// Goals and their mind maps.
//
// A goal is written as WOOP (wish, outcome, obstacle, if-then plan), the format with the best
// evidence for goal attainment, and carries either a number to reach or a set of steps. Under
// it sits a mind map, edited as an outline on iPhone, where any branch can become a task or a
// habit. Completions and habit strength roll back up to the branch and the goal.
import { db, logEvent } from './db.js';
import { nowUTC, validTime, validDate } from './time.js';
import { localNow, RuleError, createTask, createHabit, completeTask, undoTask } from './engine.js';
import { habitStats } from './strength.js';

const ts = () => nowUTC().toJSDate();
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

async function getGoalRow(id) {
  const [g] = await db()`select * from goals where id = ${id}`;
  if (!g) throw new RuleError('That goal does not exist.', 404);
  return g;
}

// ---------- Progress ----------

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

// Early on, show what is done; past halfway, show what is left (Koo & Fishbach 2012).
function progressLabel(g, pct, parts) {
  if (pct === null) return 'No steps yet. Break it down in the map.';
  if (g.measure === 'number') {
    const unit = g.unit ? ` ${g.unit}` : '';
    const gained = (g.current_value ?? g.start_value ?? 0) - (g.start_value ?? 0);
    const left = (g.target_value ?? 0) - (g.current_value ?? g.start_value ?? 0);
    return pct < 50 ? `${gained > 0 ? '+' : ''}${fmtNum(gained)}${unit} since you started` : left <= 0 ? 'Target reached' : `${fmtNum(left)}${unit} to go`;
  }
  return pct < 50 ? `${parts.done} of ${parts.total} steps done` : parts.total - parts.done <= 0 ? 'Every step done' : `${fmtNum(parts.total - parts.done)} ${parts.total - parts.done === 1 ? 'step' : 'steps'} to go`;
}

async function goalContext(goalIds) {
  if (!goalIds.length) return { tasks: [], habits: [], stats: new Map() };
  const { today, tz } = await localNow();
  const tasks = await db()`select * from tasks where goal_id in ${db()(goalIds)} and deleted_at is null order by done_at nulls first, due_date nulls last, id`;
  const habits = (await db()`select * from habits where goal_id in ${db()(goalIds)} order by sort, id`)
    .filter((h) => !h.archived_from || h.archived_from > today);
  const stats = await habitStats(habits, today, tz, { heatDays: 1 });
  return { tasks, habits, stats };
}

function computeProgress(g, ctx) {
  if (g.measure === 'number' && g.target_value !== null && g.target_value !== g.start_value) {
    const start = g.start_value ?? 0;
    const cur = g.current_value ?? start;
    const pct = Math.max(0, Math.min(100, Math.round(((cur - start) / (g.target_value - start)) * 100)));
    return { pct, label: progressLabel(g, pct) };
  }
  // Steps: tasks count 1 when done, habits count by their strength.
  const tasks = ctx.tasks.filter((t) => t.goal_id === g.id);
  const habits = ctx.habits.filter((h) => h.goal_id === g.id);
  const total = tasks.length + habits.length;
  if (!total) return { pct: null, label: progressLabel(g, null) };
  const done = tasks.filter((t) => t.done_at).length + habits.reduce((n, h) => n + (ctx.stats.get(h.id)?.strength ?? 0) / 100, 0);
  const pct = Math.round((done / total) * 100);
  return { pct, label: progressLabel(g, pct, { done: Math.round(done * 10) / 10, total }) };
}

function shapeGoal(g, ctx, today) {
  const p = computeProgress(g, ctx);
  return {
    id: g.id,
    title: g.title,
    why: g.why,
    obstacle: g.obstacle,
    plan: g.plan,
    measure: g.measure,
    unit: g.unit,
    startValue: g.start_value,
    targetValue: g.target_value,
    currentValue: g.current_value,
    targetDate: g.target_date,
    daysLeft: g.target_date ? daysBetween(today, g.target_date) : null,
    status: g.status,
    pct: p.pct,
    label: p.label,
    taskCount: ctx.tasks.filter((t) => t.goal_id === g.id).length,
    habitCount: ctx.habits.filter((h) => h.goal_id === g.id).length,
  };
}

