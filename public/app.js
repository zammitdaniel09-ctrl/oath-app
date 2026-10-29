// Oath web app. Plain modules, no build step.
import {
  $app, state, hooks, esc, api, toast, fmtDay, left, fmtMin, isIOS, localToday, localNowHM, icon, drawRings, pageHead,
  rememberKey, urgency, URGENCY, brandMark, canRedraw, redrawIfIdle, reportProblem, TEXT_FIELDS,
} from './ui.js';
import * as motion from './motion.js';
import { parseCapture } from './parse.js';
import { initGoals, loadGoals, loadGoal, viewGoals, viewGoalNew, viewGoal, goalsClick, goalsSubmit } from './goals.js';
import { initData, loadHealth, viewHealth, dataClick, dataSubmit } from './data.js';
import { initFood, loadFood, viewFood, loadFoodToday, flushFood } from './food.js';
import { foodClick, foodSubmit } from './food-actions.js';
import { initMail, loadMail, viewMail, mailClick, mailSubmit, mailChange } from './mail.js';
import { initToday } from './today.js';
import { initCalendar, loadCalendar, viewCalendar, calendarClick, calendarSubmit } from './calendar.js';
import { initPlan, planClick, habitForm, taskForm, viewPlan, planSubmit } from './plan.js';
import { initCoachMedia, stagePhotos, recording, draft as coachDraft, syncComposer, leaveChat } from './coach-media.js';
import {
  initTodayList, oathView, dodgeForm, dodgeItem, resetDock, viewToday, clockText, todayClick, todaySubmit,
} from './today-list.js';
import {
  initCoach, coachMessage, TYPING, BRIEFS, viewCoach, coachShow, sendCoach, coachClick, coachSubmit,
} from './coach.js';
import { initReview, viewReview, reviewClick, reviewSubmit } from './review.js';
import { initSettings, viewSettings, settingsClick, settingsSubmit } from './settings.js';
import {
  initLock, brandLockup, door, lockEl, setLock, showLock, lockApp, abortFaceId, renderLogin, rememberLockMode, rememberPasswordAlone,
  lockModeRemembered, renderSetup, lockClick, lockSubmit,
} from './lock.js';
import { refreshPushState, resyncPush } from './push.js';
import { initUpdate, checkBuild, resumeFresh, watchForUpdates } from './update.js';
import { followTheme } from './theme.js';

// This copy of the app. sw.js carries the same name, and test/syntax.test.js keeps the two in step.
const BUILD = 'oath-v39';

// ---------- Shell ----------

// Five tabs on the phone with Food raised in the middle; Goals and Health join them in the sidebar.
// On the phone Goals is a segment of Plan, and Health an icon in Today's header.
const TABS = [
  ['today', 'Today', 'today'],
  ['plan', 'Plan', 'plan'],
  ['goals', 'Goals', 'goals', 'wide'],
  ['food', 'Food', 'food', 'centre'],
  ['calendar', 'Calendar', 'calendar'],
  ['health', 'Health', 'heart', 'wide'],
  ['coach', 'Coach', 'coach'],
];
const WIDE_EXTRA = [['mail', 'Mail', 'mail'], ['review', 'Review', 'review'], ['settings', 'Settings', 'settings']];
const ROUTES = ['today', 'calendar', 'plan', 'food', 'goals', 'health', 'coach', 'review', 'settings', 'mail'];

