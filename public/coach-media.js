// Photos and voice notes in the coach chat. A photo (camera or library) waits above the composer and
// uploads the moment it is picked, so Send is quick; a voice note records in the composer and uploads
// when he taps send, coming back transcribed. Played back here too. The chat itself is in app.js: this
// module draws its pieces and hands finished messages to ctx.send.
import { $app, state, esc, api, toast, icon, haptic } from './ui.js';
import { shrink } from './food.js';
import { chatToEnd } from './motion.js';

let ctx = { render: () => {}, send: async () => {}, addMessage: () => {} };
export function initCoachMedia(deps) {
  ctx = { ...ctx, ...deps };
}

const MAX_PHOTOS = 4;
const MAX_MS = 5 * 60000;
const BARS = 40; // a voice note's waveform, as kept with it
const LIVE_BARS = 26; // the meter while recording
let seq = 0;

const clock = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- What waits in the composer ----------

export function draft() {
  if (!state.coachDraft) state.coachDraft = { photos: [], text: '' };
  return state.coachDraft;
}

// Send shows when there is something to send; the microphone otherwise.
export function composerEmpty() {
  const box = document.getElementById('coach-text');
  return !(box ? box.value : draft().text).trim() && !draft().photos.length;
}
export function syncComposer() {
  $app.querySelector('.cc-composer')?.classList.toggle('empty', composerEmpty());
}

export function stagedHtml() {
  const list = draft().photos;
  const inner = list.length ? `<div class="cc-staged" role="group" aria-label="Photos to send">${list.map((p) => `<span class="cc-staged-img${p.id ? '' : ' up'}">
      ${p.thumb ? `<img src="${p.thumb}" alt="Photo to send">` : ''}<i class="cc-staged-spin" aria-hidden="true"></i>
      <button type="button" class="cc-staged-x" data-action="coach-unstage" data-key="${p.key}" aria-label="Remove this photo">${icon('close')}</button></span>`).join('')}</div>` : '';
  return `<div class="cc-staged-wrap">${inner}</div>`;
}

// The strip redraws on its own, so the keyboard and what he is typing stay put.
function paintStaged() {
  const wrap = $app.querySelector('.cc-staged-wrap');
  const grew = wrap && wrap.childElementCount !== (draft().photos.length ? 1 : 0);
  if (wrap) wrap.outerHTML = stagedHtml();
  // The strip coming or going moves the chat's end, so the last message stays in view above it.
  if (grew) chatToEnd();
  const box = document.getElementById('coach-text');
  if (box) box.placeholder = draft().photos.length ? 'Add a message (optional)' : 'Message the coach';
  syncComposer();
}

