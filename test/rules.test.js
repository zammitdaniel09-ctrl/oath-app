// Strict but survivable: the daily loss cap, no misses spilling into a new season, and pardons after
// a death. Against a real Postgres with a controllable clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-12T08:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-rules-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54349,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let runOnce; let cookie = ''; let dbmod;

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const today = async () => (await call('GET', '/api/today')).data;
const missesOn = async (date) => dbmod.db()`select id, title, hp_lost from misses where date = ${date} order by id`;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54349/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app, runOnce } = await import('../src/server.js'));
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
  await runOnce();
  // Eight daily habits at 25 HP each: 200 HP on the line every day, twice the HP there is.
  for (let i = 1; i <= 8; i += 1) {
    const r = await call('POST', '/api/habits', { name: `Habit ${i}`, deadline: '21:00', penalty: 25 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
});

after(async () => {
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('what is at stake today is capped, and the plan shows the worst day', async () => {
  const t = await today();
  assert.equal(t.progress.fullStake, 200);
  assert.equal(t.progress.atStake, 50);
  assert.equal(t.progress.lethal, false);
  const plan = (await call('GET', '/api/plan')).data;
  assert.equal(plan.settings.worstDay, 200);
  assert.equal(plan.settings.dailyLossCap, 50);
});

test('a fully missed day costs 50 HP, and every miss is still recorded', async () => {
  setLocal('2026-10-12T21:30');
  await runOnce();
  const misses = await missesOn('2026-10-12');
  assert.equal(misses.length, 8);
  assert.equal(misses.reduce((n, m) => n + m.hp_lost, 0), 50);
  const t = await today();
  assert.equal(t.game.hp, 50);
  assert.equal(t.game.deaths, 0);
});

test('the next morning, missing everything again is flagged as lethal', async () => {
  setLocal('2026-10-13T08:00');
  await runOnce();
  const t = await today();
  assert.equal(t.progress.atStake, 50);
  assert.equal(t.progress.lethal, true);
});

test('a second fully missed day kills, and the rest of that day costs the new season nothing', async () => {
  setLocal('2026-10-13T21:30');
  await runOnce();
  const t = await today();
  assert.equal(t.game.deaths, 1);
  assert.equal(t.game.hp, 100, 'the new season starts full and stays full');
  assert.equal((await missesOn('2026-10-13')).length, 8);
});

test('a pardon for a miss from before the death saves the record but gives no HP back', async () => {
  const [first] = await missesOn('2026-10-13');
  const r = await call('POST', `/api/misses/${first.id}/pardon`, {
    reason: 'Was in hospital all day with my brother',
    plan: 'If that happens again, I will book a rest day the night before.',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.hpRestored, 0);
  assert.equal(r.data.hp, 100);
});
