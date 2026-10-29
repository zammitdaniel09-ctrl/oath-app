// Plan: the week at a glance, habits grouped with their strength, today's state and the last two weeks,
// tasks by when they fall due with a check to tick them off, and rest days. Plain strings, drawn on every
// redraw; a habit opened for its details stays open (this phone remembers it).
import { state, esc, icon, fmtDay, fmtMin, fmtInt, addDays, daysBetween, scheduleText, miniRing, CHECK, localNowHM } from './ui.js';
import { AUTO_LABELS } from './data.js';

let ctx = { heatmap: () => '', quickAdd: () => '' };
export function initPlan(c) {
  ctx = { ...ctx, ...c };
}

const DONE = new Set(['kept', 'min', 'pardoned']);
const JUDGED = new Set(['kept', 'min', 'pardoned', 'missed', 'open', 'none']);
const level = (s) => (s >= 80 ? 'strong' : s >= 40 ? 'mid' : 'new');
const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const chip = (cls, ic, text) => `<span class="pl-chip ${cls}">${ic ? icon(ic) : ''}${text}</span>`;
const timesAWeek = (n) => (n === 1 ? 'Once a week' : `${n} times a week`);

// Minutes from now to a deadline today; midnight is the end of the day.
function minutesTo(deadline) {
  const [h, m] = deadline.split(':').map(Number);
  const [nh, nm] = localNowHM().split(':').map(Number);
  return (h === 0 && m === 0 ? 1440 : h * 60 + m) - (nh * 60 + nm);
}
// How close a deadline today is, as the Today list colours it: calm, then Honey, Blaze and Ember, then over.
function heatOf(deadline) {
  if (!deadline) return '';
  const min = minutesTo(deadline);
  return min <= 0 ? 'over' : min <= 30 ? 'ember' : min <= 60 ? 'blaze' : min <= 180 ? 'honey' : '';
}
const leftText = (min) => (min <= 0 ? 'Due now' : min < 60 ? `${min} min left` : `${Math.floor(min / 60)} h left`);

// ---------- The week ----------

// Each day of this week, Monday first: what the habits asked for and how it went, read from their history.
function weekDays(p) {
  return (p.week || []).map((d) => {
    const back = daysBetween(d.date, p.today);
    let done = 0;
    let missed = 0;
    let due = 0;
    if (back >= 0) {
      for (const h of p.habits) {
        const s = h.heat[h.heat.length - 1 - back];
        if (!JUDGED.has(s)) continue;
        due += 1;
        if (DONE.has(s)) done += 1;
        if (s === 'missed') missed += 1;
      }
    }
    let s = 'future';
    if (d.rest) s = 'rest';
    else if (back === 0) s = 'today';
    else if (back > 0) s = !due ? 'quiet' : missed ? 'missed' : done === due ? 'clean' : 'kept';
    return { ...d, back, done, missed, due: back >= 0 ? due : d.due, s };
  });
}

function dayCell(d) {
  const pct = d.due ? Math.round((d.done / d.due) * 100) : 0;
  const inner = d.s === 'today' || d.s === 'kept' ? miniRing(pct, 30)
    : d.s === 'clean' ? icon('check') : d.s === 'missed' ? icon('close') : d.s === 'future' && d.due ? `<b>${d.due}</b>` : '';
  const what = d.s === 'rest' ? 'Rest day' : d.s === 'future' ? `${plural(d.due, 'habit')} due` : d.s === 'quiet' ? 'Nothing due'
    : `${d.done} of ${d.due} kept${d.missed ? `, ${d.missed} missed` : ''}${d.s === 'today' ? ' so far' : ''}`;
  const stake = d.stake && d.s !== 'rest' ? `${d.stake} HP on the line` : '';
  return `<span class="pl-day ${d.s}" title="${esc(`${fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}: ${what}${stake ? `, ${stake}` : ''}`)}">
    <span class="pl-dot">${inner}</span>
    <span class="pl-dl">${esc(fmtDay(d.date, { weekday: 'narrow' }))}</span></span>`;
}

