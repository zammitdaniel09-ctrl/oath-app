// The tag database: the catalogue of rules (public/food-tags.js), each rule at its published threshold,
// unknowns never tagging, facts from Open Food Facts and from label photos, his habits from the diary,
// the stored tags and their re-tagging, browsing by tag, and products filled in a few at a time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { foodTags, TAGS, TAG, TAG_GROUPS, TAGS_VERSION, cleanFacts } from '../public/food-tags.js';
import { NUTRIENT } from '../public/nutrition.js';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const keys = (tags) => tags.map((t) => t.key);
const has = (item, key) => keys(foodTags(item)).includes(key);
const why = (item, key) => foodTags(item).find((t) => t.key === key)?.why;

// ---------- The catalogue ----------

test('the catalogue: about 280 tags, each with a group, a tone and its rule in words', () => {
  assert.ok(TAGS.length >= 250, `${TAGS.length} tags`);
  assert.equal(new Set(TAGS.map((t) => t.key)).size, TAGS.length, 'keys are unique');
  const groups = new Set(TAG_GROUPS.map((g) => g.key));
  for (const t of TAGS) {
    assert.ok(groups.has(t.group), t.key);
    assert.ok(['good', 'neutral', 'warn'].includes(t.tone), t.key);
    assert.ok(t.label && t.label.length <= 40, t.key);
    assert.ok(t.about && t.about.length > 15, t.key);
    if (t.sort) assert.ok(NUTRIENT[t.sort.replace(/^-/, '')], `${t.key} sorts by a nutrient`);
  }
  // Every group has tags, and the vitamins and minerals have a source and a high claim each.
  for (const g of TAG_GROUPS) assert.ok(TAGS.some((t) => t.group === g.key), g.key);
  assert.equal(TAGS.filter((t) => t.group === 'vitamins').length, 36);
  assert.equal(TAGS.filter((t) => t.group === 'allergens').length, 28);
});

test('every food in the USDA catalogue is tagged without an error, and every tag has its reason', () => {
  const data = (f) => JSON.parse(fs.readFileSync(new URL(`../data/foods/${f}`, import.meta.url), 'utf8')).items;
  const all = [...data('usda-foods.json'), ...data('usda-all.json')];
  const seen = new Set();
  for (const it of all) {
    for (const t of foodTags(it)) {
      seen.add(t.key);
      assert.ok(t.why && t.why.length > 3, `${it.key} ${t.key}`);
      assert.equal(t.group, TAG[t.key].group);
    }
  }
  assert.ok(seen.size >= 190, `${seen.size} tags in use on USDA alone`);
});

// ---------- The rules at their thresholds ----------

test('vitamins and minerals: "source of" at 15% of the EU reference value, "high in" at 30%, half that for drinks', () => {
  // Iron's reference value is 14 mg: 2.1 mg is 15%, 4.2 mg 30%.
  assert.ok(has({ nutrients: { iron: 2.1 }, basis: 'g' }, 'source-iron'));
  assert.ok(!has({ nutrients: { iron: 2.0 }, basis: 'g' }, 'source-iron'));
  const high = keys(foodTags({ nutrients: { iron: 4.2 }, basis: 'g' }));
  assert.ok(high.includes('high-iron') && !high.includes('source-iron'));
  // A drink: 7.5% per 100 ml is a source (vitamin C 6 mg of 80).
  assert.ok(has({ nutrients: { vitc: 6 }, basis: 'ml', liquid: true }, 'source-vitc'));
  assert.ok(!has({ nutrients: { vitc: 6 }, basis: 'g' }, 'source-vitc'));
  assert.match(why({ nutrients: { iron: 4.2 }, basis: 'g' }, 'high-iron'), /4\.2 mg of iron per 100 g, 30%/);
});

test('what it does: an EU-authorised health claim, shown only when the food is high in the nutrient', () => {
  // Zinc 10 mg reference: a source at 1.5 mg says nothing yet, 3 mg (30%) carries the claims.
  assert.ok(!has({ nutrients: { zinc: 1.5 }, basis: 'g' }, 'helps-testosterone'));
  const zinc = foodTags({ nutrients: { zinc: 3 }, basis: 'g' });
  for (const k of ['helps-testosterone', 'helps-immune', 'helps-fertility', 'helps-hair-nails']) assert.ok(keys(zinc).includes(k), k);
  assert.match(zinc.find((t) => t.key === 'helps-testosterone').why, /432\/2012.*testosterone/);
  // Protein: a source is enough for muscle mass. Low salt carries the blood-pressure claim.
  assert.ok(has({ nutrients: { kcal: 165, protein: 31 }, basis: 'g' }, 'helps-muscle-mass'));
  assert.match(why({ nutrients: { salt: 0.2 }, basis: 'g' }, 'helps-blood-pressure'), /reducing the consumption of sodium/);
  // Vitamin C's iron claim is worded as the register words it.
  assert.match(why({ nutrients: { vitc: 30 }, basis: 'g' }, 'helps-iron-uptake'), /it increases iron absorption/);
});

