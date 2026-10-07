// The accountability engine: HP, misses, deaths, pardons, rules changes and the tick loop.
import { db, getKV, setKV, logEvent } from './db.js';
import { nowUTC, isoDate, addDays, weekday, deadlineAt } from './time.js';

// Every timestamp comes from the app clock, never the database clock.
const ts = () => nowUTC().toJSDate();

export const DEFAULT_SETTINGS = {
  timezone: 'Europe/Malta',
  morningTime: '07:00',
  middayTime: '13:00',
  eveningTime: '21:00',
  cleanBonus: 5,
  taskPenalty: 15,
  pardonsPerMonth: 2,
  undoMinutes: 10,
  maxHp: 100,
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await getKV('settings', {})) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await setKV('settings', next);
  return next;
}

export async function localNow() {
  const s = await getSettings();
  const local = nowUTC().setZone(s.timezone);
  return { s, local, today: isoDate(local), tz: s.timezone };
}

export async function ensureGame() {
  const existing = await getKV('game');
  if (existing) return existing;
  const { s, local, today, tz } = await localNow();
  const game = {
    hp: s.maxHp,
    season: 1,
    seasonStart: today,
    deaths: 0,
    pardonsLeft: s.pardonsPerMonth,
    pardonMonth: local.toFormat('yyyy-MM'),
    lastFinalized: addDays(today, -1, tz),
  };
  await db()`insert into kv (key, value) values ('game', ${db().json(game)}) on conflict (key) do nothing`;
  return (await getKV('game')) || game;
}

export async function getGame() {
  return ensureGame();
}

// Run fn inside a transaction holding a lock on the game state. fn may mutate `game`.
export async function withGame(fn) {
  await ensureGame();
  return db().begin(async (tx) => {
    const [row] = await tx`select value from kv where key = 'game' for update`;
    const game = row.value;
    const result = await fn(tx, game);
    await setKV('game', game, tx);
    return result;
  });
}

// ---------- Rules ----------

export function rulesOn(habit, date) {
  const base = {
    days: habit.days,
    deadline: habit.deadline,
    non_negotiable: habit.non_negotiable,
    penalty: habit.penalty,
  };
  if (habit.next_rules && habit.next_rules_from && date >= habit.next_rules_from) {
    return { ...base, ...habit.next_rules };
  }
  return base;
}

export function isScheduled(habit, date, tz) {
  if (date < habit.start_date) return false;
  if (habit.archived_from && date >= habit.archived_from) return false;
  return rulesOn(habit, date).days.includes(weekday(date, tz));
}

// ---------- Misses and deaths ----------

async function applyMiss(tx, game, s, { kind, refId, date, title, hpLost }, notes) {
  const inserted = await tx`
    insert into misses (kind, ref_id, date, title, hp_lost, created_at)
    values (${kind}, ${refId}, ${date}, ${title}, ${hpLost}, ${ts()})
    on conflict (kind, ref_id, date) do nothing
    returning id`;
  if (!inserted.length) return null;
  game.hp -= hpLost;
  await logEvent('miss', { kind, refId, date, title, hpLost, hpAfter: game.hp }, tx);
  if (game.hp <= 0) {
    game.deaths += 1;
    game.season += 1;
    game.seasonStart = date > game.seasonStart ? date : game.seasonStart;
    game.hp = s.maxHp;
    await logEvent('death', { date, cause: title, deaths: game.deaths, season: game.season }, tx);
    notes.push({
      title: 'You died.',
      body: `${title} took your last HP. Every streak is gone. Season ${game.season} starts now.`,
      tag: 'death',
    });
  } else {
    notes.push({
      title: `Missed: ${title}`,
      body: `Minus ${hpLost} HP. You are on ${game.hp} HP.`,
      tag: `miss-${kind}-${refId}-${date}`,
    });
  }
  return inserted[0].id;
}

async function checkHardTasks(tx, game, s, local, tz, notes) {
  const today = isoDate(local);
  const tasks = await tx`
    select t.* from tasks t
    where t.hard and t.done_at is null and t.deleted_at is null and t.due_date is not null and t.due_date <= ${today}
      and not exists (select 1 from misses m where m.kind = 'task' and m.ref_id = t.id and m.date = t.due_date)`;
  for (const t of tasks) {
    const due = deadlineAt(t.due_date, t.deadline || '23:59', tz);
    if (t.due_date < today || local >= due) {
      await applyMiss(tx, game, s, { kind: 'task', refId: t.id, date: t.due_date, title: t.title, hpLost: s.taskPenalty }, notes);
    }
  }
}

