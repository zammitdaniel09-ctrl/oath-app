// The accountability engine: HP, misses, deaths, pardons, rest days, rules changes and the tick loop.
//
// Research notes behind the rules (see the research report):
// - The return after a miss is rewarded (comeback bonus), the best single intervention in the
//   Milkman et al. 2021 gym megastudy. A second miss in a row costs more, because gaps, not single
//   slips, erode habits (Lally et al. 2010; Buyalskaya et al. 2023).
// - "X times a week" habits are settled on Sunday night, for behaviours that need flexible timing.
// - A minimum version, declared a day ahead, saves the HP but not the clean-day bonus.
// - Reminders are few, cue-based and fade once a habit is strong (Stawarz et al. 2015).
import { db, getKV, setKV, logEvent } from './db.js';
import { nowUTC, isoDate, addDays, weekday, deadlineAt } from './time.js';
import { rulesOn, isActive, isFlexible, isScheduled, weekStartOf, weekDates, weekTargetFor, previousOccurrence } from './rules.js';
import { restSet, habitStats } from './strength.js';

export { rulesOn, isScheduled, isFlexible, isActive, weekStartOf } from './rules.js';

// Every timestamp comes from the app clock, never the database clock.
const ts = () => nowUTC().toJSDate();

export const DEFAULT_SETTINGS = {
  timezone: 'Europe/Malta',
  morningTime: '07:00',
  middayTime: '13:00',
  eveningTime: '21:00',
  dayEnd: '22:00',
  cleanBonus: 5,
  comebackBonus: 5,
  repeatMultiplier: 1.5,
  taskPenalty: 15,
  pardonsPerMonth: 2,
  restDaysPerMonth: 2,
  maxNonNegotiables: 3,
  undoMinutes: 10,
  maxHp: 100,
  alerts: 'smart',
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

export class RuleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- Misses and deaths ----------

async function applyMiss(tx, game, s, { kind, refId, date, title, hpLost, repeat = false }, notes) {
  const inserted = await tx`
    insert into misses (kind, ref_id, date, title, hp_lost, repeat, created_at)
    values (${kind}, ${refId}, ${date}, ${title}, ${hpLost}, ${repeat}, ${ts()})
    on conflict (kind, ref_id, date) do nothing
    returning id`;
  if (!inserted.length) return null;
  game.hp -= hpLost;
  await logEvent('miss', { kind, refId, date, title, hpLost, repeat, hpAfter: game.hp }, tx);
  if (game.hp <= 0) {
    game.deaths += 1;
    game.season += 1;
    game.seasonStart = date > game.seasonStart ? date : game.seasonStart;
    game.hp = s.maxHp;
    await logEvent('death', { date, cause: title, deaths: game.deaths, season: game.season }, tx);
    notes.push({
      title: `Season ${game.season - 1} is over.`,
      body: `${title} took your last HP. Streaks reset, but every habit keeps its strength. Season ${game.season} starts now at full HP. Open the coach and plan the comeback.`,
      tag: 'death',
      urgent: true,
      both: true,
      url: '/#/coach',
    });
  } else {
    const comeback = kind === 'habit' ? ` Keep it next time for +${s.comebackBonus} HP.` : '';
    notes.push({
      title: repeat ? `Missed twice in a row: ${title}` : `Missed: ${title}`,
      body: repeat
        ? `Second miss in a row costs ${s.repeatMultiplier}x: minus ${hpLost} HP. You are on ${game.hp}.${comeback}`
        : `Minus ${hpLost} HP. You are on ${game.hp}.${comeback}`,
      tag: `miss-${kind}-${refId}-${date}`,
    });
  }
  return inserted[0].id;
}

async function unpardonedMiss(tx, habitId, date) {
  if (!date) return false;
  const [m] = await tx`select pardoned_at from misses where kind = 'habit' and ref_id = ${habitId} and date = ${date}`;
  return Boolean(m && !m.pardoned_at);
}

// What a fixed-day miss costs: the habit's penalty, or more if the previous occurrence was missed too.
async function habitMissCost(tx, s, h, date, tz, rest) {
  const r = rulesOn(h, date);
  const repeat = await unpardonedMiss(tx, h.id, previousOccurrence(h, date, tz, rest));
  return { hpLost: repeat ? Math.round(r.penalty * s.repeatMultiplier) : r.penalty, repeat };
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

// Sunday night: settle every "X times a week" habit.
async function closeWeek(tx, game, s, sunday, tz, notes, rest, habits) {
  const monday = addDays(sunday, -6, tz);
  for (const h of habits) {
    if (!weekDates(monday, tz).some((d) => isActive(h, d) && isFlexible(h, d))) continue;
    const target = weekTargetFor(h, monday, tz, rest);
    if (!target) continue;
    const [{ n: done }] = await tx`select count(*)::int as n from completions where habit_id = ${h.id} and date >= ${monday} and date <= ${sunday}`;
    const prevMissed = await unpardonedMiss(tx, h.id, addDays(sunday, -7, tz));
    if (done < target) {
      const r = rulesOn(h, sunday);
      const base = Math.ceil((r.penalty * (target - done)) / target);
      const hpLost = prevMissed ? Math.round(base * s.repeatMultiplier) : base;
      await applyMiss(tx, game, s, { kind: 'habit', refId: h.id, date: sunday, title: `${h.name}: ${done} of ${target} this week`, hpLost, repeat: prevMissed }, notes);
    } else if (prevMissed) {
      const bonus = Math.max(0, Math.min(s.comebackBonus, s.maxHp - game.hp));
      game.hp += bonus;
      await logEvent('comeback', { habitId: h.id, name: h.name, week: monday, bonus }, tx);
      notes.push({ title: `Back on track: ${h.name}`, body: `${done} of ${target} this week after last week's miss. +${bonus} HP.`, tag: `comeback-${h.id}` });
    }
  }
}

async function finalizeDay(tx, game, s, date, tz, notes, rest) {
  const habits = await tx`select * from habits`;
  const doneRows = await tx`select habit_id, minimum from completions where date = ${date}`;
  const done = new Map(doneRows.map((r) => [r.habit_id, r]));
  for (const h of habits) {
    if (!isScheduled(h, date, tz, rest) || done.has(h.id)) continue;
    const cost = await habitMissCost(tx, s, h, date, tz, rest);
    await applyMiss(tx, game, s, { kind: 'habit', refId: h.id, date, title: h.name, ...cost }, notes);
  }
  if (weekday(date, tz) === 7) await closeWeek(tx, game, s, date, tz, notes, rest, habits);

  const scheduledDone = habits.filter((h) => isScheduled(h, date, tz, rest) && done.has(h.id));
  const flexDone = habits.filter((h) => isFlexible(h, date) && done.has(h.id)).length;
  const usedMinimum = doneRows.some((r) => r.minimum); // fixed or X-a-week: any minimum voids the bonus
  const missRows = await tx`select pardoned_at from misses where date = ${date}`;
  const missed = missRows.filter((m) => !m.pardoned_at).length;
  const pardoned = missRows.length - missed;
  const tasksDone = (await tx`select count(*)::int as n from tasks where hard and due_date = ${date} and done_at is not null`)[0].n;
  const isRest = rest.has(date);
  const kept = scheduledDone.length + flexDone + tasksDone;
  const hadWork = kept + missRows.length > 0;
  const clean = hadWork && missed === 0 && !usedMinimum && !isRest;
  const bonus = clean ? Math.max(0, Math.min(s.cleanBonus, s.maxHp - game.hp)) : 0;
  game.hp += bonus;
  await tx`insert into days (date, hp_end, kept, missed, pardoned, clean, bonus, rest)
           values (${date}, ${game.hp}, ${kept}, ${missed}, ${pardoned}, ${clean}, ${bonus}, ${isRest})
           on conflict (date) do nothing`;
  await logEvent('day_closed', { date, kept, missed, pardoned, clean, bonus, rest: isRest, hp: game.hp }, tx);
  game.lastFinalized = date;
}

// ---------- The tick ----------

export async function tick() {
  const notes = [];
  const { s, local, today, tz } = await localNow();

  await withGame(async (tx, game) => {
    const rest = await restSet(tx);
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
      await finalizeDay(tx, game, s, d, tz, notes, rest);
      d = addDays(d, 1, tz);
      guard += 1;
    }
    if (guard >= 90) game.lastFinalized = addDays(today, -1, tz);

    // Deadlines that have passed today.
    const habits = await tx`select * from habits`;
    const done = new Set((await tx`select habit_id from completions where date = ${today}`).map((r) => r.habit_id));
    for (const h of habits) {
      if (!isScheduled(h, today, tz, rest) || done.has(h.id)) continue;
      const r = rulesOn(h, today);
      if (local >= deadlineAt(today, r.deadline, tz)) {
        const cost = await habitMissCost(tx, s, h, today, tz, rest);
        await applyMiss(tx, game, s, { kind: 'habit', refId: h.id, date: today, title: h.name, ...cost }, notes);
      }
    }

    // Promote rule changes that take effect today.
    const due = habits.filter((h) => h.next_rules && h.next_rules_from && h.next_rules_from <= today);
    for (const h of due) {
      const r = rulesOn(h, today);
      await tx`update habits set days = ${r.days}, deadline = ${r.deadline}, non_negotiable = ${r.non_negotiable},
               penalty = ${r.penalty}, minimum = ${r.minimum || ''}, weekly_target = ${r.weekly_target || null},
               next_rules = null, next_rules_from = null where id = ${h.id}`;
    }
  });

  notes.push(...(await dueReminders(s, local, today, tz)));
  return notes;
}

// ---------- Reminders ----------
// Few and cue-based: an optional cue reminder at the habit's anchor time, then one last call.
// Both fade once a habit passes 80% strength, except the last call on non-negotiables.

const capitalise = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

async function dueReminders(s, local, today, tz) {
  const game = await getGame();
  const items = await openItemsToday(today, tz);
  const firing = [];
  for (const it of items) {
    const plan = [];
    if (it.kind === 'habit' && !it.flexible) {
      if (it.remindAt && it.strength < 80) plan.push({ type: 'cue', at: deadlineAt(today, it.remindAt, tz) });
      if (it.heavy || it.strength < 80) plan.push({ type: 'last', at: it.due.minus({ minutes: 30 }) });
    } else if (it.kind === 'habit') {
      plan.push({ type: 'last', at: it.due.minus({ minutes: 60 }) });
    } else {
      plan.push({ type: 'last', at: it.due.minus({ minutes: 60 }) }, { type: 'last', at: it.due.minus({ minutes: 15 }) });
    }
    for (const p of plan) {
      if (local < p.at || local >= it.due) continue;
      if (local.diff(p.at, 'minutes').minutes >= 5) continue; // stale after downtime: skip
      const key = `${it.kind}:${it.id}:${today}:${p.type}:${p.at.toFormat('HHmm')}`;
      const ins = await db()`insert into reminders_sent (key) values (${key}) on conflict do nothing returning key`;
      if (ins.length) firing.push({ it, type: p.type });
    }
  }
  if (!firing.length) return [];

  const minutesLeft = (it) => Math.max(1, Math.round(it.due.diff(local, 'minutes').minutes));
  const leftText = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  const ttl = Math.max(60, Math.min(...firing.map(({ it }) => minutesLeft(it) * 60)));

  if (firing.length === 1) {
    const { it, type } = firing[0];
    const extras = [];
    if (it.firstStep) extras.push(`First step: ${it.firstStep}.`);
    if (it.minimum) extras.push(`Short on time? The minimum is "${it.minimum}".`);
    if (it.lastPlan) extras.push(`Your plan: ${it.lastPlan}`);
    const title = type === 'cue'
      ? `${it.cue ? `${capitalise(it.cue)}: ` : ''}${it.title}`
      : `${it.title}: ${leftText(minutesLeft(it))} left`;
    const body = type === 'cue'
      ? `Due ${it.deadline}.${it.ifThen ? ` ${it.ifThen}` : ''}`
      : `Due ${it.deadline}. Miss it and you lose ${it.penalty} HP (you have ${game.hp}).${extras.length ? ` ${extras.join(' ')}` : ''}`;
    return [{
      title, body, tag: `remind-${it.kind}-${it.id}`, item: { kind: it.kind, id: it.id },
      urgent: type === 'last' && it.heavy, ttl, topic: `${it.kind}-${it.id}`,
    }];
  }
  const lines = firing.map(({ it }) => `${it.title} by ${it.deadline}`);
  return [{
    title: `${firing.length} things due soon`,
    body: `${lines.join('; ')}. ${firing.reduce((n, { it }) => n + it.penalty, 0)} HP at stake.`,
    tag: 'remind-bundle',
    items: firing.map(({ it }) => ({ kind: it.kind, id: it.id, title: it.title })),
    urgent: firing.some(({ it, type }) => type === 'last' && it.heavy),
    ttl,
    topic: 'bundle',
  }];
}

// Everything that can still be lost today, soonest first.
export async function openItemsToday(today, tz) {
  const s = await getSettings();
  const rest = await restSet();
  const items = [];
  const habits = (await db()`select * from habits`).filter((h) => isActive(h, today));
  const done = new Set((await db()`select habit_id from completions where date = ${today}`).map((r) => r.habit_id));
  const missed = new Set((await db()`select ref_id from misses where kind = 'habit' and date = ${today}`).map((r) => r.ref_id));
  const open = habits.filter((h) => !done.has(h.id) && !missed.has(h.id) && (isScheduled(h, today, tz, rest) || isFlexible(h, today)));
  const stats = await habitStats(open, today, tz, { heatDays: 1 });
  for (const h of open) {
    const r = rulesOn(h, today);
    const st = stats.get(h.id) || {};
    const base = {
      kind: 'habit', id: h.id, title: h.name, deadline: r.deadline, due: deadlineAt(today, r.deadline, tz),
      heavy: r.non_negotiable, penalty: r.penalty, cue: h.cue, ifThen: h.if_then, remindAt: h.remind_at,
      minimum: r.minimum, strength: st.strength ?? 0, lastPlan: st.lastPlan,
    };
    if (!r.weekly_target) {
      items.push(base);
      continue;
    }
    const remainingDays = weekDates(weekStartOf(today, tz), tz).filter((d) => d >= today && !rest.has(d)).length;
    const needed = st.weekTarget - st.weekDone;
    if (needed > 0 && needed >= remainingDays) {
      items.push({ ...base, flexible: true, penalty: Math.ceil((r.penalty * needed) / Math.max(1, st.weekTarget)) });
    }
  }
  const tasks = await db()`select * from tasks where hard and done_at is null and deleted_at is null and due_date = ${today}`;
  const missedTasks = new Set((await db()`select ref_id from misses where kind = 'task' and date = ${today}`).map((r) => r.ref_id));
  for (const t of tasks) {
    if (missedTasks.has(t.id)) continue;
    items.push({
      kind: 'task', id: t.id, title: t.title, deadline: t.deadline || '23:59',
      due: deadlineAt(today, t.deadline || '23:59', tz), heavy: true, penalty: s.taskPenalty, firstStep: t.first_step,
    });
  }
  return items.sort((a, b) => a.due - b.due);
}

// ---------- Habit actions ----------

export async function completeHabit(id, opts = {}) {
  const note = typeof opts === 'string' ? opts : opts.note || '';
  const minimum = typeof opts === 'object' && Boolean(opts.minimum);
  const { s, local, today, tz } = await localNow();
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  const rest = await restSet();
  const flexible = isFlexible(h, today) && isActive(h, today);
  if (!flexible && !isScheduled(h, today, tz, rest)) {
    throw new RuleError(rest.has(today) ? 'Today is a rest day.' : `${h.name} is not scheduled today.`);
  }
  const r = rulesOn(h, today);
  if (minimum && !r.minimum) throw new RuleError('This habit has no minimum version. Set one in Plan; it applies from tomorrow.');
  const [miss] = await db()`select id from misses where kind = 'habit' and ref_id = ${id} and date = ${today}`;
  if (miss || local >= deadlineAt(today, r.deadline, tz)) {
    throw new RuleError(flexible ? `Locked. Log it before ${r.deadline}.` : `Locked. The deadline passed at ${r.deadline}.`, 409);
  }
  const rows = await db()`insert into completions (habit_id, date, note, minimum, completed_at)
                          values (${id}, ${today}, ${String(note).slice(0, 500)}, ${minimum}, ${ts()})
                          on conflict (habit_id, date) do nothing returning id`;
  if (!rows.length) return { ok: true, already: true };
  await logEvent('habit_kept', { id, name: h.name, date: today, minimum });

  // Comeback: kept on the first scheduled day after an unpardoned miss.
  let comeback = 0;
  if (!flexible && (await unpardonedMiss(db(), id, previousOccurrence(h, today, tz, rest)))) {
    comeback = await withGame(async (tx, game) => {
      const bonus = Math.max(0, Math.min(s.comebackBonus, s.maxHp - game.hp));
      game.hp += bonus;
      await tx`update completions set comeback = true where id = ${rows[0].id}`;
      await logEvent('comeback', { habitId: id, name: h.name, date: today, bonus }, tx);
      return bonus;
    });
  }
  return { ok: true, minimum, comeback };
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
  if (c.comeback) {
    await withGame(async (tx, game) => {
      // Take back what was actually granted (it may have been capped at max HP), not the full bonus.
      const [ev] = await tx`select data from events where type = 'comeback' and (data->>'habitId')::int = ${id}
                            and data->>'date' = ${today} order by id desc limit 1`;
      const granted = ev ? Number(ev.data.bonus) || 0 : s.comebackBonus;
      game.hp = Math.max(1, game.hp - granted);
      await logEvent('comeback_undone', { habitId: id, date: today }, tx);
    });
  }
  await logEvent('habit_undone', { id, name: h.name, date: today });
  return { ok: true };
}

// A pardon needs what got in the way and an if-then plan for next time. The plan is quoted
// back in that habit's reminders, turning every pardon into an implementation intention.
export async function pardon(missId, input) {
  const reason = String((typeof input === 'string' ? input : input?.reason) || '').trim();
  const plan = String((typeof input === 'object' && input?.plan) || '').trim();
  if (reason.length < 10) throw new RuleError('Say what specifically got in the way (at least 10 characters).');
  if (plan.length < 10) throw new RuleError('Write the plan: "If that happens again, I will ...".');
  return withGame(async (tx, game) => {
    const [m] = await tx`select * from misses where id = ${missId} for update`;
    if (!m) throw new RuleError('That miss does not exist.', 404);
    if (m.pardoned_at) throw new RuleError('Already pardoned.', 409);
    const ageH = (nowUTC().toMillis() - new Date(m.created_at).getTime()) / 3600000;
    if (ageH > 24) throw new RuleError('Pardons must be used within 24 hours of the miss.', 409);
    if (game.pardonsLeft <= 0) throw new RuleError('No pardons left this month.', 409);
    game.pardonsLeft -= 1;
    const s = await getSettings();
    game.hp = Math.min(s.maxHp, game.hp + m.hp_lost);
    await tx`update misses set pardoned_at = ${ts()}, pardon_reason = ${reason.slice(0, 1000)}, pardon_plan = ${plan.slice(0, 500)} where id = ${missId}`;
    await tx`update days set missed = greatest(missed - 1, 0), pardoned = pardoned + 1 where date = ${m.date}`;
    await logEvent('pardon', { missId, title: m.title, date: m.date, reason, plan, hpRestored: m.hp_lost }, tx);
    return { ok: true, hp: game.hp, pardonsLeft: game.pardonsLeft };
  });
}

// ---------- Rest days ----------

export async function bookRest(date, reason = '') {
  const { s, today } = await localNow();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new RuleError('Pick a date.');
  if (date <= today) throw new RuleError('Rest days must be booked before the day starts.');
  const month = date.slice(0, 7);
  const [{ n }] = await db()`select count(*)::int as n from rest_days where date like ${`${month}-%`}`;
  if (n >= s.restDaysPerMonth) throw new RuleError(`You already booked ${s.restDaysPerMonth} rest days in that month.`, 409);
  const rows = await db()`insert into rest_days (date, reason, booked_at) values (${date}, ${String(reason).slice(0, 200)}, ${ts()})
                          on conflict do nothing returning date`;
  if (!rows.length) throw new RuleError('That day is already a rest day.', 409);
  await logEvent('rest_booked', { date, reason });
  return { ok: true };
}

export async function cancelRest(date) {
  const { today } = await localNow();
  if (date <= today) throw new RuleError('A rest day cannot be cancelled once it has started.', 409);
  await db()`delete from rest_days where date = ${date}`;
  await logEvent('rest_cancelled', { date });
  return { ok: true };
}

export async function listRest() {
  const { today, tz } = await localNow();
  return db()`select date, reason from rest_days where date >= ${addDays(today, -31, tz)} order by date`;
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

const text = (v, max) => String(v ?? '').trim().slice(0, max);

async function validGoalId(goalId) {
  if (goalId === undefined || goalId === null || goalId === '') return null;
  const id = Number.parseInt(goalId, 10);
  const [g] = await db()`select id from goals where id = ${id}`;
  if (!g) throw new RuleError('That goal does not exist.');
  return id;
}

// Overcommitment is the pattern users cite when they quit: a fourth non-negotiable only once
// the existing ones are established.
async function checkNonNegotiableCap(excludeId = null) {
  const { s, today, tz } = await localNow();
  // Not archived counts, including habits that only start tomorrow (created after today's deadline).
  const habits = (await db()`select * from habits`).filter((h) => h.id !== excludeId && !(h.archived_from && h.archived_from <= today)
    && (rulesOn(h, today).non_negotiable || (h.next_rules && h.next_rules.non_negotiable)));
  if (habits.length < s.maxNonNegotiables) return;
  const stats = await habitStats(habits, today, tz, { heatDays: 1 });
  const weak = habits.filter((h) => (stats.get(h.id)?.strength ?? 0) < 80);
  if (weak.length) {
    const list = weak.map((h) => `${h.name} ${stats.get(h.id)?.strength ?? 0}%`).join(', ');
    throw new RuleError(`You already have ${habits.length} non-negotiables. Get each above 80% strength before adding another (${list}).`, 409);
  }
}

function parseWeekly(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || Number(v) === 0) return null;
  return clampInt(v, 1, 7, null);
}

export async function createHabit(input, { validTime }) {
  const { local, today, tz } = await localNow();
  const name = text(input.name, 120);
  if (!name) throw new RuleError('Give the habit a name.');
  const weekly = parseWeekly(input.weekly_target) ?? null;
  const deadline = validTime(input.deadline) ? input.deadline : weekly ? '23:59' : '21:00';
  const nn = Boolean(input.non_negotiable);
  if (nn) await checkNonNegotiableCap();
  const penalty = clampInt(input.penalty, 1, 100, nn ? 25 : 10);
  const days = weekly ? [1, 2, 3, 4, 5, 6, 7] : cleanDays(input.days ?? [1, 2, 3, 4, 5, 6, 7]);
  const goalId = await validGoalId(input.goal_id);
  const remindAt = validTime(input.remind_at) ? input.remind_at : null;
  const startsToday = local.plus({ minutes: 1 }) < deadlineAt(today, deadline, tz);
  const start = startsToday ? today : addDays(today, 1, tz);
  const [{ max }] = await db()`select coalesce(max(sort), 0) as max from habits`;
  const [h] = await db()`
    insert into habits (name, notes, days, deadline, non_negotiable, penalty, start_date, sort, cue, if_then, minimum, weekly_target, remind_at, goal_id)
    values (${name}, ${text(input.notes, 1000)}, ${days}, ${deadline}, ${nn}, ${penalty}, ${start}, ${max + 1},
            ${text(input.cue, 120)}, ${text(input.if_then, 300)}, ${text(input.minimum, 120)}, ${weekly}, ${remindAt}, ${goalId})
    returning *`;
  await logEvent('habit_created', { id: h.id, name, deadline, nn, penalty, start, weekly });
  return { habit: h, startsToday };
}

export async function habitOpenToday(h, today, tz) {
  const rest = await restSet();
  if (!isScheduled(h, today, tz, rest) && !(isFlexible(h, today) && isActive(h, today))) return false;
  const [c] = await db()`select 1 from completions where habit_id = ${h.id} and date = ${today}`;
  const [m] = await db()`select 1 from misses where kind = 'habit' and ref_id = ${h.id} and date = ${today}`;
  return !c && !m;
}

export async function updateHabit(id, input, { validTime }) {
  const { today, tz } = await localNow();
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  const name = input.name !== undefined ? text(input.name, 120) : h.name;
  if (!name) throw new RuleError('Give the habit a name.');
  // Details that do not change what is owed take effect immediately.
  await db()`update habits set name = ${name},
    notes = ${input.notes !== undefined ? text(input.notes, 1000) : h.notes},
    cue = ${input.cue !== undefined ? text(input.cue, 120) : h.cue},
    if_then = ${input.if_then !== undefined ? text(input.if_then, 300) : h.if_then},
    remind_at = ${input.remind_at !== undefined ? (validTime(input.remind_at) ? input.remind_at : null) : h.remind_at},
    goal_id = ${input.goal_id !== undefined ? await validGoalId(input.goal_id) : h.goal_id}
    where id = ${id}`;

  const current = rulesOn(h, today);
  const weekly = parseWeekly(input.weekly_target);
  const nextWeekly = weekly === undefined ? current.weekly_target : weekly;
  const next = {
    days: nextWeekly ? [1, 2, 3, 4, 5, 6, 7] : input.days !== undefined ? cleanDays(input.days) : current.days,
    deadline: input.deadline !== undefined && validTime(input.deadline) ? input.deadline : current.deadline,
    non_negotiable: input.non_negotiable !== undefined ? Boolean(input.non_negotiable) : current.non_negotiable,
    penalty: input.penalty !== undefined ? clampInt(input.penalty, 1, 100, current.penalty) : current.penalty,
    minimum: input.minimum !== undefined ? text(input.minimum, 120) : current.minimum,
    weekly_target: nextWeekly || null,
  };
  if (next.non_negotiable && !current.non_negotiable) await checkNonNegotiableCap(id);
  const changed = JSON.stringify(next) !== JSON.stringify({ ...current, weekly_target: current.weekly_target || null });
  let effective = 'now';
  if (changed) {
    // No moving the goalposts on a live obligation: rule changes start tomorrow. A new minimum
    // version always waits a day, so it has to be declared in advance.
    const minimumChanged = next.minimum !== current.minimum;
    if ((await habitOpenToday(h, today, tz)) || minimumChanged) {
      effective = addDays(today, 1, tz);
      await db()`update habits set next_rules = ${db().json(next)}, next_rules_from = ${effective} where id = ${id}`;
    } else {
      await db()`update habits set days = ${next.days}, deadline = ${next.deadline}, non_negotiable = ${next.non_negotiable},
                 penalty = ${next.penalty}, minimum = ${next.minimum}, weekly_target = ${next.weekly_target},
                 next_rules = null, next_rules_from = null where id = ${id}`;
    }
    await logEvent('habit_rules_changed', { id, name, next, effective });
  }
  return { ok: true, effective };
}

export async function archiveHabit(id) {
  const { today, tz } = await localNow();
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  const from = (await habitOpenToday(h, today, tz)) || isScheduled(h, today, tz) ? addDays(today, 1, tz) : today;
  await db()`update habits set archived_from = ${from} where id = ${id}`;
  await db()`update nodes set kind = 'idea', ref_id = null where kind = 'habit' and ref_id = ${id}`;
  await logEvent('habit_archived', { id, name: h.name, from });
  return { ok: true, from };
}

// ---------- Tasks ----------

export async function createTask(input, { validTime, validDate }, createdBy = 'you') {
  const title = text(input.title, 200);
  if (!title) throw new RuleError('Give the task a title.');
  const { today } = await localNow();
  const due = validDate(input.due_date) ? input.due_date : null;
  const deadline = validTime(input.deadline) ? input.deadline : null;
  // Voice capture never creates a penalty: a misheard sentence must not cost HP.
  const wantsHard = createdBy !== 'siri' && Boolean(input.hard);
  if (wantsHard && !due) throw new RuleError('A hard task needs a due date.');
  const firstStep = text(input.first_step, 200);
  if (wantsHard && firstStep.length < 3) throw new RuleError('A hard task needs a first step: the very first physical action.');
  if (due && due < today) throw new RuleError('The due date is in the past.');
  const estimate = input.estimate_min ? clampInt(input.estimate_min, 5, 600, null) : null;
  const goalId = await validGoalId(input.goal_id);
  const [t] = await db()`
    insert into tasks (title, notes, due_date, deadline, hard, created_by, goal_id, node_id, first_step, estimate_min, created_at)
    values (${title}, ${text(input.notes, 1000)}, ${due}, ${deadline}, ${wantsHard}, ${createdBy}, ${goalId},
            ${input.node_id ? Number(input.node_id) : null}, ${firstStep}, ${estimate}, ${ts()})
    returning *`;
  await logEvent('task_created', { id: t.id, title, due, deadline, hard: wantsHard, createdBy, goalId });
  return t;
}

export async function updateTask(id, input, { validTime, validDate }, actor = 'you') {
  const { today } = await localNow();
  const [t] = await db()`select * from tasks where id = ${id} and deleted_at is null`;
  if (!t) throw new RuleError('That task does not exist.', 404);
  const locked = t.hard && t.due_date && t.due_date <= today;
  const title = input.title !== undefined ? text(input.title, 200) : t.title;
  if (!title) throw new RuleError('Give the task a title.');
  const notes = input.notes !== undefined ? text(input.notes, 1000) : t.notes;
  const firstStep = input.first_step !== undefined ? text(input.first_step, 200) : t.first_step;
  const estimate = input.estimate_min !== undefined ? (input.estimate_min ? clampInt(input.estimate_min, 5, 600, null) : null) : t.estimate_min;
  const goalId = input.goal_id !== undefined ? await validGoalId(input.goal_id) : t.goal_id;
  let { due_date: due, deadline, hard } = t;
  const wantsRuleChange = input.due_date !== undefined || input.deadline !== undefined || input.hard !== undefined;
  if (wantsRuleChange) {
    const same = (input.due_date === undefined || (input.due_date || null) === t.due_date)
      && (input.deadline === undefined || (input.deadline || null) === t.deadline)
      && (input.hard === undefined || Boolean(input.hard) === t.hard);
    if (!same) {
      if (locked) throw new RuleError('Hard tasks are locked once they are due. Do it or take the hit.', 409);
      if (actor === 'coach' && t.hard) throw new RuleError('The coach cannot move hard tasks.', 409);
    }
    if (input.due_date !== undefined) {
      due = input.due_date === null || input.due_date === '' ? null : validDate(input.due_date) ? input.due_date : t.due_date;
      if (due && due < today && due !== t.due_date) throw new RuleError('The due date is in the past.');
    }
    if (input.deadline !== undefined) deadline = input.deadline === null || input.deadline === '' ? null : validTime(input.deadline) ? input.deadline : t.deadline;
    if (input.hard !== undefined) hard = Boolean(input.hard);
    if (hard && !due) throw new RuleError('A hard task needs a due date.');
    if (hard && firstStep.length < 3) throw new RuleError('A hard task needs a first step: the very first physical action.');
  }
  await db()`update tasks set title = ${title}, notes = ${notes}, due_date = ${due}, deadline = ${deadline}, hard = ${hard},
             first_step = ${firstStep}, estimate_min = ${estimate}, goal_id = ${goalId} where id = ${id}`;
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
  await db()`update nodes set kind = 'idea', ref_id = null where kind = 'task' and ref_id = ${id}`;
  await logEvent('task_deleted', { id, title: t.title });
  return { ok: true };
}

// Backlog triage: overdue and stale normal tasks get one decision each instead of a red pile.
export async function triageTask(id, action) {
  const { today, tz } = await localNow();
  const [t] = await db()`select * from tasks where id = ${id} and deleted_at is null and done_at is null`;
  if (!t) throw new RuleError('That task does not exist.', 404);
  if (t.hard) throw new RuleError('Hard tasks are not triaged. Do it or take the hit.', 409);
  const nextMonday = addDays(today, 8 - weekday(today, tz), tz);
  const dates = { today, tomorrow: addDays(today, 1, tz), week: nextMonday, someday: null };
  if (action === 'drop') return deleteTask(id);
  if (!(action in dates)) throw new RuleError('Unknown choice.');
  await db()`update tasks set due_date = ${dates[action]}, created_at = ${action === 'someday' ? ts() : t.created_at} where id = ${id}`;
  await logEvent('task_triaged', { id, title: t.title, action });
  return { ok: true, due: dates[action] };
}
