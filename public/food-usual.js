// Faster logging on the diary: "Usually now" chips under the capture bar (one tap logs what he
// usually has at this time, at his usual amount), one-tap water, copy or add per meal, Repeat yesterday, and swipe an
// entry to remove it. Every log goes through the offline queue with an id made here, so a tap lands
// once, and each one can be undone.
import { $app, state, esc, api, act, toast, icon, haptic, localToday, num, fmtDay, addDays, cap } from './ui.js';
import { norm, line, round } from './nutrition.js';
import * as N from './nutrition.js';

// What food.js lends this module: its state, queue, sheets and pickers (see initUsual there).
let D = null;
const F = () => D.f();
const CACHE = 'oath.foodUsual';
// A cached set of chips is offered for two hours at most: after that the time of day has moved on.
const FRESH = 2 * 3600e3;
const fmt = (v) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(Math.round(v));

// ---------- "Usually now" ----------

// The same identity the server ranks by (src/food-usual.js usualKey), for diary entries as the phone has them.
const keyOf = (e) => (e.kind === 'item' && e.refKey ? `item:${e.refKey}` : e.kind === 'recipe' && e.refKey ? `recipe:${e.refKey}`
  : e.kind === 'meal' && e.refId ? `meal:${e.refId}` : `name:${norm(e.name)}`);

// The latest answer, else the copy on the phone when it is from today and recent enough.
function latestSet() {
  const u = F().usual;
  if (u) return u;
  const c = D.store.get(CACHE, null);
  return c && c.date === localToday() && Date.now() - (c.saved || 0) < FRESH ? c : null;
}

// Fetched in the background: the row draws from the phone's copy at once and is swapped in place when
// the answer arrives.
export function loadUsual() {
  return api('GET', '/api/food/usual').then((u) => {
    F().usual = u;
    D.store.set(CACHE, { ...u, saved: Date.now() });
    const el = document.getElementById('fusual');
    if (el && state.route === 'food' && !state.param) el.outerHTML = usualHtml();
  }).catch(() => {});
}

// What to offer now: only on today, and never what is already in today's diary (or waiting to sync) in
// the same meal, so a chip disappears once tapped even with no connection. Drinks come round again.
function current() {
  const d = F().day;
  if (!d?.today) return null;
  const u = latestSet();
  if (!u) return null;
  const had = new Set(d.entries.filter((e) => e.slot !== 'drinks').map((e) => `${keyOf(e)}|${e.slot}`));
  for (const q of D.queue()) if (q.preview?.usual && q.data?.slot !== 'drinks') had.add(`${q.preview.usual}|${q.data.slot}`);
  const fresh = (p) => p.slot === 'drinks' || !had.has(`${p.key}|${p.slot}`);
  return { ...u, now: (u.now || []).filter(fresh), combos: (u.combos || []).filter((c) => c.lines.every(fresh)) };
}

const basis = (p, days) => `${p.times} times in the last ${days} days, usually around ${p.at}`;

function chip(p, days) {
  const why = basis(p, days);
  return `<div class="fu" role="listitem">
    <button type="button" class="fu-log" data-action="food-usual" data-key="${esc(p.key)}" title="${esc(why)}"
      aria-label="${esc(`Log ${p.name}, ${p.amount}, to ${D.SLOT[p.slot].toLowerCase()}. ${why}.`)}"><span class="fu-name">${esc(p.label)}</span><span class="fu-amt">${esc(p.amount)}</span></button>
    <button type="button" class="fu-more" data-action="food-usual-edit" data-key="${esc(p.key)}" aria-label="${esc(`Change ${p.label} before logging`)}">${icon('chevron')}</button></div>`;
}

function comboChip(c, days) {
  const why = basis(c, days);
  return `<div class="fu combo" role="listitem">
    <button type="button" class="fu-log" data-action="food-usual" data-key="${esc(c.key)}" title="${esc(why)}"
      aria-label="${esc(`Log your ${c.label.toLowerCase()}: ${c.lines.map((l) => `${l.name}, ${l.amount}`).join('; ')}. ${why}.`)}"><span class="fu-name">${esc(c.label)}</span><span class="fu-amt">${esc(c.names)}</span></button>
    <button type="button" class="fu-more" data-action="food-usual-edit" data-key="${esc(c.key)}" aria-label="${esc(`Change your ${c.label.toLowerCase()} before logging`)}">${icon('chevron')}</button></div>`;
}

