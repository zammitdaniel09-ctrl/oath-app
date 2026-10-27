// The live barcode scanner: point the camera at a pack, it beeps, and the product is there. No photo
// leaves the phone and no AI is asked. The phone reads the bars itself: with the browser's own
// BarcodeDetector where it reads all four food formats, else with the bundled ZXing reader
// (WebAssembly, in /vendor/zxing; iOS Safari has no BarcodeDetector). A code counts only when its check
// digit is right and two reads in a row agree. Then the catalogue is asked (Open Food Facts behind it,
// cached there), so a product scanned before comes straight back.
//
// The scanner is a layer of its own outside #app, like the confirm sheet: a redraw underneath never
// takes the camera away. Every track stops on close, on a new screen and when the app is hidden.
import { $app, state, esc, api, icon, haptic, toast, reduced, fx } from './ui.js';
import { digits, lookupCode, barcodeVariants } from './barcode.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const ZX_FORMATS = { EAN13: 'ean_13', EAN8: 'ean_8', UPCA: 'upc_a', UPCE: 'upc_e' };
// Time between reads, counted from the start of the last one: quick enough to feel instant, light on the battery.
const EVERY = 160;
const SEEN = 'oath.scanSeen';

let hooks = { found: () => {}, openSheet: () => {}, render: () => {} };
let cur = null;

// ---------- Readers ----------

// The browser's own reader, when it knows every food format.
async function nativeReader() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const have = await window.BarcodeDetector.getSupportedFormats();
    if (!FORMATS.every((f) => have.includes(f))) return null;
    const detector = new window.BarcodeDetector({ formats: FORMATS });
    return async (canvas) => (await detector.detect(canvas)).map((b) => ({ text: b.rawValue, format: b.format }));
  } catch {
    return null;
  }
}

// ZXing, loaded on first use from the app's own copy. The module would fetch its .wasm from a CDN, so
// locateFile points it at the file next to it.
let zxing = null;
export function loadZxing() {
  zxing ||= import('./vendor/zxing/reader/index.js').then(async (zx) => {
    const wasm = new URL('./vendor/zxing/zxing_reader.wasm', import.meta.url).href;
    await zx.prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasm : prefix + path) }, fireImmediately: true });
    return zx;
  }).catch((err) => {
    zxing = null;
    throw err;
  });
  return zxing;
}

async function zxingReader() {
  const zx = await loadZxing();
  const opts = { formats: Object.keys(ZX_FORMATS), tryHarder: true, maxNumberOfSymbols: 1 };
  return async (canvas, g) => {
    const found = await zx.readBarcodes(g.getImageData(0, 0, canvas.width, canvas.height), opts);
    return found.filter((r) => r.isValid).map((r) => ({ text: r.text, format: ZX_FORMATS[r.format] || null }));
  };
}

const readerFor = async () => (await nativeReader()) || zxingReader();

// The frame on screen plus a margin, in the video's own pixels. The video fills the screen like a cover
// photo (scaled and centred), so the frame is mapped back through that. Reading only this band is
// quicker than the whole picture, and a pack at the edge of the view is not read by mistake.
function band(video, frame) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const v = video.getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  const s = Math.max(v.width / vw, v.height / vh);
  const ox = (v.width - vw * s) / 2;
  const oy = (v.height - vh * s) / 2;
  const m = fr.width * 0.1;
  const x0 = Math.max(0, (fr.left - v.left - m - ox) / s);
  const y0 = Math.max(0, (fr.top - v.top - m - oy) / s);
  const x1 = Math.min(vw, (fr.right - v.left + m - ox) / s);
  const y1 = Math.min(vh, (fr.bottom - v.top + m - oy) / s);
  if (!(x1 - x0 > 32 && y1 - y0 > 32)) return { x: 0, y: vh * 0.3, w: vw, h: vh * 0.4 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

async function readFrame(run) {
  const video = run.el.querySelector('video');
  if (video.readyState < 2 || !video.videoWidth) return [];
  const r = band(video, run.el.querySelector('.scan-frame'));
  const k = Math.min(1, 1024 / r.w);
  run.canvas ||= document.createElement('canvas');
  run.canvas.width = Math.round(r.w * k);
  run.canvas.height = Math.round(r.h * k);
  run.g ||= run.canvas.getContext('2d', { willReadFrequently: true });
  run.g.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, run.canvas.width, run.canvas.height);
  return run.read(run.canvas, run.g);
}

// ---------- Products scanned on this phone, for when it is offline ----------

const stored = (key) => {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || []; } catch { return []; }
};

