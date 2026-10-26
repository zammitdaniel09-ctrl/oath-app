// Shared state and helpers for the Oath web app. Plain modules, no build step.

export const $app = document.getElementById('app');
export const $toast = document.getElementById('toast');

export const state = {
  route: 'today',
  param: null,
  query: new URLSearchParams(),
  today: null,
  plan: null,
  review: null,
  coach: null,
  settings: null,
  goals: null,
  goal: null,
  pardoning: null,
  editingHabit: null,
  editingTask: null,
  editingGoal: false,
  sending: false,
  focusMinutes: 25,
  dodging: null,
  telegram: null,
  tokens: null,
  newToken: (() => { try { return sessionStorage.getItem('oath.newToken'); } catch { return null; } })(),
  mapView: 'outline',
  mapParent: null,
  mapZoom: null,
  mapFit: null,
  sheetNode: null,
  sheetMode: null,
  decisions: {},
  push: { supported: false, permission: 'default', subscribed: false },
};

export const hooks = { onUnauthed: () => {} };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('You are offline. Try again when you have a connection.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !['/api/login', '/api/setup', '/api/password', '/api/passkey/login'].includes(path)) {
    hooks.onUnauthed();
    throw new ApiError('Log in first.', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status);
  return data;
}

// Toasts wait their turn, so quick ticks don't wipe each other's reactions. Errors go straight on
// screen, and a message already showing or waiting is not queued twice.
let toastTimer;
let toastShowing = null;
const toastQueue = [];

function showToast(t) {
  toastShowing = t;
  $toast.textContent = t.msg;
  $toast.className = `toast show${t.bad ? ' bad' : ''}${t.big ? ' big' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $toast.className = 'toast';
    toastShowing = null;
    const next = toastQueue.shift();
    if (next) setTimeout(() => showToast(next), 200);
  }, t.ms);
}

export function toast(msg, bad = false, ms = null, big = false) {
  const t = { msg, bad, big, ms: ms || (bad ? 4200 : 2600) };
  if (toastShowing?.msg === msg || toastQueue.some((q) => q.msg === msg)) return;
  if (!toastShowing || bad) return showToast(t);
  toastQueue.push(t);
  if (toastQueue.length > 3) toastQueue.shift();
}

export function react(r) {
  if (r?.text) toast(r.text, false, r.big ? 6500 : 4500, Boolean(r.big));
}

export async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    return r;
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
    return null;
  }
}

export const form2obj = (form) => Object.fromEntries(new FormData(form).entries());

export const tz = () => state.today?.timezone || 'Europe/Malta';

export function fmtClock(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz() }).format(new Date(iso));
}

export function fmtDay(dateStr, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!dateStr) return '';
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(`${dateStr}T12:00:00Z`));
}

export function localToday() {
  return state.today?.today || new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date());
}

export function localNowHM() {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz() }).format(new Date());
}

export function left(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: 'due now', cls: 'gone' };
  const min = Math.ceil(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  const text = h ? `${h} h ${m} min left` : `${m} min left`;
  return { text, cls: min <= 60 ? 'soon' : '' };
}

// How hot a deadline is: calm, then Honey within 3 hours, Blaze within 1, Ember within 30 minutes,
// Merlot once it has passed.
export function urgency(iso) {
  if (!iso) return 'calm';
  const min = (new Date(iso).getTime() - Date.now()) / 60000;
  if (min <= 0) return 'over';
  if (min <= 30) return 'ember';
  if (min <= 60) return 'blaze';
  if (min <= 180) return 'honey';
  return 'calm';
}
export const URGENCY = ['calm', 'honey', 'blaze', 'ember', 'over'];

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

export const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`);

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function scheduleText(days, deadline) {
  const set = [...days].sort();
  let when;
  if (set.length === 7) when = 'Every day';
  else if (set.join() === '1,2,3,4,5') when = 'Weekdays';
  else if (set.join() === '6,7') when = 'Weekends';
  else when = set.map((d) => DAY_NAMES[d - 1]).join(', ');
  return `${when} by ${deadline === '00:00' ? 'midnight' : deadline}`;
}

