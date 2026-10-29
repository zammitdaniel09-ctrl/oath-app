// Touch gestures on lists: swiping a row on Today (Done, Not now) or in the Food diary (Remove), and
// pulling Today down to refresh. motion.js routes pointer events here and starts it with initTouch.

import { haptic, icon, reduced } from './ui.js';
import { EASE_OUT, spring, play, after, stop, rubber, speed } from './motion-core.js';

let cb = {};

// ---------- Swipe a habit or task row on Today: right for Done, left for Not now ----------
// A row marked data-swipe="remove" (a Food diary entry) only goes left, to Remove: it carries on out
// and the row fires oath:swipe-remove for its page to handle, with that page's Undo.

let swipe = null;
let swallowUntil = 0;

export function swipeStart(e) {
  if (e.pointerType !== 'touch') return;
  const row = e.target.closest?.('.page-today .group > button.li-habit, .page-today .group > button.li-task, .group > [data-swipe="remove"]');
  if (!row || row.disabled) return;
  const remove = row.dataset.swipe === 'remove';
  if (!remove && !cb.notNow) return;
  swipe = { row, remove, pid: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, dx: 0, trail: [] };
}

function swipeBg(row, remove) {
  const bg = document.createElement('div');
  bg.className = `swipe-bg${remove ? ' remove' : ''}`;
  bg.setAttribute('aria-hidden', 'true');
  bg.innerHTML = remove ? `<span class="sw-remove">Remove${icon('trash')}</span>`
    : `<span class="sw-done">${icon('check')}Done</span><span class="sw-later">Not now${icon('clock')}</span>`;
  bg.style.top = `${row.offsetTop}px`;
  bg.style.height = `${row.offsetHeight}px`;
  row.parentElement.append(bg);
  return bg;
}

export function swipeMove(e) {
  const s = swipe;
  const dx = e.clientX - s.x0;
  const dy = e.clientY - s.y0;
  if (!s.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
      swipe = null;
      return;
    }
    if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    s.on = true;
    s.x0 += Math.sign(dx) * 12;
    s.w = s.row.offsetWidth || 1;
    s.bg = swipeBg(s.row, s.remove);
    s.row.classList.add('is-swiping');
    try { s.row.setPointerCapture(s.pid); } catch { /* the row went away */ }
  }
  let x = e.clientX - s.x0;
  const max = s.w * 0.42;
  // A remove-only row resists going right.
  if (s.remove && x > 0) x = rubber(x, s.w, 0.15);
  else if (Math.abs(x) > max) x = Math.sign(x) * (max + rubber(Math.abs(x) - max, s.w));
  s.dx = x;
  s.row.style.transform = `translate3d(${x}px, 0, 0)`;
  const side = s.remove ? (x < 0 ? 'remove' : '') : x >= 0 ? 'done' : 'later';
  if (side !== s.side) {
    s.side = side;
    if (side) s.bg.dataset.side = side;
    else delete s.bg.dataset.side;
  }
  const armed = Boolean(side) && Math.abs(x) > s.w * 0.26;
  if (armed !== s.armed) {
    s.armed = armed;
    s.bg.classList.toggle('armed', armed);
    if (armed) haptic();
  }
  s.trail.push([performance.now(), x]);
  if (s.trail.length > 8) s.trail.shift();
}

