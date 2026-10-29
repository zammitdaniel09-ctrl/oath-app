// The pieces every kind of motion in Oath is made from: springs, playing an animation safely, and the
// physics of a finger (rubber banding past an edge, where a flick comes to rest, how fast it moved).

export const WIDE = window.matchMedia('(min-width: 900px)');

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const LINEAR_OK = Boolean(window.CSS?.supports?.('transition-timing-function', 'linear(0, 1)'));

// ---------- Springs ----------

// A spring from 0 to 1 as { easing, duration }. damping 1 settles without overshoot; below 1 it
// overshoots a little. response is roughly how long it takes, in seconds. velocity is in distances
// per second (the finger's px/s divided by the px left to travel).
const springs = new Map();
export function spring(damping = 1, response = 0.35, velocity = 0) {
  const v0 = Math.max(-40, Math.min(40, Math.round(velocity * 4) / 4));
  const key = `${damping}|${response}|${v0}`;
  const hit = springs.get(key);
  if (hit) return hit;
  const w = (2 * Math.PI) / response;
  let x = 0;
  let v = v0;
  let t = 0;
  const pts = [0];
  while (t < 1.5) {
    for (let i = 0; i < 8; i += 1) {
      v += (w * w * (1 - x) - 2 * damping * w * v) / 480;
      x += v / 480;
    }
    t += 1 / 60;
    pts.push(x);
    if (Math.abs(1 - x) < 0.002 && Math.abs(v) < 0.05) break;
  }
  pts[pts.length - 1] = 1;
  const s = LINEAR_OK
    ? { easing: `linear(${pts.map((p) => Math.round(p * 1000) / 1000).join(', ')})`, duration: Math.round(t * 1000) }
    : { easing: EASE_DRAWER, duration: Math.round(t * 650) };
  if (springs.size > 200) springs.clear();
  springs.set(key, s);
  return s;
}

export function play(el, frames, opts) {
  if (!el?.animate) return null;
  try { return el.animate(frames, opts); } catch { return null; }
}
export const after = (a, fn) => (a ? a.finished.then(fn, fn) : fn());

export const stop = (el) => el?.getAnimations?.().forEach((a) => a.cancel());
// Real things slow before they stop: the further past an edge, the less the element follows.
export const rubber = (x, dim, c = 0.55) => (x * dim * c) / (dim + c * x);
// Where a flick would come to rest (Apple's projection, deceleration 0.998), from px per ms.
export const project = (v) => v * 499;

export function currentY(el) {
  try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m42; } catch { return 0; }
}

// Speed over the last tenth of a second, in px per ms. A finger that stopped before letting go has none.
export function speed(trail) {
  const last = trail[trail.length - 1];
  if (!last || performance.now() - last[0] > 90) return 0;
  const first = trail.find(([t]) => last[0] - t <= 100) || last;
  const dt = last[0] - first[0];
  return dt > 8 ? (last[1] - first[1]) / dt : 0;
}