export async function listGoals({ includeClosed = false } = {}) {
  const { today } = await localNow();
  const rows = includeClosed
    ? await db()`select * from goals order by (status = 'active') desc, sort, id`
    : await db()`select * from goals where status = 'active' order by sort, id`;
  const ctx = await goalContext(rows.map((g) => g.id));
  return rows.map((g) => shapeGoal(g, ctx, today));
}

// ---------- One goal with its map ----------

function buildTree(nodes, refs) {
  const byParent = new Map();
  for (const n of nodes) {
    const k = n.parent_id ?? 0;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort || a.id - b.id);
  const walk = (parentId, depth) => (byParent.get(parentId) || []).map((n) => {
    const children = walk(n.id, depth + 1);
    const ref = n.kind === 'task' ? refs.tasks.get(n.ref_id) : n.kind === 'habit' ? refs.habits.get(n.ref_id) : null;
    let value = null;
    if (n.kind === 'task' && ref) value = ref.done ? 1 : 0;
    else if (n.kind === 'habit' && ref) value = ref.strength / 100;
    else {
      const vals = children.map((c) => c.value).filter((v) => v !== null);
      value = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return {
      id: n.id, text: n.text, kind: ref ? n.kind : 'idea', refId: ref ? n.ref_id : null, depth, ref, children,
      value, pct: value === null ? null : Math.round(value * 100),
    };
  });
  return walk(0, 0);
}

export async function getGoal(id) {
  const { today } = await localNow();
  const g = await getGoalRow(id);
  const ctx = await goalContext([g.id]);
  const nodes = await db()`select * from nodes where goal_id = ${g.id}`;
  // Branches turned into tasks or habits elsewhere keep pointing at them.
  const taskIds = nodes.filter((n) => n.kind === 'task' && n.ref_id).map((n) => n.ref_id);
  const extraTasks = taskIds.length ? await db()`select * from tasks where id in ${db()(taskIds)} and deleted_at is null` : [];
  const taskMap = new Map([...ctx.tasks, ...extraTasks].map((t) => [t.id, {
    id: t.id, title: t.title, done: Boolean(t.done_at), dueDate: t.due_date, deadline: t.deadline, hard: t.hard,
  }]));
  const habitMap = new Map(ctx.habits.map((h) => [h.id, {
    id: h.id, title: h.name, strength: ctx.stats.get(h.id)?.strength ?? 0, cue: h.cue,
  }]));
  const logs = await db()`select value, note, at from goal_logs where goal_id = ${g.id} order by at desc limit 20`;
  return {
    goal: shapeGoal(g, ctx, today),
    tree: buildTree(nodes, { tasks: taskMap, habits: habitMap }),
    tasks: ctx.tasks.map((t) => ({ id: t.id, title: t.title, done: Boolean(t.done_at), dueDate: t.due_date, deadline: t.deadline, hard: t.hard })),
    habits: ctx.habits.map((h) => ({ id: h.id, title: h.name, strength: ctx.stats.get(h.id)?.strength ?? 0, cue: h.cue })),
    logs,
  };
}

// ---------- Writing goals ----------

function goalFields(input, current = {}) {
  const pick = (k, fn) => (input[k] !== undefined ? fn(input[k]) : current[k]);
  const measure = pick('measure', (v) => (v === 'number' ? 'number' : 'steps')) ?? 'steps';
  const f = {
    title: pick('title', (v) => text(v, 160)),
    why: pick('why', (v) => text(v, 500)) ?? '',
    obstacle: pick('obstacle', (v) => text(v, 500)) ?? '',
    plan: pick('plan', (v) => text(v, 500)) ?? '',
    measure,
    unit: pick('unit', (v) => text(v, 20)) ?? '',
    start_value: pick('start_value', num) ?? null,
    target_value: pick('target_value', num) ?? null,
    target_date: pick('target_date', (v) => (validDate(v) ? v : null)) ?? null,
  };
  if (!f.title) throw new RuleError('Name the goal.');
  if (f.measure === 'number' && (f.target_value === null || f.target_value === f.start_value)) {
    throw new RuleError('A number goal needs a target different from where you start.');
  }
  return f;
}

export async function createGoal(input) {
  const f = goalFields(input);
  const [{ max }] = await db()`select coalesce(max(sort), 0) as max from goals`;
  const [g] = await db()`
    insert into goals (title, why, obstacle, plan, measure, unit, start_value, target_value, current_value, target_date, sort, created_at)
    values (${f.title}, ${f.why}, ${f.obstacle}, ${f.plan}, ${f.measure}, ${f.unit}, ${f.start_value}, ${f.target_value},
            ${f.start_value}, ${f.target_date}, ${max + 1}, ${ts()})
    returning *`;
  await logEvent('goal_created', { id: g.id, title: g.title });
  return { id: g.id };
}

export async function updateGoal(id, input) {
  const g = await getGoalRow(id);
  const f = goalFields(input, g);
  await db()`update goals set title = ${f.title}, why = ${f.why}, obstacle = ${f.obstacle}, plan = ${f.plan}, measure = ${f.measure},
             unit = ${f.unit}, start_value = ${f.start_value}, target_value = ${f.target_value}, target_date = ${f.target_date},
             current_value = ${g.current_value ?? f.start_value} where id = ${id}`;
  return { ok: true };
}

export async function setGoalStatus(id, status) {
  if (!['active', 'done', 'dropped'].includes(status)) throw new RuleError('Unknown status.');
  const g = await getGoalRow(id);
  await db()`update goals set status = ${status}, done_at = ${status === 'active' ? null : ts()} where id = ${id}`;
  await logEvent('goal_status', { id, title: g.title, status });
  return { ok: true };
}

// "42" sets the current value; "+3" or "-1" adds to it.
export async function logGoal(id, raw, note = '') {
  const g = await getGoalRow(id);
  if (g.measure !== 'number') throw new RuleError('This goal is measured by steps, not a number.');
  const s = String(raw ?? '').trim().replace(',', '.');
  const delta = /^[+-]/.test(s);
  const n = Number(s);
  if (!s || !Number.isFinite(n)) throw new RuleError('Type a number, or +N to add to it.');
  const value = delta ? (g.current_value ?? g.start_value ?? 0) + n : n;
  await db()`update goals set current_value = ${value} where id = ${id}`;
  await db()`insert into goal_logs (goal_id, value, note, at) values (${id}, ${value}, ${text(note, 200)}, ${ts()})`;
  await logEvent('goal_logged', { id, title: g.title, value });
  return { ok: true, value };
}

// ---------- The map ----------

async function getNode(id) {
  const [n] = await db()`select * from nodes where id = ${id}`;
  if (!n) throw new RuleError('That branch does not exist.', 404);
  return n;
}

async function siblings(goalId, parentId) {
  return parentId
    ? db()`select * from nodes where goal_id = ${goalId} and parent_id = ${parentId} order by sort, id`
    : db()`select * from nodes where goal_id = ${goalId} and parent_id is null order by sort, id`;
}

export async function addNode(goalId, { parentId = null, afterId = null, text: t }) {
  await getGoalRow(goalId);
  const body = text(t, 200);
  if (!body) throw new RuleError('Write something first.');
  if (parentId) {
    const p = await getNode(parentId);
    if (p.goal_id !== Number(goalId)) throw new RuleError('That branch belongs to another goal.');
  }
  const sibs = await siblings(goalId, parentId);
  let sort = sibs.length ? sibs[sibs.length - 1].sort + 1 : 1;
  if (afterId) {
    const i = sibs.findIndex((n) => n.id === Number(afterId));
    if (i >= 0) sort = i + 1 < sibs.length ? (sibs[i].sort + sibs[i + 1].sort) / 2 : sibs[i].sort + 1;
  }
  const [n] = await db()`insert into nodes (goal_id, parent_id, text, sort, created_at)
                         values (${goalId}, ${parentId || null}, ${body}, ${sort}, ${ts()}) returning id`;
  return { id: n.id };
}

export async function updateNode(id, { text: t }) {
  const n = await getNode(id);
  const body = text(t, 200);
  if (!body) throw new RuleError('A branch cannot be empty. Delete it instead.');
  await db()`update nodes set text = ${body} where id = ${id}`;
  if (n.kind === 'task' && n.ref_id) await db()`update tasks set title = ${body} where id = ${n.ref_id} and done_at is null`;
  if (n.kind === 'habit' && n.ref_id) await db()`update habits set name = ${body} where id = ${n.ref_id}`;
  return { ok: true };
}

export async function moveNode(id, op) {
  const n = await getNode(id);
  const sibs = await siblings(n.goal_id, n.parent_id);
  const i = sibs.findIndex((x) => x.id === n.id);
  if (op === 'up' || op === 'down') {
    const j = op === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sibs.length) return { ok: true };
    await db()`update nodes set sort = ${sibs[j].sort} where id = ${n.id}`;
    await db()`update nodes set sort = ${n.sort} where id = ${sibs[j].id}`;
    if (sibs[j].sort === n.sort) await db()`update nodes set sort = ${n.sort + (op === 'up' ? -0.5 : 0.5)} where id = ${n.id}`;
    return { ok: true };
  }
  if (op === 'indent') {
    if (i <= 0) throw new RuleError('Nothing above to move it under.');
    const parent = sibs[i - 1];
    const kids = await siblings(n.goal_id, parent.id);
    await db()`update nodes set parent_id = ${parent.id}, sort = ${kids.length ? kids[kids.length - 1].sort + 1 : 1} where id = ${n.id}`;
    return { ok: true };
  }
  if (op === 'outdent') {
    if (!n.parent_id) throw new RuleError('It is already at the top level.');
    const parent = await getNode(n.parent_id);
    const upper = await siblings(n.goal_id, parent.parent_id);
    const k = upper.findIndex((x) => x.id === parent.id);
    const sort = k + 1 < upper.length ? (upper[k].sort + upper[k + 1].sort) / 2 : upper[k].sort + 1;
    await db()`update nodes set parent_id = ${parent.parent_id}, sort = ${sort} where id = ${n.id}`;
    return { ok: true };
  }
  throw new RuleError('Unknown move.');
}

