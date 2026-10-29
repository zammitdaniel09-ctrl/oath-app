// Food logged together or later: saved meals (shakes, fruit bowls, plates), recipes with their graph of
// ingredients, cooked batches with their real weight, and plans that only count once eaten.
import crypto from 'node:crypto';
import { db, logEvent } from './db.js';
import { validDate } from './time.js';
import { RuleError, localNow } from './engine.js';
import * as NUT from '../public/nutrition.js';
import { round, recipeTotals, amountText, norm, shareOf, scale, batchLeft, batchPortion } from '../public/nutrition.js';
import {
  clean, cleanFill, fillGaps, FILL_KEYS, existingEntry, placeEntry, insertEntry, newId, shapeItem, ts, SLOTS, getFood,
  shapeEntry, logFood,
} from './food.js';

const MEAL_KINDS = ['meal', 'shake', 'bowl', 'plate'];

// What a food of his own in a meal may carry: the values for the amount he had.
const OWN_KEYS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine', 'alcohol'];

// A food in a logged meal that is not a catalogue record: one he gave his own values for, or one only
// estimated from a photo or a description. { name, amount, grams | ml, kcal, protein, ..., fill, estimate }:
// the values are for the amount he had, `fill` (an estimate per 100) fills the rest when the weight is
// known, and anything still missing stays unknown.
function cleanOwnLine(l) {
  const name = clean(l.name, 120);
  if (!name) throw new RuleError('Each food needs a name.');
  const size = (x) => (Number(x) > 0 && Number(x) <= 10000 ? Number(x) : null);
  const grams = size(l.grams);
  const ml = grams ? null : size(l.ml);
  const nutrients = NUT.unknown();
  for (const k of OWN_KEYS) {
    if (l[k] === undefined || l[k] === null || l[k] === '') continue;
    const v = Number(l[k]);
    if (!(v >= 0) || v > (k === 'kcal' ? 10000 : 2000)) throw new RuleError(`${name}: ${k === 'kcal' ? 'the calories' : k} must be zero or more.`);
    nutrients[k] = v;
  }
  const fill = cleanFill(l.fill, ml ? 'ml' : 'g');
  if (fillGaps(nutrients, grams ?? ml, fill, FILL_KEYS).nutrients.kcal === null) throw new RuleError(`${name}: give the calories.`);
  return { ref: 'own', name, amount: clean(l.amount, 60), grams, ml, nutrients, ...(fill ? { fill } : {}), estimate: Boolean(l.estimate) };
}