async function finalizeDay(tx, game, s, date, tz, notes) {
  const habits = await tx`select * from habits`;
  const done = new Set((await tx`select habit_id from completions where date = ${date}`).map((r) => r.habit_id));
  for (const h of habits) {
    if (!isScheduled(h, date, tz) || done.has(h.id)) continue;
    const r = rulesOn(h, date);
    await applyMiss(tx, game, s, { kind: 'habit', refId: h.id, date, title: h.name, hpLost: r.penalty }, notes);
  }
  const kept = habits.filter((h) => isScheduled(h, date, tz) && done.has(h.id)).length;
  const missRows = await tx`select pardoned_at from misses where date = ${date}`;
  const missed = missRows.filter((m) => !m.pardoned_at).length;
  const pardoned = missRows.length - missed;
  const tasksDone = (await tx`select count(*)::int as n from tasks where hard and due_date = ${date} and done_at is not null`)[0].n;
  const hadWork = kept + missRows.length + tasksDone > 0;
  const clean = hadWork && missed === 0;
  const bonus = clean ? Math.max(0, Math.min(s.cleanBonus, s.maxHp - game.hp)) : 0;
  game.hp += bonus;
  await tx`insert into days (date, hp_end, kept, missed, pardoned, clean, bonus)
           values (${date}, ${game.hp}, ${kept + tasksDone}, ${missed}, ${pardoned}, ${clean}, ${bonus})
           on conflict (date) do nothing`;
  await logEvent('day_closed', { date, kept: kept + tasksDone, missed, pardoned, clean, bonus, hp: game.hp }, tx);
  game.lastFinalized = date;
}

// ---------- The tick ----------

export async function tick() {
  const notes = [];
  const { s, local, today, tz } = await localNow();

  await withGame(async (tx, game) => {
    const month = local.toFormat('yyyy-MM');
    if (game.pardonMonth !== month) {
      game.pardonMonth = month;
      game.pardonsLeft = s.pardonsPerMonth;
      await logEvent('pardons_refilled', { month, pardons: s.pardonsPerMonth }, tx);
    }

    await checkHardTasks(tx, game, s, local, tz, notes);

    // Close every past day that has not been judged yet (also catches up after downtime).
    let d = addDays(game.lastFinalized, 1, tz);
    let guard = 0;
    while (d < today && guard < 90) {
      await finalizeDay(tx, game, s, d, tz, notes);
      d = addDays(d, 1, tz);
      guard += 1;
    }
    if (guard >= 90) game.lastFinalized = addDays(today, -1, tz);

    // Deadlines that have passed today.
    const habits = await tx`select * from habits`;
    const done = new Set((await tx`select habit_id from completions where date = ${today}`).map((r) => r.habit_id));
    for (const h of habits) {
      if (!isScheduled(h, today, tz) || done.has(h.id)) continue;
      const r = rulesOn(h, today);
      if (local >= deadlineAt(today, r.deadline, tz)) {
        await applyMiss(tx, game, s, { kind: 'habit', refId: h.id, date: today, title: h.name, hpLost: r.penalty }, notes);
      }
    }

    // Promote rule changes that take effect today.
    const due = habits.filter((h) => h.next_rules && h.next_rules_from && h.next_rules_from <= today);
    for (const h of due) {
      const r = rulesOn(h, today);
      await tx`update habits set days = ${r.days}, deadline = ${r.deadline}, non_negotiable = ${r.non_negotiable},
               penalty = ${r.penalty}, next_rules = null, next_rules_from = null where id = ${h.id}`;
    }
  });

  notes.push(...(await dueReminders(s, local, today, tz)));
  return notes;
}

// ---------- Reminders ----------

