// What to eat next and "Rich in…": the gap maths, the ranking rules, and both endpoints end to end.
// Every person, food and number here is made up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { total } from '../public/nutrition.js';
import {
  dayGaps, needOf, scoreCandidate, rankNext, reasonOf, richRank, richRow, portionOf, IDEAS, MICRO_KEYS, KCAL_FLOOR,
} from '../src/food-next.js';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

// A made-up person's daily needs.
const REFS = {
  kcal: 2400, protein: 140, carbs: 330, fat: 80, sugars: 108, satfat: 24, salt: 6, fibre: 34,
  iron: 11, calcium: 950, potassium: 3500, magnesium: 350, vitc: 110, vitd: 15, folate: 330, b12: 4, zinc: 11.7,
};
const gapOf = (gaps, k) => gaps.find((g) => g.key === k);
const food = (name, nutrients, extra = {}) => ({ kind: 'item', key: name.toLowerCase().replace(/\W+/g, '-'), name, own: false, nutrients, ...extra });

// ---------- Gap maths ----------

test('gaps: complete totals give exact gaps, met needs and known micros above 60% are not gaps', () => {
  const t = { kcal: 1200, protein: 60, fibre: 33, iron: 9, calcium: 300, potassium: null, magnesium: 300, vitc: 100, vitd: 1, folate: 300, b12: 3.8, zinc: 10 };
  const { gaps, unknown } = dayGaps(t, REFS);
  assert.equal(gapOf(gaps, 'protein').gap, 80);
  assert.equal(gapOf(gaps, 'protein').floor, false);
  assert.equal(gapOf(gaps, 'kcal').gap, 1200);
  assert.equal(gapOf(gaps, 'fibre'), undefined, '33 of 34 g is met');
  assert.equal(gapOf(gaps, 'iron'), undefined, '82% is not a gap');
  assert.ok(gapOf(gaps, 'calcium'), '32% is a gap');
  assert.ok(gapOf(gaps, 'vitd'));
  assert.deepEqual(unknown, ['potassium'], 'no value is unknown, never a gap');
  // Biggest weighted first: protein carries the most.
  assert.equal(gaps[0].key, 'protein');
});

test('gaps: an incomplete total is a floor, so its gap is at most what it says', () => {
  const t = total([
    { kcal: 500, protein: 30, fibre: 4, iron: 2 },
    { kcal: 300, protein: null, fibre: null, iron: null },
  ]);
  assert.equal(t.missing.protein, 1);
  const { gaps } = dayGaps(t, REFS);
  const p = gapOf(gaps, 'protein');
  assert.equal(p.eaten, 30);
  assert.equal(p.gap, 110);
  assert.equal(p.floor, true);
  assert.equal(gapOf(gaps, 'kcal').floor, false);
});

test('gaps: nothing logged is the whole day, the vitamins and minerals capped at four; no body means EU RIs', () => {
  const { gaps, low } = dayGaps(total([]), REFS);
  assert.equal(gaps.filter((g) => MICRO_KEYS.includes(g.key)).length, 4);
  assert.equal(low.length, MICRO_KEYS.length - 4);
  assert.equal(gapOf(gaps, 'protein').gap, 140);
  assert.equal(needOf('protein', null), 50);
  assert.equal(needOf('fibre', null), 28, '14 g per 1,000 kcal of the 2,000 kcal reference');
  assert.equal(needOf('iron', null), 14);
});

// ---------- Ranking ----------

const dayAt = (t, refs = REFS) => ({ gaps: dayGaps(t, refs).gaps, refs, total: t });

