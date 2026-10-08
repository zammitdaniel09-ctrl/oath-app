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
  newToken: null,
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
  if (res.status === 401 && !['/api/login', '/api/setup', '/api/password'].includes(path)) {
    hooks.onUnauthed();
    throw new ApiError('Log in first.', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status);
  return data;
}

let toastTimer;
export function toast(msg, bad = false, ms = null, big = false) {
  $toast.textContent = msg;
  $toast.className = `toast show${bad ? ' bad' : ''}${big ? ' big' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = 'toast'; }, ms || (bad ? 4200 : 2600));
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
  return `${when} by ${deadline}`;
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

export function bar(pct, cls = '') {
  const p = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  return `<div class="pbar ${cls}" role="img" aria-label="${p}%"><i style="width:${p}%"></i></div>`;
}

export function strengthChip(s) {
  const level = s >= 80 ? 'strong' : s >= 40 ? 'mid' : 'new';
  return `<span class="strength ${level}" title="Habit strength">${s}<small>%</small></span>`;
}