// A meal's lines. `own` lets in foods of his own (only a meal logged straight from a plate or a chat
// card; a saved meal stays made of catalogue records). Catalogue lines may bring an estimate per 100
// (`fill`) for the values their record is missing.
export function cleanMealLines(lines, { own = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new RuleError('A saved meal needs at least one food.');
  if (lines.length > 40) throw new RuleError('Too many lines.');
  return lines.map((l) => {
    if (own && (l.ref === 'own' || l.ref === 'custom')) return cleanOwnLine(l);
    const ref = l.ref === 'recipe' ? 'recipe' : 'item';
    if (!l.ref_key) throw new RuleError('Each line needs a food.');
    const qty = Number(l.qty);
    if (!(qty > 0)) throw new RuleError('Each line needs an amount.');
    return { ref, ref_key: String(l.ref_key), qty, unit: String(l.unit || (ref === 'recipe' ? 'serving' : 'g')), optional: Boolean(l.optional), grp: clean(l.grp, 30),
      ...(own && ref === 'item' && l.fill ? { fill: l.fill } : {}) };
  });
}

// A food of his own as a priced row, scaled by the share of the meal he had.
function ownRow(l, factor) {
  const g = l.grams ? l.grams * factor : null;
  const ml = l.ml ? l.ml * factor : null;
  const { nutrients, filled } = fillGaps(NUT.scale(l.nutrients, factor, 1), g ?? ml, l.fill, FILL_KEYS);
  return {
    ref: 'own', ref_key: null, name: l.name, qty: null, unit: null,
    amount_text: l.amount || (g ? `${round(g, 0)} g` : ml ? `${round(ml, 0)} ml` : ''),
    g, ml, liquid: Boolean(ml), nutrients, filled, estimate: l.estimate, error: null,
  };
}

// Works out a meal's lines against the catalogue: [{ name, amount_text, nutrients, ... }]. Foods of his
// own are priced from their own values and keep their place in the list; a catalogue line with an
// estimate per 100 has the values its record is missing filled from it, listed in `filled`.
export async function priceLines(lines, opts = {}) {
  const at = [];
  const listed = lines.filter((l, i) => (l.ref === 'own' ? false : at.push(i) > 0));
  const back = new Map(at.map((orig, j) => [orig, j]));
  const moved = (list) => (list || []).map(Number).filter((i) => back.has(i)).map((i) => back.get(i));
  const swap = Object.fromEntries(Object.entries(opts.swap || {}).filter(([i]) => back.has(Number(i))).map(([i, s]) => [back.get(Number(i)), s]));
  const sub = { ...opts, skip: moved(opts.skip), with: moved(opts.with), swap };
  const all = [...listed, ...Object.values(swap)];
  const graph = await loadGraph(all.filter((l) => l.ref === 'recipe').map((l) => l.ref_key), all.filter((l) => l.ref !== 'recipe').map((l) => l.ref_key));
  const t = recipeTotals({ key: '__meal__', servings: 1, lines: listed }, graph.get, sub);
  const rows = t.rows.map((r) => {
    const it = r.ref === 'recipe' ? graph.recipes.get(r.ref_key) : graph.items.get(r.ref_key);
    const g = r.g ?? (r.basis === 'g' ? r.amount : null);
    const ml = r.ml ?? null;
    const fill = r.ref === 'item' && it ? cleanFill(listed[r.index]?.fill, it.basis) : null;
    const { nutrients, filled } = fillGaps(r.nutrients, fill?.basis === 'ml' ? (ml ?? g) : (g ?? ml), fill, FILL_KEYS);
    return {
      index: at[r.index], ref: r.ref, ref_key: r.ref_key, name: it?.name || r.ref_key, qty: r.qty, unit: r.unit,
      amount_text: r.ref === 'recipe' ? amountText(r.qty, r.unit) : it ? amountText(r.qty, r.unit, it) : '',
      g, ml, liquid: Boolean(it?.liquid), nutrients, ...(filled.length ? { filled } : {}), error: r.error,
    };
  });
  const skipped = new Set((opts.skip || []).map(Number));
  lines.forEach((l, i) => { if (l.ref === 'own' && !skipped.has(i)) rows.push({ index: i, ...ownRow(l, Number(opts.factor) > 0 ? Number(opts.factor) : 1) }); });
  rows.sort((a, b) => a.index - b.index);
  for (const r of rows) delete r.index;
  return { rows, nutrients: NUT.total(rows.map((r) => r.nutrients)), errors: rows.filter((r) => r.error).map((r) => r.error) };
}

const shapeMeal = (r, priced) => ({
  id: r.id, name: r.name, kind: r.kind, lines: r.lines, favourite: r.favourite, uses: r.uses,
  ...(priced ? { priced: priced.rows, nutrients: priced.nutrients, errors: priced.errors } : {}),
});

export async function listMeals() {
  const rows = await db()`select * from food_meals where deleted_at is null order by favourite desc, last_used desc nulls last, name`;
  const out = [];
  for (const r of rows) out.push(shapeMeal(r, await priceLines(r.lines)));
  return out;
}

export async function getMeal(id) {
  const [r] = await db()`select * from food_meals where id = ${Number(id)} and deleted_at is null`;
  if (!r) throw new RuleError('That saved meal is gone.', 404);
  return shapeMeal(r, await priceLines(r.lines));
}

export async function saveMeal(input) {
  const name = clean(input.name, 100);
  if (!name) throw new RuleError('Give it a name.');
  const kind = MEAL_KINDS.includes(input.kind) ? input.kind : 'meal';
  const lines = cleanMealLines(input.lines);
  const priced = await priceLines(lines);
  if (priced.errors.length) throw new RuleError(priced.errors[0]);
  const sql = db();
  const [r] = input.id
    ? await sql`update food_meals set name = ${name}, kind = ${kind}, lines = ${sql.json(lines)}, updated_at = now() where id = ${Number(input.id)} and deleted_at is null returning *`
    : await sql`insert into food_meals (name, kind, lines) values (${name}, ${kind}, ${sql.json(lines)}) returning *`;
  if (!r) throw new RuleError('That saved meal is gone.', 404);
  return shapeMeal(r, priced);
}

export async function deleteMeal(id) {
  await db()`update food_meals set deleted_at = now() where id = ${Number(id)}`;
  return { ok: true };
}

// Logs a saved meal or an unsaved builder: { meal_id | lines, name, factor, skip, swap, id, date, slot }.
// The lines are frozen into the entry, so later edits to the meal never change this day.
export async function logMeal(input, source = 'you') {
  const again = await existingEntry(input.id);
  if (again) return again;
  let lines;
  let name = clean(input.name, 120);
  let mealId = null;
  if (input.meal_id) {
    const [m] = await db()`select * from food_meals where id = ${Number(input.meal_id)} and deleted_at is null`;
    if (!m) throw new RuleError('That saved meal is gone.', 404);
    lines = m.lines;
    name = name || m.name;
    mealId = m.id;
  } else lines = cleanMealLines(input.lines, { own: true });
  if (!name) name = 'Meal';
  const factor = input.factor === undefined ? 1 : Number(input.factor);
  if (!(factor > 0) || factor > 20) throw new RuleError('The share must be more than zero.');
  const swap = {};
  for (const [i, s] of Object.entries(input.swap || {})) swap[i] = cleanMealLines([{ ...lines[i], ...s }])[0];
  const priced = await priceLines(lines, { factor, skip: input.skip || [], with: input.with || [], swap });
  if (priced.errors.length) throw new RuleError(priced.errors[0]);
  const ml = priced.rows.filter((r) => r.liquid && r.ml).reduce((a, r) => a + r.ml, 0);
  const g = priced.rows.reduce((a, r) => a + (r.g || 0), 0);
  const place = await placeEntry(input, priced.rows.every((r) => r.liquid));
  const out = await insertEntry({
    id: input.id || newId(),
    ...place,
    kind: 'meal',
    ref_id: mealId,
    name,
    qty: factor,
    unit: 'share',
    amount_text: factor === 1 ? `${priced.rows.length} items` : `${round(factor, 2)} of it, ${priced.rows.length} items`,
    grams: g || null,
    ml: ml || null,
    liquid: ml > 0 && priced.rows.every((r) => r.liquid || !r.g),
    nutrients: priced.nutrients,
    lines: priced.rows,
    // Values estimated for any of its foods: the diary marks those totals with "~".
    filled: [...new Set(priced.rows.flatMap((r) => r.filled || []))],
    estimate: Boolean(input.estimate) || priced.rows.some((r) => r.estimate),
    source,
    note: input.note,
    plan_id: input.plan_id,
  });
  if (!out.duplicate && mealId) await db()`update food_meals set uses = uses + 1, last_used = now() where id = ${mealId}`;
  return out;
}

// ---------- Recipes ----------

// Loads recipes and items reachable from the given keys, following sub-recipes, so the maths can run
// without further queries.
export async function loadGraph(recipeKeys = [], itemKeys = []) {
  const sql = db();
  const recipes = new Map();
  const items = new Map();
  let todoR = [...new Set(recipeKeys)];
  const needI = new Set(itemKeys);
  while (todoR.length) {
    const rows = await sql`select * from recipes where key in ${sql(todoR)} and deleted_at is null`;
    const ids = rows.map((r) => r.id);
    const lines = ids.length ? await sql`select * from recipe_lines where recipe_id in ${sql(ids)} order by recipe_id, sort` : [];
    const next = [];
    for (const r of rows) {
      const ls = lines.filter((l) => l.recipe_id === r.id).map((l) => ({ ref: l.ref, ref_key: l.ref_key, qty: l.qty, unit: l.unit, optional: l.optional, grp: l.grp, label: l.label, note: l.note }));
      recipes.set(r.key, { ...r, lines: ls });
      for (const l of ls) {
        if (l.ref === 'recipe') { if (!recipes.has(l.ref_key)) next.push(l.ref_key); } else needI.add(l.ref_key);
      }
    }
    todoR = [...new Set(next)].filter((k) => !recipes.has(k));
  }
  const keys = [...needI];
  if (keys.length) for (const r of await sql`select * from food_items where key in ${sql(keys)}`) items.set(r.key, shapeItem(r));
  return { recipes, items, get: { item: (k) => items.get(k), recipe: (k) => recipes.get(k) } };
}

const shapeRecipeRow = (r) => ({
  id: r.id, key: r.key, name: r.name, name_mt: r.name_mt, family: r.family, type: r.type, parent_key: r.parent_key, version: r.version,
  summary: r.summary, servings: r.servings, final_weight: r.final_weight, prep_min: r.prep_min, cook_min: r.cook_min, equipment: r.equipment,
  tags: r.tags, source: r.source, status: r.status, favourite: r.favourite, uses: r.uses, req: r.req,
  source_url: r.source_url || null, source_name: r.source_name || null,
});

export async function listRecipes({ q = '', family = '', type = '', limit = 2000 } = {}) {
  const sql = db();
  const words = norm(q).split(' ').filter(Boolean).slice(0, 6);
  const all = words.reduce((acc, w) => sql`${acc} and search like ${`%${w}%`}`, sql``);
  const rows = await sql`select r.*, (select count(*)::int from recipe_lines l where l.recipe_id = r.id) as line_count
    from recipes r where deleted_at is null ${all}
    ${family ? sql`and family = ${family}` : sql``} ${type ? sql`and type = ${type}` : sql``}
    order by favourite desc, uses desc, (type = 'base') desc, name limit ${Math.min(Number(limit) || 2000, 2000)}`;
  // Totals for the list come from one graph load.
  const graph = await loadGraph(rows.map((r) => r.key));
  return rows.map((r) => {
    let per = null;
    try {
      const t = recipeTotals(graph.recipes.get(r.key), graph.get);
      per = t.perServing;
    } catch { per = null; }
    return { ...shapeRecipeRow(r), lines: r.line_count, perServing: per };
  });
}

export async function getRecipe(ref, opts = {}) {
  const sql = db();
  const [r] = typeof ref === 'number' || /^\d+$/.test(String(ref))
    ? await sql`select * from recipes where id = ${Number(ref)} and deleted_at is null`
    : await sql`select * from recipes where key = ${String(ref)} and deleted_at is null`;
  if (!r) throw new RuleError('That recipe is gone.', 404);
  const swaps = Object.values(opts.swap || {});
  const graph = await loadGraph([r.key, ...swaps.filter((s) => s.ref === 'recipe').map((s) => s.ref_key)], swaps.filter((s) => s.ref !== 'recipe').map((s) => s.ref_key));
  const rec = graph.recipes.get(r.key);
  let t;
  try {
    t = recipeTotals(rec, graph.get, opts);
  } catch (err) {
    throw new RuleError(err.message);
  }
  const lines = rec.lines.map((l, i) => {
    const row = t.rows.find((x) => x.index === i);
    const it = l.ref === 'recipe' ? graph.recipes.get(l.ref_key) : graph.items.get(l.ref_key);
    return {
      ...l, index: i, name: it?.name || `Missing: ${l.ref_key}`, missing: !it,
      amount_text: l.ref === 'recipe' ? amountText(l.qty, l.unit) : it ? amountText(l.qty, l.unit, it) : `${l.qty} ${l.unit}`,
      skipped: !row, nutrients: row?.nutrients || null, error: row?.error || null, units: it && l.ref !== 'recipe' ? it.units : null,
    };
  });
  const variants = await sql`select key, name from recipes where parent_key = ${r.key} and deleted_at is null order by name`;
  const parent = r.parent_key ? (await sql`select key, name from recipes where key = ${r.parent_key}`)[0] || null : null;
  const batches = await sql`select id, cooked_on, final_weight, servings from food_batches where recipe_key = ${r.key} and finished_at is null order by id desc`;
  return {
    ...shapeRecipeRow(r), method: r.method, notes: r.notes, licence: r.licence, lines,
    totals: t.nutrients, perServing: t.perServing, per100: t.per100, rawWeight: t.raw_weight, errors: t.errors,
    variants, parent, openBatches: batches.length,
  };
}

const slug = (s) => norm(s).replace(/ /g, '-').slice(0, 50);

// Where a recipe stands: written by Oath and not cooked yet, checked by him, cooked and confirmed, or
// imported from a page he linked (food-import.js).
export const RECIPE_STATUSES = ['ai-untested', 'user-reviewed', 'tested', 'imported'];

// The page a recipe came from: a web address only, with the site's name for the credit on its card.
function sourceLink(input) {
  try {
    const u = new URL(String(input.source_url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: null, name: null };
    return { url: u.toString().slice(0, 1000), name: clean(input.source_name, 80) || u.hostname.replace(/^www\./, '') };
  } catch {
    return { url: null, name: null };
  }
}

// Saves a recipe of Daniel's: name, ingredients and servings are enough. Editing makes a new version;
// batches and diary entries keep the version they were made from.
export async function saveRecipe(input, { source = 'you' } = {}) {
  const name = clean(input.name, 120);
  if (!name) throw new RuleError('Give the recipe a name.');
  const servings = Number(input.servings);
  if (!(servings > 0) || servings > 200) throw new RuleError('How many servings does it make?');
  const finalWeight = input.final_weight === undefined || input.final_weight === null || input.final_weight === '' ? null : Number(input.final_weight);
  if (finalWeight !== null && !(finalWeight > 0)) throw new RuleError('The finished weight must be more than zero.');
  const lines = (input.lines || []).map((l, i) => ({
    sort: i, grp: clean(l.grp, 40), ref: l.ref === 'recipe' ? 'recipe' : 'item', ref_key: String(l.ref_key || ''),
    qty: Number(l.qty), unit: String(l.unit || 'g'), optional: Boolean(l.optional), label: clean(l.label, 60), note: clean(l.note, 120),
  }));
  if (!lines.length) throw new RuleError('Add at least one ingredient.');
  for (const l of lines) if (!l.ref_key || !(l.qty > 0)) throw new RuleError('Each ingredient needs a food and an amount.');
  const method = (input.method || []).map((s) => clean(s, 600)).filter(Boolean);
  const sql = db();
  const existing = input.key ? (await sql`select * from recipes where key = ${input.key} and deleted_at is null`)[0] : null;
  const key = existing?.key || input.key || `my:${slug(name)}-${crypto.randomBytes(3).toString('hex')}`;
  // Check it adds up (and has no loops) before saving.
  const graph = await loadGraph(lines.filter((l) => l.ref === 'recipe').map((l) => l.ref_key), lines.filter((l) => l.ref === 'item').map((l) => l.ref_key));
  try {
    const t = recipeTotals({ key, servings, final_weight: finalWeight, lines }, graph.get);
    if (t.errors.length) throw new RuleError(t.errors[0]);
  } catch (err) {
    throw err instanceof RuleError ? err : new RuleError(err.message);
  }
  const fields = {
    name, name_mt: input.name_mt ? clean(input.name_mt, 120) : null, family: clean(input.family, 40), type: ['base', 'variant', 'component', 'template'].includes(input.type) ? input.type : 'base',
    parent_key: input.parent_key || null, summary: clean(input.summary, 400), servings, final_weight: finalWeight,
    prep_min: Number(input.prep_min) > 0 ? Math.round(input.prep_min) : null, cook_min: Number(input.cook_min) > 0 ? Math.round(input.cook_min) : null,
    equipment: (input.equipment || []).map((x) => clean(x, 40)).filter(Boolean), tags: (input.tags || []).map((x) => clean(x, 30)).filter(Boolean),
    notes: clean(input.notes, 1000), req: (input.req || []).map((x) => clean(x, 120)),
    search: [norm(name), norm(input.name_mt), norm((input.tags || []).join(' ')), norm(input.family)].filter(Boolean).join(' '),
  };
  // An edit that does not mention the page keeps it.
  const link = sourceLink(input);
  return sql.begin(async (tx) => {
    let row;
    if (existing) {
      [row] = await tx`update recipes set name = ${fields.name}, name_mt = ${fields.name_mt}, family = ${fields.family}, type = ${fields.type},
        parent_key = ${fields.parent_key}, summary = ${fields.summary}, servings = ${fields.servings}, final_weight = ${fields.final_weight},
        prep_min = ${fields.prep_min}, cook_min = ${fields.cook_min}, equipment = ${fields.equipment}::text[], tags = ${fields.tags}::text[],
        method = ${tx.json(method)}, notes = ${fields.notes}, req = ${fields.req}::text[], search = ${fields.search},
        version = version + 1, edited = ${source === 'you'}, status = ${source === 'you' && existing.status === 'ai-untested' ? 'user-reviewed' : existing.status},
        source_url = coalesce(${link.url}, source_url), source_name = coalesce(${link.name}, source_name),
        updated_at = now() where id = ${existing.id} returning *`;
      await tx`delete from recipe_lines where recipe_id = ${existing.id}`;
    } else {
      [row] = await tx`insert into recipes (key, name, name_mt, family, type, parent_key, summary, servings, final_weight, prep_min, cook_min,
        equipment, tags, method, notes, req, search, source, licence, status, source_url, source_name)
        values (${key}, ${fields.name}, ${fields.name_mt}, ${fields.family}, ${fields.type}, ${fields.parent_key}, ${fields.summary}, ${fields.servings},
        ${fields.final_weight}, ${fields.prep_min}, ${fields.cook_min}, ${fields.equipment}::text[], ${fields.tags}::text[], ${tx.json(method)},
        ${fields.notes}, ${fields.req}::text[], ${fields.search}, ${source}, ${input.licence || null},
        ${RECIPE_STATUSES.includes(input.status) ? input.status : source === 'you' ? 'user-reviewed' : 'ai-untested'}, ${link.url}, ${link.url ? link.name : null})
        returning *`;
    }
    for (const l of lines) {
      await tx`insert into recipe_lines (recipe_id, sort, grp, ref, ref_key, qty, unit, optional, label, note)
        values (${row.id}, ${l.sort}, ${l.grp}, ${l.ref}, ${l.ref_key}, ${l.qty}, ${l.unit}, ${l.optional}, ${l.label}, ${l.note})`;
    }
    return { key: row.key, id: row.id, version: row.version };
  });
}

// A copy to change freely: a variant linked to its parent.
export async function duplicateRecipe(key, name) {
  const r = await getRecipe(key);
  return saveRecipe({
    name: clean(name, 120) || `${r.name} (my version)`, family: r.family, type: 'variant', parent_key: r.key, summary: r.summary,
    servings: r.servings, final_weight: r.final_weight, prep_min: r.prep_min, cook_min: r.cook_min, equipment: r.equipment, tags: r.tags,
    method: r.method, notes: r.notes,
    lines: r.lines.map((l) => ({ ref: l.ref, ref_key: l.ref_key, qty: l.qty, unit: l.unit, optional: l.optional, grp: l.grp, label: l.label, note: l.note })),
  });
}

export async function deleteRecipe(key) {
  const sql = db();
  const used = await sql`select r.key from recipe_lines l join recipes r on r.id = l.recipe_id where l.ref = 'recipe' and l.ref_key = ${key} and r.deleted_at is null limit 1`;
  if (used.length) throw new RuleError(`Another recipe uses this one (${used[0].key}). Change that one first.`);
  await sql`update recipes set deleted_at = now() where key = ${key}`;
  return { ok: true };
}

// Logs servings (or grams of the finished dish) of a recipe straight from the card, with any
// swaps and skipped optional items. The worked-out lines are frozen into the entry.
export async function logRecipe(input, source = 'you') {
  const again = await existingEntry(input.id);
  if (again) return again;
  const r = await getRecipe(input.key || input.recipe_id, { skip: input.skip || [], with: input.with || [], swap: input.swap || {}, factor: input.factor || 1 });
  if (r.errors.length) throw new RuleError(r.errors[0]);
  const unit = input.unit === 'g' ? 'g' : 'serving';
  const s = shareOf({ servings: r.servings * (input.factor || 1), final_weight: r.final_weight ? r.final_weight * (input.factor || 1) : null }, input.qty ?? 1, unit);
  if (s.error) throw new RuleError(s.error);
  const nutrients = scale(r.totals, s.share, 1);
  const place = await placeEntry(input, false);
  const out = await insertEntry({
    id: input.id || newId(),
    ...place,
    kind: 'recipe',
    ref_id: r.id,
    ref_key: r.key,
    name: r.name,
    qty: Number(input.qty ?? 1),
    unit,
    amount_text: amountText(Number(input.qty ?? 1), unit),
    grams: unit === 'g' ? Number(input.qty) : r.final_weight ? round(s.share * r.final_weight * (input.factor || 1), 1) : null,
    share: s.share,
    nutrients,
    lines: r.lines.filter((l) => !l.skipped).map((l) => ({ name: l.name, amount_text: l.amount_text, ref_key: l.ref_key, nutrients: l.nutrients ? scale(l.nutrients, s.share, 1) : null })),
    source,
    note: input.note || `Recipe version ${r.version}`,
    plan_id: input.plan_id,
  });
  if (!out.duplicate) await db()`update recipes set uses = uses + 1, last_used = now() where id = ${r.id}`;
  return out;
}

// ---------- Batches ----------

export function shapeBatch(b) {
  return b ? { ...b, final_weight: b.final_weight, servings: b.servings } : null;
}
export const batchAmountText = (qty, unit) => (unit === 'g' ? `${round(qty, 0)} g of the batch` : unit === 'serving' ? `${round(qty, 2)} ${Number(qty) === 1 ? 'serving' : 'servings'}` : `${round(qty * 100, 0)}% of the batch`);

// One cooked batch: what actually went in (after swaps), its total, and the finished weight.
export async function cookBatch(input) {
  const r = await getRecipe(input.key, { skip: input.skip || [], with: input.with || [], swap: input.swap || {}, factor: input.factor || 1 });
  if (r.errors.length) throw new RuleError(r.errors[0]);
  const finalWeight = input.final_weight === undefined || input.final_weight === '' || input.final_weight === null ? null : Number(input.final_weight);
  if (finalWeight !== null && !(finalWeight > 0)) throw new RuleError('The finished weight must be more than zero.');
  const servings = Number(input.servings || r.servings * (input.factor || 1));
  if (!(servings > 0)) throw new RuleError('How many servings did it make?');
  if (finalWeight === null && !input.servings && !r.servings) throw new RuleError('Weigh the finished batch or give the servings.');
  const { today } = await localNow();
  const lines = r.lines.filter((l) => !l.skipped).map((l) => ({ name: l.name, ref: l.ref, ref_key: l.ref_key, qty: l.qty * (input.factor || 1), unit: l.unit, amount_text: l.amount_text, nutrients: l.nutrients }));
  const sql = db();
  const [b] = await sql`insert into food_batches (recipe_key, recipe_version, name, cooked_on, lines, nutrients, final_weight, servings, note)
    values (${r.key}, ${r.version}, ${clean(input.name, 120) || r.name}, ${input.cooked_on && validDate(input.cooked_on) ? input.cooked_on : today},
      ${sql.json(lines)}, ${sql.json(r.totals)}, ${finalWeight}, ${servings}, ${clean(input.note, 300)}) returning *`;
  await logEvent('food_batch_cooked', { id: b.id, recipe: r.key });
  return getBatch(b.id);
}

export async function getBatch(id) {
  const [b] = await db()`select * from food_batches where id = ${Number(id)}`;
  if (!b) throw new RuleError('That batch is gone.', 404);
  const used = await db()`select id, date, share, amount_text from food_log where kind = 'batch' and ref_id = ${b.id} and deleted_at is null order by at`;
  const left = batchLeft(b, used.map((u) => u.share));
  return {
    id: b.id, name: b.name, recipeKey: b.recipe_key, recipeVersion: b.recipe_version, cookedOn: b.cooked_on, lines: b.lines, nutrients: b.nutrients,
    final_weight: b.final_weight, servings: b.servings, note: b.note, finished: Boolean(b.finished_at), used, left,
    perServing: b.servings ? scale(b.nutrients, 1, b.servings) : null, per100: b.final_weight ? scale(b.nutrients, 100, b.final_weight) : null,
  };
}

export async function listBatches({ open = true } = {}) {
  const sql = db();
  const rows = await sql`select id from food_batches ${open ? sql`where finished_at is null` : sql``} order by id desc limit 50`;
  const out = [];
  for (const r of rows) out.push(await getBatch(r.id));
  return out;
}

export async function logBatch(input, source = 'you') {
  const again = await existingEntry(input.id);
  if (again) return again;
  const b = await getBatch(input.batch_id);
  if (b.finished) throw new RuleError('That batch is marked finished.');
  const unit = ['g', 'serving', 'share'].includes(input.unit) ? input.unit : b.final_weight ? 'g' : 'serving';
  const p = batchPortion(b, input.qty, unit);
  if (p.error) throw new RuleError(p.error);
  if (p.share > b.left.share + 1e-9) {
    const left = b.left.g !== null ? `${round(b.left.g, 0)} g` : `${round(b.left.servings, 2)} servings`;
    throw new RuleError(`Only ${left} of this batch is left.`);
  }
  const place = await placeEntry(input, false);
  const out = await insertEntry({
    id: input.id || newId(),
    ...place,
    kind: 'batch',
    ref_id: b.id,
    ref_key: b.recipeKey,
    name: b.name,
    qty: Number(input.qty),
    unit,
    amount_text: batchAmountText(Number(input.qty), unit),
    grams: p.g,
    share: p.share,
    nutrients: p.nutrients,
    source,
    note: input.note || `Batch cooked ${b.cookedOn}`,
    plan_id: input.plan_id,
  });
  return { ...out, batch: await getBatch(b.id) };
}

export async function finishBatch(id, done = true) {
  await db()`update food_batches set finished_at = ${done ? ts() : null} where id = ${Number(id)}`;
  return getBatch(id);
}

// ---------- Plans: food meant for later, never counted as eaten ----------

const shapePlan = (p) => ({ id: p.id, date: p.date, slot: p.slot, kind: p.kind, refKey: p.ref_key, refId: p.ref_id, name: p.name, qty: p.qty, unit: p.unit, note: p.note, loggedId: p.logged_id });

export async function addPlan(input) {
  const { today } = await localNow();
  const date = input.date || today;
  if (!validDate(date)) throw new RuleError('Bad date.');
  const slot = SLOTS.includes(input.slot) ? input.slot : 'lunch';
  const kind = ['item', 'recipe', 'meal', 'batch'].includes(input.kind) ? input.kind : 'item';
  let name = clean(input.name, 120);
  if (kind === 'item') name = name || (await getFood({ key: input.ref_key })).name;
  if (kind === 'recipe') name = name || (await getRecipe(input.ref_key)).name;
  if (kind === 'meal') name = name || (await getMeal(input.ref_id)).name;
  if (kind === 'batch') name = name || (await getBatch(input.ref_id)).name;
  const [p] = await db()`insert into food_plans (date, slot, kind, ref_key, ref_id, name, qty, unit, note)
    values (${date}, ${slot}, ${kind}, ${input.ref_key || null}, ${input.ref_id ? Number(input.ref_id) : null}, ${name},
      ${input.qty === undefined ? null : Number(input.qty)}, ${input.unit || null}, ${clean(input.note, 300)}) returning *`;
  return shapePlan(p);
}

export async function listPlans(from, to) {
  const rows = await db()`select * from food_plans where date >= ${from} and date <= ${to} and deleted_at is null order by date, id`;
  return rows.map(shapePlan);
}

export async function deletePlan(id) {
  await db()`update food_plans set deleted_at = now() where id = ${Number(id)}`;
  return { ok: true };
}

// Eaten: the plan becomes a real diary entry (today unless said otherwise) and stays linked to it.
export async function eatPlan(id, input = {}) {
  const [p] = await db()`select * from food_plans where id = ${Number(id)} and deleted_at is null`;
  if (!p) throw new RuleError('That plan is gone.', 404);
  if (p.logged_id) {
    const [e] = await db()`select * from food_log where id = ${p.logged_id} and deleted_at is null`;
    if (e) return { entry: shapeEntry(e), duplicate: true };
  }
  const base = { id: input.id, date: input.date, time: input.time, slot: input.slot || p.slot, plan_id: p.id, qty: input.qty ?? p.qty, unit: input.unit ?? p.unit };
  let out;
  if (p.kind === 'item') out = await logFood({ ...base, key: p.ref_key }, 'plan');
  else if (p.kind === 'recipe') out = await logRecipe({ ...base, key: p.ref_key, qty: base.qty ?? 1, unit: base.unit || 'serving' }, 'plan');
  else if (p.kind === 'meal') out = await logMeal({ ...base, meal_id: p.ref_id, factor: base.qty ?? 1 }, 'plan');
  else out = await logBatch({ ...base, batch_id: p.ref_id }, 'plan');
  await db()`update food_plans set logged_id = ${out.entry.id} where id = ${p.id}`;
  return out;
}
