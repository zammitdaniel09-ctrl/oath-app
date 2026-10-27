// Filling what a diary entry does not say: a USDA reference for an Open Food Facts product, a quick add
// and the coach's estimates, published values found on the web and kept as a catalogue record, the
// estimate for the rest, the backfill queue, and Trends counting what was filled. A scripted Claude
// stands in for the API throughout; nothing here touches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { KEYS, fillSourceParts } from '../public/nutrition.js';

const ZONE = 'Europe/Malta';
const clock = DateTime.fromISO('2026-11-02T19:30', { zone: ZONE });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-enrich-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54371,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let coach; let food; let enrich; let tools; let photo;

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
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
let n = 0;
const id = () => `enrich-entry-${(n += 1)}-${Date.now().toString(36)}`;
const sql = () => dbmod.db();
const row = async (eid) => (await sql()`select * from food_log where id = ${eid}`)[0];
// The entry as the diary shows it, with its marks and where the filled values came from.
const entry = async (eid) => {
  const r = await row(eid);
  return (await get(`/api/food/day?date=${r.date}`)).entries.find((x) => x.id === eid);
};

const reply = (stop_reason, content) => ({ stop_reason, content });
const said = (obj) => reply('end_turn', [{ type: 'text', text: JSON.stringify(obj) }]);
const itemsIn = (params) => [...params.messages[0].content[0].text.matchAll(/^Item (\d+):/gm)].map((m) => Number(m[1]));

// A stand-in for the Anthropic client. Every request is sorted by what it is: a web search (it carries
// the web search tool), the matcher's choice, a description, or the reading of web notes (by schema).
// Each kind answers from its own list or function; a kind with no answer throws, so an unexpected call
// shows up as a failure.
function scripted(answers = {}) {
  const requests = [];
  const kindOf = (p) => {
    if ((p.tools || []).some((t) => t.type === 'web_search_20260209')) return 'web';
    const props = p.output_config?.format?.schema?.properties || {};
    if (props.choices) return 'choose';
    if (props.foods) return 'describe';
    if (props.found) return 'read';
    return 'other';
  };
  return {
    requests,
    count: (kind) => requests.filter((r) => r.kind === kind).length,
    of: (kind) => requests.filter((r) => r.kind === kind).map((r) => r.params),
    beta: {
      messages: {
        create: async (params) => {
          const kind = kindOf(params);
          requests.push({ kind, params: JSON.parse(JSON.stringify(params)) });
          let a = answers[kind];
          if (Array.isArray(a)) a = a.shift();
          if (!a) throw new Error(`no scripted ${kind} answer`);
          return typeof a === 'function' ? a(params) : a;
        },
      },
    },
  };
}