// The card at the top: this week so far, each day as a dot, and four numbers that matter for planning.
export function planHero(p) {
  const days = weekDays(p);
  if (!days.length) return '';
  const sofar = days.filter((d) => d.back >= 0 && d.s !== 'rest');
  const done = sum(sofar, (d) => d.done);
  const due = sum(sofar, (d) => d.due);
  const pct = due ? Math.round((done / due) * 100) : 0;
  const cap = p.settings.dailyLossCap;
  const live = p.habits.filter((h) => !h.archivedFrom);
  const avg = live.length ? Math.round(sum(live, (h) => h.strength) / live.length) : 0;
  const strong = live.filter((h) => h.strength >= 80).length;
  const weekEnd = days[days.length - 1].date;
  const thisWeek = p.tasks.filter((k) => k.dueDate && k.dueDate >= p.today && k.dueDate <= weekEnd);
  const overdue = p.tasks.filter((k) => k.dueDate && k.dueDate < p.today).length;
  const minutes = sum(thisWeek, (k) => k.estimate);
  const nextRest = p.restDays.find((r) => r.date > p.today) || p.restDays[0];
  const worst = p.settings.worstDay;
  const stat = (cls, ic, label, value, note) => `<div class="pl-stat ${cls}"><span class="pl-sh">${icon(ic)}${label}</span><b>${value}</b><small>${note}</small></div>`;
  const spoken = days.map((d) => `${fmtDay(d.date, { weekday: 'long' })}: ${d.s === 'future' ? `${d.due} due` : d.s === 'rest' ? 'rest' : `${d.done} of ${d.due}`}`).join(', ');
  return `<section class="card pl-hero" aria-label="This week">
    <div class="pl-hero-top">
      <div class="pl-hero-text">
        <p class="eyebrow">This week · ${esc(fmtDay(days[0].date, { day: 'numeric', month: 'short' }))}–${esc(fmtDay(weekEnd, { day: 'numeric', month: 'short' }))}</p>
        <p class="pl-big">${done}<small> of ${due} kept</small></p>
        <p class="pl-hero-sub">${due ? `${sum(sofar, (d) => d.missed) ? `${plural(sum(sofar, (d) => d.missed), 'miss', 'misses')} so far` : 'No misses so far'}` : 'The week starts today'}</p>
      </div>
      <div class="pl-hero-ring ${pct >= 90 ? 'strong' : pct >= 60 ? 'mid' : 'new'}" role="img" aria-label="${pct}% kept this week">${miniRing(pct, 76)}<b>${pct}<small>%</small></b></div>
    </div>
    <div class="pl-week" role="img" aria-label="${esc(spoken)}">${days.map(dayCell).join('')}</div>
    <div class="pl-stats">
      ${stat(`strength ${level(avg)}`, 'trend', 'Strength', `${avg}%`, strong ? `${strong} established` : 'All still building')}
      ${stat(worst > cap ? 'over' : '', 'shield', 'Worst day', `${worst} HP`, `Cap ${cap} HP a day`)}
      ${stat(overdue ? 'over' : '', 'calendar', 'Tasks this week', String(thisWeek.length), overdue ? `${overdue} overdue` : minutes ? `${fmtMin(minutes)} planned` : 'Nothing estimated')}
      ${stat('', 'moon', 'Next rest', nextRest ? esc(fmtDay(nextRest.date, { weekday: 'short', day: 'numeric', month: 'short' })) : 'None', `${p.settings.restDaysPerMonth} a month`)}
    </div>
  </section>`;
}

// ---------- Habits ----------

const FILTERS = [
  ['all', 'All', () => true],
  ['left', 'Still to do', (h) => !h.archivedFrom && (h.weeklyTarget ? h.weekDone < (h.weekTarget || h.weeklyTarget) : h.heat[h.heat.length - 1] === 'open')],
  ['nn', 'Non-negotiable', (h) => h.non_negotiable],
  ['weekly', 'Weekly', (h) => h.weeklyTarget],
  ['building', 'Building', (h) => h.strength < 80],
  ['strong', 'Established', (h) => h.strength >= 80],
];

