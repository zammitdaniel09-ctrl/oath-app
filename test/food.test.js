// Food, end to end through the API: the blueprint's 20 acceptance scenarios, the photo reader with a
// scripted Claude, Open Food Facts with a stand-in network, the coach's food tools and re-seeding.
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
let clock = DateTime.fromISO('2026-11-02T12:30', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-food-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54356 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let coach; let off; let seed; let engine;

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
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const day = (date) => get(`/api/food/day${date ? `?date=${date}` : ''}`);
const search = async (q, drinks = false) => (await get(`/api/food/search?q=${encodeURIComponent(q)}${drinks ? '&drinks=1' : ''}`)).items;
let n = 0;
const id = () => `test-entry-${(n += 1)}-${Date.now().toString(36)}`;

// Open Food Facts, standing in for the network.
const OFF = new Map();
const offProduct = (code, name, brand, quantity, nm, countries = ['en:malta']) => OFF.set(code, {
  code, product_name: name, brands: brand, quantity, nutriments: nm, countries_tags: countries, categories_tags: ['en:beverages'], last_modified_t: 1790000000,
});
async function fakeOff(url) {
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
  const prod = url.match(/\/product\/(\d+)\.json/);
  if (prod) return OFF.has(prod[1]) ? reply(200, { status: 1, product: OFF.get(prod[1]) }) : reply(404, { status: 0 });
  // The search service: plain words, or field:"value" filters.
  const q = (new URL(url).searchParams.get('q') || '').toLowerCase();
  const field = q.match(/^(\w+):"([^"]+)"$/);
  const words = field ? [] : q.split(/\s+/).filter(Boolean);
  const hits = [...OFF.values()].filter((p) => (field ? (p[field[1]] || []).includes(field[2]) : words.every((w) => `${p.brands} ${p.product_name}`.toLowerCase().includes(w))));
  return reply(200, { hits });
}

// A stand-in for the Anthropic client. A scripted response can be a function of the request.
function scripted(responses) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (params) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      const r = responses.shift();
      if (!r) throw new Error('no scripted response left');
      return typeof r === 'function' ? r(params) : r;
    } } },
  };
}
const said = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
const reading = (over) => ({ kind: 'unclear', summary: '', barcode: null, product: null, label: null, items: [], question: null, ...over });
// One food as the Understand step returns it, and the Choose step's answer.
const PER100 = { kcal: 100, protein: 2, carbs: 20, sugars: 8, fat: 1, satfat: 0.2, fibre: 2, salt: 0.05, caffeine: 0, alcohol: 0 };
const eaten = (over) => ({ name: 'Food', brand: '', variety: '', preparation: '', size: '', amount: 100, unit: 'g', weight: 100, confidence: 'medium', searches: [], per100: PER100, ...over });
const chose = (...picks) => said({ choices: picks.map(([item, key, unit, qty, why = 'Closest record']) => ({ item, key, unit, qty, why })) });
const MEDIUM_BANANA = 'p:1 medium (7" to 7-7/8" long)';
const reply = (stop_reason, content) => ({ stop_reason, content });
let t = 0;
const use = (name, input) => ({ type: 'tool_use', id: `t${(t += 1)}`, name, input });
const turn = (calls, text = 'Done.') => scripted([reply('tool_use', calls), reply('end_turn', [{ type: 'text', text }])]);

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54356 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  engine = await import('../src/engine.js');
  await engine.ensureGame();
  ({ app } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  off = await import('../src/off.js');
  off.setOffFetch(fakeOff);
  off.setOffSpacing(false);
  seed = await import('../src/food-seed.js');
  await seed.seedFood({ force: true });
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);

  offProduct('5000000000011', 'Kinnie', 'Kinnie', '330 ml', { 'energy-kcal_100g': 42, carbohydrates_100g: 10.4, sugars_100g: 10.4, proteins_100g: 0, fat_100g: 0, salt_100g: 0.02 });
  offProduct('5000000000028', 'Kinnie Zest', 'Kinnie', '330 ml', { 'energy-kcal_100g': 2, carbohydrates_100g: 0.4, sugars_100g: 0, proteins_100g: 0, fat_100g: 0, salt_100g: 0.02 });
  offProduct('5000000000035', 'Red Bull Energy Drink', 'Red Bull', '250 ml', { 'energy-kcal_100g': 46, carbohydrates_100g: 11, sugars_100g: 11, proteins_100g: 0, fat_100g: 0, salt_100g: 0.1, caffeine_100g: 0.032 });
  offProduct('5000000000042', 'Red Bull Sugarfree', 'Red Bull', '250 ml', { 'energy-kcal_100g': 3, carbohydrates_100g: 0, sugars_100g: 0, proteins_100g: 0, fat_100g: 0, salt_100g: 0.1, caffeine_100g: 0.032 });
  offProduct('5000000000059', 'Monster Energy', 'Monster', '500 ml', { 'energy-kcal_100g': 47, carbohydrates_100g: 11, sugars_100g: 11, proteins_100g: 0, fat_100g: 0, salt_100g: 0.19, caffeine_100g: 0.032 });
  offProduct('5000000000066', 'Monster Energy Zero Ultra', 'Monster', '500 ml', { 'energy-kcal_100g': 2, carbohydrates_100g: 0.9, sugars_100g: 0, proteins_100g: 0, fat_100g: 0, salt_100g: 0.18 }, ['en:united-kingdom']);
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('1: plain fruit is found first and logged by edible portion or whole weight', async () => {
  for (const [q, key] of [['apple', 'apple-raw-with-skin'], ['banana', 'banana-raw'], ['orange', 'orange-raw'], ['grapes', 'grapes-'], ['watermelon', 'watermelon-raw']]) {
    const [first] = await search(q);
    assert.ok(first.key.startsWith(key), `${q} → ${first.key}`);
    assert.equal(first.kind, 'generic');
    assert.ok(first.units.some((u) => u.unit.startsWith('p:')), `${q} has portions`);
  }
  const b = await post('/api/food/log', { id: id(), key: 'banana-raw', qty: 1, unit: 'p:1 medium (7" to 7-7/8" long)' });
  near(b.entry.grams, 118);
  near(b.entry.nutrients.kcal, 105.02);
  const whole = await post('/api/food/log', { id: id(), key: 'banana-raw', qty: 180, unit: 'whole' });
  near(whole.entry.grams, 115.2);
  assert.match(whole.entry.amountText, /edible part/);
  const w = await post('/api/food/log', { id: id(), key: 'watermelon-raw', qty: 280, unit: 'g' });
  assert.equal(w.entry.slot, 'lunch');
});

