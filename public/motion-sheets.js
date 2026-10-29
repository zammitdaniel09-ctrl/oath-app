// Sheets in motion: they spring up, leave the way they came when closed by any route, and follow a
// finger down to dismiss. motion.js calls sheetsAfter on every redraw and passes pointer drags in.

import { $app, fx, reduced } from './ui.js';
import { WIDE, EASE_OUT, spring, play, after, stop, rubber, project, currentY, speed } from './motion-core.js';

// A sheet a drag closed enters afresh if it is drawn again; one mid-entrance picks it up where it was.
let dragDismissed = false;
let entering = null;

// ---------- Sheets: spring up, drag down to dismiss, fade the backdrop ----------

function sheetFrames() {
  if (reduced()) return { frames: [{ opacity: 0 }, { opacity: 1 }], opts: { duration: 200, easing: 'ease-out' } };
  if (WIDE.matches) {
    return { frames: [{ opacity: 0, transform: 'translateY(14px) scale(0.97)' }, { opacity: 1, transform: 'none' }], opts: { duration: 300, easing: EASE_OUT } };
  }
  return { frames: [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], opts: spring(1, 0.36) };
}

function enterSheet(sheet, backdrop) {
  const { frames, opts } = sheetFrames();
  const bopts = { duration: reduced() ? 200 : 320, easing: EASE_OUT };
  play(sheet, frames, opts);
  play(backdrop, [{ opacity: 0 }, { opacity: 1 }], bopts);
  entering = { t0: performance.now(), frames, opts, bopts };
}

// The same sheet drawn again mid-entrance: pick the entrance up where it was.
function carryEnter(sheet, backdrop) {
  if (!entering) return;
  const t = performance.now() - entering.t0;
  if (t >= entering.opts.duration) {
    entering = null;
    return;
  }
  const a = play(sheet, entering.frames, entering.opts);
  if (a) a.currentTime = t;
  if (t < entering.bopts.duration) {
    const b = play(backdrop, [{ opacity: 0 }, { opacity: 1 }], entering.bopts);
    if (b) b.currentTime = t;
  }
}

// A sheet that closed by any route (button, backdrop, Escape, a saved form) leaves the way it came:
// its last frame is kept on screen, inert, and slides out over the new page.
function exitSheet(snap) {
  const { sheet, backdrop } = snap;
  fx('sheet-close');
  stop(sheet);
  stop(backdrop);
  const ghost = document.createElement('div');
  ghost.className = 'sheet-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  if (backdrop) ghost.append(backdrop);
  ghost.append(sheet);
  document.body.append(ghost);
  if (snap.scroll) sheet.scrollTop = snap.scroll;
  const from = snap.from.transform === 'none' ? 'translateY(0)' : snap.from.transform;
  let frames;
  let opts;
  if (reduced()) {
    frames = [{ opacity: snap.from.opacity }, { opacity: 0 }];
    opts = { duration: 160, easing: 'ease-out' };
  } else if (WIDE.matches) {
    frames = [{ opacity: snap.from.opacity, transform: from }, { opacity: 0, transform: 'translateY(10px) scale(0.97)' }];
    opts = { duration: 200, easing: EASE_OUT };
  } else {
    frames = [{ transform: from }, { transform: `translateY(${sheet.offsetHeight + 24}px)` }];
    opts = spring(1, 0.3);
  }
  const a = play(sheet, frames, { ...opts, fill: 'forwards' });
  play(backdrop, [{ opacity: snap.fromBackdrop }, { opacity: 0 }], { duration: Math.min(opts.duration, 260), easing: EASE_OUT, fill: 'forwards' });
  const end = () => ghost.remove();
  after(a, end);
  setTimeout(end, opts.duration + 300);
}

