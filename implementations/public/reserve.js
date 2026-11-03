import {
  api,
  baht,
  formatDesks,
  el,
  loginUrl,
  notice,
  session,
  staffHome,
  thaiDate
} from './site.js';
import { renderFloorPlan, zoneButton, zoneFromCode } from './floor-plan.js';

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
const savedKind = draft.kind === 'room' ? 'room' : 'desk';
const query = new URLSearchParams(location.search);
const linkedKind = query.get('type');
let kind =
  linkedKind === 'private-room'
    ? 'room'
    : linkedKind === 'desk'
      ? 'desk'
      : savedKind;
const savedIds =
  kind === savedKind && Array.isArray(draft.ids)
    ? draft.ids.filter(Number.isInteger)
    : [];
let selected = new Set(kind === 'room' ? savedIds.slice(0, 1) : savedIds);
let slotStart = draft.start,
  slotEnd = draft.end,
  zone = zoneFromCode(query.get('zone')) || draft.zone;
let requestKey = (kind === savedKind && draft.key) || crypto.randomUUID();
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
      kind,
      start: slotStart,
      end: slotEnd,
      zone,
      ids: [...selected],
      key: requestKey
    })
  );
}
function availableIds(slot) {
  return (kind === 'room' ? slot?.availableRoomIds : slot?.availableIds) || [];
}
function syncKindControls() {
  const roomMode = kind === 'room';
  $('desk-picker').hidden = roomMode;
  $('private-picker').hidden = !roomMode;
  $('desks-heading').textContent = roomMode ? 'ห้องส่วนตัว' : 'เลือกโต๊ะจากผัง';
  $('resource-label').textContent = roomMode ? 'ห้องส่วนตัว' : 'ห้องและโต๊ะ';
  $('rate-label').textContent = roomMode
    ? 'ราคาทั้งห้องต่อชั่วโมง'
    : 'ราคาต่อโต๊ะต่อรอบ';
  $('capacity-row').hidden = !roomMode;
}
function summary() {
  const slot = activeSlot();
  $('sum-day').textContent = day.value ? thaiDate(day.value) : '—';
  $('sum-time').textContent = slot ? slot.label + ' น.' : '—';
  let total = 0;
  if (kind === 'room') {
    const room = schedule?.privateRooms?.find((r) => selected.has(r.id));
    $('sum-desks').textContent = room?.name || 'ยังไม่ได้เลือก';
    $('sum-capacity').textContent = room ? room.capacity + ' คน' : '—';
    $('unit-price').textContent = room ? baht.format(room.hourlyRate) : '—';
    if (room && slot) total = room.hourlyRate * slot.durationHours;
  } else {
    const desks = schedule?.desks.filter((d) => selected.has(d.id)) || [];
    $('sum-desks').textContent = desks.length
      ? formatDesks(desks)
      : 'ยังไม่ได้เลือก';
    $('unit-price').textContent = settings ? baht.format(settings.price) : '—';
    total = desks.length * (settings?.price || 0);
  }
  $('total').textContent = baht.format(total);
  reserve.disabled = submitting || !slot || slot.started || !selected.size;
}
function clearSchedule() {
  schedule = null;
  for (const id of [
    'slots',
    'zones',
    'floor-canvas',
    'extra-desks',
    'private-room-list'
  ])
    $(id).replaceChildren();
  for (const id of [
    'plan-viewport',
    'plan-zoom',
    'extra-heading',
    'extra-desks'
  ])
    $(id).hidden = true;
  $('plan-description').textContent = '';
  $('zone-title').textContent = 'ผังโต๊ะ';
  $('zone-count').textContent = '';
  $('private-count').textContent = '';
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
      b.disabled = s.started || !availableIds(s).length;
      b.setAttribute('aria-pressed', String(s === slot));
      b.onclick = () => {
        slotStart = s.startTime;
        slotEnd = s.endTime;
        selected = new Set(
          [...selected].filter((id) => availableIds(s).includes(id))
        );
        notice(message);
        saveDraft(true);
        draw();
      };
      return b;
    })
  );
  if (kind === 'room') drawPrivateRooms(slot);
  else drawDesks(slot);
  summary();
}

