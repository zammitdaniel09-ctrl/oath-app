// Food: the day's diary, search, "photo of anything", quick add, the drinks tray, shake / fruit bowl /
// plate builders, recipes, cooked batches, plans and the coverage report. Every number on these
// screens comes from nutrition.js, the same maths the server uses, so nothing here needs an AI call.
// Unknown stays unknown: a "—" is a value nobody has sourced, a "+" is a total missing some lines.
// Food is a diary. It never touches HP.
import { $app, state, esc, api, act, toast, fmtDay, icon, pageHead, haptic, localToday, form2obj } from './ui.js';
import { NUTRIENT, line, total, scale, show, unitsFor, round, amountText, norm } from './nutrition.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };

const SLOTS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks'], ['drinks', 'Drinks']];
const SLOT = Object.fromEntries(SLOTS);
const KIND = { generic: 'Generic', product: 'Product', custom: 'Yours', label: 'From your label', estimate: 'Estimate' };
const STRIP = ['protein', 'carbs', 'sugars', 'fat', 'fibre', 'salt'];
const FAMILIES = {
  'breakfast-fruit-oats': 'Fruit, oats and yogurt', 'breakfast-eggs': 'Eggs and hot breakfasts', sandwiches: 'Sandwiches and wraps',
  lunches: 'Salads and packed lunches', pasta: 'Pasta', bakes: 'Bakes', rice: 'Rice and grains', noodles: 'Noodles and stir-fries',
  sides: 'Potatoes and sides', chicken: 'Chicken and turkey', meat: 'Beef, pork and lamb', fish: 'Fish and seafood',
  vegetarian: 'Beans, lentils and tofu', soups: 'Soups and stews', 'pizza-pies': 'Pizza and pies', sweets: 'Sweet things',
  maltese: 'Maltese', shakes: 'Shakes and smoothies', components: 'Sauces and components', 'saved-meals': 'Simple combinations',
};
const STATUS = { 'ai-untested': 'AI-written, not kitchen-tested', 'user-reviewed': 'Reviewed by you', tested: 'Kitchen-tested' };
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

const PATHS = { log: '/api/food/log', quick: '/api/food/quick', meal: '/api/food/meals/log', recipe: '/api/food/recipes/log', batch: '/api/food/batches/log' };

// Every diary write carries an id made here, so a write sent again (or replayed after being offline)
// lands once. Without a connection it waits on the phone and syncs later.
async function foodPost(op, data, preview = {}) {
  const body = { ...data, id: data.id || uuid() };
  try {
    return await api('POST', PATHS[op], body);
  } catch (err) {
    if (err.status !== 0) throw err;
    store.set(QUEUE, [...queue(), { id: body.id, op, data: body, preview: { date: f().day?.date || localToday(), ...preview }, at: Date.now() }]);
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
}

async function loadExtras() {
  const [recent, drinks, batches] = await Promise.all([
    api('GET', '/api/food/recent').then((r) => r.items).catch(() => null),
    api('GET', '/api/food/recent?drinks=1').then((r) => r.items).catch(() => null),
    api('GET', '/api/food/batches').then((r) => r.batches).catch(() => null),
  ]);
  if (recent) store.set('oath.foodRecent', recent);
  if (drinks) store.set('oath.foodDrinks', drinks);
  f().recent = recent || store.get('oath.foodRecent', []);
  f().drinks = drinks || store.get('oath.foodDrinks', []);
  f().batches = batches || [];
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
  }
}

async function refresh() {
  await loadFood();
  ctx.render();
}

// The Today screen's small food card is filled in the background.
export function loadFoodToday() {
  api('GET', '/api/food/day').then((d) => {
    state.foodToday = d;
    if (state.route === 'today' && !state.dirty && !state.sheet) ctx.render();
  }).catch(() => {});
}

export function foodTodayCard() {
  const d = state.foodToday;
  if (!d) return '';
  const t = d.total;
  const body = d.entries.length
    ? `<b class="ftc-kcal">${kcal(t)}</b><span class="ftc-sub">protein ${show(t, 'protein')} · carbs ${show(t, 'carbs')} · fat ${show(t, 'fat')}${t.caffeine ? ` · caffeine ${show(t, 'caffeine')}` : ''}</span>`
    : '<span class="ftc-sub">Nothing logged yet today.</span>';
  return `<a class="card food-today-card" href="#/food"><span class="li-ic">${icon('food')}</span><span class="ftc-text"><span class="eyebrow">Food</span>${body}</span>${icon('chevron', 'chev')}</a>`;
}

// ---------- Small pieces ----------

function strip(n, keys = STRIP) {
  return `<dl class="nstrip">${keys.map((k) => `<div><dt>${NUTRIENT[k].label}</dt><dd>${show(n, k)}</dd></div>`).join('')}</dl>`;
}

// Which values some lines don't have, grouped by how many lines: "1 item has no protein, carbs or fat value".
const SHOWN = ['protein', 'carbs', 'sugars', 'fat', 'fibre', 'salt', 'caffeine'];
function missingNote(n) {
  const m = n?.missing || {};
  const groups = new Map();
  for (const k of SHOWN.filter((x) => m[x])) groups.set(m[k], [...(groups.get(m[k]) || []), NUTRIENT[k].label.toLowerCase()]);
  if (!groups.size) return '';
  const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} or ${a.at(-1)}` : a[0]);
  const parts = [...groups].sort((a, b) => a[0] - b[0]).map(([count, names]) => `${count} ${count === 1 ? 'item has' : 'items have'} no ${list(names)} value`);
  return `<p class="note incomplete">${icon('spark')}<span>${parts.join('; ')}. A total with + is at least that much.</span></p>`;
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

function previewHtml(item, qty, unit) {
  const l = line(item, qty, unit);
  if (l.error) return `<p class="note bad">${esc(l.error)}</p>`;
  const amt = l.g !== null && l.basis === 'g' ? `${round(l.g, 1)} g` : l.ml !== null ? `${round(l.ml, 0)} ml` : '';
  return `<div class="fprev"><div class="fprev-main"><b>${kcal(l.nutrients)}</b><span>${esc(amt)}${l.note ? `, ${esc(l.note)}` : ''}</span></div>
    ${strip(l.nutrients)}
    <p class="fprev-extra">Caffeine ${show(l.nutrients, 'caffeine')}${l.nutrients.alcohol ? ` · alcohol ${show(l.nutrients, 'alcohol')}` : ''}</p></div>`;
}

const sourceLine = (it) => `${esc(it.sourceText || it.source)}${it.source_date ? `, ${esc(it.source_date)}` : ''}`;

// ---------- The diary ----------

function dateLabel(d) {
  if (!d) return '';
  if (d.today) return 'Today';
  return fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long' });
}

function entryRow(e) {
  const badges = [e.estimate ? '<span class="tag ftag-est">Estimated</span>' : '', e.kind === 'quick' ? '<span class="tag">Quick add</span>' : '', e.source === 'coach' ? '<span class="tag">Coach</span>' : ''].join('');
  return `<button class="li li-plain food-row" data-action="food-entry" data-eid="${esc(e.id)}">
    <span class="li-body"><span class="li-title">${esc(e.name)}${e.brand ? ` <small class="faint">${esc(e.brand)}</small>` : ''}</span>
    <span class="li-sub">${esc(e.amountText || '')}${badges ? ` ${badges}` : ''}</span></span>
    <span class="li-side"><b>${show(e.nutrients, 'kcal', { unit: false })}</b> kcal</span></button>`;
}

function pendingRows(date) {
  const q = queue().filter((x) => (x.preview?.date || localToday()) === date);
  if (!q.length) return '';
  return `<section class="section"><div class="gh"><h2>Waiting to sync</h2><span class="gh-count">${icon('sync')}${q.length}</span></div>
    <div class="group">${q.map((x) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(x.preview?.name || 'Entry')}</span>
      <span class="li-sub">${esc(x.preview?.amount || '')} · saved on this phone</span></span><span class="li-side">${x.preview?.kcal !== undefined ? `<b>${round(x.preview.kcal, 0)}</b> kcal` : ''}</span></div>`).join('')}</div></section>`;
}

