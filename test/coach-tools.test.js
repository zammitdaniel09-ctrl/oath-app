// The coach running the app: tools reach the same functions as the buttons, rules still refuse,
// destructive actions wait for a tap, receipts are kept, the game rules can be configured, and food
// described loosely is logged as estimates instead of interrogated.
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
let clock = DateTime.fromISO('2026-11-02T08:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-coachtools-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54355 + SHIFT,
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

const reply = (stop_reason, content) => ({ stop_reason, content });
const words = (text) => ({ type: 'text', text });
const said = (obj) => reply('end_turn', [words(JSON.stringify(obj))]);
// The food matcher's choice, by item number: [item, key, unit, qty, why].
const chose = (...picks) => said({ choices: picks.map(([item, key, unit, qty, why = 'Closest record']) => ({ item, key, unit, qty, why })) });
// With no choice scripted, every item asked about gets no record, so it is logged from the estimate.
const chooseNothing = (params) => said({ choices: [...params.messages[0].content[0].text.matchAll(/^Item (\d+):/gm)].map((m) => ({ item: Number(m[1]), key: '', unit: 'g', qty: 1, why: 'Not in the list' })) });

// A stand-in for the Anthropic client that replays scripted responses and records each request. The
// coach's turns and the food matcher's structured choices come from separate queues.
function scripted(responses, choices = []) {
  const requests = [];
  const structured = [];
  return {
    requests,
    structured,
    beta: {
      messages: {
        create: async (params) => {
          const copy = JSON.parse(JSON.stringify(params));
          if (params.output_config?.format) {
            structured.push(copy);
            const next = choices.shift() || chooseNothing;
            return typeof next === 'function' ? next(params) : next;
          }
          requests.push(copy);
          const next = responses.shift();
          if (!next) throw new Error('no scripted response left');
          return next;
        },
      },
    },
  };
}
let n = 0;
const use = (name, input) => ({ type: 'tool_use', id: `t${(n += 1)}`, name, input });
// One coach turn: the model calls these tools in one round, then says `text`.
const turn = (calls, text = 'Done.', choices = []) => scripted([reply('tool_use', calls), reply('end_turn', [words(text)])], choices);
const lastResults = (c) => c.requests[c.requests.length - 1].messages.at(-1).content;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54355 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  // The food catalogue, so estimated items have records to match.
  await (await import('../src/food-seed.js')).seedFood({ force: true });
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('coach: adds, edits and finishes a task through the app\'s own functions, with receipts', async () => {
  coach.setCoachClient(turn([use('add_task', { title: 'Call the bank', due_date: '2026-11-03', deadline: '15:00' })], 'Added.'));
  const added = await call('POST', '/api/coach', { text: 'Add call the bank tomorrow 3pm' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.deepEqual(added.data.reply.actions, [{ ok: true, text: 'Added task "Call the bank", 2026-11-03 15:00' }]);
  const [t] = await dbmod.db()`select * from tasks where title = 'Call the bank'`;
  assert.equal(t.created_by, 'coach');

  coach.setCoachClient(turn([use('edit_task', { task_id: t.id, due_date: '2026-11-02', deadline: '' })]));
  await call('POST', '/api/coach', { text: 'Make it today, no time' });
  const [moved] = await dbmod.db()`select due_date, deadline from tasks where id = ${t.id}`;
  assert.equal(moved.due_date, '2026-11-02');
  assert.equal(moved.deadline, null);

  coach.setCoachClient(turn([use('complete_task', { task_id: t.id })]));
  const done = await call('POST', '/api/coach', { text: 'I called them' });
  assert.equal(done.data.reply.actions[0].text, 'Done: "Call the bank"');
  const [after] = await dbmod.db()`select done_at from tasks where id = ${t.id}`;
  assert.ok(after.done_at);
});

test('coach: habits are created, ticked off and found by id', async () => {
  coach.setCoachClient(turn([use('add_habit', { name: 'Read 25 pages', deadline: '22:00', cue: 'after dinner' })]));
  await call('POST', '/api/coach', { text: 'New habit: read 25 pages by 22:00' });
  const [h] = await dbmod.db()`select id from habits where name = 'Read 25 pages'`;
  assert.ok(h);

  const c = turn([use('find_items', { query: 'read', kind: 'habit' }), use('keep_habit', { habit_id: h.id })], 'Kept it.');
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'I read today' });
  assert.equal(r.data.reply.actions.length, 1, 'lookups leave no receipt');
  assert.match(r.data.reply.actions[0].text, /^Kept "Read 25 pages"/);
  const results = lastResults(c);
  assert.equal(results.length, 2, 'both results go back in one message');
  assert.match(results[0].content, new RegExp(`habit #${h.id} "Read 25 pages"`));
  const today = (await call('GET', '/api/today')).data;
  assert.equal(today.items.find((i) => i.id === h.id).status, 'kept');
});

test('coach: a rule refusal comes back as a failed tool result and a failed receipt', async () => {
  const [h] = await dbmod.db()`select id from habits where name = 'Read 25 pages'`;
  setLocal('2026-11-02T08:30');
  const c = turn([use('undo_habit', { habit_id: h.id })], 'Too late to undo.');
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'Undo that' });
  const [res] = lastResults(c);
  assert.equal(res.is_error, true);
  assert.match(res.content, /^Failed: Undo is only possible within 10 minutes/);
  assert.equal(r.data.reply.actions[0].ok, false);
  setLocal('2026-11-02T08:00');
});

