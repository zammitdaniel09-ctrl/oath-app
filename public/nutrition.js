// Food maths shared by the phone and the server: amounts to grams or ml, nutrients scaled from a
// record's basis, totals that remember what they don't know, recipes, batches and concentrates.
//
// Unknown is never zero. A value nobody has sourced stays null, and every total carries `missing`:
// how many of its lines had no value for that nutrient. A total with missing > 0 is a floor, not a fact.

// `ri` is the EU reference intake for an adult (Regulation 1169/2011, Annex XIII), used to show
// "% of reference intake" the way EU labels do. It is a population reference, not a personal target.
// Groups: macro (the label's big seven), fat, carb, other, mineral, vitamin.
export const NUTRIENTS = [
  { key: 'kcal', label: 'Energy', unit: 'kcal', dec: 0, core: true, group: 'macro', ri: 2000 },
  { key: 'protein', label: 'Protein', unit: 'g', dec: 1, core: true, group: 'macro', ri: 50 },
  { key: 'carbs', label: 'Carbs', unit: 'g', dec: 1, core: true, group: 'macro', ri: 260 },
  { key: 'sugars', label: 'Sugars', unit: 'g', dec: 1, core: true, group: 'macro', ri: 90 },
  { key: 'fat', label: 'Fat', unit: 'g', dec: 1, core: true, group: 'macro', ri: 70 },
  { key: 'satfat', label: 'Saturates', unit: 'g', dec: 1, group: 'macro', ri: 20 },
  { key: 'fibre', label: 'Fibre', unit: 'g', dec: 1, core: true, group: 'macro' },
  { key: 'salt', label: 'Salt', unit: 'g', dec: 2, core: true, group: 'macro', ri: 6 },
  { key: 'caffeine', label: 'Caffeine', unit: 'mg', dec: 0, group: 'other' },
  { key: 'alcohol', label: 'Alcohol', unit: 'g', dec: 1, group: 'other' },
  { key: 'addsugars', label: 'Added sugars', unit: 'g', dec: 1, group: 'carb' },
  { key: 'mufa', label: 'Monounsaturated fat', unit: 'g', dec: 1, group: 'fat' },
  { key: 'pufa', label: 'Polyunsaturated fat', unit: 'g', dec: 1, group: 'fat' },
  { key: 'transfat', label: 'Trans fat', unit: 'g', dec: 2, group: 'fat' },
  { key: 'chol', label: 'Cholesterol', unit: 'mg', dec: 0, group: 'fat' },
  { key: 'potassium', label: 'Potassium', unit: 'mg', dec: 0, group: 'mineral', ri: 2000 },
  { key: 'calcium', label: 'Calcium', unit: 'mg', dec: 0, group: 'mineral', ri: 800 },
  { key: 'iron', label: 'Iron', unit: 'mg', dec: 1, group: 'mineral', ri: 14 },
  { key: 'magnesium', label: 'Magnesium', unit: 'mg', dec: 0, group: 'mineral', ri: 375 },
  { key: 'zinc', label: 'Zinc', unit: 'mg', dec: 1, group: 'mineral', ri: 10 },
  { key: 'phosphorus', label: 'Phosphorus', unit: 'mg', dec: 0, group: 'mineral', ri: 700 },
  { key: 'selenium', label: 'Selenium', unit: 'µg', dec: 0, group: 'mineral', ri: 55 },
  { key: 'vita', label: 'Vitamin A', unit: 'µg', dec: 0, group: 'vitamin', ri: 800 },
  { key: 'vitc', label: 'Vitamin C', unit: 'mg', dec: 0, group: 'vitamin', ri: 80 },
  { key: 'vitd', label: 'Vitamin D', unit: 'µg', dec: 1, group: 'vitamin', ri: 5 },
  { key: 'vite', label: 'Vitamin E', unit: 'mg', dec: 1, group: 'vitamin', ri: 12 },
  { key: 'vitk', label: 'Vitamin K', unit: 'µg', dec: 0, group: 'vitamin', ri: 75 },
  { key: 'b1', label: 'Thiamin (B1)', unit: 'mg', dec: 2, group: 'vitamin', ri: 1.1 },
  { key: 'b2', label: 'Riboflavin (B2)', unit: 'mg', dec: 2, group: 'vitamin', ri: 1.4 },
  { key: 'b3', label: 'Niacin (B3)', unit: 'mg', dec: 1, group: 'vitamin', ri: 16 },
  { key: 'b6', label: 'Vitamin B6', unit: 'mg', dec: 2, group: 'vitamin', ri: 1.4 },
  { key: 'folate', label: 'Folate', unit: 'µg', dec: 0, group: 'vitamin', ri: 200 },
  { key: 'b12', label: 'Vitamin B12', unit: 'µg', dec: 1, group: 'vitamin', ri: 2.5 },
];
export const KEYS = NUTRIENTS.map((n) => n.key);
export const NUTRIENT = Object.fromEntries(NUTRIENTS.map((n) => [n.key, n]));

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const r6 = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);

