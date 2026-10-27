// Oath web app. Plain modules, no build step.
import {
  $app, state, hooks, esc, ApiError, api, toast, react, act, form2obj, fmtClock, fmtDay, left, fmtMin,
  DAY_NAMES, scheduleText, CHECK, isStandalone, isIOS, haptic, fx, RING_MS, bar, strengthChip, localToday, localNowHM,
  icon, drawRings, pageHead, iconLink, fmtInt, fmtDec, ago, miniRing, keyBlock, rememberKey, safeColor,
  urgency, URGENCY, brandMark, emptyState,
} from './ui.js';
import { soundsOn, setSounds } from './sound.js';
import * as motion from './motion.js';
import { richHtml } from './rich.js';
import { ACTIVITY, GOALS, NUTRIENT } from './nutrition.js';
import { parseCapture } from './parse.js';
import { initGoals, loadGoals, loadGoal, viewGoals, viewGoalNew, viewGoal, goalsClick, goalsSubmit, goalsBody, goalsHref } from './goals.js';
import { initData, loadHealth, viewHealth, dataClick, dataSubmit, AUTO_LABELS, autoValue } from './data.js';
import { initFood, loadFood, viewFood, foodClick, foodSubmit, loadFoodToday } from './food.js';
import { initToday, ringHero, overview, nextTile, afterToday } from './today.js';
import { initCalendar, loadCalendar, viewCalendar, calendarClick, calendarSubmit } from './calendar.js';

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
const WIDE_EXTRA = [['review', 'Review', 'review'], ['settings', 'Settings', 'settings']];
const ROUTES = ['today', 'calendar', 'plan', 'food', 'goals', 'health', 'coach', 'review', 'settings'];

function shell(inner) {
  // One selected destination: on the phone Health and Review sit under Today and Goals under Plan;
  // the sidebar has its own rows.
  const wide = window.matchMedia('(min-width: 900px)').matches;
  const under = { review: 'today', health: 'today', goals: 'plan' };
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
  return `${pageHead(title)}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`;
}

initGoals({ shell, render: () => render(), go: () => go() });
initData({ shell, render: () => render(), go: () => go() });
initFood({ shell, render: () => render(), go: () => go() });
initToday({ render: () => render() });
initCalendar({ shell, render: () => render(), go: () => go() });

// ---------- Today ----------

// The calendar date right now, not the date of the Today being shown (which may be a cached one).
const realToday = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: t.timezone || 'Europe/Malta' }).format(new Date());

// A 00:00 deadline is the end of the day, so it reads as midnight.
const dueLabel = (hm) => (!hm ? '23:59' : hm === '00:00' ? 'midnight' : hm);

function streakText(i) {
  if (!i.streak) return '';
  return i.flexible ? `${i.streak} ${i.streak === 1 ? 'week' : 'weeks'} in a row` : `${i.streak} day streak`;
}

function autoLine(i, t) {
  if (!i.auto) return '';
  const label = AUTO_LABELS[i.auto.metric] || i.auto.metric;
  const v = autoValue(i.auto, t.health);
  if (v === null) return `<span class="li-auto">${icon('heart')}Ticks itself off from Apple Health at ${fmtInt(i.auto.target)} ${label.unit}</span>`;
  const pct = Math.min(100, Math.round((v / (i.auto.target || 1)) * 100));
  return `<span class="li-auto">${icon('heart')}${fmtInt(v)} of ${fmtInt(i.auto.target)} ${label.unit}</span>${bar(pct, 'thin auto')}`;
}

function habitRow(i, t) {
  const cls = `li li-habit ${i.status}${i.heavy ? ' heavy' : ''}`;
  const side = `<span class="li-side">${strengthChip(i.strength)}</span>`;
  const rulesNote = i.rulesChangeFrom ? `, new rules from ${fmtDay(i.rulesChangeFrom)}` : '';
  const cue = i.cue ? `After ${esc(i.cue)}. ` : '';
  const flexLine = i.flexible ? `${i.weekDone} of ${i.weekTarget} this week` : '';
  if (i.status === 'open') {
    const l = left(i.dueAt);
    const when = i.flexible
      ? `${flexLine}${i.mustToday ? ', <span class="soon">must be today</span>' : ''}`
      : `Due ${dueLabel(i.deadline)}, <span class="${l.cls}" data-left="${i.dueAt}">${l.text}</span>${i.heavy ? ` <span class="hp-chip">${i.penalty} HP</span>` : ''}`;
    const relapse = i.missedLast ? '<span class="tag bad">Missed last time</span>' : '';
    // The minimum version sits under the row, so it can be kept from the list as well as from Up next.
    const minimum = i.minimum
      ? `<div class="li-min"><button class="btn tinted small" data-action="keep-minimum" data-id="${i.id}">Minimum: ${esc(i.minimum)}</button></div>`
      : '';
    // A fixed habit's row warms up as its deadline nears.
    const heat = i.flexible ? '' : ` u-${urgency(i.dueAt)}" data-due="${i.dueAt}`;
    return `<button class="${cls}${heat}" data-action="keep" data-id="${i.id}" data-key="h${i.id}">
      <span class="chk">${CHECK}</span>
      <span class="li-body"><span class="li-title">${relapse}${esc(i.title)}</span>
        <span class="li-sub">${cue}${when}${rulesNote}</span>${autoLine(i, t)}</span>
      ${side}</button>${minimum}`;
  }
  let meta = '';
  let actions = '';
  if (i.status === 'kept') {
    const how = i.keptBy === 'health' ? 'Apple Health' : i.keptMinimum ? 'Minimum kept' : i.comeback ? 'Comeback' : 'Kept';
    meta = `<span class="good">${how}</span> at ${fmtClock(i.keptAt)}${i.flexible ? `. ${flexLine}` : ''}${streakText(i) ? `. ${streakText(i)}` : ''}`;
    if (i.canUndo) actions = `<button class="btn tinted small" data-action="undo" data-id="${i.id}">Undo</button>`;
  } else if (i.status === 'met') {
    meta = `<span class="good">Week done</span>. ${flexLine}. Log more if you like.`;
    actions = `<button class="btn tinted small" data-action="keep" data-id="${i.id}">Log today</button>`;
  } else if (i.status === 'missed') {
    meta = `<span class="bad">Missed at ${dueLabel(i.deadline)}, minus ${i.missHpLost ?? i.penalty} HP${i.missRepeat ? ' (second in a row)' : ''}</span>. Keep it next time for +${t.settings.comebackBonus} HP.`;
    actions = pardonControls(i.missId, t);
  } else if (i.status === 'pardoned') {
    meta = 'Pardoned. Streak kept, HP restored.';
  }
  return `<div class="${cls}" data-key="h${i.id}">
    <span class="chk">${CHECK}</span>
    <span class="li-body"><span class="li-title">${esc(i.title)}</span><span class="li-sub">${meta}</span></span>
    ${side}
    ${actions ? `<div class="li-actions">${actions}</div>` : ''}
  </div>`;
}

function pardonControls(missId, t) {
  if (!missId || !t.pardonable.some((p) => p.id === missId)) return '';
  if (state.pardoning === missId) {
    return `<form class="pardon-form" data-form="pardon" data-id="${missId}">
      <label class="field"><span>What specifically got in the way?</span>
        <textarea class="input" name="reason" minlength="10" required></textarea></label>
      <label class="field"><span>If that happens again, I will...</span>
        <input class="input" name="plan" minlength="10" required value="If " autocomplete="off"></label>
      <div class="form-actions">
        <button class="btn primary" type="submit">Pardon it</button>
        <button class="btn tinted" type="button" data-action="pardon-cancel">Cancel</button>
      </div></form>`;
  }
  if (t.game.pardonsLeft <= 0) return '<span class="faint small">No pardons left this month</span>';
  return `<button class="btn tinted small" data-action="pardon" data-id="${missId}">Use a pardon (${t.game.pardonsLeft} left)</button>`;
}

function taskRow(k, t) {
  const cls = `li li-task ${k.status}${k.heavy ? ' heavy' : ''}`;
  let due = 'No date';
  if (k.dueDate) {
    const dayText = k.dueDate === t.today ? 'Today' : fmtDay(k.dueDate);
    due = k.overdue ? `<span class="bad">Overdue since ${fmtDay(k.dueDate)}</span>` : `${dayText}${k.deadline ? ` ${k.deadline}` : ''}`;
  }
  const extras = [
    k.heavy ? `${k.penalty} HP at stake` : '',
    k.estimate ? `about ${fmtMin(k.estimate)}` : '',
    k.goalTitle ? esc(k.goalTitle) : '',
    k.createdBy === 'coach' ? 'from the coach' : k.createdBy === 'siri' ? 'from Siri' : '',
  ].filter(Boolean).join(', ');
  const tag = k.createdBy === 'vle' ? '<span class="tag uni">VLE</span>' : '';
  if (k.status === 'open') {
    const l = k.heavy && k.dueAt && k.dueDate === t.today ? left(k.dueAt) : null;
    const heat = k.dueAt && k.dueDate === t.today ? ` u-${urgency(k.dueAt)}" data-due="${k.dueAt}` : '';
    return `<button class="${cls}${heat}" data-action="task-done" data-id="${k.id}" data-key="t${k.id}">
      <span class="chk">${CHECK}</span>
      <span class="li-body"><span class="li-title">${tag}${esc(k.title)}</span>
        <span class="li-sub">${due}${l ? `, <span class="${l.cls}" data-left="${k.dueAt}">${l.text}</span>` : ''}${extras ? `, ${extras}` : ''}</span>
        ${k.heavy && k.firstStep ? `<span class="li-sub first-step">First step: ${esc(k.firstStep)}</span>` : ''}</span>
      <span class="li-side"></span></button>`;
  }
  let meta = '';
  let actions = '';
  if (k.status === 'done') {
    meta = `<span class="good">Done</span> at ${fmtClock(k.doneAt)}`;
    if (k.canUndo) actions = `<button class="btn tinted small" data-action="task-undo" data-id="${k.id}">Undo</button>`;
  } else if (k.status === 'missed') {
    meta = `<span class="bad">Missed, minus ${k.penalty} HP.</span> You can still do it.`;
    actions = `<button class="btn tinted small" data-action="task-done" data-id="${k.id}">Mark done</button>${pardonControls(k.missId, t)}`;
  } else if (k.status === 'pardoned') {
    meta = 'Pardoned.';
    actions = `<button class="btn tinted small" data-action="task-done" data-id="${k.id}">Mark done</button>`;
  }
  return `<div class="${cls}" data-key="t${k.id}">
    <span class="chk">${CHECK}</span>
    <span class="li-body"><span class="li-title">${tag}${esc(k.title)}</span><span class="li-sub">${meta}</span></span>
    <span class="li-side"></span>
    ${actions ? `<div class="li-actions">${actions}</div>` : ''}
  </div>`;
}

const REASONS = ['Tired', 'No time', 'Don\'t feel like it', 'Waiting on something', 'Scared of it'];
const DURATIONS = [15, 25, 45, 60];

function capacityLine(c, settings) {
  if (!c) return '';
  const over = c.over > 0;
  return `<div class="capacity${over ? ' over' : ''}">${icon('clock')}<p>Planned <b>${fmtMin(c.estimated)}</b> · free before ${settings.dayEnd} <b>${fmtMin(c.available)}</b>${over ? ` · <b>${fmtMin(c.over)} over</b>` : ''}</p></div>`;
}

// The daily loss cap in plain words: what today can still cost, and whether that would end the season.
function stakesLine(t) {
  const p = t.progress;
  if (!p.atStake) return '';
  if (p.lethal) return `<span class="lethal">Missing everything left today ends the season: ${p.atStake} HP at stake, you have ${t.game.hp}.</span><br>`;
  if (p.fullStake > p.atStake) return `Today can cost at most <b>${p.atStake} HP</b> of the ${p.fullStake} on the line.<br>`;
  return '';
}

// The ring hero (today.js): HP, the day and movement on one set, energy, protein and fibre on the
// other, with the stakes, pardons and deaths under both.
function ringsCard(t) {
  const g = t.game;
  const foot = `${stakesLine(t)}${g.pardonsLeft} ${g.pardonsLeft === 1 ? 'pardon' : 'pardons'} left this month, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'}${t.dodgesToday ? `, ${t.dodgesToday} ${t.dodgesToday === 1 ? 'dodge' : 'dodges'} today` : ''}${t.weekFocus ? `<br>This week: <b>${esc(t.weekFocus)}</b>` : ''}`;
  return ringHero(t, state.foodToday, foot);
}

// The morning oath on Today is one compact row; the oath itself opens in a sheet. The habit list
// stays tickable whether or not the oath has been taken.
function oathCard(t) {
  const n = t.openDue.length;
  return `<section class="card oath-mini">
    <span class="oath-ic" aria-hidden="true">${icon('sun')}</span>
    <span class="oath-mini-text"><b>Take today's oath</b><span>${n} ${n === 1 ? 'thing' : 'things'} open</span></span>
    <button class="btn chrome small" data-action="oath-open">Swear</button>
  </section>`;
}

// The oath in its sheet: one choice from a list, when and where, and a tap.
function oathView(t) {
  const open = [...t.openDue].sort((a, b) => (a.dueAt || '9').localeCompare(b.dueAt || '9'));
  const options = open.map((i) => `<option value="${i.kind}:${i.id}">${esc(i.title)}, by ${dueLabel(i.deadline)}${i.heavy ? `, ${i.penalty} HP` : ''}</option>`).join('');
  return `<div class="oath">
    <h2 class="oath-title">One thing that matters <em class="serif">most</em> today.</h2>
    <p class="oath-sub">${open.length} ${open.length === 1 ? 'thing stands' : 'things stand'} between you and a clean day.</p>
    ${t.lastNight ? `<p class="last-night">Last night you planned: <b>${esc(t.lastNight)}</b></p>` : ''}
    <form class="oath-form" data-form="oath">
      <label class="field"><span>Your one thing</span>
        <select class="input" name="focus" required><option value="">Choose one</option>${options}</select></label>
      <label class="field"><span>When and where</span>
        <input class="input" name="intention" maxlength="300" autocomplete="off" required value="${esc(t.lastNight || '')}" placeholder="10:00 at my desk, phone in the kitchen"></label>
      <button type="submit" class="btn chrome big">Take the oath</button>
    </form>
  </div>`;
}

// "Not now" needs a reason. The same form serves Up next and a row swiped to the left.
function dodgeForm(n) {
  const chips = REASONS.map((r) => `<label class="chip"><input type="radio" name="reason" value="${esc(r)}"><span>${esc(r)}</span></label>`).join('');
  return `${n.minimum ? `<button class="btn primary big wide" data-action="keep-minimum" data-id="${n.id}">Do the minimum now: ${esc(n.minimum)}</button>` : ''}
    <form data-form="defer" data-kind="${n.kind}" data-id="${n.id}">
      <fieldset class="chips"><legend>Why not now</legend>${chips}</fieldset>
      <label class="field"><span>Or in your own words</span><input class="input" name="own" maxlength="300" autocomplete="off"></label>
      ${n.kind === 'task' && !n.heavy ? '<label class="check"><input type="checkbox" name="move"> Move it to tomorrow</label>' : ''}
      <div class="now-actions">
        <button class="btn tinted" type="submit">Log it</button>
        <button class="btn tinted" type="button" data-action="dodge-cancel">Back, I will do it</button>
      </div>
    </form>`;
}

// The item behind a swiped row, in the shape dodgeForm wants.
function dodgeItem(ref) {
  const t = state.today;
  if (!t || !ref) return null;
  if (ref.kind === 'habit') {
    const i = t.items.find((x) => x.id === ref.id && x.status === 'open');
    return i && { kind: 'habit', id: i.id, title: i.title, minimum: i.minimum, heavy: i.heavy, deadline: i.deadline };
  }
  const k = [...t.tasks, ...t.anytime].find((x) => x.id === ref.id && x.status === 'open');
  return k && { kind: 'task', id: k.id, title: k.title, heavy: k.heavy, deadline: k.deadline };
}

