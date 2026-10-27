// Sound for Oath: short, soft sounds synthesised with the Web Audio API. No audio files.
//
// Anything asks for a sound by dispatching `oath:fx` on the document with the kind as its detail
// (ui.js has fx(kind), and haptic('tick') pairs a sound with the tap). The kinds are the app's
// feedback vocabulary: tick, untick, all-done, ring-close, log-food, send, receive, sheet-open,
// sheet-close, success, error, nav, toggle. Everything is quiet on purpose. On iOS the audio session
// is 'ambient', so the ringer switch mutes it and the user's music carries on underneath.

const KEY = 'oath.sounds';
let on = true;
try { on = localStorage.getItem(KEY) !== 'off'; } catch { /* storage unavailable: sounds stay on */ }

export const soundsOn = () => on;
export function setSounds(v) {
  on = Boolean(v);
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
}

try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch { /* not available */ }

// ---------- The voices ----------

// Short sounds are built from two things: a note (an oscillator with a quick attack and an exponential
// decay, bent from one pitch to another if asked) and a puff (band-passed noise swept up or down).
function note(c, out, t, hz, len, vol, o = {}) {
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(hz, t);
  if (o.bend) osc.frequency.exponentialRampToValueAtTime(o.bend, t + (o.glide ?? len / 2));
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(vol, t + (o.atk ?? 0.006));
  amp.gain.exponentialRampToValueAtTime(0.0001, t + len);
  let tail = osc;
  if (o.lp) {
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.lp;
    osc.connect(lp);
    tail = lp;
  }
  tail.connect(amp);
  amp.connect(out);
  osc.start(t);
  osc.stop(t + len + 0.03);
}

const noises = new WeakMap();
function puff(c, out, t, len, vol, from, to, q = 1) {
  if (!noises.has(c)) {
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.5), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
    noises.set(c, buf);
  }
  const src = c.createBufferSource();
  const band = c.createBiquadFilter();
  const amp = c.createGain();
  src.buffer = noises.get(c);
  band.type = 'bandpass';
  band.Q.value = q;
  band.frequency.setValueAtTime(from, t);
  band.frequency.exponentialRampToValueAtTime(to, t + len);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(vol, t + len * 0.35);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(band);
  band.connect(amp);
  amp.connect(out);
  src.start(t);
  src.stop(t + len + 0.03);
}

const VOICES = {
  // A soft pop that rises, with a glassy partial on top; its falling twin is quieter and rounder.
  tick(c, o, t) {
    note(c, o, t, 500, 0.17, 0.2, { bend: 860, glide: 0.06, lp: 2800 });
    note(c, o, t + 0.01, 1500, 0.08, 0.035, { bend: 2300, glide: 0.05 });
  },
  untick(c, o, t) {
    note(c, o, t, 520, 0.14, 0.11, { bend: 330, glide: 0.07, lp: 2000 });
  },
  // The day is done: a warm rolled C major with a ninth on top, and a low C underneath for body.
  'all-done'(c, o, t) {
    [523.25, 659.25, 783.99, 1174.66].forEach((hz, i) => {
      note(c, o, t + i * 0.05, hz, 0.95 - i * 0.1, 0.075, { atk: 0.012, lp: 3400 });
      note(c, o, t + i * 0.05, hz * 2, 0.45, 0.01, { atk: 0.012 });
    });
    note(c, o, t, 261.63, 0.9, 0.065, { type: 'triangle', atk: 0.02, lp: 900 });
  },
  // A ring closing: four bright partials climbing, each with a detuned twin so they shimmer.
  'ring-close'(c, o, t) {
    [1318.5, 1661.2, 1975.5, 2637].forEach((hz, i) => {
      note(c, o, t + i * 0.045, hz, 0.7, 0.05, { atk: 0.01 });
      note(c, o, t + i * 0.045, hz * 1.004, 0.7, 0.04, { atk: 0.01 });
    });
  },
  // A bubble: pitch climbs while it fades, twice, the second smaller and higher.
  'log-food'(c, o, t) {
    note(c, o, t, 320, 0.17, 0.2, { bend: 900, glide: 0.09, lp: 2400 });
    note(c, o, t + 0.07, 450, 0.13, 0.12, { bend: 1250, glide: 0.07, lp: 2600 });
  },
  send(c, o, t) {
    puff(c, o, t, 0.21, 0.2, 500, 3400, 0.9);
    note(c, o, t, 420, 0.18, 0.06, { bend: 840, glide: 0.14 });
  },
  receive(c, o, t) {
    note(c, o, t, 700, 0.22, 0.13, { bend: 760, glide: 0.08, type: 'triangle', atk: 0.012, lp: 1700 });
  },
  'sheet-open'(c, o, t) { puff(c, o, t, 0.18, 0.09, 300, 1100, 0.7); },
  'sheet-close'(c, o, t) { puff(c, o, t, 0.14, 0.07, 1000, 280, 0.7); },
  // Two bright notes, a fifth apart, the second one ringing a little longer.
  success(c, o, t) {
    note(c, o, t, 783.99, 0.22, 0.15, { lp: 4200 });
    note(c, o, t, 1568, 0.12, 0.025);
    note(c, o, t + 0.09, 1174.66, 0.5, 0.17, { lp: 4600 });
    note(c, o, t + 0.09, 2349.3, 0.3, 0.03);
  },
  // A low, soft thud: the pitch drops away, with a touch of body above it so a phone speaker carries it.
  error(c, o, t) {
    note(c, o, t, 230, 0.24, 0.2, { bend: 85, glide: 0.12, atk: 0.004, lp: 600 });
    puff(c, o, t, 0.05, 0.05, 420, 200, 0.8);
  },
  toggle(c, o, t) {
    note(c, o, t, 1500, 0.035, 0.12, { bend: 900, glide: 0.02, atk: 0.002 });
    puff(c, o, t, 0.02, 0.035, 2600, 4200, 1);
  },
  // Almost nothing: a tick you feel more than hear.
  nav(c, o, t) {
    note(c, o, t, 1900, 0.025, 0.04, { bend: 1500, glide: 0.012, atk: 0.002 });
  },
};