test('2: cereal, milk and banana saved as a meal and repeated with another cereal', async () => {
  const lines = [
    { ref: 'item', ref_key: 'granola-dry', qty: 45, unit: 'g' },
    { ref: 'item', ref_key: 'milk-semi-skimmed', qty: 200, unit: 'ml' },
    { ref: 'item', ref_key: 'banana-raw', qty: 80, unit: 'g' },
  ];
  const meal = await post('/api/food/meals', { name: 'Cereal and banana', kind: 'meal', lines });
  const first = await post('/api/food/meals/log', { id: id(), meal_id: meal.id, slot: 'breakfast' });
  const again = await post('/api/food/meals/log', { id: id(), meal_id: meal.id, slot: 'breakfast', swap: { 0: { ref_key: 'cereal-puffed-rice-dry', qty: 30 } } });
  assert.equal(first.entry.lines.length, 3);
  assert.equal(again.entry.lines[0].ref_key, 'cereal-puffed-rice-dry');
  assert.equal(again.entry.lines[1].ref_key, 'milk-semi-skimmed');
  assert.notEqual(Math.round(first.entry.nutrients.kcal), Math.round(again.entry.nutrients.kcal));
  // The saved meal itself is unchanged by the swap.
  const stored = await get(`/api/food/meals/${meal.id}`);
  assert.equal(stored.lines[0].ref_key, 'granola-dry');
});

test('3: scrambled eggs on toast keep the butter and oil', async () => {
  const lines = [
    { ref: 'item', ref_key: 'egg-whole-raw', qty: 2, unit: 'p:1 large' },
    { ref: 'item', ref_key: 'bread-white-sliced-as-sold', qty: 60, unit: 'g' },
    { ref: 'item', ref_key: 'butter-salted', qty: 8, unit: 'g' },
    { ref: 'item', ref_key: 'oil-olive', qty: 5, unit: 'ml' },
  ];
  const r = await post('/api/food/meals/log', { id: id(), lines, name: 'Scrambled eggs on toast', slot: 'breakfast' });
  const butter = r.entry.lines.find((l) => l.ref_key === 'butter-salted');
  const oil = r.entry.lines.find((l) => l.ref_key === 'oil-olive');
  assert.ok(butter.nutrients.fat > 6);
  assert.ok(oil.nutrients.fat > 4);
  near(r.entry.nutrients.fat, r.entry.lines.reduce((a, l) => a + l.nutrients.fat, 0));
});

test('4: bread, rice and pasta say their state, and dry and cooked are different records', async () => {
  const rice = await search('white long grain rice');
  const states = new Set(rice.filter((x) => x.key.startsWith('rice-white-long-grain')).map((x) => x.state));
  assert.ok(states.has('dry') && states.has('cooked'));
  const dry = await post('/api/food/log', { id: id(), key: 'spaghetti-dry', qty: 80, unit: 'g' });
  const cooked = await post('/api/food/log', { id: id(), key: 'spaghetti-cooked', qty: 80, unit: 'g' });
  assert.ok(dry.entry.nutrients.kcal > cooked.entry.nutrients.kcal * 2);
  const bread = await search('bread');
  assert.ok(bread.every((x) => x.state));
});

test('5: crisps from a sharing bag, two biscuits and one bar from a multipack', async () => {
  const crisps = await post('/api/food/items', { name: 'Sharing crisps, sea salt', brand: 'Test', basis: 'g', nutrients: { kcal: 520, protein: 6, carbs: 52, sugars: 0.6, fat: 31, salt: 1.3 }, pack: { size: 150, unit: 'g' } });
  const a = await post('/api/food/log', { id: id(), key: crisps.key, qty: 30, unit: 'g' });
  near(a.entry.nutrients.kcal, 156);
  const biscuits = await post('/api/food/log', { id: id(), key: 'biscuits-digestive-proxy', qty: 2, unit: 'p:1 cracker' });
  near(biscuits.entry.grams, 30);
  const bars = await post('/api/food/items', { name: 'Oat bars', brand: 'Test', basis: 'g', nutrients: { kcal: 430, protein: 7, carbs: 60, sugars: 28, fat: 17 }, pack: { size: 150, unit: 'g', count: 6 } });
  assert.ok(bars.units.some((u) => u.unit === 'each'));
  const one = await post('/api/food/log', { id: id(), key: bars.key, qty: 1, unit: 'each' });
  near(one.entry.grams, 25);
  near(one.entry.nutrients.kcal, 107.5);
});

