// The background loop: judging never waits on Claude (the briefs have their own lock and are claimed
// once a day), the oath chase stops rebuilding Today on every tick, and the daily upkeep trims the
// tables that only grow. Against a real Postgres with a controllable clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-12T07:30', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-loop-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54402,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let loop; let coach; let engine; let state;

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54402/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app } = await import('../src/server.js'));
  loop = await import('../src/loop.js');
  coach = await import('../src/coach.js');
  engine = await import('../src/engine.js');
  state = await import('../src/state.js');
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

// A stand-in for the Anthropic client whose answers are held back until the test lets them go.
function held() {
  const requests = [];
  const waiting = [];
  return {
    requests,
    release: (text) => waiting.shift()({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }),
    beta: { messages: { create: (params) => new Promise((resolve) => { requests.push(params); waiting.push(resolve); }) } },
  };
}
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'timed out waiting');
};

test('the coach client gives up after a minute and retries once, not ten minutes and twice', () => {
  assert.deepEqual(coach.CLIENT_LIMITS, { timeout: 120000, maxRetries: 1 });
  process.env.ANTHROPIC_API_KEY = 'test';
  coach.setCoachClient(null);
  assert.deepEqual(coach.clientLimits(), { timeout: 120000, maxRetries: 1 });
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(coach.clientLimits(), null);
});

test('a morning brief stuck on Claude does not hold up judging, and is written once', async () => {
  setLocal('2026-10-12T07:30');
  const habit = await call('POST', '/api/habits', { name: 'Read 25 Pages', deadline: '08:00', non_negotiable: true });
  assert.equal(habit.status, 200, JSON.stringify(habit.data));

  // 08:30: the 08:00 deadline has passed and the morning brief (07:00) is inside its window.
  setLocal('2026-10-12T08:30');
  process.env.ANTHROPIC_API_KEY = 'test';
  const claude = held();
  coach.setCoachClient(claude);

  let briefDone = false;
  const briefing = loop.briefsOnce().then(() => { briefDone = true; });
  await until(() => claude.requests.length === 1);

  const notes = await loop.judgeOnce();
  assert.ok(notes.some((n) => n.tag.startsWith('miss-')), 'the missed deadline was judged while the brief waited');
  assert.equal((await dbmod.db()`select 1 from misses where title = 'Read 25 Pages'`).length, 1);
  assert.equal(briefDone, false, 'and the brief is still waiting for Claude');

  // The next tick finds the briefs busy and moves on; nothing is asked twice.
  await loop.briefsOnce();
  assert.equal(claude.requests.length, 1);
  assert.equal(briefDone, false);

  claude.release('Morning. One thing is already behind you, so start with the next.');
  await briefing;
  const [brief] = await dbmod.db()`select kind, text from briefs where date = '2026-10-12'`;
  assert.equal(brief.kind, 'morning');
  assert.match(brief.text, /start with the next/);
  assert.equal((await dbmod.db()`select 1 from reminders_sent where key = 'brief:morning:2026-10-12'`).length, 1);

  // Claimed for the day: later ticks inside the window do not write it again.
  await loop.briefsOnce();
  await loop.briefsOnce();
  assert.equal(claude.requests.length, 1);
  coach.setCoachClient(null);
  delete process.env.ANTHROPIC_API_KEY;
});

test('runOnce still does a whole pass: it judges, then writes whatever brief is due', async () => {
  setLocal('2026-10-12T13:30');
  const notes = await loop.runOnce();
  assert.ok(Array.isArray(notes));
  const kinds = (await dbmod.db()`select kind from briefs where date = '2026-10-12' order by kind`).map((b) => b.kind);
  assert.deepEqual(kinds, ['midday', 'morning']);
});

// ---------- The oath chase ----------

test('the oath chase looks at Today once to send, then not at all once it has gone', async () => {
  const at = async (iso) => { setLocal(iso); const { s, local, today, tz } = await engine.localNow(); return { s, local, today, tz }; };
  const calls = [];
  const build = (open) => async () => { calls.push(open); return { progress: { open, atStake: 20 } }; };

  assert.equal(await loop.chaseOath(await at('2026-10-13T08:30'), build(2)), false, 'before the window (09:00)');
  assert.equal(await loop.chaseOath(await at('2026-10-13T19:30'), build(2)), false, 'after the window (19:00)');
  assert.equal(calls.length, 0, 'outside the window Today is not built');

  assert.equal(await loop.chaseOath(await at('2026-10-13T10:00'), build(2)), true);
  assert.equal(calls.length, 1);
  assert.equal((await dbmod.db()`select 1 from reminders_sent where key = 'oath-chase:2026-10-13'`).length, 1);
  for (const t of ['10:00:30', '10:01', '12:00', '15:30']) {
    assert.equal(await loop.chaseOath(await at(`2026-10-13T${t}`), build(2)), false);
  }
  assert.equal(calls.length, 1, 'sent: every later tick skips Today');
});

