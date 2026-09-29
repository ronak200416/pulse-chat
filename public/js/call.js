// Ultra-Reliable & Simple WebRTC Voice & Video Calling Engine
const CallManager = {
  activeCall: null, // { type: 'direct'|'group', callId, partnerId, partnerName, partnerAvatar, partnerColor, channelId, channelName, startTime, timerInterval, isCaller, callType: 'audio'|'video' }
  localStream: null,
  peerConnections: new Map(), // 'direct' or socketId -> RTCPeerConnection
  pendingCandidates: new Map(), // 'direct' or socketId -> RTCIceCandidate[]
  audioElements: new Map(),
  remoteStreams: new Map(),
  
  isMuted: false,
  isCameraOn: false,
  isStageOpen: false,

  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.services.mozilla.com' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      // Free OpenRelay TURN servers for NAT / 4G / Firewall bypass on Render
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelay',
        credential: 'openrelay'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelay',
        credential: 'openrelay'
      }
    ],
    iceCandidatePoolSize: 10
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
      const remoteVid = document.getElementById('remote-video-feed');
      if (remoteVid && remoteVid.paused && remoteVid.srcObject) {
        remoteVid.play().catch(() => {});
      }
      const localVid = document.getElementById('local-video-feed');
      if (localVid && localVid.paused && localVid.srcObject) {
        localVid.play().catch(() => {});
      }
    };
    document.addEventListener('click', unlock, { passive: true });
    document.addEventListener('touchstart', unlock, { passive: true });
  },

  bindSocketEvents() {
    if (!App.socket) return;

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
        } else if (signal.type === 'answer') {
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            await this.flushPendingCandidates('direct', pc);
          }
        } else if (signal.candidate) {
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } catch (err) {}
          } else {
            this.queuePendingCandidate('direct', signal.candidate);
          }
        }
      } catch (err) {
        console.error('Signaling error:', err);
      }
    });

    // 1-on-1 Call Accepted by Callee -> Caller creates Offer
    App.socket.on('voice_call_accepted', async ({ recipient, callId }) => {
      if (!this.activeCall || this.activeCall.callId !== callId) return;
      this.updateCallStatus('Connected');
      this.startCallTimer();

      try {
        let pc = this.peerConnections.get('direct');
        if (!pc) {
          pc = this.createDirectPeerConnection(this.activeCall.partnerId, callId);
        }

        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
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

    // Media state sync (camera on/off)
    App.socket.on('call_media_state_changed', ({ isVideoOn, isMuted }) => {
      this.updateRemoteMediaUI({ isVideoOn, isMuted });
    });

    // Group calls
    App.socket.on('user_joined_group_voice', async ({ socketId, user, channelId }) => {
      if (!this.activeCall || this.activeCall.type !== 'group' || this.activeCall.channelId !== channelId) return;
      App.showToast(`🎙️ ${user.display_name || user.username} joined call`);
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
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            await this.flushPendingCandidates(fromSocketId, pc);
          }
        } else if (signal.candidate) {
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) {}
          } else {
            this.queuePendingCandidate(fromSocketId, signal.candidate);
          }
        }
      } catch (e) {}
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
    });
  },

  bindUIEvents() {
    // Header Call Buttons
    const btnCall = document.getElementById('btn-header-call');
    if (btnCall) {
      btnCall.addEventListener('click', () => {
        if (!App.currentRoom || App.currentRoom.type !== 'direct') return;
        const partner = App.friends.find(f => f.id === App.currentRoom.recipientId) || {
          id: App.currentRoom.recipientId,
          display_name: App.currentRoom.name,
          username: App.currentRoom.name
        };
        this.startDirectCall(partner.id, partner.display_name || partner.username, partner.avatar_url, partner.avatar_color, false);
      });
    }

    const btnVideoCall = document.getElementById('btn-header-video-call');
    if (btnVideoCall) {
      btnVideoCall.addEventListener('click', () => {
        if (!App.currentRoom || App.currentRoom.type !== 'direct') return;
        const partner = App.friends.find(f => f.id === App.currentRoom.recipientId) || {
          id: App.currentRoom.recipientId,
          display_name: App.currentRoom.name,
          username: App.currentRoom.name
        };
        this.startDirectCall(partner.id, partner.display_name || partner.username, partner.avatar_url, partner.avatar_color, true);
      });
    }

    const btnJoinVoice = document.getElementById('btn-header-join-voice');
    if (btnJoinVoice) {
      btnJoinVoice.addEventListener('click', () => {
        if (!App.currentRoom || App.currentRoom.type !== 'channel') return;
        if (this.activeCall && this.activeCall.type === 'group' && this.activeCall.channelId === App.currentRoom.id) {
          this.leaveGroupVoice();
        } else {
          this.joinGroupVoice(App.currentRoom.id, App.currentRoom.name, false);
        }
      });
    }

    const btnJoinVideo = document.getElementById('btn-header-join-video');
    if (btnJoinVideo) {
      btnJoinVideo.addEventListener('click', () => {
        if (!App.currentRoom || App.currentRoom.type !== 'channel') return;
        if (this.activeCall && this.activeCall.type === 'group' && this.activeCall.channelId === App.currentRoom.id) {
          this.openVideoStage();
        } else {
          this.joinGroupVoice(App.currentRoom.id, App.currentRoom.name, true);
        }
      });
    }

    // Incoming Call Modal Actions
    const btnAccept = document.getElementById('btn-accept-incoming-call');
    const btnAcceptAudio = document.getElementById('btn-accept-incoming-call-audio');
    const btnDecline = document.getElementById('btn-decline-incoming-call');

    if (btnAccept) {
      btnAccept.addEventListener('click', () => {
        const isVid = this.activeCall && this.activeCall.callType === 'video';
        this.acceptCall(isVid);
      });
    }
    if (btnAcceptAudio) {
      btnAcceptAudio.addEventListener('click', () => {
        this.acceptCall(false);
      });
    }
    if (btnDecline) {
      btnDecline.addEventListener('click', () => this.declineCall());
    }

    // Floating Bar Actions
    const btnBarMute = document.getElementById('btn-call-mute');
    const btnBarVideo = document.getElementById('btn-call-video-toggle');
    const btnBarExpand = document.getElementById('btn-call-expand-stage');
    const btnBarEnd = document.getElementById('btn-call-end');
    const barInfoClick = document.getElementById('active-call-info-click');

    if (btnBarMute) btnBarMute.addEventListener('click', () => this.toggleMute());
    if (btnBarVideo) btnBarVideo.addEventListener('click', () => this.toggleCamera());
    if (btnBarExpand) btnBarExpand.addEventListener('click', () => this.openVideoStage());
    if (barInfoClick) barInfoClick.addEventListener('click', () => this.openVideoStage());
    if (btnBarEnd) btnBarEnd.addEventListener('click', () => this.endCall());

    // Video Stage Modal Simplified 3 Controls (Mic, Camera, End Call)
    const btnStageMute = document.getElementById('btn-stage-mute');
    const btnStageVideo = document.getElementById('btn-stage-video');
    const btnStageMin = document.getElementById('btn-video-stage-minimize');
    const btnStageEnd = document.getElementById('btn-stage-end');

    if (btnStageMute) btnStageMute.addEventListener('click', () => this.toggleMute());
    if (btnStageVideo) btnStageVideo.addEventListener('click', () => this.toggleCamera());
    if (btnStageMin) btnStageMin.addEventListener('click', () => this.closeVideoStage());
    if (btnStageEnd) btnStageEnd.addEventListener('click', () => this.endCall());
  },

  // ================= 1-on-1 Direct Calls =================

  async startDirectCall(partnerId, partnerName, partnerAvatar, partnerColor, isVideo = false) {
    if (this.activeCall) {
      App.showToast('You are already in an active call');
      return;
    }

    try {
      await this.acquireLocalMedia(isVideo);
    } catch (err) {
      console.error('Media error:', err);
      App.showToast(isVideo ? 'Camera or microphone access denied' : 'Microphone access denied');
      return;
    }

    const callType = isVideo ? 'video' : 'audio';
    App.socket.emit('voice_call_initiate', { recipientId: partnerId, callType }, async (res) => {
      if (res && res.error) {
        App.showToast(res.error);
        this.stopLocalMedia();
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
        callType,
        startTime: null
      };

      this.showActiveCallBar({
        title: `Calling ${partnerName}...`,
        status: 'Ringing...',
        name: partnerName,
        color: partnerColor
      });

      if (isVideo) {
        this.openVideoStage();
      }

      this.createDirectPeerConnection(partnerId, callId);
    });
  },

  handleIncomingCall({ callId, caller, callType }) {
    if (this.activeCall) {
      App.socket.emit('voice_call_decline', { callerId: caller.id, callId, reason: 'User is busy in another call' });
      return;
    }

    const isVideo = callType === 'video';
    this.activeCall = {
      type: 'direct',
      callId,
      partnerId: caller.id,
      partnerName: caller.display_name || caller.username,
      partnerAvatar: caller.avatar_url,
      partnerColor: caller.avatar_color || '#6366f1',
      callType: callType || 'audio',
      isCaller: false
    };

    const modal = document.getElementById('incoming-call-modal');
    const nameEl = document.getElementById('incoming-caller-name');
    const handleEl = document.getElementById('incoming-caller-handle');
    const avatarEl = document.getElementById('incoming-caller-avatar');
    const typeText = document.getElementById('incoming-call-type-text');
    const btnAudio = document.getElementById('btn-accept-incoming-call-audio');

    if (nameEl) nameEl.textContent = caller.display_name || caller.username;
    if (handleEl) handleEl.textContent = `@${caller.username}`;
    if (avatarEl) {
      avatarEl.textContent = (caller.display_name || caller.username).charAt(0).toUpperCase();
      avatarEl.style.backgroundColor = caller.avatar_color || '#6366f1';
    }

    if (typeText) {
      typeText.textContent = isVideo ? '📹 Incoming Video Call...' : '📞 Incoming Voice Call...';
    }

    if (btnAudio) {
      btnAudio.style.display = isVideo ? 'inline-flex' : 'none';
    }

    if (modal) modal.classList.add('active');
  },

  async acceptCall(withVideo = null) {
    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    if (!this.activeCall) return;

    const requestVideo = withVideo !== null ? withVideo : (this.activeCall.callType === 'video');

    try {
      await this.acquireLocalMedia(requestVideo);
    } catch (err) {
      console.error('Permission error on accept:', err);
      App.showToast('Microphone & camera permissions required');
      this.declineCall();
      return;
    }

    this.activeCall.callType = requestVideo ? 'video' : 'audio';

    this.showActiveCallBar({
      title: this.activeCall.partnerName,
      status: 'Connecting...',
      name: this.activeCall.partnerName,
      color: this.activeCall.partnerColor
    });

    if (requestVideo) {
      this.openVideoStage();
    }

    this.startCallTimer();
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

    // Attach all local tracks (audio + video)
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Ensure video transceiver is available in SDP offer/answer
    try {
      const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
      if (!transceivers.some(t => t.receiver?.track?.kind === 'video') && pc.addTransceiver) {
        pc.addTransceiver('video', { direction: 'sendrecv' });
      }
    } catch (e) {}

    // Incoming Remote Stream & Track Handler
    pc.ontrack = (event) => {
      console.log('Got remote track:', event.track.kind);
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      this.remoteStreams.set('direct', stream);

      if (event.track.kind === 'audio') {
        this.attachRemoteAudio('direct', stream);
      }
      if (event.track.kind === 'video') {
        this.attachRemoteVideo('direct', stream);
      }
    };

    // ICE Candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && this.activeCall) {
        App.socket.emit('voice_call_signal', {
          targetUserId: partnerId,
          signal: { candidate: event.candidate },
          callId: this.activeCall.callId || callId
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.updateCallStatus('Connected');
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

  // ================= Group Voice & Video Channels =================

  async joinGroupVoice(channelId, channelName, isVideo = false) {
    if (this.activeCall) {
      if (this.activeCall.type === 'group' && this.activeCall.channelId === channelId) {
        if (isVideo) this.openVideoStage();
        return;
      }
      this.endCall();
    }

    try {
      await this.acquireLocalMedia(isVideo);
    } catch (err) {
      console.error('Media error:', err);
      App.showToast('Microphone access is required');
      return;
    }

    App.socket.emit('join_group_voice', { channelId }, async (res) => {
      if (res && res.error) {
        App.showToast(res.error);
        this.stopLocalMedia();
        return;
      }

      this.activeCall = {
        type: 'group',
        channelId,
        channelName,
        callType: isVideo ? 'video' : 'audio',
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

      if (isVideo) {
        this.openVideoStage();
      }

      const participants = res.participants || [];
      for (const p of participants) {
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
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    try {
      if (pc.addTransceiver) pc.addTransceiver('video', { direction: 'sendrecv' });
    } catch (e) {}

    pc.ontrack = (event) => {
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      this.remoteStreams.set(targetSocketId, stream);

      if (event.track.kind === 'audio') {
        this.attachRemoteAudio(targetSocketId, stream);
      }
      if (event.track.kind === 'video') {
        this.attachGroupParticipantVideo(targetSocketId, stream, targetUser);
      }
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
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        App.socket.emit('group_voice_signal', {
          targetSocketId,
          signal: offer,
          channelId: this.activeCall.channelId
        });
      } catch (err) {}
    }

    return pc;
  },

  // ================= Media Acquisition & Controls =================

  async acquireLocalMedia(enableVideo = false) {
    this.stopLocalMedia();

    if (enableVideo) {
      // Try 720p first, then fallback to basic webcam for 100% PC / Laptop / Mobile compatibility
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        this.isCameraOn = this.localStream.getVideoTracks().length > 0;
      } catch (err1) {
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true
          });
          this.isCameraOn = this.localStream.getVideoTracks().length > 0;
        } catch (err2) {
          console.warn('Camera failed, falling back to audio only:', err2);
          this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          this.isCameraOn = false;
        }
      }
    } else {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      this.isCameraOn = false;
    }

    this.updateControlsUI();
    this.updateLocalVideoPreview();
  },

  stopLocalMedia() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.isCameraOn = false;
  },

  async toggleCamera() {
    if (this.isCameraOn) {
      // Turn Camera OFF
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(t => {
          t.stop();
          this.localStream.removeTrack(t);
        });
      }

      this.peerConnections.forEach(pc => {
        const senders = pc.getSenders ? pc.getSenders() : [];
        const vidSender = senders.find(s => (s.track && s.track.kind === 'video') || (s.track === null));
        if (vidSender) {
          vidSender.replaceTrack(null).catch(() => {});
        }
      });

      this.isCameraOn = false;
      App.showToast('Camera turned off');
      this.broadcastMediaState();
      this.updateControlsUI();
      this.updateLocalVideoPreview();
    } else {
      // Turn Camera ON
      try {
        let stream = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { width: { ideal: 1280 }, height: { ideal: 720 } }
          });
        } catch (e1) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true
          });
        }

        const newVideoTrack = stream.getVideoTracks()[0];
        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(t => {
            t.stop();
            this.localStream.removeTrack(t);
          });
          this.localStream.addTrack(newVideoTrack);
        } else {
          this.localStream = stream;
        }

        this.peerConnections.forEach(async (pc) => {
          const senders = pc.getSenders ? pc.getSenders() : [];
          const vidSender = senders.find(s => (s.track && s.track.kind === 'video') || (s.track === null));
          if (vidSender) {
            await vidSender.replaceTrack(newVideoTrack);
          } else {
            pc.addTrack(newVideoTrack, this.localStream);
            this.renegotiatePeerConnection(pc);
          }
        });

        this.isCameraOn = true;
        App.showToast('Camera turned on 📹');
        this.broadcastMediaState();
        this.updateControlsUI();
        this.updateLocalVideoPreview();

        if (!this.isStageOpen) {
          this.openVideoStage();
        }
      } catch (err) {
        console.error('Camera access failed on PC/Mobile:', err);
        App.showToast('Camera permission denied or camera not found');
      }
    }
  },

  async renegotiatePeerConnection(pc) {
    if (!this.activeCall) return;
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await pc.setLocalDescription(offer);

      if (this.activeCall.type === 'direct') {
        App.socket.emit('voice_call_signal', {
          targetUserId: this.activeCall.partnerId,
          signal: offer,
          callId: this.activeCall.callId
        });
      }
    } catch (e) {}
  },

  broadcastMediaState() {
    if (!this.activeCall) return;
    const payload = {
      isVideoOn: this.isCameraOn,
      isMuted: this.isMuted
    };

    if (this.activeCall.type === 'direct') {
      App.socket.emit('call_media_state', {
        targetUserId: this.activeCall.partnerId,
        ...payload
      });
    } else if (this.activeCall.type === 'group') {
      App.socket.emit('call_media_state', {
        channelId: this.activeCall.channelId,
        ...payload
      });
    }
  },

  // ================= Audio & Video Playback =================

  attachRemoteAudio(id, stream) {
    let audio = this.audioElements.get(id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.volume = 1.0;
      audio.style.position = 'fixed';
      audio.style.opacity = '0';
      audio.style.pointerEvents = 'none';
      audio.id = `remote-audio-${id}`;
      document.body.appendChild(audio);
      this.audioElements.set(id, audio);
    }

    audio.srcObject = stream;
    audio.play().catch(() => {});
  },

  attachRemoteVideo(id, stream) {
    const videoEl = document.getElementById('remote-video-feed');
    const fallbackEl = document.getElementById('remote-video-fallback');

    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.style.display = 'block';
      videoEl.onloadedmetadata = () => {
        videoEl.play().catch(() => {});
      };
      videoEl.play().catch(() => {});
      if (fallbackEl) fallbackEl.style.display = 'none';
    }

    if (!this.isStageOpen) {
      this.openVideoStage();
    }
  },

  attachGroupParticipantVideo(socketId, stream, user) {
    const grid = document.getElementById('video-stage-group-grid');
    if (!grid) return;

    let tile = document.getElementById(`group-tile-${socketId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'group-video-tile';
      tile.id = `group-tile-${socketId}`;
      tile.innerHTML = `
        <video autoplay playsinline class="group-video-element" id="vid-group-${socketId}"></video>
        <div class="video-fallback-avatar group-fallback" id="fallback-group-${socketId}">
          <div class="fallback-avatar-circle" style="background-color:${user?.avatar_color || '#6366f1'};">${(user?.display_name || user?.username || 'U').charAt(0).toUpperCase()}</div>
        </div>
        <div class="video-feed-info-pill">
          <span>${App.escapeHtml(user?.display_name || user?.username || 'Member')}</span>
          <span id="mic-status-${socketId}">🎤</span>
        </div>
      `;
      grid.appendChild(tile);
    }

    const vid = tile.querySelector('video');
    const fallback = tile.querySelector('.video-fallback-avatar');
    if (vid) {
      vid.srcObject = stream;
      vid.style.display = 'block';
      vid.play().catch(() => {});
      if (fallback) fallback.style.display = 'none';
    }
  },

  updateRemoteMediaUI({ isVideoOn, isMuted }) {
    if (this.activeCall?.type === 'direct') {
      const vidEl = document.getElementById('remote-video-feed');
      const fallbackEl = document.getElementById('remote-video-fallback');
      const micStatus = document.getElementById('remote-feed-mic-status');

      if (micStatus) {
        micStatus.textContent = isMuted ? '🔇' : '🎤';
        micStatus.style.color = isMuted ? '#ef4444' : '#34d399';
      }

      if (vidEl && fallbackEl) {
        if (isVideoOn) {
          vidEl.style.display = 'block';
          fallbackEl.style.display = 'none';
        } else {
          vidEl.style.display = 'none';
          fallbackEl.style.display = 'flex';
        }
      }
    }
  },

  updateLocalVideoPreview() {
    const vidEl = document.getElementById('local-video-feed');
    const fallbackEl = document.getElementById('local-video-fallback');
    const micStatus = document.getElementById('local-feed-mic-status');

    if (micStatus) {
      micStatus.textContent = this.isMuted ? '🔇' : '🎤';
      micStatus.style.color = this.isMuted ? '#ef4444' : '#34d399';
    }

    const hasVideo = this.isCameraOn && this.localStream && this.localStream.getVideoTracks().length > 0;
    if (vidEl) {
      if (hasVideo) {
        vidEl.srcObject = this.localStream;
        vidEl.style.display = 'block';
        vidEl.onloadedmetadata = () => {
          vidEl.play().catch(() => {});
        };
        vidEl.play().catch(() => {});
        if (fallbackEl) fallbackEl.style.display = 'none';
      } else {
        vidEl.srcObject = null;
        vidEl.style.display = 'none';
        if (fallbackEl) fallbackEl.style.display = 'flex';
      }
    }
  },

  // ================= Stage Modal & Controls =================

  openVideoStage() {
    const modal = document.getElementById('video-call-modal');
    const titleEl = document.getElementById('video-stage-title');
    const typeBadge = document.getElementById('video-stage-call-type');
    const directBody = document.getElementById('video-stage-direct-body');
    const groupGrid = document.getElementById('video-stage-group-grid');
    const partnerName = document.getElementById('remote-feed-user-name');
    const fallbackName = document.getElementById('remote-fallback-name');
    const fallbackCircle = document.getElementById('remote-fallback-avatar-circle');

    if (this.activeCall) {
      if (titleEl) {
        titleEl.textContent = this.activeCall.type === 'direct' 
          ? `Call with ${this.activeCall.partnerName}` 
          : `#${this.activeCall.channelName} Video Room`;
      }
      if (typeBadge) {
        typeBadge.textContent = this.isCameraOn ? 'LIVE VIDEO' : 'CALL';
      }

      if (this.activeCall.type === 'direct') {
        if (directBody) directBody.style.display = 'flex';
        if (groupGrid) groupGrid.style.display = 'none';

        if (partnerName) partnerName.textContent = this.activeCall.partnerName;
        if (fallbackName) fallbackName.textContent = this.activeCall.partnerName;
        if (fallbackCircle) {
          fallbackCircle.textContent = this.activeCall.partnerName.charAt(0).toUpperCase();
          fallbackCircle.style.backgroundColor = this.activeCall.partnerColor || '#6366f1';
        }
      } else {
        if (directBody) directBody.style.display = 'none';
        if (groupGrid) groupGrid.style.display = 'grid';
      }
    }

    if (modal) {
      modal.classList.add('active');
      this.isStageOpen = true;
    }

    this.updateControlsUI();
    this.updateLocalVideoPreview();
  },

  closeVideoStage() {
    const modal = document.getElementById('video-call-modal');
    if (modal) {
      modal.classList.remove('active');
      this.isStageOpen = false;
    }
  },

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }

    this.broadcastMediaState();
    this.updateControlsUI();
    App.showToast(this.isMuted ? 'Microphone Muted 🔇' : 'Microphone Unmuted 🎤');
  },

  updateControlsUI() {
    const btnMute = document.getElementById('btn-stage-mute');
    const muteIcon = document.getElementById('stage-mute-icon');
    const muteLabel = document.getElementById('stage-mute-label');

    const btnVideo = document.getElementById('btn-stage-video');
    const videoIcon = document.getElementById('stage-video-icon');
    const videoLabel = document.getElementById('stage-video-label');

    if (btnMute && muteIcon) {
      btnMute.classList.toggle('active-control-danger', this.isMuted);
      muteIcon.textContent = this.isMuted ? '🔇' : '🎤';
      if (muteLabel) muteLabel.textContent = this.isMuted ? 'Unmute' : 'Mute';
    }

    if (btnVideo && videoIcon) {
      btnVideo.classList.toggle('active-control-success', this.isCameraOn);
      btnVideo.classList.toggle('active-control-danger', !this.isCameraOn);
      videoIcon.textContent = this.isCameraOn ? '📹' : '📷';
      if (videoLabel) videoLabel.textContent = this.isCameraOn ? 'Cam Off' : 'Cam On';
    }

    // Floating Bar Controls
    const barMute = document.getElementById('btn-call-mute');
    const barVideo = document.getElementById('btn-call-video-toggle');

    if (barMute) {
      barMute.classList.toggle('active-control-danger', this.isMuted);
      barMute.innerHTML = this.isMuted ? '<span>🔇</span>' : '<span>🎤</span>';
    }
    if (barVideo) {
      barVideo.classList.toggle('active-control-success', this.isCameraOn);
      barVideo.innerHTML = this.isCameraOn ? '<span>📹</span>' : '<span>📷</span>';
    }
  },

  startCallTimer() {
    clearInterval(this.activeCall?.timerInterval);
    const timerBar = document.getElementById('call-duration-timer');
    const timerStage = document.getElementById('video-stage-timer');
    if (!this.activeCall) return;

    this.activeCall.startTime = Date.now();
    this.activeCall.timerInterval = setInterval(() => {
      if (!this.activeCall || !this.activeCall.startTime) return;
      const elapsed = Math.floor((Date.now() - this.activeCall.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const formatted = `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
      if (timerBar) timerBar.textContent = formatted;
      if (timerStage) timerStage.textContent = formatted;
    }, 1000);
  },

  showActiveCallBar({ title, status, name, color, isGroup = false }) {
    const bar = document.getElementById('active-call-bar');
    const titleEl = document.getElementById('active-call-title');
    const statusEl = document.getElementById('active-call-status');

    if (titleEl) titleEl.textContent = title;
    if (statusEl) statusEl.textContent = status;
    if (bar) bar.classList.add('active');

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
      } catch (err) {}
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

    this.stopLocalMedia();
    this.closeVideoStage();

    const bar = document.getElementById('active-call-bar');
    if (bar) bar.classList.remove('active');

    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    const remoteVid = document.getElementById('remote-video-feed');
    if (remoteVid) remoteVid.srcObject = null;
    const localVid = document.getElementById('local-video-feed');
    if (localVid) localVid.srcObject = null;

    const groupGrid = document.getElementById('video-stage-group-grid');
    if (groupGrid) groupGrid.innerHTML = '';

    this.activeCall = null;
    this.isMuted = false;
    this.isCameraOn = false;

    this.updateGroupVoiceButtonUI(false);
  }
};