test('a big protein gap ranks protein-dense foods first', () => {
  const t = { kcal: 900, protein: 25, fibre: 20, sugars: 30, salt: 2, satfat: 8, iron: 9, calcium: 800, potassium: 3000, magnesium: 300, vitc: 100, vitd: 12, folate: 300, b12: 3.5, zinc: 10 };
  const list = [
    food('Rice bowl', { kcal: 330, protein: 6, fibre: 1, sugars: 0, salt: 0, satfat: 0.2 }),
    food('Apple', { kcal: 95, protein: 0.5, fibre: 4.4, sugars: 19, salt: 0, satfat: 0 }),
    food('Grilled chicken', { kcal: 250, protein: 52, fibre: 0, sugars: 0, salt: 0.3, satfat: 1.2 }),
    food('Skyr pot', { kcal: 110, protein: 19, fibre: 0, sugars: 5, salt: 0.1, satfat: 0.3 }),
  ];
  const out = rankNext(list, { ...dayAt(t), hour: 13 });
  assert.equal(out[0].name, 'Grilled chicken');
  assert.equal(out[1].name, 'Skyr pot');
  assert.match(out[0].reason, /protein/);
  assert.equal(out[0].adds.protein, 52);
  assert.equal(out[0].log, undefined, 'the pure ranking passes through whatever payload the candidate carries');
});

test('a candidate with an unknown value gets no credit for it', () => {
  const t = { kcal: 1800, protein: 130, fibre: 30, iron: 2, calcium: 900, potassium: 3400, magnesium: 340, vitc: 105, vitd: 14, folate: 320, b12: 3.9, zinc: 11 };
  const ctx = { ...dayAt(t), hour: 12 };
  assert.ok(gapOf(ctx.gaps, 'iron'));
  const known = scoreCandidate(food('Lentils', { kcal: 230, protein: 18, fibre: 8, iron: 6.6 }), ctx);
  const unknown = scoreCandidate(food('Mystery stew', { kcal: 230, protein: 18, fibre: 8, iron: null }), ctx);
  assert.ok(known.parts.some((p) => p.key === 'iron'));
  assert.ok(!unknown.parts.some((p) => p.key === 'iron'), 'unknown iron is not counted as anything');
  assert.ok(known.score > unknown.score);
  // A food whose only value for the gap is unknown helps with nothing.
  const blank = scoreCandidate(food('Label to come', { kcal: null, protein: null, fibre: null, iron: null }), ctx);
  assert.equal(blank.gain, 0);
  assert.equal(rankNext([food('Label to come', { kcal: null, protein: null, iron: null })], ctx).length, 0);
});

test('late caffeine and alcohol are left out; decaf and alcohol-free are not', () => {
  const t = { kcal: 600, protein: 20, fibre: 5, sugars: 10, salt: 1, satfat: 3 };
  const ctx = dayAt(t);
  const espresso = food('Espresso', { kcal: 3, protein: 0.1, fibre: 0, caffeine: 63 });
  const flatWhite = food('Flat white', { kcal: 110, protein: 6, fibre: 0, caffeine: null });
  const decaf = food('Decaf latte', { kcal: 120, protein: 8, fibre: 0, caffeine: null });
  const beer = food('Lager', { kcal: 210, protein: 2, fibre: 0, alcohol: 18 });
  const zero = food('Alcohol-free lager', { kcal: 60, protein: 1, fibre: 0, alcohol: 0 });
  assert.equal(scoreCandidate(espresso, { ...ctx, hour: 16 }).excluded, 'caffeine');
  assert.equal(scoreCandidate(flatWhite, { ...ctx, hour: 15 }).excluded, 'caffeine', 'a coffee with no caffeine value is still coffee');
  assert.equal(scoreCandidate(flatWhite, { ...ctx, hour: 9 }).excluded, null);
  assert.equal(scoreCandidate(decaf, { ...ctx, hour: 20 }).excluded, null);
  assert.equal(scoreCandidate(beer, { ...ctx, hour: 9 }).excluded, 'alcohol');
  assert.equal(scoreCandidate(zero, { ...ctx, hour: 21 }).excluded, null);
  const names = rankNext([espresso, flatWhite, decaf, beer, zero], { ...ctx, hour: 17 }).map((x) => x.name);
  assert.ok(!names.includes('Espresso') && !names.includes('Flat white') && !names.includes('Lager'));
  assert.ok(names.includes('Decaf latte'));
});

