// Calendar feeds: the iCalendar parser (Google, Outlook, iCloud and Moodle shapes), feed sync from a
// local http server, VLE deadlines becoming tasks, busy time, the coach text and the API routes,
// against a real Postgres with a controllable clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime, IANAZone } from 'luxon';
import { Hono } from 'hono';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-12T08:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-calendar-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54342,
  persistent: false, createPostgresUser: true, onLog: () => {}, onError: () => {},
});

// ---------- A local calendar server ----------

const routes = new Map(); // pathname -> { status, body, type, location, gzip, chunked, hang }
const hits = new Map();
const sockets = new Set();
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://local');
  hits.set(pathname, (hits.get(pathname) || 0) + 1);
  const r = routes.get(pathname);
  if (!r) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (r.hang) return; // never answers
  if (r.location) {
    res.writeHead(r.status || 302, { location: r.location });
    res.end();
    return;
  }
  const headers = { 'content-type': r.type || 'text/calendar; charset=utf-8' };
  if (r.chunked) {
    res.writeHead(200, headers);
    const mb = Buffer.alloc(1024 * 1024, 'x');
    let n = 0;
    const pump = () => {
      while (n < r.chunked && res.write(mb)) n += 1;
      if (n < r.chunked) res.once('drain', () => { n += 1; pump(); });
      else res.end();
    };
    res.write('BEGIN:VCALENDAR\r\n');
    pump();
    return;
  }
  let body = typeof r.body === 'function' ? r.body() : r.body;
  if (r.gzip) {
    body = zlib.gzipSync(body);
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(r.status || 200, headers);
  res.end(body);
});
server.on('connection', (s) => {
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
});
let base = '';
let port = 0;
const serve = (p, spec) => routes.set(p, spec);
const realLookup = dns.lookup;

// ---------- Harness ----------

let cal; let dbmod; let engine; let app; let RuleError;

async function call(method, url, json) {
  const headers = {};
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54342/oath';
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  cal = await import('../src/calendar.js');
  await cal.migrateCalendar();
  await cal.migrateCalendar(); // idempotent
  cal.setCalendarTestHooks({ allowLocal: true });
  engine = await import('../src/engine.js');
  ({ RuleError } = engine);
  app = new Hono();
  app.onError((err, c) => {
    if (err instanceof RuleError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Something broke on the server.' }, 500);
  });
  app.route('/api', cal.calendarApi);
});

after(async () => {
  await dbmod.close();
  for (const s of sockets) s.destroy();
  await new Promise((resolve) => server.close(resolve));
  await pg.stop();
});

async function reset(iso = '2026-10-12T08:00') {
  setLocal(iso);
  routes.clear();
  hits.clear();
  cal.setCalendarTestHooks({ allowLocal: true, rewriteUrl: null, timeoutMs: null });
  await dbmod.db().unsafe('truncate cal_feeds, cal_events, tasks, events restart identity cascade');
}

const sql = () => dbmod.db();
const tasks = async () => sql()`select * from tasks where deleted_at is null order by due_date, id`;
const window = () => ({ from: DateTime.fromISO('2026-10-11', { zone: ZONE }), to: DateTime.fromISO('2026-12-12', { zone: ZONE }) });
const at = (o) => (o.allDay ? o.start.toISODate() : o.start.setZone(ZONE).toFormat('yyyy-MM-dd HH:mm'));
const titles = (events) => events.map((e) => e.title);

async function addGoogle(extra = {}) {
  serve('/calendar/ical/daniel%40gmail.com/private-abc123/basic.ics', { body: fixture('google.ics'), gzip: true });
  return cal.addFeed({ url: `${base}/calendar/ical/daniel%40gmail.com/private-abc123/basic.ics`, ...extra });
}

// Wrap VEVENT lines into a calendar and expand it over the test window.
function expandInline(body, uid) {
  const lines = body.trim().split('\n').map((l) => l.trim());
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
  const occ = cal.expandCalendar(cal.parseICS(ics), { zone: ZONE, ...window() });
  return occ.filter((o) => !uid || o.uid === uid).map(at);
}

// ---------- Parser ----------