export const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// A light tap of haptic feedback. iOS Safari (17.4+) gives a system tick when a switch toggles;
// elsewhere this does nothing. Progressive enhancement only: never the sole signal.
let hapticEl = null;
export function haptic() {
  try {
    if (!hapticEl) {
      hapticEl = document.createElement('label');
      hapticEl.setAttribute('aria-hidden', 'true');
      hapticEl.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      hapticEl.appendChild(input);
      document.body.appendChild(hapticEl);
    }
    hapticEl.click();
    if (navigator.vibrate) navigator.vibrate(12);
  } catch { /* no haptics available */ }
}

// A progress bar. No measure at all (null) reads differently from a measured 0%.
export function bar(pct, cls = '') {
  if (pct === null || pct === undefined) return `<div class="pbar none ${cls}" role="img" aria-label="Not measured yet"></div>`;
  const p = Math.max(0, Math.min(100, pct));
  return `<div class="pbar ${cls}" role="img" aria-label="${p}%"><i style="width:${p}%"></i></div>`;
}

// A colour from a calendar feed, only if it is a plain CSS colour, so it can go in a style attribute.
export const safeColor = (c) => (/^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\))$/i.test(String(c || '').trim()) ? String(c).trim() : '');

// Habit strength as a small ring with the number beside it.
export function strengthChip(s) {
  const level = s >= 80 ? 'strong' : s >= 40 ? 'mid' : 'new';
  return `<span class="strength ${level}" title="Habit strength ${s}%">${miniRing(s)}<b>${s}<small>%</small></b></span>`;
}

export function miniRing(pct, size = 22) {
  const sw = 3.2;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct || 0)) / 100;
  return `<svg class="mring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="mring-track" stroke-width="${sw}" fill="none"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="mring-fill" stroke-width="${sw}" fill="none" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"${p ? '' : ' opacity="0"'}/>
  </svg>`;
}

// ---------- Icons: plain line drawings, 24 px grid ----------

