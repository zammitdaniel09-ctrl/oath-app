// Runs the engine every 30 seconds and fires the scheduled briefs.
import { db, migrate } from './db.js';
import { deadlineAt, nowUTC, addDays, weekday } from './time.js';
import { tick, localNow, ensureGame } from './engine.js';
import { sendPush, vapidKeys } from './push.js';
import { generateBrief } from './coach.js';
import { buildToday } from './state.js';
import { prepareReview } from './review.js';

const BRIEF_TITLES = { morning: 'Morning brief', midday: 'Midday check', evening: 'Evening check' };

async function claim(key) {
  const rows = await db()`insert into reminders_sent (key) values (${key}) on conflict do nothing returning key`;
  return rows.length > 0;
}

async function scheduledBriefs() {
  const { s, local, today, tz } = await localNow();
  const times = { morning: s.morningTime, midday: s.middayTime, evening: s.eveningTime };
  for (const kind of ['morning', 'midday', 'evening']) {
    const at = deadlineAt(today, times[kind], tz);
    if (local < at || local >= at.plus({ hours: 3 })) continue;
    if (!(await claim(`brief:${kind}:${today}`))) continue;
    const { text, openCount } = await generateBrief(kind);
    if (kind === 'midday' && !openCount) continue;
    const body = text.length > 220 ? `${text.slice(0, 217).trimEnd()}...` : text;
    await sendPush({ title: BRIEF_TITLES[kind], body, fullText: text, tag: `brief-${kind}`, url: '/#/today' });
  }

  // Monday morning: write last week's review and invite him to it (a fresh-start moment).
  const morning = deadlineAt(today, s.morningTime, tz);
  if (weekday(today, tz) === 1 && local >= morning.plus({ minutes: 5 }) && local < morning.plus({ hours: 12 })) {
    const lastWeek = addDays(today, -7, tz);
    const [{ n }] = await db()`select count(*)::int as n from days where date >= ${lastWeek} and date < ${today}`;
    const [done] = await db()`select done_at from weekly_reviews where week_start = ${lastWeek}`;
    if (n > 0 && !done?.done_at && (await claim(`weekly:${lastWeek}`))) {
      await prepareReview();
      await sendPush({ title: 'Weekly review', body: 'Five minutes: keep, adjust or drop each habit, and pick this week\'s focus.', tag: 'weekly', url: '/#/review' });
    }
  }

  // No oath two hours after the morning brief: chase it once.
  const oathBy = deadlineAt(today, s.morningTime, tz).plus({ hours: 2 });
  if (local >= oathBy && local < oathBy.plus({ hours: 10 })) {
    const [plan] = await db()`select 1 from day_plans where date = ${today}`;
    if (!plan) {
      const t = await buildToday();
      if (t.progress.open && (await claim(`oath-chase:${today}`))) {
        await sendPush({
          title: 'You have not taken today\'s oath',
          body: `${t.progress.open} things due today, ${t.progress.atStake} HP at stake. Open Oath and pick your one thing.`,
          tag: 'oath-chase',
          url: '/#/today',
        });
      }
    }
  }
}

// A focus block that has run out gets one nudge asking whether it is done.
async function focusEnds() {
  const rows = await db()`select * from focus_sessions where ended_at is null and not notified`;
  for (const f of rows) {
    const end = new Date(f.started_at).getTime() + f.minutes * 60000;
    if (nowUTC().toMillis() < end) continue;
    await db()`update focus_sessions set notified = true where id = ${f.id}`;
    await sendPush({
      title: `Time: ${f.title}`,
      body: `Your ${f.minutes} minute block is over. Is it done? Mark it, or start another block.`,
      tag: `focus-${f.id}`,
      url: '/#/today',
      item: { kind: f.kind, id: f.ref_id },
      focusId: f.id,
    });
  }
}

let running = false;

export async function runOnce() {
  if (running) return [];
  running = true;
  try {
    const notes = await tick();
    if (notes.length > 4) {
      // After downtime the engine may judge many items at once: send one summary instead of a flood.
      const deaths = notes.filter((n) => n.tag === 'death').length;
      const misses = notes.filter((n) => n.tag.startsWith('miss-')).length;
      await sendPush({
        title: deaths ? 'You died while the server was catching up.' : `${misses} misses judged`,
        body: `${misses} misses were charged${deaths ? ` and you died ${deaths} time${deaths > 1 ? 's' : ''}` : ''}. Open the ledger.`,
        tag: 'catch-up',
        url: '/#/ledger',
      });
    } else {
      for (const n of notes) await sendPush({ url: '/#/today', ...n });
    }
    await focusEnds();
    await scheduledBriefs();
    return notes;
  } finally {
    running = false;
  }
}

// If the database comes back empty (restored, recreated or moved), rebuild the schema without a restart.
export async function healIfEmpty(err) {
  if (err?.code !== '42P01') return false;
  console.warn('tables missing, recreating schema');
  await migrate();
  await ensureGame();
  await vapidKeys();
  return true;
}

export function startLoop(intervalMs = 30000) {
  const run = () => runOnce().catch(async (err) => {
    if (await healIfEmpty(err).catch(() => false)) return;
    console.error('tick failed', err);
  });
  run();
  return setInterval(run, intervalMs);
}