// Search text: lower case, accents and Maltese letters folded (ħ→h, ż→z, ġ→g, ċ→c), punctuation to spaces.
// "Ħobż tal-Malti" and "hobz tal malti" both become "hobz tal malti".
export function norm(s) {
  return String(s ?? '').toLowerCase().replace(/ħ/g, 'h').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------- Nutrient sets ----------

// An empty set: every value unknown.
export function unknown() {
  return Object.fromEntries(KEYS.map((k) => [k, null]));
}

// Values per `per` units scaled to `amount` of the same unit. Unknown stays unknown; a partial value
// keeps its missing count.
export function scale(nutrients, amount, per = 100) {
  const out = {};
  const f = amount / per;
  for (const k of KEYS) {
    const v = num(nutrients?.[k]);
    out[k] = v === null ? null : r6(v * f);
  }
  if (nutrients?.missing && Object.values(nutrients.missing).some(Boolean)) out.missing = { ...nutrients.missing };
  return out;
}

// Adds lines up. Each line's own `missing` counts carry through, so a recipe with one unknown sugar
// value still reports it inside a day's total.
export function total(list) {
  const values = Object.fromEntries(KEYS.map((k) => [k, 0]));
  const missing = Object.fromEntries(KEYS.map((k) => [k, 0]));
  const known = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const n of list) {
    for (const k of KEYS) {
      const v = num(n?.[k]);
      if (v === null) missing[k] += 1;
      else {
        values[k] += v;
        known[k] += 1;
        missing[k] += n.missing?.[k] || 0;
      }
    }
  }
  const out = {};
  for (const k of KEYS) out[k] = known[k] ? r6(values[k]) : list.length ? null : 0;
  const m = Object.fromEntries(KEYS.filter((k) => missing[k]).map((k) => [k, missing[k]]));
  if (Object.keys(m).length) out.missing = m;
  return out;
}

// Is this total complete for the nutrients that matter on the day view?
export function complete(n, keys = NUTRIENTS.filter((x) => x.core).map((x) => x.key)) {
  return keys.every((k) => num(n?.[k]) !== null && !n?.missing?.[k]);
}

// ---------- Amounts ----------

// The ways an amount of this record can be given. Only sourced weights appear: no scoop without a
// weight on a label, no ml for a solid without a sourced density, no whole weight without a refuse share.
export function unitsFor(item) {
  const basis = item.basis === 'ml' ? 'ml' : 'g';
  const out = [{ unit: basis, label: basis === 'ml' ? 'ml' : 'grams' }];
  if (num(item.density)) out.push(basis === 'ml' ? { unit: 'g', label: 'grams' } : { unit: 'ml', label: 'ml' });
  if (num(item.edible) && item.edible < 1) out.push({ unit: 'whole', label: `g weighed whole (${item.refuse || 'with inedible parts'})` });
  for (const p of item.portions || []) out.push({ unit: `p:${p.label}`, label: p.label, g: num(p.g), ml: num(p.ml) });
  if (item.serving && num(item.serving.size)) out.push({ unit: 'serving', label: item.serving.label || `serving (${item.serving.size} ${item.serving.unit})` });
  if (item.pack && num(item.pack.size)) {
    out.push({ unit: 'pack', label: item.pack.label || `pack (${item.pack.size} ${item.pack.unit})` });
    if (num(item.pack.count) > 1) out.push({ unit: 'each', label: `one of ${item.pack.count} (${round(item.pack.size / item.pack.count, 1)} ${item.pack.unit})` });
  }
  if (item.concentrate && num(item.concentrate.water)) out.push({ unit: 'prepared', label: `ml made up (1 + ${item.concentrate.water} water)` });
  return out;
}

// Turns "qty unit" of a record into an amount in the record's basis (g or ml). Returns
// { amount, basis, g, ml, text, note } or { error }.
export function resolve(item, qty, unit) {
  const q = Number(qty);
  if (!(q > 0) || !Number.isFinite(q)) return { error: 'The amount must be more than zero.' };
  const basis = item.basis === 'ml' ? 'ml' : 'g';
  const density = num(item.density);
  let g = null;
  let ml = null;
  let note = '';
  const u = String(unit || basis);
  if (u === 'g') g = q;
  else if (u === 'ml') ml = q;
  else if (u === 'whole') {
    if (!(num(item.edible) > 0)) return { error: 'There is no sourced edible share for this food. Weigh the edible part instead.' };
    g = q * item.edible;
    note = `edible part of ${round(q, 0)} g whole`;
  } else if (u.startsWith('p:')) {
    const p = (item.portions || []).find((x) => x.label === u.slice(2));
    if (!p) return { error: `"${u.slice(2)}" is not a portion of this food.` };
    if (num(p.g)) g = q * p.g;
    else if (num(p.ml)) ml = q * p.ml;
    else return { error: 'That portion has no weight.' };
  } else if (u === 'serving' || u === 'pack' || u === 'each') {
    const src = u === 'serving' ? item.serving : item.pack;
    if (!src || !num(src.size)) return { error: `This food has no ${u === 'serving' ? 'serving' : 'pack'} size on record.` };
    let size = src.size;
    if (u === 'each') {
      if (!(num(src.count) > 1)) return { error: 'This pack is not a multipack.' };
      size = src.size / src.count;
    }
    if (src.unit === 'ml') ml = q * size;
    else g = q * size;
  } else if (u === 'prepared') {
    const w = num(item.concentrate?.water);
    if (w === null) return { error: 'This drink is not a concentrate.' };
    ml = q / (1 + w);
    note = `${round(ml, 0)} ml concentrate in ${round(q, 0)} ml made up`;
  } else return { error: `Unknown unit "${u}".` };

  // Into the record's basis; grams and ml only meet through a sourced density.
  if (basis === 'g' && g === null) {
    if (!density) return { error: 'This food is measured by weight and has no sourced density, so give grams.' };
    g = ml * density;
  }
  if (basis === 'ml' && ml === null) {
    if (!density) return { error: 'This drink is measured by volume and has no sourced density, so give ml.' };
    ml = g / density;
  }
  // With a sourced density both are known, so a drink logged in grams or by a portion in grams still
  // counts towards the day's drinks.
  if (density && ml === null) ml = g / density;
  if (density && g === null) g = ml * density;
  const amount = basis === 'g' ? g : ml;
  return { amount: r6(amount), basis, g: g === null ? null : r6(g), ml: ml === null ? null : r6(ml), text: amountText(q, u, item), note };
}

