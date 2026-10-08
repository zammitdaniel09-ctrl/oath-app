// End-to-end tests of the Apple Health feed (Health Auto Export and the flat Shortcut format), day
// summaries, and habits that tick themselves off or overturn misses, against a real Postgres with
// a controllable clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { Hono } from 'hono';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-08T10:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-health-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54341,
  persistent: false, createPostgresUser: true, onLog: () => {}, onError: () => {},
});

let dbmod; let engine; let health; let time; let app; let sql;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54341/oath';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  sql = dbmod.db();
  await dbmod.migrate();
  health = await import('../src/health.js');
  await health.migrateHealth();
  await health.migrateHealth(); // safe to run on every boot
  engine = await import('../src/engine.js');
  app = new Hono();
  app.onError((err, c) => {
    if (err instanceof engine.RuleError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Server error' }, 500);
  });
  app.route('/api', health.healthApi);
  app.route('/api/shortcut', health.healthShortcut);
});

after(async () => {
  await dbmod.close();
  await pg.stop();
});

// ---------- Helpers ----------

async function reset(iso) {
  setLocal(iso);
  await sql.unsafe(`truncate habits, completions, tasks, misses, days, events, reminders_sent, rest_days,
    health_samples, health_workouts restart identity cascade`);
  await sql`delete from kv where key in ('game', 'settings', 'health_goals', 'health_last_sync')`;
  await engine.tick();
}
const tick = (iso) => { setLocal(iso); return engine.tick(); };
const newHabit = async (input) => (await engine.createHabit(input, { validTime: time.validTime })).habit;
const game = () => engine.getGame();
const hae = (metrics = [], workouts = []) => ({ data: { metrics, workouts } });
const summary = (days = 30) => health.healthSummary({ days });
const day = async (date) => (await summary(30)).days.find((d) => d.date === date);
const dashOrEmoji = /[\u2013\u2014\p{Extended_Pictographic}]/u;

// Ingest and check the copy a Shortcut would show or a push would carry.
async function ingest(payload) {
  const r = await health.ingestHealth(payload);
  assert.equal(typeof r.say, 'string');
  assert.ok(!dashOrEmoji.test(r.say), r.say);
  for (const n of r.notes) assert.ok(!dashOrEmoji.test(`${n.title} ${n.body}`), JSON.stringify(n));
  return r;
}