function shell(inner) {
  // One selected destination: on the phone Health, Mail and Review sit under Today and Goals under
  // Plan; the sidebar has its own rows.
  const wide = window.matchMedia('(min-width: 900px)').matches;
  const under = { review: 'today', health: 'today', mail: 'today', goals: 'plan' };
  const active = !wide && under[state.route] ? under[state.route] : state.route;
  // The Today tab carries a count of what is still open, so the next tick is never out of mind.
  const open = state.today?.progress?.open || 0;
  const badge = (id) => (id === 'today' && open ? `<b class="tab-badge"><span class="sr">, </span>${open}<span class="sr"> open</span></b>` : '');
  // The selected tab carries a pill, which slides over from the last one (motion.js). The raised Food
  // button is its own highlight on the phone, so its pill only shows in the sidebar.
  const link = ([id, label, ic, kind], extra = '') => {
    const on = active === id || (extra && state.route === id);
    const pill = on && (!extra || wide) ? '<span class="tab-pill" aria-hidden="true"></span>' : '';
    const cls = `tab${extra}${kind === 'centre' ? ' tab-centre' : ''}${kind === 'wide' ? ' wide-only' : ''}`;
    return `<a href="#/${id}" class="${cls}"${on ? ' aria-current="page"' : ''}><span class="tab-ic">${pill}${icon(ic)}${badge(id)}</span><span>${label}</span></a>`;
  };
  const nav = TABS.map((t) => link(t)).join('');
  const more = WIDE_EXTRA.map((t) => link(t, ' wide-only')).join('');
  const m = motion.beforeShell();
  // The compact bar the large title condenses into on scroll. Decorative: the h1 stays the heading.
  const topbar = `<div class="topbar${m.condensed ? ' on' : ''}" aria-hidden="true"><a class="topbar-back" tabindex="-1" hidden></a><button type="button" class="topbar-title" tabindex="-1"></button></div>`;
  $app.innerHTML = `${topbar}<main class="page page-${state.route}">${inner}</main>
    <nav class="tabbar" aria-label="Sections"><div class="tabbar-brand wide-only">${brandMark(30)}<span>Oath</span></div>${nav}${more}</nav>
    ${sheetHtml()}`;
  document.body.classList.toggle('sheet-open', Boolean(state.sheet || state.sheetNode || state.foodSheet || state.calSheet));
  drawRings();
  motion.afterShell(m);
}

function skeleton(title) {
  if (state.loadFailed === state.route) {
    return `${pageHead(title)}<div class="card load-failed"><p>${esc(state.loadFailedMsg || 'This did not load.')}</p>
      <button type="button" class="btn tinted" data-action="reload-route">Try again</button></div>`;
  }
  return `${pageHead(title)}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`;
}

initGoals({ shell, render: () => render(), go: () => go() });
initData({ shell, render: () => render(), go: () => go() });
initFood({ shell, render: () => render(), go: () => go() });
initMail({ shell, render: () => render() });
initToday({ render: () => render() });
initCalendar({ shell, render: () => render(), go: () => go() });
initCoachMedia({ render: () => render(), send: (x) => sendCoach(x), addMessage: (m) => coachShow(m) });
initTodayList({ shell, skeleton, load, fetchToday, render, refreshToday, refreshCurrent });
initPlan({ shell, skeleton, render, refreshCurrent, go });
initCoach({ shell, skeleton, render, fetchToday, load });
initReview({ shell, skeleton, refreshCurrent });
initSettings({ shell, skeleton, load, render, wipePhone, go });
initLock({ showCachedDay, parseHash, load, go, render });
initUpdate({ build: BUILD });

// ---------- Sheets: forms slide up from the bottom ----------

function sheetHtml() {
  const s = state.sheet;
  if (!s) return '';
  let title = '';
  let body = '';
  if (s.id && !state.plan) return '';
  if (s.kind === 'coach') {
    title = 'Coach';
    const said = `<div class="msg user"><span class="msg-text">${esc(s.text)}</span></div>`;
    body = `<div class="chat coach-sheet">${said}${s.reply ? coachMessage(s.reply) : TYPING}</div>
      <div class="form-actions"><a class="btn tinted" href="#/coach">${icon('coach')}Open the chat</a><button class="btn plain" type="button" data-action="sheet-dismiss">Close</button></div>`;
  } else if (s.kind === 'habit') {
    const h = s.id ? state.plan?.habits.find((x) => x.id === s.id) : null;
    title = h ? 'Edit habit' : 'New habit';
    body = habitForm(h);
  } else if (s.kind === 'task') {
    const k = s.id ? state.plan?.tasks.find((x) => x.id === s.id) : null;
    title = k ? 'Edit task' : 'New task';
    body = taskForm(k);
  } else if (s.kind === 'dodge') {
    const n = dodgeItem(s.ref);
    if (!n) return '';
    title = 'Not now?';
    body = `<div class="dodge-sheet"><p class="dodge-title">${esc(n.title)}</p>${dodgeForm(n)}</div>`;
  } else if (s.kind === 'oath') {
    if (!state.today) return '';
    title = 'Morning oath';
    body = oathView(state.today);
  } else if (s.kind === 'photo') {
    title = 'Photo';
    body = `<img class="cc-full" src="${esc(s.src)}" alt="The photo you sent">`;
  } else if (s.kind === 'briefs') {
    title = 'Briefs';
    body = `<div class="group">${BRIEFS.map(([kind, ic, label]) => `<button class="li li-plain li-nav" data-action="brief" data-kind="${kind}">
      <span class="li-ic">${icon(ic)}</span><span class="li-body"><span class="li-title">${label}</span></span>${icon('chevron', 'chev')}</button>`).join('')}</div>`;
  } else {
    return '';
  }
  return `<div class="sheet-backdrop" data-action="sheet-dismiss"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-action="sheet-dismiss" aria-label="Close">${icon('close')}</button></div>
    ${body}
  </div>`;
}

