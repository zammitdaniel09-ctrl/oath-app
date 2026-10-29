// What Food's taps, forms and typing do: opening sheets, picking and logging foods, the builders,
// photos, recipes and plans, and search as you type with live previews.
import {
  state, api, haptic, toast, uuid, act, reduced, localToday, confirmSheet, store, redrawIfIdle, form2obj, icon, esc,
} from './ui.js';
import { f, enc, defaults, kcal, slotNow, BUILDERS, withFill, previewHtml, itemFacts } from './food-parts.js';
import { unitsFor, total, amountText, line, scale, norm } from './nutrition.js';
import { chatAfterLog, chatClick, chatPicked, chatSubmit, chatInput, chatPhoto } from './food-chat.js';
import {
  reviewItem, ownParts, reviewNutrients, resultsHtml, shareFactor, builderTotals, setReviewField, reviewKcal,
  reviewTotal,
} from './food-sheets.js';
import { energyClick, loadEnergy, energySubmit } from './food-energy.js';
import { scanClick } from './scan.js';
import { usualClick, undoLog, usualSubmit } from './food-usual.js';
import { nextClick } from './food-next.js';
import { importClick, importSubmit, needsFix, importFields, importTyped } from './food-import.js';
import { tagsClick, tagsInput } from './food-tagdb.js';
import { TAB_CARDS, TAB_KEY, sourceList } from './food-trends.js';

let ctx = {
  shell: () => {}, render: () => {}, go: async () => {}, refresh: () => {}, dated: null, foodPost: () => {},
  loadDay: () => {}, loadTrends: () => {}, optsFor: null,
};
export function initFoodActions(c) {
  ctx = { ...ctx, ...c };
}

export function openSheet(s) {
  state.foodSheet = s;
  ctx.render();
  const first = document.querySelector('.food-sheet [data-food-q], .food-sheet [data-food-amount], .food-sheet .sheet-form .input');
  first?.focus({ preventScroll: true });
}

function closeSheet() {
  state.foodSheet = null;
  ctx.render();
}