// Which habits are open for their details, remembered on this phone.
const opened = new Map();
function isOpen(id) {
  if (!opened.has(id)) {
    let open = false;
    try { open = localStorage.getItem(`oath.plan.open.${id}`) === '1'; } catch { /* storage unavailable */ }
    opened.set(id, open);
  }
  return opened.get(id);
}

// Today for one habit, as a short pill: done, still due by its deadline, missed, resting.
function todayPill(h) {
  const s = h.heat[h.heat.length - 1];
  if (h.archivedFrom) return ['leaving', 'Leaves tomorrow'];
  if (h.weeklyTarget) {
    const target = h.weekTarget || h.weeklyTarget;
    return [h.weekDone >= target ? 'done' : 'week', `${h.weekDone} of ${target}`];
  }
  if (s === 'kept') return ['done', 'Done'];
  if (s === 'min') return ['done', 'Minimum'];
  if (s === 'pardoned') return ['pardoned', 'Pardoned'];
  if (s === 'missed') return ['missed', 'Missed'];
  if (s === 'open') return [`open ${heatOf(h.deadline)}`, leftText(minutesTo(h.deadline))];
  if (s === 'rest') return ['rest', 'Rest'];
  return ['off', 'Not today'];
}

function strip(heat) {
  const days = heat.slice(-14);
  const kept = days.filter((s) => DONE.has(s)).length;
  const missed = days.filter((s) => s === 'missed').length;
  return `<span class="pl-strip" role="img" aria-label="Last 14 days: ${kept} kept, ${missed} missed">${days.map((s) => `<i class="h-${s}"></i>`).join('')}</span>`;
}

function habitRow(h, p) {
  const open = isOpen(h.id);
  const [pill, pillText] = todayPill(h);
  const when = h.weeklyTarget ? timesAWeek(h.weeklyTarget) : scheduleText(h.days, h.deadline).replace(/^Every day by /, 'by ');
  const chips = [
    chip('', h.weeklyTarget ? 'calendar' : 'clock', esc(when)),
    chip(`hp${h.non_negotiable ? ' nn' : ''}`, '', `−${h.penalty} HP`),
    h.streak ? chip('streak', 'flame', `${h.streak} ${h.weeklyTarget ? (h.streak === 1 ? 'week' : 'weeks') : (h.streak === 1 ? 'day' : 'days')}`) : '',
    h.auto ? chip('auto', 'heart', 'Health') : '',
  ].join('');
  const r = h.nextRules || {};
  const facts = [
    h.cue ? ['After', esc(h.cue)] : null,
    h.minimum ? ['Minimum', esc(h.minimum)] : null,
    h.ifThen ? ['Plan', esc(h.ifThen)] : null,
    h.auto ? ['Health', `${fmtInt(h.auto.target)} ${(AUTO_LABELS[h.auto.metric] || {}).unit || ''}${h.auto.filter ? `, ${esc(h.auto.filter)}` : ''}`] : null,
    h.goalTitle ? ['Goal', `<a href="#/goals/${h.goalId}">${esc(h.goalTitle)}</a>`] : null,
    h.notes ? ['Notes', esc(h.notes)] : null,
  ].filter(Boolean);
  const pending = h.nextRulesFrom ? `<p class="note">From ${fmtDay(h.nextRulesFrom)}: ${r.weekly_target ? timesAWeek(r.weekly_target).toLowerCase() : scheduleText(r.days, r.deadline)}${r.minimum ? `, minimum "${esc(r.minimum)}"` : ''}.</p>` : '';
  const building = h.strength < 80 ? `Day ${h.buildingDay} of building` : 'Established';
  const record = h.sched14 ? `Kept ${h.kept14} of ${h.sched14} in the last two weeks.` : '';
  const heat = ctx.heatmap(h.heat, p.today);
  return `<article class="card pl-habit${h.non_negotiable ? ' heavy' : ''}${h.archivedFrom ? ' leaving' : ''}${open ? ' open' : ''}" data-habit="${h.id}">
    <button class="pl-h-main" data-action="habit-open" data-id="${h.id}" aria-expanded="${open}" aria-controls="hm-${h.id}">
      <span class="pl-ring ${level(h.strength)}" role="img" aria-label="Strength ${h.strength}%">${miniRing(h.strength, 46)}<b>${h.strength}<small>%</small></b></span>
      <span class="pl-h-body">
        <span class="pl-h-name">${esc(h.name)}</span>
        <span class="pl-chips">${chips}</span>
        ${strip(h.heat)}
      </span>
      <span class="pl-h-side"><span class="pl-pill ${pill}">${pill === 'done' ? icon('check') : ''}${esc(pillText)}</span>${icon('chevron', 'pl-chev')}</span>
    </button>
    <div class="pl-h-more" id="hm-${h.id}"${open ? '' : ' hidden'}>
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
      ${record ? `<p class="pl-record">${record}</p>` : ''}
      ${heat}
      ${pending}
      <div class="pl-h-foot">${h.archivedFrom
        ? `<span class="small leaving">Leaves your list tomorrow. Today still counts.</span>
          <button class="btn tinted small" data-action="restore-habit" data-id="${h.id}">Keep it</button>`
        : `<span class="faint small">${building}${h.non_negotiable ? ' · non-negotiable' : ''}</span>
          <button class="btn tinted small" data-action="sheet" data-kind="habit" data-id="${h.id}">Edit</button>`}</div>
    </div>
  </article>`;
}

