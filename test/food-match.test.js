// Matching what Daniel ate to the most specific record: Understand, Retrieve and Choose with a
// scripted Claude, the local choice when the AI gives none, and fills for what a record lacks.
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
const clock = DateTime.fromISO('2026-11-02T19:30', { zone: ZONE });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-match-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54358 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let coach; let food; let photo;

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
let n = 0;
const id = () => `match-entry-${(n += 1)}-${Date.now().toString(36)}`;

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
const refused = { stop_reason: 'refusal', content: [] };
const typed = (summary, items) => said({ kind: 'meal', summary, question: null, items });
const eaten = (over) => ({
  name: 'Food', brand: '', variety: '', preparation: '', size: '', amount: 100, unit: 'g', weight: 100, confidence: 'medium', searches: [],
  per100: { kcal: 100, protein: 2, carbs: 20, sugars: 8, fat: 1, satfat: 0.2, fibre: 2, salt: 0.05, caffeine: 0, alcohol: 0 }, ...over,
});
const chose = (...picks) => said({ choices: picks.map(([item, key, unit, qty, why = 'Closest record']) => ({ item, key, unit, qty, why })) });
const askedText = (c, i) => c.requests[i].messages[0].content[0].text;

// Stand-ins for restaurant records as the full USDA import has them: per 100 g, with each size as a portion.
const BK = 'test-bk-french-fries';
const MCD = 'test-mcd-french-fries';
const FRIES = { kcal: 280, protein: 3.2, carbs: 37, sugars: null, fat: 13, satfat: 2, fibre: null, salt: 0.6, caffeine: 0, alcohol: 0 };
const FRIES_EST = { kcal: 300, protein: 3.4, carbs: 38, sugars: 0.3, fat: 14, satfat: 2.2, fibre: 3.5, salt: 0.7, caffeine: 0, alcohol: 0 };
const largeFries = (brand) => eaten({
  name: 'fries', brand, preparation: 'deep fried', size: 'large', amount: 160, weight: 160, confidence: 'high',
  searches: [`${brand.toLowerCase()} french fries`, 'french fries', 'chips'], per100: FRIES_EST,
});
const GRAPES = { kcal: 69, protein: 0.7, carbs: 17, sugars: 15, fat: 0.2, satfat: 0.05, fibre: 0.9, salt: 0.01, caffeine: 0, alcohol: 0 };
const mediumGrapes = eaten({ name: 'grapes', size: 'medium', preparation: 'raw', amount: 150, weight: 150, searches: ['grapes raw', 'grapes'], per100: GRAPES });

