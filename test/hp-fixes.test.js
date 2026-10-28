// Fixes to what HP is charged and promised: hard tasks saved or undone after their time, a missed hard
// task that can be dropped, rule changes that would make a habit due today, X-a-week habits after their
// log-by time, focus blocks left running overnight, the clean-day bonus promise, and streaks and
// strength judged by the record rather than today's rules. Against a real Postgres with a controllable clock.
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
let clock = DateTime.fromISO('2027-03-01T08:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-hpfix-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54473 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let runOnce; let cookie = ''; let dbmod; let engine;

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
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54473 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app, runOnce } = await import('../src/server.js'));
  engine = await import('../src/engine.js');
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

// ---------- Helpers ----------

// A clean slate for each scenario, with a new game at the given local time.
async function reset(iso) {
  setLocal(iso);
  await dbmod.db().unsafe(`truncate habits, completions, tasks, misses, days, events, reminders_sent, day_plans,
    focus_sessions, deferrals, reflections, goals, goal_logs, nodes, rest_days, api_tokens, weekly_reviews, briefs,
    coach_messages, push_subs restart identity cascade`);
  await dbmod.db()`delete from kv where key in ('game', 'settings')`;
  await runOnce();
  assert.equal((await today()).data.game.hp, 100);
}

const today = () => call('GET', '/api/today');
const hp = async () => (await today()).data.game.hp;
const item = async (id) => (await today()).data.items.find((i) => i.kind === 'habit' && i.id === id);
const taskOn = async (id) => (await today()).data.tasks.find((k) => k.id === id);
const planHabit = async (id) => (await call('GET', '/api/plan')).data.habits.find((h) => h.id === id);
const dayRow = async (date) => (await call('GET', '/api/review')).data.days.find((d) => d.date === date);
const keep = (id, body = {}) => call('POST', `/api/habits/${id}/keep`, body);
const newHabit = async (body) => {
  const r = await call('POST', '/api/habits', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.habit;
};
const setGame = (patch) => dbmod.db()`update kv set value = value || ${dbmod.db().json(patch)} where key = 'game'`;
const setSettings = (patch) => dbmod.db()`insert into kv (key, value) values ('settings', ${dbmod.db().json(patch)})
                                          on conflict (key) do update set value = kv.value || excluded.value`;

// A kept day for each date from `from` up to yesterday that falls on one of `days` (ISO weekdays).
async function seedKept(habitId, from, days) {
  const sql = dbmod.db();
  await sql`update habits set start_date = ${from} where id = ${habitId}`;
  for (let d = DateTime.fromISO(from, { zone: ZONE }); d.toISODate() < clock.toISODate(); d = d.plus({ days: 1 })) {
    if (days.includes(d.weekday)) await sql`insert into completions (habit_id, date, completed_at) values (${habitId}, ${d.toISODate()}, ${d.toUTC().toJSDate()})`;
  }
}

const PASSED = 'That time has already passed, Boss. Pick a later time or another day.';

// ---------- Hard tasks ----------

test('a hard task whose time has already passed is refused, on create and on edit', async () => {
  await reset('2027-03-01T16:00'); // Monday
  const base = { title: 'Send the invoice', hard: true, first_step: 'Open the invoice' };
  const late = await call('POST', '/api/tasks', { ...base, due_date: '2027-03-01', deadline: '15:00' });
  assert.equal(late.status, 400);
  assert.equal(late.data.error, PASSED);
  assert.equal((await call('POST', '/api/tasks', { ...base, due_date: '2027-03-01' })).status, 200, 'no time means 23:59, still ahead');

  const soft = (await call('POST', '/api/tasks', { title: 'Call the bank', due_date: '2027-03-01', deadline: '15:00' })).data;
  const harden = await call('PATCH', `/api/tasks/${soft.id}`, { hard: true, first_step: 'Find the number' });
  assert.equal(harden.status, 400, 'making it hard after its time');
  assert.equal(harden.data.error, PASSED);
  assert.equal((await call('PATCH', `/api/tasks/${soft.id}`, { title: 'Call the bank today' })).status, 200, 'other edits are fine');

  const ahead = (await call('POST', '/api/tasks', { ...base, title: 'Book the dentist', due_date: '2027-03-02', deadline: '09:00' })).data;
  assert.equal((await call('PATCH', `/api/tasks/${ahead.id}`, { due_date: '2027-03-01' })).status, 400, 'moved earlier onto a time already gone');
  assert.equal((await call('PATCH', `/api/tasks/${ahead.id}`, { due_date: '2027-03-01', deadline: '18:00' })).status, 200, 'earlier but still ahead is fine');

  await runOnce();
  assert.equal(await hp(), 100, 'nothing was charged');
  assert.equal((await dbmod.db()`select count(*)::int as n from misses`)[0].n, 0);
});

test('a hard task cannot be undone once its deadline has passed', async () => {
  await reset('2027-03-01T17:55');
  const t = (await call('POST', '/api/tasks', { title: 'Post the form', due_date: '2027-03-01', deadline: '18:00', hard: true, first_step: 'Find a stamp' })).data;
  setLocal('2027-03-01T17:58');
  assert.equal((await call('POST', `/api/tasks/${t.id}/done`, {})).status, 200);
  assert.equal((await taskOn(t.id)).canUndo, true, 'inside the window and before the deadline');

  setLocal('2027-03-01T18:01');
  assert.equal((await taskOn(t.id)).canUndo, false);
  const undo = await call('POST', `/api/tasks/${t.id}/undo`, {});
  assert.equal(undo.status, 409);
  assert.match(undo.data.error, /Locked/);
  await runOnce();
  assert.equal(await hp(), 100, 'nothing charged');
  assert.equal((await taskOn(t.id)).status, 'done');
});

test('a hard task whose miss has been charged can be dropped, with no HP back and nothing charged again', async () => {
  await reset('2027-03-02T08:00'); // Tuesday
  const mk = async (title, deadline) => (await call('POST', '/api/tasks', { title, due_date: '2027-03-02', deadline, hard: true, first_step: 'Open the file' })).data;
  const rent = await mk('Pay rent', '09:00');
  const fine = await mk('Pay the fine', '10:00');
  assert.equal((await taskOn(rent.id)).canDelete, false);
  assert.equal((await call('DELETE', `/api/tasks/${rent.id}`)).status, 409, 'not before the deadline');
  setLocal('2027-03-02T09:00:10');
  assert.equal((await call('DELETE', `/api/tasks/${rent.id}`)).status, 409, 'nor before the miss is charged');

  await runOnce();
  assert.equal(await hp(), 85);
  let k = await taskOn(rent.id);
  assert.equal(k.status, 'missed');
  assert.equal(k.missHpLost, 15);
  assert.equal(k.canDelete, true);
  assert.equal((await call('GET', '/api/plan')).data.tasks.find((x) => x.id === rent.id).canDelete, true);
  assert.equal((await call('DELETE', `/api/tasks/${rent.id}`)).status, 200);
  assert.equal(await taskOn(rent.id), undefined, 'gone from Today');
  await runOnce();
  assert.equal(await hp(), 85, 'no HP back, nothing charged again');

  // The daily cap cut the second miss: the row has what it really cost.
  await setSettings({ dailyLossCap: 20 });
  setLocal('2027-03-02T10:01');
  await runOnce();
  k = await taskOn(fine.id);
  assert.equal(k.penalty, 15);
  assert.equal(k.missHpLost, 5);
  assert.equal(await hp(), 80);
  assert.equal((await call('POST', `/api/tasks/${fine.id}/triage`, { action: 'tomorrow' })).status, 409, 'still cannot be moved');
  assert.equal((await call('POST', `/api/tasks/${fine.id}/triage`, { action: 'drop' })).status, 200, 'but can be dropped');

  setLocal('2027-03-03T08:00');
  await runOnce();
  assert.equal(await hp(), 80);
  assert.equal((await dbmod.db()`select count(*)::int as n from misses where kind = 'task'`)[0].n, 2);
});

// ---------- Rule changes ----------

test('adding today\'s weekday after its deadline waits until tomorrow', async () => {
  await reset('2027-03-03T08:00'); // Wednesday
  const stretch = await newHabit({ name: 'Stretch', deadline: '12:00', days: [1] });
  setLocal('2027-03-03T13:00');
  const r = await call('PATCH', `/api/habits/${stretch.id}`, { days: [1, 3] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.effective, '2027-03-04');
  await runOnce();
  assert.equal(await hp(), 100, 'no miss for a day it was not due');
  assert.ok(!(await today()).data.items.some((i) => i.id === stretch.id));

  // A change that leaves today alone still applies at once.
  const walk = await newHabit({ name: 'Walk', deadline: '20:00', days: [1] });
  assert.equal((await call('PATCH', `/api/habits/${walk.id}`, { days: [1, 5] })).data.effective, 'now');

  setLocal('2027-03-04T08:00');
  await runOnce();
  const p = await planHabit(stretch.id);
  assert.deepEqual(p.days, [1, 3]);
  assert.equal(p.nextRulesFrom, null);
  assert.equal(await hp(), 100);
});

// ---------- X-a-week habits ----------

test('an X-a-week habit closes at its log-by time: off the open list, Up next and the stakes', async () => {
  await reset('2027-03-01T08:00'); // Monday
  const swim = await newHabit({ name: 'Swim', weekly_target: 3, deadline: '21:00' });
  const read = await newHabit({ name: 'Read', weekly_target: 1, deadline: '21:00' });

  setLocal('2027-03-06T08:00'); // Saturday: Swim needs 3 with 2 days left
  await runOnce();
  let t = (await today()).data;
  assert.equal(t.items.find((i) => i.id === swim.id).mustToday, true);
  assert.equal(t.next.title, 'Swim');
  assert.equal(t.progress.open, 1);

  setLocal('2027-03-06T21:01');
  await runOnce();
  t = (await today()).data;
  const it = t.items.find((i) => i.id === swim.id);
  assert.equal(it.status, 'closed');
  assert.equal(it.closedToday, true);
  assert.equal(t.items.find((i) => i.id === read.id).status, 'closed');
  assert.equal(t.next, null, 'nothing in Up next that cannot be done');
  assert.equal(t.openDue.length, 0, 'the tab badge counts nothing open');
  assert.equal(t.progress.open, 0);
  assert.equal(t.progress.atStake, 0);
  assert.equal(t.progress.total, 1, 'the week that had to be logged today still counts against the day');
  assert.equal((await engine.openItemsToday('2027-03-06', ZONE)).length, 0, 'nor in the push badge');
  const k = await keep(swim.id);
  assert.equal(k.status, 409);
  assert.match(k.data.error, /Closed until tomorrow/);
  assert.equal(await hp(), 100);

  // Sunday: a week that will fall short means no clean-day bonus is promised.
  setLocal('2027-03-07T08:00');
  await runOnce();
  await setGame({ hp: 90 });
  t = (await today()).data;
  assert.equal(t.items.find((i) => i.id === swim.id).status, 'open');
  assert.equal(t.bonusDue, 0, 'Swim cannot reach 3 today');
  assert.equal((await keep(read.id)).status, 200);
  assert.equal((await keep(swim.id)).status, 200);

  setLocal('2027-03-08T00:01');
  const notes = await runOnce();
  const swimNote = notes.find((n) => n.title.includes('Swim'));
  assert.ok(swimNote, JSON.stringify(notes));
  assert.match(swimNote.body, /Meet next week's target for \+5 HP\./);
  const sun = await dayRow('2027-03-07');
  assert.equal(sun.bonus, 0, 'and midnight paid none');
  assert.equal(await hp(), 83, '90 minus ceil(10 x 2 / 3)');
});

// ---------- Focus blocks ----------

test('a focus block left running closes at its planned end and credits nothing the next day', async () => {
  await reset('2027-03-08T08:00'); // Monday
  const write = await newHabit({ name: 'Write', deadline: '23:00' });
  setLocal('2027-03-08T22:00');
  const a = await call('POST', '/api/focus', { kind: 'habit', id: write.id, minutes: 25 });
  assert.equal(a.status, 200, JSON.stringify(a.data));

  setLocal('2027-03-09T08:00');
  assert.equal((await today()).data.focus, null, 'yesterday\'s block is not today\'s');
  const fin = await call('POST', `/api/focus/${a.data.id}/finish`, { outcome: 'done' });
  assert.equal(fin.status, 409);
  assert.match(fin.data.error, /earlier day/);
  assert.equal((await item(write.id)).status, 'open', 'today\'s Write was not ticked off');
  const b = await call('POST', '/api/focus', { kind: 'habit', id: write.id, minutes: 30 });
  assert.equal(b.status, 200, 'an old block does not stand in the way of a new one');

  setLocal('2027-03-10T08:00');
  await runOnce();
  const rows = await dbmod.db()`select outcome, (extract(epoch from (ended_at - started_at))::int / 60) as min from focus_sessions order by id`;
  assert.deepEqual(rows.map((r) => [r.outcome, r.min]), [['expired', 25], ['expired', 30]]);
  assert.equal((await today()).data.focus, null);
  assert.equal((await call('GET', '/api/review')).data.thisWeek.focusMin, 55, 'the week counts the planned minutes, not the night');
});

// ---------- The clean-day bonus ----------

test('the clean-day bonus is only promised when midnight will pay it, at the amount it will pay', async () => {
  await reset('2027-03-15T08:00'); // Monday
  const read = await newHabit({ name: 'Read', deadline: '21:00', minimum: 'One page' });
  await call('POST', '/api/tasks', { title: 'Renew the permit', due_date: '2027-03-15', deadline: '09:00', hard: true, first_step: 'Open the form' });
  assert.equal((await today()).data.bonusDue, 0, 'at full HP there is no room for a bonus');
  setLocal('2027-03-15T09:01');
  await runOnce();
  assert.equal(await hp(), 85);
  assert.equal((await today()).data.bonusDue, 0, 'a miss today rules it out');
  let k = await keep(read.id);
  assert.equal(k.data.reaction.text, 'Everything due today is done, Boss.');

  setLocal('2027-03-16T08:00');
  await runOnce();
  assert.equal((await today()).data.bonusDue, 5);
  k = await keep(read.id);
  assert.equal(k.data.reaction.text, 'Clean sweep. Everything due today is done. Keep it clean to midnight for +5 HP.');

  setLocal('2027-03-17T08:00');
  await runOnce();
  assert.equal(await hp(), 90, 'midnight paid what was promised');
  await setGame({ hp: 98 });
  assert.equal((await today()).data.bonusDue, 2, 'capped at max HP');
  k = await keep(read.id);
  assert.match(k.data.reaction.text, /for \+2 HP\.$/);

  setLocal('2027-03-18T08:00');
  await runOnce();
  assert.equal(await hp(), 100);
  await setGame({ hp: 95 });
  assert.equal((await today()).data.bonusDue, 5);
  k = await keep(read.id, { minimum: true });
  assert.match(k.data.reaction.text, /Minimum kept/);
  assert.equal((await today()).data.bonusDue, 0, 'a minimum version voids it');

  setLocal('2027-03-19T08:00');
  await runOnce();
  assert.equal(await hp(), 95);
  const days = (await today()).data.recentDays;
  const on = (d) => days.find((x) => x.date === d);
  assert.deepEqual([on('2027-03-15').bonus, on('2027-03-16').bonus, on('2027-03-17').bonus, on('2027-03-18').bonus], [0, 5, 2, 0]);
  // The week tile can tell a kept but not clean day from one with nothing due.
  const min = on('2027-03-18');
  assert.deepEqual({ clean: min.clean, kept: min.kept, missed: min.missed, pardoned: min.pardoned, minimum: min.minimum }, { clean: false, kept: 1, missed: 0, pardoned: 0, minimum: 1 });
});

// ---------- Streaks and strength ----------

test('a habit\'s streak breaks on the day it is missed, not the day after', async () => {
  await reset('2027-03-22T08:00'); // Monday
  await setGame({ seasonStart: '2027-02-01' });
  const floss = await newHabit({ name: 'Floss', deadline: '20:00' });
  await seedKept(floss.id, '2027-03-17', [1, 2, 3, 4, 5, 6, 7]);
  assert.equal((await item(floss.id)).streak, 5, 'today is still open');
  setLocal('2027-03-22T20:01');
  await runOnce();
  const it = await item(floss.id);
  assert.equal(it.status, 'missed');
  assert.equal(it.streak, 0);
});

test('changing a habit\'s days keeps its streak and never counts old days as misses', async () => {
  await reset('2027-03-22T08:00'); // Monday
  await setGame({ seasonStart: '2027-02-01' });
  const gym = await newHabit({ name: 'Gym', deadline: '20:00', days: [1, 3, 5] });
  const swim = await newHabit({ name: 'Swim', deadline: '20:00', days: [1, 3, 5] });
  // Four weeks of Mondays, Wednesdays and Fridays, all kept.
  await seedKept(gym.id, '2027-02-22', [1, 3, 5]);
  await seedKept(swim.id, '2027-02-22', [1, 3, 5]);
  let p = await planHabit(gym.id);
  assert.equal(p.streak, 12);
  assert.equal(p.kept14, p.sched14);
  assert.equal((await keep(gym.id)).status, 200);
  assert.equal((await keep(swim.id)).status, 200);

  // Every day from now: the old Tuesdays, Thursdays and weekends were not due then.
  assert.equal((await call('PATCH', `/api/habits/${gym.id}`, { days: [1, 2, 3, 4, 5, 6, 7] })).data.effective, 'now');
  p = await planHabit(gym.id);
  assert.equal(p.streak, 13, 'the streak survives');
  assert.equal(p.kept14, p.sched14, 'no day is counted as a miss');
  assert.equal(p.strength, 50, '13 keeps in a row, at the new daily pace');

  // Mondays only: the kept Wednesdays and Fridays still count.
  assert.equal((await call('PATCH', `/api/habits/${swim.id}`, { days: [1] })).data.effective, 'now');
  assert.equal((await planHabit(swim.id)).streak, 13);

  // A real miss still breaks it.
  setLocal('2027-03-23T20:01');
  await runOnce();
  assert.equal((await item(gym.id)).status, 'missed');
  assert.equal((await planHabit(gym.id)).streak, 0);
});

test('after dropping a weekday, a kept day on it still sits between two misses', async () => {
  await reset('2027-03-01T08:00'); // Monday
  await setGame({ seasonStart: '2027-02-01' });
  const run = await newHabit({ name: 'Run', deadline: '20:00', days: [1, 3] });
  const row = await newHabit({ name: 'Row', deadline: '20:00', days: [1, 3] });
  const sql = dbmod.db();
  const miss = async (id, date) => (await sql`select repeat from misses where kind = 'habit' and ref_id = ${id} and date = ${date}`)[0];
  const comeback = async (id, date) => (await sql`select comeback from completions where habit_id = ${id} and date = ${date}`)[0]?.comeback;

  // Both missed on Monday, both kept on Wednesday (a comeback), then Wednesdays are dropped.
  setLocal('2027-03-01T20:01');
  await runOnce();
  assert.ok(await miss(run.id, '2027-03-01'));
  setLocal('2027-03-03T08:00');
  await runOnce();
  assert.equal((await keep(run.id)).status, 200);
  assert.equal((await keep(row.id)).status, 200);
  assert.equal(await comeback(row.id, '2027-03-03'), true);
  for (const h of [run, row]) assert.equal((await call('PATCH', `/api/habits/${h.id}`, { days: [1] })).data.effective, 'now');

  // Next Monday: keeping Row is no second comeback, and missing Run is not "twice in a row".
  setLocal('2027-03-08T08:00');
  await runOnce();
  assert.equal((await keep(row.id)).status, 200);
  assert.equal(await comeback(row.id, '2027-03-08'), false);
  setLocal('2027-03-08T20:01');
  await runOnce();
  assert.equal((await miss(run.id, '2027-03-08')).repeat, false);
});
