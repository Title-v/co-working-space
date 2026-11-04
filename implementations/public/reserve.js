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
import { renderFloorPlan, zoneButton } from './floor-plan.js';
import { zoneForName, zoneFromCode } from './desk-zones.mjs';
import { privateRoomPhoto, zonePhoto } from './room-photos.js';
import {
  availabilityTimeline,
  updateTimelineSelection
} from './availability-timeline.js';

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
  zone =
    zoneFromCode(query.get('zone')) ||
    zoneFromCode(draft.zoneCode) ||
    zoneForName(draft.zone)?.name ||
    draft.zone;
let requestKey = (kind === savedKind && draft.key) || crypto.randomUUID();
let minimumCapacity =
  kind === savedKind && Number.isInteger(draft.capacity) ? draft.capacity : 0;
let summaryVisible = false;
let schedule = null,
  settings,
  version = 0,
  submitting = false;
const bookingSlots = () =>
  (kind === 'room' ? schedule?.roomSlots : schedule?.slots) || [];
const activeSlot = () =>
  bookingSlots().find(
    (s) => s.startTime === slotStart && s.endTime === slotEnd
  );
function saveDraft(reset = false) {
  if (reset) requestKey = crypto.randomUUID();
  sessionStorage.setItem(
    draftKey,
    JSON.stringify({
      day: day.value,
      kind,
      capacity: minimumCapacity,
      start: slotStart,
      end: slotEnd,
      zone,
      zoneCode: zoneForName(zone)?.code,
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
  $('availability').dataset.kind = kind;
  $('reserve').dataset.kind = kind;
  $('room-hours-field').hidden = !roomMode;
  $('duration-row').hidden = !roomMode;
  $('time-label').textContent = roomMode
    ? 'เวลาเริ่ม (เวลาไทย)'
    : 'รอบเวลา (เวลาไทย)';
  $('desk-picker').hidden = roomMode;
  $('map-panel').hidden = roomMode;
  $('desk-total').hidden = roomMode;
  $('private-picker').hidden = !roomMode;
  $('desks-heading').textContent = roomMode
    ? 'ห้องส่วนตัว'
    : 'โต๊ะทำงานรายที่นั่ง';
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
  $('sum-hours').textContent = slot ? slot.durationHours + ' ชั่วโมง' : '—';
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
  $('mobile-total').textContent = baht.format(total);
  $('mobile-review').hidden = !total || summaryVisible;
  reserve.disabled = submitting || !slot || slot.started || !selected.size;
  updateTimelineSelection(kind, selected, slotStart, slotEnd);
}
let inspectedDeskId = null;
function showDeskHours(id) {
  const desk = schedule?.desks.find((d) => d.id === id);
  if (!desk) return;
  inspectedDeskId = id;
  $('desk-time-title').textContent = desk.label + ' · ' + desk.zone;
  $('desk-time-date').textContent = thaiDate(day.value) + ' · เวลาไทย';
  $('desk-time-content').replaceChildren(availabilityTimeline(desk, 'desk', schedule.slots, (resource, range) => {
    $('desk-time-dialog').close();
    chooseAvailability(resource, range);
  }));
  if (!$('desk-time-dialog').open) $('desk-time-dialog').showModal();
  updateTimelineSelection(kind, selected, slotStart, slotEnd);
}
function clearSchedule() {
  $('desk-time-dialog').close();
  schedule = null;
  for (const id of [
    'slots',
    'room-hours',
    'zones',
    'floor-canvas',
    'extra-desks',
    'private-room-list',
    'desk-timetable-list'
  ])
    $(id).replaceChildren();
  for (const id of [
    'plan-viewport',
    'plan-zoom',
    'extra-heading',
    'extra-desks'
  ])
    $(id).hidden = true;
  $('slots').disabled = true;
  $('room-hours').disabled = true;
  $('desk-total').textContent = '';
  $('plan-description').textContent = '';
  $('zone-title').textContent = 'ผังโต๊ะ';
  $('zone-count').textContent = '';
  $('private-count').textContent = '';
  $('desk-timetable').hidden = true;
  $('room-schedule-date').textContent = '';
  summary();
}

function draw() {
  if (!schedule) return;
  const slot = activeSlot();
  const slotSelect = $('slots');
  if (kind === 'room') {
    const starts = bookingSlots().filter((range) => range.durationHours === 1);
    const options = starts.map((range) => {
      const option = new Option(range.startTime + ' น.', range.startTime);
      option.disabled = range.started;
      option.selected = range.startTime === slot?.startTime;
      return option;
    });
    if (!slot)
      options.unshift(new Option('ไม่มีเวลาเปิดจองในวันนี้', '', true, true));
    slotSelect.replaceChildren(...options);
    const hours = bookingSlots().filter(
      (range) => range.startTime === slot?.startTime
    );
    $('room-hours').replaceChildren(
      ...hours.map(
        (range) =>
          new Option(
            range.durationHours + ' ชั่วโมง',
            String(range.durationHours),
            false,
            range === slot
          )
      )
    );
    $('room-hours').disabled = !slot;
  } else {
    const options = schedule.slots.map((range) => {
      const fullDay = range.startTime === '08:00' && range.endTime === '18:00';
      const option = new Option(
        fullDay ? 'เต็มวัน 08–18' : range.label,
        range.startTime + '/' + range.endTime
      );
      option.disabled = range.started || !availableIds(range).length;
      option.selected = range === slot;
      return option;
    });
    if (!slot)
      options.unshift(new Option('ไม่มีรอบว่างในวันนี้', '', true, true));
    slotSelect.replaceChildren(...options);
  }
  slotSelect.disabled = !slot;
  if (kind === 'room') drawPrivateRooms(slot);
  else drawDesks(slot);
  summary();
}

function drawPrivateRooms(slot) {
  const list = $('private-room-list');
  const focused = list.contains(document.activeElement)
    ? document.activeElement
    : null;
  const free = new Set(availableIds(slot));
  const rooms = schedule.privateRooms || [];
  const capacityFilter = $('capacity-filter');
  const maximum = rooms.reduce((max, room) => Math.max(max, room.capacity), 0);
  if (Number(capacityFilter.dataset.maximum) !== maximum) {
    capacityFilter.dataset.maximum = maximum;
    if (minimumCapacity > maximum) minimumCapacity = 0;
    const options = [new Option('ทุกขนาด', '0')];
    for (let n = 1; n <= maximum; n++)
      options.push(new Option(n + ' คน', String(n)));
    capacityFilter.replaceChildren(...options);
  }
  capacityFilter.value = String(minimumCapacity);
  const matching = rooms.filter((room) => room.capacity >= minimumCapacity);
  if (selected.size && !matching.some((room) => selected.has(room.id))) {
    selected.clear();
    saveDraft(true);
    notice(message, 'กรุณาเลือกห้องที่รองรับจำนวนผู้เข้าใช้');
  }
  const freeCount = matching.filter((room) => free.has(room.id)).length;
  $('private-count').textContent = 'พบห้องว่าง ' + freeCount + ' ห้อง';
  $('room-schedule-date').textContent =
    'เวลาว่างวันที่ ' + thaiDate(day.value) + ' · เวลาไทย';
  if (!matching.length) {
    list.replaceChildren(el('p', 'ไม่พบห้องตามจำนวนผู้ใช้ที่เลือก', 'muted'));
    return;
  }
  list.replaceChildren(
    ...matching.map((room) => {
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
      const price = baht.format(room.hourlyRate) + ' / ชั่วโมง';
      const pick = el('span', null, 'room-choice');
      pick.append(
        radio,
        el('span', 'เลือกห้อง', 'choice-label'),
        el('span', 'เลือกแล้ว', 'chosen-label')
      );
      const meta = el('span', null, 'room-meta');
      meta.append(
        el('span', 'สูงสุด ' + room.capacity + ' คน', 'private-capacity'),
        el(
          'span',
          radio.disabled ? 'ไม่ว่างตามเวลาที่เลือก' : 'ว่างตามเวลาที่เลือก',
          'private-status'
        ),
        el('span', price, 'private-price')
      );
      row.append(el('strong', room.name, 'private-name'), meta, pick);
      const line = el('div', null, 'private-line');
      line.append(
        privateRoomPhoto(room) ||
          el('span', 'ยังไม่มีภาพห้องนี้', 'photo-unavailable'),
        row,
        availabilityTimeline(
          room, 'room', schedule.roomSlots, chooseAvailability
        )
      );
      return line;
    })
  );
  if (focused) {
    const control = focused.classList.contains('time-cell')
      ? timelineControl(
          list,
          focused.closest('.daily-availability').dataset.resourceId,
          focused.dataset.start
        )
      : focused.dataset.photo
        ? list.querySelector('[data-photo="' + focused.dataset.photo + '"]')
        : list.querySelector('input:enabled[value="' + focused.value + '"]');
    control?.focus({ preventScroll: true });
  }
}

function drawDesks(slot) {
  const rooms = [...new Set(schedule.desks.map((d) => d.zone))];
  if (!rooms.includes(zone)) zone = rooms[0];
  const free = new Set(slot?.availableIds || []);
  $('desk-total').textContent =
    'ที่นั่งว่าง ' + free.size + ' จาก ' + schedule.desks.length + ' ที่นั่ง';
  const focused = document.activeElement;
  const focusedZone = $('zones').contains(focused)
    ? focused.dataset.zone
    : null;
  const focusedPhoto = $('zones').contains(focused)
    ? focused.dataset.photo
    : null;
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
      const item = el('div', null, 'zone-item');
      item.dataset.active = room === zone;
      const photo = zonePhoto(button.dataset.zoneCode, room, 'โซนรายโต๊ะ');
      if (photo) item.append(photo);
      item.append(button);
      return item;
    })
  );
  if (focusedZone || focusedPhoto) {
    [...$('zones').querySelectorAll('button')]
      .find(
        (b) =>
          (focusedZone && b.dataset.zone === focusedZone) ||
          (focusedPhoto && b.dataset.photo === focusedPhoto)
      )
      ?.focus({ preventScroll: true });
  }
  const desks = schedule.desks.filter((d) => d.zone === zone);
  $('zone-title').textContent = zone ? 'ผัง ' + zone : 'ยังไม่มีโต๊ะเปิดให้จอง';
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
      showDeskHours(id);
    }
  });
  drawDeskTimetable(desks);
  if ($('desk-time-dialog').open) showDeskHours(inspectedDeskId);
}