function nowPanel(t) {
  if (t.focus) {
    const total = t.focus.minutes * 60000;
    const leftMs = new Date(t.focus.endsAt).getTime() - Date.now();
    const pct = Math.min(100, Math.max(0, 100 - (leftMs / total) * 100));
    return `<section class="card now in-focus">
      <p class="eyebrow">${icon('focus')}In focus</p>
      <h2 class="now-title">${esc(t.focus.title)}</h2>
      <div class="clock" data-ends="${t.focus.endsAt}">${clockText(t.focus.endsAt)}</div>
      <div class="focus-bar"><i data-bar-start="${t.focus.startedAt}" data-bar-end="${t.focus.endsAt}" style="width:${pct}%"></i></div>
      <div class="now-actions">
        <button class="btn primary big" data-action="focus-done" data-id="${t.focus.id}">Done</button>
        <button class="btn tinted big" data-action="focus-stop" data-id="${t.focus.id}">Stop</button>
      </div>
    </section>`;
  }
  const n = t.next;
  if (!n) {
    if (!t.progress.total) return '';
    return `<section class="card now secured">
      <p class="eyebrow">${icon('check')}Day secured</p>
      <h2 class="now-title">Everything due today is done.</h2>
    </section>`;
  }
  const l = n.dueAt ? left(n.dueAt) : null;
  const metaParts = [];
  if (n.flexible) metaParts.push(`${n.weekDone} of ${n.weekTarget} this week`);
  else if (n.dueAt) metaParts.push(`Due ${dueLabel(n.deadline)}`);
  else metaParts.push('No deadline');
  if (n.heavy) metaParts.push(`${n.penalty} HP at stake`);
  if (state.dodging && state.dodging.kind === n.kind && state.dodging.id === n.id) {
    return `<section class="card now dodging">
      <p class="eyebrow">Not now?</p>
      <h2 class="now-title">${esc(n.title)}</h2>
      ${dodgeForm(n)}
    </section>`;
  }
  const durs = DURATIONS.map((d) => `<button type="button" class="${state.focusMinutes === d ? 'on' : ''}" data-action="dur" data-min="${d}" aria-pressed="${state.focusMinutes === d}">${d}</button>`).join('');
  let label = 'Up next';
  if (n.isFocus) label = 'Your one thing';
  else if (n.missedLast) label = `Missed last time, keep it for +${t.settings.comebackBonus} HP`;
  const sub = [];
  if (n.cue) sub.push(`After ${esc(n.cue)}`);
  if (n.firstStep) sub.push(`First step: ${esc(n.firstStep)}`);
  if (n.lastPlan) sub.push(`Your plan: ${esc(n.lastPlan)}`);
  // The card takes the colour of its countdown, and says how much of the day is left to win.
  const p = t.progress;
  const heat = n.dueAt ? ` u-${urgency(n.dueAt)}" data-due="${n.dueAt}` : ' u-calm';
  const toGo = p.total - p.done;
  return `<section class="card now${n.isFocus ? ' is-focus' : ''}${n.missedLast ? ' relapse' : ''}${heat}" data-next="${n.kind}:${n.id}">
    <div class="now-top"><p class="eyebrow">${icon(n.isFocus ? 'focus' : 'bolt')}${label}</p>${l ? `<span class="now-left ${l.cls}" data-left="${n.dueAt}">${l.text}</span>` : ''}</div>
    <h2 class="now-title">${esc(n.title)}</h2>
    <p class="now-meta">${metaParts.join(', ')}</p>
    ${sub.length ? `<p class="now-cue">${sub.join('<br>')}</p>` : ''}
    <div class="now-progress">
      <div class="np-bar" aria-hidden="true"><i data-grow="day" style="width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%"></i></div>
      <span><b>${p.done} of ${p.total}</b> done · ${toGo} to go${p.atStake ? ` · <b class="np-hp">${p.atStake} HP</b> at stake` : ''}</span>
    </div>
    <div class="now-actions">
      <button class="btn tinted big" data-action="focus-start" data-kind="${n.kind}" data-id="${n.id}">${icon('timer')}Focus ${state.focusMinutes} min</button>
      <button class="btn chrome big" data-action="now-done" data-kind="${n.kind}" data-id="${n.id}">${icon('check')}Done</button>
    </div>
    <div class="now-foot">
      <div class="seg mini" role="group" aria-label="Focus length in minutes">${durs}</div>
      <button class="btn plain small" data-action="not-now" data-kind="${n.kind}" data-id="${n.id}">Not now</button>
    </div>
  </section>`;
}

// Every habit due at midnight shares one row on the schedule instead of a stack of identical ones.
function midnightRow(list) {
  if (!list.length) return [];
  const open = list.filter((i) => i.status === 'open');
  const status = open.length ? 'open' : list.every((i) => i.status === 'kept') ? 'kept' : 'missed';
  return [{
    time: '00:00',
    title: `${list.length} ${list.length === 1 ? 'habit' : 'habits'} due at midnight`,
    kind: `due ${status}`,
    sub: open.length ? `${open.length} still open: ${open.map((i) => i.title).join(', ')}` : status === 'kept' ? 'All kept' : 'Closed',
    past: !open.length,
  }];
}

// Deadlines at 00:00 fall at the end of the day, after everything else.
const schedAt = (r) => (r.kind !== 'event' && r.kind !== 'deadline' && r.time === '00:00' ? '24:00' : r.time);

// Today in time order: calendar events with the habit and task deadlines that fall between them.
function scheduleRows(t, now) {
  const events = t.calendar || [];
  const rows = [
    ...events.filter((e) => !e.allDay).map((e) => ({
      time: e.time, title: e.title, kind: e.deadline ? 'deadline' : 'event', color: e.color,
      sub: [e.endTime && e.endTime !== e.time ? `until ${e.endTime}` : '', e.location, e.feed].filter(Boolean).join(', '),
      past: (e.endTime || e.time) < now,
    })),
    ...t.items.filter((i) => !i.flexible && i.status !== 'met' && i.deadline !== '00:00').map((i) => ({
      time: i.deadline, title: i.title, kind: `due ${i.status}`, sub: i.status === 'open' ? `Habit due${i.heavy ? `, ${i.penalty} HP` : ''}` : i.status === 'kept' ? 'Kept' : i.status,
      past: i.status !== 'open',
    })),
    ...midnightRow(t.items.filter((i) => !i.flexible && i.status !== 'met' && i.deadline === '00:00')),
    ...t.tasks.filter((k) => k.dueDate === t.today && k.deadline).map((k) => ({
      time: k.deadline, title: k.title, kind: `due ${k.status}`, sub: k.status === 'open' ? `Task due${k.heavy ? `, ${k.penalty} HP` : ''}` : k.status,
      past: k.status !== 'open',
    })),
  ];
  return rows.sort((a, b) => schedAt(a).localeCompare(schedAt(b)));
}

// The day's full schedule, with a line at the time now. On wide screens it sits beside the day.
function timeline(t) {
  const events = t.calendar || [];
  if (!events.length) return '';
  const now = localNowHM();
  const allDay = events.filter((e) => e.allDay);
  const rows = scheduleRows(t, now);
  let nowPlaced = false;
  const html = rows.map((r) => {
    let marker = '';
    if (!nowPlaced && schedAt(r) >= now) {
      nowPlaced = true;
      marker = `<div class="tl-now"><span>${now}</span></div>`;
    }
    return `${marker}<div class="tl-row ${r.kind}${r.past ? ' past' : ''}">
      <span class="tl-time">${r.time}</span>
      <span class="tl-bar"${safeColor(r.color) ? ` style="--c:${safeColor(r.color)}"` : ''}></span>
      <span class="tl-body"><span class="tl-title">${esc(r.title)}</span>${r.sub ? `<span class="tl-sub">${esc(r.sub)}</span>` : ''}</span>
    </div>`;
  }).join('') + (nowPlaced ? '' : `<div class="tl-now"><span>${now}</span></div>`);
  return `<section class="section"><div class="gh"><h2>Schedule</h2><a href="#/calendar" class="gh-link">Calendar</a></div>
    <div class="card timeline">
      ${allDay.length ? `<div class="tl-allday">${allDay.map((e) => `<span class="tl-chip"${safeColor(e.color) ? ` style="--c:${safeColor(e.color)}"` : ''}>${esc(e.title)}</span>`).join('')}</div>` : ''}
      ${html}
    </div></section>`;
}

// On the phone the schedule shrinks to what is next, a tap away from the calendar.
function nextOnCalendar(t) {
  const now = localNowHM();
  const rows = scheduleRows(t, now).map((r) => ({ ...r, sub: r.kind === 'event' ? r.sub.split(', ').slice(0, 2).join(', ') : r.sub }));
  return nextTile(rows, (t.calendar || []).filter((e) => e.allDay), now);
}

// Reminders only reach the phone from the Home Screen app with notifications allowed, so Today says so.
function remindersChip() {
  if (isIOS() && !isStandalone()) {
    return `<span class="tchip" title="Share, then Add to Home Screen">${icon('bell')}Add to Home Screen for reminders</span>`;
  }
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported || Notification.permission !== 'default') return '';
  return `<button class="tchip act" data-action="push-on">${icon('bell')}Turn on reminders</button>`;
}

// Offline, reminders, a rest day and a waiting review: one row of small chips under the rings.
function statusChips(t) {
  const chips = [
    state.offline ? `<button class="tchip warn" data-action="retry">${icon('clock')}Offline, ${t.today === realToday(t) ? 'today' : fmtDay(t.today)} as of ${fmtClock(state.offline)}<b>Retry</b></button>` : '',
    t.rest ? `<span class="tchip calm">${icon('moon')}Rest day</span>` : '',
    t.reviewDue ? `<a class="tchip act" href="#/review">${icon('review')}Review ready${icon('chevron', 'chev')}</a>` : '',
    remindersChip(),
  ].filter(Boolean);
  return chips.length ? `<div class="tchips" role="group" aria-label="Status">${chips.join('')}</div>` : '';
}

// One row per connection: green once it works, otherwise what is missing, linking to where to fix it.
function setupRows(s) {
  const rows = s.items.map((i) => `<a class="li li-nav${i.ok ? ' done' : ''}" href="${i.href}">
      <span class="chk">${CHECK}</span>
      <span class="li-body"><span class="li-title">${esc(i.title)}</span><span class="li-sub">${esc(i.detail)}${i.id === 'health' && s.health.lastSync ? ` Synced ${ago(s.health.lastSync)}.` : ''}</span></span>
      ${icon('chevron', 'chev')}</a>`).join('');
  const err = s.ingestError
    ? `<p class="note bad setup-err">The last request from Shortcuts or Health Auto Export failed ${ago(s.ingestError.at)}: ${esc(s.ingestError.reason)}</p>`
    : '';
  return rows + err;
}

// The battle plan opens by itself before noon, until you close it; then it stays closed for the day.
function planOpen(t) {
  try {
    const saved = localStorage.getItem(`oath.plan.${t.today}`);
    if (saved !== null) return saved === '1';
  } catch { /* storage unavailable */ }
  return t.localHour < 12;
}
document.addEventListener('toggle', (e) => {
  if (!e.target.matches?.('.plan-card') || !state.today) return;
  try { localStorage.setItem(`oath.plan.${state.today.today}`, e.target.open ? '1' : '0'); } catch { /* storage unavailable */ }
}, true);

function planCard(t) {
  if (!t.plan?.coachPlan) return '';
  return `<details class="card plan-card"${planOpen(t) ? ' open' : ''}>
    <summary>${icon('coach')}Battle plan${t.plan.intention ? `: ${esc(t.plan.intention)}` : ''}</summary>
    <div class="plan-text rich">${richHtml(t.plan.coachPlan)}</div>
  </details>`;
}

// One row a task with the two common moves; next week and drop wait under More.
function triageCard(t) {
  if (!t.triage.length) return '';
  const list = t.triage.slice(0, 5);
  const row = (k, sub, btns) => `<div class="tri-row">
      <span class="tri-text"><span class="li-title">${esc(k.title)}</span>${sub ? `<span class="li-sub">${sub}</span>` : ''}</span>
      <span class="tri-btns" role="group" aria-label="${esc(k.title)}">${btns}</span></div>`;
  const move = (k, to, label, cls = 'tinted') => `<button class="btn ${cls} small" data-action="triage" data-do="${to}" data-id="${k.id}">${label}</button>`;
  const rows = list.map((k) => row(k, k.dueDate ? `Was due ${fmtDay(k.dueDate)}` : `No date for ${k.ageDays} days`,
    `${move(k, 'today', 'Today')}${move(k, 'tomorrow', 'Tomorrow')}`)).join('');
  const more = list.map((k) => row(k, '', `${move(k, 'week', 'Next week')}${move(k, 'drop', 'Drop', 'plain danger-text')}`)).join('');
  return `<section class="section"><div class="gh"><h2>Clear the backlog</h2><span class="gh-count">${t.triage.length} waiting</span></div>
    <div class="group tri">${rows}<details class="tri-more"><summary>More</summary>${more}</details></div></section>`;
}

function goalsStrip(goals) {
  if (!goals?.length) return '';
  return `<section class="section"><div class="gh"><h2>Goals</h2><a class="gh-link" href="${goalsHref()}">All goals</a></div>
    <div class="goal-mini">${goals.map((g) => `<a href="#/goals/${g.id}" class="goal-mini-row">
      ${miniRing(g.pct ?? 0, 34)}<span><span class="goal-mini-title">${esc(g.title)}</span><span class="goal-mini-label">${g.pct === null ? '' : `${g.pct}%, `}${esc(g.label)}</span></span>${icon('chevron', 'chev')}</a>`).join('')}</div></section>`;
}

function closeDayCard(t) {
  if (t.reflection) {
    return `<section class="section"><div class="gh"><h2>Day closed</h2><span class="gh-count">${t.reflection.rating} out of 5</span></div>
      <div class="card brief"><p class="eyebrow">${icon('coach')}Coach</p><div class="brief-text rich">${richHtml(t.reflection.coachReply || 'The coach is writing back.')}</div>${t.reflection.tomorrow ? `<p class="brief-who">Tomorrow's one thing: ${esc(t.reflection.tomorrow)}</p>` : ''}</div></section>`;
  }
  if (t.localHour < 18 && t.progress.open) return '';
  const stars = [1, 2, 3, 4, 5].map((n) => `<label class="rate"><input type="radio" name="rating" value="${n}" required><span>${n}</span></label>`).join('');
  return `<section class="section"><div class="gh"><h2>Close the day</h2></div>
    <form class="card" data-form="reflect">
      <fieldset class="rates"><legend>How was today, honestly?</legend>${stars}</fieldset>
      <label class="field"><span>What got in the way</span><input class="input" name="blocker" maxlength="500" autocomplete="off"></label>
      <label class="field"><span>One win</span><input class="input" name="win" maxlength="500" autocomplete="off"></label>
      <label class="field"><span>Tomorrow's one thing, when and where</span><input class="input" name="tomorrow" maxlength="300" autocomplete="off" placeholder="EA settings review, 9:00 at my desk"></label>
      <div class="form-actions"><button class="btn primary" type="submit">Close the day</button></div>
    </form></section>`;
}

function quickAdd(id = 'quick-task') {
  return `<form class="li li-add" data-form="quick-task">
    <span class="add-ic">${icon('plus')}</span>
    <label class="sr" for="${id}">New task</label>
    <input id="${id}" class="add-input" name="title" placeholder="Add a task: call the bank fri 3pm" autocomplete="off" maxlength="200" required data-preview>
    <button class="btn primary small" type="submit">Add</button>
    <div class="parse-preview" aria-live="polite"></div>
  </form>`;
}

// One line to the coach from anywhere in the day: "move the dentist to Friday", "I did the gym".
function askCoach(where) {
  return `<form class="ask-coach" data-form="ask-coach">
    <span class="ask-ic" aria-hidden="true">${brandMark(22)}</span>
    <label class="sr" for="ask-${where}">Tell the coach</label>
    <input id="ask-${where}" class="ask-input" name="text" maxlength="1000" autocomplete="off" required
      placeholder="Tell the coach: move the dentist to Friday">
    <button class="btn chrome small ask-send" type="submit" aria-label="Send to the coach">${icon('send')}</button>
  </form>`;
}