// The catalogue items the row is offering now, so the recent tray below does not offer them twice.
export function usualItemKeys() {
  const u = current();
  return new Set((u?.now || []).filter((p) => p.key.startsWith('item:')).map((p) => p.key.slice(5)));
}

// The first row under the capture bar. With no history yet it is an empty placeholder, so a late
// answer has somewhere to land.
export function usualHtml() {
  const u = current();
  const days = u?.days || 60;
  const chips = u ? [...u.combos.map((c) => comboChip(c, days)), ...u.now.map((p) => chip(p, days))] : [];
  if (!chips.length) return '<div id="fusual" hidden></div>';
  return `<div class="fusual" id="fusual"><p class="fusual-k" id="fusual-k">Usually now<small>from your last ${days} days</small></p>
    <div class="tray fusual-row" role="list" aria-labelledby="fusual-k">${chips.join('')}</div></div>`;
}

const find = (key) => {
  const u = latestSet();
  return u ? [...(u.combos || []), ...(u.now || [])].find((p) => p.key === key) || null : null;
};

// The Undo banner after a log: removing what was just logged takes it out again. When its time is up it
// goes in place: a full redraw then would close a half-filled sheet and its keyboard.
function offerUndo(ids, name, verb) {
  const token = {};
  F().undo = { kind: 'log', ids, name, verb, token };
  setTimeout(() => {
    if (F().undo?.token !== token) return;
    F().undo = null;
    document.querySelector('.food-undo')?.remove();
  }, 10000);
}

async function logged(ids, name, queued, verb = 'Logged') {
  haptic('log-food');
  toast(queued ? `${cap(name)} saved on this phone. It syncs when you are back online.` : `${verb} ${name}.`);
  offerUndo(ids, name, verb);
  state.foodSheet = null;
  state.foodToday = null;
  await D.refresh().catch(() => D.render());
}

// Several lines at once, each with its own id, through the queue. Returns the ids that landed.
async function postLines(lines) {
  const ids = lines.map(() => D.uuid());
  const res = await Promise.all(lines.map((l, i) => act(() => D.foodPost(l.op, { ...l.data, id: ids[i] }, l.preview))));
  return { ids: ids.filter((_, i) => res[i]), queued: res.some((r) => r?.queued) };
}

const preview = (l) => ({ name: l.name, amount: l.amount, ...(num(l.kcal) !== null ? { kcal: l.kcal } : {}), usual: l.key });

let logging = false;
async function logUsual(p) {
  if (logging) return; // a double tap logs once
  logging = true;
  try {
    const lines = (p.lines || [p]).map((l) => ({ op: l.log.op, data: l.log.data, preview: preview(l) }));
    const { ids, queued } = await postLines(lines);
    if (ids.length) await logged(ids, p.lines ? `your ${p.label.toLowerCase()}` : `${p.label}, ${p.amount}`, queued);
  } finally {
    logging = false;
  }
}

// The chevron: a food opens its own sheet at his usual amount and meal; anything else (a combination,
// a recipe, a meal) opens a short list to change or drop lines before logging.
async function editUsual(p) {
  if (!p.lines && p.log.op === 'log') {
    const k = p.log.data.key;
    const item = latestSet()?.items?.[k] || await D.itemFor(k).catch(() => null);
    if (item) {
      D.openSheet({ kind: 'food', item, qty: p.log.data.qty, unit: p.log.data.unit, slot: p.slot });
      return;
    }
  }
  const lines = (p.lines || [p]).map((l) => ({ ...l, qty: l.log.data.qty ?? null, unit: l.log.data.unit ?? null }));
  D.openSheet({ kind: 'usual', p, lines, slot: p.slot });
}

const itemOf = (l) => (l.log.op === 'log' ? latestSet()?.items?.[l.log.data.key] || null : null);