test('traffic lights: amber in the middle, and the FSA portion rule for a food portion over 100 g', () => {
  const base = { kcal: 200, carbs: 20, sugars: 3, fat: 2, satfat: 0.5, salt: 1.3 };
  const lit = keys(foodTags({ nutrients: base, basis: 'g' }));
  assert.ok(lit.includes('medium-salt') && lit.includes('low-fat') && !lit.includes('salty'));
  // A 150 g serving holds 1.95 g of salt, over 30% of the 6 g reference intake: red.
  const ready = foodTags({ nutrients: base, basis: 'g', serving: { size: 150, unit: 'g' } });
  assert.match(ready.find((t) => t.key === 'salty').why, /portion/);
  // Two reds together are called out; all four green too.
  assert.ok(has({ nutrients: { fat: 20, satfat: 8, sugars: 1, salt: 0.1 }, basis: 'g' }, 'red-lights'));
  assert.ok(has({ nutrients: { fat: 1, satfat: 0.2, sugars: 2, salt: 0.1, carbs: 10 }, basis: 'g' }, 'all-green'));
});

test('fat quality, carb quality, energy density and the macro split', () => {
  const olive = { kcal: 884, fat: 100, satfat: 13.8, mufa: 73, pufa: 10.5, carbs: 0 };
  const o = keys(foodTags({ nutrients: olive, basis: 'g' }));
  assert.ok(o.includes('high-mufa') && o.includes('high-unsaturated') && o.includes('helps-cholesterol') && o.includes('energy-dense') && o.includes('fat-led'));
  // Wholemeal bread passes the 10:1 rule; white rice does not.
  assert.ok(has({ nutrients: { kcal: 247, carbs: 41, fibre: 7 }, basis: 'g' }, 'quality-carb'));
  assert.ok(has({ nutrients: { kcal: 130, carbs: 28, fibre: 0.4 }, basis: 'g' }, 'low-fibre-carb'));
  assert.ok(has({ nutrients: { kcal: 23 }, basis: 'g' }, 'very-low-density'));
  // Added sugar over 10% of the energy (WHO).
  assert.ok(has({ nutrients: { kcal: 400, addsugars: 30 }, basis: 'g' }, 'added-sugar-high'));
});

test('drinks: caffeine, alcohol, units per portion, the sugar levy and sports drinks', () => {
  // An energy drink, 32 mg per 100 ml in a 500 ml can: high caffeine, 160 mg a can.
  const can = foodTags({ name: 'Monster Energy', nutrients: { caffeine: 32, sugars: 11, kcal: 47, carbs: 12 }, basis: 'ml', liquid: true, serving: { size: 500, unit: 'ml' } });
  assert.ok(keys(can).includes('high-caffeine') && keys(can).includes('energy-drink') && keys(can).includes('sdil-higher') && !keys(can).includes('caffeine-hit'));
  // A 4.2% beer is 3.3 g of alcohol per 100 ml: a pint-sized 500 ml bottle is over 2 units.
  const beer = keys(foodTags({ name: 'Cisk lager', nutrients: { alcohol: 3.3, sugars: 0.3, kcal: 42 }, basis: 'ml', liquid: true, serving: { size: 500, unit: 'ml' } }));
  assert.ok(beer.includes('alcoholic') && beer.includes('two-units') && beer.includes('beer') && !beer.includes('sdil-lower'));
  assert.ok(has({ name: 'Whisky', nutrients: { alcohol: 31.6 }, basis: 'ml', liquid: true }, 'strong-alcohol'));
  assert.ok(has({ name: 'Beer, alcohol-free', nutrients: { alcohol: 0 }, basis: 'ml', liquid: true }, 'alcohol-free'));
  // A carbohydrate-electrolyte drink: 26 kcal, all from carbs, 50 mg of sodium per 100 ml.
  assert.ok(has({ nutrients: { kcal: 26, carbs: 6.4, sugars: 6, salt: 0.125 }, basis: 'ml', liquid: true }, 'sports-drink'));
  // Coffee is exempt from the EU warning wording, not from the caffeine.
  assert.match(why({ name: 'Coffee, brewed', nutrients: { caffeine: 40 }, basis: 'ml', liquid: true }, 'high-caffeine'), /exempt/);
});