// When Up next scrolls out of sight, a dock above the tabs keeps the next tick one tap away.
function nextDock(t) {
  const n = t.next;
  if (!n || t.focus) return '';
  const l = n.dueAt ? left(n.dueAt) : null;
  // A redraw keeps the dock where it was, so it never blinks out and back in after a tick.
  // Two short lines, the time left beside the label, so the dock and the tabs cover little of the day.
  return `<div class="next-dock u-${urgency(n.dueAt)}"${n.dueAt ? ` data-due="${n.dueAt}"` : ''} id="next-dock" role="region" aria-label="Up next" data-next="${n.kind}:${n.id}"${dockShown ? '' : ' hidden'}>
    <span class="dock-text"><span class="dock-label">Up next${l ? `<span class="dock-left ${l.cls}" data-left="${n.dueAt}">${l.text}</span>` : ''}</span><b>${esc(n.title)}</b></span>
    <button class="btn chrome small" data-action="now-done" data-kind="${n.kind}" data-id="${n.id}">${icon('check')}Done</button>
  </div>`;
}

let nowWatcher = null;
let dockShown = false;
function watchNow() {
  nowWatcher?.disconnect();
  nowWatcher = null;
  const card = document.querySelector('.page-today .now');
  const dock = document.getElementById('next-dock');
  if (!card || !dock || !('IntersectionObserver' in window)) {
    dockShown = false;
    return;
  }
  // Shown only once the card has scrolled up and away, never while it is still below the fold.
  nowWatcher = new IntersectionObserver(([e]) => {
    if (!card.isConnected) return; // the card was drawn over: the new one has its own watcher
    const show = !(e.isIntersecting || e.boundingClientRect.top > 0);
    if (show !== dockShown || show === dock.hidden) motion.dock(dock, show);
    dockShown = show;
  });
  nowWatcher.observe(card);
}

function briefCard(t) {
  // A brief is only shown for four hours; after that the day has moved on.
  const brief = t.briefs.find((x) => Date.now() - new Date(x.at).getTime() < 4 * 3600 * 1000);
  if (!brief) return '';
  const titles = { morning: 'Morning brief', midday: 'Midday check', evening: 'Evening check' };
  return `<section class="card brief"><p class="eyebrow">${icon('coach')}${titles[brief.kind] || 'Coach'}, ${fmtClock(brief.at)}</p><div class="brief-text rich">${richHtml(brief.text)}</div></section>`;
}

function viewToday() {
  const t = state.today;
  if (!t) return shell(skeleton('Today'));
  const part = t.localHour < 12 ? 'Morning' : t.localHour < 18 ? 'Afternoon' : 'Evening';
  const head = pageHead(`${part}, <em>${esc(t.settings.ownerName || 'Daniel')}</em>`, {
    over: fmtDay(t.today, { weekday: 'long', day: 'numeric', month: 'long' }),
    actions: `<span class="only-narrow-flex">${iconLink('#/health', 'heart', 'Health')}</span>${iconLink('#/settings', 'settings', 'Settings')}`,
  });
  const banners = statusChips(t);

  // No oath yet and something is due: the oath row sits under Up next, and the lists stay tickable.
  const needsOath = !t.plan && t.progress.open > 0;

  // The overview leads: the rings, then what is next, then the small charts. The lists follow.
  const ov = overview(t, state.foodToday, nextOnCalendar(t));

  if (!t.items.length && !t.tasks.length && !t.anytime.length && !t.triage.length) {
    shell(`${head}${ringsCard(t)}${banners}
      <section class="card now empty-now"><p class="eyebrow">${icon('plan')}Start here</p><h2 class="now-title">Add the habits you swear to.</h2>
      <div class="now-actions"><a class="btn primary big" href="#/plan">Add habits</a><a class="btn tinted big" href="#/goals/new">Set a goal</a></div></section>
      ${ov}`);
    afterToday();
    return;
  }

  const fixed = t.items.filter((i) => !i.flexible);
  const heavy = fixed.filter((i) => i.heavy);
  const normal = fixed.filter((i) => !i.heavy);
  const flex = t.items.filter((i) => i.flexible);
  const keptCount = (list) => list.filter((i) => i.status === 'kept' || i.status === 'pardoned').length;
  const openHp = (list) => list.filter((i) => i.status === 'open').reduce((n, i) => n + (i.penalty || 0), 0);
  const heavyCount = `${keptCount(heavy)} of ${heavy.length}${openHp(heavy) ? ` · ${openHp(heavy)} HP open` : ''}`;
  const section = (title, list, rows, count) => (list.length ? `<section class="section">
      <div class="gh"><h2>${title}</h2><span class="gh-count">${count ?? `${keptCount(list)} of ${list.length}`}</span></div>
      <div class="group">${rows}</div></section>` : '');

  const doneTasks = t.tasks.filter((k) => k.status === 'done');
  const openTasks = t.tasks.filter((k) => k.status !== 'done');
  const tasksHtml = `<section class="section">
    <div class="gh"><h2>Tasks</h2><span class="gh-count">${doneTasks.length} done today</span></div>
    <div class="group">
      ${[...openTasks, ...doneTasks].map((k) => taskRow(k, t)).join('')}
      ${quickAdd()}
    </div>
    ${t.anytime.length ? `<details class="anytime"><summary>Anytime: ${t.anytime.length} ${t.anytime.length === 1 ? 'task' : 'tasks'} with no date</summary>
      <div class="group">${t.anytime.map((k) => taskRow(k, t)).join('')}</div></details>` : ''}
  </section>`;

  const upcoming = t.upcoming.length ? `<section class="section"><div class="gh"><h2>Coming up</h2></div>
    <div class="group">${t.upcoming.slice(0, 6).map((u) => `<div class="li li-plain${u.heavy ? ' heavy' : ''}">
      <span class="li-body"><span class="li-title">${esc(u.title)}</span></span><span class="li-side small faint">${fmtDay(u.dueDate)}${u.deadline ? ` ${u.deadline}` : ''}${u.heavy ? ', hard' : ''}</span></div>`).join('')}</div></section>` : '';

  shell(`${head}<div class="split">
    <div>
      ${ringsCard(t)}
      ${banners}
      ${nowPanel(t)}
      ${needsOath ? oathCard(t) : ''}
      ${ov}
      ${askCoach('today')}
      ${t.plan ? capacityLine(t.capacity, t.settings) : ''}
      <div class="only-narrow">${planCard(t)}${briefCard(t)}</div>
      ${triageCard(t)}
      ${section('Non-negotiables', heavy, heavy.map((i) => habitRow(i, t)).join(''), heavyCount)}
      ${section('Habits', normal, normal.map((i) => habitRow(i, t)).join(''))}
      ${section('This week', flex, flex.map((i) => habitRow(i, t)).join(''), `${flex.filter((i) => i.status === 'met').length} of ${flex.length} met`)}
      ${tasksHtml}
      ${closeDayCard(t)}
    </div>
    <aside>
      <div class="only-wide">${timeline(t)}${planCard(t)}${briefCard(t)}</div>
      ${goalsStrip(t.goals)}
      ${upcoming}
    </aside>
  </div>${nextDock(t)}`);
  watchNow();
  afterToday();
}

