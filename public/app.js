// Oath web app. Plain modules, no build step.
import {
  $app, state, hooks, esc, ApiError, api, toast, react, act, form2obj, fmtClock, fmtDay, left, daysBetween, fmtMin,
  DAY_NAMES, scheduleText, CHECK, isStandalone, isIOS, haptic, bar, strengthChip, localToday, localNowHM,
  icon, rings, drawRings, pageHead, iconLink, fmtInt, fmtDec, fmtHours, ago, miniRing, keyBlock, rememberKey, safeColor,
} from './ui.js';
import { parseCapture } from './parse.js';
import { initGoals, loadGoals, loadGoal, viewGoals, viewGoalNew, viewGoal, goalsClick, goalsSubmit } from './goals.js';
import { initData, loadDashboard, viewDashboard, dataClick, dataSubmit, AUTO_LABELS, autoValue } from './data.js';

// ---------- Shell ----------

const TABS = [
  ['today', 'Today', 'today'],
  ['plan', 'Plan', 'plan'],
  ['goals', 'Goals', 'goals'],
  ['dashboard', 'Dashboard', 'dashboard'],
  ['coach', 'Coach', 'coach'],
];
const WIDE_EXTRA = [['review', 'Review', 'review'], ['settings', 'Settings', 'settings']];
const ROUTES = ['today', 'plan', 'goals', 'dashboard', 'coach', 'review', 'settings'];

function shell(inner) {
  // One selected destination: on the phone Review lives under Dashboard; the sidebar has its own row.
  const wide = window.matchMedia('(min-width: 900px)').matches;
  const active = state.route === 'review' && !wide ? 'dashboard' : state.route;
  const link = ([id, label, ic], extra = '') => `<a href="#/${id}" class="tab${extra}"${active === id || (extra && state.route === id) ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  const nav = TABS.map((t) => link(t)).join('');
  const more = WIDE_EXTRA.map((t) => link(t, ' wide-only')).join('');
  $app.innerHTML = `<main class="page page-${state.route}">${inner}</main>
    <nav class="tabbar" aria-label="Sections"><div class="tabbar-brand wide-only">Oath</div>${nav}${more}</nav>
    ${sheetHtml()}`;
  document.body.classList.toggle('sheet-open', Boolean(state.sheet || state.sheetNode));
  drawRings();
}

function skeleton(title) {
  return `${pageHead(title)}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`;
}

initGoals({ shell, render: () => render(), go: () => go() });
initData({ shell, render: () => render(), go: () => go() });

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
      : `Due ${dueLabel(i.deadline)}, <span class="${l.cls}" data-left="${i.dueAt}">${l.text}</span>${i.heavy ? `, ${i.penalty} HP` : ''}`;
    const relapse = i.missedLast ? '<span class="tag bad">Missed last time</span>' : '';
    // The minimum version sits under the row, so it can be kept from the list as well as from Up next.
    const minimum = i.minimum
      ? `<div class="li-min"><button class="btn tinted small" data-action="keep-minimum" data-id="${i.id}">Minimum: ${esc(i.minimum)}</button></div>`
      : '';
    return `<button class="${cls}" data-action="keep" data-id="${i.id}">
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
  return `<div class="${cls}">
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
      <p class="note">Your plan is quoted back in this habit's next reminder.</p>
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
    return `<button class="${cls}" data-action="task-done" data-id="${k.id}">
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
  return `<div class="${cls}">
    <span class="chk">${CHECK}</span>
    <span class="li-body"><span class="li-title">${tag}${esc(k.title)}</span><span class="li-sub">${meta}</span></span>
    <span class="li-side"></span>
    ${actions ? `<div class="li-actions">${actions}</div>` : ''}
  </div>`;
}

function hpBars(days, n = 14) {
  const list = days.slice(-n);
  if (!list.length) return '<p class="muted small">Your first day closes at midnight.</p>';
  // 0 HP is drawn as a dashed baseline, so a death never looks like a little HP left.
  const kind = (d) => (d.rest ? 'rest' : d.clean ? 'clean' : d.missed > 0 ? 'dirty' : '');
  const bars = list.map((d) => `<i class="${kind(d)}${d.hp_end <= 0 ? ' zero' : ''}" style="height:${Math.max(0, Math.min(100, d.hp_end))}%" title="${fmtDay(d.date)}: ${d.hp_end} HP${d.rest ? ', rest day' : d.clean ? ', clean' : ''}"></i>`).join('');
  const low = list.reduce((a, d) => (d.hp_end < a.hp_end ? d : a), list[0]);
  const label = `HP at the end of each of the last ${list.length} days, from ${list[0].hp_end} on ${fmtDay(list[0].date)} to ${list[list.length - 1].hp_end} on ${fmtDay(list[list.length - 1].date)}. Lowest ${low.hp_end} on ${fmtDay(low.date)}.`;
  const seen = new Set(list.map((d) => (d.hp_end <= 0 ? 'zero' : kind(d))));
  const key = [['clean', 'Clean day'], ['dirty', 'Missed something'], ['rest', 'Rest day'], ['zero', '0 HP']]
    .filter(([k]) => seen.has(k)).map(([k, l]) => `<span><i class="k-${k}"></i>${l}</span>`).join('');
  return `<div class="bars" role="img" aria-label="${label}">${bars}</div>
    <div class="bars-legend" aria-hidden="true"><span>${fmtDay(list[0].date)}</span><span>${fmtDay(list[list.length - 1].date)}</span></div>
    ${key ? `<div class="bars-key" aria-hidden="true">${key}</div>` : ''}`;
}

const REASONS = ['Tired', 'No time', 'Don\'t feel like it', 'Waiting on something', 'Scared of it'];
const DURATIONS = [15, 25, 45, 60];

function capacityLine(c, settings) {
  if (!c) return '';
  const over = c.over > 0;
  const free = c.busy ? `Free before ${settings.dayEnd}, after ${fmtMin(c.busy)} of calendar` : `Time left before ${settings.dayEnd}`;
  return `<div class="capacity${over ? ' over' : ''}">${icon('clock')}<p>Planned task work <b>${fmtMin(c.estimated)}</b>. ${free}: <b>${fmtMin(c.available)}</b>.${over ? ` That is ${fmtMin(c.over)} more than you have. Cut or move something now.` : ''}</p></div>`;
}

// The daily loss cap in plain words: what today can still cost, and whether that would end the season.
function stakesLine(t) {
  const p = t.progress;
  if (!p.atStake) return '';
  if (p.lethal) return `<span class="lethal">Missing everything left today ends the season: ${p.atStake} HP at stake, you have ${t.game.hp}.</span><br>`;
  if (p.fullStake > p.atStake) return `Today can cost at most <b>${p.atStake} HP</b> of the ${p.fullStake} on the line.<br>`;
  return '';
}

