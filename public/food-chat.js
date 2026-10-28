// The food chat: "What did you eat?" as a conversation. Type a meal the way you would say it, or snap a
// plate, a label or a barcode, and the answer is a card: each food matched to a record with its amount,
// the meal to log it to, and Log. While a card is open the next message changes it ("make it three
// eggs", "no toast"), and the card that comes back is the whole meal as it now stands. Nothing is logged
// until Log. The thread is kept on this phone; anything logged from a sheet while here is said in it too.
import { state, esc, api, toast, icon, haptic, num, fmtDay, localToday, reportProblem } from './ui.js';
import { show, amountText, total, refOf } from './nutrition.js';
import { chatToEnd } from './motion.js';

// What food.js lends this module (see initChat there).
let D = null;
export function initChat(deps) {
  D = deps;
}

const KEY = 'oath.foodChat';
const KEEP = 80; // messages kept on the phone
const PHOTOS = 12; // the newest photos keep their thumbnails
const EXAMPLES = ['Two eggs on toast and a flat white', 'A pastizz and a Kinnie', 'Chicken Caesar wrap and a Coke Zero', 'Large fries from Burger King'];

const inChat = () => state.route === 'food' && state.param === 'chat';
const fmt = (v) => D.fmtN(v);

function chat() {
  const F = D.f();
  // staged: a photo waiting in the composer for an optional note, kept only while the app is open.
  if (!F.chat) F.chat = { msgs: D.store.get(KEY, null)?.msgs || [], busy: null, image: null, note: '', staged: null };
  return F.chat;
}

// A card that is no longer open is kept as what it shows; only the newest photos keep a thumbnail.
function save() {
  const c = chat();
  c.msgs = c.msgs.slice(-KEEP);
  let photos = 0;
  for (let i = c.msgs.length - 1; i >= 0; i -= 1) {
    const m = c.msgs[i];
    if (m.thumb && (photos += 1) > PHOTOS) m.thumb = null;
    if (m.kind === 'card' && m.state !== 'open') m.items = [];
  }
  D.store.set(KEY, { msgs: c.msgs.map(({ fresh, ...m }) => m) });
}

function push(m) {
  // A new card or log plays its entrance once, on the draw after it lands.
  const msg = { id: D.uuid(), at: new Date().toISOString(), ...m, fresh: true };
  chat().msgs.push(msg);
  save();
  return msg;
}

const find = (id) => chat().msgs.find((m) => m.id === id) || null;
const lastFood = () => [...chat().msgs].reverse().find((m) => m.role === 'food') || null;
const openCard = () => {
  const m = lastFood();
  return m?.kind === 'card' && m.state === 'open' ? m : null;
};

// For the diary's bar: a meal still waiting in the chat.
export function chatWaiting() {
  const m = D ? openCard() : null;
  if (!m) return '';
  const n = m.items.length;
  return n ? `${n} ${n === 1 ? 'food' : 'foods'} waiting to log` : '';
}

// ---------- Today, for the header and after each log ----------

export async function loadChatDay() {
  const F = D.f();
  try {
    F.chatDay = await api('GET', '/api/food/day');
  } catch (err) {
    if (err.status !== 0) throw err;
    const c = D.store.get('oath.foodDay', null);
    if (c?.date === localToday()) F.chatDay = c;
  }
}

// Where the day stands, kept on a "logged" message so an old one still says what it said then.
function daySnap() {
  const d = D.f().chatDay;
  if (!d?.total) return null;
  const { parts } = D.macroParts(d.total);
  return { kcal: num(d.total.kcal), floor: Boolean(d.total.missing?.kcal), need: refOf('kcal', d.needs || null), own: Boolean(d.needs), parts: parts.map((p) => ({ key: p.key, kcal: p.kcal })) };
}

// ---------- Reading ----------

function setBusy(kind) {
  chat().busy = kind;
  render();
}

const itemName = (it) => it.match?.name || D.cap(it.name);
const itemAmount = (it) => (it.match && Number(it.qty) > 0 ? amountText(it.qty, it.unit, it.match) : D.roughAmount(it.guess));

