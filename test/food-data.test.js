// The food data layer: Nutri-Score and the tags (pure maths), Open Food Facts micronutrients, the bulk seed of
// the whole USDA catalogue (stable ids, same counts, favourites kept), and search over all of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import EmbeddedPostgres from 'embedded-postgres';
import { nutriScore, NUTRIENTS, KEYS } from '../public/nutrition.js';
import { foodTags } from '../public/food-tags.js';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-fooddata-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54357 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let dbmod; let food; let seed; let off;
let firstSeed; let firstSeedMs;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54357 + SHIFT}/oath`;
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  food = await import('../src/food.js');
  seed = await import('../src/food-seed.js');
  off = await import('../src/off.js');
  const t = performance.now();
  firstSeed = await seed.seedFood({ force: true });
  firstSeedMs = performance.now() - t;
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

const sql = () => dbmod.db();
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const keys = (tags) => tags.map((t) => t.key);

// ---------- Nutri-Score (2023 algorithm), worked by hand from the published threshold tables ----------

test('Nutri-Score: cola is an E, water an A, a plain banana an A', () => {
  // Cola, 42 kcal per 100 ml = 175.7 kJ: over 30, 90 and 150 kJ = 3 points; 10.6 g of sugars is over every
  // drinks threshold up to 10 g = 9 points; no saturates, salt 0.01 g. 12 points, and a drink over 9 is an E.
  const cola = nutriScore({ kcal: 42, protein: 0, carbs: 10.6, sugars: 10.6, fat: 0, satfat: 0, fibre: 0, salt: 0.01 }, { category: 'Drinks', liquid: true });
  assert.deepEqual(cola, { grade: 'e', points: 12 });
  // The same drink with sweeteners and no sugar: +4 for the sweeteners is a C, as the update intends.
  const zero = nutriScore({ kcal: 0.4, protein: 0, carbs: 0, sugars: 0, fat: 0, satfat: 0, salt: 0.02 }, { category: 'Drinks', liquid: true, sweeteners: true });
  assert.deepEqual(zero, { grade: 'c', points: 4 });
  const water = nutriScore({ kcal: 0, protein: 0, carbs: 0, sugars: 0, fat: 0, satfat: 0, salt: 0.01 }, { category: 'Water', liquid: true });
  assert.deepEqual(water, { grade: 'a', points: 0 });
  // Banana: 89 kcal = 372 kJ (1), sugars 12.23 g (3), nothing else negative = 4; fruit counts 100% (5 points),
  // fibre 2.6 g is under 3 g, protein 1.09 g is under 2.4 g: 4 - 5 = -1, an A.
  const banana = nutriScore({ kcal: 89, protein: 1.09, carbs: 20.24, sugars: 12.23, fat: 0.33, satfat: 0.112, fibre: 2.6, salt: 0.0025 }, { category: 'Fruit' });
  assert.deepEqual(banana, { grade: 'a', points: -1 });
});

test('Nutri-Score: Nutella is an E, and milk, a drink under the update, is a B', () => {
  // Nutella: 539 kcal = 2255 kJ, over six of the ten energy thresholds (6), sugars 56.3 g over all fifteen (15), saturates 10.6 g over
  // all ten (10), salt 0.107 g (0) = 31 negative points; at 11 or more the protein does not count and nothing else is positive: an E.
  const nutella = nutriScore({ kcal: 539, protein: 6.3, carbs: 57.5, sugars: 56.3, fat: 30.9, satfat: 10.6, fibre: 0, salt: 0.107 }, { category: 'Sweets and chocolate' });
  assert.deepEqual(nutella, { grade: 'e', points: 31 });
  // Whole milk per 100 ml: 61 kcal = 255 kJ (5), sugars 4.7 g (3), saturates 1.9 g (1), salt 0.1 g (0) = 9; protein 3.3 g is over every
  // drinks threshold (7): 9 - 7 = 2, a B. Skimmed milk: 2 + 3 + 0 + 0 = 5 less 7 = -2, also a B (an A is for water only).
  const whole = nutriScore({ kcal: 61, protein: 3.3, carbs: 4.7, sugars: 4.7, fat: 3.3, satfat: 1.9, fibre: 0, salt: 0.1 }, { category: 'Milk', liquid: true });
  assert.deepEqual(whole, { grade: 'b', points: 2 });
  assert.equal(nutriScore({ kcal: 33, protein: 3.4, carbs: 5, sugars: 5, fat: 0.1, satfat: 0.1, fibre: 0, salt: 0.1 }, { category: 'Milk', liquid: true }).points, -2);
  // Orange juice counts as 100% fruit (2 + 4 + 6 = the drinks scale tops out at 6): 45 kcal (188 kJ: 3), sugars 8.4 g (7) = 10 less 6.
  const juice = nutriScore({ kcal: 45, protein: 0.7, carbs: 10, sugars: 8.4, fat: 0.2, satfat: 0, fibre: 0.2, salt: 0.01 }, { category: 'Fruit juice', liquid: true });
  assert.equal(juice.points, 3 + 7 - 6);
  assert.equal(juice.grade, 'c');
});

test('Nutri-Score: fats, oils, nuts and seeds use energy from saturates and the saturates share of fat', () => {
  // Olive oil: 14 g of saturates is 518 kJ (4 points), 14% of 100 g fat is over 10% (1) = 5 points, nothing positive: a C.
  const olive = nutriScore({ kcal: 884, protein: 0, carbs: 0, sugars: 0, fat: 100, satfat: 14, fibre: 0, salt: 0 }, { category: 'Fats and oils' });
  assert.deepEqual(olive, { grade: 'c', points: 5 });
  // Rapeseed oil: 7.1 g is 263 kJ (2 points), 7.1% is under 10% (0) = 2 points: a B.
  const rapeseed = nutriScore({ kcal: 884, protein: 0, carbs: 0, sugars: 0, fat: 100, satfat: 7.1, fibre: 0, salt: 0 }, { category: 'Fats and oils' });
  assert.deepEqual(rapeseed, { grade: 'b', points: 2 });
  // Almonds: 3.8 g of saturates is 141 kJ (1 point), 7.6% of the fat (0); sugars 4.4 g (1), salt 0 = 2 negative points; fibre 12.5 g
  // (5), protein 21.2 g (7, counted because the negative points are under 7): 2 - 12 = -10, an A for this family (-6 or less).
  const almonds = nutriScore({ kcal: 579, protein: 21.2, carbs: 8.7, sugars: 4.4, fat: 49.9, satfat: 3.8, fibre: 12.5, salt: 0.0025 }, { category: 'Nuts and seeds' });
  assert.deepEqual(almonds, { grade: 'a', points: -10 });
});

test('Nutri-Score: the red meat cap, cheese protein and the protein rule at 11 negative points', () => {
  // The same numbers as beef mince and as chicken mince: red meat counts at most 2 of its 7 protein points.
  const mince = { kcal: 250, protein: 26, carbs: 0, sugars: 0, fat: 17, satfat: 7, fibre: 0, salt: 0.15 };
  const beef = nutriScore(mince, { category: 'Beef' });
  const chicken = nutriScore(mince, { category: 'Poultry' });
  // Negative: energy 1046 kJ (3), sugars 0, saturates 7 g (6), salt 0.15 (0) = 9. Protein 26 g is 7 points; capped, 2.
  assert.equal(chicken.points, 9 - 7);
  assert.equal(beef.points, 9 - 2);
  assert.equal(chicken.grade, 'b');
  assert.equal(beef.grade, 'c');
  // A name alone tells red meat when the category does not (a typed-in food).
  assert.equal(nutriScore(mince, { name: 'Beef mince' }).points, 7);
  // Cheese always counts its protein; another food does not once it has 11 negative points.
  const cheddar = { kcal: 403, protein: 25, carbs: 0.1, sugars: 0.5, fat: 33, satfat: 21, fibre: 0, salt: 1.7 };
  const cheese = nutriScore(cheddar, { category: 'Cheese' });
  const same = nutriScore(cheddar, { category: 'Snacks' });
  assert.equal(same.points - cheese.points, 7);
  assert.equal(cheese.grade, 'd');
});

test('Nutri-Score: unknown stays unknown, and some foods are outside the system', () => {
  const full = { kcal: 100, protein: 5, carbs: 10, sugars: 2, fat: 3, satfat: 1, fibre: 1, salt: 0.1 };
  assert.ok(nutriScore(full, { category: 'Dairy' }));
  for (const k of ['kcal', 'sugars', 'satfat', 'salt']) {
    assert.equal(nutriScore({ ...full, carbs: 10, fat: 3, [k]: null }, { category: 'Dairy' }), null, `no ${k}`);
  }
  // Zero carbs means zero sugars, and zero fat zero saturates, so these are not unknown.
  assert.ok(nutriScore({ kcal: 120, protein: 22, carbs: 0, sugars: null, fat: 0, satfat: null, salt: 0.1 }, { category: 'Fish and shellfish' }));
  // Fibre and protein missing count as zero.
  assert.ok(nutriScore({ kcal: 100, sugars: 2, satfat: 1, salt: 0.1 }, { category: 'Dairy' }));
  // Beer, tea, baby food and supplements are not graded.
  for (const category of ['Alcoholic drinks', 'Coffee and tea', 'Baby food', 'Supplements and powders']) {
    assert.equal(nutriScore({ ...full, kcal: 40 }, { category, liquid: true }), null, category);
  }
});

// ---------- Tags ----------

test('tags: FSA traffic lights at their thresholds, per 100 g and per 100 ml', () => {
  const base = { kcal: 300, protein: 0, carbs: 40, sugars: 10, fat: 10, satfat: 3, fibre: 0, salt: 0.5 };
  const solid = (over) => foodTags({ nutrients: { ...base, ...over }, basis: 'g' });
  // Sugars: low up to 5, red over 22.5.
  assert.ok(keys(solid({ sugars: 5 })).includes('low-sugar'));
  assert.ok(!keys(solid({ sugars: 5.1 })).includes('low-sugar'));
  assert.ok(!keys(solid({ sugars: 22.5 })).includes('sugar-rush'));
  assert.ok(keys(solid({ sugars: 22.6 })).includes('sugar-rush'));
  // Fat: low up to 3 (the EU low fat claim), red over 17.5. Saturates: low up to 1.5, red over 5. Salt: low up to 0.3, red over 1.5.
  assert.ok(keys(solid({ fat: 3 })).includes('low-fat'));
  assert.ok(keys(solid({ fat: 17.6 })).includes('high-fat') && !keys(solid({ fat: 17.5 })).includes('high-fat'));
  assert.ok(keys(solid({ satfat: 1.5 })).includes('low-saturates'));
  assert.ok(keys(solid({ satfat: 5.1 })).includes('high-saturates') && !keys(solid({ satfat: 5 })).includes('high-saturates'));
  assert.ok(keys(solid({ salt: 0.3 })).includes('low-salt'));
  assert.ok(keys(solid({ salt: 1.51 })).includes('salty') && !keys(solid({ salt: 1.5 })).includes('salty'));
  // Drinks are judged per 100 ml: 11.25 g of sugars is the line, 0.75 g of salt too.
  const drink = (over) => foodTags({ nutrients: { ...base, kcal: 40, sugars: 5, fat: 0, satfat: 0, salt: 0.05, ...over }, basis: 'ml', liquid: true });
  assert.ok(keys(drink({ sugars: 11.3 })).includes('sugar-rush') && !keys(drink({ sugars: 11.25 })).includes('sugar-rush'));
  assert.ok(keys(drink({ sugars: 2.5 })).includes('low-sugar'));
  assert.ok(keys(drink({ salt: 0.8 })).includes('salty'));
  // Sugar free wins over low sugar, and a food with no carbohydrate (meat, fish, oil) has nothing to say about sugar.
  const free = keys(solid({ sugars: 0.5 }));
  assert.ok(free.includes('sugar-free') && !free.includes('low-sugar'));
  assert.ok(!keys(solid({ sugars: 0, carbs: 0 })).some((k) => k.includes('sugar')), 'steak is not "sugar free"');
  assert.ok(keys(drink({ sugars: 0, carbs: 0, kcal: 0 })).includes('sugar-free'), 'a diet drink is');
  // A can of cola: 10.6 g per 100 ml is amber, but 355 ml holds 37.6 g and the FSA's portion rule for drinks over 150 ml makes it red.
  const cola = foodTags({ nutrients: { ...base, kcal: 42, carbs: 10.6, sugars: 10.6, fat: 0, satfat: 0, salt: 0.01 }, basis: 'g', liquid: true, density: 1.04, portions: [{ label: '1 can (12 fl oz)', g: 370 }] });
  assert.match(cola.find((t) => t.key === 'sugar-rush').why, /portion/);
  assert.ok(!keys(foodTags({ nutrients: { ...base, kcal: 42, carbs: 10.6, sugars: 10.6, fat: 0, satfat: 0, salt: 0.01 }, basis: 'ml', liquid: true })).includes('sugar-rush'), 'no portion known: per 100 ml only');
  assert.ok(!keys(foodTags({ nutrients: { ...base, kcal: 20, carbs: 4.8, sugars: 4.8, fat: 0, satfat: 0, salt: 0.01 }, basis: 'ml', liquid: true, serving: { size: 200, unit: 'ml' } })).includes('sugar-rush'), '9.6 g in a 200 ml glass is under 13.5 g');
  // The why names the criterion.
  assert.match(solid({ sugars: 30 }).find((t) => t.key === 'sugar-rush').why, /FSA/);
  assert.equal(solid({ sugars: 30 }).find((t) => t.key === 'sugar-rush').tone, 'warn');
});

test('tags: EU claims for protein and fibre, carb heavy, caffeine, NOVA and Nutri-Score', () => {
  // Protein: 20% of the energy is high, 12% a source. Chicken breast: 31 g protein, 165 kcal = 76%.
  const chicken = foodTags({ nutrients: { kcal: 165, protein: 31, carbs: 0, fat: 3.6, satfat: 1, sugars: 0, salt: 0.2 }, basis: 'g' });
  assert.ok(keys(chicken).includes('protein-packed'));
  assert.match(chicken.find((t) => t.key === 'protein-packed').why, /1924\/2006/);
  // 100 kcal with 5.9 g of protein: 5.9 x 17 / (100 x 4.184) = 24%. With 3.0 g: 12.2%, a source.
  assert.ok(keys(foodTags({ nutrients: { kcal: 100, protein: 5.9 }, basis: 'g' })).includes('protein-packed'));
  const source = keys(foodTags({ nutrients: { kcal: 100, protein: 3.0 }, basis: 'g' }));
  assert.ok(source.includes('protein-source') && !source.includes('protein-packed'));
  // 11.5% of the energy is not a source.
  assert.ok(!keys(foodTags({ nutrients: { kcal: 100, protein: 2.8 }, basis: 'g' })).some((k) => k.startsWith('protein')));
  // Watery vegetables do not count: spinach is 51% protein by energy but 2.9 g per 100 g.
  assert.ok(!keys(foodTags({ nutrients: { kcal: 23, protein: 2.9 }, basis: 'g' })).includes('protein-packed'));
  // Fibre: 6 g high, 3 g a source.
  assert.ok(keys(foodTags({ nutrients: { fibre: 6 }, basis: 'g' })).includes('high-fibre'));
  const fibre = keys(foodTags({ nutrients: { fibre: 3 }, basis: 'g' }));
  assert.ok(fibre.includes('source-fibre') && !fibre.includes('high-fibre'));
  assert.deepEqual(keys(foodTags({ nutrients: { fibre: 2.9 }, basis: 'g' })), []);
  // Carb heavy: 55% of the energy and 30 g per 100 g.
  assert.ok(keys(foodTags({ nutrients: { kcal: 360, carbs: 79, protein: 7 }, basis: 'g' })).includes('carb-heavy'));
  assert.ok(!keys(foodTags({ nutrients: { kcal: 360, carbs: 29, protein: 7 }, basis: 'g' })).includes('carb-heavy'));
  // Caffeine: over 150 mg per litre, so over 15 mg per 100 ml; a drink held per 100 g uses its density.
  assert.ok(keys(foodTags({ nutrients: { caffeine: 32 }, basis: 'ml', liquid: true })).includes('high-caffeine'));
  assert.ok(!keys(foodTags({ nutrients: { caffeine: 15 }, basis: 'ml', liquid: true })).includes('high-caffeine'));
  assert.ok(!keys(foodTags({ nutrients: { caffeine: 32 }, basis: 'g' })).includes('high-caffeine'), 'only drinks');
  // NOVA and Nutri-Score.
  assert.ok(keys(foodTags({ nutrients: {}, nova: 4 })).includes('ultra-processed'));
  assert.ok(keys(foodTags({ nutrients: {}, nova: 1 })).includes('whole-food'));
  assert.ok(keys(foodTags({ nutrients: {}, category: 'Fruit', state: 'raw', name: 'Banana' })).includes('whole-food'));
  assert.ok(!keys(foodTags({ nutrients: {}, category: 'Fruit', state: 'canned', name: 'Peaches' })).includes('whole-food'));
  assert.ok(!keys(foodTags({ nutrients: {}, category: 'Fruit', state: 'raw', name: 'Banana', nova: 3 })).includes('whole-food'));
  for (const g of ['a', 'b']) assert.ok(keys(foodTags({ nutrients: {}, nutriscore: g })).includes('good-choice'));
  for (const g of ['d', 'e']) assert.ok(keys(foodTags({ nutrients: {}, nutriscore: { grade: g } })).includes('eat-less'));
  assert.deepEqual(keys(foodTags({ nutrients: {}, nutriscore: 'c' })), []);
});

test('tags: unknown values never produce a tag, and the list is ordered with a reason for each', () => {
  assert.deepEqual(foodTags({ nutrients: {} }), []);
  assert.deepEqual(foodTags({ nutrients: Object.fromEntries(KEYS.map((k) => [k, null])) }), []);
  assert.deepEqual(foodTags(null), []);
  // Only the values that are known speak: a record with salt alone gets a salt tag and nothing else.
  assert.deepEqual(keys(foodTags({ nutrients: { salt: 2 }, basis: 'g' })), ['salty']);
  const crisps = foodTags({ nutrients: { kcal: 536, protein: 6.6, carbs: 52, sugars: 0.5, fat: 34, satfat: 3.1, fibre: 4.4, salt: 1.4 }, basis: 'g', nova: 4, nutriscore: 'd', category: 'Snacks' });
  // The verdict first, then warnings, then what is good about it.
  const lead = ['eat-less', 'ultra-processed', 'high-fat', 'source-fibre', 'sugar-free'];
  assert.deepEqual(keys(crisps).filter((k) => lead.includes(k)), lead);
  assert.ok(['eat-less', 'ultra-processed', 'source-fibre', 'sugar-free', 'high-fat'].every((k) => keys(crisps).includes(k)));
  assert.ok(keys(crisps).indexOf('eat-less') < keys(crisps).indexOf('high-fat'));
  for (const t of crisps) {
    assert.ok(['good', 'neutral', 'warn'].includes(t.tone));
    assert.ok(t.label && t.why.length > 10, t.key);
  }
});

// ---------- Open Food Facts ----------

test('Open Food Facts: micronutrients in grams become mg and µg, and the grade and NOVA come across', () => {
  const m = off.mapProduct({
    code: '5000000000999', product_name: 'Test cereal', brands: 'Testco', quantity: '500 g', countries_tags: ['en:malta'],
    nutriscore_grade: 'B', nova_group: 3,
    nutriments: {
      'energy-kcal_100g': 370, proteins_100g: 8, carbohydrates_100g: 70, sugars_100g: 20, fat_100g: 4, 'saturated-fat_100g': 1, fiber_100g: 6, salt_100g: 0.5,
      'added-sugars_100g': 15, 'monounsaturated-fat_100g': 1.2, 'polyunsaturated-fat_100g': 1.5, 'trans-fat_100g': 0.01, cholesterol_100g: 0.005,
      potassium_100g: 0.4, calcium_100g: 0.12, iron_100g: 0.009, magnesium_100g: 0.1, zinc_100g: 0.007, phosphorus_100g: 0.3, selenium_100g: 0.00002,
      'vitamin-a_100g': 0.0008, 'vitamin-c_100g': 0.08, 'vitamin-d_100g': 0.0000075, 'vitamin-e_100g': 0.012, 'vitamin-k_100g': 0.00003,
      'vitamin-b1_100g': 0.0011, 'vitamin-b2_100g': 0.0014, 'vitamin-pp_100g': 0.016, 'vitamin-b6_100g': 0.0014, 'vitamin-b9_100g': 0.0002, 'vitamin-b12_100g': 0.0000025,
    },
  });
  assert.equal(m.nutriscore, 'b');
  assert.equal(m.nova, 3);
  const n = m.nutrients;
  const expect = {
    addsugars: 15, mufa: 1.2, pufa: 1.5, transfat: 0.01, chol: 5, potassium: 400, calcium: 120, iron: 9, magnesium: 100, zinc: 7, phosphorus: 300, selenium: 20,
    vita: 800, vitc: 80, vitd: 7.5, vite: 12, vitk: 30, b1: 1.1, b2: 1.4, b3: 16, b6: 1.4, folate: 200, b12: 2.5,
  };
  for (const [k, v] of Object.entries(expect)) near(n[k], v, 1e-6);
  // Everything on the NUTRIENTS list is present in the mapped set, known or null.
  for (const k of KEYS) assert.ok(k in n, k);
  // "unknown" and "not-applicable" are not grades; a missing micronutrient stays null.
  const none = off.mapProduct({ code: '5000000000998', product_name: 'Plain', nutriscore_grade: 'not-applicable', nova_group: 'unknown', nutriments: { 'energy-kcal_100g': 100 } });
  assert.equal(none.nutriscore, null);
  assert.equal(none.nova, null);
  assert.equal(none.nutrients.calcium, null);
  // An absurd value is dropped, not kept.
  const odd = off.mapProduct({ code: '5000000000997', product_name: 'Odd', nutriments: { 'energy-kcal_100g': 100, calcium_100g: 500 } });
  assert.equal(odd.nutrients.calcium, null);
});

// ---------- The whole catalogue ----------

test('the seed loads the whole USDA catalogue with all the nutrients, and fast', async () => {
  const [{ n }] = await sql()`select count(*)::int as n from food_items`;
  assert.ok(n > 12000, `${n} records`);
  assert.ok(firstSeed.usdaAll > 11000, JSON.stringify(firstSeed));
  assert.equal(firstSeed.rejected, 0);
  assert.ok(firstSeedMs < 60000, `seeding took ${firstSeedMs} ms`);
  // Every record has the whole nutrient list, known or null.
  const [row] = await sql()`select nutrients from food_items where key = 'banana-raw'`;
  for (const k of KEYS) assert.ok(k in row.nutrients, k);
  assert.equal(NUTRIENTS.length, KEYS.length);
  const sources = await sql()`select source, kind, count(*)::int as n from food_items group by source, kind order by source, kind`;
  assert.ok(sources.some((s) => s.source === 'usda' && s.kind === 'product'), 'chain products are products');
});

test('banana has potassium 358 and the other micronutrients USDA gives', async () => {
  const b = await food.getFood({ key: 'banana-raw' });
  assert.equal(b.nutrients.potassium, 358);
  assert.equal(b.nutrients.magnesium, 27);
  near(b.nutrients.vitc, 8.7);
  near(b.nutrients.b6, 0.367);
  assert.equal(b.nutrients.folate, 20);
  assert.equal(b.nutrients.vitd, 0);
  assert.equal(b.nutrients.addsugars, null, 'USDA SR has no added sugars: unknown, not zero');
  // The grade and tags come with the record.
  assert.equal(b.nutriscore, 'a');
  assert.equal(b.nutriscoreFrom, 'computed');
  assert.ok(keys(b.tags).includes('whole-food') && keys(b.tags).includes('good-choice'));
});

test('re-seeding twice keeps the ids and the counts, and never touches favourites, uses or hidden', async () => {
  const before = await sql()`select id, key from food_items order by key`;
  await food.setFavourite('banana-raw', true);
  await sql()`update food_items set uses = 7, last_used = now(), last_qty = 2, last_unit = 'g', hidden = true where key = 'fdc-170327'`;
  await sql()`update food_items set uses = 3, favourite = true where key = ${before.find((r) => r.key.startsWith('fdc-'))?.key}`;
  const t = performance.now();
  const again = await seed.seedFood({ force: true });
  const ms = performance.now() - t;
  assert.ok(ms < 60000, `${ms} ms`);
  assert.equal(again.items, firstSeed.items);
  assert.equal(again.usdaAll, firstSeed.usdaAll);
  const after2 = await sql()`select id, key from food_items order by key`;
  assert.deepEqual(after2, before, 'same rows, same ids');
  const [banana] = await sql()`select favourite from food_items where key = 'banana-raw'`;
  assert.equal(banana.favourite, true);
  const [fries] = await sql()`select uses, hidden, last_unit from food_items where key = 'fdc-170327'`;
  assert.deepEqual({ uses: fries.uses, hidden: fries.hidden, unit: fries.last_unit }, { uses: 7, hidden: true, unit: 'g' });
  // A third seed, unchanged data and not forced, does nothing.
  const skipped = await seed.seedFood();
  assert.equal(skipped.skipped, true);
  await sql()`update food_items set hidden = false, uses = 0, last_used = null, last_qty = null, last_unit = null where key = 'fdc-170327'`;
  await sql()`update food_items set favourite = false where favourite = true`;
});

test('records saved before brand_norm existed are filled in by the migration', async () => {
  await food.upsertItem({ key: 'test-old-brand', name: 'Old product', brand: "Mac & Dónal's", nutrients: { kcal: 10 }, source: 'you' });
  await sql()`update food_items set brand_norm = '' where key = 'test-old-brand'`;
  await food.migrateFood();
  const [row] = await sql()`select brand_norm from food_items where key = 'test-old-brand'`;
  assert.equal(row.brand_norm, 'mac donals');
  await sql()`delete from food_items where key = 'test-old-brand'`;
});

test('the bulk upsert skips a bad record instead of failing the seed, and keeps the last of a repeated key', async () => {
  const good = { key: 'test-bulk-a', name: 'Bulk test food', nutrients: { kcal: 100 }, source: 'you' };
  const r = await food.upsertItems([
    good,
    { key: 'test-bulk-bad', name: 'Too much', nutrients: { kcal: 5000 }, source: 'you' },
    { key: 'Bad Key!', name: 'Bad key', nutrients: { kcal: 1 }, source: 'you' },
    { ...good, name: 'Bulk test food, second' },
  ]);
  assert.equal(r.saved, 1);
  assert.equal(r.rejected.length, 2);
  const [row] = await sql()`select name from food_items where key = 'test-bulk-a'`;
  assert.equal(row.name, 'Bulk test food, second');
  await sql()`delete from food_items where key = 'test-bulk-a'`;
});

// ---------- Search ----------

test('"burger king fries" finds Burger King\'s fries, with a large portion', async () => {
  // Burger King Malta's own leaflet (data/foods/brands) comes before the US record from USDA.
  const [first] = await food.searchFoods('burger king fries');
  assert.equal(first.brand, 'Burger King');
  assert.equal(first.name, 'Fries');
  assert.equal(first.kind, 'product');
  assert.equal(first.market, 'Malta');
  assert.ok(first.units.some((u) => u.unit === 'p:large fries'), first.units.map((u) => u.unit).join(', '));
  // Large fries from Burger King: filler words are dropped, the size picks the portion.
  const [big] = await food.searchFoods('large fries from Burger King');
  assert.equal(big.key, first.key);
  assert.deepEqual(big.portionHint, { unit: 'p:large fries', label: 'large fries' });
  // The US record from USDA is still there, with its own numbers and the newer nutrients.
  const us = (await food.searchFoods('burger king french fries')).find((x) => x.market === 'US');
  near(us.nutrients.kcal, 280);
  assert.ok(us.nutrients.potassium > 300);
  // Other chains and sizes.
  const mc = await food.searchFoods("mcdonald's big mac");
  assert.ok(mc[0].brand === "McDonald's" && /big mac/i.test(mc[0].name), `${mc[0].brand} ${mc[0].name}`);
  const small = await food.searchFoods('small burger king fries');
  assert.equal(small[0].portionHint.label, 'small fries');
});

test('chain products keep a clean name, a brand and the original USDA wording as an alias', async () => {
  const [r] = await sql()`select * from food_items where key = 'fdc-170327'`;
  assert.equal(r.name, 'French fries');
  assert.equal(r.brand, 'Burger King');
  assert.ok(r.aliases.includes('BURGER KING, french fries'));
  assert.equal(r.category, 'Fast food');
  assert.equal(r.state, 'as-sold');
  // US wording stays searchable under the UK name.
  const eggplant = await food.searchFoods('eggplant');
  assert.ok(eggplant.some((x) => /aubergine/i.test(x.name)), 'eggplant finds the aubergine');
  const cookies = await food.searchFoods('chocolate chip cookies');
  assert.ok(cookies.some((x) => /biscuit/i.test(x.name)));
  // Every restaurant chain in SR Legacy is a brand.
  const chains = await sql()`select distinct brand from food_items where kind = 'product' and market = 'US' and brand is not null`;
  const brands = chains.map((c) => c.brand);
  for (const b of ['Burger King', "McDonald's", "Wendy's", 'KFC', 'Taco Bell', 'Subway', "Domino's", 'Pizza Hut', "Papa John's", 'Little Caesars', 'Popeyes', "Applebee's", "Denny's", 'Olive Garden', "Arby's", 'Chick-fil-A']) {
    assert.ok(brands.includes(b), `${b} is a brand`);
  }
});

test('the catalogue stays honest: a USDA record without a value has null, and liquids carry a density only from a volume portion', async () => {
  const rows = await sql()`select key, name, nutrients, density, liquid, portions from food_items where source = 'usda' and liquid = true and density is not null limit 400`;
  assert.ok(rows.length > 100);
  for (const r of rows) {
    assert.ok(r.density > 0.5 && r.density < 2, `${r.key} ${r.density}`);
    assert.ok(r.portions.some((p) => /fl(uid)? oz|cup|ml|tbsp|tsp|tablespoon|teaspoon/i.test(p.label)), `${r.key} has no volume portion`);
  }
  // Nutrients USDA lacks stay null: SR Legacy has no added sugars anywhere.
  const [{ n }] = await sql()`select count(*)::int as n from food_items where key like 'fdc-%' and nutrients->>'addsugars' is not null and source_date = '2018-04'`;
  assert.equal(n, 0);
});

test('a photo that names a product finds it by brand and name, and a drink logged by weight counts as ml', async () => {
  const photo = await import('../src/food-photo.js');
  assert.equal((await photo.namedProduct({ brand: 'Pepsi', name: 'Pepsi Max' }))?.key, 'brand:pepsi:max');
  assert.equal((await photo.namedProduct({ brand: 'PEPSI', name: 'Max' }))?.key, 'brand:pepsi:max');
  assert.equal((await photo.namedProduct({ brand: 'Kinnie', name: 'Kinnie Zero' }))?.key, 'brand:kinnie:kinnie-zero');
  assert.equal(await photo.namedProduct({ brand: 'Pepsi', name: 'Pepsi Max Mango' }), null, 'every word of the name must fit');
  assert.equal(await photo.namedProduct({ brand: '', name: 'Pepsi Max' }), null, 'no brand, no guess');
  // A diet drink held per 100 g with no sourced density: its grams stand for ml, so it counts as a drink.
  const { resolve } = await import('../public/nutrition.js');
  assert.equal(resolve({ basis: 'g', liquid: true, nutrients: {}, portions: [{ label: '1 can', g: 355 }] }, 1, 'p:1 can').ml, 355);
  assert.equal(resolve({ basis: 'g', liquid: false, nutrients: {} }, 100, 'g').ml, null, 'food is never given ml');
});

test('Maltese words find their foods, with or without the Maltese letters', async () => {
  const words = JSON.parse(fs.readFileSync(new URL('../data/foods/aliases-mt.json', import.meta.url), 'utf8')).items;
  for (const mt of ['tadam', 'ġbejniet', 'tuffieħ', 'ħobż']) {
    const entry = words.find((w) => w.mt === mt);
    assert.ok(entry, mt);
    for (const q of [mt, mt.replace(/ħ/g, 'h').replace(/ġ/g, 'g').replace(/ż/g, 'z')]) {
      const hits = await food.searchFoods(q);
      assert.ok(hits.length && entry.keys.includes(hits[0].key), `${q} → ${hits[0]?.key}`);
    }
  }
});

test('the food sprint: checked fixes land on their records, label products come up by barcode and name, requirements count their records', async () => {
  // Every fix found its record.
  const fixes = JSON.parse(fs.readFileSync(new URL('../data/foods/fixes/sprint-2026-10-29.json', import.meta.url), 'utf8')).items;
  assert.equal(firstSeed.fixed, fixes.length);
  // The 139 g "slice" copied from a US bread is gone from ħobż, the ounce stays; US pack sizes say so.
  const hobz = await food.getFood({ key: 'hobz-tal-malti-as-sold' });
  assert.ok(!hobz.portions.some((p) => p.label === '1 slice') && hobz.portions.some((p) => p.label === '1 oz'), JSON.stringify(hobz.portions));
  const tuna = await food.getFood({ key: 'tuna-canned-brine-light' });
  assert.ok(tuna.portions.some((p) => p.label === '1 US can' && p.g === 165), JSON.stringify(tuna.portions));
  // Instant coffee powder is no longer counted as a drink.
  const [coffee] = await sql()`select liquid from food_items where key = 'fdc-2710481'`;
  assert.equal(coffee.liquid, false);
  // Kinnie's barcode leads to Kinnie, a Twistees bag to its label; "lampuka" finds the mahi-mahi.
  assert.equal((await off.productByBarcode('5352201082060')).key, 'brand:kinnie:kinnie');
  assert.equal((await off.productByBarcode('5350122999900')).key, 'sprint:twistees-cheesy-50g');
  const hits = await food.searchFoods('lampuka');
  assert.ok(hits.some((h) => h.key === 'mahi-mahi-raw'), hits.map((h) => h.key).join(' '));
  // Only the requirements with no record at all are missing.
  const report = await food.coverageReport();
  const gaps = JSON.parse(fs.readFileSync(new URL('../data/foods/reqmap/wave2-sprint.json', import.meta.url), 'utf8')).filter((r) => r.status === 'gap');
  assert.equal(report.foods.missing, gaps.length);
});

test('search still puts the hand-picked records first, as before the big catalogue', async () => {
  for (const [q, key] of [['apple', 'apple-raw-with-skin'], ['banana', 'banana-raw'], ['orange', 'orange-raw'], ['watermelon', 'watermelon-raw']]) {
    const [first] = await food.searchFoods(q);
    assert.ok(first.key.startsWith(key), `${q} → ${first.key}`);
    assert.equal(first.kind, 'generic');
  }
  const rice = await food.searchFoods('white long grain rice');
  const states = new Set(rice.filter((x) => x.key.startsWith('rice-white-long-grain')).map((x) => x.state));
  assert.ok(states.has('dry') && states.has('cooked'));
  assert.ok((await food.searchFoods('bread')).every((x) => x.state), 'every record says its state');
  assert.deepEqual(await food.searchFoods('zzqx unicorn snack'), []);
  assert.deepEqual(await food.searchFoods(''), []);
  assert.ok((await food.searchFoods('red bull')).some((x) => x.source === 'usda' && x.market === 'US'));
  // A drink search can be limited to liquids.
  const colas = await food.searchFoods('cola', { liquid: true });
  assert.ok(colas.length && colas.every((x) => x.liquid));
});

test('every shaped record carries a grade, NOVA and tags, and cola, Greek yogurt and crisps read as expected', async () => {
  const cola = (await food.searchFoods('cola', { liquid: true })).find((x) => x.key === 'cola') || (await food.searchFoods('cola'))[0];
  assert.equal(cola.nutriscore, 'e');
  assert.ok(keys(cola.tags).includes('sugar-rush'), keys(cola.tags).join());
  const greek = (await food.searchFoods('greek yogurt plain fat free'))[0];
  assert.ok(['a', 'b'].includes(greek.nutriscore), `${greek.name} ${greek.nutriscore}`);
  assert.ok(keys(greek.tags).includes('protein-packed'), keys(greek.tags).join());
  const crisps = (await food.searchFoods('crisps ready salted'))[0];
  assert.ok(['c', 'd', 'e'].includes(crisps.nutriscore), `${crisps.name} ${crisps.nutriscore}`);
  assert.ok(keys(crisps.tags).includes('high-fat'), keys(crisps.tags).join());
  // The grade a source gives wins over the one worked out here.
  const saved = await food.upsertItem({ key: 'off:5000000000555', name: 'Graded drink', kind: 'product', basis: 'ml', liquid: true, nutrients: { kcal: 42, sugars: 10.6, carbs: 10.6, satfat: 0, salt: 0.02, fat: 0, protein: 0 }, source: 'off', nutriscore: 'b', nova: 4 });
  const shaped = food.shapeItem(saved);
  assert.equal(shaped.nutriscore, 'b');
  assert.equal(shaped.nutriscoreFrom, 'source');
  assert.equal(shaped.nova, 4);
  assert.ok(keys(shaped.tags).includes('ultra-processed'));
  await sql()`delete from food_items where key = 'off:5000000000555'`;
});

test('search is fast over the whole catalogue', async () => {
  const queries = ['banana', 'chicken breast', 'burger king fries', 'large fries from burger king', 'cheddar cheese', 'greek yogurt', 'salted crisps', 'cola', 'rice', 'egg', 'pizza', 'a', 'bread', 'milk semi skimmed', 'whopper', 'beef'];
  for (const q of queries) await food.searchFoods(q); // warm the plans
  const times = [];
  for (let round = 0; round < 3; round += 1) {
    for (const q of queries) {
      const t = performance.now();
      await food.searchFoods(q);
      times.push([q, performance.now() - t]);
    }
  }
  const ms = times.map((x) => x[1]).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)];
  const worst = times.reduce((a, b) => (b[1] > a[1] ? b : a));
  console.log(`search: median ${median.toFixed(1)} ms, 95th ${ms[Math.floor(ms.length * 0.95)].toFixed(1)} ms, worst ${worst[1].toFixed(1)} ms ("${worst[0]}"), ${firstSeed.items} records, seed ${(firstSeedMs / 1000).toFixed(1)} s`);
  assert.ok(median < 100, `median ${median} ms`);
  assert.ok(worst[1] < 600, `worst ${worst[1]} ms for ${worst[0]}`);
});