export function amountText(qty, unit, item = {}) {
  const q = round(qty, 2);
  if (unit === 'g' || unit === 'ml') return `${q} ${unit}`;
  if (unit === 'whole') return `${q} g whole`;
  if (unit === 'prepared') return `${q} ml made up`;
  if (unit?.startsWith('p:')) {
    const label = unit.slice(2).replace(/^1\s+/, '');
    return q === 1 ? unit.slice(2) : `${q} × ${label}`;
  }
  if (unit === 'serving') return `${q} ${q === 1 ? 'serving' : 'servings'}`;
  if (unit === 'pack') return q === 1 ? (item.pack?.label || '1 pack') : q === 0.5 ? 'half a pack' : `${q} packs`;
  if (unit === 'each') return `${q} of ${item.pack?.count || '?'}`;
  return `${q} ${unit}`;
}

// One logged line: the amount and its nutrients. The nutrients are a copy, so the diary never
// changes when the record is edited later.
export function line(item, qty, unit) {
  const r = resolve(item, qty, unit);
  if (r.error) return r;
  return { ...r, nutrients: scale(item.nutrients, r.amount, 100) };
}

// ---------- Recipes ----------

// The share of a sub-recipe or batch an amount stands for: servings, grams of the final weight, or a fraction.
export function shareOf(whole, qty, unit) {
  const q = Number(qty);
  if (!(q > 0)) return { error: 'The amount must be more than zero.' };
  if (unit === 'serving') {
    if (!(num(whole.servings) > 0)) return { error: 'No servings declared.' };
    return { share: q / whole.servings };
  }
  if (unit === 'g') {
    if (!(num(whole.final_weight) > 0)) return { error: 'Weigh the finished dish first, or log by servings.' };
    return { share: q / whole.final_weight };
  }
  if (unit === 'share' || unit === 'batch') return { share: q };
  return { error: `Unknown unit "${unit}".` };
}

// Totals for a recipe. `get` looks up { item(key), recipe(key) }. Sub-recipes are counted once at the
// share used and loops are refused. Optional lines count only when chosen. `opts`: with (indexes of
// optional lines chosen), skip (indexes of lines left out), swap ({ index: { ref, ref_key, qty, unit } }),
// factor (scale every line).
export function recipeTotals(recipe, get, opts = {}, stack = []) {
  if (stack.includes(recipe.key)) throw new Error(`Recipe loop: ${[...stack, recipe.key].join(' → ')}`);
  const path = [...stack, recipe.key];
  const factor = num(opts.factor) || 1;
  const skip = new Set((opts.skip || []).map(Number));
  const chosen = new Set((opts.with || []).map(Number));
  const rows = [];
  (recipe.lines || []).forEach((raw, i) => {
    if (skip.has(i) || (raw.optional && !chosen.has(i))) return;
    const l = opts.swap?.[i] ? { ...raw, ...opts.swap[i] } : raw;
    const qty = l.qty * factor;
    let r;
    if (l.ref === 'recipe') {
      const sub = get.recipe(l.ref_key);
      if (!sub) r = { error: `Missing recipe ${l.ref_key}` };
      else {
        const t = recipeTotals(sub, get, {}, path);
        const s = shareOf({ servings: sub.servings, final_weight: t.final_weight }, qty, l.unit);
        r = s.error ? s : { amount: t.final_weight ? r6(s.share * t.final_weight) : null, basis: 'g', nutrients: scale(t.nutrients, s.share, 1) };
      }
    } else {
      const it = get.item(l.ref_key);
      r = it ? line(it, qty, l.unit) : { error: `Missing food ${l.ref_key}` };
    }
    rows.push({ index: i, ref: l.ref || 'item', ref_key: l.ref_key, qty, unit: l.unit, ...r, nutrients: r.nutrients || unknown() });
  });
  const nutrients = total(rows.map((r) => r.nutrients));
  const servings = num(recipe.servings) ? recipe.servings * factor : null;
  const final_weight = num(recipe.final_weight) ? recipe.final_weight * factor : null;
  return {
    nutrients,
    rows,
    errors: rows.filter((r) => r.error).map((r) => r.error),
    servings,
    final_weight,
    raw_weight: r6(rows.reduce((a, r) => a + (r.basis === 'g' ? r.amount || 0 : 0), 0)),
    perServing: servings ? scale(nutrients, 1, servings) : null,
    per100: final_weight ? scale(nutrients, 100, final_weight) : null,
  };
}

// ---------- Batches ----------

// One share of a cooked batch, by weight of the finished food, servings, or a fraction.
export function batchPortion(batch, qty, unit) {
  const s = shareOf(batch, qty, unit);
  if (s.error) return s;
  return {
    share: r6(s.share),
    g: num(batch.final_weight) ? r6(s.share * batch.final_weight) : null,
    nutrients: scale(batch.nutrients, s.share, 1),
  };
}

// What is left after the shares already logged.
export function batchLeft(batch, shares) {
  const used = shares.reduce((a, s) => a + (num(s) || 0), 0);
  const left = Math.max(0, 1 - used);
  return {
    used: r6(used),
    share: r6(left),
    g: num(batch.final_weight) ? r6(left * batch.final_weight) : null,
    servings: num(batch.servings) ? r6(left * batch.servings) : null,
    over: used > 1 + 1e-9,
  };
}

// ---------- Display ----------

export function round(v, dec = 0) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const p = 10 ** dec;
  return Math.round(Number(v) * p) / p;
}

