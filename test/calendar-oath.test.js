// Oath's own calendar events: added and changed in the app or by the coach, read by everything that
// reads the calendar (events, busy time, the coach's view), untouched by feed syncs, markers for
// deadlines, and the secret address Apple Calendar subscribes to. Against a real Postgres with a
// controllable clock; the coach is a scripted client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-11-02T08:00', { zone: ZONE }); // a Monday, on winter time
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-calendar-oath-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54381 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

// A feed with one lecture, 09:00 to 10:00 on Tuesday 3 November.
const FEED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'X-WR-CALNAME:Uni',
  'BEGIN:VEVENT', 'UID:lec1@test', 'DTSTAMP:20261101T000000Z', 'DTSTART;TZID=Europe/Malta:20261103T090000',
  'DTEND;TZID=Europe/Malta:20261103T100000', 'SUMMARY:Lecture', 'LOCATION:Room 4', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
const feedServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/calendar' });
  res.end(FEED);
});
let feedBase = '';

let app; let cookie = ''; let dbmod; let coach; let cal; let tools;

async function call(method, url, json, { auth = true } = {}) {
  const headers = auth ? { cookie } : {};
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set && auth) cookie = set.split(';')[0];
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { data = null; }
  return { status: res.status, data, raw, headers: res.headers };
}