export async function deleteNode(id) {
  const n = await getNode(id);
  // Children move up one level instead of disappearing with their parent.
  await db()`update nodes set parent_id = ${n.parent_id} where parent_id = ${n.id}`;
  await db()`delete from nodes where id = ${n.id}`;
  return { ok: true };
}

const v = { validTime, validDate };

export async function convertNode(id, to, opts = {}) {
  const n = await getNode(id);
  if (n.kind !== 'idea' && n.ref_id) throw new RuleError(`This branch is already a ${n.kind}.`, 409);
  if (to === 'task') {
    const t = await createTask({ ...opts, title: n.text, goal_id: n.goal_id, node_id: n.id }, v);
    await db()`update nodes set kind = 'task', ref_id = ${t.id} where id = ${n.id}`;
    return { ok: true, taskId: t.id };
  }
  if (to === 'habit') {
    const { habit, startsToday } = await createHabit({ ...opts, name: n.text, goal_id: n.goal_id }, v);
    await db()`update nodes set kind = 'habit', ref_id = ${habit.id} where id = ${n.id}`;
    return { ok: true, habitId: habit.id, startsToday };
  }
  throw new RuleError('Turn it into a task or a habit.');
}

export async function toggleNodeTask(id) {
  const n = await getNode(id);
  if (n.kind !== 'task' || !n.ref_id) throw new RuleError('That branch is not a task.');
  const [t] = await db()`select done_at from tasks where id = ${n.ref_id}`;
  if (!t) throw new RuleError('That task no longer exists.', 404);
  if (t.done_at) await undoTask(n.ref_id);
  else await completeTask(n.ref_id);
  return { ok: true, done: !t.done_at };
}
