// End-to-end tests of the accountability rules against a real Postgres, with a controllable clock.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-drive-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54331,
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
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54331/oath';
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


test('the morning oath, focus blocks, dodges, reactions and closing the day', async () => {
  assert.equal((await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' })).status, 200);
  setLocal('2026-10-12T08:00');
  const gym = (await call('POST', '/api/habits', { name: 'Gym', deadline: '19:00', non_negotiable: true })).data.habit;
  const read = (await call('POST', '/api/habits', { name: 'Read', deadline: '21:00' })).data.habit;
  const vat = (await call('POST', '/api/tasks', { title: 'VAT return', due_date: '2026-10-12', deadline: '17:00', hard: true })).data;
  const loose = (await call('POST', '/api/tasks', { title: 'Tidy desk' })).data;

  let t = (await today()).data;
  assert.equal(t.plan, null);
  assert.equal(t.progress.open, 3);
  assert.equal(t.progress.atStake, 50);
  assert.equal(t.next.title, 'VAT return', 'soonest deadline first before the oath');

  assert.equal((await call('POST', '/api/oath', { focusKind: 'habit', focusId: 999 })).status, 400);
  const oath = await call('POST', '/api/oath', { focusKind: 'habit', focusId: gym.id, intention: 'Strong body, clear head' });
  assert.equal(oath.status, 200);
  assert.equal((await call('POST', '/api/oath', { focusKind: 'habit', focusId: gym.id })).status, 409);
  t = (await today()).data;
  assert.equal(t.plan.focusTitle, 'Gym');
  assert.match(t.plan.coachPlan, /Order of battle/);
  assert.equal(t.next.title, 'Gym', 'the one thing jumps the queue when nothing is urgent');
  assert.equal(t.next.isFocus, true);

  const f = await call('POST', '/api/focus', { kind: 'habit', id: gym.id, minutes: 25 });
  assert.equal(f.status, 200);
  assert.equal((await call('POST', '/api/focus', { kind: 'habit', id: read.id })).status, 409);
  assert.equal((await today()).data.focus.title, 'Gym');
  setLocal('2026-10-12T08:26');
  await runOnce();
  const [s] = await dbmod.db()`select notified from focus_sessions where id = ${f.data.id}`;
  assert.equal(s.notified, true, 'a finished block gets a nudge');
  const fin = await call('POST', `/api/focus/${f.data.id}/finish`, { outcome: 'done' });
  assert.equal(fin.data.outcome, 'done');
  assert.match(fin.data.reaction.text, /Gym done/);
  t = (await today()).data;
  assert.equal(t.items.find((i) => i.id === gym.id).status, 'kept');
  assert.equal(t.focus, null);

  setLocal('2026-10-12T09:00');
  assert.equal((await call('POST', '/api/defer', { kind: 'habit', id: read.id, reason: '' })).status, 400);
  assert.equal((await call('POST', '/api/defer', { kind: 'habit', id: read.id, reason: 'Tired', moveToTomorrow: true })).status, 400);
  const d1 = await call('POST', '/api/defer', { kind: 'habit', id: read.id, reason: 'Tired' });
  assert.match(d1.data.reaction.text, /Logged: "Tired"/);
  assert.match(d1.data.reaction.text, /does not move: 21:00/);
  assert.equal((await call('POST', '/api/defer', { kind: 'task', id: vat.id, reason: 'Later', moveToTomorrow: true })).status, 400, 'hard tasks cannot be moved');
  const d2 = await call('POST', '/api/defer', { kind: 'task', id: loose.id, reason: 'tired', moveToTomorrow: true });
  assert.match(d2.data.reaction.text, /moved to tomorrow/);
  assert.match(d2.data.reaction.text, /2 of them "tired"/);
  t = (await today()).data;
  assert.equal(t.dodgesToday, 2);
  assert.equal(t.next.title, 'VAT return', 'a dodged item steps aside for an hour');

  const k = await call('POST', `/api/habits/${read.id}/keep`, {});
  assert.match(k.data.reaction.text, /Read done\. 1 left today\. Next: VAT return by 17:00\./);
  const v = await call('POST', `/api/tasks/${vat.id}/done`, {});
  assert.match(v.data.reaction.text, /Clean sweep/);
  assert.equal(v.data.reaction.big, true);

  assert.equal((await call('POST', '/api/reflection', { rating: 6 })).status, 400);
  const r = await call('POST', '/api/reflection', { rating: 4, blocker: 'Phone in the morning', win: 'Gym before 9' });
  assert.match(r.data.reply, /4 out of 5/);
  assert.equal((await today()).data.reflection.rating, 4);

  const { coachSnapshot } = await import('../src/state.js');
  const snap = await coachSnapshot();
  assert.match(snap, /one thing is "Gym"/);
  assert.match(snap, /Dodges in the last 7 days/);
  assert.match(snap, /Phone in the morning/);
});

test('telegram stays off without a token', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const s = await call('GET', '/api/telegram');
  assert.equal(s.data.enabled, false);
  assert.equal((await call('POST', '/api/telegram/link', {})).status, 400);
  const res = await app.request('/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"update_id":1}' });
  assert.equal(res.status, 403, 'webhook refuses calls without the secret');
});