// ---------- Data loading and routing ----------

function setBadge() {
  const n = state.today?.openDue?.length || 0;
  try {
    if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch { /* not supported */ }
}

// The last Today the server sent is kept on the phone, so a launch without signal still shows the day.
const TODAY_CACHE = 'oath.today';
function cacheToday(t) {
  try { localStorage.setItem(TODAY_CACHE, JSON.stringify({ at: new Date().toISOString(), t })); } catch { /* storage unavailable */ }
}
function cachedToday() {
  try {
    const c = JSON.parse(localStorage.getItem(TODAY_CACHE) || 'null');
    return c?.t ? c : null;
  } catch {
    return null;
  }
}
// Logging out takes everything personal off the phone: the cached day, the food caches and the queue of
// entries waiting to sync. (Locking only clears memory, so the cached day can still show offline.)
function wipePhone() {
  try {
    Object.keys(localStorage).filter((k) => k === TODAY_CACHE || k.startsWith('oath.food')).forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
  rememberKey(null);
}

// No connection: the cached Today, read only, with the Offline banner. False when there is no cache.
function showCachedDay() {
  const c = cachedToday();
  if (!c) return false;
  abortFaceId();
  parseHash();
  state.route = 'today';
  state.today = c.t;
  state.offline = c.at;
  render();
  return true;
}

async function fetchToday() {
  try {
    state.today = await api('GET', '/api/today');
    state.offline = null;
    followTheme(state.today.settings?.theme);
    rememberPasswordAlone(state.today.settings?.passwordAlone === true);
    cacheToday(state.today);
  } catch (err) {
    const c = err.status === 0 ? cachedToday() : null;
    if (!c) throw err;
    state.today = c.t;
    state.offline = c.at;
  }
  setBadge();
}

async function load(route) {
  if (route === 'today') {
    await fetchToday();
    if (!state.offline) loadFoodToday();
  }
  if (route === 'food') await loadFood();
  if (route === 'mail') await loadMail();
  // Plan holds the goals too, as its third segment.
  if (route === 'plan') [state.plan] = await Promise.all([api('GET', '/api/plan'), loadGoals()]);
  if (route === 'coach') {
    // Coming back to the app mid-send keeps the chat as it is: a voice note being transcribed or a message
    // waiting for its reply exists only on this phone until the answer lands.
    if (state.coach && (state.sending || recording() || state.coach.messages.some((m) => !m.id && m.hearing))) return;
    state.coach = await api('GET', '/api/coach');
  }
  if (route === 'review') {
    // The season (HP over 30 days, the longest streaks) heads the review.
    const [r, season] = await Promise.all([api('GET', '/api/review'), api('GET', '/api/season').catch(() => null)]);
    state.review = r;
    state.season = season;
  }
  if (route === 'health') await loadHealth();
  if (route === 'calendar') await loadCalendar();
  if (route === 'goals') {
    if (state.param === 'new') return;
    if (state.param) await loadGoal(state.param);
    else await loadGoals();
  }
  if (route === 'settings') await loadSettings();
}

// Everything at once, and the page draws with whatever arrived: only the settings themselves are essential.
// The Face ID challenge is fetched alongside, but nothing waits for it.
async function loadSettings() {
  if (window.PublicKeyCredential) {
    api('POST', '/api/passkey/register/options', {}).then((options) => { state.faceIdRegister = { options, at: Date.now() }; }).catch(() => {});
  }
  const got = await Promise.allSettled([
    api('GET', '/api/settings'), api('GET', '/api/setup-status'), api('GET', '/api/passkeys'),
    api('GET', '/api/body'), api('GET', '/api/telegram'), api('GET', '/api/tokens'), refreshPushState(),
  ]);
  const [settings, setup, passkeys, body, telegram, tokens] = got;
  const lost = got.find((r) => r.status === 'rejected' && r.reason?.status === 401);
  if (lost) throw lost.reason;
  if (settings.status === 'rejected') throw settings.reason;
  state.settings = settings.value;
  followTheme(state.settings.theme);
  if (setup.status === 'fulfilled') state.setup = setup.value;
  if (passkeys.status === 'fulfilled') state.passkeys = passkeys.value.passkeys;
  if (body.status === 'fulfilled') state.body = body.value;
  if (telegram.status === 'fulfilled') state.telegram = { ...(state.telegram || {}), ...telegram.value };
  if (tokens.status === 'fulfilled') state.tokens = tokens.value;
}

function render() {
  state.dirty = false;
  state.stale = null;
  if (state.route === 'goals') {
    if (state.param === 'new') return viewGoalNew();
    if (state.param) return viewGoal();
    return viewGoals();
  }
  const views = { today: viewToday, calendar: viewCalendar, plan: viewPlan, food: viewFood, coach: viewCoach, review: viewReview, settings: viewSettings, health: viewHealth, mail: viewMail };
  (views[state.route] || viewToday)();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [route, param, param2] = (path || 'today').split('/');
  // The Dashboard became Health: old links and notifications land there, with their section.
  if (route === 'dashboard') history.replaceState(null, '', `#/health${qs ? `?${qs}` : ''}`);
  state.route = ROUTES.includes(route) ? route : route === 'ledger' ? 'review' : route === 'dashboard' ? 'health' : 'today';
  state.param = param || null;
  state.param2 = param2 ? decodeURIComponent(param2) : null;
  if (state.route !== 'food') state.foodSheet = null;
  if (state.route !== 'calendar') state.calSheet = null;
  state.query = new URLSearchParams(qs || '');
  if (state.route === 'plan' && ['habits', 'tasks', 'goals'].includes(state.query.get('tab'))) state.planTab = state.query.get('tab');
}

// top: a new screen starts at the top (scrolled inside the transition, so the old screen leaves from
// where it was). native: the browser already animated this step, as with a swipe back in Safari.
async function go({ top = false, native = false } = {}) {
  parseHash();
  if (state.route !== 'coach') leaveChat();
  motion.navigate(() => {
    if (top) window.scrollTo({ top: 0 });
    render();
  }, { native });
  try {
    await load(state.route);
    state.loadFailed = null;
    render();
  } catch (err) {
    if (err.status === 401) return;
    toast(err.message, true);
    // A first load that failed would leave the skeleton up for good: it becomes a Try again card.
    state.loadFailed = state.route;
    state.loadFailedMsg = err.status === 0 ? 'No connection. Try again when you are back online.' : 'This did not load.';
    render();
  }
}

async function refreshToday() {
  await fetchToday();
  if (state.route === 'today') render();
}

async function refreshCurrent() {
  if (state.route === 'today') return refreshToday();
  await load(state.route);
  render();
}

async function openSheet(kind, id) {
  if (!state.plan) state.plan = await api('GET', '/api/plan');
  state.sheet = { kind, id: id || null };
  render();
  document.querySelector('.sheet .input')?.focus({ preventScroll: true });
}

function closeSheet() {
  state.sheet = null;
  render();
}

// Taps for the layout's own pieces: the oath and briefs sheets.
async function layoutClick(a, el) {
  if (a === 'oath-open' || a === 'briefs-open') {
    state.sheet = { kind: a === 'oath-open' ? 'oath' : 'briefs' };
    render();
    return true;
  }
  // A brief asked for from its sheet: the sheet closes and the brief arrives in the chat as before.
  if (a === 'brief' && state.sheet?.kind === 'briefs') {
    state.sheet = null;
    render();
    return false;
  }
  return false;
}

async function handleAction(e, el) {
  const id = Number(el.dataset.id);
  const a = el.dataset.action;
  if (await goalsClick(a, el)) return;
  if (await planClick(a, el, $app)) return;
  if (await dataClick(a, el)) return;
  if (await foodClick(a, el)) return;
  if (await mailClick(a, el)) return;
  if (await calendarClick(a, el)) return;
  if (await layoutClick(a, el)) return;
  if (await todayClick(a, el)) return;
  if (await coachClick(a, el)) return;
  if (await reviewClick(a, el)) return;
  if (await settingsClick(a, el)) return;
  if (await lockClick(a)) return;
  if (a === 'sheet') {
    await openSheet(el.dataset.kind, id || null);
  } else if (a === 'sheet-dismiss' || a === 'edit-cancel') {
    closeSheet();
  } else if (a === 'copy') {
    const input = document.getElementById(el.dataset.target);
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Copied.');
    } catch {
      input.select();
      toast('Select and copy it by hand.');
    }
  } else if (a === 'reload-route') {
    state.loadFailed = null;
    render();
    await go();
  } else if (a === 'report-problem') {
    await reportProblem('manual', {});
  } else if (a === 'retry') {
    location.reload();
  }
}

// A second tap on something still being handled (a double tap, an impatient re-tap while the server
// answers) is dropped, so nothing is logged, ticked, sent or deleted twice.
$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.busy) {
    e.preventDefault();
    return;
  }
  el.dataset.busy = '1';
  try {
    await handleAction(e, el);
  } finally {
    delete el.dataset.busy;
  }
});

