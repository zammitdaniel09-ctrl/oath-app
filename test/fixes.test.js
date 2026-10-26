// Regression tests for the October fixes: push topics Apple accepts, the coach's handling of cut-off,
// empty and declined replies, stale hard tasks in briefs, and weekly reviews of thin weeks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-12T08:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-fixes-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54347,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let runOnce; let cookie = ''; let dbmod; let coach; let push;

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const today = () => call('GET', '/api/today');

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54347/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app, runOnce } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  push = await import('../src/push.js');
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

// A stand-in for the Anthropic client that replays scripted responses and records each request.
function scripted(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(params);
          const next = responses.shift();
          if (!next) throw new Error('no scripted response left');
          return next;
        },
      },
    },
  };
}
const reply = (stop_reason, content, extra = {}) => ({ stop_reason, content, ...extra });
const words = (text) => ({ type: 'text', text });
const thought = { type: 'thinking', thinking: '', signature: 'sig' };

test('push topics are 32 base64url characters that decode, and stay the same per reminder', () => {
  for (const key of ['death', 'brief-morning', 'habit-123', 'health-overturn-12-2026-10-19', 'bundle', '']) {
    const topic = push.topicOf(key);
    assert.equal(topic.length, 32, key);
    assert.match(topic, /^[A-Za-z0-9_-]{32}$/, key);
    assert.equal(Buffer.from(topic, 'base64url').toString('base64url'), topic, `${key} decodes cleanly`);
    assert.equal(push.topicOf(key), topic, 'stable');
  }
  assert.notEqual(push.topicOf('habit-1'), push.topicOf('habit-2'));
});

test('a push device the server already knows is not fresh; an unknown one is', async () => {
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await call('POST', '/api/push/subscribe', sub)).data.fresh, true);
  assert.equal((await call('POST', '/api/push/subscribe', sub)).data.fresh, false);
  await call('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
});

test('coach: a reply cut off by the token limit is retried with more room, at the chat effort', async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  const c = scripted([
    reply('max_tokens', [thought]),
    reply('end_turn', [thought, words('Read the 25 pages before 22:00.')]),
  ]);
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'What now?' });
  assert.equal(r.data.reply.text, 'Read the 25 pages before 22:00.');
  assert.equal(r.data.reply.failed, false);
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests[1].max_tokens, c.requests[0].max_tokens * 2);
  assert.equal(c.requests[0].output_config.effort, 'medium');
  assert.equal(c.requests[0].fallbacks, 'default');
});

test('coach: text spoken before a tool call is kept, and an empty final reply is retried once', async () => {
  const c = scripted([
    reply('tool_use', [words('Adding it.'), { type: 'tool_use', id: 't1', name: 'not_a_tool', input: {} }]),
    reply('end_turn', [thought]),
    reply('end_turn', [words('Done. Start now.')]),
  ]);
  coach.setCoachClient(c);
  const r = await call('POST', '/api/coach', { text: 'Add a task to call Brian.' });
  assert.equal(r.data.reply.text, 'Adding it.\n\nDone. Start now.');
  assert.equal(c.requests.length, 3);
});

