// The daily drive: the morning oath, focus blocks, logged dodges, closing the day, and reactions.
import { db, logEvent } from './db.js';
import { nowUTC, addDays, validTime, validDate } from './time.js';
import { localNow, RuleError, completeHabit, completeTask, updateTask } from './engine.js';
import { buildToday } from './state.js';
import { battlePlan, reflectionReply } from './coach.js';

const ts = () => nowUTC().toJSDate();

function findItem(t, kind, id) {
  const list = kind === 'habit' ? t.items : kind === 'task' ? t.tasks : [];
  return list.find((x) => x.id === Number(id));
}

// What still has to happen today: open habits plus open tasks that are due today or overdue.
export function openDueToday(t) {
  return [
    ...t.items.filter((i) => i.status === 'open'),
    ...t.tasks.filter((k) => k.status === 'open' && k.dueDate && k.dueDate <= t.today),
  ];
}

// ---------- The morning oath ----------

export async function commitDay({ focusKind, focusId, intention }) {
  const { today } = await localNow();
  const [existing] = await db()`select 1 from day_plans where date = ${today}`;
  if (existing) throw new RuleError('You already took today\'s oath.', 409);
  const t = await buildToday();
  const item = findItem(t, focusKind, focusId);
  if (!item || item.status !== 'open') throw new RuleError('Pick one of today\'s open items as your one thing.');
  const text = String(intention || '').trim().slice(0, 300);
  await db()`insert into day_plans (date, focus_kind, focus_id, focus_title, intention, committed_at)
             values (${today}, ${focusKind}, ${item.id}, ${item.title}, ${text}, ${ts()})`;
  await logEvent('day_committed', { date: today, focus: item.title, intention: text });
  // A plain plan is written straight away; the coach replaces it when it has written its own.
  await battlePlan(today, { background: true });
  return { ok: true };
}

// ---------- Focus blocks ----------

export async function startFocus({ kind, id, minutes }) {
  const { today } = await localNow();
  const [running] = await db()`select id, title from focus_sessions where ended_at is null`;
  if (running) throw new RuleError(`Finish or stop the block on ${running.title} first.`, 409);
  const t = await buildToday();
  const item = findItem(t, kind, id);
  if (!item || item.status !== 'open') throw new RuleError('That is not open right now.');
  const m = Math.max(5, Math.min(180, Number.parseInt(minutes, 10) || 25));
  const [s] = await db()`insert into focus_sessions (kind, ref_id, title, date, minutes, started_at)
                         values (${kind}, ${item.id}, ${item.title}, ${today}, ${m}, ${ts()}) returning *`;
  await logEvent('focus_started', { kind, id: item.id, title: item.title, minutes: m });
  return s;
}

export async function finishFocus(id, outcome) {
  const [s] = await db()`select * from focus_sessions where id = ${id}`;
  if (!s || s.ended_at) throw new RuleError('That focus block is already over.', 409);
  const elapsed = Math.max(1, Math.round((nowUTC().toMillis() - new Date(s.started_at).getTime()) / 60000));
  let result = outcome === 'done' ? 'done' : 'stopped';
  let reaction;
  if (result === 'done') {
    try {
      if (s.kind === 'habit') await completeHabit(s.ref_id);
      else await completeTask(s.ref_id);
      reaction = await reactionAfterDone(s.kind, s.ref_id);
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      result = 'late';
      reaction = { text: err.message };
    }
  } else {
    reaction = { text: `Stopped after ${elapsed} min. ${s.title} is still open.` };
  }
  await db()`update focus_sessions set ended_at = ${ts()}, outcome = ${result} where id = ${id}`;
  await logEvent('focus_ended', { id, title: s.title, outcome: result, minutes: elapsed });
  return { ok: true, outcome: result, reaction };
}

// Ticking an item off directly also closes any focus block running on it.
export async function closeFocusFor(kind, id) {
  await db()`update focus_sessions set ended_at = ${ts()}, outcome = 'done'
             where ended_at is null and kind = ${kind} and ref_id = ${id}`;
}