const reply = (stop_reason, content) => ({ stop_reason, content });
const words = (text) => ({ type: 'text', text });
let n = 0;
const use = (name, input) => ({ type: 'tool_use', id: `t${(n += 1)}`, name, input });
// One coach turn: the model calls these tools in one round, then says `text`.
function turn(calls, text = 'Done.') {
  const requests = [];
  const responses = [reply('tool_use', calls), reply('end_turn', [words(text)])];
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          const next = responses.shift();
          if (!next) throw new Error('no scripted response left');
          return next;
        },
      },
    },
  };
}
const lastResults = (c) => c.requests[c.requests.length - 1].messages.at(-1).content;
const sql = () => dbmod.db();

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  feedBase = `http://127.0.0.1:${feedServer.address().port}`;
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54381 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.PUBLIC_HOST;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  cal = await import('../src/calendar.js');
  cal.setCalendarTestHooks({ allowLocal: true });
  tools = await import('../src/coach-tools.js');
  ({ app } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await new Promise((resolve) => feedServer.close(resolve));
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

async function reset() {
  setLocal('2026-11-02T08:00');
  await sql().unsafe('truncate cal_feeds, cal_events, oath_events, tasks, coach_pending, events restart identity cascade');
  await sql()`delete from kv where key = 'ical'`;
}

const day = (date) => call('GET', `/api/calendar/events?from=${date}&to=${date}`).then((r) => r.data.events);

test('the events table is migrated and the migration is repeatable', async () => {
  await cal.migrateCalendar();
  await cal.migrateCalendar();
  const [{ n: tables }] = await sql()`select count(*)::int as n from information_schema.tables where table_name = 'oath_events'`;
  assert.equal(tables, 1);
});

test('API: add, change and delete Oath events, with the defaults a quick phrase needs', async () => {
  await reset();
  const timed = await call('POST', '/api/calendar/events', { title: 'Gym', date: '2026-11-03', start: '18:00', end: '19:30', location: 'Hall', notes: 'Legs\nBring the belt' });
  assert.equal(timed.status, 200, timed.raw);
  const gym = timed.data.event;
  assert.deepEqual(
    [gym.own, gym.title, gym.start, gym.end, gym.time, gym.endTime, gym.allDay, gym.location, gym.notes, gym.feed, gym.by, gym.deadline],
    [true, 'Gym', '2026-11-03T18:00:00+01:00', '2026-11-03T19:30:00+01:00', '18:00', '19:30', false, 'Hall', 'Legs\nBring the belt', 'Oath', 'you', false],
  );
  assert.equal(gym.id, `oath:${gym.ownId}`);
  assert.equal(gym.color, '#e10600');

  // A start with no end lasts an hour; the day defaults to today; "9:05" is accepted.
  const hour = (await call('POST', '/api/calendar/events', { title: 'Call', start: '9:05' })).data.event;
  assert.deepEqual([hour.start, hour.end], ['2026-11-02T09:05:00+01:00', '2026-11-02T10:05:00+01:00']);
  const mins = (await call('POST', '/api/calendar/events', { title: 'Run', date: '2026-11-03', start: '07:00', duration: 45 })).data.event;
  assert.equal(mins.endTime, '07:45');
  // Times as people and models write them: "6:30 pm", "7:30pm", "18:00:00".
  const pm = (await call('POST', '/api/calendar/events', { title: 'Pm', date: '2026-11-03', start: '6:30 pm', end: '7:30pm' })).data.event;
  assert.deepEqual([pm.time, pm.endTime], ['18:30', '19:30']);
  assert.equal((await call('POST', '/api/calendar/events', { title: 'Secs', date: '2026-11-03', start: '18:00:00', duration: 30 })).data.event.endTime, '18:30');
  assert.equal((await call('POST', '/api/calendar/events', { title: 'Bare hour', start: '18' })).status, 400);
  // No start means all day, and a span keeps its last day inclusive like a feed event.
  const allDay = (await call('POST', '/api/calendar/events', { title: 'Gozo', date: '2026-11-06', end_date: '2026-11-08' })).data.event;
  assert.deepEqual([allDay.allDay, allDay.start, allDay.end, allDay.time], [true, '2026-11-06', '2026-11-08', null]);

  for (const [bad, message] of [
    [{ date: '2026-11-03', start: '18:00' }, /title/],
    [{ title: 'X', date: '3 November' }, /date must look like/],
    [{ title: 'X', start: '25:00' }, /start must look like/],
    [{ title: 'X', start: '18:00', end: '17:00' }, /end must be after/],
    [{ title: 'X', start: '18:00', duration: 2 }, /between 5 minutes and 24 hours/],
    [{ title: 'X', date: '2026-11-03', end_date: '2026-11-01' }, /last day/],
  ]) {
    const r = await call('POST', '/api/calendar/events', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.data.error, message);
  }

  // Moving the start keeps the length; moving the day keeps the times.
  const later = (await call('PATCH', `/api/calendar/events/${gym.ownId}`, { start: '19:00' })).data.event;
  assert.deepEqual([later.time, later.endTime], ['19:00', '20:30']);
  const moved = (await call('PATCH', `/api/calendar/events/${gym.ownId}`, { date: '2026-11-04' })).data.event;
  assert.deepEqual([moved.start, moved.time, moved.endTime, moved.location], ['2026-11-04T19:00:00+01:00', '19:00', '20:30', 'Hall']);
  const cleared = (await call('PATCH', `/api/calendar/events/${gym.ownId}`, { end: '21:00', location: '' })).data.event;
  assert.deepEqual([cleared.endTime, cleared.location, cleared.title], ['21:00', '', 'Gym']);
  // All day to timed needs a start; with one it works, and back again drops the times.
  const gozo = allDay.ownId;
  const stuck = await call('PATCH', `/api/calendar/events/${gozo}`, { all_day: false });
  assert.equal(stuck.status, 400);
  assert.match(stuck.data.error, /what time/);
  const timedGozo = (await call('PATCH', `/api/calendar/events/${gozo}`, { start: '10:00' })).data.event;
  assert.deepEqual([timedGozo.allDay, timedGozo.time, timedGozo.endTime], [false, '10:00', '11:00']);
  const backAgain = (await call('PATCH', `/api/calendar/events/${gozo}`, { all_day: true })).data.event;
  assert.deepEqual([backAgain.allDay, backAgain.start, backAgain.end], [true, '2026-11-06', '2026-11-06']);

  // Only Oath's own events can be reached: a feed event's id is refused, a missing one is a 404.
  assert.equal((await call('DELETE', '/api/calendar/events/1:lec1@test:1793000000000')).status, 400);
  assert.equal((await call('PATCH', '/api/calendar/events/1:lec1@test:1793000000000', { title: 'Hacked' })).status, 400);
  assert.equal((await call('PATCH', '/api/calendar/events/9999', { title: 'Nobody' })).status, 404);
  const gone = await call('DELETE', `/api/calendar/events/${hour.ownId}`);
  assert.deepEqual([gone.status, gone.data.ok, gone.data.event.title], [200, true, 'Call']);
  assert.equal((await call('DELETE', `/api/calendar/events/${hour.ownId}`)).status, 404);
  assert.equal((await call('GET', '/api/calendar/events?from=2026-11-02&to=2026-11-02')).data.events.length, 0);
});

test('the API needs the login; the calendar page can ask for a month of events', async () => {
  const anon = await call('POST', '/api/calendar/events', { title: 'Nope' }, { auth: false });
  assert.equal(anon.status, 401);
  assert.equal((await call('GET', '/api/calendar/events', undefined, { auth: false })).status, 401);
  assert.equal((await call('GET', '/api/calendar/subscription', undefined, { auth: false })).status, 401);
  assert.equal((await call('GET', '/api/calendar/events?from=2026-10-01&to=2026-12-01')).status, 200);
  assert.equal((await call('GET', '/api/calendar/events?from=2026-10-01&to=2026-12-31')).status, 400);
});

test('own events join the reads: events by day, busy minutes and the coach\'s view', async () => {
  await reset();
  assert.equal(await cal.calendarForCoach(), '', 'nothing at all, nothing to say');
  const lunch = (await call('POST', '/api/calendar/events', { title: 'Lunch with Luke', date: '2026-11-02', start: '12:30', end: '13:30', location: 'Valletta' })).data.event;
  assert.equal(await cal.busyMinutes('2026-11-02'), 60);
  assert.equal(await cal.busyMinutes('2026-11-02', '13:00', '22:00'), 30, 'only the part inside the window');
  await call('POST', '/api/calendar/events', { title: 'Birthday', date: '2026-11-02' }); // all day: not busy
  assert.equal(await cal.busyMinutes('2026-11-02'), 60);
  assert.deepEqual((await cal.eventsForDate('2026-11-02')).map((e) => e.title), ['Birthday', 'Lunch with Luke']);

  const text = await cal.calendarForCoach();
  assert.match(text, new RegExp(`12:30-13:30: Lunch with Luke \\(Valletta\\) \\[Oath event #${lunch.ownId}\\]`));
  assert.match(text, /all day: Birthday \[Oath event #\d+\]/);

  // With a feed alongside: overlapping spans merge, and the feed is the only one in the feed list.
  const added = await call('POST', '/api/calendar/feeds', { url: `${feedBase}/uni.ics`, name: 'Uni' });
  assert.equal(added.status, 200, added.raw);
  assert.equal(added.data.events, 1);
  await call('POST', '/api/calendar/events', { title: 'Study group', date: '2026-11-03', start: '09:30', end: '11:00' });
  assert.equal(await cal.busyMinutes('2026-11-03'), 120, '09:00-10:00 lecture and 09:30-11:00 group make one block of two hours');
  const both = await day('2026-11-03');
  assert.deepEqual(both.map((e) => [e.title, e.own || false]), [['Lecture', false], ['Study group', true]]);
  assert.deepEqual(Object.keys(both[0]).sort(), ['allDay', 'busy', 'color', 'deadline', 'done', 'end', 'endTime', 'feed', 'feedId', 'id', 'location', 'start', 'time', 'title'], 'feed events keep their shape');
  assert.deepEqual((await cal.listFeeds()).map((f) => f.name), ['Uni']);
});

test('feed syncs, resyncs and removals never touch Oath events', async () => {
  await reset();
  await call('POST', '/api/calendar/events', { title: 'Dentist', date: '2026-11-04', start: '15:00' });
  const added = await call('POST', '/api/calendar/feeds', { url: `${feedBase}/uni.ics`, name: 'Uni' });
  assert.equal(added.status, 200, added.raw);
  const synced = await call('POST', '/api/calendar/sync', {});
  assert.equal(synced.status, 200);
  assert.deepEqual(synced.data.results.map((r) => r.ok), [true]);
  assert.equal(synced.data.feeds.length, 1, 'no Oath row among the feeds');
  assert.equal((await day('2026-11-04')).length, 1);
  assert.equal((await call('DELETE', `/api/calendar/feeds/${added.data.feed.id}`)).status, 200);
  assert.deepEqual((await day('2026-11-04')).map((e) => e.title), ['Dentist']);
  assert.equal((await day('2026-11-03')).length, 0, 'the feed\'s event went with the feed');
  // Far out of the sync window and long past: still there.
  setLocal('2027-03-01T08:00');
  assert.deepEqual((await cal.eventsBetween('2026-11-04', '2026-11-04')).map((e) => e.title), ['Dentist']);
});

test('markers: tasks and fixed-day habits falling due, VLE copies left out', async () => {
  await reset();
  await call('POST', '/api/tasks', { title: 'Email supervisor', due_date: '2026-11-03', deadline: '16:00' });
  await call('POST', '/api/tasks', { title: 'Renew passport', due_date: '2026-11-03' });
  const mirror = (await call('POST', '/api/tasks', { title: 'Assignment 1', due_date: '2026-11-03', deadline: '23:59' })).data;
  await sql()`update tasks set ext_uid = 'cal:9:abc:def' where id = ${mirror.id}`;
  await call('POST', '/api/tasks', { title: 'Far away', due_date: '2026-12-25' });
  await call('POST', '/api/habits', { name: 'Study', deadline: '12:00', days: [1, 2, 3, 4, 5, 6, 7] });
  await call('POST', '/api/habits', { name: 'Gym', deadline: '23:59', weekly_target: 3 });
  const r = await call('GET', '/api/calendar/markers?from=2026-11-03&to=2026-11-04');
  assert.equal(r.status, 200, r.raw);
  const m = r.data.markers;
  assert.deepEqual(m.filter((x) => x.kind === 'task').map((x) => [x.title, x.date, x.time, x.done]), [
    ['Renew passport', '2026-11-03', null, false],
    ['Email supervisor', '2026-11-03', '16:00', false],
  ].sort((a, b) => String(a[2] || '99').localeCompare(String(b[2] || '99'))));
  assert.deepEqual(m.filter((x) => x.kind === 'habit').map((x) => [x.title, x.date, x.time]), [['Study', '2026-11-03', '12:00'], ['Study', '2026-11-04', '12:00']]);
  assert.equal((await call('GET', '/api/calendar/markers?from=2026-01-01&to=2026-12-31')).status, 400);
});

test('coach: adds an event with a clear receipt and the defaults of a quick phrase', async () => {
  await reset();
  const c = turn([use('add_event', { title: 'Gym', date: '2026-11-03', start: '18:00' })], 'Put it at 18:00 for an hour.');
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'gym at 6 tomorrow' });
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(r.data.reply.actions, [{ ok: true, text: 'Added "Gym" to your calendar, Tue 3 Nov 18:00 to 19:00' }]);
  const [row] = await sql()`select * from oath_events`;
  assert.deepEqual([row.title, row.created_by, row.all_day], ['Gym', 'coach', false]);
  assert.match(lastResults(c)[0].content, new RegExp(`^Added "Gym" to your calendar, Tue 3 Nov 18:00 to 19:00\\nEvent #${row.id}\\.$`));
  assert.equal((await day('2026-11-03'))[0].by, 'coach');
  assert.equal(await cal.busyMinutes('2026-11-03'), 60);
  assert.equal((await sql()`select count(*)::int as n from events where type = 'coach_action'`)[0].n, 1);

  // Date left out means today; no start means all day; a span reads as one.
  coach.setCoachClient(turn([
    use('add_event', { title: 'Mum\'s birthday' }),
    use('add_event', { title: 'Gozo trip', date: '2026-11-06', end_date: '2026-11-08' }),
    use('add_event', { title: 'Overnight', date: '2026-11-05', start: '23:00', duration_min: 120, location: 'Gozo', notes: 'Ferry at 22:30' }),
  ]));
  const many = await call('POST', '/api/coach', { text: 'add a few things' });
  assert.deepEqual(many.data.reply.actions.map((a) => a.text), [
    'Added "Mum\'s birthday" to your calendar, Mon 2 Nov, all day',
    'Added "Gozo trip" to your calendar, Fri 6 Nov to Sun 8 Nov, all day',
    'Added "Overnight" to your calendar, Thu 5 Nov 23:00 to Fri 6 Nov 01:00',
  ]);
});

test('coach: tells the model what a new event overlaps', async () => {
  await reset();
  await call('POST', '/api/calendar/feeds', { url: `${feedBase}/uni.ics`, name: 'Uni' });
  const c = turn([use('add_event', { title: 'Coffee', date: '2026-11-03', start: '09:30', end: '10:30' })]);
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'coffee at half nine tomorrow' });
  assert.equal(r.data.reply.actions.length, 1, 'the overlap is for the model, not a receipt');
  assert.match(lastResults(c)[0].content, /It overlaps "Lecture" \(09:00 to 10:00\): mention it in a few words\./);
});

