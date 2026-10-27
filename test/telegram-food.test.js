// Food by photo in Telegram: a photo from the linked chat is read like the app's camera and answered with
// buttons; "Log it" logs exactly once however often it is tapped; Cancel, expiry, a product's portion
// buttons, the caption as a hint, and chats that are not linked. Against a real Postgres, with Telegram's
// API (and its file downloads) stood in for by a scripted fetch, and Claude by a scripted client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-tgfood-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54436 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

const CHAT = 4242;
let dbmod; let tg; let coach; let food;
const realFetch = globalThis.fetch;

// A tiny JPEG's first bytes: enough for the reading's checks; the scripted Claude never looks at it.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF made-up photo bytes')]);

// Telegram's API: every call recorded; getFile answers with a path, downloads with the photo's bytes.
let calls = [];
let downloads = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/file/')) {
    downloads.push(u);
    return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) } });
  }
  if (!u.startsWith('https://api.telegram.org/')) return realFetch(url, init);
  const method = u.split('/').pop();
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  if (method === 'getFile') return json({ ok: true, result: { file_id: body.file_id, file_size: JPEG.length, file_path: `photos/${body.file_id}.jpg` } });
  return json({ ok: true, result: { message_id: 99 } });
};
const sent = (method) => calls.filter((c) => c.method === method);
const lastText = () => sent('sendMessage').at(-1)?.body;

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
const reading = (over) => ({ kind: 'unclear', summary: '', barcode: '', product: { name: '', brand: '', variant: '', pack_size: 0, pack_unit: '', pack_count: 0 },
  label: { basis: 'none', serving_size: 0, serving_unit: '', serving_label: '', values: [] }, items: [], question: '', ...over });
const PER100 = { kcal: 100, protein: 2, carbs: 20, sugars: 8, fat: 1, satfat: 0.2, fibre: 2, salt: 0.05, caffeine: 0, alcohol: 0 };
const eaten = (over) => ({ name: 'Food', brand: '', variety: '', preparation: '', size: '', amount: 100, unit: 'g', weight: 100, confidence: 'medium', searches: [], per100: PER100, ...over });
const chose = (...picks) => said({ choices: picks.map(([item, key, unit, qty, why = 'Closest record']) => ({ item, key, unit, qty, why })) });

// A plate of rice and a banana, read and matched.
const plate = () => scripted([
  said(reading({ kind: 'meal', summary: 'Rice and a banana', items: [
    eaten({ name: 'banana', searches: ['banana'], amount: 1, unit: 'piece', weight: 118 }),
    eaten({ name: 'white rice', preparation: 'boiled', searches: ['white rice cooked'], amount: 180, weight: 180 }),
  ] })),
  chose([0, 'tg-banana', 'p:1 medium', 1], [1, 'tg-rice-cooked', 'g', 180]),
]);

let updateId = 1000;
const photoMessage = (over = {}) => ({
  update_id: (updateId += 1),
  message: { message_id: updateId, chat: { id: CHAT }, photo: [
    { file_id: 'small', width: 90, height: 67, file_size: 1200 },
    { file_id: 'large', width: 1280, height: 960, file_size: 98000 },
    { file_id: 'medium', width: 320, height: 240, file_size: 9000 },
  ], ...over },
});
const tap = (data, chatId = CHAT) => ({ update_id: (updateId += 1), callback_query: { id: `cb${updateId}`, data, message: { message_id: 99, chat: { id: chatId } } } });
const buttonsOf = (body) => body?.reply_markup?.inline_keyboard?.flat() || [];
const idFrom = (body) => buttonsOf(body).find((b) => b.callback_data?.startsWith('food:log:'))?.callback_data.split(':')[2];
const entries = async (id) => dbmod.db()`select * from food_log where id like ${`tg-${id}-%`} and deleted_at is null order by id`;