$app.addEventListener('change', (e) => {
  const d = e.target.closest('[data-decide]');
  if (d) state.decisions[d.dataset.decide] = d.value;
  if (e.target.matches('[data-mail-setting]')) mailChange(e.target);
  if (e.target.matches('[data-coach-photo]')) stagePhotos(e.target);
  // A new habit's deadline follows how often it is: due by 21:00 on fixed days, loggable until the end of
  // the day for "times a week". Only the untouched default moves.
  if (e.target.name === 'freq' && e.target.closest('form[data-form="new-habit"]')) {
    const dl = e.target.form.elements.namedItem('deadline');
    if (dl && e.target.value === 'weekly' && dl.value === '21:00') dl.value = '23:59';
    else if (dl && e.target.value === 'fixed' && dl.value === '23:59') dl.value = '21:00';
  }
});

// Live preview of what quick add understood: the date, time, estimate and goal.
$app.addEventListener('input', (e) => {
  const input = e.target.closest('[data-preview]');
  if (!input) return;
  const out = input.form.querySelector('.parse-preview');
  const p = parseCapture(input.value, { today: localToday(), now: localNowHM() });
  const chips = [];
  if (p.due_date) chips.push(p.due_date === localToday() ? 'Today' : fmtDay(p.due_date));
  if (p.deadline) chips.push(p.deadline);
  if (p.estimate_min) chips.push(`about ${fmtMin(p.estimate_min)}`);
  if (p.goalTag) chips.push(`#${esc(p.goalTag)}`);
  out.innerHTML = chips.length && p.title ? `<span class="faint">${esc(p.title)}</span> ${chips.map((c) => `<span class="pchip">${c}</span>`).join('')}` : '';
});

