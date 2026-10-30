// What the Calendar shows (calendar.js): the day and multi-day grids with their events and deadline
// flags, the week strip, the month, the chosen day under it on a phone, and the bar on top with the
// sync status. Plain strings from the page's state and its days (calendar-days.js).
import { safeColor, esc, icon, addDays, localToday, localNowHM, fmtDay, ago, state, miniRing } from './ui.js';
import {
  hm, evSpan, minutesOf, lanes, dayInfo, longDay, DOW, weekdayOf, gridDays, gridStart, monday, firstOf, addMonths, cols,
  monthYear,
} from './calendar-days.js';

const colorOf = (e) => safeColor(e.color);
export const cVar = (color) => (safeColor(color) ? ` style="--c:${safeColor(color)}"` : '');

// n is how many days the grid shows: side by side in a narrow column, a title is cut short, not broken.
function eventBlock(it, n) {
  const e = it.ev;
  const mins = it.e - it.s;
  const lane = n > 1 && it.cols > 1;
  const cls = ['cal-ev', e.own ? 'own' : '', e.done ? 'done' : '', e.busy === false ? 'free' : '', mins < 50 ? 'short' : '', mins < 28 ? 'tiny' : '', lane ? 'lane' : '', n > 1 && it.cols > 2 ? 'dense' : ''].filter(Boolean).join(' ');
  const sub = `${e.time} to ${e.endTime}`;
  const place = e.location ? `<span class="cal-ev-p">${esc(e.location)}</span>` : '';
  const style = `top:${((it.s / 1440) * 100).toFixed(3)}%;height:${((mins / 1440) * 100).toFixed(3)}%;left:calc(${((it.col / it.cols) * 100).toFixed(3)}% + 1px);width:calc(${((it.span / it.cols) * 100).toFixed(3)}% - 3px)${colorOf(e) ? `;--c:${colorOf(e)}` : ''}`;
  return `<button type="button" class="${cls}" style="${style}" data-action="cal-event" data-id="${esc(e.id)}" aria-label="${esc(`${e.title}, ${sub}${e.location ? `, ${e.location}` : ''}${e.done ? ', done' : ''}`)}"><span class="cal-ev-t">${e.done ? icon('check', 'done-ic') : ''}${esc(e.title)}</span><span class="cal-ev-s">${sub}</span>${place}</button>`;
}

// A deadline: a thin line across the column at its time, with a small flag above it.
function markHtml(mk, stack, wide) {
  const top = (mk.min / 1440) * 100;
  const label = esc(mk.title);
  const cls = ['cal-mk', mk.kind || 'vle', mk.done ? 'done' : '', mk.hard ? 'hard' : '', mk.min < 30 ? 'low' : ''].filter(Boolean).join(' ');
  const time = mk.min >= 1440 ? 'midnight' : hm(mk.min);
  // One that is already kept or done shrinks to its mark, so it does not cover the day's events.
  const named = wide && !mk.done;
  return `<div class="${cls}" style="top:${top.toFixed(3)}%;--k:${stack}${safeColor(mk.color) ? `;--c:${safeColor(mk.color)}` : ''}"><button type="button" class="cal-mk-chip${named ? '' : ' bare'}" data-action="cal-mark" data-key="${esc(mk.key)}" aria-label="${label}, due ${time}${mk.done ? ', done' : ''}"><i></i>${named ? `<span>${label}</span><small class="cal-mk-due">${mk.min >= 1440 ? 'By midnight' : `Due ${time}`}</small>` : ''}</button></div>`;
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
      return `<button type="button" class="cal-chip${e.own ? ' own' : ''}${e.done ? ' done' : ''}${e.deadline ? ' flag' : ''}"${cVar(e.color)} data-action="cal-event" data-id="${esc(e.id)}">${e.done ? icon('check', 'done-ic') : ''}${esc(e.title)}</button>`;
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
  const rail = showNow ? `<i class="cal-rail" style="height:${((nowMin / 1440) * 100).toFixed(3)}%"></i>` : '';
  return `<div class="cal-pane">${heads}${allDay}<div class="cal-body" style="--n:${n}">
    <div class="cal-hours" aria-hidden="true">${rail}${hourLabels()}${nowLabel}</div>
    <div class="cal-cols${n > 1 ? ' multi' : ''}">${days.map((d, i) => columnHtml(d, infos[i], n, today, nowMin)).join('')}</div></div></div>`;
}

// Three panes in a track: before, this one, after. Only the middle one is read by a screen reader.
function track(which, panes) {
  return `<div class="cal-pager cal-${which}" data-pager="${which}"><div class="cal-track">${panes.map((p, i) => `<div class="cal-slot"${i === 1 ? '' : ' aria-hidden="true" inert'}>${p}</div>`).join('')}</div></div>`;
}