// The three rings: HP, today's progress, and movement (or habit strength before Health is linked).
function ringsCard(t) {
  const g = t.game;
  const hpPct = (g.hp / g.maxHp) * 100;
  const total = t.progress.total;
  const dayPct = total ? (t.progress.done / total) * 100 : 0;
  const h = t.health;
  let third;
  if (h?.connected && h.steps !== null && h.steps !== undefined) {
    third = { pct: (h.steps / (h.goals?.steps || 10000)) * 100, label: 'Steps', val: fmtInt(h.steps), of: `/${fmtInt(h.goals?.steps || 10000)}`, sub: h.exercise_min ? `${Math.round(h.exercise_min)} min exercise` : `Synced ${ago(h.lastSync)}` };
  } else {
    const list = t.items.filter((i) => i.strength !== undefined);
    const avg = list.length ? Math.round(list.reduce((n, i) => n + i.strength, 0) / list.length) : 0;
    third = { pct: avg, label: 'Strength', val: String(avg), of: '%', sub: list.length ? `Average of ${list.length} ${list.length === 1 ? 'habit' : 'habits'}` : 'No habits yet' };
  }
  const seasonDay = daysBetween(g.seasonStart, t.today) + 1;
  const lowHp = g.hp <= 30;
  return `<section class="card rings-card">
    ${rings([{ pct: hpPct, cls: 'r-hp' }, { pct: dayPct, cls: 'r-day' }, { pct: third.pct, cls: 'r-move' }], 132)}
    <div class="legend">
      <div class="lg r-hp${lowHp ? ' low' : ''}"><span class="lg-label">HP</span><span class="lg-val">${g.hp}<small>/${g.maxHp}</small></span><span class="lg-sub">Season ${g.season}, day ${seasonDay}</span></div>
      <div class="lg r-day"><span class="lg-label">Today</span><span class="lg-val">${t.progress.done}<small>/${total}</small></span><span class="lg-sub">${total ? (t.progress.atStake ? `${t.progress.atStake} HP still at stake` : 'Nothing left at stake') : 'Nothing due today'}</span></div>
      <div class="lg r-move"><span class="lg-label">${third.label}</span><span class="lg-val">${third.val}<small>${third.of}</small></span><span class="lg-sub">${third.sub}</span></div>
    </div>
    <p class="rings-foot">${stakesLine(t)}${g.pardonsLeft} ${g.pardonsLeft === 1 ? 'pardon' : 'pardons'} left this month, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'}${t.dodgesToday ? `, ${t.dodgesToday} ${t.dodgesToday === 1 ? 'dodge' : 'dodges'} today` : ''}${t.weekFocus ? `<br>This week: <b>${esc(t.weekFocus)}</b>` : ''}</p>
  </section>`;
}

// The morning oath, compact: one choice from a list, when and where, and a tap. The habit list
// below stays tickable whether or not the oath has been taken.
function oathView(t) {
  const open = [...t.openDue].sort((a, b) => (a.dueAt || '9').localeCompare(b.dueAt || '9'));
  const options = open.map((i) => `<option value="${i.kind}:${i.id}">${esc(i.title)}, by ${dueLabel(i.deadline)}${i.heavy ? `, ${i.penalty} HP` : ''}</option>`).join('');
  return `<section class="card oath">
    <p class="eyebrow">${icon('sun')}Morning oath</p>
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
  </section>`;
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
      <p class="now-meta">Keep it clean to midnight for +${t.settings.cleanBonus} HP. Then close the day below.</p>
    </section>`;
  }
  const l = n.dueAt ? left(n.dueAt) : null;
  const metaParts = [];
  if (n.flexible) metaParts.push(`${n.weekDone} of ${n.weekTarget} this week`);
  else if (n.dueAt) metaParts.push(`Due ${dueLabel(n.deadline)}`);
  else metaParts.push('No deadline');
  if (n.heavy) metaParts.push(`${n.penalty} HP at stake`);
  const isTask = n.kind === 'task';
  if (state.dodging && state.dodging.kind === n.kind && state.dodging.id === n.id) {
    const chips = REASONS.map((r) => `<label class="chip"><input type="radio" name="reason" value="${esc(r)}"><span>${esc(r)}</span></label>`).join('');
    return `<section class="card now dodging">
      <p class="eyebrow">Not now?</p>
      <h2 class="now-title">${esc(n.title)}</h2>
      ${n.minimum ? `<button class="btn primary big wide" data-action="keep-minimum" data-id="${n.id}">Do the minimum now: ${esc(n.minimum)}</button>
        <p class="note">The minimum saves the HP and the streak. It does not earn the clean-day bonus.</p>` : ''}
      <form data-form="defer" data-kind="${n.kind}" data-id="${n.id}">
        <fieldset class="chips"><legend>Why not now</legend>${chips}</fieldset>
        <label class="field"><span>Or in your own words</span><input class="input" name="own" maxlength="300" autocomplete="off"></label>
        ${isTask && !n.heavy ? '<label class="check"><input type="checkbox" name="move"> Move it to tomorrow</label>' : `<p class="note">${n.kind === 'habit' ? 'Habits cannot be moved.' : 'Hard tasks cannot be moved.'} The deadline stays ${n.deadline || '23:59'}.</p>`}
        <div class="now-actions">
          <button class="btn tinted" type="submit">Log it</button>
          <button class="btn tinted" type="button" data-action="dodge-cancel">Back, I will do it</button>
        </div>
      </form>
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
  return `<section class="card now${n.isFocus ? ' is-focus' : ''}${n.missedLast ? ' relapse' : ''}">
    <div class="now-top"><p class="eyebrow">${icon(n.isFocus ? 'focus' : 'bolt')}${label}</p>${l ? `<span class="now-left ${l.cls}" data-left="${n.dueAt}">${l.text}</span>` : ''}</div>
    <h2 class="now-title">${esc(n.title)}</h2>
    <p class="now-meta">${metaParts.join(', ')}</p>
    ${sub.length ? `<p class="now-cue">${sub.join('<br>')}</p>` : ''}
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

// Today in time order: calendar events with the deadlines that fall between them.
function timeline(t) {
  const events = t.calendar || [];
  if (!events.length) return '';
  const now = localNowHM();
  const allDay = events.filter((e) => e.allDay);
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
  // Deadlines at 00:00 fall at the end of the day, after everything else.
  const at = (r) => (r.kind !== 'event' && r.kind !== 'deadline' && r.time === '00:00' ? '24:00' : r.time);
  rows.sort((a, b) => at(a).localeCompare(at(b)));
  let nowPlaced = false;
  const html = rows.map((r) => {
    let marker = '';
    if (!nowPlaced && at(r) >= now) {
      nowPlaced = true;
      marker = `<div class="tl-now"><span>${now}</span></div>`;
    }
    return `${marker}<div class="tl-row ${r.kind}${r.past ? ' past' : ''}">
      <span class="tl-time">${r.time}</span>
      <span class="tl-bar"${safeColor(r.color) ? ` style="--c:${safeColor(r.color)}"` : ''}></span>
      <span class="tl-body"><span class="tl-title">${esc(r.title)}</span>${r.sub ? `<span class="tl-sub">${esc(r.sub)}</span>` : ''}</span>
    </div>`;
  }).join('') + (nowPlaced ? '' : `<div class="tl-now"><span>${now}</span></div>`);
  return `<section class="section"><div class="gh"><h2>Schedule</h2><a href="#/dashboard" class="gh-link">Calendars</a></div>
    <div class="card timeline">
      ${allDay.length ? `<div class="tl-allday">${allDay.map((e) => `<span class="tl-chip"${safeColor(e.color) ? ` style="--c:${safeColor(e.color)}"` : ''}>${esc(e.title)}</span>`).join('')}</div>` : ''}
      ${html}
    </div></section>`;
}

function healthMini(t) {
  const h = t.health;
  if (!h) return '';
  if (!h.connected) {
    return `<a class="card connect-card" href="#/dashboard?section=health">
      <span class="connect-ic">${icon('heart')}</span>
      <span><b>Connect Apple Health</b><span class="li-sub">Steps, workouts and sleep flow in, and habits like "Gym" tick themselves off.</span></span>
      ${icon('chevron', 'chev')}</a>`;
  }
  const g = h.goals || {};
  const tile = (ic, label, v, goal, fmt, unit) => {
    const pct = v === null || v === undefined || !goal ? 0 : Math.min(100, Math.round((v / goal) * 100));
    if (v === null || v === undefined) {
      return `<div class="hm-tile"><span class="hm-label">${icon(ic)}${label}</span><span class="hm-val na">–<small> no reading</small></span>${bar(null, 'thin')}</div>`;
    }
    return `<div class="hm-tile"><span class="hm-label">${icon(ic)}${label}</span><span class="hm-val">${fmt(v)}<small>${unit}</small></span>${bar(pct, 'thin')}</div>`;
  };
  return `<a class="card health-mini" href="#/dashboard">
    <div class="hm-head"><span>${icon('heart')}Health</span><span class="faint small">Synced ${ago(h.lastSync)}${icon('chevron', 'chev')}</span></div>
    <div class="hm-grid">
      ${tile('steps', 'Steps', h.steps, g.steps, fmtInt, '')}
      ${tile('timer', 'Exercise', h.exercise_min, g.exercise_min, (v) => Math.round(v), ' min')}
      ${tile('flame', 'Active', h.active_kcal, g.active_kcal, fmtInt, ' kcal')}
      ${tile('moon', 'Sleep', h.sleep_hours, g.sleep_hours, fmtHours, '')}
    </div>
    ${h.workouts?.length ? `<p class="hm-work">${icon('dumbbell')}${h.workouts.map((w) => `${esc(w.type)}, ${Math.round(w.duration_min)} min`).join('; ')}</p>` : ''}
  </a>`;
}

// Reminders only reach the phone from the Home Screen app with notifications allowed, so Today says so.
function remindersPrompt() {
  if (isIOS() && !isStandalone()) {
    return `<div class="banner">${icon('bell')}<span><b>Add Oath to your Home Screen.</b> Tap Share, then Add to Home Screen, and open it from the icon so reminders can reach you.</span></div>`;
  }
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported || Notification.permission !== 'default') return '';
  return `<div class="banner">${icon('bell')}<span><b>Turn on reminders</b> so last calls reach your lock screen.</span><button class="btn small primary" data-action="push-on">Turn on</button></div>`;
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

// Until every connection works, Today carries the list. Hidden by hand, it only comes back when
// something that worked stops working.
function setupCard(s) {
  if (!s || s.done === s.total) return '';
  let hiddenAt = null;
  try { hiddenAt = localStorage.getItem('oath.setupHidden'); } catch { /* storage unavailable */ }
  if (hiddenAt !== null && s.done >= Number(hiddenAt)) return '';
  return `<section class="section"><div class="gh"><h2>Set up <em>Oath</em></h2><span class="gh-count">${s.done} of ${s.total} connected</span></div>
    <div class="group">${setupRows(s)}</div>
    <div class="form-actions"><button class="btn plain small" data-action="setup-hide" data-done="${s.done}">Hide for now</button></div></section>`;
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
    <div class="plan-text">${esc(t.plan.coachPlan)}</div>
  </details>`;
}

