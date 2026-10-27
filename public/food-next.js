// "What to eat next" on the diary, and the "Rich in…" sheet. The server ranks both (src/food-next.js):
// today's gaps against his needs, his own foods at his usual amount and a few common foods with
// sourced portions. Here they are drawn, logged in one tap through the diary's offline queue with an
// Undo, and opened in the food sheet to change the amount.
import { state, esc, api, act, toast, icon, num, localToday } from './ui.js';
import { NUTRIENT, round } from './nutrition.js';

// The diary's own helpers (openSheet, foodPost, afterLog ...), handed over by food.js at start.
let D = null;
export function initNext(deps) {
  D = deps;
}

const f = () => state.food || (state.food = { date: null });
const enc = encodeURIComponent;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
const CACHE = 'oath.foodNext';
const UNDO_MS = 10000;
// The card waits for the day to start: something logged, or late morning.
const SHOW_FROM_HOUR = 11;

const fmt = (v, dec = 0) => (num(v) === null ? '–' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: dec }).format(round(v, dec)));
const grams = (v) => fmt(v, num(v) !== null && v < 10 ? 1 : 0);
const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const SHORT = { vitc: 'Vit C', vitd: 'Vit D', vita: 'Vit A', vite: 'Vit E', vitk: 'Vit K', b12: 'Vit B12', b6: 'Vit B6', satfat: 'Saturates', kcal: 'Energy' };
const shortOf = (k) => SHORT[k] || NUTRIENT[k]?.label || k;

function gradeDot(g) {
  const x = String(g || '').toLowerCase();
  return 'abcde'.includes(x) && x.length === 1 ? `<span class="ns-dot ns-${x}" role="img" aria-label="Nutri-Score ${x.toUpperCase()}">${x.toUpperCase()}</span>`
    : '<span class="ns-dot ns-none" aria-hidden="true"></span>';
}

// "1 US cup · 198 g": the portion in words, and its weight when the words do not already say it.
function amountLine(text, g, ml) {
  const t = String(text || '');
  const w = num(g) !== null ? `${fmt(g)} g` : num(ml) !== null ? `${fmt(ml)} ml` : '';
  return !w || /\d\s*(g|ml)$/.test(t) ? t || w : `${t} · ${w}`;
}

// ---------- Loading ----------

// Today's suggestions load with the day; offline, the last copy for today stands in.
let seq = 0;
export async function loadNext() {
  const F = f();
  const mine = (seq += 1);
  try {
    const r = await api('GET', '/api/food/next');
    if (mine !== seq) return;
    F.next = r;
    store.set(CACHE, r);
  } catch {
    if (mine !== seq) return;
    const today = localToday();
    const c = store.get(CACHE, null);
    F.next = F.next?.date === today ? F.next : c?.date === today ? c : null;
  }
}

// Redraws the card in place, so a log or an Undo does not move the page.
function patchCard() {
  const el = document.getElementById('fnext');
  if (el) el.outerHTML = nextCardHtml(f().day);
}

// ---------- The card ----------

// The two biggest gaps in a few words: "Protein 42 g · Fibre 12 g to go". A floor's gap is "up to".
// Each gap stays on one line, so a narrow phone never breaks "Vit C" in two.
function gapsHtml(r) {
  const parts = (r.gaps || []).slice(0, 2).map((g, i) => {
    const amount = g.key === 'kcal' ? `${fmt(g.gap)} kcal` : `${g.unit === 'g' ? grams(g.gap) : fmt(g.gap, NUTRIENT[g.key]?.dec || 0)} ${g.unit}`;
    const text = `${g.key === 'kcal' ? '' : `${shortOf(g.key)} `}${g.floor ? 'up to ' : ''}${amount}`;
    return i ? text : text.charAt(0).toUpperCase() + text.slice(1);
  });
  return parts.length ? `${parts.map((p, i) => `<span class="fnext-gap">${esc(p)}${i === parts.length - 1 ? ' to go' : ''}</span>`).join(' · ')}` : '';
}

