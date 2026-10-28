// Photos and voice notes in the coach chat. Each is uploaded on its own first (a photo as soon as it is
// picked, a voice note when he taps send), kept here, and then sent with a message by its id. A voice
// note is transcribed on upload by ElevenLabs Scribe, primed with the names of his habits, tasks, goals
// and events so they come out spelled his way; the coach reads the transcript. The coach sees the most
// recent photos of the conversation itself (coach.js). Nothing is kept that was never sent: an upload
// left without a message is cleared after a day.
import { Hono } from 'hono';
import { db, logEvent } from './db.js';
import { RuleError } from './engine.js';

export const MEDIA_SCHEMA = `
create table if not exists coach_media (
  id serial primary key,
  kind text not null,
  mime text not null,
  data bytea not null,
  bytes integer not null,
  duration_ms integer,
  peaks text not null default '',
  transcript text,
  message_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists coach_media_message_idx on coach_media (message_id);
`;

export async function migrateCoachMedia() {
  await db().unsafe(MEDIA_SCHEMA);
}

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// What phones record: AAC in MP4 on the iPhone, Opus in WebM elsewhere. The extension tells Scribe.
const AUDIO_EXT = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
const MAX_PHOTO = 4.5 * 1024 * 1024;
const MAX_VOICE = 12 * 1024 * 1024;
export const MAX_VOICE_MS = 5 * 60000;

// ---------- Transcription ----------

// Tests and the preview stand in for Scribe with a function (buffer, mime, keyterms) => text.
let transcriber = null;
export function setTranscriber(fn) {
  transcriber = fn;
}
export const voiceEnabled = () => Boolean(transcriber || process.env.ELEVENLABS_API_KEY);
const STT_MODEL = () => process.env.STT_MODEL || 'scribe_v2';

// Words worth spelling his way: his habits, open tasks, active goals and the events around now. Scribe
// takes terms of up to five words and 50 characters; a long name is cut at its first comma or colon.
// Up to 100 terms keeps the request billed by its own length.
const BANNED = /[<>{}[\]\\]/g;
export function termsFrom(names) {
  const seen = new Set();
  const out = [];
  for (const raw of ['Oath', 'HP', ...names]) {
    let t = String(raw || '').replace(BANNED, ' ').replace(/\s+/g, ' ').trim();
    if (t.split(' ').length > 5 || t.length >= 50) t = t.split(/[,:;(–-]/)[0].trim();
    if (!t || t.split(' ').length > 5 || t.length >= 50) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 100) break;
  }
  return out;
}

async function keyterms() {
  const sql = db();
  const lists = await Promise.all([
    sql`select name as t from habits where archived_from is null order by sort, id`.catch(() => []),
    sql`select title as t from goals where status = 'active' order by id`.catch(() => []),
    sql`select title as t from tasks where done_at is null and deleted_at is null order by id desc limit 40`.catch(() => []),
    sql`select distinct title as t from oath_events where start_at between now() - interval '2 days' and now() + interval '14 days' limit 40`.catch(() => []),
    sql`select distinct title as t from cal_events where start_at between now() - interval '2 days' and now() + interval '14 days' limit 60`.catch(() => []),
  ]);
  return termsFrom(lists.flat().map((r) => r.t));
}

async function scribe(buf, mime, terms) {
  const send = (extras) => {
    const form = new FormData();
    form.append('model_id', STT_MODEL());
    form.append('file', new Blob([buf], { type: mime }), `voice.${AUDIO_EXT[mime] || 'm4a'}`);
    form.append('tag_audio_events', 'false');
    if (extras) {
      // Clean text: no ums, false starts or noises, which is what the coach should read.
      form.append('no_verbatim', 'true');
      for (const t of terms) form.append('keyterms', t);
    }
    return fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form, signal: AbortSignal.timeout(90_000),
    });
  };
  let res;
  try {
    res = await send(true);
    // A request the model will not take with the extras is tried once more without them.
    if (res.status === 400 || res.status === 422) {
      console.error('transcription: retrying without keyterms', res.status, (await res.text().catch(() => '')).slice(0, 300));
      res = await send(false);
    }
  } catch (err) {
    console.error('transcription failed', err.name, err.message);
    throw new RuleError(err.name === 'TimeoutError' ? 'The transcription took too long. Try again.' : 'The transcription service could not be reached. Try again.', 502);
  }
  if (!res.ok) {
    console.error('transcription failed', res.status, (await res.text().catch(() => '')).slice(0, 300));
    if (res.status === 401 || res.status === 403) throw new RuleError('The transcription key was refused. Check ELEVENLABS_API_KEY in Railway.', 502);
    if (res.status === 429) throw new RuleError('The transcription service is busy or out of credit. Try again in a minute.', 502);
    throw new RuleError(`The voice note could not be transcribed (error ${res.status}). Try again.`, 502);
  }
  const out = await res.json().catch(() => ({}));
  return String(out.text || '').trim();
}

