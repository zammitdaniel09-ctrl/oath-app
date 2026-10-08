// Read models for the UI and the coach.
import { db } from './db.js';
import { nowUTC, addDays, deadlineAt, weekday } from './time.js';
import { localNow, getGame, rulesOn } from './engine.js';
import { isActive, isScheduled, isFlexible, weekStartOf, weekDates, weekTargetFor } from './rules.js';
import { habitStats, restSet } from './strength.js';
import { listGoals } from './goals.js';
import { busyMinutes, calendarForCoach, eventsForDate } from './calendar.js';
import { businessForCoach } from './business.js';

// health.js is imported lazily: state > health > push > telegram > state would be a cycle.
const health = () => import('./health.js');

// Streaks count consecutive kept occurrences this season (weeks, for X-a-week habits).
async function streaksFor(habits, today, tz, seasonStart, rest) {
  if (!habits.length) return new Map();
  const ids = habits.map((h) => h.id);
  const kept = await db()`select habit_id, date from completions where habit_id in ${db()(ids)} and date >= ${seasonStart}`;
  const pardoned = await db()`select ref_id, date from misses where kind = 'habit' and pardoned_at is not null
                              and ref_id in ${db()(ids)} and date >= ${seasonStart}`;
  const good = new Set([...kept.map((r) => `${r.habit_id}:${r.date}`), ...pardoned.map((r) => `${r.ref_id}:${r.date}`)]);
  const out = new Map();
  for (const h of habits) {
    let streak = 0;
    const floor = h.start_date > seasonStart ? h.start_date : seasonStart;
    if (isFlexible(h, today)) {
      for (let w = weekStartOf(today, tz), i = 0; i < 60 && addDays(w, 6, tz) >= floor; w = addDays(w, -7, tz), i += 1) {
        const target = weekTargetFor(h, w, tz, rest);
        if (!target) continue;
        const dates = weekDates(w, tz).filter((d) => d <= today && d >= floor);
        const done = dates.filter((d) => good.has(`${h.id}:${d}`)).length;
        const pardonedWeek = good.has(`${h.id}:${addDays(w, 6, tz)}`) && !kept.some((k) => k.habit_id === h.id && k.date === addDays(w, 6, tz));
        if (done >= target || pardonedWeek) streak += 1;
        else if (w !== weekStartOf(today, tz)) break;
      }
    } else {
      let d = today;
      for (let i = 0; i < 500 && d >= floor; i += 1) {
        if (isScheduled(h, d, tz, rest)) {
          if (good.has(`${h.id}:${d}`)) streak += 1;
          else if (d !== today) break;
        }
        d = addDays(d, -1, tz);
      }
    }
    out.set(h.id, streak);
  }
  return out;
}

const minutesUntil = (iso) => (iso ? (new Date(iso).getTime() - nowUTC().toMillis()) / 60000 : Infinity);