test('coach: edits an event, finds events with ids, and cannot touch a feed event', async () => {
  await reset();
  const feed = await call('POST', '/api/calendar/feeds', { url: `${feedBase}/uni.ics`, name: 'Uni' });
  assert.equal(feed.status, 200, feed.raw);
  const gym = (await call('POST', '/api/calendar/events', { title: 'Gym', date: '2026-11-03', start: '18:00' })).data.event;

  const find = turn([use('find_events', { from: '2026-11-03', to: '2026-11-04' })]);
  coach.setCoachClient(find);
  const found = await call('POST', '/api/coach', { text: 'what is on tomorrow?' });
  assert.equal(found.data.reply.actions, null, 'a lookup leaves no receipt');
  const listing = lastResults(find)[0].content;
  assert.match(listing, /"Lecture", Tue 3 Nov 09:00 to 10:00, Room 4 \(Uni, can be crossed off but not edited; mark id "\d+:lec1@test:\d+"\)/);
  assert.match(listing, new RegExp(`event #${gym.ownId} "Gym", Tue 3 Nov 18:00 to 19:00 \\(his own, can be changed; mark id "oath:${gym.ownId}"\\)`));
  const narrowed = turn([use('find_events', { query: 'gym', from: '2026-11-03' })]);
  coach.setCoachClient(narrowed);
  await call('POST', '/api/coach', { text: 'find gym' });
  assert.ok(!/Lecture/.test(lastResults(narrowed)[0].content));
  const empty = turn([use('find_events', { from: '2026-12-01', to: '2026-12-02' })]);
  coach.setCoachClient(empty);
  await call('POST', '/api/coach', { text: 'anything in December?' });
  assert.equal(lastResults(empty)[0].content, 'Nothing on his calendar in that time.');

  coach.setCoachClient(turn([use('edit_event', { event_id: gym.ownId, start: '19:00', location: 'Hall' })]));
  const edit = await call('POST', '/api/coach', { text: 'move gym to 7' });
  assert.deepEqual(edit.data.reply.actions, [{ ok: true, text: 'Updated "Gym", Tue 3 Nov 19:00 to 20:00' }]);
  const [row] = await sql()`select * from oath_events where id = ${gym.ownId}`;
  assert.equal(row.location, 'Hall');

  // The lecture belongs to the feed: no id reaches it.
  const lecture = (await day('2026-11-03')).find((e) => e.title === 'Lecture');
  for (const [tool, input] of [['edit_event', { event_id: lecture.id, title: 'Skipped' }], ['edit_event', { event_id: 999 }]]) {
    const c = turn([use(tool, input)]);
    coach.setCoachClient(c);
    const bad = await call('POST', '/api/coach', { text: 'change it' });
    assert.equal(bad.data.reply.actions[0].ok, false);
    assert.match(lastResults(c)[0].content, /^Failed: No event of his own with that id/);
  }
  assert.equal((await day('2026-11-03')).find((e) => e.title === 'Lecture').title, 'Lecture');
});