test('coach: a declined or empty reply is shown but never fed back as the coach\'s own words', async () => {
  coach.setCoachClient(scripted([reply('refusal', [], { stop_details: { category: 'general_harms' } })]));
  const declined = await call('POST', '/api/coach', { text: 'Something odd' });
  assert.equal(declined.data.reply.failed, true);
  assert.match(declined.data.reply.text, /can't help with that one/);

  coach.setCoachClient(scripted([reply('end_turn', []), reply('end_turn', [])]));
  const empty = await call('POST', '/api/coach', { text: 'Hello?' });
  assert.equal(empty.data.reply.failed, true);
  assert.equal(empty.data.reply.text, 'No answer came back. Try again.');

  const c = scripted([reply('end_turn', [words('Here.')])]);
  coach.setCoachClient(c);
  await call('POST', '/api/coach', { text: 'Are you there?' });
  const sent = c.requests[0].messages.map((m) => m.content);
  assert.ok(!sent.includes('No answer came back. Try again.'));
  assert.ok(!sent.some((t) => /can't help with that one/.test(t)));
});

test('briefs: a cut-off reply falls back to plain numbers instead of half a sentence', async () => {
  const c = scripted([reply('max_tokens', [words('Yesterday you')]), reply('max_tokens', [words('Yesterday you missed')])]);
  coach.setCoachClient(c);
  const { text } = await coach.generateBrief('morning');
  assert.ok(!text.startsWith('Yesterday you missed'), text);
  assert.equal(c.requests[0].output_config.effort, 'low');
  delete process.env.ANTHROPIC_API_KEY;
});

test('a slipped hard task shows as missed and is not counted as due today', async () => {
  setLocal('2026-10-12T08:00');
  const t = await call('POST', '/api/tasks', { title: 'Call Brian', due_date: '2026-10-12', deadline: '18:00', hard: true, first_step: 'Open contacts' });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  setLocal('2026-10-14T09:00');
  await runOnce();
  const d = (await today()).data;
  const task = d.tasks.find((k) => k.title === 'Call Brian');
  assert.equal(task.status, 'missed');
  assert.ok(!d.openDue.some((i) => i.title === 'Call Brian'), 'not due today');
  const { text } = await coach.generateBrief('morning');
  assert.ok(!text.includes('Call Brian'), text);
});

test('weekly review: no strongest or weakest when habits are tied, and thin habits are not judged', async () => {
  const text = await coach.writeWeeklyReview('2026-10-05', {
    weekStart: '2026-10-05', weekEnd: '2026-10-11', hpStart: null, hpEnd: 24,
    cleanDays: 0, restDays: 0, judgedDays: 2, misses: [], pardons: [], dodges: [], focusMin: 0, tasksDone: 0, reflections: [],
    habits: [
      { id: 1, name: 'Read', done: 0, target: 2, strength: 0, trend: 0 },
      { id: 2, name: 'Workout', done: 0, target: 2, strength: 0, trend: 0 },
      { id: 3, name: 'Study', done: 1, target: 5, strength: 0, trend: 0 },
    ],
  });
  assert.ok(!/Strongest|Weakest/.test(text), text);
  assert.match(text, /Too early to rank/);
  assert.match(text, /Adjust: Study\./);
});

// Raw request with no cookie, the way Shortcuts and Health Auto Export call Oath.
async function bare(method, url, { authorization, json, body, type } = {}) {
  const headers = {};
  if (authorization !== undefined) headers.authorization = authorization;
  if (json !== undefined || type) headers['content-type'] = type || 'application/json';
  const res = await app.request(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('a Shortcuts key works with or without "Bearer ", and failures show up in the setup list', async () => {
  const { token } = (await call('POST', '/api/tokens', { label: 'Shortcuts' })).data;
  assert.equal((await bare('GET', '/api/shortcut/next', { authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await bare('GET', '/api/shortcut/next', { authorization: token })).status, 200);
  assert.equal((await bare('GET', '/api/shortcut/next', { authorization: ` ${token} ` })).status, 200, 'stray spaces are fine');

  setLocal('2026-10-14T12:00');
  assert.equal((await bare('POST', '/api/shortcut/health', { authorization: 'Bearer oath_wrong', json: { steps: 100 } })).status, 401);
  let s = (await call('GET', '/api/setup-status')).data;
  assert.equal(s.ingestError.status, 401);
  assert.equal(s.ingestError.reason, 'The key was not accepted.');

  setLocal('2026-10-14T12:01');
  const notJson = await bare('POST', '/api/shortcut/health', { authorization: token, body: 'steps=100', type: 'text/plain' });
  assert.equal(notJson.status, 415);
  s = (await call('GET', '/api/setup-status')).data;
  assert.equal(s.ingestError.status, 415);

  // A sync that works clears the warning and turns Health green.
  setLocal('2026-10-14T12:02');
  assert.equal((await bare('POST', '/api/shortcut/health', { authorization: token, json: { steps: 4200 } })).status, 200);
  s = (await call('GET', '/api/setup-status')).data;
  assert.equal(s.ingestError, null);
  const health = s.items.find((i) => i.id === 'health');
  assert.equal(health.ok, true, health.detail);
  assert.equal(s.items.find((i) => i.id === 'telegram').detail, 'The bot token is not set on the server.');
  assert.equal(s.items.find((i) => i.id === 'calendars').ok, false);
  assert.equal(s.total, 5);
});