// The matcher's choice: for each item, the first of these records on its list, otherwise none. A pick
// is a key, or [key, unit, qty].
const choose = (...picks) => (params) => {
  const blocks = params.messages[0].content[0].text.split(/\n\n(?=Item \d+:)/);
  return said({
    choices: itemsIn(params).map((item) => {
      const block = blocks.find((b) => b.startsWith(`Item ${item}:`)) || '';
      const hit = picks.map((p) => (Array.isArray(p) ? p : [p, 'g', 100])).find(([k]) => block.includes(`key ${k} `));
      return hit ? { item, key: hit[0], unit: hit[1], qty: hit[2], why: 'Closest version of the same food' } : { item, key: '', unit: 'g', qty: 1, why: 'Nothing like it' };
    }),
  });
};
const chooseNothing = choose();
// Every value per 100, zero unless given.
const per100 = (over = {}) => ({ ...Object.fromEntries(KEYS.map((k) => [k, 0])), ...over });
// The same description for every item asked about.
const describeAs = (over) => (params) => said({
  foods: itemsIn(params).map((item) => ({ item, generic: 'food', searches: [], web: false, basis: 'g', portion: 100, per100: per100(), ...over })),
});

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54371/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.COACH_MODEL;
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
  enrich = await import('../src/food-enrich.js');
  tools = await import('../src/coach-tools.js');
  photo = await import('../src/food-photo.js');
  await (await import('../src/food-seed.js')).seedFood({ force: true });
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  enrich.setAutoEnrich(false);
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('without the AI key, a quick add of cola gets a USDA cola\'s values for the weight its energy gives; what he typed stays', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const c = scripted();
  coach.setCoachClient(c);
  try {
    const q = (await post('/api/food/quick', { id: id(), name: 'Cola', kcal: 139, protein: 0.5, date: '2026-10-31', time: '13:00' })).entry;
    assert.equal(q.nutrients.potassium, null, 'nothing is filled while logging');
    assert.equal(q.fillSource, null);
    const r = await enrich.enrichEntries([q.id]);
    assert.equal(r.filled, 1);
    const e = await entry(q.id);
    const src = e.fillSource;
    const ref = await food.getFood({ key: src.usda.key });
    assert.equal(ref.source, 'usda');
    assert.equal(ref.name, 'Cola');
    assert.ok(ref.nutrients.kcal > 30, 'a regular cola for a 139 kcal drink, never a diet one');
    // No weight was logged, so it comes from the energy: 139 kcal of a 42 kcal per 100 g drink.
    const grams = (139 / ref.nutrients.kcal) * 100;
    assert.deepEqual(src.weight, { amount: Math.round(grams), unit: 'g', from: 'energy' });
    near(e.nutrients.potassium, (ref.nutrients.potassium * grams) / 100);
    near(e.nutrients.carbs, (ref.nutrients.carbs * grams) / 100);
    near(e.nutrients.caffeine, (ref.nutrients.caffeine * grams) / 100);
    assert.equal(e.nutrients.kcal, 139);
    assert.equal(e.nutrients.protein, 0.5, 'his own value is never touched');
    assert.ok(!e.filled.includes('protein') && !e.filled.includes('kcal'));
    for (const k of ['carbs', 'potassium', 'calcium', 'vitc', 'b12']) assert.ok(e.filled.includes(k), `${k} is filled and marked`);
    assert.deepEqual(src.usda.keys, e.filled, 'everything filled came from USDA');
    // The line under the facts says so.
    assert.deepEqual(fillSourceParts(src).map((p) => p.text), [
      'Vitamins, minerals and other values filled from USDA: Cola', `Worked out for about ${Math.round(grams)} g, from its energy`,
    ]);
    // USDA has no added sugars on this record and there is no estimate without the AI: unknown stays unknown.
    assert.equal(e.nutrients.addsugars, null);
    assert.equal(c.requests.length, 0, 'no AI key, no calls');
    // Done once: asking again does nothing.
    assert.equal((await enrich.enrichEntries([q.id])).entries, 0);
    assert.ok((await row(q.id)).enriched_at);
  } finally {
    process.env.ANTHROPIC_API_KEY = 'test';
  }
});

test('an Open Food Facts cola: the generic USDA cola fills its gaps by volume, and an estimate only what that lacks', async () => {
  await food.upsertItem({
    key: 'off:5449000000996', kind: 'product', name: 'Coca-Cola Original Taste', brand: 'Coca-Cola', basis: 'ml', liquid: true, source: 'off',
    nutrients: { kcal: 42, protein: 0, carbs: 10.6, sugars: 10.6, fat: 0, satfat: 0, fibre: null, salt: 0 },
  });
  const c = scripted({
    choose: choose('cola-regular'),
    describe: describeAs({ generic: 'cola', searches: ['cola', 'soft drink'], web: true, basis: 'ml', portion: 330, per100: per100({ kcal: 42, carbs: 10.6, sugars: 10.6, addsugars: 10.6, potassium: 999 }) }),
  });
  coach.setCoachClient(c);
  const e0 = (await post('/api/food/log', { id: id(), key: 'off:5449000000996', qty: 330, unit: 'ml', date: '2026-10-31', time: '13:30' })).entry;
  assert.equal(e0.nutrients.potassium, null);
  await enrich.enrichEntries([e0.id]);
  const e = await entry(e0.id);
  // Nothing in the catalogue goes by the brand's words, so the description's generic words found it.
  assert.deepEqual(c.requests.map((r) => r.kind), ['describe', 'choose']);
  assert.equal(e.fillSource.usda.key, 'cola-regular');
  assert.equal(e.fillSource.usda.name, 'Cola');
  // 330 ml through the USDA cola's sourced density, 1.0381 g per ml.
  const g = 330 * 1.0381;
  near(e.nutrients.potassium, (5 * g) / 100);
  near(e.nutrients.caffeine, (9 * g) / 100);
  assert.equal(e.nutrients.fibre, 0);
  // The product's own values stay as they were.
  near(e.nutrients.kcal, 138.6);
  near(e.nutrients.sugars, 34.98);
  // USDA has no added sugars for cola, so that one comes from the estimate, never more than the sugars.
  assert.deepEqual(e.fillSource.estimate, { keys: ['addsugars'] });
  near(e.nutrients.addsugars, 34.98);
  assert.equal(e.fillSource.weight, undefined, 'its own volume, nothing assumed');
  assert.deepEqual(fillSourceParts(e.fillSource).map((p) => p.text), ['Vitamins, minerals and other values filled from USDA: Cola', 'The rest marked ~ are estimates']);
  assert.equal(c.count('web'), 0, 'a reference was found, so no web lookup');
  assert.equal(c.count('describe'), 1);
  // The choice was told what it is for and saw USDA records only.
  const asked = c.of('choose').map((p) => p.messages[0].content[0].text).join('\n');
  assert.match(asked, /USDA records only/);
  assert.ok(!/key off:/.test(asked), 'never another product as a reference');
  for (const p of c.of('choose')) {
    assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(p.fallbacks, 'default');
  }
});