// Energy for a line at the amount on screen: a food from its record, a recipe in proportion to its
// usual servings, anything else as he logged it before.
function lineKcal(l) {
  const it = itemOf(l);
  if (it) {
    const r = line(it, l.qty, l.unit);
    return r.error ? null : num(r.nutrients.kcal);
  }
  if (l.log.op === 'recipe' && num(l.kcal) !== null && Number(l.log.data.qty) > 0) return (l.kcal * Number(l.qty)) / Number(l.log.data.qty);
  return num(l.kcal);
}
const kcalText = (l) => {
  const k = lineKcal(l);
  return k === null ? '–' : `${fmt(k)} kcal`;
};

function sheetBody(s) {
  const p = s.p;
  const days = latestSet()?.days || 60;
  const rows = s.lines.map((l, i) => {
    const it = itemOf(l);
    let amount = `<span class="li-sub">${esc(l.amount || '')}</span>`;
    if (it) {
      amount = `<span class="amount-row small"><input class="input" inputmode="decimal" value="${esc(l.qty ?? '')}" data-fu-index="${i}" data-fu-field="qty" aria-label="Amount of ${esc(l.label)}">
        <select class="input" data-fu-index="${i}" data-fu-field="unit" aria-label="Unit">${D.unitOptions(it, l.unit)}</select></span>`;
    } else if (l.log.op === 'recipe') {
      amount = `<span class="amount-row small fu-servings"><input class="input" inputmode="decimal" value="${esc(l.qty ?? 1)}" data-fu-index="${i}" data-fu-field="qty" aria-label="Amount of ${esc(l.label)}">
        <span class="li-sub">${l.unit === 'g' ? 'g' : 'servings'}</span></span>`;
    }
    return `<div class="li li-plain fu-line"><span class="li-body"><span class="li-title">${esc(l.name)}</span>${amount}</span>
      <span class="li-side"><b data-fu-kcal="${i}">${kcalText(l)}</b>${s.lines.length > 1 ? `<button type="button" class="icon-btn" data-action="food-usual-drop" data-index="${i}" aria-label="Leave out ${esc(l.label)}">${icon('close')}</button>` : ''}</span></div>`;
  }).join('');
  const n = s.lines.length;
  return `<p class="fu-why">${esc(`${cap(basis(p, days))}.`)}</p>
    <div class="group fu-lines">${rows}</div>
    <form data-form="food-usual-log">${D.slotSelect(s.slot)}
      <div class="form-actions"><button class="btn primary" type="submit"${n ? '' : ' disabled'}>${n > 2 ? `Log all ${n}` : n === 2 ? 'Log both' : 'Log it'}</button></div></form>`;
}

export function usualSheet(s, wrap) {
  return wrap(s.p.lines ? s.p.label : s.p.name, sheetBody(s), 'tall');
}

// ---------- One-tap water ----------

// Tap water from the seeded catalogue, in ml, as a drink. Water still waiting to sync counts towards the
// bar, so it moves up offline too.
async function addWater(ml) {
  const id = D.uuid();
  const r = await act(() => D.foodPost('log', { key: 'water-tap', qty: ml, unit: 'ml', slot: 'drinks', id }, { name: 'Tap water', amount: `${ml} ml`, kcal: 0, ml }));
  if (r) await logged([id], `${ml} ml of water`, r.queued, 'Added');
}

