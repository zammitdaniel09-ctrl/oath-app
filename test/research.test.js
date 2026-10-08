// End-to-end tests of the research-driven accountability rules (habit strength, comebacks, repeat
// misses, X-a-week habits, minimum versions, rest days, reminders, capture, Siri tokens, goals,
// mind maps, weekly review, oath and export) against a real Postgres with a controllable clock.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-research-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54335,
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
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54335/oath';
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
});

after(async () => {
  await dbmod.close();
  await pg.stop();
});

// ---------- Helpers ----------

// A clean slate for each scenario: wipe everything except the owner, sessions and keys, and
// start a new game at the given local time.
async function reset(iso) {
  setLocal(iso);
  await dbmod.db().unsafe(`truncate habits, completions, tasks, misses, days, events, reminders_sent, day_plans,
    focus_sessions, deferrals, reflections, goals, goal_logs, nodes, rest_days, api_tokens, weekly_reviews, briefs,
    coach_messages, push_subs restart identity cascade`);
  await dbmod.db()`delete from kv where key in ('game', 'settings')`;
  await runOnce();
  const t = await today();
  assert.equal(t.status, 200);
  assert.equal(t.data.game.hp, 100);
}

// Pretend a daily habit was started n days ago and kept on every one of them.
async function seedKept(habitId, n) {
  const sql = dbmod.db();
  await sql`update habits set start_date = ${clock.minus({ days: n }).toISODate()} where id = ${habitId}`;
  for (let i = n; i >= 1; i -= 1) {
    const d = clock.minus({ days: i });
    await sql`insert into completions (habit_id, date, completed_at) values (${habitId}, ${d.toISODate()}, ${d.toUTC().toJSDate()})`;
  }
}