export async function stagePhotos(input) {
  const files = [...(input.files || [])];
  input.value = '';
  if (!files.length) return;
  const d = draft();
  const room = MAX_PHOTOS - d.photos.length;
  if (room <= 0) {
    toast(`Up to ${MAX_PHOTOS} photos in one message.`, true);
    return;
  }
  if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos in one message, so the first ${room} are in.`);
  for (const file of files.slice(0, room)) {
    const p = { key: `p${(seq += 1)}`, thumb: null, id: null };
    d.photos.push(p);
    p.up = (async () => {
      const [image, thumb] = await Promise.all([shrink(file), shrink(file, 360, 0.7)]);
      p.thumb = `data:image/jpeg;base64,${thumb}`;
      paintStaged();
      const r = await api('POST', '/api/coach/media', { kind: 'photo', data: image, mime: 'image/jpeg' });
      p.id = r.id;
      paintStaged();
    })().catch((err) => {
      d.photos = d.photos.filter((x) => x !== p);
      paintStaged();
      toast(err?.message || 'That photo could not be opened.', true);
    });
  }
  haptic('toggle');
  paintStaged();
}

export function unstage(key) {
  const d = draft();
  d.photos = d.photos.filter((p) => p.key !== key);
  haptic('toggle');
  paintStaged();
}

// The staged photos for a message: waits for their uploads and returns the ones that made it, with the
// thumbnails to show until the chat is reloaded. The strip is emptied.
export function takePhotos() {
  const list = draft().photos;
  draft().photos = [];
  return {
    shown: list.map((p) => ({ kind: 'photo', thumb: p.thumb, key: p.key })),
    ids: Promise.all(list.map((p) => p.up)).then(() => list.filter((p) => p.id).map((p) => ({ id: p.id, key: p.key }))),
  };
}

// ---------- In a message ----------

const PLAY = '<svg class="cc-i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor"/></svg>';
const PAUSE = '<svg class="cc-i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';

// A gentle made-up shape for a note kept without one.
const FLAT = Array.from({ length: BARS }, (_, i) => String(3 + Math.round(2 * Math.sin(i * 0.9) + Math.sin(i * 2.3)))).join('');

const keyOf = (v) => String(v.id || v.local);

function voiceHtml(v) {
  const peaks = /^[0-9]+$/.test(v.peaks || '') ? v.peaks : FLAT;
  const bars = [...peaks].map((h) => `<i style="--h:${h}"></i>`).join('');
  const k = keyOf(v);
  const on = playing === k;
  return `<div class="cc-voice${on ? ' playing' : ''}" data-voice="${esc(k)}" data-ms="${v.ms || 0}">
    <button type="button" class="cc-play" data-action="coach-voice" data-key="${esc(k)}" aria-label="${on ? 'Pause' : 'Play'} the voice note">${PLAY}${PAUSE}</button>
    <span class="cc-wave" aria-hidden="true">${bars}</span>
    <span class="cc-dur">${clock(v.ms)}</span>
  </div>`;
}

export function mediaHtml(m) {
  const media = m.media || [];
  const photos = media.filter((x) => x.kind === 'photo' && (x.thumb || x.id));
  const voice = media.find((x) => x.kind === 'voice');
  let out = '';
  if (photos.length) {
    out += `<div class="cc-photos n${Math.min(photos.length, 4)}">${photos.map((p) => {
      const src = p.thumb || `/api/coach/media/${p.id}`;
      const full = p.id ? `/api/coach/media/${p.id}` : p.thumb;
      return `<button type="button" class="cc-photo" data-action="coach-photo" data-src="${esc(full)}" aria-label="Open the photo"><img src="${esc(src)}" alt="" loading="lazy"></button>`;
    }).join('')}</div>`;
  }
  if (voice) out += voiceHtml(voice);
  return out;
}

// ---------- Playing ----------

let player = null;
let playing = null; // the key of the note playing (its id, or a local key before it is kept)
let raf = 0;
const local = new Map(); // key -> object URL of a note recorded on this phone

function frame() {
  raf = 0;
  const el = playing && $app.querySelector(`.cc-voice[data-voice="${CSS.escape(playing)}"]`);
  $app.querySelectorAll('.cc-voice.playing').forEach((x) => { if (x !== el) paintVoice(x, 0, false); });
  if (el && player) {
    const total = player.duration && Number.isFinite(player.duration) ? player.duration * 1000 : Number(el.dataset.ms) || 1;
    paintVoice(el, Math.min(1, (player.currentTime * 1000) / total), !player.paused, player.currentTime * 1000);
  }
  if (playing && player && !player.paused) raf = requestAnimationFrame(frame);
}

function paintVoice(el, frac, on, at = null) {
  el.classList.toggle('playing', on);
  const bars = el.querySelectorAll('.cc-wave i');
  const lit = Math.round(frac * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < lit));
  const dur = el.querySelector('.cc-dur');
  if (dur) dur.textContent = clock(at !== null && (on || frac > 0) ? at : Number(el.dataset.ms));
  el.querySelector('.cc-play')?.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} the voice note`);
}