function trayHtml(list) {
  if (!list?.length) return '';
  return `<div class="tray" role="list">${list.slice(0, 10).map((it) => {
    const d = defaults(it);
    return `<button class="tray-chip" role="listitem" data-action="food-tray" data-key="${esc(it.key)}">${it.favourite ? icon('star', 'star-on') : ''}<span>${esc(it.name)}</span><small>${esc(amountText(d.qty, d.unit, it))}</small></button>`;
  }).join('')}</div>`;
}

function batchesHtml(list) {
  if (!list?.length) return '';
  return `<section class="section"><div class="gh"><h2>Cooked batches</h2></div><div class="group">${list.map((b) => {
    const left = b.left.g !== null ? `${round(b.left.g, 0)} g left of ${round(b.final_weight, 0)} g` : `${round(b.left.servings, 1)} of ${round(b.servings, 1)} servings left`;
    return `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(b.name)}</span><span class="li-sub">${esc(left)} · cooked ${fmtDay(b.cookedOn)}</span></span>
      <span class="li-side batch-actions"><button class="btn tinted small" data-action="food-batch-log" data-id="${b.id}">Have some</button><button class="btn plain small" data-action="food-batch-done" data-id="${b.id}">Finished</button></span></div>`;
  }).join('')}</div></section>`;
}

function plansHtml(list) {
  if (!list?.length) return '';
  return `<section class="section"><div class="gh"><h2>Planned</h2><span class="gh-count">not counted until eaten</span></div><div class="group">${list.map((p) => `
    <div class="li li-plain"><span class="li-body"><span class="li-title">${esc(p.name)}</span><span class="li-sub">${SLOT[p.slot] || p.slot}${p.qty ? ` · ${esc(amountText(p.qty, p.unit || 'serving'))}` : ''}</span></span>
    <span class="li-side batch-actions"><button class="btn tinted small" data-action="food-plan-eat" data-id="${p.id}">Eaten</button><button class="icon-btn" data-action="food-plan-del" data-id="${p.id}" aria-label="Remove plan">${icon('close')}</button></span></div>`).join('')}</div></section>`;
}

function viewDiary() {
  const F = f();
  const d = F.day;
  if (!d) return ctx.shell(`${pageHead('Food')}<div class="skeleton"><i></i><i></i><i class="short"></i></div>${sheetHtml()}`);
  const t = d.total;
  const head = pageHead('Food', {
    over: dateLabel(d),
    actions: `<a class="icon-btn" href="#/food/recipes" aria-label="Recipes">${icon('recipe')}</a><a class="icon-btn" href="#/food/meals" aria-label="Saved meals">${icon('star')}</a>`,
  });
  const nav = `<div class="food-date"><button class="icon-btn" data-action="food-day" data-step="-1" aria-label="Previous day">${icon('back')}</button>
    <span>${esc(dateLabel(d))}</span>
    <button class="icon-btn" data-action="food-day" data-step="1" aria-label="Next day"${d.today ? ' disabled' : ''}>${icon('chevron')}</button></div>`;
  const incomplete = t.missing && Object.keys(t.missing).some((k) => NUTRIENT[k]?.core);
  const summary = `<section class="card food-total">
    <div class="ft-main"><b class="ft-kcal">${show(t, 'kcal', { unit: false })}</b><span class="ft-unit">kcal</span>${incomplete ? '<span class="tag ftag-est">Incomplete</span>' : ''}</div>
    ${strip(t)}
    <p class="ft-extra">${icon('drink')}<span>${d.drinksMl || 0} ml of drinks · caffeine ${show(t, 'caffeine')}</span></p>
    ${missingNote(t)}
    ${d.estimates ? `<p class="note">${d.estimates} ${d.estimates === 1 ? 'amount was' : 'amounts were'} estimated from a photo. Tap one to set the real amount.</p>` : ''}
  </section>`;
  const capture = `<div class="food-capture">
    <label class="fc-btn fc-photo">${icon('camera')}<span>Photo</span><input class="vh" type="file" accept="image/*" capture="environment" data-food-photo aria-label="Take a photo of food, a label or a barcode"></label>
    <button class="fc-btn" data-action="food-search">${icon('search')}<span>Search</span></button>
    <button class="fc-btn" data-action="food-quick">${icon('bolt')}<span>Quick add</span></button>
    <button class="fc-btn" data-action="food-search" data-drinks="1">${icon('drink')}<span>Drinks</span></button>
  </div>`;
  const builders = `<div class="builders">${['shake', 'bowl', 'plate'].map((m) => `<button class="btn tinted small" data-action="food-builder" data-mode="${m}">${icon(BUILDERS[m].icon)}${BUILDERS[m].title}</button>`).join('')}<a class="btn tinted small" href="#/food/meals">${icon('star')}Saved</a></div>`;
  const drinks = F.drinks?.length ? `<section class="section"><div class="gh sub"><h3>Drinks</h3><button class="gh-link" data-action="food-search" data-drinks="1">${icon('plus')}Other</button></div>${trayHtml(F.drinks)}</section>` : '';
  const recent = F.recent?.filter((x) => !x.liquid).length ? `<section class="section"><div class="gh sub"><h3>Recent</h3></div>${trayHtml(F.recent.filter((x) => !x.liquid))}</section>` : '';
  const slots = SLOTS.map(([s, label]) => {
    const sl = d.slots.find((x) => x.slot === s);
    if (!sl?.entries.length) return '';
    return `<section class="section"><div class="gh"><h2>${label}</h2><span class="gh-count">${kcal(sl.total)}</span></div><div class="group">${sl.entries.map(entryRow).join('')}</div></section>`;
  }).join('');
  const undo = F.undo ? `<div class="banner food-undo"><span>Removed ${esc(F.undo.name)}.</span><button class="btn tinted small" data-action="food-undo">Undo</button></div>` : '';
  const empty = !d.entries.length ? `<div class="card empty"><h3>Nothing logged${d.today ? ' yet' : ''}</h3><p class="muted">Take a photo of anything (a plate, a label, a barcode), search, or tap a recent food.</p></div>` : '';
  const offline = F.offline ? '<p class="note">Offline. Showing what this phone saved last; new entries wait here and sync when you are back online.</p>' : '';
  ctx.shell(`${head}${offline}${undo}<div class="split food-split"><div>${nav}${summary}${capture}${builders}${drinks}${recent}
    ${plansHtml(d.plans)}${batchesHtml(F.batches)}</div>
    <div>${pendingRows(d.date)}${slots}${empty}
    ${d.today ? `<div class="form-actions food-repeat"><button class="btn tinted small" data-action="food-repeat">${icon('review')}Repeat yesterday</button></div>` : ''}
    <p class="note credits">Generic foods: USDA FoodData Central (public domain). Products: © Open Food Facts contributors, ODbL. Food is a diary only: it never changes HP. <a href="#/food/report">Coverage report</a></p>
    </div></div>${sheetHtml()}`);
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
  const per = it.nutrients?.kcal === null || it.nutrients?.kcal === undefined ? 'energy unknown' : `${round(it.nutrients.kcal, 0)} kcal per 100 ${it.liquid && it.density ? 'g' : it.basis}`;
  return `<button class="li li-plain fr" data-action="food-pick" data-key="${esc(it.key)}">
    <span class="li-body"><span class="li-title">${esc(it.name)}${it.brand ? ` <small class="faint">${esc(it.brand)}</small>` : ''}</span>
    <span class="li-sub">${it.pack ? `${esc(amountText(1, 'pack', it))} · ` : ''}${it.state ? `${esc(it.state.replace(/-/g, ' '))} · ` : ''}${per} ${kindTag(it)}${it.check ? ' <span class="tag ftag-est">Check label</span>' : ''}</span></span>${icon('chevron', 'chev')}</button>`;
}