const ICONS = {
  today: '<circle cx="12" cy="12" r="8.6"/><path d="M8.2 12.4l2.6 2.6 5-5.4"/>',
  plan: '<path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10"/><path d="M4 6.5l1.1 1.1L7 5.6M4 12l1.1 1.1L7 11.1"/><circle cx="5.3" cy="17.5" r="1"/>',
  goals: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2"/>',
  dashboard: '<path d="M4.5 20V13M9.5 20V5M14.5 20v-9M19.5 20V8.5"/>',
  coach: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-8.2L6.5 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>',
  settings: '<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2.2"/><circle cx="9" cy="16.5" r="2.2"/>',
  review: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.8h3.8"/><path d="M12 8v4.3l2.8 1.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5.5 12.5l4.2 4.2L18.5 8"/>',
  steps: '<path d="M8.3 3.5c1.9 0 2.9 2 2.6 4.6-.3 2.4-1.1 3.9-2.7 3.9S5.6 10.6 5.6 8.3c0-2.6 1-4.8 2.7-4.8zM6.4 14.4l4.1-.5.3 2.6c.2 1.3-.6 2.4-1.9 2.5-1.3.2-2.4-.7-2.5-2z"/><path d="M15.7 7.5c1.7 0 2.7 2.2 2.7 4.8 0 2.3-1 3.7-2.6 3.7s-2.4-1.5-2.7-3.9c-.3-2.6.7-4.6 2.6-4.6zM13.2 17.9l4.1.5-.3 2.5c-.2 1.3-1.3 2.2-2.5 2-1.3-.1-2.1-1.2-1.9-2.5z" transform="translate(0 -2)"/>',
  flame: '<path d="M12 3.2c.6 2.9 4.9 4.9 4.9 10a4.9 4.9 0 0 1-9.8 0c0-2.4 1.2-3.7 2-5 .4 1.4 1 2.3 2 2.6-.4-2.6-.1-5.1.9-7.6z"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 1.8M9.5 3h5"/>',
  moon: '<path d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.3 6.3 0 0 0 10.1 10.1z"/>',
  heart: '<path d="M12 19.6s-7.3-4.4-7.3-9.9A4 4 0 0 1 12 7.3a4 4 0 0 1 7.3 2.4c0 5.5-7.3 9.9-7.3 9.9z"/>',
  scale: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.8 10.2a3.2 3.2 0 0 1 6.4 0M12 10.2l1.4-1.6"/>',
  dumbbell: '<path d="M3.5 10v4M6.5 7.5v9M17.5 7.5v9M20.5 10v4M6.5 12h11"/>',
  stand: '<circle cx="12" cy="5" r="1.8"/><path d="M12 8v6.5M12 14.5l-3 5.5M12 14.5l3 5.5M7.5 10.5h9"/>',
  calendar: '<rect x="3.8" y="5" width="16.4" height="15" rx="3"/><path d="M3.8 9.8h16.4M8.3 3v4M15.7 3v4"/>',
  business: '<rect x="3.5" y="7.5" width="17" height="12.5" rx="2.8"/><path d="M9 7.5V5.8c0-.7.6-1.3 1.3-1.3h3.4c.7 0 1.3.6 1.3 1.3v1.7M3.5 12.8h17"/>',
  bolt: '<path d="M13.2 3L5.5 13.3h5.8L10.6 21l7.9-10.4h-5.9z"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.3V12l3.1 1.9"/>',
  sync: '<path d="M19.5 11A7.6 7.6 0 0 0 5.8 7M4.5 4v3.5H8M4.5 13a7.6 7.6 0 0 0 13.7 4M19.5 20v-3.5H16"/>',
  faceid: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0"/>',
  shield: '<path d="M12 3.5l7 2.6v5.3c0 4.4-3 7.9-7 9.1-4-1.2-7-4.7-7-9.1V6.1z"/>',
  key: '<circle cx="8.5" cy="12" r="3.8"/><path d="M12.3 12h8.2M17.5 12v3M20.5 12v2.2"/>',
  link: '<path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3.2-3.2a3.6 3.6 0 0 0-5.1-5.1l-1.1 1.1M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3.2 3.2a3.6 3.6 0 0 0 5.1 5.1l1.1-1.1"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.8H5zM10 20.5h4"/>',
  phone: '<rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6"/><path d="M10.5 18h3"/>',
  telegram: '<path d="M20.5 4.5L3.6 11.2l5.6 1.9 1.9 6.1 3.1-3.6 4.6 3.6z"/><path d="M9.2 13.1l9-6.3"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v2.8"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  focus: '<circle cx="12" cy="12" r="8.6"/><path d="M12 3.4V6M12 18v2.6M3.4 12H6M18 12h2.6"/><circle cx="12" cy="12" r="2"/>',
  map: '<path d="M4 6.5l5-2 6 2 5-2v13l-5 2-6-2-5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  trend: '<path d="M4 16.5l5-5 3.5 3.5L20 7.5M15 7.5h5v5"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/>',
  season: '<path d="M12 3.5c4.7 0 8.5 3.8 8.5 8.5s-3.8 8.5-8.5 8.5"/><path d="M12 20.5c-4.7 0-8.5-3.8-8.5-8.5" stroke-dasharray="2 3"/><path d="M12 8v4l2.5 1.5"/>',
  uni: '<path d="M3 9.5L12 5l9 4.5-9 4.5z"/><path d="M7 11.5v4c1.4 1.3 3 2 5 2s3.6-.7 5-2v-4M21 9.5v5"/>',
  food: '<path d="M7 3.5v6.2a2.3 2.3 0 0 0 4.6 0V3.5M9.3 3.5v17M16.5 20.5V3.5c-2 .8-3 3.3-3 6.3 0 2.3 1 3.4 3 3.7"/>',
  camera: '<path d="M4.5 8.2c0-1 .8-1.7 1.7-1.7h2.2l1.4-2h4.4l1.4 2h2.2c.9 0 1.7.8 1.7 1.7v9.6c0 .9-.8 1.7-1.7 1.7H6.2c-.9 0-1.7-.8-1.7-1.7z"/><circle cx="12" cy="12.8" r="3.4"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.4 15.4l4.6 4.6"/>',
  drink: '<path d="M6.5 4.5h11l-1.4 15a1.6 1.6 0 0 1-1.6 1.5H9.5a1.6 1.6 0 0 1-1.6-1.5zM7.1 10h9.8"/>',
  recipe: '<path d="M5.5 4.5h10.2a2.8 2.8 0 0 1 2.8 2.8v12.2H8.3a2.8 2.8 0 0 1-2.8-2.8zM5.5 16.7a2.8 2.8 0 0 1 2.8-2.8h10.2M9.5 8.5h5"/>',
  blend: '<path d="M7.5 3.5h9l-1.2 9.5H8.7zM8.7 13h6.6l1.2 7.5h-9z"/><path d="M12 16.5v.5"/>',
  bowl: '<path d="M3.8 11.5h16.4a8.2 8.2 0 0 1-16.4 0zM9 20h6M14.5 4.5c-1 1.2-1 2.6 0 3.8M11 5c-.8 1-.8 2.2 0 3.2"/>',
  pot: '<path d="M4.5 9.5h15v7.2a3.3 3.3 0 0 1-3.3 3.3H7.8a3.3 3.3 0 0 1-3.3-3.3zM2.5 11.5h2M19.5 11.5h2M9 9.5V7.8a3 3 0 0 1 6 0v1.7"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.4"/><path d="M15.5 8.5V6.2c0-.9-.8-1.7-1.7-1.7H6.2c-.9 0-1.7.8-1.7 1.7v7.6c0 .9.8 1.7 1.7 1.7h2.3"/>',
  trash: '<path d="M5 7h14M10 4.5h4M7 7l.9 12c.1.9.8 1.5 1.7 1.5h4.8c.9 0 1.6-.6 1.7-1.5L17 7"/>',
  star: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
};