// A typed message: with a card open it changes that card; after a question it answers it.
async function send(text) {
  const c = chat();
  if (c.busy) return;
  const prev = lastFood();
  const open = openCard();
  const asked = prev?.kind === 'say' && prev.ask ? prev : null;
  const before = open ? { said: open.said || '', items: open.items.map((it) => ({ name: itemName(it), amount: itemAmount(it) })) }
    : asked ? { said: asked.said || '', question: asked.text } : null;
  D.f().text = '';
  push({ role: 'me', kind: 'text', text });
  haptic('send');
  await readText(text, before, open);
}

async function readText(text, before, open) {
  setBusy('text');
  const said = before?.said ? `${before.said}. ${text}` : text;
  try {
    const r = await api('POST', '/api/food/describe', { text, ...(before ? { before } : {}) });
    if (r.kind === 'meal') {
      const still = open && find(open.id);
      if (still) still.state = 'replaced';
      push({ role: 'food', kind: 'card', state: 'open', reply: r.reply || null, title: r.summary || null, items: D.photoItemsFrom(r), said, slot: open?.slot || null });
    } else {
      push({ role: 'food', kind: 'say', ask: true, text: r.question || 'What did you have?', said });
    }
  } catch (err) {
    push({ role: 'food', kind: 'say', tone: 'bad', text: err.status === 0 ? 'Working out a meal needs a connection. Quick add works offline.' : err.message, retry: { text, before } });
  }
  chat().busy = null;
  haptic('receive');
  render();
}

// A photo waits in the composer first, so a note can go with it ("about 100 g of rice", "no sauce");
// Send reads them together. With no note it is read on its own.
export async function chatPhoto(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!inChat()) openChat();
  let image;
  let thumb;
  try {
    [image, thumb] = await Promise.all([D.shrink(file), D.shrink(file, 480, 0.72)]);
  } catch (err) {
    toast(err.message || 'That photo could not be opened.', true);
    return;
  }
  chat().staged = { image, thumb: `data:image/jpeg;base64,${thumb}` };
  haptic('toggle');
  render();
}

async function sendPhoto(note) {
  const c = chat();
  const { image, thumb } = c.staged;
  c.staged = null;
  D.f().text = '';
  push({ role: 'me', kind: 'photo', thumb, text: note || null });
  haptic('send');
  await readPhoto(image, note);
}

async function readPhoto(image, note = '') {
  const c = chat();
  setBusy('photo');
  try {
    const r = await api('POST', '/api/food/photo', { image, media_type: 'image/jpeg', ...(note ? { note } : {}) });
    c.image = null;
    answerPhoto(r);
  } catch (err) {
    // Kept for Try again while the app is open, never on the phone.
    c.image = image;
    c.note = note;
    push({ role: 'food', kind: 'say', tone: 'bad', text: err.status === 0 ? 'Reading photos needs a connection.' : err.message, retry: { photo: true } });
  }
  c.busy = null;
  haptic('receive');
  render();
}

const productItem = (item) => {
  const d = D.defaults(item);
  return { name: item.name, match: item, qty: d.qty, unit: d.unit, edited: true, logId: D.uuid() };
};

function answerPhoto(r) {
  const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  if (r.kind === 'label') {
    const name = [r.draft?.brand, r.draft?.name].filter(Boolean).join(' ');
    push({ role: 'food', kind: 'say', text: `That is a nutrition label${name ? ` for ${name}` : ''}. Check the values, then save it as a food you can log.`, draft: r.draft, act: 'label' });
  } else if (r.kind === 'product') {
    push({ role: 'food', kind: 'card', state: 'open', reply: `${r.byName ? 'Found it, Boss' : 'Found it from the barcode, Boss'}: ${r.item.name}${r.item.brand ? `, ${r.item.brand}` : ''}.`, title: r.item.name, items: [productItem(r.item)], said: r.item.name });
  } else if (r.kind === 'product-unknown') {
    const name = [r.read?.brand, r.read?.name, r.read?.variant].filter(Boolean).join(' ');
    const why = r.barcode ? `Barcode ${r.barcode} is not in Oath or Open Food Facts.` : r.unreadBarcode ? 'I could not read the barcode.' : 'I could not see a barcode.';
    push({ role: 'food', kind: 'say', text: `${why}${name ? ` It looks like ${name}.` : ''} ${r.suggestions?.length ? 'Is it one of these?' : 'A photo of the nutrition label would let me add it.'}`, picks: r.suggestions || [], barcode: r.barcode || '', act: 'label-photo' });
  } else if (r.kind === 'meal' && r.items?.length) {
    push({ role: 'food', kind: 'card', state: 'open', reply: r.summary ? `Looks like ${lower(r.summary)}.` : null, title: r.summary || null, items: D.photoItemsFrom(r), said: r.summary || '' });
  } else {
    push({ role: 'food', kind: 'say', ask: true, text: r.question || 'What is it?', said: r.summary || '' });
  }
}