test('the coach\'s estimate carries every micronutrient; a USDA reference fills the record\'s gaps first and the estimate the rest', async () => {
  // The tool and the readings ask for every value per 100.
  const est = tools.TOOL_DEFS.find((t) => t.name === 'log_food_estimate');
  const per = est.input_schema.properties.items.items.properties.per100;
  assert.deepEqual(Object.keys(per.properties).sort(), KEYS.slice().sort());
  assert.match(per.description, /potassium/);
  const read = photo.TEXT_SCHEMA.properties.items.items.properties.per100;
  assert.deepEqual([...read.required].sort(), KEYS.slice().sort());
  assert.deepEqual(photo.PHOTO_SCHEMA.properties.items.items.properties.per100.required, read.required);

  await food.upsertItem({
    key: 'test-enrich-grill-fries', kind: 'product', name: 'French fries', brand: 'Zzqx Grill', state: 'fried', basis: 'g', source: 'off',
    nutrients: { kcal: 280, protein: 3.2, carbs: 37, sugars: null, fat: 13, satfat: 2, fibre: null, salt: 0.6, caffeine: 0, alcohol: 0 },
    portions: [{ label: '1 large serving', g: 154, source: 'off' }],
  });
  const coachPer100 = per100({ kcal: 300, protein: 3.4, carbs: 38, sugars: 0.3, fat: 14, satfat: 2.2, fibre: 3.5, salt: 0.7, potassium: 400, vitc: 9, iron: 0.9 });
  const c = scripted({ choose: [choose(['test-enrich-grill-fries', 'p:1 large serving', 1]), choose('chips-takeaway')] });
  coach.setCoachClient(c);
  const ctx = { actions: [], pending: [] };
  const res = await tools.runTool('log_food_estimate', {
    date: '2026-10-31', time: '19:00',
    items: [{
      name: 'fries', brand: 'Zzqx Grill', preparation: 'deep fried', size: 'large', search: 'zzqx grill french fries', searches: ['french fries'],
      amount: 154, unit: 'g', weight: 154, kcal_estimate: 460, per100: coachPer100,
    }],
  }, ctx);
  assert.ok(!res.isError, res.content);
  const [r0] = await sql()`select * from food_log where ref_key = 'test-enrich-grill-fries'`;
  assert.equal(r0.grams, 154);
  // Logging fills the record's core gaps from the coach and keeps the whole profile for later.
  assert.deepEqual(r0.filled, ['sugars', 'fibre']);
  assert.equal(r0.nutrients.potassium, null);
  assert.equal(r0.fill_profile.potassium, 400);
  assert.equal(r0.fill_profile.b12, 0);
  assert.ok(r0.fill_profile.searches.includes('french fries'));
  assert.deepEqual(r0.fill_source, { estimate: { keys: ['sugars', 'fibre'] } });

  await enrich.enrichEntries([r0.id]);
  const e = await entry(r0.id);
  // Takeaway chips from USDA come before the coach's guess: 579 mg potassium per 100 g, not 400.
  assert.equal(e.fillSource.usda.key, 'chips-takeaway');
  near(e.nutrients.potassium, 579 * 1.54);
  near(e.nutrients.vitc, 4.7 * 1.54);
  // What USDA lacks (added sugars) comes from the coach's own profile, with no further call.
  assert.deepEqual(e.fillSource.estimate.keys, ['sugars', 'fibre', 'addsugars']);
  assert.equal(e.nutrients.addsugars, 0);
  assert.equal(c.count('describe'), 0);
  assert.equal(c.count('web'), 0);
  // The record's own values never change.
  near(e.nutrients.kcal, 280 * 1.54);
  near(e.nutrients.fibre, 3.5 * 1.54);
  assert.equal(KEYS.filter((k) => e.nutrients[k] === null).length, 0, 'all 33 known');
});

