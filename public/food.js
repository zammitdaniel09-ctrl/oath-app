// Food: the day's diary, "snap your food" and "what did you eat?", search, quick add, the builders,
// recipes, cooked batches, plans, the nutrition facts sheets and the Trends charts.
// Every number comes from nutrition.js, the same maths the server uses. Unknown stays unknown:
// "–" is a value nobody has sourced, "+" a total missing some lines, "~" a value filled by estimate.
import {
  $app, state, esc, api, act, toast, fmtDay, icon, pageHead, haptic, localToday, localNowHM, form2obj,
  reduced, num, shortDay, confirmSheet, redrawIfIdle,
} from './ui.js';
import { NUTRIENT, NUTRIENTS, line, total, scale, show, unitsFor, round, amountText, norm } from './nutrition.js';
// Grades and tags come from the shared maths when it has them.
import * as N from './nutrition.js';
import { richHtml } from './rich.js';
// Real burn: the Body tab's cards and the diary tile.
import { burnCard, weightCard, burnTile, loadEnergy, energyClick, energySubmit } from './food-energy.js';
import { wantLinks, linksSleepCard, linksTrainingCard, linksAlcoholCard, linksWindowCard } from './food-links.js';
import { initScan, scanClick, scanMissBody, scanMissTitle } from './scan.js';
// One-tap logging, water, what is left today, per-meal copy and add, swipe to remove.
import {
  initUsual, loadUsual, usualHtml, usualItemKeys, usualClick, usualSubmit, usualSheet, undoLog, waterHtml, slotAction, emptySlotsHtml,
} from './food-usual.js';
import { initNext, loadNext, nextCardHtml, nextClick, richBody, richTitle } from './food-next.js';
import { importBody, importNotice, importedRow, importFields, importSubmit, importClick, importTyped, needsFix, sourceCredit, fixExtras } from './food-import.js';
// The food chat: "What did you eat?" as a conversation, opened from the bar on the diary.
import {
  initChat, viewChat, openChat, chatClick, chatSubmit, chatInput, chatPhoto, chatAfterLog, chatPicked, chatWaiting, loadChatDay,
} from './food-chat.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };

const SLOTS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks'], ['drinks', 'Drinks']];
const SLOT = Object.fromEntries(SLOTS);
const SLOT_ICON = { breakfast: 'sun', lunch: 'food', dinner: 'moon', snacks: 'bowl', drinks: 'drink' };
const KIND = { generic: 'Generic', product: 'Product', custom: 'Yours', label: 'From your label', estimate: 'Estimate' };
const STRIP = ['protein', 'carbs', 'fat', 'sugars', 'fibre', 'salt'];
const FAMILIES = {
  'breakfast-fruit-oats': 'Fruit, oats and yogurt', 'breakfast-eggs': 'Eggs and hot breakfasts', sandwiches: 'Sandwiches and wraps',
  lunches: 'Salads and packed lunches', pasta: 'Pasta', bakes: 'Bakes', rice: 'Rice and grains', noodles: 'Noodles and stir-fries',
  sides: 'Potatoes and sides', chicken: 'Chicken and turkey', meat: 'Beef, pork and lamb', fish: 'Fish and seafood',
  vegetarian: 'Beans, lentils and tofu', soups: 'Soups and stews', 'pizza-pies': 'Pizza and pies', sweets: 'Sweet things',
  maltese: 'Maltese', shakes: 'Shakes and smoothies', components: 'Sauces and components', 'saved-meals': 'Simple combinations',
};
const STATUS = { 'ai-untested': 'Not kitchen-tested', 'user-reviewed': 'Reviewed by you', tested: 'Kitchen-tested', imported: 'Imported from a link' };
const BUILDERS = {
  shake: { title: 'Shake', icon: 'blend', groups: [['liquid', 'Liquid'], ['powder', 'Powder'], ['fruit', 'Fruit'], ['add', 'Additions']] },
  bowl: { title: 'Fruit bowl', icon: 'bowl', groups: [['fruit', 'Fruit'], ['add', 'Extras']] },
  plate: { title: 'Plate', icon: 'food', groups: [['protein', 'Protein'], ['starch', 'Starch'], ['veg', 'Vegetables'], ['sauce', 'Sauce or oil']] },
  meal: { title: 'Meal', icon: 'food', groups: [['all', 'Foods']] },
};

const f = () => state.food || (state.food = { date: null });
const enc = encodeURIComponent;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const kcal = (n) => show(n, 'kcal');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------- Phone storage: the offline queue and the last copies of what the tray needs ----------

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
const QUEUE = 'oath.foodQueue';
const queue = () => store.get(QUEUE, []);

const PATHS = { log: '/api/food/log', quick: '/api/food/quick', meal: '/api/food/meals/log', recipe: '/api/food/recipes/log', batch: '/api/food/batches/log', repeat: '/api/food/repeat' };

// Every diary write carries an id made here, so a write sent again (or replayed after being offline)
// lands once. Without a connection it waits on the phone and syncs later.
async function foodPost(op, data, preview = {}) {
  const body = { ...data, id: data.id || uuid() };
  try {
    return await api('POST', PATHS[op], body);
  } catch (err) {
    if (err.status !== 0) throw err;
    store.set(QUEUE, [...queue().filter((x) => x.id !== body.id), { id: body.id, op, data: body, preview: { date: f().day?.date || localToday(), ...preview }, at: Date.now() }]);
    return { queued: true };
  }
}

let flushing = false;
export async function flushFood() {
  const q = queue();
  if (!q.length || flushing || navigator.onLine === false) return;
  flushing = true;
  try {
    const r = await api('POST', '/api/food/sync', { ops: q.map(({ id, op, data }) => ({ id, op, data })) });
    const handled = new Set(r.results.map((x) => x.id));
    store.set(QUEUE, queue().filter((x) => !handled.has(x.id)));
    const failed = r.results.filter((x) => !x.ok);
    if (failed.length) toast(`${failed.length} offline ${failed.length === 1 ? 'entry' : 'entries'} could not be saved: ${failed[0].error}`, true);
    else toast(`Synced ${handled.size} offline ${handled.size === 1 ? 'entry' : 'entries'}.`);
    if (state.route === 'food') await refresh();
  } catch { /* still offline */ } finally {
    flushing = false;
  }
}

// ---------- Loading ----------

async function loadDay() {
  const d = f().date;
  // What to eat next is for today only, and loads alongside it.
  const next = d ? null : loadNext();
  try {
    f().day = await api('GET', `/api/food/day${d ? `?date=${d}` : ''}`);
    f().offline = false;
    if (f().day.today) store.set('oath.foodDay', f().day);
  } catch (err) {
    const c = err.status === 0 ? store.get('oath.foodDay', null) : null;
    if (!c || (d && c.date !== d)) throw err;
    f().day = c;
    f().offline = true;
  }
  await next;
  loadTake('day');
}

async function loadExtras() {
  loadUsual(); // in the background: the chips draw from the phone's copy until it lands
  const [recent, drinks, batches, week] = await Promise.all([
    api('GET', '/api/food/recent').then((r) => r.items).catch(() => null),
    api('GET', '/api/food/recent?drinks=1').then((r) => r.items).catch(() => null),
    api('GET', '/api/food/batches').then((r) => r.batches).catch(() => null),
    api('GET', '/api/food/history?days=7').catch(() => null),
    loadEnergy(),
  ]);
  if (recent) store.set('oath.foodRecent', recent);
  if (drinks) store.set('oath.foodDrinks', drinks);
  f().recent = recent || store.get('oath.foodRecent', []);
  f().drinks = drinks || store.get('oath.foodDrinks', []);
  f().batches = batches || [];
  f().week = week || f().week || null;
}

async function loadTrends() {
  const F = f();
  // The Body tab's real burn comes alongside (food-energy.js keeps it in the food state).
  [F.trend] = await Promise.all([
    api('GET', `/api/food/history?days=${F.span || 7}${F.trendDate ? `&date=${F.trendDate}` : ''}`),
    trendTab() === 'body' ? loadEnergy() : null,
  ]);
  loadTake('trends');
}

// ---------- The coach's take ----------

// A few sentences from the coach on the day or the period. The screen draws without it and the take
// lands in place when it arrives; the server keeps it until the numbers change, so a repeat visit is quick.
let takeTimer = null;
function loadTake(view) {
  const F = f();
  F.takes = F.takes || {};
  const day = F.day && !F.day.today ? F.day.date : null;
  const key = view === 'trends' ? `trends-${F.span || 7}` : `day-${day || 'today'}`;
  const cur = F.takes[view];
  F.takes[view] = { ...(cur?.key === key ? cur : {}), key, loading: true };
  const query = view === 'trends' ? `view=trends&days=${F.span || 7}` : `view=day${day ? `&date=${day}` : ''}`;
  clearTimeout(takeTimer);
  takeTimer = setTimeout(async () => {
    let next;
    try {
      const r = await api('GET', `/api/food/take?${query}`);
      next = { key, text: r.text || null, loading: false };
    } catch {
      next = { ...F.takes[view], loading: false };
    }
    if (F.takes[view]?.key !== key) return;
    // Only a take that just changed fades in; later redraws show it still.
    F.takes[view] = { ...next, fresh: Boolean(next.text) && next.text !== F.takes[view]?.text };
    const el = document.getElementById(`ftake-${view}`);
    if (el) el.outerHTML = takeHtml(view) || '<div hidden></div>';
    F.takes[view].fresh = false;
  }, 350);
}

function takeHtml(view) {
  const t = f().takes?.[view];
  if (!t || (!t.text && !t.loading)) return '';
  const ask = view === 'trends' ? 'About my food lately: ' : 'About my food today: ';
  const body = t.text
    ? `<div class="ftake-text rich">${richHtml(t.text)}</div>`
    : '<div class="ftake-wait" role="status"><span class="sr">The coach is looking at your food</span><i></i><i></i><i></i></div>';
  return `<section class="ftake${t.fresh ? ' fresh' : ''}" id="ftake-${view}" aria-label="The coach's take">
    <div class="ftake-head"><span class="ftake-k">${icon('coach')}Coach</span>${t.text ? `<a class="ftake-reply" href="#/coach?ask=${enc(ask)}">Reply${icon('chevron')}</a>` : ''}</div>${body}</section>`;
}

async function loadMeals() {
  try {
    f().meals = (await api('GET', '/api/food/meals')).meals;
    store.set('oath.foodMeals', f().meals);
  } catch (err) {
    if (err.status !== 0) throw err;
    f().meals = store.get('oath.foodMeals', []);
  }
}

export async function loadFood() {
  const p = state.param;
  flushFood();
  if (!p) {
    await Promise.all([loadDay(), loadExtras()]);
  } else if (p === 'recipes') {
    if (!f().recipes) f().recipes = (await api('GET', '/api/food/recipes')).recipes;
  } else if (p === 'recipe' && state.param2) {
    if (f().recipe?.key !== state.param2) {
      f().recipe = await api('GET', `/api/food/recipes/${enc(state.param2)}`);
      f().opts = { skip: [], with: [], swap: {}, factor: 1 };
    }
  } else if (p === 'meals') {
    await loadMeals();
  } else if (p === 'report') {
    f().report = await api('GET', '/api/food/report');
  } else if (p === 'trends') {
    await loadTrends();
  } else if (p === 'chat') {
    await loadChatDay();
  }
}

async function refresh() {
  await loadFood();
  ctx.render();
}

// The Today screen's food numbers are filled in the background; the screen redraws when it is quiet.
export function loadFoodToday() {
  api('GET', '/api/food/day').then((d) => {
    state.foodToday = d;
    redrawIfIdle('today', ctx.render);
  }).catch(() => {});
}

// ---------- Small pieces ----------

let uid = 0;
const nextId = (p) => `${p}${(uid += 1)}`;
const fmtN = (v, dec = 0) => (num(v) === null ? '–' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: dec }).format(round(v, dec)));
const share = (v, sum) => (sum > 0 ? Math.round((v / sum) * 100) : 0);

function strip(n, keys = STRIP, filled = null) {
  return `<dl class="nstrip">${keys.map((k) => `<div><dt>${NUTRIENT[k].label}</dt><dd>${val(n, k, filled)}</dd></div>`).join('')}</dl>`;
}

// ---------- Grades, NOVA and tags ----------

const GRADES = ['a', 'b', 'c', 'd', 'e'];
const gradeOf = (x) => {
  const g = String((typeof x === 'string' ? x : x?.grade) || '').toLowerCase();
  return GRADES.includes(g) ? g : null;
};
const safely = (fn) => {
  try { return fn(); } catch { return null; }
};
const itemGrade = (it) => (it ? gradeOf(it.nutriscore) || gradeOf(safely(() => N.nutriScore?.(it.nutrients, { category: it.category, liquid: it.liquid }))) : null);
const itemTags = (it) => {
  if (!it) return [];
  const t = Array.isArray(it.tags) ? it.tags : safely(() => N.foodTags?.(it));
  return Array.isArray(t) ? t.filter((x) => x?.label) : [];
};
const novaOf = (x) => {
  const v = Number(x);
  return v >= 1 && v <= 4 ? Math.round(v) : null;
};

// A grade as a small lettered square in the official colour; an empty outline when there is none.
function gradeDot(g, cls = '') {
  return g ? `<span class="ns-dot ns-${g}${cls}" role="img" aria-label="Nutri-Score ${g.toUpperCase()}">${g.toUpperCase()}</span>`
    : `<span class="ns-dot ns-none${cls}" aria-hidden="true"></span>`;
}

// The Nutri-Score as packs show it: five letters, the food's own one raised.
function nutriBadge(g) {
  if (!g) return '';
  return `<span class="nscore" role="img" aria-label="Nutri-Score ${g.toUpperCase()}"><span class="nscore-name" aria-hidden="true">Nutri-Score</span>
    <span class="nscore-row" aria-hidden="true">${GRADES.map((x) => `<i class="ns-${x}${x === g ? ' on' : ''}">${x.toUpperCase()}</i>`).join('')}</span></span>`;
}

function novaBadge(v) {
  const n = novaOf(v);
  return n ? `<span class="nova nova-${n}" role="img" aria-label="NOVA group ${n}"><small aria-hidden="true">NOVA</small><b aria-hidden="true">${n}</b></span>` : '';
}

// Tags as chips; a tap shows why under them.
function tagChips(tags) {
  if (!tags.length) return '';
  return `<div class="ftags">${tags.map((t) => `<button type="button" class="ftag t-${esc(t.tone || 'neutral')}" data-action="food-tag"${t.why ? ` data-why="${esc(t.why)}"` : ''} aria-expanded="false">${esc(t.label)}</button>`).join('')}
    <p class="ftag-why" aria-live="polite" hidden></p></div>`;
}
const tagMini = (t) => (t ? `<span class="ftag-mini t-${esc(t.tone || 'neutral')}">${esc(t.label)}</span>` : '');
// The one tag a row shows: the first that says more than the grade dot beside it already does.
const GRADE_TAGS = new Set(['good-choice', 'eat-less']);
const topTag = (tags) => (tags || []).find((t) => t?.label && !GRADE_TAGS.has(t.key)) || null;

// ---------- Values, estimates and reference intakes ----------

const filledSet = (x) => (x instanceof Set ? x : new Set(Array.isArray(x) ? x : []));
// A value with its marks: "~" when an estimate filled it, "+" (from show) when it is a floor.
const val = (n, k, filled, opts) => `${filledSet(filled).has(k) && num(n?.[k]) !== null ? '<i class="est" title="Estimated">~</i>' : ''}${show(n, k, opts)}`;

// A record with an estimate's per-100 values filled into the gaps it has, and which keys were filled.
function withFill(item, fill) {
  const filled = new Set();
  if (!item || !fill) return { item, filled };
  const nutrients = { ...item.nutrients };
  for (const [k, v] of Object.entries(fill)) {
    if (NUTRIENT[k] && num(nutrients[k]) === null && num(v) !== null) {
      nutrients[k] = v;
      filled.add(k);
    }
  }
  return { item: { ...item, nutrients }, filled };
}

// What 100% stands for: his own daily need once his body is set (Settings, Body), else the EU RI.
const needs = () => f().day?.needs || f().trend?.needs || state.foodToday?.needs || null;
const refAt = (k) => N.refOf(k, needs());
const riWord = () => (needs() ? 'need' : 'RI');
const riPct = (n, k) => {
  const ri = refAt(k);
  const v = num(n?.[k]);
  return ri && v !== null ? (v / ri) * 100 : null;
};
const pctText = (p, floor) => (p === null ? '–' : `${fmtN(p, p > 0 && p < 10 ? 1 : 0)}%${floor ? '+' : ''}`);
// Sugars, saturates and salt are amounts to stay under; vitamins, minerals and protein to reach.
const LIMITS = new Set(['satfat', 'sugars', 'salt']);
const REACH = (k) => k === 'protein' || ['mineral', 'vitamin'].includes(NUTRIENT[k]?.group);
const riTone = (p, k) => (p === null || p < 100 ? '' : LIMITS.has(k) ? ' over' : REACH(k) ? ' full' : '');
// Where a % of need sits along a bar: straight up to the need, which sits at RI_AT of the width; past
// it the scale eases off, so 150%, 300% and 1,000% all fit and still read apart (300% is near 87%).
const RI_AT = 62;
const riPos = (p) => (p <= 100 ? (Math.max(0, p) / 100) * RI_AT : RI_AT + (100 - RI_AT) * (1 - 100 / p));
function riBar(p, k) {
  if (p === null) return '<span class="ri-bar none" aria-hidden="true"></span>';
  return `<span class="ri-bar${riTone(p, k)}" aria-hidden="true" style="--at:${RI_AT}%"><i style="--p:${riPos(p).toFixed(1)}"></i><b class="ri-mark"></b></span>`;
}

const SHORT = {
  kcal: 'Energy', satfat: 'Saturates', mufa: 'Monounsaturates', pufa: 'Polyunsaturates', transfat: 'Trans fat', chol: 'Cholesterol',
  carbs: 'Carbohydrate', addsugars: 'Added sugars', vita: 'Vit A', vitc: 'Vit C', vitd: 'Vit D', vite: 'Vit E', vitk: 'Vit K',
  b1: 'Thiamin', b2: 'Riboflavin', b3: 'Niacin', b6: 'Vit B6', b12: 'Vit B12', folate: 'Folate',
};
const shortLabel = (k) => SHORT[k] || NUTRIENT[k]?.label || k;

// ---------- Nutrition facts: the label, then minerals, vitamins and anything else ----------

const LABEL_ROWS = [['kcal'], ['fat'], ['satfat', 1], ['mufa', 1], ['pufa', 1], ['transfat', 1], ['chol', 1], ['carbs'], ['sugars', 1], ['addsugars', 1], ['fibre'], ['protein'], ['salt']];
// On the label the fats and carbohydrates read as they do on a pack; vitamins keep their full names.
const FACT_NAME = {
  kcal: 'Energy', satfat: 'Saturates', mufa: 'Monounsaturates', pufa: 'Polyunsaturates', transfat: 'Trans fat', chol: 'Cholesterol',
  carbs: 'Carbohydrate', addsugars: 'Added sugars',
};

// With `tap`, a row with a % of need is a button that opens the foods richest in it.
function factRow(n, k, sub, filled, tap = false) {
  const d = NUTRIENT[k];
  const p = riPct(n, k);
  const unknown = num(n?.[k]) === null;
  const btn = tap && k !== 'kcal' && refAt(k);
  const tag = btn ? `button type="button" data-action="food-rich" data-key="${k}"` : 'div';
  return `<${tag} class="nf-row${sub ? ' sub' : ''}${unknown ? ' unk' : ''}${btn ? ' nf-tap' : ''}"><span class="nf-k">${esc(FACT_NAME[k] || d.label)}${btn ? icon('chevron', 'tap-hint') : ''}</span>
    <span class="nf-v">${val(n, k, filled)}</span><span class="nf-ri">${refAt(k) ? `${riBar(p, k)}<small>${p === null ? '' : pctText(p, n?.missing?.[k])}</small>` : ''}</span></${btn ? 'button' : 'div'}>`;
}