function drawPrivateRooms(slot) {
  const free = new Set(availableIds(slot));
  const rooms = schedule.privateRooms || [];
  $('private-price-heading').textContent = slot
    ? 'ราคาเหมารอบนี้'
    : 'ราคาต่อชั่วโมง';
  $('private-count').textContent =
    'ว่าง ' + free.size + ' / ' + rooms.length + ' ห้อง';
  if (!rooms.length) {
    $('private-room-list').replaceChildren(
      el('p', 'ยังไม่มีห้องส่วนตัวเปิดให้จอง', 'muted')
    );
    return;
  }
  $('private-room-list').replaceChildren(
    ...rooms.map((room) => {
      const row = el('label', null, 'private-option');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'private-room';
      radio.value = room.id;
      radio.checked = selected.has(room.id);
      radio.disabled = !free.has(room.id);
      radio.onchange = () => {
        selected = new Set([room.id]);
        notice(message);
        saveDraft(true);
        summary();
      };
      const price = slot
        ? baht.format(room.hourlyRate * slot.durationHours)
        : baht.format(room.hourlyRate) + '/ชม.';
      row.append(
        radio,
        el('strong', room.name, 'private-name'),
        el('span', 'สูงสุด ' + room.capacity + ' คน', 'private-capacity'),
        el('span', price, 'private-price'),
        el('span', radio.disabled ? 'ไม่ว่าง' : 'ว่าง', 'private-status')
      );
      return row;
    })
  );
}

function drawDesks(slot) {
  const rooms = [...new Set(schedule.desks.map((d) => d.zone))];
  if (!rooms.includes(zone)) zone = rooms[0];
  const free = new Set(slot?.availableIds || []);
  const focusedZone = document.activeElement?.dataset.zone;
  $('zones').replaceChildren(
    ...rooms.map((room) => {
      const desks = schedule.desks.filter((d) => d.zone === room);
      const button = zoneButton(
        room,
        desks.filter((d) => free.has(d.id)).length,
        desks.length,
        room === zone
      );
      button.onclick = () => {
        if (zone === room) return;
        zone = room;
        const url = new URL(location.href);
        if (button.dataset.zoneCode)
          url.searchParams.set('zone', button.dataset.zoneCode);
        else url.searchParams.delete('zone');
        history.replaceState(null, '', url);
        saveDraft();
        drawDesks(slot);
      };
      return button;
    })
  );
  if (focusedZone) {
    [...$('zones').children]
      .find((b) => b.dataset.zone === focusedZone)
      ?.focus({ preventScroll: true });
  }
  const desks = schedule.desks.filter((d) => d.zone === zone);
  $('zone-title').textContent = zone ? 'ผัง' + zone : 'ยังไม่มีโต๊ะเปิดให้จอง';
  $('zone-count').textContent = slot
    ? 'ว่าง ' +
      desks.filter((d) => free.has(d.id)).length +
      ' / ' +
      desks.length +
      ' โต๊ะ'
    : 'ไม่มีรอบว่างในวันนี้';
  renderFloorPlan({
    zone,
    desks,
    free,
    selected,
    toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      notice(message);
      saveDraft(true);
      summary();
    }
  });
}
function reconcileSelection() {
  const prior = activeSlot();
  const slot =
    prior && !prior.started && availableIds(prior).length
      ? prior
      : schedule.slots.find((s) => !s.started && availableIds(s).length);
  const previousCount = selected.size;
  if (!slot || (slotStart && slotEnd && prior !== slot)) selected.clear();
  slotStart = slot?.startTime;
  slotEnd = slot?.endTime;
  const free = availableIds(slot);
  selected = new Set([...selected].filter((id) => free.includes(id)));
  return previousCount !== selected.size;
}

for (const radio of document.querySelectorAll('[name="booking-kind"]')) {
  radio.checked = radio.value === kind;
  radio.onchange = () => {
    kind = radio.value;
    const url = new URL(location.href);
    if (kind === 'room') {
      url.searchParams.set('type', 'private-room');
      url.searchParams.delete('zone');
    } else url.searchParams.delete('type');
    history.replaceState(null, '', url);
    selected.clear();
    syncKindControls();
    notice(message);
    if (schedule) {
      reconcileSelection();
      draw();
    } else summary();
    saveDraft(true);
  };
}
syncKindControls();

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
    if (reconcileSelection()) {
      saveDraft(true);
      notice(
        message,
        kind === 'room'
          ? 'สถานะห้องเปลี่ยนแล้ว กรุณาเลือกห้องว่าง'
          : 'สถานะโต๊ะเปลี่ยนแล้ว กรุณาตรวจรายการที่เลือก'
      );
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
  const selection = {
    date: day.value,
    startTime: slotStart,
    endTime: slotEnd,
    requestKey,
    ...(kind === 'room'
      ? { privateRoomId: [...selected][0] }
      : { deskIds: [...selected] })
  };
  const form = document.querySelector('.booking-form');
  form.inert = true;
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
      notice(message, 'กรุณาใช้บัญชีลูกค้าเพื่อจองพื้นที่');
      return;
    }
    const result = await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify(selection)
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
    form.inert = false;
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