export function gridHtml(c) {
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

export function monthHtml(c) {
  const today = localToday();
  const first = firstOf(c.date);
  return track('main', [addMonths(first, -1), first, addMonths(first, 1)].map((f) => monthPane(f, today, c.date)));
}

// Under the month on a phone, the chosen day in full: its all-day events, then its events and the habits
// and tasks due that day in time order, each a tap away from its sheet. Wider screens show them in the
// month's cells instead (calendar.css).
export function monthDayHtml(c) {
  const d = c.date;
  const info = dayInfo(d);
  const row = ({ time, title, sub, color, cls, action, attr, done }) => `<li><button type="button" class="cal-ag-row ${cls}${done ? ' done' : ''}" data-action="${action}" ${attr}${safeColor(color) ? ` style="--c:${safeColor(color)}"` : ''}>
      <span class="cal-ag-time">${esc(time)}</span><i class="cal-ag-bar" aria-hidden="true"></i>
      <span class="cal-ag-body"><b>${done ? icon('check', 'done-ic') : ''}${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></button></li>`;
  const allDay = info.allDay.map((x) => (x.ev
    ? row({ time: 'All day', title: x.ev.title, sub: x.ev.feed || '', color: x.ev.own ? '' : x.ev.color, cls: x.ev.own ? 'own' : '', action: 'cal-event', attr: `data-id="${esc(x.ev.id)}"`, done: x.ev.done })
    : row({ time: 'Due', title: x.m.title, sub: x.m.kind === 'habit' ? 'Habit' : 'Task', cls: 'due', action: 'cal-mark', attr: `data-key="${esc(`${x.m.kind}:${x.m.id}:${x.m.date}`)}"`, done: x.m.done })));
  const timed = [
    ...info.timed.map((e) => ({
      min: e.start.slice(0, 10) < d ? 0 : minutesOf(e.time),
      html: row({
        time: e.start.slice(0, 10) < d ? 'Cont.' : e.time, title: e.title,
        sub: [e.endTime && e.endTime !== e.time ? `until ${e.endTime}` : '', e.location, e.own ? '' : e.feed].filter(Boolean).join(', '),
        color: e.own ? '' : e.color, cls: e.own ? 'own' : '', action: 'cal-event', attr: `data-id="${esc(e.id)}"`, done: e.done,
      }),
    })),
    ...info.marks.map((mk) => ({
      min: mk.min,
      html: mk.ev
        ? row({ time: mk.ev.time, title: mk.title, sub: 'Deadline', cls: 'deadline', action: 'cal-event', attr: `data-id="${esc(mk.ev.id)}"`, done: mk.done })
        : row({ time: mk.min >= 1440 ? '00:00' : hm(mk.min), title: mk.title, sub: `${mk.kind === 'habit' ? 'Habit' : 'Task'} due${mk.hard ? ', hard' : ''}`, cls: 'due', action: 'cal-mark', attr: `data-key="${esc(mk.key)}"`, done: mk.done }),
    })),
  ].sort((a, b) => a.min - b.min).map((x) => x.html);
  const list = [...allDay, ...timed];
  return `<section class="cal-agenda" aria-label="${esc(longDay(d))}">
    <div class="cal-ag-head"><h3>${esc(longDay(d))}</h3><button type="button" class="cal-ag-open" data-action="cal-open" data-date="${d}">Open day${icon('chevron')}</button></div>
    ${list.length ? `<ol class="cal-ag-list">${list.join('')}</ol>` : '<p class="cal-ag-empty">Nothing on this day.</p>'}
  </section>`;
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
export function syncState(c) {
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

// Past the last day the feeds are read up to only Oath's own events show, so a quiet line says why it is empty.
function horizonHtml(c) {
  if (!c.syncedTo || !c.feeds?.length) return '';
  const last = c.view === 'month' ? addDays(addMonths(firstOf(c.date), 1), -1) : addDays(gridStart(c, c.date), gridDays(c) - 1);
  if (last <= c.syncedTo) return '';
  return `<p class="cal-horizon">Your calendars are synced up to ${esc(fmtDay(c.syncedTo, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}.</p>`;
}

// How much of what is due today is done, as a ring with the share in it, when Today has been loaded.
function dayRing() {
  const p = state.today?.progress;
  if (!p?.total) return '';
  const pct = Math.round((p.done / p.total) * 100);
  return `<a class="cal-ring${p.done >= p.total ? ' done' : ''}" href="#/today" aria-label="${p.done} of ${p.total} due today done">${miniRing(pct, 38)}<b>${pct}</b></a>`;
}

export function topHtml(c) {
  const today = localToday();
  const names = [['day', 'Day'], ['span', cols() === 7 ? 'Week' : '3 days'], ['month', 'Month']];
  const seg = `<div class="seg mini cal-seg" role="tablist" aria-label="View">${names.map(([v, name]) => `<button type="button" role="tab" data-action="cal-view" data-view="${v}"${c.view === v ? ' aria-selected="true"' : ''}>${name}</button>`).join('')}</div>`;
  return `<div class="cal-top"><div class="cal-bar">
      <h2 class="cal-label" aria-live="polite">${labelHtml(labelOf(c))}</h2>
      <div class="cal-nav">
        ${c.date === today ? '' : '<button type="button" class="btn tinted small cal-today" data-action="cal-today">Today</button>'}
        <button type="button" class="icon-btn cal-step" data-action="cal-prev" aria-label="Previous">${icon('back')}</button>
        <button type="button" class="icon-btn cal-step" data-action="cal-next" aria-label="Next">${icon('chevron')}</button>
        ${dayRing()}
      </div>${seg}</div>
    ${syncHtml(c)}${horizonHtml(c)}
    ${c.view === 'month' || (c.view === 'span' && cols() === 7) ? '' : stripHtml(c)}</div>`;
}