export function waterHtml(d) {
  const wref = N.drinksRef(d.needs || null);
  const waiting = d.today ? D.queue().filter((x) => x.preview?.date === d.date && num(x.preview?.ml) !== null).reduce((a, x) => a + x.preview.ml, 0) : 0;
  const sum = (num(d.drinksMl) || 0) + waiting;
  // No drinks logged is "—", not none.
  const ml = sum > 0 ? sum : null;
  const wp = ml === null ? null : (ml / wref) * 100;
  const add = d.today ? `<div class="fwater-add" role="group" aria-label="Add water">${[250, 500].map((v) => `<button type="button" class="fwater-btn" data-action="food-water" data-ml="${v}" aria-label="Log ${v} ml of tap water">+${v} ml</button>`).join('')}</div>` : '';
  return `<div class="fwater"><p class="fwater-head"><span class="fday-k">Water from drinks</span>
      <span class="fwater-v"><b>${ml === null ? '—' : fmt(ml)}</b> of ${fmt(wref)} ml ref${wp === null ? '' : ` · ${fmt(wp)}%`}</span></p>
    <div class="fwater-row"><span class="fwater-bar" role="img" aria-label="${esc(`Water from drinks: ${ml === null ? 'none logged' : `${fmt(ml)} ml`}, reference ${fmt(wref)} ml`)}"><i style="width:${Math.min(100, wp || 0).toFixed(1)}%" data-grow="fwater:${d.date}"></i></span>${add}</div></div>`;
}

// ---------- Per meal: add on today, copy a past day's meal (or all of yesterday) to today ----------

export function slotAction(d, slot) {
  const word = D.SLOT[slot].toLowerCase();
  if (d.today) return `<button type="button" class="icon-btn fslot-btn" data-action="food-slot-add" data-slot="${slot}" aria-label="Add to ${word}">${icon('plus')}</button>`;
  return `<button type="button" class="gh-link fslot-copy" data-action="food-slot-copy" data-slot="${slot}" aria-label="Copy ${word} to today">${icon('copy')}Copy to today</button>`;
}

// Today's empty meals as one quiet row of small links.
export function emptySlotsHtml(d) {
  if (!d.today) return '';
  const empty = D.SLOTS.filter(([s]) => !d.slots.find((x) => x.slot === s)?.entries.length);
  if (!empty.length) return '';
  return `<div class="fslot-empty" role="group" aria-label="Add to a meal"><span aria-hidden="true">Add</span>${empty.map(([s, l]) => `<button type="button" class="fslot-chip" data-action="food-slot-add" data-slot="${s}" aria-label="Add to ${l.toLowerCase()}">${l.toLowerCase()}</button>`).join('')}</div>`;
}

async function copySlot(slot) {
  const d = F().day;
  const sl = d?.slots.find((x) => x.slot === slot);
  if (!sl?.entries.length) return;
  const id = D.uuid();
  const today = localToday();
  const n = sl.entries.length;
  const name = `${D.SLOT[slot]} from ${fmtDay(d.date)}`;
  const r = await act(() => D.foodPost('repeat', { from: d.date, to: today, slot, id }, { date: today, name, amount: `${n} ${n === 1 ? 'item' : 'items'}`, ...(num(sl.total.kcal) !== null ? { kcal: sl.total.kcal } : {}) }));
  if (!r) return;
  haptic('log-food');
  const word = D.SLOT[slot].toLowerCase();
  if (r.queued) toast(`${name} saved on this phone. It goes into today when you are back online.`);
  else toast(r.duplicate ? `${cap(word)} is already copied to today.` : `Copied ${word} to today.`);
  offerUndo(r.queued ? [id] : (r.entries || []).map((e) => e.id), `${word} to today`, 'Copied');
  state.foodToday = null;
  D.render();
}

// "Repeat yesterday" on today: the whole of yesterday copied in the same way, with an id so a copy sent
// again (or replayed after being offline) lands once, and the same Undo.
async function repeatYesterday() {
  const id = D.uuid();
  const today = localToday();
  const r = await act(() => D.foodPost('repeat', { from: addDays(today, -1), to: today, id }, { date: today, name: 'Yesterday\'s food', amount: 'copied to today' }));
  if (!r) return;
  haptic('log-food');
  const n = r.entries?.length || 0;
  if (r.queued) toast('Yesterday\'s food is saved on this phone. It goes into today when you are back online.');
  else toast(r.duplicate ? 'Yesterday is already copied to today.' : `Copied ${n} ${n === 1 ? 'entry' : 'entries'} from yesterday.`);
  offerUndo(r.queued ? [id] : (r.entries || []).map((e) => e.id), 'yesterday to today', 'Copied');
  state.foodToday = null;
  await D.refresh().catch(() => D.render());
}

// ---------- Undo a log ----------