test('a food nothing in the catalogue resembles keeps the reading\'s own estimate for every vitamin and mineral', async () => {
  const wrap = { basis: 'g', ...per100({ kcal: 200, protein: 10, carbs: 25, sugars: 2, fat: 8, satfat: 3, fibre: 2, salt: 1.2, potassium: 250, iron: 1.5, vitc: 4, b12: 0.3 }) };
  const q0 = (await post('/api/food/quick', { id: id(), name: 'Zzqx mystery wrap', fill: wrap, grams: 300, estimate: true, amount: 'about 300 g', searches: ['zzqx wrap'], date: '2026-10-30', time: '13:00' })).entry;
  assert.deepEqual(q0.filled, food.FILL_KEYS, 'logging fills the core values only');
  assert.equal(q0.nutrients.iron, null);
  const c = scripted({ choose: chooseNothing, describe: describeAs({ generic: 'zzqx flatbread wrap', searches: ['zzqx flatbread'], web: false, per100: per100({ kcal: 210, potassium: 5000 }) }) });
  coach.setCoachClient(c);
  await enrich.enrichEntries([q0.id]);
  const e = await entry(q0.id);
  assert.equal(e.fillSource.usda, undefined);
  assert.equal(e.fillSource.web, undefined);
  // The reading's estimate of this food wins over the description's.
  near(e.nutrients.potassium, 750);
  near(e.nutrients.iron, 4.5);
  near(e.nutrients.b12, 0.9);
  assert.ok(e.fillSource.estimate.keys.includes('potassium'));
  assert.ok(e.filled.includes('iron'));
  assert.equal(c.count('web'), 0, 'not worth a web lookup');
});

const URL1 = 'https://www.twistees.com.mt/products/cheese';
const webFound = reply('end_turn', [
  { type: 'text', text: 'Searching for the label.' },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Twistees cheese nutrition per 100g' } },
  {
    type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
      { type: 'web_search_result', url: URL1, title: 'Twistees Cheese | Twistees', encrypted_content: 'abc', page_age: null },
      { type: 'web_search_result', url: 'https://forum.example.org/twistees', title: 'A forum', encrypted_content: 'def', page_age: null },
    ],
  },
  {
    type: 'text',
    text: 'Twistees Cheese, per 100 g: energy 2090 kJ / 500 kcal, fat 26 g, of which saturates 11 g, carbohydrate 60 g, of which sugars 3 g, fibre 2 g, protein 6 g, sodium 800 mg.',
    citations: [{ type: 'web_search_result_location', url: URL1, title: 'Twistees Cheese | Twistees', encrypted_index: 'x', cited_text: 'Energy 500 kcal' }],
  },
]);
// The reading as the API returns it: no nulls, only the values the notes gave, sodium among them.
const pairs = (o) => Object.entries(o).map(([key, value]) => ({ key, value }));
const webRead = (over = {}) => said({
  found: true, name: 'Twistees Cheese', brand: 'Twistees', url: `${URL1}/`, per: '100g', serving_size: 0, serving_unit: '',
  values: pairs({ kcal: 500, protein: 6, carbs: 60, sugars: 3, fat: 26, satfat: 11, fibre: 2, sodium_mg: 800 }),
  ...over,
});

