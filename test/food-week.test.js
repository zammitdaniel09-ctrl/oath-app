// v8 food, end to end: the energy need following Apple Health's activity, water from drinks against
// 35 ml per kg, weight over 90 days, the average day as a nutrition label, and the Sunday food report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
// A Sunday evening.
let clock = DateTime.fromISO('2027-03-14T18:30', { zone: ZONE });
const TODAY = '2027-03-14';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-foodweek-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54421,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let sql; let health;

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
const id = () => `week-entry-${(n += 1)}`;

// A made-up person, nobody real: lean mass 45.6 kg, so Katch-McArdle gives 1,355 kcal resting.
const PERSON = { sex: 'female', birthDate: '1995-06-20', heightCm: 168, weightKg: 60, bodyFat: 24, activity: 'moderate', goal: 'keep' };
const key = {};

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54421/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  sql = dbmod.db();
  const engine = await import('../src/engine.js');
  await engine.ensureGame();
  ({ app } = await import('../src/server.js'));
  health = await import('../src/health.js');
  ok(await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' }));
  ok(await call('PUT', '/api/body', PERSON));
  const water = await post('/api/food/items', { name: 'Test still water', basis: 'g', density: 1, liquid: true, portions: [{ label: '1 glass', g: 250 }],
    nutrients: { kcal: 0, protein: 0, carbs: 0, sugars: 0, fat: 0, satfat: 0, fibre: 0, salt: 0 } });
  key.water = water.key;
  const porridge = await post('/api/food/items', { name: 'Test porridge', basis: 'g', nutrients: { kcal: 150, protein: 5, carbs: 25, sugars: 2, fat: 3, satfat: 0.6, fibre: 3, salt: 0.1, mufa: 1.2, iron: 1.5 } });
  key.porridge = porridge.key;
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('the energy need follows Apple Health once it has active energy for 4 of the last 7 days', async () => {
  const before = await get('/api/body');
  assert.equal(before.needs.about.energy.from, 'factor');
  assert.equal(before.needs.refs.kcal, 2100, '1,355 × 1.55');
  assert.equal(before.needs.refs.water, 2100, '35 ml per kg at 60 kg');

  // Three days in the window, one before it and today, which is still going: not enough yet.
  await health.ingestHealth({ days: [
    { date: '2027-03-06', active_kcal: 2500 }, { date: '2027-03-08', active_kcal: 400 }, { date: '2027-03-09', active_kcal: 500 },
    { date: '2027-03-10', active_kcal: 600 }, { date: TODAY, active_kcal: 3000 },
  ] });
  assert.equal((await get('/api/body')).needs.about.energy.from, 'factor');

  // Five days: (1,355 + 500 on average) / 0.9 = 2,061.
  await health.ingestHealth({ days: [{ date: '2027-03-12', active_kcal: 300 }, { date: '2027-03-13', active_kcal: 700 }] });
  const moved = await get('/api/body');
  assert.equal(moved.needs.about.energy.from, 'health');
  assert.equal(moved.needs.about.energy.active, 500);
  assert.equal(moved.needs.refs.kcal, 2060);
  assert.equal(moved.needs.refs.protein, 96, 'protein stays 1.6 g per kg');

  // Apple Health's own resting energy on 4 days replaces the formula: (1,400 + 500) / 0.9 = 2,111.
  await health.ingestHealth({ days: ['2027-03-09', '2027-03-10', '2027-03-12', '2027-03-13'].map((date) => ({ date, basal_kcal: 1400 })) });
  const b = await get('/api/body');
  assert.equal(b.needs.refs.kcal, 2110);
  assert.equal(b.needs.about.energy.restFrom, 'health');
  assert.equal((await get('/api/food/day')).needs.kcal, 2110, 'the Food tab measures against it');

  const snap = await (await import('../src/state.js')).coachSnapshot();
  assert.match(snap, /Energy: 2,110 kcal: resting 1,400 \+ 500 active on average \(Apple Health, last 7 days\); digesting food is the other 10%\./);
  assert.match(snap, /water from drinks about 2100 ml/);
});

test('weight over 90 days: saved weights and Apple Health, one a day, what he saved winning', async () => {
  await sql`delete from events where type = 'weight'`;
  const at = (date, hm) => DateTime.fromISO(`${date}T${hm}`, { zone: ZONE }).toJSDate();
  for (const [date, kg] of [['2026-12-01', 61.5], ['2027-01-10', 60], ['2027-02-20', 59.4]]) {
    await sql`insert into events (type, data, at) values ('weight', ${sql.json({ kg })}, ${at(date, '08:00')})`;
  }
  await health.ingestHealth({ days: [{ date: '2027-02-20', weight: 59.9 }, { date: '2027-03-01', weight: 59.1 }] });
  const { weights } = await get('/api/body');
  assert.deepEqual(weights, [
    { date: '2027-01-10', kg: 60, from: 'oath' },
    { date: '2027-02-20', kg: 59.4, from: 'oath' },
    { date: '2027-03-01', kg: 59.1, from: 'health' },
  ]);
});

test('water: every drink with a density counts in ml, however it was logged', async () => {
  await post('/api/food/log', { id: id(), key: key.water, qty: 2, unit: 'p:1 glass', date: TODAY, time: '09:00' });
  await post('/api/food/log', { id: id(), key: key.water, qty: 330, unit: 'g', date: TODAY, time: '13:00' });
  const d = await get('/api/food/day');
  assert.equal(d.drinksMl, 830);
  assert.equal(d.needs.water, 2100);

  // A drink logged in grams before ml was worked out gets its ml from the record when the app starts.
  const [item] = await sql`select id from food_items where key = ${key.water}`;
  await sql`insert into food_log (id, date, at, slot, kind, ref_id, ref_key, name, qty, unit, grams, ml, liquid, nutrients)
            values ('old-water', '2027-03-12', ${DateTime.fromISO('2027-03-12T10:00', { zone: ZONE }).toJSDate()}, 'drinks', 'item', ${item.id}, ${key.water}, 'Test still water', 400, 'g', 400, null, true, ${sql.json({ kcal: 0 })})`;
  await (await import('../src/food.js')).migrateFood();
  const [old] = await sql`select ml from food_log where id = 'old-water'`;
  assert.equal(Number(old.ml), 400);
});

test('Trends: the average day as a nutrition label, every nutrient, unknown left unknown', async () => {
  await post('/api/food/log', { id: id(), key: key.porridge, qty: 200, unit: 'g', date: '2027-03-10', time: '08:00' });
  await post('/api/food/log', { id: id(), key: key.porridge, qty: 100, unit: 'g', date: '2027-03-12', time: '08:00' });
  const h = await get('/api/food/history?days=7');
  assert.equal(h.label.days, 2, 'complete days only, today left out');
  assert.equal(h.label.kcal, 225, '(300 + 150) / 2');
  assert.equal(h.label.mufa, 1.8, 'the label goes past the big seven');
  assert.equal(h.label.vitc, null, 'nothing on record: unknown, never zero');
  assert.equal(h.avg.drinksMl, 200, '400 ml one day, none logged the other');
});

test('the Sunday food report: once, from 19:00, in the chat and as a push; quiet without a key or food', async () => {
  const coach = await import('../src/coach.js');
  const { runOnce } = await import('../src/loop.js');
  const { foodWeekReport } = await import('../src/food-take.js');
  const messages = async () => (await sql`select text from coach_messages where role = 'assistant' order by id`).map((m) => m.text);

  assert.equal(await foodWeekReport(), null, 'no AI key: nothing');
  process.env.ANTHROPIC_API_KEY = 'test';
  const requests = [];
  coach.setCoachClient({
    beta: { messages: { create: async (p) => {
      requests.push(JSON.parse(JSON.stringify(p)));
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Porridge most mornings did the heavy lifting: **fibre** was solid. Try a glass of water with lunch.' }] };
    } } },
  });
  try {
    await runOnce();
    assert.equal(requests.length, 0, 'before 19:00 nothing is written');

    clock = DateTime.fromISO('2027-03-14T19:05', { zone: ZONE });
    await runOnce();
    assert.equal(requests.length, 1);
    assert.match(requests[0].system, /His food this week:\nHis food over the last 7 days, 2 of them fully logged before today/);
    assert.match(requests[0].system, /Drinks: 200 ml on an average logged day, against a reference of about 2,100 ml/);
    assert.match(requests[0].messages[0].content, /weekly food report/);
    assert.match(requests[0].messages[0].content, /Three to five short sentences: what went well first, then one or two concrete ideas/);
    assert.deepEqual(await messages(), ['Porridge most mornings did the heavy lifting: **fibre** was solid. Try a glass of water with lunch.']);
    assert.equal((await sql`select 1 from reminders_sent where key = ${`food-week:${TODAY}`}`).length, 1);

    clock = DateTime.fromISO('2027-03-14T20:30', { zone: ZONE });
    await runOnce();
    assert.equal(requests.length, 1, 'once a week');

    // The push carries plain text.
    const again = await foodWeekReport();
    assert.equal(again.note.title, 'Your food week');
    assert.equal(again.note.body, 'Porridge most mornings did the heavy lifting: fibre was solid. Try a glass of water with lunch.');
    assert.equal(again.note.url, '/#/coach');

    // A week with nothing logged: no report and no call.
    clock = DateTime.fromISO('2027-04-11T19:10', { zone: ZONE });
    const calls = requests.length;
    assert.equal(await foodWeekReport(), null);
    await runOnce();
    assert.equal(requests.length, calls);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    coach.setCoachClient(null);
  }
});
