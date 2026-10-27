// Removing a habit is one tap: a habit due today leaves tomorrow (today still counts), one that is not
// leaves at once, and either can be kept the same day.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2027-05-10T09:00', { zone: ZONE }); // a Monday

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-remove-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54391,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod;

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
const plan = async () => ok(await call('GET', '/api/plan'));
const inPlan = async (id) => (await plan()).habits.find((h) => h.id === id);
const newHabit = async (body) => ok(await call('POST', '/api/habits', body)).habit;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54391/oath';
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
  ok(await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' }));
});

after(async () => {
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('a habit due today leaves tomorrow, and Keep it brings it back', async () => {
  const gym = await newHabit({ name: 'Gym', deadline: '20:00', days: [1, 2, 3, 4, 5, 6, 7], penalty: 10 });
  assert.equal((await inPlan(gym.id)).leavesFrom, '2027-05-11', 'the card knows a removal would wait for tomorrow');

  const r = ok(await call('DELETE', `/api/habits/${gym.id}`));
  assert.deepEqual([r.from, r.name], ['2027-05-11', 'Gym']);
  const leaving = await inPlan(gym.id);
  assert.equal(leaving.archivedFrom, '2027-05-11', 'still listed today, marked as leaving');
  assert.equal(leaving.leavesFrom, null);
  const today = ok(await call('GET', '/api/today'));
  assert.ok(today.items.some((i) => i.id === gym.id), 'today still counts');

  ok(await call('POST', `/api/habits/${gym.id}/restore`, {}));
  assert.equal((await inPlan(gym.id)).archivedFrom, null);
});

test('a habit not due today leaves at once and can be undone the same day, not later', async () => {
  const swim = await newHabit({ name: 'Swim', deadline: '19:00', days: [2], penalty: 10 });
  assert.equal((await inPlan(swim.id)).leavesFrom, '2027-05-10');
  assert.equal(ok(await call('DELETE', `/api/habits/${swim.id}`)).from, '2027-05-10');
  assert.equal(await inPlan(swim.id), undefined, 'gone from the list straight away');

  assert.equal(ok(await call('POST', `/api/habits/${swim.id}/restore`, {})).name, 'Swim');
  assert.ok(await inPlan(swim.id), 'Undo brings it back');

  ok(await call('DELETE', `/api/habits/${swim.id}`));
  clock = clock.plus({ days: 1 });
  const late = await call('POST', `/api/habits/${swim.id}/restore`, {});
  assert.equal(late.status, 400, 'after the day it left, it has to be added again');
  assert.match(late.data.error, /already left your list/);
});
