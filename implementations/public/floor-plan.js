import { updateZonePhoto } from './room-photos.js';

// Coordinates are in a 600 × 360 schematic. Desk numbers are the permanent
// labels in the inventory, not array offsets or database primary keys.
const WIDTH = 600;
const HEIGHT = 360;

function seat(number, x, y, section, chair = 'bottom') {
  return { number, x, y, section, chair };
}

const rowSeats = [];
const rowLabels = [];
for (let row = 0; row < 5; row++) {
  const letter = String.fromCharCode(65 + row);
  const y = 72 + row * 52;
  rowLabels.push({ x: 48, y, text: letter });
  [123, 202, 398, 477].forEach((x, column) => {
    rowSeats.push(seat(1 + row * 4 + column, x, y, 'แถว ' + letter));
  });
}

const pods = [
  [110, 99],
  [300, 99],
  [490, 99],
  [195, 257],
  [405, 257]
];
const podSeats = [];
const podLabels = [];
pods.forEach(([x, y], index) => {
  const section = 'กลุ่ม ' + (index + 1);
  podLabels.push({ x, y, text: section });
  const first = 21 + index * 4;
  podSeats.push(
    seat(first, x - 37, y - 32, section, 'top'),
    seat(first + 1, x + 37, y - 32, section, 'top'),
    seat(first + 2, x - 37, y + 32, section),
    seat(first + 3, x + 37, y + 32, section)
  );
});

const plans = new Map([
  [
    'ห้องแสงเช้า',
    {
      code: 'A',
      description: 'โต๊ะแถวคู่ · ทางเดินกลาง',
      seats: rowSeats,
      drawing:
        '<path class="aisle" d="M264 44h72v279h-72z"/><path class="aisle-line" d="M300 55v90m0 48v109"/>',
      labels: [...rowLabels, { x: 300, y: 169, text: 'ทางเดินกลาง' }]
    }
  ],
  [
    'ห้องร่มไทร',
    {
      code: 'B',
      description: 'โต๊ะหันเข้าหากัน 5 กลุ่ม',
      seats: podSeats,
      drawing:
        '<path class="aisle" d="M22 158h556v40H322v125h-44V198H22z"/><path class="aisle-line" d="M45 178h197m116 0h197"/>' +
        pods
          .map(
            ([x, y]) =>
              '<rect class="furniture" x="' +
              (x - 65) +
              '" y="' +
              (y - 13) +
              '" width="130" height="26" rx="3"/>'
          )
          .join(''),
      labels: [...podLabels, { x: 300, y: 178, text: 'ทางเดิน' }]
    }
  ],
  [
    'ห้องลานฟ้า',
    {
      code: 'C',
      description: 'โต๊ะรูปตัวยู · พื้นที่กลางห้อง',
      seats: [
        ...[277, 214, 151].map((y, i) =>
          seat(41 + i, 112, y, 'ฝั่งซ้าย', 'right')
        ),
        ...[190, 263, 337, 410].map((x, i) =>
          seat(44 + i, x, 81, 'แนวหน้าต่าง')
        ),
        ...[151, 214, 277].map((y, i) =>
          seat(48 + i, 488, y, 'ฝั่งขวา', 'left')
        )
      ],
      drawing:
        '<path class="u-bench" d="M112 292V81H488V292"/><path class="aisle-line" d="M300 304v-70"/>',
      labels: [{ x: 300, y: 187, text: 'พื้นที่กลางห้อง' }]
    }
  ]
]);

const envelope =
  '<rect class="room-fill" x="20" y="22" width="560" height="300"/>';
const walls =
  '<path class="wall" d="M270 322H20V22H580V322H330"/>' +
  '<path class="door-leaf" d="M330 322v-54"/><path class="door-arc" d="M276 322a54 54 0 0 1 54-54"/>' +
  '<path class="window-frame" d="M102 22h116m163 0h116"/><path class="window-glass" d="M102 22h116m163 0h116"/>';
const landmarks = [
  { x: 300, y: 29, text: 'ด้านหน้าต่าง' },
  { x: 300, y: 343, text: '↑ ทางเข้า' }
];

function drawing(contents) {
  // Only fixed, authored plan geometry is passed here.
  return (
    '<svg class="plan-lines" viewBox="0 0 600 360" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
    contents +
    '</svg>'
  );
}
function position(node, { x, y }) {
  node.style.left = (100 * x) / WIDTH + '%';
  node.style.top = (100 * y) / HEIGHT + '%';
}
export function zoneFromCode(code) {
  for (const [zone, plan] of plans) {
    if (plan.code === code) return zone;
  }
}

export function zoneButton(zone, freeCount, total, active) {
  const plan = plans.get(zone);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'zone-choice';
  button.dataset.zone = zone;
  if (plan) button.dataset.zoneCode = plan.code;
  button.setAttribute('aria-label', zone);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute(
    'aria-description',
    'ว่าง ' + freeCount + ' จาก ' + total + ' โต๊ะ'
  );
  if (plan) {
    const preview = document.createElement('span');
    preview.className = 'zone-preview';
    preview.innerHTML = drawing(
      envelope +
        plan.seats
          .map(
            ({ x, y }) =>
              '<rect class="mini-desk" x="' +
              (x - 21) +
              '" y="' +
              (y - 12) +
              '" width="42" height="24" rx="3"/>'
          )
          .join('') +
        '<path class="mini-wall" d="M270 322H20V22H580V322H330"/>'
    );
    button.append(preview);
  }
  const name = document.createElement('strong');
  name.textContent = zone;
  const detail = document.createElement('small');
  detail.textContent =
    (plan ? 'โซน ' + plan.code + ' · ' : '') +
    'ว่าง ' +
    freeCount +
    '/' +
    total;
  const copy = document.createElement('span');
  copy.append(name, detail);
  button.append(copy);
  return button;
}