export async function buildToday() {
  const { s, local, today, tz } = await localNow();
  const game = await getGame();
  const rest = await restSet();
  const isRest = rest.has(today);
  const habits = (await db()`select * from habits order by sort, id`).filter((h) => isActive(h, today));
  const comps = new Map((await db()`select * from completions where date = ${today}`).map((c) => [c.habit_id, c]));
  const todaysMisses = await db()`select * from misses where date = ${today}`;
  const missByRef = new Map(todaysMisses.map((m) => [`${m.kind}:${m.ref_id}`, m]));
  const scheduled = habits.filter((h) => isScheduled(h, today, tz, rest));
  const flexible = habits.filter((h) => isFlexible(h, today));
  const shown = [...scheduled, ...flexible];
  const streaks = await streaksFor(shown, today, tz, game.seasonStart, rest);
  const stats = await habitStats(shown, today, tz, { heatDays: 1 });
  const remainingDays = weekDates(weekStartOf(today, tz), tz).filter((d) => d >= today && !rest.has(d)).length;

  const habitItem = (h) => {
    const r = rulesOn(h, today);
    const due = deadlineAt(today, r.deadline, tz);
    const c = comps.get(h.id);
    const m = missByRef.get(`habit:${h.id}`);
    const st = stats.get(h.id) || {};
    const ageMin = c ? (nowUTC().toMillis() - new Date(c.completed_at).getTime()) / 60000 : Infinity;
    const item = {
      kind: 'habit',
      id: h.id,
      title: h.name,
      notes: h.notes,
      cue: h.cue,
      ifThen: h.if_then,
      minimum: r.minimum,
      deadline: r.deadline,
      dueAt: due.toISO(),
      heavy: r.non_negotiable,
      penalty: r.penalty,
      status: c ? 'kept' : m ? (m.pardoned_at ? 'pardoned' : 'missed') : 'open',
      keptAt: c ? new Date(c.completed_at).toISOString() : null,
      keptMinimum: Boolean(c?.minimum),
      comeback: Boolean(c?.comeback),
      canUndo: Boolean(c) && ageMin <= s.undoMinutes && local < due,
      missId: m ? m.id : null,
      missRepeat: Boolean(m?.repeat),
      streak: streaks.get(h.id) || 0,
      strength: st.strength ?? 0,
      kept14: st.kept14 ?? 0,
      sched14: st.sched14 ?? 0,
      missedLast: Boolean(st.missedLast) && !c,
      lastPlan: st.lastPlan || null,
      buildingDay: st.buildingDay || 1,
      goalId: h.goal_id,
      rulesChangeFrom: h.next_rules_from || null,
      keptBy: c?.source || null,
      auto: h.auto_metric ? { metric: h.auto_metric, target: h.auto_target, filter: h.auto_filter || '' } : null,
      flexible: false,
    };
    if (isFlexible(h, today)) {
      const needed = (st.weekTarget || 0) - (st.weekDone || 0);
      Object.assign(item, {
        flexible: true,
        weekDone: st.weekDone || 0,
        weekTarget: st.weekTarget || 0,
        mustToday: !c && needed > 0 && needed >= remainingDays,
        status: c ? 'kept' : needed <= 0 ? 'met' : 'open',
        penalty: Math.ceil((r.penalty * Math.max(1, needed)) / Math.max(1, st.weekTarget || 1)),
      });
    }
    return item;
  };
  const items = shown.map(habitItem);

  const taskRows = await db()`
    select t.*, g.title as goal_title from tasks t left join goals g on g.id = t.goal_id
    where t.deleted_at is null and (t.done_at is null or (t.done_at at time zone ${tz})::date = ${today}::date)
    order by t.hard desc, t.due_date nulls last, t.deadline nulls last, t.id`;
  const taskItem = (t) => {
    const m = missByRef.get(`task:${t.id}`);
    const due = t.due_date ? deadlineAt(t.due_date, t.deadline || '23:59', tz) : null;
    const ageMin = t.done_at ? (nowUTC().toMillis() - new Date(t.done_at).getTime()) / 60000 : Infinity;
    return {
      kind: 'task',
      id: t.id,
      title: t.title,
      notes: t.notes,
      firstStep: t.first_step,
      estimate: t.estimate_min,
      goalId: t.goal_id,
      goalTitle: t.goal_title,
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
      ageDays: Math.floor((nowUTC().toMillis() - new Date(t.created_at).getTime()) / 86400000),
    };
  };
  const all = taskRows.map(taskItem);
  // Today shows what is due today, hard tasks that slipped, and what was done today.
  const tasks = all.filter((k) => k.status === 'done' || (k.dueDate && (k.dueDate === today || (k.dueDate < today && k.heavy))));
  // Overdue and stale normal tasks become one decision each instead of a growing red pile.
  const triage = all.filter((k) => k.status === 'open' && !k.heavy
    && ((k.dueDate && k.dueDate < today) || (!k.dueDate && k.ageDays >= 7)));
  const anytime = all.filter((k) => k.status === 'open' && !k.dueDate && k.ageDays < 7);
  const upcoming = taskRows
    .filter((t) => t.due_date && t.due_date > today && !t.done_at)
    .map((t) => ({ id: t.id, title: t.title, dueDate: t.due_date, deadline: t.deadline, heavy: t.hard }));

  const recentMisses = await db()`
    select * from misses where created_at > ${nowUTC().minus({ hours: 24 }).toJSDate()} and pardoned_at is null order by created_at desc`;
  const briefs = await db()`select kind, text, at from briefs where date = ${today} order by at desc`;
  const week = await db()`select date, hp_end, clean, missed, rest from days where date >= ${addDays(today, -13, tz)} order by date`;

  // ---------- The daily drive ----------
  const [planRow] = await db()`select * from day_plans where date = ${today}`;
  const [focusRow] = await db()`select * from focus_sessions where ended_at is null order by id desc limit 1`;
  const [reflRow] = await db()`select * from reflections where date = ${today}`;
  const [lastNight] = await db()`select tomorrow from reflections where date = ${addDays(today, -1, tz)}`;
  const recentDefer = await db()`select kind, ref_id from deferrals where at > ${nowUTC().minus({ minutes: 60 }).toJSDate()}`;
  const [{ dodges }] = await db()`select count(*)::int as dodges from deferrals where date = ${today}`;

  const openDue = [
    ...items.filter((i) => i.status === 'open' && (!i.flexible || i.mustToday)),
    ...tasks.filter((k) => k.status === 'open' && k.dueDate && k.dueDate <= today),
  ];
  const doneDue = items.filter((i) => i.status === 'kept' || i.status === 'pardoned').length
    + tasks.filter((k) => k.dueDate && k.dueDate <= today && (k.status === 'done' || k.status === 'pardoned')).length;
  const missedToday = items.filter((i) => i.status === 'missed').length + tasks.filter((k) => k.status === 'missed').length;
  const progress = {
    done: doneDue,
    total: doneDue + openDue.length + missedToday,
    atStake: openDue.reduce((n, i) => n + (i.penalty || 0), 0),
    open: openDue.length,
  };

  // Next: soonest deadline first. Something dodged in the last hour steps aside unless it is due
  // within 30 minutes. When nothing is urgent, the oath's one thing goes first, then anything
  // missed last time ("never miss twice"), then open X-a-week habits and undated tasks.
  const later = [
    ...items.filter((i) => i.flexible && i.status === 'open' && !i.mustToday),
    ...anytime,
  ];
  const dodged = new Set(recentDefer.map((d) => `${d.kind}:${d.ref_id}`));
  const sorted = [...openDue].sort((a, b) => minutesUntil(a.dueAt) - minutesUntil(b.dueAt) || (b.missedLast ? 1 : 0) - (a.missedLast ? 1 : 0));
  let queue = [...sorted, ...later].filter((i) => !dodged.has(`${i.kind}:${i.id}`) || minutesUntil(i.dueAt) <= 30);
  if (!queue.length) queue = [...sorted, ...later];
  const urgentExcept = (x) => queue.some((i) => i !== x && minutesUntil(i.dueAt) <= 90);
  const focusItem = planRow ? queue.find((i) => i.kind === planRow.focus_kind && i.id === planRow.focus_id) : null;
  if (focusItem && !urgentExcept(focusItem)) queue = [focusItem, ...queue.filter((i) => i !== focusItem)];
  else {
    const relapse = queue.find((i) => i.missedLast);
    if (relapse && !urgentExcept(relapse)) queue = [relapse, ...queue.filter((i) => i !== relapse)];
  }
  const pick = queue[0];
  const next = pick ? {
    kind: pick.kind, id: pick.id, title: pick.title, deadline: pick.deadline, dueAt: pick.dueAt,
    heavy: pick.heavy, penalty: pick.penalty, cue: pick.cue || '', minimum: pick.minimum || '',
    firstStep: pick.firstStep || '', missedLast: Boolean(pick.missedLast), flexible: Boolean(pick.flexible),
    weekDone: pick.weekDone, weekTarget: pick.weekTarget, lastPlan: pick.lastPlan || null,
    isFocus: Boolean(planRow && planRow.focus_kind === pick.kind && planRow.focus_id === pick.id),
  } : null;

  // Capacity: estimated task time against the free time left before the day ends (planning
  // fallacy). Time already booked in his calendars is not free.
  const estimated = openDue.filter((i) => i.kind === 'task').reduce((n, k) => n + (k.estimate || 0), 0);
  const dayEnd = deadlineAt(today, s.dayEnd || '22:00', tz);
  const left = Math.max(0, Math.round(dayEnd.diff(local, 'minutes').minutes));
  const busy = left ? await busyMinutes(today, local.toFormat('HH:mm'), s.dayEnd || '22:00').catch(() => 0) : 0;
  const available = Math.max(0, left - busy);
  const capacity = estimated ? { estimated, available, busy, over: Math.max(0, estimated - available) } : null;
  const calendar = await eventsForDate(today).catch(() => []);
  const healthToday = await (await health()).todayHealth().catch(() => null);

  // Weekly review: last week's, available Monday to Sunday until done, prompted on Monday and Tuesday.
  const lastWeek = addDays(weekStartOf(today, tz), -7, tz);
  const [review] = await db()`select focus, done_at from weekly_reviews where week_start = ${lastWeek}`;
  const [{ hadLastWeek }] = await db()`select count(*)::int as "hadLastWeek" from days where date >= ${lastWeek} and date < ${weekStartOf(today, tz)}`;
  const goals = (await listGoals()).slice(0, 3);

  return {
    now: local.toISO(),
    today,
    timezone: tz,
    game: { ...game, maxHp: s.maxHp },
    items,
    tasks,
    triage,
    anytime,
    openDue: openDue.map((i) => ({ kind: i.kind, id: i.id, title: i.title, deadline: i.deadline, penalty: i.penalty, heavy: i.heavy, dueAt: i.dueAt })),
    upcoming,
    pardonable: recentMisses.map((m) => ({ id: m.id, title: m.title, date: m.date, hpLost: m.hp_lost })),
    briefs: briefs.map((b) => ({ kind: b.kind, text: b.text, at: b.at })),
    recentDays: week,
    settings: s,
    aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    rest: isRest,
    plan: planRow ? {
      focusKind: planRow.focus_kind, focusId: planRow.focus_id, focusTitle: planRow.focus_title,
      intention: planRow.intention, coachPlan: planRow.coach_plan, committedAt: planRow.committed_at,
    } : null,
    focus: focusRow ? {
      id: focusRow.id, kind: focusRow.kind, refId: focusRow.ref_id, title: focusRow.title, minutes: focusRow.minutes,
      startedAt: new Date(focusRow.started_at).toISOString(),
      endsAt: new Date(new Date(focusRow.started_at).getTime() + focusRow.minutes * 60000).toISOString(),
    } : null,
    reflection: reflRow ? { rating: reflRow.rating, blocker: reflRow.blocker, win: reflRow.win, tomorrow: reflRow.tomorrow, coachReply: reflRow.coach_reply } : null,
    lastNight: lastNight?.tomorrow || null,
    dodgesToday: dodges,
    progress,
    capacity,
    calendar,
    health: healthToday,
    next,
    goals,
    weekFocus: review?.done_at ? review.focus : null,
    reviewDue: !review?.done_at && hadLastWeek > 0 && weekday(today, tz) <= 2,
    localHour: local.hour,
  };
}