test('coach: deleting waits for a confirmation, runs once, and can be cancelled or expire', async () => {
  const { data: task } = await call('POST', '/api/tasks', { title: 'Old errand' });
  coach.setCoachClient(turn([use('delete_task', { task_id: task.id })], 'Tap Confirm and it is gone.'));
  const r = await call('POST', '/api/coach', { text: 'Delete the old errand' });
  const p = r.data.reply.pending[0];
  assert.equal(p.summary, 'Delete task "Old errand"');
  assert.equal(r.data.reply.actions, null, 'nothing happened yet');
  assert.equal((await dbmod.db()`select deleted_at from tasks where id = ${task.id}`)[0].deleted_at, null, 'not deleted yet');

  const ok = await call('POST', `/api/coach/pending/${p.id}`, { confirm: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'done');
  assert.ok((await dbmod.db()`select deleted_at from tasks where id = ${task.id}`)[0].deleted_at);
  const again = await call('POST', `/api/coach/pending/${p.id}`, { confirm: true });
  assert.equal(again.status, 409);

  const { data: t2 } = await call('POST', '/api/tasks', { title: 'Keep me' });
  coach.setCoachClient(turn([use('delete_task', { task_id: t2.id })]));
  const r2 = await call('POST', '/api/coach', { text: 'Delete keep me' });
  const no = await call('POST', `/api/coach/pending/${r2.data.reply.pending[0].id}`, { confirm: false });
  assert.equal(no.data.status, 'cancelled');
  assert.equal((await dbmod.db()`select deleted_at from tasks where id = ${t2.id}`)[0].deleted_at, null);

  coach.setCoachClient(turn([use('delete_task', { task_id: t2.id })]));
  const r3 = await call('POST', '/api/coach', { text: 'Delete keep me' });
  const id3 = r3.data.reply.pending[0].id;
  await dbmod.db()`update coach_pending set created_at = now() - interval '31 minutes' where id = ${id3}`;
  const late = await call('POST', `/api/coach/pending/${id3}`, { confirm: true });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /expired/);

  const history = (await call('GET', '/api/coach')).data.messages;
  const first = history.find((m) => m.pending?.[0]?.id === p.id);
  assert.equal(first.pending[0].status, 'done');
  assert.ok(history.some((m) => m.role === 'assistant' && m.text === 'Done: Deleted task "Old errand".'));
});

