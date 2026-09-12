// Authentication Module
const Auth = {
  token: localStorage.getItem('antra_token') || localStorage.getItem('pulse_token') || null,
  user: null,
  isUsernameAvailable: false,
  checkUsernameTimeout: null,

  init() {
    this.modal = document.getElementById('auth-modal');
    this.viewLogin = document.getElementById('auth-view-login');
    this.viewRegister = document.getElementById('auth-view-register');

    // Legacy tabs if any
    this.tabs = document.querySelectorAll('.auth-tab-btn');
    this.panels = document.querySelectorAll('.auth-form-panel');

    // Forms
    this.loginForm = document.getElementById('login-form');
    this.registerForm = document.getElementById('register-form');

    // Registration UI Elements
    this.regUsernameInput = document.getElementById('reg-username');
    this.regDisplayNameInput = document.getElementById('reg-display-name');
    this.regBioInput = document.getElementById('reg-bio');
    this.usernameStatusEl = document.getElementById('username-availability-status');
    this.regColorPicker = document.getElementById('reg-color-picker');
    this.loginColorPicker = document.getElementById('login-color-picker');
    this.selectedRegColor = '#6366f1';

    // Live Preview Elements
    this.previewAvatar = document.getElementById('preview-avatar');
    this.previewDisplayName = document.getElementById('preview-display-name');
    this.previewHandle = document.getElementById('preview-handle');
    this.previewBio = document.getElementById('preview-bio');

    // Profile Modal
    this.profileModal = document.getElementById('profile-modal');
    this.profileForm = document.getElementById('profile-form');
    this.editColorPicker = document.getElementById('edit-color-picker');
    this.selectedEditColor = '#6366f1';

    this.bindEvents();
    return this.checkExistingSession();
  },

  switchToRegister() {
    if (this.viewLogin) this.viewLogin.style.display = 'none';
    if (this.viewRegister) {
      this.viewRegister.style.display = 'flex';
      this.viewRegister.classList.add('active');
    }
    const regUserInput = document.getElementById('reg-username');
    if (regUserInput) regUserInput.focus();
    this.updateLivePreview();
  },

  switchToLogin() {
    if (this.viewRegister) {
      this.viewRegister.style.display = 'none';
      this.viewRegister.classList.remove('active');
    }
    if (this.viewLogin) {
      this.viewLogin.style.display = 'flex';
      this.viewLogin.classList.add('active');
    }
    const loginUserInput = document.getElementById('login-username');
    if (loginUserInput) loginUserInput.focus();
  },

  updateLivePreview() {
    const username = this.regUsernameInput ? this.regUsernameInput.value.trim() : '';
    const displayName = this.regDisplayNameInput ? this.regDisplayNameInput.value.trim() : '';
    const bio = this.regBioInput ? this.regBioInput.value.trim() : '';

    if (this.previewDisplayName) {
      this.previewDisplayName.textContent = displayName || username || 'Ronak Mishra';
    }
    if (this.previewHandle) {
      this.previewHandle.textContent = `@${username || 'ronak_dev'}`;
    }
    if (this.previewBio) {
      this.previewBio.textContent = bio ? `"${bio}"` : '"Building aesthetic interfaces with modern precision."';
    }
    if (this.previewAvatar) {
      const initial = (displayName || username || 'R').charAt(0).toUpperCase();
      this.previewAvatar.textContent = initial;
      this.previewAvatar.style.backgroundColor = this.selectedRegColor || '#6366f1';
    }
  },

  bindEvents() {
    // Password visibility toggle helpers
    const setupPasswordToggle = (btnId, inputId) => {
      const btn = document.getElementById(btnId);
      const input = document.getElementById(inputId);
      if (!btn || !input) return;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';

        const openIcon = btn.querySelector('.eye-icon-open');
        const closedIcon = btn.querySelector('.eye-icon-closed');
        if (openIcon && closedIcon) {
          openIcon.style.display = isPassword ? 'none' : 'block';
          closedIcon.style.display = isPassword ? 'block' : 'none';
        }
      });
    };

    setupPasswordToggle('btn-toggle-login-pwd', 'login-password');
    setupPasswordToggle('btn-toggle-reg-pwd', 'reg-password');

    // Switch between Login & Register views
    const btnGotoRegister = document.getElementById('btn-goto-register');
    const btnGotoLogin = document.getElementById('btn-goto-login');

    if (btnGotoRegister) {
      btnGotoRegister.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchToRegister();
      });
    }

    if (btnGotoLogin) {
      btnGotoLogin.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchToLogin();
      });
    }

    // Live preview event listeners on register inputs
    if (this.regUsernameInput) {
      this.regUsernameInput.addEventListener('input', () => this.updateLivePreview());
    }
    if (this.regDisplayNameInput) {
      this.regDisplayNameInput.addEventListener('input', () => this.updateLivePreview());
    }
    if (this.regBioInput) {
      this.regBioInput.addEventListener('input', () => this.updateLivePreview());
    }

    // Login color dot picker
    if (this.loginColorPicker) {
      const loginColorName = document.getElementById('login-color-name');
      this.loginColorPicker.addEventListener('click', (e) => {
        const circle = e.target.closest('.auth-color-circle');
        if (circle) {
          this.loginColorPicker.querySelectorAll('.auth-color-circle').forEach(c => c.classList.remove('active'));
          circle.classList.add('active');
          const colorName = circle.getAttribute('data-name');
          if (loginColorName && colorName) loginColorName.textContent = colorName;
        }
      });
    }

    // Register color pills bar picker
    if (this.regColorPicker) {
      const regColorName = document.getElementById('reg-color-name');
      this.regColorPicker.addEventListener('click', (e) => {
        const pill = e.target.closest('.auth-color-pill');
        if (pill) {
          this.regColorPicker.querySelectorAll('.auth-color-pill').forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          const color = pill.getAttribute('data-color');
          const colorName = pill.getAttribute('data-name');
          if (color) this.selectedRegColor = color;
          if (regColorName && colorName) regColorName.textContent = colorName;
          this.updateLivePreview();
        }
      });
    }

    // Legacy tab switching
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

    // Live Username Availability Check
    if (this.regUsernameInput && this.usernameStatusEl) {
      this.regUsernameInput.addEventListener('input', () => {
        const username = this.regUsernameInput.value.trim().toLowerCase();
        clearTimeout(this.checkUsernameTimeout);

        if (!username) {
          this.usernameStatusEl.className = 'input-feedback-msg';
          this.usernameStatusEl.textContent = 'Letters, numbers, underscores, and dashes (min 3 chars)';
          this.isUsernameAvailable = false;
          return;
        }

        if (username.length < 3) {
          this.usernameStatusEl.className = 'input-feedback-msg invalid';
          this.usernameStatusEl.textContent = '⚠️ Username must be at least 3 characters';
          this.isUsernameAvailable = false;
          return;
        }

        const usernameRegex = /^[a-zA-Z0-9_.-]+$/;
        if (!usernameRegex.test(username)) {
          this.usernameStatusEl.className = 'input-feedback-msg invalid';
          this.usernameStatusEl.textContent = '✕ Only letters, numbers, underscores, dashes, and dots';
          this.isUsernameAvailable = false;
          return;
        }

        this.usernameStatusEl.className = 'input-feedback-msg checking';
        this.usernameStatusEl.textContent = '⏳ Checking availability...';

        this.checkUsernameTimeout = setTimeout(async () => {
          try {
            const res = await fetch(`/api/auth/check-username?username=${encodeURIComponent(username)}`);
            const data = await res.json();
            if (data.available) {
              this.usernameStatusEl.className = 'input-feedback-msg valid';
              this.usernameStatusEl.textContent = '✓ Username is available!';
              this.isUsernameAvailable = true;
            } else {
              this.usernameStatusEl.className = 'input-feedback-msg invalid';
              this.usernameStatusEl.textContent = `✕ ${data.error || 'Username is already taken'}`;
              this.isUsernameAvailable = false;
            }
          } catch (err) {
            this.usernameStatusEl.className = 'input-feedback-msg';
            this.usernameStatusEl.textContent = 'Could not verify username at the moment';
          }
        }, 300);
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

    // Submit Login Form
    if (this.loginForm) {
      this.loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        const submitBtn = document.getElementById('btn-login-submit');

        if (submitBtn) submitBtn.disabled = true;

        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (data.error) {
            errEl.innerHTML = `⚠️ ${data.error}<br><span style="font-size:0.8rem;color:#818cf8;cursor:pointer;text-decoration:underline;margin-top:4px;display:inline-block;" onclick="Auth.switchToRegister()">Don't have an account? Click here to register →</span>`;
            errEl.classList.add('active');
          } else if (data.token) {
            errEl.classList.remove('active');
            this.handleAuthSuccess(data);
          }
        } catch (err) {
          errEl.textContent = 'Server connection error. Please try again.';
          errEl.classList.add('active');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
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
        const submitBtn = document.getElementById('btn-reg-submit');

        if (username.length < 3) {
          errEl.textContent = 'Username must be at least 3 characters long.';
          errEl.classList.add('active');
          return;
        }

        if (password.length < 6) {
          errEl.textContent = 'Password must be at least 6 characters long.';
          errEl.classList.add('active');
          return;
        }

        if (submitBtn) submitBtn.disabled = true;

        try {
          const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username,
              display_name: displayName || username,
              password,
              bio,
              avatar_color: this.selectedRegColor
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
          errEl.textContent = 'Server connection error. Please try again.';
          errEl.classList.add('active');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
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
    localStorage.setItem('antra_token', data.token);
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
    localStorage.removeItem('antra_token');
    localStorage.removeItem('pulse_token');
    window.location.reload();
  }
};