export async function itemFor(key) {
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

export async function afterLog(r, name, info = {}) {
  haptic('log-food');
  if (state.route === 'food' && state.param === 'chat') {
    await chatAfterLog({ name, nutrients: info.nutrients, queued: r?.queued, duplicate: r?.duplicate });
    return;
  }
  if (r?.queued) toast(`${name} saved on this phone. It syncs when you are back online.`);
  else toast(r?.duplicate ? 'Already logged.' : `Logged ${name}.`);
  state.foodSheet = null;
  state.foodToday = null;
  if (state.route === 'food' && !state.param) await ctx.refresh().catch(() => ctx.render());
  else ctx.render();
}

// Logs reviewed foods, a photo's from its sheet or a meal's from the food chat: a matched food at its
// amount, and a food with no record as an estimated quick add. Says how many landed and whether any is
// waiting on this phone.
// As one meal (`asMeal`, two or more foods): one diary entry named `name`, each food inside it with its
// own amount, values and estimate; `id` keeps a retry from logging it twice.
export async function logReviewed(items, slot, { asMeal = false, name = '', id = null } = {}) {
  const ready = items.filter((it) => reviewItem(it).mode !== 'none');
  if (asMeal && ready.length > 1) {
    const lines = ready.map((it) => (reviewItem(it).mode === 'match'
      ? { ref: 'item', ref_key: it.match.key, qty: Number(it.qty), unit: it.unit, ...(it.fill ? { fill: it.fill } : {}) }
      : { ref: 'own', ...ownParts(it) }));
    const title = String(name || '').trim() || 'Meal';
    const kcal = total(ready.map(reviewNutrients)).kcal;
    const body = { lines, name: title, slot, estimate: ready.some((it) => !it.edited), id: id || uuid(), ...ctx.dated() };
    const r = await act(() => ctx.foodPost('meal', body, { name: title, amount: `${lines.length} foods`, kcal }));
    return { n: r ? 1 : 0, queued: Boolean(r?.queued), meal: Boolean(r) };
  }
  let n = 0;
  let queued = false;
  for (const it of items) {
    const m = reviewItem(it);
    let r = null;
    if (m.mode === 'match') {
      // The matched record's gaps, estimated per 100, go back with the line so the server keeps them.
      const body = { key: it.match.key, qty: Number(it.qty), unit: it.unit, slot, estimate: !it.edited, id: it.logId, ...(it.fill ? { fill: it.fill } : {}), ...ctx.dated() };
      r = await act(() => ctx.foodPost('log', body, { name: it.match.name, amount: amountText(it.qty, it.unit, it.match), kcal: m.line.nutrients.kcal }));
    } else if (m.mode === 'rough' || m.mode === 'own') {
      // Not in the catalogue, or with his own values: a quick add with its weight, marked as an estimate
      // when it is one.
      const body = { ...ownParts(it), slot, id: it.logId, ...ctx.dated() };
      r = await act(() => ctx.foodPost('quick', body, { name: body.name, amount: body.amount, kcal: body.kcal ?? it.guess?.kcal }));
    } else if (m.error) toast(`${it.match.name}: ${m.error}`, true);
    if (r) { n += 1; queued = queued || r.queued; }
  }
  return { n, queued };
}

// Each reviewed item carries the id its entry will be logged under, so Log all sent again (a failed try,
// a double tap) lands each entry once: the server keeps the first of an id.
export const photoItemsFrom = (r) => (r.items || []).map((x) => ({ ...x, edited: false, logId: uuid() }));

// A product found by its barcode, from a photo or the live scanner, opens straight on its sheet. A scan
// started while choosing a food for a builder or recipe carries on choosing.
export function openProduct(item, from = null) {
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
export async function shrink(file, long = 1600, quality = 0.82) {
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

export async function openBuilderFromLines(base, lines) {
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
  if (a.startsWith('food-burn-')) return energyClick(a, el, ctx.refresh);
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
      await act(() => ctx.loadDay());
      ctx.render();
      return true;
    }
    case 'food-info': {
      const key = el.dataset.key;
      F.info = { ...(F.info || {}), [key]: !F.info?.[key] };
      ctx.render();
      return true;
    }
    case 'food-tag':
    case 'food-tags-mode':
      return tagsClick(a, el);
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
      } else if (state.foodSheet === s) {
        // It failed (the toast says why): the results go back to what they were.
        const again = document.getElementById('food-results');
        if (again) again.innerHTML = resultsHtml(s);
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
      const r = await act(() => ctx.foodPost('log', { key: item.key, qty: d.qty, unit: d.unit, slot: slotNow(item.liquid), ...ctx.dated() }, { name: item.name, amount: amountText(d.qty, d.unit, item), kcal: l.nutrients?.kcal }));
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
        // The banner goes in place: a full redraw then would close a half-filled sheet and its keyboard.
        setTimeout(() => {
          if (F.undo?.id !== id) return;
          F.undo = null;
          document.querySelector('.food-undo')?.remove();
        }, 10000);
        state.foodSheet = null;
        await ctx.refresh();
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
      if (u && await act(() => api('POST', `/api/food/log/${enc(u.id)}/restore`, {}), 'Back in the diary.')) await ctx.refresh();
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
      s.dirty = true;
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
        s.dirty = false; // the stored meal is what is on screen now
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
      const r = await act(() => ctx.foodPost('meal', { meal_id: m.id, slot: slotNow(m.kind === 'shake') }, { name: m.name, amount: `${m.lines.length} items`, kcal: m.nutrients?.kcal }));
      if (r) await afterLog(r, m.name);
      return true;
    }
    case 'food-review-mode':
      s.asMeal = el.dataset.mode === 'meal';
      haptic('toggle');
      ctx.render();
      return true;
    case 'food-photo-own': {
      const it = s.items[Number(el.dataset.index)];
      if (it) it.ownOpen = !it.ownOpen;
      ctx.render();
      return true;
    }
    case 'food-photo-own-reset': {
      const it = s.items[Number(el.dataset.index)];
      if (it) delete it.own;
      ctx.render();
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
      await act(() => ctx.loadTrends());
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
      await act(() => ctx.loadTrends());
      ctx.render();
      document.querySelector(`[data-action="food-trend-day"][data-date="${date}"]`)?.focus({ preventScroll: true });
      return true;
    }
    case 'food-photo-drop':
      s.items.splice(Number(el.dataset.index), 1);
      ctx.render();
      return true;
    case 'food-plan-eat': {
      const r = await act(() => api('POST', `/api/food/plans/${el.dataset.id}/eat`, { id: uuid(), ...ctx.dated() }), 'Logged as eaten.');
      if (r) await ctx.refresh();
      return true;
    }
    case 'food-plan-del':
      if (await act(() => api('DELETE', `/api/food/plans/${el.dataset.id}`))) await ctx.refresh();
      return true;
    case 'food-batch-log': {
      const b = F.batches.find((x) => x.id === Number(el.dataset.id));
      if (b) openSheet({ kind: 'batch-log', batch: b });
      return true;
    }
    case 'food-batch-done': {
      const name = (F.batches || []).find((x) => x.id === Number(el.dataset.id))?.name || 'this batch';
      if (!await confirmSheet(`Mark ${name} as finished?`, 'It comes off the list, so no more can be logged from it. What you already logged stays.', 'Mark finished', { danger: false })) return true;
      if (await act(() => api('POST', `/api/food/batches/${el.dataset.id}/finish`, {}), 'Batch finished.')) await ctx.refresh();
      return true;
    }
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
      b.dirty = true; // a saved meal changed on screen logs as it now is
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
  if (kind === 'food-weight') return energySubmit(kind, form, ctx.refresh);
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
      const r = await act(() => ctx.foodPost('log', { key: s.item.key, qty: Number(o.qty), unit: o.unit, slot: o.slot, ...(s.fill ? { fill: s.fill } : {}), ...ctx.dated() }, { name: s.item.name, amount: amountText(o.qty, o.unit, s.item), kcal: l.nutrients.kcal }));
      if (r) await afterLog(r, s.item.name, { nutrients: l.nutrients });
      return true;
    }
    case 'food-quick': {
      const r = await act(() => ctx.foodPost('quick', { ...o, ...ctx.dated() }, { name: o.name || 'Quick add', amount: o.ml ? `${o.ml} ml` : '', kcal: Number(o.kcal) }));
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
        // What the photo read off the ingredient list (allergens, traces, E numbers) goes with it.
        ...(s.draft?.facts ? { facts: s.draft.facts } : {}),
      };
      const item = await act(() => api('POST', s.fromLabel ? '/api/food/label' : '/api/food/items', body), 'Saved.');
      if (item) {
        const d = defaults(item);
        openSheet({ kind: 'food', item, qty: d.qty, unit: d.unit });
      }
      return true;
    }
    case 'food-photo-log': {
      s.mealLogId = s.mealLogId || uuid();
      const name = o.meal_name ?? s.mealName ?? s.result?.summary ?? '';
      const { n, queued, meal } = await logReviewed(s.items, o.slot, { asMeal: s.asMeal !== false, name, id: s.mealLogId });
      if (n) await afterLog({ queued }, meal ? (String(name).trim() || 'the meal') : `${n} ${n === 1 ? 'item' : 'items'}`);
      return true;
    }
    case 'food-entry-edit': {
      const body = { slot: o.slot };
      if (o.qty !== undefined && s.item) Object.assign(body, { qty: Number(o.qty), unit: o.unit });
      if (await act(() => api('PATCH', `/api/food/log/${enc(s.entry.id)}`, body), 'Saved.')) {
        state.foodSheet = null;
        await ctx.refresh();
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
      const data = { ...(s.mealId ? { meal_id: s.mealId } : { lines: builderLines(s) }), factor, slot: o.slot, name, ...ctx.dated() };
      // An edited saved meal logs what is on screen, not the stored version.
      if (s.mealId && s.dirty) Object.assign(data, { meal_id: undefined, lines: builderLines(s) });
      const r = await act(() => ctx.foodPost('meal', data, { name, amount: `${s.lines.length} items`, kcal: kc }));
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
      const r = await act(() => ctx.foodPost('batch', { batch_id: s.batch.id, qty: Number(o.qty), unit: o.unit, slot: o.slot, ...ctx.dated() }, { name: s.batch.name, amount: `${o.qty} ${o.unit}` }));
      if (r) await afterLog(r, s.batch.name);
      return true;
    }
    case 'food-cook': {
      const F = f();
      const r = await act(() => api('POST', '/api/food/batches', { key: s.recipe.key, final_weight: o.final_weight || null, servings: Number(o.servings) || null, cooked_on: o.cooked_on, ...ctx.optsFor(s.recipe) }), 'Batch saved.');
      if (r) closeSheet();
      return true;
    }
    case 'food-recipe-log': {
      const F = f();
      const r = await act(() => ctx.foodPost('recipe', { key: s.recipe.key, qty: Number(o.qty), unit: o.unit, slot: o.slot, ...ctx.optsFor(s.recipe), ...ctx.dated() }, { name: s.recipe.name, amount: amountText(o.qty, o.unit) }));
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
export async function runSearch(q, now = false) {
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
export function sizeText(el = document.querySelector('[data-food-text]')) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

export function onInput(e) {
  const el = e.target;
  const s = state.foodSheet;
  if (el.matches('[data-food-q]')) return runSearch(el.value);
  if (tagsInput(el)) return null;
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
  } else if (el.matches('[data-photo-meal]')) {
    s.mealName = el.value;
  } else if (el.matches('[data-photo-index]')) {
    const it = s.items[Number(el.dataset.photoIndex)];
    setReviewField(it, el.dataset.photoField, el.value);
    const out = document.querySelector(`[data-photo-kcal="${el.dataset.photoIndex}"]`);
    if (out) out.innerHTML = reviewKcal(it);
    const tot = document.getElementById('frv-total');
    if (tot) tot.innerHTML = reviewTotal(s.items);
  } else if (el.matches('[data-re-index]')) {
    s.draft.lines[Number(el.dataset.reIndex)][el.dataset.reField] = el.value;
    if (s.draft.imported) importTyped(s.draft, Number(el.dataset.reIndex));
  }
  return null;
}

export function onChange(e) {
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
  if (el.matches('[data-food-amount], [data-bl-index], [data-photo-index], [data-photo-meal], [data-re-index]')) onInput(e);
  if (el.matches('[data-photo-index][data-photo-field="unit"]')) ctx.render();
}

// Return sends a typed meal; Shift+Return adds a new line. The arrow keys move between the Trends tabs.
export function onKey(e) {
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