function clockText(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'Time is up';
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Plan ----------

function heatmap(heat, today) {
  if (!heat?.length) return '';
  // Only the habit's own history, one column per week, Monday on top. Hidden in the first week.
  const firstActive = heat.findIndex((s) => s !== 'off');
  if (firstActive < 0 || heat.length - firstActive < 7) return '';
  const days = heat.slice(firstActive);
  const first = new Date(`${today}T12:00:00Z`);
  first.setUTCDate(first.getUTCDate() - (days.length - 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const cells = [...Array(offset).fill('<i class="h-pad"></i>'), ...days.map((s) => `<i class="h-${s}"></i>`)].join('');
  // A key for the states this habit actually has.
  const names = { kept: 'Kept', min: 'Minimum', missed: 'Missed', pardoned: 'Pardoned', rest: 'Rest', open: 'Today', none: 'No record', flex: 'Not done' };
  const key = Object.entries(names).filter(([s]) => days.includes(s)).map(([s, l]) => `<span><i class="h-${s}"></i>${l}</span>`).join('');
  return `<div class="heat" role="img" aria-label="Since it started: ${days.filter((s) => s === 'kept' || s === 'min' || s === 'pardoned').length} kept, ${days.filter((s) => s === 'missed').length} missed">${cells}</div>
    <div class="heat-key" aria-hidden="true">${key}</div>`;
}

function goalOptions(selected) {
  const goals = state.plan?.goals || [];
  if (!goals.length) return '';
  return `<label class="field"><span>Serves goal</span><select class="input" name="goal_id">
    <option value="">None</option>${goals.map((g) => `<option value="${g.id}"${Number(selected) === g.id ? ' selected' : ''}>${esc(g.title)}</option>`).join('')}</select></label>`;
}

function autoFields(h) {
  const a = h?.auto || null;
  const opts = [['', 'Off, I tick it myself'], ...Object.entries(AUTO_LABELS).map(([k, v]) => [k, v.name])]
    .map(([k, label]) => `<option value="${k}"${(a?.metric || '') === k ? ' selected' : ''}>${label}</option>`).join('');
  return `<div class="auto-field">
    <p class="auto-h">${icon('heart')}Tick it off from Apple Health</p>
    <div class="grid2">
      <label class="field"><span>Measure</span><select class="input" name="auto_metric">${opts}</select></label>
      <label class="field auto-on"><span>Target</span><input class="input" name="auto_target" inputmode="decimal" value="${esc(a?.target ?? '')}" placeholder="10000"></label>
    </div>
    <label class="field auto-workout"><span>Workout type contains (optional)</span><input class="input" name="auto_filter" maxlength="60" value="${esc(a?.filter || '')}" placeholder="strength, run, swim"></label>
  </div>`;
}

function habitForm(h) {
  const r = h ? { ...h, ...(h.nextRules || {}), weeklyTarget: h.nextRules ? h.nextRules.weekly_target : h.weeklyTarget, minimum: h.nextRules ? h.nextRules.minimum : h.minimum } : { deadline: '21:00', non_negotiable: false, penalty: '' };
  const days = r.days || [1, 2, 3, 4, 5, 6, 7];
  const weekly = Boolean(r.weeklyTarget);
  const dayBoxes = DAY_NAMES.map((n, i) => `<label><input type="checkbox" name="days" value="${i + 1}"${days.includes(i + 1) ? ' checked' : ''}><span>${n.slice(0, 2)}</span></label>`).join('');
  const nnCount = (state.plan?.habits || []).filter((x) => x.non_negotiable && x.id !== h?.id).length;
  const cap = state.plan?.settings?.maxNonNegotiables ?? 3;
  return `<form class="habit-form" data-form="${h ? 'edit-habit' : 'new-habit'}"${h ? ` data-id="${h.id}"` : ''}>
    <label class="field"><span>Habit</span><input class="input" name="name" maxlength="120" required value="${esc(h?.name || '')}" placeholder="20 push-ups"></label>
    <label class="field"><span>After I... (an existing routine it follows)</span><input class="input" name="cue" maxlength="120" value="${esc(h?.cue || '')}" placeholder="pour my morning coffee"></label>
    <div class="seg" role="radiogroup" aria-label="How often">
      <label><input type="radio" name="freq" value="fixed"${weekly ? '' : ' checked'}><span>Fixed days</span></label>
      <label><input type="radio" name="freq" value="weekly"${weekly ? ' checked' : ''}><span>Times a week</span></label>
    </div>
    <div class="field fixed-only"><span>Days</span><div class="days">${dayBoxes}</div></div>
    <label class="field weekly-only"><span>Times a week, settled Sunday night</span><input class="input" type="number" name="weekly_target" min="1" max="7" inputmode="numeric" value="${esc(r.weeklyTarget || 3)}"></label>
    <div class="grid2">
      <label class="field"><span><span class="fixed-only">Due by</span><span class="weekly-only">Log by</span></span><input class="input" type="time" name="deadline" required value="${esc(r.deadline || '21:00')}"></label>
      <label class="field"><span>Cue reminder at</span><input class="input" type="time" name="remind_at" value="${esc(h?.remindAt || '')}"></label>
    </div>
    <label class="field"><span>Minimum version for a bad day (optional)</span><input class="input" name="minimum" maxlength="120" value="${esc(r.minimum || '')}" placeholder="5 push-ups"></label>
    <label class="field"><span>If-then plan for the obstacle (optional)</span><input class="input" name="if_then" maxlength="300" value="${esc(h?.ifThen || '')}" placeholder="If I skip the morning, then I do it before dinner"></label>
    <div class="grid2">
      <label class="check"><input type="checkbox" name="non_negotiable"${r.non_negotiable ? ' checked' : ''}> Non-negotiable</label>
      <label class="field"><span>HP lost on a miss</span><input class="input" type="number" name="penalty" min="1" max="100" inputmode="numeric" value="${esc(r.penalty)}" placeholder="25 or 10"></label>
    </div>
    ${!h?.non_negotiable && nnCount >= cap ? `<p class="note">${nnCount} of ${cap} non-negotiables in use.</p>` : ''}
    ${autoFields(h)}
    ${goalOptions(h?.goalId)}
    <label class="field"><span>Notes</span><input class="input" name="notes" maxlength="1000" value="${esc(h?.notes || '')}" placeholder="Optional"></label>
    ${h && h.nextRulesFrom ? `<p class="note">New rules from ${fmtDay(h.nextRulesFrom)}.</p>` : ''}
    <div class="form-actions">
      <button class="btn primary" type="submit">${h ? 'Save habit' : 'Add habit'}</button>
      ${h && !h.archivedFrom ? `<button class="btn tinted danger-text" type="button" data-action="remove-habit" data-id="${h.id}">Remove habit</button>` : ''}
    </div>
  </form>`;
}

function taskForm(k) {
  const locked = k?.locked;
  return `<form class="task-form" data-form="${k ? 'edit-task' : 'new-task'}"${k ? ` data-id="${k.id}"` : ''}>
    <label class="field"><span>Task</span><input class="input" name="title" maxlength="200" required value="${esc(k?.title || '')}"></label>
    <div class="grid2">
      <label class="field"><span>Due date</span><input class="input" type="date" name="due_date" value="${esc(k?.dueDate || '')}"${locked ? ' disabled' : ''}></label>
      <label class="field"><span>Time</span><input class="input" type="time" name="deadline" value="${esc(k?.deadline || '')}"${locked ? ' disabled' : ''}></label>
    </div>
    <label class="field"><span>Estimate in minutes</span><input class="input" type="number" name="estimate_min" min="5" max="600" step="5" inputmode="numeric" value="${esc(k?.estimate || '')}" placeholder="30"></label>
    ${goalOptions(k?.goalId)}
    <label class="check"><input type="checkbox" name="hard"${k?.hard ? ' checked' : ''}${locked ? ' disabled' : ''}> Hard task: costs HP if not done by the deadline</label>
    <label class="field hard-only"><span>First step: the very first physical action</span><input class="input" name="first_step" maxlength="200" value="${esc(k?.firstStep || '')}" placeholder="Open the VAT portal and log in"></label>
    ${locked ? '<p class="note">Locked while due.</p>' : ''}
    <div class="form-actions">
      <button class="btn primary" type="submit">${k ? 'Save task' : 'Add task'}</button>
      ${k && !locked ? `<button class="btn tinted danger-text" type="button" data-action="delete-task" data-id="${k.id}">Delete</button>` : ''}
    </div>
  </form>`;
}

function habitCard(h, p) {
  const r = h.nextRules || {};
  const weekly = h.weeklyTarget;
  const sched = weekly ? `${weekly} times a week, ${h.weekDone} done this week` : scheduleText(h.days, h.deadline);
  const pending = h.nextRulesFrom ? `<p class="note">From ${fmtDay(h.nextRulesFrom)}: ${r.weekly_target ? `${r.weekly_target} times a week` : scheduleText(r.days, r.deadline)}${r.minimum ? `, minimum "${esc(r.minimum)}"` : ''}.</p>` : '';
  const building = h.strength < 80 ? `Day ${h.buildingDay} of building.` : 'Established.';
  const facts = [
    h.cue ? ['After', esc(h.cue)] : null,
    h.minimum ? ['Minimum', esc(h.minimum)] : null,
    h.ifThen ? ['Plan', esc(h.ifThen)] : null,
    h.auto ? ['Health', `${fmtInt(h.auto.target)} ${(AUTO_LABELS[h.auto.metric] || {}).unit || ''}${h.auto.filter ? `, ${esc(h.auto.filter)}` : ''}`] : null,
    h.goalTitle ? ['Goal', `<a href="#/goals/${h.goalId}">${esc(h.goalTitle)}</a>`] : null,
  ].filter(Boolean);
  // Compact by default: the history (the heatmap) opens from the strength ring or the History toggle,
  // and Remove lives in the edit sheet.
  const heat = heatmap(h.heat, p.today);
  const open = Boolean(heat) && historyOpen(h.id);
  const ringCls = `hcard-ring ${h.strength >= 80 ? 'strong' : h.strength >= 40 ? 'mid' : 'new'}`;
  const ringInner = `${miniRing(h.strength, 42)}<b>${h.strength}<small>%</small></b>`;
  const ring = heat
    ? `<button class="${ringCls}" data-action="habit-history" data-id="${h.id}" aria-expanded="${open}" aria-controls="heat-${h.id}" aria-label="Strength ${h.strength}%, history">${ringInner}</button>`
    : `<div class="${ringCls}" role="img" aria-label="Strength ${h.strength}%">${ringInner}</div>`;
  return `<div class="card hcard${h.non_negotiable ? ' heavy' : ''}${h.archivedFrom ? ' leaving' : ''}${open ? ' history-open' : ''}" data-habit="${h.id}">
    <div class="hcard-top">
      <div class="hcard-text"><h3>${esc(h.name)}</h3>
        <p class="li-sub">${sched}${h.non_negotiable ? ', <span class="bad">non-negotiable</span>' : ''}, minus ${h.penalty}&nbsp;HP</p></div>
      ${ring}
    </div>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
    ${heat ? `<div class="hcard-heat" id="heat-${h.id}"${open ? '' : ' hidden'}>${heat}</div>` : ''}
    ${pending}
    <div class="hcard-foot">${h.archivedFrom
      ? `<span class="small leaving">Leaves your list tomorrow. Today still counts.</span>
        <button class="btn tinted small" data-action="restore-habit" data-id="${h.id}">Keep it</button>`
      : `<span class="faint small">${building}${h.streak ? ` ${h.streak} ${weekly ? 'week' : 'day'} streak.` : ''}</span>
        <span class="hcard-btns">${heat ? `<button class="btn plain small hist-btn" data-action="habit-history" data-id="${h.id}" aria-expanded="${open}" aria-controls="heat-${h.id}">History</button>` : ''}
        <button class="btn tinted small" data-action="sheet" data-kind="habit" data-id="${h.id}">Edit</button></span>`}</div>
  </div>`;
}

function restCard(p) {
  const list = p.restDays.map((d) => `<div class="li li-plain">
    <span class="li-body"><span class="li-title">${fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>${d.reason ? `<span class="li-sub">${esc(d.reason)}</span>` : ''}</span>
    <button class="btn tinted small" data-action="rest-cancel" data-date="${d.date}">Cancel</button></div>`).join('');
  return `<section class="section"><div class="gh"><h2>Rest days</h2><span class="gh-count">${p.settings.restDaysPerMonth} a month</span></div>
    <div class="card">
      ${list ? `<div class="group flush">${list}</div>` : ''}
      <form class="rest-form" data-form="rest">
        <label class="sr" for="rest-date">Date</label>
        <input id="rest-date" class="input" type="date" name="date" min="${p.today}" required>
        <input class="input" name="reason" maxlength="200" placeholder="Reason" autocomplete="off">
        <button class="btn primary" type="submit">Book</button>
      </form>
    </div></section>`;
}

// What a fully missed day would put on the line against what one day can actually cost.
function budgetNote(s) {
  if (!s?.worstDay) return '';
  const capped = s.worstDay > s.dailyLossCap;
  return `<div class="capacity${capped ? ' over' : ''}">${icon('shield')}<p>Worst day <b>${s.worstDay} HP</b> · day cap <b>${s.dailyLossCap} HP</b></p></div>`;
}

// A habit that left the list at once can come back for a couple of minutes; one leaving tomorrow
// shows Keep it on its own card instead.
const undoable = (p) => state.removed && Date.now() - state.removed.at < 120000 && !p.habits.some((h) => h.id === state.removed.id);

function viewPlan() {
  const p = state.plan;
  if (!p) return shell(skeleton('Plan'));
  const tab = state.planTab || 'habits';
  const habits = p.habits.map((h) => habitCard(h, p)).join('');
  const tasks = p.tasks.map((k) => {
    const due = k.dueDate ? `${fmtDay(k.dueDate)}${k.deadline ? ` ${k.deadline}` : ''}` : 'No date';
    const extras = [k.hard ? 'hard' : '', k.estimate ? fmtMin(k.estimate) : '', k.goalTitle ? esc(k.goalTitle) : '', k.createdBy === 'coach' ? 'from the coach' : k.createdBy === 'siri' ? 'from Siri' : ''].filter(Boolean).join(', ');
    return `<button class="li li-plain li-nav${k.hard ? ' heavy' : ''}" data-action="sheet" data-kind="task" data-id="${k.id}">
      <span class="li-body"><span class="li-title">${k.createdBy === 'vle' ? '<span class="tag uni">VLE</span>' : ''}${esc(k.title)}</span><span class="li-sub">${due}${extras ? `, ${extras}` : ''}</span></span>
      ${icon('chevron', 'chev')}</button>`;
  }).join('');
  // Goals are Plan's third segment on the phone; the sidebar keeps its own Goals row.
  const goals = state.goals || p.goals;
  const segBtn = (id, label) => `<button role="tab" aria-selected="${tab === id}" data-action="plan-tab" data-tab="${id}">${label}</button>`;
  const seg = `<div class="seg plan-seg only-narrow-flex" role="tablist" aria-label="Show">
      ${segBtn('habits', 'Habits')}${segBtn('tasks', 'Tasks')}${segBtn('goals', 'Goals')}
    </div>`;
  // Two columns from 1240px show habits and tasks, so + adds a habit there.
  const add = tab === 'goals' && !window.matchMedia('(min-width: 1240px)').matches
    ? `<a class="icon-btn accent" href="#/goals/new" aria-label="New goal">${icon('plus')}</a>`
    : `<button class="icon-btn accent" data-action="sheet" data-kind="${tab === 'tasks' ? 'task' : 'habit'}" aria-label="New ${tab === 'tasks' ? 'task' : 'habit'}">${icon('plus')}</button>`;
  const activeGoals = goals.filter((g) => g.status === 'active').length;

  shell(`${pageHead('Plan', { over: `${p.habits.length} habits, ${p.tasks.length} tasks, ${activeGoals} ${activeGoals === 1 ? 'goal' : 'goals'}`, actions: add })}
    ${seg}
    ${askCoach('plan')}
    <div class="split plan-split tab-${tab}">
    <div class="pane-habits">
      <section class="section"><div class="gh"><h2>Habits</h2><button class="gh-link" data-action="sheet" data-kind="habit">New habit</button></div>
        ${undoable(p) ? `<div class="banner food-undo"><span>Removed ${esc(state.removed.name)}.</span><button class="btn tinted small" data-action="restore-habit" data-id="${state.removed.id}">Undo</button></div>` : ''}
        ${budgetNote(p.settings)}
        ${habits || emptyState({ icon: 'plan', title: 'No habits yet', actions: '<button class="btn primary" data-action="sheet" data-kind="habit">Add the first habit</button>' })}
      </section>
      ${restCard(p)}
    </div>
    <aside class="pane-tasks">
      <section class="section"><div class="gh"><h2>Tasks</h2><button class="gh-link" data-action="sheet" data-kind="task">New task</button></div>
        <div class="group">${quickAdd('plan-quick')}${tasks}</div>
      </section>
    </aside>
    <div class="pane-goals">${goalsBody(goals, '<div class="gh"><h2>Goals</h2><a class="gh-link" href="#/goals/new">New goal</a></div>')}</div>
  </div>`);
}

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

// ---------- Coach ----------

// One message: its words, what it did (receipts), and anything waiting for a Confirm tap.
const PENDING_DONE = { done: 'Confirmed', cancelled: 'Cancelled', expired: 'Expired. Ask again if you still want it.', failed: 'Did not go through' };
function coachMessage(m) {
  const receipts = m.actions?.length
    ? `<ul class="receipts">${m.actions.map((a) => `<li class="${a.ok ? 'ok' : 'no'}">${icon(a.ok ? 'check' : 'close')}<span>${esc(a.text)}</span></li>`).join('')}</ul>`
    : '';
  const pending = (m.pending || []).map((p) => (p.status === 'open'
    ? `<div class="confirm-row"><span>${esc(p.summary)}?</span><span class="confirm-btns"><button class="btn chrome small" data-action="coach-confirm" data-id="${p.id}" data-yes="1">Confirm</button><button class="btn tinted small" data-action="coach-confirm" data-id="${p.id}" data-yes="0">Cancel</button></span></div>`
    : `<p class="confirm-done ${p.status}">${esc(p.summary)}: ${PENDING_DONE[p.status] || p.status}${p.status === 'failed' && p.outcome ? `, ${esc(p.outcome)}` : ''}</p>`)).join('');
  const words = m.role === 'assistant' ? `<div class="msg-text rich">${richHtml(m.text)}</div>` : `<span class="msg-text">${esc(m.text)}</span>`;
  return `<div class="msg ${m.role}">${words}${receipts}${pending}${m.at ? `<time>${fmtClock(m.at)}</time>` : ''}</div>`;
}

// The coach thinking: three dots in a bubble of its own.
const TYPING = '<div class="msg assistant typing" role="status"><span class="sr">The coach is writing</span><i></i><i></i><i></i></div>';

// One tap for the things most often asked.
const QUICK = ['What\'s next?', 'Plan my day', 'How am I doing?', 'Log food'];

// The briefs the coach writes on its own, on demand; they sit in a sheet behind one button.
const BRIEFS = [['morning', 'sun', 'Morning brief'], ['midday', 'clock', 'Midday check'], ['evening', 'moon', 'Evening check']];

function viewCoach() {
  const c = state.coach;
  if (!c) return shell(skeleton('Coach'));
  const msgs = c.messages.map(coachMessage).join('');
  const ask = state.query.get('ask') || '';
  const empty = emptyState({ icon: 'coach', title: 'Talk to your coach' });
  const quick = QUICK.map((q) => `<button type="button" class="qchip" data-action="coach-quick" data-text="${esc(q)}"${state.sending ? ' disabled' : ''}>${esc(q)}</button>`).join('');
  const briefs = `<button class="btn tinted small briefs-btn" data-action="briefs-open"${state.sending ? ' disabled' : ''}>${icon('sun')}Briefs</button>`;
  shell(`${pageHead('Coach', { over: c.aiEnabled ? '' : 'Offline', actions: `${briefs}${iconLink('#/settings', 'settings', 'Settings')}` })}
      ${c.aiEnabled ? '' : '<div class="banner warn">The coach is offline: no Anthropic API key in Railway.</div>'}
      <div class="chat" id="chat">${msgs || empty}${state.sending ? TYPING : ''}</div>
      <div class="composer-dock">
        <div class="quick-replies" role="group" aria-label="Quick replies">${quick}</div>
        <form class="composer" data-form="coach">
          <label class="sr" for="coach-text">Message</label>
          <textarea id="coach-text" class="input" name="text" rows="1" maxlength="4000" placeholder="Message the coach" required>${esc(ask)}</textarea>
          <button class="btn primary send" type="submit" aria-label="Send"${state.sending ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
        </form>
      </div>`);
  // The chat ends at the composer, so the newest message sits just above it.
  motion.chatToEnd();
}

// ---------- Review ----------

const signed = (n) => (n > 0 ? `+${n}` : String(n));

function weekStats(w) {
  const hp = w.hpStart !== null && w.hpEnd !== null ? `${w.hpStart} to ${w.hpEnd}` : '-';
  return `<div class="stats four">
    <div class="stat"><b>${w.cleanDays}</b><span>Clean ${w.cleanDays === 1 ? 'day' : 'days'} of ${w.judgedDays}</span></div>
    <div class="stat"><b>${hp}</b><span>HP</span></div>
    <div class="stat"><b>${w.focusMin ? fmtMin(w.focusMin) : '0'}</b><span>Focus time</span></div>
    <div class="stat"><b>${w.tasksDone}</b><span>Tasks done</span></div>
  </div>
  ${w.dodges.length ? `<p class="small muted" style="margin-top:10px">"Not now" reasons: ${w.dodges.map((d) => `${esc(d.reason)} (${d.n})`).join(', ')}.</p>` : ''}`;
}

function reviewCard(r) {
  const rv = r.review;
  const w = r.lastWeek;
  if (rv.doneAt) {
    return `<section class="section"><div class="gh"><h2>Week of ${fmtDay(rv.weekStart)}</h2><span class="gh-count">Reviewed</span></div>
      <div class="card"><p>This week's focus: <b>${esc(rv.focus)}</b></p>${rv.obstaclePlan ? `<p class="small muted" style="margin-top:6px">${esc(rv.obstaclePlan)}</p>` : ''}
      ${rv.coachText ? `<details style="margin-top:10px"><summary class="small">Coach's review</summary><div class="plan-text rich">${richHtml(rv.coachText)}</div></details>` : ''}</div></section>`;
  }
  if (!w.judgedDays) {
    return `<section class="section"><div class="gh"><h2>Weekly review</h2></div>
      <div class="card muted">Opens on Monday.</div></section>`;
  }
  const rows = w.habits.map((h) => {
    const d = state.decisions[h.id] || 'keep';
    const opts = ['keep', 'adjust', 'drop'].map((o) => `<label><input type="radio" name="d-${h.id}" value="${o}"${d === o ? ' checked' : ''} data-decide="${h.id}"><span>${o[0].toUpperCase()}${o.slice(1)}</span></label>`).join('');
    return `<div class="review-row">
      <div><span class="li-title">${esc(h.name)}</span>
        <span class="li-sub">${h.flexible ? `${h.done} of ${h.target} this week` : `kept ${h.done} of ${h.target}`}${h.minimum ? `, ${h.minimum} minimum` : ''}${h.missed ? `, ${h.missed} missed` : ''}. Strength ${h.strength}% (${signed(h.trend)})</span></div>
      <div class="seg small" role="radiogroup" aria-label="Decision for ${esc(h.name)}">${opts}</div>
    </div>`;
  }).join('');
  return `<section class="section"><div class="gh"><h2>Weekly review</h2><span class="gh-count">Week of ${fmtDay(rv.weekStart)}</span></div>
    <div class="card review">
      ${rv.coachText ? `<div class="plan-text rich">${richHtml(rv.coachText)}</div>` : `<button class="btn tinted" data-action="review-write">${icon('coach')}Let the coach pre-fill it</button>`}
      ${weekStats(w)}
      <form data-form="review-finish">
        ${rows ? `<h3 style="margin-top:18px">Each habit: keep, adjust or drop</h3>${rows}` : ''}
        <label class="field"><span>This week's one or two things that matter most</span><input class="input" name="focus" maxlength="300" required autocomplete="off"></label>
        <label class="field"><span>If-then plan for the week's biggest obstacle</span><input class="input" name="obstaclePlan" maxlength="300" autocomplete="off" placeholder="If I skip Monday's gym, then I go Tuesday at 7:00"></label>
        <div class="form-actions"><button class="btn primary" type="submit">Finish the review</button></div>
      </form>
    </div></section>`;
}

// HP over the last 30 days as a filled line on a fixed 0 to max scale, deaths marked at 0.
function hpArea(days, maxHp) {
  if (days.length < 2) return '<p class="muted small">Not enough days yet</p>';
  const w = 300;
  const h = 84;
  const step = w / (days.length - 1);
  const y = (hp) => (h - 4 - (Math.max(0, hp) / maxHp) * (h - 10)).toFixed(1);
  const pts = days.map((d, i) => `${(i * step).toFixed(1)} ${y(d.hp_end)}`);
  const line = `M${pts.join(' L')}`;
  const deaths = days.map((d, i) => (d.hp_end <= 0 ? `<line x1="${(i * step).toFixed(1)}" x2="${(i * step).toFixed(1)}" y1="0" y2="${h}" class="hp-death"/>` : '')).join('');
  const low = days.reduce((a, d) => (d.hp_end < a.hp_end ? d : a), days[0]);
  const label = `HP at the end of each of the last ${days.length} days, from ${days[0].hp_end} to ${days[days.length - 1].hp_end}, lowest ${low.hp_end} on ${fmtDay(low.date)}.`;
  return `<svg class="hp-area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">
    <defs><linearGradient id="hp-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:rgba(225,6,0,0.45)"/><stop offset="1" style="stop-color:rgba(225,6,0,0)"/></linearGradient></defs>
    ${deaths}<path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#hp-fill)"/><path d="${line}" class="hp-line"/></svg>
    <div class="bc-axis" aria-hidden="true"><span>${fmtDay(days[0].date)}</span><span class="last">${fmtDay(days[days.length - 1].date)}</span></div>`;
}

// The season at the head of the review: HP now and over 30 days, pardons, and the longest streaks.
function seasonCard(s) {
  if (!s) return '';
  const g = s.game;
  const streaks = s.streaks.map((x) => `<li><span class="li-ic">${icon('flame')}</span><span class="streak-name">${esc(x.name)}</span><b>${x.streak}</b><span class="faint small">${x.weekly ? (x.streak === 1 ? 'week' : 'weeks') : (x.streak === 1 ? 'day' : 'days')}</span></li>`).join('');
  return `<section class="section season" id="season">
    <div class="gh"><h2>Season ${g.season}</h2><span class="gh-count">Day ${s.seasonDay}${g.deaths ? `, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'} so far` : ''}</span></div>
    <div class="card season-card${g.hp <= 30 ? ' low' : ''}">
      <div class="season-top">
        <div class="season-hp"><b data-count="season-hp">${g.hp}</b><span>of ${g.maxHp} HP</span></div>
        <dl class="season-stats">
          <div><dt>Pardons</dt><dd><b>${g.pardonsLeft}</b> left this month</dd></div>
        </dl>
      </div>
      ${hpArea(s.days, g.maxHp)}
      ${streaks ? `<p class="season-sub">Longest streaks</p><ul class="streaks">${streaks}</ul>` : ''}
    </div>
  </section>`;
}

function viewReview() {
  const r = state.review;
  if (!r) return shell(skeleton('Review'));
  const strengthRows = r.habitStrength.map((h) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(h.name)}</span><span class="li-sub">Kept ${h.kept14} of ${h.sched14} in 14 days</span></span><span class="li-side">${strengthChip(h.strength)}</span></div>`).join('');
  const dayRows = r.days.slice(0, 30).map((d) => `<tr><td>${fmtDay(d.date)}${d.rest ? ' <span class="faint">rest</span>' : ''}</td><td class="num">${d.kept}</td><td class="num">${d.missed ? `<span class="bad">${d.missed}</span>` : 0}</td><td class="num">${d.hp_end}${d.bonus ? ` <span class="faint">(+${d.bonus})</span>` : ''}</td></tr>`).join('');
  const missRows = r.misses.slice(0, 40).map((m) => `<div class="li li-plain">
      <span class="li-body"><span class="li-title">${esc(m.title)}</span>${m.pardoned || m.overturned ? `<span class="li-sub">${m.overturned ? 'Overturned by Apple Health' : `Pardoned: ${esc(m.reason)}${m.plan ? `<br>Plan: ${esc(m.plan)}` : ''}`}</span>` : ''}</span>
      <span class="li-side small">${fmtDay(m.date)}<br>${m.overturned ? '<span class="good">overturned</span>' : m.pardoned ? 'pardoned' : `<span class="bad">minus ${m.hpLost}${m.repeat ? ', twice' : ''}</span>`}</span></div>`).join('');
  const deaths = r.deaths.map((d) => `<div class="li li-plain"><span class="li-body"><span class="li-title">Killed by ${esc(d.cause)}</span></span><span class="li-side small faint">${fmtDay(d.date)}, season ${d.season - 1} ended</span></div>`).join('');
  const stale = r.stale.map((k) => `<div class="triage-row"><span class="li-title">${esc(k.title)}</span>
      <div class="triage-actions" role="group" aria-label="Decide">
        <button class="btn tinted small" data-action="triage" data-do="week" data-id="${k.id}">Next week</button>
        <button class="btn tinted small" data-action="triage" data-do="someday" data-id="${k.id}">Someday</button>
        <button class="btn plain small danger-text" data-action="triage" data-do="drop" data-id="${k.id}">Drop</button>
      </div></div>`).join('');

  shell(`${pageHead('Review', { actions: iconLink('#/settings', 'settings', 'Settings') })}
    <div class="split"><div>
      ${seasonCard(state.season)}
      ${reviewCard(r)}
      <section class="section"><div class="gh"><h2>This week so far</h2></div><div class="card">${weekStats(r.thisWeek)}</div></section>
      ${stale ? `<section class="section"><div class="gh"><h2>Clear the backlog</h2><span class="gh-count">${r.stale.length}</span></div><div class="card triage">${stale}</div></section>` : ''}
      <section class="section"><div class="gh"><h2>Habit strength</h2></div>
        ${strengthRows ? `<div class="group">${strengthRows}</div>` : emptyState({ icon: 'plan', title: 'No habits yet', small: true })}
      </section>
    </div><aside>
      ${goalsStrip(r.goals)}
      <section class="section"><div class="gh"><h2>Days</h2></div>
        ${dayRows ? `<div class="card flush table-wrap"><table class="table"><thead><tr><th>Day</th><th class="num">Kept</th><th class="num">Missed</th><th class="num">HP</th></tr></thead><tbody>${dayRows}</tbody></table></div>` : '<div class="card muted">Your first day closes at midnight.</div>'}
      </section>
      <section class="section"><div class="gh"><h2>Misses</h2><span class="gh-count">${r.misses.length}</span></div>
        ${missRows ? `<div class="group">${missRows}</div>` : '<div class="card muted">No misses yet.</div>'}</section>
      ${deaths ? `<section class="section"><div class="gh"><h2>Deaths</h2></div><div class="group">${deaths}</div></section>` : ''}
    </aside></div>`);
}

// ---------- Settings ----------

function pushCard() {
  const p = state.push;
  let status;
  let action = '';
  if (!p.supported) {
    status = isIOS() && !isStandalone()
      ? 'Add Oath to your Home Screen first: Share, then Add to Home Screen.'
      : 'This browser has no push notifications.';
  } else if (p.permission === 'denied') {
    status = 'Blocked. Turn them on in iOS Settings, Notifications, Oath.';
  } else if (p.subscribed) {
    const devices = p.devices == null ? '' : ` · ${p.devices} ${p.devices === 1 ? 'device' : 'devices'}`;
    status = `On for this device${devices}`;
    action = '<button class="btn tinted" data-action="push-test">Send a test</button><button class="btn tinted" data-action="push-off">Turn off on this device</button>';
  } else {
    status = 'Off on this device';
    action = '<button class="btn primary" data-action="push-on">Turn on reminders</button>';
  }
  return settingsCard('bell', 'Reminders', `<p class="muted">${status}</p>${action ? `<div class="form-actions">${action}</div>` : ''}`);
}

function settingsCard(ic, title, body, id = '') {
  return `<div class="card scard"${id ? ` id="${id}"` : ''}><h3 class="scard-h"><span class="sic sic-${ic}">${icon(ic)}</span>${title}</h3>${body}</div>`;
}

// His body sets his daily needs, and every food percentage is a share of them (nutrition.js personalNeeds).
const NEED_ROWS = [['kcal', 'Energy'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['fibre', 'Fibre'], ['sugars', 'Sugars, at most'], ['satfat', 'Saturates, at most'], ['salt', 'Salt, at most']];
const MICRO_NEEDS = ['calcium', 'iron', 'magnesium', 'potassium', 'zinc', 'vitc', 'vitd', 'b12', 'folate'];
function bodyCard() {
  const b = state.body?.body || {};
  const n = state.body?.needs;
  const opt = (list, cur) => Object.entries(list).map(([k, x]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
  const amount = (k) => `${fmtInt(n.refs[k])}${NUTRIENT[k].unit === 'kcal' ? ' kcal' : ` ${NUTRIENT[k].unit}`}`;
  const needs = n ? `<div class="need-grid">${NEED_ROWS.map(([k, label]) => `<div class="need"><span>${label}</span><b>${amount(k)}</b></div>`).join('')}</div>
      <p class="need-how small">${n.about.method === 'Katch-McArdle' ? `Resting ${fmtInt(n.about.rest)} kcal from ${fmtDec(n.about.lean)} kg lean mass` : `Resting ${fmtInt(n.about.rest)} kcal from height, weight and age`}, × ${n.about.factor} for activity. Protein ${n.about.proteinPerKg} g per kg.</p>
      <details class="need-more"><summary>Vitamins and minerals</summary><div class="need-grid">${MICRO_NEEDS.map((k) => `<div class="need"><span>${esc(NUTRIENT[k].label)}</span><b>${fmtDec(n.refs[k])} ${NUTRIENT[k].unit}</b></div>`).join('')}</div>
        <p class="need-how small">EFSA values for a ${n.about.age}-year-old ${n.about.sex === 'female' ? 'woman' : 'man'}.</p></details>`
    : '<p class="muted small">Fill these in and every food percentage becomes a share of what your body needs.</p>';
  return settingsCard('scale', 'Body', `<form data-form="body">
      <div class="grid2">
        <label class="field"><span>Sex</span><select class="input" name="sex" required><option value="">Choose</option><option value="male"${b.sex === 'male' ? ' selected' : ''}>Male</option><option value="female"${b.sex === 'female' ? ' selected' : ''}>Female</option></select></label>
        <label class="field"><span>Born</span><input class="input" type="date" name="birthDate" value="${esc(b.birthDate || '')}" required></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Height, cm</span><input class="input" name="heightCm" inputmode="decimal" value="${esc(b.heightCm ?? '')}" required></label>
        <label class="field"><span>Weight, kg</span><input class="input" name="weightKg" inputmode="decimal" value="${esc(b.weightKg ?? '')}" required></label>
        <label class="field"><span>Body fat, %</span><input class="input" name="bodyFat" inputmode="decimal" value="${esc(b.bodyFat ?? '')}" placeholder="Optional"></label>
      </div>
      <label class="field"><span>Activity</span><select class="input" name="activity" required><option value="">Choose</option>${opt(ACTIVITY, b.activity)}</select></label>
      <label class="field"><span>Goal</span><select class="input" name="goal">${opt(GOALS, b.goal || 'keep')}</select></label>
      <div class="form-actions"><button class="btn primary" type="submit">Save</button></div>
    </form>
    <div class="body-needs"><h4 class="need-h">Your daily needs</h4>${needs}</div>`, 'body');
}

// Sounds belong to the device, not the account: the choice is kept in this browser's storage (sound.js).
function soundsCard() {
  return settingsCard('sound', 'Sounds', `<label class="switch-row"><span class="switch-text"><b>Play sounds on this device</b>
      <span class="muted small">Soft sounds for ticks, meals, messages and errors. On iPhone the silent switch mutes them.</span></span>
      <input class="switch" type="checkbox" role="switch" data-action="sounds"${soundsOn() ? ' checked' : ''}></label>`);
}

function alertsCard(s) {
  const opt = (v, label, hint) => `<label class="radio-row"><input type="radio" name="alerts" value="${v}"${(s.alerts || 'both') === v ? ' checked' : ''}><span><b>${label}</b><br><span class="muted small">${hint}</span></span></label>`;
  return settingsCard('phone', 'Where alerts go', `<form data-form="alerts">
      ${opt('smart', 'One channel per alert', 'Telegram for reminders and briefs, the lock screen for last calls')}
      ${opt('both', 'Everything, everywhere', 'Lock screen and Telegram')}
      ${opt('push', 'App only', 'Telegram stays quiet')}
      <div class="form-actions"><button class="btn primary" type="submit">Save</button></div>
    </form>`);
}

function telegramCard() {
  const tg = state.telegram || {};
  let body;
  let actions = '';
  if (!tg.enabled) {
    body = 'Off: add TELEGRAM_BOT_TOKEN in Railway.';
  } else if (tg.linked) {
    body = `Connected${tg.botUsername ? ` to @${esc(tg.botUsername)}` : ''}. /today, /next, /hp, /add, /done.`;
    actions = '<button class="btn tinted" data-action="tg-test">Send a test</button><button class="btn tinted" data-action="tg-unlink">Disconnect</button>';
  } else {
    body = 'Not connected';
    actions = '<button class="btn primary" data-action="tg-link">Connect Telegram</button>';
    if (tg.linkUrl) body += `. <a href="${esc(tg.linkUrl)}">Open the link</a>`;
  }
  return settingsCard('telegram', 'Telegram', `<p class="muted">${body}</p>${actions ? `<div class="form-actions">${actions}</div>` : ''}`);
}

function siriCard() {
  const host = location.origin;
  const count = state.tokens?.count || 0;
  return settingsCard('mic', 'Siri and Shortcuts', `
    <p class="muted">"Add to Oath", "Oath done", "What's next in Oath". The key also lets Apple Health send data.</p>
    ${keyBlock()}
    <div class="form-actions">
      <button class="btn ${count ? 'tinted' : 'primary'}" data-action="token-new">${count ? 'Make a new key' : 'Make a key'}</button>
      ${count ? '<button class="btn tinted" data-action="token-revoke">Turn off all keys</button>' : ''}
    </div>
    <details class="howto"><summary>Build the "Add to Oath" shortcut</summary>
      <ol>
        <li>Open the Shortcuts app, tap +, and name it <b>Add to Oath</b>.</li>
        <li>Add <b>Ask for Input</b>, type Text, prompt "What should I add?".</li>
        <li>Add <b>Get Contents of URL</b> with URL <code>${esc(host)}/api/shortcut/add</code>. Tap Show More: Method <b>POST</b>; Headers: <b>Authorization</b> = <code>Bearer</code> followed by a space and your key; Request Body <b>JSON</b> with key <b>text</b> set to Provided Input.</li>
        <li>Add <b>Get Dictionary Value</b> for key <b>say</b>, then <b>Show Result</b>.</li>
        <li>Say "Hey Siri, Add to Oath", or put it on the Action button or a Home Screen widget.</li>
      </ol>
      <p class="small">"Oath done": the same, with URL <code>${esc(host)}/api/shortcut/done</code> and prompt "What did you do?". "What's next in Oath": Get Contents of URL with <code>${esc(host)}/api/shortcut/next</code>, Method GET, the same header, then Get Dictionary Value <b>say</b> and Speak Text.</p>
    </details>`);
}

// The game's numbers, editable. Ranges match the server's (src/settings.js), which checks them again.
const RULE_FIELDS = [
  ['maxHp', 'Max HP', 50, 500, 1],
  ['dailyLossCap', 'Most HP one day can cost', 10, 500, 1],
  ['taskPenalty', 'HP a hard task costs', 1, 100, 1],
  ['repeatMultiplier', 'Second miss in a row costs ×', 1, 3, 0.25],
  ['comebackBonus', 'Comeback bonus, HP', 0, 50, 1],
  ['cleanBonus', 'Clean-day bonus, HP', 0, 50, 1],
  ['pardonsPerMonth', 'Pardons a month', 0, 10, 1],
  ['restDaysPerMonth', 'Rest days a month', 0, 10, 1],
  ['maxNonNegotiables', 'Non-negotiables allowed', 1, 10, 1],
  ['undoMinutes', 'Minutes to undo a tick', 1, 120, 1],
];
function rulesForm(s) {
  const fields = RULE_FIELDS.map(([k, label, min, max, step]) => `<label class="field"><span>${label}</span>
      <input class="input" type="number" name="${k}" min="${min}" max="${max}" step="${step}" inputmode="decimal" value="${esc(s[k])}" required></label>`).join('');
  return `<form class="card rules-form" data-form="rules">
    <div class="grid2">${fields}</div>
    <div class="form-actions"><button class="btn primary" type="submit">Save rules</button></div>
  </form>`;
}

function viewSettings() {
  const s = state.settings;
  if (!s) return shell(skeleton('Settings'));
  const connections = settingsCard('link', 'Your data', `
    <div class="group flush">
      ${state.setup ? setupRows(state.setup) : `
      <a class="li li-plain li-nav" href="#/health?section=health"><span class="li-ic">${icon('heart')}</span><span class="li-body"><span class="li-title">Apple Health</span><span class="li-sub">Steps, workouts, sleep, heart</span></span>${icon('chevron', 'chev')}</a>
      <a class="li li-plain li-nav" href="#/health?section=calendars"><span class="li-ic">${icon('calendar')}</span><span class="li-body"><span class="li-title">Calendars and VLE deadlines</span><span class="li-sub">Google, iCloud, Outlook, UM VLE</span></span>${icon('chevron', 'chev')}</a>`}
      <a class="li li-plain li-nav" href="#/health?section=business"><span class="li-ic">${icon('business')}</span><span class="li-body"><span class="li-title">Business sites</span><span class="li-sub">GoldenStraddler, Exposed FX Journal</span></span>${icon('chevron', 'chev')}</a>
    </div>
    <div class="form-actions"><a class="btn tinted" href="/api/export" download>${icon('download')}Download all my data</a></div>`);
  // Where the food numbers come from: credits and licences live here, not on the screens.
  const src = (name, what, licence, href = '') => `<${href ? `a href="${href}"` : 'div'} class="li li-plain${href ? ' li-nav' : ''}"><span class="li-body"><span class="li-title">${name}</span><span class="li-sub">${what}${licence ? ` · ${licence}` : ''}</span></span>${href ? icon('chevron', 'chev') : ''}</${href ? 'a' : 'div'}>`;
  const sources = settingsCard('food', 'Data sources', `<div class="group flush">
      ${src('USDA FoodData Central', 'Generic foods and their nutrients', 'public domain')}
      ${src('Open Food Facts', 'Packaged products', '© Open Food Facts contributors, ODbL')}
      ${src('Your daily needs', 'Energy: Katch-McArdle or Mifflin-St Jeor × activity; protein: ISSN position stand; vitamins and minerals: EFSA dietary reference values', '', '#/settings?section=body')}
      ${src('EU reference intakes', 'The % RI until your body is set', 'Regulation (EU) 1169/2011, Annex XIII')}
      ${src('Nutri-Score', 'Grades A to E', 'Santé publique France')}
      ${src('NOVA', 'Processing groups 1 to 4', 'Monteiro et al., as given by Open Food Facts')}
      ${src('Recipe library', 'Written for Oath by AI, not kitchen-tested', '')}
      ${src('Coverage report', 'What the catalogue holds', '', '#/food/report')}
    </div>`, 'data-sources');
  shell(`${pageHead('Settings')}
    <div class="split"><div>
      ${bodyCard()}
      ${connections}
      ${faceIdCard()}
      ${pushCard()}
      ${soundsCard()}
      ${alertsCard(s)}
      ${telegramCard()}
      ${siriCard()}
      ${settingsCard('clock', 'Coach schedule', `<form data-form="settings">
          <div class="grid3">
            <label class="field"><span>Morning brief</span><input class="input" type="time" name="morningTime" value="${esc(s.morningTime)}" required></label>
            <label class="field"><span>Midday check</span><input class="input" type="time" name="middayTime" value="${esc(s.middayTime || '13:00')}" required></label>
            <label class="field"><span>Evening check</span><input class="input" type="time" name="eveningTime" value="${esc(s.eveningTime)}" required></label>
          </div>
          <div class="grid2">
            <label class="field"><span>Your day ends at</span><input class="input" type="time" name="dayEnd" value="${esc(s.dayEnd || '22:00')}" required></label>
            <label class="field"><span>Time zone</span><input class="input" name="timezone" value="${esc(s.timezone)}" required></label>
          </div>
          <div class="form-actions"><button class="btn primary" type="submit">Save schedule</button></div>
        </form>`)}
      ${settingsCard('lock', 'Password', `<form data-form="password">
          <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="10" required></label>
          <div class="form-actions"><button class="btn primary" type="submit">Change password</button><button class="btn tinted" type="button" data-action="logout">Log out</button></div>
        </form>`)}
    </div>
    <aside><section class="section"><div class="gh"><h2>Game rules</h2></div>
      ${rulesForm(s)}</section>
      <section class="section">${sources}</section></aside></div>`);
}

// ---------- Gate ----------

// The face of Oath: the mark, the chrome wordmark and the promise, centred.
function brandLockup(size = 76) {
  return `<div class="brand-lockup">${brandMark(size, 'gate-mark')}<div class="wordmark">Oath</div><p class="tagline">Keep your word.</p></div>`;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const calmMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- The lock screen ----------
//
// With Face ID only, Oath opens on a lock screen that asks for Face ID by itself, on launch and each
// time the app comes back from the background. What the platform allows, from WebKit's own source
// (AuthenticatorCoordinator.cpp): navigator.credentials.get() needs no tap, but a page that is not
// focused is refused at once with NotAllowedError, and a newer request cancels the one before it.
// iOS 16 to 17.3 gave each page load one free prompt; 17.4 and later dropped the tap rule altogether.
// So the app waits for focus, asks once per cycle, runs one prompt at a time, and never retries on
// its own after a refusal or a cancel: the next try is a tap anywhere, or the next return from the
// background. States, set on .lock[data-state]: scanning (waiting for Face ID), idle (refused or
// cancelled, button and tap-anywhere offered), unlocking (verified, fading into the app), error and
// offline. The layout is the same in every state, so nothing moves between them.
const door = { busy: false, ctl: null, started: 0, cycle: 0, disarm: null, preparing: null, refresh: 0, locking: null };

const lockEl = () => document.querySelector('.gate.lock');

function scanText() {
  const d = deviceName();
  return d === 'iPhone' || d === 'iPad' ? `Look at your ${d}.` : 'Confirm it is you.';
}

const LOCK_TEXT = {
  scanning: scanText,
  idle: () => 'Tap to unlock.',
  unlocking: () => 'Unlocked.',
  offline: () => 'No connection. Oath needs one to check Face ID.',
  error: () => 'Face ID did not go through. Tap to try again.',
};

function setLock(phase, text) {
  clearTimeout(door.refresh);
  // A tap may come minutes later: keep a fresh challenge ready so the tap goes straight to Face ID.
  if (phase === 'idle' || phase === 'error') door.refresh = setTimeout(() => prepareFaceIdLogin({ force: true }).catch(() => {}), 3 * 60000);
  const root = lockEl();
  if (!root) return;
  root.dataset.state = phase;
  const status = root.querySelector('.lock-status');
  if (status) status.textContent = text ?? LOCK_TEXT[phase]();
  const label = root.querySelector('.lock-btn-label');
  if (label) label.textContent = phase === 'offline' ? 'Try again' : 'Unlock with Face ID';
}

function showLock({ auto = true, offline = false } = {}) {
  if (lockEl()) return;
  abortFaceId();
  // Nothing of the day stays in memory behind the lock.
  Object.assign(state, {
    today: null, plan: null, review: null, coach: null, goals: null, goal: null, settings: null,
    sheet: null, sheetNode: null, sheetMode: null, foodSheet: null, calSheet: null, cal: null, dodging: null, pardoning: null, editingGoal: false,
  });
  document.body.classList.remove('sheet-open');
  window.scrollTo(0, 0);
  const phase = offline ? 'offline' : auto ? 'scanning' : 'idle';
  $app.classList.remove('enter');
  $app.innerHTML = `<div class="gate lock" data-state="${phase}">
    ${brandLockup(84)}
    <div class="lock-stage">
      <div class="lock-glyph" aria-hidden="true">${icon('faceid')}</div>
      <p class="lock-status" role="status" aria-live="polite">${esc(LOCK_TEXT[phase]())}</p>
      <div class="lock-action"><button class="btn chrome big wide" type="button" data-action="faceid-login">${icon('faceid')}<span class="lock-btn-label">${offline ? 'Try again' : 'Unlock with Face ID'}</span></button></div>
    </div>
    <details class="recover"><summary>Lost Face ID?</summary>
      <form data-form="login">
        <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
        <label class="field"><span>Recovery code (SETUP_CODE in Railway)</span><input class="input" name="recovery" autocomplete="off" required></label>
        <div class="form-actions"><button class="btn primary big wide" type="submit">Open with password</button></div>
      </form>
      <p class="note bad" id="gate-error" role="alert" hidden></p></details>
  </div>`;
  const root = lockEl();
  // A tap anywhere on the lock screen starts Face ID, straight from the tap so iOS allows it.
  root.addEventListener('click', (e) => {
    if (e.target.closest('details, a, input, label')) return;
    e.stopPropagation();
    if (['idle', 'error', 'offline'].includes(root.dataset.state)) faceIdLogin();
  });
  if (phase === 'scanning') armAutoFaceId();
  else if (phase === 'idle') { prepareFaceIdLogin().catch(() => {}); setLock('idle'); }
}

// Locks the open app in place, with no reload and no flash of the day, and asks for Face ID.
function lockApp() {
  showLock();
  // The server locks its own session too, so an app closed before unlocking leaves nothing open.
  door.locking = api('POST', '/api/lock', {}).catch(() => {});
}

// Starts Face ID by itself, once, as soon as the page can show it. delay: a beat for an aborted
// prompt to clear first, so two are never open together.
function armAutoFaceId({ delay = 0 } = {}) {
  const cycle = ++door.cycle;
  if (door.disarm) door.disarm();
  const start = () => {
    if (door.disarm) door.disarm();
    if (cycle === door.cycle && lockEl()) faceIdLogin({ auto: true });
  };
  if (document.visibilityState !== 'visible') return; // the visibility handler arms it on return
  prepareFaceIdLogin().catch(() => {});
  if (document.hasFocus()) {
    if (delay) setTimeout(start, delay); else start();
    return;
  }
  // WebKit refuses a prompt while the page is not focused, so wait for focus rather than burn the try.
  const timer = setTimeout(start, 2000);
  const onFocus = () => start();
  window.addEventListener('focus', onFocus);
  door.disarm = () => { clearTimeout(timer); window.removeEventListener('focus', onFocus); door.disarm = null; };
}

function abortFaceId() {
  if (door.disarm) door.disarm();
  door.cycle += 1;
  if (door.ctl) door.ctl.abort();
  door.ctl = null;
  door.busy = false;
}

// The app is back in front with the lock screen up: ask again, unless a prompt has only just opened.
function resumeLock() {
  const root = lockEl();
  if (!root || root.dataset.state === 'unlocking') return;
  if (door.busy && Date.now() - door.started < 3000) return;
  abortFaceId();
  setLock('scanning');
  armAutoFaceId({ delay: 150 });
}

// The server's challenge, fetched ahead so a tap goes straight to Face ID. Challenges last five minutes.
function prepareFaceIdLogin({ force = false } = {}) {
  if (!window.PublicKeyCredential) return Promise.reject(new Error('Face ID is not available.'));
  if (!force && fresh(state.faceIdLogin)) return Promise.resolve(state.faceIdLogin);
  if (!door.preparing) {
    door.preparing = api('POST', '/api/passkey/login/options', {})
      .then((options) => { state.faceIdLogin = { options, at: Date.now() }; return state.faceIdLogin; })
      .finally(() => { door.preparing = null; });
  }
  return door.preparing;
}

// One prompt at a time. auto: started by the app rather than by a tap. A refused or cancelled try
// leaves the button and the tap, and nothing else: no retry loop.
async function faceIdLogin({ auto = false } = {}) {
  if (door.busy) return;
  if (!window.PublicKeyCredential) {
    const msg = 'This browser cannot use Face ID. Open Oath from the Home Screen on your iPhone.';
    if (lockEl()) setLock('error', msg); else gateError(msg);
    return;
  }
  door.busy = true;
  door.started = Date.now();
  const ctl = new AbortController();
  door.ctl = ctl;
  const current = () => door.ctl === ctl;
  setLock('scanning');
  const slotBtn = document.querySelector('#faceid-slot button');
  if (slotBtn) slotBtn.disabled = true;
  let cred;
  try {
    const pre = fresh(state.faceIdLogin) ? state.faceIdLogin : await prepareFaceIdLogin();
    state.faceIdLogin = null;
    cred = await navigator.credentials.get({ publicKey: getOptions(pre.options), signal: ctl.signal });
    await door.locking;
    await api('POST', '/api/passkey/login', { response: credentialJSON(cred) });
  } catch (err) {
    if (!current() || err.name === 'AbortError') return;
    door.busy = false;
    door.ctl = null;
    if (slotBtn) slotBtn.disabled = false;
    prepareFaceIdLogin({ force: true }).catch(() => {});
    const quick = Date.now() - door.started < 700;
    let phase = 'idle';
    let text = 'Face ID could not start. Tap to try again.';
    if (err.status === 0) { phase = 'offline'; text = LOCK_TEXT.offline(); }
    else if (err.status === 429) { phase = 'error'; text = err.message; }
    else if (err.status) { phase = 'error'; text = LOCK_TEXT.error(); }
    else if (err.name === 'NotAllowedError') text = auto && quick ? 'Tap to unlock.' : 'Face ID was cancelled. Tap to try again.';
    if (lockEl()) setLock(phase, text); else gateError(text);
    return;
  }
  door.busy = false;
  door.ctl = null;
  setLock('unlocking');
  await enterApp();
}

// Verified. The day loads behind the lock, the lock dissolves, and the app fades in.
async function enterApp(hash) {
  const calm = calmMotion();
  const gate = document.querySelector('.gate');
  if (hash && location.hash !== hash) history.replaceState(null, '', hash);
  else if (!location.hash) history.replaceState(null, '', '#/today');
  parseHash();
  state.dirty = true; // keeps the side loaders from swapping the screen before it is ready
  const loading = load(state.route).then(() => null, (err) => err);
  const [err] = await Promise.all([loading, calm ? null : pause(320)]);
  if (gate && !calm) {
    gate.classList.add('leaving');
    await pause(200);
  }
  if (err) await go(); else render();
  if (!calm) {
    $app.classList.add('enter');
    setTimeout(() => $app.classList.remove('enter'), 500);
  }
  resyncPush();
}

// The way in. With Face ID only, it is the lock screen. Otherwise it is the password, with Face ID
// offered once a passkey exists. auto: false for a person who has just logged out on purpose.
function renderLogin(session = null, { auto = true } = {}) {
  if (!session) {
    api('GET', '/api/session').then((s) => renderLogin(s, { auto })).catch((err) => {
      if (err.status === 0 && lockModeRemembered()) showLock({ offline: true });
      else renderLogin({}, { auto });
    });
    return;
  }
  rememberLockMode(session.faceIdOnly);
  if (session.faceIdOnly) {
    showLock({ auto });
    return;
  }
  abortFaceId();
  $app.innerHTML = `<div class="gate">
    ${brandLockup()}
    <p>Welcome back, <em class="serif">Daniel</em>. Log in to see today.</p>
    <div id="faceid-slot"></div>
    <form data-form="login">
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required autofocus></label>
      <div class="form-actions"><button class="btn primary big wide" type="submit">Log in</button></div>
      <p class="note bad" id="gate-error" role="alert" hidden></p>
    </form></div>`;
  if (session.faceId) offerFaceId();
}

// The password screen's Face ID button, once a challenge is ready.
async function offerFaceId() {
  try { await prepareFaceIdLogin(); } catch { return; }
  const slot = document.getElementById('faceid-slot');
  if (!slot || slot.querySelector('button')) return;
  slot.innerHTML = `<button class="btn chrome big wide" type="button" data-action="faceid-login">${icon('faceid')}Log in with Face ID</button>
    <p class="note">Or use your password.</p>`;
  slot.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); faceIdLogin(); });
}

// Remembered on the phone so a launch without signal does not show a cached day past the lock.
function rememberLockMode(on) {
  state.faceIdOnly = Boolean(on);
  try { localStorage.setItem('oath.faceIdOnly', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
function lockModeRemembered() {
  try { return localStorage.getItem('oath.faceIdOnly') === '1'; } catch { return false; }
}
// A stray 401 behind a gate that is already up must not rebuild it, or Face ID would start over.
hooks.onUnauthed = () => { if (!document.querySelector('.gate')) renderLogin(); };

function renderSetup(code) {
  $app.innerHTML = `<div class="gate">
    ${brandLockup()}
    <p>Choose the password you will use to open Oath on your iPhone and iPad.</p>
    <form data-form="setup" data-code="${esc(code)}">
      <label class="field"><span>Password, at least 10 characters</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="10" required autofocus></label>
      <label class="field"><span>Same password again</span><input class="input" type="password" name="again" autocomplete="new-password" minlength="10" required></label>
      <div class="form-actions"><button class="btn primary big wide" type="submit">Set password</button></div>
      <p class="note bad" id="gate-error" role="alert" hidden></p>
    </form></div>`;
}

function gateError(msg) {
  const el = document.getElementById('gate-error');
  if (el) { el.textContent = msg; el.hidden = false; }
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
async function fetchToday() {
  try {
    state.today = await api('GET', '/api/today');
    state.offline = null;
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
  // Plan holds the goals too, as its third segment.
  if (route === 'plan') [state.plan] = await Promise.all([api('GET', '/api/plan'), loadGoals()]);
  if (route === 'coach') state.coach = await api('GET', '/api/coach');
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
  if (route === 'settings') {
    state.setup = await api('GET', '/api/setup-status').catch(() => state.setup);
    state.passkeys = (await api('GET', '/api/passkeys')).passkeys;
    if (window.PublicKeyCredential) {
      state.faceIdRegister = await api('POST', '/api/passkey/register/options', {}).then((options) => ({ options, at: Date.now() })).catch(() => null);
    }
    state.settings = await api('GET', '/api/settings');
    state.body = await api('GET', '/api/body').catch(() => state.body);
    state.telegram = { ...(state.telegram || {}), ...(await api('GET', '/api/telegram')) };
    state.tokens = await api('GET', '/api/tokens');
    await refreshPushState();
  }
}

function render() {
  state.dirty = false;
  if (state.route === 'goals') {
    if (state.param === 'new') return viewGoalNew();
    if (state.param) return viewGoal();
    return viewGoals();
  }
  const views = { today: viewToday, calendar: viewCalendar, plan: viewPlan, food: viewFood, coach: viewCoach, review: viewReview, settings: viewSettings, health: viewHealth };
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
  motion.navigate(() => {
    if (top) window.scrollTo({ top: 0 });
    render();
  }, { native });
  try {
    await load(state.route);
    render();
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
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

// ---------- Push ----------

function b64ToBytes(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function refreshPushState() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  state.push = { supported, permission: supported ? Notification.permission : 'default', subscribed: false, devices: null };
  state.push.devices = await api('GET', '/api/push/key').then((k) => k.devices).catch(() => null);
  if (!supported) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  state.push.subscribed = Boolean(sub);
}

// The server's key changes if its database is rebuilt; a subscription made with the old key is dead.
function sameKey(sub, publicKey) {
  const key = sub.options?.applicationServerKey;
  if (!key) return true;
  const mine = new Uint8Array(key);
  const theirs = b64ToBytes(publicKey);
  return mine.length === theirs.length && mine.every((b, i) => b === theirs[i]);
}

async function pushOn() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new ApiError('Notifications were not allowed. Turn them on in iOS Settings, Notifications, Oath.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('POST', '/api/push/subscribe', sub.toJSON());
  return true;
}

async function pushOff() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return true;
}

// iOS never tells the page when a push subscription changes, so re-send it on every launch. If the
// server had dropped it (the push service refused it) or it was made with an old key, replace it.
async function resyncPush() {
  try {
    if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const { publicKey } = await api('GET', '/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, publicKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (sub) {
      const r = await api('POST', '/api/push/subscribe', sub.toJSON());
      if (!r.fresh) return;
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api('POST', '/api/push/subscribe', sub.toJSON());
  } catch { /* try again next launch */ }
}

// ---------- Face ID (passkeys) ----------

const bytesToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createOptions(o) {
  return {
    ...o,
    challenge: b64ToBytes(o.challenge),
    user: { ...o.user, id: b64ToBytes(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: b64ToBytes(x.id) })),
  };
}

function getOptions(o) {
  return { ...o, challenge: b64ToBytes(o.challenge), allowCredentials: (o.allowCredentials || []).map((x) => ({ ...x, id: b64ToBytes(x.id) })) };
}

function credentialJSON(cred) {
  const r = cred.response;
  const response = { clientDataJSON: bytesToB64u(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bytesToB64u(r.attestationObject);
    response.transports = r.getTransports?.() || [];
  } else {
    response.authenticatorData = bytesToB64u(r.authenticatorData);
    response.signature = bytesToB64u(r.signature);
    if (r.userHandle) response.userHandle = bytesToB64u(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: bytesToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response,
  };
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Mac/.test(ua)) return 'Mac';
  return 'This device';
}

// iOS used to show Face ID only for a request that came straight from a tap, so a challenge fetched
// ahead of time goes straight to Face ID. Challenges last five minutes. (Login: see the lock screen.)
const fresh = (pre) => pre && Date.now() - pre.at < 4 * 60000;

async function faceIdAdd(el) {
  el.disabled = true;
  try {
    const pre = fresh(state.faceIdRegister) ? state.faceIdRegister : { options: await api('POST', '/api/passkey/register/options', {}) };
    state.faceIdRegister = null;
    const cred = await navigator.credentials.create({ publicKey: createOptions(pre.options) });
    await api('POST', '/api/passkey/register', { response: credentialJSON(cred), device: deviceName() });
    toast('Face ID is on. Next time, log in with your face.');
    await load('settings');
    render();
  } catch (err) {
    const msg = err.name === 'NotAllowedError' ? 'Face ID setup was cancelled.'
      : err.name === 'InvalidStateError' ? 'This device already logs in to Oath with Face ID.' : err.message;
    toast(msg, true);
    el.disabled = false;
  }
}

function faceIdCard() {
  if (!window.PublicKeyCredential) {
    return settingsCard('faceid', 'Face ID', '<p class="muted">Not available in this browser. Open Oath from the Home Screen.</p>');
  }
  const keys = state.passkeys || [];
  const rows = keys.map((k) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(k.device || 'Device')}</span>
      <span class="li-sub">Added ${fmtDay(String(k.createdAt).slice(0, 10))}${k.lastUsed ? `, last used ${ago(k.lastUsed)}` : ', not used yet'}</span></span>
      <button class="btn tinted small" data-action="faceid-remove" data-id="${esc(k.id)}">Remove</button></div>`).join('');
  const lockOn = state.settings?.faceIdLock !== false;
  // The one line kept: with the lock on, the password alone is not enough to get back in.
  const text = keys.length && lockOn ? 'Password login then needs the recovery code.' : '';
  const lock = keys.length
    ? `<label class="check"><input type="checkbox" data-action="faceid-lock"${lockOn ? ' checked' : ''}> Face ID every time Oath opens</label>`
    : '';
  return settingsCard('faceid', 'Face ID', `${text ? `<p class="muted small">${text}</p>` : ''}
    ${rows ? `<div class="group flush">${rows}</div>` : ''}${lock}
    <div class="form-actions"><button class="btn primary" data-action="faceid-add">${icon('faceid')}${keys.length ? 'Add this device too' : 'Turn on Face ID'}</button></div>`);
}

// ---------- Events ----------

function habitPayload(form) {
  const f = new FormData(form);
  const penalty = f.get('penalty');
  const weekly = f.get('freq') === 'weekly';
  return {
    name: f.get('name'),
    cue: f.get('cue') || '',
    deadline: f.get('deadline'),
    remind_at: f.get('remind_at') || null,
    days: weekly ? undefined : f.getAll('days').map(Number),
    weekly_target: weekly ? Number(f.get('weekly_target')) : null,
    non_negotiable: f.get('non_negotiable') === 'on',
    penalty: penalty === '' ? undefined : Number(penalty),
    minimum: f.get('minimum') || '',
    if_then: f.get('if_then') || '',
    goal_id: f.has('goal_id') ? f.get('goal_id') || null : undefined,
    notes: f.get('notes') || '',
  };
}

// Link (or unlink) a habit to an Apple Health measure, only when that part of the form changed.
async function saveAuto(habitId, form, before) {
  const f = new FormData(form);
  const metric = f.get('auto_metric') || '';
  const target = String(f.get('auto_target') || '').trim();
  const filter = String(f.get('auto_filter') || '').trim();
  const was = before?.auto || null;
  const same = (was?.metric || '') === metric && (!metric || (String(was?.target ?? '') === target && (was?.filter || '') === filter));
  if (same) return true;
  const r = await act(() => api('PATCH', `/api/health/habits/${habitId}`, { metric: metric || null, target: target || null, filter }));
  if (r?.keptNow) toast('Apple Health already shows it done today. Kept.');
  return Boolean(r);
}

function taskPayload(form) {
  const f = new FormData(form);
  const out = { title: f.get('title') };
  if (f.has('due_date')) out.due_date = f.get('due_date') || null;
  if (f.has('deadline')) out.deadline = f.get('deadline') || null;
  if (!form.querySelector('[name="hard"]').disabled) out.hard = f.get('hard') === 'on';
  out.first_step = f.get('first_step') || '';
  out.estimate_min = f.get('estimate_min') || null;
  if (f.has('goal_id')) out.goal_id = f.get('goal_id') || null;
  return out;
}

// Optimistic tick: the row turns green at once, then the server confirms.
async function keepHabit(el, id, minimum = false) {
  const row = el.closest('.li');
  haptic('tick');
  if (row) row.classList.add('kept', 'pending');
  motion.ticked(row);
  el.disabled = true;
  const ok = await act(() => api('POST', `/api/habits/${id}/keep`, { minimum }));
  if (ok) {
    state.dodging = null;
    if (state.sheet?.kind === 'dodge') state.sheet = null;
    await afterTick(ok.reaction);
  } else {
    if (row) row.classList.remove('kept', 'pending');
    el.disabled = false;
  }
}

// The coach may have changed tasks, habits or settings: reload what it touched, in the background.
async function coachChangedThings(reply) {
  if (!reply?.actions?.some((x) => x.ok)) return;
  state.plan = null;
  state.goals = null;
  state.dash = null;
  await fetchToday().catch(() => { state.today = null; });
  if (!['today', 'coach'].includes(state.route)) await load(state.route).catch(() => {});
}

// After a tick: the Today ring pulses, the day is reloaded, and the reaction says how much is left.
async function afterTick(reaction, current = false) {
  state.justTicked = true;
  const wasOpen = state.today?.progress?.open || 0;
  // The day reloads while the check finishes drawing; then the list settles into its new order.
  const other = current && state.route !== 'today';
  await Promise.all([other ? load(state.route) : fetchToday(), motion.tickSettled()]);
  if (other || state.route === 'today') render();
  const open = state.today?.progress?.open;
  // The last thing due today: a chord and a burst, once. On Today the chord comes from the ring as it
  // closes (today.js), so the burst waits for the same moment; elsewhere both come at once.
  if (wasOpen > 0 && open === 0) {
    if (state.route === 'today') setTimeout(() => motion.celebrate(), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : RING_MS);
    else {
      fx('all-done');
      motion.celebrate();
    }
  }
  const tail = open === 0 ? ' Everything due today is done.' : open ? ` ${open} to go.` : '';
  // The server's reaction may already say the day is done; it is said once.
  if (reaction?.text) react({ ...reaction, text: reaction.text.includes(tail.trim()) ? reaction.text : `${reaction.text}${tail}` });
  else if (tail) toast(tail.trim());
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

// A habit's history opens from its strength ring or the History toggle, and stays as it was left.
const shownHistory = new Map();
function historyOpen(id) {
  if (!shownHistory.has(id)) {
    let open = false;
    try { open = localStorage.getItem(`oath.history.${id}`) === '1'; } catch { /* storage unavailable */ }
    shownHistory.set(id, open);
  }
  return shownHistory.get(id);
}
function toggleHistory(id) {
  const open = !historyOpen(id);
  shownHistory.set(id, open);
  try { localStorage.setItem(`oath.history.${id}`, open ? '1' : '0'); } catch { /* storage unavailable */ }
  const card = $app.querySelector(`.hcard[data-habit="${id}"]`);
  if (!card) return;
  card.classList.toggle('history-open', open);
  card.querySelector('.hcard-heat').hidden = !open;
  card.querySelectorAll('[data-action="habit-history"]').forEach((b) => b.setAttribute('aria-expanded', String(open)));
}

// Taps for the layout's own pieces: the oath and briefs sheets and a habit's history.
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
  if (a === 'habit-history') {
    toggleHistory(Number(el.dataset.id));
    return true;
  }
  return false;
}

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  const a = el.dataset.action;
  if (await goalsClick(a, el)) return;
  if (await dataClick(a, el)) return;
  if (await foodClick(a, el)) return;
  if (await calendarClick(a, el)) return;
  if (await layoutClick(a, el)) return;
  if (a === 'keep') {
    await keepHabit(el, id);
  } else if (a === 'keep-minimum') {
    await keepHabit(el, id, true);
  } else if (a === 'undo') {
    haptic('untick');
    if (await act(() => api('POST', `/api/habits/${id}/undo`, {}), 'Undone.')) await refreshToday();
  } else if (a === 'task-done') {
    haptic('tick');
    const row = el.closest('.li');
    if (row) row.classList.add('done', 'pending');
    motion.ticked(row);
    const ok = await act(() => api('POST', `/api/tasks/${id}/done`, {}));
    if (ok) await afterTick(ok.reaction, true); else if (row) row.classList.remove('done', 'pending');
  } else if (a === 'task-undo') {
    haptic('untick');
    if (await act(() => api('POST', `/api/tasks/${id}/undo`, {}), 'Undone.')) await refreshToday();
  } else if (a === 'triage') {
    const labels = { today: 'Moved to today.', tomorrow: 'Moved to tomorrow.', week: 'Moved to next Monday.', someday: 'Moved to someday.', drop: 'Dropped.' };
    if (await act(() => api('POST', `/api/tasks/${id}/triage`, { action: el.dataset.do }), labels[el.dataset.do])) await refreshCurrent();
  } else if (a === 'dur') {
    state.focusMinutes = Number(el.dataset.min);
    render();
  } else if (a === 'focus-start') {
    el.disabled = true;
    haptic();
    const r = await act(() => api('POST', '/api/focus', { kind: el.dataset.kind, id, minutes: state.focusMinutes }), `Clock is running. ${state.focusMinutes} minutes. Phone down.`);
    if (r) await refreshToday(); else el.disabled = false;
  } else if (a === 'focus-done' || a === 'focus-stop') {
    el.disabled = true;
    if (a === 'focus-done') haptic('tick');
    const r = await act(() => api('POST', `/api/focus/${id}/finish`, { outcome: a === 'focus-done' ? 'done' : 'stopped' }));
    if (r) { react(r.reaction); await refreshToday(); } else el.disabled = false;
  } else if (a === 'now-done') {
    el.disabled = true;
    haptic('tick');
    // Its row in the list ticks at the same moment, so both places agree.
    const row = $app.querySelector(`.group > [data-key="${el.dataset.kind === 'habit' ? 'h' : 't'}${id}"]`);
    const cls = el.dataset.kind === 'habit' ? 'kept' : 'done';
    row?.classList.add(cls, 'pending');
    motion.ticked(row);
    const path = el.dataset.kind === 'habit' ? `/api/habits/${id}/keep` : `/api/tasks/${id}/done`;
    const r = await act(() => api('POST', path, {}));
    if (r) await afterTick(r.reaction);
    else {
      el.disabled = false;
      row?.classList.remove(cls, 'pending');
    }
  } else if (a === 'not-now') {
    state.dodging = { kind: el.dataset.kind, id };
    render();
  } else if (a === 'dodge-cancel') {
    state.dodging = null;
    if (state.sheet?.kind === 'dodge') state.sheet = null;
    toast('Good. Start it now.');
    render();
  } else if (a === 'coach-quick') {
    // A quick reply goes out as if typed.
    const form = $app.querySelector('form[data-form="coach"]');
    const box = form?.elements.namedItem('text');
    if (!box || state.sending) return;
    box.value = el.dataset.text;
    form.requestSubmit();
  } else if (a === 'plan-tab') {
    state.planTab = el.dataset.tab;
    render();
  } else if (a === 'sheet') {
    await openSheet(el.dataset.kind, id || null);
  } else if (a === 'sheet-dismiss' || a === 'edit-cancel') {
    closeSheet();
  } else if (a === 'rest-cancel') {
    if (await act(() => api('DELETE', `/api/rest/${el.dataset.date}`), 'Rest day cancelled.')) await refreshCurrent();
  } else if (a === 'review-write') {
    el.disabled = true;
    toast('The coach is writing your review');
    if (await act(() => api('POST', '/api/review/write', {}))) await refreshCurrent(); else el.disabled = false;
  } else if (a === 'tg-link') {
    const r = await act(() => api('POST', '/api/telegram/link', {}));
    if (r) {
      state.telegram = { ...state.telegram, linkUrl: r.url };
      render();
      window.location.href = r.appUrl || r.url;
    }
  } else if (a === 'tg-test') {
    await act(() => api('POST', '/api/telegram/test', {}), (r) => (r.sent ? 'Sent. Check Telegram.' : 'Not linked yet.'));
  } else if (a === 'tg-unlink') {
    if (!confirm('Disconnect Telegram?')) return;
    if (await act(() => api('POST', '/api/telegram/unlink', {}), 'Telegram disconnected.')) { await load('settings'); render(); }
  } else if (a === 'token-new') {
    const r = await act(() => api('POST', '/api/tokens', { label: 'Shortcuts' }));
    if (r) { rememberKey(r.token); state.tokens = { count: (state.tokens?.count || 0) + 1 }; render(); }
  } else if (a === 'key-hide') {
    rememberKey(null);
    render();
  } else if (a === 'token-revoke') {
    if (!confirm('Turn off every key? Your shortcuts and Apple Health sync stop until you make a new key.')) return;
    if (await act(() => api('DELETE', '/api/tokens'), 'All keys turned off.')) { rememberKey(null); await load(state.route); render(); }
  } else if (a === 'copy') {
    const input = document.getElementById(el.dataset.target);
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Copied.');
    } catch {
      input.select();
      toast('Select and copy it by hand.');
    }
  } else if (a === 'pardon') {
    state.pardoning = id;
    render();
    document.querySelector('.pardon-form textarea')?.focus();
  } else if (a === 'pardon-cancel') {
    state.pardoning = null;
    render();
  } else if (a === 'remove-habit') {
    // One tap, no dialog: Undo sits on the Plan screen until the next change.
    const r = await act(() => api('DELETE', `/api/habits/${id}`));
    if (r) {
      state.sheet = null;
      state.removed = { id, name: r.name, at: Date.now() };
      await go();
    }
  } else if (a === 'restore-habit') {
    const r = await act(() => api('POST', `/api/habits/${id}/restore`, {}));
    if (r) { state.removed = null; toast(`Kept ${r.name}.`); await go(); }
  } else if (a === 'delete-task') {
    if (!confirm('Delete this task?')) return;
    if (await act(() => api('DELETE', `/api/tasks/${id}`), 'Deleted.')) { state.sheet = null; await go(); }
  } else if (a === 'brief') {
    el.disabled = true;
    toast('Writing the brief');
    const r = await act(() => api('POST', `/api/briefs/${el.dataset.kind}`, {}));
    el.disabled = false;
    if (r) {
      state.coach.messages.push({ role: 'assistant', text: r.text, at: new Date().toISOString() });
      render();
      fx('receive');
      state.today = null;
    }
  } else if (a === 'coach-confirm') {
    // Daniel's tap on something the coach asked to do: run it or cancel it, then show the outcome.
    el.disabled = true;
    const r = await act(() => api('POST', `/api/coach/pending/${id}`, { confirm: el.dataset.yes === '1' }));
    if (!r) { el.disabled = false; return; }
    toast(r.status === 'done' ? r.text : r.status === 'cancelled' ? 'Cancelled.' : r.text, r.status === 'failed');
    const settle = (m) => (m?.pending || []).forEach((p) => { if (p.id === id) { p.status = r.status; p.outcome = r.text; } });
    if (state.sheet?.kind === 'coach') settle(state.sheet.reply);
    state.coach?.messages.forEach(settle);
    if (state.coach && r.message) state.coach.messages.push(r.message);
    await coachChangedThings({ actions: [{ ok: r.status === 'done' }] });
    render();
  } else if (a === 'retry') {
    location.reload();
  } else if (a === 'faceid-login') {
    await faceIdLogin();
  } else if (a === 'faceid-add') {
    await faceIdAdd(el);
  } else if (a === 'faceid-lock') {
    const on = el.checked;
    const r = await act(() => api('PATCH', '/api/settings', { faceIdLock: on }),
      on ? 'Oath now opens with Face ID only.' : 'Face ID lock is off. The password works on its own again.');
    if (r) {
      state.settings = r;
      rememberLockMode(on && (state.passkeys || []).length > 0);
      render();
    } else {
      el.checked = !on;
    }
  } else if (a === 'sounds') {
    // A setting of this device only. Turning them on clicks, so it can be heard straight away.
    setSounds(el.checked);
    if (el.checked) fx('toggle');
  } else if (a === 'faceid-remove') {
    if (!confirm('Remove Face ID login for this device? The password keeps working.')) return;
    if (await act(() => api('DELETE', `/api/passkeys/${encodeURIComponent(el.dataset.id)}`), 'Face ID removed for that device.')) {
      await load('settings');
      render();
    }
  } else if (a === 'push-on') {
    if (await act(pushOn, 'Reminders are on for this device.')) { await refreshPushState(); render(); }
  } else if (a === 'push-off') {
    if (await act(pushOff, 'Reminders are off for this device.')) { await refreshPushState(); render(); }
  } else if (a === 'push-test') {
    await act(() => api('POST', '/api/push/test', {}), (r) => (r.sent ? 'Test sent. It should arrive in a few seconds.' : 'No device is registered. Turn reminders on again.'));
  } else if (a === 'logout') {
    await act(() => api('POST', '/api/logout', {}));
    try { localStorage.removeItem(TODAY_CACHE); } catch { /* storage unavailable */ }
    renderLogin(null, { auto: false });
  }
});

$app.addEventListener('change', (e) => {
  const d = e.target.closest('[data-decide]');
  if (d) state.decisions[d.dataset.decide] = d.value;
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
    if (await calendarSubmit(kind, form)) return;
    if (kind === 'login') {
      try {
        await api('POST', '/api/login', form2obj(form));
        await enterApp('#/today');
      } catch (err) { gateError(err.message); }
    } else if (kind === 'setup') {
      const { password, again } = form2obj(form);
      if (password !== again) { gateError('The two passwords are different.'); return; }
      try {
        await api('POST', '/api/setup', { code: form.dataset.code, password });
        history.replaceState(null, '', '/#/plan');
        toast('Password set. Add your first habit.');
        await go();
      } catch (err) { gateError(err.message); }
    } else if (kind === 'oath') {
      await takeOath(form);
    } else if (kind === 'defer') {
      const f = new FormData(form);
      const reason = (f.get('own') || '').trim() || f.get('reason') || '';
      const r = await act(() => api('POST', '/api/defer', { kind: form.dataset.kind, id: Number(form.dataset.id), reason, moveToTomorrow: f.get('move') === 'on' }));
      if (r) {
        state.dodging = null;
        if (state.sheet?.kind === 'dodge') state.sheet = null;
        react(r.reaction);
        await refreshToday();
      }
    } else if (kind === 'reflect') {
      const r = await act(() => api('POST', '/api/reflection', form2obj(form)), 'Day closed.');
      if (r) await refreshToday();
    } else if (kind === 'quick-task') {
      const text = form2obj(form).title;
      const r = await act(() => api('POST', '/api/capture', { text }));
      if (r) {
        haptic('success');
        toast(r.say);
        form.reset();
        form.querySelector('.parse-preview').innerHTML = '';
        await refreshCurrent();
      }
    } else if (kind === 'pardon') {
      const f = form2obj(form);
      const r = await act(() => api('POST', `/api/misses/${form.dataset.id}/pardon`, { reason: f.reason, plan: f.plan }), (x) => `Pardoned. ${x.pardonsLeft} left this month.`);
      if (r) { state.pardoning = null; await refreshToday(); }
    } else if (kind === 'new-habit') {
      const r = await act(() => api('POST', '/api/habits', habitPayload(form)), (x) => (x.startsToday ? 'Habit added. It counts from today.' : 'Habit added. Today\'s deadline has passed, so it starts tomorrow.'));
      if (r) {
        await saveAuto(r.habit.id, form, null);
        state.sheet = null;
        await go();
      }
    } else if (kind === 'edit-habit') {
      const before = state.plan?.habits.find((h) => h.id === Number(form.dataset.id));
      const r = await act(() => api('PATCH', `/api/habits/${form.dataset.id}`, habitPayload(form)), (x) => (x.effective === 'now' ? 'Saved.' : `Saved. New rules start ${fmtDay(x.effective)}.`));
      if (r && (await saveAuto(Number(form.dataset.id), form, before))) { state.sheet = null; await go(); }
    } else if (kind === 'new-task') {
      if (await act(() => api('POST', '/api/tasks', taskPayload(form)), 'Task added.')) { state.sheet = null; await go(); }
    } else if (kind === 'edit-task') {
      if (await act(() => api('PATCH', `/api/tasks/${form.dataset.id}`, taskPayload(form)), 'Saved.')) { state.sheet = null; await go(); }
    } else if (kind === 'rest') {
      const f = form2obj(form);
      if (await act(() => api('POST', '/api/rest', f), `Rest day booked for ${fmtDay(f.date)}.`)) await refreshCurrent();
    } else if (kind === 'review-finish') {
      const f = form2obj(form);
      const decisions = {};
      for (const [k, val] of Object.entries(f)) if (k.startsWith('d-')) decisions[k.slice(2)] = val;
      const r = await act(() => api('POST', '/api/review/finish', { decisions, focus: f.focus, obstaclePlan: f.obstaclePlan }), 'Review done. The week starts now.');
      if (r) {
        state.decisions = {};
        if (r.adjust?.length) {
          state.sheet = { kind: 'habit', id: r.adjust[0] };
          location.hash = '#/plan';
        } else await refreshCurrent();
      }
    } else if (kind === 'coach') {
      const text = form2obj(form).text.trim();
      if (!text) return;
      state.coach.messages.push({ role: 'user', text, at: new Date().toISOString() });
      state.sending = true;
      if (state.query.has('ask')) history.replaceState(null, '', '#/coach');
      state.query = new URLSearchParams();
      render();
      haptic('send');
      const r = await act(() => api('POST', '/api/coach', { text }));
      state.sending = false;
      if (r) state.coach.messages.push(r.reply);
      render();
      if (r) fx('receive');
      await coachChangedThings(r?.reply);
    } else if (kind === 'ask-coach') {
      // The quick line on Today and Plan: the answer, and what the coach did, open in a sheet.
      const text = form2obj(form).text.trim();
      if (!text) return;
      form.reset();
      state.sheet = { kind: 'coach', text };
      render();
      haptic('send');
      const r = await act(() => api('POST', '/api/coach', { text }));
      if (!r) { state.sheet = null; render(); return; }
      state.sheet = { kind: 'coach', text, reply: r.reply };
      state.coach = null;
      await coachChangedThings(r.reply);
      render();
      fx('receive');
    } else if (kind === 'rules') {
      const f = form2obj(form);
      const patch = Object.fromEntries(Object.entries(f).filter(([k, x]) => x !== '' && Number(x) !== Number(state.settings?.[k])).map(([k, x]) => [k, Number(x)]));
      if (!Object.keys(patch).length) { toast('Nothing changed.'); return; }
      if (patch.maxHp !== undefined && patch.maxHp < (state.settings?.maxHp ?? 0)
        && !confirm(`Lower max HP to ${patch.maxHp}? If you have more HP than that now, it comes down with it.`)) return;
      if (await act(() => api('PATCH', '/api/settings', patch), 'Rules saved. They apply from now on.')) await go();
    } else if (kind === 'body') {
      const r = await act(() => api('PUT', '/api/body', form2obj(form)));
      if (r) {
        state.body = r;
        state.food = null;
        toast(r.needs ? `Saved. You need about ${fmtInt(r.needs.refs.kcal)} kcal and ${r.needs.refs.protein} g of protein a day.` : 'Saved.');
        render();
      }
    } else if (kind === 'settings') {
      if (await act(() => api('PATCH', '/api/settings', form2obj(form)), 'Schedule saved.')) await go();
    } else if (kind === 'alerts') {
      if (await act(() => api('PATCH', '/api/settings', form2obj(form)), 'Saved.')) await go();
    } else if (kind === 'password') {
      if (await act(() => api('POST', '/api/password', form2obj(form)), 'Password changed.')) form.reset();
    }
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
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
});

// ---------- The oath ----------

async function takeOath(form) {
  const f = new FormData(form);
  if (!f.get('focus')) { toast('Pick your one thing first.', true); return; }
  if (String(f.get('intention') || '').trim().length < 3) { toast('Say when and where you will do it.', true); form.querySelector('[name="intention"]')?.focus(); return; }
  const [kind, id] = String(f.get('focus')).split(':');
  const r = await act(() => api('POST', '/api/oath', { focusKind: kind, focusId: Number(id), intention: f.get('intention') || '' }));
  if (r) {
    haptic('success');
    toast('Sworn. Now do it.', false, 3500, true);
    if (state.sheet?.kind === 'oath') state.sheet = null;
    await refreshToday();
    window.scrollTo({ top: 0 });
  }
}

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
  if (document.visibilityState === 'visible' && state.route === 'today' && state.today && !state.sheet && !state.dirty && !motion.busy() && !document.activeElement?.matches('input, textarea, select')) refreshToday().catch(() => {});
}, 60000);

// Back from the background. With the lock screen up, ask for Face ID again. With Face ID only and
// more than a minute away, lock the open app in place (no reload, no flash of the day) and ask.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (lockEl()) {
    resumeLock();
    return;
  }
  if (state.faceIdOnly && away > 60000 && document.querySelector('.tabbar')) {
    lockApp();
    return;
  }
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
  if (document.querySelector('.tabbar') && !state.sheet && !state.dirty && !document.activeElement?.matches('input, textarea, select')) go();
});

// A page restored from the back-forward cache comes back without a visibility change.
window.addEventListener('pageshow', (e) => { if (e.persisted && lockEl()) resumeLock(); });

window.addEventListener('hashchange', (e) => {
  // Behind the lock screen a new address (a tapped notification) waits: unlocking opens it.
  if (document.querySelector('.gate')) return;
  state.pardoning = null;
  state.sheet = state.route === 'review' ? state.sheet : null;
  state.editingGoal = false;
  state.sheetNode = null;
  state.sheetMode = null;
  state.dodging = null;
  dockShown = false; // a new screen starts at the top, where Up next is in view
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
  canPull: () => state.route === 'today' && Boolean(state.today) && !state.sheet && !state.foodSheet && !document.querySelector('.gate'),
  refresh: () => refreshToday().catch((err) => { if (err.status !== 401) toast(err.message, true); }),
});

// The sidebar arrives at 900px and the two-column layouts at 1240px.
// A gate (the lock screen) is not a view: turning the iPad must not swap it for the app.
['(min-width: 900px)', '(min-width: 1240px)'].forEach((q) => window.matchMedia(q).addEventListener('change', () => { if (!document.querySelector('.gate')) render(); }));

// ---------- Boot ----------

// When a new version of the app is installed, switch to it straight away.
function watchForUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

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
  } catch (err) {
    if (err.status === 0 && lockModeRemembered()) {
      abortFaceId();
      if (lockEl()) setLock('offline'); else showLock({ offline: true });
      return;
    }
    const c = err.status === 0 ? cachedToday() : null;
    if (c) {
      parseHash();
      state.route = 'today';
      state.today = c.t;
      state.offline = c.at;
      render();
      return;
    }
    $app.innerHTML = `<div class="gate">${brandLockup()}<p>${esc(err.message)}</p>
      <div class="form-actions"><button class="btn primary" data-action="retry">Retry</button></div></div>`;
  }
}

boot();