// "12.4 g", "–" when unknown, and a trailing "+" when the total is missing some lines.
export function show(n, key, { unit = true } = {}) {
  const d = NUTRIENT[key];
  const v = num(n?.[key]);
  if (v === null) return '–';
  const s = new Intl.NumberFormat('en-GB', { maximumFractionDigits: d.dec }).format(round(v, d.dec));
  return `${s}${n?.missing?.[key] ? '+' : ''}${unit ? (d.unit === 'kcal' ? ' kcal' : ` ${d.unit}`) : ''}`;
}

// Where a diary entry's filled values came from (its `fillSource`), as the short phrases of the line
// under its facts: "Vitamins and minerals filled from USDA: Cola", "Values from twistees.com.mt", "The
// rest marked ~ are estimates", "Worked out for about 28 g, from its energy". A phrase with `link`
// ends in a link to the page. Empty when nothing was filled.
export function fillSourceParts(src) {
  if (!src || typeof src !== 'object') return [];
  const parts = [];
  const what = (keys) => {
    const micro = keys.filter((k) => ['mineral', 'vitamin'].includes(NUTRIENT[k]?.group)).length;
    if (micro && micro === keys.length) return 'Vitamins and minerals';
    return micro ? 'Vitamins, minerals and other values' : 'Missing values';
  };
  if (src.usda?.keys?.length) parts.push({ text: `${what(src.usda.keys)} filled from USDA: ${src.usda.name || 'a similar food'}` });
  if (src.web?.keys?.length) {
    let host = '';
    try {
      const u = new URL(src.web.url);
      if (['http:', 'https:'].includes(u.protocol)) host = u.hostname.replace(/^www\./, '');
    } catch { /* no link */ }
    parts.push(host ? { text: 'Values from ', link: { url: src.web.url, text: host } } : { text: `Values from ${src.web.name || 'the web'}` });
  }
  if (src.estimate?.keys?.length) parts.push({ text: parts.length ? 'The rest marked ~ are estimates' : 'Values marked ~ are estimates' });
  if (src.weight && num(src.weight.amount) && parts.length) {
    parts.push({ text: `Worked out for about ${round(src.weight.amount, 0)} ${src.weight.unit === 'ml' ? 'ml' : 'g'}, ${src.weight.from === 'energy' ? 'from its energy' : 'a typical portion'}` });
  }
  return parts;
}

// ---------- Grades and tags ----------
//
// Everything here reads a record's nutrients per 100 g (or per 100 ml for a drink), exactly as the
// catalogue stores them, and never guesses: an unknown value means no grade and no tag.

const pointsOver = (v, list) => list.reduce((a, t) => a + (v > t ? 1 : 0), 0);
const pointsAtLeast = (v, list) => list.reduce((a, t) => a + (v >= t ? 1 : 0), 0);

// Nutri-Score 2023: the updated algorithm of Santé publique France ("Nutri-Score: update of the algorithm
// for general foods and beverages", scientific committee report 2022, published as the 2023 update; the
// rules at santepubliquefrance.fr/nutri-score). The threshold tables below are those of the update, checked
// against Open Food Facts' open-source implementation (openfoodfacts-server, lib/ProductOpener/Nutriscore.pm).
// A value counts a point for each threshold it is over (the saturates share of fat: at or over).
const NS = {
  energy: [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350], // kJ per 100 g
  energyBeverage: [30, 90, 150, 210, 240, 270, 300, 330, 360, 390], // kJ per 100 ml
  sugars: [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51],
  sugarsBeverage: [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11],
  satfat: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  salt: [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4],
  satEnergy: [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200], // kJ of saturates: fats, oils, nuts and seeds
  satRatio: [10, 16, 22, 28, 34, 40, 46, 52, 58, 64], // saturates as % of fat: fats, oils, nuts and seeds
  fvl: [40, 60, 80, 80, 80], // % fruit, vegetables and legumes
  fvlBeverage: [40, 40, 60, 60, 80, 80],
  fibre: [3.0, 4.1, 5.2, 6.3, 7.4],
  protein: [2.4, 4.8, 7.2, 9.6, 12, 14, 17],
  proteinBeverage: [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0],
};
const KJ_PER_KCAL = 4.184;
const KJ_PER_G_SATFAT = 37; // the update's figure for the energy of saturates

// Where the catalogue's readable groups (see scripts/usda-names.mjs) meet Nutri-Score's families.
const NS_NOT_GRADED = new Set(['alcoholic drinks', 'baby food', 'supplements and powders', 'herbs and spices', 'coffee and tea']);
const NS_FAT_GROUPS = new Set(['fats and oils', 'nuts and seeds']);
const NS_FVL_GROUPS = new Set(['fruit', 'vegetables', 'legumes', 'fruit juice']);
const NS_RED_MEAT_GROUPS = new Set(['beef', 'pork', 'lamb, veal and game']);
const NS_NOT_BEVERAGE = new Set(['soups', 'sauces and condiments', 'fats and oils', 'cheese', 'dairy']);
const RED_MEAT_WORDS = /\b(beef|pork|lamb|veal|mutton|ham|bacon|salami|bologna|pepperoni|frankfurter|hot dog|chorizo|sausage|steak|venison|bison)\b/i;
const WHITE_MEAT_WORDS = /\b(chicken|turkey|duck|poultry|fish|salmon|tuna)\b/i;
const CREAM = /^(single |double |whipping |whipped |heavy |light |soured |sour |clotted |half )?cream\b(?! cheese| of| soda| puff)/i;