// Groups when nothing is filtered: the non-negotiables, the habits on set days, the ones done so many times a week.
function habitGroups(list) {
  const nn = list.filter((h) => h.non_negotiable);
  const fixed = list.filter((h) => !h.non_negotiable && !h.weeklyTarget);
  const weekly = list.filter((h) => !h.non_negotiable && h.weeklyTarget);
  const daily = fixed.every((h) => (h.days || []).length === 7);
  return [
    ['Non-negotiables', nn, nn.length ? `${sum(nn, (h) => h.penalty)} HP a day if all are missed` : ''],
    [daily ? 'Daily' : 'On set days', fixed, ''],
    ['Times a week', weekly, weekly.length ? `${sum(weekly, (h) => h.weekDone)} of ${sum(weekly, (h) => h.weekTarget || h.weeklyTarget)} done this week` : ''],
  ].filter(([, l]) => l.length);
}

export function planHabits(p, { undo = '', empty = '' } = {}) {
  const filter = FILTERS.find((f) => f[0] === state.planFilter) || FILTERS[0];
  const counts = FILTERS.map(([id, label, test]) => [id, label, p.habits.filter(test).length]);
  const chips = p.habits.length ? `<div class="pl-filters" role="tablist" aria-label="Show habits">${counts
    .filter(([id, , n]) => n || id === 'all' || id === filter[0])
    .map(([id, label, n]) => `<button role="tab" aria-selected="${id === filter[0]}" data-action="plan-filter" data-filter="${id}">${label}<span>${n}</span></button>`).join('')}</div>` : '';
  const shown = p.habits.filter(filter[2]);
  let body;
  if (!p.habits.length) body = empty;
  else if (!shown.length) body = `<p class="pl-none">${filter[0] === 'left' ? 'Nothing left to do today. Every habit due is done.' : 'No habits here.'}</p>`;
  else if (filter[0] === 'all') {
    body = habitGroups(shown).map(([title, list, note]) => `<div class="pl-group"><div class="pl-gh"><h3>${title}</h3><span>${plural(list.length, 'habit')}${note ? ` · ${note}` : ''}</span></div>
      ${list.map((h) => habitRow(h, p)).join('')}</div>`).join('');
  } else body = shown.map((h) => habitRow(h, p)).join('');
  return `<section class="section"><div class="gh"><h2>Habits</h2><button class="gh-link" data-action="sheet" data-kind="habit">${icon('plus')}New habit</button></div>
    ${undo}${chips}${body}</section>`;
}