// Takes out what a tap just logged: still on the phone, it leaves the queue; already sent, it is removed.
export async function undoLog(u) {
  const q = D.queue();
  const waiting = new Set(q.filter((x) => u.ids.includes(x.id)).map((x) => x.id));
  if (waiting.size) D.store.set(D.QUEUE, q.filter((x) => !waiting.has(x.id)));
  const sent = u.ids.filter((x) => !waiting.has(x));
  const done = await act(async () => {
    for (const x of sent) await api('DELETE', `/api/food/log/${encodeURIComponent(x)}`);
    return true;
  });
  if (!done) {
    F().undo = u; // could not reach the server: the banner stays to try again
    D.render();
    return;
  }
  toast('Taken back out.');
  state.foodToday = null;
  await D.refresh().catch(() => D.render());
}

// ---------- Actions ----------

export async function usualClick(a, el) {
  switch (a) {
    case 'food-usual': {
      const p = find(el.dataset.key);
      if (p) await logUsual(p);
      return true;
    }
    case 'food-usual-edit': {
      const p = find(el.dataset.key);
      if (p) await editUsual(p);
      return true;
    }
    case 'food-usual-drop': {
      const s = state.foodSheet;
      s?.lines.splice(Number(el.dataset.index), 1);
      D.render();
      return true;
    }
    case 'food-water':
      await addWater(Number(el.dataset.ml));
      return true;
    case 'food-slot-copy':
      await copySlot(el.dataset.slot);
      return true;
    case 'food-repeat':
      await repeatYesterday();
      return true;
    case 'food-slot-add': {
      // Search with this meal chosen for whatever is picked next.
      const slot = el.dataset.slot;
      D.openSheet({ kind: 'search', q: '', drinks: slot === 'drinks', results: null, slot });
      return true;
    }
    default:
      return false;
  }
}

export async function usualSubmit(kind, form) {
  if (kind !== 'food-usual-log') return false;
  const s = state.foodSheet;
  if (!s?.lines?.length) return true;
  const slot = form.slot?.value || s.slot;
  const lines = [];
  for (const l of s.lines) {
    const data = { ...l.log.data, slot };
    const item = itemOf(l);
    let amount = l.amount;
    if (['log', 'recipe'].includes(l.log.op)) {
      const qty = Number(String(l.qty).replace(',', '.'));
      const check = item ? line(item, qty, l.unit) : qty > 0 ? {} : { error: 'The amount must be more than zero.' };
      if (check.error) {
        toast(`${l.label}: ${check.error}`, true);
        return true;
      }
      Object.assign(data, { qty, ...(l.unit ? { unit: l.unit } : {}) });
      amount = N.amountText(qty, data.unit || 'serving', item || {});
    }
    const k = lineKcal(l);
    lines.push({ op: l.log.op, data, preview: { name: l.name, amount, ...(k !== null ? { kcal: round(k, 0) } : {}), usual: l.key } });
  }
  const { ids, queued } = await postLines(lines);
  if (ids.length) await logged(ids, s.p.lines ? `your ${s.p.label.toLowerCase()}` : s.p.label, queued);
  return true;
}

function onInput(e) {
  const el = e.target;
  if (!el.matches?.('[data-fu-index]')) return;
  const s = state.foodSheet;
  const l = s?.kind === 'usual' ? s.lines[Number(el.dataset.fuIndex)] : null;
  if (!l) return;
  l[el.dataset.fuField] = el.value;
  const out = document.querySelector(`[data-fu-kcal="${el.dataset.fuIndex}"]`);
  if (out) out.textContent = kcalText(l);
}

export function initUsual(deps) {
  D = deps;
  $app.addEventListener('input', onInput);
  $app.addEventListener('change', onInput);
  // A diary row swiped to the left (motion.js) is removed as from its sheet, with the same Undo. If it
  // could not be removed the screen redraws, which puts the row back.
  $app.addEventListener('oath:swipe-remove', async (e) => {
    const row = e.target.closest?.('[data-eid]');
    if (!row) return;
    await D.click('food-entry-del', row);
    if (row.isConnected) D.render();
  });
}