function scoreFamily(category, name, liquid) {
  const c = String(category || '').trim().toLowerCase();
  const nm = String(name || '').trim();
  const known = c && c !== 'product';
  if (NS_NOT_GRADED.has(c)) return { skip: true };
  const fat = NS_FAT_GROUPS.has(c) ? !/chestnut/i.test(nm)
    : c === 'dairy' ? CREAM.test(nm)
      : !known && /\b(oil|butter|margarine|lard|ghee)\b/i.test(nm);
  const cheese = c === 'cheese' || (!known && /\bcheese\b/i.test(nm) && !/\b(sauce|cake|spread)\b/i.test(nm));
  const redMeat = NS_RED_MEAT_GROUPS.has(c) || (c === 'sausages and cold cuts' && RED_MEAT_WORDS.test(nm) && !WHITE_MEAT_WORDS.test(nm))
    || (!known && RED_MEAT_WORDS.test(nm) && !WHITE_MEAT_WORDS.test(nm));
  const beverage = !fat && !cheese && Boolean(liquid) && !NS_NOT_BEVERAGE.has(c);
  return { skip: false, fat, cheese, redMeat, beverage, water: c === 'water' };
}

// The Nutri-Score of a food: { grade: 'a'..'e', points }, or null when energy, sugars, saturates or salt
// is unknown (or the food is outside the system: alcoholic drinks, tea and coffee, baby food, supplements).
// `nutrients` are per 100 g, or per 100 ml for a drink. Fruit, vegetable and legume share comes from
// `fruitVegShare`, else 100 for the fruit, vegetable, legume and juice groups and 0 for everything else.
// Missing sugars are zero when carbs are zero and missing saturates zero when fat is zero (as Open Food
// Facts does); missing fibre and protein count as zero, as the rules say. `sweeteners` (a drink with
// non-nutritive sweeteners, +4) and `name` (cream, red meat, chestnut) are optional extra knowledge.
export function nutriScore(nutrients, { category = null, liquid = false, fruitVegShare = null, name = null, sweeteners = false } = {}) {
  const n = nutrients || {};
  const f = scoreFamily(category, name, liquid);
  if (f.skip) return null;
  const kcal = num(n.kcal);
  let sugars = num(n.sugars);
  if (sugars === null && num(n.carbs) === 0) sugars = 0;
  let satfat = num(n.satfat);
  if (satfat === null && num(n.fat) === 0) satfat = 0;
  const salt = num(n.salt);
  if (kcal === null || sugars === null || satfat === null || salt === null) return null;
  const fat = num(n.fat);
  if (f.fat && fat === null) return null;
  const kj = kcal * KJ_PER_KCAL;
  const fibre = num(n.fibre) ?? 0;
  const protein = num(n.protein) ?? 0;
  const share = num(fruitVegShare) ?? (NS_FVL_GROUPS.has(String(category || '').toLowerCase()) ? 100 : 0);

  let negative;
  if (f.fat) {
    const ratio = fat > 0 ? (satfat / fat) * 100 : 0;
    negative = pointsOver(satfat * KJ_PER_G_SATFAT, NS.satEnergy) + pointsOver(sugars, NS.sugars) + pointsAtLeast(ratio, NS.satRatio) + pointsOver(salt, NS.salt);
  } else if (f.beverage) {
    negative = pointsOver(kj, NS.energyBeverage) + pointsOver(sugars, NS.sugarsBeverage) + pointsOver(satfat, NS.satfat) + pointsOver(salt, NS.salt) + (sweeteners ? 4 : 0);
  } else {
    negative = pointsOver(kj, NS.energy) + pointsOver(sugars, NS.sugars) + pointsOver(satfat, NS.satfat) + pointsOver(salt, NS.salt);
  }

  let proteinPoints = pointsOver(protein, f.beverage ? NS.proteinBeverage : NS.protein);
  if (f.redMeat) proteinPoints = Math.min(proteinPoints, 2); // red meat: at most 2 protein points
  // Protein counts for drinks and cheese always, otherwise only while the food is not too heavy on the negative side.
  const countProtein = f.beverage || f.cheese || (f.fat ? negative < 7 : negative < 11);
  const positive = pointsOver(fibre, NS.fibre) + pointsOver(share, f.beverage ? NS.fvlBeverage : NS.fvl) + (countProtein ? proteinPoints : 0);
  const points = negative - positive;

  let grade;
  if (f.beverage) {
    // Only plain water is an A; anything with energy or sugar is graded as a drink.
    const plainWater = f.water && kcal <= 1 && sugars <= 0.5 && !sweeteners;
    grade = plainWater ? 'a' : points <= 2 ? 'b' : points <= 6 ? 'c' : points <= 9 ? 'd' : 'e';
  } else if (f.fat) grade = points <= -6 ? 'a' : points <= 2 ? 'b' : points <= 10 ? 'c' : points <= 18 ? 'd' : 'e';
  else grade = points <= 0 ? 'a' : points <= 2 ? 'b' : points <= 10 ? 'c' : points <= 18 ? 'd' : 'e';
  return { grade, points };
}

// ---------- Tags ----------

// Official criteria where they exist, and the criterion is named in `why`:
//  - UK Food Standards Agency front-of-pack traffic lights, per 100 g (solids) or 100 ml (drinks):
//      fat low <= 3 / high > 17.5 g (drinks 1.5 / 8.75), saturates low <= 1.5 / high > 5 g (0.75 / 2.5),
//      total sugars low <= 5 / high > 22.5 g (2.5 / 11.25), salt low <= 0.3 / high > 1.5 g (0.3 / 0.75),
//      and for a drink portion over 150 ml, sugars over 13.5 g per portion are red too (a can of cola).
//  - EU nutrition claims, Regulation (EC) 1924/2006 annex: high protein when at least 20% of the energy comes
//    from protein, a source at 12%; high fibre 6 g and a source 3 g per 100 g; low fat 3 g (1.5 g per 100 ml);
//    sugars-free 0.5 g per 100 g or ml. Energy from protein uses the EU factors (17 kJ per g, 4.184 kJ per kcal).
//  - EU high caffeine labelling for drinks, Regulation (EU) 1169/2011 annex III: over 150 mg per litre.
//  - NOVA (Monteiro et al., from Open Food Facts) and the Nutri-Score grade, where the record has them.
// Oath's own, documented: "Carb heavy" (at least 55% of energy from carbs and 30 g per 100 g), and a floor
// on the protein tags (5 g and 3 g per 100 g) so that watery vegetables do not count as protein sources.
const PROTEIN_KJ = 17;
const CARB_KJ = 17;
const PROTEIN_FLOOR = { high: 5, source: 3 };
const WHOLE_RAW_GROUPS = new Set(['fruit', 'vegetables', 'legumes', 'nuts and seeds', 'eggs']);

