// Staying on the newest version.
//
// An iPhone keeps the app open in memory for days and only resumes it, and the service worker's handover
// never reaches that open copy. So the app checks the live version itself: on every server reply (each
// one names it), each time it comes back (before Face ID), every few minutes while open and when the
// network returns. When it is behind, it reloads at the next quiet moment. If a reload does not bring
// the new version, the second try first removes the service worker and its caches, which is what
// reinstalling the app does; if even that fails, a bar asks him to close and reopen the app. Tries are
// counted per version and forgotten after ten minutes, so one bad moment never blocks an update. Only a
// newer version is ever loaded, never an older one.
import { hooks, TEXT_FIELDS, canRedraw, state, bar, api } from './ui.js';
import { lockEl, setLock, resumeLock } from './lock.js';
import { recording } from './coach-media.js';

let ctx = { build: '' };
export function initUpdate(c) {
  ctx = { ...ctx, ...c };
}

const UPDATE_KEY = 'oath.update';
const buildNo = (b) => Number(/^oath-v(\d+)$/.exec(String(b || ''))?.[1] || 0);
let updating = false;

const readTries = () => {
  try { return JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null'); } catch { return null; }
};
const writeTries = (t) => {
  try {
    if (t) localStorage.setItem(UPDATE_KEY, JSON.stringify(t));
    else localStorage.removeItem(UPDATE_KEY);
  } catch { /* storage unavailable */ }
};

// A reply or a check named the live version.
function sawBuild(live) {
  if (!buildNo(live)) return;
  if (buildNo(live) <= buildNo(ctx.build)) {
    if (readTries()) writeTries(null);
    return;
  }
  updateTo(live);
}
hooks.onBuild = sawBuild;

function updateTo(live) {
  if (updating) return;
  let t = readTries();
  if (!t || t.build !== live || Date.now() - t.at > 10 * 60000) t = { build: live, n: 0, at: Date.now() };
  if (t.n >= 2) {
    updateBar();
    return;
  }
  t.n += 1;
  t.at = Date.now();
  writeTries(t);
  updating = true;
  const hard = t.n === 2;
  whenQuiet(() => (hard ? freshInstall() : location.reload()));
}

// Nothing he is doing is lost: not while he types, has a sheet open, records, waits on the coach or Face ID
// is asking. The lock screen, waiting for a tap, is the best moment of all.
function quietNow() {
  const typing = document.activeElement?.matches?.(TEXT_FIELDS);
  const lock = lockEl();
  // On the lock screen: not while Face ID is asking, nor while he types in the recovery form.
  if (lock) return ['idle', 'error', 'offline'].includes(lock.dataset.state) && !typing;
  // In the app: not with any sheet, a confirm or a half-filled form open, mid-swipe, while sending, recording
  // or typing (canRedraw covers the sheets, forms, fingers and focus).
  return canRedraw() && !state.sending && !recording() && !document.body.classList.contains('confirm-open')
    && !document.documentElement.classList.contains('kb-open') && !typing;
}
function whenQuiet(run) {
  const tick = () => (quietNow() ? run() : setTimeout(tick, 1000));
  tick();
}

// What reinstalling does: the service worker and every cache go, and the app loads from the server.
async function freshInstall() {
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister();
  } catch { /* none */ }
  try {
    for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* none */ }
  location.replace(`/?fresh=${Date.now()}${location.hash}`);
}

function updateBar() {
  if (document.querySelector('.update-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>A new version of Oath is ready. Close the app fully and open it again.</span><button type="button" class="btn chrome small">Try again</button>';
  bar.querySelector('button').addEventListener('click', () => {
    writeTries(null);
    freshInstall();
  });
  document.body.append(bar);
}

// Asks the server which version is live. Resolves to it, or null without a connection.
export async function checkBuild() {
  try {
    const res = await fetch('/version', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    const { build } = await res.json();
    sawBuild(build);
    return build;
  } catch {
    return null;
  }
}

// Back to the lock screen: a newer version loads first and asks for Face ID itself, so a prompt is never
// cut off; otherwise Face ID starts as before.
export async function resumeFresh() {
  if (lockEl()) setLock('idle');
  await checkBuild();
  if (!updating) resumeLock();
}

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  checkBuild();
  // With Face ID only, the server locks a session left alone for 15 minutes. Only Today asks it anything
  // while he reads, so a long read on Food or a long review form would end in a lock and a lost save; while
  // the app is open on screen, it says it is still here. A screen that is off asks nothing and locks as before.
  if (!lockEl() && !document.querySelector('.gate')) api('GET', '/api/session').catch(() => {});
}, 5 * 60000);
window.addEventListener('online', () => checkBuild());

export function watchForUpdates() {
  // After a fresh install the address carries ?fresh=; it comes off.
  if (location.search.includes('fresh=')) history.replaceState(null, '', `/${location.hash}`);
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => checkBuild());
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
