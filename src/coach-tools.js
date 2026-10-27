// Everything the coach can do in Oath. Each tool calls the same function the app's own buttons
// call, so every rule still holds: locked deadlines, the undo window, pardon limits, rule changes
// that start tomorrow. Tools that remove or rewrite something wait for Daniel to confirm.
import { DateTime } from 'luxon';
import { db, logEvent } from './db.js';
import { validTime, validDate, deadlineText, addDays } from './time.js';
import * as engine from './engine.js';
import * as goals from './goals.js';
import { ESTIMATE_KEYS, MICRO_TEXT } from './food.js';
import { createOathEvent, updateOathEvent, deleteOathEvent, getOathEvent, eventsBetween, eventClashes, cleanDeadlineTitle } from './calendar.js';

const v = { validTime, validDate };
const { RuleError } = engine;

// Modules that import the coach are loaded when a tool runs, never at start-up.
const drive = () => import('./drive.js');
const review = () => import('./review.js');
const health = () => import('./health.js');
const settings = () => import('./settings.js');
const food = () => import('./food.js');
const foodPhoto = () => import('./food-photo.js');

export const PENDING_MINUTES = 30;

const S = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const I = (description) => ({ type: 'integer', ...(description ? { description } : {}) });
const N = (description) => ({ type: 'number', ...(description ? { description } : {}) });
const B = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
const E = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const DATE = S('YYYY-MM-DD');
const TIME = S('HH:MM, 24 h local time');
const DAYS = { type: 'array', items: { type: 'integer' }, description: 'ISO weekdays, 1 = Monday ... 7 = Sunday' };

// ---------- Lookups ----------

const one = async (q, what) => {
  const [row] = await q;
  if (!row) throw new RuleError(`No ${what} with that id. Use find_items to look it up.`);
  return row;
};
const taskRow = (id) => one(db()`select * from tasks where id = ${Number(id)} and deleted_at is null`, 'task');
const habitRow = (id) => one(db()`select * from habits where id = ${Number(id)}`, 'habit');
const goalRow = (id) => one(db()`select * from goals where id = ${Number(id)}`, 'goal');
const nodeRow = (id) => one(db()`select n.*, g.title as goal_title from nodes n join goals g on g.id = n.goal_id where n.id = ${Number(id)}`, 'goal step');

// A goal named by id, or by (part of) its title as the coach heard it.
async function goalFrom(input) {
  if (input.goal_id) return goalRow(input.goal_id);
  if (!input.goal) return null;
  const all = await db()`select id, title from goals where status = 'active'`;
  const t = String(input.goal).toLowerCase();
  const g = all.find((x) => x.title.toLowerCase() === t) || all.find((x) => x.title.toLowerCase().includes(t) || t.includes(x.title.toLowerCase()));
  if (!g) throw new RuleError(`No active goal called "${input.goal}".`);
  return g;
}

const dueText = (t) => (t.due_date ? `, ${t.due_date}${t.deadline ? ` ${deadlineText(t.deadline)}` : ''}` : '');
const pick = (input, keys) => Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));