// ---------- Logging ----------

function cardTotal(m) {
  const rows = m.items.map(D.reviewNutrients).filter(Boolean);
  return rows.length ? total(rows) : null;
}

// Two or more foods on a card log as one meal unless he picks Separate foods.
const asMealOn = (m) => m.asMeal !== false && m.items.filter((it) => D.reviewItem(it).mode !== 'none').length > 1;

async function logCard(m) {
  const slot = m.slot || D.slotNow();
  const t = cardTotal(m);
  const rows = m.items.filter((it) => D.reviewItem(it).mode !== 'none').map((it) => {
    const kcal = num(D.reviewNutrients(it)?.kcal);
    return { name: itemName(it), amount: itemAmount(it), kcal: kcal === null ? null : Math.round(kcal) };
  });
  const asMeal = asMealOn(m);
  const name = String(m.mealName ?? m.title ?? '').trim() || 'Meal';
  m.mealLogId = m.mealLogId || D.uuid();
  save();
  setBusy('log');
  const { n, queued } = await D.logReviewed(m.items, slot, { asMeal, name, id: m.mealLogId });
  chat().busy = null;
  if (!n) {
    render();
    return;
  }
  haptic('log-food');
  m.state = 'logged';
  m.done = { rows, slot, meal: asMeal ? name : null };
  state.foodToday = null;
  await loadChatDay().catch(() => {});
  const word = D.SLOT[slot].toLowerCase();
  const est = m.items.some((it) => !it.edited) ? '~' : '';
  push({
    role: 'food', kind: 'logged', queued,
    text: asMeal ? `Logged ${name.replace(/^(A|An|The) /, (w) => w.toLowerCase())} as one meal (${rows.length} foods) to ${word}` : `${n === 1 ? `Logged ${rows[0]?.name || 'it'}` : `Logged ${n} foods`} to ${word}`,
    kcal: num(t?.kcal) === null ? null : `${est}${fmt(t.kcal)}${t.missing?.kcal ? '+' : ''}`,
    day: queued ? null : daySnap(),
  });
  render();
}

// Something logged from a sheet (the scanner, Search, Quick add, a label) while the chat is open.
export async function chatAfterLog({ name, nutrients = null, queued = false, duplicate = false }) {
  state.foodSheet = null;
  state.foodToday = null;
  await loadChatDay().catch(() => {});
  const k = num(nutrients?.kcal);
  push({
    role: 'food', kind: 'logged', queued,
    text: duplicate ? `${D.cap(name)} was already logged` : `Logged ${name}`,
    kcal: duplicate || k === null ? null : fmt(k),
    day: queued ? null : daySnap(),
  });
  render();
}

// A food he picked himself for a card's line: the estimate made for the old match no longer applies.
export function chatPicked(p, item, qty, unit) {
  const m = find(p.cid);
  state.foodSheet = null;
  if (m?.items[p.index]) Object.assign(m.items[p.index], { match: item, qty: Number(qty), unit, edited: true, fill: null, why: null, brand: null, size: null });
  else if (m?.kind === 'say') push({ role: 'food', kind: 'card', state: 'open', reply: `Going with ${item.name}.`, title: item.name, items: [{ ...productItem(item), qty: Number(qty), unit }], said: item.name });
  save();
  render();
}

// ---------- Drawing ----------