export async function buildPlan() {
  const { today, tz } = await localNow();
  const game = await getGame();
  const rest = await restSet();
  const habits = (await db()`select h.*, g.title as goal_title from habits h left join goals g on g.id = h.goal_id
                             where h.archived_from is null or h.archived_from > ${today} order by h.sort, h.id`);
  const streaks = await streaksFor(habits, today, tz, game.seasonStart, rest);
  const stats = await habitStats(habits, today, tz, { heatDays: 84 });
  const tasks = await db()`select t.*, g.title as goal_title from tasks t left join goals g on g.id = t.goal_id
                           where t.deleted_at is null and t.done_at is null order by t.due_date nulls last, t.deadline nulls last, t.id`;
  const goals = await listGoals();
  const restDays = await db()`select date, reason from rest_days where date >= ${today} order by date`;
  const s = (await localNow()).s;
  return {
    today,
    settings: { maxNonNegotiables: s.maxNonNegotiables, restDaysPerMonth: s.restDaysPerMonth },
    habits: habits.map((h) => {
      const st = stats.get(h.id) || {};
      return {
        id: h.id,
        name: h.name,
        notes: h.notes,
        cue: h.cue,
        ifThen: h.if_then,
        minimum: h.minimum,
        weeklyTarget: h.weekly_target,
        remindAt: h.remind_at,
        days: h.days,
        deadline: h.deadline,
        non_negotiable: h.non_negotiable,
        penalty: h.penalty,
        goalId: h.goal_id,
        goalTitle: h.goal_title,
        auto: h.auto_metric ? { metric: h.auto_metric, target: h.auto_target, filter: h.auto_filter || '' } : null,
        startDate: h.start_date,
        archivedFrom: h.archived_from,
        nextRules: h.next_rules,
        nextRulesFrom: h.next_rules_from,
        streak: streaks.get(h.id) || 0,
        strength: st.strength ?? 0,
        kept14: st.kept14 ?? 0,
        sched14: st.sched14 ?? 0,
        weekDone: st.weekDone ?? 0,
        weekTarget: st.weekTarget ?? 0,
        buildingDay: st.buildingDay ?? 1,
        heat: (st.heat || []).map((x) => x.s),
      };
    }),
    tasks: tasks.map((t) => ({
      id: t.id, title: t.title, notes: t.notes, dueDate: t.due_date, deadline: t.deadline, hard: t.hard,
      firstStep: t.first_step, estimate: t.estimate_min, goalId: t.goal_id, goalTitle: t.goal_title,
      locked: Boolean(t.hard && t.due_date && t.due_date <= today), createdBy: t.created_by,
    })),
    goals: goals.map((g) => ({ id: g.id, title: g.title })),
    restDays,
  };
}

