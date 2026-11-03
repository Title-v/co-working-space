// Codes keep floor plans, photo keys and saved links independent of a display name.
export const deskZones = [
  { code: 'A', name: 'Focus Zone', aliases: ['Zone A', 'ห้องแสงเช้า'] },
  { code: 'B', name: 'Team Zone', aliases: ['Zone B', 'ห้องร่มไทร'] },
  { code: 'C', name: 'Forum Zone', aliases: ['Zone C', 'ห้องลานฟ้า'] }
];

export function zoneForName(name) {
  return deskZones.find(zone => zone.name === name || zone.aliases.includes(name));
}

export function zoneFromCode(code) {
  return deskZones.find(zone => zone.code === code)?.name;
}