const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function dayWord(date) {
  const today = localToday();
  if (date === today) return 'Today';
  const y = new Date(`${today}T12:00:00`);
  y.setDate(y.getDate() - 1);
  if (date === dayOf(y.toISOString())) return 'Yesterday';
  return fmtDay(date, { weekday: 'long', day: 'numeric', month: 'short' });
}

function headHtml() {
  const d = D.f().chatDay;
  const t = d?.total;
  const need = d ? refOf('kcal', d.needs || null) : null;
  const sub = t ? `${show(t, 'kcal', { unit: false })} of ${fmt(need)} kcal today` : 'Type it or snap it';
  return `<header class="fc-head">
    <a class="icon-btn fc-back" href="#/food" aria-label="Back to Food">${icon('back')}</a>
    <span class="fc-av" aria-hidden="true">F</span>
    <div class="fc-head-text"><h1>Food</h1><p>${sub}</p></div>
    ${t ? D.energyRing(t, need, { size: 42, sw: 5, glow: false }) : ''}
  </header>`;
}

function helloHtml() {
  return `<div class="fc-hello"><span class="fc-av big" aria-hidden="true">F</span>
    <h2>What did you eat, Boss?</h2>
    <p>Say it the way you would tell a friend, or snap your plate, a label or a barcode. I find each food and its amount, and nothing is logged until you tap Log.</p>
    <div class="fc-examples" role="group" aria-label="Try">${EXAMPLES.map((x) => `<button type="button" class="fc-ex" data-action="food-chat-example" data-text="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>`;
}

function meHtml(m) {
  if (m.kind === 'photo') {
    return `<div class="msg user fc-photo">${m.thumb ? `<img src="${m.thumb}" alt="Your photo" loading="lazy">` : `<span class="fc-photo-gone">${icon('image')}Photo</span>`}
      ${m.text ? `<span class="msg-text fc-photo-note">${esc(m.text)}</span>` : ''}<time>${timeOf(m.at)}</time></div>`;
  }
  return `<div class="msg user"><span class="msg-text">${esc(m.text)}</span><time>${timeOf(m.at)}</time></div>`;
}

function sayHtml(m) {
  let extra = '';
  if (m.picks?.length) {
    extra += `<div class="fc-picks">${m.picks.slice(0, 5).map((it) => `<button type="button" class="fc-pick" data-action="food-chat-pick" data-cid="${m.id}" data-key="${esc(it.key)}">
      ${D.foodRing(it.nutrients, D.itemGrade(it))}<span><b>${esc(it.name)}</b>${it.brand ? `<small>${esc(it.brand)}</small>` : ''}</span>${icon('chevron', 'chev')}</button>`).join('')}</div>`;
  }
  const acts = [];
  if (m.retry) acts.push(`<button type="button" class="fc-act" data-action="food-chat-retry" data-cid="${m.id}">Try again</button>`);
  if (m.retry && !m.retry.photo) acts.push(`<button type="button" class="fc-act" data-action="food-quick">Quick add</button>`);
  if (m.act === 'label' && m.draft) acts.push(`<button type="button" class="fc-act on" data-action="food-chat-label" data-cid="${m.id}">Check the label</button>`);
  if (m.act === 'label-photo') {
    acts.push(`<label class="fc-act">Photo of the label<input class="vh" type="file" accept="image/*" capture="environment" data-food-photo${m.barcode ? ` data-barcode="${esc(m.barcode)}"` : ''}></label>`);
  }
  if (m.ask && !m.retry) acts.push(`<button type="button" class="fc-act" data-action="food-search">Search instead</button>`);
  // When it could not read something or something broke: report it in one tap.
  if (m.tone === 'bad' || m.ask || m.act === 'label-photo') acts.push(`<button type="button" class="fc-act" data-action="food-chat-report" data-cid="${m.id}">Report a problem</button>`);
  return `<div class="msg assistant fc-say${m.tone === 'bad' ? ' bad' : ''}"><span class="msg-text">${esc(m.text)}</span>${extra}${acts.length ? `<div class="fc-acts">${acts.join('')}</div>` : ''}</div>`;
}