async function dueReminders(s, local, today, tz) {
  const out = [];
  const game = await getGame();
  const items = await openItemsToday(today, tz);
  for (const it of items) {
    const offsets = it.heavy ? [120, 60, 30, 10] : [60, 10];
    for (const off of offsets) {
      const fireAt = it.due.minus({ minutes: off });
      if (local < fireAt || local >= it.due) continue;
      if (local.diff(fireAt, 'minutes').minutes >= 5) continue; // stale after downtime: skip
      const key = `${it.kind}:${it.id}:${today}:${off}`;
      const ins = await db()`insert into reminders_sent (key) values (${key}) on conflict do nothing returning key`;
      if (!ins.length) continue;
      const left = off >= 60 ? `${off / 60} h` : `${off} min`;
      out.push({
        title: `${it.title}: ${left} left`,
        body: `Due ${it.deadline}. Miss it and you lose ${it.penalty} HP (you have ${game.hp}).`,
        tag: `remind-${it.kind}-${it.id}`,
        item: { kind: it.kind, id: it.id },
      });
    }
  }
  return out;
}

export async function openItemsToday(today, tz) {
  const s = await getSettings();
  const items = [];
  const habits = await db()`select * from habits`;
  const done = new Set((await db()`select habit_id from completions where date = ${today}`).map((r) => r.habit_id));
  const missed = new Set((await db()`select ref_id from misses where kind = 'habit' and date = ${today}`).map((r) => r.ref_id));
  for (const h of habits) {
    if (!isScheduled(h, today, tz) || done.has(h.id) || missed.has(h.id)) continue;
    const r = rulesOn(h, today);
    items.push({
      kind: 'habit', id: h.id, title: h.name, deadline: r.deadline,
      due: deadlineAt(today, r.deadline, tz), heavy: r.non_negotiable, penalty: r.penalty,
    });
  }
  const tasks = await db()`select * from tasks where hard and done_at is null and deleted_at is null and due_date = ${today}`;
  const missedTasks = new Set((await db()`select ref_id from misses where kind = 'task' and date = ${today}`).map((r) => r.ref_id));
  for (const t of tasks) {
    if (missedTasks.has(t.id)) continue;
    items.push({
      kind: 'task', id: t.id, title: t.title, deadline: t.deadline || '23:59',
      due: deadlineAt(today, t.deadline || '23:59', tz), heavy: true, penalty: s.taskPenalty,
    });
  }
  return items.sort((a, b) => a.due - b.due);
}

// ---------- Actions ----------

export class RuleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function completeHabit(id, note = '') {
  const { local, today, tz } = await localNow();
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  if (!isScheduled(h, today, tz)) throw new RuleError(`${h.name} is not scheduled today.`);
  const r = rulesOn(h, today);
  const [miss] = await db()`select id from misses where kind = 'habit' and ref_id = ${id} and date = ${today}`;
  if (miss || local >= deadlineAt(today, r.deadline, tz)) {
    throw new RuleError(`Locked. The deadline passed at ${r.deadline}.`, 409);
  }
  const rows = await db()`insert into completions (habit_id, date, note, completed_at) values (${id}, ${today}, ${String(note).slice(0, 500)}, ${ts()})
                          on conflict (habit_id, date) do nothing returning id`;
  if (rows.length) await logEvent('habit_kept', { id, name: h.name, date: today });
  return { ok: true };
}

export async function undoHabit(id) {
  const { s, local, today, tz } = await localNow();
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  const [c] = await db()`select * from completions where habit_id = ${id} and date = ${today}`;
  if (!c) throw new RuleError('Nothing to undo.');
  const r = rulesOn(h, today);
  if (local >= deadlineAt(today, r.deadline, tz)) throw new RuleError('Locked. The deadline has passed.', 409);
  const ageMin = (nowUTC().toMillis() - new Date(c.completed_at).getTime()) / 60000;
  if (ageMin > s.undoMinutes) throw new RuleError(`Undo is only possible within ${s.undoMinutes} minutes.`, 409);
  await db()`delete from completions where id = ${c.id}`;
  await logEvent('habit_undone', { id, name: h.name, date: today });
  return { ok: true };
}

