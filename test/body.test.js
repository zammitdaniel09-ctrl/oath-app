// A body sets the daily needs: the maths from a made-up person's numbers, the Body API, and food
// percentages that switch from the EU reference intakes to those needs once it is saved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { personalNeeds, ageOn, refOf, energyText, drinksRef, resolve } from '../public/nutrition.js';

const ZONE = 'Europe/Malta';
const clock = DateTime.fromISO('2026-10-27T20:00', { zone: ZONE });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-body-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54392,
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
const near = (a, b, eps = 0.1) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

// A made-up person, nobody real.
const PERSON = { sex: 'male', birthDate: '2001-03-10', heightCm: 178, weightKg: 72, bodyFat: 15, activity: 'very', goal: 'keep' };
const TODAY = '2026-10-27';

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54392/oath';
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
  ok(await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' }));
});

after(async () => {
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('needs from a body: lean mass, activity, ISSN protein and EFSA adult values', () => {
  assert.equal(ageOn('2001-03-10', TODAY), 25);
  assert.equal(ageOn('2001-11-10', TODAY), 24, 'not a year older until the birthday');
  const n = personalNeeds(PERSON, TODAY);
  // Katch-McArdle: 370 + 21.6 × (72 × 0.85) = 1,692 kcal resting, × 1.725 = 2,919, to the nearest 10.
  assert.equal(n.about.method, 'Katch-McArdle');
  assert.equal(n.about.rest, 1692);
  assert.equal(n.refs.kcal, 2920);
  assert.equal(n.refs.protein, 115, '1.6 g per kg');
  assert.equal(n.refs.carbs, 402, '55% of energy');
  assert.equal(n.refs.fat, 97, '30% of energy');
  assert.equal(n.refs.fibre, 41, '14 g per 1,000 kcal');
  assert.equal(n.refs.salt, 6);
  assert.deepEqual([n.refs.calcium, n.refs.iron, n.refs.vitc, n.refs.vitd, n.refs.b12, n.refs.folate], [950, 11, 110, 15, 4, 330]);
  assert.equal(personalNeeds({ ...PERSON, birthDate: '2001-11-10' }, TODAY).refs.calcium, 1000, 'calcium 1,000 mg up to 24');
  assert.equal(n.refs.b1, 1.22, 'thiamin 0.1 mg per MJ');
  assert.equal(n.refs.b3, 19.5, 'niacin 1.6 mg per MJ');
  assert.equal(refOf('iron', n.refs), 11);
  assert.equal(refOf('iron'), 14, 'no body: the EU RI');
  assert.equal(refOf('fibre'), null, 'fibre has no EU RI');

  const noFat = personalNeeds({ ...PERSON, bodyFat: null }, TODAY);
  assert.equal(noFat.about.method, 'Mifflin-St Jeor');
  assert.equal(noFat.refs.kcal, 2950, '(720 + 1,112.5 − 125 + 5) × 1.725');
  assert.equal(personalNeeds({ ...PERSON, goal: 'gain' }, TODAY).refs.protein, 130, '1.8 g per kg to gain');
  assert.equal(personalNeeds({ ...PERSON, birthDate: '2010-01-01' }, TODAY), null, 'under 18: the EU RIs stay');
  assert.equal(personalNeeds({ ...PERSON, weightKg: null }, TODAY), null);
  const her = personalNeeds({ ...PERSON, sex: 'female' }, TODAY);
  assert.deepEqual([her.refs.iron, her.refs.vitc, her.refs.magnesium], [16, 95, 300]);
  assert.equal(energyText(n), '2,920 kcal: resting 1,692 from 61.2 kg lean mass, × 1.725 for activity.');
});

test('energy follows Apple Health activity once it has enough days; water is 35 ml per kg', () => {
  // Resting by Katch-McArdle (1,692) plus 700 active a day, over 0.9 for digesting food: 2,657.8.
  const own = personalNeeds(PERSON, TODAY, { activeAvg: 700, restingAvg: null });
  assert.equal(own.refs.kcal, 2660);
  assert.equal(own.about.energy.from, 'health');
  assert.equal(own.about.energy.restFrom, 'Katch-McArdle');
  assert.equal(energyText(own), '2,660 kcal: resting 1,692 from 61.2 kg lean mass + 700 active on average (Apple Health, last 7 days); digesting food is the other 10%.');
  // Apple Health's own resting energy wins over the formula: (1,750 + 700) / 0.9 = 2,722.2.
  const health = personalNeeds(PERSON, TODAY, { activeAvg: 700, restingAvg: 1750 });
  assert.equal(health.refs.kcal, 2720);
  assert.equal(health.about.rest, 1750);
  assert.equal(energyText(health), '2,720 kcal: resting 1,750 + 700 active on average (Apple Health, last 7 days); digesting food is the other 10%.');
  assert.equal(health.refs.protein, 115, 'protein stays per kg');
  assert.equal(health.refs.carbs, 374, 'carbs scale with energy');
  assert.equal(health.refs.fat, 91, 'fat scales with energy');
  // The goal still applies, and is said.
  const lose = personalNeeds({ ...PERSON, goal: 'lose' }, TODAY, { activeAvg: 700, restingAvg: 1750 });
  assert.equal(lose.refs.kcal, 2320);
  assert.match(energyText(lose), /Then 400 kcal less to lose fat\.$/);
  // Too few days (null) or a figure nobody could burn keeps the activity factor; resting alone does nothing.
  assert.equal(personalNeeds(PERSON, TODAY, { activeAvg: null, restingAvg: 1750 }).refs.kcal, 2920);
  assert.equal(personalNeeds(PERSON, TODAY, { activeAvg: 9000, restingAvg: null }).about.energy.from, 'factor');
  assert.equal(personalNeeds(PERSON, TODAY, { activeAvg: 700, restingAvg: 90 }).about.energy.restFrom, 'Katch-McArdle', 'a partial day of resting energy is ignored');

  assert.equal(own.refs.water, 2520, '35 ml per kg at 72 kg');
  assert.equal(drinksRef(own.refs), 2520);
  assert.equal(drinksRef(null), 2000, 'no body: 2,000 ml');
});

test('Apple Health averages need 4 of the 7 days; a day with no reading is left out, not zero', async () => {
  const { energyAverages } = await import('../src/body.js');
  const day = (active_kcal, basal_kcal = null) => ({ active_kcal, basal_kcal });
  assert.deepEqual(energyAverages([day(500), day(600), day(700), day(null), day(null)]), { activeAvg: null, restingAvg: null });
  assert.deepEqual(energyAverages([day(500, 1700), day(600, 1720), day(700, 1740), day(800, 1760), day(0)]), { activeAvg: 650, restingAvg: 1730 });
});

test('a drink with a sourced density has its ml however it was logged', () => {
  const water = { basis: 'g', density: 1, liquid: true, portions: [{ label: '1 glass', g: 250 }], nutrients: {} };
  assert.equal(resolve(water, 1, 'p:1 glass').ml, 250);
  assert.equal(resolve(water, 330, 'g').ml, 330);
  assert.equal(resolve({ basis: 'g', nutrients: {} }, 100, 'g').ml, null, 'no density: no ml');
});

test('the Body API saves, checks and works out the needs; food percentages then use them', async () => {
  const empty = ok(await call('GET', '/api/body'));
  assert.equal(empty.needs, null);
  assert.equal(ok(await call('GET', '/api/food/day')).needs, null, 'no body: EU RIs on the Food tab');

  const bad = await call('PUT', '/api/body', { weightKg: 7.2 });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Weight must be between/);

  const saved = ok(await call('PUT', '/api/body', { ...PERSON, heightCm: '178,0' }));
  assert.equal(saved.body.heightCm, 178, 'a comma decimal is fine');
  assert.equal(saved.needs.refs.kcal, 2920);
  assert.equal(ok(await call('GET', '/api/food/day')).needs.protein, 115);

  // A day of oats yesterday: fibre and iron are now shares of the person's own needs.
  const oats = ok(await call('POST', '/api/food/items', { name: 'Test oats', basis: 'g', nutrients: { kcal: 380, protein: 13, carbs: 60, sugars: 1, fat: 7, satfat: 1.2, fibre: 10, salt: 0, iron: 4, calcium: 50 } }));
  ok(await call('POST', '/api/food/log', { id: 'body-oats-1', key: oats.key, qty: 100, unit: 'g', date: '2026-10-26', time: '08:00' }));
  const h = ok(await call('GET', '/api/food/history?days=7'));
  assert.equal(h.needs.kcal, 2920);
  const cov = Object.fromEntries(h.coverage.map((c) => [c.key, c]));
  assert.equal(cov.fibre.ri, 41, 'fibre joins once there is a need for it');
  near(cov.fibre.pct, 24.4);
  near(cov.iron.pct, 36.4);

  const snap = await (await import('../src/state.js')).coachSnapshot();
  assert.match(snap, /Body profile: male, 25, 178 cm, 72 kg, 15% body fat/);
  assert.match(snap, /2920 kcal, protein 115 g/);

  ok(await call('PUT', '/api/body', { bodyFat: '' }));
  assert.equal(ok(await call('GET', '/api/body')).needs.about.method, 'Mifflin-St Jeor', 'body fat cleared');
});
