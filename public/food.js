// Food: the day's diary, its loading and offline queue, the coach's take, and the way between the Food
// pages. The pieces live beside it: food-parts.js (what every screen draws with), food-sheets.js,
// food-recipes.js, food-trends.js and food-actions.js (what taps, forms and typing do).
// Every number comes from nutrition.js, the same maths the server uses. Unknown stays unknown:
// "–" is a value nobody has sourced, "+" a total missing some lines, "~" a value filled by estimate.
import {
  $app, state, esc, api, toast, fmtDay, icon, pageHead, localToday, localNowHM, num, redrawIfIdle, uuid, store, cap,
} from './ui.js';
import { show, round, amountText } from './nutrition.js';
// Grades and tags come from the shared maths when it has them.
import * as N from './nutrition.js';
import { initTagDb, rowTags, loadTags, viewTags } from './food-tagdb.js';
import { richHtml } from './rich.js';
// Real burn: the Body tab's cards and the diary tile.
import { burnTile, loadEnergy } from './food-energy.js';
import { initScan } from './scan.js';
// One-tap logging, water, what is left today, per-meal copy and add, swipe to remove.
import { initUsual, loadUsual, usualHtml, usualItemKeys, waterHtml, slotAction, emptySlotsHtml } from './food-usual.js';
import { initNext, loadNext, nextCardHtml } from './food-next.js';
// The food chat: "What did you eat?" as a conversation, opened from the bar on the diary.
import { initChat, viewChat, chatWaiting, loadChatDay } from './food-chat.js';
import {
  SLOTS, SLOT, f, enc, kcal, fmtN, share, itemGrade, tagMini, filledSet, val, needs, refAt, riPct, pctText, riTone,
  riBar, shortLabel, enter, MACROS, MACRO_LABEL, macroParts, energyRing, foodRing, gradeMix, mealBar, barsHtml,
  slotSelect, slotNow, unitOptions, defaults, dateLabel, infoBtn, infoLine,
} from './food-parts.js';
import {
  initFoodSheets, reviewItem, roughAmount, reviewNutrients, setReviewField, asMealSeg, ownEditor, reviewKcal, sheetHtml,
} from './food-sheets.js';
import { initFoodRecipes, viewRecipes, viewRecipe, viewMeals, viewReport } from './food-recipes.js';
import { initFoodTrends, trendTab, viewTrends } from './food-trends.js';
import {
  initFoodActions, openSheet, itemFor, afterLog, logReviewed, photoItemsFrom, openProduct, shrink, openBuilderFromLines,
  foodClick, runSearch, sizeText, onInput, onChange, onKey,
} from './food-actions.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };

// ---------- Phone storage: the offline queue and the last copies of what the tray needs ----------

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
    // A waiting entry keeps the day and time it was eaten, not the moment it syncs. A past day's entry
    // goes in at noon, as it does online; a copy names its own day.
    if (op !== 'repeat') {
      const today = localToday();
      body.date ||= today;
      if (body.date === today) body.time ||= localNowHM();
    }
    store.set(QUEUE, [...queue().filter((x) => x.id !== body.id), { id: body.id, op, data: body, preview: { date: body.date || localToday(), ...preview }, at: Date.now() }]);
    return { queued: true };
  }
}

// The diary's day when it shows a past one: what is logged from it goes to that day, not today.
function pastDay() {
  const d = f().day;
  return state.route === 'food' && !state.param && d && !d.today ? d.date : null;
}
const dated = () => (pastDay() ? { date: pastDay() } : {});

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
    // In the background: the screen redraws when it is quiet, never under a half-filled sheet.
    if (state.route === 'food') {
      await loadFood();
      redrawIfIdle('food', ctx.render);
    }
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
    // Offline, the phone's copy stands in only for the day it is: after midnight yesterday's is not today.
    const c = err.status === 0 ? store.get('oath.foodDay', null) : null;
    if (!c || c.date !== (d || localToday())) throw err;
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
    <div class="ftake-head"><span class="ftake-k">Coach</span>${t.text ? `<a class="ftake-reply" href="#/coach?ask=${enc(ask)}">Reply${icon('chevron')}</a>` : ''}</div>${body}</section>`;
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
  } else if (p === 'tags') {
    await loadTags(state.param2);
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

// The skips, swaps and scale chosen on a recipe's page go with that recipe only; one logged from elsewhere
// (What to eat next) goes as written.
const optsFor = (recipe) => (recipe && F.recipe?.key === recipe.key ? F.opts : {});

// ---------- The diary ----------

function entryRow(e) {
  const fl = filledSet(e.filled);
  const est = e.estimate || fl.has('kcal');
  const tags = rowTags(e.tags, 2);
  return `<button class="li li-plain food-row" data-action="food-entry" data-eid="${esc(e.id)}" data-swipe="remove">
    ${foodRing(e.nutrients, e.grade)}
    <span class="li-body"><span class="li-title">${esc(e.name)}</span>
    <span class="li-sub">${e.brand ? `<span class="fr-brand">${esc(e.brand)}</span>` : ''}<span class="fr-amt">${esc(e.amountText || '')}</span>${tags.map(tagMini).join('')}</span></span>
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

