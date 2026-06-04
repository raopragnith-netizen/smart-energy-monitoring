// ===== Configuration =====
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const cachedBackend = localStorage.getItem('energyai_backend_url');
const baseEndpoint = (isLocal ? window.location.origin : (cachedBackend || window.location.origin)).replace(/\/$/, '');

const API_BASE = baseEndpoint + '/api/auth';

// Query Vercel configuration to dynamically update the backend URL
if (!isLocal) {
    (async function initApiUrls() {
        try {
            const res = await fetch(window.location.origin + '/api/config');
            const data = await res.json();
            if (data.success && data.backendUrl) {
                const base = data.backendUrl.replace(/\/$/, '');
                if (localStorage.getItem('energyai_backend_url') !== base) {
                    localStorage.setItem('energyai_backend_url', base);
                    window.location.reload();
                }
            }
        } catch (err) {
            console.warn('[API] Failed to fetch backend config:', err.message);
        }
    })();
}

// ===== DOM Elements =====
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const forgotForm = document.getElementById('forgotForm');
const showRegisterLink = document.getElementById('showRegister');
const showLoginLink = document.getElementById('showLogin');
const showForgotLink = document.getElementById('showForgotPassword');
const backToLoginLink = document.getElementById('backToLogin');
const loginSection = document.getElementById('loginSection');
const registerSection = document.getElementById('registerSection');
const forgotSection = document.getElementById('forgotSection');
const loginMessage = document.getElementById('login-message');
const registerMessage = document.getElementById('register-message');
const forgotMessage = document.getElementById('forgot-message');

// Password rule elements
const ruleLength = document.getElementById('rule-length');
const ruleLetter = document.getElementById('rule-letter');
const ruleDigit = document.getElementById('rule-digit');
const ruleSpecial = document.getElementById('rule-special');

// Auto-redirect disabled as requested

// ===== View Switching (login ↔ register ↔ forgot) =====
showRegisterLink.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('register');
});

showLoginLink.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('login');
});

showForgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('forgot');
});

backToLoginLink.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('login');
});

function switchView(mode) {
    loginSection.classList.add('hidden');
    registerSection.classList.add('hidden');
    forgotSection.classList.add('hidden');

    if (mode === 'register') {
        registerSection.classList.remove('hidden');
    } else if (mode === 'forgot') {
        forgotSection.classList.remove('hidden');
    } else {
        loginSection.classList.remove('hidden');
    }
    clearMessages();
}

// ===== Password Validation (real-time) =====
const regPasswordInput = document.getElementById('reg-password');

regPasswordInput.addEventListener('input', () => {
    const pwd = regPasswordInput.value;

    updateRule(ruleLength, pwd.length >= 7);
    updateRule(ruleLetter, /[a-zA-Z]/.test(pwd));
    updateRule(ruleDigit, /[0-9]/.test(pwd));
    updateRule(ruleSpecial, /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pwd));
});

function updateRule(el, passed) {
    if (passed) {
        el.classList.add('pass');
        el.classList.remove('fail');
        el.querySelector('.rule-icon').textContent = '✓';
    } else {
        el.classList.remove('pass');
        el.classList.add('fail');
        el.querySelector('.rule-icon').textContent = '✗';
    }
}

function validatePassword(password) {
    const errors = [];
    if (password.length < 7) errors.push('At least 7 characters required.');
    if (!/[a-zA-Z]/.test(password)) errors.push('Must contain a letter.');
    if (!/[0-9]/.test(password)) errors.push('Must contain a number.');
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) errors.push('Must contain a special character.');
    return errors;
}

// ===== Toggle Password Visibility =====
document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (input.type === 'password') {
            input.type = 'text';
            btn.querySelector('.eye-icon').style.color = '#3b82f6';
        } else {
            input.type = 'password';
            btn.querySelector('.eye-icon').style.color = '#9ca3af';
        }
    });
});

// ===== Display Messages =====
function showMessage(el, text, type) {
    el.textContent = text;
    el.className = 'message-box show ' + type;
}

function clearMessages() {
    [loginMessage, registerMessage, forgotMessage].forEach(el => {
        if (el) {
            el.className = 'message-box';
            el.textContent = '';
        }
    });
}

// ===== Login Handler =====
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    const identifier = document.getElementById('login-identifier').value.trim();
    const password = document.getElementById('login-password').value;
    const btn = document.getElementById('loginBtn');

    if (!identifier || !password) {
        showMessage(loginMessage, 'Please fill in all fields.', 'error');
        return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, password })
        });

        const data = await res.json();

        if (data.success) {
            showMessage(loginMessage, 'Login successful. Redirecting...', 'success');
            localStorage.setItem('energyai_token', data.token);
            localStorage.setItem('energyai_user', JSON.stringify(data.user));
            setTimeout(() => { window.location.href = 'index.html'; }, 800);
        } else {
            showMessage(loginMessage, data.message || 'Invalid credentials.', 'error');
        }
    } catch (err) {
        showMessage(loginMessage, 'Network error. Is the server running?', 'error');
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
});

// ===== Register Handler =====
registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    const username = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const btn = document.getElementById('registerBtn');

    if (!username || !email || !password) {
        showMessage(registerMessage, 'Please fill in all fields.', 'error');
        return;
    }

    // Client-side password validation
    const pwdErrors = validatePassword(password);
    if (pwdErrors.length > 0) {
        showMessage(registerMessage, pwdErrors[0], 'error');
        return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });

        const data = await res.json();

        if (data.success) {
            showMessage(registerMessage, 'Account created. Redirecting...', 'success');
            localStorage.setItem('energyai_token', data.token);
            localStorage.setItem('energyai_user', JSON.stringify(data.user));
            setTimeout(() => { window.location.href = 'index.html'; }, 800);
        } else {
            showMessage(registerMessage, data.message || 'Registration failed.', 'error');
        }
    } catch (err) {
        showMessage(registerMessage, 'Network error. Is the server running?', 'error');
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
});

// ===== Forgot Password Handler =====
forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    const email = document.getElementById('forgot-email').value.trim();
    const btn = document.getElementById('forgotBtn');

    if (!email) {
        showMessage(forgotMessage, 'Please enter your email address.', 'error');
        return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        const data = await res.json();

        if (data.success) {
            showMessage(forgotMessage, 'If that email exists, a reset link has been sent. Check your inbox.', 'success');
        } else {
            // Always show success-like message for security (don't reveal if email exists)
            showMessage(forgotMessage, 'If that email exists, a reset link has been sent. Check your inbox.', 'info');
        }
    } catch (err) {
        showMessage(forgotMessage, 'Could not process request. Try again later.', 'error');
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
});