async function findItems({ query = '', kind = 'all', include_closed = false }) {
  const like = `%${String(query).trim()}%`;
  const { today } = await engine.localNow();
  const out = [];
  if (kind === 'all' || kind === 'task') {
    const rows = await db()`select id, title, due_date, deadline, hard, done_at from tasks
      where deleted_at is null and title ilike ${like} and (done_at is null or ${Boolean(include_closed)})
      order by done_at nulls first, due_date nulls last, id limit 25`;
    for (const t of rows) out.push(`task #${t.id} "${t.title}"${dueText(t)}${t.hard ? ', hard' : ''}${t.done_at ? ', done' : ''}`);
  }
  if (kind === 'all' || kind === 'habit') {
    const rows = await db()`select id, name, deadline, weekly_target, non_negotiable, penalty, archived_from from habits
      where name ilike ${like} and (archived_from is null or archived_from > ${today} or ${Boolean(include_closed)}) order by sort, id limit 25`;
    for (const h of rows) out.push(`habit #${h.id} "${h.name}", ${h.weekly_target ? `${h.weekly_target} times a week` : `due ${deadlineText(h.deadline)}`}, ${h.non_negotiable ? 'non-negotiable, ' : ''}${h.penalty} HP${h.archived_from && h.archived_from <= today ? ', archived' : ''}`);
  }
  if (kind === 'all' || kind === 'goal') {
    const rows = await db()`select id, title, status from goals where title ilike ${like} and (status = 'active' or ${Boolean(include_closed)}) order by sort, id limit 15`;
    for (const g of rows) out.push(`goal #${g.id} "${g.title}"${g.status === 'active' ? '' : `, ${g.status}`}`);
  }
  if (kind === 'all' || kind === 'step') {
    const rows = await db()`select n.id, n.text, n.kind, n.parent_id, g.title from nodes n join goals g on g.id = n.goal_id
      where n.text ilike ${like} and g.status = 'active' order by g.id, n.sort limit 25`;
    for (const n of rows) out.push(`step #${n.id} "${n.text}" in goal "${n.title}"${n.kind !== 'idea' ? ` (a ${n.kind})` : ''}${n.parent_id ? `, under step #${n.parent_id}` : ''}`);
  }
  if (kind === 'all' || kind === 'miss') {
    const rows = await db()`select id, title, date, hp_lost, pardoned_at, created_at from misses
      where title ilike ${like} and created_at > now() - interval '3 days' order by created_at desc limit 10`;
    for (const m of rows) out.push(`miss #${m.id} "${m.title}" on ${m.date}, -${m.hp_lost} HP${m.pardoned_at ? ', pardoned' : ''}`);
  }
  return out.length ? out.join('\n') : 'Nothing matches.';
}

// ---------- Food from a loose description ----------

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks', 'drinks'];
const ESTIMATE_UNITS = ['g', 'ml', 'piece'];
const given = (x) => x !== undefined && x !== null && x !== '';

// The amount a receipt shows for an estimate: the weight or volume that went into the diary.
function roughly(entry) {
  const useMl = given(entry.ml) && (entry.liquid || !given(entry.grams));
  const value = useMl ? entry.ml : entry.grams;
  return given(value) ? `~${Math.round(Number(value))} ${useMl ? 'ml' : 'g'}` : entry.amountText;
}
const kcalText = (kcal) => (given(kcal) ? `${Math.round(Number(kcal))} kcal` : 'energy unknown');

// The coach's own item as an understood food: it stands in for the photo or text reading. Its whole
// calorie estimate becomes energy per 100 when it gave no profile of its own.
function coachItem(it, understood) {
  const unit = ESTIMATE_UNITS.includes(it.unit) ? it.unit : 'g';
  const amount = Number(it.amount) > 0 ? Number(it.amount) : null;
  const weight = Number(it.weight) > 0 ? Number(it.weight) : unit === 'piece' ? null : amount;
  const kcal = given(it.kcal_estimate) && Number(it.kcal_estimate) >= 0 ? Number(it.kcal_estimate) : null;
  const per100 = it.per100 && typeof it.per100 === 'object' && !Array.isArray(it.per100) ? { ...it.per100 } : {};
  if (!given(per100.kcal) && kcal !== null && weight) per100.kcal = (kcal / weight) * 100;
  const searches = [it.search, ...(Array.isArray(it.searches) ? it.searches : [])].filter((s) => typeof s === 'string');
  return { u: understood({ ...it, unit, amount, weight, searches, per100, confidence: 'medium' }), kcal };
}

// "Large fries from Burger King and a coke": the coach's items go through the same search and choice
// as a photo or a typed meal, so each is logged against the most specific record (the restaurant's own
// item and the portion his size word names) with its amount flagged as an estimate, and every core
// value the record lacks filled from the coach's profile. The profile, vitamins and minerals included,
// stays with the entry: the filler (food-enrich.js) uses it for whatever a USDA reference or the web
// cannot give. An item with no record or no usable amount becomes a quick add of the coach's estimate
// instead. One receipt per item; the detail (entry ids, slot, the record, why it was chosen, what was
// filled) goes to the model only, so it can say what it assumed.
async function logFoodEstimate({ items, slot, date, time }) {
  const list = Array.isArray(items) ? items.filter((x) => x && (x.name || x.search)).slice(0, 12) : [];
  if (!list.length) throw new RuleError('Give at least one item he ate or drank.');
  const f = await food();
  const { matchItems, understood } = await foodPhoto();
  const when = pick({ slot, date, time }, ['slot', 'date', 'time']);
  const read = list.map((it) => coachItem(it, understood));
  // Only items with an amount are matched; the rest can still be quick adds of their estimate.
  const asked = read.map((r, i) => (r.u.amount ? i : -1)).filter((i) => i >= 0);
  const found = new Map();
  try {
    const reviewed = await matchItems(asked.map((i) => read[i].u));
    asked.forEach((i, j) => found.set(i, reviewed[j]));
  } catch (err) {
    // Matching failed as a whole: every item falls back to its own estimate.
    console.error('coach food matching failed', err);
  }
  const receipts = [];
  const detail = [];
  for (const [i, it] of list.entries()) {
    const { u } = read[i];
    const name = String(it.name || it.search).trim().slice(0, 120);
    const { unit, amount } = u;
    const m = found.get(i) || null;
    const guess = read[i].kcal ?? m?.guess?.kcal ?? (u.fill?.kcal != null && u.weight ? Math.round((u.fill.kcal * u.weight) / 10) / 10 : null);
    const count = unit === 'piece' && amount > 1 ? ` x${Number(amount.toFixed(2))}` : '';
    try {
      const record = m?.match || null;
      let entry = null;
      if (record && Number(m.qty) > 0) {
        try {
          ({ entry } = await f.logFood({ key: record.key, qty: m.qty, unit: m.unit, ...when, estimate: true, fill: u.fill, searches: u.searches }, 'coach'));
        } catch (err) {
          // An amount the record cannot take falls back to the calorie estimate, when there is one.
          if (!(err instanceof RuleError) || guess === null) throw err;
        }
      }
      if (entry) {
        receipts.push({ ok: true, text: `Logged ${name}${count} ${roughly(entry)} (estimate, ${kcalText(entry.nutrients?.kcal)})` });
        const filled = entry.filled?.length ? `, filled from your estimate: ${entry.filled.join(' and ')}` : '';
        detail.push(`${name}: entry ${entry.id}, ${entry.slot} on ${entry.date}, catalogue record "${entry.name}"${entry.brand ? ` by ${entry.brand}` : ''}, ${entry.amountText}${m.why ? `, chosen because: ${m.why}` : ''}${filled}`);
        continue;
      }
      if (guess === null) {
        receipts.push({ ok: false, text: `Could not log ${name}: ${record ? 'no usable amount' : 'nothing like it in the catalogue'}. Send it again with a kcal_estimate` });
        continue;
      }
      const size = !amount ? '' : unit === 'piece' ? count : ` ~${Math.round(amount)} ${unit}`;
      // The assumed size stays on the diary entry, so he can see what the calories stand for.
      const howMuch = !amount ? '' : unit === 'piece' ? `${Number(amount.toFixed(2))} ${amount === 1 ? 'piece' : 'pieces'}` : `about ${Math.round(amount)} ${unit}`;
      const { entry: q } = await f.quickAdd({
        name, kcal: guess, estimate: true, ...when, fill: u.fill, searches: u.searches, ...(u.brand ? { brand: u.brand } : {}),
        ...(howMuch ? { amount: howMuch } : {}),
        ...(unit === 'ml' && amount ? { ml: amount } : u.weight ? { grams: u.weight } : {}),
      }, 'coach');
      receipts.push({ ok: true, text: `Logged ${name}${size} as a quick add (estimate, ${kcalText(q.nutrients?.kcal)})` });
      detail.push(`${name}: entry ${q.id}, ${q.slot} on ${q.date}, quick add${record ? '' : ', no catalogue match'}`);
    } catch (err) {
      if (!(err instanceof RuleError)) console.error('coach food estimate failed', name, err);
      receipts.push({ ok: false, text: `Could not log ${name}: ${err instanceof RuleError ? err.message : 'unexpected error'}` });
    }
  }
  return { receipts, detail: detail.length ? `Diary entries, all flagged as estimates: ${detail.join('; ')}` : '' };
}

// ---------- Calendar: his own events (feed events are read-only) ----------

// "Tue 28 Oct 18:00 to 19:00", "Fri 30 Oct, all day", "Fri 30 Oct to Sun 1 Nov, all day".
function whenText(ev) {
  const s = DateTime.fromISO(ev.start, { setZone: true });
  const e = DateTime.fromISO(ev.end, { setZone: true });
  const day = (d) => d.toFormat('ccc d LLL');
  if (ev.allDay) return ev.end > ev.start ? `${day(s)} to ${day(e)}, all day` : `${day(s)}, all day`;
  return `${day(s)} ${ev.time} to ${e.toISODate() === s.toISODate() ? '' : `${day(e)} `}${ev.endTime}`;
}

// The model says duration_min; the calendar's own field is duration.
const eventPatch = (input, keys) => {
  const patch = pick(input, keys);
  if (input.duration_min !== undefined) patch.duration = input.duration_min;
  return patch;
};

async function ownEvent(id) {
  try {
    return await getOathEvent(id);
  } catch (err) {
    if (!(err instanceof RuleError)) throw err;
    throw new RuleError('No event of his own with that id. Use find_events to look it up; events from his other calendars cannot be changed.');
  }
}

async function overlapNote(ev) {
  const clashes = await eventClashes(ev);
  return clashes.length ? ` It overlaps ${clashes.slice(0, 3).map((x) => `"${x.title}" (${x.time} to ${x.endTime})`).join(', ')}: mention it in a few words.` : '';
}

async function findEvents({ query = '', from, to }) {
  const { today } = await engine.localNow();
  const start = from || today;
  const end = to || addDays(start, 13, 'utc');
  if (!validDate(start) || !validDate(end) || end < start) throw new RuleError('Give a from and to date like 2026-10-28.');
  if (addDays(start, 61, 'utc') < end) throw new RuleError('Ask for at most 62 days at a time.');
  const q = String(query).trim().toLowerCase();
  const events = (await eventsBetween(start, end)).filter((e) => !q || `${e.title} ${e.location}`.toLowerCase().includes(q));
  const lines = events.slice(0, 40).map((e) => {
    const where = e.location ? `, ${e.location}` : '';
    if (e.own) return `event #${e.ownId} "${e.title}", ${whenText(e)}${where} (his own, can be changed)`;
    return `"${e.deadline ? cleanDeadlineTitle(e.title) : e.title}", ${whenText(e)}${where} (${e.feed}${e.deadline ? ', VLE deadline' : ''}, read-only)`;
  });
  if (events.length > 40) lines.push(`and ${events.length - 40} more: narrow the dates.`);
  return lines.length ? lines.join('\n') : 'Nothing on his calendar in that time.';
}

// ---------- The tools ----------
// run returns the receipt shown under the coach's reply (or several, see receiptsOf). confirm, when
// present, returns the line Daniel confirms; the tool then waits instead of acting.

const TOOLS = {
  find_items: {
    description: 'Look up tasks, habits, goals, goal steps and recent misses with their ids. Use it whenever you need an id you do not have, then act on the clear best match instead of asking which one he meant. Ask only if two matches are genuinely different things.',
    properties: { query: S('Words from the title; empty lists everything'), kind: E(['all', 'task', 'habit', 'goal', 'step', 'miss']), include_closed: B('Include done tasks, archived habits and closed goals') },
    read: true,
    run: findItems,
  },

  add_task: {
    description: 'Add a task. hard=true makes it cost HP if not done by the deadline; a hard task needs a due_date and a first_step (the very first physical action; if he gave none, write the obvious one yourself and say so).',
    properties: { title: S(), due_date: DATE, deadline: TIME, hard: B(), first_step: S(), estimate_min: I('Estimated minutes'), goal_id: I(), goal: S('Goal title, if no goal_id'), notes: S() },
    required: ['title'],
    async run(input) {
      const g = await goalFrom(input);
      const t = await engine.createTask({ ...input, goal_id: g?.id }, v, 'coach');
      return `Added task "${t.title}"${dueText(t)}${t.hard ? ', hard' : ''}${g ? `, under ${g.title}` : ''}`;
    },
  },
  edit_task: {
    description: 'Change a task: title, date, time, hard or not, first step, estimate, notes or goal. Send only what changes; an empty string clears a date or time. Hard tasks are locked once due.',
    properties: { task_id: I(), title: S(), due_date: S('YYYY-MM-DD, or empty to clear'), deadline: S('HH:MM, or empty to clear'), hard: B(), first_step: S(), estimate_min: I(), notes: S(), goal_id: I() },
    required: ['task_id'],
    async run(input) {
      await taskRow(input.task_id);
      await engine.updateTask(Number(input.task_id), pick(input, ['title', 'due_date', 'deadline', 'hard', 'first_step', 'estimate_min', 'notes', 'goal_id']), v, 'coach');
      const t = await taskRow(input.task_id);
      return `Updated task "${t.title}"${dueText(t)}`;
    },
  },
  complete_task: {
    description: 'Mark a task done. Only when Daniel says he did it.',
    properties: { task_id: I() },
    required: ['task_id'],
    async run({ task_id: id }) {
      const t = await taskRow(id);
      await engine.completeTask(Number(id));
      await (await drive()).closeFocusFor('task', Number(id));
      return `Done: "${t.title}"`;
    },
  },
  undo_task: {
    description: 'Undo a task marked done by mistake.',
    properties: { task_id: I() },
    required: ['task_id'],
    async run({ task_id: id }) {
      const t = await taskRow(id);
      await engine.undoTask(Number(id));
      return `Reopened "${t.title}"`;
    },
  },
  triage_task: {
    description: 'Decide a backlog task in one step: do it today, tomorrow, next week, or someday (no date). Not for hard tasks.',
    properties: { task_id: I(), action: E(['today', 'tomorrow', 'week', 'someday']) },
    required: ['task_id', 'action'],
    async run({ task_id: id, action }) {
      const t = await taskRow(id);
      const r = await engine.triageTask(Number(id), action);
      return `Moved "${t.title}" to ${r.due || 'someday'}`;
    },
  },
  delete_task: {
    description: 'Delete a task. Needs Daniel\'s confirmation in the app.',
    properties: { task_id: I() },
    required: ['task_id'],
    async confirm({ task_id: id }) { return `Delete task "${(await taskRow(id)).title}"`; },
    async run({ task_id: id }) {
      const t = await taskRow(id);
      await engine.deleteTask(Number(id));
      return `Deleted task "${t.title}"`;
    },
  },

  add_habit: {
    description: 'Create a habit: fixed days with a deadline, or weekly_target for X times a week. Anchor it to an existing routine with cue.',
    properties: { name: S(), deadline: TIME, days: DAYS, weekly_target: I('1 to 7 for X times a week'), cue: S('The routine it follows, e.g. "after I pour coffee"'), minimum: S('Smallest version that still counts'), if_then: S(), non_negotiable: B(), penalty: I('HP lost on a miss, 1 to 100'), remind_at: TIME, notes: S(), goal_id: I(), goal: S() },
    required: ['name'],
    async run(input) {
      const g = await goalFrom(input);
      const { habit, startsToday } = await engine.createHabit({ ...input, goal_id: g?.id }, v);
      return `Created habit "${habit.name}", ${habit.weekly_target ? `${habit.weekly_target} times a week` : `due ${deadlineText(habit.deadline)}`}, from ${startsToday ? 'today' : 'tomorrow'}`;
    },
  },
  edit_habit: {
    description: 'Change a habit. Name, cue, if-then, reminder, notes and goal change now; days, deadline, penalty, non-negotiable, weekly target and minimum start tomorrow if it is still open today.',
    properties: { habit_id: I(), name: S(), cue: S(), if_then: S(), minimum: S(), deadline: TIME, days: DAYS, weekly_target: I('0 to switch to fixed days'), non_negotiable: B(), penalty: I(), remind_at: S('HH:MM or empty'), notes: S(), goal_id: I() },
    required: ['habit_id'],
    async run(input) {
      const h = await habitRow(input.habit_id);
      const r = await engine.updateHabit(Number(input.habit_id), pick(input, ['name', 'cue', 'if_then', 'minimum', 'deadline', 'days', 'weekly_target', 'non_negotiable', 'penalty', 'remind_at', 'notes', 'goal_id']), v);
      return `Updated habit "${input.name || h.name}"${r.effective !== 'now' ? `, new rules from ${r.effective}` : ''}`;
    },
  },
  keep_habit: {
    description: 'Tick a habit off for today, as done or as its minimum version. Only when Daniel says he did it.',
    properties: { habit_id: I(), minimum: B('He did the minimum version') },
    required: ['habit_id'],
    async run({ habit_id: id, minimum }) {
      const h = await habitRow(id);
      const r = await engine.completeHabit(Number(id), { minimum: Boolean(minimum) });
      await (await drive()).closeFocusFor('habit', Number(id));
      return r.already ? `"${h.name}" was already kept` : `Kept "${h.name}"${minimum ? ' (minimum)' : ''}${r.comeback ? `, comeback +${r.comeback} HP` : ''}`;
    },
  },
  undo_habit: {
    description: 'Undo a habit ticked by mistake, within the undo window and before its deadline.',
    properties: { habit_id: I() },
    required: ['habit_id'],
    async run({ habit_id: id }) {
      const h = await habitRow(id);
      await engine.undoHabit(Number(id));
      return `Unticked "${h.name}"`;
    },
  },
  archive_habit: {
    description: 'Archive (stop) a habit. Needs Daniel\'s confirmation in the app.',
    properties: { habit_id: I() },
    required: ['habit_id'],
    async confirm({ habit_id: id }) { return `Archive habit "${(await habitRow(id)).name}"`; },
    async run({ habit_id: id }) {
      const h = await habitRow(id);
      const r = await engine.archiveHabit(Number(id));
      return `Archived "${h.name}" from ${r.from}`;
    },
  },
  link_habit_to_health: {
    description: 'Let Apple Health tick a habit off when a target is reached. metric empty or "off" unlinks it.',
    properties: { habit_id: I(), metric: E(['off', 'steps', 'exercise_min', 'active_kcal', 'stand_hours', 'sleep_hours', 'distance_km', 'mindful_min', 'flights', 'workout', 'water_ml']), target: N(), filter: S('For workout: a word the workout type must contain') },
    required: ['habit_id', 'metric'],
    async run({ habit_id: id, metric, target, filter }) {
      const h = await habitRow(id);
      const off = !metric || metric === 'off';
      const r = await (await health()).setHabitAuto(Number(id), { metric: off ? null : metric, target, filter: filter || '' });
      return off ? `"${h.name}" is ticked by hand again` : `"${h.name}" now ticks itself at ${target ?? ''} ${metric}${r.keptNow ? ', and it is already done today' : ''}`;
    },
  },

  take_oath: {
    description: 'Take today\'s oath for him: his one thing (an open habit or task due today) and when and where he will do it.',
    properties: { focus_kind: E(['habit', 'task']), focus_id: I(), intention: S('When and where. Use his words; if he gave no time or place, pick the likely one from the item (its deadline or cue) and say so') },
    required: ['focus_kind', 'focus_id', 'intention'],
    async run({ focus_kind: kind, focus_id: id, intention }) {
      await (await drive()).commitDay({ focusKind: kind, focusId: Number(id), intention });
      return `Oath taken: ${intention}`;
    },
  },
  start_focus: {
    description: 'Start a focus block on an open item.',
    properties: { kind: E(['habit', 'task']), id: I(), minutes: I('5 to 180, usually 25') },
    required: ['kind', 'id'],
    async run({ kind, id, minutes }) {
      const s = await (await drive()).startFocus({ kind, id: Number(id), minutes: minutes || 25 });
      return `Focus started: ${s.title}, ${s.minutes} min`;
    },
  },
  stop_focus: {
    description: 'End the running focus block: done (he finished the thing) or stopped.',
    properties: { outcome: E(['done', 'stopped']) },
    required: ['outcome'],
    async run({ outcome }) {
      const [s] = await db()`select id, title from focus_sessions where ended_at is null order by id desc limit 1`;
      if (!s) throw new RuleError('No focus block is running.');
      await (await drive()).finishFocus(s.id, outcome);
      return `Focus ${outcome === 'done' ? 'finished' : 'stopped'}: ${s.title}`;
    },
  },
  log_dodge: {
    description: 'Log a "Not now" with his reason. move_to_tomorrow only for normal tasks.',
    properties: { kind: E(['habit', 'task']), id: I(), reason: S(), move_to_tomorrow: B() },
    required: ['kind', 'id', 'reason'],
    async run({ kind, id, reason, move_to_tomorrow: move }) {
      const r = await (await drive()).defer({ kind, id: Number(id), reason, moveToTomorrow: Boolean(move) });
      return r.reaction.text;
    },
  },
  close_day: {
    description: 'Close the day with his rating (1 to 5), what got in the way, one win and tomorrow\'s one thing.',
    properties: { rating: I('1 to 5. If he describes the day without a number, pick the one that fits and say so'), blocker: S(), win: S(), tomorrow: S('Tomorrow\'s one thing, when and where') },
    required: ['rating'],
    async run(input) {
      await (await drive()).reflect(input);
      return `Day closed, ${input.rating} out of 5`;
    },
  },
  pardon_miss: {
    description: 'Pardon a miss from the last 24 hours. Needs what got in the way and his if-then plan, both in his own words, at least 10 characters each.',
    properties: { miss_id: I(), reason: S(), plan: S('If that happens again, I will ...') },
    required: ['miss_id', 'reason', 'plan'],
    async run({ miss_id: id, reason, plan }) {
      const m = await one(db()`select title from misses where id = ${Number(id)}`, 'miss');
      const r = await engine.pardon(Number(id), { reason, plan });
      return `Pardoned "${m.title}"${r.hpRestored ? `, +${r.hpRestored} HP` : ''}. ${r.pardonsLeft} left this month`;
    },
  },
  book_rest_day: {
    description: 'Book a rest day in advance (not today).',
    properties: { date: DATE, reason: S() },
    required: ['date'],
    async run({ date, reason }) {
      await engine.bookRest(date, reason || '');
      return `Rest day booked: ${date}`;
    },
  },
  cancel_rest_day: {
    description: 'Cancel a booked rest day that has not started.',
    properties: { date: DATE },
    required: ['date'],
    async run({ date }) {
      await engine.cancelRest(date);
      return `Rest day cancelled: ${date}`;
    },
  },

  add_goal: {
    description: 'Create a goal, WOOP style. measure "number" needs start_value and target_value (with a unit); "steps" is measured by finished steps.',
    properties: { title: S(), measure: E(['steps', 'number']), unit: S(), start_value: N(), target_value: N(), target_date: DATE, why: S(), obstacle: S(), plan: S() },
    required: ['title'],
    async run(input) {
      const { id } = await goals.createGoal(input);
      return `Created goal #${id} "${input.title}"`;
    },
  },
  edit_goal: {
    description: 'Change a goal\'s title, measure, numbers, date or WOOP text. Send only what changes.',
    properties: { goal_id: I(), title: S(), measure: E(['steps', 'number']), unit: S(), start_value: N(), target_value: N(), target_date: DATE, why: S(), obstacle: S(), plan: S() },
    required: ['goal_id'],
    async run(input) {
      const g = await goalRow(input.goal_id);
      await goals.updateGoal(Number(input.goal_id), pick(input, ['title', 'measure', 'unit', 'start_value', 'target_value', 'target_date', 'why', 'obstacle', 'plan']));
      return `Updated goal "${input.title || g.title}"`;
    },
  },
  log_goal_progress: {
    description: 'Log progress on a number goal: "42" sets the current value, "+3" adds to it.',
    properties: { goal_id: I(), value: S() },
    required: ['goal_id', 'value'],
    async run({ goal_id: id, value }) {
      const g = await goalRow(id);
      const r = await goals.logGoal(Number(id), value);
      return `"${g.title}" is now at ${r.value}${g.unit ? ` ${g.unit}` : ''}`;
    },
  },
  set_goal_status: {
    description: 'Mark a goal achieved, reopen it, or drop it. Dropping needs Daniel\'s confirmation in the app.',
    properties: { goal_id: I(), status: E(['done', 'active', 'dropped']) },
    required: ['goal_id', 'status'],
    async confirm({ goal_id: id, status }) { return status === 'dropped' ? `Drop goal "${(await goalRow(id)).title}"` : null; },
    async run({ goal_id: id, status }) {
      const g = await goalRow(id);
      await goals.setGoalStatus(Number(id), status);
      return `${status === 'done' ? 'Achieved' : status === 'dropped' ? 'Dropped' : 'Reopened'}: "${g.title}"`;
    },
  },
  add_goal_step: {
    description: 'Add a step (a branch in the goal\'s map), at the top level or under another step.',
    properties: { goal_id: I(), goal: S('Goal title, if no goal_id'), text: S(), parent_step_id: I() },
    required: ['text'],
    async run(input) {
      const g = await goalFrom(input);
      if (!g) throw new RuleError('Say which goal.');
      await goals.addNode(g.id, { text: input.text, parentId: input.parent_step_id || null });
      return `Added step "${input.text}" to ${g.title}`;
    },
  },
  edit_goal_step: {
    description: 'Rename a goal step.',
    properties: { step_id: I(), text: S() },
    required: ['step_id', 'text'],
    async run({ step_id: id, text }) {
      await nodeRow(id);
      await goals.updateNode(Number(id), { text });
      return `Renamed step to "${text}"`;
    },
  },
  move_goal_step: {
    description: 'Move a goal step up or down among its siblings, or in or out a level.',
    properties: { step_id: I(), op: E(['up', 'down', 'indent', 'outdent']) },
    required: ['step_id', 'op'],
    async run({ step_id: id, op }) {
      const n = await nodeRow(id);
      await goals.moveNode(Number(id), op);
      return `Moved "${n.text}" ${{ up: 'up', down: 'down', indent: 'in a level', outdent: 'out a level' }[op]}`;
    },
  },
  convert_goal_step: {
    description: 'Turn a goal step into a task (optional due_date, deadline, estimate_min) or a habit (optional cue, days, weekly_target, deadline, non_negotiable).',
    properties: { step_id: I(), to: E(['task', 'habit']), due_date: DATE, deadline: TIME, estimate_min: I(), cue: S(), days: DAYS, weekly_target: I(), non_negotiable: B() },
    required: ['step_id', 'to'],
    async run(input) {
      const n = await nodeRow(input.step_id);
      const opts = input.to === 'task'
        ? pick(input, ['due_date', 'deadline', 'estimate_min'])
        : pick(input, ['cue', 'days', 'weekly_target', 'deadline', 'non_negotiable']);
      await goals.convertNode(Number(input.step_id), input.to, opts);
      return `"${n.text}" is now a ${input.to}`;
    },
  },
  toggle_goal_step: {
    description: 'Tick or untick a goal step that is a task.',
    properties: { step_id: I() },
    required: ['step_id'],
    async run({ step_id: id }) {
      const n = await nodeRow(id);
      await goals.toggleNodeTask(Number(id));
      return `Toggled "${n.text}"`;
    },
  },
  delete_goal_step: {
    description: 'Delete a goal step; steps under it move up a level. Needs Daniel\'s confirmation in the app.',
    properties: { step_id: I() },
    required: ['step_id'],
    async confirm({ step_id: id }) { const n = await nodeRow(id); return `Delete step "${n.text}" from ${n.goal_title}`; },
    async run({ step_id: id }) {
      const n = await nodeRow(id);
      await goals.deleteNode(Number(id));
      return `Deleted step "${n.text}"`;
    },
  },

  update_schedule: {
    description: 'Change when briefs arrive, when his day ends, his time zone or where alerts go (smart: one channel per alert; both: everywhere; push: app only).',
    properties: { morningTime: TIME, middayTime: TIME, eveningTime: TIME, dayEnd: TIME, timezone: S('IANA zone, e.g. Europe/Malta'), alerts: E(['smart', 'both', 'push']) },
    async run(input) {
      const patch = pick(input, ['morningTime', 'middayTime', 'eveningTime', 'dayEnd', 'timezone', 'alerts']);
      if (!Object.keys(patch).length) throw new RuleError('Say what to change.');
      await (await settings()).applySettings(patch);
      return `Settings saved: ${Object.entries(patch).map(([k, x]) => `${k} ${x}`).join(', ')}`;
    },
  },
  change_game_rules: {
    description: 'Change the game\'s rules: maxHp, dailyLossCap, taskPenalty, cleanBonus, comebackBonus, repeatMultiplier, pardonsPerMonth, restDaysPerMonth, maxNonNegotiables, undoMinutes. Needs Daniel\'s confirmation in the app.',
    properties: { maxHp: I(), dailyLossCap: I(), taskPenalty: I(), cleanBonus: I(), comebackBonus: I(), repeatMultiplier: N(), pardonsPerMonth: I(), restDaysPerMonth: I(), maxNonNegotiables: I(), undoMinutes: I() },
    async confirm(input) {
      const { cleanPatch, RULES } = await settings();
      const patch = cleanPatch(input);
      if (!Object.keys(patch).length) throw new RuleError('Say which rule to change.');
      return `Change rules: ${Object.entries(patch).map(([k, x]) => `${RULES[k].name} to ${x}`).join(', ')}`;
    },
    async run(input) {
      const { applySettings, RULES, cleanPatch } = await settings();
      const patch = cleanPatch(input);
      await applySettings(patch);
      return `Rules changed: ${Object.entries(patch).map(([k, x]) => `${RULES[k].name} ${x}`).join(', ')}`;
    },
  },
  set_health_targets: {
    description: 'Set his daily Apple Health targets.',
    properties: { steps: I(), exercise_min: I(), active_kcal: I(), sleep_hours: N(), stand_hours: I() },
    async run(input) {
      const patch = pick(input, ['steps', 'exercise_min', 'active_kcal', 'sleep_hours', 'stand_hours']);
      if (!Object.keys(patch).length) throw new RuleError('Say which target to change.');
      await (await health()).setHealthGoals(patch);
      return `Targets saved: ${Object.entries(patch).map(([k, x]) => `${k} ${x}`).join(', ')}`;
    },
  },
  finish_weekly_review: {
    description: 'Finish last week\'s review: his focus for this week, an if-then plan for the biggest obstacle, and keep/adjust/drop per habit id. Dropping habits needs Daniel\'s confirmation in the app.',
    properties: {
      focus: S('One or two things that matter most this week'), obstacle_plan: S(),
      decisions: { type: 'object', description: 'Habit id to "keep", "adjust" or "drop"', additionalProperties: E(['keep', 'adjust', 'drop']) },
    },
    required: ['focus'],
    async confirm({ decisions = {} }) {
      const drops = Object.entries(decisions).filter(([, d]) => d === 'drop').map(([id]) => Number(id));
      if (!drops.length) return null;
      const names = (await db()`select name from habits where id in ${db()(drops)}`).map((h) => h.name);
      return `Finish the review and archive ${names.join(', ') || 'the dropped habits'}`;
    },
    async run({ focus, obstacle_plan: plan, decisions = {} }) {
      await (await review()).finishReview({ focus, obstaclePlan: plan || '', decisions });
      return `Weekly review done. Focus: ${focus}`;
    },
  },

  // ---------- Food: logging only, never targets, never HP ----------
  search_food: {
    read: true,
    description: 'Find foods, drinks, saved meals and recipes in Oath\'s catalogue, for when he names an exact product, a saved meal or a recipe, or asks what is there. For loose descriptions ("a kebab and chips") skip this and use log_food_estimate. Returns keys, names, state (raw, cooked, dry, drained) and the units each accepts. Pick the record whose state matches what he ate (cooked rice, not dry, if he ate it cooked).',
    properties: { query: S('A few words, e.g. "banana", "monster zero", "white rice"'), drinks: B('Only drinks') },
    required: ['query'],
    async run({ query, drinks = false }) {
      const f = await food();
      const items = await f.searchFoods(query, { limit: 10, liquid: drinks ? true : null });
      const meals = (await f.listMeals()).filter((m) => m.name.toLowerCase().includes(String(query).toLowerCase())).slice(0, 5);
      const recipes = await f.listRecipes({ q: query, limit: 5 });
      const out = items.map((i) => `food ${i.key} | ${i.name}${i.brand ? ` (${i.brand}${i.market ? `, ${i.market}` : ''})` : ''} | ${i.state || ''} | ${i.kind} | ${i.nutrients.kcal ?? '?'} kcal per 100 ${i.basis} | units: ${i.units.map((u) => u.unit).join(', ')}`);
      for (const m of meals) out.push(`saved meal #${m.id} "${m.name}" (${m.kind})`);
      for (const r of recipes) out.push(`recipe ${r.key} "${r.name}" | serves ${r.servings}`);
      return out.length ? out.join('\n') : 'Nothing found. Log it anyway with log_food_estimate and your own calorie estimate, and mention that a photo of the label in the Food tab makes it exact next time.';
    },
  },
  log_food: {
    description: 'Log an exact amount of one catalogue food or drink he names, with a key from search_food. unit is "g", "ml", "serving", "pack", "each" (one of a multipack), "whole" (weighed with peel), or "p:<portion label>" exactly as search_food lists it. Only log what he says he ate or drank. For loose descriptions use log_food_estimate instead.',
    properties: {
      key: S('From search_food'), qty: N('How many of the unit'), unit: S(), slot: E(MEAL_SLOTS),
      date: DATE, time: TIME,
    },
    required: ['key', 'qty', 'unit'],
    async run(input) {
      const { entry } = await (await food()).logFood(input, 'coach');
      return `Logged ${entry.name}, ${entry.amountText} (${entry.nutrients.kcal === null ? 'energy unknown' : `${Math.round(entry.nutrients.kcal)} kcal`})`;
    },
  },
  log_food_estimate: {
    description: 'Log food and drink he describes loosely ("large fries from Burger King", "a medium bunch of grapes", "had a kebab and chips", "a big bowl of pasta"). Prefer this over search_food + log_food whenever he does not give an exact product and amount; keep log_food for exact items he names with amounts. Never ask him for grams: use the real portion for what he said (that restaurant\'s large, a typical medium) and say what you assumed in a few words. One item per food or drink; list sides, sauces and drinks separately. Be as specific as he was: put the brand or restaurant, the variety, how it was cooked and his size words in their own fields, because each item is matched to the most specific catalogue record (the restaurant\'s own item and the portion his size word names, before anything generic) and logged as an estimate he can edit in the Food tab. Give kcal_estimate and per100 on every item, with every value in per100 including the vitamins and minerals: per100 fills the values a record lacks (sugars, fibre, salt, and the vitamins and minerals when no similar USDA food or published values have them), and anything the catalogue lacks is logged as a quick add of your estimate instead of being dropped. Leave slot, date and time out to use now, or set them from what he said.',
    properties: {
      items: {
        type: 'array',
        description: 'What he ate or drank, one entry per food or drink',
        items: {
          type: 'object',
          properties: {
            name: S('Plain UK English without size words, e.g. "fries", "red grapes", "chicken kebab", "Coca-Cola"'),
            brand: S('The brand or restaurant when he names one, e.g. "Burger King", "Kinnie"; leave it out otherwise'),
            variety: S('The kind, e.g. "red", "wholemeal", "zero sugar"; leave it out if he did not say'),
            preparation: S('How it was cooked or served, e.g. "deep fried", "grilled", "raw"'),
            size: S('His size words as he said them, e.g. "large", "medium", "a bowl of"'),
            search: S('2 to 4 words that would find it in a mostly American (USDA) food database, without size words, the brand first when there is one, e.g. "burger king french fries", "red grapes", "chicken kebab", "cola"'),
            searches: { type: 'array', items: S(), description: 'Up to 2 more search phrases, ending with a plain generic one, e.g. ["french fries", "potato french fries"]' },
            amount: N('The amount, in the unit: his own, or the real portion for that size and place'),
            unit: E(ESTIMATE_UNITS, 'g for food, ml for drinks, piece for whole countable things (a slice, an egg, a banana)'),
            weight: N('The same amount in grams (ml for drinks), so pieces are weighed too'),
            kcal_estimate: N('Your best calorie estimate for the whole amount'),
            per100: {
              type: 'object',
              description: `Your estimate per 100 g (per 100 ml for drinks) of this exact food, every value: kcal; protein, carbs, sugars, fat, satfat, fibre and salt in g; caffeine in mg; alcohol in g; and from typical composition data ${MICRO_TEXT}. 0 only when it truly has none.`,
              properties: Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, N()])),
            },
          },
          required: ['name', 'search', 'amount', 'unit'],
        },
      },
      slot: E(MEAL_SLOTS), date: DATE, time: TIME,
    },
    required: ['items'],
    run: logFoodEstimate,
  },
  quick_add_food: {
    description: 'Log calories (and any macros he gives) without a catalogue record, when he only knows the numbers. Kept in the diary only.',
    properties: {
      name: S(), kcal: N(), protein: N('g'), carbs: N('g'), sugars: N('g'), fat: N('g'), caffeine: N('mg'),
      slot: E(['breakfast', 'lunch', 'dinner', 'snacks', 'drinks']), date: DATE, time: TIME,
    },
    required: ['name', 'kcal'],
    async run(input) {
      const { entry } = await (await food()).quickAdd(input, 'coach');
      return `Quick add: ${entry.name}, ${Math.round(entry.nutrients.kcal)} kcal`;
    },
  },
  log_saved_meal: {
    description: 'Log one of his saved meals (shake, fruit bowl, plate) by its id from search_food. share 0.5 logs half of it.',
    properties: { meal_id: I(), share: N('1 = all of it'), slot: E(['breakfast', 'lunch', 'dinner', 'snacks', 'drinks']), date: DATE, time: TIME },
    required: ['meal_id'],
    async run({ meal_id: id, share = 1, ...rest }) {
      const { entry } = await (await food()).logMeal({ meal_id: id, factor: share, ...rest }, 'coach');
      return `Logged ${entry.name}${share !== 1 ? ` (${share} of it)` : ''}, ${Math.round(entry.nutrients.kcal ?? 0)} kcal`;
    },
  },
  log_recipe: {
    description: 'Log servings of a recipe by its key from search_food (or grams, if the recipe has a finished weight).',
    properties: { key: S(), qty: N('Servings, or grams with unit g'), unit: E(['serving', 'g']), slot: E(['breakfast', 'lunch', 'dinner', 'snacks', 'drinks']), date: DATE, time: TIME },
    required: ['key'],
    async run({ qty = 1, unit = 'serving', ...rest }) {
      const { entry } = await (await food()).logRecipe({ qty, unit, ...rest }, 'coach');
      return `Logged ${entry.name}, ${entry.amountText} (${Math.round(entry.nutrients.kcal ?? 0)} kcal)`;
    },
  },
  remove_food_entry: {
    description: 'Remove a diary entry by its id (shown in the food section of the data). Needs Daniel\'s confirmation in the app.',
    properties: { entry_id: S() },
    required: ['entry_id'],
    async confirm({ entry_id: id }) {
      const [e] = await db()`select name, amount_text, date from food_log where id = ${String(id)} and deleted_at is null`;
      if (!e) throw new RuleError('No diary entry with that id.');
      return `Remove ${e.name}${e.amount_text ? ` (${e.amount_text})` : ''} from ${e.date}`;
    },
    async run({ entry_id: id }) {
      const r = await (await food()).deleteEntry(String(id));
      return `Removed ${r.entry?.name || 'the entry'} from the diary`;
    },
  },
  food_day: {
    read: true,
    description: 'What he logged on a day, with totals. Totals marked "+" are missing some values; never present them as complete.',
    properties: { date: DATE },
    async run({ date }) {
      return (await food()).foodForCoach(date);
    },
  },

  // ---------- Calendar: his own events join the calendar page, Today and his busy time ----------
  find_events: {
    read: true,
    description: 'Look up what is on his calendar between two dates (default: the next two weeks), with ids for the events he made in Oath. Use it for an id you do not have, or to answer what is on a day. Events from his other calendars are listed too but cannot be changed.',
    properties: { query: S('Words from the title or place; empty lists everything'), from: DATE, to: DATE },
    run: findEvents,
  },
  add_event: {
    description: 'Add an event to his Oath calendar. It shows on the calendar page and Today, counts as busy time, and appears in Apple Calendar if he subscribed. Work out the date and 24-hour start from what he said ("gym at 6 tomorrow" is tomorrow 18:00); with no end or duration it lasts an hour. Leave start out for an all-day event (end_date for a span of days). Say what you assumed in a few words.',
    properties: { title: S(), date: DATE, start: TIME, end: TIME, duration_min: I('Minutes, when no end'), all_day: B(), end_date: S('Last day of an all-day span, YYYY-MM-DD'), location: S(), notes: S() },
    required: ['title'],
    async run(input) {
      const ev = await createOathEvent(eventPatch(input, ['title', 'date', 'start', 'end', 'all_day', 'end_date', 'location', 'notes']), 'coach');
      return { receipts: [{ ok: true, text: `Added "${ev.title}" to your calendar, ${whenText(ev)}` }], detail: `Event #${ev.ownId}.${await overlapNote(ev)}` };
    },
  },
  edit_event: {
    description: 'Change an event he made in Oath: title, day, time, length, all-day, place or notes. Send only what changes. Moving the start keeps the length; moving the day keeps the times. Events from his other calendars cannot be changed.',
    properties: { event_id: I('From find_events or the calendar in the current data'), title: S(), date: DATE, start: TIME, end: TIME, duration_min: I('Minutes, when no end'), all_day: B(), end_date: S('Last day of an all-day span, YYYY-MM-DD'), location: S('Empty clears it'), notes: S('Empty clears it') },
    required: ['event_id'],
    async run(input) {
      await ownEvent(input.event_id);
      const ev = await updateOathEvent(input.event_id, eventPatch(input, ['title', 'date', 'start', 'end', 'all_day', 'end_date', 'location', 'notes']));
      return { receipts: [{ ok: true, text: `Updated "${ev.title}", ${whenText(ev)}` }], detail: await overlapNote(ev).then((n) => n.trim()) };
    },
  },
  delete_event: {
    description: 'Delete an event he made in Oath. Needs Daniel\'s confirmation in the app. Events from his other calendars cannot be deleted.',
    properties: { event_id: I() },
    required: ['event_id'],
    async confirm({ event_id: id }) {
      const ev = await ownEvent(id);
      return `Delete "${ev.title}" (${whenText(ev)}) from your calendar`;
    },
    async run({ event_id: id }) {
      const ev = await ownEvent(id);
      await deleteOathEvent(id);
      return `Deleted "${ev.title}" from your calendar, ${whenText(ev)}`;
    },
  },
};

