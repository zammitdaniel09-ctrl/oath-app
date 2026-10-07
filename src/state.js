// Read models for the UI and the coach.
import { db } from './db.js';
import { nowUTC, addDays, deadlineAt } from './time.js';
import { localNow, getGame, isScheduled, rulesOn } from './engine.js';

async function streaksFor(habits, today, tz, seasonStart) {
  if (!habits.length) return new Map();
  const ids = habits.map((h) => h.id);
  const kept = await db()`select habit_id, date from completions where habit_id in ${db()(ids)} and date >= ${seasonStart}`;
  const pardoned = await db()`select ref_id, date from misses where kind = 'habit' and pardoned_at is not null
                              and ref_id in ${db()(ids)} and date >= ${seasonStart}`;
  const good = new Set([...kept.map((r) => `${r.habit_id}:${r.date}`), ...pardoned.map((r) => `${r.ref_id}:${r.date}`)]);
  const out = new Map();
  for (const h of habits) {
    let streak = 0;
    let d = today;
    const floor = h.start_date > seasonStart ? h.start_date : seasonStart;
    for (let i = 0; i < 500 && d >= floor; i += 1) {
      if (isScheduled(h, d, tz)) {
        if (good.has(`${h.id}:${d}`)) streak += 1;
        else if (d !== today) break;
      }
      d = addDays(d, -1, tz);
    }
    out.set(h.id, streak);
  }
  return out;
}

