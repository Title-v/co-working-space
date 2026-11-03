// ──────────────────────────────────────────
// SpaceHub — Shared Frontend Utilities
// ──────────────────────────────────────────

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.className = `toast toast--${type} show`;
    toast.textContent = `${type === 'success' ? '✓' : '✕'} ${message}`;
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}

async function requireAuth(allowedRoles) {
    const response = await fetch('/api/session', {credentials: 'same-origin'});
    if (!response.ok) throw new Error('Session service unavailable.');
    const {user} = await response.json();
    if (!user || !allowedRoles.includes(user.role)) {
        window.location.replace('/login.html');
        return null;
    }
    return user;
}

async function handleLogout() {
    const res = await fetch('/api/logout', {method:'POST'});
    if (!res.ok) return showToast('Sign out failed.', 'error');
    sessionStorage.removeItem('user');
    window.location.replace('/');
}

function bangkokToday() {
    return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Bangkok'}).format(new Date());
}

function escapeHtml(value) {
    const span=document.createElement('span');
    span.textContent=String(value ?? '');
    return span.innerHTML;
}

function toggleProfileMenu() {
    const dd = document.getElementById('profileDropdown');
    if (dd) dd.classList.toggle('show');
}

document.addEventListener('click', (e) => {
    const menu = document.querySelector('.profile-menu');
    if (menu && !menu.contains(e.target)) {
        const dd = document.getElementById('profileDropdown');
        if (dd) dd.classList.remove('show');
    }
});

function formatCurrency(amount) {
    return '฿' + Number(amount).toLocaleString();
}

function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('th-TH', {timeZone:'Asia/Bangkok'});
}