test('coach: deleting an event waits for the Confirm tap, and cancelling keeps it', async () => {
  await reset();
  const gym = (await call('POST', '/api/calendar/events', { title: 'Gym', date: '2026-11-03', start: '18:00' })).data.event;
  coach.setCoachClient(turn([use('delete_event', { event_id: gym.ownId })], 'Tap Confirm to remove it.'));
  const r = await call('POST', '/api/coach', { text: 'cancel the gym' });
  const p = r.data.reply.pending[0];
  assert.equal(p.summary, 'Delete "Gym" (Tue 3 Nov 18:00 to 19:00) from your calendar');
  assert.equal(r.data.reply.actions, null, 'nothing happened yet');
  assert.equal((await sql()`select count(*)::int as n from oath_events`)[0].n, 1);

  const no = await call('POST', `/api/coach/pending/${p.id}`, { confirm: false });
  assert.equal(no.data.status, 'cancelled');
  assert.equal((await sql()`select count(*)::int as n from oath_events`)[0].n, 1);

  coach.setCoachClient(turn([use('delete_event', { event_id: gym.ownId })]));
  const again = await call('POST', '/api/coach', { text: 'yes, cancel the gym' });
  const ok = await call('POST', `/api/coach/pending/${again.data.reply.pending[0].id}`, { confirm: true });
  assert.deepEqual([ok.data.status, ok.data.text], ['done', 'Deleted "Gym" from your calendar, Tue 3 Nov 18:00 to 19:00']);
  assert.equal((await sql()`select count(*)::int as n from oath_events`)[0].n, 0);
  assert.equal((await call('POST', `/api/coach/pending/${again.data.reply.pending[0].id}`, { confirm: true })).status, 409);

  // An id that is not his own is refused before anything waits.
  coach.setCoachClient(turn([use('delete_event', { event_id: 12345 })]));
  const missing = await call('POST', '/api/coach', { text: 'delete it' });
  assert.equal(missing.data.reply.pending?.length || 0, 0);
  assert.equal(missing.data.reply.actions[0].ok, false);
  assert.ok(tools.TOOL_DEFS.some((t) => t.name === 'delete_event'));
});

