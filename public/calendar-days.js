// The Calendar's days (calendar.js): dates as 'YYYY-MM-DD' strings, the page's state, the 28 day chunks
// fetched from /api/calendar, what falls on each day, and overlapping events laid out side by side.
// No drawing and no taps here.
import { addDays, fmtDay, state, api, localToday } from './ui.js';

const VIEW_KEY = 'oath.calview';
export const VIEWS = ['day', 'span', 'month'];
const CHUNK = 28; // days per fetch; the API allows 62
const FRESH_MS = 2 * 60000;

const MQ_WIDE = window.matchMedia('(min-width: 900px)');
export const MQ_WEEK = window.matchMedia('(min-width: 720px)');
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------- Dates, as 'YYYY-MM-DD' strings and day numbers, so no time zone or DST can bend them ----------

const dn = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const weekdayOf = (d) => (new Date(dn(d) * 86400000).getUTCDay() + 6) % 7; // 0 = Monday
export const monday = (d) => addDays(d, -weekdayOf(d));
export const firstOf = (d) => `${d.slice(0, 8)}01`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addMonths(d, n) {
  const t = +d.slice(0, 4) * 12 + (+d.slice(5, 7) - 1) + n;
  const y = Math.floor(t / 12);
  const m = (t % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(+d.slice(8, 10), daysIn(y, m))).padStart(2, '0')}`;
}
export const minutesOf = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3);
export const hm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(`${d}T12:00:00Z`));
export const longDay = (d) => fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' });
export const monthYear = (d) => fmtDay(d, { month: 'long', year: 'numeric' });

// ---------- State ----------

const savedView = () => {
  try { return VIEWS.includes(localStorage.getItem(VIEW_KEY)) ? localStorage.getItem(VIEW_KEY) : null; } catch { return null; }
};
export const saveView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };

export function cal() {
  if (!state.cal) {
    state.cal = { view: savedView() || (MQ_WIDE.matches ? 'span' : 'day'), date: null, today: null, syncedTo: null, chunks: new Map(), inflight: new Map(), ready: false, scrolled: false, sliding: false, lastQuery: null };
  }
  return state.cal;
}

export const cols = () => (MQ_WEEK.matches ? 7 : 3); // columns of the multi-day grid
export const gridDays = (c) => (c.view === 'day' ? 1 : cols());
// The first day of the grid that holds `date`: the 7 day grid starts on Monday, the 3 day one on the day.
export const gridStart = (c, date) => (c.view === 'span' && cols() === 7 ? monday(date) : date);

// ---------- Fetching: 28 day chunks of events and deadline markers, kept for a couple of minutes ----------

const chunkOf = (d) => Math.floor(dn(d) / CHUNK);

function loadChunk(k) {
  const c = cal();
  if (c.inflight.has(k)) return c.inflight.get(k);
  const from = iso(k * CHUNK);
  const to = iso(k * CHUNK + CHUNK - 1);
  const p = Promise.all([
    api('GET', `/api/calendar/events?from=${from}&to=${to}`),
    api('GET', `/api/calendar/markers?from=${from}&to=${to}`).catch(() => ({ markers: [] })),
  ]).then(([e, m]) => {
    c.chunks.set(k, { events: e.events, markers: m.markers, at: Date.now() });
    if (e.syncedTo !== undefined) c.syncedTo = e.syncedTo;
    // Keep the nearest few chunks only.
    const here = chunkOf(c.date || localToday());
    if (c.chunks.size > 14) [...c.chunks.keys()].sort((a, b) => Math.abs(b - here) - Math.abs(a - here)).slice(0, c.chunks.size - 14).forEach((x) => c.chunks.delete(x));
  }).finally(() => c.inflight.delete(k));
  c.inflight.set(k, p);
  return p;
}

// Makes sure every chunk touching [from, to] is loaded and no older than two minutes (fresh: refetch
// them all). Resolves to how many it fetched.
export async function ensure(from, to, { fresh = false } = {}) {
  const c = cal();
  const want = [];
  for (let k = chunkOf(from); k <= chunkOf(to); k += 1) {
    const have = c.chunks.get(k);
    if (!have || fresh || Date.now() - have.at > FRESH_MS) want.push(k);
  }
  await Promise.all(want.map(loadChunk));
  return want.length;
}

// The days the page may show after this many swipes either way: the grid or month, and the week strip.
export function windowOf(c, pages) {
  const day = c.date;
  let a;
  let b;
  if (c.view === 'month') {
    a = monday(addMonths(firstOf(day), -pages));
    b = addDays(monday(addMonths(firstOf(day), pages)), 41);
  } else {
    const n = gridDays(c);
    const s = gridStart(c, day);
    a = addDays(s, -n * pages);
    b = addDays(s, n * (pages + 1) - 1);
    if (c.view === 'day' || n === 3) {
      a = a < addDays(monday(day), -7 * pages) ? a : addDays(monday(day), -7 * pages);
      b = b > addDays(monday(day), 7 * (pages + 1) - 1) ? b : addDays(monday(day), 7 * (pages + 1) - 1);
    }
  }
  // One day more: a deadline at 00:00 the day after the last one shown flags that last day at midnight.
  return [a, addDays(b, 1)];
}

// Events and markers on one day, split into the all-day row, the timed blocks and the deadline marks.
export function evSpan(e) {
  if (e.allDay) return [e.start, e.end];
  const a = e.start.slice(0, 10);
  let b = e.end.slice(0, 10);
  if (b > a && e.end.slice(11, 16) === '00:00') b = addDays(b, -1); // ending at midnight does not spill into the next day
  return [a, b];
}

// A VLE deadline at 00:00 is the end of the day before (its task is due then, at midnight), so it flags
// that day at midnight instead of the top of its own.
export const atMidnight = (e) => e.deadline && !e.allDay && e.time === '00:00';
const deadlineMark = (e, min) => ({ ev: e, min, title: e.title, color: e.color, key: `e:${e.id}`, done: e.done });

export function dayInfo(d) {
  const ch = cal().chunks.get(chunkOf(d));
  const timed = [];
  const allDay = [];
  const marks = [];
  for (const e of ch?.events || []) {
    const [a, b] = evSpan(e);
    if (a > d || b < d || atMidnight(e)) continue;
    if (e.allDay) allDay.push({ ev: e });
    else if (e.deadline) marks.push(deadlineMark(e, minutesOf(e.time)));
    else timed.push(e);
  }
  const next = addDays(d, 1);
  for (const e of cal().chunks.get(chunkOf(next))?.events || []) {
    if (atMidnight(e) && e.start.slice(0, 10) === next) marks.push(deadlineMark(e, 1440));
  }
  for (const m of ch?.markers || []) {
    if (m.date !== d) continue;
    if (m.time) marks.push({ m, min: m.midnight ? 1440 : minutesOf(m.time), title: m.title, key: `${m.kind}:${m.id}:${m.date}`, done: m.done, kind: m.kind, hard: m.hard });
    else allDay.push({ m });
  }
  marks.sort((x, y) => x.min - y.min);
  return { timed, allDay, marks };
}

export const findEvent = (id) => {
  for (const ch of cal().chunks.values()) {
    const e = ch.events.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
};
export const findMark = (key) => {
  for (const ch of cal().chunks.values()) {
    const m = ch.markers.find((x) => `${x.kind}:${x.id}:${x.date}` === key);
    if (m) return m;
  }
  return null;
};

// ---------- Layout: overlapping events side by side, as in any calendar app ----------

export function lanes(items) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let group = [];
  let groupEnd = 0;
  const close = () => {
    const ends = [];
    for (const it of group) {
      let col = ends.findIndex((end) => end <= it.vs);
      if (col < 0) { col = ends.length; ends.push(0); }
      ends[col] = it.ve;
      it.col = col;
    }
    group.forEach((it) => {
      it.cols = ends.length;
      // Stretch across the columns to the right that nothing else uses while this one runs.
      it.span = 1;
      while (it.col + it.span < ends.length && !group.some((o) => o.col === it.col + it.span && o.vs < it.ve && o.ve > it.vs)) it.span += 1;
      out.push(it);
    });
    group = [];
  };
  for (const it of sorted) {
    if (group.length && it.s >= groupEnd) close();
    group.push(it);
    groupEnd = group.length === 1 ? it.ve : Math.max(groupEnd, it.ve);
  }
  if (group.length) close();
  return out;
}