test('6: a fruit bowl gets yogurt, one fruit is reduced and the totals follow', async () => {
  const bowl = [
    { ref: 'item', ref_key: 'banana-raw', qty: 100, unit: 'g' },
    { ref: 'item', ref_key: 'apple-raw-with-skin', qty: 120, unit: 'g' },
    { ref: 'item', ref_key: 'strawberries-raw', qty: 80, unit: 'g' },
  ];
  const base = await post('/api/food/preview', { lines: bowl });
  const withYogurt = await post('/api/food/preview', { lines: [...bowl, { ref: 'item', ref_key: 'yogurt-plain-whole', qty: 100, unit: 'g' }] });
  const lessBanana = await post('/api/food/preview', { lines: [{ ...bowl[0], qty: 60 }, ...bowl.slice(1), { ref: 'item', ref_key: 'yogurt-plain-whole', qty: 100, unit: 'g' }] });
  assert.ok(withYogurt.nutrients.kcal > base.nutrients.kcal);
  near(withYogurt.nutrients.kcal - lessBanana.nutrients.kcal, 0.4 * 89);
  const saved = await post('/api/food/meals', { name: 'Fruit bowl', kind: 'bowl', lines: bowl });
  assert.equal(saved.priced.length, 3);
});

test('7: a shake is saved, milk swapped for water, powder changed, and half a measured batch logged', async () => {
  const lines = [
    { ref: 'item', ref_key: 'milk-semi-skimmed', qty: 250, unit: 'ml', grp: 'liquid' },
    { ref: 'item', ref_key: 'protein-powder-whey-generic', qty: 30, unit: 'g', grp: 'powder' },
    { ref: 'item', ref_key: 'banana-raw', qty: 100, unit: 'g', grp: 'fruit' },
    { ref: 'item', ref_key: 'oats-rolled-dry', qty: 40, unit: 'g', grp: 'add' },
  ];
  const shake = await post('/api/food/meals', { name: 'My usual shake', kind: 'shake', lines });
  const full = await post('/api/food/meals/log', { id: id(), meal_id: shake.id });
  const water = await post('/api/food/meals/log', { id: id(), meal_id: shake.id, swap: { 0: { ref_key: 'water-tap' } } });
  const milkLine = full.entry.lines[0];
  near(full.entry.nutrients.protein - water.entry.nutrients.protein, milkLine.nutrients.protein - water.entry.lines[0].nutrients.protein);
  const more = await post('/api/food/meals/log', { id: id(), meal_id: shake.id, swap: { 1: { qty: 40 } } });
  assert.ok(more.entry.nutrients.protein > full.entry.nutrients.protein);
  // 600 g blended, 300 g drunk: half of it.
  const half = await post('/api/food/meals/log', { id: id(), meal_id: shake.id, factor: 300 / 600 });
  near(half.entry.nutrients.kcal, full.entry.nutrients.kcal / 2);
});

test('8 and 10: exact energy drinks and soft drinks by brand, never conflated; half a can; unknown caffeine kept', async () => {
  for (const q of ['kinnie', 'red bull', 'monster']) await get(`/api/food/off-search?q=${encodeURIComponent(q)}`);
  const monster = (await search('monster')).filter((x) => x.source === 'off' && x.brand === 'Monster');
  assert.equal(monster.length, 2);
  assert.notEqual(monster[0].barcode, monster[1].barcode);
  const ultra = monster.find((x) => /Zero Ultra/.test(x.name));
  assert.equal(ultra.market, 'UK');
  assert.equal(ultra.nutrients.caffeine, null, 'no caffeine on the record stays unknown');
  const kinnie = (await search('kinnie')).filter((x) => x.source === 'off');
  assert.deepEqual(kinnie.map((x) => x.name).sort(), ['Kinnie', 'Kinnie Zest']);
  const [sf] = (await search('red bull sugarfree')).filter((x) => x.source === 'off');
  assert.ok((await search('red bull')).some((x) => x.source === 'usda' && x.market === 'US'), 'the USDA record stays a separate US reference');
  assert.equal(sf.name, 'Red Bull Sugarfree');
  assert.equal(sf.pack.size, 250);
  const redbull = (await search('red bull energy drink')).find((x) => x.name === 'Red Bull Energy Drink');
  const halfCan = await post('/api/food/log', { id: id(), key: redbull.key, qty: 0.5, unit: 'pack' });
  near(halfCan.entry.ml, 125);
  near(halfCan.entry.nutrients.caffeine, 40);
  const ultraCan = await post('/api/food/log', { id: id(), key: ultra.key, qty: 1, unit: 'pack', slot: 'drinks' });
  assert.equal(ultraCan.entry.nutrients.caffeine, null);
  const d = await day();
  assert.ok(d.total.missing.caffeine >= 1);
  assert.ok(d.drinksMl >= 625);
});

test('the Malta import saves products once, resumes where it stopped, and never duplicates', async () => {
  const count = async () => (await dbmod.db()`select count(*)::int as n from food_items where source = 'off'`)[0].n;
  const first = await off.importMalta({ pages: 30, brandPages: 1 });
  const after = await count();
  assert.ok(first.calls > 0);
  assert.ok(after >= 5);
  const again = await off.importMalta({ pages: 30, brandPages: 1 });
  assert.equal(again.calls, 0, 'a finished import makes no more calls');
  assert.equal(await count(), after);
  const [kinnie] = await dbmod.db()`select market, brand, pack from food_items where barcode = '5000000000011'`;
  assert.equal(kinnie.market, 'Malta');
  assert.equal(kinnie.pack.size, 330);
});