function resultsHtml(s) {
  const list = s.results ?? (s.drinks ? f().drinks : f().recent) ?? [];
  const label = s.results ? (s.results.length ? '' : `<p class="note">Nothing in the catalogue for "${esc(s.q)}".</p>`) : list.length ? '<p class="eyebrow">Recent</p>' : '';
  return `${label}<div class="group">${list.map(resultRow).join('')}</div>`;
}

function searchBody(s) {
  return `<form data-form="food-search" class="food-search" role="search">
      <input class="input" type="search" name="q" value="${esc(s.q || '')}" placeholder="${s.drinks ? 'Search drinks' : 'Search foods and drinks'}" data-food-q autocomplete="off" enterkeyhint="search" aria-label="Search">
    </form>
    <div id="food-results">${resultsHtml(s)}</div>
    ${s.pick ? '' : `<div class="food-none"><p class="eyebrow">Not here?</p>
      <div class="sheet-actions">
        ${s.q ? `<button class="btn tinted" data-action="food-off">${icon('search')}Search Open Food Facts for "${esc(s.q)}"</button>` : ''}
        <label class="btn tinted">${icon('camera')}Photo of the label or barcode<input class="vh" type="file" accept="image/*" capture="environment" data-food-photo></label>
        <button class="btn tinted" data-action="food-custom">${icon('plus')}Add a food of your own</button>
        <button class="btn tinted" data-action="food-quick">${icon('bolt')}Quick add calories</button>
      </div><p class="note">Oath never swaps in a similar product without asking. A missing product stays missing until you add its label.</p></div>`}`;
}

function foodBody(s) {
  const it = s.item;
  const pickText = s.pick ? (s.pick.purpose === 'recipe-swap' ? 'Swap in' : 'Add') : 'Log it';
  return `<div class="food-head"><p class="li-sub">${it.brand ? `${esc(it.brand)} · ` : ''}${it.state ? `${esc(it.state.replace(/-/g, ' '))} · ` : ''}${kindTag(it)}</p>${it.check ? `<p class="note bad">${esc(it.check)}</p>` : ''}${it.status === 'needs-label' ? '<p class="note">No source has values for this yet. Add your pack\'s label to log it with real numbers.</p>' : ''}</div>
    <form data-form="food-log" class="food-amount">
      <div class="amount-row"><input class="input" name="qty" inputmode="decimal" value="${esc(s.qty)}" data-food-amount aria-label="Amount">
        <select class="input" name="unit" data-food-amount aria-label="Unit">${unitOptions(it, s.unit)}</select></div>
      <div class="pchips">${quickChips(it)}</div>
      <div id="food-preview">${previewHtml(it, s.qty, s.unit)}</div>
      ${s.pick ? '' : slotSelect(s.slot || slotNow(it.liquid))}
      <div class="form-actions"><button class="btn primary" type="submit">${pickText}</button>
        ${s.pick ? '' : `<button class="btn tinted" type="button" data-action="food-plan-open">Plan for later</button>
        <button class="icon-btn${it.favourite ? ' on' : ''}" type="button" data-action="food-fav" aria-pressed="${it.favourite ? 'true' : 'false'}" aria-label="Favourite">${icon('star')}</button>`}</div>
    </form>
    <details class="disclosure food-src"><summary>Per 100 ${it.basis} and source</summary>
      ${strip(it.nutrients, ['kcal', ...STRIP, 'caffeine'])}
      <p class="note">${sourceLine(it)}${it.source_ref?.startsWith('http') ? ` · <a href="${esc(it.source_ref)}" target="_blank" rel="noopener">record</a>` : it.source_ref ? ` · ${esc(it.source_ref)}` : ''}</p>
      ${it.notes ? `<p class="note">${esc(it.notes)}</p>` : ''}
      <p class="note">A "—" means no source gives that value, so it is unknown rather than zero.</p>
    </details>`;
}

function quickBody(s) {
  const n = (name, label, unit) => `<label class="field"><span>${label}${unit ? ` (${unit})` : ''}</span><input class="input" name="${name}" inputmode="decimal" placeholder="unknown"></label>`;
  return `<form data-form="food-quick" class="sheet-form">
    <label class="field"><span>What was it?</span><input class="input" name="name" placeholder="Quick add" maxlength="120"></label>
    <label class="field"><span>Calories (kcal)</span><input class="input" name="kcal" inputmode="decimal" required></label>
    <div class="grid2">${n('protein', 'Protein', 'g')}${n('carbs', 'Carbs', 'g')}${n('sugars', 'Sugars', 'g')}${n('fat', 'Fat', 'g')}${n('caffeine', 'Caffeine', 'mg')}${n('ml', 'Drink volume', 'ml')}</div>
    ${slotSelect(s.slot || slotNow())}
    <p class="note">Blank means unknown, not zero. Quick adds stay in the diary and never enter the catalogue.</p>
    <div class="form-actions"><button class="btn primary" type="submit">Log it</button></div></form>`;
}