export async function pardon(missId, reason) {
  const text = String(reason || '').trim();
  if (text.length < 15) throw new RuleError('Write a real reason (at least 15 characters). The coach reads it.');
  const notes = [];
  const result = await withGame(async (tx, game) => {
    const [m] = await tx`select * from misses where id = ${missId} for update`;
    if (!m) throw new RuleError('That miss does not exist.', 404);
    if (m.pardoned_at) throw new RuleError('Already pardoned.', 409);
    const ageH = (nowUTC().toMillis() - new Date(m.created_at).getTime()) / 3600000;
    if (ageH > 24) throw new RuleError('Pardons must be used within 24 hours of the miss.', 409);
    if (game.pardonsLeft <= 0) throw new RuleError('No pardons left this month.', 409);
    game.pardonsLeft -= 1;
    const s = await getSettings();
    game.hp = Math.min(s.maxHp, game.hp + m.hp_lost);
    await tx`update misses set pardoned_at = ${ts()}, pardon_reason = ${text.slice(0, 1000)} where id = ${missId}`;
    await tx`update days set missed = greatest(missed - 1, 0), pardoned = pardoned + 1 where date = ${m.date}`;
    await logEvent('pardon', { missId, title: m.title, date: m.date, reason: text, hpRestored: m.hp_lost }, tx);
    return { ok: true, hp: game.hp, pardonsLeft: game.pardonsLeft };
  });
  return { ...result, notes };
}

// ---------- Habits ----------

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function cleanDays(days) {
  const list = Array.isArray(days) ? [...new Set(days.map(Number).filter((d) => d >= 1 && d <= 7))].sort() : [];
  if (!list.length) throw new RuleError('Pick at least one day.');
  return list;
}

export async function createHabit(input, { validTime }) {
  const { local, today, tz } = await localNow();
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw new RuleError('Give the habit a name.');
  const deadline = validTime(input.deadline) ? input.deadline : '21:00';
  const nn = Boolean(input.non_negotiable);
  const penalty = clampInt(input.penalty, 1, 100, nn ? 25 : 10);
  const days = cleanDays(input.days ?? [1, 2, 3, 4, 5, 6, 7]);
  const startsToday = local.plus({ minutes: 1 }) < deadlineAt(today, deadline, tz);
  const start = startsToday ? today : addDays(today, 1, tz);
  const [{ max }] = await db()`select coalesce(max(sort), 0) as max from habits`;
  const [h] = await db()`
    insert into habits (name, notes, days, deadline, non_negotiable, penalty, start_date, sort)
    values (${name}, ${String(input.notes || '').slice(0, 1000)}, ${days}, ${deadline}, ${nn}, ${penalty}, ${start}, ${max + 1})
    returning *`;
  await logEvent('habit_created', { id: h.id, name, deadline, nn, penalty, start });
  return { habit: h, startsToday };
}

export async function habitOpenToday(h, today, tz) {
  if (!isScheduled(h, today, tz)) return false;
  const [c] = await db()`select 1 from completions where habit_id = ${h.id} and date = ${today}`;
  const [m] = await db()`select 1 from misses where kind = 'habit' and ref_id = ${h.id} and date = ${today}`;
  return !c && !m;
}

export async function updateHabit(id, input, { validTime }) {
  const { today, tz } = await localNow();
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  const name = input.name !== undefined ? String(input.name).trim().slice(0, 120) : h.name;
  if (!name) throw new RuleError('Give the habit a name.');
  const notes = input.notes !== undefined ? String(input.notes).slice(0, 1000) : h.notes;
  await db()`update habits set name = ${name}, notes = ${notes} where id = ${id}`;

  const current = rulesOn(h, today);
  const next = {
    days: input.days !== undefined ? cleanDays(input.days) : current.days,
    deadline: input.deadline !== undefined && validTime(input.deadline) ? input.deadline : current.deadline,
    non_negotiable: input.non_negotiable !== undefined ? Boolean(input.non_negotiable) : current.non_negotiable,
    penalty: input.penalty !== undefined ? clampInt(input.penalty, 1, 100, current.penalty) : current.penalty,
  };
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  let effective = 'now';
  if (changed) {
    if (await habitOpenToday(h, today, tz)) {
      // No moving the goalposts on a live obligation: rule changes start tomorrow.
      effective = addDays(today, 1, tz);
      await db()`update habits set next_rules = ${db().json(next)}, next_rules_from = ${effective} where id = ${id}`;
    } else {
      await db()`update habits set days = ${next.days}, deadline = ${next.deadline}, non_negotiable = ${next.non_negotiable},
                 penalty = ${next.penalty}, next_rules = null, next_rules_from = null where id = ${id}`;
    }
    await logEvent('habit_rules_changed', { id, name, next, effective });
  }
  return { ok: true, effective };
}

export async function archiveHabit(id) {
  const { today, tz } = await localNow();
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  const from = isScheduled(h, today, tz) ? addDays(today, 1, tz) : today;
  await db()`update habits set archived_from = ${from} where id = ${id}`;
  await logEvent('habit_archived', { id, name: h.name, from });
  return { ok: true, from };
}

