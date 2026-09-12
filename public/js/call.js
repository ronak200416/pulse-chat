// WebRTC Voice Calling Engine for 1-on-1 and Group Audio Rooms
const CallManager = {
  activeCall: null, // { type: 'direct'|'group', callId, partnerId, partnerName, channelId, channelName, startTime, timerInterval }
  localStream: null,
  peerConnections: new Map(), // Direct: 'direct' -> pc | Group: socketId -> pc
  audioElements: new Map(), // Direct: 'direct' -> audio | Group: socketId -> audio
  isMuted: false,
  isDeafened: false,
  audioCtx: null,
  ringToneOscillators: [],
  ringTimer: null,
  speakingAnalyser: null,
  speakingInterval: null,
  isSpeaking: false,

  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  },

  init() {
    this.bindSocketEvents();
    this.bindUIEvents();
  },

  bindSocketEvents() {
    if (!App.socket) return;

    // 1-on-1 Incoming Call
    App.socket.on('incoming_voice_call', (data) => {
      this.handleIncomingCall(data);
    });

    // 1-on-1 Signaling
    App.socket.on('voice_call_signal', async ({ fromUserId, signal, callId }) => {
      if (!this.activeCall || this.activeCall.callId !== callId) return;
      const pc = this.peerConnections.get('direct');
      if (!pc) return;

      try {
        if (signal.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          App.socket.emit('voice_call_signal', {
            targetUserId: fromUserId,
            signal: answer,
            callId
          });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (err) {
        console.error('Error handling direct voice call signal:', err);
      }
    });

    // 1-on-1 Call Accepted by Callee
    App.socket.on('voice_call_accepted', async ({ recipient, callId }) => {
      if (!this.activeCall || this.activeCall.callId !== callId) return;
      this.stopRingtone();
      this.playConnectedChime();
      this.updateCallStatus('Connected');
      this.startCallTimer();
    });

    // 1-on-1 Call Declined
    App.socket.on('voice_call_declined', ({ reason }) => {
      this.stopRingtone();
      this.playEndCallChime();
      App.showToast(reason || 'Call was declined');
      this.cleanupCall();
    });

    // 1-on-1 Call Ended
    App.socket.on('voice_call_ended', () => {
      this.stopRingtone();
      this.playEndCallChime();
      App.showToast('Call ended');
      this.cleanupCall();
    });

    // Group Voice Room: User Joined
    App.socket.on('user_joined_group_voice', async ({ socketId, user, channelId }) => {
      if (!this.activeCall || this.activeCall.type !== 'group' || this.activeCall.channelId !== channelId) return;
      App.showToast(`🎙️ ${user.display_name || user.username} joined voice`);
      this.addParticipantToGroupCallUI(socketId, user);
      await this.initiateGroupMeshPeer(socketId, user, true);
    });

    // Group Voice Room: Mesh Signaling
    App.socket.on('group_voice_signal', async ({ fromSocketId, fromUser, signal, channelId }) => {
      if (!this.activeCall || this.activeCall.type !== 'group' || this.activeCall.channelId !== channelId) return;
      let pc = this.peerConnections.get(fromSocketId);
      if (!pc) {
        pc = await this.initiateGroupMeshPeer(fromSocketId, fromUser, false);
      }

      try {
        if (signal.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          App.socket.emit('group_voice_signal', {
            targetSocketId: fromSocketId,
            signal: answer,
            channelId
          });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (err) {
        console.error('Group voice signal error:', err);
      }
    });

    // Group Voice Room: User Left
    App.socket.on('user_left_group_voice', ({ socketId }) => {
      if (this.peerConnections.has(socketId)) {
        this.peerConnections.get(socketId).close();
        this.peerConnections.delete(socketId);
      }
      if (this.audioElements.has(socketId)) {
        const audio = this.audioElements.get(socketId);
        audio.srcObject = null;
        audio.remove();
        this.audioElements.delete(socketId);
      }
      this.removeParticipantFromGroupCallUI(socketId);
    });

    // Live Speaking Indicator Broadcast
    App.socket.on('participant_speaking', ({ userId, socketId, isSpeaking }) => {
      this.updateParticipantSpeakingUI(userId, socketId, isSpeaking);
    });
  },

  bindUIEvents() {
    // Header Call Button (Direct Message Call)
    const btnCall = document.getElementById('btn-header-call');
    if (btnCall) {
      btnCall.addEventListener('click', () => {
        if (!App.currentRoom || App.currentRoom.type !== 'direct') return;
        const partner = App.friends.find(f => f.id === App.currentRoom.recipientId);
        if (!partner) {
          App.showToast('You must add this user as a friend to voice call');
          return;
        }
        this.startDirectCall(partner.id, partner.display_name || partner.username, partner.avatar_url, partner.avatar_color);
      });
    }

    // Header Join Voice Button (Group Channel Call)
    const btnJoinVoice = document.getElementById('btn-header-join-voice');
    if (btnJoinVoice) {
      btnJoinVoice.addEventListener('click', () => {
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

    if (btnAccept) {
      btnAccept.addEventListener('click', () => this.acceptCall());
    }
    if (btnDecline) {
      btnDecline.addEventListener('click', () => this.declineCall());
    }

    // Active Call Floating Bar Controls
    const btnMute = document.getElementById('btn-call-mute');
    const btnDeafen = document.getElementById('btn-call-deafen');
    const btnEnd = document.getElementById('btn-call-end');

    if (btnMute) {
      btnMute.addEventListener('click', () => this.toggleMute());
    }
    if (btnDeafen) {
      btnDeafen.addEventListener('click', () => this.toggleDeafen());
    }
    if (btnEnd) {
      btnEnd.addEventListener('click', () => this.endCall());
    }
  },

  // ================= 1-on-1 Direct Calls =================

  async startDirectCall(partnerId, partnerName, partnerAvatar, partnerColor) {
    if (this.activeCall) {
      App.showToast('You are already in an active call');
      return;
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (err) {
      console.error('Microphone permission error:', err);
      App.showToast('Microphone access is required for voice calls');
      return;
    }

    App.socket.emit('voice_call_initiate', { recipientId: partnerId, callType: 'audio' }, async (res) => {
      if (res && res.error) {
        App.showToast(res.error);
        if (this.localStream) {
          this.localStream.getTracks().forEach(t => t.stop());
          this.localStream = null;
        }
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
        title: `Calling ${partnerName}...`,
        status: 'Ringing...',
        avatar: partnerAvatar,
        name: partnerName,
        color: partnerColor
      });

      this.playOutgoingRinging();
      this.setupSpeakingDetector();

      // Create RTCPeerConnection
      const pc = new RTCPeerConnection(this.rtcConfig);
      this.peerConnections.set('direct', pc);

      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));

      pc.ontrack = (event) => {
        this.attachRemoteAudio('direct', event.streams[0]);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          App.socket.emit('voice_call_signal', {
            targetUserId: partnerId,
            signal: { candidate: event.candidate },
            callId
          });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      App.socket.emit('voice_call_signal', {
        targetUserId: partnerId,
        signal: offer,
        callId
      });
    });
  },

  handleIncomingCall({ callId, caller, callType }) {
    if (this.activeCall) {
      // Busy: decline automatically
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
      isCaller: false
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
    this.playIncomingRingtone();
  },

  async acceptCall() {
    this.stopRingtone();
    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    if (!this.activeCall) return;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (err) {
      console.error('Microphone error on accept:', err);
      App.showToast('Microphone access is required to answer');
      this.declineCall();
      return;
    }

    this.showActiveCallBar({
      title: this.activeCall.partnerName,
      status: 'Connected',
      name: this.activeCall.partnerName,
      color: this.activeCall.partnerColor
    });

    this.playConnectedChime();
    this.startCallTimer();
    this.setupSpeakingDetector();

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set('direct', pc);

    this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));

    pc.ontrack = (event) => {
      this.attachRemoteAudio('direct', event.streams[0]);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        App.socket.emit('voice_call_signal', {
          targetUserId: this.activeCall.partnerId,
          signal: { candidate: event.candidate },
          callId: this.activeCall.callId
        });
      }
    };

    App.socket.emit('voice_call_accept', {
      callerId: this.activeCall.partnerId,
      callId: this.activeCall.callId
    });
  },

  declineCall() {
    this.stopRingtone();
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

    this.stopRingtone();
    this.playEndCallChime();

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
      if (this.activeCall.type === 'group' && this.activeCall.channelId === channelId) return;
      this.endCall();
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (err) {
      console.error('Microphone error joining group voice:', err);
      App.showToast('Microphone access is required for voice channels');
      return;
    }

    App.socket.emit('join_group_voice', { channelId }, async (res) => {
      if (res && res.error) {
        App.showToast(res.error);
        return;
      }

      this.activeCall = {
        type: 'group',
        channelId,
        channelName,
        startTime: Date.now()
      };

      this.showActiveCallBar({
        title: `#${channelName} Voice Room`,
        status: 'Connected',
        name: channelName,
        isGroup: true
      });

      this.playConnectedChime();
      this.startCallTimer();
      this.setupSpeakingDetector();

      this.updateGroupVoiceButtonUI(true);

      // Connect mesh WebRTC to existing participants
      const participants = res.participants || [];
      for (const p of participants) {
        this.addParticipantToGroupCallUI(p.socketId, p.user);
        await this.initiateGroupMeshPeer(p.socketId, p.user, true);
      }
    });
  },

  leaveGroupVoice() {
    if (!this.activeCall || this.activeCall.type !== 'group') return;
    App.socket.emit('leave_group_voice', { channelId: this.activeCall.channelId });
    this.playEndCallChime();
    this.updateGroupVoiceButtonUI(false);
    this.cleanupCall();
  },

  async initiateGroupMeshPeer(targetSocketId, targetUser, isInitiator) {
    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(targetSocketId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

    pc.ontrack = (event) => {
      this.attachRemoteAudio(targetSocketId, event.streams[0]);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && this.activeCall) {
        App.socket.emit('group_voice_signal', {
          targetSocketId,
          signal: { candidate: event.candidate },
          channelId: this.activeCall.channelId
        });
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      App.socket.emit('group_voice_signal', {
        targetSocketId,
        signal: offer,
        channelId: this.activeCall.channelId
      });
    }

    return pc;
  },

  attachRemoteAudio(id, stream) {
    let audio = this.audioElements.get(id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      this.audioElements.set(id, audio);
    }
    audio.srcObject = stream;
    audio.muted = this.isDeafened;
  },

  // ================= Controls: Mute, Deafen, Timer =================

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }

    const btnMute = document.getElementById('btn-call-mute');
    if (btnMute) {
      btnMute.classList.toggle('active-control-danger', this.isMuted);
      btnMute.innerHTML = this.isMuted ? '<span>🔇</span>' : '<span>🎤</span>';
    }
    App.showToast(this.isMuted ? 'Microphone Muted' : 'Microphone Unmuted');
  },

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    this.audioElements.forEach(audio => {
      audio.muted = this.isDeafened;
    });

    const btnDeafen = document.getElementById('btn-call-deafen');
    if (btnDeafen) {
      btnDeafen.classList.toggle('active-control-danger', this.isDeafened);
      btnDeafen.innerHTML = this.isDeafened ? '<span>🔇</span>' : '<span>🎧</span>';
    }
    App.showToast(this.isDeafened ? 'Audio Deafen ON' : 'Audio Deafen OFF');
  },

  startCallTimer() {
    clearInterval(this.activeCall?.timerInterval);
    const timerEl = document.getElementById('call-duration-timer');
    if (!this.activeCall) return;

    this.activeCall.startTime = Date.now();
    this.activeCall.timerInterval = setInterval(() => {
      if (!this.activeCall || !this.activeCall.startTime) return;
      const elapsed = Math.floor((Date.now() - this.activeCall.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      if (timerEl) {
        timerEl.textContent = `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }
    }, 1000);
  },

  setupSpeakingDetector() {
    if (!this.localStream) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const source = this.audioCtx.createMediaStreamSource(this.localStream);
      this.speakingAnalyser = this.audioCtx.createAnalyser();
      this.speakingAnalyser.fftSize = 256;
      source.connect(this.speakingAnalyser);

      const bufferLength = this.speakingAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      clearInterval(this.speakingInterval);
      this.speakingInterval = setInterval(() => {
        if (!this.localStream || this.isMuted) {
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this.broadcastSpeakingState(false);
          }
          return;
        }

        this.speakingAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        const nowSpeaking = avg > 18;

        if (nowSpeaking !== this.isSpeaking) {
          this.isSpeaking = nowSpeaking;
          this.broadcastSpeakingState(nowSpeaking);
        }
      }, 150);
    } catch (e) {
      console.warn('Speaking detector setup failed:', e);
    }
  },

  broadcastSpeakingState(isSpeaking) {
    if (!this.activeCall) return;
    if (this.activeCall.type === 'group') {
      App.socket.emit('voice_speaking_state', {
        channelId: this.activeCall.channelId,
        isSpeaking
      });
    } else if (this.activeCall.type === 'direct') {
      App.socket.emit('voice_speaking_state', {
        targetUserId: this.activeCall.partnerId,
        isSpeaking
      });
    }
    this.updateParticipantSpeakingUI(Auth.user?.id, 'self', isSpeaking);
  },

  updateParticipantSpeakingUI(userId, socketId, isSpeaking) {
    const avatarEl = document.querySelector(`[data-call-user-id="${userId}"]`);
    if (avatarEl) {
      avatarEl.classList.toggle('is-speaking-pulse', isSpeaking);
    }
  },

  showActiveCallBar({ title, status, avatar, name, color, isGroup }) {
    const bar = document.getElementById('active-call-bar');
    const titleEl = document.getElementById('active-call-title');
    const statusEl = document.getElementById('active-call-status');
    const participantsContainer = document.getElementById('active-call-participants');

    if (titleEl) titleEl.textContent = title;
    if (statusEl) statusEl.textContent = status;

    if (participantsContainer) {
      participantsContainer.innerHTML = '';
      if (Auth.user) {
        const selfDot = document.createElement('div');
        selfDot.className = 'call-participant-avatar';
        selfDot.dataset.callUserId = Auth.user.id;
        selfDot.style.backgroundColor = Auth.user.avatar_color || '#6366f1';
        selfDot.textContent = (Auth.user.display_name || Auth.user.username).charAt(0).toUpperCase();
        selfDot.title = `${Auth.user.display_name || Auth.user.username} (You)`;
        participantsContainer.appendChild(selfDot);
      }

      if (!isGroup && name) {
        const partnerDot = document.createElement('div');
        partnerDot.className = 'call-participant-avatar';
        if (this.activeCall && this.activeCall.partnerId) {
          partnerDot.dataset.callUserId = this.activeCall.partnerId;
        }
        partnerDot.style.backgroundColor = color || '#6366f1';
        partnerDot.textContent = name.charAt(0).toUpperCase();
        partnerDot.title = name;
        participantsContainer.appendChild(partnerDot);
      }
    }

    if (bar) bar.classList.add('active');
  },

  updateCallStatus(status) {
    const statusEl = document.getElementById('active-call-status');
    if (statusEl) statusEl.textContent = status;
  },

  addParticipantToGroupCallUI(socketId, user) {
    const container = document.getElementById('active-call-participants');
    if (!container) return;

    let existing = container.querySelector(`[data-socket-id="${socketId}"]`);
    if (!existing) {
      const dot = document.createElement('div');
      dot.className = 'call-participant-avatar';
      dot.dataset.socketId = socketId;
      dot.dataset.callUserId = user.id;
      dot.style.backgroundColor = user.avatar_color || '#6366f1';
      dot.textContent = (user.display_name || user.username).charAt(0).toUpperCase();
      dot.title = user.display_name || user.username;
      container.appendChild(dot);
    }
  },

  removeParticipantFromGroupCallUI(socketId) {
    const container = document.getElementById('active-call-participants');
    if (container) {
      const dot = container.querySelector(`[data-socket-id="${socketId}"]`);
      if (dot) dot.remove();
    }
  },

  updateGroupVoiceButtonUI(isInVoice) {
    const btnJoinVoice = document.getElementById('btn-header-join-voice');
    if (btnJoinVoice) {
      btnJoinVoice.classList.toggle('active-in-voice', isInVoice);
      btnJoinVoice.innerHTML = isInVoice
        ? '<span>🔴 Leave Voice</span>'
        : '<span>🎙️ Join Voice</span>';
    }
  },

  cleanupCall() {
    this.stopRingtone();
    clearInterval(this.activeCall?.timerInterval);
    clearInterval(this.speakingInterval);

    // Stop local mic tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Close all WebRTC peer connections
    this.peerConnections.forEach(pc => pc.close());
    this.peerConnections.clear();

    // Remove remote audio elements
    this.audioElements.forEach(audio => {
      audio.srcObject = null;
      audio.remove();
    });
    this.audioElements.clear();

    // Reset controls UI
    this.isMuted = false;
    this.isDeafened = false;
    this.isSpeaking = false;

    const btnMute = document.getElementById('btn-call-mute');
    const btnDeafen = document.getElementById('btn-call-deafen');
    if (btnMute) {
      btnMute.classList.remove('active-control-danger');
      btnMute.innerHTML = '<span>🎤</span>';
    }
    if (btnDeafen) {
      btnDeafen.classList.remove('active-control-danger');
      btnDeafen.innerHTML = '<span>🎧</span>';
    }

    const timerEl = document.getElementById('call-duration-timer');
    if (timerEl) timerEl.textContent = '00:00';

    const bar = document.getElementById('active-call-bar');
    if (bar) bar.classList.remove('active');

    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    this.updateGroupVoiceButtonUI(false);
    this.activeCall = null;
  },

  // ================= Web Audio API Synthesized Chimes & Ringtones =================

  playOutgoingRinging() {
    this.stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();

      const ringLoop = () => {
        if (!this.activeCall || !this.activeCall.isCaller) return;
        const now = this.audioCtx.currentTime;
        const osc1 = this.audioCtx.createOscillator();
        const osc2 = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc1.frequency.value = 440; // Standard US ringtone 440Hz + 480Hz
        osc2.frequency.value = 480;

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.setValueAtTime(0.08, now + 1.6);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 1.8);
        osc2.stop(now + 1.8);

        this.ringTimer = setTimeout(ringLoop, 3500);
      };
      ringLoop();
    } catch (e) {}
  },

  playIncomingRingtone() {
    this.stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();

      const ringMelody = () => {
        const modal = document.getElementById('incoming-call-modal');
        if (!modal || !modal.classList.contains('active')) return;

        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 melodic ring
        const now = this.audioCtx.currentTime;

        notes.forEach((freq, idx) => {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const start = now + idx * 0.14;

          gain.gain.setValueAtTime(0.12, start);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);

          osc.connect(gain);
          gain.connect(this.audioCtx.destination);

          osc.start(start);
          osc.stop(start + 0.35);
        });

        this.ringTimer = setTimeout(ringMelody, 2200);
      };
      ringMelody();
    } catch (e) {}
  },

  stopRingtone() {
    clearTimeout(this.ringTimer);
  },

  playConnectedChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      [587.33, 880].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.12, now + idx * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.1 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.1);
        osc.stop(now + idx * 0.1 + 0.25);
      });
    } catch (e) {}
  },

  playEndCallChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      [880, 440].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.12, now + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.12);
        osc.stop(now + idx * 0.12 + 0.25);
      });
    } catch (e) {}
  }
};