test('allergens: from the label, traces as "may contain", and for a plain food only from what its name says', () => {
  const offFacts = { allergens: ['en:milk', 'en:gluten'], traces: ['en:nuts'], additives: ['en:e220'] };
  const bar = keys(foodTags({ name: 'Wafer', kind: 'product', source: 'off', nutrients: {}, facts: offFacts }));
  assert.ok(['contains-milk', 'contains-gluten', 'may-contain-nuts', 'contains-sulphites'].every((k) => bar.includes(k)));
  // A product says only what its label says: nothing is guessed from its name.
  assert.ok(!has({ name: 'Peanut cookies', kind: 'product', source: 'off', nutrients: {} }, 'contains-peanuts'));
  // A plain food from its name, never "free of".
  assert.ok(has({ name: 'Milk, whole', category: 'Milk', nutrients: {} }, 'contains-milk'));
  const almond = keys(foodTags({ name: 'Almond milk, unsweetened', category: 'Plant milks', nutrients: {} }));
  assert.ok(almond.includes('contains-nuts') && !almond.includes('contains-milk'));
  const pb = keys(foodTags({ name: 'Peanut butter, smooth', category: 'Nuts and seeds', nutrients: {} }));
  assert.ok(pb.includes('contains-peanuts') && !pb.includes('contains-milk'));
  assert.ok(!has({ name: 'Butter beans, canned', category: 'Legumes', nutrients: {} }, 'contains-milk'));
  assert.ok(has({ name: 'Bread, white', category: 'Bread and rolls', nutrients: {} }, 'contains-gluten'));
  assert.ok(!has({ name: 'Bread, gluten-free', category: 'Bread and rolls', nutrients: {} }, 'contains-gluten'));
  assert.match(why({ name: 'Pastizzi, ricotta', nutrients: {} }, 'contains-milk'), /Not checked against a label/);
});

test('labels, ingredients analysis, additives, Green-Score and Malta', () => {
  const facts = {
    labels: ['en:organic', 'en:eu-organic', 'en:fair-trade', 'en:no-gluten'], analysis: ['en:vegan', 'en:palm-oil-free'],
    additives: ['en:e951', 'en:e950', 'en:e102', 'en:e250', 'en:e330'], ingredients: 14, eco: 'e', countries: ['en:malta'],
  };
  const t = keys(foodTags({ name: 'Diet cola', kind: 'product', source: 'off', nutrients: {}, facts }));
  for (const k of ['organic', 'fair-trade', 'gluten-free', 'vegan', 'palm-oil-free', 'aspartame', 'acesulfame-k', 'sweeteners', 'southampton-colours', 'colourings', 'nitrites', 'preservatives', 'many-additives', 'eco-high', 'sold-in-malta']) {
    assert.ok(t.includes(k), k);
  }
  assert.ok(!t.includes('vegetarian'), 'vegan says it already');
  const clean = keys(foodTags({ name: 'Oats', kind: 'product', source: 'off', nutrients: {}, facts: { additives: [], ingredients: 1 } }));
  assert.ok(clean.includes('no-additives') && clean.includes('short-ingredients'));
  // No additives are claimed when the ingredient list was never read.
  assert.ok(!has({ name: 'Oats', kind: 'product', source: 'off', nutrients: {}, facts: { additives: [] } }, 'no-additives'));
  assert.ok(has({ name: 'Ħobż tal-Malti', nutrients: {} }, 'maltese'));
  assert.ok(has({ name: 'Bread', name_mt: 'Ħobż', nutrients: {} }, 'maltese'));
  // Facts are cleaned to the lists and values Oath reads; anything else is dropped.
  assert.deepEqual(cleanFacts({ labels: ['EN:Organic', 'en:organic', 42], ingredients: 3.5, eco: 'z', evil: '<script>' }), { labels: ['en:organic', '42'] });
});

test('his habits: regular, usual meal, late night, new, not lately and his top sources', () => {
  const habits = {
    favourite: true, days30: 9, logs90: 10, total: 30, late: 6, early: 0, weekend: 2, firstDays: 200, lastDays: 1,
    slots: { breakfast: 0, lunch: 0, dinner: 1, snacks: 8, drinks: 1 }, top: { protein: null, kcal: 4, sugars: 2 },
  };
  const t = keys(foodTags({ name: 'Wafer', nutrients: {}, habits }));
  for (const k of ['my-favourite', 'my-regular', 'my-snacks', 'my-late-night', 'my-top-energy', 'my-top-sugar']) assert.ok(t.includes(k), k);
  assert.ok(!t.includes('my-staple') && !t.includes('my-new') && !t.includes('my-not-lately') && !t.includes('my-top-protein'));
  const old = keys(foodTags({ name: 'Wafer', nutrients: {}, habits: { total: 5, lastDays: 40, firstDays: 300 } }));
  assert.ok(old.includes('my-not-lately'));
});

