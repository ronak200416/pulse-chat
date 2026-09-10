// Pulse Chat Client Application Coordinator
const App = {
  socket: null,
  channels: [],
  users: [],
  onlineUserIds: new Set(),
  currentRoom: null,
  typingTimeout: null,
  soundEnabled: true,
  audioCtx: null,

  async init() {
    NetworkModal.init();
    Chat.init();
    this.initAudio();
    this.bindUIEvents();

    const isAuthenticated = await Auth.init();
    if (isAuthenticated && Auth.user) {
      this.onAuthenticated(Auth.user, Auth.token);
    }
  },

  initAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    } catch (e) {
      console.warn('Web Audio not supported');
    }
  },

  playChime(type = 'receive') {
    if (!this.soundEnabled || !this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      const now = this.audioCtx.currentTime;
      if (type === 'send') {
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      } else {
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880, now + 0.08); // A5
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      }
    } catch (e) {}
  },

  bindUIEvents() {
    // Mobile Sidebar Toggle
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    const btnCloseSidebar = document.getElementById('btn-close-sidebar');
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');

    if (btnToggleSidebar && sidebar && backdrop) {
      btnToggleSidebar.addEventListener('click', () => {
        sidebar.classList.add('open');
        backdrop.classList.add('active');
      });
    }

    const closeDrawer = () => {
      if (sidebar) sidebar.classList.remove('open');
      if (backdrop) backdrop.classList.remove('active');
    };

    if (btnCloseSidebar) btnCloseSidebar.addEventListener('click', closeDrawer);
    if (backdrop) backdrop.addEventListener('click', closeDrawer);

    // Right Sidebar / Members Toggle
    const btnToggleMembers = document.getElementById('btn-toggle-members');
    const rightSidebar = document.getElementById('app-right-sidebar');
    const btnCloseRight = document.getElementById('btn-close-right-sidebar');

    if (btnToggleMembers && rightSidebar) {
      btnToggleMembers.addEventListener('click', () => {
        rightSidebar.classList.toggle('collapsed');
      });
    }
    if (btnCloseRight && rightSidebar) {
      btnCloseRight.addEventListener('click', () => {
        rightSidebar.classList.add('collapsed');
      });
    }

    // Sound Toggle Button
    const btnSound = document.getElementById('btn-toggle-sound');
    const soundIcon = document.getElementById('sound-icon');
    if (btnSound && soundIcon) {
      btnSound.addEventListener('click', () => {
        this.soundEnabled = !this.soundEnabled;
        soundIcon.textContent = this.soundEnabled ? '🔊' : '🔇';
        this.showToast(this.soundEnabled ? 'Sound notifications ON' : 'Sound notifications OFF');
      });
    }

    // Add Channel Modal
    const btnAddChannel = document.getElementById('btn-add-channel');
    const createChannelModal = document.getElementById('create-channel-modal');
    const btnCloseCreateChannel = document.getElementById('btn-close-create-channel');
    const btnCancelCreateChannel = document.getElementById('btn-cancel-create-channel');
    const createChannelForm = document.getElementById('create-channel-form');

    if (btnAddChannel && createChannelModal) {
      btnAddChannel.addEventListener('click', () => createChannelModal.classList.add('active'));
    }
    const closeCreateChan = () => {
      if (createChannelModal) createChannelModal.classList.remove('active');
    };
    if (btnCloseCreateChannel) btnCloseCreateChannel.addEventListener('click', closeCreateChan);
    if (btnCancelCreateChannel) btnCancelCreateChannel.addEventListener('click', closeCreateChan);

    if (createChannelForm) {
      createChannelForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('new-channel-name').value.trim();
        const desc = document.getElementById('new-channel-desc').value.trim();
        const icon = document.getElementById('new-channel-icon').value.trim() || '💬';

        try {
          const res = await fetch('/api/channels', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Auth.token}`
            },
            body: JSON.stringify({ name, description: desc, icon })
          });
          const data = await res.json();
          if (data.channel) {
            closeCreateChan();
            createChannelForm.reset();
            this.showToast(`Channel #${data.channel.name} created!`);
            this.selectRoom({
              id: data.channel.id,
              name: data.channel.name,
              type: 'channel',
              icon: data.channel.icon,
              desc: data.channel.description
            });
          } else if (data.error) {
            alert(data.error);
          }
        } catch (err) {
          alert('Failed to create channel');
        }
      });
    }
  },

  onAuthenticated(user, token) {
    this.connectSocket(token);
    this.loadChannels();
    this.loadUsers();
  },

  connectSocket(token) {
    if (this.socket) {
      this.socket.disconnect();
    }

    this.socket = io({
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    this.socket.on('connect', () => {
      this.socket.emit('authenticate', token);
      const dot = document.getElementById('server-status-text');
      if (dot) dot.textContent = 'PC Server Live';
    });

    this.socket.on('online_users_list', (userIds) => {
      this.onlineUserIds = new Set(userIds);
      this.updateOnlineBadges();
      this.renderUsersList();
    });

    this.socket.on('user_presence', ({ userId, status }) => {
      if (status === 'online') {
        this.onlineUserIds.add(userId);
      } else {
        this.onlineUserIds.delete(userId);
      }
      this.updateOnlineBadges();
      this.renderUsersList();
      this.renderRoomMembers();
    });

    this.socket.on('channel_created', (channel) => {
      this.channels.push(channel);
      this.renderChannelsList();
    });

    this.socket.on('new_message', (msg) => {
      Chat.appendMessage(msg);
      if (Auth.user && msg.sender_id !== Auth.user.id) {
        this.playChime('receive');
      } else {
        this.playChime('send');
      }
    });

    this.socket.on('dm_notification', (msg) => {
      if (this.currentRoom && this.currentRoom.id === msg.room_id) return;
      this.showToast(`New DM from ${msg.sender_display_name || msg.sender_username}: ${msg.content || 'Attachment'}`);
      this.playChime('receive');
    });

    this.socket.on('reaction_updated', ({ messageId, reactions }) => {
      Chat.updateReactions(messageId, reactions);
    });

    this.socket.on('message_deleted', ({ messageId }) => {
      Chat.removeMessageElement(messageId);
    });

    this.socket.on('message_edited', ({ message }) => {
      Chat.updateMessageElement(message);
    });

    this.socket.on('user_typing', ({ roomId, username }) => {
      if (this.currentRoom && this.currentRoom.id === roomId) {
        this.showTypingIndicator(username);
      }
    });

    this.socket.on('user_stop_typing', ({ roomId }) => {
      if (this.currentRoom && this.currentRoom.id === roomId) {
        this.hideTypingIndicator();
      }
    });

    this.socket.on('disconnect', () => {
      const dot = document.getElementById('server-status-text');
      if (dot) dot.textContent = 'Reconnecting...';
    });
  },

  async loadChannels() {
    try {
      const res = await fetch('/api/channels');
      const data = await res.json();
      this.channels = data.channels || [];
      this.renderChannelsList();

      // Default select #general if no room selected
      if (!this.currentRoom && this.channels.length > 0) {
        const general = this.channels.find(c => c.name === 'general') || this.channels[0];
        this.selectRoom({
          id: general.id,
          name: general.name,
          type: 'channel',
          icon: general.icon,
          desc: general.description
        });
      }
    } catch (err) {
      console.error('Failed to load channels:', err);
    }
  },

  async loadUsers() {
    try {
      const res = await fetch('/api/users');
      const data = await res.json();
      this.users = data.users || [];
      this.renderUsersList();
      this.renderRoomMembers();
    } catch (err) {
      console.error('Failed to load users:', err);
    }
  },

  renderChannelsList() {
    const list = document.getElementById('channels-list');
    if (!list) return;
    list.innerHTML = '';

    this.channels.forEach(c => {
      const item = document.createElement('div');
      item.className = `nav-item ${this.currentRoom && this.currentRoom.id === c.id ? 'active' : ''}`;
      item.dataset.channelId = c.id;
      item.innerHTML = `
        <span class="nav-item-icon">${c.icon || '#'}</span>
        <span class="nav-item-title">${c.name}</span>
      `;
      item.addEventListener('click', () => {
        this.selectRoom({
          id: c.id,
          name: c.name,
          type: 'channel',
          icon: c.icon,
          desc: c.description
        });
        this.closeMobileDrawer();
      });
      list.appendChild(item);
    });
  },

  renderUsersList() {
    const list = document.getElementById('users-list');
    if (!list) return;
    list.innerHTML = '';

    const otherUsers = this.users.filter(u => Auth.user && u.id !== Auth.user.id);

    otherUsers.forEach(u => {
      const isOnline = this.onlineUserIds.has(u.id);
      const dmRoomId = this.getDmRoomId(Auth.user.id, u.id);
      const item = document.createElement('div');
      item.className = `nav-item ${this.currentRoom && this.currentRoom.id === dmRoomId ? 'active' : ''}`;
      item.innerHTML = `
        <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
        <span class="nav-item-title">${u.display_name || u.username}</span>
      `;
      item.addEventListener('click', () => {
        this.selectRoom({
          id: dmRoomId,
          name: u.display_name || u.username,
          type: 'direct',
          recipientId: u.id,
          icon: '👤',
          desc: u.bio || `Direct message with @${u.username}`
        });
        this.closeMobileDrawer();
      });
      list.appendChild(item);
    });
  },

  renderRoomMembers() {
    const memberList = document.getElementById('room-member-list');
    const memberCount = document.getElementById('member-count');
    if (!memberList) return;

    memberList.innerHTML = '';
    if (memberCount) memberCount.textContent = this.users.length;

    this.users.forEach(u => {
      const isOnline = this.onlineUserIds.has(u.id);
      const item = document.createElement('div');
      item.className = 'member-item';
      item.innerHTML = `
        <div class="member-avatar" style="background-color:${u.avatar_color || '#6366f1'}">
          ${(u.display_name || u.username).charAt(0).toUpperCase()}
        </div>
        <div style="flex:1;min-width:0;">
          <div class="member-name">${u.display_name || u.username}</div>
          <div class="text-xs text-muted">@${u.username} • ${isOnline ? 'Online' : 'Offline'}</div>
        </div>
        <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
      `;
      memberList.appendChild(item);
    });
  },

  getDmRoomId(userA, userB) {
    const sorted = [userA, userB].sort();
    return `dm_${sorted[0]}_${sorted[1]}`;
  },

  selectRoom(room) {
    if (this.currentRoom && this.socket) {
      this.socket.emit('leave_room', this.currentRoom.id);
    }

    this.currentRoom = room;

    if (this.socket) {
      this.socket.emit('join_room', room.id);
    }

    this.renderChannelsList();
    this.renderUsersList();
    Chat.loadRoom(room);
  },

  closeMobileDrawer() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  },

  updateOnlineBadges() {
    const badge = document.getElementById('online-count-badge');
    if (badge) {
      badge.textContent = `${this.onlineUserIds.size} Online`;
    }
  },

  emitTyping() {
    if (!this.socket || !this.currentRoom || !Auth.user) return;
    this.socket.emit('typing', {
      roomId: this.currentRoom.id,
      username: Auth.user.display_name || Auth.user.username
    });

    clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      this.emitStopTyping();
    }, 2500);
  },

  emitStopTyping() {
    if (!this.socket || !this.currentRoom || !Auth.user) return;
    this.socket.emit('stop_typing', {
      roomId: this.currentRoom.id,
      username: Auth.user.display_name || Auth.user.username
    });
  },

  showTypingIndicator(username) {
    const bar = document.getElementById('typing-bar');
    const text = document.getElementById('typing-text');
    if (bar && text) {
      text.textContent = `${username} is typing...`;
      bar.style.display = 'flex';
    }
  },

  hideTypingIndicator() {
    const bar = document.getElementById('typing-bar');
    if (bar) bar.style.display = 'none';
  },

  showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
};

// Initialize application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