function triageCard(t) {
  if (!t.triage.length) return '';
  const rows = t.triage.slice(0, 5).map((k) => `<div class="triage-row">
      <span class="li-title">${esc(k.title)}</span>
      <span class="li-sub">${k.dueDate ? `Was due ${fmtDay(k.dueDate)}` : `No date for ${k.ageDays} days`}</span>
      <div class="triage-actions" role="group" aria-label="Decide">
        <button class="btn tinted small" data-action="triage" data-do="today" data-id="${k.id}">Today</button>
        <button class="btn tinted small" data-action="triage" data-do="tomorrow" data-id="${k.id}">Tomorrow</button>
        <button class="btn tinted small" data-action="triage" data-do="week" data-id="${k.id}">Next week</button>
        <button class="btn plain small danger-text" data-action="triage" data-do="drop" data-id="${k.id}">Drop</button>
      </div></div>`).join('');
  return `<section class="section"><div class="gh"><h2>Clear the backlog</h2><span class="gh-count">${t.triage.length} waiting</span></div>
    <div class="card triage">${rows}<p class="note">One decision each. A short list you trust beats a pile you never look at.</p></div></section>`;
}

function goalsStrip(goals) {
  if (!goals?.length) return '';
  return `<section class="section"><div class="gh"><h2>Goals</h2><a class="gh-link" href="#/goals">All goals</a></div>
    <div class="goal-mini">${goals.map((g) => `<a href="#/goals/${g.id}" class="goal-mini-row">
      ${miniRing(g.pct ?? 0, 34)}<span><span class="goal-mini-title">${esc(g.title)}</span><span class="goal-mini-label">${g.pct === null ? '' : `${g.pct}%, `}${esc(g.label)}</span></span>${icon('chevron', 'chev')}</a>`).join('')}</div></section>`;
}

