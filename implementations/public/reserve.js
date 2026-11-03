import {
  api,
  baht,
  deskMark,
  formatDesks,
  el,
  loginUrl,
  notice,
  session,
  staffHome,
  thaiDate
} from './site.js';

const $ = (id) => document.getElementById(id);
const day = $('day'),
  message = $('booking-message'),
  reserve = $('reserve-button');
const draftKey = 'spacehub.draft';
let draft;
try {
  draft = JSON.parse(sessionStorage.getItem(draftKey) || '{}');
} catch {
  draft = {};
}
let selected = new Set(
  Array.isArray(draft.ids) ? draft.ids.filter(Number.isInteger) : []
);
let slotStart = draft.start,
  slotEnd = draft.end,
  zone = draft.zone;
let requestKey = draft.key || crypto.randomUUID();
let schedule = null,
  settings,
  version = 0,
  submitting = false;
const activeSlot = () =>
  schedule?.slots.find(
    (s) => s.startTime === slotStart && s.endTime === slotEnd
  );
function saveDraft(reset = false) {
  if (reset) requestKey = crypto.randomUUID();
  sessionStorage.setItem(
    draftKey,
    JSON.stringify({
      day: day.value,
      start: slotStart,
      end: slotEnd,
      zone,
      ids: [...selected],
      key: requestKey
    })
  );
}
function summary() {
  const slot = activeSlot();
  const desks = schedule?.desks.filter((d) => selected.has(d.id)) || [];
  $('sum-day').textContent = day.value ? thaiDate(day.value) : '—';
  $('sum-time').textContent = slot ? slot.label + ' น.' : '—';
  $('sum-desks').textContent = desks.length
    ? formatDesks(desks)
    : 'ยังไม่ได้เลือก';
  $('unit-price').textContent = settings ? baht.format(settings.price) : '—';
  $('total').textContent = baht.format(desks.length * (settings?.price || 0));
  reserve.disabled = submitting || !slot || slot.started || !desks.length;
}
function clearSchedule() {
  schedule = null;
  for (const id of ['slots', 'zones', 'desk-map']) $(id).replaceChildren();
  $('zone-title').textContent = 'ผังโต๊ะ';
  $('zone-count').textContent = '';
  summary();
}