$app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (await goalsSubmit(kind, form)) return;
    if (await dataSubmit(kind, form)) return;
    if (await foodSubmit(kind, form)) return;
    if (await mailSubmit(kind, form)) return;
    if (await calendarSubmit(kind, form)) return;
    if (await lockSubmit(kind, form)) return;
    if (await todaySubmit(kind, form)) return;
    if (await planSubmit(kind, form)) return;
    if (await reviewSubmit(kind, form)) return;
    if (await coachSubmit(kind, form)) return;
    if (await settingsSubmit(kind, form)) return;
  } finally {
    if (submit && document.body.contains(submit)) submit.disabled = false;
  }
});

// Enter sends in the coach on keyboards; Shift+Enter makes a new line.
$app.addEventListener('keydown', (e) => {
  if (e.target.id === 'coach-text' && e.key === 'Enter' && !e.shiftKey && !isIOS()) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
  if (e.key === 'Escape' && (state.sheet || state.sheetNode || state.foodSheet || state.calSheet)) {
    state.sheet = null;
    state.sheetNode = null;
    state.foodSheet = null;
    state.calSheet = null;
    render();
  }
  const g = e.target.closest('g[data-action]');
  if (g && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

// Grow the coach composer with its text, up to a few lines.
$app.addEventListener('input', (e) => {
  if (e.target.id !== 'coach-text') return;
  coachDraft().text = e.target.value;
  syncComposer();
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
});

// Anything typed or picked in a form holds off the automatic refreshes until the next render, so
// a half-written oath or reflection is never wiped. (A tapped radio button never gets focus on iOS.)
['input', 'change'].forEach((ev) => $app.addEventListener(ev, (e) => {
  if (e.target.closest('form')) state.dirty = true;
}));

// The focus clock ticks every second.
setInterval(() => {
  document.querySelectorAll('[data-ends]').forEach((el) => { el.textContent = clockText(el.dataset.ends); });
  document.querySelectorAll('[data-bar-end]').forEach((el) => {
    const a = new Date(el.dataset.barStart).getTime();
    const b = new Date(el.dataset.barEnd).getTime();
    el.style.width = `${Math.min(100, Math.max(0, ((Date.now() - a) / (b - a)) * 100))}%`;
  });
}, 1000);

// Keep countdowns live without re-rendering the page.
setInterval(() => {
  document.querySelectorAll('[data-left]').forEach((el) => {
    const l = left(el.dataset.left);
    el.textContent = l.text;
    el.classList.remove('soon', 'gone');
    if (l.cls) el.classList.add(l.cls);
  });
  // Rows, Up next and the dock warm through Honey, Blaze and Ember as their deadlines near.
  document.querySelectorAll('[data-due]').forEach((el) => {
    const u = `u-${urgency(el.dataset.due)}`;
    if (el.classList.contains(u)) return;
    URGENCY.forEach((x) => el.classList.remove(`u-${x}`));
    el.classList.add(u);
  });
}, 15000);

setInterval(() => {
  if (document.visibilityState === 'visible' && state.route === 'today' && state.today) fetchToday().then(() => redrawIfIdle('today', render)).catch(() => {});
}, 60000);

// A screen a background refresh could not redraw (a field in use, a finger down) is drawn once that passes.
hooks.idle = () => {
  if (state.stale && state.stale === state.route && canRedraw()) render();
};

// The keyboard. iOS keeps fixed bars on the part of the screen left above the keyboard, so the tab bar
// rode up with it and sat on top of the keys. While a text field has focus the tab bar steps aside
// (app.css, html.kb-open) and the chat composers drop to just above the keyboard.
// The keyboard counts as open while a text field has focus or the visible screen has shrunk by more than
// a bar's height (the keyboard coming up), whichever iOS reports first. In the food chat the newest
// message is brought back into view above the composer once the keyboard has settled.
const vv = window.visualViewport;
let typingFocus = false;
function keyboardState() {
  const shrunk = vv ? window.innerHeight - vv.height > 140 : false;
  const open = typingFocus || shrunk;
  const root = document.documentElement;
  root.classList.toggle('kb-open', open);
  // How much of the screen the keyboard covers and how much is left above it, so a sheet can sit on top
  // of the keyboard with its buttons in reach instead of going under it (app.css).
  const kb = open && vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  root.style.setProperty('--kb', `${kb}px`);
  root.style.setProperty('--vvh', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
  // The field being typed in stays in view inside a sheet that just got shorter.
  const field = document.activeElement;
  if (kb && field?.closest?.('.sheet')) requestAnimationFrame(() => field.scrollIntoView?.({ block: 'nearest' }));
  if (shrunk && state.route === 'food' && state.param === 'chat') motion.chatToEnd();
}
document.addEventListener('focusin', (e) => {
  if (!e.target.matches?.(TEXT_FIELDS)) return;
  typingFocus = true;
  keyboardState();
});
document.addEventListener('focusout', () => {
  // Moving from one field to the next keeps the keyboard up, so wait for the next focus before deciding.
  setTimeout(() => {
    typingFocus = Boolean(document.activeElement?.matches?.(TEXT_FIELDS));
    keyboardState();
  }, 120);
});
vv?.addEventListener('resize', keyboardState);
// iOS slides the visible screen up and down while the keyboard is open; the sheet follows it.
vv?.addEventListener('scroll', () => { if (document.documentElement.classList.contains('kb-open')) keyboardState(); });

// Back from the background. With the lock screen up, ask for Face ID again. With Face ID only and
// more than a minute away, lock the open app in place (no reload, no flash of the day) and ask.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    // iOS cuts the microphone off in the background; a half-made voice note is dropped, never sent half done.
    if (recording()) leaveChat();
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  // Ask for a newer version first, also when the lock screen comes up: a phone that only ever resumes the
  // app would otherwise keep running an old version.
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
  if (lockEl()) {
    resumeFresh();
    return;
  }
  if (state.faceIdOnly && away > 60000 && document.querySelector('.tabbar')) {
    lockApp({ auto: false });
    resumeFresh();
    return;
  }
  checkBuild();
  if (document.querySelector('.tabbar') && canRedraw()) go();
});

// A page restored from the back-forward cache comes back without a visibility change.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  if (lockEl()) resumeFresh();
  else checkBuild();
});