test('Apple Calendar: a secret address serves Oath events, and only that address', async () => {
  await reset();
  const off = await call('GET', '/api/calendar/subscription');
  assert.deepEqual(off.data, { on: false, url: null, webcal: null });
  assert.equal((await call('GET', '/ical/nothing.ics', undefined, { auth: false })).status, 404, 'no address yet: nothing is served');

  const long = `${'A long note, with commas; semicolons and a newline\n'.repeat(4)}Ünïcödé ${'ü'.repeat(60)}`;
  await call('POST', '/api/calendar/events', { title: 'Gym, legs; heavy', date: '2026-11-03', start: '18:00', end: '19:00', location: 'Hall, Floor 2', notes: long });
  await call('POST', '/api/calendar/events', { title: 'Gozo', date: '2026-11-06', end_date: '2026-11-08' });

  const made = await call('POST', '/api/calendar/subscription', {});
  assert.equal(made.status, 200);
  assert.equal(made.data.on, true);
  const url = new URL(made.data.url);
  assert.match(url.pathname, /^\/ical\/[A-Za-z0-9_-]{32}\.ics$/);
  assert.equal(made.data.webcal, made.data.url.replace(/^http:/, 'webcal:'));
  assert.equal((await call('POST', '/api/calendar/subscription', {})).data.url, made.data.url, 'asking again keeps the same address');
  assert.equal((await call('GET', '/api/calendar/subscription')).data.url, made.data.url);

  const feed = await call('GET', url.pathname, undefined, { auth: false });
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /^text\/calendar/);
  assert.equal(feed.headers.get('cache-control'), 'no-store');
  assert.match(feed.raw, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.ok(feed.raw.endsWith('END:VCALENDAR\r\n'));
  assert.match(feed.raw, /DTSTART:20261103T170000Z\r\nDTEND:20261103T180000Z\r\nSUMMARY:Gym\\, legs\\; heavy\r\n/);
  assert.match(feed.raw, /DTSTART;VALUE=DATE:20261106\r\nDTEND;VALUE=DATE:20261109\r\n/);
  for (const line of feed.raw.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line.length}`);

  // It reads back as a calendar with the same events and the same note.
  const parsed = cal.parseICS(feed.raw);
  const occ = cal.expandCalendar(parsed, { zone: ZONE, from: DateTime.fromISO('2026-11-01', { zone: ZONE }), to: DateTime.fromISO('2026-12-01', { zone: ZONE }) });
  assert.deepEqual(occ.map((o) => o.title), ['Gym, legs; heavy', 'Gozo']);
  assert.equal(occ[0].location, 'Hall, Floor 2');
  assert.equal(occ[0].description, long.replace(/ +/g, ' '), 'folded and escaped text survives the trip');
  assert.equal(occ[1].allDay, true);

  // Wrong, truncated or malformed addresses are plain 404s.
  const token = url.pathname.split('/').pop().replace('.ics', '');
  for (const p of [`/ical/${token.slice(0, -1)}.ics`, `/ical/${token}x.ics`, `/ical/${token}`, '/ical/.ics', `/ical/${token}.txt`]) {
    assert.equal((await call('GET', p, undefined, { auth: false })).status, 404, p);
  }

  // A new address turns the old one off.
  const fresh = await call('POST', '/api/calendar/subscription', { rotate: true });
  assert.notEqual(fresh.data.url, made.data.url);
  assert.equal((await call('GET', url.pathname, undefined, { auth: false })).status, 404);
  assert.equal((await call('GET', new URL(fresh.data.url).pathname, undefined, { auth: false })).status, 200);

  // The secret never reaches the event log or the data export.
  const freshToken = new URL(fresh.data.url).pathname.split('/').pop().replace('.ics', '');
  const logged = JSON.stringify(await sql()`select * from events`);
  assert.ok(!logged.includes(freshToken) && !logged.includes(token));
  assert.ok(!(await call('GET', '/api/export')).raw.includes(freshToken));
});

test('the export carries Oath events', async () => {
  await reset();
  await call('POST', '/api/calendar/events', { title: 'Exported', date: '2026-11-03', start: '18:00' });
  const x = (await call('GET', '/api/export')).data;
  assert.deepEqual(x.oath_events.map((e) => e.title), ['Exported']);
});