// The Oath mark: a chrome ring with a Merlot arc, an HP ring three quarters full.
let markCount = 0;
export function brandMark(size = 32, cls = '') {
  markCount += 1;
  const g = `bm${markCount}`;
  const r = 22;
  const c = 2 * Math.PI * r;
  return `<svg class="mark${cls ? ` ${cls}` : ''}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id="${g}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:#ffffff"/><stop offset="0.5" style="stop-color:#c9ced6"/><stop offset="1" style="stop-color:#7d838f"/></linearGradient>
    <linearGradient id="${g}m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:#ff2a17"/><stop offset="1" style="stop-color:#b30500"/></linearGradient></defs>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="url(#${g}c)" stroke-width="10"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="url(#${g}m)" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${(c * 0.72).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 32 32)"/>
  </svg>`;
}

export function icon(name, cls = '') {
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

// ---------- Rings: the day at a glance ----------
// list: [{ pct, cls }] outside in. Each ring is a track plus a gradient arc. Animated once per session.
const RING_STOPS = {
  'r-hp': ['var(--merlot-hi)', 'var(--merlot)', '#a30400'],
  'r-day': ['#8dffdc', 'var(--menthol)', '#1fbf8e'],
  'r-move': ['var(--honey)', 'var(--blaze)', 'var(--ember)'],
  'r-sleep': ['#ff7d97', 'var(--cherry)', '#c4103a'],
};
let ringsDrawn = false;
export function rings(list, size = 128) {
  // Big rings get relatively thinner strokes, leaving room for the number in the middle.
  const sw = Math.round(size * (size >= 160 ? 0.086 : 0.105));
  const gap = Math.max(2, Math.round(size * 0.02));
  const animate = !ringsDrawn;
  ringsDrawn = true;
  const defs = list.map(({ cls }) => RING_STOPS[cls] && `<linearGradient id="rg-${cls}" x1="0" y1="0" x2="1" y2="1">${RING_STOPS[cls]
    .map((c, i) => `<stop offset="${i / 2}" style="stop-color:${c}"/>`).join('')}</linearGradient>`).filter(Boolean).join('');
  const circles = list.map((ring, i) => {
    const r = size / 2 - sw / 2 - i * (sw + gap);
    const c = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(1, (ring.pct || 0) / 100));
    const off = c * (1 - p);
    return `<g class="ring ${ring.cls}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r.toFixed(2)}" class="ring-track" stroke-width="${sw}" fill="none"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r.toFixed(2)}" class="ring-fill" stroke-width="${sw}" fill="none" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(animate ? c : off).toFixed(2)}" data-off="${off.toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"${p ? '' : ' opacity="0"'}/>
    </g>`;
  }).join('');
  return `<svg class="rings${animate ? ' drawing' : ''}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><defs>${defs}</defs>${circles}</svg>`;
}