function factsHtml(n, filled = null, { tap = false } = {}) {
  const fl = filledSet(filled);
  // Sub-rows nobody has a value for are left out; the main rows always show, "–" when unknown.
  const label = LABEL_ROWS.filter(([k, sub]) => !sub || ['satfat', 'sugars'].includes(k) || num(n?.[k]) !== null);
  const group = (g, title) => {
    const all = NUTRIENTS.filter((x) => x.group === g);
    const known = all.filter((x) => num(n?.[x.key]) !== null);
    const rest = all.length - known.length;
    return `<div class="nf-group"><h4 class="nf-h">${title}</h4>${known.map((x) => factRow(n, x.key, false, fl, tap)).join('')}
      ${rest ? `<p class="nf-none">${known.length ? `${rest} more not on record` : 'Not on record'}</p>` : ''}</div>`;
  };
  const other = ['caffeine', 'alcohol'].filter((k) => num(n?.[k]) > 0);
  return `<div class="nf-group nf-label"><div class="nf-cols" aria-hidden="true"><span></span><span></span><span>% ${riWord()}</span></div>
      ${label.map(([k, sub]) => factRow(n, k, sub, fl, tap)).join('')}</div>
    ${group('mineral', 'Minerals')}${group('vitamin', 'Vitamins')}
    ${other.length ? `<div class="nf-group"><h4 class="nf-h">Other</h4>${other.map((k) => factRow(n, k, false, fl)).join('')}</div>` : ''}`;
}

// ---------- Drawings: rings, bars and timelines, hand-made SVG ----------

// Charts grow in the first time a screen is seen in a session, never on a re-render.
const seen = new Set();
const enter = (key) => {
  if (seen.has(key)) return '';
  seen.add(key);
  return ' f-enter';
};
// A striped fill for unknown or incomplete parts, drawn in screen pixels so it never stretches.
const hatchDef = (id, cls = '') => `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" class="fh-bg ${cls}"/><rect width="1.8" height="5" class="fh-line ${cls}"/></pattern>`;

const MACROS = [['protein', 4], ['carbs', 4], ['fat', 9]];
const MACRO_LABEL = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat', unknown: 'Unknown' };

// Energy from protein, carbs and fat (4, 4 and 9 kcal a gram). When some lines have no macro values,
// the energy they leave unexplained is its own "unknown" part rather than shared out among the rest.
function macroParts(n) {
  const parts = MACROS.map(([k, per]) => ({ key: k, kcal: (num(n?.[k]) || 0) * per }));
  const known = parts.reduce((a, p) => a + p.kcal, 0);
  const gaps = MACROS.some(([k]) => num(n?.[k]) === null || n?.missing?.[k]);
  const rest = gaps && num(n?.kcal) !== null ? Math.max(0, n.kcal - known) : 0;
  if (rest >= 1) parts.push({ key: 'unknown', kcal: rest });
  return { parts, sum: parts.reduce((a, p) => a + p.kcal, 0) };
}

// Parts laid end to end round a ring from twelve o'clock, each a rounded arc with a hair of gap before
// the next. Each arc carries a gradient along its length, deep where it starts and lit where it ends;
// unknown energy is striped. `reach` (0 to 1) is how much of the circle they fill together.
function ringArcs({ size, sw, parts, reach = 1, id, hatch }) {
  const c0 = size / 2;
  const r = (size - sw) / 2;
  const live = parts.filter((p) => p.v > 0);
  const sum = live.reduce((a, p) => a + p.v, 0);
  const span = Math.min(1, Math.max(0, reach)) * 2 * Math.PI;
  if (!(sum > 0) || !(span > 0)) return { defs: '', arcs: '' };
  const cap = sw / 2 / r;
  const gap = live.length > 1 ? 2.5 / r : 0;
  const closed = span > 2 * Math.PI - 1e-6;
  const room = span - gap * (closed ? live.length : live.length - 1);
  const pt = (a) => `${(c0 + r * Math.cos(a)).toFixed(2)} ${(c0 + r * Math.sin(a)).toFixed(2)}`;
  let at = -Math.PI / 2;
  let defs = '';
  const arcs = live.map((p, i) => {
    const len = (p.v / sum) * room;
    const a0 = at;
    at += len + gap;
    // The round caps sit inside the part's own length; a part too short for them is a dot.
    const lone = closed && live.length === 1;
    const s = lone ? a0 : a0 + Math.min(cap, len / 2);
    const e = lone ? a0 + len - 1e-3 : a0 + len - Math.min(cap, len / 2);
    const big = e - s > Math.PI ? 1 : 0;
    const d = lone ? `M${pt(s)} A${r} ${r} 0 1 1 ${pt(s + Math.PI)} A${r} ${r} 0 1 1 ${pt(s)}` : `M${pt(s)} A${r} ${r} 0 ${big} 1 ${pt(e)}`;
    let paint = `url(#${hatch})`;
    if (p.key !== 'unknown') {
      const gid = `${id}g${i}`;
      const far = e - s > 4.5 ? s + Math.PI : e;
      defs += `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${pt(s).split(' ')[0]}" y1="${pt(s).split(' ')[1]}" x2="${pt(far).split(' ')[0]}" y2="${pt(far).split(' ')[1]}">
        <stop offset="0" class="g0 m-${p.key}"/><stop offset="1" class="g1 m-${p.key}"/></linearGradient>`;
      paint = `url(#${gid})`;
    }
    return `<path d="${d}" class="fr-arc m-${p.key}" stroke="${paint}" stroke-width="${sw}" stroke-linecap="${lone ? 'butt' : 'round'}" fill="none"/>`;
  }).join('');
  return { defs, arcs };
}

// A ring of rounded arcs with its glow, a track, and whatever goes in the middle. `grow` draws it in.
function ringSvg({ size, sw, parts, reach = 1, label, center = '', grow = false, glow = true, cls = '' }) {
  const id = nextId('fr');
  const hatch = `${id}h`;
  const c0 = size / 2;
  const r = (size - sw) / 2;
  const { defs, arcs } = ringArcs({ size, sw, parts, reach, id, hatch });
  // The draw-in mask reaches past the ring so the glow round it is not cut off.
  const pad = size / 4;
  const mask = grow ? `<mask id="${id}m" maskUnits="userSpaceOnUse" x="${-pad}" y="${-pad}" width="${size + 2 * pad}" height="${size + 2 * pad}"><circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke="#fff"
      stroke-width="${sw * 3}" pathLength="1" class="fr-draw" transform="rotate(-90 ${c0} ${c0})"/></mask>` : '';
  const halo = glow && arcs ? `<filter id="${id}f" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${(sw / 2.4).toFixed(1)}"/></filter>` : '';
  const body = `${halo ? `<g class="fr-glow" filter="url(#${id}f)">${arcs}</g>` : ''}${arcs}`;
  return `<div class="fring${cls}" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
      <defs>${hatchDef(hatch)}${defs}${mask}${halo}</defs><circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke-width="${sw}" class="fr-track"/>
      <g${grow ? ` mask="url(#${id}m)"` : ''}>${body}</g></svg>
    ${center ? `<span class="fring-c" aria-hidden="true">${center}</span>` : ''}</div>`;
}

const macroArcParts = (n) => macroParts(n).parts.map((p) => ({ key: p.key, v: p.kcal }));
const spokenSplit = (n) => {
  const { parts, sum } = macroParts(n);
  return sum > 0 ? parts.filter((p) => p.kcal > 0).map((p) => `${MACRO_LABEL[p.key]} ${share(p.kcal, sum)}%`).join(', ') : 'nothing logged';
};

// The macro energy split as a whole ring, with whatever goes in the middle.
function donut(n, { size = 112, sw = 12, center = '', label = 'Energy split', grow = false } = {}) {
  return ringSvg({ size, sw, parts: macroArcParts(n), label: `${label}: ${spokenSplit(n)}`, center, grow });
}

// The day's energy against its need: the arc goes as far round as he has eaten, split by where the
// energy came from. At the need it closes.
function energyRing(t, need, { size = 168, sw = 15, center = '', grow = false, glow = true } = {}) {
  const kcal = num(t?.kcal) || 0;
  const reach = need > 0 ? kcal / need : kcal > 0 ? 1 : 0;
  const label = `${show(t, 'kcal')} of ${fmtN(need)} kcal, energy from ${spokenSplit(t)}`;
  return ringSvg({ size, sw, parts: macroArcParts(t), reach, label, center, grow, glow, cls: ' fring-energy' });
}

// A food's own small ring: where its energy comes from, with its Nutri-Score letter in the middle.
export function foodRing(n, grade = null) {
  const size = 36;
  const sw = 3.6;
  const c0 = size / 2;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const { parts, sum } = macroParts(n);
  const live = parts.filter((p) => p.kcal > 0);
  const gap = live.length > 1 ? 2.2 : 0;
  let off = 0;
  const arcs = sum > 0 ? live.map((p) => {
    const len = (p.kcal / sum) * c;
    const arc = `<circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke-width="${sw}" class="fr-seg m-${p.key}" stroke-dasharray="${Math.max(0.6, len - gap).toFixed(2)} ${c.toFixed(2)}"
      stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${c0} ${c0})"/>`;
    off += len;
    return arc;
  }).join('') : '';
  const g = gradeOf(grade);
  return `<span class="fmini${g ? ` g-${g}` : ''}" role="img" aria-label="${esc(`${g ? `Nutri-Score ${g.toUpperCase()}. ` : ''}Energy from ${spokenSplit(n)}`)}">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke-width="${sw}" class="fr-track"/>${arcs}</svg>
    ${g ? `<b aria-hidden="true">${g.toUpperCase()}</b>` : ''}</span>`;
}

// Energy by Nutri-Score grade as one stacked bar, with each grade's share under it.
function gradeMix(mix) {
  const parts = [...GRADES, 'none'].map((g) => ({ g, v: num(mix?.[g]) || 0 }));
  const sum = parts.reduce((a, p) => a + p.v, 0);
  if (!(sum > 0)) return '';
  const live = parts.filter((p) => p.v > 0);
  const name = (g) => (g === 'none' ? 'ungraded' : g.toUpperCase());
  const spoken = live.map((p) => `${name(p.g)} ${share(p.v, sum)}%`).join(', ');
  return `<div class="gmix" role="img" aria-label="${esc(`Energy by Nutri-Score: ${spoken}`)}">
    <div class="gmix-bar">${live.map((p) => `<i class="gx-${p.g}" style="flex-grow:${p.v.toFixed(1)}"></i>`).join('')}</div>
    <div class="gmix-key" aria-hidden="true">${live.map((p) => `<span>${gradeDot(p.g === 'none' ? null : p.g, ' sm')}${share(p.v, sum)}%</span>`).join('')}</div></div>`;
}

// One meal's share of the day's energy as a short bar, split by macro.
function mealBar(n, dayKcal) {
  const k = num(n?.kcal);
  if (!(dayKcal > 0) || !(k > 0)) return '';
  const { parts, sum } = macroParts(n);
  const segs = sum > 0 ? parts.filter((p) => p.kcal > 0).map((p) => `<i class="m-${p.key}" style="flex-grow:${p.kcal.toFixed(1)}"></i>`).join('') : '<i class="m-unknown" style="flex-grow:1"></i>';
  const pc = Math.max(2, Math.min(100, (k / dayKcal) * 100));
  return `<div class="fmeal" role="img" aria-label="${share(k, dayKcal)}% of the day's energy"><span class="fmeal-bar" style="width:${pc.toFixed(1)}%">${segs}</span></div>`;
}

// Energy per day as columns, each split by where its energy came from (protein at the foot, then
// carbs, fat, and striped for energy with no macros on record), or one plain column with `plain`. A day
// with nothing logged is a short dashed mark on the baseline, never a zero bar. Columns are HTML, so
// their rounded tops stay round at any width; the scale tops out at a round number with headroom.
function barsHtml(series, { height = 150, sel = null, values = false, selValue = true, avg = null, plain = false, mini = false } = {}) {
  const n = series.length || 1;
  const vals = series.map((d) => (d.logged ? num(d.kcal) : null));
  const peak = Math.max(...vals.map((v) => v || 0), num(avg) || 0, 1);
  const step = peak > 1500 ? 500 : peak > 300 ? 100 : 50;
  const max = Math.ceil((peak * (mini ? 1 : 1.1)) / step) * step;
  const pc = (v) => ((v / max) * 100).toFixed(2);
  const cols = series.map((d, i) => {
    const v = vals[i];
    const cls = `fxb-c${d.date === sel ? ' sel' : ''}${d.incomplete ? ' inc' : ''}`;
    if (v === null) return `<span class="${cls} gap"></span>`;
    let segs = '<i class="m-energy"></i>';
    if (!plain) {
      const { parts, sum } = macroParts(d);
      segs = sum > 0 ? parts.filter((p) => p.kcal > 0).map((p) => `<i class="m-${p.key}" style="flex-grow:${p.kcal.toFixed(1)}"></i>`).join('') : '<i class="m-unknown"></i>';
    }
    const label = (values || (selValue && d.date === sel)) && v > 0 ? `<b class="fxb-v">${fmtN(v)}${d.missing?.kcal ? '+' : ''}</b>` : '';
    return `<span class="${cls}" style="--h:${pc(Math.max(v, max / 80))}%;--d:${Math.round((i * 320) / n)}ms">${label}<span class="fxb-bar">${segs}</span></span>`;
  }).join('');
  const avgLine = num(avg) !== null ? `<span class="fxb-avg" style="bottom:${pc(avg)}%"></span>` : '';
  return `<div class="fxb${mini ? ' mini' : ''}${n > 40 ? ' dense' : n > 14 ? ' mid' : ''}" style="height:${height}px" aria-hidden="true">${avgLine}
    <div class="fxb-cols" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${cols}</div></div>`;
}

// The key under a chart of split columns: the parts that are on it, and the average line.
function barKeys(series, avgText = '') {
  const on = new Set(series.filter((d) => d.logged).flatMap((d) => macroParts(d).parts.filter((p) => p.kcal > 0).map((p) => p.key)));
  const keys = ['protein', 'carbs', 'fat', 'unknown'].filter((k) => on.has(k)).map((k) => `<span><i class="fdot m-${k}"></i>${MACRO_LABEL[k]}</span>`);
  if (series.some((d) => !d.logged)) keys.push('<span><i class="fk fk-gap"></i>No log</span>');
  if (avgText) keys.push(`<span><i class="fk fk-avg"></i>${avgText}</span>`);
  return keys.length ? `<p class="fx-keys">${keys.join('')}</p>` : '';
}

function axisLabels(series, today) {
  const n = series.length;
  if (n <= 7) {
    return `<div class="fx-axis cols" style="grid-template-columns:repeat(${n},minmax(0,1fr))" aria-hidden="true">${series.map((d) => `<span${d.date === today ? ' class="is-today"' : ''}>${d.date === today ? 'Today' : fmtDay(d.date, { weekday: 'short' })}</span>`).join('')}</div>`;
  }
  const mid = series[Math.floor(n / 2)].date;
  return `<div class="fx-axis" aria-hidden="true"><span>${fmtDay(series[0].date, { day: 'numeric', month: 'short' })}</span><span>${fmtDay(mid, { day: 'numeric', month: 'short' })}</span><span class="is-today">Today</span></div>`;
}

function kindTag(it) {
  const k = it.kind;
  return `<span class="tag ftag ftag-${k}">${KIND[k] || k}${it.market && k === 'product' ? `, ${esc(it.market)}` : ''}</span>`;
}

function slotSelect(value) {
  return `<label class="field"><span>Meal</span><select class="input" name="slot">${SLOTS.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
}

function slotNow(liquid = false) {
  if (liquid) return 'drinks';
  const h = new Date().getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 18 && h < 23) return 'dinner';
  return 'snacks';
}

function unitOptions(item, selected) {
  return unitsFor(item).map((u) => {
    const w = u.g ? ` · ${round(u.g, 1)} g` : u.ml ? ` · ${round(u.ml, 0)} ml` : '';
    return `<option value="${esc(u.unit)}"${u.unit === selected ? ' selected' : ''}>${esc(u.label)}${w}</option>`;
  }).join('');
}

// A sensible first amount: what he logged last time, a pack for packaged drinks, a "medium" for fruit.
function defaults(item) {
  const units = unitsFor(item);
  const has = (u) => units.some((x) => x.unit === u);
  if (item.last && has(item.last.unit)) return { qty: item.last.qty, unit: item.last.unit };
  if (item.liquid && item.pack?.unit === 'ml') return { qty: 1, unit: 'pack' };
  if (item.liquid && has('ml')) return { qty: 250, unit: 'ml' };
  if (item.serving) return { qty: 1, unit: 'serving' };
  const medium = units.find((u) => u.unit.startsWith('p:') && /\bmedium\b/i.test(u.label));
  if (medium) return { qty: 1, unit: medium.unit };
  return { qty: 100, unit: item.basis === 'ml' ? 'ml' : 'g' };
}

function quickChips(item) {
  const units = unitsFor(item);
  const has = (u) => units.some((x) => x.unit === u);
  const chips = [];
  if (item.pack) {
    chips.push([1, 'pack', item.pack.count > 1 ? 'Whole pack' : `${item.pack.unit === 'ml' ? 'Whole' : '1 pack'} (${round(item.pack.size, 0)} ${item.pack.unit})`]);
    chips.push([0.5, 'pack', 'Half']);
    if (item.pack.count > 1) chips.push([1, 'each', `One of ${item.pack.count}`]);
  }
  if (item.serving) chips.push([1, 'serving', item.serving.label || `1 serving (${round(item.serving.size, 0)} ${item.serving.unit})`]);
  if (has('ml')) for (const ml of [250, 330, 500]) chips.push([ml, 'ml', `${ml} ml`]);
  for (const u of units.filter((x) => x.unit.startsWith('p:') && !/US cup/.test(x.label)).slice(0, 3)) chips.push([1, u.unit, u.label.replace(/^1 /, '').replace(/\s*\([^)]*\)\s*$/, '') || u.label]);
  if (!has('ml') || !item.liquid) for (const g of [50, 100]) chips.push([g, 'g', `${g} g`]);
  return chips.slice(0, 8).map(([q, u, l]) => `<button type="button" class="pchip-btn" data-action="food-chip" data-qty="${q}" data-unit="${esc(u)}">${esc(l)}</button>`).join('');
}

function previewHtml(item, qty, unit, filled = null) {
  const l = line(item, qty, unit);
  if (l.error) return `<p class="note bad">${esc(l.error)}</p>`;
  const amt = l.g !== null && l.basis === 'g' ? `${round(l.g, 1)} g` : l.ml !== null ? `${round(l.ml, 0)} ml` : '';
  return `<div class="fprev"><div class="fprev-main"><b>${val(l.nutrients, 'kcal', filled)}</b><span>${esc(amt)}${l.note ? `, ${esc(l.note)}` : ''}</span></div>
    ${strip(l.nutrients, STRIP, filled)}</div>`;
}

// The facts for a food: the portion on screen, or per 100 of its basis.
function itemFacts(s) {
  const { item, filled } = withFill(s.item, s.fill);
  if (s.per === '100') return factsHtml(item.nutrients, filled);
  const l = line(item, s.qty, s.unit);
  return l.error ? '' : factsHtml(l.nutrients, filled);
}

const sourceLine = (it) => `${esc(it.sourceText || it.source || '')}${it.source_date ? `, ${esc(it.source_date)}` : ''}`;

// Where a diary entry's filled values ("~") came from, one short line under its facts: "Vitamins and
// minerals filled from USDA: Cola. Values from mcdonalds.com." The wording is the shared maths'.
function fillSourceHtml(src) {
  const parts = N.fillSourceParts?.(src) || [];
  if (!parts.length) return '';
  const html = parts.map((p) => `${esc(p.text)}${p.link ? `<a href="${esc(p.link.url)}" target="_blank" rel="noopener">${esc(p.link.text)}</a>` : ''}`);
  return `<p class="nf-none nf-from">${html.join('. ')}.</p>`;
}

// ---------- The diary ----------

function dateLabel(d) {
  if (!d) return '';
  if (d.today) return 'Today';
  return fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long' });
}

function entryRow(e) {
  const fl = filledSet(e.filled);
  const est = e.estimate || fl.has('kcal');
  const tag = topTag(e.tags);
  return `<button class="li li-plain food-row" data-action="food-entry" data-eid="${esc(e.id)}" data-swipe="remove">
    ${foodRing(e.nutrients, e.grade)}
    <span class="li-body"><span class="li-title">${esc(e.name)}</span>
    <span class="li-sub">${e.brand ? `<span class="fr-brand">${esc(e.brand)}</span>` : ''}<span class="fr-amt">${esc(e.amountText || '')}</span>${tag ? tagMini(tag) : ''}</span></span>
    <span class="li-side"><b>${est ? '<i class="est">~</i>' : ''}${show(e.nutrients, 'kcal', { unit: false })}</b><small>kcal</small></span></button>`;
}

function pendingRows(date) {
  const q = queue().filter((x) => (x.preview?.date || localToday()) === date);
  if (!q.length) return '';
  return `<section class="section"><div class="gh"><h2>Waiting to sync</h2><span class="gh-count">${icon('sync')}${q.length}</span></div>
    <div class="group">${q.map((x) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(x.preview?.name || 'Entry')}</span>
      <span class="li-sub">${esc(x.preview?.amount || '')}</span></span><span class="li-side">${x.preview?.kcal !== undefined ? `<b>${round(x.preview.kcal, 0)}</b> kcal` : ''}</span></div>`).join('')}</div></section>`;
}

function trayHtml(list, skip = new Set()) {
  const rest = (list || []).filter((it) => !skip.has(it.key));
  if (!rest.length) return '';
  return `<div class="tray" role="list" aria-label="Log again">${rest.slice(0, 10).map((it) => {
    const d = defaults(it);
    return `<button class="tray-chip" role="listitem" data-action="food-tray" data-key="${esc(it.key)}">${it.favourite ? icon('star', 'star-on') : ''}<span>${esc(it.name)}</span><small>${esc(amountText(d.qty, d.unit, it))}</small></button>`;
  }).join('')}</div>`;
}

function batchesHtml(list) {
  if (!list?.length) return '';
  return `<section class="section"><div class="gh"><h2>Cooked batches</h2></div><div class="group">${list.map((b) => {
    const left = b.left.g !== null ? `${round(b.left.g, 0)} of ${round(b.final_weight, 0)} g left` : `${round(b.left.servings, 1)} of ${round(b.servings, 1)} servings left`;
    return `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(b.name)}</span><span class="li-sub">${esc(left)} · ${fmtDay(b.cookedOn)}</span></span>
      <span class="li-side batch-actions"><button class="btn tinted small" data-action="food-batch-log" data-id="${b.id}">Have some</button><button class="btn plain small" data-action="food-batch-done" data-id="${b.id}">Finished</button></span></div>`;
  }).join('')}</div></section>`;
}