export function swipeEnd(cancelled) {
  const s = swipe;
  swipe = null;
  if (!s?.on) return;
  swallowUntil = performance.now() + 450;
  const v = speed(s.trail);
  const flick = Math.abs(v) > 0.5 && Math.sign(v) === Math.sign(s.dx) && Math.abs(s.dx) > 40;
  const commit = !cancelled && (s.armed || flick) && (!s.remove || s.dx < 0);
  if (commit && s.remove) {
    // The row carries on out to the left over its "Remove" panel; the page redraws without it, or
    // with it back if it could not be removed.
    const out = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: `translate3d(${s.dx}px, 0, 0)` }, { transform: `translate3d(${-s.w}px, 0, 0)` }];
    play(s.row, out, { duration: 200, easing: EASE_OUT, fill: 'forwards' });
    s.row.style.transform = '';
    haptic();
    s.row.dispatchEvent(new CustomEvent('oath:swipe-remove', { bubbles: true }));
    return;
  }
  const sp = reduced() ? { duration: 180, easing: EASE_OUT } : spring(0.86, 0.34, s.dx ? (v * 1000) / -s.dx : 0);
  const a = play(s.row, [{ transform: `translate3d(${s.dx}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }], sp);
  s.row.style.transform = '';
  play(s.bg, [{ opacity: 1 }, { opacity: 0 }], { duration: Math.round(sp.duration * 0.7), easing: EASE_OUT, fill: 'forwards' });
  after(a, () => {
    s.row.classList.remove('is-swiping');
    s.bg.remove();
  });
  if (!commit) return;
  if (s.dx > 0) s.row.click();
  else cb.notNow(s.row);
}

// ---------- Pull to refresh on Today ----------

const PULL = 72;
let ptr = null;
let pull = null;

function drawPull() {
  if (!pull) return;
  pull.raf = 0;
  const d = Math.max(0, -window.scrollY);
  const p = Math.min(1, d / PULL);
  ptr.style.opacity = String(Math.min(1, d / 28));
  ptr.style.transform = `translate3d(-50%, ${Math.min(d, 120) * 0.55 - 30}px, 0) rotate(${Math.round(p * 270)}deg)`;
  ptr.querySelector('.ptr-arc').style.strokeDashoffset = String(100 - p * 100);
  const armed = d >= PULL;
  if (armed !== pull.armed) {
    pull.armed = armed;
    ptr.classList.toggle('armed', armed);
  }
  if (pull.released && d < 1) {
    ptr.style.opacity = '0';
    pull = null;
  }
}

function initPull() {
  if (!('ontouchstart' in window)) return;
  ptr = document.createElement('div');
  ptr.className = 'ptr';
  ptr.setAttribute('aria-hidden', 'true');
  ptr.innerHTML = '<svg viewBox="0 0 28 28"><circle class="ptr-track" cx="14" cy="14" r="9.5"/><circle class="ptr-arc" cx="14" cy="14" r="9.5" pathLength="100"/></svg>';
  document.body.append(ptr);
  const track = () => {
    if (pull && !pull.busy && !pull.raf) pull.raf = requestAnimationFrame(drawPull);
  };
  window.addEventListener('touchstart', (e) => {
    if (pull?.busy) return;
    const ok = cb.canPull?.() && window.scrollY <= 0 && e.touches.length === 1 && !e.target.closest('.sheet, input, textarea, select');
    pull = ok ? { armed: false, released: false, raf: 0 } : null;
  }, { passive: true });
  window.addEventListener('touchmove', track, { passive: true });
  window.addEventListener('scroll', track, { passive: true });
  window.addEventListener('touchcancel', () => {
    if (!pull || pull.busy) return;
    pull.released = true;
    pull.armed = false;
    track();
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (!pull || pull.busy) return;
    if (!pull.armed) {
      pull.released = true;
      track();
      return;
    }
    pull.busy = true;
    haptic();
    ptr.classList.add('spin');
    ptr.style.opacity = '1';
    ptr.style.transform = 'translate3d(-50%, 14px, 0)';
    Promise.resolve(cb.refresh?.()).catch(() => {}).finally(() => {
      const a = play(ptr, [{ opacity: 1, transform: 'translate3d(-50%, 14px, 0)' }, { opacity: 0, transform: 'translate3d(-50%, 6px, 0) scale(0.6)' }], { duration: 220, easing: EASE_OUT, fill: 'forwards' });
      after(a, () => {
        stop(ptr);
        ptr.classList.remove('spin', 'armed');
        ptr.style.opacity = '0';
        pull = null;
      });
    });
  }, { passive: true });
}

// What motion.js needs to know: the swipe under way, whether a click is the tail of a swipe, a pull.
export const swiping = () => swipe;
export const swallowed = () => performance.now() < swallowUntil;
export const pulling = () => pull;

export function initTouch(callbacks) {
  cb = callbacks;
  initPull();
}