const hp = async () => (await today()).data.game.hp;
const item = async (id) => (await today()).data.items.find((i) => i.kind === 'habit' && i.id === id);
const planHabit = async (id) => (await call('GET', '/api/plan')).data.habits.find((h) => h.id === id);
const allMisses = async () => (await call('GET', '/api/review')).data.misses;
const dayRow = async (date) => (await call('GET', '/api/review')).data.days.find((d) => d.date === date);
const keep = (id, body = {}) => call('POST', `/api/habits/${id}/keep`, body);
const newHabit = async (body) => {
  const r = await call('POST', '/api/habits', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.habit;
};

// Raw request with no cookie, for the Siri / Shortcuts endpoints.
async function bare(method, url, { token, json } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ---------- 1. Habit strength ----------

test('1. strength: ~80 after 30 kept days, ~96 after 60, one miss costs a few points, survives death while streaks reset', async () => {
  await reset('2026-10-12T08:00');
  const start = clock;
  const read = await newHabit({ name: 'Read', deadline: '21:00' });
  const keepDays = async (from, n) => {
    for (let i = from; i < from + n; i += 1) {
      clock = start.plus({ days: i });
      await runOnce();
      const r = await keep(read.id);
      assert.equal(r.status, 200, `keep on day ${i}: ${JSON.stringify(r.data)}`);
    }
  };

  await keepDays(0, 30);
  clock = start.plus({ days: 30 });
  await runOnce();
  const p30 = await planHabit(read.id);
  assert.ok(p30.strength >= 78 && p30.strength <= 82, `30 days -> about 80, got ${p30.strength}`);
  assert.equal((await item(read.id)).strength, p30.strength, '/api/today shows the same strength');

  await keepDays(30, 30);
  clock = start.plus({ days: 60 });
  await runOnce();
  const p60 = await planHabit(read.id);
  assert.ok(p60.strength >= 94 && p60.strength <= 97, `60 days -> about 96, got ${p60.strength}`);
  assert.equal(p60.streak, 60);
  assert.equal((await item(read.id)).strength, p60.strength);

  // A death (season reset) wipes streaks but not strength.
  const killer = await newHabit({ name: 'Killer', deadline: '10:00', penalty: 100 });
  clock = start.plus({ days: 60, hours: 2, minutes: 1 }); // 10:01
  const notes = await runOnce();
  assert.ok(notes.some((n) => n.tag === 'death'), JSON.stringify(notes));
  const g = (await today()).data.game;
  assert.equal(g.deaths, 1);
  assert.equal(g.season, 2);
  const afterDeath = await planHabit(read.id);
  assert.equal(afterDeath.strength, p60.strength, 'strength survives a death');
  assert.equal(afterDeath.streak, 0, 'streak resets on death');
  const it = await item(read.id);
  assert.equal(it.strength, p60.strength);
  assert.equal(it.streak, 0);
  assert.equal((await call('DELETE', `/api/habits/${killer.id}`)).status, 200);

  // Keep today, then one miss tomorrow.
  assert.equal((await keep(read.id)).status, 200);
  clock = start.plus({ days: 61 });
  await runOnce();
  const before1 = (await planHabit(read.id)).strength;
  clock = start.plus({ days: 61, hours: 13, minutes: 1 }); // 21:01
  await runOnce();
  assert.equal((await item(read.id)).status, 'missed');
  clock = start.plus({ days: 62 });
  await runOnce();
  const afterMiss = (await planHabit(read.id)).strength;
  assert.ok(afterMiss > 85, `one miss keeps strength above 85, got ${afterMiss}`);
  assert.ok(afterMiss < before1 && before1 - afterMiss <= 6, `a miss costs a few points: ${before1} -> ${afterMiss}`);
  assert.ok(afterMiss > 0);
});

// ---------- 2. Comeback bonus ----------

test('2a. comeback: keeping on the next scheduled day after an unpardoned miss gives +5 HP; undo takes it back', async () => {
  await reset('2026-10-12T08:00'); // Monday
  const stretch = await newHabit({ name: 'Stretch', deadline: '20:00', days: [1, 3, 5] });
  setLocal('2026-10-12T20:01');
  await runOnce();
  assert.equal(await hp(), 90);
  setLocal('2026-10-13T08:00'); // Tuesday: not scheduled
  await runOnce();
  assert.equal(await item(stretch.id), undefined);
  setLocal('2026-10-14T08:00'); // Wednesday: next scheduled day
  await runOnce();
  assert.equal(await hp(), 90);
  assert.equal((await item(stretch.id)).missedLast, true);
  const k = await keep(stretch.id);
  assert.equal(k.status, 200);
  assert.equal(k.data.comeback, 5);
  assert.match(k.data.reaction.text, /Comeback/);
  assert.equal(await hp(), 95);
  assert.equal((await item(stretch.id)).comeback, true);
  setLocal('2026-10-14T08:05');
  assert.equal((await call('POST', `/api/habits/${stretch.id}/undo`, {})).status, 200);
  assert.equal(await hp(), 90, 'undo within 10 minutes removes the bonus');
});

test('2b. comeback is capped at max HP and undo removes only what was given', async () => {
  await reset('2026-10-12T08:00');
  const floss = await newHabit({ name: 'Floss', deadline: '20:00', penalty: 3 });
  setLocal('2026-10-12T20:01');
  await runOnce();
  assert.equal(await hp(), 97);
  setLocal('2026-10-13T08:00');
  await runOnce();
  const k = await keep(floss.id);
  assert.equal(k.data.comeback, 3, 'bonus capped at max HP 100');
  assert.equal(await hp(), 100);
  setLocal('2026-10-13T08:03');
  assert.equal((await call('POST', `/api/habits/${floss.id}/undo`, {})).status, 200);
  assert.equal(await hp(), 97, 'undo gives back exactly the bonus that was granted');
});

test('2c. a pardoned miss gives no comeback', async () => {
  await reset('2026-10-12T08:00');
  const journal = await newHabit({ name: 'Journal', deadline: '20:00' });
  await call('POST', '/api/tasks', { title: 'Pay the fine', due_date: '2026-10-12', deadline: '12:00', hard: true, first_step: 'Find the letter' });
  setLocal('2026-10-12T20:01');
  await runOnce();
  assert.equal(await hp(), 75);
  const missId = (await item(journal.id)).missId;
  const p = await call('POST', `/api/misses/${missId}/pardon`, { reason: 'Stuck at the hospital all evening', plan: 'If the evening is gone, I journal at lunch' });
  assert.equal(p.status, 200);
  assert.equal(p.data.hp, 85);
  setLocal('2026-10-13T08:00');
  await runOnce();
  const k = await keep(journal.id);
  assert.equal(k.status, 200);
  assert.equal(k.data.comeback, 0);
  assert.equal(await hp(), 85);
});

// ---------- 3. Second miss in a row ----------

test('3. a second miss in a row costs 1.5x and is flagged; a miss after a kept day costs the normal penalty', async () => {
  await reset('2026-10-12T08:00');
  const gym = await newHabit({ name: 'Gym', deadline: '19:00', non_negotiable: true });
  const read = await newHabit({ name: 'Read', deadline: '21:00' });
  assert.equal(gym.penalty, 25);
  assert.equal(read.penalty, 10);
  setLocal('2026-10-12T21:01');
  await runOnce();
  assert.equal(await hp(), 65);
  setLocal('2026-10-13T08:00');
  await runOnce();
  setLocal('2026-10-13T21:01');
  await runOnce();
  let m = await allMisses();
  const gym2 = m.find((x) => x.title === 'Gym' && x.date === '2026-10-13');
  const read2 = m.find((x) => x.title === 'Read' && x.date === '2026-10-13');
  assert.equal(gym2.hpLost, 38, '25 x 1.5 rounded');
  assert.equal(gym2.repeat, true);
  assert.equal(read2.hpLost, 15, '10 x 1.5');
  assert.equal(read2.repeat, true);
  assert.equal(m.find((x) => x.title === 'Gym' && x.date === '2026-10-12').repeat, false);
  assert.equal(await hp(), 12);
  assert.equal((await item(gym.id)).missRepeat, true);

  setLocal('2026-10-14T08:00');
  await runOnce();
  assert.equal((await keep(gym.id)).status, 200);
  assert.equal((await keep(read.id)).status, 200);
  setLocal('2026-10-15T08:00');
  await runOnce();
  assert.equal((await keep(gym.id)).status, 200);
  setLocal('2026-10-15T21:01');
  await runOnce();
  m = await allMisses();
  const read4 = m.find((x) => x.title === 'Read' && x.date === '2026-10-15');
  assert.equal(read4.hpLost, 10, 'a miss after a kept day is charged normally');
  assert.equal(read4.repeat, false);
});

// ---------- 4. X times a week ----------

test('4. X-a-week habits: settled on Sunday, prorated mid-week, mustToday, comeback at settlement', async () => {
  await reset('2026-10-12T08:00'); // Monday
  const swim = await newHabit({ name: 'Swim', weekly_target: 3 });
  let it = await item(swim.id);
  assert.equal(it.flexible, true);
  assert.equal(it.weekTarget, 3);
  assert.equal(it.mustToday, false);

  const tickAt = async (iso) => { setLocal(iso); return runOnce(); };
  await tickAt('2026-10-13T08:00');
  assert.equal((await keep(swim.id)).status, 200);
  await tickAt('2026-10-14T08:00');
  await tickAt('2026-10-15T08:00');
  const yoga = await newHabit({ name: 'Yoga', weekly_target: 3 }); // Thursday start: 4 eligible days
  assert.equal((await item(yoga.id)).weekTarget, 2, 'round(3 * 4 / 7) = 2');
  assert.equal((await keep(yoga.id)).status, 200);
  await tickAt('2026-10-16T08:00'); // Friday: swim needs 2, 3 days left
  assert.equal((await item(swim.id)).mustToday, false);
  await tickAt('2026-10-17T08:00'); // Saturday: swim needs 2, 2 days left
  let t = (await today()).data;
  it = t.items.find((i) => i.id === swim.id);
  assert.equal(it.mustToday, true, JSON.stringify(it));
  assert.ok(t.openDue.some((o) => o.kind === 'habit' && o.id === swim.id), 'mustToday item is in openDue');
  assert.equal(t.items.find((i) => i.id === yoga.id).mustToday, false);
  assert.ok(!t.openDue.some((o) => o.kind === 'habit' && o.id === yoga.id));
  await tickAt('2026-10-18T08:00');
  await tickAt('2026-10-18T23:59');
  let m = await allMisses();
  assert.equal(m.filter((x) => x.kind === 'habit').length, 0, 'never charged daily');
  assert.equal(await hp(), 100);

  await tickAt('2026-10-19T00:01'); // Monday: Sunday is finalized
  m = await allMisses();
  const swimMiss = m.find((x) => x.title.startsWith('Swim'));
  const yogaMiss = m.find((x) => x.title.startsWith('Yoga'));
  assert.equal(swimMiss.date, '2026-10-18');
  assert.equal(swimMiss.hpLost, 7, 'ceil(10 * 2 / 3)');
  assert.equal(yogaMiss.hpLost, 5, 'ceil(10 * 1 / 2) on the prorated target');
  assert.equal(await hp(), 88);

  // Week 2: meet the target after the missed week.
  for (const d of ['2026-10-19', '2026-10-20', '2026-10-21']) {
    await tickAt(`${d}T08:00`);
    const k = await keep(swim.id);
    assert.equal(k.status, 200);
    assert.equal(k.data.comeback, 0, 'no comeback on a single X-a-week keep');
    assert.equal((await keep(yoga.id)).status, 200);
  }
  await tickAt('2026-10-22T08:00');
  assert.equal(await hp(), 100);
  await tickAt('2026-10-25T08:00');
  assert.equal((await call('POST', '/api/tasks', { title: 'Renew licence', due_date: '2026-10-25', deadline: '12:00', hard: true, first_step: 'Open the form' })).status, 200);
  await tickAt('2026-10-25T12:01');
  assert.equal(await hp(), 85);
  const notes = await tickAt('2026-10-26T00:01');
  assert.ok(notes.some((n) => /Back on track: Swim/.test(n.title)), JSON.stringify(notes));
  assert.ok(notes.some((n) => /Back on track: Yoga/.test(n.title)), JSON.stringify(notes));
  assert.equal(await hp(), 95, 'comeback +5 per habit at settlement');
  m = await allMisses();
  assert.ok(!m.some((x) => x.date === '2026-10-25' && x.kind === 'habit'), 'met targets are not charged');
});

// ---------- 5. Minimum version ----------

test('5. minimum version saves the HP and the streak but not the clean-day bonus', async () => {
  await reset('2026-10-12T08:00');
  await call('POST', '/api/tasks', { title: 'Submit form', due_date: '2026-10-12', deadline: '09:00', hard: true, first_step: 'Open the form' });
  const run = await newHabit({ name: 'Run 5k', deadline: '20:00', minimum: 'Run 1k' });
  const med = await newHabit({ name: 'Meditate', deadline: '20:00' });
  assert.equal((await item(run.id)).minimum, 'Run 1k');
  assert.equal((await keep(med.id, { minimum: true })).status, 400, 'no minimum version -> rejected');
  const patch = await call('PATCH', `/api/habits/${med.id}`, { minimum: '1 minute breathing' });
  assert.equal(patch.data.effective, '2026-10-13', 'a new minimum takes effect tomorrow');
  assert.equal((await keep(med.id, { minimum: true })).status, 400, 'not usable today');
  assert.equal((await keep(med.id)).status, 200);
  assert.equal((await keep(run.id)).status, 200);
  setLocal('2026-10-12T09:01');
  await runOnce();
  assert.equal(await hp(), 85);

  setLocal('2026-10-13T08:00');
  await runOnce();
  assert.equal((await item(med.id)).minimum, '1 minute breathing');
  const k = await keep(run.id, { minimum: true });
  assert.equal(k.status, 200);
  assert.match(k.data.reaction.text, /Minimum kept/);
  assert.equal((await keep(med.id, { minimum: true })).status, 200);
  const it = await item(run.id);
  assert.equal(it.status, 'kept');
  assert.equal(it.keptMinimum, true);
  assert.equal(it.streak, 2);

  setLocal('2026-10-14T08:00');
  await runOnce();
  const d13 = await dayRow('2026-10-13');
  assert.equal(d13.missed, 0, 'the minimum saved the HP');
  assert.equal(d13.clean, false, 'a minimum day is not clean');
  assert.equal(d13.bonus, 0);
  assert.equal(await hp(), 85);
  assert.equal((await keep(run.id)).status, 200);
  assert.equal((await keep(med.id)).status, 200);

  setLocal('2026-10-15T08:00');
  await runOnce();
  const d14 = await dayRow('2026-10-14');
  assert.equal(d14.clean, true);
  assert.equal(d14.bonus, 5);
  assert.equal(await hp(), 90);
  assert.equal((await item(run.id)).streak, 3, 'minimum days count for the streak');
});

test('5b. a minimum completion of an X-a-week habit also makes the day not clean', async () => {
  await reset('2026-10-12T08:00');
  await call('POST', '/api/tasks', { title: 'Submit form', due_date: '2026-10-12', deadline: '09:00', hard: true, first_step: 'Open the form' });
  setLocal('2026-10-12T09:01');
  await runOnce();
  assert.equal(await hp(), 85);
  setLocal('2026-10-13T08:00');
  await runOnce();
  const swim = await newHabit({ name: 'Swim', weekly_target: 2, minimum: '10 lengths' });
  assert.equal((await keep(swim.id, { minimum: true })).status, 200);
  setLocal('2026-10-14T08:00');
  await runOnce();
  const d13 = await dayRow('2026-10-13');
  assert.equal(d13.clean, false, 'any minimum completion makes the day not clean');
  assert.equal(d13.bonus, 0);
});

// ---------- 6. Rest days ----------

test('6. rest days: booked ahead, 2 a month, excuse fixed habits, not clean, hard tasks still count', async () => {
  await reset('2026-10-12T08:00');
  const walk = await newHabit({ name: 'Walk', deadline: '20:00' });
  const swim = await newHabit({ name: 'Swim', weekly_target: 2 });
  assert.equal((await call('POST', '/api/rest', { date: '2026-10-12' })).status, 400, 'not today');
  assert.equal((await call('POST', '/api/rest', { date: '2026-10-11' })).status, 400, 'not the past');
  assert.equal((await call('POST', '/api/rest', { date: '2026-10-13', reason: 'Family day' })).status, 200);
  assert.equal((await call('POST', '/api/rest', { date: '2026-10-15' })).status, 200);
  assert.equal((await call('POST', '/api/rest', { date: '2026-10-27' })).status, 409, 'third in a month refused');
  assert.equal((await call('POST', '/api/rest', { date: '2026-11-03' })).status, 200, 'next month has its own quota');
  assert.equal((await call('DELETE', '/api/rest/2026-11-03')).status, 200, 'a future rest day can be cancelled');
  assert.equal((await call('POST', '/api/tasks', { title: 'Pay rent', due_date: '2026-10-13', deadline: '12:00', hard: true, first_step: 'Open the bank app' })).status, 200);
  assert.equal((await keep(walk.id)).status, 200);

  setLocal('2026-10-13T08:00');
  await runOnce();
  let t = (await today()).data;
  assert.equal(t.rest, true);
  assert.ok(!t.items.some((i) => i.id === walk.id), 'fixed habits are off on a rest day');
  assert.equal((await keep(walk.id)).status, 400);
  assert.equal((await call('DELETE', '/api/rest/2026-10-13')).status, 409, 'cannot cancel once the day has started');
  setLocal('2026-10-13T12:01');
  await runOnce();
  assert.equal(await hp(), 85, 'hard tasks still cost HP on a rest day');
  setLocal('2026-10-13T20:01');
  await runOnce();
  assert.ok(!(await allMisses()).some((m) => m.title === 'Walk'), 'Walk is not charged on a rest day');

  setLocal('2026-10-14T08:00');
  await runOnce();
  const d13 = await dayRow('2026-10-13');
  assert.equal(d13.rest, true);
  assert.equal(d13.clean, false);
  assert.equal((await keep(walk.id)).status, 200);

  setLocal('2026-10-15T08:00'); // second rest day: keep an X-a-week habit, miss nothing
  await runOnce();
  assert.equal((await keep(swim.id)).status, 200);
  setLocal('2026-10-15T20:01');
  await runOnce();
  setLocal('2026-10-16T08:00');
  await runOnce();
  const d15 = await dayRow('2026-10-15');
  assert.equal(d15.rest, true);
  assert.equal(d15.missed, 0);
  assert.equal(d15.clean, false, 'a rest day is never clean');
  assert.equal(d15.bonus, 0);
  assert.equal(await hp(), 90, '85 + 5 for the clean Wednesday, nothing for the rest day');
  t = (await today()).data;
  assert.ok(!(await allMisses()).some((m) => m.title === 'Walk'));
});

// ---------- 7. Non-negotiable cap ----------

test('7. a fourth non-negotiable is refused until the others are at 80% strength', async () => {
  await reset('2026-10-12T08:00');
  const a = await newHabit({ name: 'Gym', deadline: '21:00', non_negotiable: true });
  const b = await newHabit({ name: 'Deep work', deadline: '21:00', non_negotiable: true });
  const c = await newHabit({ name: 'Sleep by 11', deadline: '21:00', non_negotiable: true });
  const fourth = { name: 'Cold plunge', deadline: '21:00', non_negotiable: true };
  const r = await call('POST', '/api/habits', fourth);
  assert.equal(r.status, 409);
  const plain = await newHabit({ name: 'Walk', deadline: '21:00' });
  assert.equal((await call('PATCH', `/api/habits/${plain.id}`, { non_negotiable: true })).status, 409, 'promoting a habit hits the cap too');
  await seedKept(a.id, 30);
  await seedKept(b.id, 30);
  assert.equal((await call('POST', '/api/habits', fourth)).status, 409, 'still one weak non-negotiable');
  await seedKept(c.id, 30);
  for (const h of [a, b, c]) assert.ok((await planHabit(h.id)).strength >= 80);
  assert.equal((await call('POST', '/api/habits', fourth)).status, 200, 'all three established -> allowed');
});

test('7b. non-negotiables that start tomorrow still count toward the cap', async () => {
  await reset('2026-10-12T22:00');
  for (const name of ['Gym', 'Deep work', 'Sleep by 11']) {
    const r = await call('POST', '/api/habits', { name, deadline: '21:00', non_negotiable: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.startsToday, false);
  }
  const r = await call('POST', '/api/habits', { name: 'Cold plunge', deadline: '21:00', non_negotiable: true });
  assert.equal(r.status, 409, 'four brand-new non-negotiables must not slip past the cap');
});

// ---------- 8. Pardons ----------

test('8. pardons need a reason and a plan, and the plan comes back as lastPlan', async () => {
  await reset('2026-10-12T08:00');
  const journal = await newHabit({ name: 'Journal', deadline: '09:00' });
  setLocal('2026-10-12T09:01');
  await runOnce();
  const missId = (await item(journal.id)).missId;
  assert.ok(missId);
  const plan = 'If the morning is gone, I journal at lunch';
  const reason = 'Hospital visit all morning';
  assert.equal((await call('POST', `/api/misses/${missId}/pardon`, { reason: '123456789', plan })).status, 400, 'reason under 10 chars');
  assert.equal((await call('POST', `/api/misses/${missId}/pardon`, { reason })).status, 400, 'no plan');
  assert.equal((await call('POST', `/api/misses/${missId}/pardon`, { reason, plan: '123456789' })).status, 400, 'plan under 10 chars');
  const p = await call('POST', `/api/misses/${missId}/pardon`, { reason, plan });
  assert.equal(p.status, 200);
  assert.equal(p.data.hp, 100);
  const m = (await allMisses()).find((x) => x.id === missId);
  assert.equal(m.plan, plan, 'plan stored');
  assert.equal(m.reason, reason);
  setLocal('2026-10-13T07:00');
  await runOnce();
  assert.equal((await item(journal.id)).lastPlan, plan, 'plan shows as lastPlan on the Today item');
});

// ---------- 9. Reminders ----------

test('9. reminders: last calls, cues, fading with strength, bundling, ttl and topic', async () => {
  await reset('2026-10-12T08:00');
  const gym = await newHabit({ name: 'Gym', deadline: '18:00', non_negotiable: true });
  const readStrong = await newHabit({ name: 'Read', deadline: '19:00' });
  const floss = await newHabit({ name: 'Floss', deadline: '20:00' });
  const stretch = await newHabit({ name: 'Stretch', deadline: '21:00', remind_at: '10:00', cue: 'after coffee' });
  const vitamins = await newHabit({ name: 'Vitamins', deadline: '22:00', remind_at: '11:00' });
  const walk = await newHabit({ name: 'Walk', deadline: '23:00' });
  const call2 = await newHabit({ name: 'Call mum', deadline: '23:00' });
  for (const h of [gym, readStrong, vitamins]) await seedKept(h.id, 30);
  assert.ok((await planHabit(gym.id)).strength >= 80);
  assert.ok((await planHabit(readStrong.id)).strength >= 80);
  assert.ok((await planHabit(vitamins.id)).strength >= 80);

  const at = async (hhmm) => { setLocal(`2026-10-12T${hhmm}`); return runOnce(); };
  const about = (notes, h) => notes.filter((n) => n.topic === `habit-${h.id}` || (n.items || []).some((x) => x.id === h.id));

  let notes = await at('10:00');
  let mine = about(notes, stretch);
  assert.equal(mine.length, 1, `cue reminder at remind_at: ${JSON.stringify(notes)}`);
  assert.match(mine[0].title, /Stretch/);
  assert.equal(mine[0].topic, `habit-${stretch.id}`);
  assert.ok(Math.abs(mine[0].ttl - 11 * 3600) <= 120, `ttl ~ time to deadline, got ${mine[0].ttl}`);

  notes = await at('11:00');
  assert.equal(about(notes, vitamins).length, 0, 'no cue reminder once strength >= 80');

  notes = await at('17:30');
  mine = about(notes, gym);
  assert.equal(mine.length, 1, `non-negotiable last call even when strong: ${JSON.stringify(notes)}`);
  assert.equal(mine[0].title, 'Gym: 30 min left');
  assert.equal(mine[0].topic, `habit-${gym.id}`);
  assert.ok(Math.abs(mine[0].ttl - 1800) <= 60, `ttl ${mine[0].ttl}`);
  await keep(gym.id);

  notes = await at('18:30');
  assert.equal(about(notes, readStrong).length, 0, 'no last call for a strong normal habit');
  await keep(readStrong.id);

  notes = await at('19:30');
  mine = about(notes, floss);
  assert.equal(mine.length, 1, `weak normal habit gets a last call: ${JSON.stringify(notes)}`);
  assert.equal(mine[0].title, 'Floss: 30 min left');
  await keep(floss.id);

  notes = await at('20:30');
  assert.equal(about(notes, stretch).length, 1, 'weak cue habit also gets its last call');
  await keep(stretch.id);

  notes = await at('21:30');
  assert.equal(about(notes, vitamins).length, 0, 'strong normal habit: no last call');
  await keep(vitamins.id);

  notes = await at('22:30');
  const bundle = notes.filter((n) => n.title === '2 things due soon');
  assert.equal(bundle.length, 1, JSON.stringify(notes));
  assert.equal(bundle[0].topic, 'bundle');
  assert.ok(Math.abs(bundle[0].ttl - 1800) <= 60);
  assert.deepEqual(bundle[0].items.map((x) => x.id).sort(), [walk.id, call2.id].sort());
  assert.ok(!notes.some((n) => n.topic === `habit-${walk.id}` || n.topic === `habit-${call2.id}`), 'bundled, not sent separately');
});

// ---------- 10. Hard tasks ----------

test('10. hard tasks need a first step; voice capture never creates a hard task', async () => {
  await reset('2026-10-12T08:00');
  const base = { title: 'File taxes', due_date: '2026-10-12', deadline: '17:00', hard: true };
  assert.equal((await call('POST', '/api/tasks', base)).status, 400);
  assert.equal((await call('POST', '/api/tasks', { ...base, first_step: '' })).status, 400);
  const ok = await call('POST', '/api/tasks', { ...base, first_step: 'Open the tax portal' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.hard, true);

  const { token } = (await call('POST', '/api/tokens', { label: 'iPhone' })).data;
  const v = await bare('POST', '/api/shortcut/add', { token, json: { text: 'pay the parking fine today 5pm', hard: true } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const task = (await call('GET', '/api/plan')).data.tasks.find((t) => t.id === v.data.task.id);
  assert.equal(task.hard, false);
  assert.equal(task.createdBy, 'siri');
});

// ---------- 11. Backlog triage ----------

test('11. backlog triage for overdue and stale normal tasks', async () => {
  await reset('2026-10-12T08:00');
  const mk = async (b) => (await call('POST', '/api/tasks', b)).data;
  const passport = await mk({ title: 'Renew passport', due_date: '2026-10-13' });
  const plumber = await mk({ title: 'Call plumber', due_date: '2026-10-13' });
  const landlord = await mk({ title: 'Email landlord', due_date: '2026-10-13' });
  const parcel = await mk({ title: 'Return parcel', due_date: '2026-10-13' });
  const garage = await mk({ title: 'Clean garage' });
  const rent = await mk({ title: 'Pay rent', due_date: '2026-10-13', deadline: '12:00', hard: true, first_step: 'Open the bank app' });
  const milk = await mk({ title: 'Buy milk', due_date: '2026-10-12' });
  let t = (await today()).data;
  assert.ok(t.tasks.some((k) => k.id === milk.id));
  assert.equal(t.triage.length, 0);

  setLocal('2026-10-15T08:00');
  await runOnce();
  t = (await today()).data;
  const triageIds = t.triage.map((k) => k.id);
  for (const k of [passport, plumber, landlord, parcel, milk]) {
    assert.ok(triageIds.includes(k.id), `overdue ${k.title} is in triage`);
    assert.ok(!t.tasks.some((x) => x.id === k.id), `overdue ${k.title} is not in tasks`);
  }
  assert.ok(!triageIds.includes(rent.id), 'hard tasks are never in triage');
  assert.ok(!triageIds.includes(garage.id), 'a 3-day-old undated task is not stale');

  setLocal('2026-10-18T07:00'); // 6 days old
  t = (await today()).data;
  assert.ok(!t.triage.some((k) => k.id === garage.id), 'a 6-day-old undated task is not stale yet');
  assert.ok(t.anytime.some((k) => k.id === garage.id));

  setLocal('2026-10-19T08:30'); // 7 days old
  await runOnce();
  t = (await today()).data;
  assert.ok(t.triage.some((k) => k.id === garage.id), 'undated task older than 7 days is in triage');
  assert.ok(!t.tasks.some((k) => k.id === garage.id));
  assert.ok(!t.anytime.some((k) => k.id === garage.id));

  const tri = (id, action) => call('POST', `/api/tasks/${id}/triage`, { action });
  assert.equal((await tri(rent.id, 'tomorrow')).status, 409, 'hard tasks cannot be triaged');
  assert.equal((await tri(passport.id, 'bogus')).status, 400);
  assert.equal((await tri(passport.id, 'today')).data.due, '2026-10-19');
  assert.equal((await tri(plumber.id, 'tomorrow')).data.due, '2026-10-20');
  assert.equal((await tri(landlord.id, 'week')).data.due, '2026-10-26');
  assert.equal((await tri(garage.id, 'someday')).data.due, null);
  assert.equal((await tri(parcel.id, 'drop')).status, 200);
  assert.equal((await tri(milk.id, 'drop')).status, 200);
  t = (await today()).data;
  assert.ok(t.tasks.some((k) => k.id === passport.id), 'today -> in the Today list');
  assert.equal(t.triage.length, 0, JSON.stringify(t.triage));
  assert.ok(t.anytime.some((k) => k.id === garage.id), 'someday -> back to undated and fresh');
  const plan = (await call('GET', '/api/plan')).data.tasks;
  assert.ok(!plan.some((k) => k.id === parcel.id), 'dropped');
  assert.equal(plan.find((k) => k.id === landlord.id).dueDate, '2026-10-26');
});

// ---------- 12. Capture ----------

test('12. capture parses day, time and estimate, and #tag links a goal', async () => {
  await reset('2026-10-12T08:00'); // Monday
  let r = await call('POST', '/api/capture', { text: 'call the bank friday 3pm ~20m' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.task.title, 'call the bank');
  assert.equal(r.data.task.due_date, '2026-10-16');
  assert.equal(r.data.task.deadline, '15:00');
  assert.equal(r.data.task.estimate_min, 20);
  assert.equal(typeof r.data.say, 'string');
  assert.match(r.data.say, /call the bank/);

  setLocal('2026-10-16T08:00'); // a Friday
  r = await call('POST', '/api/capture', { text: 'call the bank friday 3pm ~20m' });
  assert.equal(r.data.task.due_date, '2026-10-16', 'on a Friday, "friday" means today');
  assert.match(r.data.say, /today at 15:00/);

  const g = (await call('POST', '/api/goals', { title: 'Health and fitness' })).data;
  r = await call('POST', '/api/capture', { text: 'book physio tomorrow #health' });
  assert.equal(r.data.task.goal_id, g.id);
  assert.equal(r.data.goal.id, g.id);
  assert.equal(r.data.task.title, 'book physio');
  assert.equal(r.data.task.due_date, '2026-10-17');
  r = await call('POST', '/api/capture', { text: 'buy socks #nomatch' });
  assert.equal(r.data.task.goal_id, null);
  assert.match(r.data.task.title, /#nomatch/);
});

// ---------- 13. Siri tokens ----------

test('13. Siri tokens: add, done, next with a Bearer token; wrong token 401; revoke', async () => {
  await reset('2026-10-12T08:00');
  const water = await newHabit({ name: 'Drink water', deadline: '20:00' });
  const tk = await call('POST', '/api/tokens', { label: 'Shortcuts' });
  assert.equal(tk.status, 200);
  const { token } = tk.data;
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 20);
  assert.equal((await call('GET', '/api/tokens')).data.count, 1);

  const add = await bare('POST', '/api/shortcut/add', { token, json: { text: 'buy stamps tomorrow' } });
  assert.equal(add.status, 200);
  assert.match(add.data.say, /buy stamps/);
  assert.equal(add.data.task.due, '2026-10-13');

  const nxt = await bare('GET', '/api/shortcut/next', { token });
  assert.equal(nxt.status, 200);
  assert.match(nxt.data.say, /Drink water/);

  const done = await bare('POST', '/api/shortcut/done', { token, json: { text: 'drink water' } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.done.kind, 'habit');
  assert.equal(done.data.done.id, water.id);
  assert.equal(typeof done.data.say, 'string');
  assert.equal((await item(water.id)).status, 'kept');

  const bad = await bare('POST', '/api/shortcut/add', { token: 'oath_wrong', json: { text: 'x tomorrow' } });
  assert.equal(bad.status, 401);
  assert.equal(typeof bad.data.say, 'string');
  const none = await bare('GET', '/api/shortcut/next');
  assert.equal(none.status, 401);
  assert.equal(typeof none.data.say, 'string');
  assert.equal((await bare('GET', '/api/today', { token })).status, 401, 'tokens only open the shortcut endpoints');

  assert.equal((await call('DELETE', '/api/tokens')).status, 200);
  const revoked = await bare('GET', '/api/shortcut/next', { token });
  assert.equal(revoked.status, 401);
  assert.equal((await call('GET', '/api/tokens')).data.count, 0);
});

// ---------- 14. Goals ----------

test('14. goals: number progress labels flip at 50%; steps average tasks and habit strength', async () => {
  await reset('2026-10-12T08:00');
  const g = (await call('POST', '/api/goals', { title: 'Save money', measure: 'number', start_value: 10, target_value: 50 })).data;
  let r = await call('POST', `/api/goals/${g.id}/log`, { value: '+5' });
  assert.equal(r.data.value, 15);
  let goal = (await call('GET', `/api/goals/${g.id}`)).data.goal;
  assert.equal(goal.pct, 13);
  assert.equal(goal.label, '+5 since you started');
  r = await call('POST', `/api/goals/${g.id}/log`, { value: '30' });
  assert.equal(r.data.value, 30);
  goal = (await call('GET', `/api/goals/${g.id}`)).data.goal;
  assert.equal(goal.pct, 50);
  assert.match(goal.label, /to go$/);
  assert.equal(goal.label, '20 to go');

  const s = (await call('POST', '/api/goals', { title: 'Get fit' })).data;
  const h = await newHabit({ name: 'Run', deadline: '21:00', goal_id: s.id });
  await seedKept(h.id, 30);
  const t1 = (await call('POST', '/api/tasks', { title: 'Buy shoes', goal_id: s.id })).data;
  await call('POST', '/api/tasks', { title: 'Sign up for a 10k', goal_id: s.id });
  assert.equal((await call('POST', `/api/tasks/${t1.id}/done`, {})).status, 200);
  const strength = (await planHabit(h.id)).strength;
  goal = (await call('GET', `/api/goals/${s.id}`)).data.goal;
  assert.equal(goal.pct, Math.round(((1 + 0 + strength / 100) / 3) * 100), `strength ${strength}`);
  const listed = (await call('GET', '/api/goals')).data.goals.find((x) => x.id === s.id);
  assert.equal(listed.pct, goal.pct);
});

// ---------- 15. Mind map ----------

test('15. mind map: add, move, convert, toggle roll-up, delete lifts children', async () => {
  await reset('2026-10-12T08:00');
  const g = (await call('POST', '/api/goals', { title: 'Launch the shop' })).data;
  const add = async (text, parentId) => {
    const r = await call('POST', `/api/goals/${g.id}/nodes`, { text, parentId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.id;
  };
  const tree = async () => (await call('GET', `/api/goals/${g.id}`)).data.tree;
  const texts = (nodes) => nodes.map((n) => n.text);
  const move = (id, op) => call('POST', `/api/nodes/${id}/move`, { op });

  const A = await add('Plan');
  const B = await add('Build');
  const C = await add('Launch');
  const A1 = await add('Draft outline', A);
  const A2 = await add('Pick tools', A);
  let tr = await tree();
  assert.deepEqual(texts(tr), ['Plan', 'Build', 'Launch']);
  assert.deepEqual(texts(tr[0].children), ['Draft outline', 'Pick tools']);
  assert.equal(tr[0].children[0].depth, 1);

  assert.equal((await move(C, 'up')).status, 200);
  assert.deepEqual(texts(await tree()), ['Plan', 'Launch', 'Build']);
  assert.equal((await move(C, 'down')).status, 200);
  assert.deepEqual(texts(await tree()), ['Plan', 'Build', 'Launch']);
  assert.equal((await move(B, 'indent')).status, 200);
  tr = await tree();
  assert.deepEqual(texts(tr), ['Plan', 'Launch']);
  assert.deepEqual(texts(tr[0].children), ['Draft outline', 'Pick tools', 'Build']);
  assert.equal((await move(B, 'outdent')).status, 200);
  tr = await tree();
  assert.deepEqual(texts(tr), ['Plan', 'Build', 'Launch']);
  assert.equal((await move(A, 'indent')).status, 400, 'nothing above the first branch');
  assert.equal((await move(A, 'outdent')).status, 400, 'already top level');

  const ct = await call('POST', `/api/nodes/${A1}/convert`, { to: 'task' });
  assert.equal(ct.status, 200, JSON.stringify(ct.data));
  const ch = await call('POST', `/api/nodes/${A2}/convert`, { to: 'habit', options: { deadline: '21:00' } });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  assert.equal((await call('POST', `/api/nodes/${A1}/convert`, { to: 'task' })).status, 409);
  tr = await tree();
  assert.equal(tr[0].children[0].kind, 'task');
  assert.equal(tr[0].children[0].refId, ct.data.taskId);
  assert.equal(tr[0].children[1].kind, 'habit');
  assert.equal(tr[0].children[1].refId, ch.data.habitId);
  assert.equal(tr[0].pct, 0);
  assert.ok((await call('GET', '/api/plan')).data.habits.some((h) => h.id === ch.data.habitId && h.goalId === g.id));

  let tg = await call('POST', `/api/nodes/${A1}/toggle`, {});
  assert.equal(tg.data.done, true);
  tr = await tree();
  assert.equal(tr[0].children[0].pct, 100);
  assert.equal(tr[0].pct, 50, 'parent rolls up: (1 + 0) / 2');
  tg = await call('POST', `/api/nodes/${A1}/toggle`, {});
  assert.equal(tg.data.done, false);
  assert.equal((await tree())[0].pct, 0);
  await call('POST', `/api/nodes/${A1}/toggle`, {});
  assert.equal((await tree())[0].pct, 50);

  assert.equal((await call('DELETE', `/api/nodes/${A}`)).status, 200);
  tr = await tree();
  assert.ok(!texts(tr).includes('Plan'));
  for (const name of ['Draft outline', 'Pick tools', 'Build', 'Launch']) assert.ok(texts(tr).includes(name), `${name} at top level`);
  assert.ok(tr.every((n) => n.depth === 0));
});

// ---------- 16. Weekly review ----------

test('16. weekly review: focus required, drop archives, summaries, weekFocus next week', async () => {
  await reset('2026-10-12T08:00');
  const journal = await newHabit({ name: 'Journal', deadline: '21:00' });
  const cold = await newHabit({ name: 'Cold shower', deadline: '21:00' });
  for (let i = 0; i < 7; i += 1) {
    clock = DateTime.fromISO('2026-10-12T08:00', { zone: ZONE }).plus({ days: i });
    await runOnce();
    assert.equal((await keep(journal.id)).status, 200);
    assert.equal((await keep(cold.id)).status, 200);
  }
  setLocal('2026-10-19T08:00');
  await runOnce();
  const rv = (await call('GET', '/api/review')).data;
  assert.equal(rv.lastWeek.weekStart, '2026-10-12');
  assert.equal(rv.lastWeek.weekEnd, '2026-10-18');
  assert.equal(rv.thisWeek.weekStart, '2026-10-19');
  assert.equal(rv.lastWeek.judgedDays, 7);
  const jw = rv.lastWeek.habits.find((h) => h.id === journal.id);
  assert.equal(jw.done, 7);
  assert.equal(jw.target, 7);
  assert.ok(Array.isArray(rv.thisWeek.habits));
  assert.equal(rv.review.weekStart, '2026-10-12');

  assert.equal((await call('POST', '/api/review/finish', { focus: 'ab' })).status, 400);
  assert.equal((await call('POST', '/api/review/finish', {})).status, 400);
  const fin = await call('POST', '/api/review/finish', {
    focus: 'Finish the tax return', obstaclePlan: 'If I stall, I open the form first',
    decisions: { [journal.id]: 'keep', [cold.id]: 'drop' },
  });
  assert.equal(fin.status, 200);
  const plan = (await call('GET', '/api/plan')).data.habits;
  assert.ok(plan.find((h) => h.id === cold.id).archivedFrom, 'dropped habit is archived');
  assert.equal(plan.find((h) => h.id === journal.id).archivedFrom, null);
  assert.equal((await today()).data.weekFocus, 'Finish the tax return');

  setLocal('2026-10-21T08:00');
  const t = (await today()).data;
  assert.equal(t.weekFocus, 'Finish the tax return');
  assert.ok(!t.items.some((i) => i.id === cold.id), 'archived habit is gone');
  setLocal('2026-10-25T20:00');
  assert.equal((await today()).data.weekFocus, 'Finish the tax return');
  setLocal('2026-10-26T08:00');
  assert.equal((await today()).data.weekFocus, null, 'the focus belongs to one week');
});

// ---------- 17. Oath ----------

test('17. the oath needs a when-and-where intention', async () => {
  await reset('2026-10-12T08:00');
  const gym = await newHabit({ name: 'Gym', deadline: '19:00' });
  assert.equal((await call('POST', '/api/oath', { focusKind: 'habit', focusId: gym.id })).status, 400);
  assert.equal((await call('POST', '/api/oath', { focusKind: 'habit', focusId: gym.id, intention: 'ab' })).status, 400);
  assert.equal((await call('POST', '/api/oath', { focusKind: 'habit', focusId: gym.id, intention: '   ' })).status, 400);
  const ok = await call('POST', '/api/oath', { focusKind: 'habit', focusId: gym.id, intention: '7am at the gym' });
  assert.equal(ok.status, 200);
  assert.equal((await today()).data.plan.intention, '7am at the gym');
});

// ---------- 18. Export ----------

test('18. export has the data but no secrets', async () => {
  await reset('2026-10-12T08:00');
  const h = await newHabit({ name: 'Read', deadline: '21:00' });
  await keep(h.id);
  const g = (await call('POST', '/api/goals', { title: 'Write a book' })).data;
  await call('POST', `/api/goals/${g.id}/nodes`, { text: 'Outline' });
  await call('POST', '/api/tokens', { label: 'iPhone' });
  assert.equal((await call('GET', '/api/push/key')).status, 200); // makes sure VAPID keys exist
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://push.invalid/secret-endpoint', keys: { p256dh: 'p256-secret', auth: 'auth-secret' } })).status, 200);
  try {
    const r = await call('GET', '/api/export');
    assert.equal(r.status, 200);
    const x = r.data;
    for (const k of ['habits', 'completions', 'goals', 'nodes']) assert.ok(Array.isArray(x[k]), `export has ${k}`);
    assert.equal(x.habits.length, 1);
    assert.equal(x.completions.length, 1);
    assert.equal(x.goals.length, 1);
    assert.equal(x.nodes.length, 1);
    for (const k of ['owner', 'sessions', 'api_tokens', 'push_subs', 'password_hash']) assert.ok(!(k in x), `no ${k}`);
    const text = JSON.stringify(x);
    const sql = dbmod.db();
    const [{ password_hash: pw }] = await sql`select password_hash from owner`;
    assert.ok(!text.includes(pw), 'no password hash');
    assert.ok(!text.includes('scrypt$'));
    for (const s of await sql`select token_hash from sessions`) assert.ok(!text.includes(s.token_hash), 'no session hashes');
    for (const s of await sql`select token_hash from api_tokens`) assert.ok(!text.includes(s.token_hash), 'no api token hashes');
    assert.ok(!text.includes('secret-endpoint') && !text.includes('p256-secret') && !text.includes('auth-secret'), 'no push subscriptions');
    const vapid = await dbmod.getKV('vapid');
    assert.ok(!text.includes(vapid.privateKey), 'no VAPID private key');
  } finally {
    await dbmod.db()`delete from push_subs`;
  }
});