function deskButton(desk, spot, free, selected, toggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.deskId = String(desk.id);
  button.disabled = !free.has(desk.id);
  const label = desk.label.replace(/^Desk /, 'โต๊ะ ');
  const location = desk.zone + ' ' + label + (spot ? ' · ' + spot.section : '');
  function setState() {
    const pressed = selected.has(desk.id);
    const state = button.disabled ? 'ไม่ว่าง' : pressed ? 'เลือกแล้ว' : 'ว่าง';
    button.setAttribute('aria-pressed', String(pressed));
    button.setAttribute('aria-label', location + ' · ' + state);
    button.title = location + ' · ' + state;
  }
  setState();
  if (spot) {
    button.className = 'plan-seat';
    button.dataset.chair = spot.chair;
    position(button, spot);
    const face = document.createElement('span');
    face.className = 'desk-face';
    face.textContent = String(spot.number);
    button.append(face);
  } else {
    button.className = 'desk';
    button.textContent = label;
  }
  button.onclick = () => {
    toggle(desk.id);
    setState();
  };
  return button;
}

export function renderFloorPlan({ zone, desks, free, selected, toggle }) {
  const canvas = document.getElementById('floor-canvas');
  const viewport = document.getElementById('plan-viewport');
  const additional = document.getElementById('extra-desks');
  const controls = document.getElementById('plan-zoom');
  const focusedId = document.activeElement?.dataset.deskId;
  const changedZone = canvas.dataset.zone !== zone;
  const plan = plans.get(zone);
  updateZonePhoto(plan?.code, zone, plan?.description);
  // A missing or renamed desk must not move every seat that follows it.
  // Ambiguous or newly added labels stay bookable in the additional list.
  const byLabel = new Map();
  for (const desk of desks) {
    byLabel.set(desk.label, byLabel.has(desk.label) ? null : desk);
  }
  const placed = [];
  const placedIds = new Set();
  for (const spot of plan?.seats || []) {
    const desk = byLabel.get('Desk ' + spot.number);
    if (desk) {
      placed.push(deskButton(desk, spot, free, selected, toggle));
      placedIds.add(desk.id);
    }
  }
  const extra = desks
    .filter((d) => !placedIds.has(d.id))
    .map((d) => deskButton(d, null, free, selected, toggle));
  const hasPlan = placed.length > 0;
  viewport.hidden = controls.hidden = !hasPlan;
  canvas.dataset.zone = zone || '';
  if (hasPlan) {
    canvas.innerHTML = drawing(envelope + plan.drawing + walls);
    for (const landmark of [...landmarks, ...plan.labels]) {
      const label = document.createElement('span');
      label.className = 'plan-label';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = landmark.text;
      position(label, landmark);
      canvas.append(label);
    }
    canvas.append(...placed);
  } else {
    canvas.replaceChildren();
  }
  additional.replaceChildren(...extra);
  additional.hidden = !extra.length;
  document.getElementById('extra-heading').hidden = !hasPlan || !extra.length;
  document.getElementById('plan-description').textContent = hasPlan
    ? plan.description
    : '';
  if (changedZone) setZoom(0);
  if (focusedId) {
    const next =
      document.querySelector(
        '#desk-map [data-desk-id="' + focusedId + '"]:enabled'
      ) || (hasPlan ? viewport : additional.querySelector('button:enabled'));
    next?.focus({ preventScroll: true });
  }
}

const scales = [1, 1.5, 2];
let zoom = 0;
function setZoom(index) {
  const viewport = document.getElementById('plan-viewport');
  const canvas = document.getElementById('floor-canvas');
  const centerX = canvas.clientWidth
    ? (viewport.scrollLeft + viewport.clientWidth / 2) / canvas.clientWidth
    : 0.5;
  const centerY = canvas.clientHeight
    ? (viewport.scrollTop + viewport.clientHeight / 2) / canvas.clientHeight
    : 0.5;
  zoom = Math.max(0, Math.min(scales.length - 1, index));
  viewport.dataset.zoomed = String(zoom > 0);
  const size = scales[zoom] * 100 + '%';
  canvas.style.setProperty('--plan-scale', size);
  document.getElementById('zoom-value').textContent = size;
  document.getElementById('zoom-out').disabled = zoom === 0;
  document.getElementById('zoom-in').disabled = zoom === scales.length - 1;
  viewport.scrollLeft = centerX * canvas.clientWidth - viewport.clientWidth / 2;
  viewport.scrollTop =
    centerY * canvas.clientHeight - viewport.clientHeight / 2;
}
document
  .getElementById('zoom-in')
  .addEventListener('click', () => setZoom(zoom + 1));
document
  .getElementById('zoom-out')
  .addEventListener('click', () => setZoom(zoom - 1));

// Touch/trackpad scrolling stays native. A mouse can drag the empty floor.
const viewport = document.getElementById('plan-viewport');
let drag;
viewport.addEventListener('pointerdown', (event) => {
  if (
    !zoom ||
    event.pointerType !== 'mouse' ||
    event.button !== 0 ||
    event.target.closest('button')
  )
    return;
  drag = {
    x: event.clientX,
    y: event.clientY,
    left: viewport.scrollLeft,
    top: viewport.scrollTop
  };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('dragging');
  event.preventDefault();
});
viewport.addEventListener('pointermove', (event) => {
  if (!drag || !viewport.hasPointerCapture(event.pointerId)) return;
  viewport.scrollTo(
    drag.left + drag.x - event.clientX,
    drag.top + drag.y - event.clientY
  );
});
viewport.addEventListener('lostpointercapture', () => {
  drag = null;
  viewport.classList.remove('dragging');
});