test('with nothing open the chase looks again every few minutes, not every tick, and fires when something appears', async () => {
  const at = async (iso) => { setLocal(iso); const { s, local, today, tz } = await engine.localNow(); return { s, local, today, tz }; };
  const calls = [];
  const build = (open) => async () => { calls.push(open); return { progress: { open, atStake: 15 } }; };

  assert.equal(await loop.chaseOath(await at('2026-10-14T10:00:00'), build(0)), false);
  assert.equal(calls.length, 1);
  for (const t of ['10:00:30', '10:01', '10:03', '10:04:30']) await loop.chaseOath(await at(`2026-10-14T${t}`), build(0));
  assert.equal(calls.length, 1, 'ticks inside the five minutes do not build Today');
  assert.equal(await loop.chaseOath(await at('2026-10-14T10:06'), build(0)), false);
  assert.equal(calls.length, 2, 'looks again after five minutes');
  assert.equal(await loop.chaseOath(await at('2026-10-14T10:12'), build(1)), true, 'a task added later in the day is chased');
  assert.equal(calls.length, 3);
  assert.equal(await loop.chaseOath(await at('2026-10-14T10:20'), build(1)), false);
  assert.equal(calls.length, 3);
});

test('a day with an oath is never chased, and does not build Today', async () => {
  setLocal('2026-10-15T10:00');
  const { s, local, today, tz } = await engine.localNow();
  await dbmod.db()`insert into day_plans (date, focus_kind, focus_id, focus_title, committed_at) values (${today}, 'habit', 1, 'Read', ${clock.toJSDate()})`;
  let built = 0;
  assert.equal(await loop.chaseOath({ s, local, today, tz }, async () => { built += 1; return { progress: { open: 3, atStake: 30 } }; }), false);
  assert.equal(built, 0);
});

// ---------- Daily upkeep ----------

test('upkeep trims reminders and Telegram updates after 60 days and events after 400, but keeps every death', async () => {
  setLocal('2026-10-20T03:00');
  const sql = dbmod.db();
  const ago = (days) => clock.minus({ days }).toJSDate();
  await sql`delete from reminders_sent`;
  await sql`insert into reminders_sent (key, at) values ('old', ${ago(61)}), ('edge', ${ago(59)}), ('new', ${ago(1)})`;
  await sql`insert into telegram_updates (update_id, at) values (1, ${ago(61)}), (2, ${ago(59)}), (3, ${ago(1)})`;
  await sql`delete from events`;
  await sql`insert into events (type, data, at) values
    ('habit_kept', '{}', ${ago(401)}), ('habit_kept', '{}', ${ago(399)}), ('habit_kept', '{}', ${ago(2)}),
    ('death', ${sql.json({ date: '2025-08-01', cause: 'Gym', deaths: 1, season: 2 })}, ${ago(445)})`;
  await sql`insert into sessions (token_hash, last_seen) values ('upkeep-stale', ${ago(181)}), ('upkeep-live', ${ago(179)})`;

  const gone = await loop.pruneOld();
  assert.deepEqual(gone, { reminders: 1, telegram: 1, events: 1, sessions: 1 });
  assert.deepEqual((await sql`select key from reminders_sent order by key`).map((r) => r.key), ['edge', 'new']);
  assert.deepEqual((await sql`select update_id::int as id from telegram_updates order by 1`).map((r) => r.id), [2, 3]);
  assert.equal((await sql`select count(*)::int as n from events where type = 'habit_kept'`)[0].n, 2);
  assert.equal((await sql`select 1 from sessions where token_hash = 'upkeep-live'`).length, 1);
  assert.equal((await sql`select 1 from sessions where token_hash = 'upkeep-stale'`).length, 0);

  // The Deaths list on the review screen is the one place that reads events from far back.
  const review = await state.buildReview();
  assert.deepEqual(review.deaths.map((d) => d.cause), ['Gym']);
});

test('the upkeep runs once a day, is claimed like a brief, and is tried again after a failure', async () => {
  const sql = dbmod.db();
  const ancient = () => clock.minus({ days: 90 }).toJSDate();
  await sql`delete from reminders_sent`;
  setLocal('2026-10-21T03:00');
  await sql`insert into reminders_sent (key, at) values ('ancient', ${ancient()})`;
  const first = await loop.pruneDaily();
  assert.equal(first.reminders, 1, 'the first tick of the day trims');
  assert.equal((await sql`select 1 from reminders_sent where key = 'prune:2026-10-21'`).length, 1);

  await sql`insert into reminders_sent (key, at) values ('ancient-2', ${ancient()})`;
  assert.equal(await loop.pruneDaily(), null, 'the same day: nothing more is done');
  assert.equal((await sql`select 1 from reminders_sent where key = 'ancient-2'`).length, 1);

  setLocal('2026-10-22T03:00');
  assert.equal((await loop.pruneDaily()).reminders, 1, 'the next day it runs again');

  // A failure frees the day's claim so a later tick tries again (a trigger stands in for the failure).
  setLocal('2026-10-23T03:00');
  await sql`insert into telegram_updates (update_id, at) values (9, ${ancient()})`;
  await sql.unsafe(`create function upkeep_boom() returns trigger language plpgsql as $$ begin raise exception 'upkeep boom'; end $$;
                    create trigger upkeep_boom before delete on telegram_updates for each row execute function upkeep_boom()`);
  await assert.rejects(loop.pruneDaily(), /upkeep boom/);
  await sql.unsafe('drop trigger upkeep_boom on telegram_updates; drop function upkeep_boom()');
  assert.equal((await sql`select 1 from reminders_sent where key = 'prune:2026-10-23'`).length, 0, 'the claim was freed');
  assert.equal((await loop.pruneDaily()).telegram, 1, 'and it goes through the next time');
});