test('parser: Google feed with folded lines, escapes, a fold inside a UTF-8 character, weekly RRULE, EXDATE, a moved and a cancelled occurrence', () => {
  const parsed = cal.parseICS(fixture('google.ics'));
  assert.equal(parsed.name, 'Daniel');
  const occ = cal.expandCalendar(parsed, { zone: ZONE, ...window() });

  const study = occ.find((o) => o.uid === 'study-group@google.com');
  assert.equal(study.title, 'Study group: chapters 4, 5 and 6; bring the notes from last week');
  assert.equal(study.location, 'Library, Level 2');
  assert.equal(study.description, 'Line one\nLine two with a backslash \\ here, and a comma');
  assert.equal(occ.find((o) => o.uid === 'call@google.com').title, "Kafè ma' Ġorġ");

  // Mondays and Wednesdays at 09:00 Malta time: the 19th is excluded, the 21st moved to 14:00,
  // the 28th cancelled, and the clocks change on 25 October without moving the lecture.
  const lectures = occ.filter((o) => o.uid === 'lecture-cps1011@google.com');
  assert.deepEqual(lectures.map(at), [
    '2026-10-12 09:00', '2026-10-14 09:00', '2026-10-21 14:00', '2026-10-26 09:00', '2026-11-02 09:00',
    '2026-11-04 09:00', '2026-11-09 09:00', '2026-11-11 09:00', '2026-11-16 09:00', '2026-11-18 09:00',
    '2026-11-23 09:00', '2026-11-25 09:00', '2026-11-30 09:00', '2026-12-02 09:00', '2026-12-07 09:00',
    '2026-12-09 09:00',
  ]);
  assert.equal(lectures[0].start.toUTC().toISO(), '2026-10-12T07:00:00.000Z');
  assert.equal(lectures[3].start.toUTC().toISO(), '2026-10-26T08:00:00.000Z');
  assert.equal(lectures[0].end.setZone(ZONE).toFormat('HH:mm'), '11:00');
  const moved = lectures[2];
  assert.equal(moved.title, 'CPS1011 Lecture (moved)');
  assert.equal(moved.location, 'Room 5');
  assert.equal(moved.end.setZone(ZONE).toFormat('HH:mm'), '16:00');
  assert.equal(moved.origStart, '2026-10-21T07:00:00.000Z'); // keyed by the original start
  assert.equal(lectures[0].description, ''); // the VALARM's DESCRIPTION stays inside the alarm

  // DURATION and COUNT with INTERVAL.
  const revision = occ.filter((o) => o.uid === 'revision@google.com');
  assert.deepEqual(revision.map(at), ['2026-10-12 20:00', '2026-10-14 20:00', '2026-10-16 20:00']);
  assert.equal(revision[0].end.setZone(ZONE).toFormat('HH:mm'), '21:00');

  // All-day events keep their dates; the end is exclusive.
  const trip = occ.find((o) => o.uid === 'fieldtrip@google.com');
  assert.equal(trip.allDay, true);
  assert.equal(trip.title, 'Field trip, Gozo');
  assert.equal(trip.start.toISODate(), '2026-10-15');
  assert.equal(trip.end.toISODate(), '2026-10-18');
  assert.equal(occ.find((o) => o.uid === 'birthday-mum@google.com').busy, false);

  assert.ok(!occ.some((o) => o.title === 'Cancelled meeting'));
  assert.ok(!occ.some((o) => o.title === 'Old event')); // before the window
  assert.equal(occ.length, 25);
});

test('parser: Outlook feed with Windows zone names, an old Exchange display name, a custom VTIMEZONE, free time and monthly rules', () => {
  const occ = cal.expandCalendar(cal.parseICS(fixture('outlook.ics')), { zone: ZONE, ...window() });
  const one = (title) => occ.find((o) => o.title === title);
  const utc = (o) => o.start.toUTC().toISO();

  const sync = occ.filter((o) => o.title === 'Team sync');
  assert.deepEqual(sync.slice(0, 3).map(at), ['2026-10-13 10:00', '2026-10-20 10:00', '2026-10-27 10:00']);
  assert.equal(utc(sync[0]), '2026-10-13T08:00:00.000Z'); // W. Europe Standard Time, summer
  assert.equal(utc(sync[2]), '2026-10-27T09:00:00.000Z'); // after the clocks change
  assert.equal(sync.length, 9);
  assert.equal(sync[0].location, 'Microsoft Teams Meeting');
  assert.equal(utc(one('Call with the London office')), '2026-10-14T08:00:00.000Z'); // GMT Standard Time = London, BST
  assert.equal(utc(one('Call with New York')), '2026-10-15T13:00:00.000Z'); // Eastern Standard Time, EDT
  assert.equal(utc(one('Old Exchange zone name')), '2026-10-16T14:00:00.000Z'); // "(UTC-05:00) Eastern Time (US & Canada)"
  // "Customized Time Zone" exists only as the feed's own VTIMEZONE (+04:00 summer, +03:00 winter).
  assert.equal(utc(one('Custom zone before the clocks change')), '2026-10-20T06:00:00.000Z');
  assert.equal(utc(one('Custom zone after the clocks change')), '2026-10-27T07:00:00.000Z');
  assert.equal(one('Focus time').busy, false); // X-MICROSOFT-CDO-BUSYSTATUS:FREE
  assert.equal(one('Team sync').busy, true);
  // BYDAY=-1FR (last Friday) and BYDAY=MO..FR;BYSETPOS=1 (first weekday).
  assert.deepEqual(occ.filter((o) => o.title === 'Check pay slip').map(at), ['2026-10-30 12:00', '2026-11-27 12:00']);
  assert.deepEqual(occ.filter((o) => o.title === 'Monthly report').map(at), ['2026-11-02 09:00', '2026-12-01 09:00']);
});