test('coach: changing the game rules waits for a yes; schedule changes do not', async () => {
  coach.setCoachClient(turn([use('change_game_rules', { pardonsPerMonth: 3 }), use('update_schedule', { morningTime: '06:30' })]));
  const r = await call('POST', '/api/coach', { text: 'Three pardons a month, and brief me at 6:30' });
  assert.equal(r.data.reply.pending[0].summary, 'Change rules: Pardons a month to 3');
  let s = (await call('GET', '/api/settings')).data;
  assert.equal(s.morningTime, '06:30');
  assert.equal(s.pardonsPerMonth, 2);
  await call('POST', `/api/coach/pending/${r.data.reply.pending[0].id}`, { confirm: true });
  s = (await call('GET', '/api/settings')).data;
  assert.equal(s.pardonsPerMonth, 3);
});

test('game rules: bounded, consistent, and a lower max HP lowers current HP', async () => {
  assert.equal((await call('PATCH', '/api/settings', { maxHp: 20 })).status, 400);
  assert.equal((await call('PATCH', '/api/settings', { repeatMultiplier: 'lots' })).status, 400);
  assert.equal((await call('PATCH', '/api/settings', { dailyLossCap: 120 })).status, 400, 'a day cannot cost more than max HP');
  const ok = await call('PATCH', '/api/settings', { maxHp: 80, repeatMultiplier: 1.3 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.maxHp, 80);
  assert.equal(ok.data.repeatMultiplier, 1.25, 'rounded to its step');
  const t = (await call('GET', '/api/today')).data;
  assert.equal(t.game.hp, 80);
  await call('PATCH', '/api/settings', { maxHp: 100, repeatMultiplier: 1.5, pardonsPerMonth: 2 });
});

// ---------- Food from a loose description ----------

const coachFood = (name) => dbmod.db()`select * from food_log where source = 'coach' and deleted_at is null and name = ${name} order by created_at desc`;

test('coach: food described loosely is matched and logged as estimates, one receipt per item, the rest as quick adds', async () => {
  const c = turn([use('log_food_estimate', {
    slot: 'lunch',
    items: [
      { name: 'white rice', search: 'white rice cooked', amount: 180, unit: 'g', kcal_estimate: 230 },
      { name: 'banana', search: 'banana', amount: 1, unit: 'piece', kcal_estimate: 105 },
      { name: 'zorblax party bake', search: 'zorblax bake', amount: 150, unit: 'g', kcal_estimate: 420 },
    ],
  })], 'Logged it for lunch: a plate of rice, a banana and a slice of that bake.', [
    chose([0, 'rice-white-long-grain-cooked', 'g', 180, 'Cooked white rice'], [1, 'banana-raw', 'p:1 medium (7" to 7-7/8" long)', 1, 'A medium banana']),
  ]);
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'had rice, a banana and some of zorblax bake for lunch' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const receipts = r.data.reply.actions;
  assert.equal(receipts.length, 3, 'one receipt per item');
  assert.ok(receipts.every((a) => a.ok), JSON.stringify(receipts));
  assert.match(receipts[0].text, /^Logged white rice ~180 g \(estimate, \d+ kcal\)$/);
  assert.match(receipts[1].text, /^Logged banana ~\d+ g \(estimate, 105 kcal\)$/);
  assert.equal(receipts[2].text, 'Logged zorblax party bake ~150 g as a quick add (estimate, 420 kcal)');

  // Matched items are catalogue entries with their amounts flagged as estimates.
  const [rice] = await dbmod.db()`select * from food_log where source = 'coach' and kind = 'item' and ref_key like 'rice%' order by created_at desc limit 1`;
  assert.ok(rice, 'the rice was logged against a catalogue record');
  assert.equal(rice.estimate, true);
  assert.equal(rice.slot, 'lunch');
  assert.equal(rice.grams, 180);
  assert.equal(rice.date, '2026-11-02');
  const [banana] = await dbmod.db()`select * from food_log where source = 'coach' and kind = 'item' and ref_key = 'banana-raw' order by created_at desc limit 1`;
  assert.equal(banana.estimate, true);
  assert.match(banana.unit, /^p:1 medium/);
  assert.equal(Math.round(banana.nutrients.kcal), 105);

  // An item the catalogue lacks is a quick add of the coach's estimate, never dropped.
  const [bake] = await coachFood('zorblax party bake');
  assert.equal(bake.kind, 'quick');
  assert.equal(bake.nutrients.kcal, 420);
  assert.equal(bake.estimate, true);
  assert.equal(bake.amount_text, 'about 150 g');
  assert.equal(bake.slot, 'lunch');

  // The model hears the receipts plus the entry ids and the records used, so it can say what it assumed.
  const [res] = lastResults(c);
  assert.equal(res.is_error, undefined);
  assert.match(res.content, /^Logged white rice ~180 g/);
  assert.ok(res.content.includes(`entry ${banana.id}, lunch on 2026-11-02, catalogue record "${banana.name}"`), res.content);
  assert.ok(res.content.includes('chosen because: A medium banana'), res.content);
  assert.ok(res.content.includes(`entry ${bake.id}, lunch on 2026-11-02, quick add, no catalogue match`), res.content);
  // The coach's items went through the same choice as a photo, once for all of them.
  assert.equal(c.structured.length, 1);
  assert.match(c.structured[0].messages[0].content[0].text, /Item 1: name "banana"[\s\S]*key banana-raw/);
});

test('coach: "large fries from Burger King" is the restaurant\'s own large serving, and the gaps in the record are filled from the coach\'s estimate', async () => {
  const { upsertItem } = await import('../src/food.js');
  await upsertItem({
    key: 'test-coach-bk-fries', kind: 'product', name: 'French fries', brand: 'Burger King', state: 'fried', basis: 'g', source: 'usda',
    nutrients: { kcal: 280, protein: 3.2, carbs: 37, sugars: null, fat: 13, satfat: 2, fibre: null, salt: 0.6, caffeine: 0, alcohol: 0 },
    portions: [{ label: '1 small serving', g: 89, source: 'usda' }, { label: '1 medium serving', g: 116, source: 'usda' }, { label: '1 large serving', g: 154, source: 'usda' }],
  });
  const c = turn([use('log_food_estimate', {
    slot: 'dinner',
    items: [{
      name: 'fries', brand: 'Burger King', preparation: 'deep fried', size: 'large', search: 'burger king french fries', searches: ['french fries'],
      amount: 160, unit: 'g', weight: 160, kcal_estimate: 480,
      per100: { kcal: 300, protein: 3.4, carbs: 38, sugars: 0.3, fat: 14, satfat: 2.2, fibre: 3.5, salt: 0.7, caffeine: 0, alcohol: 0 },
    }],
  })], 'Logged large Burger King fries for dinner.', [chose([0, 'test-coach-bk-fries', 'p:1 large serving', 1, "Burger King's own large fries"])]);
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'large fries from burger king for dinner' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // The choice saw everything the coach said, and the restaurant's record with its portions.
  const asked = c.structured[0].messages[0].content[0].text;
  assert.match(asked, /Item 0: name "fries", brand or restaurant "Burger King", preparation "deep fried", size words "large"/);
  assert.match(asked, /key test-coach-bk-fries \| French fries \| brand Burger King .*p:1 large serving \(154 g\)/);
  assert.match(r.data.reply.actions[0].text, /^Logged fries ~154 g \(estimate, 431 kcal\)$/);
  const [row] = await dbmod.db()`select * from food_log where source = 'coach' and ref_key = 'test-coach-bk-fries'`;
  assert.equal(row.unit, 'p:1 large serving');
  assert.equal(row.grams, 154);
  assert.equal(row.estimate, true);
  assert.equal(row.slot, 'dinner');
  // The record's own values stay; only what it lacks comes from the estimate, and is marked.
  assert.deepEqual(row.filled, ['sugars', 'fibre']);
  assert.ok(Math.abs(row.nutrients.kcal - 280 * 1.54) < 1e-6);
  assert.ok(Math.abs(row.nutrients.fibre - 3.5 * 1.54) < 1e-6);
  assert.ok(row.nutrients.sugars > 0 && row.nutrients.sugars < 1);
  const [res] = lastResults(c);
  assert.match(res.content, /catalogue record "French fries" by Burger King, 1 large serving, chosen because: Burger King's own large fries, filled from your estimate: sugars and fibre/);
});

test('coach: an unmatched drink with an estimate is a quick add in ml; without one it fails loudly and nothing is logged', async () => {
  const c = turn([use('log_food_estimate', {
    items: [
      { name: 'zorblax fizz', search: 'zorblax fizz', amount: 330, unit: 'ml', kcal_estimate: 140 },
      { name: 'zorblax crunch', search: 'zorblax crunch', amount: 40, unit: 'g' },
      { name: 'halloumi', search: 'halloumi', amount: 80, unit: 'g', kcal_estimate: 260 },
    ],
  })], 'Logged the fizz at about 140 kcal.');
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'a can of zorblax fizz, a zorblax crunch and some halloumi' });
  const [fizz, crunch, halloumi] = r.data.reply.actions;
  // A record with no energy value on file (a placeholder waiting for a label) is never a match: the coach's estimate is logged.
  assert.deepEqual(halloumi, { ok: true, text: 'Logged halloumi ~80 g as a quick add (estimate, 260 kcal)' });
  assert.deepEqual(fizz, { ok: true, text: 'Logged zorblax fizz ~330 ml as a quick add (estimate, 140 kcal)' });
  assert.equal(crunch.ok, false);
  assert.match(crunch.text, /^Could not log zorblax crunch: nothing like it in the catalogue\. Send it again with a kcal_estimate$/);
  const [row] = await coachFood('zorblax fizz');
  assert.equal(row.ml, 330);
  assert.equal(row.estimate, true);
  assert.equal(row.amount_text, 'about 330 ml');
  assert.equal(row.slot, 'drinks', 'a drink with no slot given goes to drinks');
  assert.equal((await coachFood('zorblax crunch')).length, 0);
  const [res] = lastResults(c);
  assert.equal(res.is_error, undefined, 'one item worked, so the call is not an error');
  assert.match(res.content, /\nFailed: Could not log zorblax crunch/);
  assert.match(res.content, /halloumi: entry [\w-]+, \w+ on 2026-11-02, quick add, no catalogue match(;|$)/, 'the placeholder record is passed over, and the estimate used');

  // Nothing logged at all is an error result, so the model retries with an estimate.
  const c2 = turn([use('log_food_estimate', { items: [{ name: 'zorblax crunch', search: 'zorblax crunch', amount: 40, unit: 'g' }] })]);
  coach.setCoachClient(c2);
  await call('POST', '/api/coach', { text: 'and another crunch' });
  assert.equal(lastResults(c2)[0].is_error, true);
});