// ---------- Review: last week, this week, and the ledger ----------

async function weekSummary(weekStart, today, tz, habits) {
  const weekEnd = addDays(weekStart, 6, tz);
  const until = weekEnd < today ? weekEnd : today;
  const rest = await restSet();
  const days = await db()`select * from days where date >= ${weekStart} and date <= ${weekEnd} order by date`;
  const [before] = await db()`select hp_end from days where date < ${weekStart} order by date desc limit 1`;
  const comps = await db()`select habit_id, date, minimum from completions where date >= ${weekStart} and date <= ${until}`;
  const misses = await db()`select * from misses where date >= ${weekStart} and date <= ${weekEnd}`;
  const active = habits.filter((h) => weekDates(weekStart, tz).some((d) => isActive(h, d)));
  const end = await habitStats(active, until, tz, { heatDays: 1 });
  const start = await habitStats(active, addDays(weekStart, -1, tz), tz, { heatDays: 1 });
  const habitRows = active.map((h) => {
    const mine = comps.filter((c) => c.habit_id === h.id);
    const flex = isFlexible(h, until);
    let scheduled = 0;
    for (const d of weekDates(weekStart, tz)) if (d <= until && isScheduled(h, d, tz, rest)) scheduled += 1;
    const hm = misses.filter((m) => m.kind === 'habit' && m.ref_id === h.id);
    return {
      id: h.id,
      name: h.name,
      flexible: flex,
      done: mine.length,
      minimum: mine.filter((c) => c.minimum).length,
      target: flex ? weekTargetFor(h, weekStart, tz, rest) : scheduled,
      missed: hm.filter((m) => !m.pardoned_at).length,
      pardoned: hm.filter((m) => m.pardoned_at).length,
      strength: end.get(h.id)?.strength ?? 0,
      trend: (end.get(h.id)?.strength ?? 0) - (start.get(h.id)?.strength ?? 0),
    };
  });
  const dodges = await db()`select lower(reason) as reason, count(*)::int as n from deferrals
                            where date >= ${weekStart} and date <= ${weekEnd} group by lower(reason) order by n desc limit 6`;
  const [{ focusMin }] = await db()`select coalesce(sum(extract(epoch from (ended_at - started_at)) / 60), 0)::int as "focusMin"
                                   from focus_sessions where date >= ${weekStart} and date <= ${weekEnd} and ended_at is not null`;
  const [{ tasksDone }] = await db()`select count(*)::int as "tasksDone" from tasks
                                    where done_at is not null and (done_at at time zone ${tz})::date between ${weekStart}::date and ${weekEnd}::date`;
  const refl = await db()`select date, rating, blocker, win from reflections where date >= ${weekStart} and date <= ${weekEnd} order by date`;
  return {
    weekStart,
    weekEnd,
    hpStart: before?.hp_end ?? null,
    hpEnd: days.length ? days[days.length - 1].hp_end : null,
    cleanDays: days.filter((d) => d.clean).length,
    restDays: days.filter((d) => d.rest).length,
    judgedDays: days.length,
    misses: misses.filter((m) => !m.pardoned_at).map((m) => ({ title: m.title, date: m.date, hpLost: m.hp_lost, repeat: m.repeat })),
    pardons: misses.filter((m) => m.pardoned_at).map((m) => ({ title: m.title, reason: m.pardon_reason, plan: m.pardon_plan })),
    habits: habitRows,
    dodges,
    focusMin,
    tasksDone,
    reflections: refl,
  };
}

