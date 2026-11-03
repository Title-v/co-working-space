// The photo keys match the seeded private-room IDs and the zone codes in the floor plans.
const descriptions = new Map([
  ['zone-a', 'โต๊ะไม้เรียงสองฝั่งของทางเดินกลาง หันไปทางหน้าต่างบานกว้าง'],
  ['zone-b', 'โต๊ะทำงานจัดเป็นกลุ่มโดยมีแนวต้นไม้อยู่นอกหน้าต่าง'],
  ['zone-c', 'โต๊ะไม้เรียงชิดผนังสามด้านเป็นรูปตัวยู เปิดพื้นที่กลางห้อง'],
  ['private-01', 'โต๊ะไม้ขนาดเล็กกับเก้าอี้บุผ้าสองตัวหันเข้าหากัน'],
  ['private-02', 'โต๊ะทำงานยาวกับเก้าอี้สองตัวเรียงข้างกันริมหน้าต่าง'],
  ['private-03', 'โต๊ะไม้สีอ่อนทรงสี่เหลี่ยม มีเก้าอี้บุผ้ารอบสี่ด้าน'],
  ['private-04', 'โต๊ะไม้กลมกับเก้าอี้สีเทาเข้มข้างผนังไม้ระแนง'],
  ['private-05', 'โต๊ะไม้ทรงรียาวกับเก้าอี้สีฟ้าเทาข้างแผงผนังสีครีม'],
  ['private-06', 'โต๊ะสี่เหลี่ยมตรงกลางห้อง มีเก้าอี้สองฝั่งและผนังกระจกฝ้า'],
  ['private-07', 'โต๊ะไม้สองตัวต่อกันเป็นโต๊ะยาว เก้าอี้สีน้ำเงินสองฝั่ง'],
  ['private-08', 'โต๊ะประชุมทรงรีไม้สีเข้มข้างผนังไม้ระแนง'],
  ['private-09', 'โต๊ะประชุมยาว เก้าอี้บุผ้าสีเทา และผนังสีน้ำเงิน'],
  [
    'private-10',
    'โต๊ะประชุมไม้ขนาดใหญ่ล้อมด้วยเก้าอี้สีเทา มีแผงผนังสีเหลืองด้านข้าง'
  ]
]);

const dialog = document.getElementById('room-photo-dialog');
const fullImage = document.getElementById('room-photo-full');
const photoStatus = document.getElementById('room-photo-status');
const zoneHost = document.getElementById('zone-photo');

function photoButton(key, name, detail, zone = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'photo-open' + (zone ? ' photo-open--zone' : '');
  button.dataset.photo = key;
  button.setAttribute('aria-label', 'ดูภาพจำลอง' + name);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-controls', dialog.id);
  button.title = 'ดูภาพจำลอง' + name;

  const thumb = new Image(270, 180);
  thumb.alt = '';
  thumb.loading = zone ? 'eager' : 'lazy';
  thumb.decoding = 'async';
  thumb.src = '/images/rooms/' + key + '-thumb.webp';
  button.append(thumb);
  const icon = document.createElement('span');
  icon.className = 'photo-expand';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6V3h3m4 0h3v3m0 4v3h-3m-4 0H3v-3"/></svg>';
  if (zone) icon.append('ดูภาพจำลอง');
  button.append(icon);

  button.onclick = () => {
    dialog.dataset.photo = key;
    document.getElementById('room-photo-title').textContent = name;
    document.getElementById('room-photo-caption').textContent =
      'ภาพจำลองประกอบการจอง · ' + detail;
    photoStatus.textContent = 'กำลังโหลดภาพ…';
    photoStatus.hidden = false;
    fullImage.hidden = true;
    fullImage.alt = descriptions.get(key);
    fullImage.src = '/images/rooms/' + key + '.webp';
    if (
      fullImage.complete &&
      fullImage.naturalWidth &&
      fullImage.currentSrc === fullImage.src
    )
      showLoaded();
    dialog.showModal();
  };
  return button;
}

export function updateZonePhoto(code, name, description) {
  const key = code && 'zone-' + code.toLowerCase();
  if (!descriptions.has(key)) {
    zoneHost.replaceChildren();
    zoneHost.hidden = true;
    return;
  }
  if (zoneHost.firstElementChild?.dataset.photo !== key) {
    zoneHost.replaceChildren(photoButton(key, name, description, true));
  }
  zoneHost.hidden = false;
}

export function privateRoomPhoto(room) {
  const key = 'private-' + String(room.id).padStart(2, '0');
  if (!descriptions.has(key)) return null;
  return photoButton(
    key,
    room.name,
    'ห้องส่วนตัว รองรับสูงสุด ' + room.capacity + ' คน'
  );
}

function showLoaded() {
  fullImage.hidden = false;
  photoStatus.hidden = true;
}
fullImage.addEventListener('load', showLoaded);
fullImage.addEventListener('error', () => {
  fullImage.hidden = true;
  photoStatus.textContent = 'โหลดภาพไม่สำเร็จ กรุณาปิดแล้วเปิดอีกครั้ง';
  photoStatus.hidden = false;
});
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener('close', () => {
  // Availability polling may have replaced the original thumbnail while the photo was open.
  document
    .querySelector('[data-photo="' + dialog.dataset.photo + '"].photo-open')
    ?.focus({ preventScroll: true });
});