const EAN = (() => {
  const base = '501234567890';
  const sum = base.split('').map(Number).reverse().reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
})();

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54436 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.ANTHROPIC_API_KEY = 'test';
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  const engine = await import('../src/engine.js');
  await engine.ensureGame();
  tg = await import('../src/telegram.js');
  coach = await import('../src/coach.js');
  food = await import('../src/food.js');
  // Made-up records for the matcher, and a canned drink with its own barcode.
  const base = { kind: 'generic', basis: 'g', source: 'usda' };
  await food.upsertItem({ ...base, key: 'tg-banana', name: 'Banana, raw', portions: [{ label: '1 medium', g: 118, source: 'usda' }], nutrients: { kcal: 89, protein: 1.1, carbs: 22.8, sugars: 12.2, fat: 0.3, satfat: 0.1, fibre: 2.6, salt: 0 } });
  await food.upsertItem({ ...base, key: 'tg-rice-cooked', name: 'Rice, white, cooked', state: 'cooked', nutrients: { kcal: 130, protein: 2.7, carbs: 28.2, sugars: 0.1, fat: 0.3, satfat: 0.1, fibre: 0.4, salt: 0 } });
  await food.upsertItem({ key: 'tg-fizz', kind: 'product', name: 'Lemon fizz', brand: 'Madeup', barcode: EAN, basis: 'ml', liquid: true, source: 'off',
    pack: { size: 330, unit: 'ml', label: '330 ml' }, serving: { size: 250, unit: 'ml', label: '1 glass' }, nutrients: { kcal: 40, protein: 0, carbs: 10, sugars: 10, fat: 0, satfat: 0, fibre: 0, salt: 0.02 } });
  await dbmod.setKV('telegram', { chatId: CHAT, botUsername: 'oath_test_bot', secret: 'webhook-secret-for-tests-0123456789abcdef' });
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('a photo of a plate becomes a short reply with the items, estimates marked, and Log it / Cancel', async () => {
  calls = [];
  downloads = [];
  const claude = plate();
  coach.setCoachClient(claude);
  await tg.handleUpdate(photoMessage());
  assert.deepEqual(sent('getFile').map((c) => c.body.file_id), ['large'], 'the largest size');
  assert.deepEqual(downloads, ['https://api.telegram.org/file/bottest-token/photos/large.jpg']);
  assert.equal(claude.requests.length, 2, 'the same reading as the app: one look, one choice');
  assert.equal(claude.requests[0].messages[0].content[0].type, 'image');
  assert.equal(claude.requests[0].messages[0].content[0].source.media_type, 'image/jpeg');
  const reply = lastText();
  assert.equal(reply.chat_id, CHAT);
  assert.equal(reply.parse_mode, 'HTML');
  assert.match(reply.text, /<b>Rice and a banana<\/b>/);
  assert.match(reply.text, /• Banana, raw, 1 medium \(118 g\): ~105 kcal/);
  assert.match(reply.text, /• Rice, white, cooked, 180 g: ~234 kcal/);
  assert.match(reply.text, /Total <b>~339 kcal<\/b>/);
  const buttons = buttonsOf(reply);
  assert.deepEqual(buttons.map((b) => b.text), ['Log it', 'Cancel']);
  const id = idFrom(reply);
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.equal(buttons[1].callback_data, `food:cancel:${id}`);
  const held = await dbmod.getKV(`tgfood:${id}`);
  assert.equal(held.kind, 'meal');
  assert.ok(held.expires > Date.now() + 1.9 * 3600e3 && held.expires <= Date.now() + 2 * 3600e3, 'kept for two hours');
  assert.equal((await entries(id)).length, 0, 'nothing logged before the tap');
});

