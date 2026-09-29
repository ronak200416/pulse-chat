// WebRTC Voice & Video Calling Engine for 1-on-1 and Group Mesh Channels
const CallManager = {
  activeCall: null, // { type: 'direct'|'group', callId, partnerId, partnerName, partnerAvatar, partnerColor, channelId, channelName, startTime, timerInterval, isCaller, callType: 'audio'|'video' }
  localStream: null, // Combined local MediaStream
  localAudioStream: null,
  localVideoStream: null,
  screenStream: null,
  peerConnections: new Map(), // Direct: 'direct' -> pc | Group: socketId -> pc
  pendingCandidates: new Map(), // Direct: 'direct' -> candidate[] | Group: socketId -> candidate[]
  audioElements: new Map(), // Direct: 'direct' -> audio | Group: socketId -> audio
  remoteStreams: new Map(), // Direct: 'direct' -> stream | Group: socketId -> stream
  remoteMediaStates: new Map(), // Direct: partnerId -> state | Group: socketId -> state
  
  isMuted: false,
  isCameraOn: false,
  isScreenSharing: false,
  isDeafened: false,
  isStageOpen: false,
  isFullscreen: false,
  isSpeaking: false,
  
  audioCtx: null,
  ringToneOscillators: [],
  ringTimer: null,
  speakingAnalyser: null,
  speakingInterval: null,
  availableVideoDevices: [],
  currentVideoDeviceIndex: 0,

  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.services.mozilla.com' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  },

  init() {
    this.bindSocketEvents();
    this.bindUIEvents();
    this.setupGlobalAudioUnlock();
    this.enumerateDevices();
  },

  async enumerateDevices() {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        this.availableVideoDevices = devices.filter(d => d.kind === 'videoinput');
        const flipBtn = document.getElementById('btn-stage-flip');
        if (flipBtn && this.availableVideoDevices.length > 1) {
          flipBtn.style.display = 'inline-flex';
        }
      }
    } catch (e) {}
  },

  setupGlobalAudioUnlock() {
    const unlock = () => {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
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

    // 1-on-1 Incoming Call Notification
    App.socket.on('incoming_voice_call', (data) => {
      this.handleIncomingCall(data);
    });

    // 1-on-1 WebRTC Signaling Exchange
    App.socket.on('voice_call_signal', async ({ fromUserId, signal, callId }) => {
      if (!this.activeCall || this.activeCall.callId !== callId) return;

      try {
        let pc = this.peerConnections.get('direct');

        if (signal.type === 'offer') {
          // Callee receives offer from Caller
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
          // Caller receives answer from Callee
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            await this.flushPendingCandidates('direct', pc);
          }
        } else if (signal.candidate) {
          // ICE candidate received
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } catch (err) {
              console.warn('Direct addIceCandidate error:', err);
            }
          } else {
            this.queuePendingCandidate('direct', signal.candidate);
          }
        }
      } catch (err) {
        console.error('Error handling direct voice/video call signal:', err);
      }
    });

    // 1-on-1 Call Accepted by Callee -> Caller triggers negotiation
    App.socket.on('voice_call_accepted', async ({ recipient, callId }) => {
      if (!this.activeCall || this.activeCall.callId !== callId) return;
      this.stopRingtone();
      this.playConnectedChime();
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
        console.error('Error creating offer on call accepted:', err);
      }
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
      App.showToast(`🎙️ ${user.display_name || user.username} joined call`);
      this.addParticipantToGroupCallUI(socketId, user);
      this.createGroupPeerConnection(socketId, user, false);
    });

    // Group Voice Room: Mesh Signaling Exchange
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
            try {
              await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } catch (err) {
              console.warn('Group addIceCandidate error:', err);
            }
          } else {
            this.queuePendingCandidate(fromSocketId, signal.candidate);
          }
        }
      } catch (err) {
        console.error('Group call signal error:', err);
      }
    });

    // Group Voice Room: User Left
    App.socket.on('user_left_group_voice', ({ socketId }) => {
      if (this.peerConnections.has(socketId)) {
        try {
          this.peerConnections.get(socketId).close();
        } catch (e) {}
        this.peerConnections.delete(socketId);
      }
      if (this.pendingCandidates.has(socketId)) {
        this.pendingCandidates.delete(socketId);
      }
      if (this.audioElements.has(socketId)) {
        const audio = this.audioElements.get(socketId);
        audio.srcObject = null;
        audio.remove();
        this.audioElements.delete(socketId);
      }
      this.removeParticipantFromGroupCallUI(socketId);
    });

    // Media State Changed (Camera On/Off, Screen Share On/Off)
    App.socket.on('call_media_state_changed', ({ userId, socketId, isVideoOn, isScreenSharing, isMuted }) => {
      const key = socketId || userId || 'direct';
      this.remoteMediaStates.set(key, { isVideoOn, isScreenSharing, isMuted });
      this.updateRemoteMediaUI(key, { isVideoOn, isScreenSharing, isMuted, userId });
    });

    // Live Speaking Indicator Broadcast
    App.socket.on('participant_speaking', ({ userId, socketId, isSpeaking }) => {
      this.updateParticipantSpeakingUI(userId, socketId, isSpeaking);
    });
  },

  bindUIEvents() {
    // Header Voice Call Button (Direct Call)
    const btnCall = document.getElementById('btn-header-call');
    if (btnCall) {
      btnCall.addEventListener('click', () => {
        if (!App.currentRoom || App.currentRoom.type !== 'direct') return;
        const partner = App.friends.find(f => f.id === App.currentRoom.recipientId);
        if (!partner) {
          App.showToast('You must add this user as a friend to voice call');
          return;
        }
        this.startDirectCall(partner.id, partner.display_name || partner.username, partner.avatar_url, partner.avatar_color, false);
      });
    }

    // Header Video Call Button (Direct Call)
    const btnVideoCall = document.getElementById('btn-header-video-call');
    if (btnVideoCall) {
      btnVideoCall.addEventListener('click', () => {
        if (!App.currentRoom || App.currentRoom.type !== 'direct') return;
        const partner = App.friends.find(f => f.id === App.currentRoom.recipientId);
        if (!partner) {
          App.showToast('You must add this user as a friend to video call');
          return;
        }
        this.startDirectCall(partner.id, partner.display_name || partner.username, partner.avatar_url, partner.avatar_color, true);
      });
    }

    // Header Join Voice Button (Group Channel)
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

    // Header Join Video Button (Group Channel)
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
    const btnBarDeafen = document.getElementById('btn-call-deafen');
    const btnBarEnd = document.getElementById('btn-call-end');
    const barInfoClick = document.getElementById('active-call-info-click');

    if (btnBarMute) btnBarMute.addEventListener('click', () => this.toggleMute());
    if (btnBarVideo) btnBarVideo.addEventListener('click', () => this.toggleCamera());
    if (btnBarExpand) btnBarExpand.addEventListener('click', () => this.openVideoStage());
    if (barInfoClick) barInfoClick.addEventListener('click', () => this.openVideoStage());
    if (btnBarDeafen) btnBarDeafen.addEventListener('click', () => this.toggleDeafen());
    if (btnBarEnd) btnBarEnd.addEventListener('click', () => this.endCall());

    // Video Stage Modal Actions
    const btnStageMute = document.getElementById('btn-stage-mute');
    const btnStageVideo = document.getElementById('btn-stage-video');
    const btnStageScreen = document.getElementById('btn-stage-screenshare');
    const btnStageFlip = document.getElementById('btn-stage-flip');
    const btnStageDeafen = document.getElementById('btn-stage-deafen');
    const btnStageMin = document.getElementById('btn-video-stage-minimize');
    const btnStagePip = document.getElementById('btn-video-stage-pip');
    const btnStageFull = document.getElementById('btn-video-stage-fullscreen');
    const btnStageEnd = document.getElementById('btn-stage-end');
    const btnStageChat = document.getElementById('btn-stage-chat-toggle');

    if (btnStageMute) btnStageMute.addEventListener('click', () => this.toggleMute());
    if (btnStageVideo) btnStageVideo.addEventListener('click', () => this.toggleCamera());
    if (btnStageScreen) btnStageScreen.addEventListener('click', () => this.toggleScreenShare());
    if (btnStageFlip) btnStageFlip.addEventListener('click', () => this.flipCamera());
    if (btnStageDeafen) btnStageDeafen.addEventListener('click', () => this.toggleDeafen());
    if (btnStageMin) btnStageMin.addEventListener('click', () => this.closeVideoStage());
    if (btnStagePip) btnStagePip.addEventListener('click', () => this.togglePipMode());
    if (btnStageFull) btnStageFull.addEventListener('click', () => this.toggleFullscreen());
    if (btnStageEnd) btnStageEnd.addEventListener('click', () => this.endCall());
    if (btnStageChat) btnStageChat.addEventListener('click', () => this.closeVideoStage());
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
      console.error('Media acquisition error:', err);
      App.showToast(isVideo ? 'Camera or Microphone access required' : 'Microphone access is required');
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
        avatar: partnerAvatar,
        name: partnerName,
        color: partnerColor
      });

      if (isVideo) {
        this.openVideoStage();
      }

      this.playOutgoingRinging();
      this.setupSpeakingDetector();
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
    this.playIncomingRingtone();
  },

  async acceptCall(withVideo = null) {
    this.stopRingtone();
    const modal = document.getElementById('incoming-call-modal');
    if (modal) modal.classList.remove('active');

    if (!this.activeCall) return;

    const requestVideo = withVideo !== null ? withVideo : (this.activeCall.callType === 'video');

    try {
      await this.acquireLocalMedia(requestVideo);
    } catch (err) {
      console.error('Media permission error on accept:', err);
      App.showToast('Microphone & camera permissions required to answer');
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

    this.playConnectedChime();
    this.startCallTimer();
    this.setupSpeakingDetector();

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

    // Remote track handler
    pc.ontrack = (event) => {
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

  // ================= Group Voice & Video Channels =================

  async joinGroupVoice(channelId, channelName, isVideo = false) {
    if (this.activeCall) {
      if (this.activeCall.type === 'group' && this.activeCall.channelId === channelId) {
        if (isVideo && !this.isCameraOn) {
          this.openVideoStage();
          this.toggleCamera();
        }
        return;
      }
      this.endCall();
    }

    try {
      await this.acquireLocalMedia(isVideo);
    } catch (err) {
      console.error('Microphone/Camera error joining group call:', err);
      App.showToast('Microphone access is required for group rooms');
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

      this.playConnectedChime();
      this.startCallTimer();
      this.setupSpeakingDetector();
      this.updateGroupVoiceButtonUI(true);

      if (isVideo) {
        this.openVideoStage();
      }

      // Connect mesh WebRTC to existing participants
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
    this.playEndCallChime();
    this.updateGroupVoiceButtonUI(false);
    this.cleanupCall();
  },

  async createGroupPeerConnection(targetSocketId, targetUser, isInitiator) {
    if (this.peerConnections.has(targetSocketId)) {
      try {
        this.peerConnections.get(targetSocketId).close();
      } catch (e) {}
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(targetSocketId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

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
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        App.socket.emit('group_voice_signal', {
          targetSocketId,
          signal: offer,
          channelId: this.activeCall.channelId
        });
      } catch (err) {
        console.error('Error creating group mesh offer:', err);
      }
    }

    return pc;
  },

  // ================= Media Acquisition & Controls =================

  async acquireLocalMedia(enableVideo = false) {
    this.stopLocalMedia();

    // 1. Audio stream
    this.localAudioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });

    this.localStream = new MediaStream();
    this.localAudioStream.getAudioTracks().forEach(t => this.localStream.addTrack(t));

    // 2. Video stream if requested
    if (enableVideo) {
      try {
        this.localVideoStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user'
          }
        });
        this.localVideoStream.getVideoTracks().forEach(t => this.localStream.addTrack(t));
        this.isCameraOn = true;
      } catch (err) {
        console.warn('Camera acquisition failed, continuing audio-only:', err);
        this.isCameraOn = false;
      }
    } else {
      this.isCameraOn = false;
    }

    this.updateControlsUI();
    this.updateLocalVideoPreview();
  },

  stopLocalMedia() {
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach(t => t.stop());
      this.localAudioStream = null;
    }
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach(t => t.stop());
      this.localVideoStream = null;
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.isCameraOn = false;
    this.isScreenSharing = false;
  },

  async toggleCamera() {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
    }

    if (this.isCameraOn) {
      // Turn camera OFF
      if (this.localVideoStream) {
        this.localVideoStream.getTracks().forEach(t => t.stop());
        this.localVideoStream = null;
      }
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach(t => {
          t.stop();
          this.localStream.removeTrack(t);
        });
      }

      // Replace video tracks on all peer connections with null
      this.peerConnections.forEach(pc => {
        const senders = pc.getSenders();
        const vidSender = senders.find(s => s.track && s.track.kind === 'video');
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
      // Turn camera ON
      try {
        const videoConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        };

        if (this.availableVideoDevices.length > 0) {
          const device = this.availableVideoDevices[this.currentVideoDeviceIndex];
          if (device && device.deviceId) {
            videoConstraints.deviceId = { exact: device.deviceId };
          }
        }

        this.localVideoStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints
        });

        const newVideoTrack = this.localVideoStream.getVideoTracks()[0];
        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(t => {
            t.stop();
            this.localStream.removeTrack(t);
          });
          this.localStream.addTrack(newVideoTrack);
        }

        // Replace or add track on all active peer connections
        this.peerConnections.forEach(async (pc) => {
          const senders = pc.getSenders();
          const vidSender = senders.find(s => s.track && s.track.kind === 'video');
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
        console.error('Camera permission failed:', err);
        App.showToast('Could not access camera: ' + (err.message || 'Permission denied'));
      }
    }
  },

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      await this.stopScreenShare();
    } else {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always' },
          audio: true
        });

        const screenTrack = this.screenStream.getVideoTracks()[0];

        // Handle user stopping screen share via native browser floating UI
        screenTrack.onended = () => {
          this.stopScreenShare();
        };

        // If local video stream was on, pause it
        if (this.localVideoStream) {
          this.localVideoStream.getVideoTracks().forEach(t => t.enabled = false);
        }

        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(t => this.localStream.removeTrack(t));
          this.localStream.addTrack(screenTrack);
        }

        this.peerConnections.forEach(async (pc) => {
          const senders = pc.getSenders();
          const vidSender = senders.find(s => s.track && s.track.kind === 'video');
          if (vidSender) {
            await vidSender.replaceTrack(screenTrack);
          } else {
            pc.addTrack(screenTrack, this.localStream);
            this.renegotiatePeerConnection(pc);
          }
        });

        this.isScreenSharing = true;
        App.showToast('Screen sharing started 🖥️');
        this.broadcastMediaState();
        this.updateControlsUI();
        this.updateLocalVideoPreview();

        if (!this.isStageOpen) {
          this.openVideoStage();
        }
      } catch (err) {
        console.warn('Screen share canceled or error:', err);
      }
    }
  },

  async stopScreenShare() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    this.isScreenSharing = false;

    // Restore camera track if camera was previously on
    if (this.isCameraOn && this.localVideoStream) {
      const camTrack = this.localVideoStream.getVideoTracks()[0];
      if (camTrack) {
        camTrack.enabled = true;
        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(t => this.localStream.removeTrack(t));
          this.localStream.addTrack(camTrack);
        }
        this.peerConnections.forEach(pc => {
          const vidSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (vidSender) vidSender.replaceTrack(camTrack).catch(() => {});
        });
      }
    } else {
      this.peerConnections.forEach(pc => {
        const vidSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (vidSender) vidSender.replaceTrack(null).catch(() => {});
      });
    }

    App.showToast('Screen sharing ended');
    this.broadcastMediaState();
    this.updateControlsUI();
    this.updateLocalVideoPreview();
  },

  async flipCamera() {
    if (this.availableVideoDevices.length <= 1 || !this.isCameraOn) return;
    this.currentVideoDeviceIndex = (this.currentVideoDeviceIndex + 1) % this.availableVideoDevices.length;
    await this.toggleCamera(); // Turn off
    await this.toggleCamera(); // Turn on with next device
    App.showToast('Switched camera');
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
      } else if (this.activeCall.type === 'group') {
        // Group mesh renegotiation
        this.peerConnections.forEach((val, socketId) => {
          if (val === pc) {
            App.socket.emit('group_voice_signal', {
              targetSocketId: socketId,
              signal: offer,
              channelId: this.activeCall.channelId
            });
          }
        });
      }
    } catch (e) {
      console.warn('Renegotiation error:', e);
    }
  },

  broadcastMediaState() {
    if (!this.activeCall) return;
    const payload = {
      isVideoOn: this.isCameraOn || this.isScreenSharing,
      isScreenSharing: this.isScreenSharing,
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

  // ================= Audio Output & Playback =================

  attachRemoteAudio(id, stream) {
    let audio = this.audioElements.get(id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.volume = 1.0;
      audio.muted = this.isDeafened;
      audio.style.position = 'fixed';
      audio.style.opacity = '0';
      audio.style.pointerEvents = 'none';
      audio.style.bottom = '0';
      audio.id = `remote-audio-${id}`;
      document.body.appendChild(audio);
      this.audioElements.set(id, audio);
    }

    audio.srcObject = stream;
    audio.muted = this.isDeafened;

    const playAudio = () => {
      const p = audio.play();
      if (p !== undefined) {
        p.catch((err) => {
          console.warn(`Autoplay unlock needed for ${id}:`, err);
        });
      }
    };
    playAudio();
  },

  attachRemoteVideo(id, stream) {
    const videoEl = document.getElementById('remote-video-feed');
    const fallbackEl = document.getElementById('remote-video-fallback');

    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.style.display = 'block';
      videoEl.play().catch(() => {});
      if (fallbackEl) fallbackEl.style.display = 'none';
    }

    this.openVideoStage();
  },

  attachGroupParticipantVideo(socketId, stream, user) {
    const grid = document.getElementById('video-stage-group-grid');
    if (!grid) return;

    let tile = document.getElementById(`group-tile-${socketId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'group-video-tile';
      tile.id = `group-tile-${socketId}`;
      tile.dataset.callUserId = user?.id || socketId;
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

  updateRemoteMediaUI(key, { isVideoOn, isScreenSharing, isMuted, userId }) {
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
    } else {
      // Group tile
      const tile = document.getElementById(`group-tile-${key}`) || document.querySelector(`[data-call-user-id="${userId}"]`);
      if (tile) {
        const vid = tile.querySelector('video');
        const fallback = tile.querySelector('.video-fallback-avatar');
        const mic = tile.querySelector('[id^="mic-status-"]');
        if (mic) mic.textContent = isMuted ? '🔇' : '🎤';
        if (vid && fallback) {
          vid.style.display = isVideoOn ? 'block' : 'none';
          fallback.style.display = isVideoOn ? 'none' : 'flex';
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

    const hasVideo = this.isCameraOn || this.isScreenSharing;
    if (vidEl) {
      if (hasVideo && this.localStream) {
        vidEl.srcObject = this.localStream;
        vidEl.style.display = 'block';
        vidEl.play().catch(() => {});
        if (fallbackEl) fallbackEl.style.display = 'none';
      } else {
        vidEl.srcObject = null;
        vidEl.style.display = 'none';
        if (fallbackEl) fallbackEl.style.display = 'flex';
      }
    }
  },

  // ================= Stage Modals & Controls =================

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
        typeBadge.textContent = this.isCameraOn || this.isScreenSharing ? 'LIVE VIDEO' : 'AUDIO / VIDEO CALL';
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

  toggleFullscreen() {
    const stage = document.getElementById('video-stage-container');
    if (!stage) return;

    if (!document.fullscreenElement) {
      stage.requestFullscreen().catch(() => {});
      this.isFullscreen = true;
    } else {
      document.exitFullscreen().catch(() => {});
      this.isFullscreen = false;
    }
  },

  async togglePipMode() {
    const vid = document.getElementById('remote-video-feed');
    if (!vid) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await vid.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP error:', e);
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

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    this.audioElements.forEach(audio => {
      audio.muted = this.isDeafened;
    });

    const remoteVid = document.getElementById('remote-video-feed');
    if (remoteVid) remoteVid.muted = this.isDeafened;

    this.updateControlsUI();
    App.showToast(this.isDeafened ? 'Audio Deafen ON 🔇' : 'Audio Deafen OFF 🔊');
  },

  updateControlsUI() {
    // Stage Controls
    const btnMute = document.getElementById('btn-stage-mute');
    const muteIcon = document.getElementById('stage-mute-icon');
    const btnVideo = document.getElementById('btn-stage-video');
    const videoIcon = document.getElementById('stage-video-icon');
    const btnScreen = document.getElementById('btn-stage-screenshare');
    const btnDeafen = document.getElementById('btn-stage-deafen');

    if (btnMute && muteIcon) {
      btnMute.classList.toggle('active-control-danger', this.isMuted);
      muteIcon.textContent = this.isMuted ? '🔇' : '🎤';
    }

    if (btnVideo && videoIcon) {
      btnVideo.classList.toggle('active-control-success', this.isCameraOn);
      btnVideo.classList.toggle('active-control-danger', !this.isCameraOn);
      videoIcon.textContent = this.isCameraOn ? '📹' : '📷';
    }

    if (btnScreen) {
      btnScreen.classList.toggle('active-control-accent', this.isScreenSharing);
    }

    if (btnDeafen) {
      btnDeafen.classList.toggle('active-control-danger', this.isDeafened);
    }

    // Floating Bar Controls
    const barMute = document.getElementById('btn-call-mute');
    const barVideo = document.getElementById('btn-call-video-toggle');
    const barDeafen = document.getElementById('btn-call-deafen');

    if (barMute) {
      barMute.classList.toggle('active-control-danger', this.isMuted);
      barMute.innerHTML = this.isMuted ? '<span>🔇</span>' : '<span>🎤</span>';
    }
    if (barVideo) {
      barVideo.classList.toggle('active-control-success', this.isCameraOn);
      barVideo.innerHTML = this.isCameraOn ? '<span>📹</span>' : '<span>📷</span>';
    }
    if (barDeafen) {
      barDeafen.classList.toggle('active-control-danger', this.isDeafened);
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

  setupSpeakingDetector() {
    if (!this.localStream) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AudioCtx();
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
        const nowSpeaking = avg > 15;

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

    let dot = container.querySelector(`[data-socket-id="${socketId}"]`);
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'call-participant-avatar';
      dot.dataset.socketId = socketId;
      dot.dataset.callUserId = user?.id;
      dot.style.backgroundColor = user?.avatar_color || '#6366f1';
      dot.textContent = (user?.display_name || user?.username || 'U').charAt(0).toUpperCase();
      dot.title = user?.display_name || user?.username;
      container.appendChild(dot);
    }
  },

  removeParticipantFromGroupCallUI(socketId) {
    const container = document.getElementById('active-call-participants');
    if (container) {
      const dot = container.querySelector(`[data-socket-id="${socketId}"]`);
      if (dot) dot.remove();
    }
    const tile = document.getElementById(`group-tile-${socketId}`);
    if (tile) tile.remove();
  },

  updateGroupVoiceButtonUI(isInVoice) {
    const btnVoice = document.getElementById('btn-header-join-voice');
    const btnVideo = document.getElementById('btn-header-join-video');
    if (btnVoice) {
      btnVoice.classList.toggle('active-in-voice', isInVoice);
      btnVoice.innerHTML = isInVoice ? '<span>🚪 Leave Voice</span>' : '<span>🎙️ Voice</span>';
    }
    if (btnVideo) {
      btnVideo.classList.toggle('active-in-voice', isInVoice);
    }
  },

  // ================= Ringtones & Audio Synthesis =================

  playOutgoingRinging() {
    this.stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const playTone = () => {
        if (!this.activeCall) return;
        const osc1 = this.audioCtx.createOscillator();
        const osc2 = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc1.frequency.value = 440; // Hz
        osc2.frequency.value = 480; // Hz
        gain.gain.value = 0.05;

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc1.start();
        osc2.start();

        setTimeout(() => {
          try {
            gain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.1);
            osc1.stop(this.audioCtx.currentTime + 0.1);
            osc2.stop(this.audioCtx.currentTime + 0.1);
          } catch (e) {}
        }, 1500);
      };

      playTone();
      this.ringTimer = setInterval(playTone, 4000);
    } catch (e) {}
  },

  playIncomingRingtone() {
    this.stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const playBeep = () => {
        if (!this.activeCall) return;
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.frequency.value = 800;
        osc.type = 'sine';
        gain.gain.value = 0.08;

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc.start();
        setTimeout(() => {
          try {
            osc.frequency.value = 600;
          } catch (e) {}
        }, 200);

        setTimeout(() => {
          try {
            gain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.05);
            osc.stop(this.audioCtx.currentTime + 0.05);
          } catch (e) {}
        }, 600);
      };

      playBeep();
      this.ringTimer = setInterval(playBeep, 2000);
    } catch (e) {}
  },

  stopRingtone() {
    clearInterval(this.ringTimer);
    this.ringTimer = null;
  },

  playConnectedChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.frequency.value = 523.25; // C5
      gain.gain.value = 0.08;

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      setTimeout(() => { osc.frequency.value = 659.25; }, 100); // E5
      setTimeout(() => { osc.frequency.value = 783.99; }, 200); // G5
      setTimeout(() => {
        gain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.2);
        osc.stop(this.audioCtx.currentTime + 0.2);
      }, 350);
    } catch (e) {}
  },

  playEndCallChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AudioCtx();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.frequency.value = 600;
      gain.gain.value = 0.08;

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      setTimeout(() => { osc.frequency.value = 400; }, 150);
      setTimeout(() => {
        gain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.1);
        osc.stop(this.audioCtx.currentTime + 0.1);
      }, 300);
    } catch (e) {}
  },

  // ================= Cleanup =================

  cleanupCall() {
    this.stopRingtone();
    clearInterval(this.activeCall?.timerInterval);
    clearInterval(this.speakingInterval);

    this.stopLocalMedia();

    // Close all WebRTC PeerConnections
    this.peerConnections.forEach((pc) => {
      try { pc.close(); } catch (e) {}
    });
    this.peerConnections.clear();
    this.pendingCandidates.clear();

    // Remove remote audio elements
    this.audioElements.forEach((audio) => {
      audio.srcObject = null;
      audio.remove();
    });
    this.audioElements.clear();
    this.remoteStreams.clear();
    this.remoteMediaStates.clear();

    // Reset video elements
    const remoteVid = document.getElementById('remote-video-feed');
    if (remoteVid) {
      remoteVid.srcObject = null;
      remoteVid.style.display = 'none';
    }
    const localVid = document.getElementById('local-video-feed');
    if (localVid) {
      localVid.srcObject = null;
      localVid.style.display = 'none';
    }

    const groupGrid = document.getElementById('video-stage-group-grid');
    if (groupGrid) groupGrid.innerHTML = '';

    // Reset UI
    const bar = document.getElementById('active-call-bar');
    if (bar) bar.classList.remove('active');

    const incomingModal = document.getElementById('incoming-call-modal');
    if (incomingModal) incomingModal.classList.remove('active');

    this.closeVideoStage();
    this.updateGroupVoiceButtonUI(false);

    this.activeCall = null;
    this.isMuted = false;
    this.isCameraOn = false;
    this.isScreenSharing = false;
    this.isDeafened = false;
    this.isSpeaking = false;
  }
};