function itemHtml(m, it, i) {
  const r = D.reviewItem(it);
  const name = itemName(it);
  const brand = it.brand ?? it.match?.brand ?? null;
  const sub = [r.mode === 'own' ? 'Your values' : '', it.match ? (brand ? esc(brand) : '') : r.mode === 'rough' ? `${esc(D.roughAmount(it.guess))}, estimated` : r.mode === 'own' ? '' : 'No match in the catalogue'].filter(Boolean).join(' · ');
  const n = D.reviewNutrients(it);
  const field = (k) => `data-chat-cid="${m.id}" data-chat-index="${i}" data-chat-field="${k}"`;
  return `<li class="fc-item${r.mode === 'none' ? ' none' : ''}" style="--i:${i}">
    ${D.foodRing(n, D.itemGrade(it.match))}
    <div class="fc-item-body"><p class="fc-item-name">${esc(name)}</p>
      <p class="fc-item-sub">${sub}${sub ? '<span aria-hidden="true"> · </span>' : ''}<button type="button" class="linkish" data-action="food-chat-change" data-cid="${m.id}" data-index="${i}">Change</button>${r.mode !== 'none' ? `<span aria-hidden="true"> · </span><button type="button" class="linkish" data-action="food-chat-own" data-cid="${m.id}" data-index="${i}" aria-expanded="${Boolean(it.ownOpen)}">Macros</button>` : ''}</p></div>
    <div class="fc-item-side"><b class="fc-kcal" data-chat-kcal="${m.id}:${i}">${D.reviewKcal(it)}</b>
      <button type="button" class="fc-x" data-action="food-chat-drop" data-cid="${m.id}" data-index="${i}" aria-label="Remove ${esc(name)}">${icon('close')}</button></div>
    ${it.match ? `<div class="fc-amount"><input class="input" inputmode="decimal" value="${esc(it.qty ?? '')}" placeholder="amount" data-chat-cid="${m.id}" data-chat-index="${i}" data-chat-field="qty" aria-label="Amount of ${esc(name)}">
      <select class="input" data-chat-cid="${m.id}" data-chat-index="${i}" data-chat-field="unit" aria-label="Unit for ${esc(name)}">${D.unitOptions(it.match, it.unit)}</select></div>` : ''}
    ${it.ownOpen && r.mode !== 'none' ? D.ownEditor(it, field, `data-action="food-chat-own-reset" data-cid="${m.id}" data-index="${i}"`) : ''}
  </li>`;
}

function totalHtml(m) {
  const t = cardTotal(m);
  if (!t || num(t.kcal) === null) return '';
  const { parts, sum } = D.macroParts(t);
  const bar = sum > 0 ? parts.filter((p) => p.kcal > 0).map((p) => `<i class="m-${p.key}" style="flex-grow:${p.kcal.toFixed(1)}"></i>`).join('') : '';
  const g = (k) => (num(t[k]) === null ? '–' : `${fmt(t[k])}${t.missing?.[k] ? '+' : ''}`);
  const est = m.items.some((it) => !it.edited) ? '<i class="est">~</i>' : '';
  return `<div class="fc-total" data-chat-total="${m.id}"><div class="fc-total-top"><span>Total</span><b>${est}${fmt(t.kcal)}${t.missing?.kcal ? '+' : ''}<small> kcal</small></b></div>
    ${bar ? `<div class="fc-mbar" aria-hidden="true">${bar}</div>` : ''}
    <p class="fc-macros"><span class="m-protein"><i class="fdot m-protein"></i>Protein <b>${g('protein')} g</b></span><span class="m-carbs"><i class="fdot m-carbs"></i>Carbs <b>${g('carbs')} g</b></span><span class="m-fat"><i class="fdot m-fat"></i>Fat <b>${g('fat')} g</b></span></p></div>`;
}