const letter = (x) => {
  const g = String((typeof x === 'string' ? x : x?.grade) || '').toLowerCase();
  return g.length === 1 && 'abcde'.includes(g) ? g : null;
};

// The portion a drink is usually had in, in ml: the label's serving, else one of a multipack, else a can,
// bottle, glass or serving portion. Null when the record has none.
function drinkPortionMl(it) {
  const dens = num(it.density) || 1;
  const toMl = (size, unit) => (unit === 'ml' ? size : size / dens);
  if (num(it.serving?.size) > 0) return toMl(it.serving.size, it.serving.unit);
  if (num(it.pack?.size) > 0) return toMl(it.pack.size / (num(it.pack.count) > 1 ? it.pack.count : 1), it.pack.unit);
  for (const p of it.portions || []) {
    if (!/\b(can|bottle|glass|carton|pouch|serving)\b/i.test(p?.label || '')) continue;
    const ml = num(p.ml) ?? (num(p.g) ? p.g / dens : null);
    if (ml) return ml;
  }
  return null;
}

// An ordered list of { key, label, tone: 'good' | 'neutral' | 'warn', why } for a catalogue record
// ({ nutrients, basis, liquid, density, category, state, name, nutriscore, nova, and for the drinks portion
// rule serving, pack and portions }).
export function foodTags(item) {
  const it = item || {};
  const raw = it.nutrients || {};
  const drink = Boolean(it.liquid) || it.basis === 'ml';
  // A drink held per 100 g is looked at per 100 ml, through its density (water-like when it has none).
  const k = it.basis === 'ml' || !drink ? 1 : num(it.density) || 1;
  const v = (key) => {
    const x = num(raw[key]);
    return x === null ? null : x * k;
  };
  const unit = drink ? '100 ml' : '100 g';
  const tags = [];
  const add = (key, label, tone, why) => tags.push({ key, label, tone, why });

  const grade = letter(it.nutriscore);
  if (grade === 'a' || grade === 'b') add('good-choice', 'Good choice', 'good', `Nutri-Score ${grade.toUpperCase()} (2023 algorithm, Santé publique France).`);
  else if (grade === 'd' || grade === 'e') add('eat-less', 'Eat less often', 'warn', `Nutri-Score ${grade.toUpperCase()} (2023 algorithm, Santé publique France).`);

  const nova = it.nova === null || it.nova === undefined ? NaN : Number(it.nova);
  const group = String(it.category || '').toLowerCase();
  if (nova === 4) add('ultra-processed', 'Ultra-processed', 'warn', 'NOVA group 4: ultra-processed food.');
  if (nova === 1) add('whole-food', 'Whole food', 'good', 'NOVA group 1: unprocessed or minimally processed.');
  else if (!Number.isFinite(nova) && WHOLE_RAW_GROUPS.has(group) && it.state === 'raw' && !/substitute|powder|dried|flour|butter|oil/i.test(String(it.name || ''))) {
    add('whole-food', 'Whole food', 'good', 'A plain raw fruit, vegetable, legume, nut or egg: NOVA group 1 by definition.');
  }

  const kcal = v('kcal');
  const protein = v('protein');
  if (kcal !== null && kcal > 0 && protein !== null) {
    const share = (protein * PROTEIN_KJ) / (kcal * KJ_PER_KCAL);
    if (share >= 0.2 && protein >= PROTEIN_FLOOR.high) add('protein-packed', 'Protein packed', 'good', `At least 20% of the energy is protein (${Math.round(share * 100)}%): the EU "high protein" claim, Regulation 1924/2006.`);
    else if (share >= 0.12 && protein >= PROTEIN_FLOOR.source) add('protein-source', 'Source of protein', 'good', `At least 12% of the energy is protein (${Math.round(share * 100)}%): the EU "source of protein" claim, Regulation 1924/2006.`);
  }

  const fibre = v('fibre');
  if (fibre !== null) {
    if (fibre >= 6) add('high-fibre', 'High fibre', 'good', `${round(fibre, 1)} g of fibre per ${unit}, at least 6 g: the EU "high fibre" claim, Regulation 1924/2006.`);
    else if (fibre >= 3) add('source-fibre', 'Source of fibre', 'good', `${round(fibre, 1)} g of fibre per ${unit}, at least 3 g: the EU "source of fibre" claim, Regulation 1924/2006.`);
  }

  const sugars = v('sugars');
  if (sugars !== null) {
    const [low, high] = drink ? [2.5, 11.25] : [5, 22.5];
    // Meat, fish and oils have no carbohydrate to speak of: "sugar free" says nothing about them.
    const carbs0 = v('carbs');
    const sweetPossible = drink || carbs0 === null || carbs0 >= 1;
    // The FSA's portion rule for drinks: a portion over 150 ml is red above 13.5 g of sugars.
    const portionMl = drink ? drinkPortionMl(it) : null;
    const portionSugars = portionMl && portionMl > 150 ? (sugars * portionMl) / 100 : null;
    if (sugars > high) add('sugar-rush', 'Sugar rush', 'warn', `${round(sugars, 1)} g of sugars per ${unit}, over ${high} g: red on the UK FSA front-of-pack traffic lights.`);
    else if (portionSugars !== null && portionSugars > 13.5) add('sugar-rush', 'Sugar rush', 'warn', `${round(portionSugars, 1)} g of sugars in a ${round(portionMl, 0)} ml portion, over 13.5 g: red on the UK FSA front-of-pack traffic lights (the portion rule for drinks over 150 ml).`);
    else if (sugars <= 0.5 && sweetPossible) add('sugar-free', 'Sugar free', 'good', `No more than 0.5 g of sugars per ${unit}: the EU "sugars-free" claim, Regulation 1924/2006.`);
    else if (sugars <= low && sweetPossible) add('low-sugar', 'Low sugar', 'good', `${round(sugars, 1)} g of sugars per ${unit}, at most ${low} g: green on the UK FSA front-of-pack traffic lights.`);
  }

  const fat = v('fat');
  if (fat !== null) {
    const [low, high] = drink ? [1.5, 8.75] : [3, 17.5];
    if (fat <= low) add('low-fat', 'Low fat', 'good', `${round(fat, 1)} g of fat per ${unit}, at most ${low} g: the EU "low fat" claim, Regulation 1924/2006.`);
    else if (fat > high) add('high-fat', 'High fat', 'warn', `${round(fat, 1)} g of fat per ${unit}, over ${high} g: red on the UK FSA front-of-pack traffic lights.`);
  }

  const satfat = v('satfat');
  if (satfat !== null) {
    const [low, high] = drink ? [0.75, 2.5] : [1.5, 5];
    if (satfat <= low) add('low-saturates', 'Low saturates', 'good', `${round(satfat, 1)} g of saturates per ${unit}, at most ${low} g: green on the UK FSA front-of-pack traffic lights.`);
    else if (satfat > high) add('high-saturates', 'High saturates', 'warn', `${round(satfat, 1)} g of saturates per ${unit}, over ${high} g: red on the UK FSA front-of-pack traffic lights.`);
  }

  const salt = v('salt');
  if (salt !== null) {
    const high = drink ? 0.75 : 1.5;
    if (salt <= 0.3) add('low-salt', 'Low salt', 'good', `${round(salt, 2)} g of salt per ${unit}, at most 0.3 g: green on the UK FSA traffic lights and the EU "low sodium" level.`);
    else if (salt > high) add('salty', 'Salty', 'warn', `${round(salt, 2)} g of salt per ${unit}, over ${high} g: red on the UK FSA front-of-pack traffic lights.`);
  }

  const carbs = v('carbs');
  if (kcal !== null && kcal > 0 && carbs !== null && carbs >= 30) {
    const share = (carbs * CARB_KJ) / (kcal * KJ_PER_KCAL);
    if (share >= 0.55) add('carb-heavy', 'Carb heavy', 'neutral', `Carbs give ${Math.round(share * 100)}% of the energy and there are ${round(carbs, 0)} g per ${unit}: Oath's rule is at least 55% and 30 g.`);
  }

  const caffeine = v('caffeine');
  if (drink && caffeine !== null && caffeine * 10 > 150) add('high-caffeine', 'High caffeine', 'warn', `${round(caffeine * 10, 0)} mg of caffeine per litre, over 150 mg: the level at which EU rules (Regulation 1169/2011, annex III) require a high-caffeine warning on drinks.`);

  return tags;
}

