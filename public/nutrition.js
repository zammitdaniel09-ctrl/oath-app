// Food maths shared by the phone and the server: amounts to grams or ml, nutrients scaled from a
// record's basis, totals that remember what they don't know, recipes, batches and concentrates.
//
// Unknown is never zero. A value nobody has sourced stays null, and every total carries `missing`:
// how many of its lines had no value for that nutrient. A total with missing > 0 is a floor, not a fact.

export const NUTRIENTS = [
  { key: 'kcal', label: 'Energy', unit: 'kcal', dec: 0, core: true },
  { key: 'protein', label: 'Protein', unit: 'g', dec: 1, core: true },
  { key: 'carbs', label: 'Carbs', unit: 'g', dec: 1, core: true },
  { key: 'sugars', label: 'Sugars', unit: 'g', dec: 1, core: true },
  { key: 'fat', label: 'Fat', unit: 'g', dec: 1, core: true },
  { key: 'satfat', label: 'Saturates', unit: 'g', dec: 1 },
  { key: 'fibre', label: 'Fibre', unit: 'g', dec: 1, core: true },
  { key: 'salt', label: 'Salt', unit: 'g', dec: 2, core: true },
  { key: 'caffeine', label: 'Caffeine', unit: 'mg', dec: 0 },
  { key: 'alcohol', label: 'Alcohol', unit: 'g', dec: 1 },
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

// "12.4 g", "—" when unknown, and a trailing "+" when the total is missing some lines.
export function show(n, key, { unit = true } = {}) {
  const d = NUTRIENT[key];
  const v = num(n?.[key]);
  if (v === null) return '—';
  const s = new Intl.NumberFormat('en-GB', { maximumFractionDigits: d.dec }).format(round(v, d.dec));
  return `${s}${n?.missing?.[key] ? '+' : ''}${unit ? (d.unit === 'kcal' ? ' kcal' : ` ${d.unit}`) : ''}`;
}
