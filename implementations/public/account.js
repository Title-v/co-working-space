import {
  api,
  el,
  link,
  loginUrl,
  notice,
  safeNext,
  session,
  staffHome
} from './site.js';

const page = document.body.dataset.page;
if (page === 'profile') {
  const container = document.querySelector('#profile-details');
  try {
    const user = await session;
    if (!user) location.replace(loginUrl());
    else {
      container.replaceChildren(el('h2', user.firstName + ' ' + user.lastName));
      const list = el('dl', null, 'details');
      for (const [title, value] of [
        ['อีเมล', user.email],
        ['โทรศัพท์', user.phone]
      ]) {
        const row = el('div');
        row.append(el('dt', title), el('dd', value));
        list.append(row);
      }
      container.append(
        list,
        link('ดูการจองของฉัน', '/my-bookings.html', 'secondary')
      );
    }
  } catch {
    container.textContent = 'โหลดบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง';
  }
} else {
  const register = page === 'register',
    form = document.querySelector('#account-form');
  const next = safeNext(
    new URLSearchParams(location.search).get('next'),
    '/#reserve'
  );
  const alternate =
    (register ? '/login.html' : '/register.html') +
    '?next=' +
    encodeURIComponent(next);
  document.querySelector('#switch-account').href = alternate;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('button'),
      message = document.querySelector('#account-message');
    const fields = Object.fromEntries(new FormData(form));
    button.disabled = true;
    notice(message);
    let created = false;
    try {
      if (register) {
        await api('/api/register', {
          method: 'POST',
          body: JSON.stringify(fields)
        });
        created = true;
      }
      const { user } = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: fields.email, password: fields.password })
      });
      sessionStorage.removeItem('user');
      location.assign(staffHome(user) || next);
    } catch (err) {
      notice(
        message,
        created ? 'สร้างบัญชีแล้ว กรุณาเข้าสู่ระบบอีกครั้ง' : err.message
      );
    } finally {
      button.disabled = false;
    }
  };
}
