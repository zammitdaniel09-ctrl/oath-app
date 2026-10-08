// Oath web app. Plain modules, no build step.
import {
  $app, state, hooks, esc, ApiError, api, toast, react, act, form2obj, fmtClock, fmtDay, left, daysBetween, fmtMin,
  DAY_NAMES, scheduleText, CHECK, isStandalone, isIOS, haptic, bar, strengthChip, localToday, localNowHM,
} from './ui.js';
import { parseCapture } from './parse.js';
import { initGoals, loadGoals, loadGoal, viewGoals, viewGoalNew, viewGoal, goalsClick, goalsSubmit } from './goals.js';

// ---------- Shell ----------

const TABS = [
  ['today', 'Today'],
  ['plan', 'Plan'],
  ['goals', 'Goals'],
  ['coach', 'Coach'],
  ['review', 'Review'],
];
const ROUTES = ['today', 'plan', 'goals', 'coach', 'review', 'settings'];

function shell(inner) {
  const nav = TABS.map(([id, label]) => `<a href="#/${id}"${state.route === id ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const settings = `<a href="#/settings" class="wide-only"${state.route === 'settings' ? ' aria-current="page"' : ''}>Settings</a>`;
  $app.innerHTML = `<main>${inner}</main><nav class="tabbar" aria-label="Sections">${nav}${settings}</nav>`;
  applyResponsive();
}

function applyResponsive() {
  const wide = window.matchMedia('(min-width: 900px)').matches;
  document.querySelectorAll('.only-wide').forEach((el) => { el.hidden = !wide; });
  document.querySelectorAll('.only-narrow').forEach((el) => { el.hidden = wide; });
}

initGoals({ shell, render: () => render(), go: () => go() });

// ---------- Today ----------

function meter(game, lostToday) {
  const per = game.maxHp / 20;
  const on = Math.max(0, Math.min(20, Math.round(game.hp / per)));
  const lost = Math.max(0, Math.min(20 - on, Math.round(lostToday / per)));
  const low = game.hp <= 30;
  let cells = '';
  for (let i = 0; i < 20; i += 1) cells += `<i class="${i < on ? 'on' : i < on + lost ? 'lost' : ''}"></i>`;
  return { html: `<div class="meter${low ? ' low' : ''}" role="img" aria-label="${game.hp} of ${game.maxHp} HP">${cells}</div>`, low };
}

function streakText(i) {
  if (!i.streak) return '';
  return i.flexible ? `${i.streak} ${i.streak === 1 ? 'week' : 'weeks'} in a row` : `${i.streak} day streak`;
}

function habitRow(i, t) {
  const cls = `row ${i.status}${i.heavy ? ' heavy' : ''}`;
  const side = `<span class="row-side">${strengthChip(i.strength)}</span>`;
  const rulesNote = i.rulesChangeFrom ? `, new rules from ${fmtDay(i.rulesChangeFrom)}` : '';
  const cue = i.cue ? `After ${esc(i.cue)}. ` : '';
  const flexLine = i.flexible ? `${i.weekDone} of ${i.weekTarget} this week` : '';
  if (i.status === 'open') {
    const l = left(i.dueAt);
    const when = i.flexible
      ? `${flexLine}${i.mustToday ? `, <span class="soon">must be today</span>` : ''}`
      : `Due ${i.deadline}, <span class="${l.cls}" data-left="${i.dueAt}">${l.text}</span>${i.heavy ? `, ${i.penalty} HP at stake` : ''}`;
    const relapse = i.missedLast ? '<span class="tag">Missed last time</span> ' : '';
    return `<button class="${cls}" data-action="keep" data-id="${i.id}">
      <span class="box">${CHECK}</span>
      <span><span class="row-title">${relapse}${esc(i.title)}</span>
        <span class="row-meta" style="display:block">${cue}${when}${rulesNote}</span></span>
      ${side}</button>`;
  }
  let meta = '';
  let actions = '';
  if (i.status === 'kept') {
    meta = `<span class="good">${i.keptMinimum ? 'Minimum kept' : i.comeback ? 'Comeback' : 'Kept'}</span> at ${fmtClock(i.keptAt)}${i.flexible ? `. ${flexLine}` : ''}${streakText(i) ? `. ${streakText(i)}` : ''}`;
    if (i.canUndo) actions = `<button class="btn quiet small" data-action="undo" data-id="${i.id}">Undo</button>`;
  } else if (i.status === 'met') {
    meta = `<span class="good">Week done</span>. ${flexLine}. Log more if you like.`;
    actions = `<button class="btn quiet small" data-action="keep" data-id="${i.id}">Log today</button>`;
  } else if (i.status === 'missed') {
    meta = `<span class="bad">Missed at ${i.deadline}, minus ${i.penalty} HP${i.missRepeat ? ' (second in a row)' : ''}</span>. Keep it next time for +${t.settings.comebackBonus} HP.`;
    actions = pardonControls(i.missId, t);
  } else if (i.status === 'pardoned') {
    meta = 'Pardoned. Streak kept, HP restored.';
  }
  return `<div class="${cls}">
    <span class="box">${CHECK}</span>
    <span><span class="row-title">${esc(i.title)}</span><span class="row-meta" style="display:block">${meta}</span></span>
    ${side}
    ${actions ? `<div class="row-actions">${actions}</div>` : ''}
  </div>`;
}

function pardonControls(missId, t) {
  if (!missId || !t.pardonable.some((p) => p.id === missId)) return '';
  if (state.pardoning === missId) {
    return `<form class="pardon-form" data-form="pardon" data-id="${missId}" style="width:100%">
      <label class="field"><span>What specifically got in the way?</span>
        <textarea class="input" name="reason" minlength="10" required></textarea></label>
      <label class="field"><span>If that happens again, I will...</span>
        <input class="input" name="plan" minlength="10" required value="If " autocomplete="off"></label>
      <p class="note">Your plan is quoted back in this habit's next reminder.</p>
      <div class="form-actions">
        <button class="btn" type="submit">Pardon it</button>
        <button class="btn quiet" type="button" data-action="pardon-cancel">Cancel</button>
      </div></form>`;
  }
  if (t.game.pardonsLeft <= 0) return '<span class="faint" style="font-size:13.5px">No pardons left this month</span>';
  return `<button class="btn quiet small" data-action="pardon" data-id="${missId}">Use a pardon (${t.game.pardonsLeft} left)</button>`;
}

function taskRow(k, t) {
  const cls = `row ${k.status}${k.heavy ? ' heavy' : ''}`;
  let due = 'No date';
  if (k.dueDate) {
    const dayText = k.dueDate === t.today ? 'today' : fmtDay(k.dueDate);
    due = k.overdue ? `<span class="bad">Overdue since ${fmtDay(k.dueDate)}</span>` : `Due ${dayText}${k.deadline ? ` ${k.deadline}` : ''}`;
  }
  const extras = [
    k.heavy ? `${k.penalty} HP at stake` : '',
    k.estimate ? `about ${fmtMin(k.estimate)}` : '',
    k.goalTitle ? esc(k.goalTitle) : '',
    k.createdBy === 'coach' ? 'added by the coach' : k.createdBy === 'siri' ? 'added by Siri' : '',
  ].filter(Boolean).join(', ');
  if (k.status === 'open') {
    const l = k.heavy && k.dueAt && k.dueDate === t.today ? left(k.dueAt) : null;
    return `<button class="${cls}" data-action="task-done" data-id="${k.id}">
      <span class="box">${CHECK}</span>
      <span><span class="row-title">${esc(k.title)}</span>
        <span class="row-meta" style="display:block">${due}${l ? `, <span class="${l.cls}" data-left="${k.dueAt}">${l.text}</span>` : ''}${extras ? `, ${extras}` : ''}</span>
        ${k.heavy && k.firstStep ? `<span class="row-meta first-step" style="display:block">First step: ${esc(k.firstStep)}</span>` : ''}</span>
      <span></span></button>`;
  }
  let meta = '';
  let actions = '';
  if (k.status === 'done') {
    meta = `<span class="good">Done</span> at ${fmtClock(k.doneAt)}`;
    if (k.canUndo) actions = `<button class="btn quiet small" data-action="task-undo" data-id="${k.id}">Undo</button>`;
  } else if (k.status === 'missed') {
    meta = `<span class="bad">Missed, minus ${k.penalty} HP.</span> You can still do it.`;
    actions = `<button class="btn quiet small" data-action="task-done" data-id="${k.id}">Mark done</button>${pardonControls(k.missId, t)}`;
  } else if (k.status === 'pardoned') {
    meta = 'Pardoned.';
    actions = `<button class="btn quiet small" data-action="task-done" data-id="${k.id}">Mark done</button>`;
  }
  return `<div class="${cls}">
    <span class="box">${CHECK}</span>
    <span><span class="row-title">${esc(k.title)}</span><span class="row-meta" style="display:block">${meta}</span></span>
    <span></span>
    ${actions ? `<div class="row-actions">${actions}</div>` : ''}
  </div>`;
}

function hpBars(days, n = 14) {
  const list = days.slice(-n);
  if (!list.length) return '<p class="muted" style="margin-top:8px">Your first day closes at midnight.</p>';
  const bars = list.map((d) => `<i class="${d.rest ? 'rest' : d.clean ? 'clean' : d.missed > 0 ? 'dirty' : ''}" style="height:${Math.max(3, d.hp_end)}%" title="${fmtDay(d.date)}: ${d.hp_end} HP"></i>`).join('');
  return `<div class="bars" role="img" aria-label="HP at the end of each of the last ${list.length} days">${bars}</div>
    <div class="bars-legend"><span>${fmtDay(list[0].date)}</span><span>${fmtDay(list[list.length - 1].date)}</span></div>`;
}

const REASONS = ['Tired', 'No time', 'Don\'t feel like it', 'Waiting on something', 'Scared of it'];
const DURATIONS = [15, 25, 45, 60];

function capacityLine(c, settings) {
  if (!c) return '';
  const over = c.over > 0;
  return `<p class="capacity${over ? ' over' : ''}">Estimated task work today: <b>${fmtMin(c.estimated)}</b>. Time left before ${settings.dayEnd}: <b>${fmtMin(c.available)}</b>.${over ? ` That is ${fmtMin(c.over)} more than you have. Move or cut something now, not at 21:00.` : ''}</p>`;
}

function oathView(t) {
  const open = [...t.openDue].sort((a, b) => (a.dueAt || '9').localeCompare(b.dueAt || '9'));
  const weekday = fmtDay(t.today, { weekday: 'long' });
  const choices = open.map((i) => `<label class="pick-row${i.heavy ? ' heavy' : ''}">
      <input type="radio" name="focus" value="${i.kind}:${i.id}">
      <span class="pick-mark" aria-hidden="true"></span>
      <span><span class="pick-title">${esc(i.title)}</span>
        <span class="pick-meta">by ${i.deadline || '23:59'}${i.heavy ? `, ${i.penalty} HP at stake` : ''}</span></span>
    </label>`).join('');
  return `<section class="oath">
    <h1 class="oath-title">${weekday}. Take the oath.</h1>
    <p class="oath-sub">${open.length} ${open.length === 1 ? 'thing stands' : 'things stand'} between you and a clean day. ${t.progress.atStake} HP at stake.</p>
    ${t.lastNight ? `<p class="last-night">Last night you planned: <b>${esc(t.lastNight)}</b></p>` : ''}
    ${capacityLine(t.capacity, t.settings)}
    <form data-form="oath">
      <fieldset class="pick"><legend>Pick the one that matters most today</legend>${choices}</fieldset>
      <label class="field"><span>When and where will you do it?</span>
        <input class="input" name="intention" maxlength="300" autocomplete="off" required value="${esc(t.lastNight || '')}" placeholder="10:00 at my desk, phone in the kitchen"></label>
      <button type="button" class="hold" data-hold="oath"><span class="hold-fill"></span><span class="hold-label">Hold to take the oath</span></button>
    </form>
  </section>`;
}

function nowPanel(t) {
  if (t.focus) {
    const total = t.focus.minutes * 60000;
    const leftMs = new Date(t.focus.endsAt).getTime() - Date.now();
    const pct = Math.min(100, Math.max(0, 100 - (leftMs / total) * 100));
    return `<section class="now in-focus">
      <p class="now-label">In focus</p>
      <h2 class="now-title">${esc(t.focus.title)}</h2>
      <div class="clock" data-ends="${t.focus.endsAt}">${clockText(t.focus.endsAt)}</div>
      <div class="focus-bar"><i data-bar-start="${t.focus.startedAt}" data-bar-end="${t.focus.endsAt}" style="width:${pct}%"></i></div>
      <div class="now-actions">
        <button class="btn big" data-action="focus-done" data-id="${t.focus.id}">Done</button>
        <button class="btn quiet" data-action="focus-stop" data-id="${t.focus.id}">Stop</button>
      </div>
    </section>`;
  }
  const n = t.next;
  if (!n) {
    if (!t.progress.total) return '';
    return `<section class="now secured">
      <p class="now-label">Day secured</p>
      <h2 class="now-title">Everything due today is done.</h2>
      <p class="now-meta">Keep it clean to midnight for +${t.settings.cleanBonus} HP. Then close the day below.</p>
    </section>`;
  }
  const l = n.dueAt ? left(n.dueAt) : null;
  const metaParts = [];
  if (n.flexible) metaParts.push(`${n.weekDone} of ${n.weekTarget} this week`);
  else if (n.dueAt) metaParts.push(`Due ${n.deadline || '23:59'}, <span class="${l.cls}" data-left="${n.dueAt}">${l.text}</span>`);
  else metaParts.push('No deadline');
  if (n.heavy) metaParts.push(`${n.penalty} HP at stake`);
  const isTask = n.kind === 'task';
  if (state.dodging && state.dodging.kind === n.kind && state.dodging.id === n.id) {
    const chips = REASONS.map((r) => `<label class="chip"><input type="radio" name="reason" value="${esc(r)}"><span>${esc(r)}</span></label>`).join('');
    return `<section class="now dodging">
      <p class="now-label">Not now?</p>
      <h2 class="now-title">${esc(n.title)}</h2>
      ${n.minimum ? `<button class="btn big minimum-btn" data-action="keep-minimum" data-id="${n.id}">Do the minimum now: ${esc(n.minimum)}</button>
        <p class="note">The minimum saves the HP and the streak. It does not earn the clean-day bonus.</p>` : ''}
      <form data-form="defer" data-kind="${n.kind}" data-id="${n.id}">
        <fieldset class="chips"><legend>Why not now</legend>${chips}</fieldset>
        <label class="field"><span>Or in your own words</span><input class="input" name="own" maxlength="300" autocomplete="off"></label>
        ${isTask && !n.heavy ? '<label class="check"><input type="checkbox" name="move"> Move it to tomorrow</label>' : `<p class="note">${n.kind === 'habit' ? 'Habits cannot be moved.' : 'Hard tasks cannot be moved.'} The deadline stays ${n.deadline || '23:59'}.</p>`}
        <div class="now-actions">
          <button class="btn" type="submit">Log it</button>
          <button class="btn quiet" type="button" data-action="dodge-cancel">Back, I will do it</button>
        </div>
      </form>
    </section>`;
  }
  const chips = DURATIONS.map((d) => `<button type="button" class="dur${state.focusMinutes === d ? ' on' : ''}" data-action="dur" data-min="${d}" aria-pressed="${state.focusMinutes === d}">${d}</button>`).join('');
  let label = 'Do this now';
  if (n.isFocus) label = 'Your one thing. Do it now.';
  else if (n.missedLast) label = `Missed last time. Keep it now for +${t.settings.comebackBonus} HP.`;
  const sub = [];
  if (n.cue) sub.push(`After ${esc(n.cue)}`);
  if (n.firstStep) sub.push(`First step: ${esc(n.firstStep)}`);
  if (n.lastPlan) sub.push(`Your plan: ${esc(n.lastPlan)}`);
  return `<section class="now${n.isFocus ? ' is-focus' : ''}${n.missedLast ? ' relapse' : ''}">
    <p class="now-label">${label}</p>
    <h2 class="now-title">${esc(n.title)}</h2>
    <p class="now-meta">${metaParts.join(', ')}</p>
    ${sub.length ? `<p class="now-cue">${sub.join('<br>')}</p>` : ''}
    <div class="now-actions">
      <button class="btn big" data-action="focus-start" data-kind="${n.kind}" data-id="${n.id}">Start ${state.focusMinutes} min</button>
      <button class="btn quiet" data-action="now-done" data-kind="${n.kind}" data-id="${n.id}">Done</button>
      <button class="btn quiet" data-action="not-now" data-kind="${n.kind}" data-id="${n.id}">Not now</button>
    </div>
    <div class="durs" role="group" aria-label="Focus length in minutes">${chips}<span class="faint">min</span></div>
  </section>`;
}

function progressStrip(t) {
  if (!t.progress.total) return '';
  const pct = Math.round((t.progress.done / t.progress.total) * 100);
  return `<div class="progress">
    <div class="progress-text"><b>${t.progress.done} of ${t.progress.total} done</b><span>${t.progress.atStake ? `${t.progress.atStake} HP still at stake` : 'Nothing at stake'}${t.dodgesToday ? `, ${t.dodgesToday} ${t.dodgesToday === 1 ? 'dodge' : 'dodges'} today` : ''}</span></div>
    <div class="progress-bar"><i style="width:${pct}%"></i></div>
  </div>`;
}

function planCard(t) {
  if (!t.plan?.coachPlan) return '';
  return `<details class="plan-card"${t.localHour < 12 ? ' open' : ''}>
    <summary>Battle plan${t.plan.intention ? `: ${esc(t.plan.intention)}` : ''}</summary>
    <div class="plan-text">${esc(t.plan.coachPlan)}</div>
  </details>`;
}

function triageCard(t) {
  if (!t.triage.length) return '';
  const rows = t.triage.slice(0, 5).map((k) => `<div class="triage-row">
      <span class="row-title">${esc(k.title)}</span>
      <span class="row-meta">${k.dueDate ? `Was due ${fmtDay(k.dueDate)}` : `No date for ${k.ageDays} days`}</span>
      <div class="triage-actions" role="group" aria-label="Decide">
        <button class="btn quiet small" data-action="triage" data-do="today" data-id="${k.id}">Today</button>
        <button class="btn quiet small" data-action="triage" data-do="tomorrow" data-id="${k.id}">Tomorrow</button>
        <button class="btn quiet small" data-action="triage" data-do="week" data-id="${k.id}">Next week</button>
        <button class="btn quiet small" data-action="triage" data-do="drop" data-id="${k.id}">Drop</button>
      </div></div>`).join('');
  return `<section class="section"><div class="section-head"><h3>Clear the backlog</h3><span class="count">${t.triage.length} waiting</span></div>
    <div class="card triage">${rows}<p class="note">One decision each. A pile you never look at is worse than a short list you trust.</p></div></section>`;
}

function goalsStrip(t) {
  if (!t.goals?.length) return '';
  return `<section class="section"><div class="section-head"><h3>Goals</h3><a class="count" href="#/goals">All goals</a></div>
    <div class="goal-mini">${t.goals.map((g) => `<a href="#/goals/${g.id}" class="goal-mini-row">
      <span class="goal-mini-title">${esc(g.title)}</span>${bar(g.pct)}<span class="goal-mini-label">${esc(g.label)}</span></a>`).join('')}</div></section>`;
}

function closeDayCard(t) {
  if (t.reflection) {
    return `<section class="section"><div class="section-head"><h3>Day closed</h3><span class="count">${t.reflection.rating} out of 5</span></div>
      <div class="brief">${esc(t.reflection.coachReply || 'The coach is writing back.')}<div class="brief-who">Coach${t.reflection.tomorrow ? `. Tomorrow's one thing: ${esc(t.reflection.tomorrow)}` : ''}</div></div></section>`;
  }
  if (t.localHour < 18 && t.progress.open) return '';
  const stars = [1, 2, 3, 4, 5].map((n) => `<label class="rate"><input type="radio" name="rating" value="${n}" required><span>${n}</span></label>`).join('');
  return `<section class="section"><div class="section-head"><h3>Close the day</h3></div>
    <form class="card" data-form="reflect">
      <fieldset class="rates"><legend>How was today, honestly?</legend>${stars}</fieldset>
      <label class="field"><span>What got in the way</span><input class="input" name="blocker" maxlength="500" autocomplete="off"></label>
      <label class="field"><span>One win</span><input class="input" name="win" maxlength="500" autocomplete="off"></label>
      <label class="field"><span>Tomorrow's one thing, when and where</span><input class="input" name="tomorrow" maxlength="300" autocomplete="off" placeholder="EA settings review, 9:00 at my desk"></label>
      <div class="form-actions"><button class="btn" type="submit">Close the day</button></div>
    </form></section>`;
}

function quickAdd(id = 'quick-task') {
  return `<form class="inline-form quick" data-form="quick-task">
    <label class="sr" for="${id}">New task</label>
    <input id="${id}" class="input" name="title" placeholder="Add a task: call bank fri 3pm" autocomplete="off" maxlength="200" required data-preview>
    <button class="btn" type="submit">Add</button>
    <div class="parse-preview" aria-live="polite"></div>
  </form>`;
}

function viewToday() {
  const t = state.today;
  if (!t) return shell('<p class="muted">Loading</p>');
  const g = t.game;
  const lostToday = [...t.items, ...t.tasks].filter((i) => i.status === 'missed').reduce((n, i) => n + i.penalty, 0);
  const m = meter(g, lostToday);
  const seasonDay = daysBetween(g.seasonStart, t.today) + 1;

  const vitals = `<header class="vitals">
      <div class="vitals-top">
        <div class="hp${m.low ? ' low' : ''}">${g.hp}<small>HP</small></div>
        <div class="vitals-meta">
          <strong>${fmtDay(t.today, { weekday: 'long', day: 'numeric', month: 'long' })}</strong><br>
          Season ${g.season}, day ${seasonDay}<br>
          ${g.pardonsLeft} ${g.pardonsLeft === 1 ? 'pardon' : 'pardons'} left, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'}
        </div>
      </div>
      ${m.html}
      ${t.weekFocus ? `<p class="week-focus">This week: <b>${esc(t.weekFocus)}</b></p>` : ''}
    </header>`;
  const banners = [
    t.rest ? '<div class="banner rest">Rest day. Fixed habits are excused today. Hard tasks still count.</div>' : '',
    t.reviewDue ? '<a class="banner review-due" href="#/review"><b>Weekly review is ready.</b> Five minutes: keep, adjust or drop each habit and pick this week\'s focus.</a>' : '',
  ].join('');

  // A brief is only shown for four hours; after that the day has moved on.
  const brief = t.briefs.find((x) => Date.now() - new Date(x.at).getTime() < 4 * 3600 * 1000);
  const briefTitles = { morning: 'Morning brief', midday: 'Midday check', evening: 'Evening check' };
  const briefHtml = brief ? `<div class="brief">${esc(brief.text)}<div class="brief-who">${briefTitles[brief.kind] || 'Coach'}, ${fmtClock(brief.at)}</div></div>` : '';

  // No oath yet and something is due: the oath comes first.
  if (!t.plan && t.progress.open > 0) {
    shell(`<div class="split"><div>${vitals}${banners}${oathView(t)}</div>
      <aside><div class="only-wide">${briefHtml}</div></aside></div>`);
    return;
  }

  if (!t.items.length && !t.tasks.length && !t.anytime.length && !t.triage.length) {
    shell(`${vitals}${banners}<section class="now"><p class="now-label">Nothing yet</p><h2 class="now-title">Add the habits you swear to.</h2>
      <p class="now-meta">Start with two or three non-negotiables, each tied to something you already do every day. Add more once they are strong.</p>
      <div class="now-actions"><a class="btn big" href="#/plan">Add habits</a><a class="btn quiet" href="#/goals/new">Set a goal</a></div></section>`);
    return;
  }

  const fixed = t.items.filter((i) => !i.flexible);
  const heavy = fixed.filter((i) => i.heavy);
  const normal = fixed.filter((i) => !i.heavy);
  const flex = t.items.filter((i) => i.flexible);
  const keptCount = (list) => list.filter((i) => i.status === 'kept' || i.status === 'pardoned').length;
  const section = (title, list, rows, count) => (list.length ? `<section class="section">
      <div class="section-head"><h2>${title}</h2><span class="count">${count ?? `${keptCount(list)} of ${list.length} kept`}</span></div>
      <div class="list">${rows}</div></section>` : '');

  const doneTasks = t.tasks.filter((k) => k.status === 'done');
  const openTasks = t.tasks.filter((k) => k.status !== 'done');
  const tasksHtml = `<section class="section">
    <div class="section-head"><h2>Tasks</h2><span class="count">${doneTasks.length} done today</span></div>
    <div class="list">
      ${[...openTasks, ...doneTasks].map((k) => taskRow(k, t)).join('')}
      ${quickAdd()}
    </div>
    ${t.anytime.length ? `<details class="anytime"><summary>Anytime, ${t.anytime.length} ${t.anytime.length === 1 ? 'task' : 'tasks'} with no date</summary>
      <div class="list">${t.anytime.map((k) => taskRow(k, t)).join('')}</div></details>` : ''}
  </section>`;

  const upcoming = t.upcoming.length ? `<section class="section"><div class="section-head"><h3>Coming up</h3></div>
    <div class="list">${t.upcoming.slice(0, 6).map((u) => `<div class="row${u.heavy ? ' heavy' : ''}" style="grid-template-columns:1fr auto;min-height:48px">
      <span class="row-title">${esc(u.title)}</span><span class="row-side">${fmtDay(u.dueDate)}${u.deadline ? ` ${u.deadline}` : ''}${u.heavy ? ', hard' : ''}</span></div>`).join('')}</div></section>` : '';

  shell(`<div class="split">
    <div>
      ${vitals}
      ${banners}
      ${nowPanel(t)}
      ${progressStrip(t)}
      ${t.plan ? capacityLine(t.capacity, t.settings) : ''}
      <div class="only-narrow">${planCard(t)}${briefHtml}</div>
      ${triageCard(t)}
      ${section('Non-negotiables', heavy, heavy.map((i) => habitRow(i, t)).join(''))}
      ${section('Habits', normal, normal.map((i) => habitRow(i, t)).join(''))}
      ${section('This week', flex, flex.map((i) => habitRow(i, t)).join(''), `${flex.filter((i) => i.status === 'met').length} of ${flex.length} met`)}
      ${tasksHtml}
      ${closeDayCard(t)}
    </div>
    <aside>
      <div class="only-wide">${planCard(t)}${briefHtml}</div>
      ${goalsStrip(t)}
      <section class="section"><div class="section-head"><h3>Last 14 days</h3><span class="count">HP at day end</span></div>
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
  return `<div class="heat" role="img" aria-label="Since it started: ${days.filter((s) => s === 'kept' || s === 'min' || s === 'pardoned').length} kept, ${days.filter((s) => s === 'missed').length} missed">${cells}</div>`;
}

function goalOptions(selected) {
  const goals = state.plan?.goals || [];
  if (!goals.length) return '';
  return `<label class="field"><span>Serves goal</span><select class="input" name="goal_id">
    <option value="">None</option>${goals.map((g) => `<option value="${g.id}"${Number(selected) === g.id ? ' selected' : ''}>${esc(g.title)}</option>`).join('')}</select></label>`;
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
      <label class="field"><span>Cue reminder at (optional)</span><input class="input" type="time" name="remind_at" value="${esc(h?.remindAt || '')}"></label>
    </div>
    <label class="field"><span>Minimum version for a bad day (optional)</span><input class="input" name="minimum" maxlength="120" value="${esc(r.minimum || '')}" placeholder="5 push-ups"></label>
    <label class="field"><span>If-then plan for the obstacle (optional)</span><input class="input" name="if_then" maxlength="300" value="${esc(h?.ifThen || '')}" placeholder="If I skip the morning, then I do it before dinner"></label>
    <div class="grid2">
      <label class="check"><input type="checkbox" name="non_negotiable"${r.non_negotiable ? ' checked' : ''}> Non-negotiable</label>
      <label class="field"><span>HP lost on a miss</span><input class="input" type="number" name="penalty" min="1" max="100" inputmode="numeric" value="${esc(r.penalty)}" placeholder="25 or 10"></label>
    </div>
    ${!h?.non_negotiable && nnCount >= cap ? `<p class="note">You already have ${nnCount} non-negotiables. A new one is only allowed once each of them is above 80% strength.</p>` : ''}
    ${goalOptions(h?.goalId)}
    <label class="field"><span>Notes</span><input class="input" name="notes" maxlength="1000" value="${esc(h?.notes || '')}" placeholder="Optional"></label>
    ${h && h.nextRulesFrom ? `<p class="note">New rules start ${fmtDay(h.nextRulesFrom)}. Today keeps the old ones.</p>` : ''}
    <div class="form-actions">
      <button class="btn" type="submit">${h ? 'Save habit' : 'Add habit'}</button>
      ${h ? '<button class="btn quiet" type="button" data-action="edit-cancel">Cancel</button>' : ''}
      ${h ? `<button class="btn quiet" type="button" data-action="archive-habit" data-id="${h.id}">Archive</button>` : ''}
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
      <button class="btn" type="submit">${k ? 'Save task' : 'Add task'}</button>
      ${k ? '<button class="btn quiet" type="button" data-action="edit-cancel">Cancel</button>' : ''}
      ${k && !locked ? `<button class="btn quiet" type="button" data-action="delete-task" data-id="${k.id}">Delete</button>` : ''}
    </div>
  </form>`;
}

function habitCard(h, p) {
  const r = h.nextRules || {};
  const weekly = h.weeklyTarget;
  const sched = weekly ? `${weekly} times a week, ${h.weekDone} done this week` : scheduleText(h.days, h.deadline);
  const pending = h.nextRulesFrom ? `<p class="note">From ${fmtDay(h.nextRulesFrom)}: ${r.weekly_target ? `${r.weekly_target} times a week` : scheduleText(r.days, r.deadline)}${r.minimum ? `, minimum "${esc(r.minimum)}"` : ''}.</p>` : '';
  const building = h.strength < 80 ? `<p class="faint small">Day ${h.buildingDay} of building. The median is about 66.</p>` : '<p class="faint small">Established. Reminders now fade.</p>';
  return `<div class="card habit-card">
    <div class="habit-card-top">
      <div><h3>${esc(h.name)}</h3>
        <p class="muted small">${sched}, ${h.non_negotiable ? 'non-negotiable' : 'normal'}, minus ${h.penalty} HP</p>
        ${h.cue ? `<p class="small">After ${esc(h.cue)}</p>` : ''}
        ${h.minimum ? `<p class="small">Minimum: ${esc(h.minimum)}</p>` : ''}
        ${h.ifThen ? `<p class="small">${esc(h.ifThen)}</p>` : ''}
        ${h.goalTitle ? `<p class="small"><a href="#/goals/${h.goalId}">${esc(h.goalTitle)}</a></p>` : ''}
      </div>
      <div class="habit-card-side">${strengthChip(h.strength)}${h.streak ? `<span class="faint small">${h.streak} ${weekly ? 'week' : 'day'} streak</span>` : ''}</div>
    </div>
    ${heatmap(h.heat, p.today)}
    ${building}
    ${pending}${h.archivedFrom ? `<p class="note">Archived from ${fmtDay(h.archivedFrom)}.</p>` : ''}
    <div class="form-actions"><button class="btn quiet small" data-action="edit-habit" data-id="${h.id}">Edit</button></div>
  </div>`;
}

function restCard(p) {
  const list = p.restDays.map((d) => `<div class="row" style="grid-template-columns:1fr auto;min-height:48px">
    <span><span class="row-title">${fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>${d.reason ? `<span class="row-meta" style="display:block">${esc(d.reason)}</span>` : ''}</span>
    <button class="btn quiet small" data-action="rest-cancel" data-date="${d.date}">Cancel</button></div>`).join('');
  return `<section class="section"><div class="section-head"><h3>Rest days</h3><span class="count">${p.settings.restDaysPerMonth} a month</span></div>
    <div class="card">
      <p class="muted small">For travel or a planned day off. Fixed habits are excused, X-a-week targets shrink, hard tasks still count, and there is no clean-day bonus. Book before the day starts.</p>
      ${list ? `<div class="list" style="margin-top:10px">${list}</div>` : ''}
      <form class="inline-form rest-form" data-form="rest">
        <label class="sr" for="rest-date">Date</label>
        <input id="rest-date" class="input" type="date" name="date" min="${p.today}" required>
        <input class="input" name="reason" maxlength="200" placeholder="Reason" autocomplete="off">
        <button class="btn" type="submit">Book</button>
      </form>
    </div></section>`;
}

function viewPlan() {
  const p = state.plan;
  if (!p) return shell('<p class="muted">Loading</p>');
  const habits = p.habits.map((h) => (state.editingHabit === h.id ? `<div class="card">${habitForm(h)}</div>` : habitCard(h, p))).join('');
  const tasks = p.tasks.map((k) => {
    if (state.editingTask === k.id) return `<div class="card">${taskForm(k)}</div>`;
    const due = k.dueDate ? `${fmtDay(k.dueDate)}${k.deadline ? ` ${k.deadline}` : ''}` : 'No date';
    const extras = [k.hard ? 'hard' : '', k.estimate ? fmtMin(k.estimate) : '', k.goalTitle ? esc(k.goalTitle) : '', k.createdBy === 'coach' ? 'added by the coach' : k.createdBy === 'siri' ? 'added by Siri' : ''].filter(Boolean).join(', ');
    return `<div class="row${k.hard ? ' heavy' : ''}" style="grid-template-columns:1fr auto">
      <span><span class="row-title">${esc(k.title)}</span><span class="row-meta" style="display:block">${due}${extras ? `, ${extras}` : ''}</span></span>
      <button class="btn quiet small" data-action="edit-task" data-id="${k.id}">Edit</button></div>`;
  }).join('');

  shell(`<div class="split">
    <div>
      <section class="section"><div class="section-head"><h2>Habits</h2><span class="count">${p.habits.length} active</span></div>
        ${habits || '<div class="card muted">No habits yet. Add the first one below. Start with two or three.</div>'}
      </section>
      <section class="section"><div class="section-head"><h3>New habit</h3></div><div class="card">${habitForm(null)}</div></section>
      ${restCard(p)}
    </div>
    <aside>
      <section class="section"><div class="section-head"><h2>Tasks</h2><span class="count">${p.tasks.length} open</span></div>
        <div class="list">${quickAdd('plan-quick')}${tasks}</div>
      </section>
      <section class="section"><div class="section-head"><h3>New task, in full</h3></div><div class="card">${taskForm(null)}</div></section>
    </aside>
  </div>`);
}

// ---------- Coach ----------

function viewCoach() {
  const c = state.coach;
  if (!c) return shell('<p class="muted">Loading</p>');
  const msgs = c.messages.map((m) => `<div class="msg ${m.role}">${esc(m.text)}${m.at ? `<time>${fmtClock(m.at)}</time>` : ''}</div>`).join('');
  const ask = state.query.get('ask') || '';
  shell(`<section class="section">
      <div class="section-head"><h2>Coach</h2><span class="count">${c.aiEnabled ? 'Claude' : 'Offline'}</span></div>
      ${c.aiEnabled ? '' : '<div class="banner">The coach is offline. It needs an Anthropic API key in the app\'s Railway variables. Briefs still arrive with plain numbers until then.</div>'}
      <div class="form-actions">
        <button class="btn quiet small" data-action="brief" data-kind="morning">Morning brief</button>
        <button class="btn quiet small" data-action="brief" data-kind="midday">Midday check</button>
        <button class="btn quiet small" data-action="brief" data-kind="evening">Evening check</button>
      </div>
      <div class="chat" id="chat">${msgs || '<p class="muted">Ask for a plan, report a slip, or tell it what you are avoiding. It sees your HP, deadlines, habit strength, goals, dodges and pardon reasons.</p>'}
        ${state.sending ? '<div class="msg assistant faint">Thinking</div>' : ''}</div>
      <form class="composer" data-form="coach">
        <label class="sr" for="coach-text">Message</label>
        <textarea id="coach-text" class="input" name="text" rows="1" maxlength="4000" placeholder="Message the coach" required>${esc(ask)}</textarea>
        <button class="btn" type="submit"${state.sending ? ' disabled' : ''}>Send</button>
      </form>
    </section>`);
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
    return `<section class="section"><div class="section-head"><h2>Week of ${fmtDay(rv.weekStart)}</h2><span class="count">Reviewed</span></div>
      <div class="card"><p>This week's focus: <b>${esc(rv.focus)}</b></p>${rv.obstaclePlan ? `<p class="small" style="margin-top:6px">${esc(rv.obstaclePlan)}</p>` : ''}
      ${rv.coachText ? `<details style="margin-top:10px"><summary class="small">Coach's review</summary><div class="plan-text">${esc(rv.coachText)}</div></details>` : ''}</div></section>`;
  }
  if (!w.judgedDays) {
    return `<section class="section"><div class="section-head"><h2>Weekly review</h2></div>
      <div class="card muted">Your first weekly review opens on Monday, once a full week has been judged.</div></section>`;
  }
  const rows = w.habits.map((h) => {
    const d = state.decisions[h.id] || 'keep';
    const opts = ['keep', 'adjust', 'drop'].map((o) => `<label><input type="radio" name="d-${h.id}" value="${o}"${d === o ? ' checked' : ''} data-decide="${h.id}"><span>${o[0].toUpperCase()}${o.slice(1)}</span></label>`).join('');
    return `<div class="review-row">
      <div><span class="row-title">${esc(h.name)}</span>
        <span class="row-meta" style="display:block">${h.flexible ? `${h.done} of ${h.target} this week` : `kept ${h.done} of ${h.target}`}${h.minimum ? `, ${h.minimum} minimum` : ''}${h.missed ? `, ${h.missed} missed` : ''}. Strength ${h.strength}% (${signed(h.trend)})</span></div>
      <div class="seg small" role="radiogroup" aria-label="Decision for ${esc(h.name)}">${opts}</div>
    </div>`;
  }).join('');
  return `<section class="section"><div class="section-head"><h2>Weekly review</h2><span class="count">Week of ${fmtDay(rv.weekStart)}</span></div>
    <div class="card review">
      ${rv.coachText ? `<div class="plan-text">${esc(rv.coachText)}</div>` : '<button class="btn quiet" data-action="review-write">Let the coach pre-fill it</button>'}
      ${weekStats(w)}
      <form data-form="review-finish">
        ${rows ? `<h3 style="margin-top:16px">Each habit: keep, adjust or drop</h3>${rows}` : ''}
        <label class="field"><span>This week's one or two things that matter most</span><input class="input" name="focus" maxlength="300" required autocomplete="off"></label>
        <label class="field"><span>If-then plan for the week's biggest obstacle</span><input class="input" name="obstaclePlan" maxlength="300" autocomplete="off" placeholder="If I skip Monday's gym, then I go Tuesday at 7:00"></label>
        <div class="form-actions"><button class="btn" type="submit">Finish the review</button></div>
        <p class="note">Drop archives the habit. Adjust takes you to it after the review.</p>
      </form>
    </div></section>`;
}

function viewReview() {
  const r = state.review;
  if (!r) return shell('<p class="muted">Loading</p>');
  const g = r.game;
  const days = [...r.days].reverse();
  const strengthRows = r.habitStrength.map((h) => `<tr><td>${esc(h.name)}</td><td class="num">${h.kept14} of ${h.sched14}</td><td class="num">${strengthChip(h.strength)}</td></tr>`).join('');
  const dayRows = r.days.slice(0, 30).map((d) => `<tr><td>${fmtDay(d.date)}${d.rest ? ' <span class="faint">rest</span>' : ''}</td><td class="num">${d.kept}</td><td class="num">${d.missed ? `<span style="color:var(--breach);font-weight:600">${d.missed}</span>` : 0}</td><td class="num">${d.hp_end}${d.bonus ? ` <span class="faint">(+${d.bonus})</span>` : ''}</td></tr>`).join('');
  const missRows = r.misses.slice(0, 40).map((m) => `<div class="row" style="grid-template-columns:1fr auto;min-height:52px">
      <span><span class="row-title">${esc(m.title)}</span>${m.pardoned ? `<div class="reason">Pardoned: ${esc(m.reason)}${m.plan ? `<br>Plan: ${esc(m.plan)}` : ''}</div>` : ''}</span>
      <span class="row-side">${fmtDay(m.date)}<br>${m.pardoned ? 'pardoned' : `<span style="color:var(--breach);font-weight:600">minus ${m.hpLost}${m.repeat ? ', twice' : ''}</span>`}</span></div>`).join('');
  const deaths = r.deaths.map((d) => `<div class="row" style="grid-template-columns:1fr auto;min-height:48px"><span class="row-title">Killed by ${esc(d.cause)}</span><span class="row-side">${fmtDay(d.date)}, season ${d.season - 1} ended</span></div>`).join('');
  const stale = r.stale.map((k) => `<div class="triage-row"><span class="row-title">${esc(k.title)}</span>
      <div class="triage-actions" role="group" aria-label="Decide">
        <button class="btn quiet small" data-action="triage" data-do="week" data-id="${k.id}">Next week</button>
        <button class="btn quiet small" data-action="triage" data-do="someday" data-id="${k.id}">Someday</button>
        <button class="btn quiet small" data-action="triage" data-do="drop" data-id="${k.id}">Drop</button>
      </div></div>`).join('');
  const goals = r.goals.map((x) => `<a href="#/goals/${x.id}" class="goal-mini-row"><span class="goal-mini-title">${esc(x.title)}</span>${bar(x.pct)}<span class="goal-mini-label">${esc(x.label)}</span></a>`).join('');

  shell(`<div class="split"><div>
      <div class="page-head"><h1 class="page-title">Review</h1><a class="btn quiet small narrow-only" href="#/settings">Settings</a></div>
      ${reviewCard(r)}
      <section class="section"><div class="section-head"><h3>This week so far</h3></div><div class="card">${weekStats(r.thisWeek)}</div></section>
      ${stale ? `<section class="section"><div class="section-head"><h3>Clear the backlog</h3><span class="count">${r.stale.length}</span></div><div class="card triage">${stale}</div></section>` : ''}
      <section class="section"><div class="section-head"><h3>Habit strength</h3><span class="count">last 14 days</span></div>
        ${strengthRows ? `<div class="list"><table class="table"><thead><tr><th>Habit</th><th class="num">Kept</th><th class="num">Strength</th></tr></thead><tbody>${strengthRows}</tbody></table></div>` : '<div class="card muted">No habits yet.</div>'}
      </section>
      <section class="section"><div class="section-head"><h3>HP, last 30 days</h3></div><div class="card">${hpBars(days, 30)}</div></section>
    </div><aside>
      ${goals ? `<section class="section"><div class="section-head"><h3>Goals</h3></div><div class="goal-mini">${goals}</div></section>` : ''}
      <section class="section"><div class="section-head"><h3>Ledger</h3></div>
        <div class="stats">
          <div class="stat"><b>${g.season}</b><span>Season</span></div>
          <div class="stat"><b>${g.deaths}</b><span>${g.deaths === 1 ? 'Death' : 'Deaths'}</span></div>
          <div class="stat"><b>${g.pardonsLeft}</b><span>Pardons left</span></div>
        </div></section>
      <section class="section"><div class="section-head"><h3>Days</h3></div>
        ${dayRows ? `<div class="list"><table class="table"><thead><tr><th>Day</th><th class="num">Kept</th><th class="num">Missed</th><th class="num">HP</th></tr></thead><tbody>${dayRows}</tbody></table></div>` : '<div class="card muted">Your first day closes at midnight.</div>'}
      </section>
      <section class="section"><div class="section-head"><h3>Misses</h3><span class="count">${r.misses.length}</span></div>
        ${missRows ? `<div class="list">${missRows}</div>` : '<div class="card muted">No misses yet.</div>'}</section>
      ${deaths ? `<section class="section"><div class="section-head"><h3>Deaths</h3></div><div class="list">${deaths}</div></section>` : ''}
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
    status = 'Reminders are on for this device. The app icon shows how many things can still cost HP today.';
    action = '<button class="btn quiet" data-action="push-test">Send a test</button><button class="btn quiet" data-action="push-off">Turn off on this device</button>';
  } else {
    status = 'Reminders are off on this device. Turn them on so last calls and briefs reach your lock screen.';
    action = '<button class="btn" data-action="push-on">Turn on reminders</button>';
  }
  return `<div class="card"><h3>Reminders</h3><p class="muted" style="margin-top:6px">${status}</p>${action ? `<div class="form-actions">${action}</div>` : ''}</div>`;
}

function alertsCard(s) {
  const opt = (v, label, hint) => `<label class="radio-row"><input type="radio" name="alerts" value="${v}"${(s.alerts || 'smart') === v ? ' checked' : ''}><span><b>${label}</b><br><span class="muted small">${hint}</span></span></label>`;
  return `<div class="card"><h3>Where alerts go</h3>
    <form data-form="alerts">
      ${opt('smart', 'One channel per alert', 'Telegram gets reminders with Done buttons, misses and briefs. The lock screen gets last calls and deaths. Fewer, sharper alerts.')}
      ${opt('both', 'Everything, everywhere', 'Every alert on both the lock screen and Telegram.')}
      ${opt('push', 'App only', 'Telegram stays quiet except when you write to it.')}
      <div class="form-actions"><button class="btn" type="submit">Save</button></div>
    </form>
    <p class="note">Reminders fade on their own once a habit passes 80% strength. Non-negotiables always keep a last call.</p></div>`;
}

function telegramCard() {
  const tg = state.telegram || {};
  let body;
  let actions = '';
  if (!tg.enabled) {
    body = 'Create a bot with @BotFather in Telegram and add its token in Railway as TELEGRAM_BOT_TOKEN. This turns on after the next deploy.';
  } else if (tg.linked) {
    body = `Connected${tg.botUsername ? ` to @${esc(tg.botUsername)}` : ''}. Anything you write goes to the coach. Commands: /today, /next, /hp, /add call the bank friday 3pm, /done gym.`;
    actions = '<button class="btn quiet" data-action="tg-test">Send a test</button><button class="btn quiet" data-action="tg-unlink">Disconnect</button>';
  } else {
    body = 'Connect your Telegram so the coach can reach you there. The button opens Telegram; tap Start in the chat with your bot.';
    actions = '<button class="btn" data-action="tg-link">Connect Telegram</button>';
    if (tg.linkUrl) body += ` If Telegram did not open, use this link: <a href="${esc(tg.linkUrl)}">${esc(tg.linkUrl)}</a>`;
  }
  return `<div class="card"><h3>Telegram</h3><p class="muted" style="margin-top:6px">${body}</p>${actions ? `<div class="form-actions">${actions}</div>` : ''}</div>`;
}

function siriCard() {
  const host = location.origin;
  const tokenBlock = state.newToken
    ? `<label class="field"><span>Your key. Copy it now; it is only shown once.</span>
        <span class="copy-row"><input class="input mono" id="siri-key" readonly value="${esc(state.newToken)}"><button class="btn quiet small" data-action="copy" data-target="siri-key">Copy</button></span></label>`
    : '';
  const count = state.tokens?.count || 0;
  return `<div class="card"><h3>Siri and Shortcuts</h3>
    <p class="muted" style="margin-top:6px">Say "Add to Oath", "Oath done" or "What's next in Oath" from your iPhone, Apple Watch or the Action button. It works through three small shortcuts that call Oath with a personal key.</p>
    ${tokenBlock}
    <div class="form-actions">
      <button class="btn${count ? ' quiet' : ''}" data-action="token-new">${count ? 'Make a new key' : 'Make a key'}</button>
      ${count ? '<button class="btn quiet" data-action="token-revoke">Turn off all keys</button>' : ''}
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
    </details>
  </div>`;
}

function viewSettings() {
  const s = state.settings;
  if (!s) return shell('<p class="muted">Loading</p>');
  shell(`<div class="split"><div>
    <section class="section"><div class="page-head"><h1 class="page-title">Settings</h1></div>
      ${pushCard()}
      ${alertsCard(s)}
      ${telegramCard()}
      ${siriCard()}
      <div class="card"><h3>Coach schedule</h3>
        <form data-form="settings">
          <div class="grid3">
            <label class="field"><span>Morning brief</span><input class="input" type="time" name="morningTime" value="${esc(s.morningTime)}" required></label>
            <label class="field"><span>Midday check</span><input class="input" type="time" name="middayTime" value="${esc(s.middayTime || '13:00')}" required></label>
            <label class="field"><span>Evening check</span><input class="input" type="time" name="eveningTime" value="${esc(s.eveningTime)}" required></label>
          </div>
          <div class="grid2">
            <label class="field"><span>Your day ends at</span><input class="input" type="time" name="dayEnd" value="${esc(s.dayEnd || '22:00')}" required></label>
            <label class="field"><span>Time zone</span><input class="input" name="timezone" value="${esc(s.timezone)}" required></label>
          </div>
          <div class="form-actions"><button class="btn" type="submit">Save schedule</button></div>
        </form>
      </div>
      <div class="card"><h3>Your data</h3>
        <p class="muted" style="margin-top:6px">Download everything Oath holds: habits, completions, misses, pardons, deaths, goals, maps, reflections and coach notes, as one JSON file.</p>
        <div class="form-actions"><a class="btn quiet" href="/api/export" download>Download my data</a></div></div>
      <div class="card"><h3>Password</h3>
        <form data-form="password">
          <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="10" required></label>
          <div class="form-actions"><button class="btn" type="submit">Change password</button><button class="btn quiet" type="button" data-action="logout">Log out</button></div>
        </form>
      </div>
    </section></div>
    <aside><section class="section"><div class="section-head"><h3>The rules</h3></div>
      <div class="card prose">
        <p>You have ${s.maxHp} HP. Miss a habit's deadline and you lose its HP. Miss the same habit twice in a row and the second costs ${s.repeatMultiplier}x.</p>
        <p>Keep a habit right after missing it and you earn ${s.comebackBonus} HP back. One miss is an accident; the second is the start of a new habit.</p>
        <p>Strength is the real measure: it grows with every repetition and a miss costs a few points, never everything. Streaks reset on a miss.</p>
        <p>Once a deadline passes, the habit is locked. A mistaken tick can be undone within ${s.undoMinutes} minutes.</p>
        <p>"Times a week" habits are settled on Sunday night. Each missing session costs its share of the HP.</p>
        <p>A minimum version, set a day ahead, saves the HP and the streak but not the clean-day bonus.</p>
        <p>Hard tasks cost ${s.taskPenalty} HP if not done by their deadline, need a first step, and cannot be deleted or moved once due.</p>
        <p>A clean day, with nothing missed and no minimums, gives back ${s.cleanBonus} HP.</p>
        <p>At 0 HP you die. The season ends and streaks reset, but every habit keeps its strength.</p>
        <p>${s.pardonsPerMonth} pardons a month, within 24 hours, each with what got in the way and an if-then plan. ${s.restDaysPerMonth} rest days a month, booked before the day starts.</p>
        <p>At most ${s.maxNonNegotiables} non-negotiables until each is above 80% strength.</p>
        <p>Every morning you take the oath: the one thing, and when and where. "Not now" needs a reason; every dodge is logged.</p>
      </div></section></aside></div>`);
}

// ---------- Gate ----------

function renderLogin() {
  $app.innerHTML = `<div class="gate">
    <div class="wordmark">Oath</div>
    <p>Log in to see today.</p>
    <form data-form="login" style="margin-top:18px">
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required autofocus></label>
      <div class="form-actions"><button class="btn" type="submit">Log in</button></div>
      <p class="note bad" id="gate-error" hidden></p>
    </form></div>`;
}
hooks.onUnauthed = renderLogin;

function renderSetup(code) {
  $app.innerHTML = `<div class="gate">
    <div class="wordmark">Oath</div>
    <p>Choose the password you will use to open Oath on your iPhone and iPad.</p>
    <form data-form="setup" data-code="${esc(code)}" style="margin-top:18px">
      <label class="field"><span>Password, at least 10 characters</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="10" required autofocus></label>
      <label class="field"><span>Same password again</span><input class="input" type="password" name="again" autocomplete="new-password" minlength="10" required></label>
      <div class="form-actions"><button class="btn" type="submit">Set password</button></div>
      <p class="note bad" id="gate-error" hidden></p>
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

async function load(route) {
  if (route === 'today') {
    state.today = await api('GET', '/api/today');
    setBadge();
  }
  if (route === 'plan') state.plan = await api('GET', '/api/plan');
  if (route === 'coach') state.coach = await api('GET', '/api/coach');
  if (route === 'review') state.review = await api('GET', '/api/review');
  if (route === 'goals') {
    if (state.param === 'new') return;
    if (state.param) await loadGoal(state.param);
    else await loadGoals();
  }
  if (route === 'settings') {
    state.settings = await api('GET', '/api/settings');
    state.telegram = { ...(state.telegram || {}), ...(await api('GET', '/api/telegram')) };
    state.tokens = await api('GET', '/api/tokens');
    await refreshPushState();
  }
}

function render() {
  if (state.route === 'goals') {
    if (state.param === 'new') return viewGoalNew();
    if (state.param) return viewGoal();
    return viewGoals();
  }
  const views = { today: viewToday, plan: viewPlan, coach: viewCoach, review: viewReview, settings: viewSettings };
  (views[state.route] || viewToday)();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [route, param] = (path || 'today').split('/');
  state.route = ROUTES.includes(route) ? route : route === 'ledger' ? 'review' : 'today';
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
  state.today = await api('GET', '/api/today');
  setBadge();
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
  state.push = { supported, permission: supported ? Notification.permission : 'default', subscribed: false };
  if (!supported) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  state.push.subscribed = Boolean(sub);
}

async function pushOn() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new ApiError('Notifications were not allowed. Turn them on in iOS Settings, Notifications, Oath.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('POST', '/api/push/subscribe', sub.toJSON());
}

async function pushOff() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
}

// iOS never tells the page when a push subscription changes, so re-send it on every launch.
async function resyncPush() {
  try {
    if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await api('POST', '/api/push/subscribe', sub.toJSON());
  } catch { /* try again next launch */ }
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
  const row = el.closest('.row');
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

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  const a = el.dataset.action;
  if (await goalsClick(a, el)) return;
  if (a === 'keep') {
    await keepHabit(el, id);
  } else if (a === 'keep-minimum') {
    await keepHabit(el, id, true);
  } else if (a === 'undo') {
    if (await act(() => api('POST', `/api/habits/${id}/undo`, {}), 'Undone.')) await refreshToday();
  } else if (a === 'task-done') {
    haptic();
    const row = el.closest('.row');
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
      window.location.href = r.url;
    }
  } else if (a === 'tg-test') {
    await act(() => api('POST', '/api/telegram/test', {}), (r) => (r.sent ? 'Sent. Check Telegram.' : 'Not linked yet.'));
  } else if (a === 'tg-unlink') {
    if (!confirm('Disconnect Telegram?')) return;
    if (await act(() => api('POST', '/api/telegram/unlink', {}), 'Telegram disconnected.')) { await load('settings'); render(); }
  } else if (a === 'token-new') {
    const r = await act(() => api('POST', '/api/tokens', { label: 'Shortcuts' }));
    if (r) { state.newToken = r.token; state.tokens = { count: (state.tokens?.count || 0) + 1 }; render(); }
  } else if (a === 'token-revoke') {
    if (!confirm('Turn off every key? Your shortcuts stop working until you make a new key.')) return;
    if (await act(() => api('DELETE', '/api/tokens'), 'All keys turned off.')) { state.newToken = null; await load('settings'); render(); }
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
  } else if (a === 'edit-habit') {
    state.editingHabit = id;
    render();
  } else if (a === 'edit-task') {
    state.editingTask = id;
    render();
  } else if (a === 'edit-cancel') {
    state.editingHabit = null;
    state.editingTask = null;
    render();
  } else if (a === 'archive-habit') {
    if (!confirm('Archive this habit? If it is due today, today still counts.')) return;
    const r = await act(() => api('DELETE', `/api/habits/${id}`), (x) => (x.from > state.plan.today ? `Archived from ${fmtDay(x.from)}. Today still counts.` : 'Archived.'));
    if (r) { state.editingHabit = null; await go(); }
  } else if (a === 'delete-task') {
    if (!confirm('Delete this task?')) return;
    if (await act(() => api('DELETE', `/api/tasks/${id}`), 'Deleted.')) { state.editingTask = null; await go(); }
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
  } else if (a === 'push-on') {
    if (await act(pushOn, 'Reminders are on for this device.')) { await refreshPushState(); render(); }
  } else if (a === 'push-off') {
    if (await act(pushOff, 'Reminders are off for this device.')) { await refreshPushState(); render(); }
  } else if (a === 'push-test') {
    await act(() => api('POST', '/api/push/test', {}), (r) => (r.sent ? 'Test sent. It should arrive in a few seconds.' : 'No device is registered. Turn reminders on again.'));
  } else if (a === 'logout') {
    await act(() => api('POST', '/api/logout', {}));
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
      // The hold button submits through takeOath; Enter in the text field lands here.
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
      if (r) await go();
    } else if (kind === 'edit-habit') {
      const r = await act(() => api('PATCH', `/api/habits/${form.dataset.id}`, habitPayload(form)), (x) => (x.effective === 'now' ? 'Saved.' : `Saved. New rules start ${fmtDay(x.effective)}.`));
      if (r) { state.editingHabit = null; await go(); }
    } else if (kind === 'new-task') {
      if (await act(() => api('POST', '/api/tasks', taskPayload(form)), 'Task added.')) await go();
    } else if (kind === 'edit-task') {
      if (await act(() => api('PATCH', `/api/tasks/${form.dataset.id}`, taskPayload(form)), 'Saved.')) { state.editingTask = null; await go(); }
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
          state.editingHabit = r.adjust[0];
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
  const g = e.target.closest('g[data-action]');
  if (g && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

// ---------- Hold to take the oath ----------

const HOLD_MS = 1300;
let holdTimer = null;

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
  } else {
    form.querySelector('.hold')?.classList.remove('sworn');
  }
}

function holdStart(e) {
  const btn = e.target.closest('[data-hold]');
  if (!btn) return;
  const form = btn.closest('form');
  if (!form.querySelector('input[name="focus"]:checked')) {
    toast('Pick your one thing first.', true);
    return;
  }
  if (String(form.querySelector('[name="intention"]').value || '').trim().length < 3) {
    toast('Say when and where you will do it.', true);
    return;
  }
  e.preventDefault();
  btn.classList.add('holding');
  holdTimer = setTimeout(() => {
    holdTimer = null;
    btn.classList.remove('holding');
    btn.classList.add('sworn');
    takeOath(form);
  }, HOLD_MS);
}

function holdEnd(e) {
  const btn = e.target.closest('[data-hold]');
  if (!btn || !holdTimer) return;
  clearTimeout(holdTimer);
  holdTimer = null;
  btn.classList.remove('holding');
  toast('Hold it until it fills.');
}

$app.addEventListener('pointerdown', holdStart);
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $app.addEventListener(ev, holdEnd));
$app.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-hold]')) e.preventDefault(); });
// Keyboard users press Enter or Space once.
$app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-hold]');
  if (btn && e.detail === 0) takeOath(btn.closest('form'));
});

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
    el.className = l.cls;
  });
}, 15000);

setInterval(() => {
  if (document.visibilityState === 'visible' && state.route === 'today' && state.today && !document.activeElement?.matches('input, textarea')) refreshToday().catch(() => {});
}, 60000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.querySelector('.tabbar') && !document.activeElement?.matches('input, textarea')) go();
});

window.addEventListener('hashchange', () => {
  state.pardoning = null;
  state.editingHabit = state.route === 'review' ? state.editingHabit : null;
  state.editingTask = null;
  state.editingGoal = false;
  state.sheetNode = null;
  state.sheetMode = null;
  state.dodging = null;
  go();
});

window.matchMedia('(min-width: 900px)').addEventListener('change', applyResponsive);

// ---------- Boot ----------

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
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
      return renderLogin();
    }
    await go();
    resyncPush();
  } catch (err) {
    $app.innerHTML = `<div class="gate"><div class="wordmark">Oath</div><p>${esc(err.message)}</p></div>`;
  }
}

boot();