// ---------- Dodges ----------

export async function defer({ kind, id, reason, moveToTomorrow }) {
  const { today, tz } = await localNow();
  const t = await buildToday();
  const item = findItem(t, kind, id);
  if (!item || item.status !== 'open') throw new RuleError('That is not open right now.');
  const why = String(reason || '').trim().slice(0, 300);
  if (why.length < 2) throw new RuleError('Say why. One word is enough.');
  let moved = null;
  if (moveToTomorrow) {
    if (kind !== 'task') throw new RuleError('Habits cannot be moved. Do it or take the hit.');
    if (item.heavy) throw new RuleError('Hard tasks cannot be moved.');
    moved = addDays(today, 1, tz);
    await updateTask(item.id, { due_date: moved }, { validTime, validDate });
  }
  await db()`insert into deferrals (kind, ref_id, title, date, reason, moved_to, at)
             values (${kind}, ${item.id}, ${item.title}, ${today}, ${why}, ${moved}, ${ts()})`;
  await logEvent('deferred', { kind, id: item.id, title: item.title, reason: why, moved });
  const weekStart = addDays(today, -6, tz);
  const [{ n }] = await db()`select count(*)::int as n from deferrals where date >= ${weekStart}`;
  const [{ same }] = await db()`select count(*)::int as same from deferrals where date >= ${weekStart} and lower(reason) = lower(${why})`;
  const parts = [];
  parts.push(moved ? `${item.title} moved to tomorrow.` : `Logged: "${why}".`);
  parts.push(`${n} ${n === 1 ? 'dodge' : 'dodges'} this week${same > 1 ? `, ${same} of them "${why}"` : ''}.`);
  if (!moved && item.dueAt) parts.push(`The deadline does not move: ${item.deadline || '23:59'}.`);
  return { ok: true, reaction: { text: parts.join(' ') } };
}

// ---------- Closing the day ----------

export async function reflect({ rating, blocker, win }) {
  const { today } = await localNow();
  const r = Number.parseInt(rating, 10);
  if (!(r >= 1 && r <= 5)) throw new RuleError('Rate the day from 1 to 5.');
  const b = String(blocker || '').trim().slice(0, 500);
  const w = String(win || '').trim().slice(0, 500);
  await db()`insert into reflections (date, rating, blocker, win, at) values (${today}, ${r}, ${b}, ${w}, ${ts()})
             on conflict (date) do update set rating = excluded.rating, blocker = excluded.blocker, win = excluded.win, at = excluded.at, coach_reply = null`;
  await logEvent('reflection', { date: today, rating: r, blocker: b, win: w });
  const reply = await reflectionReply(today);
  return { ok: true, reply };
}

// ---------- Reactions ----------

const MILESTONES = [3, 7, 14, 21, 30, 50, 75, 100, 150, 200, 365];

export async function reactionAfterDone(kind, id) {
  const t = await buildToday();
  const item = findItem(t, kind, id);
  const open = openDueToday(t);
  if (!item) return { text: 'Done.' };
  const hadWork = t.items.length + t.tasks.filter((k) => k.dueDate && k.dueDate <= t.today).length > 0;
  if (!open.length && hadWork) {
    return { text: `Clean sweep. Everything due today is done. Keep it clean to midnight for +${t.settings.cleanBonus} HP.`, big: true };
  }
  if (kind === 'habit' && MILESTONES.includes(item.streak)) {
    return { text: `${item.title}: ${item.streak} days straight. Do not break it now.${t.next ? ` Next: ${t.next.title}.` : ''}`, big: true };
  }
  const parts = [`${item.title} done.`];
  if (open.length) parts.push(`${open.length} left today.`);
  if (t.next) parts.push(`Next: ${t.next.title}${t.next.deadline ? ` by ${t.next.deadline}` : ''}.`);
  return { text: parts.join(' ') };
}
