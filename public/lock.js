// The way in: the setup and login forms and the lock screen that asks for Face ID by itself.
import { state, closeConfirm, $app, icon, esc, api, reduced, hooks, form2obj, toast } from './ui.js';
import { deviceName, fresh, getOptions, credentialJSON } from './passkeys.js';
import { appIcon } from './app-icon.js';
import { leaveChat } from './coach-media.js';
import { resyncPush } from './push.js';
import { flushFood } from './food.js';

let ctx = { showCachedDay: () => {}, parseHash: () => {}, load: () => {}, go: () => {}, render: () => {} };
export function initLock(c) {
  ctx = { ...ctx, ...c };
}

// The face of Oath: the app icon charging, the wordmark and the promise, centred.
export function brandLockup(size = 76) {
  return `<div class="brand-lockup">${appIcon(Math.round(size * 1.45), 'gate-mark')}<div class="wordmark">Oath</div><p class="tagline">Keep your word.</p></div>`;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- The lock screen ----------
//
// With Face ID only, Oath opens on a lock screen that asks for Face ID by itself, on launch and each
// time the app comes back from the background. What the platform allows, from WebKit's own source
// (AuthenticatorCoordinator.cpp): navigator.credentials.get() needs no tap, but a page that is not
// focused is refused at once with NotAllowedError, and a newer request cancels the one before it.
// iOS 16 to 17.3 gave each page load one free prompt; 17.4 and later dropped the tap rule altogether.
// So the app waits for focus, asks once per cycle, runs one prompt at a time, and never retries on
// its own after a refusal or a cancel: the next try is a tap anywhere, or the next return from the
// background. States, set on .lock[data-state]: scanning (waiting for Face ID), idle (refused or
// cancelled, button and tap-anywhere offered), unlocking (verified, fading into the app), error and
// offline. The layout is the same in every state, so nothing moves between them.
export const door = { busy: false, ctl: null, started: 0, cycle: 0, disarm: null, preparing: null, refresh: 0, locking: null };

export const lockEl = () => document.querySelector('.gate.lock');

function scanText() {
  const d = deviceName();
  return d === 'iPhone' || d === 'iPad' ? `Look at your ${d}.` : 'Confirm it is you.';
}

const LOCK_TEXT = {
  scanning: scanText,
  idle: () => 'Tap to unlock.',
  unlocking: () => 'Unlocked.',
  offline: () => 'No connection. Oath needs one to check Face ID.',
  error: () => 'Face ID did not go through. Tap to try again.',
};

export function setLock(phase, text) {
  clearTimeout(door.refresh);
  // A tap may come minutes later: keep a fresh challenge ready so the tap goes straight to Face ID.
  if (phase === 'idle' || phase === 'error') door.refresh = setTimeout(() => prepareFaceIdLogin({ force: true }).catch(() => {}), 3 * 60000);
  const root = lockEl();
  if (!root) return;
  root.dataset.state = phase;
  const status = root.querySelector('.lock-status');
  if (status) status.textContent = text ?? LOCK_TEXT[phase]();
  const label = root.querySelector('.lock-btn-label');
  if (label) label.textContent = phase === 'offline' ? 'Try again' : 'Unlock with Face ID';
}

// What the app holds in memory about Daniel: gone behind the lock screen and after a log out.
export function forgetMemory() {
  Object.assign(state, {
    today: null, plan: null, review: null, coach: null, goals: null, goal: null, settings: null,
    food: null, foodToday: null, overview: null, dash: null, body: null, offline: null, stale: null,
    sheet: null, sheetNode: null, sheetMode: null, foodSheet: null, calSheet: null, cal: null, dodging: null, pardoning: null, editingGoal: false,
  });
}

export function showLock({ auto = true, offline = false } = {}) {
  if (lockEl()) return;
  closeConfirm();
  // A voice note being recorded stops with the lock (nothing is sent), and so does playback.
  leaveChat();
  abortFaceId();
  forgetMemory();
  document.body.classList.remove('sheet-open');
  window.scrollTo(0, 0);
  const phase = offline ? 'offline' : auto ? 'scanning' : 'idle';
  $app.classList.remove('enter');
  $app.innerHTML = `<div class="gate lock" data-state="${phase}">
    ${brandLockup(84)}
    <div class="lock-stage">
      <div class="lock-glyph" aria-hidden="true">${icon('faceid')}</div>
      <p class="lock-status" role="status" aria-live="polite">${esc(LOCK_TEXT[phase]())}</p>
      <div class="lock-action"><button class="btn chrome big wide" type="button" data-action="faceid-login">${icon('faceid')}<span class="lock-btn-label">${offline ? 'Try again' : 'Unlock with Face ID'}</span></button></div>
    </div>
    <details class="recover"><summary>Lost Face ID?</summary>
      <form data-form="login">
        <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
        <label class="field"><span>Recovery code (SETUP_CODE in Railway)</span><input class="input" name="recovery" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <div class="form-actions"><button class="btn primary big wide" type="submit">Open with password</button></div>
      </form>
      <p class="note bad" id="gate-error" role="alert" hidden></p></details>
  </div>`;
  const root = lockEl();
  // A tap anywhere on the lock screen starts Face ID, straight from the tap so iOS allows it.
  root.addEventListener('click', (e) => {
    if (e.target.closest('details, a, input, label')) return;
    e.stopPropagation();
    if (['idle', 'error', 'offline'].includes(root.dataset.state)) faceIdLogin();
  });
  if (phase === 'scanning') armAutoFaceId();
  else if (phase === 'idle') { prepareFaceIdLogin().catch(() => {}); setLock('idle'); }
}

// Locks the open app in place, with no reload and no flash of the day, and asks for Face ID.
export function lockApp(opts) {
  showLock(opts);
  // The server locks its own session too, so an app closed before unlocking leaves nothing open.
  door.locking = api('POST', '/api/lock', {}).catch(() => {});
}

// Starts Face ID by itself, once, as soon as the page can show it. delay: a beat for an aborted
// prompt to clear first, so two are never open together.
function armAutoFaceId({ delay = 0 } = {}) {
  const cycle = ++door.cycle;
  if (door.disarm) door.disarm();
  const start = () => {
    if (door.disarm) door.disarm();
    if (cycle === door.cycle && lockEl()) faceIdLogin({ auto: true });
  };
  if (document.visibilityState !== 'visible') return; // the visibility handler arms it on return
  prepareFaceIdLogin().catch(() => {});
  if (document.hasFocus()) {
    if (delay) setTimeout(start, delay); else start();
    return;
  }
  // WebKit refuses a prompt while the page is not focused, so wait for focus rather than burn the try.
  const timer = setTimeout(start, 2000);
  const onFocus = () => start();
  window.addEventListener('focus', onFocus);
  door.disarm = () => { clearTimeout(timer); window.removeEventListener('focus', onFocus); door.disarm = null; };
}

export function abortFaceId() {
  if (door.disarm) door.disarm();
  door.cycle += 1;
  if (door.ctl) door.ctl.abort();
  door.ctl = null;
  door.busy = false;
}

// The app is back in front with the lock screen up: ask again, unless a prompt has only just opened.
export function resumeLock() {
  const root = lockEl();
  if (!root || root.dataset.state === 'unlocking') return;
  if (door.busy && Date.now() - door.started < 3000) return;
  abortFaceId();
  setLock('scanning');
  armAutoFaceId({ delay: 150 });
}

// The server's challenge, fetched ahead so a tap goes straight to Face ID. Challenges last five minutes.
function prepareFaceIdLogin({ force = false } = {}) {
  if (!window.PublicKeyCredential) return Promise.reject(new Error('Face ID is not available.'));
  if (!force && fresh(state.faceIdLogin)) return Promise.resolve(state.faceIdLogin);
  if (!door.preparing) {
    door.preparing = api('POST', '/api/passkey/login/options', {})
      .then((options) => { state.faceIdLogin = { options, at: Date.now() }; return state.faceIdLogin; })
      .finally(() => { door.preparing = null; });
  }
  return door.preparing;
}

// One prompt at a time. auto: started by the app rather than by a tap. A refused or cancelled try
// leaves the button and the tap, and nothing else: no retry loop.
async function faceIdLogin({ auto = false } = {}) {
  if (door.busy) return;
  if (!window.PublicKeyCredential) {
    const msg = 'This browser cannot use Face ID. Open Oath from the Home Screen on your iPhone.';
    if (lockEl()) setLock('error', msg); else gateError(msg);
    return;
  }
  door.busy = true;
  door.started = Date.now();
  const ctl = new AbortController();
  door.ctl = ctl;
  const current = () => door.ctl === ctl;
  setLock('scanning');
  const slotBtn = document.querySelector('#faceid-slot button');
  if (slotBtn) slotBtn.disabled = true;
  let cred;
  try {
    const pre = fresh(state.faceIdLogin) ? state.faceIdLogin : await prepareFaceIdLogin();
    state.faceIdLogin = null;
    cred = await navigator.credentials.get({ publicKey: getOptions(pre.options), signal: ctl.signal });
    await door.locking;
    await api('POST', '/api/passkey/login', { response: credentialJSON(cred) });
  } catch (err) {
    if (!current() || err.name === 'AbortError') return;
    door.busy = false;
    door.ctl = null;
    if (slotBtn) slotBtn.disabled = false;
    // Offline behind the lock screen: the cached day, read only, as at a cold start.
    if (err.status === 0 && lockEl() && ctx.showCachedDay()) return;
    prepareFaceIdLogin({ force: true }).catch(() => {});
    const quick = Date.now() - door.started < 700;
    let phase = 'idle';
    let text = 'Face ID could not start. Tap to try again.';
    if (err.status === 0) { phase = 'offline'; text = LOCK_TEXT.offline(); }
    else if (err.status === 429) { phase = 'error'; text = err.message; }
    // A key the server no longer knows says so, instead of "try again" forever.
    else if (err.status === 401 && err.message) { phase = 'error'; text = err.message; }
    else if (err.status) { phase = 'error'; text = LOCK_TEXT.error(); }
    else if (err.name === 'NotAllowedError') text = auto && quick ? 'Tap to unlock.' : 'Face ID was cancelled. Tap to try again.';
    if (lockEl()) setLock(phase, text); else gateError(text);
    return;
  }
  door.busy = false;
  door.ctl = null;
  setLock('unlocking');
  await enterApp();
}

// Verified. The day loads behind the lock, the lock dissolves, and the app fades in.
async function enterApp(hash) {
  const calm = reduced();
  const gate = document.querySelector('.gate');
  if (hash && location.hash !== hash) history.replaceState(null, '', hash);
  else if (!location.hash) history.replaceState(null, '', '#/today');
  ctx.parseHash();
  state.dirty = true; // keeps the side loaders from swapping the screen before it is ready
  const loading = ctx.load(state.route).then(() => null, (err) => err);
  const [err] = await Promise.all([loading, calm ? null : pause(320)]);
  if (gate && !calm) {
    gate.classList.add('leaving');
    await pause(200);
  }
  if (err) await ctx.go(); else ctx.render();
  if (!calm) {
    $app.classList.add('enter');
    setTimeout(() => $app.classList.remove('enter'), 500);
  }
  resyncPush();
  flushFood();
}

// The way in. With Face ID only, it is the lock screen. Otherwise it is the password, with Face ID
// offered once a passkey exists. auto: false for a person who has just logged out on purpose.
export function renderLogin(session = null, { auto = true } = {}) {
  if (!session) {
    api('GET', '/api/session').then((s) => renderLogin(s, { auto })).catch((err) => {
      if (err.status === 0 && lockModeRemembered()) showLock({ offline: true });
      else renderLogin({}, { auto });
    });
    return;
  }
  rememberLockMode(session.faceIdOnly);
  if (session.faceIdOnly) {
    showLock({ auto });
    return;
  }
  abortFaceId();
  $app.innerHTML = `<div class="gate">
    ${brandLockup()}
    <p>Welcome back, <em class="serif">Daniel</em>. Log in to see today.</p>
    <div id="faceid-slot"></div>
    <form data-form="login">
      <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required autofocus></label>
      <div class="form-actions"><button class="btn primary big wide" type="submit">Log in</button></div>
      <p class="note bad" id="gate-error" role="alert" hidden></p>
    </form></div>`;
  if (session.faceId) offerFaceId();
}

// The password screen's Face ID button, once a challenge is ready.
async function offerFaceId() {
  try { await prepareFaceIdLogin(); } catch { return; }
  const slot = document.getElementById('faceid-slot');
  if (!slot || slot.querySelector('button')) return;
  slot.innerHTML = `<button class="btn chrome big wide" type="button" data-action="faceid-login">${icon('faceid')}Log in with Face ID</button>
    <p class="note">Or use your password.</p>`;
  slot.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); faceIdLogin(); });
}