// Rest days are booked in advance: today can be neither booked nor cancelled, so neither is offered.
export function planRest(p) {
  const list = p.restDays.map((d) => `<div class="pl-rest-row">
    <span class="pl-date"><b>${esc(fmtDay(d.date, { day: 'numeric' }))}</b><small>${esc(fmtDay(d.date, { month: 'short' }))}</small></span>
    <span class="pl-rest-text"><b>${d.date === p.today ? 'Today, resting' : esc(fmtDay(d.date, { weekday: 'long' }))}</b>${d.reason ? `<small>${esc(d.reason)}</small>` : ''}</span>
    ${d.date === p.today ? '' : `<button class="btn tinted small" data-action="rest-cancel" data-date="${d.date}">Cancel</button>`}</div>`).join('');
  return `<section class="section"><div class="gh"><h2>Rest days</h2><span class="gh-count">${icon('moon')}${p.settings.restDaysPerMonth} a month</span></div>
    <div class="card pl-rest">
      ${list || '<p class="pl-rest-empty">None booked. A rest day excuses every habit on set days, and weekly targets shrink to fit.</p>'}
      <form class="rest-form" data-form="rest">
        <label class="sr" for="rest-date">Date</label>
        <input id="rest-date" class="input" type="date" name="date" min="${addDays(p.today, 1)}" required>
        <input class="input" name="reason" maxlength="200" placeholder="Reason" autocomplete="off">
        <button class="btn primary" type="submit">Book</button>
      </form>
    </div></section>`;
}

// ---------- Tasks ----------

function taskRow(k, group, p) {
  let when = '';
  if (group === 'overdue') when = chip('late', 'clock', `Since ${esc(fmtDay(k.dueDate))}`);
  else if (group === 'today' || group === 'tomorrow') when = k.deadline ? chip(group === 'today' ? `due ${heatOf(k.deadline)}` : '', 'clock', k.deadline) : '';
  else if (k.dueDate) when = chip('', 'clock', `${esc(fmtDay(k.dueDate))}${k.deadline ? ` ${k.deadline}` : ''}`);
  const chips = [
    when,
    k.hard ? chip('hard', 'shield', k.locked ? 'Hard, locked' : 'Hard') : '',
    k.estimate ? chip('', 'timer', fmtMin(k.estimate)) : '',
    k.goalTitle ? chip('goal', 'goals', esc(k.goalTitle)) : '',
    k.createdBy === 'coach' ? chip('', 'coach', 'Coach') : k.createdBy === 'siri' ? chip('', 'mic', 'Siri') : '',
  ].join('');
  const move = group === 'overdue' && !k.locked
    ? `<div class="pl-t-move"><span>Move to</span><button class="btn tinted small" data-action="triage" data-do="today" data-id="${k.id}">Today</button><button class="btn tinted small" data-action="triage" data-do="tomorrow" data-id="${k.id}">Tomorrow</button></div>` : '';
  return `<div class="li pl-task${k.hard ? ' heavy' : ''}${group === 'overdue' ? ' late' : ''}" data-key="t${k.id}">
    <button class="pl-chk" data-action="task-done" data-id="${k.id}" aria-label="Done: ${esc(k.title)}"><span class="chk">${CHECK}</span></button>
    <button class="pl-t-body" data-action="sheet" data-kind="task" data-id="${k.id}">
      <span class="li-title">${k.createdBy === 'vle' ? '<span class="tag uni">VLE</span>' : ''}${esc(k.title)}</span>
      ${chips ? `<span class="pl-chips">${chips}</span>` : ''}
      ${k.hard && k.firstStep ? `<span class="li-sub first-step">First step: ${esc(k.firstStep)}</span>` : ''}
    </button>
    ${move}
  </div>`;
}