// After a render, sweep any rings that start empty to their value.
export function drawRings() {
  const svg = document.querySelector('svg.rings.drawing');
  if (!svg) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    svg.querySelectorAll('.ring-fill').forEach((c) => c.setAttribute('stroke-dashoffset', c.dataset.off));
    svg.classList.remove('drawing');
  }));
}

// ---------- Small charts ----------

const niceNum = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n < 100 && !Number.isInteger(n) ? String(Math.round(n * 10) / 10) : String(Math.round(n)));

// Vertical bars, one per day, with an optional dashed goal line. values may contain nulls.
// A measured 0 is a flat line on the baseline; a day with no data is a dotted outline.
export function barChart(values, { goal = null, labels = [], titles = labels, cls = '', height = 96, unit = '', label = 'Chart', fmt = niceNum } = {}) {
  const w = 300;
  const h = height;
  const top = 14;
  const n = values.length || 1;
  const max = Math.max(goal || 0, ...values.map((v) => v || 0), 1);
  const slot = w / n;
  const bw = Math.min(26, slot * 0.62);
  const x = (i) => (i * slot + (slot - bw) / 2).toFixed(1);
  const bars = values.map((v, i) => {
    const tip = `<title>${esc(titles[i] || '')}: ${v === null || v === undefined ? 'no data' : `${fmt(v)}${esc(unit)}`}</title>`;
    if (v === null || v === undefined) return `<rect x="${x(i)}" y="${h - 6}" width="${bw.toFixed(1)}" height="6" rx="1.5" class="bc-empty">${tip}</rect>`;
    if (!v) return `<rect x="${x(i)}" y="${h - 1.5}" width="${bw.toFixed(1)}" height="1.5" class="bc-zero">${tip}</rect>`;
    const bh = ((h - top) * v) / max;
    const met = goal && v >= goal;
    return `<rect x="${x(i)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(5, bw / 2).toFixed(1)}" class="bc-bar${met ? ' met' : ''}">${tip}</rect>`;
  }).join('');
  const gy = goal ? h - ((h - top) * goal) / max : null;
  const goalLine = goal ? `<line x1="0" x2="${w}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" class="bc-goal"/>` : '';
  // The goal's number sits in HTML beside the line, so the stretched chart never distorts it.
  const goalLabel = goal ? `<span class="bc-goal-label" style="bottom:${(((h - gy) / h) * 100).toFixed(1)}%" aria-hidden="true">Goal ${fmt(goal)}</span>` : '';
  const axis = labels.length ? `<div class="bc-axis" aria-hidden="true">${labels.map((l, i) => `<span${i === labels.length - 1 ? ' class="last"' : ''}>${esc(l)}</span>`).join('')}</div>` : '';
  const spoken = values.map((v, i) => `${titles[i] || ''} ${v === null || v === undefined ? 'no data' : `${fmt(v)}${unit}`}`).join(', ');
  const aria = `${label}${goal ? `, goal ${fmt(goal)}${unit}` : ''}. ${spoken}`;
  return `<div class="bchart ${cls}"><div class="bchart-plot"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px" role="img" aria-label="${esc(aria)}">${goalLine}${bars}</svg>${goalLabel}</div>${axis}</div>`;
}

