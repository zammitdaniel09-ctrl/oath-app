// Oath web app. Plain modules, no build step.

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

const state = {
  route: 'today',
  today: null,
  plan: null,
  ledger: null,
  coach: null,
  settings: null,
  pardoning: null,
  editingHabit: null,
  editingTask: null,
  sending: false,
  push: { supported: false, permission: 'default', subscribed: false },
};

// ---------- Utilities ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('You are offline. Try again when you have a connection.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !['/api/login', '/api/setup', '/api/password'].includes(path)) {
    renderLogin();
    throw new ApiError('Log in first.', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  $toast.textContent = msg;
  $toast.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = 'toast'; }, bad ? 4200 : 2400);
}

const tz = () => state.today?.timezone || 'Europe/Malta';

function fmtClock(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz() }).format(new Date(iso));
}

function fmtDay(dateStr, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!dateStr) return '';
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(`${dateStr}T12:00:00Z`));
}

function left(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: 'due now', cls: 'gone' };
  const min = Math.ceil(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  const text = h ? `${h} h ${m} min left` : `${m} min left`;
  return { text, cls: min <= 60 ? 'soon' : '' };
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function scheduleText(days, deadline) {
  const set = [...days].sort();
  let when;
  if (set.length === 7) when = 'Every day';
  else if (set.join() === '1,2,3,4,5') when = 'Weekdays';
  else if (set.join() === '6,7') when = 'Weekends';
  else when = set.map((d) => DAY_NAMES[d - 1]).join(', ');
  return `${when} by ${deadline}`;
}

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- Shell ----------

const TABS = [
  ['today', 'Today'],
  ['plan', 'Plan'],
  ['coach', 'Coach'],
  ['ledger', 'Ledger'],
  ['settings', 'Settings'],
];

function shell(inner) {
  const nav = TABS.map(([id, label]) => `<a href="#/${id}"${state.route === id ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  $app.innerHTML = `<main>${inner}</main><nav class="tabbar" aria-label="Sections">${nav}</nav>`;
}

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

function habitRow(i, t) {
  const cls = `row ${i.status}${i.heavy ? ' heavy' : ''}`;
  const side = `<span class="row-side">${i.streak ? `<span class="streak">${i.streak}<small>${i.streak === 1 ? 'day' : 'days'}</small></span>` : ''}</span>`;
  const rulesNote = i.rulesChangeFrom ? `, new rules from ${fmtDay(i.rulesChangeFrom)}` : '';
  if (i.status === 'open') {
    const l = left(i.dueAt);
    return `<button class="${cls}" data-action="keep" data-id="${i.id}">
      <span class="box">${CHECK}</span>
      <span><span class="row-title">${esc(i.title)}</span>
        <span class="row-meta" style="display:block">Due ${i.deadline}, <span class="${l.cls}" data-left="${i.dueAt}">${l.text}</span>${i.heavy ? `, ${i.penalty} HP at stake` : ''}${rulesNote}</span></span>
      ${side}</button>`;
  }
  let meta = '';
  let actions = '';
  if (i.status === 'kept') {
    meta = `<span class="good">Kept</span> at ${fmtClock(i.keptAt)}${rulesNote}`;
    if (i.canUndo) actions = `<button class="btn quiet small" data-action="undo" data-id="${i.id}">Undo</button>`;
  } else if (i.status === 'missed') {
    meta = `<span class="bad">Missed at ${i.deadline}, minus ${i.penalty} HP</span>`;
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
      <label class="field"><span>Why should this not count? The coach reads this.</span>
        <textarea class="input" name="reason" minlength="15" required></textarea></label>
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
  const hardText = k.heavy ? `, ${k.penalty} HP at stake` : '';
  const by = k.createdBy === 'coach' ? ', added by the coach' : '';
  if (k.status === 'open') {
    const l = k.heavy && k.dueAt && k.dueDate === t.today ? left(k.dueAt) : null;
    return `<button class="${cls}" data-action="task-done" data-id="${k.id}">
      <span class="box">${CHECK}</span>
      <span><span class="row-title">${esc(k.title)}</span>
        <span class="row-meta" style="display:block">${due}${l ? `, <span class="${l.cls}" data-left="${k.dueAt}">${l.text}</span>` : ''}${hardText}${by}</span></span>
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
  const bars = list.map((d) => `<i class="${d.clean ? 'clean' : d.missed > 0 ? 'dirty' : ''}" style="height:${Math.max(3, d.hp_end)}%" title="${fmtDay(d.date)}: ${d.hp_end} HP"></i>`).join('');
  return `<div class="bars" role="img" aria-label="HP at the end of each of the last ${list.length} days">${bars}</div>
    <div class="bars-legend"><span>${fmtDay(list[0].date)}</span><span>${fmtDay(list[list.length - 1].date)}</span></div>`;
}

function viewToday() {
  const t = state.today;
  if (!t) return shell('<p class="muted">Loading</p>');
  const g = t.game;
  const lostToday = [...t.items, ...t.tasks].filter((i) => i.status === 'missed').reduce((n, i) => n + i.penalty, 0);
  const m = meter(g, lostToday);
  const seasonDay = daysBetween(g.seasonStart, t.today) + 1;

  const openDue = [
    ...t.items.filter((i) => i.status === 'open').map((i) => ({ title: i.title, dueAt: i.dueAt, deadline: i.deadline })),
    ...t.tasks.filter((k) => k.status === 'open' && k.heavy && k.dueDate === t.today && k.dueAt).map((k) => ({ title: k.title, dueAt: k.dueAt, deadline: k.deadline || '23:59' })),
  ].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const next = openDue[0];
  const nextLine = next
    ? (() => { const l = left(next.dueAt); return `<span>Next: <b>${esc(next.title)}</b> at ${next.deadline}</span><span class="${l.cls}" data-left="${next.dueAt}">${l.text}</span>`; })()
    : t.items.length || t.tasks.length ? '<span>Nothing left with a deadline today.</span>' : '<span>No habits yet. Add your first in Plan.</span>';

  const heavy = t.items.filter((i) => i.heavy);
  const normal = t.items.filter((i) => !i.heavy);
  const keptCount = (list) => list.filter((i) => i.status === 'kept' || i.status === 'pardoned').length;

  const section = (title, list, rows) => (list.length ? `<section class="section">
      <div class="section-head"><h2>${title}</h2><span class="count">${keptCount(list)} of ${list.length} kept</span></div>
      <div class="list">${rows}</div></section>` : '');

  const openTasks = t.tasks.filter((k) => k.status !== 'done');
  const doneTasks = t.tasks.filter((k) => k.status === 'done');
  const tasksHtml = `<section class="section">
    <div class="section-head"><h2>Tasks</h2><span class="count">${doneTasks.length} done today</span></div>
    <div class="list">
      ${[...openTasks, ...doneTasks].map((k) => taskRow(k, t)).join('') || ''}
      <form class="inline-form" data-form="quick-task">
        <label class="sr" for="quick-task">New task</label>
        <input id="quick-task" class="input" name="title" placeholder="Add a task" autocomplete="off" maxlength="200" required>
        <button class="btn" type="submit">Add</button>
      </form>
    </div></section>`;

  const brief = t.briefs[0];
  const briefHtml = brief ? `<div class="brief">${esc(brief.text)}<div class="brief-who">${brief.kind === 'morning' ? 'Morning brief' : 'Evening check'}, ${fmtClock(brief.at)}</div></div>` : '';

  const upcoming = t.upcoming.length ? `<section class="section"><div class="section-head"><h3>Coming up</h3></div>
    <div class="list">${t.upcoming.slice(0, 6).map((u) => `<div class="row${u.heavy ? ' heavy' : ''}" style="grid-template-columns:1fr auto;min-height:48px">
      <span class="row-title">${esc(u.title)}</span><span class="row-side">${fmtDay(u.dueDate)}${u.deadline ? ` ${u.deadline}` : ''}${u.heavy ? ', hard' : ''}</span></div>`).join('')}</div></section>` : '';

  shell(`<div class="split">
    <div>
      <header class="vitals">
        <div class="vitals-top">
          <div class="hp${m.low ? ' low' : ''}">${g.hp}<small>HP</small></div>
          <div class="vitals-meta">
            <strong>${fmtDay(t.today, { weekday: 'long', day: 'numeric', month: 'long' })}</strong><br>
            Season ${g.season}, day ${seasonDay}<br>
            ${g.pardonsLeft} ${g.pardonsLeft === 1 ? 'pardon' : 'pardons'} left, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'}
          </div>
        </div>
        ${m.html}
        <div class="next">${nextLine}</div>
      </header>
      <div class="only-narrow">${briefHtml}</div>
      ${section('Non-negotiables', heavy, heavy.map((i) => habitRow(i, t)).join(''))}
      ${section('Habits', normal, normal.map((i) => habitRow(i, t)).join(''))}
      ${tasksHtml}
    </div>
    <aside>
      <div class="only-wide">${briefHtml}</div>
      <section class="section"><div class="section-head"><h3>Last 14 days</h3><span class="count">HP at day end</span></div>
        <div class="card">${hpBars(t.recentDays)}</div></section>
      ${upcoming}
    </aside>
  </div>`);
  applyResponsiveBrief();
}

function applyResponsiveBrief() {
  const wide = window.matchMedia('(min-width: 900px)').matches;
  document.querySelectorAll('.only-wide').forEach((el) => { el.hidden = !wide; });
  document.querySelectorAll('.only-narrow').forEach((el) => { el.hidden = wide; });
}

// ---------- Plan ----------

function habitForm(h) {
  const days = h ? h.nextRules?.days || h.days : [1, 2, 3, 4, 5, 6, 7];
  const r = h ? { ...h, ...(h.nextRules || {}) } : { deadline: '21:00', non_negotiable: false, penalty: '' };
  const dayBoxes = DAY_NAMES.map((n, i) => `<label><input type="checkbox" name="days" value="${i + 1}"${days.includes(i + 1) ? ' checked' : ''}><span>${n.slice(0, 2)}</span></label>`).join('');
  return `<form data-form="${h ? 'edit-habit' : 'new-habit'}"${h ? ` data-id="${h.id}"` : ''}>
    <label class="field"><span>Name</span><input class="input" name="name" maxlength="120" required value="${esc(h?.name || '')}" placeholder="Gym, read 20 pages, no sugar"></label>
    <div class="grid2">
      <label class="field"><span>Deadline</span><input class="input" type="time" name="deadline" required value="${esc(r.deadline)}"></label>
      <label class="field"><span>HP lost on a miss</span><input class="input" type="number" name="penalty" min="1" max="100" inputmode="numeric" value="${esc(r.penalty)}" placeholder="25 or 10"></label>
    </div>
    <div class="field"><span>Days</span><div class="days">${dayBoxes}</div></div>
    <label class="check"><input type="checkbox" name="non_negotiable"${r.non_negotiable ? ' checked' : ''}> Non-negotiable: more reminders, bigger penalty</label>
    <label class="field"><span>Notes</span><input class="input" name="notes" maxlength="1000" value="${esc(h?.notes || '')}" placeholder="Optional"></label>
    ${h && h.nextRulesFrom ? `<p class="note">New rules start ${fmtDay(h.nextRulesFrom)}. Today keeps the old ones.</p>` : ''}
    <div class="form-actions">
      <button class="btn" type="submit">${h ? 'Save habit' : 'Add habit'}</button>
      ${h ? '<button class="btn quiet" type="button" data-action="edit-cancel">Cancel</button>' : ''}
      ${h ? `<button class="btn quiet" type="button" data-action="archive-habit" data-id="${h.id}">Archive</button>` : ''}
    </div>
    <p class="note">Changes to a habit that is still open today take effect tomorrow.</p>
  </form>`;
}

function taskForm(k) {
  const locked = k?.locked;
  return `<form data-form="${k ? 'edit-task' : 'new-task'}"${k ? ` data-id="${k.id}"` : ''}>
    <label class="field"><span>Task</span><input class="input" name="title" maxlength="200" required value="${esc(k?.title || '')}"></label>
    <div class="grid2">
      <label class="field"><span>Due date</span><input class="input" type="date" name="due_date" value="${esc(k?.dueDate || '')}"${locked ? ' disabled' : ''}></label>
      <label class="field"><span>Time</span><input class="input" type="time" name="deadline" value="${esc(k?.deadline || '')}"${locked ? ' disabled' : ''}></label>
    </div>
    <label class="check"><input type="checkbox" name="hard"${k?.hard ? ' checked' : ''}${locked ? ' disabled' : ''}> Hard task: costs HP if not done by the deadline</label>
    ${locked ? '<p class="note">This hard task is due, so its date and penalty are locked.</p>' : ''}
    <div class="form-actions">
      <button class="btn" type="submit">${k ? 'Save task' : 'Add task'}</button>
      ${k ? '<button class="btn quiet" type="button" data-action="edit-cancel">Cancel</button>' : ''}
      ${k && !locked ? `<button class="btn quiet" type="button" data-action="delete-task" data-id="${k.id}">Delete</button>` : ''}
    </div>
  </form>`;
}

function viewPlan() {
  const p = state.plan;
  if (!p) return shell('<p class="muted">Loading</p>');
  const habits = p.habits.map((h) => {
    if (state.editingHabit === h.id) return `<div class="card">${habitForm(h)}</div>`;
    const archiving = h.archivedFrom ? `<p class="note">Archived from ${fmtDay(h.archivedFrom)}.</p>` : '';
    const pending = h.nextRulesFrom ? `<p class="note">New rules from ${fmtDay(h.nextRulesFrom)}: ${scheduleText(h.nextRules.days, h.nextRules.deadline)}.</p>` : '';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:start">
        <div><h3>${esc(h.name)}</h3>
          <p class="muted" style="margin-top:4px;font-size:15px">${scheduleText(h.days, h.deadline)}, ${h.non_negotiable ? 'non-negotiable' : 'normal'}, minus ${h.penalty} HP</p>
          ${h.notes ? `<p class="faint" style="margin-top:4px;font-size:14px">${esc(h.notes)}</p>` : ''}
          ${pending}${archiving}</div>
        <div style="text-align:right"><span class="streak">${h.streak}<small>${h.streak === 1 ? 'day' : 'days'}</small></span><br>
          <button class="btn quiet small" style="margin-top:8px" data-action="edit-habit" data-id="${h.id}">Edit</button></div>
      </div></div>`;
  }).join('');

  const tasks = p.tasks.map((k) => {
    if (state.editingTask === k.id) return `<div class="card">${taskForm(k)}</div>`;
    const due = k.dueDate ? `${fmtDay(k.dueDate)}${k.deadline ? ` ${k.deadline}` : ''}` : 'No date';
    return `<div class="row${k.hard ? ' heavy' : ''}" style="grid-template-columns:1fr auto">
      <span><span class="row-title">${esc(k.title)}</span><span class="row-meta" style="display:block">${due}${k.hard ? ', hard' : ''}${k.createdBy === 'coach' ? ', added by the coach' : ''}</span></span>
      <button class="btn quiet small" data-action="edit-task" data-id="${k.id}">Edit</button></div>`;
  }).join('');

  shell(`<div class="split">
    <div>
      <section class="section"><div class="section-head"><h2>Habits</h2><span class="count">${p.habits.length} active</span></div>
        ${habits || '<div class="card muted">No habits yet. Add the first one below.</div>'}
      </section>
      <section class="section"><div class="section-head"><h3>New habit</h3></div><div class="card">${habitForm(null)}</div></section>
    </div>
    <aside>
      <section class="section"><div class="section-head"><h2>Open tasks</h2><span class="count">${p.tasks.length}</span></div>
        ${tasks ? `<div class="list">${tasks}</div>` : '<div class="card muted">No open tasks.</div>'}
      </section>
      <section class="section"><div class="section-head"><h3>New task</h3></div><div class="card">${taskForm(null)}</div></section>
    </aside>
  </div>`);
}

// ---------- Coach ----------

function viewCoach() {
  const c = state.coach;
  if (!c) return shell('<p class="muted">Loading</p>');
  const msgs = c.messages.map((m) => `<div class="msg ${m.role}">${esc(m.text)}${m.at ? `<time>${fmtClock(m.at)}</time>` : ''}</div>`).join('');
  shell(`<section class="section" style="margin-top:8px">
      <div class="section-head"><h2>Coach</h2><span class="count">${c.aiEnabled ? 'Claude' : 'Offline'}</span></div>
      ${c.aiEnabled ? '' : '<div class="banner">The coach is offline. It needs an Anthropic API key in the app\'s Railway variables. Briefs still arrive with plain numbers until then.</div>'}
      <div class="form-actions">
        <button class="btn quiet small" data-action="brief" data-kind="morning">Morning brief now</button>
        <button class="btn quiet small" data-action="brief" data-kind="evening">Evening check now</button>
      </div>
      <div class="chat" id="chat">${msgs || '<p class="muted">Ask for a plan, report a slip, or tell it what you are avoiding. It sees your HP, deadlines, streaks and pardon reasons.</p>'}
        ${state.sending ? '<div class="msg assistant faint">Thinking</div>' : ''}</div>
      <form class="composer" data-form="coach">
        <label class="sr" for="coach-text">Message</label>
        <textarea id="coach-text" class="input" name="text" rows="1" maxlength="4000" placeholder="Message the coach" required></textarea>
        <button class="btn" type="submit"${state.sending ? ' disabled' : ''}>Send</button>
      </form>
    </section>`);
  const chat = document.getElementById('chat');
  if (chat) chat.lastElementChild?.scrollIntoView({ block: 'end' });
}

// ---------- Ledger ----------

function viewLedger() {
  const l = state.ledger;
  if (!l) return shell('<p class="muted">Loading</p>');
  const g = l.game;
  const days = [...l.days].reverse();
  const habitRows = l.habitStats.map((h) => `<tr><td>${esc(h.name)}</td><td class="num">${h.streak}</td><td class="num">${h.kept30} of ${h.scheduled30}</td></tr>`).join('');
  const dayRows = l.days.slice(0, 30).map((d) => `<tr><td>${fmtDay(d.date)}</td><td class="num">${d.kept}</td><td class="num">${d.missed ? `<span style="color:var(--breach);font-weight:600">${d.missed}</span>` : 0}</td><td class="num">${d.hp_end}${d.bonus ? ` <span class="faint">(+${d.bonus})</span>` : ''}</td></tr>`).join('');
  const missRows = l.misses.slice(0, 40).map((m) => `<div class="row" style="grid-template-columns:1fr auto;min-height:52px">
      <span><span class="row-title">${esc(m.title)}</span>${m.pardoned ? `<div class="reason">Pardoned: ${esc(m.reason)}</div>` : ''}</span>
      <span class="row-side">${fmtDay(m.date)}<br>${m.pardoned ? 'pardoned' : `<span style="color:var(--breach);font-weight:600">minus ${m.hpLost}</span>`}</span></div>`).join('');
  const deaths = l.deaths.map((d) => `<div class="row" style="grid-template-columns:1fr auto;min-height:48px"><span class="row-title">Killed by ${esc(d.cause)}</span><span class="row-side">${fmtDay(d.date)}, season ${d.season - 1} ended</span></div>`).join('');

  shell(`<div class="split"><div>
      <section class="section"><div class="section-head"><h2>Ledger</h2></div>
        <div class="stats">
          <div class="stat"><b>${g.season}</b><span>Season</span></div>
          <div class="stat"><b>${g.deaths}</b><span>${g.deaths === 1 ? 'Death' : 'Deaths'}</span></div>
          <div class="stat"><b>${g.pardonsLeft}</b><span>Pardons left</span></div>
        </div>
      </section>
      <section class="section"><div class="section-head"><h3>HP, last 30 days</h3></div><div class="card">${hpBars(days, 30)}</div></section>
      <section class="section"><div class="section-head"><h3>Habits, last 30 days</h3></div>
        ${habitRows ? `<div class="list"><table class="table"><thead><tr><th>Habit</th><th class="num">Streak</th><th class="num">Kept</th></tr></thead><tbody>${habitRows}</tbody></table></div>` : '<div class="card muted">No habits yet.</div>'}
      </section>
      <section class="section"><div class="section-head"><h3>Days</h3></div>
        ${dayRows ? `<div class="list"><table class="table"><thead><tr><th>Day</th><th class="num">Kept</th><th class="num">Missed</th><th class="num">HP</th></tr></thead><tbody>${dayRows}</tbody></table></div>` : '<div class="card muted">Your first day closes at midnight.</div>'}
      </section>
    </div><aside>
      <section class="section"><div class="section-head"><h3>Misses</h3><span class="count">${l.misses.length}</span></div>
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
    status = `Reminders are on for this device. ${state.today ? '' : ''}`;
    action = '<button class="btn quiet" data-action="push-test">Send a test</button><button class="btn quiet" data-action="push-off">Turn off on this device</button>';
  } else {
    status = 'Reminders are off on this device. Turn them on so deadlines, misses and briefs reach your lock screen.';
    action = '<button class="btn" data-action="push-on">Turn on reminders</button>';
  }
  return `<div class="card"><h3>Reminders</h3><p class="muted" style="margin-top:6px">${status}</p>${action ? `<div class="form-actions">${action}</div>` : ''}</div>`;
}

function viewSettings() {
  const s = state.settings;
  if (!s) return shell('<p class="muted">Loading</p>');
  shell(`<div class="split"><div>
    <section class="section"><div class="section-head"><h2>Settings</h2></div>
      ${pushCard()}
      <div class="card"><h3>Coach schedule</h3>
        <form data-form="settings">
          <div class="grid2">
            <label class="field"><span>Morning brief</span><input class="input" type="time" name="morningTime" value="${esc(s.morningTime)}" required></label>
            <label class="field"><span>Evening check</span><input class="input" type="time" name="eveningTime" value="${esc(s.eveningTime)}" required></label>
          </div>
          <label class="field"><span>Time zone</span><input class="input" name="timezone" value="${esc(s.timezone)}" required></label>
          <div class="form-actions"><button class="btn" type="submit">Save schedule</button></div>
        </form>
      </div>
      <div class="card"><h3>Password</h3>
        <form data-form="password">
          <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="10" required></label>
          <div class="form-actions"><button class="btn" type="submit">Change password</button><button class="btn quiet" type="button" data-action="logout">Log out</button></div>
        </form>
      </div>
    </section></div>
    <aside><section class="section"><div class="section-head"><h3>The rules</h3></div>
      <div class="card" style="font-size:15px;line-height:1.55">
        <p>You have ${s.maxHp} HP. Every habit has a deadline. Miss it and you lose its HP, and its streak resets.</p>
        <p style="margin-top:10px">Once a deadline passes, the habit is locked. You cannot tick it late. A mistaken tick can be undone within ${s.undoMinutes} minutes.</p>
        <p style="margin-top:10px">Hard tasks cost ${s.taskPenalty} HP if they are not done by their deadline, and cannot be deleted or moved once due.</p>
        <p style="margin-top:10px">A clean day, with nothing missed, gives back ${s.cleanBonus} HP.</p>
        <p style="margin-top:10px">At 0 HP you die. Every streak is wiped and a new season starts at full HP.</p>
        <p style="margin-top:10px">You get ${s.pardonsPerMonth} pardons a month for real emergencies. A pardon needs a written reason, must be used within 24 hours and restores the HP and the streak.</p>
        <p style="margin-top:10px">Changing a habit that is still open today only takes effect tomorrow.</p>
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

// ---------- Data loading ----------

async function load(route) {
  if (route === 'today') state.today = await api('GET', '/api/today');
  if (route === 'plan') state.plan = await api('GET', '/api/plan');
  if (route === 'coach') state.coach = await api('GET', '/api/coach');
  if (route === 'ledger') state.ledger = await api('GET', '/api/ledger');
  if (route === 'settings') {
    state.settings = await api('GET', '/api/settings');
    await refreshPushState();
  }
}

function render() {
  const views = { today: viewToday, plan: viewPlan, coach: viewCoach, ledger: viewLedger, settings: viewSettings };
  (views[state.route] || viewToday)();
}

async function go() {
  const route = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'today';
  state.route = TABS.some(([id]) => id === route) ? route : 'today';
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
  if (state.route === 'today') render();
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

// ---------- Events ----------

const form2obj = (form) => Object.fromEntries(new FormData(form).entries());

function habitPayload(form) {
  const f = new FormData(form);
  const penalty = f.get('penalty');
  return {
    name: f.get('name'),
    deadline: f.get('deadline'),
    days: f.getAll('days').map(Number),
    non_negotiable: f.get('non_negotiable') === 'on',
    penalty: penalty === '' ? undefined : Number(penalty),
    notes: f.get('notes') || '',
  };
}

function taskPayload(form) {
  const f = new FormData(form);
  const out = { title: f.get('title') };
  if (f.has('due_date')) out.due_date = f.get('due_date') || null;
  if (f.has('deadline')) out.deadline = f.get('deadline') || null;
  if (!form.querySelector('[name="hard"]').disabled) out.hard = f.get('hard') === 'on';
  return out;
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    return r;
  } catch (err) {
    if (err.status !== 401) toast(err.message, true);
    return null;
  }
}

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  const a = el.dataset.action;
  if (a === 'keep') {
    el.disabled = true;
    const ok = await act(() => api('POST', `/api/habits/${id}/keep`, {}), 'Kept. You can undo for 10 minutes.');
    if (ok) await refreshToday(); else el.disabled = false;
  } else if (a === 'undo') {
    if (await act(() => api('POST', `/api/habits/${id}/undo`, {}), 'Undone.')) await refreshToday();
  } else if (a === 'task-done') {
    if (await act(() => api('POST', `/api/tasks/${id}/done`, {}), 'Done.')) await refreshToday();
  } else if (a === 'task-undo') {
    if (await act(() => api('POST', `/api/tasks/${id}/undo`, {}), 'Undone.')) await refreshToday();
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

$app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (kind === 'login') {
      try {
        await api('POST', '/api/login', form2obj(form));
        location.hash = '#/today';
        await go();
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
    } else if (kind === 'quick-task') {
      const title = form2obj(form).title;
      if (await act(() => api('POST', '/api/tasks', { title }), 'Task added.')) await refreshToday();
    } else if (kind === 'pardon') {
      const reason = form2obj(form).reason;
      const r = await act(() => api('POST', `/api/misses/${form.dataset.id}/pardon`, { reason }), (x) => `Pardoned. ${x.pardonsLeft} left this month.`);
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
    } else if (kind === 'coach') {
      const text = form2obj(form).text.trim();
      if (!text) return;
      state.coach.messages.push({ role: 'user', text, at: new Date().toISOString() });
      state.sending = true;
      render();
      const r = await act(() => api('POST', '/api/coach', { text }));
      state.sending = false;
      if (r) state.coach.messages.push(r.reply);
      render();
      state.today = null;
    } else if (kind === 'settings') {
      if (await act(() => api('PATCH', '/api/settings', form2obj(form)), 'Schedule saved.')) await go();
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
});

// Keep countdowns live without re-rendering the page.
setInterval(() => {
  document.querySelectorAll('[data-left]').forEach((el) => {
    const l = left(el.dataset.left);
    el.textContent = l.text;
    el.className = l.cls;
  });
}, 15000);

setInterval(() => {
  if (document.visibilityState === 'visible' && state.route === 'today' && state.today) refreshToday().catch(() => {});
}, 60000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.today !== undefined && document.querySelector('.tabbar')) go();
});

window.addEventListener('hashchange', () => {
  state.pardoning = null;
  state.editingHabit = null;
  state.editingTask = null;
  go();
});

window.matchMedia('(min-width: 900px)').addEventListener('change', applyResponsiveBrief);

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
  } catch (err) {
    $app.innerHTML = `<div class="gate"><div class="wordmark">Oath</div><p>${esc(err.message)}</p></div>`;
  }
}

boot();
