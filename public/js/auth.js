// Authentication Module
const Auth = {
  token: localStorage.getItem('pulse_token') || null,
  user: null,

  init() {
    this.modal = document.getElementById('auth-modal');
    this.tabs = document.querySelectorAll('.auth-tab-btn');
    this.panels = document.querySelectorAll('.auth-form-panel');

    // Forms
    this.guestForm = document.getElementById('guest-form');
    this.loginForm = document.getElementById('login-form');
    this.registerForm = document.getElementById('register-form');

    // Color Pickers
    this.guestColorPicker = document.getElementById('guest-color-picker');
    this.selectedGuestColor = '#6366f1';

    // Profile Modal
    this.profileModal = document.getElementById('profile-modal');
    this.profileForm = document.getElementById('profile-form');
    this.editColorPicker = document.getElementById('edit-color-picker');
    this.selectedEditColor = '#6366f1';

    this.bindEvents();
    return this.checkExistingSession();
  },

  bindEvents() {
    // Tab switching
    this.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetId = tab.getAttribute('data-tab');
        this.tabs.forEach(t => t.classList.remove('active'));
        this.panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const activePanel = document.getElementById(targetId.replace('-tab', '-form'));
        if (activePanel) activePanel.classList.add('active');
      });
    });

    // Guest color picker
    if (this.guestColorPicker) {
      this.guestColorPicker.addEventListener('click', (e) => {
        if (e.target.classList.contains('color-dot')) {
          this.guestColorPicker.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
          e.target.classList.add('active');
          this.selectedGuestColor = e.target.getAttribute('data-color');
        }
      });
    }

    // Edit profile color picker
    if (this.editColorPicker) {
      this.editColorPicker.addEventListener('click', (e) => {
        if (e.target.classList.contains('color-dot')) {
          this.editColorPicker.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
          e.target.classList.add('active');
          this.selectedEditColor = e.target.getAttribute('data-color');
        }
      });
    }

    // Submit Guest Form
    if (this.guestForm) {
      this.guestForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('guest-name');
        const displayName = nameInput ? nameInput.value.trim() : '';
        if (!displayName) return;

        try {
          const res = await fetch('/api/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              display_name: displayName,
              avatar_color: this.selectedGuestColor
            })
          });
          const data = await res.json();
          if (data.token) {
            this.handleAuthSuccess(data);
          }
        } catch (err) {
          console.error('Guest auth error:', err);
          App.showToast('Failed to connect as guest');
        }
      });
    }

    // Submit Login Form
    if (this.loginForm) {
      this.loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');

        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (data.error) {
            errEl.textContent = data.error;
            errEl.classList.add('active');
          } else if (data.token) {
            errEl.classList.remove('active');
            this.handleAuthSuccess(data);
          }
        } catch (err) {
          errEl.textContent = 'Server connection error';
          errEl.classList.add('active');
        }
      });
    }

    // Submit Register Form
    if (this.registerForm) {
      this.registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('reg-username').value.trim();
        const displayName = document.getElementById('reg-display-name').value.trim();
        const password = document.getElementById('reg-password').value;
        const bio = document.getElementById('reg-bio').value.trim();
        const errEl = document.getElementById('reg-error');

        try {
          const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username,
              display_name: displayName,
              password,
              bio,
              avatar_color: this.selectedGuestColor
            })
          });
          const data = await res.json();
          if (data.error) {
            errEl.textContent = data.error;
            errEl.classList.add('active');
          } else if (data.token) {
            errEl.classList.remove('active');
            this.handleAuthSuccess(data);
          }
        } catch (err) {
          errEl.textContent = 'Server connection error';
          errEl.classList.add('active');
        }
      });
    }

    // Profile Settings Trigger
    const btnEditProfile = document.getElementById('btn-edit-profile');
    if (btnEditProfile) {
      btnEditProfile.addEventListener('click', () => this.openProfileModal());
    }

    const btnCloseProfile = document.getElementById('btn-close-profile-modal');
    const btnCancelProfile = document.getElementById('btn-cancel-profile');
    if (btnCloseProfile) btnCloseProfile.addEventListener('click', () => this.closeProfileModal());
    if (btnCancelProfile) btnCancelProfile.addEventListener('click', () => this.closeProfileModal());

    // Submit Profile Update
    if (this.profileForm) {
      this.profileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const displayName = document.getElementById('edit-display-name').value.trim();
        const bio = document.getElementById('edit-bio').value.trim();

        try {
          const res = await fetch('/api/users/profile', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify({
              display_name: displayName,
              bio,
              avatar_color: this.selectedEditColor
            })
          });
          const data = await res.json();
          if (data.user) {
            this.user = data.user;
            this.updateUserUI();
            this.closeProfileModal();
            App.showToast('Profile updated!');
          }
        } catch (err) {
          App.showToast('Failed to update profile');
        }
      });
    }

    // Logout
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => this.logout());
    }
  },

  async checkExistingSession() {
    if (!this.token) {
      this.showAuthModal();
      return false;
    }

    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        this.user = data.user;
        this.hideAuthModal();
        this.updateUserUI();
        return true;
      } else {
        this.logout();
        return false;
      }
    } catch (err) {
      console.warn('Session verification error:', err);
      this.showAuthModal();
      return false;
    }
  },

  handleAuthSuccess(data) {
    this.token = data.token;
    this.user = data.user;
    localStorage.setItem('pulse_token', data.token);
    this.hideAuthModal();
    this.updateUserUI();
    App.onAuthenticated(this.user, this.token);
  },

  showAuthModal() {
    if (this.modal) this.modal.classList.add('active');
  },

  hideAuthModal() {
    if (this.modal) this.modal.classList.remove('active');
  },

  openProfileModal() {
    if (!this.user || !this.profileModal) return;
    document.getElementById('edit-display-name').value = this.user.display_name || '';
    document.getElementById('edit-bio').value = this.user.bio || '';
    this.selectedEditColor = this.user.avatar_color || '#6366f1';

    if (this.editColorPicker) {
      this.editColorPicker.querySelectorAll('.color-dot').forEach(dot => {
        dot.classList.toggle('active', dot.getAttribute('data-color') === this.selectedEditColor);
      });
    }

    this.profileModal.classList.add('active');
  },

  closeProfileModal() {
    if (this.profileModal) this.profileModal.classList.remove('active');
  },

  updateUserUI() {
    if (!this.user) return;
    const nameEl = document.getElementById('my-display-name');
    const handleEl = document.getElementById('my-handle');
    const avatarEl = document.getElementById('my-avatar');

    if (nameEl) nameEl.textContent = this.user.display_name || this.user.username;
    if (handleEl) handleEl.textContent = `@${this.user.username}`;
    if (avatarEl) {
      avatarEl.textContent = (this.user.display_name || this.user.username).charAt(0).toUpperCase();
      avatarEl.style.backgroundColor = this.user.avatar_color || '#6366f1';
    }
  },

  logout() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('pulse_token');
    window.location.reload();
  }
};