test('coach: the persona is warm and assumes, and the estimate tool is offered with typical portions', async () => {
  const c = scripted([reply('end_turn', [words('Morning! Let us get the gym in before nine.')])]);
  coach.setCoachClient(c);
  await call('POST', '/api/coach', { text: 'morning' });
  // The persona is a system block of its own; the current data follows it in another.
  const [{ text: persona }, data] = c.requests[0].system;
  assert.match(data.text, /^Current data:\n/);
  assert.ok(!persona.includes('Current data:'));
  assert.ok(!/ruthless|drill-sergeant/i.test(persona), 'the rough framing is gone');
  assert.ok(!persona.includes('—'), 'no em dashes');
  assert.match(persona, /Assume and act/);
  assert.match(persona, /Ask at most one short question/);
  assert.match(persona, /Not pushy/);
  assert.match(persona, /no labelled sections/);
  assert.ok(!/End with the next action/.test(persona), 'no forced call to action at the end of every reply');
  assert.match(persona, /\*\*bold\*\* for the one thing that matters most/, 'Markdown the app can draw');
  assert.match(persona, /Food never touches HP/);
  assert.match(persona, /Never ask him for grams/);
  assert.match(persona, /Never claim \(no evidence\)/);
  const tools = Object.fromEntries(c.requests[0].tools.map((t) => [t.name, t]));
  const est = tools.log_food_estimate;
  assert.ok(est, 'log_food_estimate is offered');
  assert.deepEqual(est.input_schema.required, ['items']);
  assert.deepEqual(est.input_schema.properties.items.items.properties.unit.enum, ['g', 'ml', 'piece']);
  for (const k of ['brand', 'variety', 'preparation', 'size', 'weight', 'per100']) assert.ok(est.input_schema.properties.items.items.properties[k], `items carry ${k}`);
  assert.match(est.description, /Never ask him for grams/);
  assert.match(est.description, /most specific catalogue record/);
  assert.match(tools.find_items.description, /act on the clear best match/);
});