function draw() {
  if (!schedule) return;
  const slot = activeSlot();
  $('slots').replaceChildren(
    ...schedule.slots.map((s) => {
      const b = el(
        'button',
        s.startTime === '08:00' && s.endTime === '18:00'
          ? 'เต็มวัน 08–18 น.'
          : s.label
      );
      b.type = 'button';
      b.disabled = s.started || !s.availableDesks;
      b.setAttribute('aria-pressed', String(s === slot));
      b.onclick = () => {
        slotStart = s.startTime;
        slotEnd = s.endTime;
        selected = new Set(
          [...selected].filter((id) => s.availableIds.includes(id))
        );
        notice(message);
        saveDraft(true);
        draw();
      };
      return b;
    })
  );
  const rooms = [...new Set(schedule.desks.map((d) => d.zone))];
  if (!rooms.includes(zone)) zone = rooms[0];
  $('zones').replaceChildren(
    ...rooms.map((room) => {
      const b = el('button', room);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(room === zone));
      b.onclick = () => {
        zone = room;
        saveDraft();
        draw();
      };
      return b;
    })
  );
  const roomDesks = schedule.desks.filter((d) => d.zone === zone);
  const free = new Set(slot?.availableIds || []);
  $('zone-title').textContent = zone ? 'หมายเลขโต๊ะ' : 'ยังไม่มีโต๊ะเปิดให้จอง';
  $('zone-count').textContent = slot
    ? 'ว่าง ' +
      roomDesks.filter((d) => free.has(d.id)).length +
      ' / ' +
      roomDesks.length +
      ' โต๊ะ'
    : 'ไม่มีรอบว่างในวันนี้';
  $('desk-map').replaceChildren(
    ...roomDesks.map((d) => {
      const b = el('button', null, 'desk');
      b.type = 'button';
      b.innerHTML = deskMark;
      b.append(el('span', d.label.replace(/^Desk /, 'โต๊ะ ')));
      b.disabled = !free.has(d.id);
      b.setAttribute('aria-pressed', String(selected.has(d.id)));
      b.setAttribute(
        'aria-label',
        d.zone +
          ' ' +
          d.label.replace(/^Desk /, 'โต๊ะ ') +
          ' ' +
          (b.disabled ? 'ไม่ว่าง' : 'ว่าง')
      );
      b.onclick = () => {
        if (selected.has(d.id)) selected.delete(d.id);
        else selected.add(d.id);
        notice(message);
        saveDraft(true);
        draw();
      };
      return b;
    })
  );
  summary();
}
async function refresh(clear = false) {
  if (!day.value || !day.validity.valid) {
    version++;
    selected.clear();
    clearSchedule();
    notice(message, 'กรุณาเลือกวันที่ในช่วงที่เปิดให้จอง');
    return;
  }
  const localVersion = ++version;
  if (clear) {
    clearSchedule();
    $('freshness').textContent = 'กำลังโหลดผังโต๊ะ…';
  }
  const freshness = $('freshness');
  try {
    const result = await api(
      '/api/bookings/availability?date=' + encodeURIComponent(day.value)
    );
    if (localVersion !== version) return;
    schedule = result;
    const valid = activeSlot();
    const slot =
      valid && !valid.started && valid.availableDesks
        ? valid
        : result.slots.find((s) => !s.started && s.availableDesks);
    const wasSelected = selected.size;
    // A refreshed screen must never move an existing selection to a different time.
    if (!slot || (slotStart && slotEnd && valid !== slot)) selected.clear();
    slotStart = slot?.startTime;
    slotEnd = slot?.endTime;
    selected = new Set(
      [...selected].filter((id) => slot?.availableIds.includes(id))
    );
    if (wasSelected !== selected.size) {
      saveDraft(true);
      notice(message, 'สถานะโต๊ะเปลี่ยนแล้ว กรุณาตรวจรายการที่เลือก');
    }
    freshness.textContent =
      'อัปเดต ' +
      new Intl.DateTimeFormat('th-TH', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Bangkok'
      }).format(new Date()) +
      ' น.';
    freshness.classList.remove('stale');
    draw();
  } catch (e) {
    if (localVersion !== version) return;
    clearSchedule();
    freshness.textContent = 'โหลดผังโต๊ะไม่สำเร็จ';
    freshness.classList.add('stale');
    notice(message, 'ตรวจสอบการเชื่อมต่อแล้วเลือกวันที่อีกครั้ง');
  }
}
day.onchange = () => {
  selected.clear();
  notice(message);
  saveDraft(true);
  refresh(true);
};
reserve.onclick = async () => {
  if (submitting || !selected.size || !activeSlot()) return;
  submitting = true;
  summary();
  saveDraft();
  notice(message);
  try {
    const user = await session;
    if (!user) {
      location.assign(loginUrl());
      return;
    }
    if (staffHome(user)) {
      notice(message, 'กรุณาใช้บัญชีลูกค้าเพื่อจองโต๊ะ');
      return;
    }
    const result = await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({
        date: day.value,
        startTime: slotStart,
        endTime: slotEnd,
        deskIds: [...selected],
        requestKey
      })
    });
    sessionStorage.removeItem(draftKey);
    location.assign('/payment.html?booking=' + result.booking.id);
  } catch (e) {
    if (e.status === 401) {
      location.assign(loginUrl());
      return;
    }
    notice(message, e.message);
    if (e.status === 409) await refresh();
  } finally {
    submitting = false;
    summary();
  }
};
try {
  settings = await api('/api/bookings/settings');
  day.min = settings.today;
  day.max = settings.lastDate;
  day.value =
    draft.day >= day.min && draft.day <= day.max ? draft.day : settings.today;
  await refresh(true);
  if (!draft.day && schedule && !activeSlot()) {
    const tomorrow = new Date(day.value + 'T12:00:00Z');
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    day.value = tomorrow.toISOString().slice(0, 10);
    await refresh(true);
  }
  setInterval(() => {
    if (!document.hidden && !submitting) refresh();
  }, 30000);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
} catch {
  $('freshness').textContent = 'ยังเชื่อมระบบจองไม่ได้';
  notice(message, 'กรุณาโหลดหน้านี้อีกครั้ง');
}