function closeDayCard(t) {
  if (t.reflection) {
    return `<section class="section"><div class="gh"><h2>Day closed</h2><span class="gh-count">${t.reflection.rating} out of 5</span></div>
      <div class="card brief"><p class="eyebrow">${icon('coach')}Coach</p><div class="brief-text">${esc(t.reflection.coachReply || 'The coach is writing back.')}</div>${t.reflection.tomorrow ? `<p class="brief-who">Tomorrow's one thing: ${esc(t.reflection.tomorrow)}</p>` : ''}</div></section>`;
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

function briefCard(t) {
  // A brief is only shown for four hours; after that the day has moved on.
  const brief = t.briefs.find((x) => Date.now() - new Date(x.at).getTime() < 4 * 3600 * 1000);
  if (!brief) return '';
  const titles = { morning: 'Morning brief', midday: 'Midday check', evening: 'Evening check' };
  return `<section class="card brief"><p class="eyebrow">${icon('coach')}${titles[brief.kind] || 'Coach'}, ${fmtClock(brief.at)}</p><div class="brief-text">${esc(brief.text)}</div></section>`;
}

function viewToday() {
  const t = state.today;
  if (!t) return shell(skeleton('Today'));
  const part = t.localHour < 12 ? 'Morning' : t.localHour < 18 ? 'Afternoon' : 'Evening';
  const head = pageHead(`${part}, <em>${esc(t.settings.ownerName || 'Daniel')}</em>`, {
    over: fmtDay(t.today, { weekday: 'long', day: 'numeric', month: 'long' }),
    actions: iconLink('#/settings', 'settings', 'Settings'),
  });
  const banners = [
    state.offline ? `<div class="banner offline">${icon('clock')}<span><b>Offline.</b> This is ${t.today === realToday(t) ? 'today' : fmtDay(t.today)} as of ${fmtClock(state.offline)}. Ticks need a connection.</span><button class="btn small" data-action="retry">Retry</button></div>` : '',
    remindersPrompt(),
    t.rest ? `<div class="banner calm">${icon('moon')}<span>Rest day. Fixed habits are excused today. Hard tasks still count.</span></div>` : '',
    t.reviewDue ? `<a class="banner action" href="#/review">${icon('review')}<span><b>Weekly review is ready.</b> Five minutes: keep, adjust or drop each habit and pick this week's focus.</span>${icon('chevron', 'chev')}</a>` : '',
  ].join('');

  // No oath yet and something is due: the oath card sits under Up next, and the lists stay tickable.
  const needsOath = !t.plan && t.progress.open > 0;

  if (!t.items.length && !t.tasks.length && !t.anytime.length && !t.triage.length) {
    shell(`${head}${ringsCard(t)}${banners}
      <section class="card now empty-now"><p class="eyebrow">${icon('plan')}Start here</p><h2 class="now-title">Add the habits you swear to.</h2>
      <p class="now-meta">Start with two or three non-negotiables, each tied to something you already do every day. Add more once they are strong.</p>
      <div class="now-actions"><a class="btn primary big" href="#/plan">Add habits</a><a class="btn tinted big" href="#/goals/new">Set a goal</a></div></section>
      ${healthMini(t)}${timeline(t)}`);
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
      ${needsOath ? oathView(t) : ''}
      ${t.plan ? capacityLine(t.capacity, t.settings) : ''}
      <div class="only-narrow">${planCard(t)}${briefCard(t)}</div>
      ${triageCard(t)}
      ${section('Non-negotiables', heavy, heavy.map((i) => habitRow(i, t)).join(''), heavyCount)}
      ${section('Habits', normal, normal.map((i) => habitRow(i, t)).join(''))}
      ${section('This week', flex, flex.map((i) => habitRow(i, t)).join(''), `${flex.filter((i) => i.status === 'met').length} of ${flex.length} met`)}
      ${tasksHtml}
      ${setupCard(state.setup)}
      <div class="only-narrow">${timeline(t)}${healthMini(t)}</div>
      ${closeDayCard(t)}
    </div>
    <aside>
      <div class="only-wide">${timeline(t)}${healthMini(t)}${planCard(t)}${briefCard(t)}</div>
      ${goalsStrip(t.goals)}
      <section class="section"><div class="gh"><h2>Last 14 days</h2><span class="gh-count">HP at day end</span></div>
        <div class="card">${hpBars(t.recentDays)}</div></section>
      ${upcoming}
    </aside>
  </div>`);
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
    <p class="note auto-on">When Apple Health shows the target was hit, the habit is kept for you, and a miss it proves wrong is overturned.</p>
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
    ${!h?.non_negotiable && nnCount >= cap ? `<p class="note">You already have ${nnCount} non-negotiables. A new one is only allowed once each of them is above 80% strength.</p>` : ''}
    ${autoFields(h)}
    ${goalOptions(h?.goalId)}
    <label class="field"><span>Notes</span><input class="input" name="notes" maxlength="1000" value="${esc(h?.notes || '')}" placeholder="Optional"></label>
    ${h && h.nextRulesFrom ? `<p class="note">New rules start ${fmtDay(h.nextRulesFrom)}. Today keeps the old ones.</p>` : ''}
    <div class="form-actions">
      <button class="btn primary" type="submit">${h ? 'Save habit' : 'Add habit'}</button>
      ${h ? `<button class="btn tinted danger-text" type="button" data-action="archive-habit" data-id="${h.id}">Archive</button>` : ''}
    </div>
    <p class="note">${h ? 'Changes to a habit still open today, and any new minimum version, take effect tomorrow.' : 'Most habits take about two months to feel automatic, anywhere from two weeks to eight months. Strength shows how far along you are; one miss costs a few points, not everything.'}</p>
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
    ${locked ? '<p class="note">This hard task is due, so its date and penalty are locked.</p>' : ''}
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
  const building = h.strength < 80 ? `Day ${h.buildingDay} of building. The median is about 66.` : 'Established. Reminders now fade.';
  const facts = [
    h.cue ? ['After', esc(h.cue)] : null,
    h.minimum ? ['Minimum', esc(h.minimum)] : null,
    h.ifThen ? ['Plan', esc(h.ifThen)] : null,
    h.auto ? ['Health', `${fmtInt(h.auto.target)} ${(AUTO_LABELS[h.auto.metric] || {}).unit || ''}${h.auto.filter ? `, ${esc(h.auto.filter)}` : ''}`] : null,
    h.goalTitle ? ['Goal', `<a href="#/goals/${h.goalId}">${esc(h.goalTitle)}</a>`] : null,
  ].filter(Boolean);
  return `<div class="card hcard${h.non_negotiable ? ' heavy' : ''}">
    <div class="hcard-top">
      <div class="hcard-text"><h3>${esc(h.name)}</h3>
        <p class="li-sub">${sched}${h.non_negotiable ? ', <span class="bad">non-negotiable</span>' : ''}, minus ${h.penalty} HP</p></div>
      <div class="hcard-ring ${h.strength >= 80 ? 'strong' : h.strength >= 40 ? 'mid' : 'new'}">${miniRing(h.strength, 48)}<b>${h.strength}<small>%</small></b></div>
    </div>
    ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
    ${heatmap(h.heat, p.today)}
    ${pending}${h.archivedFrom ? `<p class="note">Archived from ${fmtDay(h.archivedFrom)}.</p>` : ''}
    <div class="hcard-foot"><span class="faint small">${building}${h.streak ? ` ${h.streak} ${weekly ? 'week' : 'day'} streak.` : ''}</span>
      <button class="btn tinted small" data-action="sheet" data-kind="habit" data-id="${h.id}">Edit</button></div>
  </div>`;
}

function restCard(p) {
  const list = p.restDays.map((d) => `<div class="li li-plain">
    <span class="li-body"><span class="li-title">${fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>${d.reason ? `<span class="li-sub">${esc(d.reason)}</span>` : ''}</span>
    <button class="btn tinted small" data-action="rest-cancel" data-date="${d.date}">Cancel</button></div>`).join('');
  return `<section class="section"><div class="gh"><h2>Rest days</h2><span class="gh-count">${p.settings.restDaysPerMonth} a month</span></div>
    <div class="card">
      <p class="muted small">For travel or a planned day off. Fixed habits are excused, X-a-week targets shrink, hard tasks still count, and there is no clean-day bonus. Book before the day starts.</p>
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
  return `<div class="capacity${capped ? ' over' : ''}">${icon('shield')}<p>Your worst day puts <b>${s.worstDay} HP</b> on the line. ${capped
    ? `One day can cost at most <b>${s.dailyLossCap}</b>, so two bad days in a row end the season.`
    : `That is within the ${s.dailyLossCap} HP a day can cost.`}</p></div>`;
}

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
  const seg = `<div class="seg plan-seg only-narrow-flex" role="tablist" aria-label="Show">
      <button role="tab" aria-selected="${tab === 'habits'}" data-action="plan-tab" data-tab="habits">Habits</button>
      <button role="tab" aria-selected="${tab === 'tasks'}" data-action="plan-tab" data-tab="tasks">Tasks</button>
    </div>`;
  const add = `<button class="icon-btn accent" data-action="sheet" data-kind="${tab === 'tasks' ? 'task' : 'habit'}" aria-label="New ${tab === 'tasks' ? 'task' : 'habit'}">${icon('plus')}</button>`;

  shell(`${pageHead('Plan', { over: `${p.habits.length} habits, ${p.tasks.length} open tasks`, actions: add })}
    ${seg}
    <div class="split plan-split tab-${tab}">
    <div class="pane-habits">
      <section class="section"><div class="gh"><h2>Habits</h2><button class="gh-link" data-action="sheet" data-kind="habit">New habit</button></div>
        ${budgetNote(p.settings)}
        ${habits || `<div class="card empty"><h3>No habits yet</h3><p class="muted">Start with two or three, each tied to something you already do every day.</p><div class="form-actions"><button class="btn primary" data-action="sheet" data-kind="habit">Add the first habit</button></div></div>`}
      </section>
      ${restCard(p)}
    </div>
    <aside class="pane-tasks">
      <section class="section"><div class="gh"><h2>Tasks</h2><button class="gh-link" data-action="sheet" data-kind="task">New task</button></div>
        <div class="group">${quickAdd('plan-quick')}${tasks}</div>
      </section>
    </aside>
  </div>`);
}

// ---------- Sheets: forms slide up from the bottom ----------

function sheetHtml() {
  const s = state.sheet;
  if (!s) return '';
  let title = '';
  let body = '';
  if (s.id && !state.plan) return '';
  if (s.kind === 'habit') {
    const h = s.id ? state.plan?.habits.find((x) => x.id === s.id) : null;
    title = h ? 'Edit habit' : 'New habit';
    body = habitForm(h);
  } else if (s.kind === 'task') {
    const k = s.id ? state.plan?.tasks.find((x) => x.id === s.id) : null;
    title = k ? 'Edit task' : 'New task';
    body = taskForm(k);
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

function viewCoach() {
  const c = state.coach;
  if (!c) return shell(skeleton('Coach'));
  const msgs = c.messages.map((m) => `<div class="msg ${m.role}">${esc(m.text)}${m.at ? `<time>${fmtClock(m.at)}</time>` : ''}</div>`).join('');
  const ask = state.query.get('ask') || '';
  shell(`${pageHead('Coach', { over: c.aiEnabled ? 'Claude, with your whole day in view' : 'Offline', actions: iconLink('#/settings', 'settings', 'Settings') })}
      ${c.aiEnabled ? '' : '<div class="banner warn">The coach is offline. It needs an Anthropic API key in the app\'s Railway variables. Briefs still arrive with plain numbers until then.</div>'}
      <div class="brief-buttons">
        <button class="btn tinted small" data-action="brief" data-kind="morning">${icon('sun')}Morning brief</button>
        <button class="btn tinted small" data-action="brief" data-kind="midday">${icon('clock')}Midday check</button>
        <button class="btn tinted small" data-action="brief" data-kind="evening">${icon('moon')}Evening check</button>
      </div>
      <div class="chat" id="chat">${msgs || '<p class="muted chat-empty">Ask for a plan, report a slip, or tell it what you are avoiding. It sees your HP, deadlines, habit strength, goals, calendar, Apple Health, dodges and pardon reasons.</p>'}
        ${state.sending ? '<div class="msg assistant typing"><i></i><i></i><i></i></div>' : ''}</div>
      <form class="composer" data-form="coach">
        <label class="sr" for="coach-text">Message</label>
        <textarea id="coach-text" class="input" name="text" rows="1" maxlength="4000" placeholder="Message the coach" required>${esc(ask)}</textarea>
        <button class="btn primary send" type="submit" aria-label="Send"${state.sending ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
      </form>`);
  const chat = document.getElementById('chat');
  if (chat) chat.lastElementChild?.scrollIntoView({ block: 'end' });
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
      ${rv.coachText ? `<details style="margin-top:10px"><summary class="small">Coach's review</summary><div class="plan-text">${esc(rv.coachText)}</div></details>` : ''}</div></section>`;
  }
  if (!w.judgedDays) {
    return `<section class="section"><div class="gh"><h2>Weekly review</h2></div>
      <div class="card muted">Your first weekly review opens on Monday, once a full week has been judged.</div></section>`;
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
      ${rv.coachText ? `<div class="plan-text">${esc(rv.coachText)}</div>` : `<button class="btn tinted" data-action="review-write">${icon('coach')}Let the coach pre-fill it</button>`}
      ${weekStats(w)}
      <form data-form="review-finish">
        ${rows ? `<h3 style="margin-top:18px">Each habit: keep, adjust or drop</h3>${rows}` : ''}
        <label class="field"><span>This week's one or two things that matter most</span><input class="input" name="focus" maxlength="300" required autocomplete="off"></label>
        <label class="field"><span>If-then plan for the week's biggest obstacle</span><input class="input" name="obstaclePlan" maxlength="300" autocomplete="off" placeholder="If I skip Monday's gym, then I go Tuesday at 7:00"></label>
        <div class="form-actions"><button class="btn primary" type="submit">Finish the review</button></div>
        <p class="note">Drop archives the habit. Adjust takes you to it after the review.</p>
      </form>
    </div></section>`;
}

function viewReview() {
  const r = state.review;
  if (!r) return shell(skeleton('Review'));
  const g = r.game;
  const days = [...r.days].reverse();
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

  shell(`${pageHead('Review', { over: 'The week, and everything that counted', actions: iconLink('#/settings', 'settings', 'Settings') })}
    <div class="split"><div>
      ${reviewCard(r)}
      <section class="section"><div class="gh"><h2>This week so far</h2></div><div class="card">${weekStats(r.thisWeek)}</div></section>
      ${stale ? `<section class="section"><div class="gh"><h2>Clear the backlog</h2><span class="gh-count">${r.stale.length}</span></div><div class="card triage">${stale}</div></section>` : ''}
      <section class="section"><div class="gh"><h2>Habit strength</h2></div>
        ${strengthRows ? `<div class="group">${strengthRows}</div>` : '<div class="card muted">No habits yet.</div>'}
      </section>
      <section class="section"><div class="gh"><h2>HP, last 30 days</h2></div><div class="card">${hpBars(days, 30)}</div></section>
    </div><aside>
      ${goalsStrip(r.goals)}
      <section class="section"><div class="gh"><h2>Ledger</h2></div>
        <div class="stats">
          <div class="stat"><b>${g.season}</b><span>Season</span></div>
          <div class="stat"><b>${g.deaths}</b><span>${g.deaths === 1 ? 'Death' : 'Deaths'}</span></div>
          <div class="stat"><b>${g.pardonsLeft}</b><span>Pardons left</span></div>
        </div></section>
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
      ? 'To get reminders on iPhone or iPad, add Oath to your Home Screen first: tap Share, then Add to Home Screen, then open Oath from the new icon and come back here.'
      : 'This browser does not support push notifications.';
  } else if (p.permission === 'denied') {
    status = 'Notifications are blocked. Turn them on in iOS Settings, Notifications, Oath.';
  } else if (p.subscribed) {
    const devices = p.devices == null ? '' : ` The server is sending to ${p.devices} ${p.devices === 1 ? 'device' : 'devices'}.`;
    status = `Reminders are on for this device.${devices} The app icon shows how many things can still cost HP today.`;
    action = '<button class="btn tinted" data-action="push-test">Send a test</button><button class="btn tinted" data-action="push-off">Turn off on this device</button>';
  } else {
    status = 'Reminders are off on this device. Turn them on so last calls and briefs reach your lock screen.';
    action = '<button class="btn primary" data-action="push-on">Turn on reminders</button>';
  }
  return settingsCard('bell', 'Reminders', `<p class="muted">${status}</p>${action ? `<div class="form-actions">${action}</div>` : ''}`);
}

function settingsCard(ic, title, body, id = '') {
  return `<div class="card scard"${id ? ` id="${id}"` : ''}><h3 class="scard-h"><span class="sic sic-${ic}">${icon(ic)}</span>${title}</h3>${body}</div>`;
}

function alertsCard(s) {
  const opt = (v, label, hint) => `<label class="radio-row"><input type="radio" name="alerts" value="${v}"${(s.alerts || 'both') === v ? ' checked' : ''}><span><b>${label}</b><br><span class="muted small">${hint}</span></span></label>`;
  return settingsCard('phone', 'Where alerts go', `<form data-form="alerts">
      ${opt('smart', 'One channel per alert', 'Telegram gets reminders with Done buttons, misses and briefs. The lock screen gets last calls and deaths. Fewer, sharper alerts.')}
      ${opt('both', 'Everything, everywhere', 'Every alert on both the lock screen and Telegram.')}
      ${opt('push', 'App only', 'Telegram stays quiet except when you write to it.')}
      <div class="form-actions"><button class="btn primary" type="submit">Save</button></div>
    </form>
    <p class="note">Reminders fade on their own once a habit passes 80% strength. Non-negotiables always keep a last call.</p>`);
}

function telegramCard() {
  const tg = state.telegram || {};
  let body;
  let actions = '';
  if (!tg.enabled) {
    body = 'Create a bot with @BotFather in Telegram and add its token in Railway as TELEGRAM_BOT_TOKEN. This turns on after the next deploy.';
  } else if (tg.linked) {
    body = `Connected${tg.botUsername ? ` to @${esc(tg.botUsername)}` : ''}. Anything you write goes to the coach. Commands: /today, /next, /hp, /add call the bank friday 3pm, /done gym.`;
    actions = '<button class="btn tinted" data-action="tg-test">Send a test</button><button class="btn tinted" data-action="tg-unlink">Disconnect</button>';
  } else {
    body = 'Connect your Telegram so the coach can reach you there. The button opens Telegram; tap Start in the chat with your bot.';
    actions = '<button class="btn primary" data-action="tg-link">Connect Telegram</button>';
    if (tg.linkUrl) body += ` If Telegram did not open, use this link: <a href="${esc(tg.linkUrl)}">${esc(tg.linkUrl)}</a>`;
  }
  return settingsCard('telegram', 'Telegram', `<p class="muted">${body}</p>${actions ? `<div class="form-actions">${actions}</div>` : ''}`);
}

function siriCard() {
  const host = location.origin;
  const count = state.tokens?.count || 0;
  return settingsCard('mic', 'Siri and Shortcuts', `
    <p class="muted">Say "Add to Oath", "Oath done" or "What's next in Oath" from your iPhone, Apple Watch or the Action button. The same key lets Apple Health send its data.</p>
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
      <p class="small">Things added by voice are normal tasks. Making something hard stays a decision you make in the app.</p>
    </details>`);
}

function viewSettings() {
  const s = state.settings;
  if (!s) return shell(skeleton('Settings'));
  const connections = settingsCard('link', 'Your data', `
    <div class="group flush">
      ${state.setup ? setupRows(state.setup) : `
      <a class="li li-plain li-nav" href="#/dashboard?section=health"><span class="li-ic">${icon('heart')}</span><span class="li-body"><span class="li-title">Apple Health</span><span class="li-sub">Steps, workouts, sleep, heart</span></span>${icon('chevron', 'chev')}</a>
      <a class="li li-plain li-nav" href="#/dashboard?section=calendars"><span class="li-ic">${icon('calendar')}</span><span class="li-body"><span class="li-title">Calendars and VLE deadlines</span><span class="li-sub">Google, iCloud, Outlook, UM VLE</span></span>${icon('chevron', 'chev')}</a>`}
      <a class="li li-plain li-nav" href="#/dashboard"><span class="li-ic">${icon('business')}</span><span class="li-body"><span class="li-title">Business sites</span><span class="li-sub">GoldenStraddler, Exposed FX Journal</span></span>${icon('chevron', 'chev')}</a>
    </div>
    <div class="form-actions"><a class="btn tinted" href="/api/export" download>${icon('download')}Download all my data</a></div>`);
  shell(`${pageHead('Settings', { over: 'Oath' })}
    <div class="split"><div>
      ${connections}
      ${faceIdCard()}
      ${pushCard()}
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
    <aside><section class="section"><div class="gh"><h2>The rules</h2></div>
      <div class="card prose">
        <p>You have ${s.maxHp} HP. Miss a habit's deadline and you lose its HP. Miss the same habit twice in a row and the second costs ${s.repeatMultiplier}x.</p>
        <p>Keep a habit right after missing it and you earn ${s.comebackBonus} HP back. One miss is an accident; the second is the start of a new habit.</p>
        <p>Strength is the real measure: it grows with every repetition and a miss costs a few points, never everything. Streaks reset on a miss.</p>
        <p>Once a deadline passes, the habit is locked. A mistaken tick can be undone within ${s.undoMinutes} minutes. If Apple Health later proves it was done before the deadline, the miss is overturned.</p>
        <p>"Times a week" habits are settled on Sunday night. Each missing session costs its share of the HP.</p>
        <p>A minimum version, set a day ahead, saves the HP and the streak but not the clean-day bonus.</p>
        <p>Hard tasks cost ${s.taskPenalty} HP if not done by their deadline, need a first step, and cannot be deleted or moved once due.</p>
        <p>A clean day, with nothing missed and no minimums, gives back ${s.cleanBonus} HP.</p>
        <p>One day can cost at most ${s.dailyLossCap} HP, however much is missed. A bad day hurts; two in a row can end the season.</p>
        <p>At 0 HP you die. The season ends and streaks reset, but every habit keeps its strength. Whatever else that day misses costs the new season nothing.</p>
        <p>${s.pardonsPerMonth} pardons a month, within 24 hours, each with what got in the way and an if-then plan. ${s.restDaysPerMonth} rest days a month, booked before the day starts.</p>
        <p>At most ${s.maxNonNegotiables} non-negotiables until each is above 80% strength.</p>
        <p>Every morning you take the oath: the one thing, and when and where. "Not now" needs a reason; every dodge is logged.</p>
      </div></section></aside></div>`);
}

// ---------- Gate ----------

// The way in. With Face ID only, it is a lock screen that starts Face ID by itself, with the
// password and recovery code tucked away for the day Face ID is lost. Otherwise it is the password,
// with Face ID offered once a passkey exists.
function renderLogin(session = null) {
  if (!session) {
    api('GET', '/api/session').then((s) => renderLogin(s)).catch(() => renderLogin({}));
    return;
  }
  rememberLockMode(session.faceIdOnly);
  if (session.faceIdOnly) {
    $app.innerHTML = `<div class="gate">
      <div class="wordmark">Oath</div>
      <p>${session.locked ? 'Locked. ' : ''}Look at your iPhone to open it, <em class="serif">Daniel</em>.</p>
      <div id="faceid-slot"><button class="btn chrome big wide" type="button" data-action="faceid-login">${icon('faceid')}Open with Face ID</button></div>
      <p class="note bad" id="gate-error" role="alert" hidden></p>
      <details class="recover"><summary>Lost Face ID?</summary>
        <form data-form="login">
          <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
          <label class="field"><span>Recovery code (SETUP_CODE in Railway)</span><input class="input" name="recovery" autocomplete="off" required></label>
          <div class="form-actions"><button class="btn primary big wide" type="submit">Open with password</button></div>
        </form></details>
    </div>`;
    const btn = document.querySelector('[data-action="faceid-login"]');
    if (btn) faceIdLogin(btn, { auto: true });
    return;
  }
  $app.innerHTML = `<div class="gate">
    <div class="wordmark">Oath</div>
    <p>Welcome back, <em class="serif">Daniel</em>. Log in to see today.</p>
    <div id="faceid-slot"></div>
    <form data-form="login">
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required autofocus></label>
      <div class="form-actions"><button class="btn primary big wide" type="submit">Log in</button></div>
      <p class="note bad" id="gate-error" role="alert" hidden></p>
    </form></div>`;
  if (session.faceId) prepareFaceIdLogin();
}

// Remembered on the phone so a launch without signal does not show a cached day past the lock.
function rememberLockMode(on) {
  state.faceIdOnly = Boolean(on);
  try { localStorage.setItem('oath.faceIdOnly', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
function lockModeRemembered() {
  try { return localStorage.getItem('oath.faceIdOnly') === '1'; } catch { return false; }
}
hooks.onUnauthed = renderLogin;

function renderSetup(code) {
  $app.innerHTML = `<div class="gate">
    <div class="wordmark">Oath</div>
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

// The setup list is fetched in the background for Today, at most every few minutes; Telegram's
// status comes from Telegram itself, so it should not hold up the day.
function loadSetup() {
  if (state.setupAt && Date.now() - state.setupAt < 5 * 60000) return;
  state.setupAt = Date.now();
  api('GET', '/api/setup-status').then((s) => {
    state.setup = s;
    if (state.route === 'today' && !state.dirty && !state.sheet) render();
  }).catch(() => { state.setupAt = 0; });
}

async function load(route) {
  if (route === 'today') {
    await fetchToday();
    if (!state.offline) loadSetup();
  }
  if (route === 'plan') state.plan = await api('GET', '/api/plan');
  if (route === 'coach') state.coach = await api('GET', '/api/coach');
  if (route === 'review') state.review = await api('GET', '/api/review');
  if (route === 'dashboard') await loadDashboard();
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
  const views = { today: viewToday, plan: viewPlan, coach: viewCoach, review: viewReview, settings: viewSettings, dashboard: viewDashboard };
  (views[state.route] || viewToday)();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [route, param] = (path || 'today').split('/');
  state.route = ROUTES.includes(route) ? route : route === 'ledger' ? 'review' : route === 'health' ? 'dashboard' : 'today';
  state.param = param || null;
  state.query = new URLSearchParams(qs || '');
}

async function go() {
  parseHash();
  render();
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

// iOS only shows Face ID when the request comes straight from a tap, so the server's challenge is
// fetched ahead of time and the tap goes straight to Face ID. Challenges last five minutes.
const fresh = (pre) => pre && Date.now() - pre.at < 4 * 60000;

async function prepareFaceIdLogin() {
  if (!window.PublicKeyCredential) return;
  try {
    state.faceIdLogin = { options: await api('POST', '/api/passkey/login/options', {}), at: Date.now() };
    const slot = document.getElementById('faceid-slot');
    if (slot && !slot.querySelector('[data-action="faceid-login"]')) {
      slot.innerHTML = `<button class="btn chrome big wide" type="button" data-action="faceid-login">${icon('faceid')}Log in with Face ID</button>
        <p class="note">Or use your password.</p>`;
    }
  } catch { /* the password still works */ }
}

// auto: started by the app as it opens rather than by a tap. iOS allows that for the first Face ID
// request after a page loads; if it refuses, the button stays for a tap, with no error shown.
async function faceIdLogin(el, { auto = false } = {}) {
  if (!window.PublicKeyCredential) {
    gateError('This browser cannot use Face ID. Open Oath from the Home Screen on your iPhone.');
    return;
  }
  el.disabled = true;
  try {
    const pre = fresh(state.faceIdLogin) ? state.faceIdLogin : { options: await api('POST', '/api/passkey/login/options', {}) };
    state.faceIdLogin = null;
    const cred = await navigator.credentials.get({ publicKey: getOptions(pre.options) });
    await api('POST', '/api/passkey/login', { response: credentialJSON(cred) });
    location.hash = location.hash || '#/today';
    await go();
    resyncPush();
  } catch (err) {
    if (!(auto && err.name === 'NotAllowedError')) {
      gateError(err.name === 'NotAllowedError' ? 'Face ID was cancelled. Tap to try again.' : err.message);
    }
    el.disabled = false;
    prepareFaceIdLogin();
  }
}

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
    return settingsCard('faceid', 'Face ID', '<p class="muted">This browser cannot use Face ID login. Open Oath from the Home Screen on your iPhone.</p>');
  }
  const keys = state.passkeys || [];
  const rows = keys.map((k) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(k.device || 'Device')}</span>
      <span class="li-sub">Added ${fmtDay(String(k.createdAt).slice(0, 10))}${k.lastUsed ? `, last used ${ago(k.lastUsed)}` : ', not used yet'}</span></span>
      <button class="btn tinted small" data-action="faceid-remove" data-id="${esc(k.id)}">Remove</button></div>`).join('');
  const lockOn = state.settings?.faceIdLock !== false;
  const text = !keys.length
    ? 'Open Oath with your face. Your iPhone keeps the key; Oath only stores its public half.'
    : lockOn ? 'Oath opens with Face ID only, every time. Without Face ID, the password needs the recovery code (SETUP_CODE in Railway).'
      : 'These devices can log in with your face. The password also works on its own.';
  const lock = keys.length
    ? `<label class="check"><input type="checkbox" data-action="faceid-lock"${lockOn ? ' checked' : ''}> Face ID every time Oath opens</label>`
    : '';
  return settingsCard('faceid', 'Face ID', `<p class="muted">${text}</p>
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
  haptic();
  if (row) row.classList.add('kept', 'pending');
  el.disabled = true;
  const ok = await act(() => api('POST', `/api/habits/${id}/keep`, { minimum }));
  if (ok) {
    react(ok.reaction);
    state.dodging = null;
    await refreshToday();
  } else {
    if (row) row.classList.remove('kept', 'pending');
    el.disabled = false;
  }
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

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  const a = el.dataset.action;
  if (await goalsClick(a, el)) return;
  if (await dataClick(a, el)) return;
  if (a === 'keep') {
    await keepHabit(el, id);
  } else if (a === 'keep-minimum') {
    await keepHabit(el, id, true);
  } else if (a === 'undo') {
    if (await act(() => api('POST', `/api/habits/${id}/undo`, {}), 'Undone.')) await refreshToday();
  } else if (a === 'task-done') {
    haptic();
    const row = el.closest('.li');
    if (row) row.classList.add('done', 'pending');
    const ok = await act(() => api('POST', `/api/tasks/${id}/done`, {}));
    if (ok) { react(ok.reaction); await refreshCurrent(); } else if (row) row.classList.remove('done', 'pending');
  } else if (a === 'task-undo') {
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
    if (a === 'focus-done') haptic();
    const r = await act(() => api('POST', `/api/focus/${id}/finish`, { outcome: a === 'focus-done' ? 'done' : 'stopped' }));
    if (r) { react(r.reaction); await refreshToday(); } else el.disabled = false;
  } else if (a === 'now-done') {
    el.disabled = true;
    haptic();
    const path = el.dataset.kind === 'habit' ? `/api/habits/${id}/keep` : `/api/tasks/${id}/done`;
    const r = await act(() => api('POST', path, {}));
    if (r) { react(r.reaction); await refreshToday(); } else el.disabled = false;
  } else if (a === 'not-now') {
    state.dodging = { kind: el.dataset.kind, id };
    render();
  } else if (a === 'dodge-cancel') {
    state.dodging = null;
    toast('Good. Start it now.');
    render();
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
  } else if (a === 'archive-habit') {
    if (!confirm('Archive this habit? If it is due today, today still counts.')) return;
    const r = await act(() => api('DELETE', `/api/habits/${id}`), (x) => (x.from > state.plan.today ? `Archived from ${fmtDay(x.from)}. Today still counts.` : 'Archived.'));
    if (r) { state.sheet = null; await go(); }
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
      state.today = null;
    }
  } else if (a === 'retry') {
    location.reload();
  } else if (a === 'faceid-login') {
    await faceIdLogin(el);
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
  } else if (a === 'faceid-remove') {
    if (!confirm('Remove Face ID login for this device? The password keeps working.')) return;
    if (await act(() => api('DELETE', `/api/passkeys/${encodeURIComponent(el.dataset.id)}`), 'Face ID removed for that device.')) {
      await load('settings');
      render();
    }
  } else if (a === 'setup-hide') {
    try { localStorage.setItem('oath.setupHidden', el.dataset.done); } catch { /* storage unavailable */ }
    render();
  } else if (a === 'push-on') {
    if (await act(pushOn, 'Reminders are on for this device.')) { await refreshPushState(); render(); }
  } else if (a === 'push-off') {
    if (await act(pushOff, 'Reminders are off for this device.')) { await refreshPushState(); render(); }
  } else if (a === 'push-test') {
    await act(() => api('POST', '/api/push/test', {}), (r) => (r.sent ? 'Test sent. It should arrive in a few seconds.' : 'No device is registered. Turn reminders on again.'));
  } else if (a === 'logout') {
    await act(() => api('POST', '/api/logout', {}));
    try { localStorage.removeItem(TODAY_CACHE); } catch { /* storage unavailable */ }
    renderLogin();
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
    if (kind === 'login') {
      try {
        await api('POST', '/api/login', form2obj(form));
        location.hash = '#/today';
        await go();
        resyncPush();
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
      if (r) { state.dodging = null; react(r.reaction); await refreshToday(); }
    } else if (kind === 'reflect') {
      const r = await act(() => api('POST', '/api/reflection', form2obj(form)), 'Day closed.');
      if (r) await refreshToday();
    } else if (kind === 'quick-task') {
      const text = form2obj(form).title;
      const r = await act(() => api('POST', '/api/capture', { text }));
      if (r) {
        haptic();
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
      const r = await act(() => api('POST', '/api/coach', { text }));
      state.sending = false;
      if (r) state.coach.messages.push(r.reply);
      render();
      state.today = null;
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
  if (e.key === 'Escape' && (state.sheet || state.sheetNode)) {
    state.sheet = null;
    state.sheetNode = null;
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
    haptic();
    toast('Sworn. Now do it.', false, 3500, true);
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
}, 15000);

setInterval(() => {
  if (document.visibilityState === 'visible' && state.route === 'today' && state.today && !state.sheet && !state.dirty && !document.activeElement?.matches('input, textarea, select')) refreshToday().catch(() => {});
}, 60000);

// Back after more than a minute away: with Face ID only, start over, which locks and asks again.
// A fresh page load also lets iOS start Face ID without a tap.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  if (state.faceIdOnly && hiddenAt && Date.now() - hiddenAt > 60000 && document.querySelector('.tabbar')) {
    location.reload();
    return;
  }
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
  if (document.querySelector('.tabbar') && !state.sheet && !state.dirty && !document.activeElement?.matches('input, textarea, select')) go();
});

window.addEventListener('hashchange', () => {
  state.pardoning = null;
  state.sheet = state.route === 'review' ? state.sheet : null;
  state.editingGoal = false;
  state.sheetNode = null;
  state.sheetMode = null;
  state.dodging = null;
  window.scrollTo({ top: 0 });
  go();
});

// The sidebar arrives at 900px and the two-column layouts at 1240px.
['(min-width: 900px)', '(min-width: 1240px)'].forEach((q) => window.matchMedia(q).addEventListener('change', () => render()));

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
  try {
    const s = await api('GET', '/api/session');
    if (!s.authed) {
      if (!s.setupDone) {
        $app.innerHTML = '<div class="gate"><div class="wordmark">Oath</div><p>Open the setup link you were given to choose your password.</p></div>';
        return;
      }
      return renderLogin(s);
    }
    // Face ID only: every time the app opens, it locks its own session first and asks for Face ID.
    if (s.faceIdOnly) {
      await api('POST', '/api/lock', {}).catch(() => {});
      return renderLogin({ ...s, authed: false, locked: true });
    }
    rememberLockMode(false);
    await go();
    resyncPush();
  } catch (err) {
    if (err.status === 0 && lockModeRemembered()) {
      $app.innerHTML = `<div class="gate"><div class="wordmark">Oath</div><p>Offline. Oath needs a connection to check Face ID.</p>
        <div class="form-actions"><button class="btn primary" data-action="retry">Retry</button></div></div>`;
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
    $app.innerHTML = `<div class="gate"><div class="wordmark">Oath</div><p>${esc(err.message)}</p>
      <div class="form-actions"><button class="btn primary" data-action="retry">Retry</button></div></div>`;
  }
}

boot();