function remember(code, item) {
  try {
    const list = stored(SEEN).filter((x) => x.code !== code);
    localStorage.setItem(SEEN, JSON.stringify([{ code, item }, ...list].slice(0, 30)));
  } catch { /* storage unavailable or full: the server's cache still has it */ }
}

function remembered(code) {
  const v = new Set(barcodeVariants(code));
  return stored(SEEN).find((x) => v.has(x.code))?.item
    || [...stored('oath.foodRecent'), ...stored('oath.foodDrinks')].find((x) => x?.barcode && v.has(x.barcode)) || null;
}

// ---------- The layer ----------

const PROBLEM = {
  denied: ['No camera access', 'Oath is not allowed to use the camera. Allow it in your settings, or snap a photo or type the number instead.'],
  none: ['No camera found', 'Snap a photo or type the number under the bars instead.'],
  busy: ['The camera is busy', 'Another app may be using it. Close that and try again, or type the number instead.', 'Try again'],
  unsupported: ['No live camera here', 'This browser cannot show the camera inside the app. Snap a photo or type the number instead.'],
  reader: ['The scanner could not load', 'It needs a connection the first time. Snap a photo or type the number instead.', 'Try again'],
  failed: ['The camera did not start', 'Try again, or snap a photo or type the number instead.', 'Try again'],
  paused: ['Camera paused', 'It stops while Oath is in the background.', 'Start the camera'],
};

function cameraProblem(err) {
  const n = err?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'none';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
  return 'failed';
}

function layerHtml() {
  return `<div class="scan-cam"><video class="scan-video" playsinline muted autoplay disablepictureinpicture></video></div>
    <div class="scan-top">
      <button type="button" class="scan-ic" data-scan="torch" aria-pressed="false" aria-label="Torch" hidden>${icon('torch')}</button>
      <h2 class="scan-title" id="scan-title">Scan a barcode</h2>
      <button type="button" class="scan-ic" data-scan="close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="scan-mid">
      <div class="scan-frame" aria-hidden="true"><i></i><i></i><i></i><i></i><b class="scan-line"></b></div>
      <div class="scan-off" hidden>${icon('camera', 'scan-off-ic')}<p class="scan-off-h"></p><p class="scan-off-t"></p>
        <div class="scan-off-acts"><button type="button" class="btn tinted" data-scan="start" hidden></button>
          <button type="button" class="btn primary" data-scan="photo">${icon('camera')}Snap a photo instead</button></div></div>
      <p class="scan-status" role="status" aria-live="polite"></p>
    </div>
    <form class="scan-type" novalidate>
      <label class="sr" for="scan-code">Type the number under the bars</label>
      <input id="scan-code" class="input" name="code" inputmode="numeric" autocomplete="off" enterkeyhint="search" maxlength="20" placeholder="Type the number" spellcheck="false">
      <button class="btn primary" type="submit">Find</button>
    </form>`;
}

function status(run, text, bad = false) {
  const el = run.el.querySelector('.scan-status');
  el.textContent = text;
  el.classList.toggle('is-bad', bad);
}

// The camera cannot help: say why plainly and offer the other ways in. The typed number stays.
function off(run, why) {
  if (run !== cur || run.looking) return;
  stopCamera(run);
  const [head, text, retry] = PROBLEM[why] || PROBLEM.failed;
  const box = run.el.querySelector('.scan-off');
  box.querySelector('.scan-off-h').textContent = head;
  box.querySelector('.scan-off-t').textContent = text;
  const again = box.querySelector('[data-scan="start"]');
  again.hidden = !retry;
  again.textContent = retry || '';
  box.hidden = false;
  run.el.classList.add('is-off');
  run.el.dataset.why = why;
  status(run, '');
}

function stopCamera(run) {
  clearTimeout(run.timer);
  run.stream?.getTracks().forEach((t) => t.stop());
  run.stream = null;
  run.track = null;
  run.torch = false;
  const video = run.el.querySelector('video');
  if (video) video.srcObject = null;
  run.el.classList.remove('is-live');
  const torch = run.el.querySelector('[data-scan="torch"]');
  torch.hidden = true;
  torch.setAttribute('aria-pressed', 'false');
}

// getUserMedia is called here, inside the tap that opened the scanner (or tapped Start): installed to the
// home screen, iOS only lets the camera start from a tap. The reader loads alongside it.
function start(run) {
  run.el.classList.remove('is-off', 'is-hit');
  run.el.querySelector('.scan-off').hidden = true;
  run.done = false;
  run.last = null;
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return off(run, 'unsupported');
  status(run, 'Starting the camera');
  run.reader ||= readerFor().catch(() => null);
  md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then((stream) => live(run, stream))
    .catch((err) => off(run, cameraProblem(err)));
  return null;
}

