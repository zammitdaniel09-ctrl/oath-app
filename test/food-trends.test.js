// Food trends, end to end through the API: grades on the diary, reference-intake coverage, the grade
// mix, best and worst foods, top sources, eat more or less, meal timing and weekday averages.
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
let clock = DateTime.fromISO('2027-05-10T20:00', { zone: ZONE });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-trends-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54359 + SHIFT,
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
const get = async (url) => ok(await call('GET', url));
const post = async (url, body = {}) => ok(await call('POST', url, body));
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
let n = 0;
const id = () => `trend-entry-${(n += 1)}-${Date.now().toString(36)}`;

// Three foods of his own with known values per 100 g, graded as the source would grade them.
const FOODS = {
  lentil: { name: 'Lentil bowl', grade: 'a', nutrients: { kcal: 120, protein: 9, carbs: 18, sugars: 1, fat: 1, satfat: 0.2, fibre: 8, salt: 0.3, iron: 3.3, potassium: 400 } },
  cola: { name: 'Cola', grade: 'e', nutrients: { kcal: 42, protein: 0, carbs: 10.6, sugars: 10.6, fat: 0, satfat: 0, fibre: 0, salt: 0.01, iron: 0, potassium: 0 } },
  salami: { name: 'Salami', grade: 'd', nutrients: { kcal: 400, protein: 22, carbs: 1, sugars: 1, fat: 34, satfat: 12, fibre: 0, salt: 4.5, iron: 1.5, potassium: 300, vitd: 0.5 } },
};
const key = {};
const log = (food, qty, date, time) => post('/api/food/log', { id: id(), key: key[food], qty, unit: 'g', date, time });
const weekday = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54359 + SHIFT}/oath`;
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
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
  const sql = dbmod.db();
  for (const [k, f] of Object.entries(FOODS)) {
    const item = await post('/api/food/items', { name: f.name, basis: 'g', nutrients: f.nutrients });
    key[k] = item.key;
    await sql`update food_items set nutriscore = ${f.grade}, nova = ${k === 'lentil' ? 1 : 4} where key = ${item.key}`;
  }
  // Two complete days and today. Today is drawn but never averaged.
  await log('lentil', 300, '2027-05-05', '13:00');
  await log('cola', 500, '2027-05-05', '15:00');
  await log('salami', 100, '2027-05-05', '20:00');
  await log('lentil', 200, '2027-05-07', '12:30');
  await log('cola', 1500, '2027-05-07', '16:10');
  await log('salami', 150, '2027-05-07', '19:45');
  await log('cola', 330, '2027-05-10', '11:00');
  await post('/api/food/quick', { id: id(), name: 'Cake at the office', kcal: 320, date: '2027-05-10', time: '15:00' });
});

after(async () => {
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('the diary grades what was eaten and keeps a quick add ungraded', async () => {
  const d = await get('/api/food/day');
  assert.equal(d.date, '2027-05-10');
  const cola = d.entries.find((e) => e.refKey === key.cola);
  assert.equal(cola.grade, 'e', 'the source grade wins');
  assert.equal(cola.nova, 4);
  assert.ok(Array.isArray(cola.tags));
  const cake = d.entries.find((e) => e.kind === 'quick');
  assert.equal(cake.grade, null, 'no weight, no grade');
  near(d.grades.e, 138.6);
  near(d.grades.none, 320);
  assert.equal(d.grades.a, 0);
  const past = await get('/api/food/day?date=2027-05-05');
  assert.deepEqual(past.grades, { a: 360, b: 0, c: 0, d: 400, e: 210, none: 0 });
});

test('a food with no grade from its source is graded by the shared maths, and tagged', async () => {
  const N = await import('../public/nutrition.js');
  if (typeof N.nutriScore !== 'function') return;
  const nutrients = { kcal: 61, protein: 3.5, carbs: 4.7, sugars: 4.7, fat: 3.3, satfat: 2.1, fibre: 0, salt: 0.11, calcium: 121 };
  const item = await post('/api/food/items', { name: 'Plain yogurt', basis: 'g', nutrients });
  const logged = await post('/api/food/log', { id: id(), key: item.key, qty: 150, unit: 'g', date: '2027-05-09', time: '10:00' });
  const d = await get('/api/food/day?date=2027-05-09');
  const e = d.entries.find((x) => x.id === logged.entry.id);
  assert.equal(e.grade, N.nutriScore(nutrients, { liquid: false }).grade);
  {
    assert.ok(e.tags.length > 0, 'tags come from the shared rules');
    assert.ok(e.tags.every((t) => t.label && ['good', 'neutral', 'warn'].includes(t.tone)));
  }
  await call('DELETE', `/api/food/log/${logged.entry.id}`);
});

test('coverage averages each nutrient against its reference intake over complete days only', async () => {
  const h = await get('/api/food/history?days=7');
  assert.equal(h.loggedDays, 2);
  const c = Object.fromEntries(h.coverage.map((x) => [x.key, x]));
  assert.ok(h.coverage.every((x) => x.ri > 0), 'only nutrients with a reference intake');
  // Iron: (11.4 + 8.85) / 2 = 10.125 mg of 14.
  near(c.iron.avg, 10.125);
  near(c.iron.pct, 72.3, 0.06);
  assert.equal(c.iron.days, 2);
  assert.equal(c.iron.partial, 0);
  // Vitamin D only on the salami: known on both days but a floor on both.
  near(c.vitd.avg, 0.625);
  assert.equal(c.vitd.partial, 2);
  // Nothing logged has vitamin C: unknown, never zero.
  assert.equal(c.vitc.avg, null);
  assert.equal(c.vitc.pct, null);
  assert.equal(c.vitc.days, 0);
  // Sugars (57 + 162.5) / 2 over 90 g, salt (5.45 + 7.5) / 2 over 6 g.
  near(c.sugars.pct, 121.9, 0.06);
  near(c.salt.pct, 107.9, 0.06);
});

test('grade mix by day, best and worst foods, and top sources', async () => {
  const h = await get('/api/food/history?days=7');
  const on = (date) => h.grades.days.find((d) => d.date === date);
  assert.equal(h.grades.days.length, 7);
  assert.deepEqual(on('2027-05-05'), { date: '2027-05-05', a: 360, b: 0, c: 0, d: 400, e: 210, none: 0 });
  assert.deepEqual(on('2027-05-06'), { date: '2027-05-06', a: 0, b: 0, c: 0, d: 0, e: 0, none: 0 });
  near(h.grades.total.e, 210 + 630 + 138.6);
  near(h.grades.total.none, 320);

  assert.deepEqual(h.rank.best.map((f) => [f.name, f.grade, f.count]), [['Lentil bowl', 'a', 2]]);
  assert.deepEqual(h.rank.worst.map((f) => [f.name, f.grade, f.count]), [['Cola', 'e', 3], ['Salami', 'd', 2]]);
  assert.equal(h.rank.foods, 4);
  assert.equal(h.rank.graded, 3);

  const sug = h.sources.sugars;
  near(sug.total, 254.48);
  assert.equal(sug.items[0].name, 'Cola');
  near(sug.items[0].amount, 246.98);
  near(sug.items.reduce((a, x) => a + x.share, 0), 100, 0.2);
  assert.equal(h.sources.salt.items[0].name, 'Salami');
  assert.equal(h.sources.fibre.items[0].name, 'Lentil bowl');
  assert.equal(h.sources.protein.items[0].name, 'Salami');
  assert.ok(!h.sources.fibre.items.some((x) => x.name === 'Cola'), 'nothing that added none');
});

test('eat more of and eat less of come from his data against official measures', async () => {
  const h = await get('/api/food/history?days=7');
  // Over the reference intake for sugars and salt: their top sources.
  assert.deepEqual(h.advice.less.map((x) => [x.name, x.reason]), [['Cola', 'Sugars'], ['Salami', 'Salt']]);
  // His lowest-covered minerals and vitamins: the food he already eats that brings the most, never a D or E.
  assert.deepEqual(h.advice.more.map((x) => [x.name, x.reason]), [['Lentil bowl', 'Potassium']]);
  near(h.advice.more[0].pct, 50, 0.6);
});

test('meal timing by weekday and hour, and weekday averages, over complete days', async () => {
  const h = await get('/api/food/history?days=7');
  const w5 = weekday('2027-05-05');
  const w7 = weekday('2027-05-07');
  assert.equal(h.timing.days[w5], 1);
  assert.equal(h.timing.days[w7], 1);
  assert.equal(h.timing.kcal[w5][13], 360);
  assert.equal(h.timing.kcal[w5][15], 210);
  assert.equal(h.timing.kcal[w7][19], 600);
  const today = weekday('2027-05-10');
  if (today !== w5 && today !== w7) assert.ok(h.timing.kcal[today].every((v) => v === null), 'today is not averaged');
  const wd = h.weekdays.find((x) => x.day === w5);
  assert.equal(wd.n, 1);
  near(wd.kcal, 970);
  assert.equal(h.weekdays.length, 7);
  // The original shape still holds for the Today card and older screens.
  assert.deepEqual(h.top[0], { name: 'Cola', kind: 'item', count: 3 });
});

test('the coverage report counts nutrient values across the catalogue', async () => {
  const r = await get('/api/food/report');
  assert.equal(r.nutrients.list.length, 33);
  assert.equal(r.nutrients.list.find((x) => x.key === 'iron').count, 3);
  assert.equal(r.nutrients.list.find((x) => x.key === 'vitd').count, 1);
  assert.equal(r.nutrients.graded, 3);
});

test('the coach take: written from the numbers, kept until they change, quiet when the coach is off', async () => {
  const coach = await import('../src/coach.js');
  assert.deepEqual(await get('/api/food/take'), { text: null, off: true }, 'no key, no card');
  process.env.ANTHROPIC_API_KEY = 'test';
  const requests = [];
  const answers = ['Cola is doing most of the work today: **330 ml** so far.', 'The lentils balance it nicely.', 'Cola keeps topping the sugar list.'];
  coach.setCoachClient({
    beta: { messages: { create: async (p) => {
      requests.push(JSON.parse(JSON.stringify(p)));
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: answers.shift() }] };
    } } },
  });
  try {
    const t1 = await get('/api/food/take');
    assert.match(t1.text, /^Cola is doing/);
    assert.equal(requests.length, 1);
    const sys = requests[0].system;
    assert.match(sys, /What is on his screen:/);
    assert.match(sys, /today, Monday, evening/);
    assert.match(sys, /Cola \(330/);
    assert.match(sys, /Nutri-Score E/);
    assert.match(sys, /Energy by Nutri-Score: /);
    assert.match(sys, /This past week, today left out \(2 logged days\)/);
    assert.match(sys, /Not pushy/, 'the coach voice comes with it');
    assert.ok(!requests[0].tools, 'a take has no tools');
    assert.match(requests[0].messages[0].content, /25 words at most in all.*no greeting, no sign-off, no question/, 'short, and no greeting');

    assert.equal((await get('/api/food/take')).text, t1.text, 'same numbers, same take');
    assert.equal(requests.length, 1, 'and no new call');

    await log('lentil', 150, '2027-05-10', '18:00');
    assert.equal((await get('/api/food/take')).text, 'The lentils balance it nicely.', 'a new entry, a new take');
    assert.equal(requests.length, 2);

    const tr = await get('/api/food/take?view=trends&days=7');
    assert.equal(tr.text, 'Cola keeps topping the sugar list.');
    assert.match(requests[2].system, /the last 7 days, 2 of them fully logged/);
    assert.match(requests[2].system, /Lowest graded: [^\n]*Cola \(E, 3x\)/);
    assert.match(requests[2].system, /Top sugars sources: Cola/);

    const bad = await call('GET', '/api/food/take?date=not-a-date');
    assert.equal(bad.status, 400);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    coach.setCoachClient(null);
  }
});
