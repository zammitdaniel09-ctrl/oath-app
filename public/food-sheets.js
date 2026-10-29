// The Food sheets: search, a food and its amount, quick add, your own food, the review of a photo or
// typed meal, an entry, the builders, plans, batches and recipes. sheetHtml picks the one that is open.
import { esc, icon, num, cap, localToday, state, shortDay } from './ui.js';
import { round, amountText, line, total, show, scale } from './nutrition.js';
import {
  gradeDot, itemGrade, kindTag, SOURCE_TAG, f, novaBadge, withFill, nutriBadge, itemTags, unitOptions, quickChips,
  previewHtml, slotSelect, slotNow, itemFacts, sourceLine, fmtN, infoBtn, infoLine, filledSet, kcal, val, strip, STRIP,
  factsHtml, fillSourceHtml, gradeMix, BUILDERS, SLOT, dateLabel,
} from './food-parts.js';
import { fixExtras, importNotice, importedRow, importBody } from './food-import.js';
import { tagPanel, tagMore } from './food-tagdb.js';
import { usualSheet } from './food-usual.js';
import { scanMissTitle, scanMissBody } from './scan.js';
import { richTitle, richBody } from './food-next.js';

let ctx = { pastDay: () => {} };
export function initFoodSheets(c) {
  ctx = { ...ctx, ...c };
}

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
    <span class="li-sub">${it.pack ? `${esc(amountText(1, 'pack', it))} · ` : ''}${it.state ? `${esc(it.state.replace(/-/g, ' '))} · ` : ''}${per}${it.kind !== 'generic' ? ` ${kindTag(it)}` : SOURCE_TAG[it.source] ? ` <span class="tag ftag">${SOURCE_TAG[it.source]}</span>` : ''}</span></span>${icon('chevron', 'chev')}</button>`;
}

export function resultsHtml(s) {
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
      ${tagPanel(itemTags(it))}
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
    ${tagMore(itemTags(it))}
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
    <div class="form-actions"><button class="btn primary" type="submit">Save</button></div></form>`;
}

// The review for a photographed plate or a typed meal. Each food is matched to a record with an
// estimated amount; a typed food with no record keeps a rough estimate and logs as an estimated
// quick add. Nothing is logged until Log all.
export function reviewItem(it) {
  // His own values (Macros) win over the record and the estimate.
  if (it.own && num(it.own.kcal) !== null) return { mode: 'own' };
  const { item, filled } = withFill(it.match, it.fill);
  const l = item && Number(it.qty) > 0 ? line(item, it.qty, it.unit) : null;
  if (l && !l.error) return { mode: 'match', line: l, filled };
  if (num(it.guess?.kcal) !== null) return { mode: 'rough' };
  return { mode: 'none', error: l?.error || null };
}

export function roughAmount(g) {
  if (num(g?.amount) === null || !(g.amount > 0)) return '';
  const q = round(g.amount, g.unit === 'piece' ? 1 : 0);
  return g.unit === 'piece' ? `about ${q} ${q === 1 ? 'piece' : 'pieces'}` : `about ${q} ${g.unit}`;
}

// The values a reviewed food logs with: the record at its amount, his own, or the rough estimate.
export function reviewNutrients(it) {
  const m = reviewItem(it);
  if (m.mode === 'match') return m.line.nutrients;
  if (m.mode === 'own') return { protein: null, carbs: null, fat: null, ...it.own };
  if (m.mode === 'rough') return { kcal: it.guess.kcal, protein: it.guess.protein ?? null, carbs: it.guess.carbs ?? null, fat: it.guess.fat ?? null };
  return null;
}

// How much of a reviewed food he had, in g or ml, when that is known.
function reviewWeight(it) {
  const l = it.match && Number(it.qty) > 0 ? line(it.match, it.qty, it.unit) : null;
  if (l && !l.error) return { grams: l.g ?? null, ml: l.g ? null : l.ml ?? null };
  const g = it.guess || {};
  const w = num(g.weight) ?? (['g', 'ml'].includes(g.unit) ? num(g.amount) : null);
  return it.fill?.basis === 'ml' || g.unit === 'ml' ? { grams: null, ml: w } : { grams: w, ml: null };
}