test('energy past what is left, and sugars or salt past their limits, cost a candidate unless he is gaining', () => {
  const t = { kcal: 2300, protein: 100, fibre: 30, sugars: 100, salt: 5.5, satfat: 20 };
  const ctx = { ...dayAt(t), hour: 19 };
  const lean = food('Egg whites', { kcal: 70, protein: 15, fibre: 0, sugars: 0.5, salt: 0.4, satfat: 0 });
  const heavy = food('Protein pizza', { kcal: 900, protein: 40, fibre: 4, sugars: 12, salt: 3, satfat: 12 });
  const a = scoreCandidate(lean, { ...ctx, goal: 'keep' });
  const b = scoreCandidate(heavy, { ...ctx, goal: 'keep' });
  assert.ok(a.score > b.score);
  assert.ok(b.penalty > 1);
  const gaining = scoreCandidate(heavy, { ...ctx, goal: 'gain' });
  assert.ok(gaining.penalty < b.penalty, 'gaining weight: energy past the need is not a cost');
});

test('covered: every need met is no gaps at all', () => {
  const t = { kcal: 2350, protein: 150, fibre: 36, iron: 12, calcium: 1000, potassium: 3600, magnesium: 400, vitc: 120, vitd: 10, folate: 400, b12: 5, zinc: 12 };
  const { gaps } = dayGaps(t, REFS);
  assert.deepEqual(gaps, [], 'vitamin D at 67% is above the 60% line');
});

test('his own foods get a familiarity bonus, and at least one catalogue idea he has not logged makes the list', () => {
  const t = { kcal: 800, protein: 30, fibre: 8, sugars: 20, salt: 2, satfat: 6 };
  const ctx = { ...dayAt(t), hour: 12 };
  const mine = (name, protein, count = 6) => food(name, { kcal: 200, protein, fibre: 3, sugars: 2, salt: 0.3, satfat: 1 }, { own: true, count });
  const own = [mine('Chicken wrap', 35), mine('Tuna salad', 33), mine('Bean chilli', 30), mine('Tofu bowl', 29), mine('Turkey sandwich', 28)];
  const idea = food('Lentils, boiled', { kcal: 230, protein: 18, fibre: 8, sugars: 3.6, salt: 0, satfat: 0.1 });
  const out = rankNext([...own, idea], ctx);
  assert.equal(out.length, 4);
  assert.equal(out.filter((x) => x.own).length, 3);
  assert.equal(out[3].name, 'Lentils, boiled', 'the catalogue idea takes the last place');
  assert.equal(out[3].own, false);
  // Same values: his own one ranks above the stranger.
  const twin = rankNext([food('Pot of skyr', { kcal: 150, protein: 20, fibre: 0 }), food('Skyr, mine', { kcal: 150, protein: 20, fibre: 0 }, { own: true, count: 3 })], ctx);
  assert.equal(twin[0].name, 'Skyr, mine');
  assert.equal(twin.length, 2);
});

test('his own foods lead: at most two catalogue ideas, from different food groups, unless his own run out', () => {
  const t = { kcal: 800, protein: 30, fibre: 5, sugars: 20, salt: 2, satfat: 6 };
  const ctx = { ...dayAt(t), hour: 13 };
  const legume = (name, fibre) => food(name, { kcal: 220, protein: 15, fibre, sugars: 1, salt: 0, satfat: 0.1 }, { category: 'Legumes' });
  const ideas = [legume('Lentils', 16), legume('Black beans', 15), legume('Chickpeas', 13), food('Raspberries', { kcal: 64, protein: 1.5, fibre: 8, sugars: 5, salt: 0, satfat: 0 }, { category: 'Fruit' })];
  const own = [food('His porridge', { kcal: 300, protein: 12, fibre: 6, sugars: 8, salt: 0.1, satfat: 1 }, { own: true, count: 9 }), food('His bean wrap', { kcal: 420, protein: 20, fibre: 9, sugars: 3, salt: 1, satfat: 3 }, { own: true, count: 4 })];
  const out = rankNext([...ideas, ...own], ctx);
  assert.equal(out.length, 4);
  assert.equal(out.filter((x) => !x.own).length, 2);
  assert.ok(out.some((x) => x.name === 'Raspberries'), 'a second group rather than a second kind of bean');
  assert.equal(out.filter((x) => ['Lentils', 'Black beans', 'Chickpeas'].includes(x.name)).length, 1);
  // With nothing of his own that helps, the ideas fill the rows.
  assert.equal(rankNext(ideas, ctx).length, 4);
});

