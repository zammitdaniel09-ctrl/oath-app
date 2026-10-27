// "Usually now" and the faster ways to log: the ranking (time of day, recency, the kind of day, what
// is already logged, amounts, usual combinations), then end to end through the API: the one-tap
// predictions, water in ml, and copying one meal of a past day to today. Made-up foods and days only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { rankUsual, findCombos, usualKey, gap, timeWeight, ageWeight, USUAL } from '../src/food-usual.js';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

// ---------- The ranking, with no database ----------

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
let seq = 0;
const E = (key, date, hhmm, slot = 'breakfast', extra = {}) => ({ id: `e${(seq += 1)}`, key, date, min: toMin(hhmm), slot, ...extra });
const back = (date, n) => DateTime.fromISO(date).minus({ days: n }).toISODate();
const at = (date, hhmm) => ({ date, min: toMin(hhmm) });
const keys = (list) => list.map((p) => p.key);

test('the kernel is a circle and the recency halves every three weeks', () => {
  assert.equal(gap(toMin('23:30'), toMin('00:15')), 45);
  assert.equal(timeWeight(480, 480), 1);
  assert.ok(Math.abs(timeWeight(480, 480 + USUAL.sigma) - Math.exp(-0.5)) < 1e-9);
  assert.ok(Math.abs(ageWeight(21) - 0.5) < 1e-9);
  assert.equal(usualKey({ kind: 'item', ref_key: 'oats' }), 'item:oats');
  assert.equal(usualKey({ kind: 'recipe', ref_key: 'shakshuka' }), 'recipe:shakshuka');
  assert.equal(usualKey({ kind: 'meal', ref_id: 4, name: 'My shake' }), 'meal:4');
  assert.equal(usualKey({ kind: 'quick', name: 'Lunch  Out!' }), 'name:lunch out');
});

test('time of day: a breakfast food leads at 08:00 and is gone at 20:00', () => {
  const today = '2027-03-10';
  const list = [];
  for (let n = 1; n <= 10; n += 1) {
    list.push(E('item:oats', back(today, n), '08:00', 'breakfast'));
    list.push(E('item:pasta', back(today, n), '20:00', 'dinner'));
  }
  const morning = rankUsual(list, at(today, '08:05'));
  assert.deepEqual(keys(morning), ['item:oats']);
  assert.equal(morning[0].slot, 'breakfast');
  assert.equal(morning[0].times, 10);
  assert.equal(morning[0].min, toMin('08:00'), 'usually around 08:00');
  const evening = rankUsual(list, at(today, '20:00'));
  assert.deepEqual(keys(evening), ['item:pasta']);
  assert.equal(evening[0].slot, 'dinner');
});

test('recency: what he had last week beats what he had six weeks ago', () => {
  const today = '2027-03-10';
  const list = [];
  for (let n = 1; n <= 5; n += 1) {
    list.push(E('item:new-cereal', back(today, n), '08:00'));
    list.push(E('item:old-cereal', back(today, 40 + n), '08:00'));
  }
  const r = rankUsual(list, at(today, '08:00'));
  assert.deepEqual(keys(r), ['item:new-cereal', 'item:old-cereal']);
  assert.ok(r[0].score > r[1].score * 2.5);
  // Past the 60-day window nothing counts at all.
  const ancient = [E('item:x', back(today, 61), '08:00'), E('item:x', back(today, 62), '08:00')];
  assert.deepEqual(rankUsual(ancient, at(today, '08:00')), []);
});

test('the same kind of day counts a little more: weekend food on a Sunday, weekday food on a Wednesday', () => {
  // Pancakes on Saturdays, toast on Mondays, both at 09:00. The toast is always two days more recent.
  const list = [];
  for (const d of ['2027-05-08', '2027-05-01', '2027-04-24', '2027-04-17']) list.push(E('item:pancakes', d, '09:00'));
  for (const d of ['2027-05-10', '2027-05-03', '2027-04-26', '2027-04-19']) list.push(E('item:toast', d, '09:00'));
  const sunday = '2027-05-16';
  const wednesday = '2027-05-12';
  assert.deepEqual(keys(rankUsual(list, at(sunday, '09:00'))), ['item:pancakes', 'item:toast']);
  assert.deepEqual(keys(rankUsual(list, at(wednesday, '09:00'))), ['item:toast', 'item:pancakes']);
  // Without the bonus, recency alone puts the toast first on Sunday too.
  assert.deepEqual(keys(rankUsual(list, at(sunday, '09:00'), { dayBonus: 1 })), ['item:toast', 'item:pancakes']);
});

