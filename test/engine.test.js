// End-to-end tests of the accountability rules against a real Postgres, with a controllable clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-07T10:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54329,
  persistent: false, createPostgresUser: true, onLog: () => {}, onError: () => {},
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
const today = () => call('GET', '/api/today');

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54329/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app, runOnce } = await import('../src/server.js'));
});

after(async () => {
  await dbmod.close();
  await pg.stop();
});

test('setup, login and auth guard', async () => {
  assert.equal((await today()).status, 401);
  assert.equal((await call('POST', '/api/setup', { code: 'wrong', password: 'long-enough-pass' })).status, 403);
  assert.equal((await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'short' })).status, 400);
  const ok = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'another-pass-123' })).status, 409);
  const t = await today();
  assert.equal(t.status, 200);
  assert.equal(t.data.game.hp, 100);
  await call('POST', '/api/logout', {});
  assert.equal((await today()).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope-nope-nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'long-enough-pass' })).status, 200);
  assert.equal((await today()).status, 200);
});

test('keep, undo window and deadline lock', async () => {
  setLocal('2026-10-07T10:00');
  const gym = await call('POST', '/api/habits', { name: 'Gym', deadline: '19:00', non_negotiable: true });
  assert.equal(gym.status, 200);
  assert.equal(gym.data.startsToday, true);
  assert.equal(gym.data.habit.penalty, 25);
  const read = await call('POST', '/api/habits', { name: 'Read 20 pages', deadline: '12:00' });
  assert.equal(read.data.habit.penalty, 10);
  const late = await call('POST', '/api/habits', { name: 'Morning walk', deadline: '08:00' });
  assert.equal(late.data.startsToday, false, 'a habit whose deadline already passed starts tomorrow');

  const gymId = gym.data.habit.id;
  assert.equal((await call('POST', `/api/habits/${gymId}/keep`, {})).status, 200);
  let t = await today();
  assert.equal(t.data.items.find((i) => i.id === gymId).status, 'kept');
  assert.equal(t.data.items.find((i) => i.id === gymId).streak, 1);
  setLocal('2026-10-07T10:05');
  assert.equal((await call('POST', `/api/habits/${gymId}/undo`, {})).status, 200);
  assert.equal((await call('POST', `/api/habits/${gymId}/keep`, {})).status, 200);
  setLocal('2026-10-07T10:20');
  assert.equal((await call('POST', `/api/habits/${gymId}/undo`, {})).status, 409, 'undo closes after 10 minutes');

  setLocal('2026-10-07T12:01');
  await runOnce();
  t = await today();
  assert.equal(t.data.game.hp, 90);
  const readItem = t.data.items.find((i) => i.id === read.data.habit.id);
  assert.equal(readItem.status, 'missed');
  const keepLate = await call('POST', `/api/habits/${read.data.habit.id}/keep`, {});
  assert.equal(keepLate.status, 409);
  assert.match(keepLate.data.error, /Locked/);
  await runOnce();
  assert.equal((await today()).data.game.hp, 90, 'a miss is only charged once');
});

test('pardons restore HP once, need a reason and are limited', async () => {
  const t = await today();
  const missId = t.data.items.find((i) => i.status === 'missed').missId;
  assert.equal((await call('POST', `/api/misses/${missId}/pardon`, { reason: 'too short' })).status, 400);
  const p = await call('POST', `/api/misses/${missId}/pardon`, { reason: 'Hospital visit with my dad all morning' });
  assert.equal(p.status, 200);
  assert.equal(p.data.hp, 100);
  assert.equal(p.data.pardonsLeft, 1);
  assert.equal((await call('POST', `/api/misses/${missId}/pardon`, { reason: 'Hospital visit with my dad all morning' })).status, 409);
});

test('rule changes on an open habit wait until tomorrow', async () => {
  setLocal('2026-10-07T13:00');
  const h = await call('POST', '/api/habits', { name: 'Deep work block', deadline: '17:00', non_negotiable: true });
  const r = await call('PATCH', `/api/habits/${h.data.habit.id}`, { deadline: '23:00' });
  assert.equal(r.data.effective, '2026-10-08');
  let item = (await today()).data.items.find((i) => i.id === h.data.habit.id);
  assert.equal(item.deadline, '17:00', 'today keeps the old deadline');
  assert.equal(item.rulesChangeFrom, '2026-10-08');
  assert.equal((await call('POST', `/api/habits/${h.data.habit.id}/keep`, {})).status, 200);
});

test('reminders fire in their window and only once', async () => {
  setLocal('2026-10-07T13:30');
  const h = await call('POST', '/api/habits', { name: 'Call the accountant', deadline: '15:00', non_negotiable: true });
  setLocal('2026-10-07T13:00');
  setLocal('2026-10-07T14:30');
  let notes = await runOnce();
  assert.ok(notes.some((n) => n.title.startsWith('Call the accountant: 30 min left')), JSON.stringify(notes));
  notes = await runOnce();
  assert.ok(!notes.some((n) => n.title.startsWith('Call the accountant')), 'no duplicate reminder');
  await call('POST', `/api/habits/${h.data.habit.id}/keep`, {});
});