// What the numbers stand on, and which gaps are "at most" because some of today's foods have no value.
function footText(r, items) {
  const basis = r.based === 'needs' ? 'your daily needs' : 'EU reference intakes';
  const floors = (r.gaps || []).slice(0, 2).filter((g) => g.floor).map((g) => lower(g.key === 'kcal' ? 'energy' : NUTRIENT[g.key]?.label));
  const ideas = items.some((x) => !x.own) ? ' Ideas use USDA portions.' : '';
  const floor = floors.length ? ` Some of today's foods have no ${floors.join(' or ')} value, so less may be left.` : '';
  return `Against ${basis}. Your foods at your usual amount.${ideas}${floor}`;
}

function addsHtml(a) {
  const plus = (k) => (a.missing?.[k] ? '+' : '');
  const bits = [
    `<span><b>${fmt(a.kcal)}${plus('kcal')}</b> kcal</span>`,
    `<span><b>${num(a.protein) === null ? '–' : `${grams(a.protein)}${plus('protein')} g`}</b> protein</span>`,
    `<span><b>${num(a.fibre) === null ? '–' : `${grams(a.fibre)}${plus('fibre')} g`}</b> fibre</span>`,
  ];
  if (a.micro) bits.push(`<span>${esc(shortOf(a.micro.key))} <b>${fmt(a.micro.pct)}%${a.micro.floor ? '+' : ''}</b></span>`);
  return `<span class="fnext-adds">${bits.join('')}</span>`;
}

function rowHtml(x, i) {
  const amount = amountLine(x.amountText, x.g, x.ml);
  const tag = x.own ? '' : `<span class="ftag-mini">${x.fresh ? 'New idea' : 'Idea'}</span>`;
  return `<li class="fnext-row">
    <button type="button" class="fnext-pick" data-action="food-next-open" data-i="${i}" aria-label="${esc(`${x.name}, ${amount}. Change the amount`)}">
      ${gradeDot(x.grade)}
      <span class="fnext-body"><span class="fnext-name">${esc(x.name)}</span>
        <span class="fnext-amt">${esc(amount)}${tag ? ` ${tag}` : ''}</span>
        ${addsHtml(x.adds || {})}
        ${x.reason ? `<span class="fnext-why">${esc(x.reason)}</span>` : ''}</span>
    </button>
    <button type="button" class="btn tinted small fnext-log" data-action="food-next-log" data-i="${i}" aria-label="${esc(`Log ${x.name}, ${amount}`)}">Log</button></li>`;
}

function coveredText(r) {
  const unknown = (r.unknown || []).filter((k) => k !== 'kcal').map((k) => lower(shortOf(k)));
  const rest = unknown.length ? ` No values yet for ${unknown.length > 2 ? `${unknown.slice(0, 2).join(', ')} and ${unknown.length - 2} more` : unknown.join(' and ')}.` : '';
  return `Today's needs are covered.${rest}`;
}

// The card itself, or an empty marker it can land in later. Today only, once the day has started.
export function nextCardHtml(d) {
  const F = f();
  const r = F.next;
  const started = d?.entries?.length > 0 || new Date().getHours() >= SHOW_FROM_HOUR;
  if (!d?.today || !r || r.date !== d.date || !started) return '<div id="fnext" hidden></div>';
  const u = F.nextUndo && F.nextUndo.until > Date.now() ? F.nextUndo : null;
  const undo = u ? `<div class="fnext-undo" role="status"><span>Logged ${esc(u.name)}.</span><button type="button" class="btn tinted small" data-action="food-next-undo">Undo</button></div>` : '';
  if (r.covered) {
    return `<section class="card fnext is-covered" id="fnext" aria-label="What to eat next">${undo}
      <p class="fnext-calm">${icon('check')}<span>${esc(coveredText(r))}</span></p></section>`;
  }
  const items = r.items || [];
  return `<section class="card fnext" id="fnext" aria-labelledby="fnext-h">
    <p class="fday-k fnext-k">What to eat next</p>
    <h2 class="fnext-gaps" id="fnext-h">${gapsHtml(r)}</h2>
    ${undo}
    ${items.length ? `<ul class="fnext-list">${items.map(rowHtml).join('')}</ul>` : '<p class="fnext-none">Nothing you usually eat fits what is left today.</p>'}
    <p class="fnext-foot">${esc(footText(r, items))}</p></section>`;
}