function plansHtml(list) {
  if (!list?.length) return '';
  return `<section class="section"><div class="gh"><h2>Planned</h2></div><div class="group">${list.map((p) => `
    <div class="li li-plain"><span class="li-body"><span class="li-title">${esc(p.name)}</span><span class="li-sub">${SLOT[p.slot] || p.slot}${p.qty ? ` · ${esc(amountText(p.qty, p.unit || 'serving'))}` : ''}</span></span>
    <span class="li-side batch-actions"><button class="btn tinted small" data-action="food-plan-eat" data-id="${p.id}">Eaten</button><button class="icon-btn" data-action="food-plan-del" data-id="${p.id}" aria-label="Remove plan">${icon('close')}</button></span></div>`).join('')}</div></section>`;
}

// One small affordance per screen that says what the marks mean.
function infoBtn(key) {
  const open = Boolean(f().info?.[key]);
  return `<button type="button" class="finfo-btn${open ? ' on' : ''}" data-action="food-info" data-key="${key}" aria-expanded="${open}" aria-label="What the marks mean">i</button>`;
}
function infoLine(key, extra = '') {
  if (!f().info?.[key]) return '';
  return `<p class="finfo"><span><i class="est">~</i> estimate</span><span><b>+</b> at least</span><span><b>–</b> unknown</span>${extra}</p>`;
}

function viewDiary() {
  const F = f();
  const d = F.day;
  const head = pageHead('Food', {
    actions: `<a class="icon-btn" href="#/food/trends" aria-label="Trends">${icon('trend')}</a><a class="icon-btn" href="#/food/recipes" aria-label="Recipes">${icon('recipe')}</a><a class="icon-btn" href="#/food/meals" aria-label="Saved meals">${icon('star')}</a>`,
  });
  if (!d) return ctx.shell(`${head}<div class="skeleton"><i></i><i></i><i class="short"></i></div>${sheetHtml()}`);
  const t = d.total;
  const anim = enter('diary');
  const slots = SLOTS.map(([s, label]) => {
    const sl = d.slots.find((x) => x.slot === s);
    if (!sl?.entries.length) return '';
    return `<section class="section fslot fslot-${s}"><div class="gh"><h2><span class="fslot-ic" aria-hidden="true">${icon(SLOT_ICON[s])}</span>${label}</h2><span class="gh-side"><span class="gh-count">${kcal(sl.total)}</span>${slotAction(d, s)}</span></div>${mealBar(sl.total, num(t.kcal))}<div class="group">${sl.entries.map(entryRow).join('')}</div></section>`;
  }).join('');
  const undo = F.undo ? `<div class="banner food-undo"><span>${F.undo.verb || 'Removed'} ${esc(F.undo.name)}.</span><button class="btn tinted small" data-action="food-undo">Undo</button></div>` : '';
  const empty = !d.entries.length ? `<div class="card fempty"><p>Nothing logged${d.today ? ' yet' : ''}</p></div>` : '';
  const offline = F.offline ? `<div class="banner offline">${icon('clock')}<span><b>Offline.</b> New entries sync later.</span></div>` : '';
  const repeat = d.today ? `<div class="form-actions food-repeat"><button class="btn tinted small" data-action="food-repeat">${icon('review')}Repeat yesterday</button></div>` : '';
  ctx.shell(`${head}${offline}${undo}<div class="split fdiary${anim}">
    <div class="fcol fcol-a"><div class="fd-cap">${captureHtml()}${takeHtml('day')}</div><div class="fd-meals">${pendingRows(d.date)}${slots}${empty}${emptySlotsHtml(d)}${repeat}</div></div>
    <div class="fcol fcol-b"><div class="fd-sum">${daySummary(d)}</div><div class="fd-side">${nextCardHtml(d)}${burnTile(F.energy)}${trendPreview(F.week)}${plansHtml(d.plans)}${batchesHtml(F.batches)}</div></div>
    </div>${sheetHtml()}`);
}

// The two ways in sit in one bar: the camera, and the words, which open the food chat. A photo taken
// here is read in the chat too. Everything else is a tap below.
function captureHtml() {
  const tools = [
    ['food-scan', 'barcode', 'Scan', ''],
    ['food-search', 'search', 'Search', ''], ['food-quick', 'bolt', 'Quick add', ''], ['food-search', 'drink', 'Drinks', ' data-drinks="1"'],
    ['food-builder', 'blend', 'Shake', ' data-mode="shake"'], ['food-builder', 'bowl', 'Bowl', ' data-mode="bowl"'], ['food-builder', 'food', 'Plate', ' data-mode="plate"'],
  ];
  const waiting = chatWaiting();
  return `<section class="fcap" aria-label="Log food">
    <div class="fcap-bar">
      <label class="fcap-cam" title="Snap your food">${icon('camera')}<span class="sr">Snap your food: a plate, a label or a barcode</span>
        <input class="vh" type="file" accept="image/*" capture="environment" data-chat-photo></label>
      <button type="button" class="fcap-open" data-action="food-chat-open"><span class="fcap-q">What did you eat?</span>
        <span class="fcap-hint">${waiting ? `<i class="fcap-dot" aria-hidden="true"></i>${esc(waiting)}` : 'Type it the way you would say it'}</span></button>
      <button type="button" class="fcap-send" data-action="food-chat-open" aria-label="Open the food chat">${icon('chat')}</button>
    </div>
    ${usualHtml()}
    <div class="fcap-tools" role="group" aria-label="More ways to log">${tools.map(([a, ic, l, extra]) => `<button type="button" class="fcap-tool" data-action="${a}"${extra}>${icon(ic)}<span>${l}</span></button>`).join('')}</div>
    ${trayHtml(f().recent, usualItemKeys())}
  </section>`;
}

const KEY_MICROS = ['iron', 'calcium', 'potassium', 'vitc', 'vitd', 'b12'];

// What the day's energy and macros are measured against, said the way the card says it.
const ofNeed = () => (needs() ? 'of your need' : 'of the RI');

// Protein, carbs and fat under the ring: grams so far against the day's amount, and each one's share of
// the energy. Protein is one to reach; carbs and fat only say so when they go past theirs.
function macroCols(t, fl) {
  const { parts, sum } = macroParts(t);
  return `<div class="fmcs">${MACROS.map(([k]) => {
    const ref = refAt(k);
    const v = num(t[k]);
    const p = ref && v !== null ? (v / ref) * 100 : null;
    const kc = parts.find((x) => x.key === k)?.kcal || 0;
    const tone = p === null ? ' unk' : p >= 100 ? (k === 'protein' ? ' full' : ' over') : '';
    const spoken = `${MACRO_LABEL[k]}: ${v === null ? 'not known' : `${show(t, k)}${ref ? ` of ${fmtN(ref)} g, ${fmtN(p)}%` : ''}`}${sum > 0 ? `, ${share(kc, sum)}% of the energy` : ''}`;
    return `<div class="fmc m-${k}${tone}" role="img" aria-label="${esc(spoken)}">
      <span class="fmc-k" aria-hidden="true"><span>${MACRO_LABEL[k]}</span>${sum > 0 && kc > 0 ? `<small>${share(kc, sum)}%</small>` : ''}</span>
      <b class="fmc-v" aria-hidden="true">${v === null ? '–' : `${fl.has(k) ? '<i class="est">~</i>' : ''}${fmtN(v)}${t.missing?.[k] ? '+' : ''}<small>g</small>`}</b>
      <span class="fmc-bar" aria-hidden="true"><i style="--p:${Math.min(100, p ?? 0).toFixed(1)}"></i></span>
      <span class="fmc-of" aria-hidden="true">${ref ? `of ${fmtN(ref)} g` : ''}</span></div>`;
  }).join('')}</div>`;
}

// The day at a glance. The ring is the day's energy against its need, its arc split by where the
// energy came from; under it protein, carbs and fat against theirs; then six vitamins and minerals on
// the eased scale, the energy by Nutri-Score, water from drinks, and the rest in a strip.
function daySummary(d) {
  const t = d.total;
  const has = d.entries.length > 0;
  const fl = new Set(d.entries.flatMap((e) => e.filled || []));
  const need = refAt('kcal');
  const kcal = num(t.kcal);
  const floor = Boolean(t.missing?.kcal);
  const center = `<b>${has ? show(t, 'kcal', { unit: false }) : '0'}</b><small>${need ? `of ${fmtN(need)} kcal` : 'kcal'}</small>`;
  let left = '';
  if (need && kcal !== null && has) {
    const diff = need - kcal;
    if (!d.today) left = `<p class="fday-left"><b>${fmtN((kcal / need) * 100)}%${floor ? '+' : ''}</b> ${ofNeed()}</p>`;
    else if (diff >= 0) left = `<p class="fday-left"><b>${floor ? 'At most ' : ''}${fmtN(diff)}</b> kcal left</p>`;
    else left = `<p class="fday-left over"><b>${floor ? 'At least ' : ''}${fmtN(-diff)}</b> kcal over</p>`;
  } else if (d.today && need) left = `<p class="fday-left"><b>${fmtN(need)}</b> kcal to go</p>`;
  const unknown = macroParts(t).parts.find((p) => p.key === 'unknown');
  const unk = unknown ? `<p class="fday-unk"><i class="fdot m-unknown" aria-hidden="true"></i><span><b>${fmtN(unknown.kcal)} kcal</b> from foods with no protein, carbs or fat on record</span></p>` : '';
  // Each tile opens the foods richest in it.
  const micros = `<div class="fmicro">${KEY_MICROS.map((k) => {
    const p = riPct(t, k);
    const done = p !== null && p >= 100;
    return `<button type="button" class="fmicro-i${p === null ? ' unk' : ''}${done ? ' done' : ''}" data-action="food-rich" data-key="${k}" aria-label="${esc(`${shortLabel(k)} ${pctText(p, t.missing?.[k])}. Foods rich in it`)}">
      <span class="fmicro-k"><span>${shortLabel(k)}</span>${icon('chevron', 'tap-hint')}</span><b>${pctText(p, t.missing?.[k])}${done ? icon('check', 'fmicro-ok') : ''}</b>${riBar(p, k)}</button>`;
  }).join('')}</div>`;
  const extra = ['sugars', 'satfat', 'salt', 'fibre', 'caffeine', 'alcohol'];
  const facts = `<dl class="fday-strip">${extra.map((k) => {
    const p = riPct(t, k);
    return `<div class="fst${riTone(p, k)}"><dt>${shortLabel(k)}</dt><dd>${val(t, k, fl)}</dd>${refAt(k) && p !== null ? riBar(p, k) : ''}</div>`;
  }).join('')}</dl>`;
  // Water from drinks against a reference (35 ml per kg, else 2,000 ml), with one-tap water on today.
  const water = waterHtml(d);
  const mix = has ? gradeMix(d.grades) : '';
  return `<section class="card fday" aria-label="${esc(dateLabel(d))}">
    <div class="fday-head"><h2>${esc(dateLabel(d))}</h2><div class="fday-nav">
      <button class="icon-btn" data-action="food-day" data-step="-1" aria-label="Previous day">${icon('back')}</button>
      <button class="icon-btn" data-action="food-day" data-step="1" aria-label="Next day"${d.today ? ' disabled' : ''}>${icon('chevron')}</button></div></div>
    <div class="fday-hero">${energyRing(t, need, { center, grow: Boolean(enter(`ring-${d.date}`)) })}${left}</div>
    ${macroCols(t, fl)}${unk}
    ${has ? `<div class="fday-sec"><p class="fday-k"><span>Vitamins and minerals</span><small>% ${ofNeed()}</small></p>${micros}</div>` : ''}
    ${mix ? `<div class="fday-sec"><p class="fday-k"><span>Nutri-Score</span><small>share of energy</small></p>${mix}</div>` : ''}
    ${has ? `<div class="fday-sec">${water}${facts}</div>` : d.today ? `<div class="fday-sec">${water}</div>` : ''}
    ${has ? `<div class="fday-foot">${infoBtn('day')}<button class="gh-link" data-action="food-daynut">All nutrients${icon('chevron')}</button></div>${infoLine('day')}` : ''}
  </section>`;
}

// A small link to Trends: the last seven days as bars and their average.
function trendPreview(w) {
  if (!w?.series) return '';
  const avg = num(w.avg?.kcal);
  return `<a class="card ftrend" href="#/food/trends">
    <span class="ftrend-bars">${barsHtml(w.series, { height: 44, sel: w.today, selValue: false, avg: w.avg?.kcal, mini: true })}</span>
    <span class="ftrend-words"><span class="eyebrow">Trends</span><b>${avg === null ? '–' : `${fmtN(avg)}${w.avg.missing?.kcal ? '+' : ''}`}<small> kcal a day</small></b></span>
    ${icon('chevron', 'chev')}</a>`;
}

// ---------- Sheets ----------

function sheetWrap(title, body, cls = '') {
  return `<div class="sheet-backdrop" data-action="food-close"></div>
  <div class="sheet food-sheet ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-action="food-close" aria-label="Close">${icon('close')}</button></div>
    ${body}
  </div>`;
}

function resultRow(it) {
  const per = it.nutrients?.kcal === null || it.nutrients?.kcal === undefined ? 'energy unknown' : `${round(it.nutrients.kcal, 0)} kcal / 100 ${it.liquid && it.density ? 'g' : it.basis}`;
  return `<button class="li li-plain fr" data-action="food-pick" data-key="${esc(it.key)}">${gradeDot(itemGrade(it))}
    <span class="li-body"><span class="li-title">${esc(it.name)}${it.brand ? ` <small class="faint">${esc(it.brand)}</small>` : ''}</span>
    <span class="li-sub">${it.pack ? `${esc(amountText(1, 'pack', it))} · ` : ''}${it.state ? `${esc(it.state.replace(/-/g, ' '))} · ` : ''}${per}${it.kind !== 'generic' ? ` ${kindTag(it)}` : ''}</span></span>${icon('chevron', 'chev')}</button>`;
}

function resultsHtml(s) {
  const list = s.results ?? (s.drinks ? f().drinks : f().recent) ?? [];
  const label = s.results ? (s.results.length ? '' : `<p class="note">Nothing for "${esc(s.q)}".</p>`) : list.length ? '<p class="eyebrow">Recent</p>' : '';
  return `${label}<div class="group">${list.map(resultRow).join('')}</div>`;
}

function searchBody(s) {
  return `<form data-form="food-search" class="food-search has-scan" role="search">
      <input class="input" type="search" name="q" value="${esc(s.q || '')}" placeholder="${s.drinks ? 'Search drinks' : 'Search foods and drinks'}" data-food-q autocomplete="off" enterkeyhint="search" aria-label="Search">
      <button type="button" class="icon-btn fscan-btn" data-action="food-scan" aria-label="Scan a barcode">${icon('barcode')}</button>
    </form>
    <div id="food-results">${resultsHtml(s)}</div>
    ${s.pick ? fixExtras(s) : `<div class="food-none"><p class="eyebrow">Not here?</p>
      <div class="sheet-actions">
        ${s.q ? `<button class="btn tinted" data-action="food-off">${icon('search')}Search Open Food Facts for "${esc(s.q)}"</button>` : ''}
        <label class="btn tinted">${icon('camera')}Photo of the label or barcode<input class="vh" type="file" accept="image/*" capture="environment" data-food-photo></label>
        <button class="btn tinted" data-action="food-custom">${icon('plus')}Add a food of your own</button>
        <button class="btn tinted" data-action="food-quick">${icon('bolt')}Quick add calories</button>
      </div></div>`}`;
}

// A food: its grades and tags, the amount, then the full nutrition facts per portion or per 100.
function foodBody(s) {
  const it = s.item;
  const pickText = s.pick ? ({ 'recipe-swap': 'Swap in', chat: 'Use this' }[s.pick.purpose] || 'Add') : 'Log it';
  const g = itemGrade(it);
  const nova = novaBadge(it.nova);
  const sub = [it.brand, it.pack ? amountText(1, 'pack', it) : null, it.state ? it.state.replace(/-/g, ' ') : null].filter(Boolean).map(esc).join(' · ');
  const per = s.per === '100' ? '100' : 'portion';
  const { filled } = withFill(it, s.fill);
  const record = it.source_ref?.startsWith('http') ? ` · <a href="${esc(it.source_ref)}" target="_blank" rel="noopener">record</a>` : '';
  return `<div class="fd-head">${sub ? `<p class="fd-sub">${sub}</p>` : ''}
      ${g || nova ? `<div class="fd-badges">${nutriBadge(g)}${nova}</div>` : ''}
      ${tagChips(itemTags(it))}
      ${it.check ? `<p class="note bad">${esc(it.check)}</p>` : ''}${it.status === 'needs-label' ? '<p class="note">No values yet. Add the label to log it.</p>' : ''}</div>
    <form data-form="food-log" class="food-amount">
      <div class="amount-row"><input class="input" name="qty" inputmode="decimal" value="${esc(s.qty)}" data-food-amount aria-label="Amount">
        <select class="input" name="unit" data-food-amount aria-label="Unit">${unitOptions(it, s.unit)}</select></div>
      <div class="pchips">${quickChips(it)}</div>
      <div id="food-preview">${previewHtml(withFill(it, s.fill).item, s.qty, s.unit, filled)}</div>
      ${s.pick ? '' : slotSelect(s.slot || slotNow(it.liquid))}
      <div class="form-actions"><button class="btn primary" type="submit">${pickText}</button>
        ${s.pick ? '' : `<button class="btn tinted" type="button" data-action="food-plan-open">Plan for later</button>
        <button class="icon-btn${it.favourite ? ' on' : ''}" type="button" data-action="food-fav" aria-pressed="${it.favourite ? 'true' : 'false'}" aria-label="Favourite">${icon('star')}</button>`}</div>
    </form>
    <section class="nf" aria-label="Nutrition facts">
      <div class="nf-top"><h3>Nutrition</h3><div class="seg small nf-seg" role="radiogroup" aria-label="Values per">
        <label><input type="radio" name="nf-per" value="portion" data-food-per${per === 'portion' ? ' checked' : ''}><span>Portion</span></label>
        <label><input type="radio" name="nf-per" value="100" data-food-per${per === '100' ? ' checked' : ''}><span>100 ${it.basis === 'ml' ? 'ml' : 'g'}</span></label></div></div>
      <div id="food-facts">${itemFacts({ ...s, per })}</div>
    </section>
    <p class="fd-src">${sourceLine(it)}${record}</p>`;
}

function quickBody(s) {
  const n = (name, label, unit) => `<label class="field"><span>${label}${unit ? ` (${unit})` : ''}</span><input class="input" name="${name}" inputmode="decimal" placeholder="unknown"></label>`;
  return `<form data-form="food-quick" class="sheet-form">
    <label class="field"><span>What was it?</span><input class="input" name="name" placeholder="Quick add" maxlength="120"></label>
    <label class="field"><span>Calories (kcal)</span><input class="input" name="kcal" inputmode="decimal" required></label>
    <div class="grid2">${n('protein', 'Protein', 'g')}${n('carbs', 'Carbs', 'g')}${n('sugars', 'Sugars', 'g')}${n('fat', 'Fat', 'g')}${n('caffeine', 'Caffeine', 'mg')}${n('ml', 'Drink volume', 'ml')}</div>
    ${slotSelect(s.slot || slotNow())}
    <div class="form-actions"><button class="btn primary" type="submit">Log it</button></div></form>`;
}