// ---------- Tasks ----------

export async function createTask(input, { validTime, validDate }, createdBy = 'you') {
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) throw new RuleError('Give the task a title.');
  const { today } = await localNow();
  const due = validDate(input.due_date) ? input.due_date : null;
  const deadline = validTime(input.deadline) ? input.deadline : null;
  const hard = Boolean(input.hard) && Boolean(due);
  if (input.hard && !due) throw new RuleError('A hard task needs a due date.');
  if (due && due < today) throw new RuleError('The due date is in the past.');
  const [t] = await db()`
    insert into tasks (title, notes, due_date, deadline, hard, created_by)
    values (${title}, ${String(input.notes || '').slice(0, 1000)}, ${due}, ${deadline}, ${hard}, ${createdBy})
    returning *`;
  await logEvent('task_created', { id: t.id, title, due, deadline, hard, createdBy });
  return t;
}

export async function updateTask(id, input, { validTime, validDate }, actor = 'you') {
  const { today } = await localNow();
  const [t] = await db()`select * from tasks where id = ${id} and deleted_at is null`;
  if (!t) throw new RuleError('That task does not exist.', 404);
  const locked = t.hard && t.due_date && t.due_date <= today;
  const title = input.title !== undefined ? String(input.title).trim().slice(0, 200) : t.title;
  if (!title) throw new RuleError('Give the task a title.');
  const notes = input.notes !== undefined ? String(input.notes).slice(0, 1000) : t.notes;
  let { due_date: due, deadline, hard } = t;
  const wantsRuleChange = input.due_date !== undefined || input.deadline !== undefined || input.hard !== undefined;
  if (wantsRuleChange) {
    if (locked) throw new RuleError('Hard tasks are locked once they are due. Do it or take the hit.', 409);
    if (actor === 'coach' && t.hard) throw new RuleError('The coach cannot move hard tasks.', 409);
    if (input.due_date !== undefined) {
      due = input.due_date === null || input.due_date === '' ? null : validDate(input.due_date) ? input.due_date : t.due_date;
      if (due && due < today) throw new RuleError('The due date is in the past.');
    }
    if (input.deadline !== undefined) deadline = input.deadline === null || input.deadline === '' ? null : validTime(input.deadline) ? input.deadline : t.deadline;
    if (input.hard !== undefined) hard = Boolean(input.hard);
    if (hard && !due) throw new RuleError('A hard task needs a due date.');
  }
  await db()`update tasks set title = ${title}, notes = ${notes}, due_date = ${due}, deadline = ${deadline}, hard = ${hard} where id = ${id}`;
  await logEvent('task_updated', { id, title, due, deadline, hard, actor });
  return { ok: true };
}

export async function completeTask(id) {
  const [t] = await db()`update tasks set done_at = ${ts()} where id = ${id} and deleted_at is null and done_at is null returning *`;
  if (!t) throw new RuleError('That task is already done or does not exist.', 404);
  await logEvent('task_done', { id, title: t.title });
  return { ok: true };
}

export async function undoTask(id) {
  const { s } = await localNow();
  const [t] = await db()`select * from tasks where id = ${id} and deleted_at is null`;
  if (!t || !t.done_at) throw new RuleError('Nothing to undo.');
  const ageMin = (nowUTC().toMillis() - new Date(t.done_at).getTime()) / 60000;
  if (t.hard && ageMin > s.undoMinutes) throw new RuleError(`Undo is only possible within ${s.undoMinutes} minutes.`, 409);
  await db()`update tasks set done_at = null where id = ${id}`;
  await logEvent('task_undone', { id, title: t.title });
  return { ok: true };
}

export async function deleteTask(id) {
  const { today } = await localNow();
  const [t] = await db()`select * from tasks where id = ${id} and deleted_at is null`;
  if (!t) throw new RuleError('That task does not exist.', 404);
  if (t.hard && t.due_date && t.due_date <= today && !t.done_at) {
    throw new RuleError('Hard tasks cannot be deleted once they are due. Do it or take the hit.', 409);
  }
  await db()`update tasks set deleted_at = ${ts()} where id = ${id}`;
  await logEvent('task_deleted', { id, title: t.title });
  return { ok: true };
}