test('coach: prompt caching marks the last tool, the persona and the newest message, never the current data', async () => {
  const c = turn([use('find_items', { query: 'read' })], 'Found it.');
  coach.setCoachClient(c);
  await call('POST', '/api/coach', { text: 'find read' });
  assert.equal(c.requests.length, 2, 'two rounds of the tool loop');
  const mark = { type: 'ephemeral' };
  for (const r of c.requests) {
    const [persona, data] = r.system;
    assert.deepEqual(persona.cache_control, mark);
    assert.equal(data.cache_control, undefined, 'the current data changes every time, so it is never a cache point');
    assert.deepEqual(r.tools.at(-1).cache_control, mark);
    assert.ok(r.tools.slice(0, -1).every((t) => !t.cache_control), 'one point for all the tools');
    // One moving point in the conversation, on the newest message's last block: three in all, of four allowed.
    const marked = r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control);
    assert.equal(marked.length, 1);
    assert.deepEqual(r.messages.at(-1).content.at(-1).cache_control, mark);
    // Server-side fallback is still asked for.
    assert.equal(r.fallbacks, 'default');
    assert.deepEqual(r.betas, ['server-side-fallback-2026-07-01']);
  }
  assert.equal(c.requests[0].messages.at(-1).content.at(-1).text, 'find read');
  assert.equal(c.requests[1].messages.at(-1).content[0].type, 'tool_result');
  // The second round repeats the first word for word up to the moved point, so it reads it back.
  assert.equal(c.requests[1].system[1].text, c.requests[0].system[1].text);
  const { cache_control: moved, ...asked } = c.requests[0].messages.at(-1).content.at(-1);
  assert.deepEqual(moved, mark);
  assert.deepEqual(c.requests[1].messages.at(-3).content, [asked]);
  const { TOOL_DEFS } = await import('../src/coach-tools.js');
  assert.ok(TOOL_DEFS.every((t) => !t.cache_control), 'the shared tool list itself is never marked');
});