// The next seven days as columns: how many tasks fall on each, the hard ones in red, today first.
function loadChart(p) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(p.today, i));
  const per = days.map((d) => p.tasks.filter((k) => k.dueDate === d));
  const max = Math.max(1, ...per.map((l) => l.length));
  const cols = days.map((d, i) => {
    const l = per[i];
    const hard = l.filter((k) => k.hard).length;
    const mins = sum(l, (k) => k.estimate);
    const title = `${fmtDay(d, { weekday: 'long', day: 'numeric', month: 'short' })}: ${plural(l.length, 'task')}${hard ? `, ${hard} hard` : ''}${mins ? `, ${fmtMin(mins)}` : ''}`;
    return `<span class="pl-col${i === 0 ? ' is-today' : ''}" title="${esc(title)}">
      <span class="pl-n">${l.length || ''}</span>
      <span class="pl-bar${l.length ? '' : ' zero'}" style="--h:${((l.length / max) * 100).toFixed(0)}%">${hard ? `<i style="--hh:${((hard / l.length) * 100).toFixed(0)}%"></i>` : ''}</span>
      <span class="pl-dl">${i === 0 ? 'Today' : esc(fmtDay(d, { weekday: 'short' }))}</span></span>`;
  }).join('');
  return `<div class="pl-load" role="img" aria-label="${esc(days.map((d, i) => `${fmtDay(d, { weekday: 'long' })} ${per[i].length}`).join(', '))}">${cols}</div>`;
}

export function planTasks(p) {
  const t = p.today;
  const tomorrow = addDays(t, 1);
  const weekEnd = p.week?.length ? p.week[p.week.length - 1].date : addDays(t, 6);
  const groups = [
    ['overdue', 'Overdue', (k) => k.dueDate && k.dueDate < t],
    ['today', 'Today', (k) => k.dueDate === t],
    ['tomorrow', 'Tomorrow', (k) => k.dueDate === tomorrow],
    ['week', 'Later this week', (k) => k.dueDate > tomorrow && k.dueDate <= weekEnd],
    ['later', 'Later', (k) => k.dueDate > tomorrow && k.dueDate > weekEnd],
    ['someday', 'Any time', (k) => !k.dueDate],
  ];
  const overdue = p.tasks.filter(groups[0][2]).length;
  const minutes = sum(p.tasks.filter((k) => k.dueDate && k.dueDate <= weekEnd), (k) => k.estimate);
  const summary = [plural(p.tasks.length, 'open task'), overdue ? `<b class="bad">${overdue} overdue</b>` : '', minutes ? `${fmtMin(minutes)} planned this week` : ''].filter(Boolean).join(' · ');
  const lists = groups.map(([id, title, test]) => {
    const l = p.tasks.filter(test);
    if (!l.length) return '';
    const mins = sum(l, (k) => k.estimate);
    return `<div class="pl-group ${id}"><div class="pl-gh"><h3>${title}</h3><span>${l.length}${mins ? ` · ${fmtMin(mins)}` : ''}</span></div>
      <div class="group">${l.map((k) => taskRow(k, id, p)).join('')}</div></div>`;
  }).join('');
  return `<section class="section"><div class="gh"><h2>Tasks</h2><button class="gh-link" data-action="sheet" data-kind="task">${icon('plus')}New task</button></div>
    <div class="card pl-loadcard"><p class="pl-sum">${summary}</p>${loadChart(p)}</div>
    <div class="group pl-add">${ctx.quickAdd('plan-quick')}</div>
    ${lists || '<p class="pl-none">No open tasks. Add one above, or tell the coach.</p>'}
  </section>`;
}

// ---------- Taps ----------

export function planClick(a, el, $app) {
  if (a === 'plan-filter') {
    state.planFilter = el.dataset.filter;
    ctx.render();
    return true;
  }
  if (a === 'habit-open') {
    const id = Number(el.dataset.id);
    const open = !isOpen(id);
    opened.set(id, open);
    try { localStorage.setItem(`oath.plan.open.${id}`, open ? '1' : '0'); } catch { /* storage unavailable */ }
    const card = $app.querySelector(`.pl-habit[data-habit="${id}"]`);
    if (!card) return true;
    card.classList.toggle('open', open);
    card.querySelector('.pl-h-more').hidden = !open;
    el.setAttribute('aria-expanded', String(open));
    return true;
  }
  return false;
}