function customBody(s) {
  const d = s.draft || {};
  const nv = (k) => (d.nutrients?.[k] === null || d.nutrients?.[k] === undefined ? '' : round(d.nutrients[k], 3));
  const n = (k, label, unit) => `<label class="field"><span>${label} (${unit})</span><input class="input" name="n_${k}" inputmode="decimal" value="${nv(k)}" placeholder="unknown"${k === 'kcal' ? ' required' : ''}></label>`;
  const basis = d.basis === 'ml' ? 'ml' : 'g';
  return `<form data-form="food-custom" class="sheet-form">
    ${s.fromLabel ? '<p class="note">Read from your photo. Check every number against the label before saving.</p>' : ''}
    ${(d.warnings || []).map((w) => `<p class="note bad">${esc(w)}</p>`).join('')}
    <label class="field"><span>Name</span><input class="input" name="name" value="${esc(d.name || '')}" required maxlength="160"></label>
    <div class="grid2"><label class="field"><span>Brand</span><input class="input" name="brand" value="${esc(d.brand || '')}"></label>
      <label class="field"><span>Barcode</span><input class="input mono" name="barcode" inputmode="numeric" value="${esc(d.barcode || '')}"></label></div>
    <fieldset class="field"><span>Values are per</span><div class="seg"><label><input type="radio" name="basis" value="g"${basis === 'g' ? ' checked' : ''}><span>100 g</span></label><label><input type="radio" name="basis" value="ml"${basis === 'ml' ? ' checked' : ''}><span>100 ml</span></label></div></fieldset>
    <div class="grid2">${n('kcal', 'Energy', 'kcal')}${n('protein', 'Protein', 'g')}${n('carbs', 'Carbohydrate', 'g')}${n('sugars', 'of which sugars', 'g')}${n('fat', 'Fat', 'g')}${n('satfat', 'of which saturates', 'g')}${n('fibre', 'Fibre', 'g')}${n('salt', 'Salt', 'g')}${n('caffeine', 'Caffeine', 'mg')}${n('alcohol', 'Alcohol', 'g')}</div>
    <div class="grid2"><label class="field"><span>Package size</span><input class="input" name="pack_size" inputmode="decimal" value="${esc(d.pack?.size || '')}" placeholder="e.g. 500"></label>
      <label class="field"><span>Items inside (multipack)</span><input class="input" name="pack_count" inputmode="numeric" value="${esc(d.pack?.count || '')}" placeholder="1"></label>
      <label class="field"><span>Serving size</span><input class="input" name="serving_size" inputmode="decimal" value="${esc(d.serving?.size || '')}"></label>
      <label class="field"><span>Serving name</span><input class="input" name="serving_label" value="${esc(d.serving?.label || '')}" placeholder="e.g. 1 scoop"></label></div>
    <p class="note">Package and serving sizes use the same unit as the values (g or ml). Leave anything not on the label blank: blank is unknown, not zero.</p>
    <div class="form-actions"><button class="btn primary" type="submit">Save and log</button></div></form>`;
}

function photoBody(s) {
  if (s.busy) return '<div class="photo-busy"><div class="msg assistant typing" aria-label="Reading the photo"><i></i><i></i><i></i></div><p class="note">Reading the photo. It is not stored.</p></div>';
  const r = s.result;
  if (!r) return '';
  if (r.kind === 'product') {
    return `<p class="note">${esc(r.summary || '')}</p><div class="group">${resultRow(r.item)}</div>`;
  }
  if (r.kind === 'product-unknown') {
    const name = [r.read?.brand, r.read?.name, r.read?.variant].filter(Boolean).join(' ');
    return `<p class="note">${r.barcode ? `Barcode ${esc(r.barcode)} is not in Oath or Open Food Facts.` : r.unreadBarcode ? 'The barcode could not be read clearly.' : 'No barcode was readable.'}${name ? ` It looks like <b>${esc(name)}</b>.` : ''}${r.offError ? ` (${esc(r.offError)})` : ''}</p>
      ${r.suggestions?.length ? `<p class="eyebrow">Close matches, only if it is exactly this product</p><div class="group">${r.suggestions.map(resultRow).join('')}</div>` : ''}
      <div class="sheet-actions"><label class="btn primary">${icon('camera')}Photo of the nutrition label<input class="vh" type="file" accept="image/*" capture="environment" data-food-photo></label>
      <button class="btn tinted" data-action="food-custom" data-from-photo="1">${icon('plus')}Type the label in</button>
      <button class="btn tinted" data-action="food-quick">${icon('bolt')}Quick add calories</button></div>`;
  }
  if (r.kind === 'meal') {
    return `<p class="note">${esc(r.summary || '')} The foods come from the catalogue; the amounts are estimates from the photo, so check them.</p>
      <div class="group photo-items">${s.items.map((it, i) => `<div class="li li-plain photo-item">
        <span class="li-body"><span class="li-title">${esc(it.match?.name || it.name)}</span>
        <span class="li-sub">${it.match ? `${kindTag(it.match)} ` : 'No match in the catalogue. '}<button class="linkish" data-action="food-photo-change" data-index="${i}">Change</button></span>
        ${it.match ? `<span class="amount-row small"><input class="input" inputmode="decimal" value="${esc(it.qty ?? '')}" data-photo-index="${i}" data-photo-field="qty" aria-label="Amount">
          <select class="input" data-photo-index="${i}" data-photo-field="unit" aria-label="Unit">${unitOptions(it.match, it.unit)}</select></span>` : ''}</span>
        <span class="li-side"><b data-photo-kcal="${i}">${it.match && it.qty ? kcal(line(it.match, it.qty, it.unit).nutrients || {}) : ''}</b>
          ${it.edited ? '' : '<span class="tag ftag-est">Estimate</span>'}<button class="icon-btn" data-action="food-photo-drop" data-index="${i}" aria-label="Remove">${icon('close')}</button></span></div>`).join('')}</div>
      <form data-form="food-photo-log">${slotSelect(slotNow())}<div class="form-actions"><button class="btn primary" type="submit">Log ${s.items.filter((x) => x.match && x.qty).length} items</button></div></form>`;
  }
  return `<p class="note">${esc(r.question || 'What is it?')}</p><div class="sheet-actions">
    <button class="btn tinted" data-action="food-search">${icon('search')}Search</button><button class="btn tinted" data-action="food-quick">${icon('bolt')}Quick add</button></div>`;
}

function entryBody(s) {
  const e = s.entry;
  const lines = e.lines?.length ? `<p class="eyebrow">What went in</p><div class="group">${e.lines.map((l) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(l.name)}</span><span class="li-sub">${esc(l.amount_text || '')}</span></span><span class="li-side">${l.nutrients ? kcal(l.nutrients) : ''}</span></div>`).join('')}</div>` : '';
  const amount = s.item ? `<form data-form="food-entry-edit"><div class="amount-row"><input class="input" name="qty" inputmode="decimal" value="${esc(e.qty)}" data-food-amount aria-label="Amount">
      <select class="input" name="unit" data-food-amount aria-label="Unit">${unitOptions(s.item, e.unit)}</select></div>
      <div id="food-preview">${previewHtml(s.item, e.qty, e.unit)}</div>${slotSelect(e.slot)}
      <div class="form-actions"><button class="btn primary" type="submit">Save</button></div></form>`
    : `<p class="li-sub">${esc(e.amountText || '')}</p>${strip(e.nutrients, ['kcal', ...STRIP, 'caffeine'])}${missingNote(e.nutrients)}
      <form data-form="food-entry-edit">${slotSelect(e.slot)}<div class="form-actions"><button class="btn tinted" type="submit">Move</button></div></form>`;
  return `${e.estimate ? '<p class="note">The amount was estimated from a photo. Set the real amount if you know it.</p>' : ''}${amount}${lines}
    <div class="sheet-actions"><button class="btn tinted danger-text" data-action="food-entry-del" data-eid="${esc(e.id)}">${icon('trash')}Remove from the diary</button></div>`;
}

function builderTotals(s) {
  const rows = s.lines.map((l) => (l.ref === 'recipe' ? { nutrients: scale(l.per, l.qty, 1) } : line(l.item, l.qty, l.unit)));
  const bad = rows.find((r) => r.error);
  const whole = total(rows.map((r) => r.nutrients || {}));
  const factor = shareFactor(s);
  const had = scale(whole, factor, 1);
  return `${bad ? `<p class="note bad">${esc(bad.error)}</p>` : ''}
    <div class="fprev"><div class="fprev-main"><b>${kcal(had)}</b><span>${factor === 1 ? 'all of it' : `${round(factor * 100, 0)}% of ${kcal(whole)}`}</span></div>${strip(had)}<p class="fprev-extra">Caffeine ${show(had, 'caffeine')}</p>${missingNote(had)}</div>`;
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
      ${s.mode === 'shake' ? `<div class="grid2"><label class="field"><span>Finished weight, if weighed (g)</span><input class="input" inputmode="decimal" value="${esc(s.measured || '')}" data-bl-batch="measured"></label>
        <label class="field"><span>You drank (g)</span><input class="input" inputmode="decimal" value="${esc(s.had || '')}" data-bl-batch="had"></label></div>
        <p class="note">Weighing the whole shake and what you drank logs that share. It assumes the shake is well mixed; what stays in the blender is not counted.</p>` : ''}
    </div>
    <div id="builder-total">${builderTotals(s)}</div>
    ${slotSelect(s.slot || slotNow(s.mode === 'shake'))}
    <div class="form-actions"><button class="btn primary" type="submit"${s.lines.length ? '' : ' disabled'}>Log it</button>
      <button class="btn tinted" type="button" data-action="food-bl-save"${s.lines.length ? '' : ' disabled'}>${s.mealId ? 'Save changes' : 'Save as a meal'}</button>
      ${s.mealId ? '<button class="btn plain" type="button" data-action="food-bl-copy">Save a copy</button>' : ''}</div>
  </form>`;
}

