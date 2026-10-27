// Motion for Oath: one module decides what moves, when, and how, so the views stay plain strings.
//
// The app redraws by replacing #app's HTML on every change, so nothing here replays on a redraw.
// Every effect is tied to a first view or to a real change: a new screen, a sheet that opens or
// closes, a tick, a new message, a number that moved. Only transform and opacity animate, through
// Web Animations, so the work stays on the compositor. Springs use Apple's two numbers, damping and
// response, sampled into a CSS linear() easing; when a drag lets go, the finger's speed is handed to
// the spring so there is no seam. Reduced motion keeps the meaning (fades) and drops the travel.
// The same moments are heard: sheets and taps ask sound.js for their sounds through fx().

import { state, hooks, haptic, icon, fx, reduced } from './ui.js';

const $app = document.getElementById('app');
const WIDE = window.matchMedia('(min-width: 900px)');

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
const LINEAR_OK = Boolean(window.CSS?.supports?.('transition-timing-function', 'linear(0, 1)'));

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

function play(el, frames, opts) {
  if (!el?.animate) return null;
  try { return el.animate(frames, opts); } catch { return null; }
}
const after = (a, fn) => (a ? a.finished.then(fn, fn) : fn());

// Animations that must survive a redraw. A screen often redraws a moment after a change (its data
// arrives, a side loader finishes): anything started under a key is picked up on the new element at
// the time it had reached, instead of being cut off.
const runs = new Map();
function playKeyed(key, el, frames, opts) {
  const a = play(el, frames, opts);
  if (a) runs.set(key, { frames, opts, t0: performance.now() });
  return a;
}
function replay(key, el) {
  const r = runs.get(key);
  if (!r) return false;
  const t = performance.now() - r.t0;
  if (t >= (r.opts.delay || 0) + r.opts.duration) {
    runs.delete(key);
    return false;
  }
  if (!el) return false;
  const a = play(el, r.frames, r.opts);
  if (a) a.currentTime = t;
  return true;
}
function prune() {
  const now = performance.now();
  for (const [k, r] of runs) if (now - r.t0 > (r.opts.delay || 0) + r.opts.duration) runs.delete(k);
}
const stop = (el) => el?.getAnimations?.().forEach((a) => a.cancel());
// Real things slow before they stop: the further past an edge, the less the element follows.
const rubber = (x, dim, c = 0.55) => (x * dim * c) / (dim + c * x);
// Where a flick would come to rest (Apple's projection, deceleration 0.998), from px per ms.
const project = (v) => v * 499;

function currentY(el) {
  try { return new DOMMatrixReadOnly(getComputedStyle(el).transform).m42; } catch { return 0; }
}

// Speed over the last tenth of a second, in px per ms. A finger that stopped before letting go has none.
function speed(trail) {
  const last = trail[trail.length - 1];
  if (!last || performance.now() - last[0] > 90) return 0;
  const first = trail.find(([t]) => last[0] - t <= 100) || last;
  const dt = last[0] - first[0];
  return dt > 8 ? (last[1] - first[1]) / dt : 0;
}

// ---------- Bookkeeping across redraws ----------

const viewOf = () => [state.route, state.param, state.param2].filter((x) => x !== null && x !== undefined && x !== '').join('/');
let lastView = null;
let wasLoading = false;
const entered = new Set();
let inTransition = false;
let navToken = 0;
let lead = null;
let tickAt = 0;
let dragDismissed = false;
let entering = null;
const counted = new Map();
const counters = new Map();
let lastBadge = null;
let lastNext = null;
let topIO = null;
let chatGrew = false;
let cb = {};

const isLoading = (page) => Boolean(page.querySelector(':scope > .skeleton'))
  || [...page.children].some((c) => c.matches('p.muted') && c.textContent.trim() === 'Loading');

// ---------- Before and after each redraw ----------

// Read what is on screen now, so the redraw can carry on from it.
export function beforeShell() {
  const view = viewOf();
  const inShell = Boolean($app.querySelector(':scope > .page'));
  if (!inShell) entered.clear(); // back from the lock screen: the day gets its entrance again
  const same = inShell && view === lastView;
  const snap = { view, same, condensed: same && Boolean($app.querySelector('.topbar.on')) };
  // The selection as drawn: the capsule, or on the phone the raised Food button, which has none.
  const cur = $app.querySelector('.tabbar .tab[aria-current="page"]');
  const pill = cur?.querySelector('.tab-pill');
  if (pill?.offsetWidth) snap.pill = { rect: pill.getBoundingClientRect(), tab: cur.getAttribute('href'), wide: WIDE.matches };
  else if (cur?.classList.contains('tab-centre')) snap.pill = { rect: cur.querySelector('.tab-ic').getBoundingClientRect(), tab: cur.getAttribute('href'), wide: WIDE.matches, fab: true };
  const sheet = $app.querySelector('.sheet');
  if (sheet) {
    snap.sheet = sheet;
    snap.backdrop = $app.querySelector('.sheet-backdrop');
    snap.label = sheet.getAttribute('aria-label');
    snap.scroll = sheet.scrollTop;
    const cs = getComputedStyle(sheet);
    snap.from = { transform: cs.transform, opacity: cs.opacity };
    snap.fromBackdrop = snap.backdrop ? getComputedStyle(snap.backdrop).opacity : '1';
  }
  if (same) {
    snap.segs = readSegs();
    snap.rows = readRows();
    snap.width = document.documentElement.clientWidth;
    snap.chat = chatCount();
  }
  return snap;
}

