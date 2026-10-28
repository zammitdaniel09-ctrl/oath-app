// Photos and voice notes in the coach chat: uploads, the coach seeing photos, voice notes transcribed
// (primed with his own names) and sent as their transcript, playback in byte ranges, and a crossed-off
// event staying on Today.
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
const clock = DateTime.fromISO('2027-02-10T15:00', { zone: ZONE });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-media-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54444 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});
let app; let cookie = ''; let dbmod; let coach; let media;

async function call(method, url, json, headers = {}) {
  const h = { cookie, ...headers };
  if (json !== undefined || method !== 'GET') h['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}
async function post(url, body = {}) {
  const res = await call('POST', url, body);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// A scripted Claude: answers in order and keeps every request.
function scripted(responses) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (params) => { requests.push(structuredClone(params)); return responses.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Okay.' }] }; } } },
  };
}
const says = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

// The smallest real JPEG: one white pixel.
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
const AUDIO = Buffer.from('a fake recording, long enough to be one').toString('base64');

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54444 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ELEVENLABS_API_KEY;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  const engine = await import('../src/engine.js');
  await engine.ensureGame();
  ({ app } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  media = await import('../src/coach-media.js');
  assert.equal((await post('/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' })).status, 200);
});

after(async () => {
  await dbmod?.close?.().catch(() => {});
  await pg.stop().catch(() => {});
  // Windows can hold the data folder for a moment after Postgres stops; a left-over temp folder is harmless.
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* left for the OS */ }
});