function customBody(s) {
  const d = s.draft || {};
  const nv = (k) => (d.nutrients?.[k] === null || d.nutrients?.[k] === undefined ? '' : round(d.nutrients[k], 3));
  const n = (k, label, unit) => `<label class="field"><span>${label} (${unit})</span><input class="input" name="n_${k}" inputmode="decimal" value="${nv(k)}" placeholder="unknown"${k === 'kcal' ? ' required' : ''}></label>`;
  const basis = d.basis === 'ml' ? 'ml' : 'g';
  return `<form data-form="food-custom" class="sheet-form">
    ${(d.warnings || []).map((w) => `<p class="note bad">${esc(w)}</p>`).join('')}
    <label class="field"><span>Name</span><input class="input" name="name" value="${esc(d.name || '')}" required maxlength="160"></label>
    <div class="grid2"><label class="field"><span>Brand</span><input class="input" name="brand" value="${esc(d.brand || '')}"></label>
      <label class="field"><span>Barcode</span><input class="input mono" name="barcode" inputmode="numeric" value="${esc(d.barcode || '')}"></label></div>
    <fieldset class="field"><span>Values are per</span><div class="seg"><label><input type="radio" name="basis" value="g"${basis === 'g' ? ' checked' : ''}><span>100 g</span></label><label><input type="radio" name="basis" value="ml"${basis === 'ml' ? ' checked' : ''}><span>100 ml</span></label></div></fieldset>
    <div class="grid2">${n('kcal', 'Energy', 'kcal')}${n('protein', 'Protein', 'g')}${n('carbs', 'Carbohydrate', 'g')}${n('sugars', 'of which sugars', 'g')}${n('fat', 'Fat', 'g')}${n('satfat', 'of which saturates', 'g')}${n('fibre', 'Fibre', 'g')}${n('salt', 'Salt', 'g')}${n('caffeine', 'Caffeine', 'mg')}${n('alcohol', 'Alcohol', 'g')}</div>
    <div class="grid2"><label class="field"><span>Package size (g or ml)</span><input class="input" name="pack_size" inputmode="decimal" value="${esc(d.pack?.size || '')}" placeholder="500"></label>
      <label class="field"><span>Items inside</span><input class="input" name="pack_count" inputmode="numeric" value="${esc(d.pack?.count || '')}" placeholder="1"></label>
      <label class="field"><span>Serving size (g or ml)</span><input class="input" name="serving_size" inputmode="decimal" value="${esc(d.serving?.size || '')}"></label>
      <label class="field"><span>Serving name</span><input class="input" name="serving_label" value="${esc(d.serving?.label || '')}" placeholder="1 scoop"></label></div>
    <div class="form-actions"><button class="btn primary" type="submit">Save and log</button></div></form>`;
}

// The review for a photographed plate or a typed meal. Each food is matched to a record with an
// estimated amount; a typed food with no record keeps a rough estimate and logs as an estimated
// quick add. Nothing is logged until Log all.
function reviewItem(it) {
  const { item, filled } = withFill(it.match, it.fill);
  const l = item && Number(it.qty) > 0 ? line(item, it.qty, it.unit) : null;
  if (l && !l.error) return { mode: 'match', line: l, filled };
  if (num(it.guess?.kcal) !== null) return { mode: 'rough' };
  return { mode: 'none', error: l?.error || null };
}

function roughAmount(g) {
  if (num(g?.amount) === null || !(g.amount > 0)) return '';
  const q = round(g.amount, g.unit === 'piece' ? 1 : 0);
  return g.unit === 'piece' ? `about ${q} ${q === 1 ? 'piece' : 'pieces'}` : `about ${q} ${g.unit}`;
}

function reviewKcal(it) {
  const m = reviewItem(it);
  const est = it.edited ? '' : '<i class="est">~</i>';
  if (m.mode === 'match') return `${est || (m.filled.has('kcal') ? '<i class="est">~</i>' : '')}${show(m.line.nutrients, 'kcal')}`;
  if (m.mode === 'rough') return `<i class="est">~</i>${fmtN(it.guess.kcal)} kcal`;
  return '';
}

function reviewBody(s) {
  const r = s.result;
  const modes = s.items.map(reviewItem);
  const rows = s.items.map((it, i) => {
    const m = modes[i];
    const brand = it.brand ?? it.match?.brand ?? null;
    const size = it.size ?? (it.match?.pack ? amountText(1, 'pack', it.match) : null);
    const names = [brand, size].filter(Boolean).map(esc).join(' · ');
    const sub = it.match ? names : m.mode === 'rough' ? esc(roughAmount(it.guess)) : 'No match';
    return `<div class="li li-plain photo-item">
      ${gradeDot(itemGrade(it.match))}
      <span class="li-body"><span class="li-title">${esc(it.match?.name || cap(it.name))}</span>
        <span class="li-sub">${sub}${sub ? ' · ' : ''}<button class="linkish" data-action="food-photo-change" data-index="${i}">Change</button></span>
        ${it.why && it.match ? `<span class="frv-why">${esc(it.why)}</span>` : ''}</span>
      <span class="li-side"><b data-photo-kcal="${i}">${reviewKcal(it)}</b><button class="icon-btn" data-action="food-photo-drop" data-index="${i}" aria-label="Remove">${icon('close')}</button></span>
      ${it.match ? `<span class="amount-row small photo-amount"><input class="input" inputmode="decimal" value="${esc(it.qty ?? '')}" placeholder="amount" data-photo-index="${i}" data-photo-field="qty" aria-label="Amount">
        <select class="input" data-photo-index="${i}" data-photo-field="unit" aria-label="Unit">${unitOptions(it.match, it.unit)}</select></span>` : ''}</div>`;
  }).join('');
  const n = modes.filter((m) => m.mode !== 'none').length;
  const sum = modes.reduce((a, m, i) => a + (m.mode === 'match' ? num(m.line.nutrients.kcal) || 0 : m.mode === 'rough' ? num(s.items[i].guess.kcal) || 0 : 0), 0);
  return `<div class="frv-top"><p class="frv-sum">${r.summary ? esc(r.summary) : `${s.items.length} ${s.items.length === 1 ? 'item' : 'items'}`}</p>${sum ? `<b class="frv-total"><i class="est">~</i>${fmtN(sum)} kcal</b>` : ''}${infoBtn('review')}</div>
    ${infoLine('review')}
    <div class="group photo-items">${rows || '<p class="note pad">Nothing left to log.</p>'}</div>
    <form data-form="food-photo-log">${slotSelect(slotNow())}<div class="form-actions"><button class="btn primary" type="submit"${n ? '' : ' disabled'}>${n === s.items.length ? 'Log all' : `Log ${n} of ${s.items.length}`}</button></div></form>`;
}

function photoBody(s) {
  if (s.busy) return '<div class="photo-busy"><div class="msg assistant typing" aria-label="Reading the photo"><i></i><i></i><i></i></div></div>';
  const r = s.result;
  if (!r) return '';
  if (r.kind === 'meal') return reviewBody(s);
  if (r.kind === 'product') {
    return `${r.summary ? `<p class="note">${esc(r.summary)}</p>` : ''}<div class="group">${resultRow(r.item)}</div>`;
  }
  if (r.kind === 'product-unknown') {
    const name = [r.read?.brand, r.read?.name, r.read?.variant].filter(Boolean).join(' ');
    return `<p class="note">${r.barcode ? `Barcode ${esc(r.barcode)} is not in Oath or Open Food Facts.` : r.unreadBarcode ? 'The barcode could not be read.' : 'No barcode found.'}${name ? ` Looks like <b>${esc(name)}</b>.` : ''}${r.offError ? ` (${esc(r.offError)})` : ''}</p>
      ${r.suggestions?.length ? `<p class="eyebrow">Close matches</p><div class="group">${r.suggestions.map(resultRow).join('')}</div>` : ''}
      <div class="sheet-actions"><label class="btn primary">${icon('camera')}Photo of the nutrition label<input class="vh" type="file" accept="image/*" capture="environment" data-food-photo></label>
      <button class="btn tinted" data-action="food-custom" data-from-photo="1">${icon('plus')}Type the label in</button>
      <button class="btn tinted" data-action="food-quick">${icon('bolt')}Quick add calories</button></div>`;
  }
  return `<p class="note">${esc(r.question || 'What is it?')}</p><div class="sheet-actions">
    <button class="btn tinted" data-action="food-search">${icon('search')}Search</button><button class="btn tinted" data-action="food-quick">${icon('bolt')}Quick add</button></div>`;
}