export const TOOL_DEFS = Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  input_schema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) },
}));

// A tool's run returns one receipt line, or { receipts: [{ ok, text }], detail } when it does one
// thing per item. detail goes back to the model only, never under the reply.
const receiptsOf = (out) => (Array.isArray(out?.receipts) ? out.receipts : [{ ok: true, text: String(out) }]);

// Runs one tool call. ctx collects receipts and pending confirmations for the reply.
// Returns { content, isError } for the tool_result; it is an error only when nothing worked.
export async function runTool(name, input, ctx = { actions: [], pending: [] }) {
  const t = TOOLS[name];
  if (!t) return { content: `Unknown tool ${name}.`, isError: true };
  try {
    if (t.confirm) {
      const summary = await t.confirm(input);
      if (summary) {
        const [p] = await db()`insert into coach_pending (tool, input, summary) values (${name}, ${db().json(input)}, ${summary}) returning id`;
        ctx.pending.push({ id: p.id, summary });
        return { content: `Not done yet. It waits for Daniel to tap Confirm under your reply: "${summary}". Tell him what it will do; do not say it is done.`, isError: false };
      }
    }
    const out = await t.run(input);
    const receipts = receiptsOf(out);
    if (!t.read) {
      for (const r of receipts) {
        ctx.actions.push(r);
        if (r.ok) await logEvent('coach_action', { tool: name, text: r.text });
      }
    }
    if (!out?.receipts) return { content: String(out), isError: false };
    const content = [...receipts.map((r) => (r.ok ? r.text : `Failed: ${r.text}`)), out.detail].filter(Boolean).join('\n');
    return { content, isError: !receipts.some((r) => r.ok) };
  } catch (err) {
    const why = err instanceof RuleError ? err.message : 'unexpected error';
    if (!(err instanceof RuleError)) console.error('coach tool failed', name, err);
    if (!t.read) ctx.actions.push({ ok: false, text: `${name.replace(/_/g, ' ')}: ${why}` });
    return { content: `Failed: ${why}`, isError: true };
  }
}