// After the new HTML is in: measure everything first, then start every animation, so the browser
// lays out once.
export function afterShell(snap) {
  const page = $app.querySelector(':scope > .page');
  if (!page) return;
  const loading = isLoading(page);
  const jobs = [];
  segsAfter(snap, jobs); // the only step that writes before reading: it adds the segment pills
  sheetsAfter(snap, jobs);
  pillAfter(snap, jobs);
  if (snap.rows) rowsAfter(snap, jobs);
  chatAfter(snap, jobs);
  nextAfter(snap, page, jobs);
  growAfter(jobs);
  badgeAfter(jobs);
  if (!loading) entranceAfter(snap, page, jobs);
  countsAfter(jobs);
  rollAfter(snap, jobs);
  topbarAfter(page);
  jobs.forEach((job) => job());
  prune();
  lastView = snap.view;
  wasLoading = loading;
}

// ---------- Navigation ----------

// Settings, Review and Dashboard sit one level under the tabs on the phone; a parameter is one level deeper.
const UNDER = ['review', 'settings', 'dashboard'];
function depth(v) {
  const parts = v.split('/');
  return parts.length - 1 + (!WIDE.matches && UNDER.includes(parts[0]) ? 1 : 0);
}
function navKind(from, to) {
  if (!from) return 'tab';
  const a = from.split('/')[0];
  const b = to.split('/')[0];
  const sub = UNDER;
  const related = a === b || (!WIDE.matches && (sub.includes(a) || sub.includes(b)));
  if (related && depth(to) > depth(from)) return 'fwd';
  if (related && depth(to) < depth(from)) return 'back';
  return 'tab';
}

// A change of screen: a push for going deeper, a pop for coming back, a quick settle between tabs.
// The View Transitions API animates snapshots, so the live page is never transformed; the tab bar
// keeps its own name and stays put. Without it, the new screen fades in (see entranceAfter).
export function navigate(update, { native = false } = {}) {
  const to = viewOf();
  const inApp = Boolean($app.querySelector('.tabbar'));
  if (!inApp || native || to === lastView || !document.startViewTransition || document.visibilityState !== 'visible') {
    update();
    return;
  }
  const root = document.documentElement;
  const kind = reduced() ? 'fade' : navKind(lastView, to);
  const token = (navToken += 1);
  root.dataset.nav = kind;
  // Tabs sit side by side, so a new tab drifts in from the side it is on.
  const dir = kind === 'tab' ? tabDir(lastView, to) : '';
  if (dir) root.dataset.dir = dir;
  else delete root.dataset.dir;
  const clear = () => {
    delete root.dataset.nav;
    delete root.dataset.dir;
  };
  try {
    const t = document.startViewTransition(() => {
      inTransition = true;
      try { update(); } finally { inTransition = false; }
    });
    t.ready.catch(() => {}); // a transition skipped by the next one is not an error
    t.finished.finally(() => { if (navToken === token) clear(); });
  } catch {
    clear();
    update();
  }
}

// Which way along the tab bar a move goes: 'r' to a tab further right, 'l' to one further left.
function tabDir(from, to) {
  const tabs = [...$app.querySelectorAll('.tabbar .tab')].map((a) => (a.getAttribute('href') || '').slice(2));
  const a = tabs.indexOf((from || '').split('/')[0]);
  const b = tabs.indexOf(to.split('/')[0]);
  return a < 0 || b < 0 || a === b ? '' : b > a ? 'r' : 'l';
}

// ---------- First view: a gentle stagger, once per screen per session ----------

function blocksOf(page) {
  const chat = page.querySelector('#chat');
  if (chat) {
    return [...page.querySelectorAll(':scope > .lt, :scope > .banner, :scope > .brief-buttons'), ...[...chat.children].slice(-4),
      ...page.querySelectorAll(':scope > .composer-dock')];
  }
  const out = [];
  for (const el of page.children) {
    if (el.matches('.sheet, .sheet-backdrop, .next-dock')) continue;
    if (el.classList.contains('split')) for (const col of el.children) out.push(...col.children);
    else out.push(el);
  }
  return out;
}

const STAGGER = { duration: 420, step: 45, max: 8 };
let stagger = null;

