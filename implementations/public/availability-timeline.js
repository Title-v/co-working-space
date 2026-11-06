import { el } from './site.js';

// Use the same server-calculated slots as checkout, including pending holds and
// Bangkok's elapsed-time cutoff. The all-day desk option is not a separate row.
export function availabilityTimeline(resource, kind, slots, onChoose) {
  const field = kind === 'room' ? 'availableRoomIds' : 'availableIds';
  const cells = slots
    .filter((slot) => slot.durationHours === 1)
    .map((slot) => ({
      ...slot,
      state: slot.started
        ? 'past'
        : slot[field].includes(resource.id)
          ? 'free'
          : 'busy'
    }));
  const free = [];
  for (const cell of cells.filter((cell) => cell.state === 'free')) {
    if (free.at(-1)?.endTime === cell.startTime)
      free.at(-1).endTime = cell.endTime;
    else free.push({ startTime: cell.startTime, endTime: cell.endTime });
  }
  const name = resource.name || resource.label;
  const block = el('div', null, 'daily-availability');
  block.dataset.resourceId = resource.id;
  block.dataset.resourceKind = kind;
  const description = el('p', null, 'free-times');
  description.append(
    el('strong', 'ว่าง: '),
    document.createTextNode(
      free.length
        ? free.map((range) => range.startTime + '–' + range.endTime).join(' · ') + ' น.'
        : cells.every((cell) => cell.state === 'past')
          ? 'ไม่มีเวลาเปิดจองที่เหลือในวันนี้'
          : 'ไม่มีช่วงว่างในวันนี้'
    )
  );
  const strip = el('div', null, 'time-strip');
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'เวลาเข้าใช้ ' + name);
  for (const cell of cells) {
    const button = el('button', null, 'time-cell');
    const state = { free: 'ว่าง', busy: 'ไม่ว่าง', past: 'ผ่านไปแล้ว' }[cell.state];
    button.type = 'button';
    button.dataset.state = cell.state;
    button.dataset.start = cell.startTime;
    button.dataset.end = cell.endTime;
    button.disabled = cell.state !== 'free';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', name + ' ' + cell.label + ' น. ' + state);
    button.title = cell.label + ' น. · ' + state;
    button.append(
      el('span', kind === 'room' ? cell.startTime.slice(0, 2) : cell.startTime),
      el('small', '–' + (kind === 'room' ? cell.endTime.slice(0, 2) : cell.endTime))
    );
    button.onclick = () => onChoose(resource, cell);
    strip.append(button);
  }
  block.append(description, strip);
  return block;
}

export function updateTimelineSelection(kind, ids, startTime, endTime) {
  for (const block of document.querySelectorAll('.daily-availability')) {
    const selected = block.dataset.resourceKind === kind && ids.has(Number(block.dataset.resourceId));
    for (const button of block.querySelectorAll('.time-cell')) {
      button.setAttribute(
        'aria-pressed',
        String(selected && !button.disabled && button.dataset.start >= startTime && button.dataset.end <= endTime)
      );
    }
  }
}