test('what is already logged today in that meal is left out; drinks come round again', () => {
  const today = '2027-03-10';
  const list = [];
  for (let n = 1; n <= 6; n += 1) {
    list.push(E('item:oats', back(today, n), '08:00', 'breakfast'));
    list.push(E('item:espresso', back(today, n), '08:10', 'drinks'));
    list.push(E('item:espresso', back(today, n), '11:00', 'drinks'));
  }
  assert.deepEqual(keys(rankUsual(list, at(today, '08:15'))).sort(), ['item:espresso', 'item:oats']);
  const had = [...list, E('item:oats', today, '07:40', 'breakfast'), E('item:espresso', today, '08:12', 'drinks')];
  assert.deepEqual(keys(rankUsual(had, at(today, '08:15'))), [], 'both are in today\'s diary');
  // The same food in another meal does not count as had for breakfast.
  const elsewhere = [...list, E('item:oats', today, '07:40', 'snacks')];
  assert.ok(keys(rankUsual(elsewhere, at(today, '08:15'))).includes('item:oats'));
  // The second coffee of the day is offered again three hours after the first.
  assert.deepEqual(keys(rankUsual(had, at(today, '11:05'))), ['item:espresso']);
});

test('amounts follow his most recent amount at about this time, else his most recent', () => {
  const today = '2027-03-10';
  const list = [
    E('item:oats', back(today, 9), '08:00', 'breakfast', { qty: 60, unit: 'g' }),
    E('item:oats', back(today, 6), '08:20', 'breakfast', { qty: 60, unit: 'g' }),
    E('item:oats', back(today, 3), '07:50', 'breakfast', { qty: 80, unit: 'g' }),
    E('item:oats', back(today, 1), '21:30', 'snacks', { qty: 40, unit: 'g' }),
  ];
  const morning = rankUsual(list, at(today, '08:10'));
  assert.equal(morning[0].from.qty, 80, 'the latest breakfast, not last night\'s snack');
  assert.equal(morning[0].slot, 'breakfast');
  const afternoon = rankUsual(list, at(today, '14:30'), { minScore: 0 });
  assert.equal(afternoon[0].from.qty, 40, 'nothing near 14:30, so the latest of all');
  // Logged once is not usual.
  assert.deepEqual(rankUsual([E('item:once', back(today, 1), '08:00')], at(today, '08:00')), []);
});

test('usual combinations need three times together, within 20 minutes, in the same meal', () => {
  const today = '2027-03-10';
  const days = [back(today, 2), back(today, 4)];
  const list = [];
  for (const d of days) {
    list.push(E('item:oats', d, '08:00', 'breakfast', { qty: 60 }), E('item:milk', d, '08:05', 'breakfast', { qty: 200 }));
    list.push(E('item:banana', d, '08:40', 'breakfast'));
  }
  assert.deepEqual(findCombos(list, at(today, '08:10')), [], 'twice is not yet usual');
  const third = back(today, 6);
  list.push(E('item:oats', third, '08:00', 'breakfast', { qty: 50 }), E('item:milk', third, '08:12', 'breakfast', { qty: 250 }));
  const combos = findCombos(list, at(today, '08:10'));
  assert.equal(combos.length, 1);
  assert.deepEqual(combos[0].keys, ['item:oats', 'item:milk'], 'in the order he logs them; the banana came 40 minutes later');
  assert.equal(combos[0].times, 3);
  assert.equal(combos[0].slot, 'breakfast');
  assert.deepEqual(combos[0].lines.map((l) => l.from.qty), [60, 200], 'amounts from the latest time he had it');
  // The same pair split across two meals is not a combination.
  const split = [];
  for (const d of [back(today, 1), back(today, 2), back(today, 3)]) split.push(E('item:oats', d, '08:00', 'breakfast'), E('item:milk', d, '08:05', 'snacks'));
  assert.deepEqual(findCombos(split, at(today, '08:10')), []);
  // A bigger set wins when it is nearly always the case, and nothing is offered once part of it is had.
  const trio = [];
  for (let n = 1; n <= 4; n += 1) {
    const d = back(today, n);
    trio.push(E('item:eggs', d, '09:00'), E('item:toast', d, '09:02'), E('item:juice', d, '09:03'));
  }
  assert.deepEqual(findCombos(trio, at(today, '09:00'))[0].keys, ['item:eggs', 'item:toast', 'item:juice']);
  assert.deepEqual(findCombos([...trio, E('item:toast', today, '08:55')], at(today, '09:00')), []);
  // A dinner combination is not offered at breakfast.
  assert.deepEqual(findCombos(trio, at(today, '20:00')), []);
});

