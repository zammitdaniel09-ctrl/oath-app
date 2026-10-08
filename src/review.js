// The Monday review: a fresh-start moment to keep, adjust or drop each habit and pick the week's focus.
import { db, logEvent } from './db.js';
import { nowUTC } from './time.js';
import { RuleError, archiveHabit } from './engine.js';
import { buildReview } from './state.js';
import { writeWeeklyReview } from './coach.js';

export async function prepareReview() {
  const r = await buildReview();
  const text = await writeWeeklyReview(r.review.weekStart, r.lastWeek);
  return { text, weekStart: r.review.weekStart };
}

export async function finishReview({ decisions = {}, focus, obstaclePlan }) {
  const r = await buildReview();
  const f = String(focus || '').trim().slice(0, 300);
  if (f.length < 3) throw new RuleError('Name one or two things that matter most this week.');
  const plan = String(obstaclePlan || '').trim().slice(0, 300);
  const clean = {};
  for (const [id, d] of Object.entries(decisions || {})) {
    if (['keep', 'adjust', 'drop'].includes(d)) clean[id] = d;
  }
  for (const [id, d] of Object.entries(clean)) {
    if (d === 'drop') await archiveHabit(Number(id)).catch(() => {});
  }
  await db()`insert into weekly_reviews (week_start, focus, obstacle_plan, decisions, done_at)
             values (${r.review.weekStart}, ${f}, ${plan}, ${db().json(clean)}, ${nowUTC().toJSDate()})
             on conflict (week_start) do update set focus = excluded.focus, obstacle_plan = excluded.obstacle_plan,
             decisions = excluded.decisions, done_at = excluded.done_at`;
  await logEvent('weekly_review', { weekStart: r.review.weekStart, focus: f, decisions: clean });
  return { ok: true, adjust: Object.entries(clean).filter(([, d]) => d === 'adjust').map(([id]) => Number(id)) };
}
