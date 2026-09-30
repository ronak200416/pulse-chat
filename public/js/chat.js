// Chat Module: Rendering, Audio Recording, Media Uploads & Interactions
const Chat = {
  activeRoom: null, // { id, name, type, icon, desc }
  replyingTo: null,
  messageCache: new Map(), // roomId -> messages[] for 0ms instant loading
  isRecordingVoice: false,
  mediaRecorder: null,
  audioChunks: [],
  voiceTimerInterval: null,
  voiceDurationSec: 0,
  isAtBottom: true,
  searchDebounce: null,

  emojis: [
    '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗',
    '😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄',
    '😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯',
    '🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥',
    '😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️',
    '💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈',
    '👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋',
    '👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠',
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝',
    '🔥','✨','🌟','💫','💥','⚡','🌈','☀️','🌙','⭐','🎉','🎊','🎈','🎁','🏆','🚀','💎','💯'
  ],

  init() {
    this.messagesFeed = document.getElementById('messages-feed');
    this.messagesContainer = document.getElementById('messages-container');
    this.msgInput = document.getElementById('message-input');
    this.btnSend = document.getElementById('btn-send-message');
    this.btnAttachment = document.getElementById('btn-attachment');
    this.fileInput = document.getElementById('file-input');
    this.btnVoice = document.getElementById('btn-voice-record');
    this.btnCancelVoice = document.getElementById('btn-cancel-voice');
    this.btnSendVoice = document.getElementById('btn-send-voice');
    this.voiceBar = document.getElementById('voice-recording-bar');
    this.voiceRecTime = document.getElementById('voice-rec-time');
    this.replyBar = document.getElementById('reply-preview-bar');
    this.replyUserName = document.getElementById('reply-user-name');
    this.replySnippet = document.getElementById('reply-snippet-text');
    this.btnCancelReply = document.getElementById('btn-cancel-reply');
    this.btnEmoji = document.getElementById('btn-emoji-trigger');
    this.emojiPicker = document.getElementById('emoji-picker');
    this.emojiGrid = document.getElementById('emoji-grid');
    this.emojiSearchInput = document.getElementById('emoji-search-input');
    this.btnScrollBottom = document.getElementById('btn-scroll-bottom');
    this.lightbox = document.getElementById('lightbox-modal');
    this.lightboxImg = document.getElementById('lightbox-img');
    this.lightboxDownload = document.getElementById('lightbox-download');
    this.btnCloseLightbox = document.getElementById('btn-close-lightbox');
    this.lightboxBackdrop = document.getElementById('lightbox-backdrop');

    this.renderEmojiGrid(this.emojis);
    this.bindEvents();
  },

  bindEvents() {
    // Send message on Enter (Shift+Enter for newlines)
    if (this.msgInput) {
      this.msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        } else {
          App.emitTyping();
        }
      });

      // Auto resize textarea
      this.msgInput.addEventListener('input', () => {
        this.msgInput.style.height = 'auto';
        this.msgInput.style.height = Math.min(this.msgInput.scrollHeight, 140) + 'px';
      });
    }

    if (this.btnSend) {
      this.btnSend.addEventListener('click', () => this.sendMessage());
    }

    // Attachment Button
    if (this.btnAttachment && this.fileInput) {
      this.btnAttachment.addEventListener('click', () => this.fileInput.click());
      this.fileInput.addEventListener('change', (e) => this.handleFileUpload(e.target.files[0]));
    }

    // Voice Recording
    if (this.btnVoice) {
      this.btnVoice.addEventListener('click', () => this.startVoiceRecording());
    }
    if (this.btnCancelVoice) {
      this.btnCancelVoice.addEventListener('click', () => this.cancelVoiceRecording());
    }
    if (this.btnSendVoice) {
      this.btnSendVoice.addEventListener('click', () => this.stopAndSendVoiceRecording());
    }

    // Cancel Reply
    if (this.btnCancelReply) {
      this.btnCancelReply.addEventListener('click', () => this.clearReply());
    }

    // Emoji Picker Toggle
    if (this.btnEmoji) {
      this.btnEmoji.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = this.emojiPicker.style.display === 'none';
        this.emojiPicker.style.display = isHidden ? 'flex' : 'none';
      });
    }

    // Emoji Search
    if (this.emojiSearchInput) {
      this.emojiSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        this.renderEmojiGrid(this.emojis);
      });
    }

    // Close emoji picker on click outside
    document.addEventListener('click', (e) => {
      if (this.emojiPicker && !this.emojiPicker.contains(e.target) && e.target !== this.btnEmoji) {
        this.emojiPicker.style.display = 'none';
      }
    });

    // Scroll Detection
    if (this.messagesContainer) {
      this.messagesContainer.addEventListener('scroll', () => {
        const distFromBottom = this.messagesContainer.scrollHeight - this.messagesContainer.scrollTop - this.messagesContainer.clientHeight;
        this.isAtBottom = distFromBottom < 60;
        if (this.btnScrollBottom) {
          this.btnScrollBottom.style.display = this.isAtBottom ? 'none' : 'flex';
        }
      });
    }

    if (this.btnScrollBottom) {
      this.btnScrollBottom.addEventListener('click', () => this.scrollToBottom(true));
    }

    // Lightbox handlers
    if (this.btnCloseLightbox) this.btnCloseLightbox.addEventListener('click', () => this.closeLightbox());
    if (this.lightboxBackdrop) this.lightboxBackdrop.addEventListener('click', () => this.closeLightbox());

    // Search input
    const searchInput = document.getElementById('search-input');
    const searchResultsPanel = document.getElementById('search-results-panel');
    const btnCloseSearch = document.getElementById('btn-close-search');
    const btnClearSearch = document.getElementById('btn-clear-search');

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        if (btnClearSearch) btnClearSearch.style.display = query ? 'block' : 'none';
        clearTimeout(this.searchDebounce);
        if (!query) {
          if (searchResultsPanel) searchResultsPanel.style.display = 'none';
          return;
        }
        this.searchDebounce = setTimeout(() => this.performSearch(query), 300);
      });
    }
    if (btnClearSearch) {
      btnClearSearch.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        btnClearSearch.style.display = 'none';
        if (searchResultsPanel) searchResultsPanel.style.display = 'none';
      });
    }
    if (btnCloseSearch && searchResultsPanel) {
      btnCloseSearch.addEventListener('click', () => {
        searchResultsPanel.style.display = 'none';
      });
    }
  },

  renderEmojiGrid(emojis) {
    if (!this.emojiGrid) return;
    this.emojiGrid.innerHTML = '';
    emojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        if (this.msgInput) {
          this.msgInput.value += emoji;
          this.msgInput.focus();
        }
      });
      this.emojiGrid.appendChild(btn);
    });
  },

  async loadRoom(room) {
    this.activeRoom = room;
    this.clearReply();

    const isGeneral = room.id === 'chan_general' || (room.name && room.name.toLowerCase() === 'general');
    const isChannel = room.type === 'channel';

    // Update Header UI
    const titleEl = document.getElementById('current-room-title');
    const descEl = document.getElementById('current-room-desc');
    const iconEl = document.getElementById('current-room-icon');
    const tagEl = document.getElementById('current-room-tag');

    if (titleEl) titleEl.textContent = isChannel ? (isGeneral ? 'General' : `#${room.name}`) : room.name;
    if (descEl) descEl.textContent = isGeneral ? 'Anonymous world chat' : (room.desc || (isChannel ? 'Group conversation' : 'Direct message'));
    
    if (iconEl) {
      if (isGeneral) {
        iconEl.innerHTML = '<img src="img/antra-icon.svg" alt="antra" style="width:22px; height:22px; border-radius:5px; display:block;">';
      } else if (isChannel) {
        iconEl.innerHTML = '<span class="room-hash">#</span>';
      } else {
        iconEl.innerHTML = '<span class="room-dm-initial">' + this.escapeHtml(room.name ? room.name.charAt(0).toUpperCase() : 'U') + '</span>';
      }
    }

    if (tagEl) {
      if (isChannel && !isGeneral) {
        tagEl.style.display = 'inline-block';
        tagEl.textContent = 'Channel';
      } else {
        tagEl.style.display = 'none';
      }
    }

    // Update Right Sidebar
    const rightTitle = document.getElementById('right-sidebar-title');
    const rightSub = document.getElementById('right-sidebar-subtitle');
    const cdName = document.getElementById('cd-name');
    const cdBadge = document.getElementById('cd-badge');
    const cdSub = document.getElementById('cd-sub');
    const cdDesc = document.getElementById('cd-desc');
    const cdIcon = document.getElementById('cd-icon-box');
    const cdPrivacy = document.getElementById('cd-privacy-val');
    const onlineCountEl = document.getElementById('overview-online-count');
    const secSection = document.getElementById('security-policy-section');
    const customMembersSection = document.getElementById('custom-members-section');

    if (rightTitle) rightTitle.textContent = isGeneral ? 'General' : (isChannel ? `#${room.name}` : room.name);
    if (rightSub) {
      if (isChannel && !isGeneral) {
        rightSub.style.display = 'inline-block';
        rightSub.textContent = 'Channel Details';
      } else {
        rightSub.style.display = 'none';
      }
    }
    if (cdName) cdName.textContent = isGeneral ? 'General' : (isChannel ? `#${room.name}` : room.name);
    
    if (cdBadge) {
      cdBadge.style.display = 'none';
    }

    if (cdSub) {
      cdSub.textContent = isGeneral ? 'Public Anonymous Channel' : (isChannel ? 'Private Group Channel' : 'Encrypted Direct Message');
    }

    if (cdDesc) {
      cdDesc.textContent = isGeneral 
        ? 'Anonymous world chat.'
        : (room.desc || 'Private messaging space.');
    }

    if (cdIcon) {
      if (isGeneral) {
        cdIcon.innerHTML = '<img src="img/antra-icon.svg" alt="antra" style="width:26px; height:26px; border-radius:6px; display:block;">';
      } else if (isChannel) {
        cdIcon.innerHTML = '<span class="room-hash">#</span>';
      } else {
        cdIcon.innerHTML = '<span class="room-dm-initial">' + this.escapeHtml(room.name ? room.name.charAt(0).toUpperCase() : 'U') + '</span>';
      }
    }

    if (cdPrivacy) {
      cdPrivacy.textContent = isGeneral ? 'Public' : (isChannel ? 'Private Group' : 'Direct');
    }

    if (onlineCountEl) {
      const activeCount = App.onlineUserIds ? App.onlineUserIds.size : 1;
      onlineCountEl.textContent = `${activeCount} active`;
    }

    if (secSection) {
      secSection.style.display = 'none';
    }

    if (customMembersSection) {
      customMembersSection.style.display = isGeneral ? 'none' : 'block';
    }

    // ⚡ Instant Cache-First Display (0ms Latency)
    if (this.messageCache.has(room.id)) {
      this.renderMessages(this.messageCache.get(room.id));
    }

    // Background Revalidation (Stale-While-Revalidate)
    try {
      const res = await fetch(`/api/messages/${room.id}?limit=60`);
      const data = await res.json();
      const messages = data.messages || [];
      this.messageCache.set(room.id, messages);
      if (this.activeRoom && this.activeRoom.id === room.id) {
        this.renderMessages(messages);
      }
    } catch (err) {
      console.error('Failed to load room messages:', err);
    }
  },

  renderMessages(messages) {
    if (!this.messagesFeed) return;
    this.messagesFeed.innerHTML = '';

    const welcomeBanner = document.getElementById('chat-welcome-banner');
    const welcomeTitle = document.getElementById('welcome-title');
    const welcomeDesc = document.getElementById('welcome-desc');

    if (this.activeRoom) {
      const isGeneral = this.activeRoom.id === 'chan_general' || (this.activeRoom.name && this.activeRoom.name.toLowerCase() === 'general');
      if (welcomeTitle) {
        welcomeTitle.textContent = isGeneral ? 'Anonymous World Chat' : (this.activeRoom.type === 'channel' ? `Welcome to #${this.activeRoom.name}!` : `Conversation with ${this.activeRoom.name}`);
      }
      if (welcomeDesc) {
        welcomeDesc.textContent = isGeneral ? 'Anonymous world chat.' : (this.activeRoom.desc || 'Send your first message to get started.');
      }
    }

    let lastDateStr = null;

    messages.forEach(msg => {
      const msgDate = new Date(msg.created_at);
      const dateStr = msgDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

      if (dateStr !== lastDateStr) {
        lastDateStr = dateStr;
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.innerHTML = `<span>${dateStr}</span>`;
        this.messagesFeed.appendChild(sep);
      }

      const msgEl = this.createMessageElement(msg);
      this.messagesFeed.appendChild(msgEl);
    });

    this.scrollToBottom(false);
  },

  createMessageElement(msg) {
    const el = document.createElement('div');
    el.className = 'message-item';
    el.id = `msg-${msg.id}`;
    el.dataset.msgId = msg.id;

    const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isMe = Auth.user && Auth.user.id === msg.sender_id;
    const isGeneral = this.activeRoom && (this.activeRoom.id === 'chan_general' || (this.activeRoom.name && this.activeRoom.name.toLowerCase() === 'general'));

    let senderName = msg.sender_display_name || msg.sender_username || 'User';
    let avatarBg = msg.sender_avatar_color || '#6366f1';
    let initial = senderName.charAt(0).toUpperCase();

    if (isGeneral) {
      senderName = isMe ? 'Anonymous (You)' : 'Anonymous';
      avatarBg = isMe ? '#252d43' : '#1e2438';
      initial = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="anon-dp-svg"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
    }

    // Reply Bubble if quoting
    let replyHtml = '';
    if (msg.reply_to_id && msg.reply_to_sender) {
      const quoteSenderDisplay = isGeneral ? 'Anonymous' : msg.reply_to_sender;
      replyHtml = `
        <div class="reply-ref">
          <span class="reply-ref-name">↪ ${this.escapeHtml(quoteSenderDisplay)}:</span>
          <span class="reply-ref-text">${this.escapeHtml(msg.reply_to_content || '')}</span>
        </div>
      `;
    }

    // Message Body content
    let bodyHtml = '';
    if (msg.message_type === 'image' && msg.file_url) {
      bodyHtml = `
        <div class="msg-image-wrap" onclick="Chat.openLightbox('${msg.file_url}')">
          <img src="${msg.file_url}" alt="Shared image" loading="lazy">
        </div>
      `;
    } else if (msg.message_type === 'audio' && msg.file_url) {
      bodyHtml = `
        <div class="msg-voice-player" id="voice-player-${msg.id}">
          <button class="voice-play-btn" onclick="Chat.toggleAudioPlay('${msg.id}', '${msg.file_url}')">▶</button>
          <div class="voice-waveform-wrap">
            <div class="voice-progress-bar">
              <div class="voice-progress-fill" id="audio-fill-${msg.id}"></div>
            </div>
            <span class="voice-duration" id="audio-dur-${msg.id}">Voice note</span>
          </div>
          <audio id="audio-elem-${msg.id}" src="${msg.file_url}" preload="metadata"></audio>
        </div>
      `;
    } else if (msg.message_type === 'file' && msg.file_url) {
      const sizeMb = (msg.file_size / (1024 * 1024)).toFixed(2);
      bodyHtml = `
        <a href="${msg.file_url}" download="${this.escapeHtml(msg.file_name || 'download')}" target="_blank" class="msg-file-wrap">
          <span class="file-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></span>
          <div class="file-meta">
            <span class="file-name">${this.escapeHtml(msg.file_name || 'File')}</span>
            <span class="file-size">${sizeMb > 0 ? sizeMb + ' MB' : 'Attachment'}</span>
          </div>
          <span class="icon-btn-xs" style="color:var(--accent-link);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
        </a>
      `;
    }

    // Text content formatted with markdown
    const textFormatted = msg.content ? `<div class="msg-content">${this.formatMarkdown(msg.content)}</div>` : '';

    // Reactions HTML
    const reactionsHtml = this.renderReactionsHtml(msg.reactions || [], msg.id);

    // Action Bar HTML (SVG vector buttons)
    const quoteSender = isGeneral ? 'Anonymous' : (msg.sender_display_name || msg.sender_username);
    const actionBarHtml = `
      <div class="message-action-bar">
        <button class="icon-btn-xs" title="React" aria-label="React" onclick="Chat.showQuickReaction('${msg.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
        </button>
        <button class="icon-btn-xs" title="Reply" aria-label="Reply" onclick="Chat.setReply('${msg.id}', '${this.escapeHtml(quoteSender)}', '${this.escapeHtml(msg.content || '')}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
        </button>
        ${isMe ? `<button class="icon-btn-xs" title="Edit" aria-label="Edit" onclick="Chat.editMessagePrompt('${msg.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>` : ''}
        ${isMe ? `<button class="icon-btn-xs" title="Delete" aria-label="Delete" onclick="Chat.deleteMessage('${msg.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>` : ''}
      </div>
    `;

    el.innerHTML = `
      <div class="msg-avatar ${isGeneral ? 'anon-avatar-box' : ''}" style="background:${avatarBg};">${initial}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-sender ${isGeneral ? 'text-anon' : ''}">${this.escapeHtml(senderName)}</span>
          <span class="msg-timestamp">${timeStr}</span>
          ${msg.is_edited ? '<span class="msg-edited-tag">(edited)</span>' : ''}
        </div>
        ${replyHtml}
        ${textFormatted}
        ${bodyHtml}
        <div class="msg-reactions" id="reactions-${msg.id}">
          ${reactionsHtml}
        </div>
      </div>
      ${actionBarHtml}
    `;

    return el;
  },

  renderReactionsHtml(reactions, msgId) {
    if (!reactions || !reactions.length) return '';
    return reactions.map(r => {
      const hasReacted = Auth.user && r.users && r.users.some(u => u.id === Auth.user.id);
      return `
        <button class="reaction-pill ${hasReacted ? 'reacted' : ''}" onclick="Chat.toggleReaction('${msgId}', '${r.emoji}')">
          <span>${r.emoji}</span>
          <span class="reaction-count">${r.count}</span>
        </button>
      `;
    }).join('');
  },

  appendMessage(msg) {
    // Keep client cache updated
    if (msg && msg.room_id) {
      if (!this.messageCache.has(msg.room_id)) {
        this.messageCache.set(msg.room_id, []);
      }
      const list = this.messageCache.get(msg.room_id);
      if (!list.some(m => m.id === msg.id)) {
        list.push(msg);
      }
    }

    if (!this.messagesFeed) return;
    // Only append if message belongs to current room
    if (this.activeRoom && msg.room_id !== this.activeRoom.id) {
      return;
    }

    const msgEl = this.createMessageElement(msg);
    this.messagesFeed.appendChild(msgEl);

    if (this.isAtBottom || (Auth.user && msg.sender_id === Auth.user.id)) {
      this.scrollToBottom(true);
    }
  },

  sendMessage() {
    if (!this.msgInput || !this.activeRoom) return;
    const content = this.msgInput.value.trim();
    if (!content) return;

    const payload = {
      room_type: this.activeRoom.type,
      room_id: this.activeRoom.id,
      recipient_id: this.activeRoom.type === 'direct' ? this.activeRoom.recipientId : null,
      content,
      message_type: 'text',
      reply_to_id: this.replyingTo ? this.replyingTo.id : null,
      reply_to_sender: this.replyingTo ? this.replyingTo.sender : null,
      reply_to_content: this.replyingTo ? this.replyingTo.content : null
    };

    App.socket.emit('send_message', payload, (res) => {
      if (res && res.error) {
        App.showToast(res.error);
      }
    });

    this.msgInput.value = '';
    this.msgInput.style.height = 'auto';
    this.clearReply();
    App.emitStopTyping();
  },

  async handleFileUpload(file) {
    if (!file || !this.activeRoom) return;
    App.showToast('Uploading file...');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${Auth.token}` },
        body: formData
      });
      const data = await res.json();

      if (data.url) {
        let type = 'file';
        if (data.mimetype.startsWith('image/')) type = 'image';
        else if (data.mimetype.startsWith('audio/')) type = 'audio';

        const payload = {
          room_type: this.activeRoom.type,
          room_id: this.activeRoom.id,
          recipient_id: this.activeRoom.type === 'direct' ? this.activeRoom.recipientId : null,
          content: '',
          message_type: type,
          file_url: data.url,
          file_name: data.filename,
          file_size: data.size
        };

        App.socket.emit('send_message', payload);
        App.showToast('File shared!');
      }
    } catch (err) {
      console.error('File upload failed:', err);
      App.showToast('Upload failed');
    }
  },

  // Voice Note Recording
  async startVoiceRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.start();
      this.isRecordingVoice = true;
      this.voiceDurationSec = 0;
      this.voiceBar.style.display = 'flex';
      document.getElementById('composer-box').style.display = 'none';

      this.voiceTimerInterval = setInterval(() => {
        this.voiceDurationSec++;
        const mins = Math.floor(this.voiceDurationSec / 60);
        const secs = this.voiceDurationSec % 60;
        this.voiceRecTime.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }, 1000);
    } catch (err) {
      console.warn('Microphone access denied:', err);
      App.showToast('Microphone permission required for voice notes');
    }
  },

  cancelVoiceRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    clearInterval(this.voiceTimerInterval);
    this.audioChunks = [];
    this.isRecordingVoice = false;
    this.voiceBar.style.display = 'none';
    document.getElementById('composer-box').style.display = 'flex';
  },

  stopAndSendVoiceRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;

    this.mediaRecorder.onstop = async () => {
      clearInterval(this.voiceTimerInterval);
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      const file = new File([audioBlob], `voicenote_${Date.now()}.webm`, { type: 'audio/webm' });

      this.handleFileUpload(file);
      this.cancelVoiceRecording();
    };

    this.mediaRecorder.stop();
  },

  toggleAudioPlay(msgId, url) {
    const audio = document.getElementById(`audio-elem-${msgId}`);
    const btn = document.querySelector(`#voice-player-${msgId} .voice-play-btn`);
    const fill = document.getElementById(`audio-fill-${msgId}`);

    if (!audio) return;

    if (audio.paused) {
      audio.play();
      btn.textContent = '⏸';
      audio.ontimeupdate = () => {
        const pct = (audio.currentTime / audio.duration) * 100;
        if (fill) fill.style.width = `${pct}%`;
      };
      audio.onended = () => {
        btn.textContent = '▶';
        if (fill) fill.style.width = '0%';
      };
    } else {
      audio.pause();
      btn.textContent = '▶';
    }
  },

  setReply(id, sender, content) {
    this.replyingTo = { id, sender, content };
    if (this.replyUserName) this.replyUserName.textContent = sender;
    if (this.replySnippet) this.replySnippet.textContent = content || '[Attachment]';
    if (this.replyBar) this.replyBar.style.display = 'flex';
    if (this.msgInput) this.msgInput.focus();
  },

  clearReply() {
    this.replyingTo = null;
    if (this.replyBar) this.replyBar.style.display = 'none';
  },

  showQuickReaction(msgId) {
    const emojis = ['❤️', '👍', '😂', '🔥', '🎉', '🚀'];
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    this.toggleReaction(msgId, randomEmoji);
  },

  toggleReaction(msgId, emoji) {
    if (!Auth.user || !this.activeRoom) return;
    App.socket.emit('add_reaction', {
      messageId: msgId,
      emoji,
      roomId: this.activeRoom.id
    });
  },

  async deleteMessage(msgId) {
    const ok = await App.confirm({
      title: 'Delete Message',
      message: 'Are you sure you want to permanently delete this message?',
      confirmText: 'Delete',
      danger: true,
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
    });
    if (!ok) return;
    App.socket.emit('delete_message', { messageId: msgId, roomId: this.activeRoom.id }, (res) => {
      if (res && res.error) App.showToast(res.error);
    });
  },

  async editMessagePrompt(msgId) {
    const msgEl = document.getElementById(`msg-${msgId}`);
    const currentText = msgEl ? (msgEl.querySelector('.msg-content p')?.textContent || msgEl.querySelector('.msg-content')?.textContent || '') : '';
    const newText = await App.prompt({
      title: 'Edit Message',
      message: 'Update your message content:',
      defaultValue: currentText.trim(),
      placeholder: 'Type updated message...',
      confirmText: 'Save Edit',
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'
    });
    if (newText !== null && newText.trim() && newText.trim() !== currentText.trim()) {
      App.socket.emit('edit_message', {
        messageId: msgId,
        newContent: newText.trim(),
        roomId: this.activeRoom.id
      });
    }
  },

  updateReactions(msgId, reactions) {
    const rxContainer = document.getElementById(`reactions-${msgId}`);
    if (rxContainer) {
      rxContainer.innerHTML = this.renderReactionsHtml(reactions, msgId);
    }
  },

  removeMessageElement(msgId) {
    if (this.activeRoom && this.messageCache.has(this.activeRoom.id)) {
      const list = this.messageCache.get(this.activeRoom.id);
      this.messageCache.set(this.activeRoom.id, list.filter(m => m.id !== msgId));
    }
    const el = document.getElementById(`msg-${msgId}`);
    if (el) el.remove();
  },

  updateMessageElement(msg) {
    const el = document.getElementById(`msg-${msg.id}`);
    if (el) {
      const newEl = this.createMessageElement(msg);
      el.replaceWith(newEl);
    }
  },

  async performSearch(query) {
    const list = document.getElementById('search-results-list');
    const countEl = document.getElementById('search-count');
    const panel = document.getElementById('search-results-panel');

    if (!list || !panel) return;
    list.innerHTML = '<div>Searching...</div>';
    panel.style.display = 'flex';

    try {
      const res = await fetch(`/api/messages-search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      const msgs = data.messages || [];

      if (countEl) countEl.textContent = msgs.length;
      list.innerHTML = '';

      if (msgs.length === 0) {
        list.innerHTML = '<div class="text-muted" style="padding:12px;text-align:center;">No matching messages found</div>';
        return;
      }

      msgs.forEach(m => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.innerHTML = `
          <div class="search-res-sender">${this.escapeHtml(m.sender_display_name || m.sender_username)}</div>
          <div class="search-res-text">${this.escapeHtml(m.content)}</div>
        `;
        item.addEventListener('click', () => {
          App.selectRoom({ id: m.room_id, name: 'Search result', type: m.room_type });
          panel.style.display = 'none';
        });
        list.appendChild(item);
      });
    } catch (err) {
      console.warn('Search error:', err);
    }
  },

  openLightbox(src) {
    if (this.lightbox && this.lightboxImg) {
      this.lightboxImg.src = src;
      if (this.lightboxDownload) this.lightboxDownload.href = src;
      this.lightbox.style.display = 'flex';
    }
  },

  closeLightbox() {
    if (this.lightbox) this.lightbox.style.display = 'none';
  },

  scrollToBottom(smooth = true) {
    if (!this.messagesContainer) return;
    const scrollHeight = this.messagesContainer.scrollHeight;
    if (smooth) {
      this.messagesContainer.scrollTo({ top: scrollHeight, behavior: 'smooth' });
    } else {
      this.messagesContainer.scrollTop = scrollHeight;
    }
  },

  formatMarkdown(text) {
    if (!text) return '';
    let escaped = this.escapeHtml(text);

    // Code blocks ```code```
    escaped = escaped.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    // Inline code `code`
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold **text**
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic *text*
    escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Auto links
    escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Newlines to <br>
    escaped = escaped.replace(/\n/g, '<br>');

    return `<p>${escaped}</p>`;
  },

  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};