// ---------- End to end through the API ----------

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2027-03-10T08:10', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-usual-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54432 + SHIFT,
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
let n = 0;
const id = () => `usual-entry-${(n += 1)}-${Date.now().toString(36)}`;

// Made-up foods of his own, per 100 g.
const FOODS = {
  porridge: { name: 'Porridge oats, test', nutrients: { kcal: 370, protein: 13, carbs: 60, sugars: 1, fat: 7, fibre: 9, salt: 0 } },
  milk: { name: 'Test milk', basis: 'ml', nutrients: { kcal: 47, protein: 3.4, carbs: 4.8, sugars: 4.8, fat: 1.7, fibre: 0, salt: 0.1 } },
  stew: { name: 'Bean stew, test', nutrients: { kcal: 110, protein: 7, carbs: 15, sugars: 3, fat: 2, fibre: 6, salt: 0.6 } },
  roll: { name: 'Bread roll, test', nutrients: { kcal: 260, protein: 9, carbs: 48, sugars: 3, fat: 3, fibre: 3, salt: 1.1 } },
};
const key = {};

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54432 + SHIFT}/oath`;
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
  for (const [k, f] of Object.entries(FOODS)) key[k] = (await post('/api/food/items', { name: f.name, basis: f.basis || 'g', nutrients: f.nutrients })).key;
  // The real tap water record from the seed data, as the one-tap water buttons log it.
  const food = await import('../src/food.js');
  const water = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../data/foods/usda-foods.json'), 'utf8')).items.find((x) => x.key === 'water-tap');
  await food.upsertItem(water);
});

after(async () => {
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('GET /api/food/usual: nothing to offer before there is a history', async () => {
  const u = await get('/api/food/usual');
  assert.deepEqual(u.now, []);
  assert.deepEqual(u.combos, []);
});

test('GET /api/food/usual: his usual breakfast, at his usual amounts, ready to log in one tap', async () => {
  // Three weeks of porridge with milk at about 08:00 and a stew at about 13:00.
  for (let d = 1; d <= 21; d += 1) {
    const date = back('2027-03-10', d);
    if (d % 7 === 3) continue; // a few days off
    await post('/api/food/log', { id: id(), key: key.porridge, qty: d <= 2 ? 70 : 60, unit: 'g', date, time: '08:00', slot: 'breakfast' });
    await post('/api/food/log', { id: id(), key: key.milk, qty: 200, unit: 'ml', date, time: '08:04', slot: 'breakfast' });
    await post('/api/food/log', { id: id(), key: key.stew, qty: 350, unit: 'g', date, time: '13:05', slot: 'lunch' });
  }
  // Removed entries count for nothing.
  for (let d = 1; d <= 5; d += 1) {
    const r = await post('/api/food/log', { id: id(), key: key.roll, qty: 80, unit: 'g', date: back('2027-03-10', d), time: '08:02', slot: 'breakfast' });
    ok(await call('DELETE', `/api/food/log/${r.entry.id}`));
  }
  setLocal('2027-03-10T08:01');
  const u = await get('/api/food/usual');
  assert.deepEqual(u.now.map((p) => p.key), [`item:${key.porridge}`, `item:${key.milk}`]);
  const [porridge] = u.now;
  assert.equal(porridge.label, 'Porridge oats', 'the short name for the chip');
  assert.equal(porridge.amount, '70 g', 'his latest amount at this time');
  assert.equal(porridge.slot, 'breakfast');
  assert.equal(porridge.times, 18);
  assert.equal(porridge.at, '08:00');
  assert.deepEqual(porridge.log, { op: 'log', data: { key: key.porridge, qty: 70, unit: 'g', slot: 'breakfast' } });
  assert.equal(porridge.kcal, 259);
  assert.ok(u.items[key.porridge], 'the record travels with the chip so it opens offline');
  assert.equal(u.combos.length, 1);
  assert.equal(u.combos[0].label, 'Usual breakfast');
  assert.equal(u.combos[0].names, 'porridge oats, test milk');
  assert.deepEqual(u.combos[0].lines.map((l) => l.log.data.qty), [70, 200]);
  assert.equal(u.combos[0].kcal, 259 + 94);

  // One tap: each line of the combination with its own id from the phone.
  const ids = [id(), id()];
  for (const [i, l] of u.combos[0].lines.entries()) {
    const r = await post(`/api/food/${l.log.op === 'log' ? 'log' : l.log.op}`, { ...l.log.data, id: ids[i] });
    assert.equal(r.entry.id, ids[i]);
    assert.equal(r.entry.slot, 'breakfast');
  }
  const after1 = await get('/api/food/usual');
  assert.deepEqual(after1.now, [], 'both are in today\'s breakfast now');
  assert.deepEqual(after1.combos, []);

  // At lunch the stew is offered, in its own meal, and a quick add he repeats comes back as he logged it.
  for (const d of [1, 3, 5]) await post('/api/food/quick', { id: id(), name: 'Canteen lunch', kcal: 640, protein: 31, date: back('2027-03-10', d), time: '12:40', slot: 'lunch' });
  setLocal('2027-03-10T12:50');
  const lunch = await get('/api/food/usual');
  assert.deepEqual(lunch.now.map((p) => [p.label, p.amount, p.slot]), [['Bean stew', '350 g', 'lunch'], ['Canteen lunch', '640 kcal', 'lunch']]);
  const canteen = lunch.now[1].log;
  assert.equal(canteen.op, 'quick');
  assert.equal(canteen.data.kcal, 640);
  assert.equal(canteen.data.protein, 31);
  assert.equal(canteen.data.carbs, undefined, 'unknown stays unknown');
  const q = await post('/api/food/quick', { ...canteen.data, id: id() });
  assert.equal(q.entry.nutrients.kcal, 640);
  assert.equal(q.entry.nutrients.carbs, null);
});

test('one-tap water: tap water logged in ml counts as a drink, and lands once', async () => {
  setLocal('2027-03-10T15:00');
  const w = await get('/api/food/items/water-tap');
  assert.equal(w.liquid, true);
  assert.ok(w.units.some((x) => x.unit === 'ml'), 'water can be logged in ml through its sourced density');
  const before = (await get('/api/food/day')).drinksMl;
  const first = id();
  const a = await post('/api/food/log', { id: first, key: 'water-tap', qty: 250, unit: 'ml', slot: 'drinks' });
  assert.equal(a.entry.ml, 250);
  assert.equal(a.entry.liquid, true);
  assert.equal(a.entry.slot, 'drinks');
  assert.equal(a.entry.amountText, '250 ml');
  assert.equal(a.entry.nutrients.kcal, 0);
  await post('/api/food/log', { id: id(), key: 'water-tap', qty: 500, unit: 'ml', slot: 'drinks' });
  // The same tap replayed from the offline queue lands once.
  const again = await post('/api/food/sync', { ops: [{ id: first, op: 'log', data: { id: first, key: 'water-tap', qty: 250, unit: 'ml', slot: 'drinks' } }] });
  assert.equal(again.results[0].duplicate, true);
  const d = await get('/api/food/day');
  assert.equal(d.drinksMl, before + 750);
});

test('copy one meal of a past day to today: same times of day, once, and undone by removing the copies', async () => {
  setLocal('2027-03-10T18:30');
  const from = '2027-03-08';
  const today = '2027-03-10';
  const lunchBefore = (await get(`/api/food/day?date=${today}`)).entries.filter((e) => e.slot === 'lunch').length;
  const opId = id();
  const r = await post('/api/food/repeat', { from, to: today, slot: 'lunch', id: opId });
  assert.equal(r.entries.length, 1, 'only the lunch');
  const [copy] = r.entries;
  assert.equal(copy.slot, 'lunch');
  assert.equal(copy.date, today);
  assert.equal(copy.source, 'repeat');
  assert.equal(DateTime.fromJSDate(new Date(copy.at), { zone: ZONE }).toFormat('HH:mm'), '13:05', 'the time of day it was had');
  // Sent again, directly or from the offline queue: the same copy, not another.
  const again = await post('/api/food/repeat', { from, to: today, slot: 'lunch', id: opId });
  assert.equal(again.duplicate, true);
  assert.equal(again.entries[0].id, copy.id);
  const synced = await post('/api/food/sync', { ops: [{ id: opId, op: 'repeat', data: { from, to: today, slot: 'lunch', id: opId } }] });
  assert.equal(synced.results[0].ok, true);
  assert.equal(synced.results[0].duplicate, true);
  let d = await get(`/api/food/day?date=${today}`);
  assert.equal(d.entries.filter((e) => e.slot === 'lunch').length, lunchBefore + 1);
  // Undo removes the copies.
  ok(await call('DELETE', `/api/food/log/${copy.id}`));
  d = await get(`/api/food/day?date=${today}`);
  assert.equal(d.entries.filter((e) => e.slot === 'lunch').length, lunchBefore);
  // A whole day still copies with no id, as "Repeat yesterday" does.
  const all = await post('/api/food/repeat', { from: '2027-03-09' });
  assert.equal(all.entries.length, 4, 'porridge, milk, stew and the canteen lunch');
  assert.equal((await call('POST', '/api/food/repeat', { from, id: 'bad id!' })).status, 400);
});