test('Log it logs the entries the way the app does, once, and a second tap does not double them', async () => {
  coach.setCoachClient(plate());
  await tg.handleUpdate(photoMessage());
  const id = idFrom(lastText());
  calls = [];
  await tg.handleUpdate(tap(`food:log:${id}`));
  const rows = await entries(id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.id, r.ref_key, r.qty, r.unit, r.estimate, r.source]), [
    [`tg-${id}-0`, 'tg-banana', 1, 'p:1 medium', true, 'you'],
    [`tg-${id}-1`, 'tg-rice-cooked', 180, 'g', true, 'you'],
  ]);
  assert.ok(rows[0].fill_profile, 'the reading\'s estimate per 100 goes with it, as from the app');
  const answer = sent('answerCallbackQuery')[0].body.text;
  assert.match(answer, /^Logged 2 items for \w[\w ]*, ~339 kcal\.$/);
  assert.deepEqual(sent('editMessageReplyMarkup')[0].body.reply_markup, { inline_keyboard: [] }, 'the buttons go');
  assert.equal(lastText().text, answer);
  // Tapped again (or delivered twice): nothing more lands.
  calls = [];
  await tg.handleUpdate(tap(`food:log:${id}`));
  assert.equal((await entries(id)).length, 2);
  assert.equal(sent('answerCallbackQuery')[0].body.text, 'Already logged.');
  // Two taps at the same moment still land once each.
  coach.setCoachClient(plate());
  await tg.handleUpdate(photoMessage());
  const id2 = idFrom(lastText());
  await Promise.all([tg.handleUpdate(tap(`food:log:${id2}`)), tg.handleUpdate(tap(`food:log:${id2}`))]);
  assert.equal((await entries(id2)).length, 2);
});

test('Cancel logs nothing and takes the buttons away; a later tap on it has expired', async () => {
  coach.setCoachClient(plate());
  await tg.handleUpdate(photoMessage());
  const id = idFrom(lastText());
  calls = [];
  await tg.handleUpdate(tap(`food:cancel:${id}`));
  assert.equal(sent('answerCallbackQuery')[0].body.text, 'Okay, not logged.');
  assert.equal(sent('editMessageReplyMarkup').length, 1);
  assert.equal(await dbmod.getKV(`tgfood:${id}`), null);
  await tg.handleUpdate(tap(`food:log:${id}`));
  assert.equal(sent('answerCallbackQuery')[1].body.text, 'That one expired, send it again.');
  assert.equal((await entries(id)).length, 0);
});

test('after two hours a result has expired: a tap says so and logs nothing', async () => {
  coach.setCoachClient(plate());
  await tg.handleUpdate(photoMessage());
  const id = idFrom(lastText());
  const held = await dbmod.getKV(`tgfood:${id}`);
  await dbmod.setKV(`tgfood:${id}`, { ...held, expires: Date.now() - 1000 });
  calls = [];
  await tg.handleUpdate(tap(`food:log:${id}`));
  assert.equal(sent('answerCallbackQuery')[0].body.text, 'That one expired, send it again.');
  assert.equal(lastText().text, 'That one expired, send it again.');
  assert.equal((await entries(id)).length, 0);
  // An id nobody made, or a mangled one, gets the same plain answer.
  await tg.handleUpdate(tap('food:log:0123456789abcdef'));
  await tg.handleUpdate(tap('food:log:../../x'));
  assert.deepEqual(sent('answerCallbackQuery').slice(1).map((c) => c.body.text), ['That one expired, send it again.', 'That one expired, send it again.']);
  // Expired results are cleared as new ones arrive.
  coach.setCoachClient(plate());
  await tg.handleUpdate(photoMessage());
  assert.equal(await dbmod.getKV(`tgfood:${id}`), null);
});

test('a product: "Found" with a button for each of its sourced portions, and a portion logs once', async () => {
  coach.setCoachClient(scripted([said(reading({ kind: 'barcode', summary: 'A can', barcode: EAN }))]));
  calls = [];
  await tg.handleUpdate(photoMessage());
  const reply = lastText();
  assert.match(reply.text, /^Found <b>Lemon fizz<\/b> \(Madeup\)\./);
  assert.match(reply.text, /• 1 pack, 330 ml: 132 kcal/);
  assert.match(reply.text, /• 1 glass, 250 ml: 100 kcal/);
  const buttons = buttonsOf(reply);
  assert.deepEqual(buttons.map((b) => b.text), ['1 pack, 330 ml', '1 glass, 250 ml', 'Cancel']);
  const id = buttons[0].callback_data.split(':')[2];
  assert.equal(buttons[1].callback_data, `food:log:${id}:1`);
  calls = [];
  await tg.handleUpdate(tap(`food:log:${id}:1`));
  let rows = await entries(id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].ref_key, rows[0].qty, rows[0].unit, rows[0].estimate], ['tg-fizz', 1, 'serving', false]);
  assert.match(sent('answerCallbackQuery')[0].body.text, /^Logged Lemon fizz \(1 glass, 250 ml\) for drinks: 100 kcal\.$/);
  // The other portion tapped after it: still the one entry.
  await tg.handleUpdate(tap(`food:log:${id}:0`));
  rows = await entries(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unit, 'serving');
});