test('parser: more RRULE shapes, UNTIL, COUNT with EXDATE, and an occurrence moved into the window', () => {
  // Last day of the month.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:a
    DTSTART;TZID=Europe/Malta:20260930T100000
    RRULE:FREQ=MONTHLY;BYMONTHDAY=-1
    END:VEVENT`), ['2026-10-31 10:00', '2026-11-30 10:00']);
  // The 31st skips months without one.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:b
    DTSTART;TZID=Europe/Malta:20260831T100000
    RRULE:FREQ=MONTHLY
    END:VEVENT`), ['2026-10-31 10:00']);
  // First Monday of the month.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:c
    DTSTART;TZID=Europe/Malta:20261005T183000
    DTEND;TZID=Europe/Malta:20261005T193000
    RRULE:FREQ=MONTHLY;BYDAY=1MO
    END:VEVENT`), ['2026-11-02 18:30', '2026-12-07 18:30']);
  // Every other Thursday.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:d
    DTSTART;TZID=Europe/Malta:20261001T120000
    RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH
    END:VEVENT`), ['2026-10-15 12:00', '2026-10-29 12:00', '2026-11-12 12:00', '2026-11-26 12:00', '2026-12-10 12:00']);
  // All-day weekly with COUNT=4; the excluded date still counts towards COUNT.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:e
    DTSTART;VALUE=DATE:20261013
    RRULE:FREQ=WEEKLY;COUNT=4
    EXDATE;VALUE=DATE:20261020
    END:VEVENT`), ['2026-10-13', '2026-10-27', '2026-11-03']);
  // A yearly all-day event from 1999 (fast-forwarded, not walked).
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:f
    DTSTART;VALUE=DATE:19991105
    DTEND;VALUE=DATE:19991106
    RRULE:FREQ=YEARLY
    END:VEVENT`), ['2026-11-05']);
  // UNTIL as a date is inclusive.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:g
    DTSTART;TZID=Europe/Malta:20261020T070000
    RRULE:FREQ=DAILY;UNTIL=20261023
    END:VEVENT`), ['2026-10-20 07:00', '2026-10-21 07:00', '2026-10-22 07:00', '2026-10-23 07:00']);
  // DAILY limited by BYDAY, with COUNT.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:h
    DTSTART;TZID=Europe/Malta:20261012T060000
    RRULE:FREQ=DAILY;BYDAY=MO,WE,FR;COUNT=5
    END:VEVENT`), ['2026-10-12 06:00', '2026-10-14 06:00', '2026-10-16 06:00', '2026-10-19 06:00', '2026-10-21 06:00']);
  // A daily event since 1990 keeps 08:00 local across the clock change: 62 days in the window.
  const daily = expandInline(`BEGIN:VEVENT
    UID:i
    DTSTART;TZID=Europe/Malta:19900101T080000
    RRULE:FREQ=DAILY
    END:VEVENT`);
  assert.equal(daily.length, 62);
  assert.ok(daily.every((d) => d.endsWith(' 08:00')));
  // A series that ended in early October, with one occurrence moved into the window.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:j
    DTSTART;TZID=Europe/Malta:20260901T100000
    DTEND;TZID=Europe/Malta:20260901T110000
    RRULE:FREQ=WEEKLY;UNTIL=20261006T235959Z
    SUMMARY:Seminar
    END:VEVENT
    BEGIN:VEVENT
    UID:j
    RECURRENCE-ID;TZID=Europe/Malta:20260929T100000
    DTSTART;TZID=Europe/Malta:20261013T100000
    DTEND;TZID=Europe/Malta:20261013T110000
    SUMMARY:Seminar (rescheduled)
    END:VEVENT`), ['2026-10-13 10:00']);
  // Yearly on the last Sunday of October, as time zone rules are written.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:k
    DTSTART;TZID=Europe/Malta:20201025T120000
    RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
    END:VEVENT`), ['2026-10-25 12:00']);
  // A floating time is the user's local time; a timed event with no end has no length.
  const floating = cal.expandCalendar(cal.parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:l\nDTSTART:20261013T090000\nEND:VEVENT\nEND:VCALENDAR\n'), { zone: ZONE, ...window() });
  assert.equal(floating[0].start.toUTC().toISO(), '2026-10-13T07:00:00.000Z');
  assert.equal(floating[0].end.toMillis(), floating[0].start.toMillis());
  // An unknown TZID with no definition falls back to the user's zone.
  assert.deepEqual(expandInline(`BEGIN:VEVENT
    UID:m
    DTSTART;TZID=Somewhere Odd:20261013T090000
    END:VEVENT`), ['2026-10-13 09:00']);
});

test('parser: rejects web pages and junk, and every Windows zone maps to a real IANA zone', () => {
  assert.throws(() => cal.parseICS('<!doctype html><html><body>Sign in</body></html>'), (e) => e instanceof RuleError && /web page, not a calendar/.test(e.message));
  assert.throws(() => cal.parseICS('{"ok":true}'), (e) => e instanceof RuleError && /did not return a calendar/.test(e.message));
  assert.equal(cal.expandCalendar(cal.parseICS('﻿BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'), { zone: ZONE, ...window() }).length, 0);
  const bad = Object.entries(cal.WINDOWS_ZONES).filter(([, z]) => !IANAZone.isValidZone(z));
  assert.deepEqual(bad, []);
  for (const z of ['W. Europe Standard Time', 'GMT Standard Time', 'Eastern Standard Time', 'Pacific Standard Time', 'China Standard Time', 'India Standard Time', 'Tokyo Standard Time', 'Singapore Standard Time']) {
    assert.ok(cal.WINDOWS_ZONES[z], z);
  }
});