async function live(run, stream) {
  if (run !== cur || run.done) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  run.stream = stream;
  [run.track] = stream.getVideoTracks();
  const video = run.el.querySelector('video');
  video.srcObject = stream;
  try { await video.play(); } catch { /* a muted inline video plays on its own */ }
  if (run.stream !== stream) return;
  run.el.classList.add('is-live');
  if (run.track?.getCapabilities?.().torch) run.el.querySelector('[data-scan="torch"]').hidden = false;
  // The first time on a phone without BarcodeDetector, the reader may still be on its way.
  status(run, 'Getting the scanner ready');
  const read = await run.reader;
  if (run.stream !== stream) return;
  if (!read) {
    run.reader = null; // Try again loads it afresh
    off(run, 'reader');
    return;
  }
  run.read = read;
  status(run, 'Hold the barcode in the frame');
  tick(run, stream);
}

function tick(run, stream) {
  clearTimeout(run.timer);
  run.timer = setTimeout(async () => {
    if (run.stream !== stream || run.done) return;
    const t0 = performance.now();
    let codes = [];
    try { codes = await readFrame(run); } catch { /* a frame that cannot be read is skipped */ }
    if (run.stream !== stream || run.done) return;
    for (const c of codes) {
      const code = lookupCode(c.text, c.format);
      if (!code) continue;
      // Two reads in a row must agree, so one misread frame never opens the wrong product.
      if (run.last === code) return hit(run, code);
      run.last = code;
      break;
    }
    run.wait = Math.max(0, EVERY - (performance.now() - t0));
    tick(run, stream);
    return null;
  }, run.wait ?? EVERY);
}

function hit(run, code) {
  run.done = true;
  haptic('success');
  stopCamera(run);
  run.el.classList.add('is-hit');
  status(run, `Looking up ${code}`);
  find(code, run);
}

// Looks a code up and moves on: the product's sheet, or the sheet that offers to add it. Offline, a
// product this phone has scanned or logged before still opens.
async function find(code, run) {
  if (run) run.looking = true;
  const from = run ? run.from : state.foodSheet?.from ?? null;
  let item = null;
  let miss = {};
  try {
    ({ item } = await api('GET', `/api/food/barcode/${encodeURIComponent(code)}`));
    if (item) remember(code, item);
  } catch (err) {
    if (err.status === 401) return closeScanner();
    item = err.status === 0 ? remembered(code) : null;
    if (!item) miss = err.status === 0 ? { offline: true } : { error: err.message };
  }
  if (run && run !== cur) return null; // closed while looking
  closeScanner();
  if (item) return hooks.found(item, from);
  state.foodSheet = { kind: 'scan-miss', code, from, pick: from?.pick || null, back: from?.pick ? from.back : null, ...miss };
  hooks.render();
  return null;
}

function typed(run, form) {
  if (run.looking) return null;
  const c = digits(form.code.value);
  if (c.length < 8 || c.length > 14) return status(run, 'A barcode has 8 to 14 digits.', true);
  const code = lookupCode(c);
  if (!code) return status(run, 'That number does not add up. Check it against the digits under the bars.', true);
  form.code.blur();
  run.done = true;
  stopCamera(run);
  status(run, `Looking up ${code}`);
  return find(code, run);
}

async function torch(run, btn) {
  const on = !run.torch;
  try {
    await run.track.applyConstraints({ advanced: [{ torch: on }] });
    run.torch = on;
    btn.setAttribute('aria-pressed', String(on));
  } catch {
    toast('The torch did not switch on.', true);
  }
}

function onKey(e) {
  if (!cur) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeScanner();
  } else if (e.key === 'Tab') {
    // Focus stays inside the scanner while it is open.
    const list = [...cur.el.querySelectorAll('button:not([hidden]), input')].filter((x) => x.offsetParent !== null);
    const at = list.indexOf(document.activeElement);
    e.preventDefault();
    list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
  }
}

function onLayerClick(e) {
  const run = cur;
  const b = e.target.closest('[data-scan]');
  if (!run || !b) return;
  const what = b.dataset.scan;
  if (what === 'close') closeScanner();
  else if (what === 'torch') torch(run, b);
  else if (what === 'start') start(run);
  else if (what === 'photo') {
    // The diary's own photo button, so the photo goes the usual way (a label, a packet or a plate).
    const input = $app.querySelector('input[data-food-photo]');
    closeScanner();
    if (input) input.click();
    else toast('Open Food to snap a photo.', true);
  }
}

