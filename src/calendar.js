// Calendar feeds: Google, iCloud, Outlook and the University VLE (Moodle), subscribed to by their
// iCal address. Events show what the day already holds (busy time for the capacity check and the
// coach's view); a "deadlines" feed turns each VLE due date into a normal task, once. Oath's own events
// (added in the app or by the coach) live in their own table and join the same reads.
//
// The iCalendar parser (ics.js) is our own and covers what real feeds use (RFC 5545): line unfolding, text
// escapes, DATE and DATE-TIME values in UTC, IANA, Windows or VTIMEZONE-defined zones, floating
// times, DURATION, RRULE expansion inside a window, EXDATE, RDATE, RECURRENCE-ID overrides and
// cancelled events.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { db, logEvent, getKV, setKV } from './db.js';
import { nowUTC, addDays, deadlineAt, validTime, validDate } from './time.js';
import { localNow, createTask, updateTask, completeTask, undoTask, isScheduled, rulesOn, RuleError } from './engine.js';
import { restSet } from './strength.js';
import { text, parseICS, expandCalendar } from './ics.js';

// The parser's own entry points, as the tests and older callers know them.
export { parseICS, expandCalendar, WINDOWS_ZONES } from './ics.js';

const v = { validTime, validDate };
// Every timestamp comes from the app clock, never the database clock.
const ts = () => nowUTC().toJSDate();

const KINDS = ['calendar', 'deadlines'];
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// Events are kept from yesterday to about six months ahead. MAX_PER_EVENT and MAX_PER_FEED (ics.js) still bound
// what one feed can store (a daily event is 182 rows), so a longer window cannot run away.
const WINDOW_AFTER_DAYS = 180;
const KEEP_PAST_DAYS = 120; // older events left over from earlier syncs are pruned
const MAX_FEEDS = 20;
const FRESH_MINUTES = 14; // "every 15 minutes", less a minute of slack so a 15-minute loop never skips a beat
const MAX_RANGE_DAYS = 62;
const SYNC_CONCURRENCY = 3;
const PALETTE = ['#2f6f8f', '#c0612b', '#3d7a4a', '#a8842c', '#b0465c', '#4b5d73'];
const OATH_COLOR = '#e10600'; // Merlot: his own events stand out from the feeds
const OATH_DEFAULT_MIN = 60; // an event with a start and no end lasts an hour
const OATH_MAX_MIN = 24 * 60;
const OATH_MAX_DAYS = 62; // longest all-day span
const USER_AGENT = 'Oath/1.0 (personal calendar sync)';

// Tests serve feeds from a local http server: allow loopback and plain http there, let them point
// https:// links at it, and shorten the fetch timeout.
const testHooks = { allowLocal: false, rewriteUrl: null, timeoutMs: null };
export function setCalendarTestHooks(hooks = {}) {
  Object.assign(testHooks, hooks);
}
const localAllowed = () => process.env.NODE_ENV === 'test' || Boolean(testHooks.allowLocal);

// ---------- Schema ----------

export const CALENDAR_SCHEMA = `
create table if not exists cal_feeds (
  id serial primary key,
  name text not null,
  url text not null,
  kind text not null default 'calendar' check (kind in ('calendar', 'deadlines')),
  color text not null default '',
  last_sync timestamptz,
  last_error text,
  event_count int not null default 0,
  created_at timestamptz not null
);
create table if not exists cal_events (
  feed_id int not null references cal_feeds(id) on delete cascade,
  uid text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  all_day boolean not null default false,
  title text not null,
  location text not null default '',
  busy boolean not null default true,
  primary key (feed_id, uid, start_at)
);
alter table cal_events add column if not exists busy boolean not null default true;
-- The occurrence's original start (ISO), part of the key a deadline's task is made under. A moved
-- occurrence of a series keeps it while its start_at changes.
alter table cal_events add column if not exists orig_start text;
create index if not exists cal_events_start_idx on cal_events (start_at);
alter table tasks add column if not exists ext_uid text;
create unique index if not exists tasks_ext_uid_idx on tasks (ext_uid) where ext_uid is not null;
-- Oath's own events: made in the app or by the coach. A table of their own, so no feed sync, removal or
-- feed count ever touches them. All-day events are stored like the feeds' (UTC midnight, end exclusive).
create table if not exists oath_events (
  id serial primary key,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text not null default '',
  notes text not null default '',
  created_by text not null default 'you',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists oath_events_start_idx on oath_events (start_at);
-- Events he has crossed off (his own and those from his other calendars), by the event's id as the app
-- shows it (feed:uid:start or oath:id). The feeds stay untouched; the mark lives only in Oath.
create table if not exists event_marks (
  event_id text primary key,
  title text not null default '',
  date text not null default '',
  done_at timestamptz not null
);
`;

export async function migrateCalendar() {
  await db().unsafe(CALENDAR_SCHEMA);
}

// ---------- Fetching ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) {
      const hi = Number.parseInt(hex[1], 16);
      const lo = Number.parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;
}

const privateHostError = () => new RuleError('That link points to a private network address. Use the public calendar link.');

function checkHost(hostname) {
  if (localAllowed()) return;
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new RuleError('That link has no server name.');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw privateHostError();
    return;
  }
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) throw privateHostError();
}

// webcal:// becomes https://; only https is fetched (plain http and loopback only in tests).
export function normalizeFeedUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) throw new RuleError('Paste the calendar link.');
  if (s.length > 2000) throw new RuleError('That link is too long.');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new RuleError('That does not look like a link. It should start with https:// or webcal://.');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localAllowed())) {
    throw new RuleError(u.protocol === 'http:'
      ? 'Use the secure link: it should start with https:// or webcal://.'
      : 'Calendar links start with https:// or webcal://.');
  }
  if (u.username || u.password) throw new RuleError('Links with a user name or password inside are not supported.');
  checkHost(u.hostname);
  u.hash = '';
  return u.toString();
}

