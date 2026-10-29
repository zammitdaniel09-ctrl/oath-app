// Plan: the week at a glance, habits grouped with their strength, today's state and the last two weeks,
// tasks by when they fall due with a check to tick them off, and rest days. Plain strings, drawn on every
// redraw; a habit opened for its details stays open (this phone remembers it). Also the page around them, the
// habit and task forms, and adding, changing and removing habits, tasks and rest days.
import {
  state, esc, icon, fmtDay, fmtMin, fmtInt, addDays, daysBetween, scheduleText, miniRing, CHECK, localNowHM, plural,
  DAY_NAMES, emptyState, pageHead, act, api, toast, confirmSheet, form2obj,
} from './ui.js';
import { AUTO_LABELS } from './data.js';
import { goalsBody } from './goals.js';
import { askCoach, quickAdd } from './today-list.js';

let ctx = { shell: () => {}, skeleton: () => {}, render: () => {}, refreshCurrent: () => {}, go: () => {} };
export function initPlan(c) {
  ctx = { ...ctx, ...c };
}

const DONE = new Set(['kept', 'min', 'pardoned']);
const JUDGED = new Set(['kept', 'min', 'pardoned', 'missed', 'open', 'none']);
const level = (s) => (s >= 80 ? 'strong' : s >= 40 ? 'mid' : 'new');
const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
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
  const heat = heatmap(h.heat, p.today);
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
    <div class="group pl-add">${quickAdd('plan-quick')}</div>
    ${lists || '<p class="pl-none">No open tasks. Add one above, or tell the coach.</p>'}
  </section>`;
}

// ---------- Taps ----------

export async function planClick(a, el, $app) {
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
  const id = Number(el.dataset.id);
  if (a === 'plan-tab') {
    state.planTab = el.dataset.tab;
    ctx.render();
  } else if (a === 'rest-cancel') {
    if (await act(() => api('DELETE', `/api/rest/${el.dataset.date}`), 'Rest day cancelled.')) await ctx.refreshCurrent();
  } else if (a === 'remove-habit') {
    // One tap, no dialog: Undo sits on the Plan screen until the next change.
    const r = await act(() => api('DELETE', `/api/habits/${id}`));
    if (r) {
      state.sheet = null;
      state.removed = { id, name: r.name, at: Date.now() };
      await ctx.go();
    }
  } else if (a === 'restore-habit') {
    const r = await act(() => api('POST', `/api/habits/${id}/restore`, {}));
    if (r) { state.removed = null; toast(`Kept ${r.name}.`); await ctx.go(); }
  } else if (a === 'delete-task') {
    if (!await confirmSheet('Delete this task?')) return true;
    if (await act(() => api('DELETE', `/api/tasks/${id}`), 'Deleted.')) { state.sheet = null; await ctx.go(); }
  } else return false;
  return true;
}

// ---------- The page, the forms and the changes ----------

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

export function habitForm(h) {
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

export function taskForm(k) {
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

// A habit that left the list at once can come back for a couple of minutes; one leaving tomorrow
// shows Keep it on its own card instead.
const undoable = (p) => state.removed && Date.now() - state.removed.at < 120000 && !p.habits.some((h) => h.id === state.removed.id);

export function viewPlan() {
  const p = state.plan;
  if (!p) return ctx.shell(ctx.skeleton('Plan'));
  const tab = state.planTab || 'habits';
  const wide = window.matchMedia('(min-width: 1240px)').matches;
  // Goals are Plan's third segment on the phone; the sidebar keeps its own Goals row.
  const goals = state.goals || p.goals;
  const activeGoals = goals.filter((g) => g.status === 'active').length;
  const segBtn = (id, label, n) => `<button role="tab" aria-selected="${tab === id}" data-action="plan-tab" data-tab="${id}">${label}<span class="seg-n">${n}</span></button>`;
  const seg = `<div class="seg plan-seg only-narrow-flex" role="tablist" aria-label="Show">
      ${segBtn('habits', 'Habits', p.habits.length)}${segBtn('tasks', 'Tasks', p.tasks.length)}${segBtn('goals', 'Goals', activeGoals)}
    </div>`;
  // Two columns from 1240px show habits and tasks, so + adds a habit there.
  const add = tab === 'goals' && !wide
    ? `<a class="icon-btn accent" href="#/goals/new" aria-label="New goal">${icon('plus')}</a>`
    : `<button class="icon-btn accent" data-action="sheet" data-kind="${tab === 'tasks' ? 'task' : 'habit'}" aria-label="New ${tab === 'tasks' ? 'task' : 'habit'}">${icon('plus')}</button>`;
  const undo = undoable(p) ? `<div class="banner food-undo"><span>Removed ${esc(state.removed.name)}.</span><button class="btn tinted small" data-action="restore-habit" data-id="${state.removed.id}">Undo</button></div>` : '';
  const empty = emptyState({ icon: 'plan', title: 'No habits yet', actions: '<button class="btn primary" data-action="sheet" data-kind="habit">Add the first habit</button>' });

  ctx.shell(`${pageHead('Plan', { over: `${p.habits.length} habits, ${p.tasks.length} tasks, ${activeGoals} ${activeGoals === 1 ? 'goal' : 'goals'}`, actions: add })}
    ${tab === 'goals' && !wide ? '' : planHero(p)}
    ${seg}
    ${askCoach('plan')}
    <div class="split plan-split tab-${tab}">
    <div class="pane-habits">${planHabits(p, { undo, empty })}${planRest(p)}</div>
    <aside class="pane-tasks">${planTasks(p)}</aside>
    <div class="pane-goals">${goalsBody(goals, '<div class="gh"><h2>Goals</h2><a class="gh-link" href="#/goals/new">New goal</a></div>')}</div>
  </div>`);
}

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

export async function planSubmit(kind, form) {
  if (kind === 'new-habit') {
    const r = await act(() => api('POST', '/api/habits', habitPayload(form)), (x) => (x.startsToday ? 'Habit added. It counts from today.' : 'Habit added. Today\'s deadline has passed, so it starts tomorrow.'));
    if (r) {
      await saveAuto(r.habit.id, form, null);
      state.sheet = null;
      await ctx.go();
    }
  } else if (kind === 'edit-habit') {
    const before = state.plan?.habits.find((h) => h.id === Number(form.dataset.id));
    const r = await act(() => api('PATCH', `/api/habits/${form.dataset.id}`, habitPayload(form)), (x) => (x.effective === 'now' ? 'Saved.' : `Saved. New rules start ${fmtDay(x.effective)}.`));
    if (r && (await saveAuto(Number(form.dataset.id), form, before))) { state.sheet = null; await ctx.go(); }
  } else if (kind === 'new-task') {
    if (await act(() => api('POST', '/api/tasks', taskPayload(form)), 'Task added.')) { state.sheet = null; await ctx.go(); }
  } else if (kind === 'edit-task') {
    if (await act(() => api('PATCH', `/api/tasks/${form.dataset.id}`, taskPayload(form)), 'Saved.')) { state.sheet = null; await ctx.go(); }
  } else if (kind === 'rest') {
    const f = form2obj(form);
    if (await act(() => api('POST', '/api/rest', f), `Rest day booked for ${fmtDay(f.date)}.`)) await ctx.refreshCurrent();
  } else return false;
  return true;
}