async function call(method, url, json) {
  const headers = json === undefined ? {} : { 'content-type': 'application/json' };
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const BOTH = 'Daniel’s iPhone|Daniel’s Apple Watch';

// ---------- 1. Health Auto Export metrics ----------

test('1. HAE hourly samples become local days across the time zone boundary; re-sends and a second feed never double count', async () => {
  await reset('2026-10-08T12:00');
  const payload = hae([
    {
      name: 'step_count', units: 'count', data: [
        { date: '2026-10-07 23:00:00 +0200', qty: 100, source: BOTH },
        { date: '2026-10-07 22:30:00 +0000', qty: 300, source: BOTH }, // 00:30 on 8 Oct in Malta, though the UTC date is the 7th
        { date: '2026-10-08 00:00:00 +0200', qty: 200, source: BOTH },
        { date: '2026-10-08 09:00:00 +0200', qty: 1000, source: 'Daniel’s iPhone' }, // same feed, joined by "|" above
        { date: '2026-10-08 10:00:00 +0200', qty: 1500, source: BOTH },
      ],
    },
    { name: 'active_energy', units: 'kJ', data: [{ date: '2026-10-08 09:00:00 +0200', qty: 418.4, source: BOTH }] },
    { name: 'resting_heart_rate', units: 'count/min', data: [{ date: '2026-10-08 00:00:00 +0200', qty: 58, source: BOTH }] },
    {
      name: 'heart_rate', units: 'count/min', data: [
        { date: '2026-10-08 09:00:00 +0200', Min: 60, Avg: 80, Max: 120, source: BOTH },
        { date: '2026-10-08 10:00:00 +0200', Min: 70, Avg: 100, Max: 150, source: BOTH },
      ],
    },
    { name: 'walking_speed', units: 'km/hr', data: [{ date: '2026-10-08 09:00:00 +0200', qty: 5.2, source: BOTH }] },
    { name: 'weight_body_mass', units: 'lb', data: [{ date: '2026-10-08 07:30:00 +0200', qty: 173, source: 'Scale' }] },
    { name: 'dietary_water', units: 'fl_oz_us', data: [{ date: '2026-10-08 08:00:00 +0200', qty: 16, source: 'WaterMinder' }] },
  ]);
  const r1 = await ingest(payload);
  assert.equal(r1.ok, true);
  assert.equal(r1.format, 'health-auto-export');
  assert.deepEqual(r1.dates, ['2026-10-07', '2026-10-08']);
  assert.equal(r1.say, 'Synced 2 days.');
  let d8 = await day('2026-10-08');
  assert.equal(d8.steps, 3000, '300 + 200 + 1000 + 1500');
  assert.equal((await day('2026-10-07')).steps, 100);
  assert.equal(d8.active_kcal, 100, 'kJ converted to kcal');
  assert.equal(d8.resting_hr, 58);
  assert.equal(d8.weight_kg, 78.5, 'lb converted to kg');
  assert.equal(d8.water_ml, 473, 'fl oz converted to mL');

  const count = async () => (await sql`select count(*)::int as n from health_samples`)[0].n;
  const before1 = await count();
  const r2 = await ingest(payload);
  assert.equal(r2.samples, r1.samples);
  assert.equal(await count(), before1, 're-sending upserts, it never adds rows');
  assert.equal((await day('2026-10-08')).steps, 3000, 're-sent payload does not double count');

  // The current hour grows between syncs: the new value replaces the old one.
  await ingest(hae([{ name: 'step_count', units: 'count', data: [{ date: '2026-10-08 10:00:00 +0200', qty: 2000, source: BOTH }] }]));
  assert.equal((await day('2026-10-08')).steps, 3500);

  // The Shortcut feed for the same day: the larger feed counts, they are never added together.
  const f = await ingest({ steps: '3,200' });
  assert.equal(f.format, 'shortcut');
  assert.equal((await day('2026-10-08')).steps, 3500);
  await ingest({ steps: 4100 });
  assert.equal((await day('2026-10-08')).steps, 4100);

  const s = await summary(7);
  assert.deepEqual(s.other.find((o) => o.key === 'walking_speed'), { key: 'walking_speed', label: 'Walking speed', unit: 'km/hr', value: 5.2, date: '2026-10-08' });
  assert.equal(s.other.find((o) => o.key === 'heart_rate').value, 90, 'heart rate averages the hourly Avg values');
  assert.ok(!s.other.some((o) => o.key === 'steps' || o.key.startsWith('sleep_')));
});

// ---------- 2. Sleep ----------

test('2. sleep counts toward the day you wake up, with stages, from summarised nights and from raw segments', async () => {
  await reset('2026-10-08T12:00');
  // A summarised night. Health Auto Export may date it by the evening it started; the wake-up time decides.
  const night = {
    date: '2026-10-07', totalSleep: 7.2, asleep: 0, core: 4.1, deep: 1.2, rem: 1.9, awake: 0.4, inBed: 7.8,
    sleepStart: '2026-10-07 23:40:00 +0200', sleepEnd: '2026-10-08 07:05:00 +0200',
    inBedStart: '2026-10-07 23:20:00 +0200', inBedEnd: '2026-10-08 07:10:00 +0200', source: 'Apple Watch',
  };
  const r = await ingest(hae([{ name: 'sleep_analysis', units: 'hr', data: [night] }]));
  assert.deepEqual(r.dates, ['2026-10-08']);
  let d = await day('2026-10-08');
  assert.equal(d.sleep_hours, 7.2);
  assert.deepEqual(d.sleep, { deep: 1.2, rem: 1.9, core: 4.1, awake: 0.4, in_bed: 7.8 });
  assert.equal((await day('2026-10-07')).sleep_hours, null);

  // The same night synced again, now complete: it replaces, never adds.
  await ingest(hae([{ name: 'sleep_analysis', units: 'hr', data: [{ ...night, totalSleep: 7.4, core: 4.3 }] }]));
  assert.equal((await day('2026-10-08')).sleep_hours, 7.4);

  // Raw segments (Summarize Data off) for the night before: the part before midnight still belongs to the 7th.
  const seg = (value, start, end, qty, source = 'Apple Watch') => ({ value, startDate: start, endDate: end, qty, source });
  const segments = [
    seg('Core', '2026-10-06 23:30:00 +0200', '2026-10-07 01:00:00 +0200', 1.5),
    seg('Deep', '2026-10-07 01:00:00 +0200', '2026-10-07 02:00:00 +0200', 1),
    seg('Awake', '2026-10-07 02:00:00 +0200', '2026-10-07 02:15:00 +0200', 0.25),
    seg('REM', '2026-10-07 02:15:00 +0200', '2026-10-07 03:45:00 +0200', 1.5),
    seg('Core', '2026-10-07 03:45:00 +0200', '2026-10-07 06:30:00 +0200', 2.75),
    seg('In Bed', '2026-10-06 23:00:00 +0200', '2026-10-07 06:45:00 +0200', 7.75, 'Daniel’s iPhone'),
  ];
  await ingest(hae([{ name: 'sleep_analysis', units: 'hr', data: segments }]));
  await ingest(hae([{ name: 'sleep_analysis', units: 'hr', data: segments }]));
  d = await day('2026-10-07');
  assert.equal(d.sleep_hours, 6.8, '1.5 + 1 + 1.5 + 2.75 asleep, awake and in bed not counted');
  assert.deepEqual(d.sleep, { deep: 1, rem: 1.5, core: 4.25, awake: 0.25, in_bed: 7.75 });
  assert.equal((await day('2026-10-06')).sleep_hours, null);

  // An evening nap that ends after 18:00 belongs to the next day.
  await ingest(hae([{ name: 'sleep_analysis', units: 'hr', data: [seg('Core', '2026-10-05 17:40:00 +0200', '2026-10-05 18:20:00 +0200', 0.67)] }]));
  assert.equal((await day('2026-10-06')).sleep_hours, 0.7);

  assert.equal((await health.todayHealth()).sleep_hours, 7.4, 'today shows last night');
});

// ---------- 3. Workouts ----------

test('3. workouts in the version 1 and version 2 shapes, with unit conversion and upsert by id', async () => {
  await reset('2026-10-08T12:00');
  const v2 = {
    id: 'A1B2-C3', name: 'Traditional Strength Training',
    start: '2026-10-08 07:00:00 +0200', end: '2026-10-08 07:50:00 +0200', duration: 2700,
    location: 'Indoor', isIndoor: true,
    activeEnergyBurned: { qty: 1255.2, units: 'kJ' }, totalEnergy: { qty: 380, units: 'kcal' },
    intensity: { qty: 5.1, units: 'kcal/hr·kg' },
    heartRate: { min: { qty: 80, units: 'bpm' }, avg: { qty: 121.6, units: 'bpm' }, max: { qty: 160, units: 'bpm' } },
    heartRateData: [{ date: '2026-10-08 07:01:00 +0200', Min: 80, Avg: 100, Max: 110, units: 'bpm', source: 'Apple Watch' }],
    route: [],
  };
  const v1 = {
    name: 'Running', start: '2026-10-07 18:00:00 +0200', end: '2026-10-07 18:31:00 +0200',
    activeEnergy: { qty: 350, units: 'kcal' }, distance: { qty: 3.1, units: 'mi' },
    avgHeartRate: { qty: 150, units: 'bpm' }, maxHeartRate: { qty: 172, units: 'bpm' },
    heartRateData: [{ date: '2026-10-07 18:01:00 +0200', qty: 140, units: 'count/min' }],
  };
  const r = await ingest(hae([], [v2, v1]));
  assert.equal(r.workouts, 2);
  assert.deepEqual(r.dates, ['2026-10-07', '2026-10-08']);
  await ingest(hae([], [v2, v1]));
  assert.equal((await sql`select count(*)::int as n from health_workouts`)[0].n, 2, 'upserted by id, or by type and start without one');

  let s = await summary(7);
  assert.deepEqual(s.workouts.map((w) => w.type), ['Traditional Strength Training', 'Running'], 'newest first');
  const st = s.workouts[0];
  assert.equal(st.id, 'A1B2-C3');
  assert.equal(st.date, '2026-10-08');
  assert.equal(st.duration_min, 45, 'duration in seconds, pauses respected');
  assert.equal(st.kcal, 300, 'kJ to kcal');
  assert.equal(st.avg_hr, 122);
  assert.equal(st.start, '2026-10-08T05:00:00.000Z');
  const run = s.workouts[1];
  assert.match(run.id, /^hae_/);
  assert.equal(run.duration_min, 31, 'no duration: from start and end');
  assert.equal(run.kcal, 350);
  assert.equal(run.distance_km, 4.99, 'miles to km');
  assert.equal(run.avg_hr, 150);
  const [raw] = await sql`select * from health_workouts where id = 'A1B2-C3'`;
  assert.equal(raw.max_hr, 160);
  assert.deepEqual(raw.extra, { location: 'Indoor', indoor: true, intensity_met: 5.1, total_kcal: 380 });

  // An old export with duration in minutes and energy as a time series.
  await ingest(hae([], [{
    name: 'Walking', start: '2026-10-06 10:00:00 +0200', end: '2026-10-06 10:40:00 +0200', duration: 40,
    activeEnergy: [{ date: '2026-10-06 10:00:00 +0200', qty: 50, units: 'kcal' }, { date: '2026-10-06 10:20:00 +0200', qty: 60, units: 'kcal' }],
  }]));
  s = await summary(7);
  const walk = s.workouts.find((w) => w.type === 'Walking');
  assert.equal(walk.duration_min, 40);
  assert.equal(walk.kcal, 110);

  // The same session from the Shortcut as well shows once.
  await ingest({ workouts: [{ type: 'Strength Training', start: '2026-10-08T07:00:00+02:00', duration_min: 45, kcal: 290 }] });
  const t = await health.todayHealth();
  assert.deepEqual(t.workouts, [{ type: 'Traditional Strength Training', duration_min: 45 }]);
});

// ---------- 4. Flat Shortcut format ----------

test('4. the flat Shortcut format takes strings with units, thousands separators and decimal commas', async () => {
  await reset('2026-10-08T12:00');
  const r = await ingest({
    date: '2026-10-07', steps: '8,123', active_kcal: '450 kcal', exercise_min: '32 min', stand_hours: '9', sleep_hours: '7,2',
    distance_km: '6.1 km', resting_hr: '58 bpm', hrv_ms: '45', weight_kg: '78,4', mindful_min: 10, flights: '5 floors', water_ml: '1.5 L',
    deep_hours: '1,1', rem_hours: '1.6',
    workouts: [{ type: 'Strength Training', start: '2026-10-07T18:00:00+02:00', duration_min: '45', kcal: '300' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.dates, ['2026-10-07']);
  assert.equal(r.workouts, 1);
  assert.equal(r.say, 'Synced 1 day.');
  let d = await day('2026-10-07');
  assert.equal(d.steps, 8123);
  assert.equal(d.active_kcal, 450);
  assert.equal(d.exercise_min, 32);
  assert.equal(d.stand_hours, 9);
  assert.equal(d.sleep_hours, 7.2);
  assert.deepEqual(d.sleep, { deep: 1.1, rem: 1.6, core: null, awake: null, in_bed: null });
  assert.equal(d.distance_km, 6.1);
  assert.equal(d.resting_hr, 58);
  assert.equal(d.hrv_ms, 45);
  assert.equal(d.weight_kg, 78.4);
  assert.equal(d.mindful_min, 10);
  assert.equal(d.flights, 5);
  assert.equal(d.water_ml, 1500);
  const [w] = (await summary(7)).workouts;
  assert.deepEqual([w.type, w.duration_min, w.kcal, w.date], ['Strength Training', 45, 300, '2026-10-07']);

  // Several days at once, other spellings, and a list of numbers (one per line) that gets added up.
  await ingest({
    days: [
      { date: '2026-10-06', steps: '12.345', sleep_hours: '7 hr 30 min', distance_km: '3.1 mi', active_kcal: '1,046 kJ' },
      { date: 'yesterday', exercise_min: '1 hr' },
      { date: '05/10/2026', steps: '1200\n800\n500', Sleep: '450 min' },
      { date: '4 Oct 2026 at 21:30', Weight: '173 lb' },
    ],
  });
  d = await day('2026-10-06');
  assert.equal(d.steps, 12345, '"12.345" steps is twelve thousand');
  assert.equal(d.sleep_hours, 7.5);
  assert.equal(d.distance_km, 4.99);
  assert.equal(d.active_kcal, 250);
  assert.equal((await day('2026-10-07')).exercise_min, 60, 're-sending a day replaces its value');
  assert.equal((await day('2026-10-05')).steps, 2500);
  assert.equal((await day('2026-10-05')).sleep_hours, 7.5);
  assert.equal((await day('2026-10-04')).weight_kg, 78.5);

  // A summed duration that arrives as a bare number of minutes or seconds.
  await ingest({ days: [{ date: '2026-10-03', sleep_hours: 27000, exercise_min: '1920' }, { date: '2026-10-02', sleep_hours: 450 }] });
  assert.equal((await day('2026-10-03')).sleep_hours, 7.5, 'seconds');
  assert.equal((await day('2026-10-03')).exercise_min, 32, 'seconds');
  assert.equal((await day('2026-10-02')).sleep_hours, 7.5, 'minutes');

  // A free Shortcut sending "today so far" every hour keeps one value per day.
  await ingest({ steps: 1000 });
  await ingest({ steps: 2500 });
  assert.equal((await day('2026-10-08')).steps, 2500);

  await assert.rejects(health.ingestHealth({ date: '2026-13-01', steps: 5 }), /The date must look like 2026-10-08/);
  await assert.rejects(health.ingestHealth({ date: '2026-10-09', steps: 5 }), /future/);
  await assert.rejects(health.ingestHealth({ hello: 'world' }), /No health values found/);
  await assert.rejects(health.ingestHealth('not json'), /Send JSON/);

  // Through the Shortcut route: errors carry "say" too.
  const bad = await call('POST', '/api/shortcut/health', { hello: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.say, 'No health values found. Send fields like steps, exercise_min or sleep_hours.');
  const ok = await call('POST', '/api/shortcut/health', { steps: 100, exercise_min: 3 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.say, 'Synced 1 day.');
});

// ---------- 5. Auto-kept today ----------

test('5. a linked habit ticks itself off today before the deadline, with source health and the comeback bonus', async () => {
  await reset('2026-10-07T10:00'); // Wednesday
  const walk = await newHabit({ name: 'Walk', deadline: '21:00' });
  const gym = await newHabit({ name: 'Gym', deadline: '20:00' });
  await health.setHabitAuto(walk.id, { metric: 'steps', target: '8,000' });
  await health.setHabitAuto(gym.id, { metric: 'workout', target: 30, filter: 'strength' });
  await tick('2026-10-07T21:01'); // both missed, no data that day
  assert.equal((await game()).hp, 80);
  await tick('2026-10-08T10:00');

  let r = await ingest({ steps: 5000 });
  assert.equal(r.autoKept.length, 0, 'under the target');
  r = await ingest({ steps: '9,000' });
  assert.deepEqual(r.autoKept.map((k) => [k.name, k.date, k.comeback]), [['Walk', '2026-10-08', 5]]);
  assert.equal(r.say, 'Synced 1 day. Walk ticked off from Apple Health.');
  assert.deepEqual(r.notes.map((n) => [n.title, n.body]), [['Kept from Apple Health: Walk', '9,000 steps. Ticked off for you, and +5 HP for coming back.']]);
  const [c] = await sql`select * from completions where habit_id = ${walk.id} and date = '2026-10-08'`;
  assert.equal(c.source, 'health');
  assert.equal(c.note, 'Apple Health: 9,000 steps');
  assert.equal(c.comeback, true);
  assert.equal((await game()).hp, 85);

  r = await ingest(hae([], [{ id: 'run-1', name: 'Outdoor Run', start: '2026-10-08 08:00:00 +0200', end: '2026-10-08 08:40:00 +0200', duration: 2400 }]));
  assert.equal(r.autoKept.length, 0, 'a run does not match "strength"');
  r = await ingest(hae([], [{ id: 'gym-1', name: 'Functional Strength Training', start: '2026-10-08 09:00:00 +0200', end: '2026-10-08 09:20:00 +0200', duration: 1200 }]));
  assert.equal(r.autoKept.length, 0, '20 minutes is under the 30 minute target');
  // Through the Shortcut route, so the push path runs too (no devices: nothing is sent, nothing breaks).
  const res = await call('POST', '/api/shortcut/health', hae([], [{ id: 'gym-2', name: 'Traditional Strength Training', start: '2026-10-08 09:30:00 +0200', end: '2026-10-08 09:45:00 +0200', duration: 900 }]));
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.autoKept.map((k) => k.name), ['Gym'], 'two strength sessions add up to 35 minutes');
  assert.equal(res.data.autoKept[0].label, 'Functional Strength Training and Traditional Strength Training, 35 min');
  assert.equal(res.data.say, 'Synced 1 day. Gym ticked off from Apple Health.');
  assert.equal((await game()).hp, 90);

  // Data going down never removes a completion.
  await ingest({ steps: 10 });
  assert.equal((await sql`select count(*)::int as n from completions where habit_id = ${walk.id}`)[0].n, 1);
  const s = await summary(1);
  assert.deepEqual(s.autoHabits.map((h) => [h.name, h.metric, h.target, h.filter, h.todayValue, h.met]), [
    ['Walk', 'steps', 8000, '', 10, false],
    ['Gym', 'workout', 30, 'strength', 35, true],
  ]);
});

// ---------- 6. Overturned miss ----------

test('6. Apple Health overturns a miss: HP back, miss marked, days row fixed, pardons untouched', async () => {
  await reset('2026-10-07T08:00'); // Wednesday
  const gym = await newHabit({ name: 'Gym', deadline: '19:00', non_negotiable: true });
  assert.equal(gym.penalty, 25);
  await health.setHabitAuto(gym.id, { metric: 'workout', target: 30, filter: 'strength' });
  await tick('2026-10-07T19:01');
  assert.equal((await game()).hp, 75);
  await tick('2026-10-08T08:00');
  let [row] = await sql`select * from days where date = '2026-10-07'`;
  assert.deepEqual([row.missed, row.kept], [1, 0]);
  const pardonsBefore = (await game()).pardonsLeft;

  // The phone was locked all evening; the workout arrives the next morning.
  const payload = hae([], [{ id: 'w-7', name: 'Traditional Strength Training', start: '2026-10-07 18:00:00 +0200', end: '2026-10-07 18:45:00 +0200', duration: 2700 }]);
  const r = await ingest(payload);
  assert.deepEqual(r.overturned.map((o) => [o.name, o.date, o.hpLost, o.hpBack]), [['Gym', '2026-10-07', 25, 25]]);
  assert.equal(r.say, 'Synced 1 day. Apple Health overturned the miss on Gym: +25 HP.');
  const g = await game();
  assert.equal(g.hp, 100);
  assert.equal(g.pardonsLeft, pardonsBefore, 'an overturn never uses a pardon');
  const [m] = await sql`select * from misses where kind = 'habit' and ref_id = ${gym.id} and date = '2026-10-07'`;
  assert.equal(m.overturned, true);
  assert.ok(m.pardoned_at);
  assert.equal(m.pardon_reason, 'Apple Health shows it was done: Traditional Strength Training, 45 min');
  [row] = await sql`select * from days where date = '2026-10-07'`;
  assert.deepEqual([row.missed, row.kept], [0, 1]);
  const [c] = await sql`select * from completions where habit_id = ${gym.id} and date = '2026-10-07'`;
  assert.equal(c.source, 'health');
  assert.deepEqual(r.notes.map((n) => [n.title, n.body, n.tag]), [
    ['Apple Health overturned a miss', 'Gym on Wed 7 Oct was done after all. +25 HP back.', `health-overturn-${gym.id}-2026-10-07`],
  ]);
  const [ev] = await sql`select data from events where type = 'miss_overturned'`;
  assert.equal(ev.data.hpBack, 25);

  // Syncing the same workout again changes nothing.
  const again = await ingest(payload);
  assert.equal(again.overturned.length, 0);
  assert.equal(again.autoKept.length, 0);
  assert.equal((await game()).hp, 100);

  // The overturned miss is not a "miss twice in a row": today's miss costs the normal penalty.
  await tick('2026-10-08T19:01');
  const [m8] = await sql`select * from misses where kind = 'habit' and ref_id = ${gym.id} and date = '2026-10-08'`;
  assert.deepEqual([m8.hp_lost, m8.repeat], [25, false]);
});

// ---------- 7. No refund after a death ----------

test('7. an overturn after the season ended gives no HP back', async () => {
  await reset('2026-10-07T08:00');
  const walk = await newHabit({ name: 'Walk', deadline: '10:00', penalty: 100 });
  await newHabit({ name: 'Read', deadline: '11:00' });
  await health.setHabitAuto(walk.id, { metric: 'steps', target: 5000 });
  const notes = await tick('2026-10-07T10:01');
  assert.ok(notes.some((n) => n.tag === 'death'), JSON.stringify(notes));
  assert.equal((await game()).deaths, 1);
  await tick('2026-10-07T11:01'); // Read missed in the new season
  assert.equal((await game()).hp, 90);

  const r = await ingest(hae([{
    name: 'step_count', units: 'count', data: [
      { date: '2026-10-07 08:00:00 +0200', qty: 3500, source: 'iPhone' },
      { date: '2026-10-07 09:00:00 +0200', qty: 2500, source: 'iPhone' },
    ],
  }]));
  assert.deepEqual(r.overturned.map((o) => [o.name, o.hpBack]), [['Walk', 0]]);
  assert.equal((await game()).hp, 90, 'nothing is refunded across a death');
  const [m] = await sql`select * from misses where kind = 'habit' and ref_id = ${walk.id}`;
  assert.equal(m.overturned, true);
  assert.equal(r.notes[0].body, 'Walk on Wed 7 Oct was done after all. Your season has ended since, so no HP comes back.');
  assert.equal(r.say, 'Synced 1 day. Apple Health overturned the miss on Walk.');
});

// ---------- 8. Deadline proof ----------

test('8. only data from before the deadline can overturn a miss', async () => {
  await reset('2026-10-07T08:00');
  const gym = await newHabit({ name: 'Gym', deadline: '19:00', non_negotiable: true });
  const walk = await newHabit({ name: 'Walk', deadline: '20:00' });
  await health.setHabitAuto(gym.id, { metric: 'workout', target: 30, filter: 'strength' });
  await health.setHabitAuto(walk.id, { metric: 'steps', target: 8000 });
  await tick('2026-10-07T20:01');
  assert.equal((await game()).hp, 65);

  let r = await ingest(hae([], [{ id: 'late', name: 'Traditional Strength Training', start: '2026-10-07 19:30:00 +0200', end: '2026-10-07 20:30:00 +0200', duration: 3600 }]));
  assert.equal(r.overturned.length, 0, 'a workout that started after the deadline does not count');
  assert.equal((await sql`select count(*)::int as n from completions`)[0].n, 0);

  r = await ingest(hae([{
    name: 'step_count', units: 'count', data: [
      { date: '2026-10-07 12:00:00 +0200', qty: 7000, source: 'iPhone' },
      { date: '2026-10-07 20:00:00 +0200', qty: 3000, source: 'iPhone' },
    ],
  }]));
  assert.equal(r.overturned.length, 0, 'steps after 20:00 do not count for a 20:00 deadline');
  r = await ingest({ date: '2026-10-07', steps: 12000 });
  assert.equal(r.overturned.length, 0, 'a whole-day total reported after the deadline proves nothing about the time');
  assert.equal((await day('2026-10-07')).steps, 12000, 'the day itself still shows the full total');
  assert.equal((await game()).hp, 65);

  // Next morning a late upload fills in an earlier hour: now it is proven.
  await tick('2026-10-08T07:00');
  r = await ingest(hae([{ name: 'step_count', units: 'count', data: [{ date: '2026-10-07 13:00:00 +0200', qty: 1500, source: 'iPhone' }] }]));
  assert.deepEqual(r.overturned.map((o) => [o.name, o.hpBack]), [['Walk', 10]]);
  assert.equal(r.autoKept[0].label, '8,500 steps');
  assert.equal((await game()).hp, 75);
  assert.equal((await sql`select count(*)::int as n from completions where habit_id = ${gym.id}`)[0].n, 0, 'Gym stays missed');
});

// ---------- 9. X a week ----------

test('9. X-a-week habits count Apple Health days, but never reopen a settled week', async () => {
  await reset('2026-10-12T08:00'); // Monday
  const swim = await newHabit({ name: 'Swim', weekly_target: 3 });
  await health.setHabitAuto(swim.id, { metric: 'workout', filter: 'swim' });
  const sw = (id, start, minutes) => {
    const s = DateTime.fromFormat(start, 'yyyy-MM-dd HH:mm:ss ZZZ', { setZone: true });
    return { id, name: 'Pool Swim', start, end: s.plus({ minutes }).toFormat('yyyy-MM-dd HH:mm:ss ZZZ'), duration: minutes * 60 };
  };
  let r = await ingest(hae([], [sw('s1', '2026-10-12 07:00:00 +0200', 30)]));
  assert.deepEqual(r.autoKept.map((k) => k.date), ['2026-10-12']);

  await tick('2026-10-14T08:00'); // Wednesday: Monday and Tuesday are judged
  r = await ingest(hae([], [sw('s2', '2026-10-13 18:00:00 +0200', 40)]));
  assert.deepEqual(r.autoKept.map((k) => k.date), ['2026-10-13'], "Tuesday's swim synced late still counts for this week");
  assert.equal(r.notes[0].body, 'Pool Swim, 40 min on Tue 13 Oct. Counted as kept.');
  const [d13] = await sql`select * from days where date = '2026-10-13'`;
  assert.equal(d13.kept, 1, 'the judged day now shows it');

  await tick('2026-10-19T00:30'); // Monday: last week is settled at 2 of 3
  const [weekMiss] = await sql`select * from misses where kind = 'habit' and ref_id = ${swim.id}`;
  assert.equal(weekMiss.date, '2026-10-18');
  r = await ingest(hae([], [sw('s3', '2026-10-18 10:00:00 +0200', 30)]));
  assert.equal(r.autoKept.length, 0, 'a settled week is not reopened');
  assert.equal(r.overturned.length, 0);
  assert.equal((await sql`select count(*)::int as n from completions where habit_id = ${swim.id}`)[0].n, 2);
});

// ---------- 10. Linking a habit ----------

test('10. setHabitAuto validates its input, and linking ticks off a habit already done today', async () => {
  await reset('2026-10-08T10:00');
  const h = await newHabit({ name: 'Meditate', deadline: '21:00' });
  const isRule = (status, re) => (e) => e instanceof engine.RuleError && e.status === status && re.test(e.message);
  await assert.rejects(health.setHabitAuto(h.id, { metric: 'pushups', target: 10 }), isRule(400, /one of: steps, exercise_min/));
  await assert.rejects(health.setHabitAuto(h.id, { metric: 'steps' }), isRule(400, /Set a target, for example 10000/));
  await assert.rejects(health.setHabitAuto(h.id, { metric: 'steps', target: -5 }), isRule(400, /above 0/));
  await assert.rejects(health.setHabitAuto(h.id, { metric: 'steps', target: 'lots' }), isRule(400, /above 0/));
  await assert.rejects(health.setHabitAuto(h.id, { metric: 'sleep_hours', target: 30 }), isRule(400, /at most 16/));
  await assert.rejects(health.setHabitAuto(9999, { metric: 'steps', target: 10 }), isRule(404, /does not exist/));
  let r = await health.setHabitAuto(h.id, { metric: 'workout', filter: '  Yoga ' });
  assert.deepEqual(r.habit, { id: h.id, autoMetric: 'workout', autoTarget: 1, autoFilter: 'Yoga' });
  r = await health.setHabitAuto(h.id, { metric: 'Mindful_Min', target: '10 min', filter: 'ignored' });
  assert.deepEqual(r.habit, { id: h.id, autoMetric: 'mindful_min', autoTarget: 10, autoFilter: '' });
  assert.equal(r.keptNow, false);

  const bad = await call('PATCH', `/api/health/habits/${h.id}`, { metric: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /one of/);
  assert.equal((await call('PATCH', '/api/health/habits/12345', { metric: 'steps', target: 1 })).status, 404);
  const off = await call('PATCH', `/api/health/habits/${h.id}`, { metric: null });
  assert.equal(off.status, 200);
  assert.equal(off.data.habit.autoMetric, null);
  const [row] = await sql`select auto_metric, auto_target, auto_filter from habits where id = ${h.id}`;
  assert.deepEqual({ ...row }, { auto_metric: null, auto_target: null, auto_filter: '' });

  await ingest({ mindful_min: 12 });
  assert.equal((await sql`select count(*)::int as n from completions`)[0].n, 0, 'not linked: nothing ticked');
  const on = await call('PATCH', `/api/health/habits/${h.id}`, { metric: 'mindful_min', target: 10 });
  assert.equal(on.status, 200);
  assert.equal(on.data.keptNow, true);
  const [c] = await sql`select source, note from completions where habit_id = ${h.id}`;
  assert.deepEqual({ ...c }, { source: 'health', note: 'Apple Health: 12 mindful minutes' });
});

// ---------- 11. Read side ----------

test('11. healthSummary, todayHealth, goals and the coach lines', async () => {
  await reset('2026-10-08T10:00');
  assert.equal(await health.healthForCoach(), '');
  let s = await summary(30);
  assert.equal(s.today, '2026-10-08');
  assert.equal(s.connected, false);
  assert.equal(s.lastSync, null);
  assert.equal(s.days.length, 30);
  assert.equal(s.days[0].date, '2026-09-09');
  assert.equal(s.days[29].date, '2026-10-08');
  assert.ok(s.days.every((d) => d.steps === null && d.sleep === null));
  assert.deepEqual(s.goals, { steps: 10000, exercise_min: 30, active_kcal: 500, stand_hours: 12, sleep_hours: 7.5 });
  assert.deepEqual(s.latest, { weight_kg: null, vo2max: null, body_fat_pct: null, resting_hr: null, hrv_ms: null });
  assert.deepEqual([s.workouts, s.autoHabits, s.other], [[], [], []]);

  await ingest({ date: '2026-10-06', weight_kg: 79.1, steps: 6000, resting_hr: 60 });
  await ingest({ date: '2026-10-07', weight_kg: 78.6, steps: 9000, sleep_hours: 6.6, hrv_ms: 40 });
  await ingest(hae([
    { name: 'vo2max', units: 'ml/(kg·min)', data: [{ date: '2026-10-05 00:00:00 +0200', qty: 44.2, source: 'Apple Watch' }] },
    { name: 'body_fat_percentage', units: '%', data: [{ date: '2026-10-07 07:00:00 +0200', qty: 0.182, source: 'Scale' }] },
    { name: 'blood_oxygen_saturation', units: '%', data: [{ date: '2026-10-08 03:00:00 +0200', qty: 0.97, source: 'Apple Watch' }] },
  ]));
  await ingest({ steps: 4210, exercise_min: 12, active_kcal: 230, stand_hours: 6, sleep_hours: 7.2 });
  await ingest(hae([], [{ id: 'm1', name: 'Traditional Strength Training', start: '2026-10-06 18:00:00 +0200', end: '2026-10-06 18:45:00 +0200', duration: 2700 }]));

  s = await summary(30);
  assert.equal(s.connected, true);
  assert.equal(s.lastSync, '2026-10-08T08:00:00.000Z');
  assert.deepEqual(Object.keys(s.days[0]), ['date', 'steps', 'active_kcal', 'exercise_min', 'stand_hours', 'sleep_hours', 'sleep',
    'distance_km', 'flights', 'resting_hr', 'hrv_ms', 'weight_kg', 'mindful_min', 'kcal_in', 'water_ml']);
  assert.deepEqual(s.days[29], {
    date: '2026-10-08', steps: 4210, active_kcal: 230, exercise_min: 12, stand_hours: 6, sleep_hours: 7.2, sleep: null,
    distance_km: null, flights: null, resting_hr: null, hrv_ms: null, weight_kg: null, mindful_min: null, kcal_in: null, water_ml: null,
  });
  assert.deepEqual(s.latest, {
    weight_kg: { value: 78.6, date: '2026-10-07' },
    vo2max: { value: 44.2, date: '2026-10-05' },
    body_fat_pct: { value: 18.2, date: '2026-10-07' },
    resting_hr: { value: 60, date: '2026-10-06' },
    hrv_ms: { value: 40, date: '2026-10-07' },
  });
  assert.deepEqual(s.other, [{ key: 'spo2', label: 'Blood oxygen', unit: '%', value: 97, date: '2026-10-08' }]);
  assert.deepEqual(s.workouts, [{
    id: 'm1', type: 'Traditional Strength Training', date: '2026-10-06', start: '2026-10-06T16:00:00.000Z', end: '2026-10-06T16:45:00.000Z',
    duration_min: 45, kcal: null, distance_km: null, avg_hr: null,
  }]);

  const g = await call('PUT', '/api/health/goals', { steps: '12,000', sleep_hours: 8 });
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.goals, { steps: 12000, exercise_min: 30, active_kcal: 500, stand_hours: 12, sleep_hours: 8 });
  assert.equal((await call('PUT', '/api/health/goals', { steps: -1 })).status, 400);
  assert.equal((await call('PUT', '/api/health/goals', { floss: 2 })).status, 400);
  assert.equal((await call('PUT', '/api/health/goals', { sleep_hours: 'zero' })).status, 400);
  const got = await call('GET', '/api/health?days=7');
  assert.equal(got.status, 200);
  assert.equal(got.data.days.length, 7);
  assert.equal(got.data.goals.steps, 12000);

  assert.deepEqual(await health.todayHealth(), {
    date: '2026-10-08', connected: true, lastSync: '2026-10-08T08:00:00.000Z',
    steps: 4210, exercise_min: 12, active_kcal: 230, stand_hours: 6, sleep_hours: 7.2, workouts: [],
    goals: { steps: 12000, exercise_min: 30, active_kcal: 500, stand_hours: 12, sleep_hours: 8 },
  });

  const walk = await newHabit({ name: 'Walk', deadline: '21:00' });
  await health.setHabitAuto(walk.id, { metric: 'steps', target: 10000 });
  s = await summary(7);
  assert.deepEqual(s.autoHabits, [{ habitId: walk.id, name: 'Walk', metric: 'steps', target: 10000, filter: '', todayValue: 4210, met: false }]);

  const coach = await health.healthForCoach();
  const lines = coach.split('\n');
  assert.equal(lines[0], 'Apple Health (last sync Thu 8 Oct 10:00):');
  assert.ok(lines.includes('  Today so far: 4,210 steps, 12 exercise min, 230 active kcal, 6 stand hours.'), coach);
  assert.ok(lines.includes('  Last night: 7.2 h asleep.'), coach);
  assert.ok(lines.includes('  Last 7 days, average per day with data: 6,403 steps, 12 exercise min, 230 active kcal, 6.9 h sleep, resting heart rate 60, HRV 40 ms.'), coach);
  assert.ok(lines.includes('  Workouts this week: Tue Traditional Strength Training 45 min.'), coach);
  assert.ok(lines.includes('  Weight: 78.6 kg on 2026-10-07.'), coach);
  assert.ok(lines.includes('  Habits ticked off by Apple Health data: Walk (10,000 steps, today 4,210 steps).'), coach);
  assert.ok(!dashOrEmoji.test(coach));
});

// ---------- 12. Big payloads ----------

test('12. a several-megabyte Health Auto Export payload goes through the Shortcut route', async () => {
  await reset('2026-10-08T10:00');
  const names = ['step_count', 'active_energy', 'apple_exercise_time', 'basal_energy_burned', 'walking_running_distance', 'flights_climbed', 'apple_stand_time', 'heart_rate'];
  const metrics = names.map((name) => ({ name, units: name === 'heart_rate' ? 'count/min' : 'count', data: [] }));
  const start = DateTime.fromISO('2026-05-11T00:00', { zone: ZONE });
  for (let i = 0; i < 150 * 24; i += 1) {
    const date = start.plus({ hours: i }).toFormat('yyyy-MM-dd HH:mm:ss ZZZ');
    for (const m of metrics) {
      m.data.push(m.name === 'heart_rate'
        ? { date, Min: 50, Avg: 70, Max: 90, source: BOTH }
        : { date, qty: 10, source: BOTH });
    }
  }
  const body = JSON.stringify(hae(metrics));
  assert.ok(body.length > 2_000_000, `payload is ${body.length} bytes`);
  const t0 = Date.now();
  const res = await app.request('/api/shortcut/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.samples, names.length * 150 * 24);
  assert.equal(data.dates.length, 150);
  assert.ok(Date.now() - t0 < 30000, 'well inside the 30 second background window');
  const d = await day('2026-10-07');
  assert.equal(d.steps, 240);
  assert.equal(d.flights, 240);
});