test('coach: a new time zone waits for his tap; a bad one is refused at once, and the same zone just saves', async () => {
  coach.setCoachClient(turn([use('update_schedule', { timezone: 'Asia/Tokyo', morningTime: '06:45' })], 'Tap Confirm and you are on Tokyo time.'));
  const r = await call('POST', '/api/coach', { text: 'I am in Tokyo now, brief me at 6:45' });
  const p = r.data.reply.pending[0];
  assert.equal(p.summary, 'Change your time zone to Asia/Tokyo, with morning brief at 06:45');
  assert.equal(r.data.reply.actions, null, 'nothing happened yet');
  let s = (await call('GET', '/api/settings')).data;
  assert.equal(s.timezone, 'Europe/Malta', 'today is not rolled over before the tap');
  assert.equal(s.morningTime, '06:30', 'the rest of the change waits with it');
  const ok = await call('POST', `/api/coach/pending/${p.id}`, { confirm: true });
  assert.equal(ok.data.status, 'done', JSON.stringify(ok.data));
  s = (await call('GET', '/api/settings')).data;
  assert.equal(s.timezone, 'Asia/Tokyo');
  assert.equal(s.morningTime, '06:45');
  await call('PATCH', '/api/settings', { timezone: 'Europe/Malta', morningTime: '06:30' });

  coach.setCoachClient(turn([use('update_schedule', { timezone: 'Mars/Olympus' })]));
  const bad = await call('POST', '/api/coach', { text: 'Set my zone to Mars' });
  assert.deepEqual(bad.data.reply.pending, []);
  assert.equal(bad.data.reply.actions[0].ok, false);
  assert.match(bad.data.reply.actions[0].text, /Unknown time zone/);

  coach.setCoachClient(turn([use('update_schedule', { timezone: 'Europe/Malta', eveningTime: '21:30' })]));
  const same = await call('POST', '/api/coach', { text: 'Evening check at 21:30' });
  assert.deepEqual(same.data.reply.pending, []);
  assert.equal((await call('GET', '/api/settings')).data.eveningTime, '21:30');
});