test('a label goes to the app to be checked; anything unclear is asked about', async () => {
  coach.setCoachClient(scripted([said(reading({ kind: 'label', summary: 'A nutrition table', product: { name: 'Oat bar', brand: 'Madeup', variant: '', pack_size: 40, pack_unit: 'g', pack_count: 0 },
    label: { basis: '100g', serving_size: 0, serving_unit: '', serving_label: '', values: [{ key: 'kcal', value: 410 }, { key: 'protein', value: 8 }] } }))]));
  calls = [];
  await tg.handleUpdate(photoMessage());
  assert.equal(lastText().text, "That's a nutrition label for <b>Madeup Oat bar</b>. Open Oath to check and save it.");
  assert.equal(buttonsOf(lastText()).filter((b) => b.callback_data).length, 0, 'nothing to log from here');
  coach.setCoachClient(scripted([said(reading({ kind: 'unclear', summary: 'A blurry shape', question: 'Is that a pastizz or a qassata?' }))]));
  await tg.handleUpdate(photoMessage());
  assert.equal(lastText().text, 'Is that a pastizz or a qassata?');
});

test('the caption goes to the reading as the typed hint', async () => {
  const claude = plate();
  coach.setCoachClient(claude);
  await tg.handleUpdate(photoMessage({ caption: 'brown rice, not white' }));
  const content = claude.requests[0].messages[0].content;
  assert.equal(content[1].type, 'text');
  assert.equal(content[1].text, 'Daniel says: brown rice, not white');
  assert.match(claude.requests[1].messages[0].content[0].text, /brown rice, not white/, 'the choice sees it too');
  // An image sent as a file is read too.
  coach.setCoachClient(plate());
  calls = [];
  await tg.handleUpdate({ update_id: (updateId += 1), message: { message_id: 1, chat: { id: CHAT }, document: { file_id: 'doc', mime_type: 'image/jpeg', file_size: 5000 } } });
  assert.deepEqual(sent('getFile').map((c) => c.body.file_id), ['doc']);
  assert.ok(idFrom(lastText()));
});

test('a photo from a chat that is not linked is ignored, and its taps are refused', async () => {
  const claude = scripted([]);
  coach.setCoachClient(claude);
  calls = [];
  downloads = [];
  await tg.handleUpdate(photoMessage({ chat: { id: 777 } }));
  assert.equal(calls.length, 0, 'not even a reply');
  assert.equal(downloads.length, 0);
  assert.equal(claude.requests.length, 0);
  // A tap from elsewhere on a real result: private, and nothing logged.
  coach.setCoachClient(plate());
  await tg.handleUpdate(photoMessage());
  const id = idFrom(lastText());
  calls = [];
  await tg.handleUpdate(tap(`food:log:${id}`, 777));
  assert.equal(sent('answerCallbackQuery')[0].body.text, 'This bot is private.');
  assert.equal((await entries(id)).length, 0);
  // Before any chat is linked, a photo is ignored too.
  await dbmod.setKV('telegram', { botUsername: 'oath_test_bot' });
  calls = [];
  await tg.handleUpdate(photoMessage());
  assert.equal(calls.length, 0);
  await dbmod.setKV('telegram', { chatId: CHAT, botUsername: 'oath_test_bot', secret: 'webhook-secret-for-tests-0123456789abcdef' });
});

test('a photo that is too big, or not a photo Claude can read, gets a plain answer', async () => {
  calls = [];
  coach.setCoachClient(scripted([]));
  await tg.handleUpdate(photoMessage({ photo: [{ file_id: 'huge', width: 9000, height: 9000, file_size: 11 * 1024 * 1024 }] }));
  assert.match(lastText().text, /too big/);
  assert.equal(downloads.filter((d) => d.includes('huge')).length, 0, 'not downloaded');
});