export async function buildReview() {
  const { today, tz } = await localNow();
  const game = await getGame();
  const habits = await db()`select * from habits order by sort, id`;
  const thisWeek = weekStartOf(today, tz);
  const lastWeek = addDays(thisWeek, -7, tz);
  const [review] = await db()`select * from weekly_reviews where week_start = ${lastWeek}`;
  const stale = await db()`select id, title, due_date, created_at from tasks
                           where deleted_at is null and done_at is null and not hard
                             and ((due_date is not null and due_date < ${today}) or (due_date is null and created_at < ${nowUTC().minus({ days: 7 }).toJSDate()}))
                           order by created_at limit 12`;
  const days = await db()`select * from days order by date desc limit 90`;
  const misses = await db()`select * from misses order by created_at desc limit 200`;
  const deaths = await db()`select data, at from events where type = 'death' order by at desc limit 50`;
  const activeNow = habits.filter((h) => !h.archived_from || h.archived_from > today);
  const stats = await habitStats(activeNow, today, tz, { heatDays: 1 });
  return {
    today,
    game,
    review: review ? {
      weekStart: review.week_start, coachText: review.coach_text, focus: review.focus,
      obstaclePlan: review.obstacle_plan, decisions: review.decisions, doneAt: review.done_at,
    } : { weekStart: lastWeek, coachText: null, focus: '', obstaclePlan: '', decisions: null, doneAt: null },
    lastWeek: await weekSummary(lastWeek, today, tz, habits),
    thisWeek: await weekSummary(thisWeek, today, tz, habits),
    stale: stale.map((t) => ({ id: t.id, title: t.title, dueDate: t.due_date })),
    goals: await listGoals(),
    habitStrength: activeNow.map((h) => ({ id: h.id, name: h.name, strength: stats.get(h.id)?.strength ?? 0, kept14: stats.get(h.id)?.kept14 ?? 0, sched14: stats.get(h.id)?.sched14 ?? 0 })),
    days,
    misses: misses.map((m) => ({
      id: m.id, kind: m.kind, title: m.title, date: m.date, hpLost: m.hp_lost, repeat: m.repeat,
      pardoned: Boolean(m.pardoned_at) && !m.overturned, overturned: Boolean(m.overturned), reason: m.pardon_reason, plan: m.pardon_plan,
    })),
    deaths: deaths.map((d) => ({ ...d.data, at: d.at })),
  };
}