export function sheetsAfter(snap, jobs, inTransition) {
  const sheet = $app.querySelector('.sheet');
  const backdrop = sheet ? $app.querySelector('.sheet-backdrop') : null;
  if (sheet) bindSheetTouch(sheet);
  if (sheet && (!snap.sheet || dragDismissed || !snap.same)) {
    jobs.push(() => {
      enterSheet(sheet, backdrop);
      fx('sheet-open');
    });
  } else if (sheet) {
    // Drawn again: the same sheet keeps its scroll; new contents in the same sheet cross-fade.
    const same = snap.label === sheet.getAttribute('aria-label');
    jobs.push(() => {
      if (same && snap.scroll) sheet.scrollTop = snap.scroll;
      carryEnter(sheet, backdrop);
      if (!same) [...sheet.children].forEach((c) => play(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' }));
    });
  } else if (snap.sheet && !dragDismissed && !inTransition) {
    entering = null;
    jobs.push(() => exitSheet(snap));
  }
  dragDismissed = false;
}

// Dragging: from the grabber and title (pointer events), or from the content when it is scrolled to
// the top (touch events, so a pull down at the top moves the sheet instead of rubber-banding).
let drag = null;

export function grabSheet(sheet, y) {
  const backdrop = $app.querySelector('.sheet-backdrop');
  const base = currentY(sheet);
  const op = backdrop ? Number(getComputedStyle(backdrop).opacity) : 1;
  stop(sheet);
  stop(backdrop);
  entering = null;
  sheet.style.transform = `translate3d(0, ${base}px, 0)`;
  if (backdrop) backdrop.style.opacity = String(op);
  sheet.classList.add('is-dragging');
  drag = { sheet, backdrop, y0: y, base, h: sheet.offsetHeight || 1, off: base, trail: [[performance.now(), base]] };
}

export function dragTo(y) {
  const d = drag;
  let off = d.base + (y - d.y0);
  if (off < 0) off = -rubber(-off, d.h);
  d.off = off;
  d.sheet.style.transform = `translate3d(0, ${off}px, 0)`;
  if (d.backdrop) d.backdrop.style.opacity = String(1 - Math.min(1, Math.max(0, off) / d.h));
  const now = performance.now();
  d.trail.push([now, off]);
  while (d.trail.length > 2 && now - d.trail[0][0] > 140) d.trail.shift();
}

export function letGo() {
  const d = drag;
  drag = null;
  if (!d) return;
  d.sheet.classList.remove('is-dragging');
  const v = speed(d.trail);
  const dismiss = d.off > 4 && v > -0.05 && d.off + project(v) > d.h * 0.5;
  const bFrom = d.backdrop?.style.opacity || '1';
  if (dismiss) {
    fx('sheet-close');
    const to = d.h + 24;
    const s = reduced() ? { duration: 160, easing: 'ease-out' } : spring(1, 0.3, (v * 1000) / Math.max(1, to - d.off));
    const a = play(d.sheet, [{ transform: `translate3d(0, ${d.off}px, 0)` }, { transform: `translate3d(0, ${to}px, 0)` }], { ...s, fill: 'forwards' });
    play(d.backdrop, [{ opacity: bFrom }, { opacity: 0 }], { duration: Math.min(s.duration, 280), easing: EASE_OUT, fill: 'forwards' });
    after(a, () => closeDragged(d));
    return;
  }
  const s = reduced() ? { duration: 180, easing: EASE_OUT } : spring(Math.abs(v) > 0.3 ? 0.8 : 1, 0.3, d.off ? (v * 1000) / -d.off : 0);
  play(d.sheet, [{ transform: `translate3d(0, ${d.off}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }], s);
  d.sheet.style.transform = '';
  if (d.backdrop) {
    play(d.backdrop, [{ opacity: bFrom }, { opacity: 1 }], { duration: 240, easing: EASE_OUT });
    d.backdrop.style.opacity = '';
  }
}

// Off screen: close it the way its own close button would, so every kind of sheet just works.
function closeDragged(d) {
  dragDismissed = true;
  const closer = d.backdrop?.dataset.action ? d.backdrop
    : d.sheet.querySelector('[data-action="sheet-dismiss"], [data-action="sheet-close"], [data-action="food-close"]');
  closer?.click();
  setTimeout(() => {
    if (!d.sheet.isConnected) return;
    // Nothing closed it: bring it back rather than leave it hidden.
    dragDismissed = false;
    stop(d.sheet);
    stop(d.backdrop);
    d.sheet.style.transform = '';
    if (d.backdrop) d.backdrop.style.opacity = '';
    enterSheet(d.sheet, d.backdrop);
  }, 160);
}

const NO_PULL = 'input, textarea, select, .tray, .map-scroll, .heat, .table-wrap, .quick-replies';

function bindSheetTouch(sheet) {
  let start = null;
  sheet.addEventListener('touchstart', (e) => {
    start = null;
    if (WIDE.matches || drag || e.touches.length !== 1) return;
    if (e.target.closest('.sheet-grab, .sheet-head') || e.target.closest(NO_PULL)) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, top: sheet.scrollTop <= 0 };
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!start) return;
    const t = e.touches[0];
    if (drag?.touch) {
      if (e.cancelable) e.preventDefault();
      dragTo(t.clientY);
      return;
    }
    if (!start.top || sheet.scrollTop > 0) {
      start = null;
      return;
    }
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (dy < 0 || Math.abs(dx) > Math.abs(dy)) {
      if (Math.abs(dx) + Math.abs(dy) > 6) start = null;
      return;
    }
    // At the top, pulling down would only rubber-band: take it for the sheet instead.
    if (e.cancelable) e.preventDefault();
    if (dy > 8) {
      grabSheet(sheet, t.clientY);
      drag.touch = true;
    }
  }, { passive: false });
  const end = () => {
    start = null;
    if (drag?.touch) letGo();
  };
  sheet.addEventListener('touchend', end, { passive: true });
  sheet.addEventListener('touchcancel', end, { passive: true });
}

// The drag under way, if any (motion.js routes pointer moves to it).
export const sheetDrag = () => drag;