// A food that logs with values of its own rather than a catalogue line: his own (Macros), or a rough
// estimate for a food the catalogue does not have. His energy, protein, carbs and fat win; the record's
// other values stay, never more sugar than his carbs or saturates than his fat.
export function ownParts(it) {
  const m = reviewItem(it);
  const name = it.match?.name || cap(it.name);
  const amount = it.match && Number(it.qty) > 0 ? amountText(it.qty, it.unit, it.match) : roughAmount(it.guess);
  const { grams, ml } = reviewWeight(it);
  if (m.mode === 'own') {
    const l = it.match && Number(it.qty) > 0 ? line(it.match, it.qty, it.unit) : null;
    const rec = l && !l.error ? l.nutrients : it.guess || {};
    const o = it.own;
    const part = (v, whole) => (num(v) === null ? null : num(whole) === null ? v : Math.min(v, whole));
    return { name, amount, grams, ml, kcal: o.kcal, protein: o.protein ?? null, carbs: o.carbs ?? null, fat: o.fat ?? null,
      sugars: part(rec.sugars, o.carbs), satfat: part(rec.satfat, o.fat), fibre: num(rec.fibre), salt: num(rec.salt), caffeine: num(rec.caffeine), alcohol: num(rec.alcohol) };
  }
  // Not in the catalogue: the estimate per 100 and the weight, or without them the rough totals.
  const g = it.guess;
  const body = { name, amount, grams, ml, estimate: true };
  if (it.fill && (grams ?? ml)) body.fill = it.fill;
  else Object.assign(body, { kcal: round(g.kcal, 0), protein: g.protein, carbs: g.carbs, sugars: g.sugars, fat: g.fat, fibre: g.fibre, salt: g.salt });
  return body;
}

// A typed value on a reviewed food: its amount or unit, or one of his own values (own_kcal and so on).
// The first own value starts from what was shown, so the others are kept; a new amount scales them.
export function setReviewField(it, field, value) {
  it.edited = true;
  const x = String(value).trim().replace(',', '.');
  if (field.startsWith('own_')) {
    if (!it.own) {
      const n = reviewNutrients(it) || {};
      it.own = Object.fromEntries(['kcal', 'protein', 'carbs', 'fat'].map((k) => [k, num(n[k]) === null ? null : round(n[k], k === 'kcal' ? 0 : 1)]));
    }
    const v = Number(x);
    it.own[field.slice(4)] = x === '' ? null : v >= 0 ? v : it.own[field.slice(4)];
    return;
  }
  if (field === 'qty' && it.own && Number(it.qty) > 0 && Number(x) > 0) {
    for (const k of Object.keys(it.own)) if (num(it.own[k]) !== null) it.own[k] = round((it.own[k] * Number(x)) / Number(it.qty), 1);
  }
  it[field] = value;
}

// Several foods log as one meal (each food listed inside it) or each as its own entry.
export function asMealSeg(on, attrs) {
  return `<div class="seg frv-mode" role="group" aria-label="Log as">
    <button type="button" aria-pressed="${on}" ${attrs('meal')}>One meal</button>
    <button type="button" aria-pressed="${!on}" ${attrs('items')}>Separate foods</button></div>`;
}

// His own energy and macros for one food, for the amount he had.
export function ownEditor(it, field, reset) {
  const n = reviewNutrients(it) || {};
  const v = (k) => { const x = it.own?.[k] ?? n[k]; return num(x) === null ? '' : round(x, k === 'kcal' ? 0 : 1); };
  const f = (k, label, unit) => `<label class="own-f"><span>${label}</span><span class="own-in"><input class="input" inputmode="decimal" value="${v(k)}" placeholder="?" ${field(`own_${k}`)} aria-label="${label} in ${unit}"><i>${unit}</i></span></label>`;
  return `<div class="own-ed">${f('kcal', 'Energy', 'kcal')}${f('protein', 'Protein', 'g')}${f('carbs', 'Carbs', 'g')}${f('fat', 'Fat', 'g')}
    <p class="own-note">For the amount above. ${it.own ? `<button type="button" class="linkish" ${reset}>Use ${it.match ? 'the catalogue' : 'the estimate'} again</button>` : 'Type over any value to use your own.'}</p></div>`;
}

