// Pure scheduling rules for habits. No database access here, so every module can share them.
import { addDays, weekday } from './time.js';

export function rulesOn(habit, date) {
  const base = {
    days: habit.days,
    deadline: habit.deadline,
    non_negotiable: habit.non_negotiable,
    penalty: habit.penalty,
    minimum: habit.minimum || '',
    weekly_target: habit.weekly_target || null,
  };
  if (habit.next_rules && habit.next_rules_from && date >= habit.next_rules_from) {
    return { ...base, ...habit.next_rules };
  }
  return base;
}

export function isActive(habit, date) {
  if (date < habit.start_date) return false;
  return !(habit.archived_from && date >= habit.archived_from);
}

// "X times a week" habits are judged once per week, not per day.
export function isFlexible(habit, date) {
  return Boolean(rulesOn(habit, date).weekly_target);
}

// A fixed-day habit that is due on this date. Rest days excuse every fixed habit.
export function isScheduled(habit, date, tz, rest = null) {
  if (!isActive(habit, date)) return false;
  const r = rulesOn(habit, date);
  if (r.weekly_target) return false;
  if (rest && rest.has(date)) return false;
  return r.days.includes(weekday(date, tz));
}

export function weekStartOf(date, tz) {
  return addDays(date, 1 - weekday(date, tz), tz);
}

export function weekDates(weekStart, tz) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i, tz));
}

// The weekly target, scaled down when the habit started mid-week or rest days were booked.
export function weekTargetFor(habit, weekStart, tz, rest = null) {
  const dates = weekDates(weekStart, tz);
  const target = rulesOn(habit, dates[6]).weekly_target;
  if (!target) return 0;
  const eligible = dates.filter((d) => isActive(habit, d) && isFlexible(habit, d) && !(rest && rest.has(d))).length;
  if (eligible >= 7) return target;
  return Math.min(target, Math.round((target * eligible) / 7));
}

// The scheduled day before this one, for "never miss twice".
export function previousOccurrence(habit, date, tz, rest = null) {
  let d = addDays(date, -1, tz);
  for (let i = 0; i < 28 && d >= habit.start_date; i += 1) {
    if (isScheduled(habit, d, tz, rest)) return d;
    d = addDays(d, -1, tz);
  }
  return null;
}