// A diary entry: its grade and tags, the amount to change, and what it brought, with any estimated
// values marked.
function entryBody(s) {
  const e = s.entry;
  const fl = filledSet(e.filled);
  const nova = novaBadge(e.nova);
  const lines = e.lines?.length ? `<p class="eyebrow fd-eyebrow">What went in</p><div class="group">${e.lines.map((l) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(l.name)}</span><span class="li-sub">${esc(l.amount_text || '')}</span></span><span class="li-side">${l.nutrients ? kcal(l.nutrients) : ''}</span></div>`).join('')}</div>` : '';
  const amount = s.item ? `<form data-form="food-entry-edit"><div class="amount-row"><input class="input" name="qty" inputmode="decimal" value="${esc(e.qty)}" data-food-amount aria-label="Amount">
      <select class="input" name="unit" data-food-amount aria-label="Unit">${unitOptions(s.item, e.unit)}</select></div>
      <div id="food-preview">${previewHtml(s.item, e.qty, e.unit, fl)}</div>${slotSelect(e.slot)}
      <div class="form-actions"><button class="btn primary" type="submit">Save</button></div></form>`
    : `<div class="fprev"><div class="fprev-main"><b>${e.estimate ? '<i class="est">~</i>' : ''}${val(e.nutrients, 'kcal', fl)}</b><span>${esc(e.amountText || '')}</span></div>${strip(e.nutrients, STRIP, fl)}</div>
      <form data-form="food-entry-edit">${slotSelect(e.slot)}<div class="form-actions"><button class="btn tinted" type="submit">Move</button></div></form>`;
  return `<div class="fd-head">${e.grade || nova ? `<div class="fd-badges">${nutriBadge(e.grade)}${nova}</div>` : ''}${tagChips(e.tags || [])}</div>
    ${amount}
    <section class="nf" aria-label="Nutrition facts"><div class="nf-top"><h3>Nutrition</h3><span class="nf-per">${esc(e.amountText || 'as logged')}</span></div>${factsHtml(e.nutrients, fl)}${fillSourceHtml(e.fillSource)}</section>
    ${lines}
    <div class="sheet-actions"><button class="btn tinted danger-text" data-action="food-entry-del" data-eid="${esc(e.id)}">${icon('trash')}Remove from the diary</button></div>`;
}

// Everything the day adds up to, as one nutrition label.
function dayNutBody() {
  const d = f().day;
  if (!d) return '';
  const fl = new Set(d.entries.flatMap((e) => e.filled || []));
  return `<div class="fprev"><div class="fprev-main"><b>${val(d.total, 'kcal', fl)}</b><span>${d.entries.length} ${d.entries.length === 1 ? 'item' : 'items'}</span></div>${strip(d.total, STRIP, fl)}</div>
    ${gradeMix(d.grades) ? `<div class="nf-mix">${gradeMix(d.grades)}</div>` : ''}
    <section class="nf" aria-label="Nutrition facts"><div class="nf-top"><h3>Nutrition</h3></div>${factsHtml(d.total, fl, { tap: true })}</section>`;
}

function builderTotals(s) {
  const rows = s.lines.map((l) => (l.ref === 'recipe' ? { nutrients: scale(l.per, l.qty, 1) } : line(l.item, l.qty, l.unit)));
  const bad = rows.find((r) => r.error);
  const whole = total(rows.map((r) => r.nutrients || {}));
  const factor = shareFactor(s);
  const had = scale(whole, factor, 1);
  return `${bad ? `<p class="note bad">${esc(bad.error)}</p>` : ''}
    <div class="fprev"><div class="fprev-main"><b>${kcal(had)}</b><span>${factor === 1 ? 'all of it' : `${round(factor * 100, 0)}% of ${kcal(whole)}`}</span></div>${strip(had)}</div>`;
}

function shareFactor(s) {
  const m = Number(s.measured);
  const h = Number(s.had);
  if (m > 0 && h > 0) return Math.min(h / m, 1);
  return s.share || 1;
}

function builderBody(s) {
  const B = BUILDERS[s.mode] || BUILDERS.meal;
  const groups = B.groups.map(([g, label]) => {
    const ls = s.lines.map((l, i) => ({ l, i })).filter(({ l }) => (l.group || B.groups[0][0]) === g || (B.groups.length === 1));
    return `<div class="bgroup"><div class="bgroup-head"><h3>${label}</h3><button class="gh-link" type="button" data-action="food-bl-add" data-group="${g}">${icon('plus')}Add</button></div>
      ${ls.length ? `<div class="group">${ls.map(({ l, i }) => `<div class="li li-plain bline">
        <span class="li-body"><span class="li-title">${esc(l.ref === 'recipe' ? l.name : l.item.name)}</span>
        ${l.ref === 'recipe' ? `<span class="li-sub">${esc(amountText(l.qty, 'serving'))} · recipe</span>`
          : `<span class="amount-row small"><input class="input" inputmode="decimal" value="${esc(l.qty)}" data-bl-index="${i}" data-bl-field="qty" aria-label="Amount">
          <select class="input" data-bl-index="${i}" data-bl-field="unit" aria-label="Unit">${unitOptions(l.item, l.unit)}</select></span>`}</span>
        <span class="li-side">${l.ref === 'recipe' ? '' : `<button class="btn plain small" type="button" data-action="food-bl-swap" data-index="${i}">Swap</button>`}<button class="icon-btn" type="button" data-action="food-bl-drop" data-index="${i}" aria-label="Remove">${icon('close')}</button></span></div>`).join('')}</div>` : ''}</div>`;
  }).join('');
  const shares = [[1, 'All'], [0.5, 'Half'], [1 / 3, 'A third'], [0.25, 'A quarter']];
  return `<form data-form="food-builder" class="sheet-form builder">
    <label class="field"><span>Name</span><input class="input" name="name" value="${esc(s.name || '')}" placeholder="My usual ${B.title.toLowerCase()}" maxlength="100" data-bl-name></label>
    ${groups}
    <div class="bgroup"><h3>How much you had</h3>
      <div class="seg wide-seg" role="group" aria-label="Share">${shares.map(([v, l]) => `<button type="button" data-action="food-bl-share" data-share="${v}" class="${!s.measured && Math.abs((s.share || 1) - v) < 0.001 ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${s.mode === 'shake' ? `<div class="grid2"><label class="field"><span>Finished weight (g)</span><input class="input" inputmode="decimal" value="${esc(s.measured || '')}" data-bl-batch="measured"></label>
        <label class="field"><span>You drank (g)</span><input class="input" inputmode="decimal" value="${esc(s.had || '')}" data-bl-batch="had"></label></div>` : ''}
    </div>
    <div id="builder-total">${builderTotals(s)}</div>
    ${slotSelect(s.slot || slotNow(s.mode === 'shake'))}
    <div class="form-actions"><button class="btn primary" type="submit"${s.lines.length ? '' : ' disabled'}>Log it</button>
      <button class="btn tinted" type="button" data-action="food-bl-save"${s.lines.length ? '' : ' disabled'}>${s.mealId ? 'Save changes' : 'Save as a meal'}</button>
      ${s.mealId ? `<button class="btn plain" type="button" data-action="food-bl-copy">Save a copy</button><button class="btn plain danger-text" type="button" data-action="food-meal-del" data-id="${s.mealId}">Delete</button>` : ''}</div>
  </form>`;
}

function planBody(s) {
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA');
  return `<form data-form="food-plan" class="sheet-form"><p class="li-title">${esc(s.target.name)}</p>
    <label class="field"><span>Day</span><input class="input" type="date" name="date" value="${tomorrow}" min="${localToday()}" required></label>
    ${slotSelect(s.target.slot || 'lunch')}
    <div class="form-actions"><button class="btn primary" type="submit">Plan it</button></div></form>`;
}

function batchLogBody(s) {
  const b = s.batch;
  const byWeight = b.final_weight > 0;
  return `<form data-form="food-batch-log" class="sheet-form"><p class="li-sub">${byWeight ? `${round(b.left.g, 0)} of ${round(b.final_weight, 0)} g left` : `${round(b.left.servings, 2)} servings left`}</p>
    <div class="amount-row"><input class="input" name="qty" inputmode="decimal" value="${byWeight ? '' : 1}" placeholder="${byWeight ? 'grams on your plate' : 'servings'}" required aria-label="Amount">
      <select class="input" name="unit">${byWeight ? '<option value="g">g of the cooked batch</option>' : ''}<option value="serving">servings</option></select></div>
    ${slotSelect(slotNow())}
    <div class="form-actions"><button class="btn primary" type="submit">Log it</button></div></form>`;
}

function cookBody(s) {
  const r = s.recipe;
  return `<form data-form="food-cook" class="sheet-form"><p class="li-sub">${esc(r.name)}, version ${r.version}${s.factor !== 1 ? `, ×${round(s.factor, 2)}` : ''}</p>
    <div class="grid2"><label class="field"><span>Finished weight (g)</span><input class="input" name="final_weight" inputmode="decimal" placeholder="without the pot"></label>
      <label class="field"><span>Servings</span><input class="input" name="servings" inputmode="decimal" value="${round(r.servings * s.factor, 2)}"></label></div>
    <label class="field"><span>Cooked on</span><input class="input" type="date" name="cooked_on" value="${localToday()}"></label>
    <div class="form-actions"><button class="btn primary" type="submit">Save the batch</button></div></form>`;
}

function recipeLogBody(s) {
  const r = s.recipe;
  return `<form data-form="food-recipe-log" class="sheet-form"><p class="li-sub">${esc(r.name)}</p>
    <div class="amount-row"><input class="input" name="qty" inputmode="decimal" value="1" required aria-label="Amount">
      <select class="input" name="unit"><option value="serving">servings</option>${r.final_weight ? '<option value="g">g of the finished dish</option>' : ''}</select></div>
    ${slotSelect(slotNow())}
    <div class="form-actions"><button class="btn primary" type="submit">Log it</button></div></form>`;
}

function recipeEditBody(s) {
  const d = s.draft;
  return `<form data-form="food-recipe-save" class="sheet-form">
    ${d.imported ? importNotice(d) : ''}
    <label class="field"><span>Name</span><input class="input" name="name" value="${esc(d.name || '')}" required maxlength="120"></label>
    <div class="grid2"><label class="field"><span>Servings it makes</span><input class="input" name="servings" inputmode="decimal" value="${esc(d.servings ?? 1)}" required></label>
      <label class="field"><span>Finished weight (g)</span><input class="input" name="final_weight" inputmode="decimal" value="${esc(d.final_weight || '')}" placeholder="optional"></label></div>
    <div class="bgroup"><div class="bgroup-head"><h3>Ingredients</h3><button class="gh-link" type="button" data-action="food-re-add">${icon('plus')}Add</button></div>
      ${d.lines.length ? `<div class="group">${d.lines.map((l, i) => (d.imported ? importedRow(l, i, unitOptions) : `<div class="li li-plain bline"><span class="li-body"><span class="li-title">${esc(l.item?.name || l.name)}</span>
        ${l.item ? `<span class="amount-row small"><input class="input" inputmode="decimal" value="${esc(l.qty)}" data-re-index="${i}" data-re-field="qty" aria-label="Amount">
          <select class="input" data-re-index="${i}" data-re-field="unit" aria-label="Unit">${unitOptions(l.item, l.unit)}</select></span>` : `<span class="li-sub">${esc(amountText(l.qty, l.unit))}</span>`}</span>
        <span class="li-side"><button class="icon-btn" type="button" data-action="food-re-drop" data-index="${i}" aria-label="Remove">${icon('close')}</button></span></div>`)).join('')}</div>` : '<p class="note">No ingredients yet.</p>'}</div>
    <label class="field"><span>Method, one step per line</span><textarea class="input" name="method" rows="4" placeholder="optional">${esc((d.method || []).join('\n'))}</textarea></label>
    <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="2" placeholder="optional">${esc(d.notes || '')}</textarea></label>
    <div class="form-actions"><button class="btn primary" type="submit"${d.lines.length ? '' : ' disabled'}>Save recipe</button></div></form>`;
}

function sheetHtml() {
  const s = state.foodSheet;
  if (!s) return '';
  switch (s.kind) {
    case 'search': return sheetWrap(s.pick ? 'Choose a food' : s.slot ? `Add to ${SLOT[s.slot].toLowerCase()}` : s.drinks ? 'Drinks' : 'Search', searchBody(s), 'tall');
    case 'usual': return usualSheet(s, sheetWrap);
    case 'food': return sheetWrap(s.item.name, foodBody(s), 'tall');
    case 'quick': return sheetWrap('Quick add', quickBody(s));
    case 'custom': return sheetWrap(s.fromLabel ? 'Check the label' : 'A food of your own', customBody(s), 'tall');
    case 'photo': {
      const title = s.busy ? 'Reading the photo' : s.result?.kind === 'meal' ? 'On the plate' : s.result?.kind === 'product' ? 'Found it' : 'From the photo';
      return sheetWrap(title, photoBody(s), 'tall');
    }
    case 'scan-miss': return sheetWrap(scanMissTitle(s), scanMissBody(s));
    case 'entry': return sheetWrap(s.entry.name, entryBody(s), 'tall');
    case 'daynut': return sheetWrap(f().day?.today ? 'Today' : dateLabel(f().day), dayNutBody(), 'tall');
    case 'builder': return sheetWrap(s.mealId ? s.name || 'Saved meal' : `New ${(BUILDERS[s.mode] || BUILDERS.meal).title.toLowerCase()}`, builderBody(s), 'tall');
    case 'plan': return sheetWrap('Plan for later', planBody(s));
    case 'batch-log': return sheetWrap(s.batch.name, batchLogBody(s));
    case 'cook': return sheetWrap('Cook a batch', cookBody(s));
    case 'recipe-log': return sheetWrap('Log it', recipeLogBody(s));
    case 'rich': return sheetWrap(richTitle(s), richBody(s), 'tall');
    case 'recipe-edit': return sheetWrap(s.draft.key ? 'Edit recipe' : s.draft.imported ? 'Imported recipe' : 'New recipe', recipeEditBody(s), 'tall');
    case 'recipe-import': return sheetWrap('Import from a link', importBody(s));
    default: return '';
  }
}

// ---------- Recipes ----------

function recipeRow(r) {
  const time = (r.prep_min || 0) + (r.cook_min || 0);
  return `<a class="li li-nav recipe-row" href="#/food/recipe/${enc(r.key)}"><span class="li-body">
    <span class="li-title">${esc(r.name)}${r.name_mt ? ` <em class="serif mt">${esc(r.name_mt)}</em>` : ''}</span>
    <span class="li-sub">${esc(FAMILIES[r.family] || r.family || '')}${r.type === 'template' ? ' · combination' : r.type === 'component' ? ' · component' : r.type === 'variant' ? ' · variant' : ''} · serves ${round(r.servings, 1)}${time ? ` · ${time} min` : ''}${r.perServing ? ` · ${kcal(r.perServing)} a serving` : ''}${r.source === 'you' ? ' <span class="tag">Yours</span>' : ''}</span></span>${icon('chevron', 'chev')}</a>`;
}

function viewRecipes() {
  const F = f();
  const all = F.recipes;
  const head = pageHead('Recipes', { over: '<a class="back-inline" href="#/food">Food</a>', actions: `<button class="icon-btn" data-action="food-imp-open" aria-label="Import from a link" title="Import from a link">${icon('link')}</button><button class="icon-btn accent" data-action="food-recipe-new" aria-label="New recipe">${icon('plus')}</button>` });
  if (!all) return ctx.shell(`${head}<div class="skeleton"><i></i><i class="short"></i></div>${sheetHtml()}`);
  const fl = F.filter || (F.filter = { q: '', family: '', type: 'all', limit: 60 });
  const q = norm(fl.q);
  const list = all.filter((r) => (!fl.family || r.family === fl.family)
    && (fl.type === 'all' || (fl.type === 'recipes' && ['base', 'variant'].includes(r.type)) || (fl.type === 'combos' && r.type === 'template') || (fl.type === 'components' && r.type === 'component') || (fl.type === 'mine' && r.source === 'you'))
    && (!q || q.split(' ').every((w) => norm(`${r.name} ${r.name_mt || ''} ${(r.tags || []).join(' ')}`).includes(w))));
  const fams = [...new Set(all.map((r) => r.family))].filter(Boolean);
  const types = [['all', 'All'], ['recipes', 'Recipes'], ['combos', 'Combos'], ['components', 'Components'], ['mine', 'Yours']];
  ctx.shell(`${head}
    <div class="recipe-filters"><input class="input" type="search" placeholder="Search ${all.length} recipes" value="${esc(fl.q)}" data-recipe-q aria-label="Search recipes">
      <select class="input" data-recipe-family aria-label="Family"><option value="">All families</option>${fams.map((x) => `<option value="${x}"${x === fl.family ? ' selected' : ''}>${esc(FAMILIES[x] || x)}</option>`).join('')}</select></div>
    <div class="seg small type-seg" role="group" aria-label="Kind">${types.map(([v, l]) => `<button type="button" data-action="food-recipe-type" data-type="${v}" class="${fl.type === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="recipe-list"><div class="group">${list.slice(0, fl.limit).map(recipeRow).join('') || '<p class="note pad">No recipes match.</p>'}</div>
    ${list.length > fl.limit ? `<div class="form-actions"><button class="btn tinted small" data-action="food-recipe-more">Show more (${list.length - fl.limit})</button></div>` : ''}</div>
    ${sheetHtml()}`);
}

function viewRecipe() {
  const r = f().recipe;
  const back = `<a class="back" href="#/food/recipes">${icon('back')}Recipes</a>`;
  if (!r) return ctx.shell(`${back}<div class="skeleton"><i></i><i class="short"></i></div>`);
  const o = f().opts;
  const per = r.perServing || r.totals;
  const groups = [...new Set(r.lines.map((l) => l.grp || ''))];
  const lineRow = (l) => {
    const off = l.optional && l.skipped;
    const swapped = o.swap[l.index];
    return `<div class="li li-plain rline${off ? ' off' : ''}">
      ${l.optional ? `<input class="ropt" type="checkbox" data-action="food-r-opt" data-index="${l.index}"${off ? '' : ' checked'} aria-label="Include ${esc(l.label || l.name)}">` : ''}
      <span class="li-body"><span class="li-title">${esc(cap(l.label || l.name))}${l.optional ? ' <small class="faint">optional</small>' : ''}</span>
        <span class="li-sub">${esc(l.amount_text)} · ${l.ref === 'recipe' ? `<a href="#/food/recipe/${enc(l.ref_key)}">${esc(l.name)}</a>` : esc(l.name)}${swapped ? ' · swapped' : ''}${l.missing ? ' · <b>not in the catalogue</b>' : ''}</span></span>
      <span class="li-side">${off ? '' : l.nutrients ? kcal(l.nutrients) : ''}${l.ref === 'item' ? `<button class="btn plain small" data-action="food-r-swap" data-index="${l.index}">Swap</button>` : ''}</span></div>`;
  };
  const factors = [[0.5, '×½'], [1, '×1'], [2, '×2'], [3, '×3']];
  const status = STATUS[r.status] || r.status;
  const mine = r.source === 'you';
  const g = r.per100 ? gradeOf(safely(() => N.nutriScore?.(r.per100, { liquid: false }))) : null;
  ctx.shell(`${back}${pageHead(esc(r.name), { over: esc(FAMILIES[r.family] || r.family || '') })}
    ${r.name_mt ? `<p class="serif mt-big">${esc(r.name_mt)}</p>` : ''}
    ${r.summary ? `<p class="rsum">${esc(r.summary)}</p>` : ''}
    <p class="rtags"><span class="tag">${r.type === 'template' ? 'Combination' : r.type === 'component' ? 'Component' : r.type === 'variant' ? 'Variant' : 'Recipe'}</span><span class="tag ${r.status === 'ai-untested' ? 'ftag-est' : ''}">${esc(status)}</span>${mine ? '<span class="tag">Yours</span>' : ''}${r.parent ? ` <a class="tag" href="#/food/recipe/${enc(r.parent.key)}">Based on ${esc(r.parent.name)}</a>` : ''}</p>
    ${sourceCredit(r)}
    <div class="split"><div>
    <section class="card food-total"><div class="ft-main"><b class="ft-kcal">${show(per, 'kcal', { unit: false })}</b><span class="ft-unit">kcal a serving</span>${g ? nutriBadge(g) : ''}</div>${strip(per)}
      <p class="ft-extra"><span>Whole recipe ${kcal(r.totals)} · serves ${round(r.servings * o.factor, 2)}${r.per100 ? ` · ${kcal(r.per100)} per 100 g` : ''}${(r.prep_min || r.cook_min) ? ` · ${(r.prep_min || 0) + (r.cook_min || 0)} min` : ''}</span></p>
      ${r.errors?.length ? `<p class="note bad">${esc(r.errors.join(' '))}</p>` : ''}</section>
    <div class="seg small" role="group" aria-label="Scale">${factors.map(([v, l]) => `<button type="button" data-action="food-r-factor" data-factor="${v}" class="${o.factor === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="form-actions recipe-actions"><button class="btn primary" data-action="food-r-log">Log a serving</button>
      ${r.type === 'template' ? '<button class="btn tinted" data-action="food-r-builder">Open in the builder</button>' : '<button class="btn tinted" data-action="food-r-cook">Cook a batch</button>'}
      <button class="btn tinted" data-action="food-r-plan">Plan</button><button class="btn tinted" data-action="food-r-dup">${icon('copy')}Make my version</button>
      ${mine ? '<button class="btn tinted" data-action="food-r-edit">Edit</button><button class="btn plain" data-action="food-r-del">Delete</button>' : ''}</div>
    <section class="section"><div class="gh"><h2>Ingredients</h2>${Object.keys(o.swap).length || o.skip.length || o.with.length ? '<button class="gh-link" data-action="food-r-reset">Reset</button>' : ''}</div>
      ${groups.map((gr) => `${gr ? `<p class="eyebrow">${esc(gr)}</p>` : ''}<div class="group">${r.lines.filter((l) => (l.grp || '') === gr).map(lineRow).join('')}</div>`).join('')}</section>
    </div><div>
    ${r.method?.length ? `<section class="section"><div class="gh"><h2>Method</h2></div><ol class="method">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol></section>` : ''}
    ${r.variants?.length ? `<section class="section"><div class="gh"><h2>Variants</h2></div><div class="group">${r.variants.map((v) => `<a class="li li-nav" href="#/food/recipe/${enc(v.key)}"><span class="li-body"><span class="li-title">${esc(v.name)}</span></span>${icon('chevron', 'chev')}</a>`).join('')}</div></section>` : ''}
    ${r.notes ? `<details class="card disclosure"><summary>Notes</summary><p class="note">${esc(r.notes)}</p></details>` : ''}
    <section class="section"><div class="gh"><h2>Nutrition</h2><span class="gh-count">a serving</span></div><div class="card nf nf-card">${factsHtml(per)}</div></section>
    </div></div>${sheetHtml()}`);
}

// ---------- Saved meals ----------

function viewMeals() {
  const meals = f().meals;
  const head = pageHead('Saved meals', { over: '<a class="back-inline" href="#/food">Food</a>' });
  if (!meals) return ctx.shell(`${head}<div class="skeleton"><i class="short"></i><i class="short"></i></div>${sheetHtml()}`);
  ctx.shell(`${head}
    <div class="fcap-tools meal-tools" role="group" aria-label="New">${['shake', 'bowl', 'plate', 'meal'].map((m) => `<button type="button" class="fcap-tool" data-action="food-builder" data-mode="${m}">${icon(BUILDERS[m].icon)}<span>${BUILDERS[m].title}</span></button>`).join('')}</div>
    ${meals.length ? `<div class="group">${meals.map((m) => `<div class="li li-plain">
      <span class="li-ic">${icon((BUILDERS[m.kind] || BUILDERS.meal).icon)}</span>
      <button class="li-body linkish-block" data-action="food-meal-open" data-id="${m.id}"><span class="li-title">${esc(m.name)}</span><span class="li-sub">${m.lines.length} items · ${kcal(m.nutrients)}</span></button>
      <span class="li-side meal-actions"><button class="btn tinted small" data-action="food-meal-log" data-id="${m.id}">Log</button><button class="icon-btn" data-action="food-meal-del" data-id="${m.id}" aria-label="Delete ${esc(m.name)}">${icon('trash')}</button></span></div>`).join('')}</div>`
      : '<div class="card fempty"><p>No saved meals yet</p></div>'}
    ${sheetHtml()}`);
}

// ---------- Coverage report: what the catalogue holds ----------

function viewReport() {
  const r = f().report;
  const head = pageHead('Coverage', { over: '<a class="back-inline" href="#/settings">Settings</a>' });
  if (!r) return ctx.shell(`${head}<div class="skeleton"><i></i><i class="short"></i></div>`);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const cat = (c, list) => {
    const good = list === 'food' ? (c.counts.mapped || 0) + (c.counts.products || 0) + (c.counts.recipe || 0) : c.counts.covered || 0;
    return `<details class="disclosure cov"><summary><span class="cov-name">${esc(c.label || c.category)}</span><span class="cov-n">${good}/${c.total}</span>
      <span class="pbar thin"><i style="width:${pct(good, c.total)}%"></i></span></summary>
      <p class="note">${Object.entries(c.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      ${c.open.length ? `<ul class="cov-open">${c.open.map((o) => `<li><b>${esc(o.name)}</b> <span class="tag">${esc(o.state)}</span>${o.issue ? ` ${esc(o.issue)}` : ''}</li>`).join('')}</ul>` : ''}</details>`;
  };
  const nut = r.nutrients;
  const nutRows = nut ? nut.list.map((x) => `<div class="rirow"><span class="rirow-k">${esc(shortLabel(x.key))}</span><span class="rirow-bar"><i style="--f:${(nut.total ? x.count / nut.total : 0).toFixed(3)}"></i></span><span class="rirow-v">${pct(x.count, nut.total)}%</span></div>`).join('') : '';
  ctx.shell(`${head}
    <div class="stats cov-stats">
      <div class="card"><p class="eyebrow">Foods</p><b class="big">${r.foods.matched}<small>/${r.foods.total}</small></b><p class="li-sub">${r.foods.incomplete} partial · ${r.foods.missing} missing</p></div>
      <div class="card"><p class="eyebrow">Recipes</p><b class="big">${r.recipes.covered}<small>/${r.recipes.total}</small></b><p class="li-sub">${r.recipes.byType.base || 0} base · ${r.recipes.byType.variant || 0} variants</p></div>
      <div class="card"><p class="eyebrow">Catalogue</p><b class="big">${r.catalogue.generic + r.catalogue.estimates + r.catalogue.products + r.catalogue.yours}</b><p class="li-sub">${r.catalogue.products} products · ${r.catalogue.yours} yours${nut ? ` · ${nut.graded} graded` : ''}</p></div>
    </div>
    ${nutRows ? `<section class="section"><div class="gh"><h2>Values on record</h2><span class="gh-count">of ${nut.total} foods</span></div><div class="card fcard">${nutRows}</div></section>` : ''}
    <section class="section"><div class="gh"><h2>Foods by category</h2></div>${r.foods.categories.map((c) => cat(c, 'food')).join('')}</section>
    <section class="section"><div class="gh"><h2>Recipes by family</h2></div>${r.recipes.categories.map((c) => cat(c, 'recipe')).join('')}</section>`);
}

// ---------- Trends: drawings first, short labels, numbers on the graphics ----------

const SPANS = [7, 30, 90];
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SOURCE_KEYS = ['sugars', 'salt', 'satfat', 'protein', 'fibre'];
const SOURCE_LABEL = { sugars: 'Sugar', salt: 'Salt', satfat: 'Sat fat', protein: 'Protein', fibre: 'Fibre' };

function cardHead(title, side = '') {
  return `<div class="fcard-head"><h2>${title}</h2>${side ? `<span class="fcard-side">${side}</span>` : ''}</div>`;
}

// The period in four numbers.
function kpiRow(h) {
  const g = h.grades?.total;
  const sum = g ? Object.values(g).reduce((a, v) => a + (num(v) || 0), 0) : 0;
  const ab = sum ? share((g.a || 0) + (g.b || 0), sum) : null;
  const logged = h.series.filter((d) => d.logged).length;
  const tile = (v, l) => `<div class="fkpi"><b>${v}</b><span>${l}</span></div>`;
  return `<div class="fkpis">
    ${tile(`${fmtN(h.avg.kcal)}${h.avg.missing?.kcal ? '+' : ''}`, 'kcal a day')}
    ${tile(num(h.avg.protein) === null ? '–' : `${fmtN(h.avg.protein)}<small> g</small>`, 'protein a day')}
    ${tile(ab === null ? '–' : `${ab}<small>%</small>`, 'from A and B')}
    ${tile(`${logged}<small>/${h.days}</small>`, 'days logged')}</div>`;
}

// Energy per day, each column split by macro; the average as a dashed line, the chosen day lit and the
// rest dimmed. Tap a day to choose it.
function energyCard(h, sel) {
  const avg = num(h.avg.kcal);
  const hits = h.series.map((d) => `<button type="button" data-action="food-trend-day" data-date="${d.date}" aria-pressed="${d.date === sel}"
    aria-label="${esc(`${d.date === h.today ? 'Today' : shortDay(d.date)}: ${d.logged ? `${fmtN(d.kcal)} kcal${d.incomplete ? ', incomplete' : ''}, ${spokenSplit(d)}` : 'nothing logged'}`)}"></button>`).join('');
  const side = `<span><i class="fk fk-avg"></i>${avg === null ? '–' : `<b>${fmtN(avg)}${h.avg.missing?.kcal ? '+' : ''}</b> avg`}</span>`;
  return `<section class="card fcard ftr-energy f-wide">${cardHead('Energy', side)}
    <div class="fx-plot">${barsHtml(h.series, { height: 168, sel, values: h.days <= 7, avg })}
      <div class="fx-hits" style="grid-template-columns:repeat(${h.series.length},minmax(0,1fr))">${hits}</div></div>
    ${axisLabels(h.series, h.today)}
    ${barKeys(h.series)}
  </section>`;
}

// What he ate by Nutri-Score: the period as one bar, then each day as a column of energy shares.
function gradeCard(h) {
  const gr = h.grades;
  if (!gr) return '';
  const days = gr.days || [];
  const height = 88;
  const n = days.length || 1;
  const slot = 100 / n;
  const bw = slot * (n > 40 ? 0.74 : 0.56);
  const cols = days.map((d, i) => {
    const sum = [...GRADES, 'none'].reduce((a, g) => a + (num(d[g]) || 0), 0);
    const x = (i * slot + (slot - bw) / 2).toFixed(3);
    if (!(sum > 0)) return `<rect x="${x}%" y="${height - 2}" width="${bw.toFixed(3)}%" height="2" class="fx-gap"/>`;
    let y = height;
    const segs = [...GRADES, 'none'].map((g) => {
      const v = num(d[g]) || 0;
      if (!v) return '';
      const hh = (v / sum) * height;
      y -= hh;
      return `<rect x="${x}%" y="${(y + 0.5).toFixed(1)}" width="${bw.toFixed(3)}%" height="${Math.max(0.5, hh - 1).toFixed(1)}" rx="${n > 40 ? 0.5 : 1.5}" class="gx gx-${g}"/>`;
    }).join('');
    return `<g class="gx-col" style="animation-delay:${Math.round((i * 320) / n)}ms">${segs}</g>`;
  }).join('');
  const mix = gradeMix(gr.total);
  return `<section class="card fcard fgrades">${cardHead('Nutri-Score', h.rank ? `<span><b>${h.rank.graded}</b> of ${h.rank.foods} foods graded</span>` : '')}
    ${mix || '<p class="fempty-line">Nothing graded yet</p>'}
    ${mix ? `<svg class="fx-svg fgrade-cols" width="100%" height="${height}" aria-hidden="true"><line x1="0" x2="100%" y1="${height - 0.5}" y2="${height - 0.5}" class="fx-base"/>${cols}</svg>${axisLabels(h.series, h.today)}` : ''}
  </section>`;
}

// Bars against the reference intake, with a mark at 100%.
// With `tap`, each row is a button that opens the foods richest in it.
function riRows(list, { best = new Set(), low = new Set(), tap = false } = {}) {
  const at = RI_AT;
  return list.map((c, i) => {
    const p = num(c.pct);
    const w = p === null ? 0 : riPos(p) / 100;
    const tone = `${riTone(p, c.key)}${best.has(c.key) ? ' best' : ''}${low.has(c.key) ? ' low' : ''}`;
    // "~" when some of it was filled from a similar food, the web or an estimate rather than on record.
    const est = p !== null && c.est > 0 ? `<i class="est" title="${c.est >= 100 ? 'Estimated' : `About ${fmtN(c.est)}% estimated`}">~</i>` : '';
    const tag = tap ? `button type="button" data-action="food-rich" data-key="${esc(c.key)}"` : 'div';
    return `<${tag} class="rirow${tone}${p === null ? ' unk' : ''}${tap ? ' ri-tap' : ''}" style="--i:${i}"><span class="rirow-k">${tap ? `<span>${esc(shortLabel(c.key))}</span>${icon('chevron', 'tap-hint')}` : esc(shortLabel(c.key))}</span>
      <span class="rirow-bar"><i style="--f:${w.toFixed(3)}"></i><b class="rirow-100" style="left:${at}%"></b></span>
      <span class="rirow-v">${p === null ? '–' : `${est}${fmtN(p)}%${c.partial ? '+' : ''}`}</span></${tap ? 'button' : 'div'}>`;
  }).join('');
}

function riLegend() {
  return `<div class="rirow rirow-legend" aria-hidden="true"><span></span><span class="rirow-bar bare"><b class="rirow-100" style="left:${RI_AT}%"><em>${needs() ? 'Need' : 'RI'}</em></b></span><span></span></div>`;
}

// The average day against the label's reference intakes.
function labelCard(h) {
  const list = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'salt'].map((k) => h.coverage?.find((c) => c.key === k)).filter(Boolean);
  if (!list.length) return '';
  return `<section class="card fcard">${cardHead('Average day', `<span><b>${h.loggedDays}</b> ${h.loggedDays === 1 ? 'day' : 'days'}</span>`)}
    ${riLegend()}${riRows(list)}</section>`;
}

// The average day as a pack's nutrition label: the fats and carbohydrates broken down, each against
// his need or the RI. Sub-rows nobody has a value for are left out, as on the day's label.
function nutritionLabelCard(h) {
  const n = h.label;
  if (!n) return '';
  const rows = LABEL_ROWS.filter(([k, sub]) => !sub || ['satfat', 'sugars'].includes(k) || num(n[k]) !== null);
  return `<section class="card fcard">${cardHead('Nutrition label', `<span>Average of <b>${n.days}</b> ${n.days === 1 ? 'day' : 'days'}</span>`)}
    <div class="nf-group nf-label"><div class="nf-cols" aria-hidden="true"><span></span><span></span><span>% ${riWord()}</span></div>
      ${rows.map(([k, sub]) => factRow(n, k, sub, n.filled)).join('')}</div></section>`;
}

// Vitamins and minerals: the average % of reference intake, best first; the three highest and the
// three lowest marked. Nutrients nothing he ate has a value for are named, never drawn as zero.
function microCard(h) {
  const all = (h.coverage || []).filter((c) => ['mineral', 'vitamin'].includes(c.group));
  if (!all.length) return '';
  const known = all.filter((c) => num(c.pct) !== null).sort((a, b) => b.pct - a.pct);
  const unknown = all.filter((c) => num(c.pct) === null);
  const best = new Set(known.slice(0, 3).map((c) => c.key));
  const low = new Set(known.length > 3 ? known.slice(Math.max(3, known.length - 3)).map((c) => c.key) : []);
  return `<section class="card fcard f-wide fmicro-card">${cardHead('Vitamins and minerals', known.length ? '<span><i class="fk fk-best"></i>Top</span><span><i class="fk fk-low"></i>Lowest</span>' : '')}
    ${known.length ? `${riLegend()}<div class="rirows" style="--rows:${Math.ceil(known.length / 2)}">${riRows(known, { best, low, tap: true })}</div>` : '<p class="fempty-line">No values on record yet</p>'}
    ${known.some((c) => c.est > 0) ? '<p class="rirow-none"><i class="est">~</i> Partly filled from similar foods, published values or estimates</p>' : ''}
    ${unknown.length ? `<p class="rirow-none">No data: ${unknown.map((c) => esc(shortLabel(c.key))).join(', ')}</p>` : ''}</section>`;
}

function rankList(list, empty) {
  if (!list?.length) return `<p class="fempty-line">${empty}</p>`;
  return `<ol class="frank-list">${list.map((x) => `<li>${gradeDot(x.grade)}<span class="frank-name">${esc(x.name)}${topTag(x.tags) ? ` ${tagMini(topTag(x.tags))}` : ''}</span><b>×${x.count}</b></li>`).join('')}</ol>`;
}

// The best and worst foods he ate, by grade then how often.
function rankCard(h) {
  if (!h.rank) return '';
  return `<section class="card fcard f-wide">${cardHead('Food rankings')}
    <div class="frank"><div><h3 class="frank-h good">Best</h3>${rankList(h.rank.best, 'No A or B foods yet')}</div>
    <div><h3 class="frank-h bad">Worst</h3>${rankList(h.rank.worst, 'No D or E foods')}</div></div></section>`;
}

function sourceList(h, k) {
  const s = h.sources?.[k];
  if (!s?.items.length) return '<p class="fempty-line">Nothing on record</p>';
  const top = s.items[0].amount || 1;
  const unit = NUTRIENT[k].unit;
  return `<ol class="fsrc-list">${s.items.map((x) => `<li>${gradeDot(x.grade)}<span class="fsrc-name">${esc(x.name)}</span>
    <span class="fsrc-bar"><i style="--f:${(x.amount / top).toFixed(3)}"></i></span><b>${fmtN(x.share)}%</b><small>${fmtN(x.amount, unit === 'g' && x.amount < 10 ? 1 : 0)} ${unit}</small></li>`).join('')}</ol>`;
}

// Where his sugar, salt, saturates, protein and fibre came from.
function sourcesCard(h) {
  if (!h.sources) return '';
  const k = SOURCE_KEYS.includes(f().src) ? f().src : 'sugars';
  return `<section class="card fcard">${cardHead('Top sources')}
    <div class="hscroll"><div class="seg small fsrc-seg" role="radiogroup" aria-label="Nutrient">${SOURCE_KEYS.map((x) => `<label><input type="radio" name="fsrc" value="${x}" data-food-src${x === k ? ' checked' : ''}><span>${SOURCE_LABEL[x]}</span></label>`).join('')}</div></div>
    <div id="fsrc-list">${sourceList(h, k)}</div></section>`;
}

// Eat more of, eat less of: from his own foods, measured against reference intakes and Nutri-Score.
function adviceCard(h) {
  const a = h.advice;
  if (!a) return '';
  const row = (x, more) => {
    const why = more
      ? (x.nutrient ? `${esc(shortLabel(x.nutrient))} <small>${fmtN(x.pct)}% ${riWord()}</small>` : esc(x.reason))
      : (x.nutrient ? `${esc(shortLabel(x.nutrient))} <small>${fmtN(x.share)}% of yours</small>` : `${esc(x.reason)} <small>×${x.count}</small>`);
    return `<li>${gradeDot(x.grade)}<span class="fadv-name">${esc(x.name)}</span><span class="fadv-why ${more ? 't-good' : 't-warn'}">${why}</span></li>`;
  };
  return `<section class="card fcard f-wide">${cardHead('Eat more of, less of')}
    <div class="fadv"><div><h3 class="frank-h good">${icon('plus')}More</h3>${a.more.length ? `<ul class="fadv-list">${a.more.map((x) => row(x, true)).join('')}</ul>` : '<p class="fempty-line">Nothing stands out</p>'}</div>
    <div><h3 class="frank-h bad">Less</h3>${a.less.length ? `<ul class="fadv-list">${a.less.map((x) => row(x, false)).join('')}</ul>` : '<p class="fempty-line">Nothing over the limits</p>'}</div></div></section>`;
}

// When he eats: average energy by weekday and hour.
function timingCard(h) {
  const t = h.timing;
  if (!t) return '';
  const vals = t.kcal.flat().filter((v) => num(v) !== null);
  const max = Math.max(1, ...vals);
  const byHour = Array.from({ length: 24 }, (_, hr) => t.kcal.reduce((a, row) => a + (num(row[hr]) || 0), 0));
  const peak = byHour.indexOf(Math.max(...byHour));
  const any = vals.some((v) => v > 0);
  const rows = t.kcal.map((row, w) => `<span class="fheat-d">${WEEK[w].slice(0, 1)}</span>${row.map((v, hr) => (num(v) === null ? '<i class="na"></i>'
    : `<i style="--a:${(v / max).toFixed(3)}"${v > 0 ? ` title="${WEEK[w]} ${String(hr).padStart(2, '0')}:00, ${fmtN(v)} kcal"` : ''}></i>`)).join('')}`).join('');
  return `<section class="card fcard">${cardHead('Meal timing', any ? `<span>Peak <b>${String(peak).padStart(2, '0')}:00</b></span>` : '')}
    ${any ? `<div class="fheat" role="img" aria-label="${esc(`Energy by hour and weekday, busiest around ${peak}:00`)}"><div class="fheat-grid">${rows}</div>
      <div class="fheat-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div>` : '<p class="fempty-line">Not enough days yet</p>'}</section>`;
}

// The average day by weekday, against the period's average.
function weekdayCard(h) {
  const w = h.weekdays;
  if (!w?.some((x) => x.n)) return '';
  const series = w.map((x) => ({ date: `w${x.day}`, logged: x.n > 0, kcal: x.kcal, protein: x.protein, carbs: x.carbs, fat: x.fat }));
  const best = [...w].filter((x) => x.n).sort((a, b) => b.kcal - a.kcal)[0];
  return `<section class="card fcard">${cardHead('By weekday', best ? `<span>Most on <b>${WEEK[best.day]}</b></span>` : '')}
    ${barsHtml(series, { height: 132, values: true, avg: num(h.avg.kcal) })}
    <div class="fx-axis cols" style="grid-template-columns:repeat(7,minmax(0,1fr))" aria-hidden="true">${WEEK.map((d) => `<span>${d}</span>`).join('')}</div>
    ${barKeys(series, 'Average day')}</section>`;
}

// The chosen day's macro split against the period's average.
function splitCard(h) {
  const ch = h.chosen;
  const avg = h.avg;
  const dayName = ch.today ? 'Today' : shortDay(ch.date);
  const a = macroParts(avg);
  const d = macroParts(ch);
  const keys = ['protein', 'carbs', 'fat', ...([d, a].some((m) => m.parts.some((p) => p.key === 'unknown')) ? ['unknown'] : [])];
  const pc = (m, k) => {
    const p = m.parts.find((x) => x.key === k);
    return m.sum > 0 && p ? `${share(p.kcal, m.sum)}%` : '–';
  };
  const ring = (n, title, tot, plus) => `<figure class="fsplit-ring">${donut(n, { size: 104, sw: 12, label: `${title}, energy from`,
    center: `<b>${fmtN(tot)}${plus ? '+' : ''}</b><small>kcal</small>` })}<figcaption>${title}</figcaption></figure>`;
  return `<section class="card fcard">${cardHead('Energy split')}
    <div class="fsplit">${ring(ch, dayName, ch.kcal, ch.missing?.kcal)}${ring(avg, `${h.days}-day avg`, avg.kcal, avg.missing?.kcal)}</div>
    <table class="fsplit-table"><thead><tr><th scope="col"><span class="sr">Macro</span></th><th scope="col">${esc(dayName)}</th><th scope="col">Avg</th></tr></thead>
      <tbody>${keys.map((k) => `<tr><th scope="row"><i class="fdot m-${k}"></i>${MACRO_LABEL[k]}</th><td>${pc(d, k)}</td><td>${pc(a, k)}</td></tr>`).join('')}</tbody></table>
  </section>`;
}

// This period against the one before, as paired bars with the change beside them.
function compareCard(h) {
  const rows = [['kcal', 'Energy', 'kcal'], ['protein', 'Protein', 'g'], ['sugars', 'Sugars', 'g'], ['fibre', 'Fibre', 'g'], ['salt', 'Salt', 'g'], ['caffeine', 'Caffeine', 'mg']];
  const now = h.avg;
  const before = h.prev.avg;
  const body = rows.map(([k, label, unit]) => {
    const a = num(now[k]);
    const b = num(before[k]);
    const top = Math.max(a || 0, b || 0) || 1;
    const bar = (v, cls, plus) => `<span class="fcmp-bar ${cls}">${v === null ? '' : `<i style="--f:${(v / top).toFixed(3)}"></i>`}<b>${fmtN(v, k === 'kcal' || k === 'caffeine' ? 0 : 1)}${v !== null && plus ? '+' : ''}</b></span>`;
    let delta = '<span class="fcmp-delta none" aria-hidden="true">–</span>';
    if (a !== null && b !== null && b > 0) {
      const c = Math.round(((a - b) / b) * 100);
      delta = `<span class="fcmp-delta${c > 0 ? ' up' : c < 0 ? ' down' : ''}"><i aria-hidden="true"></i>${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c)}%</span>`;
    }
    return `<div class="fcmp-row"><span class="fcmp-label">${label}<small>${unit}</small></span>
      <span class="fcmp-bars">${bar(a, 'cur', now.missing?.[k])}${bar(b, 'prev', before.missing?.[k])}</span>${delta}</div>`;
  }).join('');
  const key = `<span><i class="fk fk-now"></i>Last ${h.days} days</span><span><i class="fk fk-prev"></i>${h.days} before</span>`;
  return `<section class="card fcard">${cardHead('Against the period before')}
    <p class="fx-keys top">${key}</p>${body}
  </section>`;
}

// Caffeine through the chosen day by hour, with drinks hanging below the line.
function caffeineCard(h) {
  const ch = h.chosen;
  const { caffeine, caffeineUnknown, drinksMl } = ch.hours;
  const height = 112;
  const mid = 74;
  const cmax = Math.max(100, ...caffeine);
  const mmax = Math.max(500, ...drinksMl);
  const slot = 100 / 24;
  const bw = slot * 0.62;
  const hatch = nextId('fc');
  let lastLabel = -9;
  const marks = caffeine.map((v, i) => {
    const x = (i * slot + (slot - bw) / 2).toFixed(3);
    let out = '';
    let topY = mid;
    if (v > 0) {
      const bh = Math.max(3, ((mid - 20) * v) / cmax);
      topY = mid - bh;
      out += `<rect x="${x}%" y="${topY.toFixed(1)}" width="${bw.toFixed(3)}%" height="${bh.toFixed(1)}" rx="2" class="fc-bar" style="animation-delay:${i * 12}ms"/>`;
    }
    if (caffeineUnknown[i]) {
      topY -= 9;
      out += `<rect x="${x}%" y="${topY.toFixed(1)}" width="${bw.toFixed(3)}%" height="8" rx="2" class="fc-unk" style="fill:url(#${hatch})"/>`;
    }
    if (v > 0 && i - lastLabel > 2) {
      lastLabel = i;
      out += `<text x="${((i + 0.5) * slot).toFixed(2)}%" y="${(topY - 5).toFixed(1)}" text-anchor="${i > 21 ? 'end' : i < 2 ? 'start' : 'middle'}" class="fx-val">${fmtN(v)}</text>`;
    }
    if (drinksMl[i] > 0) {
      const dh = Math.max(3, ((height - mid - 6) * drinksMl[i]) / mmax);
      out += `<rect x="${x}%" y="${mid + 3}" width="${bw.toFixed(3)}%" height="${dh.toFixed(1)}" rx="2" class="fd-bar" style="animation-delay:${i * 12}ms"/>`;
    }
    return out;
  }).join('');
  let now = '';
  if (ch.today) {
    const [hh, mm] = localNowHM().split(':').map(Number);
    now = `<line x1="${(((hh + mm / 60) / 24) * 100).toFixed(2)}%" x2="${(((hh + mm / 60) / 24) * 100).toFixed(2)}%" y1="8" y2="${height}" class="fc-now"/>`;
  }
  const unknown = caffeineUnknown.some(Boolean);
  const spoken = caffeine.map((v, i) => (v > 0 ? `${i}:00 ${fmtN(v)} mg` : '')).filter(Boolean).join(', ') || 'no caffeine logged';
  const side = `<span><i class="fk fk-caf"></i><b>${show(ch, 'caffeine', { unit: false })}</b> mg</span><span><i class="fk fk-drink"></i><b>${fmtN(ch.drinksMl ?? 0)}</b> ml</span>`;
  return `<section class="card fcard">${cardHead(`Caffeine, ${ch.today ? 'today' : esc(shortDay(ch.date))}`, side)}
    <div class="fc-plot"><svg class="fx-svg" width="100%" height="${height}" role="img" aria-label="${esc(`Caffeine by hour: ${spoken}`)}"><defs>${hatchDef(hatch, 'caf')}</defs>
      <line x1="0" x2="100%" y1="${mid + 1}" y2="${mid + 1}" class="fx-base"/>${marks}${now}</svg></div>
    <div class="fc-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    ${unknown ? '<p class="fx-keys"><span><i class="fk fk-unk"></i>No caffeine value</span></p>' : ''}
  </section>`;
}

// Cards below the fold are drawn when they come near the screen, once per session.
// [draw, height held while waiting, full width on wide screens]
const LAZY = {
  label: [labelCard, 300], micro: [microCard, 520, true], nlabel: [nutritionLabelCard, 420], rank: [rankCard, 260, true], sources: [sourcesCard, 300], timing: [timingCard, 250],
  advice: [adviceCard, 240, true], weekdays: [weekdayCard, 220], caffeine: [caffeineCard, 220], split: [splitCard, 300], compare: [compareCard, 330],
  weight: [() => weightCard(f().energy), 470],
  // Food and your body (food-links.js): drawn from the links, not the period.
  lsleep: [() => linksSleepCard(f().links), 420],
  lfuel: [() => linksTrainingCard(f().links), 330], lalcohol: [() => linksAlcoholCard(f().links), 300], lwindow: [() => linksWindowCard(f().links), 280],
};

// Trends in five tabs. Each tab's first card is drawn at once and the rest as they come near the
// screen. The tab is in the address (#/food/trends?tab=nutrients) and kept for the session.
const TABS = [['overview', 'Overview'], ['nutrients', 'Nutrients'], ['foods', 'Foods'], ['timing', 'Timing'], ['body', 'Body']];
const TAB_CARDS = {
  overview: [(h, sel) => energyCard(h, sel), 'label'],
  nutrients: [(h) => microCard(h), 'nlabel', 'sources'],
  foods: [(h) => gradeCard(h), 'rank', 'advice'],
  timing: [(h) => timingCard(h), 'weekdays', 'caffeine', 'split', 'compare'],
  body: [(h) => burnCard(f().energy), 'weight', 'lsleep', 'lfuel', 'lalcohol', 'lwindow'],
};
const TAB_KEY = 'oath.trendsTab';
function trendTab() {
  const q = state.query?.get('tab');
  if (TAB_CARDS[q]) return q;
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    if (TAB_CARDS[kept]) return kept;
  } catch { /* storage unavailable */ }
  return 'overview';
}
function lazy(name, h) {
  const F = f();
  if (F.shown?.has(name)) return LAZY[name][0](h);
  return `<section class="card fcard f-lazy${LAZY[name][2] ? ' f-wide' : ''}" data-lazy="${name}" style="min-height:${LAZY[name][1]}px" aria-hidden="true"></section>`;
}

let lazyIO = null;
function watchLazy() {
  lazyIO?.disconnect();
  const els = [...document.querySelectorAll('[data-lazy]')];
  if (!els.length) return;
  const draw = (el) => {
    const h = f().trend;
    const name = el.dataset.lazy;
    if (!h || !el.isConnected) return;
    (f().shown || (f().shown = new Set())).add(name);
    const html = LAZY[name][0](h);
    if (!html) {
      el.remove();
      return;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const card = tpl.content.firstElementChild;
    card.classList.add('f-enter', 'f-in');
    el.replaceWith(card);
  };
  if (!('IntersectionObserver' in window)) {
    els.forEach(draw);
    return;
  }
  lazyIO = new IntersectionObserver((list) => list.forEach((e) => {
    if (!e.isIntersecting) return;
    lazyIO.unobserve(e.target);
    draw(e.target);
  }), { rootMargin: '240px 0px' });
  els.forEach((el) => lazyIO.observe(el));
}

function viewTrends() {
  const F = f();
  const h = F.trend;
  const span = F.span || 7;
  const head = pageHead('Trends', { over: '<a class="back-inline" href="#/food">Food</a>', actions: infoBtn('trends') });
  const seg = `<div class="seg small ftr-span" role="group" aria-label="Period">${SPANS.map((n) => `<button type="button" data-action="food-span" data-days="${n}" class="${span === n ? 'on' : ''}" aria-pressed="${span === n}">${n} days</button>`).join('')}</div>`;
  if (!h) return ctx.shell(`${head}${seg}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`);
  const sel = h.chosen.date;
  const tab = trendTab();
  // The Body tab's links load on first view and land in place (food-links.js).
  if (tab === 'body') wantLinks(F, () => redrawIfIdle('food', ctx.render));
  const legend = infoLine('trends', h.needs ? '<span><b>100%</b> your daily need, from your body</span>' : '<span><b>RI</b> EU reference intake</span>');
  const tabs = `<div class="seg ftr-tabs" role="tablist" aria-label="Trends">${TABS.map(([k, label]) => `<button type="button" role="tab" id="ftab-${k}" aria-controls="ftr-panel" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" data-action="food-tab" data-tab="${k}">${label}</button>`).join('')}</div>`;
  const [first, ...rest] = TAB_CARDS[tab];
  const top = tab === 'overview' ? `${takeHtml('trends')}${kpiRow(h)}` : '';
  // The Body tab keeps its own windows (28 days for the real burn, 90 for the links), so it has no period.
  ctx.shell(`${head}${legend}${tabs}${tab === 'body' ? '' : seg}
    <div id="ftr-panel" role="tabpanel" aria-labelledby="ftab-${tab}">${top}
    <div class="ftr-grid${enter(`trends-${tab}`)}">${first(h, sel)}${rest.map((x) => lazy(x, h)).join('')}</div></div>${sheetHtml()}`);
  watchLazy();
}

export function viewFood() {
  const p = state.param;
  if (p === 'trends') return viewTrends();
  if (p === 'recipes') return viewRecipes();
  if (p === 'recipe') return viewRecipe();
  if (p === 'meals') return viewMeals();
  if (p === 'report') return viewReport();
  if (p === 'chat') return viewChat();
  return viewDiary();
}

// ---------- Actions ----------

function openSheet(s) {
  state.foodSheet = s;
  ctx.render();
  const first = document.querySelector('.food-sheet [data-food-q], .food-sheet [data-food-amount], .food-sheet .sheet-form .input');
  first?.focus({ preventScroll: true });
}

function closeSheet() {
  state.foodSheet = null;
  ctx.render();
}

async function itemFor(key) {
  const local = [...(f().recent || []), ...(f().drinks || []), ...(state.foodSheet?.results || [])].find((x) => x.key === key);
  if (local) return local;
  return api('GET', `/api/food/items/${enc(key)}`);
}

async function pickItem(key) {
  const s = state.foodSheet;
  const item = await itemFor(key);
  // A pick that knows how much (an imported line's amount) starts there, when the food takes that unit.
  const hint = s?.pick?.amount;
  const d = hint && unitsFor(item).some((u) => u.unit === hint.unit) ? hint : defaults(item);
  // A search opened from a meal's "+" keeps that meal for the log.
  openSheet({ kind: 'food', item, qty: d.qty, unit: d.unit, pick: s?.pick || null, back: s?.pick ? s.back : null, slot: s?.slot });
}

function backToBuilder(s, mutate) {
  const b = s.back;
  if (mutate) mutate(b);
  openSheet(b);
}

async function afterLog(r, name, info = {}) {
  haptic('log-food');
  if (state.route === 'food' && state.param === 'chat') {
    await chatAfterLog({ name, nutrients: info.nutrients, queued: r?.queued, duplicate: r?.duplicate });
    return;
  }
  if (r?.queued) toast(`${name} saved on this phone. It syncs when you are back online.`);
  else toast(r?.duplicate ? 'Already logged.' : `Logged ${name}.`);
  state.foodSheet = null;
  state.foodToday = null;
  if (state.route === 'food' && !state.param) await refresh().catch(() => ctx.render());
  else ctx.render();
}

// Logs reviewed foods, a photo's from its sheet or a meal's from the food chat: a matched food at its
// amount, and a food with no record as an estimated quick add. Says how many landed and whether any is
// waiting on this phone.
async function logReviewed(items, slot) {
  let n = 0;
  let queued = false;
  for (const it of items) {
    const m = reviewItem(it);
    let r = null;
    if (m.mode === 'match') {
      // The matched record's gaps, estimated per 100, go back with the line so the server keeps them.
      const body = { key: it.match.key, qty: Number(it.qty), unit: it.unit, slot, estimate: !it.edited, id: it.logId, ...(it.fill ? { fill: it.fill } : {}) };
      r = await act(() => foodPost('log', body, { name: it.match.name, amount: amountText(it.qty, it.unit, it.match), kcal: m.line.nutrients.kcal }));
    } else if (m.mode === 'rough') {
      // Not in the catalogue: the estimate per 100 and its weight go in the diary as a quick add
      // marked as an estimate. Without a profile or a weight, the rough totals stand in.
      const g = it.guess;
      const name = cap(it.name);
      const amount = roughAmount(g);
      const drink = it.fill?.basis === 'ml' || g.unit === 'ml';
      const weight = num(g.weight) ?? (['g', 'ml'].includes(g.unit) ? num(g.amount) : null);
      const body = { name, amount, slot, estimate: true, id: it.logId, ...(drink ? { ml: weight } : { grams: weight }) };
      if (it.fill && weight) body.fill = it.fill;
      else Object.assign(body, { kcal: round(g.kcal, 0), protein: g.protein, carbs: g.carbs, sugars: g.sugars, fat: g.fat, fibre: g.fibre, salt: g.salt });
      r = await act(() => foodPost('quick', body, { name, amount, kcal: g.kcal }));
    } else if (m.error) toast(`${it.match.name}: ${m.error}`, true);
    if (r) { n += 1; queued = queued || r.queued; }
  }
  return { n, queued };
}

// Each reviewed item carries the id its entry will be logged under, so Log all sent again (a failed try,
// a double tap) lands each entry once: the server keeps the first of an id.
const photoItemsFrom = (r) => (r.items || []).map((x) => ({ ...x, edited: false, logId: uuid() }));

// A product found by its barcode, from a photo or the live scanner, opens straight on its sheet. A scan
// started while choosing a food for a builder or recipe carries on choosing.
function openProduct(item, from = null) {
  const d = defaults(item);
  openSheet({ kind: 'food', item, qty: d.qty, unit: d.unit, pick: from?.pick || null, back: from?.pick ? from.back : null });
  toast(`Found ${item.name}.`);
}

async function readPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  // A label photographed for a barcode the scanner could not find is saved under that barcode.
  const barcode = input.dataset.barcode || '';
  state.foodSheet = { kind: 'photo', busy: true };
  ctx.render();
  try {
    const image = await shrink(file);
    const result = await api('POST', '/api/food/photo', { image, media_type: 'image/jpeg', ...(barcode ? { barcode } : {}) });
    if (result.kind === 'label') {
      openSheet({ kind: 'custom', draft: result.draft, fromLabel: true });
      return;
    }
    if (result.kind === 'product') {
      openProduct(result.item);
      return;
    }
    state.foodSheet = { kind: 'photo', result, items: photoItemsFrom(result) };
    ctx.render();
  } catch (err) {
    state.foodSheet = null;
    ctx.render();
    toast(err.status === 0 ? 'Reading photos needs a connection.' : err.message, true);
  }
}

// About 1,600 px on the long side as a JPEG: plenty for a label, small enough to send quickly.
async function shrink(file, long = 1600, quality = 0.82) {
  let src;
  let w;
  let h;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    h = src.height;
  } catch {
    src = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('That photo could not be opened.'));
      img.src = URL.createObjectURL(file);
    });
    w = src.naturalWidth;
    h = src.naturalHeight;
  }
  const s = Math.min(1, long / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality).split(',')[1];
}