test('the reason line names the gap it helps most', () => {
  const gaps = [{ key: 'protein', word: 'protein' }, { key: 'fibre', word: 'fibre' }, { key: 'kcal', word: 'energy' }];
  assert.equal(reasonOf([{ key: 'protein', amount: 40, cover: 0.7, weighted: 1.4 }], gaps), 'Covers most of your protein gap');
  assert.equal(reasonOf([{ key: 'protein', amount: 40, cover: 0.95, weighted: 1.4 }, { key: 'fibre', amount: 8, cover: 0.5, weighted: 0.6 }], gaps), 'Covers your protein gap, plus fibre');
  assert.equal(reasonOf([{ key: 'protein', amount: 6, cover: 0.1, weighted: 0.2 }], gaps), 'Adds 6 g of protein');
  assert.equal(reasonOf([{ key: 'kcal', amount: 500, cover: 0.65, weighted: 0.4 }], gaps), 'Covers most of the energy you have left');
});

// ---------- Rich in ----------

test('rich in: per portion and per 100 kcal rank differently, and unknown values are left out', () => {
  const list = [
    food('Spinach, boiled', { kcal: 41, iron: 6.4 }, { g: 180, amountText: '1 US cup' }),
    food('Beef mince, browned', { kcal: 180, iron: 2.2 }, { g: 85, amountText: '3 oz' }),
    food('Lentils, boiled', { kcal: 230, iron: 6.6 }, { g: 198, amountText: '1 US cup' }),
    food('Cereal with no label', { kcal: 150, iron: null }, { g: 40 }),
    food('Espresso', { kcal: 3, iron: 0.04 }, { ml: 30, amountText: '30 ml' }),
  ];
  const portion = richRank(list, 'iron', 11, 'portion');
  assert.deepEqual(portion.map((r) => r.name), ['Lentils, boiled', 'Spinach, boiled', 'Beef mince, browned', 'Espresso']);
  assert.equal(portion[0].pct, 60);
  const kcal = richRank(list, 'iron', 11, 'kcal');
  assert.deepEqual(kcal.map((r) => r.name), ['Spinach, boiled', 'Lentils, boiled', 'Beef mince, browned'], `under ${KCAL_FLOOR} kcal a portion is not ranked per 100 kcal`);
  assert.equal(kcal[0].perKcal.amount, 15.61);
  assert.equal(kcal[0].perKcal.g, 439);
  assert.ok(![...portion, ...kcal].some((r) => r.name === 'Cereal with no label'));
  assert.equal(richRow(food('Water', { kcal: 0, iron: 0 }), 'iron', 11), null, 'nothing is not rich in anything');
});

test('a typical portion comes from the label serving or a sourced helping, never a pound or a teaspoon', () => {
  assert.deepEqual(portionOf({ serving: { size: 30, unit: 'g' }, portions: [] }), { qty: 1, unit: 'serving' });
  assert.deepEqual(portionOf({ portions: [{ label: '1 lb', g: 454 }, { label: '1 tsp', g: 2 }, { label: '1 medium', g: 118 }] }), { qty: 1, unit: 'p:1 medium' });
  assert.deepEqual(portionOf({ category: 'Legumes', portions: [{ label: '1 US cup', g: 198 }, { label: '1 tbsp', g: 12 }] }), { qty: 1, unit: 'p:1 US cup' });
  assert.deepEqual(portionOf({ category: 'Sugar, syrups and spreads', portions: [{ label: '1 US cup', g: 320 }, { label: '1 tbsp', g: 20 }] }), { qty: 1, unit: 'p:1 tbsp' }, 'a cup of syrup is not a helping');
  assert.equal(portionOf({ portions: [{ label: '1 package', g: 900 }] }), null);
});

// ---------- End to end ----------

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2027-03-10T13:00', { zone: ZONE });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-next-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54434 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let foodmod;
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
const get = async (url) => ok(await call('GET', url));
const post = async (url, body = {}) => ok(await call('POST', url, body));
let n = 0;
const id = () => `next-entry-${(n += 1)}-${Date.now().toString(36)}`;