// DNS lookup that refuses private addresses, so a public name pointing inside the network (or
// changing its answer between check and connect) cannot reach internal services.
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!localAllowed() && addresses.some((a) => isPrivateIp(a.address))) {
      return callback(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
    }
    if (opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function getOnce(url, msLeft) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(resolve, { status, location: res.headers.location || '' });
      }
      if (status !== 200) {
        res.resume();
        return finish(resolve, { status });
      }
      const tooBig = Object.assign(new Error('too big'), { code: 'ETOOBIG' });
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
        req.destroy();
        return finish(reject, tooBig);
      }
      const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          finish(reject, tooBig);
        } else chunks.push(chunk);
      });
      stream.on('end', () => finish(resolve, { status, buffer: Buffer.concat(chunks) }));
      stream.on('error', (e) => finish(reject, e));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, Object.assign(new Error('aborted'), { code: 'ECONNRESET' })));
    });
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, Math.max(1, msLeft));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

function fetchError(err, url) {
  if (err instanceof RuleError) return err;
  const host = url.hostname;
  switch (err.code) {
    case 'ETIMEDOUT': return new RuleError('The calendar server took longer than 15 seconds to answer. Try again later.');
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return new RuleError(`Could not find the server ${host}. Check the link.`);
    case 'EPRIVATE': return privateHostError();
    case 'ECONNREFUSED': return new RuleError(`${host} refused the connection. Try again later.`);
    case 'ECONNRESET': return new RuleError(`${host} dropped the connection. Try again later.`);
    case 'ETOOBIG': return new RuleError('That calendar is larger than 10 MB, too big to sync.');
    default:
      if (/CERT|SSL|TLS|EPROTO/i.test(`${err.code} ${err.message}`)) return new RuleError(`The secure connection to ${host} failed.`);
      return new RuleError(`Could not fetch the calendar from ${host} (${err.code || 'network error'}).`);
  }
}

function statusError(status) {
  if (status === 401 || status === 403) {
    return new RuleError(`The calendar server refused access (error ${status}). The link may be private, expired or reset. Copy a fresh link.`);
  }
  if (status === 404 || status === 410) {
    return new RuleError(`Nothing was found at that link (error ${status}). Check you copied the whole address, or copy a fresh one.`);
  }
  if (status === 429) return new RuleError('The calendar server says too many requests. Oath will try again later.');
  if (status >= 500) return new RuleError(`The calendar server had a problem (error ${status}). Oath will try again later.`);
  return new RuleError(`The calendar server answered with error ${status}.`);
}

// GET a feed: 15 s overall, at most 10 MB, redirects followed (each hop checked again).
export async function fetchCalendar(rawUrl) {
  const deadline = Date.now() + (testHooks.timeoutMs || FETCH_TIMEOUT_MS);
  let url = new URL(normalizeFeedUrl(rawUrl));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = testHooks.rewriteUrl ? new URL(testHooks.rewriteUrl(url.toString())) : url;
    let res;
    try {
      res = await getOnce(target, deadline - Date.now());
    } catch (err) {
      throw fetchError(err, url);
    }
    if (res.location !== undefined) {
      if (!res.location) throw statusError(res.status);
      url = new URL(normalizeFeedUrl(new URL(res.location, url).toString()));
      continue;
    }
    if (res.status !== 200) throw statusError(res.status);
    return res.buffer;
  }
  throw new RuleError('That link redirected too many times.');
}

// ---------- Feeds ----------

function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const segs = u.pathname.split('/').filter(Boolean);
    const first = segs.length > 1 ? `/${segs[0]}` : '';
    const last = segs[segs.length - 1] || '';
    const showLast = /\.(ics|ical|ifb|php)$/i.test(last) && last.length <= 40;
    return `${u.protocol}//${u.host}${first}/…${showLast ? `/${last}` : ''}${u.search ? '?…' : ''}`;
  } catch {
    return '…';
  }
}