test('coach: goal steps say whether they are ticked, and toggle_goal_step ticks or unticks as asked', async () => {
  const { runTool } = await import('../src/coach-tools.js');
  const sql = dbmod.db();
  const ctx = () => ({ actions: [], pending: [] });
  await runTool('add_goal', { title: 'Run a 10k' }, ctx());
  const [g] = await sql`select id from goals where title = 'Run a 10k'`;
  await runTool('add_goal_step', { goal_id: g.id, text: 'Buy running shoes' }, ctx());
  const [n] = await sql`select id from nodes where text = 'Buy running shoes'`;
  await runTool('convert_goal_step', { step_id: n.id, to: 'task' }, ctx());
  const found = async () => (await runTool('find_items', { query: 'running shoes', kind: 'step' })).content;
  assert.match(await found(), new RegExp(`step #${n.id} "Buy running shoes" in goal "Run a 10k" \\(a task, not ticked\\)`));

  const toggle = async (input) => {
    const c = ctx();
    await runTool('toggle_goal_step', { step_id: n.id, ...input }, c);
    return c.actions[0].text;
  };
  assert.equal(await toggle({ done: true }), 'Ticked "Buy running shoes"');
  assert.match(await found(), /\(a task, ticked\)/);
  assert.equal(await toggle({ done: true }), '"Buy running shoes" was already ticked, so nothing changed');
  assert.match(await found(), /\(a task, ticked\)/, 'asking twice never unticks it');
  assert.equal(await toggle({ done: false }), 'Unticked "Buy running shoes"');
  assert.equal(await toggle({ done: false }), '"Buy running shoes" was already unticked, so nothing changed');
  assert.equal(await toggle({}), 'Ticked "Buy running shoes"', 'with no done it still flips');
});

test('coach: stopping a focus block as done when the item cannot be ticked is a failed receipt, not "finished"', async () => {
  const { runTool } = await import('../src/coach-tools.js');
  const { data: task } = await call('POST', '/api/tasks', { title: 'Write the cover letter', due_date: '2026-11-02' });
  const started = { actions: [], pending: [] };
  await runTool('start_focus', { kind: 'task', id: task.id, minutes: 25 }, started);
  assert.equal(started.actions[0].ok, true, JSON.stringify(started.actions));
  // Gone before the block ends, so ticking it fails.
  await dbmod.db()`update tasks set deleted_at = now() where id = ${task.id}`;
  const ctx = { actions: [], pending: [] };
  const r = await runTool('stop_focus', { outcome: 'done' }, ctx);
  assert.equal(r.isError, true);
  assert.equal(ctx.actions[0].ok, false);
  assert.equal(ctx.actions[0].text, 'Focus ended, but "Write the cover letter" was not ticked: That task is already done or does not exist.');
  const [s] = await dbmod.db()`select outcome, ended_at from focus_sessions where ref_id = ${task.id} and kind = 'task'`;
  assert.equal(s.outcome, 'late');
  assert.ok(s.ended_at);
});