// ---------- Logging and opening a suggestion ----------

async function logRow(i) {
  const F = f();
  const x = F.next?.items?.[i];
  if (!x || !D) return;
  const id = uuid();
  const body = { ...x.log.body, id, slot: D.slotNow(x.liquid) };
  const r = await act(() => D.foodPost(x.log.op, body, { name: x.name, amount: x.amountText, kcal: x.adds?.kcal ?? undefined }));
  if (!r) return;
  F.nextUndo = { id, name: x.name, queued: Boolean(r.queued), until: Date.now() + UNDO_MS };
  // Off the list at once (and off the offline copy); the next ranking from the server replaces it.
  F.next = { ...F.next, items: F.next.items.filter((_, j) => j !== i) };
  store.set(CACHE, F.next);
  setTimeout(() => {
    if (F.nextUndo?.id !== id) return;
    F.nextUndo = null;
    if (state.route === 'food' && !state.param) patchCard();
  }, UNDO_MS + 50);
  await D.afterLog(r, x.name);
}

async function undoRow() {
  const F = f();
  const u = F.nextUndo;
  F.nextUndo = null;
  if (!u) return;
  if (u.queued) {
    D.dropQueued(u.id);
    toast(`Removed ${u.name}.`);
    await D.refresh();
    return;
  }
  if (await act(() => api('DELETE', `/api/food/log/${enc(u.id)}`), `Removed ${u.name}.`)) await D.refresh();
  else patchCard();
}

// A row opens where its amount can change: the food sheet, the recipe's log sheet, or the meal's builder.
async function openFood(x) {
  if (x.kind === 'item') {
    const item = await D.itemFor(x.key);
    D.openSheet({ kind: 'food', item, qty: x.portion?.qty ?? x.qty, unit: x.portion?.unit ?? x.unit });
  } else if (x.kind === 'recipe') {
    D.openSheet({ kind: 'recipe-log', recipe: await api('GET', `/api/food/recipes/${enc(x.key)}`) });
  } else if (x.kind === 'meal') {
    const m = await api('GET', `/api/food/meals/${x.mealId}`);
    await D.openBuilder({ mode: m.kind, mealId: m.id, name: m.name }, m.lines);
  }
}

// ---------- Rich in… ----------

export const richTitle = (s) => `${s.limit ? 'High' : 'Rich'} in ${lower(NUTRIENT[s.key]?.label || s.key)}`;

export function openRich(key) {
  if (!NUTRIENT[key] || key === 'kcal' || !D) return;
  const s = { kind: 'rich', key, by: f().richBy || 'portion', data: {}, limit: ['sugars', 'salt', 'satfat'].includes(key) };
  D.openSheet(s);
  fetchRich(s);
}

async function fetchRich(s) {
  const by = s.by;
  if (!s.data[by]) {
    s.error = null;
    try {
      s.data[by] = await api('GET', `/api/food/rich?k=${enc(s.key)}&by=${by}`);
    } catch (err) {
      s.error = err.status === 0 ? 'Finding foods needs a connection.' : err.message;
    }
  }
  if (state.foodSheet !== s) return;
  const box = document.getElementById('frich-list');
  if (box) box.innerHTML = richListHtml(s);
}