// Remembered on the phone so a launch without signal does not show a cached day past the lock.
export function rememberLockMode(on) {
  state.faceIdOnly = Boolean(on);
  try { localStorage.setItem('oath.faceIdOnly', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
export function lockModeRemembered() {
  try { return localStorage.getItem('oath.faceIdOnly') === '1'; } catch { return false; }
}
// A stray 401 behind a gate that is already up must not rebuild it, or Face ID would start over.
hooks.onUnauthed = () => { if (!document.querySelector('.gate')) renderLogin(); };

export function renderSetup(code) {
  $app.innerHTML = `<div class="gate">
    ${brandLockup()}
    <p>Choose the password you will use to open Oath on your iPhone and iPad.</p>
    <form data-form="setup" data-code="${esc(code)}">
      <label class="field"><span>Password, at least 10 characters</span><input class="input" type="password" name="password" autocomplete="new-password" minlength="10" required autofocus></label>
      <label class="field"><span>Same password again</span><input class="input" type="password" name="again" autocomplete="new-password" minlength="10" required></label>
      <div class="form-actions"><button class="btn primary big wide" type="submit">Set password</button></div>
      <p class="note bad" id="gate-error" role="alert" hidden></p>
    </form></div>`;
}

function gateError(msg) {
  const el = document.getElementById('gate-error');
  if (el) { el.textContent = msg; el.hidden = false; }
}

export async function lockClick(a) {
  if (a === 'faceid-login') {
    await faceIdLogin();
  } else return false;
  return true;
}

export async function lockSubmit(kind, form) {
  if (kind === 'login') {
    try {
      await api('POST', '/api/login', form2obj(form));
      await enterApp('#/today');
    } catch (err) { gateError(err.message); }
  } else if (kind === 'setup') {
    const { password, again } = form2obj(form);
    if (password !== again) { gateError('The two passwords are different.'); return true; }
    try {
      await api('POST', '/api/setup', { code: form.dataset.code, password });
      history.replaceState(null, '', '/#/plan');
      toast('Password set. Add your first habit.');
      await ctx.go();
    } catch (err) { gateError(err.message); }
  } else return false;
  return true;
}
