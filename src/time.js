import { DateTime } from 'luxon';

// A swappable clock so the engine can be tested at any moment in time.
let override = null;

export function setClock(fn) {
  override = fn;
}

export function nowUTC() {
  return override ? override() : DateTime.utc();
}

export function nowIn(zone) {
  return nowUTC().setZone(zone);
}

export function isoDate(dt) {
  return dt.toISODate();
}

export function addDays(dateStr, n, zone) {
  return DateTime.fromISO(dateStr, { zone }).plus({ days: n }).toISODate();
}

export function weekday(dateStr, zone) {
  // ISO weekday: 1 = Monday, 7 = Sunday
  return DateTime.fromISO(dateStr, { zone }).weekday;
}

// The moment a HH:MM deadline falls on a given local date.
export function deadlineAt(dateStr, hhmm, zone) {
  const [h, m] = (hhmm || '23:59').split(':').map(Number);
  return DateTime.fromISO(dateStr, { zone }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

export function validTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}
