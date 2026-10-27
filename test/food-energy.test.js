// Real burn: energy use measured from a made-up person's weight trend and logged food. The maths on
// its own (trend, slope, days left out, confidence, blend and range), his needs when he chooses it,
// and the API end to end with a diary and weigh-ins in the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { personalNeeds, energyText } from '../public/nutrition.js';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const ZONE = 'Europe/Malta';
const clock = DateTime.fromISO('2027-03-15T20:00', { zone: ZONE });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-energy-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54431 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let E;

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
const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b} ${msg}`);

// Calendar arithmetic for the fixtures.
const shift = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// A repeatable "random" for noisy weights (mulberry32): the sum of twelve uniforms, roughly normal with sd 1.
function noise(seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => { let x = 0; for (let i = 0; i < 12; i += 1) x += rnd(); return x - 6; };
}

const TO = '2027-03-14';
const FROM = shift(TO, -27);
// A made-up person who eats `kcal` a day and changes weight steadily by `perWeek`. Weigh-ins start 40
// days before the window (so the trend has a run-up) and come every `every` days; `noise` is the sd of
// the day-to-day water swing in kg. `logged(i)` says whether day i of the window has a log.
function person({ kcal = 2600, perWeek = 0, start = 74, every = 1, sd = 0, seed = 7, logged = () => true } = {}) {
  const swing = noise(seed);
  const days = [];
  const readings = [];
  for (let i = -40; i <= 28; i += 1) {
    const date = shift(FROM, i);
    if (i % every === 0) readings.push({ date, kg: Math.round((start + (perWeek / 7) * i + sd * swing()) * 10) / 10 });
    if (i >= 0 && i < 28 && logged(i)) days.push({ date, logged: true, kcal });
  }
  return { days, readings };
}
const run = (p, opts = {}) => E.measure({ ...p, from: FROM, to: TO, prior: 2700, goal: 'keep', ...opts });

// A made-up person, nobody real.
const PERSON = { sex: 'female', birthDate: '1994-06-02', heightCm: 168, weightKg: 64, bodyFat: 24, activity: 'moderate', goal: 'keep' };

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54431 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  const engine = await import('../src/engine.js');
  await engine.ensureGame();
  ({ app } = await import('../src/server.js'));
  E = await import('../src/food-energy.js');
  ok(await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' }));
});

after(async () => {
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('steady weight and steady intake: the burn is the intake', () => {
  const r = run(person({ kcal: 2600, perWeek: 0 }));
  assert.equal(r.window.days, 28);
  assert.equal(r.window.from, FROM);
  assert.equal(r.measured, 2600);
  assert.equal(r.trend.perWeek, 0);
  assert.equal(r.trend.kg, 74);
  assert.equal(r.confidence, 'high');
  // 90% measured, 10% the usual 2,700.
  assert.equal(r.burn, 2610);
  assert.equal(r.goal.ok, true);
  assert.equal(r.goal.text, 'Steady, as planned.');
});

test('gaining 0.5 kg a week on 3,000 kcal: the burn is about 2,450', () => {
  const r = run(person({ kcal: 3000, perWeek: 0.5 }), { goal: 'gain' });
  // 3,000 − (0.5 / 7) × 7,700 = 2,450.
  near(r.measured, 2450, 10);
  near(r.trend.perWeek, 0.5, 0.01);
  assert.equal(r.confidence, 'high');
  near(r.burn, 0.9 * 2450 + 0.1 * 2700, 10);
  assert.equal(r.goal.text, 'Gaining about 0.5 kg a week, as planned.');
  assert.equal(r.suggested, r.burn + 300, 'the goal adds 300 kcal');
});

test('days with nothing logged are left out, never counted as zero', () => {
  const r = run(person({ kcal: 2600, logged: (i) => i % 3 !== 0 }));
  assert.equal(r.counts.none, 10);
  assert.equal(r.counts.good, 18);
  assert.equal(r.intake.avg, 2600, 'the average is over the logged days');
  assert.equal(r.measured, 2600);
  const gap = r.series.find((s) => s.date === FROM);
  assert.deepEqual([gap.kcal, gap.good, gap.reason], [null, false, 'none']);
});

test('incomplete and partly logged days are left out and counted apart', () => {
  const p = person({ kcal: 2600 });
  p.days[3] = { ...p.days[3], kcal: 1900, missing: { kcal: 1 } }; // a line with no energy
  p.days[5] = { ...p.days[5], kcal: null }; // nothing with a known energy
  p.days[8] = { ...p.days[8], kcal: 900 }; // under 45% of 2,700: only part of the day
  p.days[9] = { ...p.days[9], kcal: 1300 }; // low, but a believable whole day
  const r = run(p);
  assert.equal(r.counts.incomplete, 2);
  assert.equal(r.counts.partial, 1);
  assert.equal(r.counts.good, 25);
  assert.equal(r.series[8].reason, 'partial');
  assert.equal(r.series[8].kcal, 900, 'still drawn');
  assert.equal(r.series[3].reason, 'incomplete');
  assert.equal(r.series[9].good, true);
  near(r.intake.avg, (24 * 2600 + 1300) / 25, 1);
  // Without a body, "partly" is under 45% of 2,000 kcal.
  assert.equal(run(p, { prior: null }).series[8].reason, null, '900 kcal is a whole day against 2,000');
});

test('confidence follows fully logged days, weigh-ins and their span', () => {
  const at = (days, weighIns, span) => E.confidenceOf({ days, weighIns, span });
  assert.equal(at(9, 30, 27), 'none', 'too few days');
  assert.equal(at(10, 4, 27), 'none', 'too few weigh-ins');
  assert.equal(at(10, 5, 13), 'none', 'too short a span');
  assert.equal(at(10, 5, 14), 'low');
  assert.equal(at(17, 30, 27), 'low');
  assert.equal(at(18, 10, 21), 'medium');
  assert.equal(at(18, 10, 20), 'low');
  assert.equal(at(24, 16, 26), 'high');
  assert.equal(at(28, 15, 27), 'medium');
  // The same thresholds through the whole calculation: weigh-ins every other day from day 13 of the window.
  const p = person({ kcal: 2500, every: 2, logged: (i) => i >= 16 });
  p.readings = p.readings.filter((r) => r.date >= shift(FROM, 12));
  const r = run(p);
  assert.deepEqual([r.counts.good, r.counts.weighIns, r.counts.span], [12, 8, 14]);
  assert.equal(r.confidence, 'low');
  assert.equal(r.weight, 0.5);
  assert.equal(r.missing, null);
});

test('with too little data it says what is missing, and the usual burn stands', () => {
  const p = person({ kcal: 2500, logged: (i) => i >= 24 });
  p.readings = p.readings.filter((r) => r.date >= shift(FROM, 20) && r.date <= TO).filter((_, i) => i % 3 === 0);
  const r = run(p);
  assert.equal(r.confidence, 'none');
  assert.deepEqual([r.counts.good, r.counts.weighIns, r.counts.span], [4, 3, 6]);
  assert.equal(r.burn, 2700, 'the usual burn');
  assert.equal(r.range, null);
  assert.deepEqual({ ...r.missing, text: undefined }, { days: 6, weighIns: 2, span: 8, daysToGo: 8, text: undefined });
  assert.equal(r.missing.text, '6 more fully logged days and 2 more weigh-ins over at least 8 more days');
  assert.equal(r.goal.ok, null, 'too early for the goal check');
  assert.equal(E.missingFor({ days: 12, weighIns: 6, span: 10 }).text, 'weigh-ins over 4 more days');
  assert.equal(E.missingFor({ days: 9, weighIns: 5, span: 20 }).text, '1 more fully logged day');
  // No weigh-ins and no logs: nothing to measure, nothing invented.
  const empty = run({ days: [], readings: [] });
  assert.deepEqual([empty.measured, empty.confidence, empty.trend.kg, empty.series.length], [null, 'none', null, 28]);
  assert.equal(run({ days: [], readings: [] }, { prior: null }).burn, null, 'no body and no data: no burn');
});

test('the blend leans on the measurement by confidence, with a ± range clamped to sane values', () => {
  const sd = 0.4;
  const p = person({ kcal: 3100, perWeek: 0, sd, seed: 11 });
  const high = run(p);
  assert.equal(high.confidence, 'high');
  near(high.burn, 0.9 * high.measured + 0.1 * 2700, 10);
  assert.ok(high.range.margin > 0 && high.range.margin < 200, `a month of daily weigh-ins is fairly sure: ±${high.range.margin}`);
  assert.equal(high.range.low, high.burn - high.range.margin);
  assert.equal(high.range.high, high.burn + high.range.margin);
  // Fewer weigh-ins, wider range, and a medium blend.
  const fewer = { ...p, readings: p.readings.filter((_, i) => i % 2 === 0) };
  const medium = run(fewer);
  assert.equal(medium.confidence, 'medium');
  assert.equal(medium.weight, 0.75);
  near(medium.burn, 0.75 * medium.measured + 0.25 * 2700, 10);
  assert.ok(medium.range.margin > high.range.margin);
  // No body: nothing to lean on, so the measurement alone.
  assert.equal(run(p, { prior: null }).burn, high.measured);
  // An impossible measurement is clamped and held at low.
  const wild = run(person({ kcal: 1300, perWeek: 1.5 }));
  assert.equal(wild.measured, 1200);
  assert.equal(wild.clamped, true);
  assert.equal(wild.confidence, 'low');
  assert.equal(wild.burn, 1950, 'half of 1,200 and half of 2,700');
  assert.ok(wild.range.low >= 1200);
  // A very unsure measurement (huge swings on the scale) is held at low, however many days there are.
  const swings = person({ kcal: 2600, sd: 3, seed: 5 });
  swings.readings = swings.readings.filter((_, i) => i % 2 === 0);
  const unsure = run(swings);
  assert.ok(unsure.range.margin > E.WIDE, `±${unsure.range.margin}`);
  assert.equal(unsure.confidence, 'low');
});

test('noisy daily weights still give a stable trend and a burn near the truth', () => {
  const steady = person({ kcal: 2400, perWeek: -0.4, sd: 0.6, seed: 3 });
  const r = run(steady, { goal: 'lose' });
  const inWindow = r.weights.filter((p) => p.date >= FROM && p.date <= TO);
  const wobble = (list, k) => list.slice(1).reduce((a, p, i) => a + Math.abs(p[k] - list[i][k]), 0) / (list.length - 1);
  assert.ok(wobble(inWindow, 'trendKg') < wobble(inWindow, 'kg') / 5, 'the trend moves far less from day to day than the scale');
  near(r.trend.perWeek, -0.4, 0.1);
  // Truth: 2,400 + (0.4 / 7) × 7,700 = 2,840.
  near(r.measured, 2840, 150);
  assert.ok(Math.abs(r.measured - 2840) <= 2 * r.range.margin + 10, 'within two standard errors');
  assert.equal(r.goal.ok, true);
  // Another seed for the same person barely moves the answer.
  near(run(person({ kcal: 2400, perWeek: -0.4, sd: 0.6, seed: 99 })).measured, r.measured, 200);
  // The trend carries over days with no reading.
  const gaps = E.trendLine([{ date: '2027-01-01', kg: 70 }, { date: '2027-01-04', kg: 71 }], '2027-01-05');
  assert.deepEqual(gaps.map((p) => p.trendKg), [70, 70, 70, 70.1, 70.1]);
});

test('the goal check names a stall', () => {
  assert.equal(E.goalCheck('gain', 0.02, true).text, 'Not gaining yet: the trend is flat.');
  assert.equal(E.goalCheck('gain', -0.3, true).text, 'Not gaining yet: losing about 0.3 kg a week.');
  assert.equal(E.goalCheck('lose', 0.04, true).ok, false);
  assert.equal(E.goalCheck('keep', 0.4, true).text, 'Gaining about 0.4 kg a week, while the goal is to keep it steady.');
  assert.equal(E.goalCheck('gain', 0.3, false).ok, null);
});

test('his needs use the real burn when he chose it and it is ready, and say why when not', () => {
  const today = '2027-03-15';
  const usual = personalNeeds(PERSON, today);
  const burn = { kcal: 2480, confidence: 'medium', days: 28, missing: '' };
  assert.equal(personalNeeds(PERSON, today, { burn }).refs.kcal, usual.refs.kcal, 'auto: the formula, whatever the burn');
  const chose = { ...PERSON, energyFrom: 'burn' };
  const n = personalNeeds(chose, today, { burn });
  assert.equal(n.refs.kcal, 2480);
  assert.equal(n.about.method, 'Real burn');
  assert.equal(n.about.energy.from, 'burn');
  assert.equal(n.about.energy.usual.burn, usual.about.energy.burn, 'the usual figure kept beside it');
  assert.equal(n.refs.carbs, Math.round((2480 * 0.55) / 4), 'carbs follow the energy');
  assert.equal(n.refs.protein, usual.refs.protein, 'protein stays per kg');
  assert.equal(energyText(n), '2,480 kcal from your real burn: weight trend and logged food over 28 days (medium confidence).');
  const lose = personalNeeds({ ...chose, goal: 'lose' }, today, { burn });
  assert.equal(lose.refs.kcal, 2080);
  assert.equal(energyText(lose), '2,080 kcal from your real burn of 2,480: weight trend and logged food over 28 days (medium confidence). Then 400 kcal less to lose fat.');
  // Not ready: the formula stays, quietly, and the line says why.
  const wait = personalNeeds(chose, today, { burn: { kcal: 2700, confidence: 'none', days: 28, missing: '6 more fully logged days and 3 more weigh-ins' } });
  assert.equal(wait.refs.kcal, usual.refs.kcal);
  assert.equal(wait.about.method, usual.about.method);
  assert.match(energyText(wait), /× 1\.55 for activity\. Real burn takes over once there is enough data: 6 more fully logged days and 3 more weigh-ins\.$/);
  assert.match(energyText(personalNeeds(chose, today, {})), /Real burn takes over once there is enough data\.$/);
  // Apple Health's activity still counts when real burn is not ready.
  assert.equal(personalNeeds(chose, today, { activeAvg: 600, restingAvg: null, burn: { kcal: 2700, confidence: 'none' } }).about.energy.from, 'health');
  // A burn nobody could have is never used.
  assert.equal(personalNeeds(chose, today, { burn: { kcal: 800, confidence: 'high' } }).refs.kcal, usual.refs.kcal);
});

test('the API measures his real burn from the diary and the scale, and his needs can use it', async () => {
  const sql = dbmod.db();
  const before = ok(await call('GET', '/api/food/energy'));
  assert.equal(before.confidence, 'none');
  assert.equal(before.prior, null, 'no body yet');
  assert.equal(before.burn, null);
  assert.equal(before.profile, false);

  ok(await call('PUT', '/api/body', PERSON));
  // Weigh-ins from 40 days back to today, losing 0.35 kg a week, each in the morning.
  for (let i = -40; i <= 28; i += 1) {
    const date = shift(FROM, i);
    const kg = Math.round((66 - (0.35 / 7) * (i + 40)) * 100) / 100;
    await sql`insert into events (type, data, at) values ('weight', ${sql.json({ kg })}, ${DateTime.fromISO(`${date}T07:30`, { zone: ZONE }).toJSDate()})`;
  }
  // The window's days: 2,300 kcal on most, one with nothing, one partly logged, one with a line of unknown energy.
  for (let i = 0; i < 28; i += 1) {
    const date = shift(FROM, i);
    if (i === 4) continue;
    const kcal = i === 9 ? 600 : 2300;
    ok(await call('POST', '/api/food/quick', { id: `energy-day-${i}`, name: 'Day of food', kcal, date, time: '13:00' }));
  }
  await sql`insert into food_log (id, date, at, slot, kind, name, nutrients) values ('energy-unknown', ${shift(FROM, 12)}, now(), 'snacks', 'quick', 'Something', ${sql.json({ kcal: null })})`;
  // A deleted entry counts for nothing.
  ok(await call('POST', '/api/food/quick', { id: 'energy-deleted', name: 'Gone', kcal: 4000, date: shift(FROM, 20), time: '15:00' }));
  ok(await call('DELETE', '/api/food/log/energy-deleted'));

  const r = ok(await call('GET', '/api/food/energy'));
  assert.deepEqual(r.window, { from: FROM, to: TO, days: 28 });
  assert.equal(r.series.length, 28);
  assert.deepEqual([r.counts.none, r.counts.partial, r.counts.incomplete, r.counts.good], [1, 1, 1, 25]);
  assert.deepEqual([r.counts.weighIns, r.counts.span], [28, 27]);
  assert.equal(r.intake.avg, 2300);
  near(r.trend.perWeek, -0.35, 0.01);
  // 2,300 + (0.35 / 7) × 7,700 = 2,685.
  near(r.measured, 2690, 10);
  assert.equal(r.confidence, 'high');
  assert.equal(typeof r.prior, 'number');
  near(r.burn, 0.9 * r.measured + 0.1 * r.prior, 10);
  assert.equal(r.goal.key, 'keep');
  assert.equal(r.goal.ok, false, 'losing while the goal is to keep');
  assert.equal(r.suggested, r.burn);
  assert.equal(r.using, false);
  assert.equal(r.energyFrom, 'auto');
  assert.equal(r.weights.at(-1).date, '2027-03-15', 'the trend runs to today');
  assert.ok(r.series.every((s) => s.trendKg !== null && s.weightKg !== null));

  // Settings sees how ready it is.
  const view = ok(await call('GET', '/api/body'));
  assert.equal(view.energy.confidence, 'high');
  assert.equal(view.energy.using, false);
  assert.equal(view.needs.about.energy.from, 'factor');

  // He chooses it: his needs, and every food percentage, now follow it.
  const chose = ok(await call('PUT', '/api/body', { energyFrom: 'burn' }));
  assert.equal(chose.body.energyFrom, 'burn');
  assert.equal(chose.needs.refs.kcal, r.burn);
  assert.equal(chose.energy.using, true);
  assert.equal(ok(await call('GET', '/api/food/day')).needs.kcal, r.burn);
  assert.equal(ok(await call('GET', '/api/food/energy')).using, true);
  const snap = await (await import('../src/state.js')).coachSnapshot();
  assert.match(snap, /Real burn, measured from his logged food and weight trend over the 28 days to 2027-03-14: about [\d,]+ kcal a day \(± \d+\), high confidence, from 25 fully logged days and 28 weigh-ins/);
  assert.match(snap, /His daily needs use the real burn\./);
  assert.equal((await call('PUT', '/api/body', { energyFrom: 'magic' })).status, 400);

  // A weigh-in the same as the last still counts as a reading for today.
  const last = (await sql`select count(*)::int as n from events where type = 'weight'`)[0].n;
  ok(await call('PUT', '/api/body', { weightKg: 64, weighIn: true }));
  ok(await call('PUT', '/api/body', { weightKg: 64, weighIn: true }));
  ok(await call('PUT', '/api/body', { weightKg: 64 }));
  assert.equal((await sql`select count(*)::int as n from events where type = 'weight'`)[0].n, last + 2);

  // Back to the formula.
  const undo = ok(await call('PUT', '/api/body', { energyFrom: 'auto' }));
  assert.equal(undo.needs.about.energy.from, 'factor');
});