test('deadline titles: Moodle suffixes are trimmed and "opens" events are not deadlines', () => {
  assert.equal(cal.cleanDeadlineTitle('Assignment 1 is due'), 'Assignment 1');
  assert.equal(cal.cleanDeadlineTitle('Quiz 2 closes'), 'Quiz 2');
  assert.equal(cal.cleanDeadlineTitle('Essay due.'), 'Essay');
  assert.equal(cal.cleanDeadlineTitle('Peer review (submissions deadline)'), 'Peer review');
  assert.equal(cal.cleanDeadlineTitle('Report should be completed'), 'Report');
  assert.equal(cal.cleanDeadlineTitle('Exam'), 'Exam');
  assert.equal(cal.cleanDeadlineTitle('is due'), 'is due');
  assert.equal(cal.cleanDeadlineTitle(''), 'VLE deadline');
  assert.equal(cal.isOpeningEvent('Quiz 2 opens'), true);
  assert.equal(cal.isOpeningEvent('Peer review (opens for submissions)'), true);
  assert.equal(cal.isOpeningEvent('Assignment 1 is due'), false);
});

// ---------- Feeds ----------

test('Google feed: fetched (gzip) from its secret address, stored inside the window, read back per day', async () => {
  await reset();
  const r = await addGoogle();
  assert.equal(r.feed.name, 'Daniel');
  assert.equal(r.feed.kind, 'calendar');
  assert.equal(r.events, 25);
  assert.equal(r.created, 0);
  assert.equal(r.feed.eventCount, 25);
  assert.equal(r.feed.lastError, null);
  assert.equal(r.feed.lastSync, clock.toUTC().toISO());
  assert.match(r.feed.color, /^#[0-9a-f]{6}$/);

  const feeds = await cal.listFeeds();
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].host, `127.0.0.1:${port}`);
  assert.equal(feeds[0].url, `http://127.0.0.1:${port}/calendar/…/basic.ics`);
  assert.ok(!JSON.stringify(feeds).includes('private-abc123'));
  assert.ok(!JSON.stringify(feeds).includes('daniel'));

  const mon = await cal.eventsForDate('2026-10-12');
  assert.deepEqual(titles(mon), ['CPS1011 Lecture', 'Study group: chapters 4, 5 and 6; bring the notes from last week', 'Gym', 'Optional talk', 'Revision sprint']);
  assert.deepEqual(mon[0], {
    id: mon[0].id, feedId: 1, feed: 'Daniel', color: r.feed.color, title: 'CPS1011 Lecture',
    start: '2026-10-12T09:00:00+02:00', end: '2026-10-12T11:00:00+02:00', allDay: false, time: '09:00', endTime: '11:00',
    location: 'Room 202', busy: true, deadline: false,
  });
  const tue = await cal.eventsForDate('2026-10-13');
  assert.deepEqual(titles(tue), ["Mum's birthday", "Kafè ma' Ġorġ"]); // all-day first; the cancelled meeting is gone
  assert.deepEqual([tue[0].allDay, tue[0].start, tue[0].end, tue[0].time], [true, '2026-10-13', '2026-10-13', null]);
  assert.equal(tue[1].start, '2026-10-13T19:00:00+02:00');
  const fri = await cal.eventsForDate('2026-10-16');
  assert.deepEqual(titles(fri), ['Field trip, Gozo', 'Revision sprint']);
  assert.deepEqual([fri[0].start, fri[0].end], ['2026-10-15', '2026-10-17']); // last day inclusive
  assert.deepEqual(await cal.eventsForDate('2026-10-19'), []); // EXDATE
  const moved = await cal.eventsForDate('2026-10-21');
  assert.deepEqual(moved.map((e) => [e.title, e.time, e.endTime, e.location]), [['CPS1011 Lecture (moved)', '14:00', '16:00', 'Room 5']]);
  assert.deepEqual(await cal.eventsForDate('2026-10-28'), []); // cancelled occurrence
  assert.equal((await cal.eventsForDate('2026-10-26'))[0].start, '2026-10-26T09:00:00+01:00');
  assert.deepEqual(await cal.eventsForDate('2026-12-28'), []); // beyond the 60-day window

  const [{ n }] = await sql()`select count(*)::int as n from cal_events where start_at < '2026-10-10'`;
  assert.equal(n, 0);
  const range = await cal.eventsBetween('2026-10-12', '2026-10-13');
  assert.equal(range.length, 7);
  assert.deepEqual(range.map((e) => e.start).slice(-2), ['2026-10-13', '2026-10-13T19:00:00+02:00']);

  // Two weeks later the window has moved on: late December appears, nothing duplicates.
  setLocal('2026-11-01T09:00');
  const again = await cal.syncFeed(r.feed.id);
  assert.equal(again.ok, true);
  assert.deepEqual(titles(await cal.eventsForDate('2026-12-28')), ['CPS1011 Lecture']);
  assert.deepEqual(titles(await cal.eventsForDate('2026-10-12')), titles(mon)); // history kept
  const [{ dupes }] = await sql()`select count(*)::int as dupes from (select uid, start_at from cal_events group by 1, 2 having count(*) > 1) d`;
  assert.equal(dupes, 0);
  assert.equal(hits.get('/calendar/ical/daniel%40gmail.com/private-abc123/basic.ics'), 2);
});