function viewDiary() {
  const F = f();
  const d = F.day;
  const head = pageHead('Food', {
    actions: `<a class="icon-btn" href="#/food/trends" aria-label="Trends">${icon('trend')}</a><a class="icon-btn" href="#/food/recipes" aria-label="Recipes">${icon('recipe')}</a><a class="icon-btn" href="#/food/meals" aria-label="Saved meals">${icon('star')}</a><a class="icon-btn" href="#/food/tags" aria-label="Tags">${icon('tag')}</a>`,
  });
  if (!d) return ctx.shell(`${head}<div class="skeleton"><i></i><i></i><i class="short"></i></div>${sheetHtml()}`);
  const t = d.total;
  const anim = enter('diary');
  const slots = SLOTS.map(([s, label]) => {
    const sl = d.slots.find((x) => x.slot === s);
    if (!sl?.entries.length) return '';
    return `<section class="section fslot fslot-${s}"><div class="gh"><h2>${label}</h2><span class="gh-side"><span class="gh-count">${kcal(sl.total)}</span>${slotAction(d, s)}</span></div>${mealBar(sl.total, num(t.kcal))}<div class="group">${sl.entries.map(entryRow).join('')}</div></section>`;
  }).join('');
  const undo = F.undo ? `<div class="banner food-undo"><span>${F.undo.verb || 'Removed'} ${esc(F.undo.name)}.</span><button class="btn tinted small" data-action="food-undo">Undo</button></div>` : '';
  const empty = !d.entries.length ? `<div class="card fempty"><p>Nothing logged${d.today ? ' yet' : ''}</p></div>` : '';
  const offline = F.offline ? `<div class="banner offline">${icon('clock')}<span><b>Offline.</b> New entries sync later.</span></div>` : '';
  const repeat = d.today ? `<div class="form-actions food-repeat"><button class="btn tinted small" data-action="food-repeat">Repeat yesterday</button></div>` : '';
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
    <div class="fcap-tools" role="group" aria-label="More ways to log">${tools.map(([a, ic, l, extra]) => `<button type="button" class="fcap-tool" data-action="${a}"${extra}><span>${l}</span></button>`).join('')}</div>
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
  const has = d.entries.length > 0;
  // A past day with nothing logged is unknown, never zero: its ring and macros say "–".
  const t = has || d.today ? d.total : N.unknown();
  const fl = new Set(d.entries.flatMap((e) => e.filled || []));
  const need = refAt('kcal');
  const kcal = num(t.kcal);
  const floor = Boolean(t.missing?.kcal);
  const center = `<b>${has ? show(t, 'kcal', { unit: false }) : d.today ? '0' : '–'}</b><small>${need ? `of ${fmtN(need)} kcal` : 'kcal'}</small>`;
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

export function viewFood() {
  const p = state.param;
  if (p === 'trends') return viewTrends();
  if (p === 'recipes') return viewRecipes();
  if (p === 'recipe') return viewRecipe();
  if (p === 'meals') return viewMeals();
  if (p === 'report') return viewReport();
  if (p === 'chat') return viewChat();
  if (p === 'tags') return viewTags();
  return viewDiary();
}

export function initFood(c) {
  ctx = c;
  initFoodSheets({ pastDay });
  initFoodRecipes({ ...ctx });
  initFoodTrends({ ...ctx, takeHtml });
  initFoodActions({ ...ctx, refresh, dated, foodPost, loadDay, loadTrends, optsFor });
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
  initTagDb({ f, sheetHtml, shell: (html) => ctx.shell(html), render: () => ctx.render() });
  initChat({
    f, store, uuid, openSheet, runSearch, defaults, reviewItem, reviewKcal, reviewNutrients, setReviewField, asMealSeg, ownEditor, roughAmount, unitOptions, itemGrade, foodRing, macroParts, energyRing,
    logReviewed, shrink, slotNow, SLOT, SLOTS, photoItemsFrom, fmtN, cap, sizeText, sheetHtml,
    shell: (html) => ctx.shell(html), render: () => ctx.render(),
  });
}