// Daniel's answer to a waiting action: run it (once) or cancel it.
export async function resolvePendingAction(id, confirm) {
  const [p] = await db()`select * from coach_pending where id = ${Number(id)}`;
  if (!p) throw new RuleError('That request does not exist.', 404);
  if (p.status !== 'open') throw new RuleError(`Already ${p.status}.`, 409);
  const ageMin = (Date.now() - new Date(p.created_at).getTime()) / 60000;
  if (ageMin > PENDING_MINUTES) {
    await db()`update coach_pending set status = 'expired', resolved_at = now() where id = ${p.id}`;
    throw new RuleError('That request expired. Ask the coach again.', 409);
  }
  // Claim it first, so a double tap cannot run it twice.
  const claimed = await db()`update coach_pending set status = 'running' where id = ${p.id} and status = 'open' returning id`;
  if (!claimed.length) throw new RuleError('Already handled.', 409);
  if (!confirm) {
    await db()`update coach_pending set status = 'cancelled', resolved_at = now(), outcome = 'Cancelled' where id = ${p.id}`;
    return { status: 'cancelled', text: `Cancelled: ${p.summary}.` };
  }
  try {
    const text = receiptsOf(await TOOLS[p.tool].run(p.input)).map((r) => r.text).join('; ');
    await db()`update coach_pending set status = 'done', resolved_at = now(), outcome = ${text} where id = ${p.id}`;
    await logEvent('coach_action', { tool: p.tool, text, confirmed: true });
    return { status: 'done', text };
  } catch (err) {
    const why = err instanceof RuleError ? err.message : 'That did not work.';
    if (!(err instanceof RuleError)) console.error('coach confirmed action failed', p.tool, err);
    await db()`update coach_pending set status = 'failed', resolved_at = now(), outcome = ${why} where id = ${p.id}`;
    return { status: 'failed', text: why };
  }
}