// What the client sees. The full URL is a secret (anyone with it can read the calendar), so it
// never leaves the server.
function publicFeed(r) {
  let host = '';
  try {
    host = new URL(r.url).host;
  } catch {
    host = '';
  }
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    color: r.color,
    host,
    url: maskUrl(r.url),
    lastSync: r.last_sync ? new Date(r.last_sync).toISOString() : null,
    lastError: r.last_error || null,
    eventCount: r.event_count,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function listFeeds() {
  const rows = await db()`select * from cal_feeds order by id`;
  return rows.map(publicFeed);
}

function looksLikeVle(url, cal) {
  const u = new URL(url);
  return /vle|moodle/i.test(u.hostname) || /export_execute\.php/i.test(u.pathname) || /moodle/i.test(cal.prodid);
}

export async function addFeed(input = {}) {
  const url = normalizeFeedUrl(input.url);
  let kind = input.kind === undefined || input.kind === null || input.kind === '' ? null : String(input.kind).trim().toLowerCase();
  if (kind && !KINDS.includes(kind)) throw new RuleError('The kind must be "calendar" or "deadlines".');
  const [{ n }] = await db()`select count(*)::int as n from cal_feeds`;
  if (n >= MAX_FEEDS) throw new RuleError(`You can add up to ${MAX_FEEDS} calendars. Remove one first.`, 409);
  const [dupe] = await db()`select id from cal_feeds where url = ${url}`;
  if (dupe) throw new RuleError('That calendar is already added.', 409);

  const cal = parseICS(await fetchCalendar(url)); // throws a clear RuleError if it is not a calendar
  if (!kind) kind = looksLikeVle(url, cal) ? 'deadlines' : 'calendar';
  const name = text(input.name, 80) || cal.name || (kind === 'deadlines' ? 'VLE deadlines' : 'Calendar');
  const color = /^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? input.color.toLowerCase() : PALETTE[n % PALETTE.length];
  const [row] = await db()`insert into cal_feeds (name, url, kind, color, created_at)
                           values (${name}, ${url}, ${kind}, ${color}, ${ts()}) returning *`;
  await logEvent('calendar_added', { id: row.id, name, kind, host: new URL(url).host });
  const sync = await syncFeed(row.id, { cal });
  const [fresh] = await db()`select * from cal_feeds where id = ${row.id}`;
  return { feed: publicFeed(fresh), events: sync.events, created: sync.created, updated: sync.updated };
}

// Syncs of one feed never overlap (the loop and a manual "sync now" can race).
const locks = new Map();
function withFeedLock(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

const feedId = (id) => {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) throw new RuleError('Bad id.');
  return n;
};

export async function removeFeed(id) {
  const fid = feedId(id);
  return withFeedLock(fid, async () => {
    const [f] = await db()`delete from cal_feeds where id = ${fid} returning id, name`;
    if (!f) throw new RuleError('That calendar does not exist.', 404);
    await logEvent('calendar_removed', { id: f.id, name: f.name });
    return { ok: true };
  });
}

function syncWindow(local) {
  const startToday = local.startOf('day');
  return { from: startToday.minus({ days: 1 }), to: startToday.plus({ days: WINDOW_AFTER_DAYS + 1 }) };
}

// The last local date every synced feed has been read up to, or null with none. Past it the calendar
// shows only Oath's own events, so the page can say so instead of looking empty.
export async function syncedThrough() {
  const { tz } = await localNow();
  const [r] = await db()`select min(last_sync) as at from cal_feeds`.catch(ignoreMissingTables([]));
  if (!r?.at) return null;
  return syncWindow(DateTime.fromJSDate(r.at, { zone: tz })).to.minus({ days: 1 }).toISODate();
}

// Fetch (unless a parsed calendar is passed), expand, and replace the feed's events in the window
// in one transaction. Records last_sync, last_error and event_count. Throws a RuleError on failure.
export async function syncFeed(id, { cal = null } = {}) {
  const fid = feedId(id);
  return withFeedLock(fid, async () => {
    const [feed] = await db()`select * from cal_feeds where id = ${fid}`;
    if (!feed) throw new RuleError('That calendar does not exist.', 404);
    try {
      const parsed = cal || parseICS(await fetchCalendar(feed.url));
      const { local, today, tz } = await localNow();
      const { from, to } = syncWindow(local);
      const occs = expandCalendar(parsed, { zone: tz, from, to });
      const rows = [];
      const seen = new Set();
      for (const o of occs) {
        const key = `${o.uid}|${o.start.toMillis()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          feed_id: feed.id, uid: o.uid, start_at: o.start.toJSDate(), end_at: o.end.toJSDate(), all_day: o.allDay,
          title: o.title || 'Untitled event', location: o.location, busy: o.busy, orig_start: o.origStart,
        });
      }
      await db().begin(async (tx) => {
        await tx`delete from cal_events where feed_id = ${feed.id}
                 and (start_at >= ${from.toJSDate()} or coalesce(end_at, start_at) > ${from.toJSDate()})`;
        await tx`delete from cal_events where feed_id = ${feed.id}
                 and coalesce(end_at, start_at) < ${from.minus({ days: KEEP_PAST_DAYS }).toJSDate()}`;
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          await tx`insert into cal_events ${tx(chunk, 'feed_id', 'uid', 'start_at', 'end_at', 'all_day', 'title', 'location', 'busy', 'orig_start')}
                   on conflict do nothing`;
        }
        await tx`update cal_feeds set last_sync = ${ts()}, last_error = null, event_count = ${rows.length} where id = ${feed.id}`;
      });
      let created = 0;
      let updated = 0;
      if (feed.kind === 'deadlines') ({ created, updated } = await syncDeadlineTasks(feed, occs, today, tz));
      return { id: feed.id, ok: true, events: rows.length, created, updated };
    } catch (err) {
      const message = err instanceof RuleError ? err.message : 'Something went wrong while syncing this calendar.';
      if (!(err instanceof RuleError)) console.error('calendar sync failed', feed.id, err);
      await db()`update cal_feeds set last_error = ${message} where id = ${feed.id}`.catch(() => {});
      throw err;
    }
  });
}

// Sync every feed not synced in the last 15 minutes (all of them with force). A failing feed is
// recorded on its row and in the result, and never stops the others.
export async function syncAllFeeds({ force = false } = {}) {
  const feeds = await db()`select id, last_sync from cal_feeds order by id`;
  const cutoff = nowUTC().minus({ minutes: FRESH_MINUTES }).toMillis();
  const due = feeds.filter((f) => force || !f.last_sync || new Date(f.last_sync).getTime() <= cutoff);
  const results = feeds.filter((f) => !due.includes(f)).map((f) => ({ id: f.id, ok: true, skipped: true }));
  for (let i = 0; i < due.length; i += SYNC_CONCURRENCY) {
    const batch = due.slice(i, i + SYNC_CONCURRENCY);
    results.push(...(await Promise.all(batch.map(async (f) => {
      try {
        return await syncFeed(f.id);
      } catch (err) {
        return { id: f.id, ok: false, error: err instanceof RuleError ? err.message : 'Something went wrong while syncing this calendar.' };
      }
    }))));
  }
  return results.sort((a, b) => a.id - b.id);
}

// ---------- Deadlines feeds: VLE due dates become tasks ----------

// "Quiz 2 opens" and other start-of-window events are not deadlines.
export function isOpeningEvent(title) {
  const t = String(title || '').trim().replace(/\.+$/, '');
  return /\s(opens|open)$/i.test(t)
    || /\((opens?|opens? for (submissions?|assessment)|submissions? opens?)\)$/i.test(t)
    || /\bdue to be graded$/i.test(t);
}

// "Assignment 1 is due" -> "Assignment 1", "Quiz 2 closes" -> "Quiz 2".
export function cleanDeadlineTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  const stripped = t
    .replace(/\s*\((submissions? deadline|submissions? close[sd]?|assessment deadline|closes|due)\)$/i, '')
    .replace(/\s+(is due|are due|due|closes|close|deadline|should be completed)$/i, '')
    .trim();
  return (/^(is|are)?$/i.test(stripped) ? t : stripped) || 'VLE deadline';
}

const UNIT_CODE = /\b([A-Z]{3}\d{4})\b/;

function deadlineTask(o) {
  const course = o.categories.join(', ');
  const code = UNIT_CODE.exec(course)?.[1] || (!course && UNIT_CODE.exec(o.description)?.[1]) || '';
  let title = cleanDeadlineTitle(o.title);
  if (code && !title.includes(code)) title = `${title} (${code})`;
  const notes = [];
  if (course) notes.push(`Course: ${course}`);
  else if (code) notes.push(`Course: ${code}`);
  if (o.description) notes.push(o.description.length > 600 ? `${o.description.slice(0, 597).trimEnd()}...` : o.description);
  notes.push('From the VLE calendar.');
  return { title: title.slice(0, 200), notes: notes.join('\n').slice(0, 1000) };
}

const ISO_TAIL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The ext_uid of the task a deadline becomes: feed, event UID and the occurrence's original start in UTC.
// Rows synced before orig_start was stored fall back to their start, which is the same for a one-off event.
const deadlineKey = (r) => `cal:${r.feed_id}:${r.uid}:${r.orig_start || new Date(r.start_at).toISOString()}`;

async function syncDeadlineTasks(feed, occs, today, tz) {
  const existing = await db()`select id, ext_uid, due_date, deadline, done_at, deleted_at from tasks where ext_uid like 'cal:%'`;
  const feedIds = new Set((await db()`select id from cal_feeds`).map((r) => r.id));
  const claimed = new Set();
  let created = 0;
  let updated = 0;
  for (const o of occs) {
    if (isOpeningEvent(o.title)) continue;
    const local = o.allDay ? o.start : o.start.setZone(tz);
    const deadline = o.allDay ? null : local.toFormat('HH:mm');
    // The VLE's "Fri 00:00" is the end of Thursday, and Oath reads a 00:00 deadline as the end of its date,
    // so the task is due on the day before at 00:00: the same moment, not a day late.
    const due = deadline === '00:00' ? local.minus({ days: 1 }).toISODate() : local.toISODate();
    if (due < today) continue;
    const key = deadlineKey({ feed_id: feed.id, uid: o.uid, orig_start: o.origStart });
    try {
      let t = existing.find((x) => x.ext_uid === key);
      if (!t && !o.recurring) {
        // The same one-off event at a new time: the deadline moved.
        const prefix = `cal:${feed.id}:${o.uid}:`;
        const same = existing.filter((x) => !claimed.has(x.id) && x.ext_uid.startsWith(prefix) && ISO_TAIL.test(x.ext_uid.slice(prefix.length)));
        if (same.length === 1) [t] = same;
      }
      if (!t) {
        // A task made from this event by a feed that was removed and added again.
        const suffix = `:${o.uid}:${o.origStart}`;
        t = existing.find((x) => !claimed.has(x.id) && x.ext_uid.endsWith(suffix) && !feedIds.has(Number(x.ext_uid.split(':')[1])));
      }
      if (t) {
        claimed.add(t.id);
        if (t.ext_uid !== key) {
          await db()`update tasks set ext_uid = ${key} where id = ${t.id}`;
          t.ext_uid = key;
        }
        if (!t.done_at && !t.deleted_at && (t.due_date !== due || (t.deadline || null) !== deadline)) {
          try {
            await updateTask(t.id, { due_date: due, deadline }, v, 'vle');
            t.due_date = due;
            t.deadline = deadline;
            updated += 1;
          } catch (err) {
            if (!(err instanceof RuleError)) throw err; // e.g. he made it hard and it is locked: leave it
          }
        }
        continue;
      }
      const { title, notes } = deadlineTask(o);
      const task = await createTask({ title, due_date: due, deadline, notes }, v, 'vle');
      try {
        await db()`update tasks set ext_uid = ${key} where id = ${task.id}`;
      } catch (err) {
        if (err.code !== '23505') throw err;
        await db()`delete from tasks where id = ${task.id}`; // created elsewhere in the meantime
        continue;
      }
      existing.push({ id: task.id, ext_uid: key, due_date: due, deadline, done_at: null, deleted_at: null });
      claimed.add(task.id);
      created += 1;
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      console.warn('calendar deadline skipped', feed.id, o.uid, err.message);
    }
  }
  return { created, updated };
}

// ---------- Read side ----------

const ignoreMissingTables = (fallback) => (err) => {
  if (err?.code === '42P01') return fallback; // calendar schema not migrated: no calendar, not an error
  throw err;
};

const feedEventId = (r) => `${r.feed_id}:${r.uid}:${new Date(r.start_at).getTime()}`;

function toEvent(r, tz) {
  const allDay = r.all_day;
  const s = DateTime.fromJSDate(r.start_at, { zone: allDay ? 'utc' : tz });
  let e = r.end_at ? DateTime.fromJSDate(r.end_at, { zone: allDay ? 'utc' : tz }) : s;
  if (allDay) e = e.minus({ days: 1 }) < s ? s : e.minus({ days: 1 }); // all-day end is the last day, inclusive
  return {
    id: feedEventId(r),
    feedId: r.feed_id,
    feed: r.feed,
    color: r.color,
    title: r.title,
    start: allDay ? s.toISODate() : s.toISO({ suppressMilliseconds: true }),
    end: allDay ? e.toISODate() : e.toISO({ suppressMilliseconds: true }),
    allDay,
    time: allDay ? null : s.toFormat('HH:mm'),
    endTime: allDay ? null : e.toFormat('HH:mm'),
    location: r.location,
    busy: r.busy,
    deadline: r.kind === 'deadlines',
  };
}

// ---------- Oath's own events ----------

// Same shape as a feed event, plus own, ownId and notes, so every reader (Today, busy time, the coach,
// the calendar page) treats them alike. Feed events never carry those three.
function toOwnEvent(r, tz) {
  const e = toEvent({ ...r, feed_id: null, uid: String(r.id), feed: 'Oath', color: OATH_COLOR, kind: 'oath', busy: true }, tz);
  return { ...e, id: `oath:${r.id}`, feedId: null, own: true, ownId: r.id, notes: r.notes, by: r.created_by };
}

const given = (x) => x !== undefined && x !== null && x !== '';
const flag = (x) => x === true || x === 'true' || x === 'on' || x === 1 || x === '1';
// "18:00", "9:05", "18:00:00" and "6pm" all read as a time; anything else is not one.
const hhmm = (x) => {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i.exec(String(x ?? '').trim());
  if (!m || (!m[2] && !m[3])) return '';
  let h = Number(m[1]);
  if (m[3]) {
    if (h < 1 || h > 12) return '';
    h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
};
const notesText = (x) => String(x ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 1000);

// A stored event as the local date and times it was entered with.
function localForm(r, tz) {
  const base = { title: r.title, location: r.location, notes: r.notes };
  if (r.all_day) {
    const s = DateTime.fromJSDate(r.start_at, { zone: 'utc' });
    const e = DateTime.fromJSDate(r.end_at, { zone: 'utc' }).minus({ days: 1 });
    return { ...base, allDay: true, date: s.toISODate(), endDate: (e < s ? s : e).toISODate(), start: null, duration: null };
  }
  const s = DateTime.fromJSDate(r.start_at, { zone: tz });
  const e = DateTime.fromJSDate(r.end_at, { zone: tz });
  return { ...base, allDay: false, date: s.toISODate(), endDate: s.toISODate(), start: s.toFormat('HH:mm'), duration: Math.round(e.diff(s, 'minutes').minutes) };
}

// What was asked (a new event, or a patch to cur) as table columns. Every default lives here: no start
// means all day, a start with no end lasts an hour, a moved start keeps the length, a moved day keeps
// the times.
function composeOwn(input, cur, tz, today) {
  const title = input.title !== undefined ? text(input.title, 200) : cur?.title;
  if (!title) throw new RuleError('Give the event a title.');
  const date = given(input.date) ? String(input.date).trim() : cur?.date || today;
  if (!validDate(date)) throw new RuleError('The date must look like 2026-10-28.');
  let allDay;
  if (given(input.all_day)) allDay = flag(input.all_day);
  else if (cur) allDay = given(input.start) ? false : cur.allDay;
  else allDay = !given(input.start);
  const out = {
    title,
    location: input.location !== undefined ? text(input.location, 200) : cur?.location || '',
    notes: input.notes !== undefined ? notesText(input.notes) : cur?.notes || '',
    all_day: allDay,
  };
  if (allDay) {
    const span = cur?.allDay ? Math.round(DateTime.fromISO(cur.endDate, { zone: 'utc' }).diff(DateTime.fromISO(cur.date, { zone: 'utc' }), 'days').days) : 0;
    let endDate = date;
    if (given(input.end_date)) endDate = String(input.end_date).trim();
    else if (cur?.allDay) endDate = given(input.date) ? addDays(date, span, 'utc') : cur.endDate;
    if (!validDate(endDate) || endDate < date) throw new RuleError('The last day must be on or after the first day.');
    if (DateTime.fromISO(endDate, { zone: 'utc' }).diff(DateTime.fromISO(date, { zone: 'utc' }), 'days').days >= OATH_MAX_DAYS) {
      throw new RuleError(`An all-day event can last up to ${OATH_MAX_DAYS} days.`);
    }
    out.start_at = DateTime.fromISO(date, { zone: 'utc' }).toJSDate();
    out.end_at = DateTime.fromISO(endDate, { zone: 'utc' }).plus({ days: 1 }).toJSDate();
    return out;
  }
  const start = given(input.start) ? hhmm(input.start) : cur && !cur.allDay ? cur.start : '';
  if (!validTime(start)) throw new RuleError(given(input.start) ? 'The start must look like 18:00.' : 'Say what time it starts.');
  const startAt = deadlineAt(date, start, tz);
  let minutes = cur && !cur.allDay ? cur.duration : OATH_DEFAULT_MIN;
  if (given(input.end)) {
    const end = hhmm(input.end);
    if (!validTime(end)) throw new RuleError('The end must look like 19:00.');
    if (end === start) throw new RuleError('The end must be after the start.');
    // An end before the start is on the next day: 22:00 to 01:00 runs past midnight.
    minutes = Math.round(deadlineAt(end < start ? addDays(date, 1, tz) : date, end, tz).diff(startAt, 'minutes').minutes);
    if (!(minutes > 0)) throw new RuleError('The end must be after the start.'); // only inside a clock change
  } else if (given(input.duration)) {
    minutes = Math.round(Number(input.duration));
    if (!(minutes >= 5 && minutes <= OATH_MAX_MIN)) throw new RuleError('The length must be between 5 minutes and 24 hours.');
  }
  out.start_at = startAt.toJSDate();
  out.end_at = startAt.plus({ minutes }).toJSDate();
  return out;
}

// Only Oath's own ids (7 or oath:7) pass; a feed event's id looks different and is refused.
const ownIdOf = (id) => {
  const s = String(id).replace(/^oath:/, '');
  if (!/^\d{1,9}$/.test(s)) throw new RuleError('Only events made in Oath can be changed.');
  return Number(s);
};

async function ownRow(id) {
  const [row] = await db()`select * from oath_events where id = ${ownIdOf(id)}`;
  if (!row) throw new RuleError('That event does not exist.', 404);
  return row;
}

export async function getOathEvent(id) {
  const { tz } = await localNow();
  return toOwnEvent(await ownRow(id), tz);
}

export async function createOathEvent(input = {}, createdBy = 'you') {
  const { tz, today } = await localNow();
  const c = composeOwn(input, null, tz, today);
  const [row] = await db()`
    insert into oath_events (title, start_at, end_at, all_day, location, notes, created_by, created_at, updated_at)
    values (${c.title}, ${c.start_at}, ${c.end_at}, ${c.all_day}, ${c.location}, ${c.notes}, ${createdBy === 'coach' ? 'coach' : 'you'}, ${ts()}, ${ts()})
    returning *`;
  await logEvent('calendar_event', { action: 'added', id: row.id, by: row.created_by });
  return toOwnEvent(row, tz);
}

export async function updateOathEvent(id, patch = {}) {
  const { tz, today } = await localNow();
  const cur = await ownRow(id);
  const c = composeOwn(patch, localForm(cur, tz), tz, today);
  const [row] = await db()`
    update oath_events set title = ${c.title}, start_at = ${c.start_at}, end_at = ${c.end_at}, all_day = ${c.all_day},
      location = ${c.location}, notes = ${c.notes}, updated_at = ${ts()}
    where id = ${cur.id} returning *`;
  await logEvent('calendar_event', { action: 'changed', id: row.id });
  return toOwnEvent(row, tz);
}

export async function deleteOathEvent(id) {
  const { tz } = await localNow();
  const [row] = await db()`delete from oath_events where id = ${ownIdOf(id)} returning *`;
  if (!row) throw new RuleError('That event does not exist.', 404);
  await logEvent('calendar_event', { action: 'deleted', id: row.id });
  return { ok: true, event: toOwnEvent(row, tz) };
}

// Timed events that overlap this one, so a new booking can say what it lands on.
export async function eventClashes(ev) {
  if (ev.allDay) return [];
  const { tz } = await localNow();
  const day = DateTime.fromISO(ev.start, { zone: tz }).toISODate();
  const s = DateTime.fromISO(ev.start).toMillis();
  const e = DateTime.fromISO(ev.end).toMillis();
  return (await eventsBetween(day, DateTime.fromISO(ev.end, { zone: tz }).toISODate()))
    .filter((x) => x.id !== ev.id && !x.allDay && !x.deadline && DateTime.fromISO(x.start).toMillis() < e && DateTime.fromISO(x.end).toMillis() > s);
}

// ---------- Deadlines: the habits and tasks that fall due inside a range, for the calendar page ----------

// Fixed-day habits on the days they are scheduled, and tasks with a due date. Tasks made from a VLE
// deadline are left out: the deadline feed already shows them as events.
export async function deadlineMarkers(from, to) {
  const { tz } = await localNow();
  const tasks = await db()`
    select id, title, due_date, deadline, hard, done_at from tasks
    where deleted_at is null and ext_uid is null and due_date >= ${from} and due_date <= ${to}
    order by due_date, deadline nulls last, id`;
  const habits = await db()`select * from habits where start_date <= ${to} and (archived_from is null or archived_from > ${from}) order by sort, id`;
  const rest = await restSet();
  const kept = new Set((await db()`select habit_id, date from completions where date >= ${from} and date <= ${to}`).map((r) => `${r.habit_id}:${r.date}`));
  const out = tasks.map((t) => ({
    kind: 'task', id: t.id, title: t.title, date: t.due_date, time: t.deadline || null, done: Boolean(t.done_at), hard: t.hard, midnight: t.deadline === '00:00',
  }));
  for (let d = from; d <= to; d = addDays(d, 1, tz)) {
    for (const h of habits) {
      if (!isScheduled(h, d, tz, rest)) continue;
      const r = rulesOn(h, d);
      out.push({ kind: 'habit', id: h.id, title: h.name, date: d, time: r.deadline, done: kept.has(`${h.id}:${d}`), hard: r.non_negotiable, midnight: r.deadline === '00:00' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '99').localeCompare(String(b.time || '99')) || a.title.localeCompare(b.title));
}

// ---------- Subscribing from Apple Calendar: a secret address that serves Oath's own events ----------

const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Content lines are folded at 75 octets, never inside a character.
function foldLine(line) {
  const parts = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += size;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const icsStamp = (d) => DateTime.fromJSDate(d, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss'Z'");
const icsDay = (d) => DateTime.fromJSDate(d, { zone: 'utc' }).toFormat('yyyyLLdd');

export async function oathIcs() {
  const rows = await db()`select * from oath_events where end_at > ${nowUTC().minus({ days: 90 }).toJSDate()} order by start_at, id`
    .catch(ignoreMissingTables([]));
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Oath//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Oath', `X-APPLE-CALENDAR-COLOR:${OATH_COLOR.toUpperCase()}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
  ];
  for (const r of rows) {
    lines.push('BEGIN:VEVENT', `UID:oath-${r.id}@oath`, `DTSTAMP:${icsStamp(r.updated_at)}`, `LAST-MODIFIED:${icsStamp(r.updated_at)}`);
    if (r.all_day) lines.push(`DTSTART;VALUE=DATE:${icsDay(r.start_at)}`, `DTEND;VALUE=DATE:${icsDay(r.end_at)}`);
    else lines.push(`DTSTART:${icsStamp(r.start_at)}`, `DTEND:${icsStamp(r.end_at)}`);
    lines.push(`SUMMARY:${icsText(r.title)}`);
    if (r.location) lines.push(`LOCATION:${icsText(r.location)}`);
    if (r.notes) lines.push(`DESCRIPTION:${icsText(r.notes)}`);
    lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// The address holds the only secret: anyone with it can read the events. It is stored as it is, so the
// app can show it again, and it is never logged or sent anywhere but to the signed-in app.
async function icalToken({ make = false, rotate = false } = {}) {
  const saved = (await getKV('ical', null))?.token || null;
  if (saved && !rotate) return saved;
  if (!make) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  await setKV('ical', { token, at: ts().toISOString() });
  await logEvent('calendar_subscription', { action: saved ? 'renewed' : 'created' });
  return token;
}

async function icalTokenValid(candidate) {
  const saved = await icalToken();
  if (!saved || typeof candidate !== 'string') return false;
  const sha = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(sha(saved), sha(candidate));
}

// Events overlapping a range, across all feeds, sorted by start (all-day events first on their
// day). from and to are 'YYYY-MM-DD' local dates (both included) or ISO timestamps ([from, to)).
export async function eventsBetween(fromISO, toISO) {
  const { tz } = await localNow();
  const bound = (x, isEnd) => {
    const s = String(x ?? '');
    if (validDate(s)) return DateTime.fromISO(s, { zone: tz }).plus({ days: isEnd ? 1 : 0 });
    const dt = DateTime.fromISO(s, { zone: tz });
    if (!s || !dt.isValid) throw new RuleError('Dates must look like 2026-10-14.');
    return dt;
  };
  const from = bound(fromISO, false);
  const to = bound(toISO ?? fromISO, true);
  if (to <= from) return [];
  const fromDate = from.toISODate();
  const lastDate = to.minus({ milliseconds: 1 }).toISODate();
  const rows = await db()`
    select e.*, f.name as feed, f.color, f.kind from cal_events e join cal_feeds f on f.id = e.feed_id
    where e.start_at < ${to.plus({ days: 1 }).toJSDate()} and coalesce(e.end_at, e.start_at) >= ${from.minus({ days: 1 }).toJSDate()}
    order by e.start_at, e.title`;
  const own = await db()`
    select * from oath_events
    where start_at < ${to.plus({ days: 1 }).toJSDate()} and end_at >= ${from.minus({ days: 1 }).toJSDate()}
    order by start_at, title`.catch(ignoreMissingTables([]));
  const fromMs = from.toMillis();
  const toMs = to.toMillis();
  const sortKey = (ev) => (ev.allDay ? DateTime.fromISO(ev.start, { zone: tz }).toMillis() - 1 : DateTime.fromISO(ev.start).toMillis());
  const inRange = (r) => {
    if (r.all_day) {
      const s = DateTime.fromJSDate(r.start_at, { zone: 'utc' }).toISODate();
      const endExcl = DateTime.fromJSDate(r.end_at || r.start_at, { zone: 'utc' }).toISODate();
      return s <= lastDate && (endExcl > fromDate || s >= fromDate);
    }
    const s = r.start_at.getTime();
    const e = (r.end_at || r.start_at).getTime();
    return s < toMs && (e > fromMs || s >= fromMs);
  };
  const feedRows = rows.filter(inRange);
  const events = [...feedRows.map((r) => toEvent(r, tz)), ...own.filter(inRange).map((r) => toOwnEvent(r, tz))]
    .sort((a, b) => sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));
  const ids = events.map((e) => e.id);
  const marks = ids.length ? await db()`select event_id from event_marks where event_id = any(${ids})`.catch(ignoreMissingTables([])) : [];
  const done = new Set(marks.map((m) => m.event_id));
  // A VLE deadline that became a task is done exactly when that task is, wherever it was ticked.
  const keys = new Map(feedRows.filter((r) => r.kind === 'deadlines').map((r) => [deadlineKey(r), feedEventId(r)]));
  const linked = keys.size ? await db()`select ext_uid, done_at from tasks where ext_uid = any(${[...keys.keys()]}) and deleted_at is null` : [];
  const taskDone = new Map(linked.map((t) => [keys.get(t.ext_uid), Boolean(t.done_at)]));
  return events.map((e) => ({ ...e, done: taskDone.has(e.id) ? taskDone.get(e.id) : done.has(e.id) }));
}

// The live task a VLE deadline became (see deadlineKey), or null.
async function deadlineTaskOf(id) {
  const m = /^(\d+):(.+):(\d+)$/.exec(String(id || ''));
  if (!m) return null;
  const [r] = await db()`select e.feed_id, e.uid, e.start_at, e.orig_start from cal_events e join cal_feeds f on f.id = e.feed_id
    where f.kind = 'deadlines' and e.feed_id = ${Number(m[1])} and e.uid = ${m[2]} and e.start_at = ${new Date(Number(m[3]))}`;
  if (!r) return null;
  const [t] = await db()`select id, done_at from tasks where ext_uid = ${deadlineKey(r)} and deleted_at is null`;
  return t || null;
}

// One event by the id the app shows: oath:<id> for his own, <feed>:<uid>:<start ms> for the others.
export async function eventById(id) {
  const { tz } = await localNow();
  const s = String(id || '');
  const own = /^oath:(\d+)$/.exec(s);
  if (own) {
    const [r] = await db()`select * from oath_events where id = ${Number(own[1])}`;
    return r ? toOwnEvent(r, tz) : null;
  }
  const m = /^(\d+):(.+):(\d+)$/.exec(s);
  if (!m) return null;
  const [r] = await db()`select e.*, f.name as feed, f.color, f.kind from cal_events e join cal_feeds f on f.id = e.feed_id
    where e.feed_id = ${Number(m[1])} and e.uid = ${m[2]} and e.start_at = ${new Date(Number(m[3]))}`;
  return r ? toEvent(r, tz) : null;
}

// Crosses an event off, or back on. Works for every event: the mark is Oath's own, the feed is never changed.
export async function markEventDone(id, done = true) {
  const ev = await eventById(id);
  if (!ev) throw new RuleError('That event is not on the calendar any more.', 404);
  const task = ev.deadline ? await deadlineTaskOf(ev.id) : null;
  if (task) {
    // The deadline and its task are one piece of work, so crossing it off here ticks the task (and back).
    if (done && !task.done_at) await completeTask(task.id);
    else if (!done && task.done_at) await undoTask(task.id);
  } else if (done) {
    await db()`insert into event_marks (event_id, title, date, done_at) values (${ev.id}, ${ev.title}, ${String(ev.start).slice(0, 10)}, ${nowUTC().toJSDate()})
      on conflict (event_id) do update set done_at = excluded.done_at, title = excluded.title`;
  } else {
    await db()`delete from event_marks where event_id = ${ev.id}`;
  }
  await logEvent('event_marked', { id: ev.id, done: Boolean(done) });
  return { ...ev, done: Boolean(done) };
}

export async function eventsForDate(date) {
  if (!validDate(date)) throw new RuleError('Dates must look like 2026-10-14.');
  const events = await eventsBetween(date, date);
  return [...events.filter((e) => e.allDay), ...events.filter((e) => !e.allDay)];
}

// Minutes between two local times on a date that are covered by timed, busy events of
// 'calendar' feeds and Oath's own events, overlaps merged. Deadlines and "free" events do not count.
export async function busyMinutes(date, fromHHMM = '00:00', toHHMM = '23:59') {
  if (!validDate(date) || !validTime(fromHHMM) || !validTime(toHHMM)) return 0;
  const { tz } = await localNow();
  const from = deadlineAt(date, fromHHMM, tz).toMillis();
  const to = deadlineAt(date, toHHMM, tz).toMillis();
  if (to <= from) return 0;
  const feedRows = await db()`
    select e.start_at, e.end_at from cal_events e join cal_feeds f on f.id = e.feed_id
    where f.kind = 'calendar' and not e.all_day and e.busy
      and e.start_at < ${new Date(to)} and e.end_at > ${new Date(from)}`.catch(ignoreMissingTables([]));
  const ownRows = await db()`
    select start_at, end_at from oath_events
    where not all_day and start_at < ${new Date(to)} and end_at > ${new Date(from)}`.catch(ignoreMissingTables([]));
  const spans = [...feedRows, ...ownRows]
    .map((r) => [Math.max(from, r.start_at.getTime()), Math.min(to, r.end_at.getTime())])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total / 60000);
}

// Today's and tomorrow's events as short lines for the coach, or '' when there is nothing.
export async function calendarForCoach() {
  try {
    const { today, tz } = await localNow();
    const [{ n }] = await db()`select (select count(*) from cal_feeds)::int + (select count(*) from oath_events)::int as n`;
    if (!n) return '';
    const lines = [];
    for (const [date, label] of [[today, 'today'], [addDays(today, 1, tz), 'tomorrow']]) {
      const events = await eventsForDate(date);
      if (!events.length) continue;
      lines.push(`Calendar ${label} (${DateTime.fromISO(date, { zone: tz }).toFormat('ccc d LLL')}):`);
      for (const e of events.slice(0, 12)) {
        let when = `${e.time}-${e.endTime}`;
        if (e.allDay) when = e.end !== e.start ? `all day, until ${DateTime.fromISO(e.end).toFormat('ccc d LLL')}` : 'all day';
        else if (e.deadline) when = `due ${e.time}`;
        const title = e.deadline ? cleanDeadlineTitle(e.title) : e.title;
        // Oath's own events carry their id, so the coach can move or delete them.
        lines.push(`  ${when}: ${title}${e.location ? ` (${e.location})` : ''}${e.deadline ? ' [VLE deadline]' : ''}${e.own ? ` [Oath event #${e.ownId}]` : ''}`);
      }
      if (events.length > 12) lines.push(`  and ${events.length - 12} more`);
    }
    if (!lines.length) return '';
    const failing = await db()`select name from cal_feeds where last_error is not null order by id`;
    if (failing.length) lines.push(`Calendar sync is failing for: ${failing.map((f) => f.name).join(', ')}.`);
    return lines.join('\n');
  } catch (err) {
    return ignoreMissingTables('')(err);
  }
}

// ---------- API (mounted under the authenticated /api) ----------

export const calendarApi = new Hono();

const jsonBody = async (c) => {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
};

calendarApi.get('/calendar/feeds', async (c) => c.json({ feeds: await listFeeds() }));
calendarApi.post('/calendar/feeds', async (c) => c.json(await addFeed(await jsonBody(c))));
calendarApi.delete('/calendar/feeds/:id', async (c) => c.json(await removeFeed(c.req.param('id'))));
calendarApi.post('/calendar/sync', async (c) => c.json({ results: await syncAllFeeds({ force: true }), feeds: await listFeeds() }));
// A range of local dates from the query, at most MAX_RANGE_DAYS long.
async function rangeOf(c) {
  const { today, tz } = await localNow();
  const from = c.req.query('from') || today;
  const to = c.req.query('to') || from;
  if (!validDate(from) || !validDate(to)) throw new RuleError('Dates must look like 2026-10-14.');
  if (to < from) throw new RuleError('The end date is before the start date.');
  const days = DateTime.fromISO(to, { zone: tz }).diff(DateTime.fromISO(from, { zone: tz }), 'days').days + 1;
  if (days > MAX_RANGE_DAYS) throw new RuleError(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
  return { from, to };
}

calendarApi.get('/calendar/events', async (c) => {
  const { from, to } = await rangeOf(c);
  return c.json({ from, to, events: await eventsBetween(from, to), syncedTo: await syncedThrough() });
});
// Oath's own events. Feed events stay read-only: their ids are not numbers, so they cannot be reached here.
calendarApi.post('/calendar/events', async (c) => c.json({ event: await createOathEvent(await jsonBody(c)) }));
calendarApi.patch('/calendar/events/:id', async (c) => c.json({ event: await updateOathEvent(c.req.param('id'), await jsonBody(c)) }));
calendarApi.delete('/calendar/events/:id', async (c) => c.json({ ok: true, event: (await deleteOathEvent(c.req.param('id'))).event }));
// Crossing an event off works for every event, his own and his other calendars' (the mark is Oath's own).
calendarApi.post('/calendar/events/:id/done', async (c) => c.json({ event: await markEventDone(c.req.param('id'), (await jsonBody(c)).done !== false) }));
// Habits and tasks falling due in a range, drawn as markers on the calendar page.
calendarApi.get('/calendar/markers', async (c) => {
  const { from, to } = await rangeOf(c);
  return c.json({ from, to, markers: await deadlineMarkers(from, to) });
});

// The address to subscribe to from Apple Calendar. GET shows it (if there is one); POST makes it, or
// with { rotate: true } makes a new one and turns the old one off.
function subscriptionFor(c, token) {
  if (!token) return { on: false, url: null, webcal: null };
  const domain = process.env.PUBLIC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN;
  const origin = domain ? `https://${domain}` : new URL(c.req.url).origin;
  const url = `${origin}/ical/${token}.ics`;
  return { on: true, url, webcal: url.replace(/^https?:/, 'webcal:') };
}
calendarApi.get('/calendar/subscription', async (c) => c.json(subscriptionFor(c, await icalToken())));
calendarApi.post('/calendar/subscription', async (c) => {
  const b = await jsonBody(c);
  return c.json(subscriptionFor(c, await icalToken({ make: true, rotate: Boolean(b.rotate) })));
});

// Mounted outside /api and the login: Apple Calendar cannot sign in, so the address carries the secret.
// A wrong or missing one is a plain 404, which tells a guesser nothing.
export const calendarPublic = new Hono();
calendarPublic.get('/ical/:file', async (c) => {
  const file = c.req.param('file');
  if (!/\.ics$/i.test(file) || !(await icalTokenValid(file.replace(/\.ics$/i, '')))) return c.text('Not found.', 404);
  return c.body(await oathIcs(), 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
});
