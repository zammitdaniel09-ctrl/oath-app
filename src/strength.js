// Habit strength: an exponentially weighted score that rises with every repetition and decays
// slowly after a miss, modelled on Loop Habit Tracker. A perfect month reaches about 80% and two
// months about 96%. One miss costs a few points and never resets it to zero, which matches the
// finding that a single missed day does not slow habit formation (Lally et al. 2010).
import { db } from './db.js';
import { addDays } from './time.js';
import { rulesOn, isActive, isScheduled, isFlexible, weekStartOf, weekDates, weekTargetFor, previousOccurrence } from './rules.js';

export async function restSet(tx = db()) {
  const rows = await tx`select date from rest_days`;
  return new Set(rows.map((r) => r.date));
}

export async function habitStats(habits, asOf, tz, { heatDays = 84 } = {}) {
  const out = new Map();
  if (!habits.length) return out;
  const ids = habits.map((h) => h.id);
  const from = addDays(asOf, -400, tz);
  const comps = await db()`select habit_id, date, minimum from completions where habit_id in ${db()(ids)} and date >= ${from} and date <= ${asOf}`;
  const misses = await db()`select ref_id, date, pardoned_at, pardon_plan, created_at from misses
                            where kind = 'habit' and ref_id in ${db()(ids)} order by created_at`;
  const rest = await restSet();
  const compBy = new Map();
  for (const c of comps) compBy.set(`${c.habit_id}:${c.date}`, c);
  const missBy = new Map();
  const planBy = new Map();
  for (const m of misses) {
    missBy.set(`${m.ref_id}:${m.date}`, m);
    if (m.pardon_plan) planBy.set(m.ref_id, m.pardon_plan);
  }

  for (const h of habits) {
    const key = (d) => `${h.id}:${d}`;
    const flexibleNow = isFlexible(h, asOf);
    let score = 0;
    const startScan = h.start_date > from ? h.start_date : from;

    if (!flexibleNow) {
      const perWeek = Math.max(1, rulesOn(h, asOf).days.length);
      const m = 0.2 ** (1 / ((perWeek * 30) / 7));
      for (let d = startScan; d <= asOf; d = addDays(d, 1, tz)) {
        if (!isScheduled(h, d, tz, rest)) continue;
        const done = compBy.get(key(d));
        const miss = missBy.get(key(d));
        if (d === asOf && !done && !miss) continue; // today is still open
        const value = done ? (done.minimum ? 0.5 : 1) : miss?.pardoned_at ? 1 : 0;
        score = score * m + value * (1 - m);
      }
    } else {
      const m = 0.2 ** (1 / 4.3);
      const currentWeek = weekStartOf(asOf, tz);
      for (let w = weekStartOf(startScan, tz); w <= currentWeek; w = addDays(w, 7, tz)) {
        const target = weekTargetFor(h, w, tz, rest);
        if (!target) continue;
        const dates = weekDates(w, tz).filter((d) => d <= asOf);
        const done = dates.reduce((n, d) => n + (compBy.get(key(d)) ? (compBy.get(key(d)).minimum ? 0.5 : 1) : 0), 0);
        const miss = missBy.get(key(addDays(w, 6, tz)));
        if (w === currentWeek && done < target) continue; // this week is still open
        const value = miss?.pardoned_at ? 1 : Math.min(1, done / target);
        score = score * m + value * (1 - m);
      }
    }

    // Last 14 days, for the honest "kept X of Y" line.
    let kept14 = 0;
    let sched14 = 0;
    for (let i = 13; i >= 0; i -= 1) {
      const d = addDays(asOf, -i, tz);
      if (!isScheduled(h, d, tz, rest)) continue;
      const done = compBy.get(key(d));
      const miss = missBy.get(key(d));
      if (d === asOf && !done && !miss) continue;
      sched14 += 1;
      if (done || miss?.pardoned_at) kept14 += 1;
    }

    // Heatmap, oldest first.
    const heat = [];
    for (let i = heatDays - 1; i >= 0; i -= 1) {
      const d = addDays(asOf, -i, tz);
      let s = 'off';
      if (!isActive(h, d)) s = 'off';
      else if (rest.has(d)) s = 'rest';
      else {
        const done = compBy.get(key(d));
        const miss = missBy.get(key(d));
        if (done) s = done.minimum ? 'min' : 'kept';
        else if (miss) s = miss.pardoned_at ? 'pardoned' : 'missed';
        else if (isFlexible(h, d)) s = 'flex';
        else if (isScheduled(h, d, tz, rest)) s = d === asOf ? 'open' : 'none';
      }
      heat.push({ date: d, s });
    }

    // This week, for X-a-week habits.
    let weekDone = 0;
    let weekTarget = 0;
    if (flexibleNow) {
      const w = weekStartOf(asOf, tz);
      weekTarget = weekTargetFor(h, w, tz, rest);
      weekDone = weekDates(w, tz).filter((d) => d <= asOf && compBy.get(key(d))).length;
    }

    const prev = flexibleNow ? addDays(weekStartOf(asOf, tz), -1, tz) : previousOccurrence(h, asOf, tz, rest);
    const prevMiss = prev ? missBy.get(key(prev)) : null;

    out.set(h.id, {
      strength: Math.round(score * 100),
      kept14,
      sched14,
      heat,
      weekDone,
      weekTarget,
      missedLast: Boolean(prevMiss && !prevMiss.pardoned_at),
      lastPlan: planBy.get(h.id) || null,
      buildingDay: Math.max(1, Math.round((new Date(`${asOf}T12:00:00Z`) - new Date(`${h.start_date}T12:00:00Z`)) / 86400000) + 1),
    });
  }
  return out;
}

export async function strengthOf(habit, asOf, tz) {
  const map = await habitStats([habit], asOf, tz, { heatDays: 1 });
  return map.get(habit.id)?.strength ?? 0;
}
