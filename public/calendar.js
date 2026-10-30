// The Calendar page: a day grid, a 3 day (phone) or week (wide) grid and a month, all read from
// /api/calendar. Oath's own events are added, changed and deleted in a sheet; events from the feeds
// are read-only. Plain strings like the other pages: the app redraws #app, this module only decides
// what goes in it. Swipes are a transform on a three-pane track (the pane before, this one, the pane
// after), so a swipe is a spring on the compositor and the redraw after it is invisible. Its days are in
// calendar-days.js, what it draws in calendar-draw.js and its sheets in calendar-sheets.js; this module
// keeps the page, the swipes, the taps and the loading.
import {
  $app, state, esc, api, act, toast, icon, pageHead, localToday, localNowHM, haptic, form2obj, reduced, addDays,
  confirmSheet, canRedraw,
} from './ui.js';
import { spring } from './motion.js';
import {
  VIEWS, MQ_WEEK, addMonths, minutesOf, hm, validDate, longDay, saveView, cal, cols, gridDays, gridStart, ensure,
  windowOf, findEvent,
} from './calendar-days.js';
import { gridHtml, monthHtml, monthDayHtml, topHtml } from './calendar-draw.js';
import { sheetHtml } from './calendar-sheets.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };

const HEAD_H = 56; // px, the day headings of the 3 day and week grids

// ---------- Fetching and syncing ----------

const prefetch = () => {
  const c = cal();
  ensure(...windowOf(c, 2)).then((n) => {
    if (n && state.route === 'calendar' && !state.calSheet && !c.sliding) ctx.render();
  }).catch(() => {});
};

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
  const agenda = c.view === 'month' && !MQ_WEEK.matches ? monthDayHtml(c) : '';
  ctx.shell(`${head}<div class="cal v-${c.view}">${topHtml(c)}<div class="cal-frame">${body}</div>${agenda}</div>${sheetHtml(c)}`);
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

// Left on today, the page follows the day when it turns: past midnight, or back from the background.
function followToday(c) {
  const today = localToday();
  if (c.today && c.today !== today && c.date === c.today) {
    c.date = today;
    c.scrolled = false;
  }
  c.today = today;
}

// The red line and its label creep down the day without a redraw; at midnight the page redraws for the new day.
setInterval(() => {
  if (state.route !== 'calendar') return;
  const c = cal();
  if (c.today && c.today !== localToday() && !c.sliding && canRedraw()) {
    followToday(c);
    ensure(...windowOf(c, 0)).then(() => { if (state.route === 'calendar' && canRedraw()) ctx.render(); }).catch(() => {});
    return;
  }
  const min = minutesOf(localNowHM());
  $app.querySelectorAll('.cal-now').forEach((el) => { el.style.top = `${((min / 1440) * 100).toFixed(3)}%`; });
  $app.querySelectorAll('.cal-nowlbl').forEach((el) => { el.style.top = `${((min / 1440) * 100).toFixed(3)}%`; el.textContent = hm(min); });
}, 30000);

// The next full hour, at the latest 23:00 so a new event still starts today.
function nextHour() {
  const [h, m] = localNowHM().split(':').map(Number);
  return hm(Math.min(23 * 60, (h + (m > 0 ? 1 : 0)) * 60));
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
  // hm wraps past midnight, and an end before the start is the next day (the server reads it so too).
  const end = e && !e.allDay ? e.endTime : hm(minutesOf(start) + 60);
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
      // On a phone the month picks a day first and lists it underneath; the chosen day, tapped again,
      // opens it.
      if (validDate(el.dataset.date) && c.view === 'month' && !MQ_WEEK.matches && el.classList.contains('cal-cell') && el.dataset.date !== c.date) {
        c.date = el.dataset.date;
        haptic('toggle');
        settle();
        return true;
      }
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
    case 'cal-mark': {
      // A VLE deadline's flag opens its event, where Mark done can find it.
      const key = el.dataset.key || '';
      state.calSheet = key.startsWith('e:') ? { kind: 'event', id: key.slice(2) } : { kind: 'mark', key };
      ctx.render();
      return true;
    }
    case 'cal-new':
      openForm(null);
      return true;
    case 'cal-edit': {
      const e = findEvent(state.calSheet?.id);
      if (e?.own) openForm(e);
      return true;
    }
    case 'cal-done': {
      const e = findEvent(state.calSheet?.id);
      if (!e) return true;
      el.disabled = true;
      const r = await act(() => api('POST', `/api/calendar/events/${encodeURIComponent(e.id)}/done`, { done: !e.done }));
      if (r?.event) {
        haptic();
        e.done = r.event.done;
        state.today = null;
        ctx.render();
      } else el.disabled = false;
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
      if (/^\d\d:\d\d$/.test(start || '')) form.elements.end.value = hm(minutesOf(start) + Number(el.dataset.min));
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
  const id = form.dataset.id;
  const was = state.calSheet?.kind === 'form' ? state.calSheet.draft : null;
  // An all-day event moved with its last day left alone keeps its length: the server shifts the last day.
  const keepSpan = id && allDay && was?.all_day && f.end_date === was.end_date && f.date !== was.date;
  if (allDay && !keepSpan) body.end_date = f.end_date && f.end_date >= f.date ? f.end_date : f.date;
  else if (!allDay) { body.start = f.start; if (f.end) body.end = f.end; }
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
  followToday(c);
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