function planBody(s) {
  const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('en-CA');
  return `<form data-form="food-plan" class="sheet-form"><p class="li-title">${esc(s.target.name)}</p>
    <label class="field"><span>Day</span><input class="input" type="date" name="date" value="${tomorrow}" min="${localToday()}" required></label>
    ${slotSelect(s.target.slot || 'lunch')}
    <p class="note">A plan is not eaten food: it is not counted until you tap Eaten.</p>
    <div class="form-actions"><button class="btn primary" type="submit">Plan it</button></div></form>`;
}

function batchLogBody(s) {
  const b = s.batch;
  const byWeight = b.final_weight > 0;
  return `<form data-form="food-batch-log" class="sheet-form"><p class="li-sub">${byWeight ? `${round(b.left.g, 0)} g left of ${round(b.final_weight, 0)} g` : `${round(b.left.servings, 2)} servings left`}</p>
    <div class="amount-row"><input class="input" name="qty" inputmode="decimal" value="${byWeight ? '' : 1}" placeholder="${byWeight ? 'grams on your plate' : 'servings'}" required aria-label="Amount">
      <select class="input" name="unit">${byWeight ? '<option value="g">g of the cooked batch</option>' : ''}<option value="serving">servings</option></select></div>
    ${slotSelect(slotNow())}
    <p class="note">Only what you eat is logged. Reheating it later does not log it again.</p>
    <div class="form-actions"><button class="btn primary" type="submit">Log it</button></div></form>`;
}

function cookBody(s) {
  const r = s.recipe;
  return `<form data-form="food-cook" class="sheet-form"><p class="li-sub">${esc(r.name)}, version ${r.version}${s.factor !== 1 ? `, ×${round(s.factor, 2)}` : ''}</p>
    <div class="grid2"><label class="field"><span>Finished weight (g)</span><input class="input" name="final_weight" inputmode="decimal" placeholder="weigh the pot or tray"></label>
      <label class="field"><span>Servings</span><input class="input" name="servings" inputmode="decimal" value="${round(r.servings * s.factor, 2)}"></label></div>
    <label class="field"><span>Cooked on</span><input class="input" type="date" name="cooked_on" value="${localToday()}"></label>
    <p class="note">Weigh the finished batch (without the pot) to log portions by grams. Later edits to the recipe never change this batch.</p>
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
    <label class="field"><span>Name</span><input class="input" name="name" value="${esc(d.name || '')}" required maxlength="120"></label>
    <div class="grid2"><label class="field"><span>Servings it makes</span><input class="input" name="servings" inputmode="decimal" value="${esc(d.servings || 1)}" required></label>
      <label class="field"><span>Finished weight (g), optional</span><input class="input" name="final_weight" inputmode="decimal" value="${esc(d.final_weight || '')}"></label></div>
    <div class="bgroup"><div class="bgroup-head"><h3>Ingredients</h3><button class="gh-link" type="button" data-action="food-re-add">${icon('plus')}Add</button></div>
      ${d.lines.length ? `<div class="group">${d.lines.map((l, i) => `<div class="li li-plain bline"><span class="li-body"><span class="li-title">${esc(l.item?.name || l.name)}</span>
        ${l.item ? `<span class="amount-row small"><input class="input" inputmode="decimal" value="${esc(l.qty)}" data-re-index="${i}" data-re-field="qty" aria-label="Amount">
          <select class="input" data-re-index="${i}" data-re-field="unit" aria-label="Unit">${unitOptions(l.item, l.unit)}</select></span>` : `<span class="li-sub">${esc(amountText(l.qty, l.unit))}</span>`}</span>
        <span class="li-side"><button class="icon-btn" type="button" data-action="food-re-drop" data-index="${i}" aria-label="Remove">${icon('close')}</button></span></div>`).join('')}</div>` : '<p class="note">Add what goes in, with amounts. Name, ingredients and servings are all a recipe needs.</p>'}</div>
    <label class="field"><span>Method (optional, one step per line)</span><textarea class="input" name="method" rows="4">${esc((d.method || []).join('\n'))}</textarea></label>
    <label class="field"><span>Notes (optional)</span><textarea class="input" name="notes" rows="2">${esc(d.notes || '')}</textarea></label>
    <div class="form-actions"><button class="btn primary" type="submit"${d.lines.length ? '' : ' disabled'}>Save recipe</button></div></form>`;
}