// The review's running total: energy and the three macros, "~" when any of it is estimated.
export function reviewTotal(items) {
  const rows = items.map(reviewNutrients).filter(Boolean);
  if (!rows.length) return '';
  const t = total(rows);
  if (num(t.kcal) === null) return '';
  const est = items.some((it) => !it.edited && reviewItem(it).mode !== 'own') ? '<i class="est">~</i>' : '';
  const g = (k) => (num(t[k]) === null ? '–' : `${fmtN(t[k])}${t.missing?.[k] ? '+' : ''}`);
  return `<b class="frv-total">${est}${fmtN(t.kcal)}${t.missing?.kcal ? '+' : ''} kcal</b><span class="frv-macros">P ${g('protein')} g · C ${g('carbs')} g · F ${g('fat')} g</span>`;
}

export function reviewKcal(it) {
  const m = reviewItem(it);
  if (m.mode === 'own') return `${fmtN(it.own.kcal)} kcal`;
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
    const sub = [m.mode === 'own' ? 'Your values' : '', it.match ? names : m.mode === 'rough' ? esc(roughAmount(it.guess)) : m.mode === 'own' ? '' : 'No match'].filter(Boolean).join(' · ');
    const own = m.mode !== 'none' ? ` · <button class="linkish" data-action="food-photo-own" data-index="${i}" aria-expanded="${Boolean(it.ownOpen)}">Macros</button>` : '';
    return `<div class="li li-plain photo-item">
      ${gradeDot(itemGrade(it.match))}
      <span class="li-body"><span class="li-title">${esc(it.match?.name || cap(it.name))}</span>
        <span class="li-sub">${sub}${sub ? ' · ' : ''}<button class="linkish" data-action="food-photo-change" data-index="${i}">Change</button>${own}</span>
        ${it.why && it.match ? `<span class="frv-why">${esc(it.why)}</span>` : ''}</span>
      <span class="li-side"><b data-photo-kcal="${i}">${reviewKcal(it)}</b><button class="icon-btn" data-action="food-photo-drop" data-index="${i}" aria-label="Remove">${icon('close')}</button></span>
      ${it.match ? `<span class="amount-row small photo-amount"><input class="input" inputmode="decimal" value="${esc(it.qty ?? '')}" placeholder="amount" data-photo-index="${i}" data-photo-field="qty" aria-label="Amount">
        <select class="input" data-photo-index="${i}" data-photo-field="unit" aria-label="Unit">${unitOptions(it.match, it.unit)}</select></span>` : ''}
      ${it.ownOpen && m.mode !== 'none' ? ownEditor(it, (k) => `data-photo-index="${i}" data-photo-field="${k}"`, `data-action="food-photo-own-reset" data-index="${i}"`) : ''}</div>`;
  }).join('');
  const n = modes.filter((m) => m.mode !== 'none').length;
  const asMeal = n > 1 && s.asMeal !== false;
  const label = asMeal ? (n === s.items.length ? 'Log as one meal' : `Log ${n} of ${s.items.length} as one meal`) : n === s.items.length ? 'Log all' : `Log ${n} of ${s.items.length}`;
  return `<div class="frv-top"><p class="frv-sum">${r.summary ? esc(r.summary) : `${s.items.length} ${s.items.length === 1 ? 'item' : 'items'}`}</p><span class="frv-tot" id="frv-total">${reviewTotal(s.items)}</span>${infoBtn('review')}</div>
    ${infoLine('review')}
    ${n > 1 ? asMealSeg(asMeal, (mode) => `data-action="food-review-mode" data-mode="${mode}"`) : ''}
    <div class="group photo-items">${rows || '<p class="note pad">Nothing left to log.</p>'}</div>
    <form data-form="food-photo-log">${asMeal ? `<label class="field"><span>Meal name</span><input class="input" name="meal_name" value="${esc(s.mealName ?? r.summary ?? '')}" maxlength="120" autocomplete="off" data-photo-meal placeholder="Meal"></label>` : ''}${slotSelect(slotNow())}<div class="form-actions"><button class="btn primary" type="submit"${n ? '' : ' disabled'}>${label}</button></div></form>`;
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
  return `<div class="fd-head">${e.grade || nova ? `<div class="fd-badges">${nutriBadge(e.grade)}${nova}</div>` : ''}${tagPanel(e.tags || [])}</div>
    ${amount}
    <section class="nf" aria-label="Nutrition facts"><div class="nf-top"><h3>Nutrition</h3><span class="nf-per">${esc(e.amountText || 'as logged')}</span></div>${factsHtml(e.nutrients, fl)}${fillSourceHtml(e.fillSource)}</section>
    ${tagMore(e.tags || [])}
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

export function builderTotals(s) {
  const rows = s.lines.map((l) => (l.ref === 'recipe' ? { nutrients: scale(l.per, l.qty, 1) } : line(l.item, l.qty, l.unit)));
  const bad = rows.find((r) => r.error);
  const whole = total(rows.map((r) => r.nutrients || {}));
  const factor = shareFactor(s);
  const had = scale(whole, factor, 1);
  return `${bad ? `<p class="note bad">${esc(bad.error)}</p>` : ''}
    <div class="fprev"><div class="fprev-main"><b>${kcal(had)}</b><span>${factor === 1 ? 'all of it' : `${round(factor * 100, 0)}% of ${kcal(whole)}`}</span></div>${strip(had)}</div>`;
}

export function shareFactor(s) {
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

export function sheetHtml() {
  const s = state.foodSheet;
  if (!s) return '';
  // On a past day a sheet that logs names the day it logs to.
  const past = s.pick ? null : ctx.pastDay();
  const on = (title) => (past ? `${title} · ${shortDay(past)}` : title);
  switch (s.kind) {
    case 'search': return sheetWrap(s.pick ? 'Choose a food' : on(s.slot ? `Add to ${SLOT[s.slot].toLowerCase()}` : s.drinks ? 'Drinks' : 'Search'), searchBody(s), 'tall');
    case 'usual': return usualSheet(s, sheetWrap);
    case 'food': return sheetWrap(on(s.item.name), foodBody(s), 'tall');
    case 'quick': return sheetWrap(on('Quick add'), quickBody(s));
    case 'custom': return sheetWrap(s.fromLabel ? 'Check the label' : 'A food of your own', customBody(s), 'tall');
    case 'photo': {
      const title = s.busy ? 'Reading the photo' : s.result?.kind === 'meal' ? 'On the plate' : s.result?.kind === 'product' ? 'Found it' : 'From the photo';
      return sheetWrap(on(title), photoBody(s), 'tall');
    }
    case 'scan-miss': return sheetWrap(scanMissTitle(s), scanMissBody(s));
    case 'entry': return sheetWrap(s.entry.name, entryBody(s), 'tall');
    case 'daynut': return sheetWrap(f().day?.today ? 'Today' : dateLabel(f().day), dayNutBody(), 'tall');
    case 'builder': return sheetWrap(on(s.mealId ? s.name || 'Saved meal' : `New ${(BUILDERS[s.mode] || BUILDERS.meal).title.toLowerCase()}`), builderBody(s), 'tall');
    case 'plan': return sheetWrap('Plan for later', planBody(s));
    case 'batch-log': return sheetWrap(on(s.batch.name), batchLogBody(s));
    case 'cook': return sheetWrap('Cook a batch', cookBody(s));
    case 'recipe-log': return sheetWrap(on('Log it'), recipeLogBody(s));
    case 'rich': return sheetWrap(richTitle(s), richBody(s), 'tall');
    case 'recipe-edit': return sheetWrap(s.draft.key ? 'Edit recipe' : s.draft.imported ? 'Imported recipe' : 'New recipe', recipeEditBody(s), 'tall');
    case 'recipe-import': return sheetWrap('Import from a link', importBody(s));
    default: return '';
  }
}