// Schedules a sound on any audio context, so the same code can be rendered offline to check it.
export const render = (kind, c, out, t = 0) => VOICES[kind]?.(c, out, t);

// ---------- Playing ----------

// How loud a sound is in the order of things: a lesser one is dropped if a greater one has just
// played, so one action never makes two sounds. SHADOW is how long a sound covers for those below it.
const RANK = { nav: 0, toggle: 1, 'sheet-open': 1, 'sheet-close': 1, tick: 2, untick: 2, send: 2, receive: 2, 'log-food': 2, success: 3, error: 3, 'ring-close': 4, 'all-done': 5 };
const SHADOW = { nav: 0, toggle: 80, 'sheet-open': 120, 'sheet-close': 120, tick: 140, untick: 140, send: 140, receive: 140, 'log-food': 160, success: 200, error: 200, 'ring-close': 300, 'all-done': 500 };
// Sounds that already answered the tap: a confirmation straight after one of these would be a second voice.
const ANSWERS = new Set(['toggle', 'tick', 'untick', 'send', 'log-food', 'ring-close', 'all-done']);

let ctx = null;
let bus = null;
let last = { kind: '', at: -1e9 };
let allDoneAt = -1e9;
let ringTimer = 0;

// The context is made inside the first gesture (browsers refuse it before that) and resumed by any
// later one: iOS suspends it whenever the app goes to the background.
const GESTURES = ['pointerup', 'touchend', 'mouseup', 'click', 'keydown'];

function open() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { return null; }
  bus = ctx.createGain();
  bus.gain.value = 0.8;
  bus.connect(ctx.destination);
  ctx.addEventListener('statechange', () => (ctx.state === 'running' ? disarm() : arm()));
  return ctx;
}

function unlock() {
  const c = open();
  if (!c || c.state === 'running') return;
  c.resume().catch(() => {});
  // Older iOS wants something started inside the gesture itself.
  const src = c.createBufferSource();
  src.buffer = c.createBuffer(1, 1, 22050);
  src.connect(c.destination);
  src.start(0);
}

function arm() { GESTURES.forEach((g) => document.addEventListener(g, unlock, { capture: true, passive: true })); }
function disarm() { GESTURES.forEach((g) => document.removeEventListener(g, unlock, { capture: true })); }

function go(kind) {
  last = { kind, at: performance.now() };
  if (kind === 'all-done') allDoneAt = last.at;
  render(kind, ctx, bus, ctx.currentTime + 0.005);
}

export function play(kind) {
  if (!on || !ctx || !VOICES[kind] || document.visibilityState === 'hidden') return;
  const now = performance.now();
  if (now - last.at < SHADOW[last.kind] && RANK[kind] <= RANK[last.kind]) return;
  if (kind === 'success' && ANSWERS.has(last.kind) && now - last.at < 1200) return;
  // A ring closing as the day completes is part of the chord: wait a beat to see whether it comes.
  if (kind === 'ring-close') {
    if (now - allDoneAt < 1500) return;
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => ctx.state === 'running' && go(kind), 90);
    return;
  }
  if (kind === 'all-done') clearTimeout(ringTimer);
  if (ctx.state === 'running') {
    go(kind);
    return;
  }
  // Just woken by the gesture that asked for this sound: play it once audio is running, if that is quick.
  ctx.resume().then(() => { if (ctx.state === 'running' && performance.now() - now < 200) go(kind); }).catch(() => {});
}

document.addEventListener('oath:fx', (e) => play(e.detail));
arm();