export function toggleVoice(key) {
  if (!player) {
    player = new Audio();
    player.preload = 'auto';
    const stop = () => {
      const el = playing && $app.querySelector(`.cc-voice[data-voice="${CSS.escape(playing)}"]`);
      if (el) paintVoice(el, 0, false);
      playing = null;
    };
    player.addEventListener('ended', stop);
    player.addEventListener('error', () => {
      if (playing) toast('That voice note could not be played.', true);
      stop();
    });
    player.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(frame); });
    player.addEventListener('pause', () => requestAnimationFrame(frame));
  }
  if (playing === key) {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    return;
  }
  // Played straight from its address inside the tap, which is what lets an iPhone start it.
  playing = key;
  player.src = local.get(key) || `/api/coach/media/${encodeURIComponent(key)}`;
  player.play().catch((err) => {
    if (err?.name === 'NotAllowedError') toast('Tap play again.');
  });
  haptic('toggle');
}

// ---------- Recording ----------

let rec = null;
export const recording = () => Boolean(rec);

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return '';
}

export function recBarHtml() {
  return `<div class="composer cc-rec" role="group" aria-label="Recording a voice note">
    <button type="button" class="cc-rec-x" data-action="coach-rec-cancel" aria-label="Delete the recording">${icon('trash')}</button>
    <span class="cc-rec-dot" aria-hidden="true"></span>
    <span class="cc-rec-time" role="timer">${clock(rec ? performance.now() - rec.started : 0)}</span>
    <span class="cc-rec-bars" aria-hidden="true">${'<i></i>'.repeat(LIVE_BARS)}</span>
    <button type="button" class="btn primary send" data-action="coach-rec-send" aria-label="Send the voice note">${icon('send')}</button>
  </div>`;
}

export async function startRecording() {
  if (rec || state.sending) return;
  if (!state.coach?.voice) {
    toast('Voice notes need a transcription key on the server: add ELEVENLABS_API_KEY to the app\'s variables in Railway.', true);
    return;
  }
  const mime = pickMime();
  if (mime === null || !navigator.mediaDevices?.getUserMedia) {
    toast('This browser cannot record audio.', true);
    return;
  }
  // The meter's audio context starts inside the tap, before anything is awaited, or a phone keeps it silent.
  let ac = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ac = AC ? new AC() : null;
  } catch { ac = null; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    ac?.close().catch(() => {});
    toast(err?.name === 'NotAllowedError' ? 'The microphone is blocked. Allow it for Oath when asked, or in your phone\'s Settings, then try again.' : 'The microphone could not start.', true);
    return;
  }
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64000 });
  } catch {
    recorder = new MediaRecorder(stream);
  }
  const r = { stream, recorder, chunks: [], started: performance.now(), levels: [], timer: 0, mime: recorder.mimeType || mime || 'audio/mp4', ac };
  recorder.ondataavailable = (e) => { if (e.data?.size) r.chunks.push(e.data); };
  recorder.start(1000);
  if (ac) {
    try {
      ac.resume?.().catch(() => {});
      const an = ac.createAnalyser();
      an.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(an);
      r.an = an;
      r.buf = new Float32Array(an.fftSize);
    } catch { r.an = null; }
  }
  rec = r;
  if (playing && player) player.pause();
  haptic('toggle');
  ctx.render();
  // On a timer rather than the screen's frames, so the clock and the five-minute limit keep going.
  r.timer = setInterval(() => meter(r), 90);
}

// The level now, 0 to 1: the signal's loudness on a log scale, so speech fills the meter.
function level(r) {
  if (!r.an) return 0.25 + 0.2 * Math.abs(Math.sin(performance.now() / 180));
  r.an.getFloatTimeDomainData(r.buf);
  let sum = 0;
  for (let i = 0; i < r.buf.length; i += 1) sum += r.buf[i] * r.buf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / r.buf.length) || 1e-6);
  return Math.max(0, Math.min(1, (db + 55) / 45));
}