function timelineControl(container, id, start) {
  return container.querySelector(
    '.daily-availability[data-resource-id="' + id +
    '"] .time-cell[data-start="' + start + '"]:enabled'
  );
}

function drawDeskTimetable(desks) {
  const list = $('desk-timetable-list');
  const focused = list.contains(document.activeElement)
    ? document.activeElement
    : null;
  $('desk-timetable').hidden = !desks.length;
  $('desk-schedule-date').textContent =
    zone + ' · ' + thaiDate(day.value) + ' · เวลาไทย';
  list.replaceChildren(
    ...desks.map((desk) => {
      const row = el('div', null, 'desk-time-row');
      row.append(
        el('h4', desk.label),
        availabilityTimeline(desk, 'desk', schedule.slots, chooseAvailability)
      );
      return row;
    })
  );
  if (focused?.classList.contains('time-cell')) {
    timelineControl(
      list,
      focused.closest('.daily-availability').dataset.resourceId,
      focused.dataset.start
    )?.focus({ preventScroll: true });
  }
  updateTimelineSelection(kind, selected, slotStart, slotEnd);
}

function chooseAvailability(resource, range) {
  if (submitting || range.started || !availableIds(range).includes(resource.id))
    return;
  const sameTime = range.startTime === slotStart && range.endTime === slotEnd;
  if (kind === 'room' || !sameTime) selected.clear();
  selected.add(resource.id);
  slotStart = range.startTime;
  slotEnd = range.endTime;
  notice(message);
  saveDraft(true);
  draw();
  $('time-selection-status').textContent =
    'เลือก ' + (resource.name || resource.label) + ' เวลา ' + range.label + ' น.';
}
function reconcileSelection() {
  const prior = activeSlot();
  const ranges = bookingSlots();
  // A fully booked range must remain visible, rather than shortening the customer's visit.
  const keepPrior =
    prior && !prior.started && (kind === 'room' || availableIds(prior).length);
  const slot = keepPrior
    ? prior
    : ranges.find((range) => !range.started && availableIds(range).length) ||
      (kind === 'room' ? ranges.find((range) => !range.started) : undefined);
  const previousCount = selected.size;
  if (!slot || (slotStart && slotEnd && prior !== slot)) selected.clear();
  slotStart = slot?.startTime;
  slotEnd = slot?.endTime;
  const free = availableIds(slot);
  selected = new Set([...selected].filter((id) => free.includes(id)));
  return previousCount !== selected.size;
}