// Every object closed and no numeric or length constraints: what structured outputs accept.
function strictSchema(s, where = 'schema') {
  assert.ok(!/"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minLength|maxLength|minItems|maxItems)"/.test(JSON.stringify(s)), `${where} has an unsupported constraint`);
  const walk = (x, at) => {
    if (!x || typeof x !== 'object') return;
    if (x.type === 'object') {
      assert.equal(x.additionalProperties, false, `${at} is not closed`);
      assert.deepEqual([...x.required].sort(), Object.keys(x.properties).sort(), `${at} leaves a property optional`);
    }
    for (const [k, v] of Object.entries(x)) walk(v, `${at}.${k}`);
  };
  walk(s, where);
}

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54358 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  await (await import('../src/engine.js')).ensureGame();
  ({ app } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  food = await import('../src/food.js');
  photo = await import('../src/food-photo.js');
  await (await import('../src/food-seed.js')).seedFood({ force: true });
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
  await food.upsertItem({
    key: BK, kind: 'product', name: 'French fries', brand: 'Burger King', state: 'fried', category: 'fast food', basis: 'g', source: 'usda', nutrients: FRIES,
    portions: [{ label: '1 small serving', g: 89, source: 'usda' }, { label: '1 medium serving', g: 116, source: 'usda' }, { label: '1 large serving', g: 154, source: 'usda' }],
  });
  await food.upsertItem({
    key: MCD, kind: 'product', name: 'French fries', brand: "McDonald's", state: 'fried', category: 'fast food', basis: 'g', source: 'usda', nutrients: { ...FRIES, kcal: 323, sugars: 0.2 },
    portions: [{ label: '1 small serving', g: 71, source: 'usda' }, { label: '1 medium serving', g: 111, source: 'usda' }, { label: '1 large serving', g: 150, source: 'usda' }],
  });
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('large fries from Burger King: the restaurant\'s own record and its large serving, chosen from a shortlist', async () => {
  const c = scripted([typed('Large Burger King fries', [largeFries('Burger King')]), chose([0, BK, 'p:1 large serving', 1, "Burger King's own large fries"])]);
  coach.setCoachClient(c);
  const r = await post('/api/food/describe', { text: 'I ate a portion of fries, large fries, from Burger King' });
  assert.equal(r.items.length, 1);
  const [it] = r.items;
  assert.equal(it.match.key, BK);
  assert.equal(it.unit, 'p:1 large serving');
  assert.equal(it.qty, 1);
  assert.equal(it.brand, 'Burger King');
  assert.equal(it.size, 'large');
  assert.equal(it.why, "Burger King's own large fries");
  assert.equal(it.estimate, true);
  assert.deepEqual(it.fill, { basis: 'g', ...FRIES_EST });
  assert.ok(!it.alternatives.some((a) => a.key === BK));
  assert.ok(it.alternatives.some((a) => a.key === 'chips-takeaway'), 'the generic fries were offered too, and lost');

  // Two calls: understand, then one choice. The choice hears what he said and a ranked shortlist with
  // the brand's own record first, its portions written out.
  assert.equal(c.requests.length, 2);
  const ask = askedText(c, 1);
  assert.match(ask, /I ate a portion of fries, large fries, from Burger King/);
  assert.match(ask, /Item 0: name "fries", brand or restaurant "Burger King", preparation "deep fried", size words "large", estimated 160 g/);
  assert.match(ask, /p:1 large serving \(154 g\)/);
  const at = (key) => ask.indexOf(`key ${key} `);
  assert.ok(at(BK) >= 0 && at(BK) < at('chips-takeaway') && at(BK) < at(MCD), 'the brand\'s record leads the shortlist');
  assert.ok((ask.match(/^ {2}- key /gm) || []).length <= 12, 'a shortlist of about 12');
  strictSchema(c.requests[0].output_config.format.schema, 'understand');
  strictSchema(c.requests[1].output_config.format.schema, 'choose');
});

test('without the AI\'s choice, the local score still picks Burger King\'s large serving, and never another restaurant\'s', async () => {
  coach.setCoachClient(scripted([typed('Large Burger King fries', [largeFries('Burger King')]), refused]));
  const r = await post('/api/food/describe', { text: 'large fries from Burger King' });
  const [it] = r.items;
  assert.equal(it.match.key, BK);
  assert.equal(it.unit, 'p:1 large serving');
  assert.equal(it.qty, 1);
  assert.match(it.why, /^Burger King's own record, 1 large serving$/);

  // A restaurant the catalogue lacks: not Burger King's or McDonald's fries, but the general record
  // with its own large portion, and the reason.
  coach.setCoachClient(scripted([typed("Large Five Guys fries", [largeFries("Five Guys")]), refused]));
  const w = (await post('/api/food/describe', { text: "large fries from Five Guys" })).items[0];
  assert.ok(w.match, 'a general record is better than nothing');
  assert.ok(![BK, MCD].includes(w.match.key), w.match.key);
  assert.equal(w.match.brand, null);
  assert.match(w.why, /^No Five Guys record in the catalogue, so the closest general one/);
  assert.match(w.unit, /^p:.*\blarge\b/);
});

test('medium grapes: a grape record and a fitting portion; a unit the record cannot take is never kept', async () => {
  const c = scripted([typed('Medium grapes', [mediumGrapes]), (params) => {
    const key = params.messages[0].content[0].text.match(/key (grapes-[a-z]+-raw) /)[1];
    return chose([0, key, 'p:1 US cup', 1, 'A medium bowl of grapes is about a cup']);
  }]);
  coach.setCoachClient(c);
  const [it] = (await post('/api/food/describe', { text: 'I ate grapes, a medium size' })).items;
  assert.match(it.match.key, /^grapes-(red|green)-raw$/);
  assert.equal(it.unit, 'p:1 US cup');
  assert.equal(it.qty, 1);
  assert.equal(it.size, 'medium');
  assert.equal(it.why, 'A medium bowl of grapes is about a cup');
  assert.ok(it.alternatives.some((a) => /^grapes-(red|green)-raw$/.test(a.key)), 'the other grapes are an alternative');
  assert.match(askedText(c, 1), /p:10 grapes \(49 g\)/);
  assert.ok(!/key (juice-grape|grapefruit-raw) /.test(askedText(c, 1)), 'grape juice and grapefruit are not grapes');

  // A portion the record does not have: the record stands, the amount goes back to the estimate.
  coach.setCoachClient(scripted([typed('Medium grapes', [mediumGrapes]), chose([0, 'grapes-red-raw', 'p:1 medium bunch', 1])]));
  const bad = (await post('/api/food/describe', { text: 'medium grapes' })).items[0];
  assert.equal(bad.match.key, 'grapes-red-raw');
  assert.equal(bad.unit, 'g');
  assert.equal(bad.qty, 150);
  // A key that is not on the list: the local choice stands.
  coach.setCoachClient(scripted([typed('Medium grapes', [mediumGrapes]), chose([0, 'grapes-purple-raw', 'g', 150])]));
  const made = (await post('/api/food/describe', { text: 'medium grapes' })).items[0];
  assert.match(made.match.name, /^(red |green )?grapes\b/i);
  assert.equal(made.match.state, 'raw');
  // And with no answer at all.
  coach.setCoachClient(scripted([typed('Medium grapes', [mediumGrapes]), refused]));
  const local = (await post('/api/food/describe', { text: 'medium grapes' })).items[0];
  assert.match(local.match.name, /^(red |green )?grapes\b/i);
  assert.equal(local.match.state, 'raw');
  assert.equal(local.unit, 'g');
  assert.equal(local.qty, 150);
});

test('fills apply only to what the record lacks, are listed in filled, and stay off without an estimate', async () => {
  const fill = { basis: 'g', ...FRIES_EST };
  const e = (await post('/api/food/log', { id: id(), key: BK, qty: 1, unit: 'p:1 large serving', estimate: true, fill })).entry;
  assert.deepEqual(e.filled, ['sugars', 'fibre']);
  // The record's own values stay, even where the estimate says otherwise.
  near(e.nutrients.kcal, 280 * 1.54);
  near(e.nutrients.protein, 3.2 * 1.54);
  near(e.nutrients.fat, 13 * 1.54);
  near(e.nutrients.salt, 0.6 * 1.54);
  // The gaps come from the estimate, scaled to the amount; sugars follow the record's own carbs.
  near(e.nutrients.fibre, 3.5 * 1.54);
  near(e.nutrients.sugars, (37 * 1.54 * 0.3) / 38);
  assert.equal(e.estimate, true);
  const d = await get('/api/food/day');
  assert.deepEqual(d.entries.find((x) => x.id === e.id).filled, ['sugars', 'fibre'], 'the day view keeps the mark');
  assert.ok(!d.total.missing?.sugars, 'no missing sugar on the day');

  const plain = (await post('/api/food/log', { id: id(), key: BK, qty: 1, unit: 'p:1 large serving' })).entry;
  assert.equal(plain.nutrients.sugars, null);
  assert.deepEqual(plain.filled, []);
  const full = (await post('/api/food/log', { id: id(), key: 'banana-raw', qty: 100, unit: 'g', fill })).entry;
  assert.deepEqual(full.filled, [], 'a record that knows everything takes nothing');
  near(full.nutrients.kcal, 89);
  const odd = (await post('/api/food/log', { id: id(), key: BK, qty: 100, unit: 'g', fill: { sugars: -4, fibre: 'lots' } })).entry;
  assert.deepEqual(odd.filled, [], 'values that are not believable are never stored');
  assert.equal(odd.nutrients.fibre, null);

  // A drink's estimate is per 100 ml and fills by volume.
  await food.upsertItem({ key: 'test-mystery-cola', kind: 'product', name: 'Mystery cola', basis: 'ml', liquid: true, source: 'off', nutrients: { kcal: 42, carbs: 10.6 } });
  const can = (await post('/api/food/log', { id: id(), key: 'test-mystery-cola', qty: 330, unit: 'ml', fill: { basis: 'ml', kcal: 40, sugars: 10.6, carbs: 10.6, caffeine: 10, salt: 0.02 } })).entry;
  assert.deepEqual(can.filled, ['sugars', 'salt', 'caffeine']);
  near(can.nutrients.caffeine, 33);
  near(can.nutrients.kcal, 138.6);
});

test('a food with no record keeps its whole estimate, and its quick add stores all of it, marked', async () => {
  const wrap = { kcal: 200, protein: 10, carbs: 25, sugars: 2, fat: 8, satfat: 3, fibre: 2, salt: 1.2, caffeine: 0, alcohol: 0 };
  coach.setCoachClient(scripted([typed('A mystery wrap', [eaten({ name: 'Zzqx mystery wrap', searches: ['zzqx wrap'], amount: 300, weight: 300, per100: wrap })]), chose([0, '', 'g', 300, 'Nothing like it'])]));
  const [it] = (await post('/api/food/describe', { text: 'a zzqx mystery wrap' })).items;
  assert.equal(it.match, null);
  assert.ok(it.why);
  assert.equal(it.guess.sugars, 6);
  assert.equal(it.guess.salt, 3.6);

  // The phone can send the estimate itself: every value is worked out and marked as filled.
  const q = (await post('/api/food/quick', { id: id(), name: it.name, fill: it.fill, grams: it.guess.weight, estimate: true, amount: 'about 300 g' })).entry;
  assert.equal(q.kind, 'quick');
  assert.equal(q.estimate, true);
  assert.equal(q.nutrients.kcal, 600);
  for (const k of food.FILL_KEYS) assert.notEqual(q.nutrients[k], null, `${k} is stored`);
  assert.deepEqual(q.filled, food.FILL_KEYS);
  assert.equal(q.amountText, 'about 300 g');
  // Or the whole-amount values; what he typed wins over the estimate.
  const values = Object.fromEntries(food.FILL_KEYS.map((k) => [k, it.guess[k]]));
  const q2 = (await post('/api/food/quick', { id: id(), name: it.name, ...values, kcal: 550, estimate: true, fill: it.fill, grams: 300 })).entry;
  assert.equal(q2.nutrients.kcal, 550);
  assert.equal(q2.nutrients.sugars, 6);
  assert.deepEqual(q2.filled, []);
  assert.equal((await call('POST', '/api/food/quick', { id: id(), name: 'Nothing known' })).status, 400, 'still needs calories from somewhere');
});

test('searches leave out size words, placeholders are never a match, and fills never claim more than the whole', async () => {
  const sized = await photo.shortlistFor(photo.understood({ name: 'large fries', brand: 'Burger King', searches: ['large burger king fries'], amount: 160, unit: 'g' }));
  assert.equal(sized.list[0].key, BK);
  const halloumi = await photo.shortlistFor(photo.understood({ name: 'halloumi', searches: ['halloumi cheese', 'halloumi'], amount: 80, unit: 'g' }));
  assert.ok(!halloumi.list.some((r) => r.key === 'halloumi-needs-label'));

  const f = food.cleanFill({ kcal: 50, carbs: 20, sugars: 30, fat: 1, satfat: 5, salt: -1, fibre: 'x', protein: 2000 });
  assert.equal(f.basis, 'g');
  assert.equal(f.sugars, 20);
  assert.equal(f.satfat, 1);
  assert.equal(f.salt, null);
  assert.equal(f.fibre, null);
  assert.equal(f.protein, null);
  assert.equal(food.cleanFill({}), null);
  assert.equal(food.cleanFill(null), null);
  const g = food.fillGaps({ kcal: 100, carbs: 10, sugars: null, fat: null, satfat: null }, 50, { basis: 'g', kcal: 300, carbs: 40, sugars: 20, fat: 10, satfat: 4 });
  assert.deepEqual(g.filled, ['sugars', 'fat', 'satfat']);
  assert.equal(g.nutrients.kcal, 100);
  assert.equal(g.nutrients.sugars, 5);
  assert.equal(g.nutrients.fat, 5);
  assert.equal(g.nutrients.satfat, 2);
});

test('a zero, diet or decaf version is a different food: Capri Sun Zero never lands on the regular Capri Sun', async () => {
  const DRINK = { kcal: 40, protein: 0, carbs: 9, sugars: 8.5, fat: 0, satfat: 0, fibre: 0, salt: 0.01, caffeine: 0, alcohol: 0 };
  await food.upsertItem({ key: 'test-capri-orange', kind: 'product', name: 'Orange', brand: 'Capri-Sun', basis: 'ml', liquid: true, source: 'off', nutrients: DRINK });
  const zero = (over = {}) => eaten({
    name: 'Capri Sun Zero', brand: 'Capri-Sun', variety: 'zero sugar', amount: 200, unit: 'ml', weight: 200,
    searches: ['capri sun zero', 'capri sun', 'fruit drink'], per100: { ...DRINK, kcal: 4, carbs: 0.8, sugars: 0.5 }, ...over,
  });

  // Only the regular one is in the catalogue: it is never offered, so even a wrong pick cannot use it.
  const c = scripted([typed('A Capri Sun Zero', [zero()]), chose([0, 'test-capri-orange', 'ml', 200])]);
  coach.setCoachClient(c);
  const [lone] = (await post('/api/food/describe', { text: 'a capri sun zero' })).items;
  assert.notEqual(lone.match?.key, 'test-capri-orange', 'no regular Capri Sun for a zero one');
  if (lone.match) assert.ok(lone.match.nutrients.sugars <= 1 || photo.variantsOf(lone.match.name).has('sugar free'), `a sugar-free stand-in, not ${lone.match.name}`);
  assert.equal(lone.fill.sugars, 0.5, 'his zero-sugar estimate travels with it');
  assert.ok(!askedText(c, 1).includes('key test-capri-orange '), 'the regular version was not on the shortlist');

  // With the zero version in the catalogue, it wins, even without the AI's choice.
  await food.upsertItem({ key: 'test-capri-zero', kind: 'product', name: 'Zero Orange', brand: 'Capri-Sun', basis: 'ml', liquid: true, source: 'off', nutrients: { ...DRINK, kcal: 4, carbs: 0.9, sugars: 0.6 } });
  coach.setCoachClient(scripted([typed('A Capri Sun Zero', [zero()]), refused]));
  assert.equal((await post('/api/food/describe', { text: 'a capri sun zero' })).items[0].match.key, 'test-capri-zero');

  // And a plain Capri Sun keeps the regular one ahead of the zero.
  coach.setCoachClient(scripted([typed('A Capri Sun', [zero({ name: 'Capri Sun', variety: '', searches: ['capri sun orange', 'capri sun'], per100: DRINK })]), refused]));
  assert.equal((await post('/api/food/describe', { text: 'a capri sun' })).items[0].match.key, 'test-capri-orange');

  assert.deepEqual([...photo.variantsOf('Diet Coke')], ['sugar free']);
  assert.deepEqual([...photo.variantsOf('decaf flat white')], ['decaf']);
  assert.deepEqual([...photo.variantsOf('Chicken, light meat')], ['light']);
  assert.deepEqual([...photo.variantsOf('Kinnie')], []);
});

test('reading schemas stay within the API limit of 16 nullable fields', () => {
  const unions = (s) => {
    let k = 0;
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x.anyOf) || Array.isArray(x.type)) k += 1;
      Object.values(x).forEach(walk);
    };
    walk(s);
    return k;
  };
  for (const [name, s] of Object.entries({ photo: photo.PHOTO_SCHEMA, text: photo.TEXT_SCHEMA, choose: photo.CHOOSE_SCHEMA })) {
    assert.ok(unions(s) <= 16, `${name} has ${unions(s)} nullable fields`);
    strictSchema(s, name);
  }
  // The photo reading still comes back with nulls for what was not seen.
  const r = photo.photoFromWire({ kind: 'label', summary: '', barcode: '', question: '',
    product: { name: 'Zero Orange', brand: 'Capri-Sun', variant: '', pack_size: 200, pack_unit: 'ml', pack_count: 0 },
    label: { basis: '100ml', serving_size: 0, serving_unit: '', serving_label: '', values: [{ key: 'kcal', value: 4 }, { key: 'sugars', value: 0.6 }] } });
  assert.equal(r.barcode, null);
  assert.deepEqual(r.product, { name: 'Zero Orange', brand: 'Capri-Sun', variant: null, pack_size: 200, pack_unit: 'ml', pack_count: null });
  assert.equal(r.label.kcal, 4);
  assert.equal(r.label.sugars, 0.6);
  assert.equal(r.label.salt, null, 'a value not printed is unknown, not zero');
  assert.equal(photo.photoFromWire({ kind: 'meal', label: { basis: 'none', values: [] } }).label, null);
});