function entranceAfter(snap, page, jobs) {
  const now = performance.now();
  const first = !entered.has(snap.view);
  // The day often redraws a moment after it first appears (setup status, food): the entrance
  // carries on across that redraw instead of being cut off.
  const carry = !first && snap.same && stagger?.view === snap.view && now - stagger.t0 < STAGGER.duration + STAGGER.step * STAGGER.max;
  const fromLoading = snap.same && wasLoading;
  const plainNav = !snap.same && !inTransition && Boolean(lastView);
  if (!first && !carry && !fromLoading && !plainNav) return;
  entered.add(snap.view);
  const vh = window.innerHeight;
  const chat = Boolean(page.querySelector('#chat'));
  let list = blocksOf(page).map((el) => [el, el.getBoundingClientRect()]).filter(([, r]) => r.height > 0);
  if (!chat) list = list.filter(([, r]) => r.bottom > 0 && r.top < vh).sort((a, b) => a[1].top - b[1].top || a[1].left - b[1].left);
  const els = list.slice(0, STAGGER.max).map(([el]) => el);
  if (!els.length) return;
  if (!first && !carry) {
    jobs.push(() => els.forEach((el) => play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })));
    return;
  }
  if (reduced()) {
    if (first) jobs.push(() => els.forEach((el) => play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })));
    return;
  }
  if (first) stagger = { view: snap.view, t0: now };
  const at = now - stagger.t0;
  jobs.push(() => els.forEach((el, i) => {
    const a = play(el, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }],
      { duration: STAGGER.duration, easing: EASE_OUT, delay: i * STAGGER.step, fill: 'backwards' });
    if (a && at > 0) a.currentTime = at;
  }));
}

// ---------- Headline numbers count up on first view, and from the old value when they change ----------

function countsAfter(jobs) {
  $app.querySelectorAll('[data-count]').forEach((el) => {
    const key = el.dataset.count;
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.nodeValue));
    if (!node) return;
    const to = Number(node.nodeValue.trim());
    if (!Number.isFinite(to)) return;
    const prev = counted.get(key);
    counted.set(key, to);
    const run = counters.get(key);
    if (run && run.to === to) {
      // A redraw in the middle of a count: carry on from where it was.
      run.node = node;
      node.nodeValue = String(Math.round(run.value));
      return;
    }
    if (reduced() || prev === to) return;
    const from = run ? Math.round(run.value) : prev === undefined ? 0 : prev;
    jobs.push(() => count(key, node, from, to, prev === undefined ? 1000 : 700));
  });
}

function count(key, node, from, to, ms) {
  const run = { node, from, to, value: from, t0: performance.now(), ms };
  counters.set(key, run);
  node.nodeValue = String(from);
  const step = (now) => {
    if (counters.get(key) !== run) return;
    // A frame's timestamp can fall just before the count began: never step backwards.
    const p = Math.min(1, Math.max(0, (now - run.t0) / run.ms));
    run.value = run.from + (run.to - run.from) * (1 - (1 - p) ** 4);
    run.node.nodeValue = String(Math.round(run.value));
    if (p < 1) requestAnimationFrame(step);
    else counters.delete(key);
  };
  requestAnimationFrame(step);
}

// ---------- Numbers that change roll: the old one leaves upward, the new one comes up behind it ----------

// For small counts that tick up and down (the open count on the tab, a day's calories, done of total).
// Mark any other with data-roll. The ones that count up from zero (data-count) have their own motion.
const ROLL = '[data-roll], .tab-badge, .ft-kcal, .fring-c > b, .lg-val:not([data-count])';
const rolled = new Map();