test('a local brand with no reference: its published values are found on the web, cited, saved as a catalogue record and reused', async () => {
  const describe = describeAs({ generic: 'cheese puff snack', searches: ['zzqx cheese puffs'], web: true, basis: 'g', portion: 30, per100: per100({ kcal: 520, potassium: 150, calcium: 60 }) });
  const c = scripted({ choose: chooseNothing, describe, web: [webFound], read: [webRead()] });
  coach.setCoachClient(c);
  const q = (await post('/api/food/quick', { id: id(), name: 'Twistees Cheese', brand: 'Twistees', kcal: 140, date: '2026-10-31', time: '16:00' })).entry;
  assert.equal(q.brand, 'Twistees');
  await enrich.enrichEntries([q.id]);

  // One search, sent without a schema (structured output and web search do not mix), then one reading.
  assert.equal(c.count('web'), 1);
  const [w] = c.of('web');
  assert.deepEqual(w.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'MT', timezone: 'Europe/Malta' } }]);
  assert.equal(w.output_config.format, undefined);
  assert.equal(w.model, 'claude-sonnet-5-5');
  assert.equal(w.fallbacks, 'default');
  assert.match(w.messages[0].content, /Twistees Cheese/);
  assert.equal(c.count('read'), 1);
  assert.match(c.of('read')[0].messages[0].content[0].text, /Pages it read:\n- https:\/\/www\.twistees\.com\.mt\/products\/cheese/);

  // A catalogue record of its own, with the page and the date, found by search next time.
  const item = await food.getFood({ key: 'web:twistees-cheese' });
  assert.equal(item.kind, 'web');
  assert.equal(item.source, 'web');
  assert.equal(item.source_ref, URL1, 'the address the search returned');
  assert.equal(item.source_date, '2026-11-02');
  assert.equal(item.brand, 'Twistees');
  assert.equal(item.nutrients.kcal, 500);
  assert.equal(item.nutrients.salt, 2, '800 mg sodium is 2 g salt');
  assert.match(item.notes, /twistees|Twistees/);
  assert.match(item.notes, /sodium/);
  assert.equal(item.nutrients.potassium, null, 'nothing the page did not give');
  assert.ok((await food.searchFoods('twistees')).some((x) => x.key === 'web:twistees-cheese'));
  assert.equal(await enrich.webLookupsToday(), 1);

  // The entry: 28 g from its energy, the label values from the page, the rest from the estimate.
  const e = await entry(q.id);
  assert.deepEqual(e.fillSource.weight, { amount: 28, unit: 'g', from: 'energy' });
  assert.equal(e.fillSource.web.url, URL1);
  assert.equal(e.fillSource.web.key, 'web:twistees-cheese');
  for (const k of ['protein', 'carbs', 'fat', 'salt']) assert.ok(e.fillSource.web.keys.includes(k), k);
  near(e.nutrients.protein, 1.68);
  near(e.nutrients.salt, 0.56);
  near(e.nutrients.potassium, 42);
  assert.ok(e.fillSource.estimate.keys.includes('potassium'));
  assert.ok(!e.fillSource.estimate.keys.includes('protein'), 'the page beats the estimate');
  assert.equal(e.nutrients.kcal, 140);
  assert.deepEqual(fillSourceParts(e.fillSource), [
    { text: 'Values from ', link: { url: URL1, text: 'twistees.com.mt' } },
    { text: 'The rest marked ~ are estimates' },
    { text: 'Worked out for about 28 g, from its energy' },
  ]);

  // Logged again: nothing is asked, the saved record is used.
  const before = c.requests.length;
  const q2 = (await post('/api/food/quick', { id: id(), name: 'Twistees Cheese', brand: 'Twistees', kcal: 70, date: '2026-10-31', time: '17:00' })).entry;
  await enrich.enrichEntries([q2.id]);
  assert.equal(c.requests.length, before, 'no new call for a food already looked up');
  const e2 = await entry(q2.id);
  assert.equal(e2.fillSource.web.key, 'web:twistees-cheese');
  near(e2.nutrients.protein, 0.84);
  assert.equal(await enrich.webLookupsToday(), 1);
});