test('busy minutes: timed busy events only, overlaps merged, clipped to the range', async () => {
  await reset();
  await addGoogle();
  // Lecture 09-11, study group 14:00-15:30 overlapping gym 15-16, revision 20-21. The optional
  // talk is marked free and the birthday is all day.
  assert.equal(await cal.busyMinutes('2026-10-12', '08:00', '22:00'), 120 + 120 + 60);
  assert.equal(await cal.busyMinutes('2026-10-12', '10:00', '15:00'), 60 + 60);
  assert.equal(await cal.busyMinutes('2026-10-12', '15:15', '15:45'), 30);
  assert.equal(await cal.busyMinutes('2026-10-12', '22:00', '08:00'), 0);
  assert.equal(await cal.busyMinutes('2026-10-13'), 60); // the cancelled meeting does not count
  assert.equal(await cal.busyMinutes('bad', '08:00', '22:00'), 0);

  // Outlook: "Focus time" is marked free.
  serve('/owa/calendar/abc@um.edu.mt/def/calendar.ics', { body: fixture('outlook.ics') });
  await cal.addFeed({ url: `${base}/owa/calendar/abc@um.edu.mt/def/calendar.ics` });
  assert.equal(await cal.busyMinutes('2026-10-13', '00:00', '23:59'), 60 + 60);

  // A deadlines feed never makes time busy, even with long events.
  serve('/copy.ics', { body: fixture('google.ics') });
  const d = await cal.addFeed({ url: `${base}/copy.ics`, kind: 'deadlines', name: 'Copy' });
  assert.equal(d.feed.kind, 'deadlines');
  assert.equal(await cal.busyMinutes('2026-10-12', '08:00', '22:00'), 300);
});

test('Outlook feed: Windows zones land at the right local time', async () => {
  await reset();
  serve('/owa/calendar/abc@um.edu.mt/def/calendar.ics', { body: fixture('outlook.ics') });
  const r = await cal.addFeed({ url: `${base}/owa/calendar/abc@um.edu.mt/def/calendar.ics` });
  assert.equal(r.feed.name, 'Calendar');
  assert.equal(r.feed.kind, 'calendar');
  const tue = await cal.eventsForDate('2026-10-13');
  assert.deepEqual(tue.map((e) => [e.title, e.time, e.endTime, e.busy]), [['Team sync', '10:00', '11:00', true], ['Focus time', '14:00', '16:00', false]]);
  assert.deepEqual((await cal.eventsForDate('2026-10-15')).map((e) => [e.title, e.time]), [['Call with New York', '15:00']]);
  assert.deepEqual((await cal.eventsForDate('2026-10-27')).map((e) => [e.title, e.time]), [['Custom zone after the clocks change', '08:00'], ['Team sync', '10:00']]);
});

