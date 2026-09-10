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
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880, now + 0.08);
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

    // Add Channel / Group Modal
    const btnAddChannel = document.getElementById('btn-add-channel');
    const createChannelModal = document.getElementById('create-channel-modal');
    const btnCloseCreateChannel = document.getElementById('btn-close-create-channel');
    const btnCancelCreateChannel = document.getElementById('btn-cancel-create-channel');
    const createChannelForm = document.getElementById('create-channel-form');

    if (btnAddChannel && createChannelModal) {
      btnAddChannel.addEventListener('click', () => {
        this.renderMemberSelectionCheckboxes();
        createChannelModal.classList.add('active');
      });
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

        // Collect selected member IDs
        const memberCheckboxes = document.querySelectorAll('#create-group-member-list input[type="checkbox"]:checked');
        const selectedMembers = Array.from(memberCheckboxes).map(cb => cb.value);

        try {
          const res = await fetch('/api/channels', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Auth.token}`
            },
            body: JSON.stringify({
              name,
              description: desc,
              icon,
              is_private: selectedMembers.length > 0 ? 1 : 0,
              members: selectedMembers
            })
          });
          const data = await res.json();
          if (data.channel) {
            closeCreateChan();
            createChannelForm.reset();
            this.showToast(`Group #${data.channel.name} created!`);
            this.selectRoom({
              id: data.channel.id,
              name: data.channel.name,
              type: 'channel',
              icon: data.channel.icon,
              desc: data.channel.description,
              created_by: data.channel.created_by
            });
          } else if (data.error) {
            alert(data.error);
          }
        } catch (err) {
          alert('Failed to create group');
        }
      });
    }

    // Delete Group Buttons (Header & Sidebar)
    const btnHeaderDelete = document.getElementById('btn-header-delete-group');
    const btnSidebarDelete = document.getElementById('btn-sidebar-delete-group');
    const handleDelete = async () => {
      if (!this.currentRoom || this.currentRoom.type !== 'channel') return;
      if (!confirm(`Are you sure you want to permanently delete the group #${this.currentRoom.name}? This will remove all its messages.`)) return;

      try {
        const res = await fetch(`/api/channels/${this.currentRoom.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${Auth.token}` }
        });
        const data = await res.json();
        if (data.success) {
          this.showToast(`Group #${this.currentRoom.name} deleted`);
        } else if (data.error) {
          alert(data.error);
        }
      } catch (err) {
        alert('Failed to delete group');
      }
    };
    if (btnHeaderDelete) btnHeaderDelete.addEventListener('click', handleDelete);
    if (btnSidebarDelete) btnSidebarDelete.addEventListener('click', handleDelete);

    // Leave Group Buttons (Header & Sidebar)
    const btnHeaderLeave = document.getElementById('btn-header-leave-group');
    const btnSidebarLeave = document.getElementById('btn-sidebar-leave-group');
    const handleLeave = async () => {
      if (!this.currentRoom || this.currentRoom.type !== 'channel') return;
      if (!confirm(`Are you sure you want to leave the group #${this.currentRoom.name}?`)) return;

      try {
        const res = await fetch(`/api/channels/${this.currentRoom.id}/leave`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${Auth.token}` }
        });
        const data = await res.json();
        if (data.success) {
          this.showToast(`You left #${this.currentRoom.name}`);
          this.channels = this.channels.filter(c => c.id !== this.currentRoom.id);
          this.renderChannelsList();
          const general = this.channels.find(c => c.name === 'general') || this.channels[0];
          if (general) this.selectRoom(general);
        } else if (data.error) {
          alert(data.error);
        }
      } catch (err) {
        alert('Failed to leave group');
      }
    };
    if (btnHeaderLeave) btnHeaderLeave.addEventListener('click', handleLeave);
    if (btnSidebarLeave) btnSidebarLeave.addEventListener('click', handleLeave);
  },

  renderMemberSelectionCheckboxes() {
    const list = document.getElementById('create-group-member-list');
    if (!list) return;

    const otherUsers = this.users.filter(u => Auth.user && u.id !== Auth.user.id);
    if (otherUsers.length === 0) {
      list.innerHTML = '<div class="text-xs text-muted" style="padding:8px;">No other users registered yet. You can still create the group!</div>';
      return;
    }

    list.innerHTML = '';
    otherUsers.forEach(u => {
      const isOnline = this.onlineUserIds.has(u.id);
      const item = document.createElement('label');
      item.className = 'member-select-item';
      item.innerHTML = `
        <input type="checkbox" value="${u.id}">
        <div class="member-select-avatar" style="background-color:${u.avatar_color || '#6366f1'}">
          ${(u.display_name || u.username).charAt(0).toUpperCase()}
        </div>
        <span class="member-select-name">${u.display_name || u.username} (@${u.username})</span>
        <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
      `;
      list.appendChild(item);
    });
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
      if (dot) dot.textContent = 'Connected';
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
      const exists = this.channels.some(c => c.id === channel.id);
      if (!exists) {
        this.channels.push(channel);
        this.renderChannelsList();
      }
    });

    this.socket.on('channel_deleted', ({ channelId }) => {
      this.channels = this.channels.filter(c => c.id !== channelId);
      this.renderChannelsList();

      if (this.currentRoom && this.currentRoom.id === channelId) {
        this.showToast('This group was deleted by the creator');
        const general = this.channels.find(c => c.name === 'general') || this.channels[0];
        if (general) this.selectRoom(general);
      }
    });

    this.socket.on('member_left', ({ channelId, userId }) => {
      if (Auth.user && Auth.user.id === userId) {
        this.channels = this.channels.filter(c => c.id !== channelId);
        this.renderChannelsList();
        if (this.currentRoom && this.currentRoom.id === channelId) {
          const general = this.channels.find(c => c.name === 'general') || this.channels[0];
          if (general) this.selectRoom(general);
        }
      }
      this.renderRoomMembers();
    });

    this.socket.on('member_removed', ({ channelId, userId }) => {
      if (Auth.user && Auth.user.id === userId) {
        this.showToast('You were removed from the group by the admin');
        this.channels = this.channels.filter(c => c.id !== channelId);
        this.renderChannelsList();
        if (this.currentRoom && this.currentRoom.id === channelId) {
          const general = this.channels.find(c => c.name === 'general') || this.channels[0];
          if (general) this.selectRoom(general);
        }
      }
      this.renderRoomMembers();
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
      const headers = Auth.token ? { 'Authorization': `Bearer ${Auth.token}` } : {};
      const res = await fetch('/api/channels', { headers });
      const data = await res.json();
      this.channels = data.channels || [];
      this.renderChannelsList();

      if (!this.currentRoom && this.channels.length > 0) {
        const general = this.channels.find(c => c.name === 'general') || this.channels[0];
        this.selectRoom({
          id: general.id,
          name: general.name,
          type: 'channel',
          icon: general.icon,
          desc: general.description,
          created_by: general.created_by
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
          desc: c.description,
          created_by: c.created_by
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

  async renderRoomMembers() {
    const memberList = document.getElementById('room-member-list');
    const memberCount = document.getElementById('member-count');
    if (!memberList) return;

    memberList.innerHTML = '';

    const defaultIds = ['chan_general', 'chan_random', 'chan_tech', 'chan_media'];
    const isChannel = this.currentRoom && this.currentRoom.type === 'channel';
    const isDefault = this.currentRoom && defaultIds.includes(this.currentRoom.id);
    const isCreator = this.currentRoom && Auth.user && this.currentRoom.created_by === Auth.user.id;

    if (isChannel && !isDefault) {
      try {
        const res = await fetch(`/api/channels/${this.currentRoom.id}/members`);
        const data = await res.json();
        const members = data.members || [];
        if (memberCount) memberCount.textContent = members.length;

        members.forEach(u => {
          const isOnline = this.onlineUserIds.has(u.id);
          const isThisUserCreator = this.currentRoom.created_by === u.id;
          const canRemove = isCreator && u.id !== Auth.user.id;

          const item = document.createElement('div');
          item.className = 'member-item';
          item.innerHTML = `
            <div class="member-avatar" style="background-color:${u.avatar_color || '#6366f1'}">
              ${(u.display_name || u.username).charAt(0).toUpperCase()}
            </div>
            <div style="flex:1;min-width:0;">
              <div class="member-name">
                ${u.display_name || u.username}
                ${isThisUserCreator ? '<span class="admin-badge">Admin</span>' : ''}
              </div>
              <div class="text-xs text-muted">@${u.username} • ${isOnline ? 'Online' : 'Offline'}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
              ${canRemove ? `<button class="btn-remove-member" title="Remove ${u.display_name || u.username} from group" onclick="App.removeMemberFromGroup('${u.id}', '${u.display_name || u.username}')">✕</button>` : ''}
            </div>
          `;
          memberList.appendChild(item);
        });
        return;
      } catch (e) {}
    }

    // Default: show all users
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

  async removeMemberFromGroup(userId, displayName) {
    if (!this.currentRoom || this.currentRoom.type !== 'channel') return;
    if (!confirm(`Remove ${displayName} from #${this.currentRoom.name}?`)) return;

    try {
      const res = await fetch(`/api/channels/${this.currentRoom.id}/members/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${Auth.token}` }
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Removed ${displayName} from group`);
      } else if (data.error) {
        alert(data.error);
      }
    } catch (e) {
      alert('Failed to remove member');
    }
  },

  updateGroupActionButtons() {
    const btnHeaderDelete = document.getElementById('btn-header-delete-group');
    const btnSidebarDelete = document.getElementById('btn-sidebar-delete-group');
    const btnHeaderLeave = document.getElementById('btn-header-leave-group');
    const btnSidebarLeave = document.getElementById('btn-sidebar-leave-group');

    const defaultIds = ['chan_general', 'chan_random', 'chan_tech', 'chan_media'];
    const isChannel = this.currentRoom && this.currentRoom.type === 'channel';
    const isDefault = this.currentRoom && defaultIds.includes(this.currentRoom.id);
    const isCreator = this.currentRoom && Auth.user && this.currentRoom.created_by === Auth.user.id;

    if (isChannel && !isDefault) {
      if (isCreator) {
        if (btnHeaderDelete) btnHeaderDelete.style.display = 'inline-flex';
        if (btnSidebarDelete) btnSidebarDelete.style.display = 'block';
        if (btnHeaderLeave) btnHeaderLeave.style.display = 'none';
        if (btnSidebarLeave) btnSidebarLeave.style.display = 'none';
      } else {
        if (btnHeaderDelete) btnHeaderDelete.style.display = 'none';
        if (btnSidebarDelete) btnSidebarDelete.style.display = 'none';
        if (btnHeaderLeave) btnHeaderLeave.style.display = 'inline-flex';
        if (btnSidebarLeave) btnSidebarLeave.style.display = 'block';
      }
    } else {
      if (btnHeaderDelete) btnHeaderDelete.style.display = 'none';
      if (btnSidebarDelete) btnSidebarDelete.style.display = 'none';
      if (btnHeaderLeave) btnHeaderLeave.style.display = 'none';
      if (btnSidebarLeave) btnSidebarLeave.style.display = 'none';
    }
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
    this.updateGroupActionButtons();
    this.renderRoomMembers();
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

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