test('the web is never trusted past what it returned, and lookups stop at the daily cap', async () => {
  // A page the model names that the search never returned is not a source: nothing is saved.
  coach.setCoachClient(scripted({ web: [webFound], read: [webRead({ url: 'https://made-up.example/twistees' })] }));
  assert.equal(await enrich.lookUpOnWeb({ name: 'Twistees Paprika', brand: 'Twistees' }), null);
  coach.setCoachClient(scripted({ web: [webFound], read: [said({ found: false, name: '', brand: '', url: '', per: '100g', serving_size: 0, serving_unit: '', values: [] })] }));
  assert.equal(await enrich.lookUpOnWeb({ name: 'Twistees Paprika', brand: 'Twistees' }), null);
  // Values per serving become values per 100 by the serving size.
  coach.setCoachClient(scripted({ web: [webFound], read: [webRead({ name: 'Twistees Cheese Bag', per: 'serving', serving_size: 25, serving_unit: 'g', values: pairs({ kcal: 125, protein: 1.5, salt: 0.5 }) })] }));
  const bag = await enrich.lookUpOnWeb({ name: 'Twistees Cheese Bag', brand: 'Twistees' });
  assert.equal(bag.nutrients.kcal, 500);
  assert.equal(bag.nutrients.protein, 6);
  assert.equal(bag.nutrients.salt, 2);
  assert.deepEqual(bag.serving, { size: 25, unit: 'g' });

  // At the cap, the entry is still filled, from the estimate, without searching.
  await dbmod.setKV('food_web_lookups', { date: '2026-11-02', n: enrich.WEB_PER_DAY });
  const c = scripted({ choose: chooseNothing, describe: describeAs({ generic: 'bitter orange soft drink', searches: ['zzqx bitter soda'], web: true, basis: 'ml', portion: 330, per100: per100({ kcal: 45, carbs: 11, potassium: 10 }) }) });
  coach.setCoachClient(c);
  const q = (await post('/api/food/quick', { id: id(), name: 'Kinnie Zest', brand: 'Kinnie', kcal: 150, ml: 330, date: '2026-10-30', time: '12:00' })).entry;
  await enrich.enrichEntries([q.id]);
  assert.equal(c.count('web'), 0);
  const e = await entry(q.id);
  near(e.nutrients.potassium, 33);
  assert.ok(e.fillSource.estimate.keys.includes('potassium'));
  assert.ok((await row(q.id)).enriched_at);
  assert.equal(await enrich.webLookupsToday(), enrich.WEB_PER_DAY);
});

test('the backfill: newest first, a few at a time, deleted entries skipped, complete ones only marked, and each done once', async () => {
  await sql()`update food_log set enriched_at = now() where enriched_at is null`;
  delete process.env.ANTHROPIC_API_KEY;
  const c = scripted();
  coach.setCoachClient(c);
  try {
    const old = [];
    for (const [i, date] of ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'].entries()) {
      old.push((await post('/api/food/quick', { id: id(), name: 'Cola', kcal: 100 + i, date, time: '12:00' })).entry.id);
    }
    const gone = (await post('/api/food/quick', { id: id(), name: 'Cola', kcal: 120, date: '2026-10-29', time: '12:00' })).entry.id;
    await call('DELETE', `/api/food/log/${gone}`);
    const full = await post('/api/food/items', { name: 'Everything bar', basis: 'g', nutrients: per100({ kcal: 400, protein: 10, carbs: 50, sugars: 20, fat: 15, satfat: 5, addsugars: 10 }) });
    const whole = (await post('/api/food/log', { id: id(), key: full.key, qty: 50, unit: 'g', date: '2026-10-29', time: '13:00' })).entry.id;
    const meal = (await post('/api/food/meals/log', { id: id(), name: 'A plate', lines: [{ ref: 'item', ref_key: 'banana-raw', qty: 100, unit: 'g' }], date: '2026-10-29', time: '14:00' })).entry.id;

    const t1 = await enrich.drainEnrichment({ limit: 2 });
    assert.equal(t1.entries, 2);
    assert.equal(t1.filled, 2);
    assert.equal(t1.complete, 1, 'the complete entry is only marked');
    const done = async (eid) => Boolean((await row(eid)).enriched_at);
    assert.deepEqual(await Promise.all(old.map(done)), [false, false, true, true], 'the newest first');
    assert.ok(await done(whole));
    assert.deepEqual((await row(whole)).filled, [], 'nothing to fill on a complete entry');
    const deleted = await row(gone);
    assert.equal(deleted.enriched_at, null, 'a deleted entry is skipped');
    assert.equal(deleted.nutrients.potassium, null);
    assert.equal((await row(meal)).enriched_at, null, 'meals are made of catalogue lines and are left as they are');

    await enrich.drainEnrichment({ limit: 2 });
    assert.deepEqual(await Promise.all(old.map(done)), [true, true, true, true]);
    const snapshot = (await row(old[0])).nutrients;
    assert.ok(snapshot.potassium > 0);
    const t3 = await enrich.drainEnrichment({ limit: 2 });
    assert.equal(t3.entries, 0, 'nothing left');
    assert.equal((await enrich.enrichEntries(old)).entries, 0, 'done once');
    assert.deepEqual((await row(old[0])).nutrients, snapshot);
    assert.equal(c.requests.length, 0);
  } finally {
    process.env.ANTHROPIC_API_KEY = 'test';
  }
});