test('Moodle deadlines feed: tasks once, re-sync does not duplicate, a moved deadline updates the task, re-adding adopts the tasks', async () => {
  await reset();
  let current = fixture('moodle.ics');
  serve('/vle/calendar/export_execute.php', { body: () => current });
  const url = `${base}/vle/calendar/export_execute.php?userid=1234&authtoken=s3cr3t&preset_what=all&preset_time=recentupcoming`;
  const r = await cal.addFeed({ url });
  assert.equal(r.feed.kind, 'deadlines'); // auto-detected from export_execute.php
  assert.equal(r.feed.name, 'VLE deadlines');
  assert.equal(r.created, 4);
  assert.equal(r.feed.url, `http://127.0.0.1:${port}/vle/…/export_execute.php?…`);
  assert.ok(!JSON.stringify(await cal.listFeeds()).includes('s3cr3t'));

  let list = await tasks();
  assert.deepEqual(list.map((t) => [t.title, t.due_date, t.deadline]), [
    ['Lab sheet 3 (ICS1018)', '2026-10-12', '22:00'], // course code found in the description
    ['Quiz 2 (ARI1120)', '2026-10-16', '17:00'], // "Quiz 2 opens" is not a deadline
    ['Assignment 1 (CPS1011)', '2026-10-20', '23:59'], // 21:59 UTC is 23:59 in Malta
    ['Project proposal', '2026-10-30', null], // all day: no time; yesterday's reading log is skipped
  ]);
  assert.ok(list.every((t) => !t.hard && t.created_by === 'vle'));
  const assignment = list.find((t) => t.title.startsWith('Assignment 1'));
  assert.equal(assignment.notes, 'Course: CPS1011-SEM1-A-2627\nUpload your report as one PDF.\nFrom the VLE calendar.');
  assert.equal(assignment.ext_uid, 'cal:1:5501@www.um.edu.mt:2026-10-20T21:59:00.000Z');
  assert.equal(list.find((t) => t.title === 'Project proposal').notes, 'Course: Orientation 2026\nFrom the VLE calendar.');

  // The deadlines also show as events, flagged.
  const due = await cal.eventsForDate('2026-10-20');
  assert.deepEqual(due.map((e) => [e.title, e.time, e.deadline]), [['Assignment 1 is due', '23:59', true]]);

  // Syncing again changes nothing.
  const again = await cal.syncFeed(r.feed.id);
  assert.deepEqual([again.created, again.updated], [0, 0]);
  assert.equal((await tasks()).length, 4);

  // He finishes the quiz. Then the lecturer extends the assignment, moves the quiz, removes the lab
  // sheet and adds an essay.
  setLocal('2026-10-13T09:00');
  const quiz = list.find((t) => t.title.startsWith('Quiz 2'));
  await engine.completeTask(quiz.id);
  current = fixture('moodle-moved.ics');
  const moved = await cal.syncFeed(r.feed.id);
  assert.deepEqual([moved.created, moved.updated], [1, 1]);
  list = await tasks();
  assert.deepEqual(list.map((t) => [t.title, t.due_date, t.deadline, Boolean(t.done_at)]), [
    ['Lab sheet 3 (ICS1018)', '2026-10-12', '22:00', false], // kept, it is his task now
    ['Quiz 2 (ARI1120)', '2026-10-16', '17:00', true], // done: left alone
    ['Assignment 1 (CPS1011)', '2026-10-22', '12:00', false], // moved
    ['Project proposal', '2026-10-30', null, false],
    ['Final essay (CPS1011)', '2026-11-20', '23:59', false], // new; 22:59 UTC in winter
  ]);
  assert.equal(list.find((t) => t.title.startsWith('Assignment 1')).ext_uid, 'cal:1:5501@www.um.edu.mt:2026-10-22T10:00:00.000Z');
  assert.deepEqual(Object.values(await cal.syncFeed(r.feed.id)).slice(-2), [0, 0]);

  // Removing the feed keeps the tasks and drops the events; adding it again adopts the tasks.
  await cal.removeFeed(r.feed.id);
  assert.equal((await tasks()).length, 5);
  assert.equal((await sql()`select count(*)::int as n from cal_events`)[0].n, 0);
  const back = await cal.addFeed({ url });
  assert.equal(back.created, 0);
  assert.equal((await tasks()).length, 5);
  assert.equal((await tasks()).find((t) => t.title.startsWith('Assignment 1')).ext_uid, `cal:${back.feed.id}:5501@www.um.edu.mt:2026-10-22T10:00:00.000Z`);

  // An explicit kind wins over auto-detection.
  serve('/vle2/calendar/export_execute.php', { body: fixture('moodle.ics') });
  const plain = await cal.addFeed({ url: `${base}/vle2/calendar/export_execute.php?x=1`, kind: 'calendar' });
  assert.equal(plain.feed.kind, 'calendar');
  assert.equal(plain.created, 0);
  assert.equal((await tasks()).length, 5);
  assert.equal(await cal.busyMinutes('2026-10-16'), 0); // zero-length deadlines are never busy
});

test('webcal:// links become https://', async () => {
  await reset();
  assert.equal(cal.normalizeFeedUrl('webcal://p52-caldav.icloud.com/published/2/MTIzNDU2'), 'https://p52-caldav.icloud.com/published/2/MTIzNDU2');
  assert.equal(cal.normalizeFeedUrl(' WEBCAL://p52-caldav.icloud.com/published/2/x#frag '), 'https://p52-caldav.icloud.com/published/2/x');
  // Point https at the local plain-http server to prove the converted link is what gets fetched.
  cal.setCalendarTestHooks({ rewriteUrl: (u) => u.replace(`https://127.0.0.1:${port}/`, `http://127.0.0.1:${port}/`) });
  serve('/published/2/icloud.ics', { body: fixture('icloud.ics') });
  const r = await cal.addFeed({ url: `webcal://127.0.0.1:${port}/published/2/icloud.ics` });
  assert.equal(r.feed.name, 'Home');
  assert.equal(r.feed.url, `https://127.0.0.1:${port}/published/…/icloud.ics`);
  assert.equal((await sql()`select url from cal_feeds`)[0].url, `https://127.0.0.1:${port}/published/2/icloud.ics`);
  assert.equal(hits.get('/published/2/icloud.ics'), 1);
  assert.deepEqual((await cal.eventsForDate('2026-10-17')).map((e) => [e.title, e.time, e.location]), [['Dentist', '10:30', 'Triq il-Kbira Marsaskala']]);
  assert.deepEqual((await cal.eventsForDate('2026-10-18')).map((e) => [e.title, e.time]), [['Floating breakfast', '09:00']]);
});

