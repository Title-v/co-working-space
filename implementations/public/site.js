export const deskMark =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="14" height="9" rx="1.6"/><path d="M10 12v3m-4 1h8"/></svg>';
const header = document.getElementById('site-header');
const here = document.body.dataset.page;
header.innerHTML = `
  <nav class="dashboard__nav customer-nav" aria-label="เมนูหลัก">
    <a class="dashboard__nav-logo" href="/" aria-label="SpaceHub หน้าจองโต๊ะ">
      <span class="navbar__logo-icon" aria-hidden="true">⬡</span>SpaceHub
    </a>
    <div class="dashboard__nav-links"></div>
    <div class="nav-user"></div>
  </nav>`;

const navigation = header.querySelector('.dashboard__nav-links');
for (const [page, label, href] of [
  ['reserve', 'จองโต๊ะ', '/#reserve'],
  ['mine', 'การจองของฉัน', '/my-bookings.html']
]) {
  const item = link(label, href, 'nav-link');
  if (here === page) {
    item.classList.add('nav-link--active');
    item.setAttribute('aria-current', 'page');
  }
  navigation.append(item);
}

export async function api(path, init = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    }
  });
  let data = {};
  if (response.status !== 204) {
    try {
      data = await response.json();
    } catch {
      throw new Error('ระบบยังยืนยันผลไม่ได้ กรุณาตรวจรายการแล้วลองอีกครั้ง');
    }
  }
  if (!response.ok) {
    const error = new Error(data.error || 'ไม่สามารถดำเนินการได้');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function safeNext(value, fallback = '/') {
  if (!value) return fallback;
  try {
    const url = new URL(value, location.origin);
    if (
      url.origin === location.origin &&
      [
        '/',
        '/index.html',
        '/my-bookings.html',
        '/payment.html',
        '/profile.html'
      ].includes(url.pathname)
    ) {
      return url.pathname + url.search + url.hash;
    }
  } catch {}
  return fallback;
}

export function loginUrl() {
  return (
    '/login.html?next=' +
    encodeURIComponent(
      safeNext(location.pathname + location.search + location.hash)
    )
  );
}
export function staffHome(user) {
  if (user?.role === 'manager') return '/manager-dashboard.html';
  if (user?.role === 'employee') return '/employee-dashboard.html';
  return null;
}
export function el(tag, content, className) {
  const node = document.createElement(tag);
  if (content != null) node.textContent = content;
  if (className) node.className = className;
  return node;
}
export function link(label, href, className) {
  const a = el('a', label, className);
  a.href = href;
  return a;
}
export function notice(node, message = '') {
  node.textContent = message;
  node.hidden = !message;
}
export const baht = new Intl.NumberFormat('th-TH', {
  style: 'currency',
  currency: 'THB',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0
});
export const thaiDate = (day) =>
  new Intl.DateTimeFormat('th-TH', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Bangkok'
  }).format(new Date(day + 'T12:00:00+07:00'));
export function formatDesks(desks) {
  const groups = new Map();
  for (const d of desks) {
    if (!groups.has(d.zone)) groups.set(d.zone, []);
    groups.get(d.zone).push(d.label.replace(/^Desk /, 'โต๊ะ '));
  }
  return [...groups]
    .map(([room, seats]) => room + ' · ' + seats.join(', '))
    .join(' / ');
}

export const bookingRef = (id) => 'SH-' + String(id).padStart(6, '0');

const menu = header.querySelector('.nav-user');
menu.append(link('เข้าสู่ระบบ', loginUrl(), 'signin'));
export const session = api('/api/session').then(({ user }) => {
  if (user) {
    const profile = link(
      staffHome(user) ? 'หลังเคาน์เตอร์' : 'บัญชีของฉัน',
      staffHome(user) || '/profile.html',
      'nav-link profile-link'
    );
    const logout = el('button', 'ออกจากระบบ', 'secondary');
    logout.type = 'button';
    logout.onclick = async () => {
      logout.disabled = true;
      try {
        await api('/api/logout', { method: 'POST' });
        sessionStorage.removeItem('user');
        sessionStorage.removeItem('spacehub.draft');
        location.assign('/');
      } catch {
        logout.textContent = 'ลองออกอีกครั้ง';
        logout.disabled = false;
      }
    };
    menu.replaceChildren(profile, logout);
  }
  return user;
});
// Browsing availability remains usable during a session-service interruption.
session.catch(() => {});