function meter(r) {
  if (rec !== r) return;
  const ms = performance.now() - r.started;
  r.levels.push(level(r));
  const bars = $app.querySelectorAll('.cc-rec-bars i');
  const recent = r.levels.slice(-bars.length);
  bars.forEach((b, i) => { b.style.setProperty('--v', (recent[i - (bars.length - recent.length)] ?? 0).toFixed(2)); });
  const t = $app.querySelector('.cc-rec-time');
  if (t) t.textContent = clock(ms);
  if (ms >= MAX_MS) {
    toast('Five minutes is the most for one voice note, so it went as it was.');
    finishRecording();
  }
}

function release(r) {
  clearInterval(r.timer);
  r.stream.getTracks().forEach((t) => t.stop());
  r.ac?.close().catch(() => {});
}

function stopped(r) {
  return new Promise((resolve) => {
    if (r.recorder.state === 'inactive') { resolve(); return; }
    r.recorder.addEventListener('stop', () => resolve(), { once: true });
    r.recorder.stop();
  });
}

export async function cancelRecording() {
  const r = rec;
  if (!r) return;
  rec = null;
  await stopped(r).catch(() => {});
  release(r);
  haptic('toggle');
  ctx.render();
}

// The waveform kept with a note: BARS heights of 0 to 9, the loudest moment at 9.
function peaksOf(levels) {
  if (!levels.length) return '';
  const out = [];
  for (let i = 0; i < BARS; i += 1) {
    const part = levels.slice(Math.floor((i * levels.length) / BARS), Math.max(Math.floor(((i + 1) * levels.length) / BARS), Math.floor((i * levels.length) / BARS) + 1));
    out.push(part.length ? Math.max(...part) : 0);
  }
  const top = Math.max(...out) || 1;
  return out.map((v) => Math.round((v / top) * 9)).join('');
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.onerror = () => reject(new Error('The recording could not be read.'));
  fr.readAsDataURL(blob);
});

export async function finishRecording() {
  const r = rec;
  if (!r) return;
  rec = null;
  const ms = Math.round(performance.now() - r.started);
  await stopped(r).catch(() => {});
  release(r);
  const blob = new Blob(r.chunks, { type: r.mime.split(';')[0] });
  if (ms < 700 || !blob.size) {
    ctx.render();
    toast('That was too short to send. Tap the microphone and speak, then send.');
    return;
  }
  const peaks = peaksOf(r.levels);
  const key = `l${(seq += 1)}`;
  local.set(key, URL.createObjectURL(blob));
  const voice = { kind: 'voice', ms, peaks, local: key };
  const msg = { role: 'user', text: '', at: new Date().toISOString(), media: [voice], hearing: true };
  ctx.addMessage(msg);
  haptic('send');
  let up;
  try {
    up = await api('POST', '/api/coach/media', { kind: 'voice', data: await toBase64(blob), mime: r.mime, duration_ms: ms, peaks });
  } catch (err) {
    msg.hearing = false;
    msg.notSent = true;
    state.sending = false;
    ctx.render();
    toast(err?.message || 'The voice note did not upload.', true);
    return;
  }
  msg.hearing = false;
  voice.id = up.id;
  local.set(String(up.id), local.get(key));
  if (playing === key) playing = String(up.id);
  if (!up.transcript) {
    msg.unheard = true;
    state.sending = false;
    ctx.render();
    toast('Nothing could be heard in that one. Try again a little closer to the phone.', true);
    return;
  }
  msg.text = up.transcript;
  // The transcript shows under the note at once, not only when the coach has answered.
  ctx.render();
  await ctx.send({ text: '', media: [up.id], msg });
}

// Leaving the chat stops a recording (nothing is sent) and the playback.
export function leaveChat() {
  if (rec) cancelRecording();
  if (player && !player.paused) player.pause();
}
