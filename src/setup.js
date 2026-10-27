// "Set up Oath": whether each connection is working, in one place, with the last thing that went
// wrong. Shortcuts, Health Auto Export and Telegram hide their own errors, so Oath keeps them.
import { db, getKV, setKV } from './db.js';
import { subscriptionCount } from './push.js';
import { telegramStatus, webhookInfo } from './telegram.js';
import { nowUTC } from './time.js';
import { passkeyCount } from './passkeys.js';

const DAY = 24 * 3600 * 1000;
const iso = (d) => (d ? new Date(d).toISOString() : null);

// At most one note this often, so a flood of failed requests cannot keep rewriting the record.
const NOTE_GAP_MS = 10000;
let lastNote = 0;

// The last failed request from Shortcuts or Health Auto Export. Returns whether it was written.
export async function noteIngestError(path, status, reason) {
  const now = nowUTC().toMillis();
  if (now >= lastNote && now - lastNote < NOTE_GAP_MS) return false;
  lastNote = now;
  await setKV('ingest_error', { at: nowUTC().toISO(), path, status, reason: String(reason || '').slice(0, 200) });
  return true;
}

export async function setupStatus() {
  const now = nowUTC().toMillis();
  const [faceIds, devices, tg, hook, feeds, tokens, healthSync, healthRows, ingestError] = await Promise.all([
    passkeyCount(),
    subscriptionCount(),
    telegramStatus(),
    webhookInfo(),
    db()`select name, kind, last_sync, last_error, event_count from cal_feeds order by id`,
    db()`select count(*)::int as n, max(last_used) as last_used from api_tokens`,
    getKV('health_last_sync'),
    db()`select (select count(*) from health_samples)::int + (select count(*) from health_workouts)::int as n`,
    getKV('ingest_error'),
  ]);
  const [{ n: keyCount, last_used: keyUsed }] = tokens;
  const [{ n: healthCount }] = healthRows;
  const calendars = feeds.filter((f) => f.kind === 'calendar');
  const vle = feeds.filter((f) => f.kind === 'deadlines');
  const feedProblem = (list) => list.find((f) => f.last_error)?.last_error || null;
  const lastHealth = healthSync?.at ? new Date(healthSync.at).getTime() : 0;
  // An error only matters if nothing has worked since.
  const errorAt = ingestError?.at ? new Date(ingestError.at).getTime() : 0;
  const lastGood = Math.max(lastHealth, keyUsed ? new Date(keyUsed).getTime() : 0);
  const openError = errorAt > lastGood ? ingestError : null;

  // Telegram keeps its last error after deliveries recover, so it only counts while messages are stuck.
  const stuck = Boolean(hook?.lastError && hook.pending > 0);

  const items = [
    {
      id: 'faceid',
      title: 'Face ID login',
      ok: faceIds > 0,
      detail: faceIds ? `${faceIds} ${faceIds === 1 ? 'device logs' : 'devices log'} in with Face ID.` : 'Log in with your face instead of the password.',
      href: '#/settings',
    },
    {
      id: 'reminders',
      title: 'Reminders on this iPhone',
      ok: devices > 0,
      detail: devices ? `Sending to ${devices} ${devices === 1 ? 'device' : 'devices'}.` : 'No device is registered for notifications.',
      href: '#/settings',
    },
    {
      id: 'telegram',
      title: 'Telegram',
      ok: tg.linked && !stuck,
      detail: !tg.enabled ? 'The bot token is not set on the server.'
        : !tg.linked ? `Not linked yet${tg.botUsername ? ` to @${tg.botUsername}` : ''}.`
          : stuck ? `Linked, but Telegram cannot deliver to Oath: ${hook.lastError}`
            : `Linked to @${tg.botUsername}.`,
      href: '#/settings',
    },
    {
      id: 'calendars',
      title: 'Calendars',
      ok: calendars.length > 0 && !feedProblem(calendars),
      detail: !calendars.length ? 'No calendar added yet: Google, iCloud or Outlook.'
        : feedProblem(calendars) ? `A calendar failed to sync: ${feedProblem(calendars)}`
          : `${calendars.map((f) => f.name).join(', ')}.`,
      href: '#/dashboard?section=calendars',
    },
    {
      id: 'vle',
      title: 'UM VLE deadlines',
      ok: vle.length > 0 && !feedProblem(vle),
      detail: !vle.length ? 'The VLE calendar export is not added yet.'
        : feedProblem(vle) ? `The VLE feed failed to sync: ${feedProblem(vle)}`
          : `${vle.reduce((n, f) => n + f.event_count, 0)} deadlines read from the VLE.`,
      href: '#/dashboard?section=calendars',
    },
    {
      id: 'health',
      title: 'Apple Health',
      ok: healthCount > 0 && now - lastHealth < 2 * DAY,
      detail: !lastHealth ? 'No Health sync has arrived yet.'
        : !healthCount ? 'A sync arrived but carried no values. Check the Shortcut reads Health, or that Health Auto Export is allowed to read Health.'
          : now - lastHealth >= 2 * DAY ? 'The last sync is more than two days old. Check the automation is still on.'
            : `${healthCount} values stored.`,
      href: '#/dashboard?section=health',
    },
  ];
  return {
    items,
    done: items.filter((i) => i.ok).length,
    total: items.length,
    key: { count: keyCount, lastUsed: iso(keyUsed) },
    health: { lastSync: healthSync?.at || null, values: healthCount, format: healthSync?.format || null },
    ingestError: openError,
  };
}