function rollAfter(snap, jobs) {
  const seen = {};
  $app.querySelectorAll(ROLL).forEach((el) => {
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.nodeValue));
    if (!node) return;
    const name = el.dataset.roll || el.classList[0] || el.tagName;
    seen[name] = (seen[name] || 0) + 1;
    const key = `${name}#${seen[name]}`;
    const text = node.nodeValue.trim();
    const prev = rolled.get(key);
    rolled.set(key, text);
    const id = `roll:${key}`;
    const moved = prev !== undefined && prev !== text && snap.same && !reduced();
    const carrying = !moved && runs.has(id) && !reduced(); // a redraw in the middle of a roll
    if (!moved && !carrying) return;
    const wrap = document.createElement('span');
    wrap.className = 'roll';
    const now = document.createElement('span');
    now.className = 'roll-in';
    now.textContent = node.nodeValue;
    wrap.append(now);
    node.replaceWith(wrap);
    if (carrying) {
      jobs.push(() => replay(id, now));
      return;
    }
    const was = document.createElement('span');
    was.className = 'roll-out';
    was.setAttribute('aria-hidden', 'true');
    was.textContent = prev;
    wrap.append(was);
    const dir = parseFloat(text.replace(/[^\d.-]/g, '')) >= parseFloat(prev.replace(/[^\d.-]/g, '')) ? 1 : -1;
    jobs.push(() => {
      playKeyed(id, now, [{ opacity: 0, transform: `translateY(${dir * 70}%)` }, { opacity: 1, transform: 'none' }], { ...spring(0.9, 0.34), fill: 'backwards' });
      const a = play(was, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${dir * -70}%)` }], { duration: 200, easing: EASE_OUT, fill: 'forwards' });
      after(a, () => was.remove());
    });
  });
}

// ---------- The tab bar: the selection slides, the new icon gives a small bounce ----------

function pillAfter(snap, jobs) {
  const tab = $app.querySelector('.tabbar .tab[aria-current="page"]');
  if (!tab) return;
  const href = tab.getAttribute('href');
  const changed = snap.pill && snap.pill.wide === WIDE.matches && snap.pill.tab !== href;
  const pill = tab.querySelector('.tab-pill');
  // On the phone the raised Food button is the selection: arriving at it, it settles with a press.
  if (!pill?.offsetWidth) {
    const disc = tab.classList.contains('tab-centre') ? tab.querySelector('.tab-ic') : null;
    if (!disc) return;
    if (changed && !reduced()) jobs.push(() => playKeyed(`fab:${href}`, disc, [{ transform: 'scale(0.88)' }, { transform: 'none' }], spring(0.5, 0.42)));
    else jobs.push(() => replay(`fab:${href}`, disc));
    return;
  }
  const ic = tab.querySelector('.tab-ic .ic');
  const r = changed && !reduced() ? pill.getBoundingClientRect() : null;
  if (!r?.width) {
    jobs.push(() => {
      replay(`pill:${href}`, pill);
      replay(`pill-ic:${href}`, ic);
    });
    return;
  }
  // From centre to centre, so a capsule leaving the round Food button grows out of it.
  const from = snap.pill.rect;
  const dx = from.left + from.width / 2 - (r.left + r.width / 2);
  const dy = from.top + from.height / 2 - (r.top + r.height / 2);
  const frames = snap.pill.fab
    ? [{ transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0 }, { transform: 'none', opacity: 1 }]
    : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }];
  jobs.push(() => {
    playKeyed(`pill:${href}`, pill, frames, spring(0.78, 0.38));
    playKeyed(`pill-ic:${href}`, ic, [{ transform: 'scale(0.82)' }, { transform: 'none' }], spring(0.55, 0.36));
  });
}

function badgeAfter(jobs) {
  const b = $app.querySelector('.tab-badge');
  const n = b ? Number(b.textContent.replace(/\D/g, '')) : 0;
  const prev = lastBadge;
  lastBadge = n;
  if (!b) return;
  if (prev === null || prev === n || reduced()) {
    jobs.push(() => replay(`badge:${n}`, b));
    return;
  }
  jobs.push(() => playKeyed(`badge:${n}`, b, [{ transform: 'scale(1.45)' }, { transform: 'none' }], spring(0.5, 0.36)));
}

// ---------- The compact top bar: the large title condenses into it on scroll ----------

function topbarAfter(page) {
  topIO?.disconnect();
  topIO = null;
  const bar = $app.querySelector(':scope > .topbar');
  if (!bar) return;
  const title = page.querySelector('.lt-title, .goal-h');
  if (!title) {
    bar.classList.remove('on');
    return;
  }
  bar.querySelector('.topbar-title').textContent = title.textContent.trim();
  const back = page.querySelector(':scope > a.back, :scope > .goal-head > a.back');
  const link = bar.querySelector('.topbar-back');
  if (back) {
    link.href = back.getAttribute('href');
    link.innerHTML = icon('back');
    const words = document.createElement('span');
    words.textContent = back.textContent.trim();
    link.append(words);
    link.hidden = false;
  }
  if (!('IntersectionObserver' in window)) return;
  const h = bar.offsetHeight || 48;
  topIO = new IntersectionObserver(([e]) => {
    bar.classList.toggle('on', !e.isIntersecting && e.boundingClientRect.top < h);
  }, { rootMargin: `-${h}px 0px 0px 0px` });
  topIO.observe(title);
}

// ---------- Segmented controls: one pill that slides between the choices ----------

function segKey(seg, seen) {
  const label = seg.getAttribute('aria-label') || seg.className;
  seen[label] = (seen[label] || 0) + 1;
  return `${label}#${seen[label]}`;
}

function segChoice(seg) {
  for (const c of seg.children) {
    if (c.tagName === 'BUTTON' && (c.getAttribute('aria-selected') === 'true' || c.getAttribute('aria-pressed') === 'true' || c.classList.contains('on'))) return c;
    if (c.tagName === 'LABEL' && c.querySelector('input:checked')) return c;
  }
  return null;
}

// Where each pill is, and which choice it sits on: it only slides when the choice changed.
function readSegs() {
  const out = new Map();
  const seen = {};
  $app.querySelectorAll('.seg').forEach((seg) => {
    const key = segKey(seg, seen);
    const ind = seg.querySelector('.seg-ind');
    if (ind) out.set(key, { rect: ind.getBoundingClientRect(), at: [...seg.children].indexOf(ind.parentElement) });
  });
  return out;
}

function makeInd() {
  const ind = document.createElement('i');
  ind.className = 'seg-ind';
  ind.setAttribute('aria-hidden', 'true');
  return ind;
}

function segsAfter(snap, jobs) {
  const seen = {};
  const moves = [];
  const carry = [];
  $app.querySelectorAll('.seg').forEach((seg) => {
    const key = segKey(seg, seen);
    seg.classList.add('seg-live');
    const choice = segChoice(seg);
    if (!choice) return;
    const ind = makeInd();
    choice.prepend(ind);
    const at = [...seg.children].indexOf(choice);
    const was = snap.segs?.get(key);
    if (was && was.at !== at && !reduced()) moves.push([ind, was.rect, `seg:${snap.view}:${key}:${at}`]);
    else carry.push([ind, `seg:${snap.view}:${key}:${at}`]);
  });
  const measured = moves.map(([ind, from, key]) => [ind, from, ind.getBoundingClientRect(), key]);
  jobs.push(() => {
    measured.forEach(([ind, from, to, key]) => slide(ind, from, to, key));
    carry.forEach(([ind, key]) => replay(key, ind));
  });
}

function slide(ind, from, to, key = null) {
  if (!to.width || !from.width) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01) return;
  const frames = [{ transform: `translate(${dx}px, ${dy}px) scaleX(${sx})` }, { transform: 'none' }];
  if (key) playKeyed(key, ind, frames, spring(0.86, 0.32));
  else play(ind, frames, spring(0.86, 0.32));
}

// Radio segments change without a redraw: move the pill to the new choice and slide it there.
function onSegChange(e) {
  const input = e.target;
  if (input.type !== 'radio') return;
  const seg = input.closest('.seg-live');
  const label = input.closest('label');
  if (!seg || !label || !input.checked) return;
  let ind = seg.querySelector('.seg-ind');
  if (ind?.parentElement === label) return;
  const from = ind?.getBoundingClientRect();
  if (!ind) ind = makeInd();
  label.prepend(ind);
  if (from && !reduced()) slide(ind, from, ind.getBoundingClientRect());
}

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

function sheetsAfter(snap, jobs) {
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

function grabSheet(sheet, y) {
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

function dragTo(y) {
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

function letGo() {
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

// ---------- Ticks: the check pops and draws, then the list settles into its new order ----------

export function ticked(row) {
  tickAt = performance.now();
  lead = row?.dataset?.key || null;
  // Sparks leave the check. When the tap was somewhere else (the Done button in Up next) they leave
  // the finger instead, and with nothing to go by they stay home.
  const r = row?.querySelector('.chk')?.getBoundingClientRect();
  const box = row?.getBoundingClientRect();
  const touched = performance.now() - tap.at < 1500;
  const onRow = touched && box && tap.x >= box.left && tap.x <= box.right && tap.y >= box.top && tap.y <= box.bottom;
  const seen = r?.width && r.bottom > 0 && r.top < window.innerHeight && (onRow || !touched);
  const at = seen ? [r.left + r.width / 2, r.top + r.height / 2] : touched ? [tap.x, tap.y] : null;
  if (!at) return;
  sparkAt = { x: at[0], y: at[1], t: performance.now() };
  spark(at[0], at[1], 8, 34, 6);
}

// ---------- Sparks: a small burst where a tick lands, a bigger one when the day is done ----------

const SPARK = ['#3ff0b9', '#8dffdc', '#f4f5f8', '#3ff0b9', '#ffc233'];
let sparkLayer = null;
let sparkAt = null;
const tap = { x: 0, y: 0, at: -1e9 };

// n specks fly out from (x, y), slow as they go and fade; fall pulls them down at the end. A layer of
// its own on top of everything, so a redraw never cuts a burst off.
function spark(x, y, n, reach, size, fall = 0) {
  if (reduced() || document.visibilityState !== 'visible') return;
  if (!sparkLayer) {
    sparkLayer = document.createElement('div');
    sparkLayer.className = 'fx-spark-layer';
    sparkLayer.setAttribute('aria-hidden', 'true');
    document.body.append(sparkLayer);
  }
  const specks = [];
  for (let i = 0; i < n; i += 1) {
    const dot = document.createElement('i');
    dot.className = 'fx-spark';
    const s = size * (0.7 + Math.random() * 0.6);
    dot.style.cssText = `width:${s}px;height:${fall ? s * (i % 3 ? 1 : 1.8) : s}px;margin:${-s / 2}px 0 0 ${-s / 2}px;background:${SPARK[i % SPARK.length]}`;
    const ang = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.8;
    const dist = reach * (0.55 + Math.random() * 0.6);
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist;
    const spin = fall ? Math.round((Math.random() - 0.5) * 540) : 0;
    specks.push([dot, [
      { transform: `translate3d(${x}px, ${y}px, 0) rotate(0deg) scale(1)`, opacity: 1, easing: EASE_OUT },
      { transform: `translate3d(${x + dx}px, ${y + dy}px, 0) rotate(${spin / 2}deg) scale(1)`, opacity: 1, offset: 0.5, easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
      { transform: `translate3d(${x + dx * 1.1}px, ${y + dy * 1.1 + fall}px, 0) rotate(${spin}deg) scale(0.4)`, opacity: 0 },
    ], Math.round((fall ? 900 : 520) + Math.random() * 220)]);
  }
  specks.forEach(([dot, frames, duration]) => {
    sparkLayer.append(dot);
    after(play(dot, frames, { duration, fill: 'both' }), () => dot.remove());
  });
}

// The last thing due today is done: a fountain of sparks from the middle of the screen, at the height
// of the last tick, that rise and fall back.
export function celebrate() {
  const vh = window.innerHeight;
  const y = sparkAt && performance.now() - sparkAt.t < 5000 ? sparkAt.y : vh * 0.45;
  spark(window.innerWidth / 2, Math.min(Math.max(y, vh * 0.3), vh * 0.6), 28, Math.min(150, window.innerWidth * 0.4), 7, 90);
}

// Resolves once the check has finished drawing, so a redraw never cuts it off.
export function tickSettled() {
  const left = tickAt + 460 - performance.now();
  return left > 0 && !reduced() ? new Promise((r) => { setTimeout(r, left); }) : Promise.resolve();
}

// Where each keyed row of Today sits in its list: its top within the group, its height, and which
// group it is in (counted from the first), so a redraw can tell a row that moved from one that came
// or went. Measured from the group, so a change above the list moves nothing.
const ROWS = '.page-today .group > [data-key]';
function readRows() {
  const out = new Map();
  const groups = new Map();
  $app.querySelectorAll(ROWS).forEach((row) => {
    const group = row.parentElement;
    if (!groups.has(group)) groups.set(group, { top: group.getBoundingClientRect().top, at: groups.size });
    const g = groups.get(group);
    const r = row.getBoundingClientRect();
    out.set(row.dataset.key, { top: r.top - g.top, h: r.height, g: g.at, el: row, group });
  });
  return out;
}

function moveRow(row, a, isLead) {
  if (!a) return;
  row.classList.add('is-moving');
  if (isLead) row.classList.add('is-lead');
  after(a, () => row.classList.remove('is-moving', 'is-lead'));
}

// After a redraw: rows that moved slide to their new place, a row that is new settles in, and a row
// that has gone fades away where it was (a copy of it, held in its group for a moment).
function rowsAfter(snap, jobs) {
  // A sheet hides or shows the page's scrollbar on a desktop, which can re-wrap text: not the rows' doing.
  if (reduced() || snap.width !== document.documentElement.clientWidth) return;
  const now = readRows();
  const moves = [];
  const fresh = [];
  const gone = [];
  for (const [key, r] of now) {
    const was = snap.rows.get(key);
    if (!was || was.g !== r.g) fresh.push(key);
    else if (Math.abs(was.top - r.top) > 2) moves.push([key, was.top - r.top]);
  }
  for (const [key, was] of snap.rows) if (!now.has(key)) gone.push(was);
  // A whole list swapped for another is a new screen's business, not the rows'.
  const few = snap.rows.size > 0 && now.size > 0 && fresh.length <= 3 && gone.length <= 3 && !wasLoading;
  jobs.push(() => {
    const s = spring(1, 0.4);
    moves.forEach(([key, dy]) => {
      const row = now.get(key).el;
      moveRow(row, playKeyed(`row:${key}`, row, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], s), key === lead);
    });
    if (few) {
      fresh.forEach((key) => {
        const row = now.get(key).el;
        moveRow(row, playKeyed(`row:${key}`, row, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { ...spring(0.8, 0.42), fill: 'backwards' }), false);
      });
      gone.forEach((was) => {
        const group = [...now.values()].find((r) => r.g === was.g)?.group;
        if (group) fadeRow(group, was);
      });
    }
    rowsCarry(now);
  });
}

// A copy of a row that has gone, laid where it was, that slips away to the left and leaves.
function fadeRow(group, was) {
  const ghost = was.el.cloneNode(true);
  ghost.classList.remove('pending', 'is-moving', 'is-lead', 'is-swiping');
  ghost.classList.add('row-ghost');
  ghost.removeAttribute('data-key');
  ghost.removeAttribute('data-action');
  ghost.removeAttribute('data-due');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.top = `${was.top}px`;
  ghost.style.height = `${was.h}px`;
  group.append(ghost);
  const a = play(ghost, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-20px)' }], { duration: 260, easing: EASE_OUT, fill: 'forwards' });
  const end = () => ghost.remove();
  after(a, end);
  setTimeout(end, 600);
}

// A redraw while rows are still settling: they carry on settling.
function rowsCarry(now) {
  if (![...runs.keys()].some((k) => k.startsWith('row:'))) return;
  for (const [key, r] of now) {
    const id = `row:${key}`;
    if (!runs.has(id) || r.el.getAnimations().length) continue;
    if (replay(id, r.el)) moveRow(r.el, r.el.getAnimations()[0], key === lead);
  }
}

// Up next changed to a new item: its words arrive like the next card in a deck, in the card and the dock.
function nextAfter(snap, page, jobs) {
  const card = page.querySelector('.now[data-next]');
  const key = card?.dataset.next || null;
  const prev = lastNext;
  lastNext = key;
  if (!card) return;
  const kids = [...card.children, ...page.querySelectorAll('#next-dock:not([hidden]) .dock-text')];
  if (!snap.same || !prev || prev === key || reduced()) {
    jobs.push(() => kids.forEach((k, i) => replay(`next:${key}:${i}`, k)));
    return;
  }
  jobs.push(() => kids.forEach((k, i) => playKeyed(`next:${key}:${i}`, k, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
    { duration: 380, easing: EASE_OUT, delay: i * 35, fill: 'backwards' })));
}

// Bars drawn at a new width grow from the old one (data-grow="key" on the bar's fill).
const grown = new Map();
function growAfter(jobs) {
  $app.querySelectorAll('[data-grow]').forEach((el) => {
    const key = el.dataset.grow;
    const to = parseFloat(el.style.width);
    const first = !grown.has(key);
    const from = first ? 0 : grown.get(key);
    grown.set(key, to);
    if (from === to || !(to > 0) || reduced()) {
      jobs.push(() => replay(`grow:${key}:${to}`, el));
      return;
    }
    jobs.push(() => playKeyed(`grow:${key}:${to}`, el, [{ transform: `scaleX(${Math.max(0, from) / to})` }, { transform: 'none' }], { ...spring(1, 0.5), delay: first ? 260 : 120, fill: 'backwards' }));
  });
}

// The dock above the tab bar rises in when Up next scrolls away, and drops out when it comes back.
export function dock(el, show) {
  stop(el);
  if (show) {
    el.hidden = false;
    if (!reduced()) play(el, [{ opacity: 0, transform: 'translateY(18px) scale(0.98)' }, { opacity: 1, transform: 'none' }], spring(0.86, 0.38));
    return;
  }
  const a = reduced() ? null : play(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(14px)' }], { duration: 160, easing: EASE_OUT, fill: 'forwards' });
  if (!a) {
    el.hidden = true;
    return;
  }
  a.finished.then(() => {
    el.hidden = true;
    a.cancel();
  }, () => {});
}

// ---------- Coach: bubbles pop in from their side, the typing dots arrive the same way ----------

function chatBox() { return $app.querySelector('#chat, .coach-sheet'); }
function chatCount() {
  const box = chatBox();
  if (!box) return null;
  return {
    key: box.id === 'chat' ? 'coach' : `sheet:${box.querySelector('.msg.user .msg-text')?.textContent || ''}`,
    n: box.querySelectorAll(':scope > .msg:not(.typing)').length,
    typing: Boolean(box.querySelector(':scope > .typing')),
  };
}

function chatAfter(snap, jobs) {
  chatGrew = false;
  const now = chatCount();
  if (!now) return;
  const box = chatBox();
  const msgs = [...box.querySelectorAll(':scope > .msg')];
  const was = snap.chat;
  const fresh = new Set();
  if (was && was.key === now.key) {
    msgs.filter((m) => !m.classList.contains('typing')).slice(was.n).forEach((m) => fresh.add(m));
    const typing = box.querySelector(':scope > .typing');
    if (typing && !was.typing) fresh.add(typing);
  }
  chatGrew = fresh.size > 0;
  jobs.push(() => {
    let i = 0;
    msgs.forEach((m, at) => {
      const key = `msg:${now.key}:${m.classList.contains('typing') ? 'typing' : at}`;
      m.style.transformOrigin = m.classList.contains('user') ? '100% 100%' : '0 100%';
      if (!fresh.has(m)) {
        replay(key, m);
        return;
      }
      if (reduced()) playKeyed(key, m, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      else {
        playKeyed(key, m, [{ opacity: 0, transform: 'translateY(14px) scale(0.9)' }, { opacity: 1, transform: 'none' }],
          { ...spring(0.74, 0.4), delay: i * 80, fill: 'backwards' });
      }
      i += 1;
    });
  });
}

// The chat ends at the composer: scroll there, smoothly when a message has just arrived.
export function chatToEnd() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: chatGrew && !reduced() ? 'smooth' : 'auto' });
}

// ---------- Swipe a habit or task row on Today: right for Done, left for Not now ----------

let swipe = null;
let swallowUntil = 0;

function swipeStart(e) {
  if (e.pointerType !== 'touch' || !cb.notNow) return;
  const row = e.target.closest?.('.page-today .group > button.li-habit, .page-today .group > button.li-task');
  if (!row || row.disabled) return;
  swipe = { row, pid: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, dx: 0, trail: [] };
}

function swipeBg(row) {
  const bg = document.createElement('div');
  bg.className = 'swipe-bg';
  bg.setAttribute('aria-hidden', 'true');
  bg.innerHTML = `<span class="sw-done">${icon('check')}Done</span><span class="sw-later">Not now${icon('clock')}</span>`;
  bg.style.top = `${row.offsetTop}px`;
  bg.style.height = `${row.offsetHeight}px`;
  row.parentElement.append(bg);
  return bg;
}

function swipeMove(e) {
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
    s.bg = swipeBg(s.row);
    s.row.classList.add('is-swiping');
    try { s.row.setPointerCapture(s.pid); } catch { /* the row went away */ }
  }
  let x = e.clientX - s.x0;
  const max = s.w * 0.42;
  if (Math.abs(x) > max) x = Math.sign(x) * (max + rubber(Math.abs(x) - max, s.w));
  s.dx = x;
  s.row.style.transform = `translate3d(${x}px, 0, 0)`;
  const side = x >= 0 ? 'done' : 'later';
  if (side !== s.side) {
    s.side = side;
    s.bg.dataset.side = side;
  }
  const armed = Math.abs(x) > s.w * 0.26;
  if (armed !== s.armed) {
    s.armed = armed;
    s.bg.classList.toggle('armed', armed);
    if (armed) haptic();
  }
  s.trail.push([performance.now(), x]);
  if (s.trail.length > 8) s.trail.shift();
}

function swipeEnd(cancelled) {
  const s = swipe;
  swipe = null;
  if (!s?.on) return;
  swallowUntil = performance.now() + 450;
  const v = speed(s.trail);
  const flick = Math.abs(v) > 0.5 && Math.sign(v) === Math.sign(s.dx) && Math.abs(s.dx) > 40;
  const commit = !cancelled && (s.armed || flick);
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

// ---------- Wiring ----------

function onPointerDown(e) {
  tap.x = e.clientX;
  tap.y = e.clientY;
  tap.at = performance.now();
  if (e.button !== 0 || drag || swipe) return;
  const t = e.target;
  const head = !WIDE.matches && t.closest?.('.sheet .sheet-grab, .sheet .sheet-head');
  if (head && !t.closest('button, a, input, select, textarea, label') && !t.closest('.sheet-ghost')) {
    grabSheet(head.closest('.sheet'), e.clientY);
    drag.pid = e.pointerId;
    return;
  }
  swipeStart(e);
}

function onPointerMove(e) {
  if (drag && drag.pid === e.pointerId) dragTo(e.clientY);
  else if (swipe && swipe.pid === e.pointerId) swipeMove(e);
}

function onPointerEnd(e) {
  if (drag && drag.pid === e.pointerId) letGo();
  else if (swipe && swipe.pid === e.pointerId) swipeEnd(e.type === 'pointercancel');
}

function onClickCapture(e) {
  // The click a finished swipe leaves behind is not a tap.
  if (e.isTrusted && performance.now() < swallowUntil) {
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  if (e.target.closest?.('.topbar-title')) window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
  // Heard, barely: moving between tabs and screens, and picking from a segmented control.
  if (e.target.closest?.('.tabbar .tab:not([aria-current="page"]), a.back, .topbar-back')) fx('nav');
  else if (e.target.closest?.('.seg button:not([aria-selected="true"]):not(.on):not([aria-pressed="true"])')) fx('toggle');
}

// A switch, a tick box, a day, a chip, a choice: each answers with a small click. data-fx="off" opts
// out, and the Sounds switch makes its own.
function onChange(e) {
  const input = e.target;
  if (input.matches?.('input[type="checkbox"], input[type="radio"]') && input.closest('#app') && !input.closest('[data-fx="off"]') && input.dataset.action !== 'sounds') fx('toggle');
}

// Someone is mid-gesture: background refreshes wait, so the thing under the finger stays put.
export const busy = () => Boolean(drag || swipe?.on || pull);
hooks.busy = busy;

export function initMotion(callbacks = {}) {
  cb = callbacks;
  // iOS only shows :active press states once a page listens for touches.
  document.addEventListener('touchstart', () => {}, { passive: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerEnd, { passive: true });
  window.addEventListener('pointercancel', onPointerEnd, { passive: true });
  document.addEventListener('change', onSegChange, true);
  document.addEventListener('change', onChange);
  document.addEventListener('click', onClickCapture, true);
  initPull();
}