export async function buildToday() {
  const { s, local, today, tz } = await localNow();
  const game = await getGame();
  const habits = await db()`select * from habits where archived_from is null or archived_from > ${today} order by sort, id`;
  const comps = new Map((await db()`select * from completions where date = ${today}`).map((c) => [c.habit_id, c]));
  const todaysMisses = await db()`select * from misses where date = ${today}`;
  const missByRef = new Map(todaysMisses.map((m) => [`${m.kind}:${m.ref_id}`, m]));
  const scheduled = habits.filter((h) => isScheduled(h, today, tz));
  const streaks = await streaksFor(scheduled, today, tz, game.seasonStart);

  const items = scheduled.map((h) => {
    const r = rulesOn(h, today);
    const due = deadlineAt(today, r.deadline, tz);
    const c = comps.get(h.id);
    const m = missByRef.get(`habit:${h.id}`);
    const status = c ? 'kept' : m ? (m.pardoned_at ? 'pardoned' : 'missed') : 'open';
    const ageMin = c ? (nowUTC().toMillis() - new Date(c.completed_at).getTime()) / 60000 : Infinity;
    return {
      kind: 'habit',
      id: h.id,
      title: h.name,
      notes: h.notes,
      deadline: r.deadline,
      dueAt: due.toISO(),
      heavy: r.non_negotiable,
      penalty: r.penalty,
      status,
      keptAt: c ? new Date(c.completed_at).toISOString() : null,
      canUndo: Boolean(c) && ageMin <= s.undoMinutes && local < due,
      missId: m ? m.id : null,
      streak: streaks.get(h.id) || 0,
      rulesChangeFrom: h.next_rules_from || null,
    };
  });

  const taskRows = await db()`
    select * from tasks where deleted_at is null and (
      done_at is null or (done_at at time zone ${tz})::date = ${today}::date
    ) order by hard desc, due_date nulls last, deadline nulls last, id`;
  const tasks = taskRows
    .filter((t) => !t.due_date || t.due_date <= today || t.done_at)
    .map((t) => {
      const m = missByRef.get(`task:${t.id}`);
      const due = t.due_date ? deadlineAt(t.due_date, t.deadline || '23:59', tz) : null;
      const ageMin = t.done_at ? (nowUTC().toMillis() - new Date(t.done_at).getTime()) / 60000 : Infinity;
      return {
        kind: 'task',
        id: t.id,
        title: t.title,
        notes: t.notes,
        dueDate: t.due_date,
        deadline: t.deadline,
        dueAt: due ? due.toISO() : null,
        heavy: t.hard,
        penalty: t.hard ? s.taskPenalty : 0,
        overdue: Boolean(t.due_date && t.due_date < today && !t.done_at),
        status: t.done_at ? 'done' : m ? (m.pardoned_at ? 'pardoned' : 'missed') : 'open',
        doneAt: t.done_at ? new Date(t.done_at).toISOString() : null,
        canUndo: Boolean(t.done_at) && (!t.hard || ageMin <= s.undoMinutes),
        missId: m ? m.id : null,
        createdBy: t.created_by,
      };
    });
  const upcoming = taskRows
    .filter((t) => t.due_date && t.due_date > today && !t.done_at)
    .map((t) => ({ id: t.id, title: t.title, dueDate: t.due_date, deadline: t.deadline, heavy: t.hard }));

  const recentMisses = await db()`
    select * from misses where created_at > ${nowUTC().minus({ hours: 24 }).toJSDate()} and pardoned_at is null order by created_at desc`;
  const briefs = await db()`select kind, text, at from briefs where date = ${today} order by at desc`;
  const week = await db()`select date, hp_end, clean, missed from days where date >= ${addDays(today, -13, tz)} order by date`;

  // ---------- The daily drive ----------
  const [planRow] = await db()`select * from day_plans where date = ${today}`;
  const [focusRow] = await db()`select * from focus_sessions where ended_at is null order by id desc limit 1`;
  const [reflRow] = await db()`select * from reflections where date = ${today}`;
  const recentDefer = await db()`select kind, ref_id from deferrals where at > ${nowUTC().minus({ minutes: 60 }).toJSDate()}`;
  const [{ dodges }] = await db()`select count(*)::int as dodges from deferrals where date = ${today}`;

  const openDue = [
    ...items.filter((i) => i.status === 'open'),
    ...tasks.filter((k) => k.status === 'open' && k.dueDate && k.dueDate <= today),
  ];
  const doneDue = items.filter((i) => i.status === 'kept' || i.status === 'pardoned').length
    + tasks.filter((k) => k.dueDate && k.dueDate <= today && (k.status === 'done' || k.status === 'pardoned')).length;
  const progress = {
    done: doneDue,
    total: doneDue + openDue.length + items.filter((i) => i.status === 'missed').length
      + tasks.filter((k) => k.status === 'missed').length,
    atStake: openDue.reduce((n, i) => n + (i.penalty || 0), 0),
    open: openDue.length,
  };

  // Next: soonest deadline first, undated tasks last. Something dodged in the last hour steps aside
  // unless it is due within 30 minutes. The chosen one thing jumps the queue when nothing is urgent.
  const candidates = [...openDue, ...tasks.filter((k) => k.status === 'open' && !k.dueDate)];
  const dodged = new Set(recentDefer.map((d) => `${d.kind}:${d.ref_id}`));
  const minutesLeft = (i) => (i.dueAt ? (new Date(i.dueAt).getTime() - nowUTC().toMillis()) / 60000 : Infinity);
  const sorted = [...candidates].sort((a, b) => minutesLeft(a) - minutesLeft(b));
  let queue = sorted.filter((i) => !dodged.has(`${i.kind}:${i.id}`) || minutesLeft(i) <= 30);
  if (!queue.length) queue = sorted;
  if (planRow) {
    const focusItem = queue.find((i) => i.kind === planRow.focus_kind && i.id === planRow.focus_id);
    const urgent = queue.some((i) => i !== focusItem && minutesLeft(i) <= 90);
    if (focusItem && !urgent) queue = [focusItem, ...queue.filter((i) => i !== focusItem)];
  }
  const pick = queue[0];
  const next = pick ? {
    kind: pick.kind, id: pick.id, title: pick.title, deadline: pick.deadline, dueAt: pick.dueAt,
    heavy: pick.heavy, penalty: pick.penalty,
    isFocus: Boolean(planRow && planRow.focus_kind === pick.kind && planRow.focus_id === pick.id),
  } : null;

  return {
    now: local.toISO(),
    today,
    timezone: tz,
    game: { ...game, maxHp: s.maxHp },
    items,
    tasks,
    upcoming,
    pardonable: recentMisses.map((m) => ({ id: m.id, title: m.title, date: m.date, hpLost: m.hp_lost })),
    briefs: briefs.map((b) => ({ kind: b.kind, text: b.text, at: b.at })),
    recentDays: week,
    settings: s,
    aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    plan: planRow ? {
      focusKind: planRow.focus_kind, focusId: planRow.focus_id, focusTitle: planRow.focus_title,
      intention: planRow.intention, coachPlan: planRow.coach_plan, committedAt: planRow.committed_at,
    } : null,
    focus: focusRow ? {
      id: focusRow.id, kind: focusRow.kind, refId: focusRow.ref_id, title: focusRow.title, minutes: focusRow.minutes,
      startedAt: new Date(focusRow.started_at).toISOString(),
      endsAt: new Date(new Date(focusRow.started_at).getTime() + focusRow.minutes * 60000).toISOString(),
    } : null,
    reflection: reflRow ? { rating: reflRow.rating, blocker: reflRow.blocker, win: reflRow.win, coachReply: reflRow.coach_reply } : null,
    dodgesToday: dodges,
    progress,
    next,
    localHour: local.hour,
  };
}

