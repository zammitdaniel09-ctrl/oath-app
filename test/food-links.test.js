// Food and your body: the statistics on their own, then the whole thing through the API with made-up
// diary days and Apple Health samples. No real person's data anywhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import {
  tTwoSided, tCdf, welch, strengthOf, lateCut, buildRows, linksFrom, ibeta, MIN_DAYS,
} from '../src/food-links.js';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const ZONE = 'Europe/Malta';
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b} (within ${eps})`);
const plusDays = (date, n) => DateTime.fromISO(date, { zone: ZONE }).plus({ days: n }).toISODate();

// ---------- The t distribution and Welch's test ----------

test('the two-sided p-value matches closed forms and printed t tables', () => {
  // One degree of freedom is the Cauchy distribution, two have a closed form too.
  for (const t of [0.2, 1, 2.5, 7]) {
    near(tTwoSided(t, 1), 1 - (2 / Math.PI) * Math.atan(t), 1e-10);
    near(tTwoSided(t, 2), 1 - t / Math.sqrt(2 + t * t), 1e-10);
  }
  // Critical values from any t table.
  near(tTwoSided(12.706, 1), 0.05, 2e-5);
  near(tTwoSided(2.571, 5), 0.05, 2e-4);
  near(tTwoSided(2.228, 10), 0.05, 2e-4);
  near(tTwoSided(2.086, 20), 0.05, 2e-4);
  near(tTwoSided(2.750, 30), 0.01, 2e-5);
  near(tTwoSided(1.962, 1000), 0.05, 2e-4);
  assert.equal(tTwoSided(0, 7), 1);
  near(tCdf(0, 7), 0.5, 1e-12);
  near(tCdf(-1.3, 9) + tCdf(1.3, 9), 1, 1e-12);
  near(ibeta(0.3, 2, 3), 0.3483, 1e-4); // I_0.3(2, 3) = 0.3483
});

test('the t CDF agrees with integrating the density for a degrees of freedom that is not whole', () => {
  const df = 7.4;
  const lg = (x) => { // Stirling is enough for a check this loose; the module uses Lanczos
    let s = 0; let y = x;
    while (y < 8) { s -= Math.log(y); y += 1; }
    return s + (y - 0.5) * Math.log(y) - y + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * y) - 1 / (360 * y ** 3);
  };
  const c = Math.exp(lg((df + 1) / 2) - lg(df / 2)) / Math.sqrt(df * Math.PI);
  const pdf = (x) => c * (1 + (x * x) / df) ** (-(df + 1) / 2);
  const t = 1.9;
  const steps = 20000; // Simpson from 0 to t, plus the half below 0
  let s = pdf(0) + pdf(t);
  for (let i = 1; i < steps; i += 1) s += (i % 2 ? 4 : 2) * pdf((t * i) / steps);
  near(tCdf(t, df), 0.5 + (s * t) / steps / 3, 1e-8);
});

test("Welch's test reproduces R's t.test on Student's sleep data", () => {
  // t.test(extra ~ group, data = sleep): t = -1.8608, df = 17.776, p-value = 0.07939
  const g1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0];
  const g2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4];
  const w = welch(g1, g2);
  near(w.t, -1.8608, 1e-4);
  near(w.df, 17.776, 1e-3);
  near(w.p, 0.07939, 1e-5);
  near(w.diff, -1.58, 1e-9);
  assert.equal(welch([5, 5, 5], [5, 5, 5]).p, 1, 'no spread and no difference');
  assert.equal(welch([5, 5, 5], [6, 6, 6]).p, 0, 'no spread but a difference');
});

test('strength in words follows the fixed thresholds', () => {
  assert.equal(strengthOf(0.01, 8, 20), 'clear');
  assert.equal(strengthOf(0.01, 7, 20), 'maybe', 'clear needs 8 a side');
  assert.equal(strengthOf(0.15, 6, 6), 'maybe');
  assert.equal(strengthOf(0.15, 5, 30), 'no clear link');
  assert.equal(strengthOf(0.3, 30, 30), 'no clear link');
});

// ---------- Made-up days ----------

// A seeded generator so every run sees the same made-up days.
const rng = (seed) => () => {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
};
const at = (date, time) => DateTime.fromISO(`${date}T${time}`, { zone: ZONE }).toJSDate();
let eid = 0;
const entry = (date, time, n = {}, extra = {}) => ({
  id: `e${(eid += 1)}`, date, at: at(date, time), created_at: at(date, time),
  nutrients: { kcal: 600, carbs: 70, protein: 30, caffeine: 0, alcohol: 0, ...n }, liquid: false, ml: null, ...extra,
});
const drink = (date, time, n = {}, ml = 250) => entry(date, time, { kcal: 2, carbs: 0, protein: 0, ...n }, { liquid: true, ml });

// Thirty days of food, and Health filed the way health.js files it: sleep under the date he wakes up.
function month({ days = 30, start = '2026-11-01', late = (i) => i % 5 === 0 || i % 5 === 2, sleep = () => 7.5, health = true, day = null } = {}) {
  const entries = [];
  const hlth = [];
  for (let i = 0; i < days; i += 1) {
    const date = plusDays(start, i);
    entries.push(entry(date, '08:00', { kcal: 450 }), entry(date, '13:00', { kcal: 750 }));
    entries.push(entry(date, late(i) ? '22:15' : '19:45', { kcal: 800 }));
    if (day) day(i, date, entries);
    if (health) hlth.push({ date: plusDays(date, 1), sleep_hours: sleep(i, late(i)), resting_hr: 55, hrv_ms: 60, active_kcal: 500, exercise_min: 30 });
  }
  return { entries, health: hlth, from: start, to: plusDays(start, days - 1) };
}
const rowsOf = (m) => buildRows(m.entries, m.health, { tz: ZONE, from: m.from, to: m.to });
const linkOf = (out, key) => out.links.find((l) => l.key === key);

test('a built-in effect, late meals and 45 min less sleep over 30 days, comes out clear', () => {
  const noise = rng(11);
  const m = month({ sleep: (i, late) => 7.6 - (late ? 0.75 : 0) + (noise() - 0.5) * 0.8 });
  const out = linksFrom(rowsOf(m));
  const l = linkOf(out, 'late-sleep');
  assert.equal(l.state, 'ok');
  assert.equal(l.cut, '21:30', 'every cut from 20:30 to 22:00 splits these days 12 to 18; the tie goes to 21:30');
  assert.equal(l.a.n, 12);
  assert.equal(l.b.n, 18);
  near(l.diff, -0.75, 0.2);
  assert.ok(l.p < 0.001, `p ${l.p}`);
  assert.equal(l.strength, 'clear');
  assert.match(l.text, /^On nights you ate after 21:30 you slept \d+ min less \(12 nights vs 18\)\. Clear pattern so far\.$/);
  assert.equal(l.a.values.length, 12, 'each night is there for the dot strip');
  assert.ok(!/\b(caus|because|makes you)/i.test(l.text), 'never a claim of cause');
});

test('no effect comes out as no clear link', () => {
  const noise = rng(5);
  const m = month({ sleep: () => 7.4 + (noise() - 0.5) * 1.2 });
  const l = linkOf(linksFrom(rowsOf(m)), 'late-sleep');
  assert.equal(l.state, 'ok');
  assert.ok(l.p > 0.2, `p ${l.p}`);
  assert.equal(l.strength, 'no clear link');
  assert.match(l.text, /Could be chance\.$/);
});

test('too few days asks for exactly how many more', () => {
  // Ten days: three late, seven early, no caffeine after 14:00 at all.
  const m = month({ days: 10, late: (i) => i < 3 });
  const out = linksFrom(rowsOf(m));
  const l = linkOf(out, 'late-sleep');
  assert.equal(l.state, 'needs-data');
  assert.equal(l.need, MIN_DAYS - 3);
  assert.equal(l.a.n, 3);
  assert.equal(l.b.n, 7);
  assert.equal(l.strength, null);
  assert.match(l.text, /^Needs 3 more nights you ate after 21:30\. /);
  const c = linkOf(out, 'caffeine-sleep');
  assert.equal(c.state, 'needs-data');
  assert.equal(c.need, 6);
  assert.match(c.text, /^Needs 6 more days with caffeine after 14:00\. /);
  assert.equal(linkOf(out, 'eating-window').state, 'ok', 'ten timed days are enough for the window');
});

test('food on a day is paired with the sleep filed under the next date, the night that follows it', () => {
  const d = '2026-11-10';
  const entries = [entry(d, '08:00'), entry(d, '22:40'), entry(plusDays(d, 1), '00:30', { kcal: 300 }), entry(plusDays(d, 1), '09:00')];
  const health = [
    { date: d, sleep_hours: 9, hrv_ms: 80, resting_hr: 50, active_kcal: 700, exercise_min: 60 }, // the night before: not this day's
    { date: plusDays(d, 1), sleep_hours: 5.5, hrv_ms: 41, resting_hr: 62, active_kcal: 200, exercise_min: 5 },
  ];
  const [row, nextDay] = buildRows(entries, health, { tz: ZONE, from: d, to: plusDays(d, 1) });
  assert.equal(row.date, d);
  assert.equal(row.sleep, 5.5, 'sleep filed under the wake date D + 1');
  assert.equal(row.hrvNext, 41);
  assert.equal(row.rhrNext, 62);
  assert.equal(row.activeKcal, 700, 'training is the day itself');
  assert.equal(row.last, 24 * 60 + 30, 'the 00:30 snack is the end of the evening before');
  assert.equal(nextDay.first, 9 * 60, 'and not the next day\'s breakfast');
  assert.equal(row.kcal, 1200, 'totals stay on the diary day');
});

test('unlogged days are left out, never zero, and so is a day without the Health value', () => {
  const m = month({ days: 12, day: () => {} });
  const skipped = new Set([m.entries[6].date, m.entries[15].date]); // days 2 and 5
  const entries = m.entries.filter((e) => !skipped.has(e.date));
  const health = m.health.map((h, i) => (i === 7 ? { ...h, sleep_hours: null } : h));
  const rows = buildRows(entries, health, { tz: ZONE, from: m.from, to: m.to });
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => !skipped.has(r.date) && r.kcal > 0));
  const out = linksFrom(rows);
  assert.equal(out.rows, 10);
  const l = linkOf(out, 'late-sleep');
  assert.equal(l.a.n + l.b.n, 9, 'the night with no sleep value is out of that comparison only');
  const w = linkOf(out, 'eating-window');
  assert.equal(w.a.n, 10);
});

test('an entry added later without a time does not set the eating window', () => {
  const d = '2026-11-12';
  const late = { ...entry(d, '12:00', { kcal: 500 }), created_at: at(plusDays(d, 2), '10:00') };
  const [row] = buildRows([entry(d, '08:30'), late, entry(d, '19:00')], [], { tz: ZONE, from: d, to: d });
  assert.equal(row.first, null);
  assert.equal(row.last, null);
  assert.equal(row.kcal, 1700, 'its energy still counts');
});

test('a late drink with no caffeine value is unknown, not zero', () => {
  const d = '2026-11-13';
  const [unknown] = buildRows([entry(d, '09:00'), drink(d, '16:00', { caffeine: null })], [], { tz: ZONE, from: d, to: d });
  assert.equal(unknown.caffeineLate, null);
  const [known] = buildRows([entry(d, '09:00'), drink(d, '16:00', { caffeine: 80 }), drink(d, '17:00', { caffeine: null })], [], { tz: ZONE, from: d, to: d });
  assert.equal(known.caffeineLate, 80, '80 mg is over the line whatever the other drink held');
  const [morning] = buildRows([drink(d, '08:00', { caffeine: 120 }), entry(d, '13:00')], [], { tz: ZONE, from: d, to: d });
  assert.equal(morning.caffeineLate, 0, 'morning coffee is not after 14:00');
});

test('with no Health data every Health link says so, and the eating window still works', () => {
  const m = month({ health: false });
  const out = linksFrom(rowsOf(m));
  assert.equal(out.health, false);
  for (const k of ['late-sleep', 'caffeine-sleep', 'training-fuel', 'alcohol-hrv', 'alcohol-rhr']) {
    const l = linkOf(out, k);
    assert.equal(l.state, 'no-health', k);
    assert.equal(l.a, null);
    assert.ok(l.text.length > 10);
  }
  assert.equal(linkOf(out, 'eating-window').state, 'ok');
});

test('training days that burn far more but eat about the same are flagged as possible under-fuelling', () => {
  const make = (extra) => {
    const noise = rng(3);
    const entries = [];
    const hl = [];
    for (let i = 0; i < 30; i += 1) {
      const date = plusDays('2026-11-01', i);
      const training = i % 3 === 0;
      entries.push(entry(date, '08:00', { kcal: 500, carbs: 60 }), entry(date, '19:30', { kcal: 900, carbs: 100 }));
      entries.push(entry(date, '13:00', { kcal: 800 + (training ? extra : 0) + (noise() - 0.5) * 200, carbs: 90 + (training ? extra / 8 : 0) }));
      hl.push({ date, exercise_min: training ? 80 : 15, active_kcal: training ? 950 + noise() * 100 : 320 + noise() * 100 });
    }
    return linkOf(linksFrom(buildRows(entries, hl, { tz: ZONE, from: '2026-11-01', to: plusDays('2026-11-01', 29) })), 'training-fuel');
  };
  const same = make(40);
  assert.equal(same.state, 'ok');
  assert.equal(same.a.n, 10);
  assert.equal(same.b.n, 20);
  assert.ok(same.burn.diff > 550, `burn ${same.burn.diff}`);
  assert.ok(same.gap > 300, `gap ${same.gap}`);
  assert.equal(same.underfuel, true);
  assert.match(same.text, /^On training days you burned about \d+ kcal more but ate \d+ kcal more \(10 training days vs 20 rest days\)\. You may be under-fuelling/);
  assert.equal(same.strength, 'clear');
  assert.ok(same.carbs.a > 0 && same.carbs.b > 0);
  const fed = make(620);
  assert.equal(fed.underfuel, false);
  assert.match(fed.text, /keeps pace/);
});

// Health rows sent as separate pieces, one row per date as metricDays gives them.
function mergeByDate(list) {
  const m = new Map();
  for (const h of list) m.set(h.date, { ...(m.get(h.date) || {}), ...Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) });
  return [...m.values()];
}

test('the late cut-off is chosen by balance alone, never by the outcome', () => {
  const lasts = [20 * 60, 20 * 60 + 40, 21 * 60 + 10, 21 * 60 + 40, 22 * 60 + 10, 22 * 60 + 40];
  assert.equal(lateCut(lasts), 21 * 60 + 30, '21:30 splits them three and three');
  assert.equal(lateCut([19 * 60, 19 * 60, 21 * 60 + 15, 21 * 60 + 15, 23 * 60]), 21 * 60, '21:00 gives the most even split');
  assert.equal(lateCut([]), 21 * 60 + 30);
});

// ---------- End to end ----------

let clock = DateTime.fromISO('2027-02-28T20:00', { zone: ZONE });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-links-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54437 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});
let app; let cookie = ''; let dbmod; let health;

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54437 + SHIFT}/oath`;
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
  health = await import('../src/health.js');
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('the API joins the diary and seeded Health samples, and the coach hears the clearest link', async () => {
  let r = ok(await call('GET', '/api/food/links?days=30'));
  assert.equal(r.days, 30);
  assert.equal(r.rows, 0);
  assert.equal(r.health, false);
  assert.equal(r.links.find((l) => l.key === 'late-sleep').state, 'no-health');

  // 24 made-up days in February: late dinners on every third day, and 50 min less sleep the night after.
  const noise = rng(17);
  const days = [];
  let n = 0;
  for (let i = 0; i < 26; i += 1) {
    const date = plusDays('2027-02-02', i);
    const late = i % 3 === 0;
    if (i === 4 || i === 13) continue; // nothing logged on two days
    const quick = async (time, kcal, extra = {}) => ok(await call('POST', '/api/food/quick', { id: `links-${(n += 1)}-entry`, name: 'Made-up meal', kcal, carbs: Math.round(kcal / 8), protein: 30, caffeine: 0, alcohol: 0, date, time, ...extra }));
    await quick('08:00', 450);
    await quick('13:00', 700);
    await quick(late ? '22:20' : '19:30', 850);
    // Health: that day's activity, and the sleep he wakes up to the next morning, filed under the next date.
    days.push({ date, active_kcal: 450 + Math.round(noise() * 200), exercise_min: 20 + Math.round(noise() * 20) });
    days.push({ date: plusDays(date, 1), sleep_hours: Math.round((7.7 - (late ? 0.83 : 0) + (noise() - 0.5) * 0.6) * 100) / 100, hrv: 58, resting_heart_rate: 54 });
  }
  const merged = mergeByDate(days.map((d) => ({ ...d })));
  await health.ingestHealth({ days: merged });

  r = ok(await call('GET', '/api/food/links?days=30'));
  assert.equal(r.health, true);
  assert.equal(r.rows, 24, 'logged days only, today left out');
  assert.equal(r.alcohol, false);
  const l = r.links.find((x) => x.key === 'late-sleep');
  assert.equal(l.state, 'ok');
  assert.equal(l.a.n + l.b.n, 24);
  assert.ok(l.diff < -0.6 && l.diff > -1.1, `diff ${l.diff}`);
  assert.equal(l.strength, 'clear');
  for (const k of ['key', 'title', 'state', 'strength', 'a', 'b', 'diff', 'unit', 'text', 'need']) assert.ok(k in l, k);
  assert.deepEqual(Object.keys(l.a).slice(0, 3), ['label', 'mean', 'n']);
  assert.equal(r.links.find((x) => x.key === 'alcohol-hrv').state, 'needs-data', 'no alcohol logged');
  assert.equal(r.links.find((x) => x.key === 'eating-window').state, 'ok');

  const food = await import('../src/food.js');
  const coach = await food.foodForCoach();
  assert.match(coach, /Food and body, the clearest link/);
  assert.match(coach, /On nights you ate after \d\d:\d\d you slept/);
  assert.ok(!/Food and body/.test(await food.foodForCoach('2027-02-03')), 'only the snapshot carries it');
  assert.equal((await call('GET', '/api/food/links?days=nonsense')).data.days, 90);
});