window.addEventListener('hashchange', (e) => {
  // Behind the lock screen a new address (a tapped notification) waits: unlocking opens it.
  if (document.querySelector('.gate')) return;
  state.pardoning = null;
  state.sheet = state.route === 'review' ? state.sheet : null;
  state.editingGoal = false;
  state.sheetNode = null;
  state.sheetMode = null;
  state.dodging = null;
  resetDock(); // a new screen starts at the top, where Up next is in view
  // The scroll to the top happens inside the screen change, so the old screen leaves from where it was.
  go({ top: true, native: Boolean(e.hasUAVisualTransition) });
});

// Motion that needs the app: a row swiped left asks "Not now?" in a sheet, and Today pulls to refresh.
motion.initMotion({
  notNow(row) {
    const [, k, id] = /^([ht])(\d+)$/.exec(row.dataset.key || '') || [];
    if (!k) return;
    state.sheet = { kind: 'dodge', ref: { kind: k === 'h' ? 'habit' : 'task', id: Number(id) } };
    render();
  },
  canPull: () => state.route === 'today' && !state.sheet && !state.foodSheet && !document.querySelector('.gate'),
  refresh: () => refreshToday().catch((err) => { if (err.status !== 401) toast(err.message, true); }),
});

// The sidebar arrives at 900px and the two-column layouts at 1240px.
// A gate (the lock screen) is not a view: turning the iPad must not swap it for the app.
// Turning a phone or iPad with a form half typed waits for a quiet moment (hooks.idle draws it), so the
// text and the keyboard are not thrown away.
['(min-width: 900px)', '(min-width: 1240px)'].forEach((q) => window.matchMedia(q).addEventListener('change', () => {
  if (document.querySelector('.gate')) return;
  if (canRedraw()) render(); else state.stale = state.route;
}));