function sheetHtml() {
  const s = state.foodSheet;
  if (!s) return '';
  switch (s.kind) {
    case 'search': return sheetWrap(s.pick ? 'Choose a food' : s.drinks ? 'Drinks' : 'Search', searchBody(s), 'tall');
    case 'food': return sheetWrap(s.item.name, foodBody(s));
    case 'quick': return sheetWrap('Quick add', quickBody(s));
    case 'custom': return sheetWrap(s.fromLabel ? 'Check the label' : 'A food of your own', customBody(s), 'tall');
    case 'photo': return sheetWrap(s.busy ? 'Reading the photo' : s.result?.kind === 'meal' ? 'On the plate' : s.result?.kind === 'product' ? 'Found it' : 'From the photo', photoBody(s), 'tall');
    case 'entry': return sheetWrap(s.entry.name, entryBody(s));
    case 'builder': return sheetWrap(s.mealId ? s.name || 'Saved meal' : `New ${(BUILDERS[s.mode] || BUILDERS.meal).title.toLowerCase()}`, builderBody(s), 'tall');
    case 'plan': return sheetWrap('Plan for later', planBody(s));
    case 'batch-log': return sheetWrap(s.batch.name, batchLogBody(s));
    case 'cook': return sheetWrap('Cook a batch', cookBody(s));
    case 'recipe-log': return sheetWrap('Log it', recipeLogBody(s));
    case 'recipe-edit': return sheetWrap(s.draft.key ? 'Edit recipe' : 'New recipe', recipeEditBody(s), 'tall');
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
  const head = pageHead('Recipes', { over: '<a class="back-inline" href="#/food">Food</a>', actions: `<button class="icon-btn accent" data-action="food-recipe-new" aria-label="New recipe">${icon('plus')}</button>` });
  if (!all) return ctx.shell(`${head}<p class="muted">Loading</p>${sheetHtml()}`);
  const fl = F.filter || (F.filter = { q: '', family: '', type: 'all', limit: 60 });
  const q = norm(fl.q);
  const list = all.filter((r) => (!fl.family || r.family === fl.family)
    && (fl.type === 'all' || (fl.type === 'recipes' && ['base', 'variant'].includes(r.type)) || (fl.type === 'combos' && r.type === 'template') || (fl.type === 'components' && r.type === 'component') || (fl.type === 'mine' && r.source === 'you'))
    && (!q || q.split(' ').every((w) => norm(`${r.name} ${r.name_mt || ''} ${(r.tags || []).join(' ')}`).includes(w))));
  const fams = [...new Set(all.map((r) => r.family))].filter(Boolean);
  const types = [['all', 'All'], ['recipes', 'Recipes'], ['combos', 'Shakes and combos'], ['components', 'Components'], ['mine', 'Yours']];
  const counts = all.reduce((a, r) => ({ ...a, [r.type]: (a[r.type] || 0) + 1 }), {});
  ctx.shell(`${head}
    <p class="note">${counts.base || 0} base recipes, ${counts.variant || 0} variants, ${counts.component || 0} components and ${counts.template || 0} shakes and combinations. Library recipes are AI-written and not kitchen-tested; nutrition is worked out from the ingredients.</p>
    <div class="recipe-filters"><input class="input" type="search" placeholder="Search recipes (pastizz, pasta, shake...)" value="${esc(fl.q)}" data-recipe-q aria-label="Search recipes">
      <select class="input" data-recipe-family aria-label="Family"><option value="">All families</option>${fams.map((x) => `<option value="${x}"${x === fl.family ? ' selected' : ''}>${esc(FAMILIES[x] || x)}</option>`).join('')}</select></div>
    <div class="seg small type-seg" role="group" aria-label="Kind">${types.map(([v, l]) => `<button type="button" data-action="food-recipe-type" data-type="${v}" class="${fl.type === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="recipe-list"><div class="group">${list.slice(0, fl.limit).map(recipeRow).join('') || '<p class="note pad">No recipes match.</p>'}</div>
    ${list.length > fl.limit ? `<div class="form-actions"><button class="btn tinted small" data-action="food-recipe-more">Show more (${list.length - fl.limit})</button></div>` : ''}</div>
    ${sheetHtml()}`);
}

function viewRecipe() {
  const r = f().recipe;
  const back = '<a class="back" href="#/food/recipes">' + icon('back') + 'Recipes</a>';
  if (!r) return ctx.shell(`${back}<p class="muted">Loading</p>`);
  const o = f().opts;
  const per = r.perServing || r.totals;
  const groups = [...new Set(r.lines.map((l) => l.grp || ''))];
  const lineRow = (l) => {
    const off = l.optional && l.skipped;
    const swapped = o.swap[l.index];
    return `<div class="li li-plain rline${off ? ' off' : ''}">
      ${l.optional ? `<input class="ropt" type="checkbox" data-action="food-r-opt" data-index="${l.index}"${off ? '' : ' checked'} aria-label="Include ${esc(l.label || l.name)}">` : ''}
      <span class="li-body"><span class="li-title">${esc(cap(l.label || l.name))}${l.optional ? ' <small class="faint">optional</small>' : ''}</span>
        <span class="li-sub">${esc(l.amount_text)} · ${l.ref === 'recipe' ? `<a href="#/food/recipe/${enc(l.ref_key)}">${esc(l.name)}</a>` : esc(l.name)}${swapped ? ' · swapped' : ''}${l.missing ? ' · <b>missing from the catalogue</b>' : ''}</span></span>
      <span class="li-side">${off ? '' : l.nutrients ? kcal(l.nutrients) : ''}${l.ref === 'item' ? `<button class="btn plain small" data-action="food-r-swap" data-index="${l.index}">Swap</button>` : ''}</span></div>`;
  };
  const factors = [[0.5, '×½'], [1, '×1'], [2, '×2'], [3, '×3']];
  const status = STATUS[r.status] || r.status;
  const mine = r.source === 'you';
  ctx.shell(`${back}${pageHead(esc(r.name), { over: esc(FAMILIES[r.family] || r.family || '') })}
    ${r.name_mt ? `<p class="serif mt-big">${esc(r.name_mt)}</p>` : ''}
    ${r.summary ? `<p class="prose">${esc(r.summary)}</p>` : ''}
    <p class="rtags"><span class="tag">${r.type === 'template' ? 'Combination' : r.type === 'component' ? 'Component' : r.type === 'variant' ? 'Variant' : 'Recipe'}</span><span class="tag ${r.status === 'ai-untested' ? 'ftag-est' : ''}">${esc(status)}</span>${mine ? '<span class="tag">Yours</span>' : ''}${r.parent ? ` <a class="tag" href="#/food/recipe/${enc(r.parent.key)}">Based on ${esc(r.parent.name)}</a>` : ''}</p>
    <div class="split"><div>
    <section class="card food-total"><div class="ft-main"><b class="ft-kcal">${show(per, 'kcal', { unit: false })}</b><span class="ft-unit">kcal a serving</span></div>${strip(per)}
      <p class="ft-extra"><span>Whole recipe ${kcal(r.totals)} · serves ${round(r.servings * o.factor, 2)}${r.per100 ? ` · ${kcal(r.per100)} per 100 g` : ''}${(r.prep_min || r.cook_min) ? ` · ${(r.prep_min || 0) + (r.cook_min || 0)} min` : ''}</span></p>
      ${missingNote(r.totals)}${r.errors?.length ? `<p class="note bad">${esc(r.errors.join(' '))}</p>` : ''}</section>
    <div class="seg small" role="group" aria-label="Scale">${factors.map(([v, l]) => `<button type="button" data-action="food-r-factor" data-factor="${v}" class="${o.factor === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="form-actions recipe-actions"><button class="btn primary" data-action="food-r-log">Log a serving</button>
      ${r.type === 'template' ? '<button class="btn tinted" data-action="food-r-builder">Open in the builder</button>' : '<button class="btn tinted" data-action="food-r-cook">Cook a batch</button>'}
      <button class="btn tinted" data-action="food-r-plan">Plan</button><button class="btn tinted" data-action="food-r-dup">${icon('copy')}Make my version</button>
      ${mine ? `<button class="btn tinted" data-action="food-r-edit">Edit</button><button class="btn plain" data-action="food-r-del">Delete</button>` : ''}</div>
    <section class="section"><div class="gh"><h2>Ingredients</h2>${Object.keys(o.swap).length || o.skip.length || o.with.length ? '<button class="gh-link" data-action="food-r-reset">Reset</button>' : ''}</div>
      ${groups.map((g) => `${g ? `<p class="eyebrow">${esc(g)}</p>` : ''}<div class="group">${r.lines.filter((l) => (l.grp || '') === g).map(lineRow).join('')}</div>`).join('')}</section>
    </div><div>
    ${r.method?.length ? `<section class="section"><div class="gh"><h2>Method</h2></div><ol class="method">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol></section>` : ''}
    ${r.variants?.length ? `<section class="section"><div class="gh"><h2>Variants</h2></div><div class="group">${r.variants.map((v) => `<a class="li li-nav" href="#/food/recipe/${enc(v.key)}"><span class="li-body"><span class="li-title">${esc(v.name)}</span></span>${icon('chevron', 'chev')}</a>`).join('')}</div></section>` : ''}
    ${r.notes ? `<details class="disclosure"><summary>Notes</summary><p class="note">${esc(r.notes)}</p></details>` : ''}
    <p class="note">${r.source === 'oath' ? 'Original to Oath. AI-written and not kitchen-tested; amounts and times are a starting point.' : 'Your recipe.'} Nutrition comes from the ingredient records (USDA FoodData Central unless marked) and is only as complete as they are.</p>
    </div></div>${sheetHtml()}`);
}

// ---------- Saved meals ----------

function viewMeals() {
  const meals = f().meals;
  const head = pageHead('Saved meals', { over: '<a class="back-inline" href="#/food">Food</a>' });
  if (!meals) return ctx.shell(`${head}<p class="muted">Loading</p>${sheetHtml()}`);
  ctx.shell(`${head}
    <div class="builders">${['shake', 'bowl', 'plate', 'meal'].map((m) => `<button class="btn tinted small" data-action="food-builder" data-mode="${m}">${icon('plus')}${BUILDERS[m].title}</button>`).join('')}</div>
    ${meals.length ? `<div class="group">${meals.map((m) => `<div class="li li-plain">
      <span class="li-ic">${icon((BUILDERS[m.kind] || BUILDERS.meal).icon)}</span>
      <button class="li-body linkish-block" data-action="food-meal-open" data-id="${m.id}"><span class="li-title">${esc(m.name)}</span><span class="li-sub">${m.lines.length} items · ${kcal(m.nutrients)}</span></button>
      <span class="li-side"><button class="btn tinted small" data-action="food-meal-log" data-id="${m.id}">Log</button></span></div>`).join('')}</div>`
      : '<div class="card empty"><h3>No saved meals yet</h3><p class="muted">Build a shake, fruit bowl or plate and save it. Next time it is one tap, even offline.</p></div>'}
    <p class="note">Shake presets and simple combinations are in <a href="#/food/recipes">Recipes</a>; open one in the builder to make it yours.</p>
    ${sheetHtml()}`);
}

// ---------- Coverage report ----------

function viewReport() {
  const r = f().report;
  const head = pageHead('Coverage', { over: '<a class="back-inline" href="#/food">Food</a>' });
  if (!r) return ctx.shell(`${head}<p class="muted">Loading</p>`);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const cat = (c, list) => {
    const good = list === 'food' ? (c.counts.mapped || 0) + (c.counts.products || 0) + (c.counts.recipe || 0) : c.counts.covered || 0;
    return `<details class="disclosure cov"><summary><span class="cov-name">${esc(c.label || c.category)}</span><span class="cov-n">${good}/${c.total}</span>
      <span class="pbar thin"><i style="width:${pct(good, c.total)}%"></i></span></summary>
      <p class="note">${Object.entries(c.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      ${c.open.length ? `<ul class="cov-open">${c.open.map((o) => `<li><b>${esc(o.name)}</b> <span class="tag">${esc(o.state)}</span>${o.issue ? ` ${esc(o.issue)}` : ''}</li>`).join('')}</ul>` : ''}</details>`;
  };
  ctx.shell(`${head}
    <div class="stats cov-stats">
      <div class="card"><p class="eyebrow">Foods on the list</p><b class="big">${r.foods.matched}<small>/${r.foods.total}</small></b><p class="note">${r.foods.incomplete} partial or estimated, ${r.foods.missing} missing. Products count once a matching product is in the catalogue.</p></div>
      <div class="card"><p class="eyebrow">Recipe starting points</p><b class="big">${r.recipes.covered}<small>/${r.recipes.total}</small></b><p class="note">Library: ${r.recipes.byType.base || 0} base, ${r.recipes.byType.variant || 0} variants, ${r.recipes.byType.component || 0} components, ${r.recipes.byType.template || 0} combinations.</p></div>
      <div class="card"><p class="eyebrow">Catalogue</p><b class="big">${r.catalogue.generic + r.catalogue.estimates}</b><p class="note">${r.catalogue.generic} generic and ${r.catalogue.estimates} estimates from USDA, ${r.catalogue.products} products, ${r.catalogue.needsLabel ? `${r.catalogue.needsLabel} waiting for a label, ` : ''}${r.catalogue.yours} of yours, ${r.catalogue.recipes} recipes.</p></div>
    </div>
    <section class="section"><div class="gh"><h2>Foods by category</h2></div>${r.foods.categories.map((c) => cat(c, 'food')).join('')}</section>
    <section class="section"><div class="gh"><h2>Recipes by family</h2></div>${r.recipes.categories.map((c) => cat(c, 'recipe')).join('')}</section>`);
}

export function viewFood() {
  const p = state.param;
  if (p === 'recipes') return viewRecipes();
  if (p === 'recipe') return viewRecipe();
  if (p === 'meals') return viewMeals();
  if (p === 'report') return viewReport();
  return viewDiary();
}

// ---------- Actions ----------

function openSheet(s) {
  state.foodSheet = s;
  ctx.render();
  const first = document.querySelector('.food-sheet [data-food-q], .food-sheet [data-food-amount], .food-sheet .input');
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
  const d = defaults(item);
  openSheet({ kind: 'food', item, qty: d.qty, unit: d.unit, pick: s?.pick || null, back: s?.pick ? s.back : null });
}

function backToBuilder(s, mutate) {
  const b = s.back;
  if (mutate) mutate(b);
  openSheet(b);
}

async function afterLog(r, name) {
  haptic();
  if (r?.queued) toast(`${name} saved on this phone. It syncs when you are back online.`);
  else toast(r?.duplicate ? 'Already logged.' : `Logged ${name}.`);
  state.foodSheet = null;
  state.foodToday = null;
  if (state.route === 'food' && !state.param) await refresh().catch(() => ctx.render());
  else ctx.render();
}

const photoItemsFrom = (r) => (r.items || []).map((x) => ({ ...x, edited: false }));

async function readPhoto(input) {
  const file = input.files?.[0];
  if (!file) return;
  state.foodSheet = { kind: 'photo', busy: true };
  ctx.render();
  try {
    const image = await shrink(file);
    const result = await api('POST', '/api/food/photo', { image, media_type: 'image/jpeg' });
    if (result.kind === 'label') {
      openSheet({ kind: 'custom', draft: result.draft, fromLabel: true });
      return;
    }
    if (result.kind === 'product') {
      const d = defaults(result.item);
      openSheet({ kind: 'food', item: result.item, qty: d.qty, unit: d.unit });
      toast(`Found ${result.item.name}.`);
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
async function shrink(file) {
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
  const s = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
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

export async function foodClick(a, el) {
  if (!a.startsWith('food-')) return false;
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
      F.day = null;
      ctx.render();
      await act(() => loadDay());
      ctx.render();
      return true;
    }
    case 'food-search':
      openSheet({ kind: 'search', q: '', drinks: el.dataset.drinks === '1', results: null });
      return true;
    case 'food-quick':
      openSheet({ kind: 'quick' });
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
      document.getElementById('food-preview').innerHTML = previewHtml(s.item, s.qty, s.unit);
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
      const r = await act(() => api('POST', '/api/food/meals', body), a === 'food-bl-copy' ? 'Saved a copy.' : 'Saved. It is one tap from now on.');
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
    case 'food-meal-log': {
      const m = (F.meals || []).find((x) => x.id === Number(el.dataset.id));
      const r = await act(() => foodPost('meal', { meal_id: m.id, slot: slotNow(m.kind === 'shake') }, { name: m.name, amount: `${m.lines.length} items`, kcal: m.nutrients?.kcal }));
      if (r) await afterLog(r, m.name);
      return true;
    }
    case 'food-photo-change':
      openSheet({ kind: 'search', q: s.items[Number(el.dataset.index)].search || '', results: null, pick: { purpose: 'photo', index: Number(el.dataset.index) }, back: s });
      return true;
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
      if (await act(() => api('POST', `/api/food/batches/${el.dataset.id}/finish`, {}), 'Batch marked finished. Leftovers are not counted.')) await refresh();
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
      const r = await act(() => api('POST', `/api/food/recipes/${enc(F.recipe.key)}/duplicate`, {}), 'Your version is saved. Change it freely.');
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
        lines: r.lines.map((l, i) => ({ ref: l.ref, ref_key: l.ref_key, name: l.name, item: items[i], qty: l.qty, unit: l.unit, label: l.label, optional: l.optional, grp: l.grp })) } });
      return true;
    }
    case 'food-r-del':
      if (!window.confirm(`Delete "${F.recipe.name}"? Entries already logged keep their numbers.`)) return true;
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
  } else if (p.purpose === 'photo') {
    backToBuilder(s, (b) => Object.assign(b.items[p.index], { match: s.item, qty: Number(qty), unit, edited: true }));
  } else if (p.purpose === 'recipe-swap') {
    f().opts.swap[p.index] = { ref: 'item', ref_key: s.item.key, qty: Number(qty), unit };
    state.foodSheet = null;
    await previewRecipe();
  }
}

export async function foodSubmit(kind, form) {
  if (!kind.startsWith('food-')) return false;
  const s = state.foodSheet;
  const o = form2obj(form);
  switch (kind) {
    case 'food-search':
      await runSearch(o.q, true);
      return true;
    case 'food-log': {
      if (s.pick) {
        const l = line(s.item, o.qty, o.unit);
        if (l.error) { toast(l.error, true); return true; }
        await finishPick(s, o.qty, o.unit);
        return true;
      }
      const l = line(s.item, o.qty, o.unit);
      if (l.error) { toast(l.error, true); return true; }
      const r = await act(() => foodPost('log', { key: s.item.key, qty: Number(o.qty), unit: o.unit, slot: o.slot }, { name: s.item.name, amount: amountText(o.qty, o.unit, s.item), kcal: l.nutrients.kcal }));
      if (r) await afterLog(r, s.item.name);
      return true;
    }
    case 'food-quick': {
      const r = await act(() => foodPost('quick', o, { name: o.name || 'Quick add', amount: o.ml ? `${o.ml} ml` : '', kcal: Number(o.kcal) }));
      if (r) await afterLog(r, o.name || 'it');
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
      const item = await act(() => api('POST', s.fromLabel ? '/api/food/label' : '/api/food/items', body), 'Saved. It will come up in search from now on.');
      if (item) {
        const d = defaults(item);
        openSheet({ kind: 'food', item, qty: d.qty, unit: d.unit });
      }
      return true;
    }
    case 'food-photo-log': {
      const items = s.items.filter((x) => x.match && Number(x.qty) > 0);
      let n = 0;
      let queued = false;
      for (const it of items) {
        const l = line(it.match, it.qty, it.unit);
        if (l.error) { toast(`${it.match.name}: ${l.error}`, true); continue; }
        const r = await act(() => foodPost('log', { key: it.match.key, qty: Number(it.qty), unit: it.unit, slot: o.slot, estimate: !it.edited }, { name: it.match.name, amount: amountText(it.qty, it.unit, it.match), kcal: l.nutrients.kcal }));
        if (r) { n += 1; queued = queued || r.queued; }
      }
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
      const r = await act(() => api('POST', '/api/food/plans', { ...t, date: o.date, slot: o.slot }), 'Planned. It is not counted until you tap Eaten.');
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
      const r = await act(() => api('POST', '/api/food/batches', { key: s.recipe.key, final_weight: o.final_weight || null, servings: Number(o.servings) || null, cooked_on: o.cooked_on, ...F.opts }), 'Batch saved. Log portions from the Food tab.');
      if (r) closeSheet();
      return true;
    }
    case 'food-recipe-log': {
      const F = f();
      const r = await act(() => foodPost('recipe', { key: s.recipe.key, qty: Number(o.qty), unit: o.unit, slot: o.slot, ...F.opts }, { name: s.recipe.name, amount: amountText(o.qty, o.unit) }));
      if (r) await afterLog(r, s.recipe.name);
      return true;
    }
    case 'food-recipe-save': {
      saveRecipeDraft(s);
      const d = s.draft;
      const body = { key: d.key, name: d.name, servings: Number(d.servings), final_weight: d.final_weight ? Number(d.final_weight) : null, method: d.method, notes: d.notes,
        lines: d.lines.map((l) => ({ ref: l.ref || 'item', ref_key: l.ref_key || l.item?.key, qty: Number(l.qty), unit: l.unit, label: l.label || (l.item?.name || l.name || '').split(',')[0].toLowerCase(), optional: l.optional, grp: l.grp })) };
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
    if (!off && q.trim() && !s.pick) {
      const none = document.querySelector('.food-none .sheet-actions');
      none?.insertAdjacentHTML('afterbegin', `<button class="btn tinted" data-action="food-off">${icon('search')}Search Open Food Facts for "${esc(q)}"</button>`);
    } else if (off) off.innerHTML = `${icon('search')}Search Open Food Facts for "${esc(q)}"`;
  };
  if (now) await run();
  else searchTimer = setTimeout(run, 220);
}

function onInput(e) {
  const el = e.target;
  const s = state.foodSheet;
  if (el.matches('[data-food-q]')) return runSearch(el.value);
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
    const item = s.item;
    if (!item) return null;
    s.qty = form.qty.value;
    s.unit = form.unit.value;
    document.getElementById('food-preview').innerHTML = previewHtml(item, s.qty, s.unit);
  } else if (el.matches('[data-bl-index]')) {
    const l = s.lines[Number(el.dataset.blIndex)];
    l[el.dataset.blField] = el.dataset.blField === 'qty' ? el.value : el.value;
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
    if (out) out.textContent = kcal(line(it.match, it.qty, it.unit).nutrients || {});
  } else if (el.matches('[data-re-index]')) {
    s.draft.lines[Number(el.dataset.reIndex)][el.dataset.reField] = el.value;
  }
  return null;
}

function onChange(e) {
  const el = e.target;
  if (el.matches('[data-food-photo]')) {
    readPhoto(el);
    return;
  }
  if (el.matches('[data-recipe-family]')) {
    f().filter.family = el.value;
    f().filter.limit = 60;
    ctx.render();
    return;
  }
  if (el.matches('[data-food-amount], [data-bl-index], [data-photo-index], [data-re-index]')) onInput(e);
  if (el.matches('[data-photo-index][data-photo-field="unit"]')) ctx.render();
}

export function initFood(c) {
  ctx = c;
  $app.addEventListener('input', onInput);
  $app.addEventListener('change', onChange);
  window.addEventListener('online', () => flushFood());
}
