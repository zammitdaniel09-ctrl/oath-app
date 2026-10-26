// A 00:00 deadline means midnight at the end of the day, not the start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-08T09:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54345,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {},
});

let app; let runOnce; let cookie = ''; let dbmod; let time;

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const item = async (id) => (await call('GET', '/api/today')).data.items.find((i) => i.id === id);
const missesOn = async (date) => (await dbmod.db()`select title from misses where date = ${date} order by title`).map((m) => m.title);

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54345/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app, runOnce } = await import('../src/server.js'));
  await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
});

after(async () => {
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('a 00:00 deadline falls at the end of the day, across the clock change', () => {
  assert.equal(time.dueOn('2026-10-08', '00:00', ZONE).toISO(), '2026-10-09T00:00:00.000+02:00');
  assert.equal(time.dueOn('2026-10-25', '00:00', ZONE).toISO(), '2026-10-26T00:00:00.000+01:00');
  assert.equal(time.dueOn('2026-10-08', '21:00', ZONE).toISO(), '2026-10-08T21:00:00.000+02:00');
  // Plain times of day are unchanged.
  assert.equal(time.deadlineAt('2026-10-08', '00:00', ZONE).toISO(), '2026-10-08T00:00:00.000+02:00');
});

test('a 00:00 habit stays open all day and can be kept before midnight', async () => {
  setLocal('2026-10-08T09:00');
  const read = await call('POST', '/api/habits', { name: 'Read 25 Pages', deadline: '00:00', non_negotiable: true });
  const gym = await call('POST', '/api/habits', { name: 'Workout', deadline: '00:00', non_negotiable: true });
  assert.equal(read.data.startsToday, true);
  assert.equal(gym.data.startsToday, true);

  await runOnce();
  assert.deepEqual(await missesOn('2026-10-08'), [], 'nothing is missed at the start of the day');
  const open = await item(read.data.habit.id);
  assert.equal(open.status, 'open');
  assert.equal(open.dueAt, '2026-10-09T00:00:00.000+02:00');

  setLocal('2026-10-08T23:59');
  await runOnce();
  const kept = await call('POST', `/api/habits/${read.data.habit.id}/keep`, {});
  assert.equal(kept.status, 200);
  assert.equal((await item(read.data.habit.id)).status, 'kept');

  // Midnight closes the day: the unticked habit is missed on the 8th, the kept one is not.
  setLocal('2026-10-09T00:00:30');
  await runOnce();
  assert.deepEqual(await missesOn('2026-10-08'), ['Workout']);
  assert.deepEqual(await missesOn('2026-10-09'), [], 'the new day starts open');
  assert.equal((await item(read.data.habit.id)).status, 'open');

  // Too late to tick the 8th; the 9th can be kept straight away.
  const next = await call('POST', `/api/habits/${gym.data.habit.id}/keep`, {});
  assert.equal(next.status, 200);
});