function cardHtml(m) {
  const head = m.reply || m.title ? `<p class="fc-reply">${esc(m.reply || m.title)}</p>` : '';
  if (m.state === 'replaced') return `<div class="msg assistant fc-card old">${head}<p class="fc-note">Changed below</p></div>`;
  if (m.state === 'logged') {
    const d = m.done || { rows: [] };
    return `<div class="msg assistant fc-card done">${head}<ul class="fc-done">${d.rows.map((x) => `<li><span>${esc(x.name)}<small>${esc(x.amount || '')}</small></span><b>${x.kcal ?? ''}</b></li>`).join('')}</ul></div>`;
  }
  const busy = chat().busy;
  const n = m.items.filter((it) => D.reviewItem(it).mode !== 'none').length;
  const slot = m.slot || D.slotNow();
  const asMeal = asMealOn(m);
  const label = asMeal ? (n === m.items.length ? 'Log as one meal' : `Log ${n} of ${m.items.length} as one meal`) : n === m.items.length ? (n === 1 ? 'Log it' : `Log all ${n}`) : `Log ${n} of ${m.items.length}`;
  return `<div class="msg assistant fc-card${m.fresh ? ' fresh' : ''}" data-cid="${m.id}">${head}
    ${n > 1 ? D.asMealSeg(asMeal, (mode) => `data-action="food-chat-mode" data-cid="${m.id}" data-mode="${mode}"`) : ''}
    ${asMeal ? `<label class="fc-meal-name"><span>Meal name</span><input class="input" value="${esc(m.mealName ?? m.title ?? '')}" maxlength="120" autocomplete="off" placeholder="Meal" data-chat-cid="${m.id}" data-chat-meal></label>` : ''}
    <ul class="fc-items">${m.items.map((it, i) => itemHtml(m, it, i)).join('') || '<li class="fc-empty">Nothing left on this card.</li>'}</ul>
    ${totalHtml(m)}
    <div class="fc-slots" role="radiogroup" aria-label="Log to">${D.SLOTS.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === slot}" class="fc-slot${v === slot ? ' on' : ''}" data-action="food-chat-slot" data-cid="${m.id}" data-slot="${v}">${l}</button>`).join('')}</div>
    <button type="button" class="fc-log" data-action="food-chat-log" data-cid="${m.id}"${n && !busy ? '' : ' disabled'}><span>${label}</span></button>
  </div>`;
}

function loggedHtml(m) {
  const d = m.day;
  let bar = '';
  if (d?.need && d.kcal !== null) {
    const fill = Math.min(1, d.kcal / d.need);
    const sum = d.parts.reduce((a, p) => a + p.kcal, 0);
    const segs = sum > 0 ? d.parts.filter((p) => p.kcal > 0).map((p) => `<i class="m-${p.key}" style="flex-grow:${p.kcal.toFixed(1)}"></i>`).join('') : '';
    const left = d.need - d.kcal;
    bar = `<div class="fc-day"><div class="fc-day-bar" aria-hidden="true"><span style="width:${(fill * 100).toFixed(1)}%">${segs}</span></div>
      <p><span>Today <b>${fmt(d.kcal)}${d.floor ? '+' : ''}</b> of ${fmt(d.need)} kcal</span><span>${left >= 0 ? `<b>${fmt(left)}</b> left` : `<b class="over">${fmt(-left)}</b> over`}</span></p></div>`;
  }
  return `<div class="msg assistant fc-logged${m.fresh ? ' fresh' : ''}">
    <span class="fc-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M7.4 12.4l3 3 6.2-6.6"/></svg></span>
    <div class="fc-logged-body"><p class="fc-logged-t"><b>${esc(m.text)}</b>${m.kcal ? `<span>${esc(m.kcal)} kcal</span>` : ''}</p>
      ${m.queued ? '<p class="fc-note">Saved on this phone. It syncs when you are back online.</p>' : ''}${bar}</div></div>`;
}

function typingHtml(kind) {
  const word = kind === 'photo' ? 'Looking at your photo' : kind === 'log' ? 'Logging' : 'Working it out';
  return `<div class="msg assistant typing fc-typing" role="status"><i></i><i></i><i></i><span>${word}</span></div>`;
}

function threadHtml() {
  const c = chat();
  if (!c.msgs.length && !c.busy) return helloHtml();
  let day = '';
  const out = [`<button type="button" class="fc-clear" data-action="food-chat-clear">Clear this chat</button>`];
  for (const m of c.msgs) {
    const d = dayOf(m.at);
    if (d !== day) {
      day = d;
      out.push(`<p class="fc-daysep"><span>${esc(dayWord(d))}</span></p>`);
    }
    if (m.role === 'me') out.push(meHtml(m));
    else if (m.kind === 'card') out.push(cardHtml(m));
    else if (m.kind === 'logged') out.push(loggedHtml(m));
    else out.push(sayHtml(m));
  }
  if (c.busy) out.push(typingHtml(c.busy));
  return out.join('');
}

function composerHtml() {
  const c = chat();
  const open = openCard();
  const staged = c.staged ? `<div class="fc-staged"><span class="fc-staged-img"><img src="${c.staged.thumb}" alt="Photo to send">
      <button type="button" class="fc-staged-x" data-action="food-chat-unstage" aria-label="Remove the photo">${icon('close')}</button></span>
      <span class="fc-staged-words"><b>Add a note to help</b><small>Optional: what it is, how much ("about 100 g of rice"), anything hidden. Or just send.</small></span></div>` : '';
  const hint = c.staged ? 'About 100 g, cooked in olive oil…' : open ? 'Change it, or add to it' : 'What did you eat?';
  return `<div class="composer-dock fc-dock${c.staged ? ' staging' : ''}">
    ${staged}
    <div class="quick-replies fc-tools" role="group" aria-label="More ways to log">
      <button type="button" class="qchip" data-action="food-scan">Scan</button>
      <label class="qchip">From photos<input class="vh" type="file" accept="image/*" data-chat-photo></label>
      <button type="button" class="qchip" data-action="food-search">Search</button>
      <button type="button" class="qchip" data-action="food-quick">Quick add</button>
    </div>
    <form class="composer fc-composer" data-form="food-chat-send">
      <label class="fc-cam" title="Snap your food">${icon('camera')}<span class="sr">Snap your food</span><input class="vh" type="file" accept="image/*" capture="environment" data-chat-photo></label>
      <label class="sr" for="fchat-text">What did you eat?</label>
      <textarea id="fchat-text" class="input" name="text" rows="1" maxlength="600" placeholder="${hint}" data-food-text enterkeyhint="send" autocomplete="off">${esc(D.f().text || '')}</textarea>
      <button class="btn send fc-send" type="submit" aria-label="Send"${c.busy ? ' disabled' : ''}>${icon('send')}</button>
    </form>
  </div>`;
}

export function viewChat() {
  // A redraw while he is typing keeps the keyboard up.
  const typing = document.activeElement?.id === 'fchat-text';
  D.shell(`<div class="fchat-page">${headHtml()}<div class="chat fchat" id="chat" data-chat="food">${threadHtml()}</div>${composerHtml()}</div>${D.sheetHtml()}`);
  const box = document.getElementById('fchat-text');
  if (typing && box && !state.foodSheet) {
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  }
  D.sizeText(box);
  chatToEnd();
  for (const m of chat().msgs) m.fresh = false;
}

function render() {
  if (inChat()) D.render();
}

function patchHead() {
  const el = document.querySelector('.fc-head');
  if (inChat() && el) el.outerHTML = headHtml();
}

// The chat opens in place from the diary, drawn at once so a tap on the bar can bring the keyboard up.
export function openChat({ focus = false } = {}) {
  if (!inChat()) {
    history.pushState(null, '', '#/food/chat');
    state.param = 'chat';
    state.param2 = null;
    state.query = new URLSearchParams();
    state.foodSheet = null;
    // Today's numbers are asked for every time the chat opens (the diary may have changed since); they
    // land in the header in place, so the keyboard stays up.
    loadChatDay().then(patchHead).catch(() => {});
  }
  D.render();
  if (focus) document.getElementById('fchat-text')?.focus({ preventScroll: true });
  chatToEnd();
}

// ---------- Taps, typing and sending ----------

export async function chatClick(a, el) {
  const m = el.dataset.cid ? find(el.dataset.cid) : null;
  switch (a) {
    case 'food-chat-open':
      openChat({ focus: true });
      return true;
    case 'food-chat-example': {
      D.f().text = el.dataset.text;
      render();
      const box = document.getElementById('fchat-text');
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
      return true;
    }
    case 'food-chat-report': {
      // The message it was about and the few before it go with the report (text only, no photos).
      const msgs = chat().msgs;
      const at = m ? msgs.indexOf(m) : msgs.length - 1;
      const thread = msgs.slice(Math.max(0, at - 5), at + 1).map((x) => ({ role: x.role, kind: x.kind || '', text: String(x.text || x.reply || x.title || x.said || '').slice(0, 400), photo: Boolean(x.image || x.thumb) }));
      await reportProblem('food-chat', { message: m?.text || '', thread });
      return true;
    }
    case 'food-chat-slot':
      if (m) {
        m.slot = el.dataset.slot;
        save();
        el.closest('.fc-slots')?.querySelectorAll('.fc-slot').forEach((b) => {
          const on = b === el;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
        });
        haptic('toggle');
      }
      return true;
    case 'food-chat-log':
      if (m?.state === 'open' && !chat().busy) await logCard(m);
      return true;
    case 'food-chat-mode':
      if (m) {
        m.asMeal = el.dataset.mode === 'meal';
        save();
        haptic('toggle');
        render();
      }
      return true;
    case 'food-chat-own':
    case 'food-chat-own-reset': {
      const it = m?.items?.[Number(el.dataset.index)];
      if (!it) return true;
      if (a === 'food-chat-own') it.ownOpen = !it.ownOpen;
      else delete it.own;
      save();
      render();
      return true;
    }
    case 'food-chat-drop':
      if (m?.items) {
        m.items.splice(Number(el.dataset.index), 1);
        save();
        render();
      }
      return true;
    case 'food-chat-change': {
      const it = m?.items?.[Number(el.dataset.index)];
      if (!it) return true;
      const alts = (it.alternatives || []).filter((x) => x?.key);
      D.openSheet({ kind: 'search', q: it.search || '', results: alts.length ? alts : null, pick: { purpose: 'chat', cid: m.id, index: Number(el.dataset.index) } });
      if (it.search && !alts.length) await D.runSearch(it.search, true);
      return true;
    }
    case 'food-chat-pick': {
      const item = m?.picks?.find((x) => x.key === el.dataset.key);
      if (!item) return true;
      push({ role: 'food', kind: 'card', state: 'open', reply: `Going with ${item.name}.`, title: item.name, items: [productItem(item)], said: item.name });
      render();
      return true;
    }
    case 'food-chat-label':
      if (m?.draft) D.openSheet({ kind: 'custom', draft: m.draft, fromLabel: true });
      return true;
    case 'food-chat-unstage':
      chat().staged = null;
      render();
      return true;
    case 'food-chat-retry': {
      if (!m?.retry || chat().busy) return true;
      const { retry } = m;
      chat().msgs = chat().msgs.filter((x) => x !== m);
      save();
      if (retry.photo) {
        if (chat().image) await readPhoto(chat().image, chat().note);
        else toast('Take the photo again.', true);
      } else {
        await readText(retry.text, retry.before, openCard());
      }
      return true;
    }
    case 'food-chat-clear':
      chat().msgs = [];
      save();
      render();
      return true;
    default:
      return false;
  }
}

export async function chatSubmit(form) {
  const text = String(form.text.value || '').replace(/\s+/g, ' ').trim();
  if (chat().busy) return true;
  if (chat().staged) {
    await sendPhoto(text.slice(0, 300));
    return true;
  }
  if (!text) return true;
  await send(text);
  return true;
}

// An amount or unit changed on a card: its line and the total redraw in place.
export function chatInput(el) {
  const m = find(el.dataset.chatCid);
  const i = Number(el.dataset.chatIndex);
  if (m && el.matches('[data-chat-meal]')) {
    m.mealName = el.value;
    save();
    return;
  }
  const it = m?.items?.[i];
  if (!it) return;
  D.setReviewField(it, el.dataset.chatField, el.value);
  save();
  const out = document.querySelector(`[data-chat-kcal="${m.id}:${i}"]`);
  if (out) out.innerHTML = D.reviewKcal(it);
  const tot = document.querySelector(`[data-chat-total="${m.id}"]`);
  if (tot) tot.outerHTML = totalHtml(m) || '<div hidden></div>';
}