// A line with a soft area under it. series: [{ value }].
export function sparkline(values, { cls = '', height = 44 } = {}) {
  const pts = values.map((v) => (v === null || v === undefined ? null : Number(v)));
  const real = pts.filter((v) => v !== null);
  if (real.length < 2) return '';
  const w = 200;
  const h = height;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min || 1;
  const step = w / (pts.length - 1);
  // A missing day breaks the line instead of being bridged; a lone reading shows as a dot.
  const runs = [[]];
  pts.forEach((v, i) => {
    if (v === null) { if (runs[runs.length - 1].length) runs.push([]); return; }
    runs[runs.length - 1].push([i * step, h - 4 - ((v - min) / span) * (h - 10)]);
  });
  const xy = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const paths = runs.filter((r) => r.length).map((r) => {
    if (r.length === 1) return `<path d="M${xy(r[0])} h0.01" class="spark-dot"/>`;
    const line = r.map((p, i) => `${i ? 'L' : 'M'}${xy(p)}`).join(' ');
    const area = `${line} L${r[r.length - 1][0].toFixed(1)} ${h} L${r[0][0].toFixed(1)} ${h} Z`;
    return `<path d="${area}" class="spark-area"/><path d="${line}" class="spark-line"/>`;
  }).join('');
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
}

export const fmtInt = (n) => (n === null || n === undefined ? '-' : Math.round(n).toLocaleString('en-GB'));
export const fmtDec = (n, d = 1) => (n === null || n === undefined ? '-' : Number(n).toFixed(d).replace(/\.0+$/, ''));
export function fmtHours(h) {
  if (h === null || h === undefined) return '-';
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
export function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

// ---------- Large title header ----------

export function pageHead(title, { over = '', actions = '' } = {}) {
  return `<header class="lt">
    <div class="lt-text">${over ? `<p class="lt-over">${over}</p>` : ''}<h1 class="lt-title">${title}</h1></div>
    ${actions ? `<div class="lt-actions">${actions}</div>` : ''}
  </header>`;
}

export function iconLink(href, name, label) {
  return `<a class="icon-btn" href="${href}" aria-label="${label}">${icon(name)}</a>`;
}

// The personal key for Shortcuts and Apple Health, shown once right after it is made.
// It stays on screen (for this tab) until dismissed, so switching to Shortcuts mid-setup does not lose it.
export function keyBlock() {
  if (!state.newToken) return '';
  return `<label class="field"><span>Your key. The server keeps no copy, so save it before you hide it.</span>
    <span class="copy-row"><input class="input mono" id="siri-key" readonly value="${esc(state.newToken)}"><button class="btn tinted small" data-action="copy" data-target="siri-key">Copy</button></span></label>
    <p class="note">Paste it as the value of the <b>Authorization</b> header, on its own or after "Bearer ". <button class="linkish" data-action="key-hide">Hide the key</button></p>`;
}

export function rememberKey(token) {
  state.newToken = token;
  try {
    if (token) sessionStorage.setItem('oath.newToken', token);
    else sessionStorage.removeItem('oath.newToken');
  } catch { /* storage unavailable */ }
}
