// Pulse Chat Lightweight & High-Performance WebRTC Voice Calling Engine
const CallManager = {
  activeCall: null, // { type: 'direct'|'group', callId, partnerId, partnerName, partnerAvatar, partnerColor, channelId, channelName, startTime, timerInterval, isCaller }
  localStream: null,
  peerConnections: new Map(), // 'direct' or socketId -> RTCPeerConnection
  pendingCandidates: new Map(), // 'direct' or socketId -> RTCIceCandidate[]
  audioElements: new Map(),
  
  isMuted: false,

  // Fast, reliable public STUN servers (zero-timeout, sub-20ms resolution)
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  },

  init() {
    this.bindSocketEvents();
    this.bindUIEvents();
    this.setupGlobalAudioUnlock();
  },

  setupGlobalAudioUnlock() {
    const unlock = () => {
      this.audioElements.forEach(audio => {
        if (audio && audio.paused && audio.srcObject) {
          audio.play().catch(() => {});
        }
      });
    };
    document.addEventListener('click', unlock, { passive: true });
    document.addEventListener('touchstart', unlock, { passive: true });
  },

  bindSocketEvents() {
    if (!App.socket) return;

    // Remove any previous handlers to prevent duplicate execution on socket reconnect
    App.socket.off('incoming_voice_call');
    App.socket.off('voice_call_signal');
    App.socket.off('voice_call_accepted');
    App.socket.off('voice_call_declined');
    App.socket.off('voice_call_ended');
    App.socket.off('user_joined_group_voice');
    App.socket.off('group_voice_signal');
    App.socket.off('user_left_group_voice');

    // 1-on-1 Incoming Call
    App.socket.on('incoming_voice_call', (data) => {
      this.handleIncomingCall(data);
    });

    // 1-on-1 WebRTC Signaling
    App.socket.on('voice_call_signal', async ({ fromUserId, signal, callId }) => {
      if (!this.activeCall || this.activeCall.callId !== callId) return;

      try {
        let pc = this.peerConnections.get('direct');

        if (signal.type === 'offer') {
          if (!pc) {
            pc = this.createDirectPeerConnection(fromUserId, callId);
          }
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          await this.flushPendingCandidates('direct', pc);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          App.socket.emit('voice_call_signal', {
            targetUserId: fromUserId,
            signal: answer,
            callId
          });

          this.updateCallStatus('Connected');
          if (!this.activeCall.startTime) {
            this.startCallTimer();
          }
        } else if (signal.type === 'answer') {
          if (pc && (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-remote-offer')) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            await this.flushPendingCandidates('direct', pc);
            this.updateCallStatus('Connected');
            if (!this.activeCall.startTime) {
              this.startCallTimer();
            }
          }
        } else if (signal.candidate) {
          const candidateData = signal.candidate;
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidateData));
            } catch (err) {
              console.warn('Direct addIceCandidate error:', err);
            }
          } else {
            this.queuePendingCandidate('direct', candidateData);
          }
        }
      } catch (err) {
        console.error('Signaling error:', err);
      }
    });

    // 1-on-1 Call Accepted by Callee -> Caller creates Offer
    App.socket.on('voice_call_accepted', async ({ recipient, callId }) => {
      if (!this.activeCall || this.activeCall.callId !== callId) return;
      this.updateCallStatus('Connecting...');
      this.startCallTimer();

      try {
        let pc = this.peerConnections.get('direct');
        if (!pc) {
          pc = this.createDirectPeerConnection(this.activeCall.partnerId, callId);
        }

        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        App.socket.emit('voice_call_signal', {
          targetUserId: this.activeCall.partnerId,
          signal: offer,
          callId
        });
      } catch (err) {
        console.error('Error creating offer on accepted:', err);
      }
    });

    // 1-on-1 Call Declined
    App.socket.on('voice_call_declined', ({ reason }) => {
      App.showToast(reason || 'Call declined');
      this.cleanupCall();
    });

    // 1-on-1 Call Ended
    App.socket.on('voice_call_ended', () => {
      App.showToast('Call ended');
      this.cleanupCall();
    });

    // Group Voice Channel Events
    App.socket.on('user_joined_group_voice', async ({ socketId, user, channelId }) => {
      if (!this.activeCall || this.activeCall.type !== 'group' || this.activeCall.channelId !== channelId) return;
      App.showToast(`🎙️ ${user.display_name || user.username} joined voice`);
      this.addParticipantToGroupCallUI(socketId, user);
      this.createGroupPeerConnection(socketId, user, false);
    });

    App.socket.on('group_voice_signal', async ({ fromSocketId, fromUser, signal, channelId }) => {
      if (!this.activeCall || this.activeCall.type !== 'group' || this.activeCall.channelId !== channelId) return;

      try {
        let pc = this.peerConnections.get(fromSocketId);
        if (signal.type === 'offer') {
          if (!pc) {
            pc = this.createGroupPeerConnection(fromSocketId, fromUser, false);
          }
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          await this.flushPendingCandidates(fromSocketId, pc);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          App.socket.emit('group_voice_signal', {
            targetSocketId: fromSocketId,
            signal: answer,
            channelId
          });
        } else if (signal.type === 'answer') {
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            await this.flushPendingCandidates(fromSocketId, pc);
          }
        } else if (signal.candidate) {
          const candidateData = signal.candidate;
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidateData));
            } catch (e) {
              console.warn('Group addIceCandidate error:', e);
            }
          } else {
            this.queuePendingCandidate(fromSocketId, candidateData);
          }
        }
      } catch (e) {
        console.error('Group signaling error:', e);
      }
    });

    App.socket.on('user_left_group_voice', ({ socketId }) => {
      if (this.peerConnections.has(socketId)) {
        try { this.peerConnections.get(socketId).close(); } catch (e) {}
        this.peerConnections.delete(socketId);
      }
      if (this.audioElements.has(socketId)) {
        const a = this.audioElements.get(socketId);
        a.srcObject = null;
        a.remove();
        this.audioElements.delete(socketId);
      }
      this.removeParticipantFromGroupCallUI(socketId);
    });
  },

  bindUIEvents() {
    // Header Call Button (Direct Call)
    const btnCall = document.getElementById('btn-header-call');
    if (btnCall && !btnCall._hasCallListener) {
      btnCall._hasCallListener = true;
      btnCall.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!App.currentRoom || App.currentRoom.type !== 'direct') return;
        const partner = App.friends.find(f => f.id === App.currentRoom.recipientId) || {
          id: App.currentRoom.recipientId,
          display_name: App.currentRoom.name,
          username: App.currentRoom.name
        };
        this.startDirectCall(partner.id, partner.display_name || partner.username, partner.avatar_url, partner.avatar_color);
      });
    }

    // Header Join Voice Button (Group Channel)
    const btnJoinVoice = document.getElementById('btn-header-join-voice');
    if (btnJoinVoice && !btnJoinVoice._hasVoiceListener) {
      btnJoinVoice._hasVoiceListener = true;
      btnJoinVoice.addEventListener('click', (e) => {
        e.preventDefault();
        if (!App.currentRoom || App.currentRoom.type !== 'channel') return;
        if (this.activeCall && this.activeCall.type === 'group' && this.activeCall.channelId === App.currentRoom.id) {
          this.leaveGroupVoice();
        } else {
          this.joinGroupVoice(App.currentRoom.id, App.currentRoom.name);
        }
      });
    }

    // Incoming Call Modal Actions
    const btnAccept = document.getElementById('btn-accept-incoming-call');
    const btnDecline = document.getElementById('btn-decline-incoming-call');

    if (btnAccept && !btnAccept._hasAcceptListener) {
      btnAccept._hasAcceptListener = true;
      btnAccept.addEventListener('click', (e) => {
        e.preventDefault();
        this.acceptCall();
      });
    }
    if (btnDecline && !btnDecline._hasDeclineListener) {
      btnDecline._hasDeclineListener = true;
      btnDecline.addEventListener('click', (e) => {
        e.preventDefault();
        this.declineCall();
      });
    }

    // Floating Bar Controls
    const btnBarMute = document.getElementById('btn-call-mute');
    const btnBarEnd = document.getElementById('btn-call-end');

    if (btnBarMute && !btnBarMute._hasMuteListener) {
      btnBarMute._hasMuteListener = true;
      btnBarMute.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleMute();
      });
    }
    if (btnBarEnd && !btnBarEnd._hasEndListener) {
      btnBarEnd._hasEndListener = true;
      btnBarEnd.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.endCall();
      });
    }
  },

  // ================= 1-on-1 Voice Calls =================

  async startDirectCall(partnerId, partnerName, partnerAvatar, partnerColor) {
    if (this.activeCall) {
      App.showToast('You are already in an active call');
      return;
    }

    try {
      await this.acquireLocalAudio();
    } catch (err) {
      console.error('Audio permission error:', err);
      App.showToast('Microphone access is required for voice calling');
      return;
    }

    App.socket.emit('voice_call_initiate', { recipientId: partnerId, callType: 'audio' }, async (res) => {
      if (res && res.error) {
        App.showToast(res.error);
        this.stopLocalAudio();
        return;
      }

      const callId = res.callId;
      this.activeCall = {
        type: 'direct',
        callId,
        partnerId,
        partnerName,
        partnerAvatar,
        partnerColor: partnerColor || '#6366f1',
        isCaller: true,
        startTime: null
      };

      this.showActiveCallBar({
        title: partnerName,
        status: 'Ringing...',
        name: partnerName,
        color: partnerColor
      });

      this.createDirectPeerConnection(partnerId, callId);
    });
  },

  handleIncomingCall({ callId, caller }) {
    if (this.activeCall) {
      App.socket.emit('voice_call_decline', { callerId: caller.id, callId, reason: 'User is busy in another call' });
      return;
    }

    this.activeCall = {
      type: 'direct',
      callId,
      partnerId: caller.id,
      partnerName: caller.display_name || caller.username,
      partnerAvatar: caller.avatar_url,
      partnerColor: caller.avatar_color || '#6366f1',
      isCaller: false,
      startTime: null
    };

    const modal = document.getElementById('incoming-call-modal');
    const nameEl = document.getElementById('incoming-caller-name');
    const handleEl = document.getElementById('incoming-caller-handle');
    const avatarEl = document.getElementById('incoming-caller-avatar');

    if (nameEl) nameEl.textContent = caller.display_name || caller.username;
    if (handleEl) handleEl.textContent = `@${caller.username}`;
    if (avatarEl) {
      avatarEl.textContent = (caller.display_name || caller.username).charAt(0).toUpperCase();
      avatarEl.style.backgroundColor = caller.avatar_color || '#6366f1';
    }

    if (modal) modal.classList.add('active');
  },

  async acceptCall() {
    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    if (!this.activeCall) return;

    try {
      await this.acquireLocalAudio();
    } catch (err) {
      console.error('Microphone error on accept:', err);
      App.showToast('Microphone access is required to answer');
      this.declineCall();
      return;
    }

    this.showActiveCallBar({
      title: this.activeCall.partnerName,
      status: 'Connecting...',
      name: this.activeCall.partnerName,
      color: this.activeCall.partnerColor
    });

    this.createDirectPeerConnection(this.activeCall.partnerId, this.activeCall.callId);

    App.socket.emit('voice_call_accept', {
      callerId: this.activeCall.partnerId,
      callId: this.activeCall.callId
    });
  },

  createDirectPeerConnection(partnerId, callId) {
    if (this.peerConnections.has('direct')) {
      try {
        this.peerConnections.get('direct').close();
      } catch (e) {}
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set('direct', pc);

    // Attach local audio tracks
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Remote audio track handler
    pc.ontrack = (event) => {
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      this.attachRemoteAudio('direct', stream);
      this.updateCallStatus('Connected');
      if (this.activeCall && !this.activeCall.startTime) {
        this.startCallTimer();
      }
    };

    // ICE Candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && this.activeCall) {
        App.socket.emit('voice_call_signal', {
          targetUserId: partnerId,
          signal: { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate },
          callId: this.activeCall.callId || callId
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.updateCallStatus('Connected');
        if (this.activeCall && !this.activeCall.startTime) {
          this.startCallTimer();
        }
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        this.updateCallStatus('Reconnecting...');
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.updateCallStatus('Connected');
        if (this.activeCall && !this.activeCall.startTime) {
          this.startCallTimer();
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.updateCallStatus('Reconnecting...');
      }
    };

    return pc;
  },

  declineCall() {
    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    if (this.activeCall) {
      App.socket.emit('voice_call_decline', {
        callerId: this.activeCall.partnerId,
        callId: this.activeCall.callId,
        reason: 'Call declined'
      });
      this.cleanupCall();
    }
  },

  endCall() {
    if (!this.activeCall) return;

    if (this.activeCall.type === 'direct') {
      App.socket.emit('voice_call_end', {
        targetUserId: this.activeCall.partnerId,
        callId: this.activeCall.callId
      });
    } else if (this.activeCall.type === 'group') {
      App.socket.emit('leave_group_voice', { channelId: this.activeCall.channelId });
    }

    this.cleanupCall();
  },

  // ================= Group Voice Channels =================

  async joinGroupVoice(channelId, channelName) {
    if (this.activeCall) {
      if (this.activeCall.type === 'group' && this.activeCall.channelId === channelId) {
        return;
      }
      this.endCall();
    }

    try {
      await this.acquireLocalAudio();
    } catch (err) {
      console.error('Audio permission error for group voice:', err);
      App.showToast('Microphone access is required for voice rooms');
      return;
    }

    App.socket.emit('join_group_voice', { channelId }, async (res) => {
      if (res && res.error) {
        App.showToast(res.error);
        this.stopLocalAudio();
        return;
      }

      this.activeCall = {
        type: 'group',
        channelId,
        channelName,
        startTime: Date.now()
      };

      this.showActiveCallBar({
        title: `#${channelName} Room`,
        status: 'Connected',
        name: channelName,
        isGroup: true
      });

      this.startCallTimer();
      this.updateGroupVoiceButtonUI(true);

      const participants = res.participants || [];
      for (const p of participants) {
        this.addParticipantToGroupCallUI(p.socketId, p.user);
        await this.createGroupPeerConnection(p.socketId, p.user, true);
      }
    });
  },

  leaveGroupVoice() {
    if (!this.activeCall || this.activeCall.type !== 'group') return;
    App.socket.emit('leave_group_voice', { channelId: this.activeCall.channelId });
    this.updateGroupVoiceButtonUI(false);
    this.cleanupCall();
  },

  async createGroupPeerConnection(targetSocketId, targetUser, isInitiator) {
    if (this.peerConnections.has(targetSocketId)) {
      try { this.peerConnections.get(targetSocketId).close(); } catch (e) {}
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(targetSocketId, pc);

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    pc.ontrack = (event) => {
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      this.attachRemoteAudio(targetSocketId, stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && this.activeCall) {
        App.socket.emit('group_voice_signal', {
          targetSocketId,
          signal: { candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate },
          channelId: this.activeCall.channelId
        });
      }
    };

    if (isInitiator) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
        await pc.setLocalDescription(offer);
        App.socket.emit('group_voice_signal', {
          targetSocketId,
          signal: offer,
          channelId: this.activeCall.channelId
        });
      } catch (err) {
        console.error('Group initiator offer error:', err);
      }
    }

    return pc;
  },

  // ================= Audio Acquisition & Controls =================

  async acquireLocalAudio() {
    this.stopLocalAudio();

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    this.updateControlsUI();
  },

  stopLocalAudio() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
  },

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }

    this.updateControlsUI();
    App.showToast(this.isMuted ? 'Muted 🔇' : 'Unmuted 🎤');
  },

  updateControlsUI() {
    const barMute = document.getElementById('btn-call-mute');
    if (barMute) {
      barMute.classList.toggle('active-control-danger', this.isMuted);
      barMute.innerHTML = this.isMuted ? '<span>🔇</span>' : '<span>🎤</span>';
    }
  },

  attachRemoteAudio(id, stream) {
    let audio = this.audioElements.get(id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.setAttribute('autoplay', '');
      audio.setAttribute('playsinline', '');
      audio.volume = 1.0;
      audio.style.position = 'fixed';
      audio.style.opacity = '0';
      audio.style.pointerEvents = 'none';
      audio.id = `remote-audio-${id}`;
      document.body.appendChild(audio);
      this.audioElements.set(id, audio);
    }

    audio.srcObject = stream;
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch((e) => {
        console.warn('Auto-play blocked, will resume on interaction:', e);
      });
    }
  },

  startCallTimer() {
    clearInterval(this.activeCall?.timerInterval);
    const timerBar = document.getElementById('call-duration-timer');
    if (!this.activeCall) return;

    if (!this.activeCall.startTime) {
      this.activeCall.startTime = Date.now();
    }
    if (timerBar) timerBar.textContent = '00:00';

    this.activeCall.timerInterval = setInterval(() => {
      if (!this.activeCall || !this.activeCall.startTime) return;
      const elapsed = Math.floor((Date.now() - this.activeCall.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const formatted = `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
      if (timerBar) timerBar.textContent = formatted;
    }, 1000);
  },

  showActiveCallBar({ title, status, name, color, isGroup = false }) {
    const bar = document.getElementById('active-call-bar');
    const titleEl = document.getElementById('active-call-title');
    const statusEl = document.getElementById('active-call-status');
    const timerEl = document.getElementById('call-duration-timer');

    if (titleEl) titleEl.textContent = title || 'Voice Call';
    if (statusEl) statusEl.textContent = status || 'Connected';
    if (timerEl && status !== 'Connected') timerEl.textContent = '00:00';
    if (bar) {
      bar.classList.add('active');
    }

    this.updateControlsUI();
  },

  updateCallStatus(status) {
    const statusEl = document.getElementById('active-call-status');
    if (statusEl) statusEl.textContent = status;
  },

  updateGroupVoiceButtonUI(isInCall) {
    const btnJoinVoice = document.getElementById('btn-header-join-voice');
    if (btnJoinVoice) {
      btnJoinVoice.classList.toggle('active', isInCall);
      btnJoinVoice.textContent = isInCall ? 'Leave Room' : 'Join Voice';
    }
  },

  addParticipantToGroupCallUI(socketId, user) {
    const container = document.getElementById('active-call-participants');
    if (!container) return;

    if (!document.getElementById(`call-avatar-${socketId}`)) {
      const dot = document.createElement('div');
      dot.className = 'active-call-avatar';
      dot.id = `call-avatar-${socketId}`;
      dot.title = user.display_name || user.username;
      dot.style.backgroundColor = user.avatar_color || '#6366f1';
      dot.textContent = (user.display_name || user.username).charAt(0).toUpperCase();
      container.appendChild(dot);
    }
  },

  removeParticipantFromGroupCallUI(socketId) {
    const dot = document.getElementById(`call-avatar-${socketId}`);
    if (dot) dot.remove();
  },

  queuePendingCandidate(id, candidate) {
    if (!this.pendingCandidates.has(id)) {
      this.pendingCandidates.set(id, []);
    }
    this.pendingCandidates.get(id).push(candidate);
  },

  async flushPendingCandidates(id, pc) {
    const queue = this.pendingCandidates.get(id) || [];
    for (const cand of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn('flush candidate error:', err);
      }
    }
    this.pendingCandidates.delete(id);
  },

  cleanupCall() {
    clearInterval(this.activeCall?.timerInterval);

    this.peerConnections.forEach(pc => {
      try { pc.close(); } catch (e) {}
    });
    this.peerConnections.clear();
    this.pendingCandidates.clear();

    this.audioElements.forEach(audio => {
      audio.srcObject = null;
      audio.remove();
    });
    this.audioElements.clear();

    this.stopLocalAudio();

    const bar = document.getElementById('active-call-bar');
    if (bar) bar.classList.remove('active');

    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    const partsContainer = document.getElementById('active-call-participants');
    if (partsContainer) partsContainer.innerHTML = '';

    this.activeCall = null;
    this.isMuted = false;

    this.updateGroupVoiceButtonUI(false);
  }
};