// ---------- Uploads ----------

const clampMs = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.min(MAX_VOICE_MS + 5000, Math.round(Number(ms))) : null);
const cleanPeaks = (p) => (/^[0-9]{1,64}$/.test(String(p || '')) ? String(p) : '');
const publicMedia = (r) => ({ id: Number(r.id), kind: r.kind, ms: r.duration_ms ?? null, peaks: r.peaks || '', ...(r.kind === 'voice' ? { transcript: r.transcript || '' } : {}) });

export async function saveMedia({ kind, data, mime = '', duration_ms: ms = null, peaks = '' } = {}) {
  if (!['photo', 'voice'].includes(kind)) throw new RuleError('Send a photo or a voice note.');
  if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) throw new RuleError('Send it as base64.');
  const type = String(mime).split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new RuleError('That upload was empty.');
  let transcript = null;
  if (kind === 'photo') {
    if (!PHOTO_TYPES.includes(type)) throw new RuleError('Send a JPEG, PNG or WebP photo.');
    if (buf.length > MAX_PHOTO) throw new RuleError('That photo is too big. Try again; the app shrinks it first.');
  } else {
    if (!AUDIO_EXT[type]) throw new RuleError('That recording format is not supported.');
    if (buf.length > MAX_VOICE || (clampMs(ms) || 0) > MAX_VOICE_MS + 5000) throw new RuleError('That voice note is too long. Keep it under five minutes.');
    if (!voiceEnabled()) throw new RuleError('Voice notes need a transcription key on the server: add ELEVENLABS_API_KEY to the app\'s variables in Railway.', 503);
    transcript = await (transcriber || scribe)(buf, type, await keyterms());
  }
  await db()`delete from coach_media where message_id is null and created_at < now() - interval '1 day'`;
  const [row] = await db()`insert into coach_media (kind, mime, data, bytes, duration_ms, peaks, transcript)
    values (${kind}, ${type}, ${buf}, ${buf.length}, ${kind === 'voice' ? clampMs(ms) : null}, ${kind === 'voice' ? cleanPeaks(peaks) : ''}, ${transcript})
    returning id, kind, duration_ms, peaks, transcript`;
  await logEvent('coach_media', { id: row.id, kind, bytes: buf.length });
  return publicMedia(row);
}

// Uploads not yet sent with a message, in the order asked for; the caller checks they all came back.
export async function unsentMedia(ids) {
  if (!ids.length) return [];
  const rows = await db()`select id, kind, duration_ms, peaks, transcript from coach_media where id = any(${ids}) and message_id is null`;
  return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean).map(publicMedia);
}

export async function attachMedia(ids, messageId) {
  if (ids.length) await db()`update coach_media set message_id = ${messageId} where id = any(${ids}) and message_id is null`;
}

// The photos themselves, for the coach to look at: id -> { mime, data } in base64.
export async function photoData(ids) {
  if (!ids.length) return new Map();
  const rows = await db()`select id, mime, data from coach_media where id = any(${ids}) and kind = 'photo'`;
  return new Map(rows.map((r) => [r.id, { mime: r.mime, data: Buffer.from(r.data).toString('base64') }]));
}

const jsonBody = async (c) => {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
};

export const coachMediaApi = new Hono();
coachMediaApi.post('/coach/media', async (c) => c.json(await saveMedia(await jsonBody(c))));
// A photo or voice note as it was sent. Never changes, so the phone keeps it. Safari fetches audio in
// byte ranges and will not play it without them.
coachMediaApi.get('/coach/media/:id', async (c) => {
  const [r] = await db()`select mime, data from coach_media where id = ${Number(c.req.param('id')) || 0}`;
  if (!r) return c.json({ error: 'Not found.' }, 404);
  const buf = new Uint8Array(r.data);
  const head = { 'content-type': r.mime, 'cache-control': 'private, max-age=31536000, immutable', 'accept-ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    if (start >= buf.length || start > end) return c.body(null, 416, { 'content-range': `bytes */${buf.length}` });
    return c.body(buf.subarray(start, end + 1), 206, { ...head, 'content-range': `bytes ${start}-${end}/${buf.length}` });
  }
  return c.body(buf, 200, head);
});