// Kept for the old Ledger endpoint.
export async function buildLedger() {
  const r = await buildReview();
  return { game: r.game, days: r.days, misses: r.misses, deaths: r.deaths, habitStats: r.habitStrength };
}

// ---------- The coach's view of everything ----------

export async function coachSnapshot() {
  const t = await buildToday();
  const { tz } = await localNow();
  const g = t.game;
  const lines = [];
  lines.push(`Now: ${t.now} (${tz}). Today is ${t.today}.${t.rest ? ' Today is a booked REST DAY: fixed habits are excused.' : ''}`);
  lines.push(`HP ${g.hp}/${g.maxHp}. Season ${g.season} started ${g.seasonStart}. Deaths so far: ${g.deaths}. Pardons left this month: ${g.pardonsLeft}.`);
  if (t.weekFocus) lines.push(`This week's focus, chosen in his weekly review: "${t.weekFocus}".`);
  lines.push('Today, habits (strength is a 0-100 habit-strength score that survives misses; streak resets on a miss):');
  if (!t.items.length) lines.push('  none scheduled');
  for (const i of t.items) {
    const flex = i.flexible ? ` | ${i.weekDone} of ${i.weekTarget} this week${i.mustToday ? ', MUST be done today' : ''}` : ` | due ${i.deadline}`;
    lines.push(`  [${i.status}${i.keptMinimum ? ', minimum version' : ''}] ${i.title}${flex} | ${i.heavy ? 'NON-NEGOTIABLE' : 'normal'} | penalty ${i.penalty} HP | strength ${i.strength}% | streak ${i.streak}${i.cue ? ` | cue: "${i.cue}"` : ''}${i.minimum ? ` | minimum: "${i.minimum}"` : ''}${i.missedLast ? ' | MISSED LAST TIME' : ''}${i.lastPlan ? ` | his if-then plan: "${i.lastPlan}"` : ''}`);
  }
  lines.push('Today, tasks:');
  if (!t.tasks.length) lines.push('  none due');
  for (const k of t.tasks) {
    lines.push(`  [${k.status}${k.overdue ? ', OVERDUE' : ''}] #${k.id} ${k.title}${k.dueDate ? ` | due ${k.dueDate} ${k.deadline || ''}` : ''}${k.heavy ? ' | HARD' : ''}${k.firstStep ? ` | first step: "${k.firstStep}"` : ''}${k.estimate ? ` | est ${k.estimate} min` : ''}${k.goalTitle ? ` | goal: ${k.goalTitle}` : ''}`);
  }
  if (t.anytime.length) lines.push(`Undated tasks: ${t.anytime.map((k) => `#${k.id} ${k.title}`).join('; ')}`);
  if (t.triage.length) lines.push(`Backlog needing a decision (overdue or stale): ${t.triage.map((k) => `#${k.id} ${k.title}`).join('; ')}`);
  if (t.upcoming.length) {
    lines.push('Upcoming tasks:');
    for (const k of t.upcoming.slice(0, 15)) lines.push(`  #${k.id} ${k.title} | due ${k.dueDate} ${k.deadline || ''}${k.heavy ? ' | HARD' : ''}`);
  }
  if (t.capacity) {
    lines.push(`Capacity: ${t.capacity.estimated} min of estimated task work today, ${t.capacity.available} min of free time left before the day ends${t.capacity.busy ? ` (${t.capacity.busy} min more are booked in his calendar)` : ''}.`);
  }
  const calendarText = await calendarForCoach().catch(() => '');
  if (calendarText) lines.push(calendarText);
  const goals = await listGoals();
  if (goals.length) {
    lines.push('Active goals (WOOP):');
    for (const goal of goals) {
      lines.push(`  "${goal.title}" | progress ${goal.pct === null ? 'no steps yet' : `${goal.pct}%`} (${goal.label})${goal.targetDate ? ` | by ${goal.targetDate} (${goal.daysLeft} days)` : ''}${goal.why ? ` | why: "${goal.why}"` : ''}${goal.obstacle ? ` | obstacle: "${goal.obstacle}"` : ''}${goal.plan ? ` | plan: "${goal.plan}"` : ''} | ${goal.habitCount} habits, ${goal.taskCount} tasks`);
    }
  }
  const days = await db()`select * from days order by date desc limit 14`;
  if (days.length) {
    lines.push('Last days (newest first):');
    for (const d of days) lines.push(`  ${d.date}: ${d.rest ? 'REST DAY, ' : ''}kept ${d.kept}, missed ${d.missed}, pardoned ${d.pardoned}, ${d.clean ? 'clean' : 'not clean'}, HP end ${d.hp_end}`);
  }
  const misses = await db()`select * from misses order by created_at desc limit 15`;
  if (misses.length) {
    lines.push('Recent misses:');
    for (const m of misses) lines.push(`  ${m.date} ${m.title} -${m.hp_lost} HP${m.repeat ? ' (second miss in a row)' : ''}${m.pardoned_at ? ` | PARDONED, what got in the way: "${m.pardon_reason}", plan: "${m.pardon_plan || ''}"` : ''}`);
  }
  if (t.plan) {
    lines.push(`Today's oath: his one thing is "${t.plan.focusTitle}".${t.plan.intention ? ` When and where, in his words: "${t.plan.intention}".` : ''}`);
  } else if (t.progress.open) {
    lines.push('He has NOT taken today\'s oath yet (no one thing chosen).');
  }
  if (t.lastNight) lines.push(`Last night he planned today's one thing as: "${t.lastNight}".`);
  lines.push(`Progress today: ${t.progress.done} of ${t.progress.total} done, ${t.progress.atStake} HP still at stake.`);
  if (t.focus) lines.push(`He is in a ${t.focus.minutes} minute focus block on "${t.focus.title}" that started ${t.focus.startedAt}.`);
  const dodges = await db()`select * from deferrals where date >= ${addDays(t.today, -6, tz)} order by at desc limit 25`;
  if (dodges.length) {
    lines.push('Dodges in the last 7 days (he pressed "Not now" and gave a reason):');
    for (const d of dodges) lines.push(`  ${d.date} ${d.title}: "${d.reason}"${d.moved_to ? ` (moved to ${d.moved_to})` : ''}`);
  }
  const focus = await db()`select * from focus_sessions where date >= ${addDays(t.today, -6, tz)} and ended_at is not null order by id desc limit 15`;
  if (focus.length) {
    lines.push('Recent focus blocks:');
    for (const f of focus) lines.push(`  ${f.date} ${f.title}: ${f.minutes} min planned, ${f.outcome}`);
  }
  const refl = await db()`select * from reflections order by date desc limit 7`;
  if (refl.length) {
    lines.push('His own end-of-day reflections (newest first):');
    for (const r of refl) lines.push(`  ${r.date}: rated ${r.rating}/5${r.blocker ? `, got in the way: "${r.blocker}"` : ''}${r.win ? `, win: "${r.win}"` : ''}${r.tomorrow ? `, plan for next day: "${r.tomorrow}"` : ''}`);
  }
  const rest = await db()`select date from rest_days where date >= ${t.today} order by date limit 4`;
  if (rest.length) lines.push(`Booked rest days ahead: ${rest.map((r) => r.date).join(', ')}.`);
  const healthText = await (await health()).healthForCoach().catch(() => '');
  if (healthText) lines.push(healthText);
  const business = await businessForCoach().catch(() => '');
  if (business) lines.push(business);
  return lines.join('\n');
}