test('unknown values never tag, and nothing leans on a value that is not there', () => {
  assert.deepEqual(foodTags({ nutrients: {} }), []);
  assert.deepEqual(foodTags({ nutrients: {}, facts: {} }), []);
  // Empty calories needs most micronutrients known: sugar with none on record is not called empty.
  assert.ok(!has({ nutrients: { kcal: 400, carbs: 100, sugars: 100, protein: 0, fat: 0 }, basis: 'g' }, 'empty-calories'));
  const known = Object.fromEntries(Object.keys(NUTRIENT).filter((k) => NUTRIENT[k].group === 'vitamin' || NUTRIENT[k].group === 'mineral').map((k) => [k, 0]));
  assert.ok(has({ nutrients: { kcal: 400, carbs: 100, sugars: 100, protein: 0, fat: 0, fibre: 0, ...known }, basis: 'g' }, 'empty-calories'));
});

// ---------- The server ----------

const ZONE = 'Europe/Malta';
const clock = DateTime.fromISO('2027-03-10T20:00', { zone: ZONE });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-tags-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54442 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});
let app; let cookie = ''; let dbmod; let off; let tagsrv;

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
let n = 0;
const id = () => `tagtest-entry-${(n += 1)}-abcdef`;

// A made-up product as Open Food Facts gives it, with the facts the tags read.
const PRODUCT = {
  code: '5000000003334', product_name: 'Test hazelnut spread', brands: 'Test Brand', quantity: '400 g', serving_size: '15 g', serving_quantity: 15,
  nutriments: { 'energy-kcal_100g': 539, carbohydrates_100g: 57.5, sugars_100g: 56.3, proteins_100g: 6.3, fat_100g: 30.9, 'saturated-fat_100g': 10.6, fiber_100g: 3.4, salt_100g: 0.107 },
  countries_tags: ['en:malta'], categories_tags: ['en:spreads', 'en:sweet-spreads'], nutriscore_grade: 'e', nova_group: 4,
  labels_tags: ['en:rainforest-alliance'], allergens_tags: ['en:milk', 'en:nuts', 'en:soybeans'], traces_tags: ['en:gluten'],
  additives_tags: ['en:e322'], ingredients_analysis_tags: ['en:non-vegan', 'en:vegetarian', 'en:palm-oil'], ingredients_n: 7, environmental_score_grade: 'd',
};

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54442 + SHIFT}/oath`;
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
  off = await import('../src/off.js');
  tagsrv = await import('../src/food-tags.js');
  off.setOffSpacing(false);
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  await dbmod?.closeDb?.().catch(() => {});
  await pg.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a product from Open Food Facts keeps its facts and its tags, stored for browsing', async () => {
  const asked = [];
  off.setOffFetch(async (url) => {
    asked.push(url);
    return { ok: true, status: 200, json: async () => ({ status: 1, product: PRODUCT }) };
  });
  const item = await get(`/api/food/barcode/${PRODUCT.code}`).then((r) => r.item);
  assert.match(asked[0], /labels_tags.*allergens_tags.*additives_tags.*ingredients_analysis_tags/);
  assert.deepEqual(item.facts.allergens, ['en:milk', 'en:nuts', 'en:soybeans']);
  const t = keys(item.tags);
  for (const k of ['eat-less', 'ultra-processed', 'sugar-rush', 'contains-milk', 'contains-nuts', 'may-contain-gluten', 'vegetarian', 'palm-oil', 'rainforest-alliance', 'eco-mid', 'sold-in-malta', 'sugar-syrup']) {
    assert.ok(t.includes(k), k);
  }
  const [row] = await dbmod.db()`select tags, tags_v, facts_at from food_items where key = ${item.key}`;
  assert.equal(row.tags_v, TAGS_VERSION);
  assert.ok(row.facts_at, 'when the facts came is kept');
  assert.deepEqual(row.tags, t, 'the stored tags are the shared rules on the record, without habits');
});

test('records tagged under older rules are tagged again, in batches', async () => {
  await post('/api/food/items', { name: 'Test lentils', basis: 'g', nutrients: { kcal: 116, protein: 9, carbs: 13.6, fibre: 7.9, fat: 0.4, sugars: 1.8, salt: 0.005, iron: 3.3 } });
  await dbmod.db()`update food_items set tags = '{}', tags_v = 0`;
  const done = await tagsrv.retagCatalogue({ batch: 1 });
  assert.ok(done >= 2);
  const [{ left }] = await dbmod.db()`select count(*)::int as left from food_items where tags_v < ${TAGS_VERSION}`;
  assert.equal(left, 0);
  const [r] = await dbmod.db()`select tags from food_items where name = 'Test lentils'`;
  // Iron 3.3 mg of 14 is 24% of the reference value: a source. Fibre 7.9 g is high.
  assert.ok(r.tags.includes('source-iron') && r.tags.includes('high-fibre'));
});

test('his habits come from the diary: the food sheet and the diary carry them', async () => {
  const [{ key }] = await dbmod.db()`select key from food_items where barcode = ${PRODUCT.code}`;
  // Five late snacks over the last ten days.
  for (let d = 1; d <= 5; d += 1) {
    const date = clock.minus({ days: d * 2 }).toISODate();
    await post('/api/food/log', { id: id(), key, qty: 15, unit: 'g', date, time: '22:30', slot: 'snacks' });
  }
  const item = await get(`/api/food/items/${encodeURIComponent(key)}`);
  const t = keys(item.tags);
  for (const k of ['my-regular', 'my-snacks', 'my-late-night', 'my-top-sugar']) assert.ok(t.includes(k), k);
  const day = await get(`/api/food/day?date=${clock.minus({ days: 2 }).toISODate()}`);
  assert.ok(day.entries[0].tags.some((x) => x.key === 'my-late-night'));
});

test('the tag browser: every tag with his count and the catalogue count, then one tag down to its foods', async () => {
  const idx = await get('/api/food/tags');
  assert.equal(idx.total, TAGS.length);
  const flat = idx.groups.flatMap((g) => g.tags);
  assert.equal(flat.length, TAGS.length);
  const milk = flat.find((x) => x.key === 'contains-milk');
  assert.equal(milk.mine, 1);
  assert.ok(milk.all >= 1);
  const iron = await get('/api/food/tags/source-iron');
  assert.equal(iron.tag.label, 'Source of iron');
  assert.ok(iron.all.some((x) => x.name === 'Test lentils'));
  assert.equal(iron.all[0].value.key, 'iron');
  // A health-claim tag ranks by the share of the reference value; habits list only his foods.
  const sweet = await get('/api/food/tags/my-late-night');
  assert.equal(sweet.mine.length, 1);
  assert.deepEqual(sweet.all, []);
  assert.equal((await call('GET', '/api/food/tags/not-a-tag')).status, 404);
});

test('products he eats are filled in from Open Food Facts a few at a time, once', async () => {
  const sql = dbmod.db();
  // An older product, saved before Oath asked for facts, that he has logged.
  await sql`update food_items set facts = '{}', facts_at = null, uses = 3 where barcode = ${PRODUCT.code}`;
  let calls = 0;
  off.setOffFetch(async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ status: 1, product: PRODUCT }) };
  });
  const r = await tagsrv.collectFacts({ max: 3 });
  assert.deepEqual(r, { asked: 1, filled: 1 });
  const again = await tagsrv.collectFacts({ max: 3 });
  assert.deepEqual(again, { asked: 0, filled: 0 }, 'filled once');
  assert.equal(calls, 1);
  const [row] = await sql`select facts, uses from food_items where barcode = ${PRODUCT.code}`;
  assert.ok(row.facts.allergens.includes('en:milk'));
  assert.ok(row.uses >= 3, 'his use count is kept');
});

test('a label photo\'s ingredient list becomes facts on the food saved from it', async () => {
  const photo = await import('../src/food-photo.js');
  const facts = photo.ingredientFacts({ count: 6, allergens: ['milk', 'eggs'], traces: ['peanuts'], additives: ['E 471', 'e330', 'aspartame'] });
  assert.deepEqual(facts, { allergens: ['en:milk', 'en:eggs'], traces: ['en:peanuts'], additives: ['en:e471', 'en:e330'], ingredients: 6, from: 'label' });
  assert.equal(photo.ingredientFacts({ count: 0, allergens: [], traces: [], additives: [] }), null);
  const saved = await post('/api/food/label', { name: 'Custard pot', basis: 'g', nutrients: { kcal: 110, protein: 3, carbs: 16, sugars: 12, fat: 3.5, satfat: 2.2, salt: 0.15 }, facts });
  const t = keys(saved.tags);
  assert.ok(t.includes('contains-milk') && t.includes('contains-eggs') && t.includes('may-contain-peanuts') && t.includes('emulsifiers'));
});