test('products sold in Malta come first, and a record whose energy does not fit its macros is flagged', async () => {
  offProduct('5000000000080', 'Kinnie', 'Kinnie', '330 ml', { 'energy-kcal_100g': 40, carbohydrates_100g: 10, sugars_100g: 10, proteins_100g: 0, fat_100g: 0 }, ['en:germany']);
  offProduct('5000000000097', 'Kinnie', 'Kinnie', '250 ml', { 'energy-kcal_100g': 100, carbohydrates_100g: 10.5, sugars_100g: 10.5, proteins_100g: 0, fat_100g: 0 });
  await get('/api/food/off-search?q=kinnie');
  const list = (await search('kinnie')).filter((x) => x.source === 'off');
  // Among equally good name matches, the ones sold in Malta come first.
  const exact = list.filter((x) => x.name === 'Kinnie');
  const firstAbroad = exact.findIndex((x) => x.market !== 'Malta');
  assert.ok(firstAbroad > 0 && exact.slice(firstAbroad).every((x) => x.market !== 'Malta'), exact.map((x) => x.market).join(','));
  const odd = list.find((x) => x.barcode === '5000000000097');
  assert.match(odd.check, /doesn't match/);
  assert.equal(list.find((x) => x.barcode === '5000000000011').check, null);
  assert.equal((await search('vinegar'))[0].check, null, 'USDA records are not second-guessed');
});

test('9: an unknown imported drink is added from its label and found by barcode next time', async () => {
  assert.equal((await get('/api/food/barcode/4999999999999')).item, null);
  const saved = await post('/api/food/label', {
    name: 'Imported cherry cola', brand: 'Foreign Fizz', barcode: '4999999999999', basis: 'ml', liquid: true,
    nutrients: { kcal: 44, carbs: 11, sugars: 11, protein: 0, fat: 0, salt: 0.01, caffeine: 10 }, pack: { size: 330, unit: 'ml' },
  });
  assert.equal(saved.kind, 'label');
  assert.equal(saved.sourceText, 'Read from a label photo');
  const again = await get('/api/food/barcode/4999999999999');
  assert.equal(again.item.key, saved.key);
  const [first] = await search('cherry cola');
  assert.equal(first.key, saved.key);
  const can = await post('/api/food/log', { id: id(), key: saved.key, qty: 1, unit: 'pack' });
  near(can.entry.nutrients.caffeine, 33);
});

test('11: a filled ftira keeps every part editable', async () => {
  const lines = [
    { ref: 'item', ref_key: 'ftira-bread-as-sold', qty: 120, unit: 'g' },
    { ref: 'item', ref_key: 'tuna-canned-water-light', qty: 90, unit: 'g' },
    { ref: 'item', ref_key: 'tomato-raw', qty: 80, unit: 'g' },
    { ref: 'item', ref_key: 'oil-olive', qty: 5, unit: 'g' },
    { ref: 'item', ref_key: 'olives-black', qty: 15, unit: 'g' },
    { ref: 'item', ref_key: 'capers-drained', qty: 5, unit: 'g' },
  ];
  const ftira = await post('/api/food/meals', { name: 'Tuna ftira', kind: 'meal', lines });
  const r = await post('/api/food/meals/log', { id: id(), meal_id: ftira.id, swap: { 0: { ref_key: 'bread-white-sliced-as-sold', qty: 100 } } });
  assert.deepEqual(r.entry.lines.map((l) => l.ref_key), ['bread-white-sliced-as-sold', 'tuna-canned-water-light', 'tomato-raw', 'oil-olive', 'olives-black', 'capers-drained']);
  assert.ok(r.entry.lines.every((l) => l.nutrients.kcal !== null));
});

test('12: a Maltese dish is found with or without accents, and recipe, estimate and product stay distinct', async () => {
  await post('/api/food/recipes', {
    name: 'Bread with oil and tomato', name_mt: 'Ħobż biż-żejt', servings: 1, family: 'maltese',
    lines: [{ ref: 'item', ref_key: 'hobz-tal-malti-as-sold', qty: 100, unit: 'g', label: 'bread' }, { ref: 'item', ref_key: 'oil-olive', qty: 10, unit: 'g', label: 'olive oil' }],
  });
  for (const q of ['hobz biz zejt', 'Ħobż biż-żejt', 'HOBZ']) {
    const list = (await get(`/api/food/recipes?q=${encodeURIComponent(q)}`)).recipes;
    assert.ok(list.some((r) => r.name_mt === 'Ħobż biż-żejt'), q);
  }
  const bread = (await search('hobz tal-malti'))[0];
  assert.equal(bread.kind, 'estimate');
  OFF.set('5000000000073', { code: '5000000000073', product_name: 'Galletti', brands: 'Maltese Bakery', quantity: '200 g', nutriments: { 'energy-kcal_100g': 400 }, countries_tags: ['en:malta'] });
  const galletti = (await get('/api/food/barcode/5000000000073')).item;
  assert.equal(galletti.kind, 'product');
  assert.equal(galletti.nutrients.protein, null);
});

test('13 and 15: a sauce batch used in a recipe counts once; editing the master never changes snapshots', async () => {
  const sauce = await post('/api/food/recipes', {
    name: 'Test tomato sauce', servings: 4, type: 'component',
    lines: [{ ref: 'item', ref_key: 'tomato-passata', qty: 500, unit: 'g', label: 'passata' }, { ref: 'item', ref_key: 'oil-olive', qty: 20, unit: 'g', label: 'olive oil' }],
  });
  const dish = await post('/api/food/recipes', {
    name: 'Test pasta in sauce', servings: 1,
    lines: [{ ref: 'item', ref_key: 'spaghetti-dry', qty: 80, unit: 'g', label: 'pasta' }, { ref: 'recipe', ref_key: sauce.key, qty: 1, unit: 'serving', label: 'sauce' }],
  });
  const s = await get(`/api/food/recipes/${encodeURIComponent(sauce.key)}`);
  const d = await get(`/api/food/recipes/${encodeURIComponent(dish.key)}`);
  const pasta = d.lines[0].nutrients.kcal;
  near(d.totals.kcal, pasta + s.totals.kcal / 4, 1e-4);
  // A loop is refused.
  const loop = await call('POST', '/api/food/recipes', { key: sauce.key, name: 'Test tomato sauce', servings: 4, lines: [{ ref: 'recipe', ref_key: dish.key, qty: 1, unit: 'serving', label: 'x' }] });
  assert.equal(loop.status, 400);
  // Snapshots: log the dish, cook the sauce, then change the sauce.
  const logged = await post('/api/food/recipes/log', { id: id(), key: dish.key, qty: 1 });
  const batch = await post('/api/food/batches', { key: sauce.key, final_weight: 480, servings: 4 });
  await post('/api/food/recipes', { key: sauce.key, name: 'Test tomato sauce', servings: 4, type: 'component', lines: [{ ref: 'item', ref_key: 'tomato-passata', qty: 500, unit: 'g', label: 'passata' }, { ref: 'item', ref_key: 'oil-olive', qty: 60, unit: 'g', label: 'olive oil' }] });
  const after = await get(`/api/food/recipes/${encodeURIComponent(sauce.key)}`);
  assert.equal(after.version, 2);
  assert.ok(after.totals.kcal > s.totals.kcal);
  const entries = (await day()).entries;
  const still = entries.find((e) => e.id === logged.entry.id);
  near(still.nutrients.kcal, logged.entry.nutrients.kcal);
  const b = await get(`/api/food/batches/${batch.id}`);
  near(b.nutrients.kcal, s.totals.kcal, 1e-4);
  assert.equal(b.recipeVersion, 1);
});

test('14: a 1,600 g batch, 300 g today and 250 g tomorrow: 550/1,600 used, 1,050 g left', async () => {
  const r = await post('/api/food/recipes', {
    name: 'Test chilli', servings: 6,
    lines: [{ ref: 'item', ref_key: 'tomato-passata', qty: 800, unit: 'g', label: 'passata' }, { ref: 'item', ref_key: 'spaghetti-dry', qty: 300, unit: 'g', label: 'pasta' }],
  });
  const batch = await post('/api/food/batches', { key: r.key, final_weight: 1600, servings: 6 });
  const a = await post('/api/food/batches/log', { id: id(), batch_id: batch.id, qty: 300, unit: 'g' });
  setLocal('2026-11-03T13:00');
  const b = await post('/api/food/batches/log', { id: id(), batch_id: batch.id, qty: 250, unit: 'g' });
  assert.equal(a.entry.date, '2026-11-02');
  assert.equal(b.entry.date, '2026-11-03');
  near(a.entry.share + b.entry.share, 550 / 1600);
  near(a.entry.nutrients.kcal + b.entry.nutrients.kcal, batch.nutrients.kcal * (550 / 1600), 1e-4);
  assert.equal(b.batch.left.g, 1050);
  const tooMuch = await call('POST', '/api/food/batches/log', { id: id(), batch_id: batch.id, qty: 1100, unit: 'g' });
  assert.equal(tooMuch.status, 400);
  setLocal('2026-11-02T12:30');
});

test('16: a plan for tomorrow adds nothing today and becomes a real entry once eaten', async () => {
  const before = (await day()).total.kcal;
  const plan = await post('/api/food/plans', { kind: 'item', ref_key: 'banana-raw', qty: 120, unit: 'g', date: '2026-11-03', slot: 'snacks' });
  assert.equal((await day()).total.kcal, before);
  setLocal('2026-11-03T16:00');
  const tomorrow = await day();
  assert.ok(tomorrow.plans.some((p) => p.id === plan.id));
  const eaten = await post(`/api/food/plans/${plan.id}/eat`, { id: id() });
  near(eaten.entry.grams, 120);
  assert.equal(eaten.entry.planId, plan.id);
  const twice = await post(`/api/food/plans/${plan.id}/eat`, { id: id() });
  assert.equal(twice.entry.id, eaten.entry.id);
  assert.ok(!(await day()).plans.some((p) => p.id === plan.id));
  setLocal('2026-11-02T12:30');
});

test('17: an unavailable item stays missing: no silent substitute, a custom food or quick add instead', async () => {
  assert.deepEqual(await search('zzqx unicorn snack'), []);
  assert.deepEqual((await get('/api/food/off-search?q=zzqx%20unicorn')).items, []);
  const noEnergy = await call('POST', '/api/food/items', { name: 'Unicorn snack', nutrients: { protein: 3 } });
  assert.equal(noEnergy.status, 400);
  const custom = await post('/api/food/items', { name: 'Unicorn snack', nutrients: { kcal: 480, protein: 3 } });
  assert.equal(custom.kind, 'custom');
  assert.equal(custom.nutrients.sugars, null);
  const quick = await post('/api/food/quick', { id: id(), name: 'Something at a party', kcal: 250 });
  assert.equal(quick.entry.nutrients.protein, null);
  assert.equal((await search('something at a party')).length, 0, 'quick adds never enter the catalogue');
});

test('18: an offline repeat of a saved fruit bowl syncs exactly once', async () => {
  const bowl = await post('/api/food/meals', { name: 'Offline bowl', kind: 'bowl', lines: [{ ref: 'item', ref_key: 'banana-raw', qty: 100, unit: 'g' }] });
  const entryId = id();
  const ops = [{ id: entryId, op: 'meal', data: { id: entryId, meal_id: bowl.id } }, { id: 'q-bad', op: 'log', data: { id: id(), key: 'not-a-food', qty: 1, unit: 'g' } }];
  const first = await post('/api/food/sync', { ops });
  const second = await post('/api/food/sync', { ops });
  assert.equal(first.results[0].ok, true);
  assert.equal(first.results[1].ok, false);
  assert.equal(second.results[0].duplicate, true);
  const [{ count }] = await dbmod.db()`select count(*)::int as count from food_log where id = ${entryId}`;
  assert.equal(count, 1);
});

test('19: sugar and caffeine show incomplete data, and food never touches HP', async () => {
  const hpBefore = (await engine.getGame()).hp;
  const misses = (await dbmod.db()`select count(*)::int as n from misses`)[0].n;
  await post('/api/food/quick', { id: id(), name: 'Mystery drink', kcal: 120, ml: 330 });
  const d = await day();
  assert.ok(d.total.missing.sugars >= 1);
  assert.ok(d.total.missing.caffeine >= 1);
  assert.equal((await engine.getGame()).hp, hpBefore);
  assert.equal((await dbmod.db()`select count(*)::int as n from misses`)[0].n, misses);
});

test('20: re-running the seed keeps ids, adds nothing twice and keeps favourites; the report is honest', async () => {
  await post('/api/food/items/banana-raw/favourite', { on: true });
  const count = async () => (await dbmod.db()`select (select count(*)::int from food_items) as items, (select count(*)::int from recipes) as recipes,
    (select count(*)::int from recipe_lines) as lines, (select count(*)::int from food_requirements) as reqs`)[0];
  const ids = async () => (await dbmod.db()`select key, id from food_items where key in ('banana-raw', 'spaghetti-dry', 'water-tap') order by key`);
  const before = await count();
  const idsBefore = await ids();
  const uses = (await dbmod.db()`select uses from food_items where key = 'banana-raw'`)[0].uses;
  await seed.seedFood({ force: true });
  await seed.seedFood({ force: true });
  assert.deepEqual(await count(), before);
  assert.deepEqual(await ids(), idsBefore);
  const [banana] = await dbmod.db()`select favourite, uses from food_items where key = 'banana-raw'`;
  assert.equal(banana.favourite, true);
  assert.equal(banana.uses, uses);
  const skipped = await seed.seedFood();
  assert.equal(skipped.skipped, true);
  const r = await get('/api/food/report');
  assert.equal(r.foods.total, 575);
  assert.equal(r.recipes.total, 373);
  assert.ok(r.foods.matched > 350);
  assert.ok(r.foods.categories.some((c) => c.open.some((o) => o.state === 'gap' || o.state === 'missing')));
});

test('photo: a label becomes a draft to check, a plate is matched to records with estimated amounts, a barcode finds the product', async () => {
  const label = scripted([said(reading({ kind: 'label', summary: 'A nutrition table', product: { name: 'Lemon soda', brand: 'Fizz', variant: null, pack_size: 330, pack_unit: 'ml', pack_count: null },
    label: { basis: '100ml', serving_size: null, serving_unit: null, serving_label: null, kcal: 38, kj: 160, protein: 0, carbs: 9.4, sugars: 9.4, fat: 0, satfat: 0, fibre: null, salt: 0.02, caffeine_mg: null } }))]);
  coach.setCoachClient(label);
  const l = await post('/api/food/photo', { image: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' });
  assert.equal(l.kind, 'label');
  assert.equal(l.draft.basis, 'ml');
  assert.equal(l.draft.nutrients.kcal, 38);
  assert.equal(l.draft.nutrients.fibre, null);
  assert.equal(l.draft.pack.size, 330);
  assert.equal(label.requests[0].output_config.format.type, 'json_schema');
  assert.equal(label.requests[0].messages[0].content[0].type, 'image');

  // A plate: the reading understands each food, then one more call chooses the records.
  const plate = scripted([
    said(reading({ kind: 'meal', summary: 'Rice and a banana', items: [
      eaten({ name: 'Banana', searches: ['banana raw', 'banana'], amount: 1, unit: 'piece', weight: 118, confidence: 'high' }),
      eaten({ name: 'White rice', preparation: 'boiled', searches: ['white rice cooked', 'rice'], amount: 180, weight: 180 }),
    ] })),
    chose([0, 'banana-raw', MEDIUM_BANANA, 1, 'A medium banana'], [1, 'rice-white-long-grain-cooked', 'g', 180, 'Cooked white rice, as eaten']),
  ]);
  coach.setCoachClient(plate);
  const m = await post('/api/food/photo', { image: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' });
  assert.equal(m.kind, 'meal');
  assert.equal(m.items[0].match.key, 'banana-raw');
  assert.equal(m.items[0].unit, MEDIUM_BANANA);
  assert.equal(m.items[0].why, 'A medium banana');
  assert.equal(m.items[1].match.state, 'cooked');
  assert.equal(m.items[1].qty, 180);
  assert.ok(m.items.every((x) => x.estimate && x.fill && 'brand' in x && 'size' in x && x.why));
  assert.equal(plate.requests.length, 2, 'one reading, one choice for all items');
  const photoItem = plate.requests[0].output_config.format.schema.properties.items.items.properties;
  assert.ok(photoItem.per100 && photoItem.brand && photoItem.size && photoItem.searches, 'the photo reading understands each food in detail');
  const choice = plate.requests[1];
  assert.equal(choice.output_config.format.type, 'json_schema');
  assert.match(choice.messages[0].content[0].text, /Item 0: name "Banana"[\s\S]*key banana-raw/);
  assert.match(choice.messages[0].content[0].text, /Item 1: name "White rice"[\s\S]*key rice-white-long-grain-cooked/);

  coach.setCoachClient(scripted([said(reading({ kind: 'barcode', summary: 'A can', barcode: '5000000000011' }))]));
  const b = await post('/api/food/photo', { image: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' });
  assert.equal(b.kind, 'product-unknown', 'a barcode with a bad check digit is not trusted');
  offProduct('5000000000043', 'Test Cola', 'Testco', '330 ml', { 'energy-kcal_100g': 42, sugars_100g: 10.6 });
  coach.setCoachClient(scripted([said(reading({ kind: 'barcode', summary: 'A can', barcode: '5000000000043' }))]));
  const c = await post('/api/food/photo', { image: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' });
  assert.equal(c.kind, 'product');
  assert.equal(c.item.barcode, '5000000000043');
  assert.equal(c.item.pack.size, 330);
});

test('coach: finds and logs food with a receipt, and removing an entry waits for a tap', async () => {
  coach.setCoachClient(turn([use('search_food', { query: 'banana' })], 'Found it.'));
  await post('/api/coach', { text: 'find banana' });
  coach.setCoachClient(turn([use('log_food', { key: 'banana-raw', qty: 1, unit: 'p:1 medium (7" to 7-7/8" long)', slot: 'snacks' })], 'Logged.'));
  const r = await post('/api/coach', { text: 'I had a banana' });
  assert.match(r.reply.actions[0].text, /^Logged Banana, .* \(105 kcal\)$/);
  const [e] = await dbmod.db()`select id from food_log where source = 'coach' order by created_at desc limit 1`;
  coach.setCoachClient(turn([use('remove_food_entry', { entry_id: e.id })], 'Tap Confirm to remove it.'));
  const pend = await post('/api/coach', { text: 'remove the banana' });
  assert.equal(pend.reply.pending.length, 1);
  assert.equal((await dbmod.db()`select deleted_at from food_log where id = ${e.id}`)[0].deleted_at, null);
  await post(`/api/coach/pending/${pend.reply.pending[0].id}`, { confirm: true });
  assert.ok((await dbmod.db()`select deleted_at from food_log where id = ${e.id}`)[0].deleted_at);
});

test('describe: typed words become catalogue matches with estimated amounts; a food with no record keeps a rough estimate', async () => {
  const wrap = { kcal: 200, protein: 10, carbs: 25, sugars: 2, fat: 8, satfat: 3, fibre: 2, salt: 1.2, caffeine: 0, alcohol: 0 };
  const typed = scripted([
    said({ kind: 'meal', summary: 'A banana and a wrap', question: null, items: [
      eaten({ name: 'Banana', searches: ['banana'], amount: 1, unit: 'piece', weight: 118, confidence: 'high' }),
      eaten({ name: 'Zzqx mystery wrap', searches: ['zzqx wrap'], amount: 300, weight: 300, confidence: 'low', per100: wrap }),
    ] }),
    chose([0, 'banana-raw', MEDIUM_BANANA, 1, 'A medium banana'], [1, '', 'g', 300, 'Nothing like it in the catalogue']),
  ]);
  coach.setCoachClient(typed);
  const r = await post('/api/food/describe', { text: 'a banana and a zzqx mystery wrap' });
  assert.equal(r.kind, 'meal');
  assert.equal(r.source, 'text');
  assert.equal(r.items[0].match.key, 'banana-raw');
  assert.equal(r.items[0].unit, MEDIUM_BANANA);
  assert.equal(r.items[0].qty, 1);
  assert.ok(r.items.every((x) => x.estimate));
  assert.equal(r.items[1].match, null);
  assert.equal(r.items[1].qty, 300);
  assert.deepEqual(r.items[1].fill, { basis: 'g', ...wrap });
  // The whole amount, worked out from the profile per 100: every value, so a quick add is complete.
  assert.deepEqual(r.items[1].guess, { kcal: 600, protein: 30, carbs: 75, sugars: 6, fat: 24, satfat: 9, fibre: 6, salt: 3.6, caffeine: 0, alcohol: 0, amount: 300, unit: 'g', weight: 300 });
  const req = typed.requests[0];
  assert.equal(req.output_config.format.type, 'json_schema');
  const props = req.output_config.format.schema.properties.items.items.properties;
  for (const k of ['brand', 'variety', 'preparation', 'size', 'amount', 'unit', 'weight', 'searches', 'per100']) assert.ok(props[k], `every item carries ${k}`);
  // Every value per 100, the core ones first, then the fats, minerals and vitamins: all 33.
  const per100Keys = Object.keys(props.per100.properties);
  assert.deepEqual(per100Keys.slice(0, 10), ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'fibre', 'salt', 'satfat', 'caffeine', 'alcohol']);
  assert.deepEqual([...per100Keys].sort(), (await import('../public/nutrition.js')).KEYS.slice().sort());
  assert.deepEqual(props.per100.required, per100Keys);
  assert.equal(req.messages[0].content.length, 1);
  assert.equal(req.messages[0].content[0].type, 'text');
  assert.equal(req.messages[0].content[0].text, 'a banana and a zzqx mystery wrap');

  coach.setCoachClient(scripted([said({ kind: 'unclear', summary: '', items: [], question: null })]));
  const not = await post('/api/food/describe', { text: 'my car keys' });
  assert.equal(not.kind, 'unclear');
  assert.match(not.question, /food or drink/);
  coach.setCoachClient(scripted([said({ kind: 'unclear', summary: '', items: [], question: 'Which pastizzi, ricotta or peas?' })]));
  assert.equal((await post('/api/food/describe', { text: 'pastizzi' })).question, 'Which pastizzi, ricotta or peas?');
  assert.equal((await call('POST', '/api/food/describe', { text: '   ' })).status, 400);
});

test('quick add: an estimate is marked as one and keeps its rough amount; unknown macros stay unknown', async () => {
  const q = await post('/api/food/quick', { id: id(), name: 'Zzqx mystery wrap', kcal: 640, protein: 32, carbs: 70, estimate: true, amount: 'about 300 g', slot: 'lunch' });
  assert.equal(q.entry.kind, 'quick');
  assert.equal(q.entry.estimate, true);
  assert.equal(q.entry.amountText, 'about 300 g');
  assert.equal(q.entry.nutrients.fat, null);
  const plain = await post('/api/food/quick', { id: id(), name: 'Biscuit', kcal: 80 });
  assert.equal(plain.entry.estimate, false);
  const d = await day();
  assert.equal(d.entries.find((e) => e.id === q.entry.id).estimate, true);
  assert.ok(d.estimates >= 1);
});

test('history: gaps stay gaps, averages use logged days only, incomplete days are flagged, the period before is compared', async () => {
  setLocal('2027-03-10T20:00');
  const qa = (date, time, over) => post('/api/food/quick', { id: id(), date, time, ...over });
  const full = (kcal, protein) => ({ kcal, protein, carbs: 100, sugars: 20, fat: 40, fibre: 8, salt: 1, caffeine: 0 });
  await qa('2027-03-05', '08:00', { name: 'Porridge', ...full(400, 15) });
  await qa('2027-03-05', '19:00', { name: 'Dinner', ...full(1400, 60) });
  const gone = await qa('2027-03-06', '12:00', { name: 'Deleted later', ...full(900, 30) });
  assert.equal((await call('DELETE', `/api/food/log/${gone.entry.id}`)).status, 200);
  await qa('2027-03-07', '12:00', { name: 'Party food', kcal: 1800 });
  await qa('2027-03-09', '08:00', { name: 'Porridge', ...full(400, 15) });
  await qa('2027-03-09', '13:00', { name: 'Lunch', ...full(1600, 85) });
  await qa('2027-03-10', '08:30', { name: 'Espresso', ...full(2, 0.1), caffeine: 80, ml: 30 });
  await qa('2027-03-10', '15:10', { name: 'Mystery can', kcal: 120, ml: 330 });
  await qa('2027-03-01', '12:00', { name: 'Big day', ...full(2500, 100) });

  const h = await get('/api/food/history?days=7');
  assert.equal(h.days, 7);
  assert.deepEqual([h.from, h.to, h.prevFrom, h.prevTo], ['2027-03-04', '2027-03-10', '2027-02-25', '2027-03-03']);
  assert.deepEqual(h.series.map((d) => d.date), ['2027-03-04', '2027-03-05', '2027-03-06', '2027-03-07', '2027-03-08', '2027-03-09', '2027-03-10']);
  const on = (date) => h.series.find((d) => d.date === date);
  for (const gap of ['2027-03-04', '2027-03-06', '2027-03-08']) {
    assert.equal(on(gap).logged, false, gap);
    assert.equal(on(gap).kcal, null, `${gap} is a gap, not zero`);
    assert.equal(on(gap).incomplete, false);
  }
  assert.equal(on('2027-03-05').kcal, 1800);
  assert.equal(on('2027-03-05').incomplete, false);
  assert.equal(on('2027-03-07').incomplete, true);
  assert.equal(on('2027-03-07').protein, null);
  assert.equal(on('2027-03-10').drinksMl, 360);
  // Today is drawn but not averaged: (1800 + 1800 + 2000) / 3 logged days.
  assert.equal(h.loggedDays, 3);
  near(h.avg.kcal, 5600 / 3, 0.01);
  near(h.avg.protein, (75 + 100) / 2, 0.01);
  assert.equal(h.avg.missing.protein, 1, 'one averaged day had no protein value');
  assert.equal(h.avg.missing.kcal, undefined);
  assert.equal(h.prev.loggedDays, 1);
  assert.equal(h.prev.avg.kcal, 2500);
  assert.deepEqual(h.top[0], { name: 'Porridge', kind: 'quick', count: 2 });
  assert.ok(!h.top.some((x) => x.name === 'Deleted later'));
  // Today by hour: known caffeine is counted, a drink with no caffeine value is counted apart.
  assert.equal(h.chosen.date, '2027-03-10');
  assert.equal(h.chosen.today, true);
  assert.equal(h.chosen.hours.caffeine[8], 80);
  assert.equal(h.chosen.hours.caffeineUnknown[15], 1);
  assert.equal(h.chosen.hours.caffeine[15], 0);
  assert.equal(h.chosen.hours.drinksMl[15], 330);
  assert.equal(h.chosen.caffeine, 80);
  assert.equal(h.chosen.missing.caffeine, 1);

  const past = await get('/api/food/history?days=7&date=2027-03-09');
  assert.equal(past.chosen.date, '2027-03-09');
  assert.equal(past.chosen.today, false);
  assert.equal(past.chosen.kcal, 2000);
  const month = await get('/api/food/history?days=30');
  assert.equal(month.series.length, 30);
  assert.equal(month.prevTo, '2027-02-08');
  assert.equal((await get('/api/food/history?days=13')).days, 7);
  assert.equal((await call('GET', '/api/food/history?date=nope')).status, 400);
  setLocal('2026-11-02T12:30');
});
