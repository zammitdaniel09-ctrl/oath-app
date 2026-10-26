// The coach running the app: tools reach the same functions as the buttons, rules still refuse,
// destructive actions wait for a tap, receipts are kept, and the game rules can be configured.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-11-02T08:00', { zone: ZONE });
const setLocal = (iso) => { clock = DateTime.fromISO(iso, { zone: ZONE }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-coachtools-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54355,
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

// A stand-in for the Anthropic client that replays scripted responses and records each request.
function scripted(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          const next = responses.shift();
          if (!next) throw new Error('no scripted response left');
          return next;
        },
      },
    },
  };
}
const reply = (stop_reason, content) => ({ stop_reason, content });
const words = (text) => ({ type: 'text', text });
let n = 0;
const use = (name, input) => ({ type: 'tool_use', id: `t${(n += 1)}`, name, input });
// One coach turn: the model calls these tools in one round, then says `text`.
const turn = (calls, text = 'Done.') => scripted([reply('tool_use', calls), reply('end_turn', [words(text)])]);
const lastResults = (c) => c.requests[c.requests.length - 1].messages.at(-1).content;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54355/oath';
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
