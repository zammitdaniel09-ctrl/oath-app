// The Calendar page: a day grid, a 3 day (phone) or week (wide) grid and a month, all read from
// /api/calendar. Oath's own events are added, changed and deleted in a sheet; events from the feeds
// are read-only. Plain strings like the other pages: the app redraws #app, this module only decides
// what goes in it. Swipes are a transform on a three-pane track (the pane before, this one, the pane
// after), so a swipe is a spring on the compositor and the redraw after it is invisible.
import {
  $app, state, esc, api, act, toast, icon, pageHead, safeColor, localToday, localNowHM, haptic, form2obj, fmtDay,
  reduced, shortDay, addDays, confirmSheet, ago,
} from './ui.js';
import { spring } from './motion.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };

const VIEW_KEY = 'oath.calview';
const VIEWS = ['day', 'span', 'month'];
const CHUNK = 28; // days per fetch; the API allows 62
const FRESH_MS = 2 * 60000;
const HEAD_H = 56; // px, the day headings of the 3 day and week grids
const MQ_WIDE = window.matchMedia('(min-width: 900px)');
const MQ_WEEK = window.matchMedia('(min-width: 720px)');
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------- Dates, as 'YYYY-MM-DD' strings and day numbers, so no time zone or DST can bend them ----------

const dn = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const weekdayOf = (d) => (new Date(dn(d) * 86400000).getUTCDay() + 6) % 7; // 0 = Monday
const monday = (d) => addDays(d, -weekdayOf(d));
const firstOf = (d) => `${d.slice(0, 8)}01`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addMonths(d, n) {
  const t = +d.slice(0, 4) * 12 + (+d.slice(5, 7) - 1) + n;
  const y = Math.floor(t / 12);
  const m = (t % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(+d.slice(8, 10), daysIn(y, m))).padStart(2, '0')}`;
}
const minutesOf = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3);
const hm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(`${d}T12:00:00Z`));
const longDay = (d) => fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' });
const monthYear = (d) => fmtDay(d, { month: 'long', year: 'numeric' });

// ---------- State ----------

const savedView = () => {
  try { return VIEWS.includes(localStorage.getItem(VIEW_KEY)) ? localStorage.getItem(VIEW_KEY) : null; } catch { return null; }
};
const saveView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };

function cal() {
  if (!state.cal) {
    state.cal = { view: savedView() || (MQ_WIDE.matches ? 'span' : 'day'), date: null, chunks: new Map(), inflight: new Map(), ready: false, scrolled: false, sliding: false, lastQuery: null };
  }
  return state.cal;
}

const cols = () => (MQ_WEEK.matches ? 7 : 3); // columns of the multi-day grid
const gridDays = (c) => (c.view === 'day' ? 1 : cols());
// The first day of the grid that holds `date`: the 7 day grid starts on Monday, the 3 day one on the day.
const gridStart = (c, date) => (c.view === 'span' && cols() === 7 ? monday(date) : date);

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
    // Keep the nearest few chunks only.
    const here = chunkOf(c.date || localToday());
    if (c.chunks.size > 14) [...c.chunks.keys()].sort((a, b) => Math.abs(b - here) - Math.abs(a - here)).slice(0, c.chunks.size - 14).forEach((x) => c.chunks.delete(x));
  }).finally(() => c.inflight.delete(k));
  c.inflight.set(k, p);
  return p;
}

// Makes sure every chunk touching [from, to] is loaded and no older than two minutes (fresh: refetch
// them all). Resolves to how many it fetched.
async function ensure(from, to, { fresh = false } = {}) {
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
function windowOf(c, pages) {
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
  return [a, b];
}

const prefetch = () => {
  const c = cal();
  ensure(...windowOf(c, 2)).then((n) => {
    if (n && state.route === 'calendar' && !state.calSheet && !c.sliding) ctx.render();
  }).catch(() => {});
};

// Events and markers on one day, split into the all-day row, the timed blocks and the deadline marks.
function evSpan(e) {
  if (e.allDay) return [e.start, e.end];
  const a = e.start.slice(0, 10);
  let b = e.end.slice(0, 10);
  if (b > a && e.end.slice(11, 16) === '00:00') b = addDays(b, -1); // ending at midnight does not spill into the next day
  return [a, b];
}

function dayInfo(d) {
  const ch = cal().chunks.get(chunkOf(d));
  const timed = [];
  const allDay = [];
  const marks = [];
  for (const e of ch?.events || []) {
    const [a, b] = evSpan(e);
    if (a > d || b < d) continue;
    if (e.allDay) allDay.push({ ev: e });
    else if (e.deadline) marks.push({ ev: e, min: minutesOf(e.time), title: e.title, color: e.color, key: `e:${e.id}`, done: false });
    else timed.push(e);
  }
  for (const m of ch?.markers || []) {
    if (m.date !== d) continue;
    if (m.time) marks.push({ m, min: m.midnight ? 1440 : minutesOf(m.time), title: m.title, key: `${m.kind}:${m.id}:${m.date}`, done: m.done, kind: m.kind, hard: m.hard });
    else allDay.push({ m });
  }
  marks.sort((x, y) => x.min - y.min);
  return { timed, allDay, marks };
}

const findEvent = (id) => {
  for (const ch of cal().chunks.values()) {
    const e = ch.events.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
};
const findMark = (key) => {
  for (const ch of cal().chunks.values()) {
    const m = ch.markers.find((x) => `${x.kind}:${x.id}:${x.date}` === key);
    if (m) return m;
  }
  return null;
};

// ---------- Layout: overlapping events side by side, as in any calendar app ----------

function lanes(items) {
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

// ---------- Pieces of the page ----------

const colorOf = (e) => safeColor(e.color);
const cVar = (color) => (safeColor(color) ? ` style="--c:${safeColor(color)}"` : '');

// n is how many days the grid shows: side by side in a narrow column, a title is cut short, not broken.
function eventBlock(it, n) {
  const e = it.ev;
  const mins = it.e - it.s;
  const lane = n > 1 && it.cols > 1;
  const cls = ['cal-ev', e.own ? 'own' : '', e.busy === false ? 'free' : '', mins < 50 ? 'short' : '', mins < 28 ? 'tiny' : '', lane ? 'lane' : '', n > 1 && it.cols > 2 ? 'dense' : ''].filter(Boolean).join(' ');
  const sub = `${e.time} to ${e.endTime}`;
  const place = e.location ? `<span class="cal-ev-p">${esc(e.location)}</span>` : '';
  const style = `top:${((it.s / 1440) * 100).toFixed(3)}%;height:${((mins / 1440) * 100).toFixed(3)}%;left:calc(${((it.col / it.cols) * 100).toFixed(3)}% + 1px);width:calc(${((it.span / it.cols) * 100).toFixed(3)}% - 3px)${colorOf(e) ? `;--c:${colorOf(e)}` : ''}`;
  return `<button type="button" class="${cls}" style="${style}" data-action="cal-event" data-id="${esc(e.id)}" aria-label="${esc(`${e.title}, ${sub}${e.location ? `, ${e.location}` : ''}`)}"><span class="cal-ev-t">${esc(e.title)}</span><span class="cal-ev-s">${sub}</span>${place}</button>`;
}

// A deadline: a thin line across the column at its time, with a small flag above it.
function markHtml(mk, stack, wide) {
  const top = (mk.min / 1440) * 100;
  const label = esc(mk.title);
  const cls = ['cal-mk', mk.kind || 'vle', mk.done ? 'done' : '', mk.hard ? 'hard' : '', mk.min < 30 ? 'low' : ''].filter(Boolean).join(' ');
  const time = mk.min >= 1440 ? 'midnight' : hm(mk.min);
  // One that is already kept or done shrinks to its mark, so it does not cover the day's events.
  const named = wide && !mk.done;
  return `<div class="${cls}" style="top:${top.toFixed(3)}%;--k:${stack}${safeColor(mk.color) ? `;--c:${safeColor(mk.color)}` : ''}"><button type="button" class="cal-mk-chip${named ? '' : ' bare'}" data-action="cal-mark" data-key="${esc(mk.key)}" aria-label="${label}, due ${time}${mk.done ? ', done' : ''}"><i></i>${named ? `<span>${label}</span>` : ''}</button></div>`;
}

function columnHtml(d, info, n, today, nowMin) {
  const items = info.timed.map((e) => {
    const s = evSpan(e)[0] < d ? 0 : minutesOf(e.time);
    let end = e.end.slice(0, 10) > d ? 1440 : minutesOf(e.endTime);
    if (end <= s) end = Math.min(1440, s + 15);
    return { ev: e, s, e: end, vs: s, ve: Math.max(end, s + 30) };
  });
  const blocks = lanes(items).map((it) => eventBlock(it, n)).join('');
  // Deadlines close together stack their flags upwards instead of printing over each other.
  let prev = -999;
  let stack = 0;
  const marks = info.marks.map((mk) => {
    stack = mk.min - prev < 18 ? stack + 1 : 0;
    prev = mk.min;
    return markHtml(mk, stack, n === 1);
  }).join('');
  const now = d === today ? `<div class="cal-now" style="top:${((nowMin / 1440) * 100).toFixed(3)}%"></div>` : '';
  return `<div class="cal-col${d === today ? ' today' : ''}" data-date="${d}">${blocks}${marks}${now}</div>`;
}

function allDayCell(info) {
  const list = info.allDay;
  const room = 3;
  const shown = list.length > room ? list.slice(0, room - 1) : list;
  const chips = shown.map((x) => {
    if (x.ev) {
      const e = x.ev;
      return `<button type="button" class="cal-chip${e.own ? ' own' : ''}${e.deadline ? ' flag' : ''}"${cVar(e.color)} data-action="cal-event" data-id="${esc(e.id)}">${esc(e.title)}</button>`;
    }
    const m = x.m;
    return `<button type="button" class="cal-chip task${m.done ? ' done' : ''}" data-action="cal-mark" data-key="${esc(`${m.kind}:${m.id}:${m.date}`)}"><i></i>${esc(m.title)}</button>`;
  }).join('');
  const more = list.length > room ? `<span class="cal-more">+${list.length - shown.length} more</span>` : '';
  return `<div class="cal-ad">${chips}${more}</div>`;
}

function hourLabels() {
  return Array.from({ length: 23 }, (_, i) => `<span class="cal-hour" style="top:${(((i + 1) / 24) * 100).toFixed(3)}%">${String(i + 1).padStart(2, '0')}:00</span>`).join('');
}

// One pane of the grid: n days starting at `start`. rows is the number of all-day rows every pane
// shares, so the three panes of the track are always the same height.
function gridPane(start, n, rows, today, nowMin) {
  const days = Array.from({ length: n }, (_, i) => addDays(start, i));
  const infos = days.map(dayInfo);
  const heads = n > 1 ? `<div class="cal-heads" style="--n:${n}"><span></span>${days.map((d) => {
    const cls = `cal-head${d === today ? ' today' : ''}`;
    return `<button type="button" class="${cls}" data-action="cal-open" data-date="${d}" aria-label="${longDay(d)}"><span>${DOW[weekdayOf(d)]}</span><b>${+d.slice(8)}</b></button>`;
  }).join('')}</div>` : '';
  const allDay = rows ? `<div class="cal-allday" style="--n:${n};--rows:${rows}"><span class="cal-allday-l">all-day</span>${infos.map(allDayCell).join('')}</div>` : '';
  const showNow = days.includes(today);
  const nowLabel = showNow ? `<span class="cal-nowlbl" style="top:${((nowMin / 1440) * 100).toFixed(3)}%">${hm(nowMin)}</span>` : '';
  return `<div class="cal-pane">${heads}${allDay}<div class="cal-body" style="--n:${n}">
    <div class="cal-hours" aria-hidden="true">${hourLabels()}${nowLabel}</div>
    <div class="cal-cols${n > 1 ? ' multi' : ''}">${days.map((d, i) => columnHtml(d, infos[i], n, today, nowMin)).join('')}</div></div></div>`;
}

// Three panes in a track: before, this one, after. Only the middle one is read by a screen reader.
function track(which, panes) {
  return `<div class="cal-pager cal-${which}" data-pager="${which}"><div class="cal-track">${panes.map((p, i) => `<div class="cal-slot"${i === 1 ? '' : ' aria-hidden="true" inert'}>${p}</div>`).join('')}</div></div>`;
}

function gridHtml(c) {
  const today = localToday();
  const nowMin = minutesOf(localNowHM());
  const n = gridDays(c);
  const s = gridStart(c, c.date);
  const starts = [-1, 0, 1].map((k) => addDays(s, k * n));
  const rows = Math.min(3, Math.max(0, ...starts.flatMap((st) => Array.from({ length: n }, (_, i) => dayInfo(addDays(st, i)).allDay.length))));
  return track('main', starts.map((st) => gridPane(st, n, rows, today, nowMin)));
}

function dots(d) {
  const info = dayInfo(d);
  const colours = [...new Set([...info.allDay.filter((x) => x.ev).map((x) => x.ev.color), ...info.timed.map((e) => e.color)].map((x) => safeColor(x) || '#c9ced6'))].slice(0, 3);
  return colours.map((x) => `<i style="background:${x}"></i>`).join('');
}

function stripHtml(c) {
  const today = localToday();
  const n = gridDays(c);
  const s = gridStart(c, c.date);
  const inGrid = (d) => c.view === 'span' && d >= s && d < addDays(s, n);
  const pane = (start) => `<div class="cal-week">${Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const cls = ['cal-wd', d === today ? 'today' : '', d === c.date ? 'sel' : '', inGrid(d) ? 'in' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-action="cal-pick" data-date="${d}" aria-label="${longDay(d)}"${d === c.date ? ' aria-current="date"' : ''}><span class="cal-wd-n">${DOW[i][0]}</span><b>${+d.slice(8)}</b><span class="cal-dots">${dots(d)}</span></button>`;
  }).join('')}</div>`;
  const m = monday(c.date);
  return track('strip', [addDays(m, -7), m, addDays(m, 7)].map(pane));
}

function monthPane(first, today, sel) {
  const start = monday(first);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    const info = dayInfo(d);
    const out = d.slice(0, 7) !== first.slice(0, 7);
    const list = [...info.allDay.filter((x) => x.ev).map((x) => x.ev), ...info.timed];
    const chips = list.slice(0, 3).map((e) => `<span class="cal-mc${e.own ? ' own' : ''}"${cVar(e.color)}>${esc(e.title)}</span>`).join('') + (list.length > 3 ? `<span class="cal-mc more">+${list.length - 3}</span>` : '');
    const cls = ['cal-cell', out ? 'out' : '', d === today ? 'today' : '', d === sel ? 'sel' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-action="cal-open" data-date="${d}" aria-label="${esc(`${longDay(d)}${list.length ? `, ${list.length} event${list.length === 1 ? '' : 's'}` : ''}`)}"><span class="cal-num">${+d.slice(8)}</span><span class="cal-dots">${dots(d)}</span><span class="cal-chips">${chips}</span></button>`;
  }).join('');
  return `<div class="cal-pane"><div class="cal-dow">${DOW.map((x) => `<span><span class="s">${x[0]}</span><span class="l">${x}</span></span>`).join('')}</div><div class="cal-grid">${cells}</div></div>`;
}

function monthHtml(c) {
  const today = localToday();
  const first = firstOf(c.date);
  return track('main', [addMonths(first, -1), first, addMonths(first, 1)].map((f) => monthPane(f, today, c.date)));
}

function labelOf(c) {
  if (c.view === 'month' || c.view === 'day' || cols() === 3) return monthYear(c.date);
  const s = monday(c.date);
  const e = addDays(s, 6);
  return s.slice(0, 7) === e.slice(0, 7)
    ? `${+s.slice(8)} to ${fmtDay(e, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : `${fmtDay(s, { day: 'numeric', month: 'short' })} to ${fmtDay(e, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// "October 2026": the month bold, the year quiet. A week range stays as it is.
function labelHtml(text) {
  const m = /^(\S+) (\d{4})$/.exec(text);
  return m ? `${esc(m[1])} <span class="cal-year">${m[2]}</span>` : esc(text);
}

// ---------- Sync status ----------

// When the feeds last came in, and whether any failed: one quiet line under the bar, a sheet with each.
const STALE_MS = 45 * 60000;
function syncState(c) {
  const feeds = c.feeds || [];
  if (!feeds.length) return null;
  const failed = feeds.filter((f) => f.lastError);
  const times = feeds.map((f) => (f.lastSync ? Date.parse(f.lastSync) : 0));
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const tone = c.syncing ? 'busy' : failed.length ? 'bad' : !oldest || Date.now() - oldest > STALE_MS ? 'stale' : 'ok';
  return { feeds, failed, newest, tone };
}

function syncHtml(c) {
  const s = syncState(c);
  if (!s) return '';
  const when = c.syncing ? 'Syncing…' : s.newest ? `Synced ${ago(new Date(s.newest).toISOString())}` : 'Not synced yet';
  const extra = s.failed.length ? ` · ${s.failed.length} ${s.failed.length === 1 ? 'calendar' : 'calendars'} failed` : ` · ${s.feeds.length} ${s.feeds.length === 1 ? 'calendar' : 'calendars'}`;
  return `<button type="button" class="cal-sync ${s.tone}" data-action="cal-sync-open" aria-label="${esc(`${when}${extra}. Details`)}"><i aria-hidden="true"></i><span>${esc(when)}${esc(extra)}</span></button>`;
}

function syncSheet(c) {
  const s = syncState(c);
  const rows = (s?.feeds || []).map((f) => `<div class="cal-feed${f.lastError ? ' bad' : ''}"><i style="--c:${safeColor(f.color) || '#8a909c'}"></i>
    <span class="cal-feed-body"><b>${esc(f.name)}</b><small>${f.lastError ? esc(f.lastError) : f.lastSync ? `Synced ${esc(ago(f.lastSync))} · ${f.eventCount} ${f.eventCount === 1 ? 'event' : 'events'}` : 'Not synced yet'}</small></span></div>`).join('');
  return sheetWrap('Calendars', `<div class="cal-feeds">${rows || '<p class="note">No calendars connected.</p>'}</div>
    <p class="note">Oath checks every calendar every 15 minutes.</p>
    <div class="sheet-actions"><button type="button" class="btn primary" data-action="cal-sync-now"${c.syncing ? ' disabled' : ''}>${c.syncing ? 'Syncing…' : 'Sync now'}</button>
      <a class="btn tinted" href="#/health?section=calendars">Manage calendars</a></div>`);
}

async function loadFeeds() {
  const c = cal();
  try {
    c.feeds = (await api('GET', '/api/calendar/feeds')).feeds;
  } catch { /* the status line waits for the next visit */ }
}

async function syncNow() {
  const c = cal();
  if (c.syncing) return;
  c.syncing = true;
  ctx.render();
  const r = await act(() => api('POST', '/api/calendar/sync', {}));
  c.syncing = false;
  if (r) {
    c.feeds = r.feeds;
    const bad = r.feeds.filter((f) => f.lastError).length;
    toast(bad ? `${bad} ${bad === 1 ? 'calendar' : 'calendars'} could not be synced.` : 'Calendars synced.', Boolean(bad));
    await refetch();
  } else {
    ctx.render();
  }
}

function topHtml(c) {
  const today = localToday();
  const names = [['day', 'Day'], ['span', cols() === 7 ? 'Week' : '3 days'], ['month', 'Month']];
  const seg = `<div class="seg mini cal-seg" role="tablist" aria-label="View">${names.map(([v, name]) => `<button type="button" role="tab" data-action="cal-view" data-view="${v}"${c.view === v ? ' aria-selected="true"' : ''}>${name}</button>`).join('')}</div>`;
  return `<div class="cal-top"><div class="cal-bar">
      <h2 class="cal-label" aria-live="polite">${labelHtml(labelOf(c))}</h2>
      <div class="cal-nav">
        ${c.date === today ? '' : '<button type="button" class="btn tinted small cal-today" data-action="cal-today">Today</button>'}
        <button type="button" class="icon-btn cal-step" data-action="cal-prev" aria-label="Previous">${icon('back')}</button>
        <button type="button" class="icon-btn cal-step" data-action="cal-next" aria-label="Next">${icon('chevron')}</button>
      </div>${seg}</div>
    ${syncHtml(c)}
    ${c.view === 'month' || (c.view === 'span' && cols() === 7) ? '' : stripHtml(c)}</div>`;
}

// ---------- The page ----------

export function viewCalendar() {
  const c = cal();
  if (!c.date) c.date = localToday();
  const head = pageHead('Calendar', {
    over: esc(longDay(localToday())),
    actions: `<button type="button" class="icon-btn" data-action="cal-sub" aria-label="Show in Apple Calendar" title="Show in Apple Calendar">${icon('phone')}</button>
      <button type="button" class="icon-btn accent" data-action="cal-new" aria-label="New event" title="New event">${icon('plus')}</button>`,
  });
  const body = c.view === 'month' ? monthHtml(c) : gridHtml(c);
  ctx.shell(`${head}<div class="cal v-${c.view}">${topHtml(c)}<div class="cal-frame">${body}</div></div>${sheetHtml(c)}`);
  afterRender(c);
}

// Centre the tracks, stick the headings under the bar, and open at the time of day on first view.
function afterRender(c) {
  const bar = $app.querySelector('.cal-top');
  const topbar = $app.querySelector('.topbar');
  if (bar) $app.querySelector('.page')?.style.setProperty('--cal-stick', `${(topbar?.offsetHeight || 0) + bar.offsetHeight}px`);
  if (c.ready && !c.scrolled && c.view !== 'month' && window.scrollY < 4) {
    c.scrolled = true;
    scrollToNow(c);
  }
}

function scrollToNow(c) {
  const colsEl = $app.querySelector('.cal-main .cal-slot:nth-child(2) .cal-cols');
  if (!colsEl) return;
  const rect = colsEl.getBoundingClientRect();
  const n = gridDays(c);
  const s = gridStart(c, c.date);
  const today = localToday();
  const showsToday = today >= s && today < addDays(s, n);
  const min = showsToday ? Math.max(0, minutesOf(localNowHM()) - 90) : 7 * 60 + 30;
  // Under the bar, and under the day headings of the multi-day grids.
  const stick = (parseFloat(getComputedStyle($app.querySelector('.page')).getPropertyValue('--cal-stick')) || 0) + (n > 1 ? HEAD_H : 0);
  window.scrollTo({ top: Math.max(0, rect.top + window.scrollY + (min / 1440) * rect.height - stick - 8) });
}

// The red line and its label creep down the day without a redraw.
setInterval(() => {
  if (state.route !== 'calendar') return;
  const min = minutesOf(localNowHM());
  $app.querySelectorAll('.cal-now').forEach((el) => { el.style.top = `${((min / 1440) * 100).toFixed(3)}%`; });
  $app.querySelectorAll('.cal-nowlbl').forEach((el) => { el.style.top = `${((min / 1440) * 100).toFixed(3)}%`; el.textContent = hm(min); });
}, 30000);

// ---------- Sheets ----------

function sheetWrap(title, body, cls = '') {
  return `<div class="sheet-backdrop" data-action="cal-close"></div>
  <div class="sheet cal-sheet ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-action="cal-close" aria-label="Close">${icon('close')}</button></div>
    ${body}
  </div>`;
}

function whenLine(e) {
  if (e.allDay) return e.end > e.start ? `${shortDay(e.start)} to ${shortDay(e.end)}` : longDay(e.start);
  const sd = e.start.slice(0, 10);
  const ed = e.end.slice(0, 10);
  return `${longDay(sd)}<br>${e.time} to ${ed === sd ? '' : `${shortDay(ed)} `}${e.endTime}`;
}

function eventSheet(s) {
  const e = findEvent(s.id);
  if (!e) return '';
  const feed = `<span class="cal-d-feed"${cVar(e.color)}><i></i>${esc(e.feed)}${e.deadline ? ', deadline' : ''}</span>`;
  const lines = [
    `<p class="cal-d-when">${whenLine(e)}</p>`,
    e.location ? `<p class="cal-d-row"><span>Where</span>${esc(e.location)}</p>` : '',
    e.notes ? `<p class="cal-d-row"><span>Notes</span><span class="cal-d-notes">${esc(e.notes)}</span></p>` : '',
    e.own && e.by === 'coach' ? '<p class="cal-d-row"><span>Added by</span>The coach</p>' : '',
    !e.own ? '<p class="note">From a subscribed calendar</p>' : '',
  ].join('');
  let actions = '';
  if (e.own && s.confirmDelete) {
    actions = `<div class="confirm-row"><span>Delete this event?</span><span class="confirm-btns"><button class="btn danger small" data-action="cal-del-yes">Delete</button><button class="btn tinted small" data-action="cal-del-no">Keep</button></span></div>`;
  } else if (e.own) {
    actions = `<div class="sheet-actions"><button class="btn tinted" data-action="cal-edit">Edit</button><button class="btn tinted danger-text" data-action="cal-del">${icon('trash')}Delete</button></div>`;
  }
  return sheetWrap('Event', `<div class="cal-d"><div class="cal-d-top">${feed}<h3 class="cal-d-title">${esc(e.title)}</h3></div>${lines}${actions}</div>`);
}

function markSheet(s) {
  const m = findMark(s.key);
  if (m) {
    const what = m.kind === 'habit' ? 'Habit' : 'Task';
    const due = m.time ? (m.midnight ? 'by midnight' : `by ${m.time}`) : 'today';
    const status = m.done ? (m.kind === 'habit' ? 'Kept' : 'Done') : 'Still open';
    return sheetWrap(what, `<div class="cal-d"><div class="cal-d-top"><span class="cal-d-feed mark ${m.kind}${m.hard ? ' hard' : ''}"><i></i>${what} due ${due}</span><h3 class="cal-d-title">${esc(m.title)}</h3></div>
      <p class="cal-d-when">${longDay(m.date)}</p><p class="cal-d-row"><span>Status</span>${status}</p>
      <div class="sheet-actions"><a class="btn tinted" href="#/${m.kind === 'habit' ? 'plan' : 'today'}">${icon('chevron')}Open ${m.kind === 'habit' ? 'Plan' : 'Today'}</a></div></div>`);
  }
  // A deadline from a feed: its event.
  const id = s.key.replace(/^e:/, '');
  return s.key.startsWith('e:') && findEvent(id) ? eventSheet({ id }) : '';
}

function nextHour() {
  const [h, m] = localNowHM().split(':').map(Number);
  return hm(Math.min(22 * 60, (h + (m > 0 ? 1 : 0)) * 60));
}

function formSheet(s) {
  const f = s.draft;
  return sheetWrap(s.id ? 'Edit event' : 'New event', `<form class="sheet-form cal-form" data-form="cal-event" data-id="${s.id ?? ''}">
    <label class="field"><span>Title</span><input class="input" name="title" value="${esc(f.title)}" required maxlength="200" autocomplete="off" enterkeyhint="done"></label>
    <label class="check"><input type="checkbox" name="all_day"${f.all_day ? ' checked' : ''}><span>All day</span></label>
    <div class="grid2">
      <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${f.date}" required></label>
      <label class="field allday-only"><span>Last day</span><input class="input" type="date" name="end_date" value="${f.end_date}"></label>
    </div>
    <div class="grid2 timed-only">
      <label class="field"><span>Starts</span><input class="input" type="time" name="start" value="${f.start}"></label>
      <label class="field"><span>Ends</span><input class="input" type="time" name="end" value="${f.end}"></label>
    </div>
    <div class="cal-durs timed-only" role="group" aria-label="Length">${[[30, '30 min'], [60, '1 h'], [90, '1.5 h'], [120, '2 h']].map(([m, t]) => `<button type="button" class="btn tinted small" data-action="cal-dur" data-min="${m}">${t}</button>`).join('')}</div>
    <label class="field"><span>Location</span><input class="input" name="location" value="${esc(f.location)}" maxlength="200" autocomplete="off"></label>
    <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="3" maxlength="1000">${esc(f.notes)}</textarea></label>
    <div class="form-actions"><button class="btn chrome" type="submit">Save</button><button class="btn tinted" type="button" data-action="cal-close">Cancel</button></div>
  </form>`);
}

function subSheet(s) {
  const info = s.info;
  let body;
  if (!info) body = '<p class="muted">Loading</p>';
  else if (!info.on) {
    body = `<div class="sheet-actions"><button class="btn primary" data-action="cal-sub-make"${s.busy ? ' disabled' : ''}>${icon('calendar')}Turn on</button></div>`;
  } else {
    body = `<div class="sheet-actions"><a class="btn primary" href="${esc(info.webcal)}">${icon('calendar')}Subscribe in Apple Calendar</a></div>
      <label class="field"><span>Link</span><span class="copy-row"><input class="input mono" id="cal-sub-url" readonly value="${esc(info.url)}"><button type="button" class="btn tinted small" data-action="copy" data-target="cal-sub-url">Copy</button></span></label>
      <div class="sheet-actions"><button class="btn tinted danger-text" data-action="cal-sub-new"${s.busy ? ' disabled' : ''}>Make a new link</button></div>`;
  }
  return sheetWrap('Apple Calendar', `<div class="cal-sub">${body}</div>`);
}

function sheetHtml(c) {
  const s = state.calSheet;
  if (!s) return '';
  if (s.kind === 'event') return eventSheet(s);
  if (s.kind === 'mark') return markSheet(s);
  if (s.kind === 'form') return formSheet(s);
  if (s.kind === 'sub') return subSheet(s);
  if (s.kind === 'sync') return syncSheet(c);
  return '';
}

// ---------- Moving about ----------

function settle() {
  ctx.render();
  prefetch();
}

function stepDate(c, which, dir) {
  if (which === 'strip') return addDays(c.date, 7 * dir);
  if (c.view === 'month') {
    const next = addMonths(c.date, dir);
    const today = localToday();
    return next.slice(0, 7) === today.slice(0, 7) ? today : next;
  }
  return addDays(c.date, (c.view === 'span' ? cols() : 1) * dir);
}

const xOf = (el) => {
  try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; } catch { return 0; }
};

// Slide a track one pane (dir -1 or 1) or back to rest (0) on a spring, then redraw around the new
// middle pane. v is the finger's speed in px/ms.
function slide(which, dir, v = 0) {
  const c = cal();
  const pager = $app.querySelector(`.cal-pager[data-pager="${which}"]`);
  if (c.sliding) return;
  if (!pager) {
    if (dir) { c.date = stepDate(c, which, dir); settle(); }
    return;
  }
  const tr = pager.firstElementChild;
  const finish = () => {
    c.sliding = false;
    if (dir) {
      c.date = stepDate(c, which, dir);
      settle();
    } else {
      tr.getAnimations().forEach((x) => x.cancel());
      tr.style.transform = '';
    }
  };
  if (reduced()) { finish(); return; }
  const w = pager.clientWidth;
  const from = xOf(tr);
  const to = -dir * w;
  c.sliding = true;
  const sp = spring(1, 0.34, Math.abs(to - from) > 1 ? (v * 1000) / (to - from) : 0);
  const a = tr.animate([{ transform: `translate3d(${from}px,0,0)` }, { transform: `translate3d(${to}px,0,0)` }], { ...sp, fill: 'forwards' });
  a.finished.then(finish, finish);
}

// Dragging a track with a finger or the mouse. Vertical movement is the page's (touch-action: pan-y).
let drag = null;

function onDown(e) {
  const pager = e.target.closest?.('.cal-pager');
  if (!pager || state.calSheet || cal().sliding || (e.pointerType === 'mouse' && e.button !== 0)) return;
  drag = { pager, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, locked: false, trail: [[performance.now(), 0]] };
}

function onMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  if (!drag.locked) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dy) >= Math.abs(dx)) { drag = null; return; }
    drag.locked = true;
    drag.pager.classList.add('dragging');
    try { drag.pager.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
  }
  drag.dx = dx;
  drag.pager.firstElementChild.style.transform = `translate3d(${dx}px,0,0)`;
  const now = performance.now();
  drag.trail.push([now, dx]);
  while (drag.trail.length > 2 && now - drag.trail[0][0] > 120) drag.trail.shift();
}

function onUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  d.pager.classList.remove('dragging');
  if (!d.locked) return;
  // The click that follows a drag is not a tap on whatever was under the finger.
  const swallow = (ev) => ev.stopPropagation();
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.removeEventListener('click', swallow, true), 120);
  const first = d.trail[0];
  const last = d.trail[d.trail.length - 1];
  const v = last[0] - first[0] > 8 && performance.now() - last[0] < 90 ? (last[1] - first[1]) / (last[0] - first[0]) : 0;
  const w = d.pager.clientWidth || 1;
  const reach = d.dx + v * 220;
  const dir = reach < -w * 0.3 ? 1 : reach > w * 0.3 ? -1 : 0;
  slide(d.pager.dataset.pager, dir, v);
}

function onCancel(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  d.pager.classList.remove('dragging');
  if (d.locked) slide(d.pager.dataset.pager, 0, 0);
}

// ---------- Actions ----------

const fx = (name) => document.dispatchEvent(new CustomEvent('oath:fx', { detail: name }));

function openForm(e) {
  const c = cal();
  const today = localToday();
  const date = e ? e.start.slice(0, 10) : c.date;
  const start = e && !e.allDay ? e.time : date === today ? nextHour() : '09:00';
  const end = e && !e.allDay ? e.endTime : hm(Math.min(1439, minutesOf(start) + 60));
  state.calSheet = {
    kind: 'form', id: e ? e.ownId : null,
    draft: {
      title: e?.title || '', date, end_date: e?.allDay ? e.end : date, all_day: Boolean(e?.allDay),
      start, end, location: e?.location || '', notes: e?.notes || '',
    },
  };
  ctx.render();
  if (!e) document.querySelector('.cal-form [name="title"]')?.focus({ preventScroll: true });
}

function closeSheet() {
  state.calSheet = null;
  ctx.render();
}

async function openSub() {
  state.calSheet = { kind: 'sub', info: null, busy: false };
  ctx.render();
  const info = await act(() => api('GET', '/api/calendar/subscription'));
  if (state.calSheet?.kind !== 'sub') return;
  if (info) state.calSheet.info = info;
  else state.calSheet = null;
  ctx.render();
}

async function makeSub(rotate) {
  const s = state.calSheet;
  if (rotate && !await confirmSheet('Make a new link?', 'The old one stops working.', 'Make new link')) return;
  s.busy = true;
  ctx.render();
  const info = await act(() => api('POST', '/api/calendar/subscription', { rotate }), rotate ? 'New link made.' : null);
  if (state.calSheet !== s) return;
  s.busy = false;
  if (info) s.info = info;
  ctx.render();
}

// What changed: forget what was fetched, load the window again, and draw.
async function refetch() {
  const c = cal();
  c.chunks.clear();
  try { await ensure(...windowOf(c, 0), { fresh: true }); } catch (err) { toast(err.message, true); }
  ctx.render();
  prefetch();
}

function setView(v) {
  const c = cal();
  if (!VIEWS.includes(v) || v === c.view) return;
  c.view = v;
  saveView(v);
  c.scrolled = false;
  window.scrollTo({ top: 0 });
  ensure(...windowOf(c, 0)).then((n) => { if (n && state.route === 'calendar' && !state.calSheet) ctx.render(); }).catch(() => {});
  ctx.render();
  prefetch();
}

export async function calendarClick(a, el) {
  const c = cal();
  switch (a) {
    case 'cal-view':
      setView(el.dataset.view);
      return true;
    case 'cal-today':
      c.date = localToday();
      c.scrolled = false;
      settle();
      return true;
    case 'cal-prev':
    case 'cal-next':
      slide('main', a === 'cal-next' ? 1 : -1);
      return true;
    case 'cal-pick':
      if (validDate(el.dataset.date)) { c.date = el.dataset.date; settle(); }
      return true;
    case 'cal-open':
      if (validDate(el.dataset.date)) {
        c.date = el.dataset.date;
        c.view = 'day';
        saveView('day');
        c.scrolled = false;
        window.scrollTo({ top: 0 });
        settle();
      }
      return true;
    case 'cal-event':
      state.calSheet = { kind: 'event', id: el.dataset.id };
      ctx.render();
      return true;
    case 'cal-mark':
      state.calSheet = { kind: 'mark', key: el.dataset.key };
      ctx.render();
      return true;
    case 'cal-new':
      openForm(null);
      return true;
    case 'cal-edit': {
      const e = findEvent(state.calSheet?.id);
      if (e?.own) openForm(e);
      return true;
    }
    case 'cal-del':
      if (state.calSheet?.kind === 'event') { state.calSheet.confirmDelete = true; ctx.render(); }
      return true;
    case 'cal-del-no':
      if (state.calSheet) { state.calSheet.confirmDelete = false; ctx.render(); }
      return true;
    case 'cal-del-yes': {
      const e = findEvent(state.calSheet?.id);
      if (!e?.own) return true;
      el.disabled = true;
      if (await act(() => api('DELETE', `/api/calendar/events/${e.ownId}`), 'Event deleted.')) {
        haptic();
        state.calSheet = null;
        await refetch();
      } else el.disabled = false;
      return true;
    }
    case 'cal-dur': {
      const form = el.closest('form');
      const start = form?.elements.start.value;
      if (/^\d\d:\d\d$/.test(start || '')) form.elements.end.value = hm(Math.min(1439, minutesOf(start) + Number(el.dataset.min)));
      else toast('Set the start first.', true);
      return true;
    }
    case 'cal-close':
      closeSheet();
      return true;
    case 'cal-sub':
      await openSub();
      return true;
    case 'cal-sync-open':
      state.calSheet = { kind: 'sync' };
      ctx.render();
      return true;
    case 'cal-sync-now':
      await syncNow();
      return true;
    case 'cal-sub-make':
      await makeSub(false);
      return true;
    case 'cal-sub-new':
      await makeSub(true);
      return true;
    default:
      return false;
  }
}

export async function calendarSubmit(kind, form) {
  if (kind !== 'cal-event') return false;
  const f = form2obj(form);
  const allDay = f.all_day === 'on';
  if (!allDay && !f.start) { toast('Set a start time, or tick All day.', true); return true; }
  const body = { title: f.title, date: f.date, all_day: allDay, location: f.location || '', notes: f.notes || '' };
  if (allDay) body.end_date = f.end_date && f.end_date >= f.date ? f.end_date : f.date;
  else { body.start = f.start; if (f.end) body.end = f.end; }
  const id = form.dataset.id;
  const r = await act(() => (id ? api('PATCH', `/api/calendar/events/${id}`, body) : api('POST', '/api/calendar/events', body)));
  if (!r) return true;
  haptic();
  fx('success');
  toast(id ? 'Event saved.' : 'Event added.');
  state.calSheet = null;
  cal().date = r.event.start.slice(0, 10);
  await refetch();
  return true;
}

// ---------- Loading and wiring ----------

export async function loadCalendar() {
  const c = cal();
  const q = state.query;
  const asked = q?.toString() || '';
  if (asked !== c.lastQuery) {
    c.lastQuery = asked;
    const d = q?.get('d');
    if (validDate(d)) c.date = d;
    const v = q?.get('v') === 'week' ? 'span' : q?.get('v');
    if (VIEWS.includes(v)) c.view = v;
  }
  if (!c.date) c.date = localToday();
  await Promise.all([ensure(...windowOf(c, 0), { fresh: true }), loadFeeds()]);
  c.ready = true;
  prefetch();
}

export function initCalendar(c) {
  ctx = c;
  // Coming into the page from elsewhere starts on today, and opens at the time of day.
  let prev = location.hash;
  const routeOf = (h) => h.replace(/^#\/?/, '').split(/[/?]/)[0];
  window.addEventListener('hashchange', () => {
    if (routeOf(location.hash) === 'calendar' && routeOf(prev) !== 'calendar') {
      const s = cal();
      s.date = localToday();
      s.scrolled = false;
      s.ready = false;
      s.lastQuery = null;
    }
    prev = location.hash;
  });
  // A tablet turned between portrait and landscape changes how many days the grid holds.
  MQ_WEEK.addEventListener('change', () => { if (state.route === 'calendar' && !state.calSheet && !document.querySelector('.gate')) ctx.render(); });
  $app.addEventListener('pointerdown', onDown);
  $app.addEventListener('pointermove', onMove);
  $app.addEventListener('pointerup', onUp);
  $app.addEventListener('pointercancel', onCancel);
  document.addEventListener('keydown', (e) => {
    if (state.route !== 'calendar' || state.calSheet || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowLeft') slide('main', -1);
    else if (e.key === 'ArrowRight') slide('main', 1);
    else if (e.key === 't') calendarClick('cal-today', document.body);
  });
}
