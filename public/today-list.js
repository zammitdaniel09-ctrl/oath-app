// Today's own lists, under the overview (today.js): the oath, Up next and the Now panel, the habits and
// tasks with their ticks, pardons and "Not now", the schedule and the backlog, and the page that puts
// them together. Plain strings, drawn on every redraw.
import {
  icon, fmtInt, bar, strengthChip, fmtDay, esc, left, urgency, CHECK, fmtClock, state, addDays, fmtMin, localNowHM,
  safeColor, isIOS, isStandalone, ago, miniRing, brandMark, pageHead, iconLink, haptic, act, api, reduced, RING_MS, fx,
  react, toast, $app, form2obj, dayShare,
} from './ui.js';
import { AUTO_LABELS, autoValue } from './data.js';
import { ringHero, nextTile, overview, afterToday, weekTrack, cleanRun } from './today.js';
import { mailChip } from './mail.js';
import { richHtml } from './rich.js';
import { goalsHref } from './goals.js';
import * as motion from './motion.js';

let ctx = {
  shell: () => {}, skeleton: () => {}, load: () => {}, fetchToday: () => {}, render: () => {}, refreshToday: () => {},
  refreshCurrent: () => {},
};
export function initTodayList(c) {
  ctx = { ...ctx, ...c };
}

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
    meta = `<span class="good">Week done</span>. ${flexLine}.${i.closedToday ? '' : ' Log more if you like.'}`;
    if (!i.closedToday) actions = `<button class="btn tinted small" data-action="keep" data-id="${i.id}">Log today</button>`;
  } else if (i.status === 'closed') {
    meta = `Closed until tomorrow. ${flexLine}, today's log-by time was ${dueLabel(i.deadline)}.`;
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

// Misses that can still be pardoned but have no row of their own today: one due at midnight, a weekly
// habit settled on Sunday, yesterday evening's. Without this they could only be pardoned through the coach.
function recentMisses(t) {
  if (!t.game.pardonsLeft) return '';
  const shown = new Set([...t.items.map((i) => i.missId), ...t.tasks.map((k) => k.missId)].filter(Boolean));
  const rest = (t.pardonable || []).filter((p) => !shown.has(p.id));
  if (!rest.length) return '';
  const when = (d) => (d === addDays(t.today, -1) ? 'Yesterday' : d === t.today ? 'Today' : fmtDay(d));
  return `<section class="section"><div class="gh"><h2>Recent misses</h2><span class="gh-count">Pardonable</span></div>
    <div class="group">${rest.map((p) => `<div class="li missed">
      <span class="chk">${CHECK}</span>
      <span class="li-body"><span class="li-title">${esc(p.title)}</span><span class="li-sub"><span class="bad">Missed ${when(p.date)}${p.hpLost ? `, minus ${p.hpLost} HP` : ''}</span></span></span>
      <span class="li-side"></span>
      <div class="li-actions">${pardonControls(p.id, t)}</div></div>`).join('')}</div></section>`;
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
    // What the miss really cost: the daily cap or a death that day can make it less than the penalty.
    const lost = k.missHpLost ?? k.penalty;
    meta = `<span class="bad">Missed${lost ? `, minus ${lost} HP` : ''}.</span> You can still do it${k.canDelete ? ', or drop it' : ''}.`;
    actions = `<button class="btn tinted small" data-action="task-done" data-id="${k.id}">Mark done</button>${pardonControls(k.missId, t)}${k.canDelete ? `<button class="btn tinted small" data-action="delete-task" data-id="${k.id}">Drop</button>` : ''}`;
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
export function oathView(t) {
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
export function dodgeForm(n) {
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
export function dodgeItem(ref) {
  const t = state.today;
  if (!t || !ref) return null;
  if (ref.kind === 'habit') {
    const i = t.items.find((x) => x.id === ref.id && x.status === 'open');
    return i && { kind: 'habit', id: i.id, title: i.title, minimum: i.minimum, heavy: i.heavy, deadline: i.deadline };
  }
  const k = [...t.tasks, ...t.anytime].find((x) => x.id === ref.id && x.status === 'open');
  return k && { kind: 'task', id: k.id, title: k.title, heavy: k.heavy, deadline: k.deadline };
}

// Up next's deadline as a gauge from the start of the day: the knob is now and moves on (app.js), the
// end is the deadline. It takes the card's colour, which warms as the deadline nears.
function deadlineGauge(n) {
  const v = dayShare(n.dueAt);
  return `<div class="now-gauge">
      <div class="gauge" style="--v:${v.toFixed(3)}" data-gauge-due="${n.dueAt}" role="img" aria-label="${esc(`Due ${dueLabel(n.deadline)}`)}"><i></i><b>${icon('bolt')}</b></div>
      <span class="gauge-scale" aria-hidden="true"><span>Today</span><span>Due <b>${esc(dueLabel(n.deadline))}</b></span></span>
    </div>`;
}

// Everything due today done with nothing missed: the run of clean days, counting today, big on a glow,
// with the week's days under it.
function securedCard(t) {
  // A rest day neither breaks nor adds to the run, but the moment still counts at least this day.
  const run = Math.max(1, cleanRun(t) + (t.rest ? 0 : 1));
  return `<section class="card now secured glow-card" aria-label="Day secured">
    <span class="glow-flame" aria-hidden="true">${icon('flame')}</span>
    <b class="glow-num">${run}</b>
    <span class="glow-label">${run === 1 ? 'Day secured' : 'clean days in a row'}</span>
    <p class="glow-sub">Everything due today is done.${t.bonusDue > 0 ? ` Keep it clean to midnight for +${t.bonusDue} HP.` : ''}</p>
    ${weekTrack(t, { key: 'week-glow', today: t.rest ? null : 'clean' })}
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
    // "Secured" only when nothing was missed; otherwise it is just over for today.
    const missed = t.progress.total - t.progress.done - t.progress.open > 0;
    if (!missed) return securedCard(t);
    return `<section class="card now secured">
      <p class="eyebrow">${icon('check')}Nothing left today</p>
      <h2 class="now-title">Everything else due today is done, Boss.</h2>
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
  else if (n.missedLast && n.flexible) label = `Missed last week, hit ${n.weekTarget} for +${t.settings.comebackBonus} HP on Sunday`;
  else if (n.missedLast) label = `Missed last time, keep it for +${t.settings.comebackBonus} HP`;
  const sub = [];
  if (n.cue) sub.push(`After ${esc(n.cue)}`);
  if (n.firstStep) sub.push(`First step: ${esc(n.firstStep)}`);
  if (n.lastPlan) sub.push(`Your plan: ${esc(n.lastPlan)}`);
  // The card takes the colour of its countdown, and says how much of the day is left to win.
  const p = t.progress;
  const heat = n.dueAt ? ` u-${urgency(n.dueAt)}" data-due="${n.dueAt}` : ' u-calm';
  // What is still open; a miss is not "to go".
  const toGo = p.open;
  return `<section class="card now${n.isFocus ? ' is-focus' : ''}${n.missedLast ? ' relapse' : ''}${heat}" data-next="${n.kind}:${n.id}">
    <div class="now-top"><p class="eyebrow">${icon(n.isFocus ? 'focus' : 'bolt')}${label}</p>${l ? `<span class="now-left ${l.cls}" data-left="${n.dueAt}">${l.text}</span>` : ''}</div>
    <h2 class="now-title">${esc(n.title)}</h2>
    <p class="now-meta">${metaParts.join(', ')}</p>
    ${n.dueAt ? deadlineGauge(n) : ''}
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
    // A VLE deadline already has its task among the rows below (with its time and HP), so it is not listed
    // twice. Past is judged on the real end, so an event running past midnight stays on until it ends, and
    // one that began last night is listed from the start of today.
    ...events.filter((e) => !e.allDay && !e.deadline).map((e) => {
      const before = e.start.slice(0, 10) < t.today;
      const endMs = Date.parse(e.end || e.start);
      return {
        time: before ? '00:00' : e.time, title: e.title, kind: 'event', color: e.color, done: Boolean(e.done),
        sub: [e.done ? 'Done' : '', e.endTime && e.endTime !== e.time ? `until ${e.endTime}` : '', e.location, e.feed].filter(Boolean).join(', '),
        past: Number.isFinite(endMs) ? endMs <= Date.now() : (e.endTime || e.time) < now,
      };
    }),
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
    return `${marker}<div class="tl-row ${r.kind}${r.past ? ' past' : ''}${r.done ? ' done' : ''}"${safeColor(r.color) ? ` style="--c:${safeColor(r.color)}"` : ''}>
      <span class="tl-time">${r.time}</span>
      <span class="tl-bar"></span>
      <span class="tl-body"><span class="tl-title">${r.done ? icon('check', 'done-ic') : ''}${esc(r.title)}</span>${r.sub ? `<span class="tl-sub">${esc(r.sub)}</span>` : ''}</span>
    </div>`;
  }).join('') + (nowPlaced ? '' : `<div class="tl-now"><span>${now}</span></div>`);
  return `<section class="section"><div class="gh"><h2>Schedule</h2><a href="#/calendar" class="gh-link">Calendar</a></div>
    <div class="card timeline">
      ${allDay.length ? `<div class="tl-allday">${allDay.map((e) => `<span class="tl-chip${e.done ? ' done' : ''}"${safeColor(e.color) ? ` style="--c:${safeColor(e.color)}"` : ''}>${e.done ? icon('check', 'done-ic') : ''}${esc(e.title)}</span>`).join('')}</div>` : ''}
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
    return `<span class="tchip" title="Share, then Add to Home Screen">Add to Home Screen for reminders</span>`;
  }
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported || Notification.permission !== 'default') return '';
  return `<button class="tchip act" data-action="push-on">Turn on reminders</button>`;
}

// Offline, reminders, a rest day, a waiting review and important email: one row of small chips under the rings.
function statusChips(t) {
  const chips = [
    state.offline ? `<button class="tchip warn" data-action="retry">Offline, ${t.today === realToday(t) ? 'today' : fmtDay(t.today)} as of ${fmtClock(state.offline)}<b>Retry</b></button>` : '',
    t.rest ? `<span class="tchip calm">Rest day</span>` : '',
    t.reviewDue ? `<a class="tchip act" href="#/review">Review ready${icon('chevron', 'chev')}</a>` : '',
    mailChip(t),
    remindersChip(),
  ].filter(Boolean);
  return chips.length ? `<div class="tchips" role="group" aria-label="Status">${chips.join('')}</div>` : '';
}

// One row per connection: green once it works, otherwise what is missing, linking to where to fix it.
export function setupRows(s) {
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

export function goalsStrip(goals) {
  if (!goals?.length) return '';
  return `<section class="section"><div class="gh"><h2>Goals</h2><a class="gh-link" href="${goalsHref()}">All goals</a></div>
    <div class="goal-mini">${goals.map((g) => `<a href="#/goals/${g.id}" class="goal-mini-row">
      ${miniRing(g.pct ?? 0, 34)}<span><span class="goal-mini-title">${esc(g.title)}</span><span class="goal-mini-label">${g.pct === null ? '' : `${g.pct}%, `}${esc(g.label)}</span></span>${icon('chevron', 'chev')}</a>`).join('')}</div></section>`;
}

function closeDayCard(t) {
  if (t.reflection) {
    return `<section class="section"><div class="gh"><h2>Day closed</h2><span class="gh-count">${t.reflection.rating} out of 5</span></div>
      <div class="card brief"><p class="eyebrow">Coach</p><div class="brief-text rich">${richHtml(t.reflection.coachReply || 'The coach is writing back.')}</div>${t.reflection.tomorrow ? `<p class="brief-who">Tomorrow's one thing: ${esc(t.reflection.tomorrow)}</p>` : ''}</div></section>`;
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

export function quickAdd(id = 'quick-task') {
  return `<form class="li li-add" data-form="quick-task">
    <span class="add-ic">${icon('plus')}</span>
    <label class="sr" for="${id}">New task</label>
    <input id="${id}" class="add-input" name="title" placeholder="Add a task: call the bank fri 3pm" autocomplete="off" maxlength="200" required data-preview>
    <button class="btn primary small" type="submit">Add</button>
    <div class="parse-preview" aria-live="polite"></div>
  </form>`;
}

// One line to the coach from anywhere in the day: "move the dentist to Friday", "I did the gym".
export function askCoach(where) {
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
// A new screen starts at the top, where Up next is in view.
export function resetDock() {
  dockShown = false;
}
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
  return `<section class="card brief"><p class="eyebrow">${titles[brief.kind] || 'Coach'}, ${fmtClock(brief.at)}</p><div class="brief-text rich">${richHtml(brief.text)}</div></section>`;
}

export function viewToday() {
  const t = state.today;
  if (!t) return ctx.shell(ctx.skeleton('Today'));
  const part = t.localHour < 12 ? 'Morning' : t.localHour < 18 ? 'Afternoon' : 'Evening';
  const head = pageHead(`${part}, <em>Boss</em>`, {
    over: fmtDay(t.today, { weekday: 'long', day: 'numeric', month: 'long' }),
    actions: `<span class="only-narrow-flex">${iconLink('#/health', 'heart', 'Health')}</span>${iconLink('#/settings', 'settings', 'Settings')}`,
  });
  const banners = statusChips(t);

  // No oath yet and something is due: the oath row sits under Up next, and the lists stay tickable.
  const needsOath = !t.plan && t.progress.open > 0;

  // The overview leads: the rings, then what is next, then the small charts. The lists follow.
  const ov = overview(t, state.foodToday, nextOnCalendar(t));

  if (!t.items.length && !t.tasks.length && !t.anytime.length && !t.triage.length) {
    ctx.shell(`${head}${ringsCard(t)}${banners}
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

  ctx.shell(`${head}<div class="split">
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
      ${recentMisses(t)}
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

export function clockText(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'Time is up';
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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

// After a tick: the Today ring pulses, the day is reloaded, and the reaction says how much is left.
async function afterTick(reaction, current = false) {
  state.justTicked = true;
  const wasOpen = state.today?.progress?.open || 0;
  // The day reloads while the check finishes drawing; then the list settles into its new order.
  const other = current && state.route !== 'today';
  await Promise.all([other ? ctx.load(state.route) : ctx.fetchToday(), motion.tickSettled()]);
  if (other || state.route === 'today') ctx.render();
  const open = state.today?.progress?.open;
  // The last thing due today: a chord and a burst, once. On Today the chord comes from the ring as it
  // closes (today.js), so the burst waits for the same moment; elsewhere both come at once.
  if (wasOpen > 0 && open === 0) {
    if (state.route === 'today') setTimeout(() => motion.celebrate(), reduced() ? 0 : RING_MS);
    else {
      fx('all-done');
      motion.celebrate();
    }
  }
  const tail = open === 0 ? ' Everything due today is done.' : open ? ` ${open} to go.` : '';
  // The server's reaction may already say how much is left ("5 left today") or that the day is done; it
  // is said once.
  const said = (t) => t.includes(tail.trim()) || /\b\d+ (?:left|to go)\b|nothing (?:left|else)|everything due today/i.test(t);
  if (reaction?.text) react({ ...reaction, text: said(reaction.text) ? reaction.text : `${reaction.text}${tail}` });
  else if (tail) toast(tail.trim());
}

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
    await ctx.refreshToday();
    window.scrollTo({ top: 0 });
  }
}

export async function todayClick(a, el) {
  const id = Number(el.dataset.id);
  if (a === 'keep') {
    await keepHabit(el, id);
  } else if (a === 'keep-minimum') {
    await keepHabit(el, id, true);
  } else if (a === 'undo') {
    haptic('untick');
    if (await act(() => api('POST', `/api/habits/${id}/undo`, {}), 'Undone.')) await ctx.refreshToday();
  } else if (a === 'task-done') {
    haptic('tick');
    const row = el.closest('.li');
    if (row) row.classList.add('done', 'pending');
    motion.ticked(row);
    const ok = await act(() => api('POST', `/api/tasks/${id}/done`, {}));
    if (ok) await afterTick(ok.reaction, true); else if (row) row.classList.remove('done', 'pending');
  } else if (a === 'task-undo') {
    haptic('untick');
    if (await act(() => api('POST', `/api/tasks/${id}/undo`, {}), 'Undone.')) await ctx.refreshToday();
  } else if (a === 'triage') {
    const labels = { today: 'Moved to today.', tomorrow: 'Moved to tomorrow.', week: 'Moved to next Monday.', someday: 'Moved to someday.', drop: 'Dropped.' };
    if (await act(() => api('POST', `/api/tasks/${id}/triage`, { action: el.dataset.do }), labels[el.dataset.do])) await ctx.refreshCurrent();
  } else if (a === 'dur') {
    state.focusMinutes = Number(el.dataset.min);
    ctx.render();
  } else if (a === 'focus-start') {
    el.disabled = true;
    haptic();
    const r = await act(() => api('POST', '/api/focus', { kind: el.dataset.kind, id, minutes: state.focusMinutes }), `Clock is running. ${state.focusMinutes} minutes. Phone down.`);
    if (r) await ctx.refreshToday(); else el.disabled = false;
  } else if (a === 'focus-done' || a === 'focus-stop') {
    el.disabled = true;
    if (a === 'focus-done') haptic('tick');
    const r = await act(() => api('POST', `/api/focus/${id}/finish`, { outcome: a === 'focus-done' ? 'done' : 'stopped' }));
    if (r) { react(r.reaction); await ctx.refreshToday(); } else el.disabled = false;
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
    ctx.render();
  } else if (a === 'dodge-cancel') {
    state.dodging = null;
    if (state.sheet?.kind === 'dodge') state.sheet = null;
    toast('Good. Start it now.');
    ctx.render();
  } else if (a === 'pardon') {
    state.pardoning = id;
    ctx.render();
    document.querySelector('.pardon-form textarea')?.focus();
  } else if (a === 'pardon-cancel') {
    state.pardoning = null;
    ctx.render();
  } else return false;
  return true;
}

export async function todaySubmit(kind, form) {
  if (kind === 'oath') {
    await takeOath(form);
  } else if (kind === 'defer') {
    const f = new FormData(form);
    const reason = (f.get('own') || '').trim() || f.get('reason') || '';
    const r = await act(() => api('POST', '/api/defer', { kind: form.dataset.kind, id: Number(form.dataset.id), reason, moveToTomorrow: f.get('move') === 'on' }));
    if (r) {
      state.dodging = null;
      if (state.sheet?.kind === 'dodge') state.sheet = null;
      react(r.reaction);
      await ctx.refreshToday();
    }
  } else if (kind === 'reflect') {
    const r = await act(() => api('POST', '/api/reflection', form2obj(form)), 'Day closed.');
    if (r) await ctx.refreshToday();
  } else if (kind === 'quick-task') {
    const text = form2obj(form).title;
    const r = await act(() => api('POST', '/api/capture', { text }));
    if (r) {
      haptic('success');
      toast(r.say);
      form.reset();
      form.querySelector('.parse-preview').innerHTML = '';
      await ctx.refreshCurrent();
    }
  } else if (kind === 'pardon') {
    const f = form2obj(form);
    const r = await act(() => api('POST', `/api/misses/${form.dataset.id}/pardon`, { reason: f.reason, plan: f.plan }), (x) => `Pardoned. ${x.pardonsLeft} left this month.`);
    if (r) { state.pardoning = null; await ctx.refreshToday(); }
  } else return false;
  return true;
}