test('the food chat: a correction is read against what was listed before, and the reply line comes back', async () => {
  const c = scripted([
    said({ kind: 'meal', summary: 'Three eggs on toast', reply: 'Made it three eggs, still on one slice of toast.', question: null, items: [mediumGrapes] }),
    refused,
  ]);
  coach.setCoachClient(c);
  const r = await post('/api/food/describe', {
    text: 'actually it was three eggs',
    before: { said: 'two eggs on toast', items: [{ name: 'Egg, boiled', amount: '2 large' }, { name: 'Toast', amount: '1 slice' }] },
  });
  assert.equal(r.reply, 'Made it three eggs, still on one slice of toast.');
  const asked = askedText(c, 0);
  assert.match(asked, /^Earlier in this chat, he said: "two eggs on toast", you listed: Egg, boiled, 2 large; Toast, 1 slice\.\nNow he says: "actually it was three eggs"$/);
  assert.match(c.requests[0].system[0]?.text || JSON.stringify(c.requests[0].system), /return the whole list as it now stands/);

  // Without anything before, the words go as typed; an empty reply is no reply.
  const d = scripted([typed('Medium grapes', [mediumGrapes]), refused]);
  coach.setCoachClient(d);
  const plain = await post('/api/food/describe', { text: 'medium grapes', before: { said: '', items: [] } });
  assert.equal(askedText(d, 0), 'medium grapes');
  assert.equal(plain.reply, null);
});
