// Network Modal & Mobile Connection Hub
const NetworkModal = {
  init() {
    this.modal = document.getElementById('network-modal');
    this.btnOpen = document.getElementById('btn-open-network');
    this.btnHeaderShare = document.getElementById('btn-header-share');
    this.btnClose = document.getElementById('btn-close-network-modal');
    this.btnDone = document.getElementById('btn-done-network');
    this.qrImg = document.getElementById('network-qr-img');
    this.lanUrlInput = document.getElementById('lan-url-input');
    this.btnCopyLan = document.getElementById('btn-copy-lan-url');
    this.btnCopyTunnel = document.getElementById('btn-copy-tunnel-cmd');

    this.bindEvents();
  },

  bindEvents() {
    if (this.btnOpen) {
      this.btnOpen.addEventListener('click', () => this.open());
    }
    if (this.btnHeaderShare) {
      this.btnHeaderShare.addEventListener('click', () => this.open());
    }
    if (this.btnClose) {
      this.btnClose.addEventListener('click', () => this.close());
    }
    if (this.btnDone) {
      this.btnDone.addEventListener('click', () => this.close());
    }

    if (this.btnCopyLan) {
      this.btnCopyLan.addEventListener('click', () => {
        if (this.lanUrlInput && this.lanUrlInput.value) {
          navigator.clipboard.writeText(this.lanUrlInput.value);
          this.btnCopyLan.textContent = 'Copied! ✓';
          setTimeout(() => { this.btnCopyLan.textContent = 'Copy Link'; }, 2000);
          App.showToast('Wi-Fi link copied to clipboard!');
        }
      });
    }

    if (this.btnCopyTunnel) {
      this.btnCopyTunnel.addEventListener('click', () => {
        navigator.clipboard.writeText('npm run tunnel');
        this.btnCopyTunnel.textContent = 'Copied! ✓';
        setTimeout(() => { this.btnCopyTunnel.textContent = 'Copy Command'; }, 2000);
        App.showToast('Tunnel command copied! Run it in a terminal.');
      });
    }

    // Close on backdrop click
    if (this.modal) {
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.close();
      });
    }
  },

  async open() {
    if (this.modal) this.modal.classList.add('active');
    await this.fetchNetworkInfo();
  },

  close() {
    if (this.modal) this.modal.classList.remove('active');
  },

  async fetchNetworkInfo() {
    try {
      const res = await fetch('/api/network-info');
      const data = await res.json();

      if (this.qrImg && data.qrCode) {
        this.qrImg.src = data.qrCode;
      }
      if (this.lanUrlInput && data.lanUrl) {
        this.lanUrlInput.value = data.lanUrl;
      }

      // Update stats in right sidebar if available
      if (data.stats) {
        const elMsgs = document.getElementById('stat-messages');
        const elUsers = document.getElementById('stat-users');
        const elDb = document.getElementById('stat-db-size');
        if (elMsgs) elMsgs.textContent = data.stats.messages;
        if (elUsers) elUsers.textContent = data.stats.users;
        if (elDb) elDb.textContent = `${data.stats.db_size_kb} KB`;
      }
    } catch (err) {
      console.warn('Could not fetch network info:', err);
    }
  }
};