function richRowHtml(x, i, list, r) {
  const kcalMode = r.by === 'kcal';
  const p = kcalMode ? x.perKcal : x;
  const unit = r.unit;
  const amt = `${fmt(p.amount, NUTRIENT[r.key]?.dec ?? 1)}${x.floor ? '+' : ''} ${unit}`;
  const sub = kcalMode
    ? `Per 100 kcal${x.perKcal?.g ? ` · about ${fmt(x.perKcal.g)} ${x.perKcal.basis}` : ''}`
    : amountLine(x.portion.text, x.portion.g, x.portion.ml);
  return `<button type="button" class="li li-plain fr frich-row" data-action="food-rich-pick" data-list="${list}" data-i="${i}">${gradeDot(x.grade)}
    <span class="li-body"><span class="li-title">${esc(x.name)}${x.brand ? ` <small class="faint">${esc(x.brand)}</small>` : ''}</span>
      <span class="li-sub">${esc(sub)}</span></span>
    <span class="li-side frich-v"><b>${esc(amt)}</b>${p.pct === null || p.pct === undefined ? '' : `<small>${fmt(p.pct, p.pct < 10 ? 1 : 0)}%</small>`}</span></button>`;
}

function richListHtml(s) {
  const r = s.data[s.by];
  if (s.error && !r) return `<p class="note">${esc(s.error)}</p>`;
  if (!r) return '<div class="frich-wait" role="status"><span class="sr">Finding foods</span><i></i><i></i><i></i></div>';
  const word = lower(r.label);
  const need = num(r.need) === null ? '' : `${r.based === 'needs' ? 'Your need' : r.based === 'ri' ? 'EU reference intake' : 'Reference'}: ${fmt(r.need, NUTRIENT[r.key]?.dec ?? 1)} ${r.unit} a day.`;
  const list = (rows, name, empty) => (rows.length
    ? `<div class="group frich-group">${rows.map((x, i) => richRowHtml(x, i, name, r)).join('')}</div>`
    : `<p class="fempty-line frich-empty">${empty}</p>`);
  const how = r.by === 'kcal'
    ? `Per 100 kcal of each food. Foods under ${r.kcalFloor} kcal a portion are left out.`
    : 'Per portion: your usual amount, or a portion from the label or USDA.';
  return `${need ? `<p class="frich-lead">${esc(need)}</p>` : ''}
    <h3 class="frich-h">Your foods</h3>${list(r.yours, 'yours', `Nothing you logged in the last ${r.days} days has a value for ${esc(word)}.`)}
    <h3 class="frich-h">More ideas</h3>${list(r.ideas, 'ideas', 'No other foods with a value for it.')}
    <p class="frich-foot">${esc(how)} Foods with no ${esc(word)} value on record are left out, never counted as none.</p>`;
}

export function richBody(s) {
  // Radios, so the segment's pill slides to the choice without a redraw (motion.js).
  const seg = [['portion', 'Per portion'], ['kcal', 'Per 100 kcal']].map(([v, l]) => `<label><input type="radio" name="frich-by" value="${v}" data-action="food-rich-by" data-by="${v}"${s.by === v ? ' checked' : ''}><span>${l}</span></label>`).join('');
  return `<div class="seg small frich-seg" role="radiogroup" aria-label="Rank">${seg}</div>
    <div id="frich-list" aria-live="polite">${richListHtml(s)}</div>`;
}

// ---------- Clicks ----------

// The diary hands every "food-next-…" and "food-rich…" action here.
export async function nextClick(a, el) {
  const F = f();
  const s = state.foodSheet;
  switch (a) {
    case 'food-next-log':
      await logRow(Number(el.dataset.i));
      return true;
    case 'food-next-open': {
      const x = F.next?.items?.[Number(el.dataset.i)];
      if (x) await act(() => openFood(x));
      return true;
    }
    case 'food-next-undo':
      await undoRow();
      return true;
    case 'food-rich':
      openRich(el.dataset.key);
      return true;
    case 'food-rich-by': {
      if (s?.kind !== 'rich' || s.by === el.dataset.by) return true;
      s.by = el.dataset.by === 'kcal' ? 'kcal' : 'portion';
      F.richBy = s.by;
      await fetchRich(s);
      return true;
    }
    case 'food-rich-pick': {
      const x = s?.data?.[s.by]?.[el.dataset.list]?.[Number(el.dataset.i)];
      if (x) await act(() => openFood(x));
      return true;
    }
    default:
      return false;
  }
}