test('a photo uploads, goes with a message, and the coach sees it', async () => {
  const up = await post('/api/coach/media', { kind: 'photo', data: JPEG, mime: 'image/jpeg' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.kind, 'photo');
  const c = scripted([says('That is a blank page, Boss.')]);
  coach.setCoachClient(c);
  const r = await post('/api/coach', { text: 'What is this?', media: [up.data.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reply.text, 'That is a blank page, Boss.');
  assert.deepEqual(r.data.sent.media.map((m) => m.kind), ['photo']);
  const last = c.requests[0].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'image');
  assert.equal(last.content[0].source.media_type, 'image/jpeg');
  assert.equal(last.content[0].source.data, JPEG);
  assert.equal(last.content.at(-1).text, 'What is this?');
  // In the chat history with its photo, and the photo itself comes back.
  const hist = await (await call('GET', '/api/coach')).json();
  const mine = hist.messages.find((m) => m.id === r.data.sent.id);
  assert.equal(mine.media[0].id, up.data.id);
  const img = await call('GET', `/api/coach/media/${up.data.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(JPEG, 'base64'));
  // Sent once only.
  assert.equal((await post('/api/coach', { text: 'Again', media: [up.data.id] })).status, 409);
});

test('a photo alone is a message; only the last three photos are shown to the coach again', async () => {
  coach.setCoachClient(scripted([says('Got them.'), says('Got them.'), says('Got them.'), says('Got them.')]));
  for (let i = 0; i < 3; i += 1) {
    const up = await post('/api/coach/media', { kind: 'photo', data: JPEG, mime: 'image/jpeg' });
    const r = await post('/api/coach', { media: [up.data.id] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.sent.text, '');
  }
  const c = scripted([says('Fine.')]);
  coach.setCoachClient(c);
  await post('/api/coach', { text: 'And now?' });
  const msgs = c.requests[0].messages;
  const images = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'image');
  assert.equal(images.length, 3);
  const older = msgs.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && /no longer shown/.test(b.text)));
  assert.ok(older, 'the oldest photo is mentioned, not resent');
  assert.equal((await post('/api/coach', {})).status, 400);
});

test('every photo of his newest message is shown, even the four the app allows at once', async () => {
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push((await post('/api/coach/media', { kind: 'photo', data: JPEG, mime: 'image/jpeg' })).data.id);
  const c = scripted([says('Four pages of notes, Boss.')]);
  coach.setCoachClient(c);
  const r = await post('/api/coach', { text: 'Turn these into tasks', media: ids });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const msgs = c.requests[0].messages;
  assert.equal(msgs.at(-1).content.filter((b) => b.type === 'image').length, 4, 'all four of this message');
  assert.equal(msgs.at(-1).content.at(-1).text, 'Turn these into tasks');
  // The older limit still holds: no earlier photo comes back with them.
  assert.equal(msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'image').length, 4);

  // One photo next: it is shown, with the last few before it.
  const one = await post('/api/coach/media', { kind: 'photo', data: JPEG, mime: 'image/jpeg' });
  const c2 = scripted([says('Got it.')]);
  coach.setCoachClient(c2);
  await post('/api/coach', { text: 'And this one', media: [one.data.id] });
  const all = c2.requests[0].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'image');
  assert.equal(all.length, 3);
  assert.equal(c2.requests[0].messages.at(-1).content[0].type, 'image');
});

test('voice notes: a clear message without a key; with one, transcribed with his names and sent as the transcript', async () => {
  const off = await post('/api/coach/media', { kind: 'voice', data: AUDIO, mime: 'audio/mp4', duration_ms: 4200 });
  assert.equal(off.status, 503);
  assert.match(off.data.error, /ELEVENLABS_API_KEY/);
  assert.equal((await (await call('GET', '/api/coach')).json()).voice, false);

  const sql = dbmod.db();
  await sql`insert into habits (name, start_date) values ('Study Part 2, the long block in the library', '2027-01-01'), ('Gym', '2027-01-01')`;
  await sql`insert into tasks (title) values ('Email Dr Vella')`;
  let heard;
  media.setTranscriber(async (buf, mime, terms) => {
    heard = { bytes: buf.length, mime, terms };
    return 'Cross out coaching for today, I did it already.';
  });
  assert.equal((await (await call('GET', '/api/coach')).json()).voice, true);
  const up = await post('/api/coach/media', { kind: 'voice', data: AUDIO, mime: 'audio/mp4;codecs=mp4a.40.2', duration_ms: 4200, peaks: '0123456789' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.transcript, 'Cross out coaching for today, I did it already.');
  assert.equal(up.data.ms, 4200);
  assert.equal(heard.mime, 'audio/mp4');
  assert.ok(heard.terms.includes('Study Part 2'), heard.terms.join(', '));
  assert.ok(heard.terms.includes('Gym') && heard.terms.includes('Email Dr Vella'));

  const c = scripted([says('Done, Boss.')]);
  coach.setCoachClient(c);
  const r = await post('/api/coach', { media: [up.data.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sent.text, 'Cross out coaching for today, I did it already.');
  assert.deepEqual(r.data.sent.media, [{ id: up.data.id, kind: 'voice', ms: 4200, peaks: '0123456789' }]);
  const last = c.requests[0].messages.at(-1).content;
  assert.match(last.at(-1).text, /^\[Voice note, transcribed:\]\nCross out coaching/);

  // Played back in byte ranges, as Safari asks for audio.
  const part = await call('GET', `/api/coach/media/${up.data.id}`, undefined, { range: 'bytes=0-1' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-1/${Buffer.from(AUDIO, 'base64').length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).length, 2);

  // Nothing heard: nothing is sent.
  media.setTranscriber(async () => '');
  const quiet = await post('/api/coach/media', { kind: 'voice', data: AUDIO, mime: 'audio/webm', duration_ms: 1500 });
  assert.equal(quiet.data.transcript, '');
  assert.equal((await post('/api/coach', { media: [quiet.data.id] })).status, 400);
  media.setTranscriber(null);
});

test('uploads are checked, and one never sent is cleared after a day', async () => {
  assert.equal((await post('/api/coach/media', { kind: 'video', data: JPEG })).status, 400);
  assert.equal((await post('/api/coach/media', { kind: 'photo', data: JPEG, mime: 'image/gif' })).status, 400);
  assert.equal((await post('/api/coach/media', { kind: 'photo', data: 'not base64!', mime: 'image/jpeg' })).status, 400);
  const sql = dbmod.db();
  const old = await post('/api/coach/media', { kind: 'photo', data: JPEG, mime: 'image/jpeg' });
  await sql`update coach_media set created_at = now() - interval '2 days' where id = ${old.data.id}`;
  await post('/api/coach/media', { kind: 'photo', data: JPEG, mime: 'image/jpeg' });
  assert.equal((await sql`select id from coach_media where id = ${old.data.id}`).length, 0);
});

test('names for the transcriber: short enough, cut at a comma, no repeats, at most 100', () => {
  const terms = media.termsFrom(['Gym', 'gym', 'Study Part 2, the long block in the library before the lecture', 'A name with far too many words in it', '<Read> [notes]', ...Array.from({ length: 200 }, (_, i) => `Task ${i}`)]);
  assert.equal(terms[0], 'Oath');
  assert.ok(terms.includes('Study Part 2'));
  assert.ok(!terms.some((t) => /many words/.test(t)));
  assert.ok(terms.includes('Read notes'));
  assert.equal(terms.filter((t) => t.toLowerCase() === 'gym').length, 1);
  assert.equal(terms.length, 100);
  assert.ok(terms.every((t) => t.length < 50 && t.split(' ').length <= 5));
});

test('Scribe gets the recording, the model and his names; a request it refuses with them is tried plain', async () => {
  const real = globalThis.fetch;
  const seen = [];
  process.env.ELEVENLABS_API_KEY = 'xi-test-key';
  globalThis.fetch = async (url, init) => {
    seen.push({ url, key: init.headers['xi-api-key'], form: init.body });
    if (seen.length === 2) return new Response(JSON.stringify({ detail: 'keyterms not supported' }), { status: 422 });
    return new Response(JSON.stringify({ text: ' Gym at six tomorrow. ', language_code: 'eng' }), { status: 200 });
  };
  try {
    const one = await post('/api/coach/media', { kind: 'voice', data: AUDIO, mime: 'audio/mp4', duration_ms: 2000 });
    assert.equal(one.data.transcript, 'Gym at six tomorrow.');
    const [first] = seen;
    assert.equal(first.url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(first.key, 'xi-test-key');
    assert.equal(first.form.get('model_id'), 'scribe_v2');
    assert.equal(first.form.get('no_verbatim'), 'true');
    assert.ok(first.form.getAll('keyterms').includes('Gym'));
    assert.equal(first.form.get('file').name, 'voice.m4a');
    assert.equal(first.form.get('file').size, Buffer.from(AUDIO, 'base64').length);
    const two = await post('/api/coach/media', { kind: 'voice', data: AUDIO, mime: 'audio/webm', duration_ms: 2000 });
    assert.equal(two.status, 200);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].form.getAll('keyterms').length, 0);
    assert.equal(seen[2].form.get('file').name, 'voice.webm');
  } finally {
    globalThis.fetch = real;
    delete process.env.ELEVENLABS_API_KEY;
  }
});

test('the microphone is the app\'s own', async () => {
  const res = await call('GET', '/api/coach');
  assert.match(res.headers.get('permissions-policy'), /microphone=\(self\)/);
});