const kindSelect = $('booking-type');
kindSelect.value = kind;
kindSelect.onchange = () => {
  kind = kindSelect.value;
  if (kind === 'room') {
    const oneHour = bookingSlots().find(
      (range) => range.startTime === slotStart && range.durationHours === 1
    );
    slotEnd = oneHour?.endTime;
  }
  const url = new URL(location.href);
  if (kind === 'room') {
    url.searchParams.set('type', 'private-room');
    url.searchParams.delete('zone');
  } else url.searchParams.set('type', 'desk');
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
function selectTime(range) {
  if (!range) return;
  slotStart = range.startTime;
  slotEnd = range.endTime;
  const previousCount = selected.size;
  selected = new Set(
    [...selected].filter((id) => availableIds(range).includes(id))
  );
  notice(
    message,
    selected.size !== previousCount
      ? 'พื้นที่ที่เลือกไม่ว่างตลอดช่วงเวลานี้ กรุณาเลือกใหม่'
      : ''
  );
  saveDraft(true);
  draw();
}
$('slots').onchange = () => {
  if (kind === 'room') {
    const wantedHours = activeSlot()?.durationHours || 1;
    const choices = bookingSlots().filter(
      (range) => range.startTime === $('slots').value
    );
    const range =
      choices.find((range) => range.durationHours === wantedHours) ||
      choices.at(-1);
    selectTime(range);
    if (range && range.durationHours !== wantedHours) {
      notice(
        message,
        'เวลาเริ่มนี้จองได้สูงสุด ' +
          range.durationHours +
          ' ชั่วโมง ถึง ' +
          range.endTime +
          ' น.'
      );
    }
  } else {
    selectTime(
      bookingSlots().find(
        (range) => range.startTime + '/' + range.endTime === $('slots').value
      )
    );
  }
};
$('room-hours').onchange = () => {
  selectTime(
    bookingSlots().find(
      (range) =>
        range.startTime === slotStart &&
        range.durationHours === Number($('room-hours').value)
    )
  );
};
$('capacity-filter').onchange = () => {
  minimumCapacity = Number($('capacity-filter').value);
  if (
    schedule?.privateRooms.some(
      (r) => selected.has(r.id) && r.capacity < minimumCapacity
    )
  ) {
    selected.clear();
    notice(message, 'กรุณาเลือกห้องที่รองรับจำนวนผู้เข้าใช้');
    saveDraft(true);
  } else saveDraft();
  if (schedule) draw();
};
$('reserve').onsubmit = async (event) => {
  event.preventDefault();
  await refresh();
  if (schedule) {
    $('desks-heading').focus({ preventScroll: true });
    $('availability').scrollIntoView({ block: 'start' });
  }
};
new IntersectionObserver(
  ([entry]) => {
    summaryVisible = entry.isIntersecting;
    summary();
  },
  { threshold: 0.2 }
).observe($('booking-summary'));
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
    $('freshness').textContent = 'กำลังตรวจสอบพื้นที่ว่าง…';
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
    freshness.textContent = 'โหลดข้อมูลพื้นที่ว่างไม่สำเร็จ';
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
  const controls = document.querySelectorAll('[data-booking-controls]');
  controls.forEach((control) => {
    control.inert = true;
  });
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
    controls.forEach((control) => {
      control.inert = false;
    });
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