async function openBuilderFromLines(base, lines) {
  const items = await Promise.all(lines.map((l) => (l.ref === 'recipe' ? null : itemFor(l.ref_key).catch(() => null))));
  const built = [];
  for (const [i, l] of lines.entries()) {
    if (l.ref === 'recipe') {
      const sub = await api('GET', `/api/food/recipes/${enc(l.ref_key)}`).catch(() => null);
      if (sub?.perServing) built.push({ ref: 'recipe', key: l.ref_key, name: sub.name, qty: l.qty, unit: 'serving', per: sub.perServing, group: l.grp });
    } else if (items[i]) built.push({ ref: 'item', item: items[i], qty: l.qty, unit: l.unit, group: l.grp || l.group });
  }
  openSheet({ ...base, kind: 'builder', lines: built, share: 1 });
}

const builderLines = (s) => s.lines.map((l) => (l.ref === 'recipe' ? { ref: 'recipe', ref_key: l.key, qty: l.qty, unit: 'serving', grp: l.group || '' }
  : { ref: 'item', ref_key: l.item.key, qty: Number(l.qty), unit: l.unit, grp: l.group || '' }));

// A small cross-fade for a part of the screen that changed in place.
function settle(el) {
  if (!el?.animate || reduced()) return;
  try { el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' }); } catch { /* no Web Animations */ }
}

export async function foodClick(a, el) {
  if (!a.startsWith('food-')) return false;
  if (a.startsWith('food-chat-')) return chatClick(a, el);
  if (a.startsWith('food-burn-')) return energyClick(a, el, refresh);
  if (a.startsWith('food-scan')) return scanClick(a, el);
  if (await usualClick(a, el)) return true;
  if (a.startsWith('food-next-') || a.startsWith('food-rich')) return nextClick(a, el);
  if (a.startsWith('food-imp-')) return importClick(a, el, { open: openSheet, save: saveRecipeDraft, defaults, search: runSearch });
  const s = state.foodSheet;
  const F = f();
  switch (a) {
    case 'food-close':
      if (s?.pick && s.back) backToBuilder(s);
      else closeSheet();
      return true;
    case 'food-day': {
      const cur = F.day?.date || localToday();
      const d = new Date(`${cur}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + Number(el.dataset.step));
      const next = d.toISOString().slice(0, 10);
      F.date = next >= localToday() ? null : next;
      await act(() => loadDay());
      ctx.render();
      return true;
    }
    case 'food-info': {
      const key = el.dataset.key;
      F.info = { ...(F.info || {}), [key]: !F.info?.[key] };
      ctx.render();
      return true;
    }
    case 'food-tag': {
      const box = el.closest('.ftags');
      const why = box?.querySelector('.ftag-why');
      if (!why) return true;
      const open = el.getAttribute('aria-expanded') === 'true';
      box.querySelectorAll('.ftag').forEach((b) => b.setAttribute('aria-expanded', 'false'));
      if (open || !el.dataset.why) {
        why.hidden = true;
        return true;
      }
      el.setAttribute('aria-expanded', 'true');
      why.textContent = el.dataset.why;
      why.hidden = false;
      if (!reduced()) why.animate?.([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
      return true;
    }
    case 'food-daynut':
      openSheet({ kind: 'daynut' });
      return true;
    case 'food-search':
      openSheet({ kind: 'search', q: '', drinks: el.dataset.drinks === '1', results: null });
      return true;
    case 'food-quick':
      openSheet({ kind: 'quick', slot: s?.slot });
      return true;
    case 'food-custom':
      openSheet({ kind: 'custom', draft: el.dataset.fromPhoto && s?.result ? { name: [s.result.read?.name, s.result.read?.variant].filter(Boolean).join(' '), brand: s.result.read?.brand || '', barcode: s.result.barcode || '', pack: s.result.read?.pack_size ? { size: s.result.read.pack_size, count: s.result.read.pack_count } : null, basis: s.result.read?.pack_unit === 'ml' ? 'ml' : 'g' } : { name: s?.q || '' } });
      return true;
    case 'food-pick':
      await act(() => pickItem(el.dataset.key));
      return true;
    case 'food-off': {
      const box = document.getElementById('food-results');
      if (box) box.innerHTML = '<p class="note">Searching Open Food Facts…</p>';
      const r = await act(() => api('GET', `/api/food/off-search?q=${enc(s.q)}`));
      if (r) {
        s.results = r.items;
        ctx.render();
        if (!r.items.length) toast('Open Food Facts has nothing for that either. Take a photo of the label or add it yourself.');
      }
      return true;
    }
    case 'food-chip': {
      const form = el.closest('form');
      form.qty.value = el.dataset.qty;
      form.unit.value = el.dataset.unit;
      s.qty = el.dataset.qty;
      s.unit = el.dataset.unit;
      updateAmount(s);
      return true;
    }
    case 'food-fav': {
      const on = !s.item.favourite;
      const r = await act(() => api('POST', `/api/food/items/${enc(s.item.key)}/favourite`, { on }), on ? 'Added to favourites.' : 'Removed from favourites.');
      if (r) {
        s.item.favourite = on;
        ctx.render();
      }
      return true;
    }
    case 'food-plan-open':
      openSheet({ kind: 'plan', target: { kind: 'item', ref_key: s.item.key, name: s.item.name, qty: Number(s.qty), unit: s.unit } });
      return true;
    case 'food-tray': {
      const item = await itemFor(el.dataset.key).catch(() => null);
      if (!item) return true;
      const d = defaults(item);
      if (!item.last) {
        openSheet({ kind: 'food', item, qty: d.qty, unit: d.unit });
        return true;
      }
      const l = line(item, d.qty, d.unit);
      const r = await act(() => foodPost('log', { key: item.key, qty: d.qty, unit: d.unit, slot: slotNow(item.liquid) }, { name: item.name, amount: amountText(d.qty, d.unit, item), kcal: l.nutrients?.kcal }));
      if (r) await afterLog(r, item.name);
      return true;
    }
    case 'food-entry': {
      const e = F.day?.entries.find((x) => x.id === el.dataset.eid);
      if (!e) return true;
      let item = null;
      if (e.kind === 'item' && e.refKey) item = await itemFor(e.refKey).catch(() => null);
      openSheet({ kind: 'entry', entry: e, item });
      return true;
    }
    case 'food-entry-del': {
      const id = el.dataset.eid;
      const r = await act(() => api('DELETE', `/api/food/log/${enc(id)}`));
      if (r) {
        F.undo = { id, name: r.entry?.name || 'the entry' };
        setTimeout(() => { if (F.undo?.id === id) { F.undo = null; if (state.route === 'food') ctx.render(); } }, 10000);
        state.foodSheet = null;
        await refresh();
      }
      return true;
    }
    case 'food-undo': {
      const u = F.undo;
      F.undo = null;
      if (u?.kind === 'log') {
        await undoLog(u);
        return true;
      }
      if (u && await act(() => api('POST', `/api/food/log/${enc(u.id)}/restore`, {}), 'Back in the diary.')) await refresh();
      return true;
    }
    case 'food-repeat': {
      const y = new Date(`${localToday()}T12:00:00Z`);
      y.setUTCDate(y.getUTCDate() - 1);
      const r = await act(() => api('POST', '/api/food/repeat', { from: y.toISOString().slice(0, 10) }), (x) => `Copied ${x.entries.length} entries from yesterday.`);
      if (r) await refresh();
      return true;
    }
    case 'food-builder':
      openSheet({ kind: 'builder', mode: el.dataset.mode, lines: [], share: 1, name: '' });
      return true;
    case 'food-bl-add':
      openSheet({ kind: 'search', q: '', drinks: el.dataset.group === 'liquid', results: null, pick: { purpose: 'builder', group: el.dataset.group }, back: s });
      return true;
    case 'food-bl-swap':
      openSheet({ kind: 'search', q: '', drinks: s.lines[Number(el.dataset.index)].item.liquid, results: null, pick: { purpose: 'builder-swap', index: Number(el.dataset.index) }, back: s });
      return true;
    case 'food-bl-drop':
      s.lines.splice(Number(el.dataset.index), 1);
      ctx.render();
      return true;
    case 'food-bl-share':
      s.share = Number(el.dataset.share);
      s.measured = '';
      s.had = '';
      ctx.render();
      return true;
    case 'food-bl-save':
    case 'food-bl-copy': {
      const name = (document.querySelector('[data-bl-name]')?.value || s.name || '').trim() || `My ${(BUILDERS[s.mode] || BUILDERS.meal).title.toLowerCase()}`;
      const body = { name: a === 'food-bl-copy' ? `${name} (copy)` : name, kind: s.mode in BUILDERS ? s.mode : 'meal', lines: builderLines(s) };
      if (a === 'food-bl-save' && s.mealId) body.id = s.mealId;
      const r = await act(() => api('POST', '/api/food/meals', body), a === 'food-bl-copy' ? 'Saved a copy.' : 'Saved. One tap from now on.');
      if (r) {
        s.mealId = r.id;
        s.name = r.name;
        f().meals = null;
        ctx.render();
      }
      return true;
    }
    case 'food-meal-open': {
      const m = (F.meals || []).find((x) => x.id === Number(el.dataset.id));
      if (m) await act(() => openBuilderFromLines({ mode: m.kind, mealId: m.id, name: m.name }, m.lines));
      return true;
    }
    case 'food-meal-del': {
      const id = Number(el.dataset.id);
      const name = (F.meals || []).find((x) => x.id === id)?.name || s?.name || 'this meal';
      if (!await confirmSheet(`Delete ${name}?`, 'Entries already logged keep their numbers.')) return true;
      if (await act(() => api('DELETE', `/api/food/meals/${id}`), 'Meal deleted.')) {
        if (F.meals) F.meals = F.meals.filter((x) => x.id !== id);
        store.set('oath.foodMeals', store.get('oath.foodMeals', []).filter((x) => x.id !== id));
        state.foodSheet = null;
        ctx.render();
      }
      return true;
    }
    case 'food-meal-log': {
      const m = (F.meals || []).find((x) => x.id === Number(el.dataset.id));
      const r = await act(() => foodPost('meal', { meal_id: m.id, slot: slotNow(m.kind === 'shake') }, { name: m.name, amount: `${m.lines.length} items`, kcal: m.nutrients?.kcal }));
      if (r) await afterLog(r, m.name);
      return true;
    }
    case 'food-photo-change': {
      // The matcher's other candidates come first; typing searches the whole catalogue.
      const it = s.items[Number(el.dataset.index)];
      const q = it.search || '';
      const alts = (it.alternatives || []).filter((x) => x?.key);
      openSheet({ kind: 'search', q, results: alts.length ? alts : null, pick: { purpose: 'photo', index: Number(el.dataset.index) }, back: s });
      if (q && !alts.length) await runSearch(q, true);
      return true;
    }
    case 'food-span': {
      const days = Number(el.dataset.days);
      if (days === (F.span || 7)) return true;
      F.span = days;
      ctx.render();
      await act(() => loadTrends());
      ctx.render();
      return true;
    }
    case 'food-links-retry':
      F.links = null;
      ctx.render();
      return true;
    case 'food-tab': {
      const tab = el.dataset.tab;
      if (!TAB_CARDS[tab]) return true;
      try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* storage unavailable */ }
      // A tab is a view of the same page, not a step back can undo.
      state.query = new URLSearchParams(tab === 'overview' ? '' : `tab=${tab}`);
      history.replaceState(null, '', `#/food/trends${tab === 'overview' ? '' : `?tab=${tab}`}`);
      ctx.render();
      document.getElementById(`ftab-${tab}`)?.focus({ preventScroll: true });
      if (tab === 'body' && !F.energy) loadEnergy().then(() => redrawIfIdle('food', ctx.render));
      return true;
    }
    case 'food-trend-day': {
      const date = el.dataset.date;
      if (F.trend?.chosen?.date === date) return true;
      F.trendDate = date === F.trend?.today ? null : date;
      await act(() => loadTrends());
      ctx.render();
      document.querySelector(`[data-action="food-trend-day"][data-date="${date}"]`)?.focus({ preventScroll: true });
      return true;
    }
    case 'food-photo-drop':
      s.items.splice(Number(el.dataset.index), 1);
      ctx.render();
      return true;
    case 'food-plan-eat': {
      const r = await act(() => api('POST', `/api/food/plans/${el.dataset.id}/eat`, { id: uuid() }), 'Logged as eaten.');
      if (r) await refresh();
      return true;
    }
    case 'food-plan-del':
      if (await act(() => api('DELETE', `/api/food/plans/${el.dataset.id}`))) await refresh();
      return true;
    case 'food-batch-log': {
      const b = F.batches.find((x) => x.id === Number(el.dataset.id));
      if (b) openSheet({ kind: 'batch-log', batch: b });
      return true;
    }
    case 'food-batch-done':
      if (await act(() => api('POST', `/api/food/batches/${el.dataset.id}/finish`, {}), 'Batch finished.')) await refresh();
      return true;
    // Recipes
    case 'food-recipe-type':
      F.filter.type = el.dataset.type;
      F.filter.limit = 60;
      ctx.render();
      return true;
    case 'food-recipe-more':
      F.filter.limit += 120;
      ctx.render();
      return true;
    case 'food-recipe-new':
      openSheet({ kind: 'recipe-edit', draft: { name: '', servings: 1, lines: [], method: [] } });
      return true;
    case 'food-re-add':
      saveRecipeDraft(s);
      openSheet({ kind: 'search', q: '', results: null, pick: { purpose: 'recipe-line' }, back: s });
      return true;
    case 'food-re-drop':
      saveRecipeDraft(s);
      s.draft.lines.splice(Number(el.dataset.index), 1);
      ctx.render();
      return true;
    case 'food-r-opt': {
      const i = Number(el.dataset.index);
      F.opts.with = el.checked ? [...F.opts.with, i] : F.opts.with.filter((x) => x !== i);
      await previewRecipe();
      return true;
    }
    case 'food-r-factor':
      F.opts.factor = Number(el.dataset.factor);
      await previewRecipe();
      return true;
    case 'food-r-reset':
      F.opts = { skip: [], with: [], swap: {}, factor: F.opts.factor };
      await previewRecipe();
      return true;
    case 'food-r-swap':
      openSheet({ kind: 'search', q: '', results: null, pick: { purpose: 'recipe-swap', index: Number(el.dataset.index) } });
      return true;
    case 'food-r-log':
      openSheet({ kind: 'recipe-log', recipe: F.recipe });
      return true;
    case 'food-r-cook':
      openSheet({ kind: 'cook', recipe: F.recipe, factor: F.opts.factor });
      return true;
    case 'food-r-plan':
      openSheet({ kind: 'plan', target: { kind: 'recipe', ref_key: F.recipe.key, name: F.recipe.name, qty: 1, unit: 'serving' } });
      return true;
    case 'food-r-builder': {
      const r = F.recipe;
      const mode = r.family === 'shakes' ? 'shake' : /bowl|fruit/i.test(r.name) ? 'bowl' : 'meal';
      const lines = r.lines.filter((l) => !(l.optional && l.skipped)).map((l, i) => ({ ...l, ...(F.opts.swap[i] || {}), grp: mode === 'shake' ? shakeGroup(l) : mode === 'bowl' ? (/fruit|banana|apple|berr|grape|melon|mango|kiwi|pear|peach|orange/i.test(l.name) ? 'fruit' : 'add') : 'all' }));
      await act(() => openBuilderFromLines({ mode, name: r.name }, lines));
      return true;
    }
    case 'food-r-dup': {
      const r = await act(() => api('POST', `/api/food/recipes/${enc(F.recipe.key)}/duplicate`, {}), 'Your version is saved.');
      if (r) {
        F.recipes = null;
        location.hash = `#/food/recipe/${enc(r.key)}`;
      }
      return true;
    }
    case 'food-r-edit': {
      const r = F.recipe;
      const items = await Promise.all(r.lines.map((l) => (l.ref === 'item' ? itemFor(l.ref_key).catch(() => null) : null)));
      openSheet({ kind: 'recipe-edit', draft: { key: r.key, name: r.name, servings: r.servings, final_weight: r.final_weight, method: r.method, notes: r.notes,
        family: r.family, summary: r.summary, tags: r.tags, prep_min: r.prep_min, cook_min: r.cook_min,
        lines: r.lines.map((l, i) => ({ ref: l.ref, ref_key: l.ref_key, name: l.name, item: items[i], qty: l.qty, unit: l.unit, label: l.label, optional: l.optional, grp: l.grp, note: l.note })) } });
      return true;
    }
    case 'food-r-del':
      if (!await confirmSheet(`Delete ${F.recipe.name}?`, 'Logged entries keep their numbers.')) return true;
      if (await act(() => api('DELETE', `/api/food/recipes/${enc(F.recipe.key)}`), 'Recipe deleted.')) {
        F.recipes = null;
        location.hash = '#/food/recipes';
      }
      return true;
    default:
      return false;
  }
}

function shakeGroup(l) {
  const n = `${l.name} ${l.ref_key}`.toLowerCase();
  if (/milk|drink|water|juice|kefir|coffee|tea/.test(n) && !/powder/.test(n)) return 'liquid';
  if (/powder|whey|protein|casein/.test(n)) return 'powder';
  if (/banana|berr|mango|apple|peach|pineapple|kiwi|date|orange|avocado|strawberr|fruit/.test(n)) return 'fruit';
  return 'add';
}

async function previewRecipe() {
  const F = f();
  const r = await act(() => api('POST', `/api/food/recipes/${enc(F.recipe.key)}/preview`, F.opts));
  if (r) F.recipe = r;
  ctx.render();
}

function saveRecipeDraft(s) {
  const form = document.querySelector('form[data-form="food-recipe-save"]');
  if (!form || !s?.draft) return;
  const o = form2obj(form);
  Object.assign(s.draft, { name: o.name, servings: o.servings, final_weight: o.final_weight, method: String(o.method || '').split('\n').map((x) => x.trim()).filter(Boolean), notes: o.notes });
}

// Picking a food while choosing for a builder, a recipe line, a photo item or a recipe swap.
async function finishPick(s, qty, unit) {
  const p = s.pick;
  if (p.purpose === 'builder' || p.purpose === 'builder-swap') {
    backToBuilder(s, (b) => {
      const l = { ref: 'item', item: s.item, qty: Number(qty), unit, group: p.group };
      if (p.purpose === 'builder') b.lines.push(l);
      else b.lines[p.index] = { ...l, group: b.lines[p.index].group };
    });
  } else if (p.purpose === 'recipe-line') {
    backToBuilder(s, (b) => b.draft.lines.push({ ref: 'item', ref_key: s.item.key, item: s.item, name: s.item.name, qty: Number(qty), unit, label: s.item.name.split(',')[0].toLowerCase() }));
  } else if (p.purpose === 'recipe-fix') {
    // An imported line he sorted out: the food and amount he chose; the page's words stay with it.
    backToBuilder(s, (b) => Object.assign(b.draft.lines[p.index], { ref: 'item', ref_key: s.item.key, item: s.item, name: s.item.name, qty: Number(qty), unit, flag: null, estimate: false }));
  } else if (p.purpose === 'photo') {
    // A food he picked himself: the estimate made for the old match no longer applies.
    backToBuilder(s, (b) => Object.assign(b.items[p.index], { match: s.item, qty: Number(qty), unit, edited: true, fill: null, why: null, brand: null, size: null }));
  } else if (p.purpose === 'chat') {
    chatPicked(p, s.item, qty, unit);
  } else if (p.purpose === 'recipe-swap') {
    f().opts.swap[p.index] = { ref: 'item', ref_key: s.item.key, qty: Number(qty), unit };
    state.foodSheet = null;
    await previewRecipe();
  }
}

export async function foodSubmit(kind, form) {
  if (!kind.startsWith('food-')) return false;
  if (kind === 'food-weight') return energySubmit(kind, form, refresh);
  if (kind === 'food-chat-send') return chatSubmit(form);
  if (await usualSubmit(kind, form)) return true;
  const s = state.foodSheet;
  const o = form2obj(form);
  switch (kind) {
    case 'food-search':
      await runSearch(o.q, true);
      return true;
    case 'food-log': {
      const { item } = withFill(s.item, s.fill);
      const l = line(item, o.qty, o.unit);
      if (l.error) { toast(l.error, true); return true; }
      if (s.pick) {
        await finishPick(s, o.qty, o.unit);
        return true;
      }
      const r = await act(() => foodPost('log', { key: s.item.key, qty: Number(o.qty), unit: o.unit, slot: o.slot, ...(s.fill ? { fill: s.fill } : {}) }, { name: s.item.name, amount: amountText(o.qty, o.unit, s.item), kcal: l.nutrients.kcal }));
      if (r) await afterLog(r, s.item.name, { nutrients: l.nutrients });
      return true;
    }
    case 'food-quick': {
      const r = await act(() => foodPost('quick', o, { name: o.name || 'Quick add', amount: o.ml ? `${o.ml} ml` : '', kcal: Number(o.kcal) }));
      if (r) await afterLog(r, o.name || 'it', { nutrients: { kcal: Number(o.kcal) } });
      return true;
    }
    case 'food-custom': {
      const nutrients = {};
      for (const k of ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine', 'alcohol']) nutrients[k] = o[`n_${k}`] === '' ? null : Number(String(o[`n_${k}`]).replace(',', '.'));
      const body = {
        name: o.name, brand: o.brand, barcode: o.barcode, basis: o.basis, liquid: o.basis === 'ml', nutrients,
        pack: o.pack_size ? { size: Number(o.pack_size), unit: o.basis, count: Number(o.pack_count) || null } : null,
        serving: o.serving_size ? { size: Number(o.serving_size), unit: o.basis, label: o.serving_label || null } : null,
        market: 'Malta',
      };
      const item = await act(() => api('POST', s.fromLabel ? '/api/food/label' : '/api/food/items', body), 'Saved.');
      if (item) {
        const d = defaults(item);
        openSheet({ kind: 'food', item, qty: d.qty, unit: d.unit });
      }
      return true;
    }
    case 'food-photo-log': {
      const { n, queued } = await logReviewed(s.items, o.slot);
      if (n) await afterLog({ queued }, `${n} ${n === 1 ? 'item' : 'items'}`);
      return true;
    }
    case 'food-entry-edit': {
      const body = { slot: o.slot };
      if (o.qty !== undefined && s.item) Object.assign(body, { qty: Number(o.qty), unit: o.unit });
      if (await act(() => api('PATCH', `/api/food/log/${enc(s.entry.id)}`, body), 'Saved.')) {
        state.foodSheet = null;
        await refresh();
      }
      return true;
    }
    case 'food-builder': {
      const factor = shareFactor(s);
      const name = (o.name || '').trim() || `${(BUILDERS[s.mode] || BUILDERS.meal).title}`;
      const rows = s.lines.map((l) => (l.ref === 'recipe' ? { nutrients: scale(l.per, l.qty, 1) } : line(l.item, l.qty, l.unit)));
      const bad = rows.find((x) => x.error);
      if (bad) { toast(bad.error, true); return true; }
      const kc = scale(total(rows.map((x) => x.nutrients)), factor, 1).kcal;
      const data = s.mealId ? { meal_id: s.mealId, factor, slot: o.slot, name } : { lines: builderLines(s), factor, slot: o.slot, name };
      // An edited saved meal logs what is on screen, not the stored version.
      if (s.mealId && s.dirty) Object.assign(data, { meal_id: undefined, lines: builderLines(s) });
      const r = await act(() => foodPost('meal', data, { name, amount: `${s.lines.length} items`, kcal: kc }));
      if (r) await afterLog(r, name);
      return true;
    }
    case 'food-plan': {
      const t = s.target;
      const r = await act(() => api('POST', '/api/food/plans', { ...t, date: o.date, slot: o.slot }), 'Planned.');
      if (r) closeSheet();
      return true;
    }
    case 'food-batch-log': {
      const r = await act(() => foodPost('batch', { batch_id: s.batch.id, qty: Number(o.qty), unit: o.unit, slot: o.slot }, { name: s.batch.name, amount: `${o.qty} ${o.unit}` }));
      if (r) await afterLog(r, s.batch.name);
      return true;
    }
    case 'food-cook': {
      const F = f();
      const r = await act(() => api('POST', '/api/food/batches', { key: s.recipe.key, final_weight: o.final_weight || null, servings: Number(o.servings) || null, cooked_on: o.cooked_on, ...F.opts }), 'Batch saved.');
      if (r) closeSheet();
      return true;
    }
    case 'food-recipe-log': {
      const F = f();
      const r = await act(() => foodPost('recipe', { key: s.recipe.key, qty: Number(o.qty), unit: o.unit, slot: o.slot, ...F.opts }, { name: s.recipe.name, amount: amountText(o.qty, o.unit) }));
      if (r) await afterLog(r, s.recipe.name);
      return true;
    }
    case 'food-recipe-import':
      await importSubmit(form, { open: openSheet, render: () => ctx.render() });
      return true;
    case 'food-recipe-save': {
      saveRecipeDraft(s);
      const d = s.draft;
      if (d.imported && d.lines.some(needsFix)) {
        toast('Pick a food and an amount for the lines marked, or remove them.', true);
        ctx.render();
        return true;
      }
      const body = { key: d.key, name: d.name, servings: Number(d.servings), final_weight: d.final_weight ? Number(d.final_weight) : null, method: d.method, notes: d.notes,
        family: d.family, summary: d.summary, tags: d.tags, prep_min: d.prep_min, cook_min: d.cook_min, ...importFields(d),
        lines: d.lines.map((l) => ({ ref: l.ref || 'item', ref_key: l.ref_key || l.item?.key, qty: Number(l.qty), unit: l.unit, label: l.label || (l.item?.name || l.name || '').split(',')[0].toLowerCase(), optional: l.optional, grp: l.grp, note: l.note })) };
      const r = await act(() => api('POST', '/api/food/recipes', body), 'Recipe saved.');
      if (r) {
        state.foodSheet = null;
        f().recipes = null;
        f().recipe = null;
        location.hash = `#/food/recipe/${enc(r.key)}`;
      }
      return true;
    }
    default:
      return false;
  }
}

// ---------- Typing: search as you type, live previews, builder totals ----------

let searchTimer = null;
let searchSeq = 0;
async function runSearch(q, now = false) {
  const s = state.foodSheet;
  if (!s || s.kind !== 'search') return;
  s.q = q;
  clearTimeout(searchTimer);
  const run = async () => {
    const seq = (searchSeq += 1);
    if (!q.trim()) {
      s.results = null;
    } else {
      try {
        s.results = (await api('GET', `/api/food/search?q=${enc(q)}${s.drinks ? '&drinks=1' : ''}`)).items;
      } catch (err) {
        if (err.status === 0) {
          const local = [...(f().recent || []), ...(f().drinks || [])];
          const w = norm(q).split(' ');
          s.results = local.filter((x) => w.every((x2) => norm(`${x.name} ${x.brand || ''}`).includes(x2)));
        } else return;
      }
    }
    if (seq !== searchSeq || state.foodSheet !== s) return;
    const box = document.getElementById('food-results');
    if (box) box.innerHTML = resultsHtml(s);
    const off = document.querySelector('[data-action="food-off"]');
    if (!off && q.trim() && (!s.pick || s.pick.purpose === 'recipe-fix')) {
      const none = document.querySelector('.food-none .sheet-actions');
      none?.insertAdjacentHTML('afterbegin', `<button class="btn tinted" data-action="food-off">${icon('search')}Search Open Food Facts for "${esc(q)}"</button>`);
    } else if (off) off.innerHTML = `${icon('search')}Search Open Food Facts for "${esc(q)}"`;
  };
  if (now) await run();
  else searchTimer = setTimeout(run, 220);
}

// The amount changed: the preview and, per portion, the facts follow it.
function updateAmount(s) {
  const prev = document.getElementById('food-preview');
  if (s.kind === 'food') {
    const { item, filled } = withFill(s.item, s.fill);
    if (prev) prev.innerHTML = previewHtml(item, s.qty, s.unit, filled);
    const facts = document.getElementById('food-facts');
    if (facts && s.per !== '100') facts.innerHTML = itemFacts(s);
  } else if (prev && s.item) prev.innerHTML = previewHtml(s.item, s.qty, s.unit);
}

// The typed meal grows with its words, up to a few lines.
function sizeText(el = document.querySelector('[data-food-text]')) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

function onInput(e) {
  const el = e.target;
  const s = state.foodSheet;
  if (el.matches('[data-food-q]')) return runSearch(el.value);
  if (el.matches('[data-food-text]')) {
    f().text = el.value;
    sizeText(el);
    return null;
  }
  if (el.matches('[data-chat-cid]')) {
    chatInput(el);
    return null;
  }
  if (el.matches('[data-recipe-q]')) {
    f().filter.q = el.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const pos = el.selectionStart;
      ctx.render();
      const again = document.querySelector('[data-recipe-q]');
      again?.focus();
      again?.setSelectionRange(pos, pos);
    }, 200);
    return null;
  }
  if (!s) return null;
  if (el.matches('[data-food-amount]')) {
    const form = el.closest('form');
    if (s.kind === 'entry') {
      if (!s.item) return null;
      s.entry = { ...s.entry, qty: form.qty.value, unit: form.unit.value };
      const prev = document.getElementById('food-preview');
      if (prev) prev.innerHTML = previewHtml(s.item, form.qty.value, form.unit.value);
      return null;
    }
    if (!s.item) return null;
    s.qty = form.qty.value;
    s.unit = form.unit.value;
    updateAmount(s);
  } else if (el.matches('[data-bl-index]')) {
    const l = s.lines[Number(el.dataset.blIndex)];
    l[el.dataset.blField] = el.value;
    s.dirty = true;
    document.getElementById('builder-total').innerHTML = builderTotals(s);
  } else if (el.matches('[data-bl-batch]')) {
    s[el.dataset.blBatch] = el.value;
    document.getElementById('builder-total').innerHTML = builderTotals(s);
  } else if (el.matches('[data-bl-name]')) {
    s.name = el.value;
  } else if (el.matches('[data-photo-index]')) {
    const it = s.items[Number(el.dataset.photoIndex)];
    it[el.dataset.photoField] = el.value;
    it.edited = true;
    const out = document.querySelector(`[data-photo-kcal="${el.dataset.photoIndex}"]`);
    if (out) out.innerHTML = reviewKcal(it);
  } else if (el.matches('[data-re-index]')) {
    s.draft.lines[Number(el.dataset.reIndex)][el.dataset.reField] = el.value;
    if (s.draft.imported) importTyped(s.draft, Number(el.dataset.reIndex));
  }
  return null;
}

function onChange(e) {
  const el = e.target;
  if (el.matches('[data-food-photo]')) {
    readPhoto(el);
    return;
  }
  if (el.matches('[data-chat-photo]')) {
    chatPhoto(el);
    return;
  }
  if (el.matches('[data-chat-cid]')) {
    chatInput(el);
    return;
  }
  if (el.matches('[data-recipe-family]')) {
    f().filter.family = el.value;
    f().filter.limit = 60;
    ctx.render();
    return;
  }
  // Per portion or per 100: the facts swap in place while the segment's pill slides.
  if (el.matches('[data-food-per]')) {
    const s = state.foodSheet;
    if (!s || s.kind !== 'food') return;
    s.per = el.value;
    const box = document.getElementById('food-facts');
    if (box) {
      box.innerHTML = itemFacts(s);
      settle(box);
    }
    return;
  }
  if (el.matches('[data-food-src]')) {
    f().src = el.value;
    const box = document.getElementById('fsrc-list');
    if (box && f().trend) {
      box.innerHTML = sourceList(f().trend, el.value);
      settle(box);
    }
    return;
  }
  if (el.matches('[data-food-amount], [data-bl-index], [data-photo-index], [data-re-index]')) onInput(e);
  if (el.matches('[data-photo-index][data-photo-field="unit"]')) ctx.render();
}

// Return sends a typed meal; Shift+Return adds a new line. The arrow keys move between the Trends tabs.
function onKey(e) {
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.matches?.('.ftr-tabs [role="tab"]')) {
    const list = [...e.target.parentElement.querySelectorAll('[role="tab"]')];
    const i = (list.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length;
    e.preventDefault();
    list[i].click();
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !e.target.matches?.('[data-food-text]')) return;
  e.preventDefault();
  e.target.form?.requestSubmit();
}

export function initFood(c) {
  ctx = c;
  initScan({ found: openProduct, openSheet, render: () => ctx.render() });
  initNext({
    openSheet, itemFor, foodPost, afterLog, slotNow, refresh, openBuilder: openBuilderFromLines,
    dropQueued: (id) => store.set(QUEUE, queue().filter((x) => x.id !== id)),
  });
  $app.addEventListener('input', onInput);
  $app.addEventListener('change', onChange);
  $app.addEventListener('keydown', onKey);
  window.addEventListener('online', () => flushFood());
  initUsual({
    f, store, queue, QUEUE, foodPost, uuid, itemFor, openSheet, slotSelect, unitOptions, SLOT, SLOTS, click: foodClick,
    refresh: () => refresh(), render: () => ctx.render(),
  });
  initChat({
    f, store, uuid, openSheet, runSearch, defaults, reviewItem, reviewKcal, roughAmount, unitOptions, itemGrade, foodRing, macroParts, energyRing,
    logReviewed, shrink, slotNow, SLOT, SLOTS, photoItemsFrom, fmtN, cap, sizeText, sheetHtml,
    shell: (html) => ctx.shell(html), render: () => ctx.render(),
  });
}
