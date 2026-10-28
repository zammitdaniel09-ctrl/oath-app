// The coach reaching the rest of the app: crossing off any calendar event (his own and his other
// calendars'), acting on email, finding today's events by name; and Report a problem, kept and logged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const ZONE = 'Europe/Malta';
const clock = DateTime.fromISO('2027-02-10T15:00', { zone: ZONE });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-reach-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54443 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});
let app; let cookie = ''; let dbmod; let tools;

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const get = async (url) => ok(await call('GET', url));
const post = async (url, body = {}) => ok(await call('POST', url, body));
const today = clock.toISODate();
let feedEventId;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54443 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  const engine = await import('../src/engine.js');
  await engine.ensureGame();
  ({ app } = await import('../src/server.js'));
  tools = await import('../src/coach-tools.js');
  assert.equal((await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' })).status, 200);
  // A coaching session from his Google calendar, today 18:00 to 19:00.
  const sql = dbmod.db();
  const [{ id: feed }] = await sql`insert into cal_feeds (name, url, created_at) values ('Google', 'https://calendar.example/feed.ics', now()) returning id`;
  const start = clock.set({ hour: 18, minute: 0 });
  await sql`insert into cal_events (feed_id, uid, start_at, end_at, title) values (${feed}, 'coach-1@google.com', ${start.toJSDate()}, ${start.plus({ hours: 1 }).toJSDate()}, 'Coaching')`;
  feedEventId = `${feed}:coach-1@google.com:${start.toMillis()}`;
});

after(async () => {
  await dbmod?.close?.().catch(() => {});
  await pg.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('any calendar event can be crossed off and back on, his own and his other calendars\'', async () => {
  const list = await get(`/api/calendar/events?from=${today}&to=${today}`);
  const coaching = list.events.find((e) => e.title === 'Coaching');
  assert.equal(coaching.id, feedEventId);
  assert.equal(coaching.done, false);
  const done = await post(`/api/calendar/events/${encodeURIComponent(feedEventId)}/done`, { done: true });
  assert.equal(done.event.done, true);
  assert.equal((await get(`/api/calendar/events?from=${today}&to=${today}`)).events.find((e) => e.id === feedEventId).done, true);
  // His own event too.
  const own = (await post('/api/calendar/events', { title: 'Gym', date: today, start: '07:00' })).event;
  assert.equal((await post(`/api/calendar/events/${own.id}/done`, {})).event.done, true);
  // Back on.
  assert.equal((await post(`/api/calendar/events/${encodeURIComponent(feedEventId)}/done`, { done: false })).event.done, false);
  assert.equal((await call('POST', '/api/calendar/events/9:nothing:1/done', {})).status, 404);
  // The feed itself is never changed.
  const [row] = await dbmod.db()`select title from cal_events where uid = 'coach-1@google.com'`;
  assert.equal(row.title, 'Coaching');
});

test('the coach crosses off "coaching" by name, finds it with find_items, and says so', async () => {
  const found = await tools.runTool('find_items', { query: 'coaching' });
  assert.match(found.content, /calendar event "Coaching".*mark id/);
  const ctx = { actions: [], pending: [] };
  const r = await tools.runTool('mark_event_done', { title: 'coaching' }, ctx);
  assert.equal(r.isError, false, r.content);
  assert.match(ctx.actions[0].text, /Crossed off "Coaching"/);
  const today2 = await get(`/api/calendar/events?from=${today}&to=${today}`);
  assert.equal(today2.events.find((e) => e.id === feedEventId).done, true);
  const nothing = await tools.runTool('mark_event_done', { title: 'piano lesson' }, { actions: [], pending: [] });
  assert.equal(nothing.isError, true);
  assert.match(nothing.content, /Nothing called "piano lesson"/);
});

test('the coach can mark an important email done or not important', async () => {
  const sql = dbmod.db();
  const [m] = await sql`insert into mail_messages (uid_validity, uid, from_addr, from_name, subject, received_at, important)
    values (1, 1, 'tutor@uni.example', 'Tutor', 'Assignment feedback', now(), true) returning id`;
  const ctx = { actions: [], pending: [] };
  const r = await tools.runTool('mark_email', { email_id: m.id, done: true }, ctx);
  assert.equal(r.isError, false, r.content);
  assert.match(ctx.actions[0].text, /Marked "Assignment feedback" done/);
  const [after1] = await sql`select done_at from mail_messages where id = ${m.id}`;
  assert.ok(after1.done_at);
});

test('Report a problem is kept, carries the coach conversation, and is written to the log', async () => {
  const sql = dbmod.db();
  await sql`insert into coach_messages (role, text) values ('user', 'cross out coaching'), ('assistant', 'I cannot change events from your other calendars.')`;
  const lines = [];
  const real = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let out;
  try {
    out = await post('/api/problems', { kind: 'coach', note: 'He would not cross it out', route: '#/coach', context: { reply: 'I cannot change events', trouble: [{ kind: 'api', status: 500 }] } });
  } finally {
    console.log = real;
  }
  assert.ok(out.id > 0);
  const [row] = await sql`select kind, note, route, context, status from problem_reports where id = ${out.id}`;
  assert.equal(row.kind, 'coach');
  assert.equal(row.status, 'open');
  assert.ok(row.context.conversation.some((m) => /cross out coaching/.test(m.text)), 'the conversation came with it');
  const line = lines.find((l) => l.startsWith('[problem-report]'));
  assert.ok(line, 'one line in the server log');
  assert.match(line, new RegExp(`#${out.id} coach #/coach \\| He would not cross it out`));
  // Anything else, from anywhere; an unknown kind is kept as manual.
  const other = await post('/api/problems', { kind: 'weird', note: 'x'.repeat(3000) });
  const [o] = await sql`select kind, length(note) as n from problem_reports where id = ${other.id}`;
  assert.equal(o.kind, 'manual');
  assert.equal(o.n, 1000);
  const listed = await get('/api/problems');
  assert.equal(listed.problems[0].id, other.id);
});