test('links: other schemes, plain http and private or loopback hosts are refused outside tests', async () => {
  await reset();
  const saved = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  cal.setCalendarTestHooks({ allowLocal: false });
  try {
    const cases = [
      ['ftp://example.com/cal.ics', /start with https:\/\/ or webcal/],
      ['http://example.com/cal.ics', /secure link/],
      ['https://127.0.0.1/cal.ics', /private network/],
      ['https://localhost/cal.ics', /private network/],
      ['https://10.1.2.3/cal.ics', /private network/],
      ['https://192.168.1.20/cal.ics', /private network/],
      ['https://169.254.169.254/latest/meta-data', /private network/],
      ['https://[::1]/cal.ics', /private network/],
      ['https://[::ffff:127.0.0.1]/cal.ics', /private network/],
      ['https://2130706433/cal.ics', /private network/],
      ['https://postgres.railway.internal/cal.ics', /private network/],
      ['https://user:pass@example.com/cal.ics', /user name or password/],
      ['not a link', /does not look like a link/],
      ['', /Paste the calendar link/],
      [`${base}/cal.ics`, /secure link/],
    ];
    for (const [url, re] of cases) {
      await assert.rejects(cal.addFeed({ url }), (e) => e instanceof RuleError && re.test(e.message), url);
    }
    await assert.rejects(cal.addFeed({ url: 'https://calendar.example.com/x.ics', kind: 'birthdays' }), /calendar" or "deadlines/);
    // A public-looking name that resolves to a private address is refused at connect time.
    dns.lookup = (host, opts, cb) => (host === 'calendar.example.com' ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : realLookup(host, opts, cb));
    cal.setCalendarTestHooks({ rewriteUrl: (u) => u.replace('https://calendar.example.com', 'http://calendar.example.com') });
    serve('/x.ics', { body: fixture('icloud.ics') });
    await assert.rejects(cal.addFeed({ url: `https://calendar.example.com:${port}/x.ics` }), /private network/);
    assert.equal(hits.get('/x.ics'), undefined);
  } finally {
    dns.lookup = realLookup;
    if (saved !== undefined) process.env.NODE_ENV = saved;
    cal.setCalendarTestHooks({ allowLocal: true, rewriteUrl: null });
  }
  assert.equal((await sql()`select count(*)::int as n from cal_feeds`)[0].n, 0);
});

test('links: a web page, a 404, redirects, a hanging server, an oversized file and duplicates', async () => {
  await reset();
  serve('/page', { body: '<!DOCTYPE html><html><body>Log in to the VLE</body></html>', type: 'text/html' });
  await assert.rejects(cal.addFeed({ url: `${base}/page` }), /web page, not a calendar file/);
  serve('/json', { body: '{"ok":true}', type: 'application/json' });
  await assert.rejects(cal.addFeed({ url: `${base}/json` }), /did not return a calendar/);
  await assert.rejects(cal.addFeed({ url: `${base}/missing.ics` }), /Nothing was found at that link \(error 404\)/);
  serve('/forbidden.ics', { status: 403, body: 'no' });
  await assert.rejects(cal.addFeed({ url: `${base}/forbidden.ics` }), /refused access \(error 403\)/);
  serve('/loop', { status: 302, location: '/loop' });
  await assert.rejects(cal.addFeed({ url: `${base}/loop` }), /redirected too many times/);
  cal.setCalendarTestHooks({ timeoutMs: 300 });
  serve('/slow.ics', { hang: true });
  await assert.rejects(cal.addFeed({ url: `${base}/slow.ics` }), /took longer than 15 seconds/);
  cal.setCalendarTestHooks({ timeoutMs: null });
  serve('/huge.ics', { chunked: 11 });
  await assert.rejects(cal.addFeed({ url: `${base}/huge.ics` }), /larger than 10 MB/);
  assert.equal((await sql()`select count(*)::int as n from cal_feeds`)[0].n, 0);

  serve('/old.ics', { status: 301, location: '/new.ics' });
  serve('/new.ics', { body: fixture('icloud.ics') });
  const r = await cal.addFeed({ url: `${base}/old.ics` });
  assert.equal(r.feed.name, 'Home');
  assert.equal(r.events, 2);
  await assert.rejects(cal.addFeed({ url: `${base}/old.ics` }), (e) => e.status === 409 && /already added/.test(e.message));
});

test('sync all: a failing feed is recorded and never stops the others; 15-minute throttle; force', async () => {
  await reset();
  serve('/a.ics', { body: fixture('icloud.ics') });
  serve('/b.ics', { body: fixture('outlook.ics') });
  const a = (await cal.addFeed({ url: `${base}/a.ics` })).feed;
  const b = (await cal.addFeed({ url: `${base}/b.ics` })).feed;
  const firstSync = clock.toUTC().toISO();

  setLocal('2026-10-12T08:20');
  serve('/b.ics', { status: 500, body: 'oops' });
  const results = await cal.syncAllFeeds();
  assert.deepEqual(results.map((x) => [x.id, x.ok]), [[a.id, true], [b.id, false]]);
  assert.match(results[1].error, /had a problem \(error 500\)/);
  let feeds = await cal.listFeeds();
  assert.equal(feeds[0].lastSync, clock.toUTC().toISO());
  assert.equal(feeds[0].lastError, null);
  assert.match(feeds[1].lastError, /error 500/);
  assert.equal(feeds[1].lastSync, firstSync); // last good sync
  assert.equal(feeds[1].eventCount, 19);
  assert.deepEqual(titles(await cal.eventsForDate('2026-10-13')), ['Team sync', 'Focus time']); // old events kept

  // Ten minutes later: the healthy feed is fresh and skipped, the failing one is retried.
  setLocal('2026-10-12T08:30');
  const hitsA = hits.get('/a.ics');
  const second = await cal.syncAllFeeds();
  assert.deepEqual(second.map((x) => [x.id, Boolean(x.skipped), x.ok]), [[a.id, true, true], [b.id, false, false]]);
  assert.equal(hits.get('/a.ics'), hitsA);

  // A dead server (connection refused) is recorded the same way.
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  await sql()`update cal_feeds set url = ${`http://127.0.0.1:${deadPort}/b.ics`} where id = ${b.id}`;
  const third = await cal.syncAllFeeds({ force: true });
  assert.equal(third[0].ok, true);
  assert.equal(hits.get('/a.ics'), hitsA + 1); // forced
  assert.match(third[1].error, /refused the connection/);
  await assert.rejects(cal.syncFeed(b.id), /refused the connection/);

  // Fixed again.
  await sql()`update cal_feeds set url = ${`${base}/b.ics`} where id = ${b.id}`;
  serve('/b.ics', { body: fixture('outlook.ics') });
  const fourth = await cal.syncAllFeeds({ force: true });
  assert.ok(fourth.every((x) => x.ok));
  feeds = await cal.listFeeds();
  assert.equal(feeds[1].lastError, null);
  assert.equal(feeds[1].lastSync, clock.toUTC().toISO());

  // Fifteen minutes after that, both are due again.
  setLocal('2026-10-12T08:45');
  assert.ok((await cal.syncAllFeeds()).every((x) => x.ok && !x.skipped));
});

