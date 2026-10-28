// The live scanner's server side, end to end through the API: a barcode no database knows, then a label
// photographed for it with the scanned code as a hint, saved under that code and found by the next scan
// with no call out; and the catalogue finding a product by the same code with or without leading zeros.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-scan-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54433 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let coach;

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

// Open Food Facts, standing in for the network, counting the product reads that reach it.
const OFF = new Map();
const offCalls = [];
async function fakeOff(url) {
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });
  const prod = url.match(/\/product\/(\d+)\.json/);
  if (prod) offCalls.push(prod[1]);
  if (prod) return OFF.has(prod[1]) ? reply(200, { status: 1, product: OFF.get(prod[1]) }) : reply(404, { status: 0 });
  return reply(200, { hits: [] });
}

// A stand-in for the Anthropic client, answering with one scripted reading.
function scripted(responses) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (params) => {
      requests.push(params);
      const r = responses.shift();
      if (!r) throw new Error('no scripted response left');
      return r;
    } } },
  };
}
const said = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
const reading = (over) => ({ kind: 'unclear', summary: '', barcode: null, product: null, label: null, items: [], question: null, ...over });
const LABEL = { basis: '100ml', serving_size: null, serving_unit: null, serving_label: null, kcal: 41, kj: 172, protein: 0, carbs: 10, sugars: 10, fat: 0, satfat: 0, fibre: null, salt: 0.02, caffeine_mg: null };
const PHOTO = { image: 'iVBORw0KGgoAAAANSUhEUg==', media_type: 'image/png' };

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54433 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  const engine = await import('../src/engine.js');
  await engine.ensureGame();
  ({ app } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  const off = await import('../src/off.js');
  off.setOffFetch(fakeOff);
  off.setOffSpacing(false);
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('the app may use its own camera, and nothing else may', async () => {
  const res = await app.request('/healthz');
  assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.match(res.headers.get('permissions-policy'), /microphone=\(self\)/);
});

test('a scanned code no database knows, then its label photographed with the code as a hint, is found by the next scan', async () => {
  const code = '5000000001248';
  assert.equal((await get(`/api/food/barcode/${code}`)).item, null);
  assert.deepEqual(offCalls, [code]);

  // The label photo has no barcode in it: the scanned one comes along as the hint.
  const client = scripted([said(reading({ kind: 'label', summary: 'A nutrition table', product: { name: 'Blood orange soda', brand: 'Test Fizz', variant: '', pack_size: 330, pack_unit: 'ml', pack_count: 0 }, label: LABEL }))]);
  coach.setCoachClient(client);
  const l = await post('/api/food/photo', { ...PHOTO, barcode: code });
  assert.equal(l.kind, 'label');
  assert.equal(l.draft.barcode, code);
  assert.equal(l.draft.nutrients.kcal, 41);
  assert.equal(client.requests.length, 1, 'one reading, as before');

  const saved = await post('/api/food/label', { ...l.draft, liquid: true });
  assert.equal(saved.kind, 'label');
  assert.equal(saved.barcode, code);
  const again = await get(`/api/food/barcode/${code}`);
  assert.equal(again.item.key, saved.key);
  assert.deepEqual(offCalls, [code], 'the second scan never left the catalogue');
});

test('the hint beats a code read off the photo; a hint that does not check out is ignored; UPC-E is kept as its UPC-A', async () => {
  const label = (barcode) => said(reading({ kind: 'label', summary: 'A label', barcode, product: { name: 'Lemon soda', brand: '', variant: '', pack_size: 0, pack_unit: '', pack_count: 0 }, label: LABEL }));
  coach.setCoachClient(scripted([label('5900000000015'), label('5900000000015'), label(''), label('')]));
  assert.equal((await post('/api/food/photo', { ...PHOTO, barcode: '5000000001231' })).draft.barcode, '5000000001231');
  assert.equal((await post('/api/food/photo', { ...PHOTO, barcode: '5000000001232' })).draft.barcode, '5900000000015', 'a bad check digit is no hint');
  assert.equal((await post('/api/food/photo', { ...PHOTO, barcode: '04252614' })).draft.barcode, '042100005264');
  assert.equal((await post('/api/food/photo', PHOTO)).draft.barcode, '', 'no hint, no barcode read: none');
});

test('a packet photographed for an unknown scanned code keeps the code for typing the label in', async () => {
  const code = '5900000000015';
  coach.setCoachClient(scripted([said(reading({ kind: 'packet', summary: 'A packet of crisps', product: { name: 'Sea salt crisps', brand: 'Test Snacks', variant: '', pack_size: 40, pack_unit: 'g', pack_count: 0 } }))]));
  const r = await post('/api/food/photo', { ...PHOTO, barcode: code });
  assert.equal(r.kind, 'product-unknown');
  assert.equal(r.barcode, code);
  assert.equal(r.unreadBarcode, false);
});

test('a product kept under its EAN-13 is found by the UPC-A a scanner reports, with no second record or call out', async () => {
  OFF.set('0036000291452', {
    code: '0036000291452', product_name: 'Test tissues', brands: 'Testco', quantity: '100 g', countries_tags: ['en:united-kingdom'],
    nutriments: { 'energy-kcal_100g': 0, proteins_100g: 0, carbohydrates_100g: 0, fat_100g: 0 },
  });
  const first = await get('/api/food/barcode/0036000291452');
  assert.equal(first.item.key, 'off:0036000291452');
  const calls = offCalls.length;
  const upcA = await get('/api/food/barcode/036000291452');
  assert.equal(upcA.item.key, 'off:0036000291452');
  assert.equal(offCalls.length, calls);
  const [{ n }] = await dbmod.db()`select count(*)::int as n from food_items where barcode like '%36000291452'`;
  assert.equal(n, 1);
});
