// Runs the engine every 30 seconds and fires the scheduled briefs. Beside it, the food filler fills
// in what diary entries do not say (food-enrich.js).
import { db, migrate } from './db.js';
import { deadlineAt, nowUTC, addDays, weekday } from './time.js';
import { tick, localNow, ensureGame } from './engine.js';
import { sendPush, vapidKeys } from './push.js';
import { generateBrief } from './coach.js';
import { plainText } from '../public/rich.js';
import { buildToday } from './state.js';
import { prepareReview } from './review.js';
import { syncAllFeeds } from './calendar.js';
import { refreshBusiness, businessSources } from './business.js';
import { setAutoEnrich, drainEnrichment } from './food-enrich.js';
import { pruneSessions } from './auth.js';
import { foodWeekReport } from './food-take.js';
import { syncMail, MAIL_KEEP_DAYS } from './mail.js';
import { collectFacts } from './food-tags.js';

const BRIEF_TITLES = { morning: 'Morning brief', midday: 'Midday check', evening: 'Evening check' };
// The Sunday food report: from 19:00 local time, for three hours, once a week.
const FOOD_WEEK_TIME = '19:00';
const FOOD_WEEK_TRIES = 3;
const foodWeekTries = new Map();

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
    const key = `brief:${kind}:${today}`;
    if (!(await claim(key))) continue;
    let brief;
    try {
      brief = await generateBrief(kind);
    } catch (err) {
      // Free the slot so a later tick inside the window tries again.
      await db()`delete from reminders_sent where key = ${key}`;
      throw err;
    }
    const { text, openCount } = brief;
    if (kind === 'midday' && !openCount) continue;
    // A notification shows text only, so the coach's Markdown markers are dropped there.
    const plain = plainText(text);
    const body = plain.length > 220 ? `${plain.slice(0, 217).trimEnd()}...` : plain;
    await sendPush({ title: BRIEF_TITLES[kind], body, fullText: text, tag: `brief-${kind}`, url: '/#/today' });
  }

  // Monday morning: write last week's review and invite him to it (a fresh-start moment).
  const morning = deadlineAt(today, s.morningTime, tz);
  if (weekday(today, tz) === 1 && local >= morning.plus({ minutes: 5 }) && local < morning.plus({ hours: 12 })) {
    const lastWeek = addDays(today, -7, tz);
    // A week with fewer than 4 days of real work has too little to review.
    const [{ n }] = await db()`select count(*)::int as n from days where date >= ${lastWeek} and date < ${today}
                               and not rest and kept + missed + pardoned > 0`;
    const [done] = await db()`select done_at from weekly_reviews where week_start = ${lastWeek}`;
    if (n >= 4 && !done?.done_at && (await claim(`weekly:${lastWeek}`))) {
      await prepareReview();
      await sendPush({ title: 'Weekly review', body: 'Five minutes: keep, adjust or drop each habit, and pick this week\'s focus.', tag: 'weekly', url: '/#/review' });
    }
  }

  // Sunday evening: the coach's take on the week's food, in the chat and on the lock screen. Nothing
  // when no food was logged that week or the coach is off. A failed write frees the slot for the next
  // tick, a few times at most.
  const foodWeekAt = deadlineAt(today, FOOD_WEEK_TIME, tz);
  if (weekday(today, tz) === 7 && local >= foodWeekAt && local < foodWeekAt.plus({ hours: 3 })) {
    const key = `food-week:${today}`;
    if (await claim(key)) {
      let report = null;
      try {
        report = await foodWeekReport();
      } catch (err) {
        console.error('food week report failed', err.status || '', err.message);
        const tries = (foodWeekTries.get(key) || 0) + 1;
        foodWeekTries.set(key, tries);
        if (tries < FOOD_WEEK_TRIES) await db()`delete from reminders_sent where key = ${key}`;
      }
      if (report) await sendPush(report.note);
    }
  }


  await chaseOath({ s, local, today, tz });
}

// With nothing open there is nothing to chase yet, but something may be added later in the day, so
// that is looked at again after this long rather than on every tick.
const CHASE_RECHECK_MS = 5 * 60000;
let chaseLooked = { day: null, at: 0 };

