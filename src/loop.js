// Runs the engine every 30 seconds and fires the scheduled briefs.
import { db, migrate } from './db.js';
import { deadlineAt } from './time.js';
import { tick, localNow, ensureGame } from './engine.js';
import { sendPush, vapidKeys } from './push.js';
import { generateBrief } from './coach.js';

async function scheduledBriefs() {
  const { s, local, today, tz } = await localNow();
  for (const kind of ['morning', 'evening']) {
    const at = deadlineAt(today, kind === 'morning' ? s.morningTime : s.eveningTime, tz);
    if (local < at || local >= at.plus({ hours: 3 })) continue;
    const key = `brief:${kind}:${today}`;
    const claimed = await db()`insert into reminders_sent (key) values (${key}) on conflict do nothing returning key`;
    if (!claimed.length) continue;
    const { text } = await generateBrief(kind);
    const body = text.length > 220 ? `${text.slice(0, 217).trimEnd()}...` : text;
    await sendPush({ title: kind === 'morning' ? 'Morning brief' : 'Evening check', body, tag: `brief-${kind}`, url: '/#/today' });
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
      for (const n of notes) await sendPush({ ...n, url: '/#/today' });
    }
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