export function openScanner() {
  if (cur) return;
  // "Scan again" from the not-found sheet goes back to wherever the first scan started.
  const sheet = state.foodSheet;
  const from = sheet?.kind === 'scan-miss' ? sheet.from : sheet || null;
  const el = document.createElement('div');
  el.className = 'scan';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'scan-title');
  el.innerHTML = layerHtml();
  const run = { el, from, before: document.activeElement, stream: null, track: null, timer: 0, last: null, done: false, torch: false, reader: null };
  cur = run;
  el.addEventListener('click', onLayerClick);
  el.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    typed(run, e.target);
  });
  document.activeElement?.blur?.();
  document.body.append(el);
  document.documentElement.classList.add('scan-open');
  $app.inert = true;
  document.addEventListener('keydown', onKey, true);
  start(run);
  if (sheet?.kind === 'scan-miss') {
    state.foodSheet = from;
    hooks.render();
  }
  fx('sheet-open');
  try {
    el.animate(reduced() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'scale(1.03)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  } catch { /* no Web Animations */ }
  el.querySelector('[data-scan="close"]').focus({ preventScroll: true });
}

export function closeScanner() {
  const run = cur;
  if (!run) return;
  cur = null;
  run.done = true;
  stopCamera(run);
  document.removeEventListener('keydown', onKey, true);
  $app.inert = false;
  document.documentElement.classList.remove('scan-open');
  const gone = () => run.el.remove();
  let a = null;
  try { a = run.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced() ? 120 : 180, easing: 'ease-out', fill: 'forwards' }); } catch { /* no Web Animations */ }
  if (a) a.finished.then(gone, gone);
  else gone();
  setTimeout(gone, 400);
  if (run.before?.isConnected) run.before.focus?.({ preventScroll: true });
}

// ---------- The sheet when nothing has the code ----------

export const scanMissTitle = (s) => (s.offline ? 'You are offline' : s.error ? 'Could not look it up' : 'Not in the food databases yet');

export function scanMissBody(s) {
  const code = `<span class="scan-code">${esc(s.code)}</span>`;
  const again = `<button class="btn plain" data-action="food-scan">${icon('barcode')}Scan again</button>`;
  if (s.offline) {
    return `<p class="note">Barcode ${code} cannot be looked up without a connection. Products you have scanned on this phone before still open offline.</p>
      <div class="sheet-actions"><button class="btn tinted" data-action="food-quick">${icon('bolt')}Quick add calories</button>${again}</div>`;
  }
  return `<p class="note">${s.error ? `Barcode ${code}: ${esc(s.error)}` : `Barcode ${code} is not in Oath or Open Food Facts. Add it once and it comes straight up the next time you scan it.`}</p>
    <div class="sheet-actions">
      ${s.error ? `<button class="btn primary" data-action="food-scan-find" data-code="${esc(s.code)}">${icon('sync')}Try again</button>` : ''}
      <label class="btn ${s.error ? 'tinted' : 'primary'}">${icon('camera')}Photo the label<input class="vh" type="file" accept="image/*" capture="environment" data-food-photo data-barcode="${esc(s.code)}"></label>
      <button class="btn tinted" data-action="food-scan-custom" data-code="${esc(s.code)}">${icon('plus')}Add it yourself</button>
      ${again}
    </div>`;
}

// food-scan opens the scanner (already open by now: the tap itself opened it), food-scan-custom starts a
// food of his own with the code filled in, food-scan-find asks again after a failed lookup.
export async function scanClick(a, el) {
  if (a === 'food-scan') {
    openScanner();
    return true;
  }
  if (a === 'food-scan-custom') {
    hooks.openSheet({ kind: 'custom', draft: { barcode: el.dataset.code } });
    return true;
  }
  if (a === 'food-scan-find') {
    el.disabled = true;
    el.lastChild.textContent = 'Looking it up';
    await find(el.dataset.code, null);
    return true;
  }
  return false;
}

export function initScan(h) {
  hooks = { ...hooks, ...h };
  // Opened in the capture phase of the tap itself, before any await, so the camera may start.
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-action="food-scan"]');
    if (b && !b.disabled) openScanner();
  }, true);
  window.addEventListener('hashchange', closeScanner);
  window.addEventListener('pagehide', closeScanner);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && cur?.stream) off(cur, 'paused');
  });
}