// No oath two hours after the morning brief: chase it once. buildToday is the heaviest read there
// is, so it only runs while the nudge is still unsent, and not on every tick even then.
export async function chaseOath({ s, local, today, tz }, build = buildToday) {
  const oathBy = deadlineAt(today, s.morningTime, tz).plus({ hours: 2 });
  if (local < oathBy || local >= oathBy.plus({ hours: 10 })) return false;
  const key = `oath-chase:${today}`;
  if ((await db()`select 1 from reminders_sent where key = ${key}`).length) return false;
  if ((await db()`select 1 from day_plans where date = ${today}`).length) return false;
  const now = nowUTC().toMillis();
  if (chaseLooked.day === today && now >= chaseLooked.at && now - chaseLooked.at < CHASE_RECHECK_MS) return false;
  chaseLooked = { day: today, at: now };
  const t = await build();
  if (!t.progress.open || !(await claim(key))) return false;
  await sendPush({
    title: 'You have not taken today\'s oath',
    body: `${t.progress.open} things due today, ${t.progress.atStake} HP at stake. Open Oath and pick your one thing.`,
    tag: 'oath-chase',
    url: '/#/today',
  });
  return true;
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

// Once a day: the tables that only ever grow are trimmed, and sessions nobody has used for half a
// year are dropped. Reminder keys and Telegram update ids only matter for a day or two; 60 days is
// generous. Events are an audit trail that nothing reads far back, except the Deaths list on the
// review screen, so deaths are kept for good (a handful a year) and everything else for 400 days.
const KEEP_DAYS = { reminders: 60, telegram: 60, events: 400, mail: MAIL_KEEP_DAYS };

export async function pruneOld() {
  const now = nowUTC();
  const before = (days) => now.minus({ days }).toJSDate();
  const sent = await db()`delete from reminders_sent where at < ${before(KEEP_DAYS.reminders)}`;
  const updates = await db()`delete from telegram_updates where at < ${before(KEEP_DAYS.telegram)}`;
  const events = await db()`delete from events where at < ${before(KEEP_DAYS.events)} and type <> 'death'`;
  const sessions = await pruneSessions();
  const mail = await db()`delete from mail_messages where received_at < ${before(KEEP_DAYS.mail)}`;
  return { reminders: sent.count, telegram: updates.count, events: events.count, sessions, mail: mail.count };
}

let prunedOn = null;

// Claimed per day like the briefs, and freed if it fails so a later tick tries again.
export async function pruneDaily() {
  const day = nowUTC().toISODate();
  if (prunedOn === day) return null;
  const key = `prune:${day}`;
  if (!(await claim(key))) {
    prunedOn = day;
    return null;
  }
  try {
    const gone = await pruneOld();
    prunedOn = day;
    const total = Object.values(gone).reduce((n, x) => n + x, 0);
    if (total) console.log('pruned old rows', JSON.stringify(gone));
    return gone;
  } catch (err) {
    await db()`delete from reminders_sent where key = ${key}`;
    throw err;
  }
}

// Judging has a lock of its own and nothing in it waits on Claude, so one slow API call can never
// hold up a deadline. The briefs and the weekly review write with Claude, so they have a separate
// lock: the next tick skips them while one is still being written, and the claim keeps each brief
// to once a day.
let running = false;
let briefing = false;

export async function judgeOnce() {
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
    return notes;
  } finally {
    running = false;
  }
}

export async function briefsOnce() {
  if (briefing) return;
  briefing = true;
  try {
    // Independent jobs: a failing brief must not stop the daily upkeep, nor the other way round.
    const jobs = await Promise.allSettled([scheduledBriefs(), pruneDaily()]);
    const failed = jobs.find((j) => j.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    briefing = false;
  }
}

// One full pass, judging first. The server runs the two halves side by side (see startLoop); this is
// for tests and for anything that wants both done when it returns.
export async function runOnce() {
  const notes = await judgeOnce();
  await briefsOnce();
  return notes;
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
  // Judging and the briefs run side by side, each on its own lock. Only judging rebuilds an empty
  // database, so the two never try to at once.
  const run = () => {
    judgeOnce().catch(async (err) => {
      if (await healIfEmpty(err).catch(() => false)) return;
      console.error('tick failed', err);
    });
    briefsOnce().catch((err) => {
      if (err?.code !== '42P01') console.error('briefs failed', err);
    });
  };
  run();
  // Calendars every 15 minutes and business sites every 10, off the tick so a slow server never
  // delays judging.
  const syncCalendars = () => syncAllFeeds().catch((err) => console.error('calendar sync failed', err));
  const syncBusiness = () => (businessSources().length ? refreshBusiness() : Promise.resolve()).catch((err) => console.error('business refresh failed', err));
  syncCalendars();
  syncBusiness();
  setInterval(syncCalendars, 15 * 60000).unref();
  setInterval(syncBusiness, 10 * 60000).unref();
  // Gmail every 5 minutes, when it is connected (mail.js does nothing otherwise).
  const syncInbox = () => syncMail().catch((err) => console.error('mail sync failed', err.message));
  syncInbox();
  setInterval(syncInbox, 5 * 60000).unref();
  // Products he eats that Open Food Facts has more to say about (labels, allergens, additives): three
  // every ten minutes, well inside its rate limits.
  const moreFacts = () => collectFacts().catch((err) => console.error('food facts failed', err.message));
  setInterval(moreFacts, 10 * 60000).unref();
  // Food: new diary entries get their missing nutrients filled a moment after they are logged, and
  // older ones a few at a time on their own timer, so a slow lookup never delays judging. The first
  // pass waits one interval, giving the food seed time to load at boot.
  setAutoEnrich(true);
  const fillFood = () => drainEnrichment().catch((err) => console.error('food fill failed', err));
  setInterval(fillFood, intervalMs).unref();
  return setInterval(run, intervalMs);
}