// ---------- His own needs, from his body ----------
// With a body profile every percentage is against what his body needs, not the EU reference intakes
// (set for an average adult on 2,000 kcal). Each value names its source:
// - energy: resting energy by Katch-McArdle from lean mass when body fat is known, else Mifflin-St Jeor,
//   times an activity factor, then the goal (keep, or about 300 kcal more to gain, 400 less to lose).
//   Once Apple Health has his active energy for at least 4 of the last 7 days, his real activity
//   replaces the factor: resting (Apple Health's own when it has it) plus his average active energy,
//   over 0.9, as digesting food (the thermic effect of food) takes about a tenth of what is eaten;
// - protein: 1.6 g per kg to keep, 1.8 to gain, 2.0 to lose (ISSN position stand: 1.4 to 2.0 g/kg for
//   people who train); carbohydrate 55% and fat 30% of energy (inside EFSA's 45 to 60% and 20 to 35%);
// - sugars and saturates: the EU RIs scaled to his energy; salt 6 g (EU RI); fibre 14 g per 1,000 kcal (US IOM);
// - vitamins and minerals: EFSA dietary reference values for adults, the PRI where there is one, else the
//   AI; thiamin and niacin scale with energy as EFSA sets them. Under 18 the EU RIs stay;
// - water from drinks: 35 ml per kg, a reference rather than an RI. EFSA's adequate intake of total water
//   is 2.5 L a day for men and 2.0 L for women, about 80% of it from drinks; 35 ml per kg sits a little
//   above that for someone who trains. Without a body, 2,000 ml (DRINKS_REF).
export const ACTIVITY = {
  sedentary: { factor: 1.2, label: 'Mostly sitting' },
  light: { factor: 1.375, label: 'Light: 1 to 3 sessions a week' },
  moderate: { factor: 1.55, label: 'Moderate: 3 to 5 sessions a week' },
  very: { factor: 1.725, label: 'Very active: hard sport most days' },
  athlete: { factor: 1.9, label: 'Athlete: twice a day or physical work' },
};
export const GOALS = { keep: { kcal: 0, protein: 1.6, label: 'Keep my weight' }, gain: { kcal: 300, protein: 1.8, label: 'Gain muscle' }, lose: { kcal: -400, protein: 2.0, label: 'Lose fat' } };