test('coach text: today and tomorrow, with VLE deadlines marked', async () => {
  await reset();
  assert.equal(await cal.calendarForCoach(), '');
  await addGoogle();
  serve('/vle/calendar/export_execute.php', { body: fixture('moodle.ics') });
  await cal.addFeed({ url: `${base}/vle/calendar/export_execute.php?authtoken=x` });
  assert.equal(await cal.calendarForCoach(), [
    'Calendar today (Mon 12 Oct):',
    '  09:00-11:00: CPS1011 Lecture (Room 202)',
    '  14:00-15:30: Study group: chapters 4, 5 and 6; bring the notes from last week (Library, Level 2)',
    '  15:00-16:00: Gym',
    '  18:00-19:00: Optional talk',
    '  20:00-21:00: Revision sprint',
    '  due 22:00: Lab sheet 3 [VLE deadline]',
    'Calendar tomorrow (Tue 13 Oct):',
    "  all day: Mum's birthday",
    "  19:00-20:00: Kafè ma' Ġorġ",
  ].join('\n'));
  setLocal('2026-10-15T08:00');
  assert.match(await cal.calendarForCoach(), /all day, until Sat 17 Oct: Field trip, Gozo/);
  setLocal('2026-12-20T08:00'); // beyond everything synced
  assert.equal(await cal.calendarForCoach(), '');
});

test('API routes: list, add, events, sync and delete', async () => {
  await reset();
  assert.deepEqual(await call('GET', '/api/calendar/feeds'), { status: 200, data: { feeds: [] } });
  const bad = await call('POST', '/api/calendar/feeds', { url: 'ftp://example.com/x.ics' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /https:\/\/ or webcal/);

  serve('/g.ics', { body: fixture('google.ics') });
  const added = await call('POST', '/api/calendar/feeds', { url: `${base}/g.ics`, name: 'Uni timetable', color: '#123ABC' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.feed.name, 'Uni timetable');
  assert.equal(added.data.feed.color, '#123abc');
  assert.equal(added.data.events, 25);
  assert.deepEqual(Object.keys(added.data.feed).sort(), ['color', 'createdAt', 'eventCount', 'host', 'id', 'kind', 'lastError', 'lastSync', 'name', 'url']);

  const ev = await call('GET', '/api/calendar/events?from=2026-10-12&to=2026-10-13');
  assert.equal(ev.status, 200);
  assert.equal(ev.data.from, '2026-10-12');
  assert.equal(ev.data.events.length, 7);
  assert.deepEqual(Object.keys(ev.data.events[0]).sort(), ['allDay', 'busy', 'color', 'deadline', 'end', 'endTime', 'feed', 'feedId', 'id', 'location', 'start', 'time', 'title']);
  assert.equal((await call('GET', '/api/calendar/events')).data.events.length, 5); // defaults to today
  assert.match((await call('GET', '/api/calendar/events?from=2026-10-01&to=2026-12-31')).data.error, /at most 62 days/);
  assert.equal((await call('GET', '/api/calendar/events?from=2026-10-01&to=2026-12-01')).status, 200); // 62 days
  assert.match((await call('GET', '/api/calendar/events?from=2026-10-14&to=2026-10-12')).data.error, /before the start/);
  assert.equal((await call('GET', '/api/calendar/events?from=14-10-2026')).status, 400);

  const synced = await call('POST', '/api/calendar/sync', {});
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.data.results, [{ id: 1, ok: true, events: 25, created: 0, updated: 0 }]);
  assert.equal(synced.data.feeds.length, 1);

  assert.deepEqual(await call('DELETE', '/api/calendar/feeds/1'), { status: 200, data: { ok: true } });
  assert.equal((await call('DELETE', '/api/calendar/feeds/1')).status, 404);
  assert.equal((await call('DELETE', '/api/calendar/feeds/abc')).status, 400);
  assert.equal((await call('GET', '/api/calendar/events?from=2026-10-12')).data.events.length, 0);
});