export async function buildPlan() {
  const { today, tz } = await localNow();
  const game = await getGame();
  const habits = await db()`select * from habits where archived_from is null or archived_from > ${today} order by sort, id`;
  const streaks = await streaksFor(habits, today, tz, game.seasonStart);
  const tasks = await db()`select * from tasks where deleted_at is null and done_at is null order by due_date nulls last, deadline nulls last, id`;
  return {
    today,
    habits: habits.map((h) => ({
      id: h.id,
      name: h.name,
      notes: h.notes,
      days: h.days,
      deadline: h.deadline,
      non_negotiable: h.non_negotiable,
      penalty: h.penalty,
      startDate: h.start_date,
      archivedFrom: h.archived_from,
      nextRules: h.next_rules,
      nextRulesFrom: h.next_rules_from,
      streak: streaks.get(h.id) || 0,
    })),
    tasks: tasks.map((t) => ({
      id: t.id, title: t.title, notes: t.notes, dueDate: t.due_date, deadline: t.deadline, hard: t.hard,
      locked: Boolean(t.hard && t.due_date && t.due_date <= today), createdBy: t.created_by,
    })),
  };
}

export async function buildLedger() {
  const { today, tz } = await localNow();
  const game = await getGame();
  const days = await db()`select * from days order by date desc limit 90`;
  const misses = await db()`select * from misses order by created_at desc limit 200`;
  const deaths = await db()`select data, at from events where type = 'death' order by at desc limit 50`;
  const habits = await db()`select * from habits order by sort, id`;
  const since = addDays(today, -29, tz);
  const kept30 = await db()`select habit_id, count(*)::int as n from completions where date >= ${since} group by habit_id`;
  const keptMap = new Map(kept30.map((r) => [r.habit_id, r.n]));
  const streaks = await streaksFor(habits.filter((h) => !h.archived_from || h.archived_from > today), today, tz, game.seasonStart);
  // Today only counts once it is decided (kept or missed), so an open habit does not look like a failure.
  const decidedToday = new Set([
    ...(await db()`select habit_id from completions where date = ${today}`).map((r) => r.habit_id),
    ...(await db()`select ref_id from misses where kind = 'habit' and date = ${today}`).map((r) => r.ref_id),
  ]);
  const habitStats = habits
    .filter((h) => !h.archived_from || h.archived_from > today)
    .map((h) => {
      let scheduled = 0;
      for (let d = since; d < today; d = addDays(d, 1, tz)) if (isScheduled(h, d, tz)) scheduled += 1;
      if (isScheduled(h, today, tz) && decidedToday.has(h.id)) scheduled += 1;
      return { id: h.id, name: h.name, streak: streaks.get(h.id) || 0, kept30: keptMap.get(h.id) || 0, scheduled30: scheduled };
    });
  return {
    game,
    days,
    misses: misses.map((m) => ({
      id: m.id, kind: m.kind, title: m.title, date: m.date, hpLost: m.hp_lost,
      pardoned: Boolean(m.pardoned_at), reason: m.pardon_reason,
    })),
    deaths: deaths.map((d) => ({ ...d.data, at: d.at })),
    habitStats,
  };
}

