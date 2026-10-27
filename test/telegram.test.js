// Telegram: a chat that has blocked the bot (or is gone) is unlinked once instead of failing on every
// brief, and the webhook secret is compared in constant time. Against a real Postgres, with Telegram's
// API stood in for by a scripted fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-telegram-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54401,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

const SECRET = 'webhook-secret-for-tests-0123456789abcdef';
let app; let dbmod; let tg; let push;
const realFetch = globalThis.fetch;

// Telegram's answers, one per call to its API; `calls` records what Oath asked.
let calls = [];
let answer = () => ({ ok: true, result: {} });
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, init);
  calls.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
  const r = answer();
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : r.error_code, headers: { 'content-type': 'application/json' } });
};
const blocked = () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });

// Collects what Oath logs while a step runs.
async function logged(step) {
  const out = { warn: [], error: [] };
  const [warn, error] = [console.warn, console.error];
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.error = (...a) => out.error.push(a.join(' '));
  try {
    await step();
  } finally {
    [console.warn, console.error] = [warn, error];
  }
  return out;
}

const link = (chatId = 4242) => dbmod.setKV('telegram', { chatId, botUsername: 'oath_test_bot', secret: SECRET });
const linked = async () => (await tg.telegramStatus()).linked;
const unlinkEvents = async () => (await dbmod.db()`select count(*)::int as n from events where type = 'telegram_unlinked'`)[0].n;
const until = async (check) => {
  for (let i = 0; i < 200 && !(await check()); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(await check(), 'timed out waiting');
};

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54401/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.ANTHROPIC_API_KEY;
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app } = await import('../src/server.js'));
  tg = await import('../src/telegram.js');
  push = await import('../src/push.js');
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

test('a message that reaches Telegram stays linked', async () => {
  await link();
  calls = [];
  answer = () => ({ ok: true, result: {} });
  assert.equal(await tg.sendTelegram({ title: 'Morning brief', body: 'Hello' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, 4242);
  assert.equal(await linked(), true);
});

test('a blocked bot unlinks the chat and says so once, instead of failing on every brief', async () => {
  await link();
  calls = [];
  answer = blocked;
  const before = await unlinkEvents();
  const out = await logged(async () => {
    assert.equal(await tg.sendTelegram({ title: 'Morning brief', body: 'Hello' }), false);
    assert.equal(await linked(), false, 'unlinked, as Settings would');
    assert.equal(calls.length, 1);
    // The next brief does not even try.
    assert.equal(await tg.sendTelegram({ title: 'Midday check', body: 'Hello' }), false);
    assert.equal(await tg.sendTelegram({ title: 'Evening check', body: 'Hello' }), false);
  });
  assert.equal(calls.length, 1, 'nothing was sent once the chat was unlinked');
  assert.equal(out.warn.length, 1, 'one line in the log');
  assert.match(out.warn[0], /blocked by the user/);
  assert.match(out.warn[0], /Unlinked/);
  assert.equal(out.error.length, 0);
  assert.equal(await unlinkEvents(), before + 1);
  assert.equal((await tg.telegramStatus()).linked, false);
});

test('messages in flight together when the block shows up unlink once, not three times', async () => {
  await link();
  calls = [];
  answer = blocked;
  const before = await unlinkEvents();
  const out = await logged(async () => {
    const sent = await Promise.all([1, 2, 3].map((n) => tg.sendTelegram({ title: `Note ${n}`, body: 'x' })));
    assert.deepEqual(sent, [false, false, false]);
  });
  assert.equal(await linked(), false);
  assert.equal(out.warn.length, 1);
  assert.equal(await unlinkEvents(), before + 1);
});

test('a chat Telegram cannot find is unlinked too, but other failures are not mistaken for it', async () => {
  await link();
  answer = () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' });
  assert.equal(await logged(() => tg.sendTelegram({ title: 'x', body: 'y' })).then(() => linked()), false);

  await link();
  answer = () => ({ ok: false, error_code: 500, description: 'Internal Server Error' });
  await assert.rejects(tg.sendTelegram({ title: 'x', body: 'y' }), /Internal Server Error/);
  assert.equal(await linked(), true, 'a hiccup at Telegram leaves the link alone');

  answer = () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' });
  await assert.rejects(tg.sendTelegram({ title: 'x', body: 'y' }), /Too Many Requests/);
  assert.equal(await linked(), true);
});

test('the push path, which every brief takes, unlinks a blocked chat without an error line', async () => {
  await link();
  answer = blocked;
  const out = await logged(async () => {
    await push.sendPush({ title: 'Morning brief', body: 'Hello', tag: 'brief-morning', url: '/#/today' });
    await until(async () => !(await linked()));
  });
  assert.equal(out.error.length, 0, out.error.join('\n'));
  assert.equal(out.warn.length, 1);
});

// ---------- The webhook secret ----------

const hook = (secret) => app.request('/telegram/webhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret }) },
  body: JSON.stringify({}),
});

test('the webhook takes only the secret it registered, compared in constant time', async () => {
  await link();
  const compared = [];
  const real = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (a, b) => { compared.push([a.length, b.length]); return real(a, b); };
  try {
    assert.equal((await hook(SECRET)).status, 200);
    const wrong = [
      `${SECRET.slice(0, -1)}X`, // one character off
      SECRET.slice(0, -1), // a prefix
      `${SECRET}0`, // longer
      '', // empty
      SECRET.toUpperCase(),
    ];
    for (const secret of wrong) assert.equal((await hook(secret)).status, 403, secret);
    assert.equal((await hook(undefined)).status, 403, 'no header at all');
    assert.ok(compared.length >= 7, `every comparison went through timingSafeEqual (${compared.length})`);
    assert.ok(compared.every(([a, b]) => a === b), 'on equal-length digests, so lengths cannot leak');
  } finally {
    crypto.timingSafeEqual = real;
  }
  // Before a secret exists nothing gets through, not even an empty header.
  await dbmod.setKV('telegram', { chatId: 4242 });
  assert.equal((await hook(undefined)).status, 403);
  assert.equal((await hook('')).status, 403);
});