// ---------- Boot ----------

async function boot() {
  watchForUpdates();
  if (location.pathname === '/setup') {
    const code = new URLSearchParams(location.search).get('code') || '';
    try {
      const s = await api('GET', '/api/session');
      if (s.setupDone) { history.replaceState(null, '', '/#/today'); return s.authed ? go() : renderLogin(); }
    } catch { /* show the form anyway */ }
    return renderSetup(code);
  }
  // A phone that opens with Face ID only goes straight to the lock screen, with no blank wait, and
  // Face ID starts while the server is still being asked.
  if (lockModeRemembered()) showLock();
  try {
    const s = await api('GET', '/api/session');
    if (!s.authed) {
      if (!s.setupDone) {
        abortFaceId();
        $app.innerHTML = `<div class="gate">${brandLockup()}<p>Open the setup link you were given to choose your password.</p></div>`;
        return;
      }
      return renderLogin(s);
    }
    // Face ID only: every time the app opens, it locks its own session first and asks for Face ID.
    if (s.faceIdOnly) {
      rememberLockMode(true);
      door.locking = api('POST', '/api/lock', {}).catch(() => {});
      return showLock();
    }
    rememberLockMode(false);
    abortFaceId();
    await go();
    resyncPush();
    flushFood();
  } catch (err) {
    // No connection: the cached day shows even behind Face ID, read only. Without one, the lock waits.
    if (err.status === 0 && showCachedDay()) return;
    if (err.status === 0 && lockModeRemembered()) {
      abortFaceId();
      if (lockEl()) setLock('offline'); else showLock({ offline: true });
      return;
    }
    $app.innerHTML = `<div class="gate">${brandLockup()}<p>${esc(err.message)}</p>
      <div class="form-actions"><button class="btn primary" data-action="retry">Retry</button></div></div>`;
  }
}

boot();