test('a failing estimate is retried a few times and then left; a rate limit pauses the filler without counting', async () => {
  await sql()`update food_log set enriched_at = now() where enriched_at is null`;
  const boom = { choose: chooseNothing, describe: () => { throw new Error('boom'); } };
  coach.setCoachClient(scripted(boom));
  const q = (await post('/api/food/quick', { id: id(), name: 'Zzqx protein bar', kcal: 200, date: '2026-10-30', time: '10:00' })).entry;
  const r1 = await enrich.enrichEntries([q.id]);
  assert.equal(r1.failed, 1);
  let r = await row(q.id);
  assert.equal(r.enrich_tries, 1);
  assert.equal(r.enriched_at, null);
  assert.match(r.enrich_error, /boom/);
  await enrich.drainEnrichment();
  assert.equal((await row(q.id)).enrich_tries, 2);
  // The last try keeps whatever it has and stops.
  await enrich.drainEnrichment();
  r = await row(q.id);
  assert.equal(r.enrich_tries, enrich.MAX_TRIES);
  assert.ok(r.enriched_at);
  assert.equal((await enrich.drainEnrichment()).entries, 0);

  // A rate limit: nothing is counted, the filler waits, then carries on.
  const limit = Object.assign(new Error('rate limited'), { status: 429 });
  const c = scripted({ choose: chooseNothing, describe: [() => { throw limit; }, describeAs({ generic: 'oat bar', searches: [], per100: per100({ kcal: 400, iron: 3 }) })] });
  coach.setCoachClient(c);
  const q2 = (await post('/api/food/quick', { id: id(), name: 'Zzqx oat bar', kcal: 200, date: '2026-10-30', time: '11:00' })).entry;
  assert.equal((await enrich.enrichEntries([q2.id])).paused, true);
  assert.equal((await row(q2.id)).enrich_tries, 0);
  assert.equal((await enrich.drainEnrichment()).paused, true, 'paused for a while');
  assert.equal(c.count('describe'), 1);
  enrich.resumeEnrichment();
  await enrich.drainEnrichment();
  const e = await entry(q2.id);
  near(e.nutrients.iron, 1.5, 1e-6);
  assert.deepEqual(e.fillSource.weight, { amount: 50, unit: 'g', from: 'energy' });
});

test('new entries are filled a moment after they are logged, once the loop has turned the filler on', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  coach.setCoachClient(scripted());
  try {
    const off = (await post('/api/food/quick', { id: id(), name: 'Cola', kcal: 90, date: '2026-10-29', time: '18:00' })).entry;
    await enrich.enrichIdle();
    assert.equal((await row(off.id)).enriched_at, null, 'off until the loop turns it on');
    enrich.setAutoEnrich(true);
    const on = (await post('/api/food/quick', { id: id(), name: 'Cola', kcal: 90, date: '2026-10-29', time: '18:30' })).entry;
    assert.equal(on.nutrients.potassium, null, 'the response is not held up');
    await enrich.enrichIdle();
    const e = await entry(on.id);
    assert.ok(e.nutrients.potassium > 0);
    assert.ok(e.fillSource.usda);
  } finally {
    enrich.setAutoEnrich(false);
    process.env.ANTHROPIC_API_KEY = 'test';
  }
});

test('Trends counts the filled vitamins and minerals and marks them as partly estimated', async () => {
  const h = await get('/api/food/history?days=7');
  const c = Object.fromEntries(h.coverage.map((x) => [x.key, x]));
  for (const k of ['potassium', 'calcium', 'iron', 'magnesium', 'zinc', 'phosphorus', 'selenium', 'vita', 'vitc', 'vitd', 'vite', 'vitk', 'b1', 'b2', 'b3', 'b6', 'folate', 'b12']) {
    assert.notEqual(c[k].pct, null, `${k} has a value`);
  }
  // Most of it was filled; the banana in the saved plate brought its own.
  assert.ok(c.potassium.est > 50 && c.potassium.est < 100, String(c.potassium.est));
  // The share counts what was filled, not what was on record.
  const d = await get('/api/food/day?date=2026-10-31');
  const known = d.entries.reduce((a, e) => a + (e.filled.includes('potassium') ? 0 : e.nutrients.potassium || 0), 0);
  assert.equal(known, 0, 'none of that day\'s potassium was on the records themselves');
});
