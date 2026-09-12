// Pulse Chat Client Application Coordinator
const App = {
  socket: null,
  channels: [],
  users: [],
  friends: [],
  pendingRequests: { incoming: [], outgoing: [] },
  onlineUserIds: new Set(),
  currentRoom: null,
  typingTimeout: null,
  soundEnabled: true,
  audioCtx: null,
  friendSearchDebounce: null,

  async init() {
    Chat.init();
    this.initAudio();
    this.bindUIEvents();
    this.bindFriendModalEvents();

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

    // Pinned General Chat Button
    const btnGeneral = document.getElementById('btn-general-chat');
    if (btnGeneral) {
      btnGeneral.addEventListener('click', () => {
        this.selectGeneralRoom();
        this.closeMobileDrawer();
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
              is_private: 0,
              members: selectedMembers
            })
          });
          const data = await res.json();
          if (data.channel) {
            closeCreateChan();
            createChannelForm.reset();
            this.showToast(`Group #${data.channel.name} created!`);
            
            const exists = this.channels.some(c => c.id === data.channel.id);
            if (!exists) {
              this.channels.push(data.channel);
              this.renderChannelsList();
            }

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
      if (!this.currentRoom || this.currentRoom.type !== 'channel' || this.currentRoom.id === 'chan_general') return;
      if (!confirm(`Are you sure you want to permanently delete the group #${this.currentRoom.name}? This will remove all its messages.`)) return;

      try {
        const res = await fetch(`/api/channels/${this.currentRoom.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${Auth.token}` }
        });
        const data = await res.json();
        if (data.success) {
          this.showToast(`Group #${this.currentRoom.name} deleted`);
          this.channels = this.channels.filter(c => c.id !== this.currentRoom.id);
          this.renderChannelsList();
          this.selectGeneralRoom();
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
      if (!this.currentRoom || this.currentRoom.type !== 'channel' || this.currentRoom.id === 'chan_general') return;
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
          this.selectGeneralRoom();
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

  bindFriendModalEvents() {
    const btnOpenModal = document.getElementById('btn-open-friend-modal');
    const modal = document.getElementById('friend-manager-modal');
    const btnCloseModal = document.getElementById('btn-close-friend-modal');
    const tabBtns = document.querySelectorAll('.friend-tab-btn');
    const searchInput = document.getElementById('friend-search-input');

    if (btnOpenModal) {
      btnOpenModal.addEventListener('click', () => {
        this.openFriendModal('tab-find-friends');
      });
    }

    if (btnCloseModal && modal) {
      btnCloseModal.addEventListener('click', () => {
        modal.classList.remove('active');
      });
    }

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        this.switchFriendTab(tabId);
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(this.friendSearchDebounce);
        const q = e.target.value.trim();
        this.friendSearchDebounce = setTimeout(() => {
          this.performFriendSearch(q);
        }, 300);
      });
    }
  },

  openFriendModal(tabId = 'tab-find-friends') {
    const modal = document.getElementById('friend-manager-modal');
    if (modal) {
      modal.classList.add('active');
      this.switchFriendTab(tabId);
    }
  },

  switchFriendTab(tabId) {
    const tabBtns = document.querySelectorAll('.friend-tab-btn');
    const tabContents = document.querySelectorAll('.friend-tab-content');

    tabBtns.forEach(btn => {
      if (btn.dataset.tab === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    tabContents.forEach(tc => {
      if (tc.id === tabId) {
        tc.style.display = 'flex';
        tc.classList.add('active');
      } else {
        tc.style.display = 'none';
        tc.classList.remove('active');
      }
    });

    if (tabId === 'tab-find-friends') {
      const input = document.getElementById('friend-search-input');
      if (input) {
        input.focus();
        if (input.value.trim()) {
          this.performFriendSearch(input.value.trim());
        }
      }
    } else if (tabId === 'tab-pending-requests') {
      this.loadFriendRequests();
    } else if (tabId === 'tab-my-friends') {
      this.loadFriends();
    }
  },

  async performFriendSearch(query) {
    const container = document.getElementById('friend-search-results');
    if (!container) return;

    if (!query) {
      container.innerHTML = `
        <div class="empty-tab-state">
          <span class="empty-icon">🤝</span>
          <h4>Connect with Friends</h4>
          <p>Type a username or unique ID above to search and send a friend request.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);">Searching users...</div>';

    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`, {
        headers: { 'Authorization': `Bearer ${Auth.token}` }
      });
      const data = await res.json();
      const users = data.users || [];

      if (users.length === 0) {
        container.innerHTML = `
          <div class="empty-tab-state">
            <span class="empty-icon">🔍</span>
            <h4>No Users Found</h4>
            <p>No user matches "${this.escapeHtml(query)}". Check spelling or search by user ID.</p>
          </div>
        `;
        return;
      }

      container.innerHTML = '';
      users.forEach(u => {
        const card = document.createElement('div');
        card.className = 'friend-card';

        let actionHtml = '';
        if (u.relationship === 'friends') {
          actionHtml = `<button class="btn btn-xs btn-glass" onclick="App.openDirectMessage('${u.id}', '${this.escapeHtml(u.display_name || u.username)}')">💬 Message</button>`;
        } else if (u.relationship === 'pending_sent') {
          actionHtml = `<span class="badge-sm" style="color:var(--text-muted);font-size:0.75rem;">⏳ Request Sent</span>`;
        } else if (u.relationship === 'pending_received') {
          actionHtml = `<button class="btn btn-xs btn-primary" onclick="App.acceptFriendRequest('${u.request_id}')">✓ Accept</button>`;
        } else {
          actionHtml = `<button class="btn btn-xs btn-primary" onclick="App.sendFriendRequest('${u.username}')">+ Add Friend</button>`;
        }

        card.innerHTML = `
          <div class="friend-card-left">
            <div class="friend-card-avatar" style="background-color: ${u.avatar_color || '#6366f1'}">
              ${(u.display_name || u.username).charAt(0).toUpperCase()}
            </div>
            <div class="friend-card-info">
              <div class="friend-card-name">${this.escapeHtml(u.display_name || u.username)}</div>
              <div class="friend-card-handle">@${this.escapeHtml(u.username)}</div>
              ${u.bio ? `<div class="friend-card-bio">${this.escapeHtml(u.bio)}</div>` : ''}
            </div>
          </div>
          <div class="friend-card-actions">
            ${actionHtml}
          </div>
        `;
        container.appendChild(card);
      });
    } catch (err) {
      container.innerHTML = '<div class="empty-sub-state">Failed to search users</div>';
    }
  },

  async sendFriendRequest(targetIdentifier) {
    try {
      const res = await fetch('/api/friends/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Auth.token}`
        },
        body: JSON.stringify({ target: targetIdentifier })
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(data.message || 'Friend request sent!');
        this.playChime('send');
        const searchInput = document.getElementById('friend-search-input');
        if (searchInput && searchInput.value.trim()) {
          this.performFriendSearch(searchInput.value.trim());
        }
        this.loadFriendRequests();
        if (data.auto_accepted) {
          this.loadFriends();
        }
      } else if (data.error) {
        alert(data.error);
      }
    } catch (e) {
      alert('Failed to send friend request');
    }
  },

  async acceptFriendRequest(requestId) {
    try {
      const res = await fetch('/api/friends/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Auth.token}`
        },
        body: JSON.stringify({ requestId })
      });
      const data = await res.json();
      if (data.success) {
        this.showToast('Friend request accepted! 🤝');
        this.playChime('send');
        this.loadFriends();
        this.loadFriendRequests();
        const searchInput = document.getElementById('friend-search-input');
        if (searchInput && searchInput.value.trim()) {
          this.performFriendSearch(searchInput.value.trim());
        }
      } else if (data.error) {
        alert(data.error);
      }
    } catch (e) {
      alert('Failed to accept friend request');
    }
  },

  async rejectFriendRequest(requestId) {
    try {
      const res = await fetch('/api/friends/reject', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Auth.token}`
        },
        body: JSON.stringify({ requestId })
      });
      const data = await res.json();
      if (data.success) {
        this.showToast('Request dismissed');
        this.loadFriendRequests();
      } else if (data.error) {
        alert(data.error);
      }
    } catch (e) {
      alert('Failed to dismiss request');
    }
  },

  async removeFriend(friendId, friendName) {
    if (!confirm(`Are you sure you want to remove @${friendName} from your friends?`)) return;

    try {
      const res = await fetch(`/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${Auth.token}` }
      });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Removed @${friendName} from friends`);
        this.loadFriends();
        if (this.currentRoom && this.currentRoom.type === 'direct' && this.currentRoom.recipientId === friendId) {
          this.selectGeneralRoom();
        }
      } else if (data.error) {
        alert(data.error);
      }
    } catch (e) {
      alert('Failed to remove friend');
    }
  },

  async loadFriends() {
    try {
      const res = await fetch('/api/friends', {
        headers: { 'Authorization': `Bearer ${Auth.token}` }
      });
      const data = await res.json();
      this.friends = data.friends || [];
      this.renderUsersList();
      this.renderFriendsTab();

      const countEl = document.getElementById('tab-friends-count');
      if (countEl) countEl.textContent = this.friends.length;
    } catch (err) {
      console.error('Failed to load friends:', err);
    }
  },

  async loadFriendRequests() {
    try {
      const res = await fetch('/api/friends/requests', {
        headers: { 'Authorization': `Bearer ${Auth.token}` }
      });
      const data = await res.json();
      this.pendingRequests = {
        incoming: data.incoming || [],
        outgoing: data.outgoing || []
      };

      const incomingCount = this.pendingRequests.incoming.length;
      const sidebarBadge = document.getElementById('friend-requests-badge');
      const tabBadge = document.getElementById('tab-requests-count');

      if (sidebarBadge) {
        sidebarBadge.textContent = incomingCount;
        sidebarBadge.style.display = incomingCount > 0 ? 'inline-flex' : 'none';
      }

      if (tabBadge) {
        tabBadge.textContent = incomingCount;
        tabBadge.style.display = incomingCount > 0 ? 'inline-block' : 'none';
      }

      this.renderRequestsTab();
    } catch (err) {
      console.error('Failed to load friend requests:', err);
    }
  },

  renderRequestsTab() {
    const incomingContainer = document.getElementById('incoming-requests-list');
    const outgoingContainer = document.getElementById('outgoing-requests-list');

    if (incomingContainer) {
      const incoming = this.pendingRequests.incoming;
      if (incoming.length === 0) {
        incomingContainer.innerHTML = '<div class="empty-sub-state">No incoming friend requests</div>';
      } else {
        incomingContainer.innerHTML = '';
        incoming.forEach(req => {
          const card = document.createElement('div');
          card.className = 'request-card';
          card.innerHTML = `
            <div class="friend-card-left">
              <div class="friend-card-avatar" style="background-color:${req.avatar_color || '#6366f1'}">
                ${(req.display_name || req.username).charAt(0).toUpperCase()}
              </div>
              <div class="friend-card-info">
                <div class="friend-card-name">${this.escapeHtml(req.display_name || req.username)}</div>
                <div class="friend-card-handle">@${this.escapeHtml(req.username)}</div>
              </div>
            </div>
            <div class="friend-card-actions">
              <button class="btn btn-xs btn-primary" onclick="App.acceptFriendRequest('${req.request_id}')">✓ Accept</button>
              <button class="btn btn-xs btn-glass" onclick="App.rejectFriendRequest('${req.request_id}')">✕ Decline</button>
            </div>
          `;
          incomingContainer.appendChild(card);
        });
      }
    }

    if (outgoingContainer) {
      const outgoing = this.pendingRequests.outgoing;
      if (outgoing.length === 0) {
        outgoingContainer.innerHTML = '<div class="empty-sub-state">No pending sent requests</div>';
      } else {
        outgoingContainer.innerHTML = '';
        outgoing.forEach(req => {
          const card = document.createElement('div');
          card.className = 'request-card';
          card.innerHTML = `
            <div class="friend-card-left">
              <div class="friend-card-avatar" style="background-color:${req.avatar_color || '#6366f1'}">
                ${(req.display_name || req.username).charAt(0).toUpperCase()}
              </div>
              <div class="friend-card-info">
                <div class="friend-card-name">${this.escapeHtml(req.display_name || req.username)}</div>
                <div class="friend-card-handle">@${this.escapeHtml(req.username)}</div>
              </div>
            </div>
            <div class="friend-card-actions">
              <button class="btn btn-xs btn-glass" onclick="App.rejectFriendRequest('${req.request_id}')">Cancel</button>
            </div>
          `;
          outgoingContainer.appendChild(card);
        });
      }
    }
  },

  renderFriendsTab() {
    const container = document.getElementById('friends-list-container');
    if (!container) return;

    if (this.friends.length === 0) {
      container.innerHTML = `
        <div class="empty-tab-state">
          <span class="empty-icon">👤</span>
          <h4>No Friends Added Yet</h4>
          <p>Search for users in the "Find & Add" tab to send friend requests.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    this.friends.forEach(f => {
      const isOnline = this.onlineUserIds.has(f.id);
      const card = document.createElement('div');
      card.className = 'friend-card';
      card.innerHTML = `
        <div class="friend-card-left">
          <div class="friend-card-avatar" style="background-color:${f.avatar_color || '#6366f1'}">
            ${(f.display_name || f.username).charAt(0).toUpperCase()}
          </div>
          <div class="friend-card-info">
            <div class="friend-card-name">${this.escapeHtml(f.display_name || f.username)}</div>
            <div class="friend-card-handle">@${this.escapeHtml(f.username)} • ${isOnline ? 'Online' : 'Offline'}</div>
            ${f.bio ? `<div class="friend-card-bio">${this.escapeHtml(f.bio)}</div>` : ''}
          </div>
        </div>
        <div class="friend-card-actions">
          <button class="btn btn-xs btn-primary" onclick="App.openDirectMessage('${f.id}', '${this.escapeHtml(f.display_name || f.username)}')">💬 Message</button>
          <button class="btn btn-xs btn-glass" onclick="App.removeFriend('${f.id}', '${this.escapeHtml(f.username)}')">✕ Remove</button>
        </div>
      `;
      container.appendChild(card);
    });
  },

  openDirectMessage(friendId, friendName) {
    const modal = document.getElementById('friend-manager-modal');
    if (modal) modal.classList.remove('active');

    const friend = this.friends.find(f => f.id === friendId);
    const dmRoomId = this.getDmRoomId(Auth.user.id, friendId);

    this.selectRoom({
      id: dmRoomId,
      name: friend ? (friend.display_name || friend.username) : friendName,
      type: 'direct',
      recipientId: friendId,
      icon: '👤',
      desc: friend ? (friend.bio || `Direct message with @${friend.username}`) : `Direct message with @${friendName}`
    });
    this.closeMobileDrawer();
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
        <span class="member-select-name">${this.escapeHtml(u.display_name || u.username)} (@${this.escapeHtml(u.username)})</span>
        <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
      `;
      list.appendChild(item);
    });
  },

  onAuthenticated(user, token) {
    this.connectSocket(token);
    this.loadChannels();
    this.loadFriends();
    this.loadFriendRequests();
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
      this.updateOnlinePresenceCount();
      this.renderUsersList();
      this.renderFriendsTab();
      this.renderRoomMembers();
    });

    this.socket.on('online_count', (count) => {
      this.updateOnlinePresenceCount(count);
    });

    this.socket.on('user_presence', ({ userId, status }) => {
      if (status === 'online') {
        this.onlineUserIds.add(userId);
      } else {
        this.onlineUserIds.delete(userId);
      }
      this.updateOnlinePresenceCount();
      this.renderUsersList();
      this.renderFriendsTab();
      this.renderRoomMembers();
    });

    this.socket.on('friend_request_received', (data) => {
      this.showToast(data.message || 'New friend request received!');
      this.playChime('receive');
      this.loadFriendRequests();
    });

    this.socket.on('friend_request_accepted', (data) => {
      this.showToast(data.message || 'Friend request accepted!');
      this.playChime('send');
      this.loadFriends();
      this.loadFriendRequests();
    });

    this.socket.on('channel_created', (channel) => {
      const isCreator = Auth.user && channel.created_by === Auth.user.id;
      const isMember = Auth.user && Array.isArray(channel.member_ids) && channel.member_ids.includes(Auth.user.id);
      if (channel.id === 'chan_general' || isCreator || isMember) {
        const exists = this.channels.some(c => c.id === channel.id);
        if (!exists) {
          this.channels.push(channel);
          this.renderChannelsList();
          if (isMember && !isCreator) {
            this.showToast(`You were added to group #${channel.name}!`);
          }
        }
      }
    });

    this.socket.on('channel_deleted', ({ channelId }) => {
      this.channels = this.channels.filter(c => c.id !== channelId);
      this.renderChannelsList();

      if (this.currentRoom && this.currentRoom.id === channelId) {
        this.showToast('This group was deleted by the creator');
        this.selectGeneralRoom();
      }
    });

    this.socket.on('member_left', ({ channelId, userId }) => {
      if (Auth.user && Auth.user.id === userId) {
        this.channels = this.channels.filter(c => c.id !== channelId);
        this.renderChannelsList();
        if (this.currentRoom && this.currentRoom.id === channelId) {
          this.selectGeneralRoom();
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
          this.selectGeneralRoom();
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

  updateOnlinePresenceCount(explicitCount) {
    const count = typeof explicitCount === 'number' ? explicitCount : (this.onlineUserIds ? this.onlineUserIds.size : 1);
    const countEl = document.getElementById('overview-online-count');
    if (countEl) {
      countEl.textContent = `${count} active`;
    }
  },

  selectGeneralRoom() {
    const general = this.channels.find(c => c.id === 'chan_general' || c.name.toLowerCase() === 'general') || {
      id: 'chan_general',
      name: 'General',
      type: 'channel',
      icon: '💬',
      desc: 'Incognito Community • Messages & user identities are anonymous',
      created_by: 'system'
    };
    this.selectRoom({
      id: general.id,
      name: 'General',
      type: 'channel',
      icon: general.icon || '💬',
      desc: 'Incognito Community • Messages & user identities are anonymous',
      created_by: general.created_by || 'system'
    });
  },

  async loadChannels() {
    try {
      const headers = Auth.token ? { 'Authorization': `Bearer ${Auth.token}` } : {};
      const res = await fetch('/api/channels', { headers });
      const data = await res.json();
      this.channels = data.channels || [];
      this.renderChannelsList();

      if (!this.currentRoom) {
        this.selectGeneralRoom();
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
    } catch (err) {
      console.error('Failed to load users:', err);
    }
  },

  renderChannelsList() {
    // Update General Chat Pinned Active State
    const btnGeneral = document.getElementById('btn-general-chat');
    if (btnGeneral) {
      const isGeneralActive = this.currentRoom && (this.currentRoom.id === 'chan_general' || this.currentRoom.name === 'general');
      if (isGeneralActive) {
        btnGeneral.classList.add('active');
      } else {
        btnGeneral.classList.remove('active');
      }
    }

    const list = document.getElementById('channels-list');
    if (!list) return;
    list.innerHTML = '';

    // Filter only custom user groups (exclude general)
    const customGroups = this.channels.filter(c => c.id !== 'chan_general' && c.name !== 'general');

    if (customGroups.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-nav-state';
      emptyState.innerHTML = `
        <div>No groups created or joined yet</div>
        <button type="button" class="btn-create-hint" id="btn-create-hint-empty">
          <span>+ Create a Group</span>
        </button>
      `;
      const hintBtn = emptyState.querySelector('#btn-create-hint-empty');
      if (hintBtn) {
        hintBtn.addEventListener('click', () => {
          const btnAdd = document.getElementById('btn-add-channel');
          if (btnAdd) btnAdd.click();
        });
      }
      list.appendChild(emptyState);
      return;
    }

    customGroups.forEach(c => {
      const isOwner = Auth.user && c.created_by === Auth.user.id;
      const item = document.createElement('div');
      item.className = `nav-item ${this.currentRoom && this.currentRoom.id === c.id ? 'active' : ''}`;
      item.dataset.channelId = c.id;
      item.innerHTML = `
        <span class="nav-item-icon">${c.icon || '💬'}</span>
        <span class="nav-item-title">${this.escapeHtml(c.name)}</span>
        ${isOwner ? '<span class="group-badge-role">Owner</span>' : ''}
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

    if (!this.friends || this.friends.length === 0) {
      list.innerHTML = `
        <div class="empty-nav-state" style="cursor:pointer;" onclick="App.openFriendModal('tab-find-friends')">
          <div>No friends added yet</div>
          <button type="button" class="btn-create-hint">
            <span>+ Find Friends</span>
          </button>
        </div>
      `;
      return;
    }

    this.friends.forEach(u => {
      const isOnline = this.onlineUserIds.has(u.id);
      const dmRoomId = this.getDmRoomId(Auth.user.id, u.id);
      const item = document.createElement('div');
      item.className = `nav-item ${this.currentRoom && this.currentRoom.id === dmRoomId ? 'active' : ''}`;
      item.innerHTML = `
        <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
        <span class="nav-item-title">${this.escapeHtml(u.display_name || u.username)}</span>
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

    const isChannel = this.currentRoom && this.currentRoom.type === 'channel';
    const isGeneral = this.currentRoom && (this.currentRoom.id === 'chan_general' || this.currentRoom.name === 'general');
    const isCreator = this.currentRoom && Auth.user && this.currentRoom.created_by === Auth.user.id;

    if (isGeneral) {
      if (memberCount) memberCount.textContent = '🕶️ Anonymous';
      memberList.innerHTML = `
        <div class="anonymous-notice-banner">
          <span class="anon-icon">🕶️</span>
          <h4>Incognito Community</h4>
          <p>General chat is 100% anonymous. Online presence and user identities are private.</p>
        </div>
      `;
      return;
    }

    if (isChannel && !isGeneral) {
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
                ${this.escapeHtml(u.display_name || u.username)}
                ${isThisUserCreator ? '<span class="admin-badge">Admin</span>' : ''}
              </div>
              <div class="text-xs text-muted">@${this.escapeHtml(u.username)} • ${isOnline ? 'Online' : 'Offline'}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
              ${canRemove ? `<button class="btn-remove-member" title="Remove ${this.escapeHtml(u.display_name || u.username)} from group" onclick="App.removeMemberFromGroup('${u.id}', '${this.escapeHtml(u.display_name || u.username)}')">✕</button>` : ''}
            </div>
          `;
          memberList.appendChild(item);
        });
        return;
      } catch (e) {}
    }

    // Direct Message view
    if (this.currentRoom && this.currentRoom.type === 'direct') {
      const partner = this.friends.find(f => f.id === this.currentRoom.recipientId);
      if (memberCount) memberCount.textContent = '2';
      if (partner) {
        const isOnline = this.onlineUserIds.has(partner.id);
        memberList.innerHTML = `
          <div class="member-item">
            <div class="member-avatar" style="background-color:${partner.avatar_color || '#6366f1'}">
              ${(partner.display_name || partner.username).charAt(0).toUpperCase()}
            </div>
            <div style="flex:1;min-width:0;">
              <div class="member-name">${this.escapeHtml(partner.display_name || partner.username)}</div>
              <div class="text-xs text-muted">@${this.escapeHtml(partner.username)} • ${isOnline ? 'Online' : 'Offline'}</div>
            </div>
            <span class="status-indicator ${isOnline ? 'online' : 'offline'}"></span>
          </div>
        `;
      }
    }
  },

  async removeMemberFromGroup(userId, displayName) {
    if (!this.currentRoom || this.currentRoom.type !== 'channel' || this.currentRoom.id === 'chan_general') return;
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

    const isChannel = this.currentRoom && this.currentRoom.type === 'channel';
    const isGeneral = this.currentRoom && (this.currentRoom.id === 'chan_general' || this.currentRoom.name === 'general');
    const isCreator = this.currentRoom && Auth.user && this.currentRoom.created_by === Auth.user.id;

    if (isChannel && !isGeneral) {
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
      const isGeneral = this.currentRoom && (this.currentRoom.id === 'chan_general' || this.currentRoom.name === 'general');
      text.textContent = isGeneral ? 'Someone is typing...' : `${username} is typing...`;
      bar.style.display = 'flex';
    }
  },

  hideTypingIndicator() {
    const bar = document.getElementById('typing-bar');
    if (bar) bar.style.display = 'none';
  },

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
