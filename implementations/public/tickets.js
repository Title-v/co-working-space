import {
  api,
  baht,
  bookingRef,
  formatDesks,
  el,
  link,
  loginUrl,
  notice,
  session,
  staffHome,
  thaiDate
} from './site.js';

const checkout = document.body.dataset.page === 'payment',
  list = document.querySelector('#ticket-list'),
  message = document.querySelector('#ticket-message');
const labels = {
  pending: 'รอชำระเดโม',
  confirmed: 'ยืนยันแล้ว',
  cancelled: 'ยกเลิกแล้ว',
  expired: 'หมดเวลาชำระ',
  checked_in: 'เช็กอินแล้ว'
};
const selectedId = new URLSearchParams(location.search).get('booking');
let timer,
  version = 0,
  changing = false;
function action(label, handler, className = 'primary') {
  const b = el('button', label, className);
  b.type = 'button';
  b.onclick = async () => {
    if (changing) return;
    changing = true;
    b.disabled = true;
    notice(message);
    try {
      await handler();
    } catch (e) {
      if (e.status === 401) location.assign(loginUrl());
      else {
        notice(message, e.message);
        await load();
      }
    } finally {
      b.disabled = false;
      changing = false;
    }
  };
  return b;
}
function ticket(b) {
  const card = el('article', null, 'booking-card ticket'),
    top = el('div', null, 'ticket-top');
  top.append(
    el('div', 'เลขที่การจอง ' + bookingRef(b.id), 'ref'),
    el('span', labels[b.status] || b.status, 'badge ' + b.status)
  );
  card.append(top, el('h2', thaiDate(b.booking_date)));
  const details = el('dl', null, 'details');
  const rows = [
    ['ช่วงเวลา', b.start_time + ' – ' + b.end_time + ' น.'],
    ...(b.private_room
      ? [
          ['ห้องส่วนตัวทั้งห้อง', b.private_room.name],
          ['ความจุสูงสุด', b.private_room.capacity + ' คน']
        ]
      : [['ที่นั่ง', formatDesks(b.desks)]]),
    ['ยอดชำระเดโม', baht.format(b.total_baht)]
  ];
  for (const [name, value] of rows) {
    const row = el('div');
    row.append(el('dt', name), el('dd', value));
    details.append(row);
  }
  card.append(details);
  const actions = el('div', null, 'ticket-actions');
  if (b.status === 'pending') {
    if (b.expires_at) {
      const clock = el('p', 'กำลังตรวจเวลาคงเหลือ…', 'countdown');
      clock.dataset.deadline = b.expires_at;
      card.append(clock);
    }
    if (checkout) {
      card.append(
        el(
          'small',
          'ใช้สำหรับทดลองชำระเท่านั้น ไม่ต้องกรอกข้อมูลบัตรหรือโอนเงิน'
        )
      );
      actions.append(
        action('ยืนยันชำระเดโม ' + baht.format(b.total_baht), async () => {
          await api('/api/bookings/' + b.id + '/pay', {
            method: 'POST',
            body: JSON.stringify({ paymentMethod: 'demo' })
          });
          location.assign('/my-bookings.html?confirmed=' + b.id);
        })
      );
    } else {
      actions.append(
        link('ชำระเงินเดโม', '/payment.html?booking=' + b.id, 'primary')
      );
    }
  }
  if (
    b.status === 'pending' ||
    (b.status === 'confirmed' && b.before_booking_day)
  ) {
    actions.append(
      action(
        'ยกเลิกการจอง',
        async () => {
          if (
            !window.confirm(
              'ยกเลิก ' +
                bookingRef(b.id) +
                ' และคืนพื้นที่ให้ผู้จองคนอื่นหรือไม่?'
            )
          )
            return;
          await api('/api/bookings/' + b.id + '/cancel', { method: 'POST' });
          await load();
          notice(message, 'ยกเลิกการจอง ' + bookingRef(b.id) + ' แล้ว');
        },
        'text-button'
      )
    );
  }
  if (checkout && b.status !== 'pending')
    actions.append(link('ดูการจองของฉัน', '/my-bookings.html', 'secondary'));
  card.append(actions);
  return card;
}
let lastExpiryCheck = 0;
function tick() {
  let due = false;
  for (const clock of list.querySelectorAll('[data-deadline]')) {
    const seconds = Math.max(
      0,
      Math.ceil((new Date(clock.dataset.deadline) - Date.now()) / 1000)
    );
    clock.textContent =
      'เหลือเวลาชำระเดโม ' +
      Math.floor(seconds / 60) +
      ':' +
      String(seconds % 60).padStart(2, '0') +
      ' นาที';
    if (!seconds) {
      due = true;
    }
  }
  if (due && !changing && Date.now() - lastExpiryCheck >= 3000) {
    lastExpiryCheck = Date.now();
    load();
  }
}
async function load() {
  const turn = ++version;
  try {
    if (checkout && !/^[1-9]\d*$/.test(selectedId || ''))
      throw new Error('ไม่พบเลขที่การจอง');
    const data = await api(
      checkout ? '/api/bookings/' + selectedId : '/api/bookings'
    );
    if (version !== turn) return;
    const rows = checkout ? [data.booking] : data.bookings;
    if (rows.length) list.replaceChildren(...rows.map(ticket));
    else {
      const box = el('article', null, 'booking-card ticket empty');
      box.append(
        el('h2', 'ยังไม่มีการจอง'),
        el('p', 'เลือกวันและรอบเวลาเพื่อดูโต๊ะหรือห้องส่วนตัวที่ว่าง', 'muted'),
        link('เลือกพื้นที่ทำงาน', '/#reserve', 'primary')
      );
      list.replaceChildren(box);
    }
    const confirmed = new URLSearchParams(location.search).get('confirmed');
    if (
      !checkout &&
      rows.some((b) => String(b.id) === confirmed && b.status === 'confirmed')
    ) {
      notice(
        message,
        'ชำระเดโมสำเร็จ การจอง ' +
          bookingRef(confirmed) +
          ' ได้รับการยืนยันแล้ว'
      );
      history.replaceState(null, '', '/my-bookings.html');
    }
    tick();
  } catch (e) {
    if (e.status === 401) {
      location.replace(loginUrl());
      return;
    }
    list.replaceChildren(
      el('p', e.message, 'notice'),
      link('กลับไปหน้าจองพื้นที่', '/#reserve', 'secondary')
    );
  }
}
try {
  const user = await session;
  if (!user) location.replace(loginUrl());
  else if (staffHome(user)) location.replace(staffHome(user));
  else {
    await load();
    timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !changing) load();
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) location.reload();
    });
  }
} catch {
  notice(message, 'เชื่อมต่อระบบไม่ได้ กรุณาโหลดหน้าอีกครั้ง');
}