// A compact plain-text snapshot of everything the coach needs to judge the day.
export async function coachSnapshot() {
  const t = await buildToday();
  const { tz } = await localNow();
  const g = t.game;
  const lines = [];
  lines.push(`Now: ${t.now} (${tz}). Today is ${t.today}.`);
  lines.push(`HP ${g.hp}/${g.maxHp}. Season ${g.season} started ${g.seasonStart}. Deaths so far: ${g.deaths}. Pardons left this month: ${g.pardonsLeft}.`);
  lines.push('Today, habits:');
  if (!t.items.length) lines.push('  none scheduled');
  for (const i of t.items) {
    lines.push(`  [${i.status}] ${i.title} | due ${i.deadline} | ${i.heavy ? 'NON-NEGOTIABLE' : 'normal'} | penalty ${i.penalty} HP | streak ${i.streak}${i.keptAt ? ` | kept at ${i.keptAt}` : ''}`);
  }
  lines.push('Today, tasks:');
  if (!t.tasks.length) lines.push('  none');
  for (const k of t.tasks) {
    lines.push(`  [${k.status}${k.overdue ? ', OVERDUE' : ''}] #${k.id} ${k.title}${k.dueDate ? ` | due ${k.dueDate} ${k.deadline || ''}` : ' | no date'}${k.heavy ? ' | HARD' : ''}`);
  }
  if (t.upcoming.length) {
    lines.push('Upcoming tasks:');
    for (const k of t.upcoming.slice(0, 15)) lines.push(`  #${k.id} ${k.title} | due ${k.dueDate} ${k.deadline || ''}${k.heavy ? ' | HARD' : ''}`);
  }
  const days = await db()`select * from days order by date desc limit 14`;
  if (days.length) {
    lines.push('Last days (newest first):');
    for (const d of days) lines.push(`  ${d.date}: kept ${d.kept}, missed ${d.missed}, pardoned ${d.pardoned}, ${d.clean ? 'clean' : 'dirty'}, HP end ${d.hp_end}`);
  }
  const misses = await db()`select * from misses order by created_at desc limit 15`;
  if (misses.length) {
    lines.push('Recent misses:');
    for (const m of misses) lines.push(`  ${m.date} ${m.title} -${m.hp_lost} HP${m.pardoned_at ? ` | PARDONED, reason given: "${m.pardon_reason}"` : ''}`);
  }
  if (t.plan) {
    lines.push(`Today's oath: his one thing is "${t.plan.focusTitle}".${t.plan.intention ? ` Why it matters, in his words: "${t.plan.intention}".` : ''}`);
  } else if (t.progress.open) {
    lines.push('He has NOT taken today\'s oath yet (no one thing chosen).');
  }
  lines.push(`Progress today: ${t.progress.done} of ${t.progress.total} done, ${t.progress.atStake} HP still at stake.`);
  if (t.focus) lines.push(`He is in a ${t.focus.minutes} minute focus block on "${t.focus.title}" that started ${t.focus.startedAt}.`);
  const { tz: zone } = await localNow();
  const dodges = await db()`select * from deferrals where date >= ${addDays(t.today, -6, zone)} order by at desc limit 25`;
  if (dodges.length) {
    lines.push('Dodges in the last 7 days (he pressed "Not now" and gave a reason):');
    for (const d of dodges) lines.push(`  ${d.date} ${d.title}: "${d.reason}"${d.moved_to ? ` (moved to ${d.moved_to})` : ''}`);
  }
  const focus = await db()`select * from focus_sessions where date >= ${addDays(t.today, -6, zone)} and ended_at is not null order by id desc limit 15`;
  if (focus.length) {
    lines.push('Recent focus blocks:');
    for (const f of focus) lines.push(`  ${f.date} ${f.title}: ${f.minutes} min planned, ${f.outcome}`);
  }
  const refl = await db()`select * from reflections order by date desc limit 7`;
  if (refl.length) {
    lines.push('His own end-of-day reflections (newest first):');
    for (const r of refl) lines.push(`  ${r.date}: rated ${r.rating}/5${r.blocker ? `, got in the way: "${r.blocker}"` : ''}${r.win ? `, win: "${r.win}"` : ''}`);
  }
  return lines.join('\n');
}