export function ageOn(birthDate, today) {
  const [by, bm, bd] = String(birthDate || '').split('-').map(Number);
  const [ty, tm, td] = String(today || '').split('-').map(Number);
  if (!by || !ty) return null;
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

const EFSA = {
  male: { iron: 11, magnesium: 350, zinc: 11.7, vita: 750, vitc: 110, vite: 13, b6: 1.7 },
  female: { iron: 16, magnesium: 300, zinc: 9.3, vita: 650, vitc: 95, vite: 11, b6: 1.6 },
  both: { potassium: 3500, phosphorus: 550, selenium: 70, vitd: 15, vitk: 70, b2: 1.6, folate: 330, b12: 4 },
};

// Water from drinks a day, in ml, when there is no body to work it out from.
export const DRINKS_REF = 2000;
const DRINKS_ML_PER_KG = 35;
// Digesting food takes about 10% of what is eaten, so resting plus active energy is 90% of the need.
const TEF_SHARE = 0.9;

// body: { sex, birthDate, heightCm, weightKg, bodyFat, activity, goal }. health, optional: Apple
// Health's daily averages over the last 7 days, { activeAvg, restingAvg }, each null when it has fewer
// than 4 days of it (src/body.js). Returns null when something needed is missing, or
// { refs: { key: amount a day }, about: { ... how energy was worked out } }.
export function personalNeeds(body, today, health = null) {
  const b = body || {};
  const w = Number(b.weightKg);
  const h = Number(b.heightCm);
  const age = ageOn(b.birthDate, today);
  const sex = b.sex === 'female' ? 'female' : b.sex === 'male' ? 'male' : null;
  const act = ACTIVITY[b.activity];
  const goal = GOALS[b.goal] || GOALS.keep;
  if (!sex || !(w > 0) || !(h > 0) || age === null || age < 18 || !act) return null;
  const fat = Number(b.bodyFat);
  const lean = fat > 0 && fat < 70 ? w * (1 - fat / 100) : null;
  const formula = lean ? 370 + 21.6 * lean : 10 * w + 6.25 * h - 5 * age + (sex === 'male' ? 5 : -161);
  // Only believable daily figures count: a partial export can leave a day's total far too low.
  const active = num(health?.activeAvg) !== null && health.activeAvg >= 0 && health.activeAvg <= 6000 ? health.activeAvg : null;
  const healthRest = active !== null && num(health?.restingAvg) !== null && health.restingAvg >= 600 && health.restingAvg <= 5000 ? health.restingAvg : null;
  const rest = healthRest ?? formula;
  const burn = active !== null ? (rest + active) / TEF_SHARE : rest * act.factor;
  const kcal = round((burn + goal.kcal) / 10) * 10;
  const mj = (kcal * KJ_PER_KCAL) / 1000;
  const refs = {
    kcal,
    protein: round(w * goal.protein),
    carbs: round((kcal * 0.55) / 4),
    fat: round((kcal * 0.3) / 9),
    sugars: round((90 * kcal) / 2000),
    satfat: round((20 * kcal) / 2000),
    salt: 6,
    fibre: round((14 * kcal) / 1000),
    calcium: age < 25 ? 1000 : 950,
    ...EFSA.both,
    ...EFSA[sex],
    b1: round(0.1 * mj, 2),
    b3: round(1.6 * mj, 1),
    water: round((DRINKS_ML_PER_KG * w) / 10) * 10,
  };
  const method = lean ? 'Katch-McArdle' : 'Mifflin-St Jeor';
  return {
    refs,
    about: {
      age, sex, lean: lean === null ? null : round(lean, 1), rest: round(rest), factor: act.factor, method,
      goal: b.goal in GOALS ? b.goal : 'keep', proteinPerKg: goal.protein,
      // Where the energy came from: Apple Health's activity, or the activity factor.
      energy: active !== null
        ? { from: 'health', rest: round(rest), restFrom: healthRest !== null ? 'health' : method, active: round(active), goalKcal: goal.kcal }
        : { from: 'factor', rest: round(rest), restFrom: method, factor: act.factor, goalKcal: goal.kcal },
    },
  };
}

const kcalText = (v) => Math.round(v).toLocaleString('en-GB');
const GOAL_WORDS = { gain: 'gain muscle', lose: 'lose fat' };

// One line on how the energy need was worked out, for the Body card and the coach:
// "2,690 kcal: resting 1,602 + 819 active on average (Apple Health, last 7 days); digesting food is the other 10%."
export function energyText(needs) {
  const e = needs?.about?.energy;
  if (!e) return '';
  const a = needs.about;
  const goal = e.goalKcal ? ` Then ${kcalText(Math.abs(e.goalKcal))} kcal ${e.goalKcal > 0 ? 'more' : 'less'} to ${GOAL_WORDS[a.goal] || 'meet the goal'}.` : '';
  const from = e.restFrom === 'health' ? '' : e.restFrom === 'Katch-McArdle' ? ` from ${a.lean} kg lean mass` : ' from height, weight and age';
  if (e.from === 'health') {
    return `${kcalText(needs.refs.kcal)} kcal: resting ${kcalText(e.rest)}${from} + ${kcalText(e.active)} active on average (Apple Health, last 7 days); digesting food is the other 10%.${goal}`;
  }
  return `${kcalText(needs.refs.kcal)} kcal: resting ${kcalText(e.rest)}${from}, × ${e.factor} for activity.${goal}`;
}

// The amount 100% stands for: his own need when there is one, else the EU reference intake.
export const refOf = (k, refs = null) => refs?.[k] ?? NUTRIENT[k]?.ri ?? null;

// Water from drinks a day, in ml: his own reference when his body is set, else 2,000 ml.
export const drinksRef = (refs = null) => refs?.water ?? DRINKS_REF;