test('hard tasks cost HP and cannot be deleted once due', async () => {
  setLocal('2026-10-07T14:40');
  const t = await call('POST', '/api/tasks', { title: 'Send the VAT return', due_date: '2026-10-07', deadline: '15:00', hard: true });
  assert.equal(t.status, 200);
  assert.equal((await call('DELETE', `/api/tasks/${t.data.id}`)).status, 409);
  assert.equal((await call('PATCH', `/api/tasks/${t.data.id}`, { due_date: '2026-10-09' })).status, 409);
  const soft = await call('POST', '/api/tasks', { title: 'Buy printer ink' });
  assert.equal((await call('DELETE', `/api/tasks/${soft.data.id}`)).status, 200);
  setLocal('2026-10-07T15:01');
  await runOnce();
  const s = await today();
  assert.equal(s.data.game.hp, 85);
  assert.equal(s.data.tasks.find((k) => k.id === t.data.id).status, 'missed');
});

test('day close, clean-day bonus and catch-up after downtime', async () => {
  // Oct 7: Gym kept, Read pardoned, Deep work kept, accountant kept, VAT task missed -> dirty day, no bonus.
  setLocal('2026-10-08T00:01');
  await runOnce();
  let led = (await call('GET', '/api/ledger')).data;
  const d7 = led.days.find((d) => d.date === '2026-10-07');
  assert.equal(d7.clean, false);
  assert.equal(d7.missed, 1);
  assert.equal(d7.pardoned, 1);
  assert.equal(d7.bonus, 0);

  // Oct 8: keep everything that is due.
  setLocal('2026-10-08T07:00');
  let t = await today();
  for (const i of t.data.items) await call('POST', `/api/habits/${i.id}/keep`, {});
  t = await today();
  assert.ok(t.data.items.every((i) => i.status === 'kept'));
  assert.equal(t.data.items.find((i) => i.title === 'Gym').streak, 2);
  const deep = t.data.items.find((i) => i.title === 'Deep work block');
  assert.equal(deep.deadline, '23:00', 'new rules took effect');

  // The server is down for three days; on return it judges every missed day.
  setLocal('2026-10-11T09:00');
  await runOnce();
  led = (await call('GET', '/api/ledger')).data;
  const d8 = led.days.find((d) => d.date === '2026-10-08');
  assert.equal(d8.clean, true);
  assert.equal(d8.bonus, 5);
  assert.ok(led.days.find((d) => d.date === '2026-10-09'));
  assert.ok(led.days.find((d) => d.date === '2026-10-10'));
  assert.equal(led.misses.filter((m) => m.date === '2026-10-09').length, 5, 'every habit due on the 9th was charged');
  t = await today();
  assert.ok(t.data.game.deaths >= 1, 'five misses a day for two days is fatal');
});

test('running out of HP kills you and resets the season', async () => {
  setLocal('2026-10-11T09:05');
  const before = (await today()).data.game;
  await call('POST', '/api/habits', { name: 'Cold plunge', deadline: '10:00', non_negotiable: true, penalty: 100 });
  setLocal('2026-10-11T10:01');
  const notes = await runOnce();
  assert.ok(notes.some((n) => n.title === 'You died.'), JSON.stringify(notes));
  const g = (await today()).data.game;
  assert.equal(g.deaths, before.deaths + 1);
  assert.equal(g.season, before.season + 1);
  assert.equal(g.hp, 100);
  assert.equal(g.seasonStart, '2026-10-11');
  const led = (await call('GET', '/api/ledger')).data;
  assert.equal(led.deaths.length, before.deaths + 1);
});

test('pardons refill at the start of a month', async () => {
  setLocal('2026-11-01T08:00');
  await runOnce();
  assert.equal((await today()).data.game.pardonsLeft, 2);
});

test('coach answers offline without an API key and briefs fall back', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = await call('POST', '/api/coach', { text: 'What should I do now?' });
  assert.equal(r.status, 200);
  assert.match(r.data.reply.text, /offline/);
  const b = await call('POST', '/api/briefs/morning', {});
  assert.equal(b.status, 200);
  assert.match(b.data.text, /HP/);
  const t = await today();
  assert.equal(t.data.briefs[0].kind, 'morning');
});

test('non-JSON writes are refused', async () => {
  const res = await app.request('/api/tasks', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(res.status, 415);
});

test('an emptied database rebuilds itself without a restart', async () => {
  await dbmod.db().unsafe('drop schema public cascade; create schema public;');
  const first = await call('GET', '/api/session');
  assert.equal(first.status, 503);
  const second = await call('GET', '/api/session');
  assert.equal(second.status, 200);
  assert.equal(second.data.setupDone, false);
  await runOnce();
  assert.ok((await dbmod.getKV('game')).hp > 0);
});