// His own foods (made up), and catalogue records under keys from IDEAS with made-up values.
const MINE = {
  shake: { name: 'Banana oat shake', nutrients: { kcal: 90, protein: 6, carbs: 13, sugars: 7, fat: 1.5, satfat: 0.5, fibre: 1.2, salt: 0.1, iron: 0.6, calcium: 110, potassium: 250, magnesium: 25, vitc: 2, vitd: 0.1, folate: 10, b12: 0.3, zinc: 0.6 } },
  cutlet: { name: 'Chicken cutlet', nutrients: { kcal: 165, protein: 31, carbs: 0, sugars: 0, fat: 3.6, satfat: 1, fibre: 0, salt: 0.2, iron: 0.9, calcium: 12, potassium: 300, magnesium: 28, vitc: 0, vitd: 0.1, folate: 4, b12: 0.3, zinc: 1 } },
  mystery: { name: 'Bakery roll', nutrients: { kcal: 280, protein: 9, carbs: 50, sugars: 4, fat: 4, satfat: 1, fibre: null, salt: 1.1 } },
  espresso: { name: 'Espresso', basis: 'ml', nutrients: { kcal: 9, protein: 0.1, carbs: 1.7, sugars: 0, fat: 0.2, satfat: 0.1, fibre: 0, salt: 0.03, caffeine: 212, iron: 0.1, magnesium: 80 } },
  wine: { name: 'Red wine', basis: 'ml', nutrients: { kcal: 85, protein: 0.1, carbs: 2.6, sugars: 0.6, fat: 0, satfat: 0, fibre: 0, salt: 0, alcohol: 10.6, iron: 0.5 } },
  latte: { name: 'Iced protein latte', basis: 'ml', nutrients: { kcal: 60, protein: 10, carbs: 4, sugars: 3, fat: 0.8, satfat: 0.5, fibre: 0, salt: 0.1, caffeine: 40, calcium: 120 } },
  feast: { name: 'Test feast bar', nutrients: { kcal: 400, protein: 25, carbs: 30, sugars: 5, fat: 18, satfat: 4, fibre: 6, salt: 0.5, iron: 3, calcium: 250, potassium: 900, magnesium: 90, vitc: 30, vitd: 3, folate: 90, b12: 1, zinc: 3 } },
};
const CATALOGUE = [
  { key: 'lentils-boiled', name: 'Lentils, boiled', category: 'Legumes', portions: [{ label: '1 US cup', g: 198 }], nutrients: { kcal: 116, protein: 9, carbs: 20, sugars: 1.8, fat: 0.4, satfat: 0.05, fibre: 7.9, salt: 0, iron: 3.3, calcium: 19, potassium: 369, magnesium: 36, vitc: 1.5, vitd: 0, folate: 181, b12: 0, zinc: 1.3 } },
  { key: 'spinach-boiled', name: 'Spinach, boiled', category: 'Vegetables', portions: [{ label: '1 US cup', g: 180 }], nutrients: { kcal: 23, protein: 3, carbs: 3.8, sugars: 0.4, fat: 0.3, satfat: 0.04, fibre: 2.4, salt: 0.18, iron: 3.6, calcium: 136, potassium: 466, magnesium: 87, vitc: 9.8, vitd: 0, folate: 146, b12: 0, zinc: 0.8 } },
  { key: 'yogurt-greek-low-fat', name: 'Yogurt, Greek, low fat', category: 'Dairy', portions: [{ label: '1 container (7 oz)', g: 200 }], nutrients: { kcal: 73, protein: 10, carbs: 4, sugars: 4, fat: 2, satfat: 1.2, fibre: 0, salt: 0.09, iron: 0.04, calcium: 115, potassium: 141, magnesium: 11, vitc: 0, vitd: 0, folate: 7, b12: 0.75, zinc: 0.5 } },
  { key: 'orange-raw', name: 'Orange, raw', category: 'Fruit', portions: [{ label: '1 fruit (2-5/8" dia)', g: 131 }], nutrients: { kcal: 47, protein: 0.9, carbs: 12, sugars: 9.4, fat: 0.1, satfat: 0, fibre: 2.4, salt: 0, iron: 0.1, calcium: 40, potassium: 181, magnesium: 10, vitc: 53, vitd: 0, folate: 30, b12: 0, zinc: 0.07 } },
  // A catalogue record with no iron value: never ranked for iron.
  { key: 'pear-raw', name: 'Pear, raw', category: 'Fruit', portions: [{ label: '1 medium', g: 178 }], nutrients: { kcal: 57, protein: 0.4, carbs: 15, sugars: 9.8, fat: 0.1, satfat: 0, fibre: 3.1, salt: 0, iron: null, calcium: 9, potassium: 116, magnesium: 7, vitc: 4.3, vitd: 0, folate: 7, b12: 0, zinc: 0.1 } },
];
const key = {};

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54434 + SHIFT}/oath`;
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
  foodmod = await import('../src/food.js');
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
  for (const [k, f] of Object.entries(MINE)) key[k] = (await post('/api/food/items', { name: f.name, basis: f.basis || 'g', nutrients: f.nutrients })).key;
  for (const c of CATALOGUE) await foodmod.upsertItem({ ...c, kind: 'generic', basis: 'g', source: 'usda', portions: c.portions.map((p) => ({ ...p, source: 'usda' })) });
  // A made-up person: 30, 180 cm, 80 kg, moderately active, keeping his weight.
  ok(await call('PUT', '/api/body', { sex: 'male', birthDate: '1996-04-02', heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'keep' }));
  // His usual foods over the last weeks.
  for (let d = 3; d <= 20; d += 1) {
    const date = clock.minus({ days: d }).toISODate();
    await post('/api/food/log', { id: id(), key: key.shake, qty: 300, unit: 'g', date, time: '08:00' });
    await post('/api/food/log', { id: id(), key: key.cutlet, qty: 150, unit: 'g', date, time: '13:00' });
    if (d % 2) await post('/api/food/log', { id: id(), key: key.mystery, qty: 80, unit: 'g', date, time: '13:00' });
    await post('/api/food/log', { id: id(), key: key.espresso, qty: 30, unit: 'ml', date, time: '10:00' });
    if (d % 4 === 0) await post('/api/food/log', { id: id(), key: key.latte, qty: 330, unit: 'ml', date, time: '11:00' });
    if (d % 3 === 0) await post('/api/food/log', { id: id(), key: key.wine, qty: 150, unit: 'ml', date, time: '20:00' });
  }
  // One odd amount: his usual cutlet stays 150 g.
  await post('/api/food/log', { id: id(), key: key.cutlet, qty: 220, unit: 'g', date: clock.minus({ days: 2 }).toISODate(), time: '13:00' });
  // Today so far: breakfast.
  await post('/api/food/log', { id: id(), key: key.shake, qty: 300, unit: 'g', time: '08:00' });
});

after(async () => {
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('API: what to eat next ranks his foods at his usual amount with a catalogue idea, each ready to log', async () => {
  const r = await get('/api/food/next');
  assert.equal(r.covered, false);
  assert.equal(r.based, 'needs');
  assert.equal(r.today, true);
  assert.ok(r.gaps.some((g) => g.key === 'protein'));
  assert.ok(r.items.length >= 2 && r.items.length <= 4);
  const names = r.items.map((x) => x.name);
  assert.ok(!names.includes('Red wine'), 'never alcohol');
  const cutlet = r.items.find((x) => x.name === 'Chicken cutlet');
  assert.ok(cutlet, `the cutlet closes his protein gap: ${names.join(', ')}`);
  assert.equal(cutlet.own, true);
  assert.equal(cutlet.qty, 150, 'his usual amount, not the odd 220 g');
  assert.equal(cutlet.adds.protein, 46.5);
  assert.ok(cutlet.reason);
  assert.deepEqual(cutlet.log, { op: 'log', body: { key: key.cutlet, qty: 150, unit: 'g' } });
  const idea = r.items.find((x) => !x.own);
  assert.ok(idea, 'at least one catalogue idea he has not logged');
  assert.ok(IDEAS.some(([k]) => k === idea.key));
  assert.equal(idea.source.kind, 'catalogue');
  assert.match(idea.log.body.unit, /^p:/, 'a sourced portion');
  // The payload logs as it is.
  const logged = await post('/api/food/log', { ...idea.log.body, id: id() });
  assert.equal(logged.entry.refKey, idea.key);
  assert.equal(Math.round(logged.entry.nutrients.kcal), idea.adds.kcal);
});

test('API: the bakery roll with no fibre value is never credited for fibre', async () => {
  const r = await get('/api/food/next');
  for (const x of r.items.filter((i) => i.name === 'Bakery roll')) {
    assert.equal(x.adds.fibre, null);
    assert.doesNotMatch(x.reason, /fibre/);
  }
  const rich = await get('/api/food/rich?k=fibre');
  assert.ok(rich.yours.some((x) => x.name === 'Banana oat shake'));
  assert.ok(!rich.yours.some((x) => x.name === 'Bakery roll'), 'unknown fibre is left out, not ranked as zero');
});

test('API: from 15:00 his coffees are not suggested', async () => {
  const noon = await get('/api/food/next');
  assert.ok(noon.items.some((x) => x.name === 'Iced protein latte'), noon.items.map((x) => x.name).join(', '));
  const before = clock;
  clock = clock.set({ hour: 16, minute: 10 });
  try {
    const r = await get('/api/food/next');
    assert.equal(r.hour, 16);
    assert.ok(!r.items.some((x) => ['Espresso', 'Iced protein latte'].includes(x.name)));
  } finally {
    clock = before;
  }
});

test('API: rich in iron, per portion and per 100 kcal, with unknown values left out', async () => {
  const p = await get('/api/food/rich?k=iron&by=portion');
  assert.equal(p.label, 'Iron');
  assert.equal(p.based, 'needs');
  assert.equal(p.need, 11);
  assert.ok(p.yours.length >= 2);
  assert.ok(!p.yours.some((x) => x.name === 'Bakery roll'), 'no iron value, so not in the list');
  assert.ok(!p.ideas.some((x) => x.name === 'Pear, raw'));
  assert.equal(p.ideas[0].name, 'Spinach, boiled');
  assert.equal(p.ideas[0].amount, 6.48);
  assert.equal(p.ideas[0].pct, 59);
  assert.equal(p.ideas[0].portion.text, '1 US cup');
  // The idea logged above is his own now, so it moved from the ideas to his foods, once.
  const yours = new Set(p.yours.map((x) => x.key));
  assert.ok(!p.ideas.some((x) => yours.has(x.key)));
  assert.ok(p.yours.some((x) => IDEAS.some(([k]) => k === x.key)));
  for (const list of [p.yours, p.ideas]) for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1].amount >= list[i].amount);
  const k = await get('/api/food/rich?k=iron&by=kcal');
  assert.equal(k.by, 'kcal');
  assert.equal(k.ideas[0].name, 'Spinach, boiled');
  assert.ok(!k.yours.some((x) => x.name === 'Espresso'), 'under 20 kcal a portion is not ranked per 100 kcal');
  for (let i = 1; i < k.ideas.length; i += 1) assert.ok(k.ideas[i - 1].perKcal.amount >= k.ideas[i].perKcal.amount);
  const bad = await call('GET', '/api/food/rich?k=unicorn');
  assert.equal(bad.status, 400);
});

test('API: covered once every need is met', async () => {
  // A made-up feast that meets the day: 6 bars.
  await post('/api/food/log', { id: id(), key: key.feast, qty: 600, unit: 'g', time: '13:30' });
  await post('/api/food/log', { id: id(), key: key.cutlet, qty: 200, unit: 'g', time: '13:30' });
  const r = await get('/api/food/next');
  assert.equal(r.covered, true, JSON.stringify(r.gaps));
  assert.deepEqual(r.items, []);
});

test('the coach can ask which foods are rich in a nutrient', async () => {
  const tools = await import('../src/coach-tools.js');
  assert.ok(tools.TOOL_DEFS.some((t) => t.name === 'foods_rich_in'));
  const out = await tools.runTool('foods_rich_in', { nutrient: 'iron' });
  assert.equal(out.isError, false);
  assert.match(out.content, /Spinach, boiled/);
  assert.match(out.content, /left out, not counted as zero/);
});
