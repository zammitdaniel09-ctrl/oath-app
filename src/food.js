// Food: the catalogue (USDA generics, Open Food Facts products, labels read from photos, Daniel's own
// foods), the diary, saved meals, recipes, cooked batches, plans and the coverage report.
//
// Honest by construction: every record says where its numbers came from, unknown values stay null,
// diary lines keep a frozen copy of what was logged, and food never touches HP.
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { db, logEvent } from './db.js';
import { nowUTC, addDays, validDate, validTime } from './time.js';
import { localNow, RuleError } from './engine.js';
import {
  KEYS, NUTRIENT, NUTRIENTS, norm, scale, total, line, batchPortion, unknown, round, amountText, unitsFor, resolve,
  show, portionName,
} from '../public/nutrition.js';
// Grades come from the shared maths when it has them; read through the namespace so the
// diary still works on a build without them.
import * as NUT from '../public/nutrition.js';
import { foodTags, tagKeys, cleanFacts, TAGS_VERSION } from '../public/food-tags.js';
import { needRefs } from './body.js';
import { foodHistory } from './food-history.js';
import {
  cleanMealLines, priceLines, listMeals, getMeal, saveMeal, deleteMeal, logMeal, listRecipes, getRecipe, saveRecipe,
  duplicateRecipe, deleteRecipe, logRecipe, shapeBatch, batchAmountText, cookBatch, getBatch, listBatches, logBatch,
  finishBatch, addPlan, listPlans, deletePlan, eatPlan,
} from './food-recipes.js';

// Moved to food-history.js; still exported here for the modules and tests that import them from this file.
export { HISTORY_SPANS, dayStats, foodHistory, SOURCE_KEYS } from './food-history.js';
// Moved to food-recipes.js; still exported here for the modules and tests that import them from this file.
export {
  listMeals, getMeal, saveMeal, deleteMeal, logMeal, loadGraph, listRecipes, getRecipe, RECIPE_STATUSES, saveRecipe,
  duplicateRecipe, deleteRecipe, logRecipe, cookBatch, getBatch, listBatches, logBatch, finishBatch, addPlan, listPlans,
  deletePlan, eatPlan,
} from './food-recipes.js';

// ---------- Schema ----------

export const FOOD_SCHEMA = `
create table if not exists food_items (
  id serial primary key,
  key text not null unique,
  kind text not null,
  name text not null,
  name_mt text,
  aliases text[] not null default '{}',
  name_norm text not null,
  alias_norm text[] not null default '{}',
  search text not null,
  brand text,
  barcode text,
  market text,
  category text,
  state text,
  basis text not null default 'g',
  nutrients jsonb not null default '{}',
  portions jsonb not null default '[]',
  edible double precision,
  refuse text,
  density double precision,
  pack jsonb,
  serving jsonb,
  concentrate jsonb,
  liquid boolean not null default false,
  source text not null,
  source_ref text,
  source_date text,
  status text not null default 'ok',
  notes text not null default '',
  req text[] not null default '{}',
  uses int not null default 0,
  last_used timestamptz,
  last_qty double precision,
  last_unit text,
  favourite boolean not null default false,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists food_items_barcode_idx on food_items (barcode);
create index if not exists food_items_name_norm_idx on food_items (name_norm);
create table if not exists food_log (
  id text primary key,
  date text not null,
  at timestamptz not null,
  slot text not null,
  kind text not null,
  ref_id int,
  ref_key text,
  name text not null,
  brand text,
  qty double precision,
  unit text,
  amount_text text not null default '',
  grams double precision,
  ml double precision,
  share double precision,
  liquid boolean not null default false,
  nutrients jsonb not null,
  lines jsonb,
  estimate boolean not null default false,
  source text not null default 'you',
  note text not null default '',
  plan_id int,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists food_log_date_idx on food_log (date);
create table if not exists food_meals (
  id serial primary key,
  name text not null,
  kind text not null default 'meal',
  lines jsonb not null,
  favourite boolean not null default false,
  uses int not null default 0,
  last_used timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists recipes (
  id serial primary key,
  key text not null unique,
  name text not null,
  name_mt text,
  family text not null default '',
  type text not null default 'base',
  parent_key text,
  req text[] not null default '{}',
  version int not null default 1,
  summary text not null default '',
  servings double precision not null,
  final_weight double precision,
  prep_min int,
  cook_min int,
  equipment text[] not null default '{}',
  method jsonb not null default '[]',
  tags text[] not null default '{}',
  source text not null default 'oath',
  licence text,
  status text not null default 'ai-untested',
  notes text not null default '',
  search text not null,
  edited boolean not null default false,
  seed_hash text,
  favourite boolean not null default false,
  uses int not null default 0,
  last_used timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists recipe_lines (
  id serial primary key,
  recipe_id int not null references recipes(id) on delete cascade,
  sort int not null,
  grp text not null default '',
  ref text not null default 'item',
  ref_key text not null,
  qty double precision not null,
  unit text not null,
  optional boolean not null default false,
  label text not null default '',
  note text not null default ''
);
create index if not exists recipe_lines_recipe_idx on recipe_lines (recipe_id);
create table if not exists food_batches (
  id serial primary key,
  recipe_key text,
  recipe_version int,
  name text not null,
  cooked_on text not null,
  lines jsonb not null,
  nutrients jsonb not null,
  final_weight double precision,
  servings double precision,
  note text not null default '',
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists food_plans (
  id serial primary key,
  date text not null,
  slot text not null,
  kind text not null,
  ref_key text,
  ref_id int,
  name text not null,
  qty double precision,
  unit text,
  note text not null default '',
  logged_id text,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists food_plans_date_idx on food_plans (date);
create table if not exists food_requirements (
  key text not null,
  list text not null,
  category text not null,
  category_label text not null default '',
  priority text not null default '',
  name text not null,
  handling text not null default '',
  type text,
  status text not null,
  records text[] not null default '{}',
  issue text not null default '',
  updated_at timestamptz not null default now(),
  primary key (list, key)
);
-- v6: grades and processing level as given by the source (Open Food Facts), and which values of a
-- diary line were filled with an estimate because the record had none.
alter table food_items add column if not exists nutriscore text;
alter table food_items add column if not exists nova int;
-- v6: the brand as searched (lower case, accents and punctuation folded), so "burger king fries" can lead with the brand.
alter table food_items add column if not exists brand_norm text not null default '';
alter table food_log add column if not exists filled text[] not null default '{}';
-- v6.1: the coach's take on a Food screen, kept until the numbers behind it change (food-take.js).
create table if not exists food_takes (
  view text not null,
  date date not null,
  hash text not null,
  text text not null,
  at timestamptz not null default now(),
  primary key (view, date)
);
-- v7: filling in what an entry's record or estimate left unknown (food-enrich.js). fill_source says where
-- filled values came from, fill_profile keeps the reading's or the coach's estimate per 100 for later,
-- and enriched_at with enrich_tries keep the background queue idempotent and let it give up on failures.
alter table food_log add column if not exists fill_source jsonb;
alter table food_log add column if not exists fill_profile jsonb;
alter table food_log add column if not exists enriched_at timestamptz;
alter table food_log add column if not exists enrich_tries int not null default 0;
alter table food_log add column if not exists enrich_error text;
create index if not exists food_log_enrich_idx on food_log (date) where enriched_at is null and deleted_at is null;
-- v7: what the filler already worked out for a name (a reference record, a description, a web result),
-- so the same food logged again costs nothing.
create table if not exists food_lookups (
  key text primary key,
  value jsonb not null,
  at timestamptz not null default now()
);
-- v9: a recipe imported from a link keeps the page it came from, credited on its card (food-import.js).
alter table recipes add column if not exists source_url text;
alter table recipes add column if not exists source_name text;
-- v16: what a record knows beyond its numbers (labels, allergens, traces, additives, ingredients analysis,
-- categories, Green-Score: public/food-tags.js cleanFacts), when Open Food Facts last gave them, and the
-- record's tags as the shared rules work them out, with the rules' version, so the catalogue can be
-- browsed by tag and is worked out again when a rule changes (src/food-tags.js).
alter table food_items add column if not exists facts jsonb not null default '{}';
alter table food_items add column if not exists facts_at timestamptz;
alter table food_items add column if not exists tags text[] not null default '{}';
alter table food_items add column if not exists tags_v int not null default 0;
create index if not exists food_items_tags_idx on food_items using gin (tags);
`;

export async function migrateFood() {
  const sql = db();
  await sql.unsafe(FOOD_SCHEMA);
  // Search over the whole USDA catalogue stays quick with a trigram index where the host allows the
  // extension (Railway may not); without it a plain scan is fast enough, so this is optional.
  try {
    await sql.unsafe('create extension if not exists pg_trgm');
    await sql.unsafe('create index if not exists food_items_search_trgm on food_items using gin (search gin_trgm_ops)');
  } catch { /* optional */ }
  // Records saved before brand_norm existed.
  const old = await sql`select id, brand from food_items where brand is not null and brand_norm = ''`;
  if (old.length) {
    await sql`update food_items f set brand_norm = t.b from unnest(${old.map((r) => r.id)}::int[], ${old.map((r) => norm(r.brand))}::text[]) as t(id, b) where f.id = t.id`;
  }
  // Drinks logged in grams before their ml was worked out from the record's sourced density.
  await sql`update food_log l set ml = l.grams / i.density from food_items i
            where l.ref_id = i.id and l.kind = 'item' and l.liquid and l.ml is null and l.grams > 0 and i.density > 0`;
  // Drinks with no sourced density, logged by weight or by a portion in grams, never reached the day's
  // drinks; their grams stand for ml now (public/nutrition.js resolve), and the ones already logged follow.
  await sql`update food_log set ml = grams where liquid and ml is null and grams > 0`;
}

// ---------- Records ----------

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks', 'drinks'];
const KINDS = ['generic', 'product', 'custom', 'label', 'estimate', 'web'];
const SOURCE_TEXT = {
  usda: 'USDA FoodData Central',
  off: 'Open Food Facts',
  label: 'Read from a label photo',
  you: 'Entered by you',
  estimate: 'Generic estimate',
  web: 'Published values found on the web',
  cofid: 'UK composition of foods (CoFID)',
  ciqual: 'French composition table (Ciqual, ANSES)',
  brand: 'Published by the brand',
};

export const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const ts = () => nowUTC().toJSDate();

// The most a value can believably be per 100 g or ml: energy tops out near pure fat, grams at the basis,
// mg and µg far higher.
export function perHundredCap(k, basisMax = 100) {
  const unit = NUTRIENT[k]?.unit;
  return k === 'kcal' ? 950 : k === 'caffeine' ? 6000 : unit === 'g' ? basisMax : unit === 'mg' ? 100000 : 1000000;
}

// Only the nutrient keys we know, as numbers or null. Negative or absurd values are refused.
export function cleanNutrients(input = {}, { basisMax = 100 } = {}) {
  const out = {};
  for (const k of KEYS) {
    const raw = input[k];
    if (raw === null || raw === undefined || raw === '') { out[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new RuleError(`${k} must be a number of zero or more, or left blank.`);
    if (v > perHundredCap(k, basisMax)) throw new RuleError(`${k} of ${v} per 100 is not believable.`);
    out[k] = v;
  }
  return out;
}

const portionList = (list) => (Array.isArray(list) ? list : []).map((p) => ({
  label: clean(p.label, 80),
  ...(n(Number(p.g)) && Number(p.g) > 0 ? { g: Number(p.g) } : {}),
  ...(n(Number(p.ml)) && Number(p.ml) > 0 ? { ml: Number(p.ml) } : {}),
  source: clean(p.source || 'you', 20),
})).filter((p) => p.label && (p.g || p.ml));

const sizeOf = (x) => {
  if (!x || !(Number(x.size) > 0)) return null;
  const out = { size: Number(x.size), unit: x.unit === 'ml' ? 'ml' : 'g' };
  if (Number(x.count) > 1) out.count = Math.round(Number(x.count));
  if (x.label) out.label = clean(x.label, 60);
  return out;
};

// A record whose energy doesn't fit its protein, carbs and fat (EU factors 4/4/9, fibre 2, alcohol 7)
// is probably mistyped at the source. It is shown as it is, with a note to check the label.
export function energyCheck(nut) {
  const v = (k) => (typeof nut?.[k] === 'number' ? nut[k] : null);
  const [kcal, p, c, f] = [v('kcal'), v('protein'), v('carbs'), v('fat')];
  if ([kcal, p, c, f].some((x) => x === null)) return null;
  const est = 4 * p + 4 * c + 9 * f + 2 * (v('fibre') || 0) + 7 * (v('alcohol') || 0);
  if (Math.abs(est - kcal) <= Math.max(15, kcal * 0.25)) return null;
  return `The energy on this record (${Math.round(kcal)} kcal) doesn't match its protein, carbs and fat (about ${Math.round(est)} kcal). Check it against the label.`;
}

const safeGrade = (fn) => {
  try { return fn(); } catch { return null; }
};
const letterOf = (x) => {
  const g = String((typeof x === 'string' ? x : x?.grade) || '').toLowerCase();
  return g.length === 1 && 'abcde'.includes(g) ? g : null;
};

// The Nutri-Score of a record: the source's own grade (Open Food Facts) when it has one, else the 2023
// algorithm on its numbers. A drink held per 100 g is worked out per 100 ml through its density.
function gradeOfRow(r) {
  const given = letterOf(r.nutriscore);
  if (given) return { grade: given, from: 'source' };
  const per = r.basis !== 'ml' && r.liquid && r.density > 0 ? scale(r.nutrients, r.density, 1) : r.nutrients;
  const computed = safeGrade(() => NUT.nutriScore?.(per, { category: r.category, liquid: r.liquid, name: r.name }));
  return computed ? { grade: computed.grade, from: 'computed' } : { grade: null, from: null };
}

// What the tag rules read from a row (public/food-tags.js).
export const tagInput = (r, extra = {}) => ({
  nutrients: r.nutrients, basis: r.basis, liquid: r.liquid, density: r.density, category: r.category, state: r.state, name: r.name, name_mt: r.name_mt,
  brand: r.brand, kind: r.kind, source: r.source, market: r.market, nova: r.nova, portions: r.portions, serving: r.serving, pack: r.pack, facts: r.facts, ...extra,
});

// What the maths and the screens need from a row. `nutriscore` is a lower case letter, a to e, or null;
// `nutriscoreFrom` says whether it came from the source or was worked out here; `tags` is the ordered
// list of { key, label, tone, group, why } ("Protein packed", "Sugar rush", "Contains milk" ...), with
// the diary's habits ("Your regular") when `habits` is given.
export function shapeItem(r, habits = null) {
  if (!r) return null;
  const graded = gradeOfRow(r);
  const nova = Number(r.nova) >= 1 && Number(r.nova) <= 4 ? Number(r.nova) : null;
  const tags = safeGrade(() => foodTags(tagInput(r, { nutriscore: graded.grade, nova, habits }))) || [];
  return {
    nutriscore: graded.grade,
    nutriscoreFrom: graded.from,
    nova,
    tags,
    id: r.id,
    key: r.key,
    kind: r.kind,
    name: r.name,
    name_mt: r.name_mt,
    aliases: r.aliases,
    brand: r.brand,
    barcode: r.barcode,
    market: r.market,
    category: r.category,
    state: r.state,
    basis: r.basis,
    nutrients: r.nutrients,
    portions: r.portions || [],
    edible: r.edible,
    refuse: r.refuse,
    density: r.density,
    pack: r.pack,
    serving: r.serving,
    concentrate: r.concentrate,
    liquid: r.liquid,
    source: r.source,
    sourceText: SOURCE_TEXT[r.source] || r.source,
    source_ref: r.source_ref,
    source_date: r.source_date,
    status: r.status,
    notes: r.notes,
    favourite: r.favourite,
    uses: r.uses,
    facts: r.facts || {},
    last: r.last_unit ? { qty: r.last_qty, unit: r.last_unit } : null,
    units: unitsFor(r),
    // Only crowd-sourced, web and typed-in values are checked; USDA uses food-specific energy factors.
    check: ['off', 'label', 'you', 'web'].includes(r.source) ? energyCheck(r.nutrients) : null,
  };
}

// Size words that a portion can carry ("1 large serving", "small"). They go into the search text, so
// "large fries" finds the records that have a large portion.
const SIZE_WORDS = ['small', 'medium', 'large', 'jumbo', 'mini', 'junior', 'kids'];
const sizesOf = (portions) => {
  const words = new Set(portions.flatMap((p) => norm(p.label).split(' ')));
  return SIZE_WORDS.filter((w) => words.has(w));
};

const gradeLetter = (x) => {
  const g = String(x ?? '').trim().toLowerCase();
  return g.length === 1 && 'abcde'.includes(g) ? g : null;
};
const novaGroup = (x) => {
  const v = Math.round(Number(x));
  return Number.isFinite(v) && v >= 1 && v <= 4 ? v : null;
};

// Everything a catalogue row needs, validated and normalised. Single saves, imports and the seed all go through here.
export function prepareItem(input) {
  const key = clean(input.key, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9:._-]*$/.test(key)) throw new RuleError(`Bad food key "${key}".`);
  const kind = KINDS.includes(input.kind) ? input.kind : 'generic';
  const name = clean(input.name, 160);
  if (!name) throw new RuleError('A food needs a name.');
  const aliases = [...new Set((input.aliases || []).map((a) => clean(a, 160)).filter(Boolean))];
  const nameNorm = norm(name);
  const aliasNorm = [...new Set(aliases.map(norm).concat(input.name_mt ? [norm(input.name_mt)] : []).filter(Boolean))];
  const portions = portionList(input.portions);
  const brandNorm = norm(input.brand);
  const search = [nameNorm, ...aliasNorm, brandNorm, norm(input.barcode), ...sizesOf(portions)].filter(Boolean).join(' ');
  const basis = input.basis === 'ml' ? 'ml' : 'g';
  const nutrients = cleanNutrients(input.nutrients || {});
  const edible = n(Number(input.edible)) && input.edible > 0 && input.edible <= 1 ? Number(input.edible) : null;
  const density = n(Number(input.density)) && input.density > 0.3 && input.density < 3 ? Number(input.density) : null;
  const concentrate = input.concentrate && Number(input.concentrate.water) > 0 ? { water: Number(input.concentrate.water) } : null;
  const row = {
    key, kind, name, name_mt: input.name_mt ? clean(input.name_mt, 160) : null, aliases, name_norm: nameNorm, alias_norm: aliasNorm, search,
    brand: input.brand ? clean(input.brand, 80) : null,
    brand_norm: brandNorm,
    barcode: input.barcode ? String(input.barcode).replace(/\D/g, '').slice(0, 14) || null : null,
    market: input.market ? clean(input.market, 40) : null,
    category: input.category ? clean(input.category, 60) : null,
    state: input.state ? clean(input.state, 30) : null,
    basis, nutrients, portions, edible, refuse: input.refuse ? clean(input.refuse, 80) : null, density,
    pack: sizeOf(input.pack), serving: sizeOf(input.serving), concentrate,
    liquid: Boolean(input.liquid) || basis === 'ml',
    source: clean(input.source || 'you', 20),
    source_ref: input.source_ref ? clean(input.source_ref, 200) : null,
    source_date: input.source_date ? clean(input.source_date, 30) : null,
    status: clean(input.status || 'ok', 30),
    notes: clean(input.notes, 600),
    req: (input.req || []).map((x) => clean(x, 120)),
    nutriscore: gradeLetter(input.nutriscore),
    nova: novaGroup(input.nova),
    facts: cleanFacts(input.facts),
  };
  // The tags as stored for browsing: the shared rules on the record as saved, without the diary's habits.
  row.tags = safeGrade(() => tagKeys(tagInput(row, { nutriscore: gradeOfRow(row).grade }))) || [];
  row.tags_v = TAGS_VERSION;
  return row;
}

// Inserts or updates one record by its key. Seeds and imports call this; Daniel's favourites, use
// counts and hidden flags are never touched by an update.
export async function upsertItem(input, tx = db()) {
  const row = prepareItem(input);
  const [saved] = await tx`
    insert into food_items (key, kind, name, name_mt, aliases, name_norm, alias_norm, search, brand, brand_norm, barcode, market, category, state,
      basis, nutrients, portions, edible, refuse, density, pack, serving, concentrate, liquid, source, source_ref, source_date, status, notes, req,
      nutriscore, nova, facts, facts_at, tags, tags_v)
    values (${row.key}, ${row.kind}, ${row.name}, ${row.name_mt}, ${row.aliases}::text[], ${row.name_norm}, ${row.alias_norm}::text[], ${row.search},
      ${row.brand}, ${row.brand_norm}, ${row.barcode}, ${row.market}, ${row.category}, ${row.state}, ${row.basis}, ${tx.json(row.nutrients)}, ${tx.json(row.portions)},
      ${row.edible}, ${row.refuse}, ${row.density}, ${row.pack ? tx.json(row.pack) : null}, ${row.serving ? tx.json(row.serving) : null},
      ${row.concentrate ? tx.json(row.concentrate) : null}, ${row.liquid}, ${row.source}, ${row.source_ref}, ${row.source_date}, ${row.status},
      ${row.notes}, ${row.req}::text[], ${row.nutriscore}, ${row.nova}, ${tx.json(row.facts)}, ${Object.keys(row.facts).length ? new Date() : null},
      ${row.tags}::text[], ${row.tags_v})
    on conflict (key) do update set kind = excluded.kind, name = excluded.name, name_mt = excluded.name_mt, aliases = excluded.aliases,
      name_norm = excluded.name_norm, alias_norm = excluded.alias_norm, search = excluded.search, brand = excluded.brand, brand_norm = excluded.brand_norm,
      barcode = excluded.barcode, market = excluded.market, category = excluded.category, state = excluded.state, basis = excluded.basis, nutrients = excluded.nutrients,
      portions = excluded.portions, edible = excluded.edible, refuse = excluded.refuse, density = excluded.density, pack = excluded.pack,
      serving = excluded.serving, concentrate = excluded.concentrate, liquid = excluded.liquid, source = excluded.source,
      source_ref = excluded.source_ref, source_date = excluded.source_date, status = excluded.status, notes = excluded.notes, req = excluded.req,
      nutriscore = excluded.nutriscore, nova = excluded.nova, facts = excluded.facts, facts_at = coalesce(excluded.facts_at, food_items.facts_at),
      tags = excluded.tags, tags_v = excluded.tags_v, updated_at = now()
    returning *`;
  return saved;
}

const BULK_COLUMNS = ['key', 'kind', 'name', 'name_mt', 'aliases', 'name_norm', 'alias_norm', 'search', 'brand', 'brand_norm', 'barcode', 'market', 'category', 'state',
  'basis', 'nutrients', 'portions', 'edible', 'refuse', 'density', 'pack', 'serving', 'concentrate', 'liquid', 'source', 'source_ref', 'source_date', 'status', 'notes', 'req',
  'nutriscore', 'nova', 'facts', 'tags', 'tags_v'];

// The same upsert for thousands of records, in multi-row statements of about `batch` rows. A record that
// fails validation is skipped and reported, never fatal; a repeated key keeps its last record. Favourites,
// use counts, last-used and hidden flags are not in the column list, so they are never touched. Rows
// whose values did not change are still written, which keeps ids stable and the counts the same.
export async function upsertItems(inputs, tx = db(), { batch = 500 } = {}) {
  const byKey = new Map();
  const rejected = [];
  for (const input of inputs) {
    try {
      const row = prepareItem(input);
      byKey.set(row.key, row);
    } catch (e) {
      rejected.push({ key: input?.key ?? null, error: e.message });
    }
  }
  const rows = [...byKey.values()];
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    await tx`
      insert into food_items ${tx(chunk, ...BULK_COLUMNS)}
      on conflict (key) do update set kind = excluded.kind, name = excluded.name, name_mt = excluded.name_mt, aliases = excluded.aliases,
        name_norm = excluded.name_norm, alias_norm = excluded.alias_norm, search = excluded.search, brand = excluded.brand, brand_norm = excluded.brand_norm,
        barcode = excluded.barcode, market = excluded.market, category = excluded.category, state = excluded.state, basis = excluded.basis, nutrients = excluded.nutrients,
        portions = excluded.portions, edible = excluded.edible, refuse = excluded.refuse, density = excluded.density, pack = excluded.pack,
        serving = excluded.serving, concentrate = excluded.concentrate, liquid = excluded.liquid, source = excluded.source,
        source_ref = excluded.source_ref, source_date = excluded.source_date, status = excluded.status, notes = excluded.notes, req = excluded.req,
        nutriscore = excluded.nutriscore, nova = excluded.nova, facts = excluded.facts, tags = excluded.tags, tags_v = excluded.tags_v, updated_at = now()`;
  }
  return { saved: rows.length, rejected };
}

export async function itemByKey(key) {
  const [r] = await db()`select * from food_items where key = ${String(key || '')}`;
  return r || null;
}

async function itemByRef({ key, id }) {
  if (key) return itemByKey(key);
  if (id) return (await db()`select * from food_items where id = ${Number(id)}`)[0] || null;
  return null;
}

export async function getFood(ref) {
  const r = await itemByRef(ref);
  if (!r) throw new RuleError('That food is not in the catalogue.', 404);
  return shapeItem(r, (await habitStats()).get(r.key) || null);
}

// ---------- Habits ----------

// What the diary says about each food he has logged, for the "Your habits" tags: how many days of the
// last 30 it was logged on, how its logs of the last 90 days split by meal, hour and weekday, when it was
// first and last logged, and where it ranks for protein, energy and sugar over the last 30 days.
// Late is 21:00 to 04:00, early 04:00 to 08:00, both in his time zone. Map of catalogue key to habits.
export async function habitStats() {
  const { today, tz } = await localNow();
  const d30 = addDays(today, -30, tz);
  const d90 = addDays(today, -90, tz);
  const rows = await db()`
    select l.ref_key as key, min(l.date) as first, max(l.date) as last, count(*)::int as total,
      count(distinct l.date) filter (where l.date > ${d30})::int as days30,
      count(*) filter (where l.date > ${d90})::int as logs90,
      count(*) filter (where l.date > ${d90} and l.slot = 'breakfast')::int as breakfast,
      count(*) filter (where l.date > ${d90} and l.slot = 'lunch')::int as lunch,
      count(*) filter (where l.date > ${d90} and l.slot = 'dinner')::int as dinner,
      count(*) filter (where l.date > ${d90} and l.slot = 'snacks')::int as snacks,
      count(*) filter (where l.date > ${d90} and l.slot = 'drinks')::int as drinks,
      count(*) filter (where l.date > ${d90} and (extract(hour from l.at at time zone ${tz}) >= 21 or extract(hour from l.at at time zone ${tz}) < 4))::int as late,
      count(*) filter (where l.date > ${d90} and extract(hour from l.at at time zone ${tz}) >= 4 and extract(hour from l.at at time zone ${tz}) < 8)::int as early,
      count(*) filter (where l.date > ${d90} and extract(isodow from l.date::date) in (6, 7))::int as weekend,
      sum((l.nutrients->>'protein')::float) filter (where l.date > ${d30}) as protein30,
      sum((l.nutrients->>'kcal')::float) filter (where l.date > ${d30}) as kcal30,
      sum((l.nutrients->>'sugars')::float) filter (where l.date > ${d30}) as sugars30
    from food_log l
    where l.kind = 'item' and l.ref_key is not null and l.deleted_at is null and l.date <= ${today}
    group by l.ref_key`;
  const favourites = await db()`select key from food_items where favourite`;
  const ago = (date) => Math.round(DateTime.fromISO(today).diff(DateTime.fromISO(date), 'days').days);
  const rank = (field) => {
    const order = rows.filter((r) => r[field] > 0).sort((a, b) => b[field] - a[field]);
    return new Map(order.map((r, i) => [r.key, i + 1]));
  };
  const ranks = { protein: rank('protein30'), kcal: rank('kcal30'), sugars: rank('sugars30') };
  const out = new Map();
  for (const r of rows) {
    out.set(r.key, {
      days30: r.days30, logs90: r.logs90, total: r.total, late: r.late, early: r.early, weekend: r.weekend,
      slots: { breakfast: r.breakfast, lunch: r.lunch, dinner: r.dinner, snacks: r.snacks, drinks: r.drinks },
      firstDays: ago(r.first), lastDays: ago(r.last),
      top: { protein: ranks.protein.get(r.key) || null, kcal: ranks.kcal.get(r.key) || null, sugars: ranks.sugars.get(r.key) || null },
    });
  }
  for (const f of favourites) out.set(f.key, { ...(out.get(f.key) || {}), favourite: true });
  return out;
}

// Words that carry no meaning in "large fries from Burger King", and the size words that point at a
// portion rather than a food: sizes are not required in a record's text, they rank it higher and name
// the portion to pick ("1 large serving").
const FILLER = new Set(['from', 'at', 'the', 'a', 'an', 'of', 'my', 'some', 'for', 'please']);
const SIZE_QUERY = new Set(['small', 'medium', 'large']);

// Local ranking: exact name (or brand and name), an exact alias, name starts with the words, an alias
// starts with them, then anything containing every word. Plain foods before products, then what Daniel
// uses most, then the hand-picked records before the bulk USDA ones, then shorter names. Aliases only lead
// to a record; they never merge two foods. A size word in the query ("large", "small") ranks the records
// that have such a portion first and adds `portionHint: { unit, label }` to them.
export async function searchFoods(q, { limit = 30, kind = null, liquid = null } = {}) {
  const asked = norm(q).split(' ').filter(Boolean).slice(0, 8);
  if (!asked.length) return [];
  let words = asked.filter((w) => !FILLER.has(w));
  if (!words.length) words = asked;
  const sizes = words.filter((w) => SIZE_QUERY.has(w));
  const core = words.filter((w) => !SIZE_QUERY.has(w)).slice(0, 6);
  if (!core.length) core.push(...words.slice(0, 6));
  const query = core.join(' ');
  const sql = db();
  // One or two letters typed so far ("b"): names that start with them, not every record that contains them.
  const typing = core.every((w) => w.length < 2);
  const all = typing ? sql`and name_norm like ${`${core[0]}%`}` : core.reduce((acc, w) => sql`${acc} and search like ${`%${w}%`}`, sql``);
  const sized = sizes.length ? sizes.reduce((acc, w) => sql`${acc} and search like ${`%${w}%`}`, sql`true`) : sql`false`;
  const max = Math.min(Number(limit) || 30, 80);
  // The bulk records (the rest of USDA, keys fdc-<id>, and the UK and French tables, cofid-... and ciqual-...)
  // rank four places lower than a hand-picked or imported record, so an
  // exact name in the bulk file (the survey's "Grapes") ties with a hand-picked record that has the name
  // inside it ("Red grapes") and loses the tie, while a bulk exact name still beats a hand-picked record
  // that only has the words somewhere ("Milk chocolate" for "cola").
  const rows = await sql`
    select f.* from (
      select id, row_number() over (order by
        (case
          when name_norm = ${query} then 0
          when brand_norm <> '' and brand_norm || ' ' || name_norm = ${query} then 0
          when ${query} = any(alias_norm) then 1
          when name_norm like ${`${query} %`} then 2
          when brand_norm <> '' and brand_norm || ' ' || name_norm like ${`${query} %`} then 2
          when exists (select 1 from unnest(alias_norm) a where a like ${`${query}%`}) then 3
          when name_norm like ${`%${query}%`} then 4
          when brand_norm <> '' and brand_norm || ' ' || name_norm like ${`%${query}%`} then 4
          when name_norm like ${`${core[0]} %`} then 5
          else 6 end) + (case when key like 'fdc-%' or key like 'cofid-%' or key like 'ciqual-%' then 4 else 0 end),
        ${sized} desc, (kind = 'generic') desc, (market = 'Malta') desc, uses desc, (key like 'fdc-%' or key like 'cofid-%' or key like 'ciqual-%'), length(name), name) as ord
      from food_items
      where hidden = false ${all}
        ${kind ? sql`and kind = ${kind}` : sql``}
        ${liquid === null ? sql`` : sql`and liquid = ${liquid}`}
      order by ord
      limit ${max}) h
    join food_items f on f.id = h.id
    order by h.ord`;
  // A bulk record that says the same as a hand-picked one in the list (the survey's "Banana", raw, next to
  // the curated banana) is left out, so two rows nothing tells apart never show. Everything else stays.
  const bulk = (r) => /^(fdc|cofid|ciqual)-/.test(r.key) || ['cofid', 'ciqual'].includes(r.source);
  const twin = (r) => `${r.name_norm}|${norm(r.state || '')}|${r.brand_norm || ''}`;
  const curated = new Set(rows.filter((r) => !bulk(r)).map(twin));
  return rows.filter((r) => !bulk(r) || !curated.has(twin(r))).map((r) => {
    const item = shapeItem(r);
    if (!sizes.length) return item;
    const hit = (r.portions || []).find((p) => norm(p.label).split(' ').includes(sizes[0]));
    return hit ? { ...item, portionHint: { unit: `p:${hit.label}`, label: hit.label } } : item;
  });
}

export async function recentFoods({ liquid = null, limit = 16 } = {}) {
  const sql = db();
  const rows = await sql`select * from food_items where hidden = false and (uses > 0 or favourite)
    ${liquid === null ? sql`` : sql`and liquid = ${liquid}`}
    order by favourite desc, last_used desc nulls last limit ${limit}`;
  return rows.map(shapeItem);
}

// Daniel's own food, typed in or read from a label he confirmed.
export async function saveCustomFood(input, { fromLabel = false } = {}) {
  const name = clean(input.name, 160);
  if (!name) throw new RuleError('Give the food a name.');
  const nutrients = cleanNutrients(input.nutrients || {});
  if (nutrients.kcal === null) throw new RuleError('Energy (kcal per 100) is needed for a food of your own.');
  const key = input.key && String(input.key).startsWith('my:') ? input.key
    : `my:${norm(input.brand ? `${input.brand} ${name}` : name).replace(/ /g, '-').slice(0, 60)}-${crypto.randomBytes(3).toString('hex')}`;
  const row = await upsertItem({
    ...input,
    key,
    name,
    kind: fromLabel ? 'label' : 'custom',
    nutrients,
    source: fromLabel ? 'label' : 'you',
    source_date: new Date().toISOString().slice(0, 10),
    notes: fromLabel ? clean(`Read from a photo of the label and checked by you. ${input.notes || ''}`, 600) : clean(input.notes, 600),
  });
  await logEvent('food_item_saved', { key: row.key, kind: row.kind });
  return shapeItem(row);
}

export async function setFavourite(key, on) {
  const [r] = await db()`update food_items set favourite = ${Boolean(on)} where key = ${key} returning *`;
  if (!r) throw new RuleError('That food is not in the catalogue.', 404);
  return shapeItem(r);
}

// ---------- Diary ----------

const idOk = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
export const newId = () => crypto.randomUUID();

function slotFor(local, liquid) {
  if (liquid) return 'drinks';
  const h = local.hour;
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 18 && h < 23) return 'dinner';
  return 'snacks';
}

// When and where an entry goes. A date in the future is a plan, not a log.
export async function placeEntry(input, liquid) {
  const { local, today, tz } = await localNow();
  const date = input.date ? String(input.date) : today;
  if (!validDate(date)) throw new RuleError('Bad date.');
  if (date > addDays(today, 1, tz)) throw new RuleError('That date is in the future. Plan it instead of logging it.');
  let at = local;
  if (input.time) {
    if (!validTime(input.time)) throw new RuleError('Time must be HH:MM.');
    const [h, m] = input.time.split(':').map(Number);
    at = local.set({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)), hour: h, minute: m, second: 0 });
  } else if (date !== today) at = local.set({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)), hour: 12, minute: 0 });
  const slot = SLOTS.includes(input.slot) ? input.slot : slotFor(at, liquid);
  return { date, at: at.toUTC().toJSDate(), slot };
}

export const shapeEntry = (r) => ({
  id: r.id,
  date: r.date,
  at: r.at,
  slot: r.slot,
  kind: r.kind,
  refKey: r.ref_key,
  refId: r.ref_id,
  name: r.name,
  brand: r.brand,
  qty: r.qty,
  unit: r.unit,
  // Entries logged before portion names lost their US size notes are shown without them too.
  amountText: portionName(r.amount_text),
  grams: r.grams,
  ml: r.ml,
  share: r.share,
  liquid: r.liquid,
  nutrients: r.nutrients,
  lines: r.lines,
  estimate: r.estimate,
  // Nutrients the record had no value for, filled from an estimate: the screen marks them as estimated.
  filled: r.filled || [],
  // Where the filled values came from: { usda: { key, name, keys }, web: { key, name, url, keys },
  // estimate: { keys }, weight: { amount, unit, from } }, or null when nothing was filled.
  fillSource: r.fill_source || null,
  source: r.source,
  note: r.note,
  planId: r.plan_id,
});

// Writes one entry once. The id comes from the phone, so an offline entry replayed later lands once.
export async function insertEntry(e, tx = db()) {
  const filled = (Array.isArray(e.filled) ? e.filled : []).filter((k) => KEYS.includes(k));
  // A repeated day copies its entries' fills and provenance with them.
  const rows = await tx`
    insert into food_log (id, date, at, slot, kind, ref_id, ref_key, name, brand, qty, unit, amount_text, grams, ml, share, liquid,
      nutrients, lines, estimate, source, note, plan_id, filled, fill_source, fill_profile, enriched_at)
    values (${e.id}, ${e.date}, ${e.at}, ${e.slot}, ${e.kind}, ${e.ref_id ?? null}, ${e.ref_key ?? null}, ${e.name}, ${e.brand ?? null},
      ${e.qty ?? null}, ${e.unit ?? null}, ${e.amount_text || ''}, ${e.grams ?? null}, ${e.ml ?? null}, ${e.share ?? null}, ${Boolean(e.liquid)},
      ${tx.json(e.nutrients)}, ${e.lines ? tx.json(e.lines) : null}, ${Boolean(e.estimate)}, ${e.source || 'you'}, ${clean(e.note, 300)},
      ${e.plan_id ?? null}, ${filled}::text[], ${e.fill_source ? tx.json(e.fill_source) : null}, ${e.fill_profile ? tx.json(e.fill_profile) : null},
      ${e.enriched_at ?? null})
    on conflict (id) do nothing returning *`;
  if (rows.length) return { entry: shapeEntry(rows[0]), duplicate: false };
  const [existing] = await tx`select * from food_log where id = ${e.id}`;
  return { entry: shapeEntry(existing), duplicate: true };
}

export async function existingEntry(id) {
  if (!id) return null;
  if (!idOk(id)) throw new RuleError('Bad entry id.');
  const [r] = await db()`select * from food_log where id = ${id}`;
  return r ? { entry: shapeEntry(r), duplicate: true } : null;
}

// ---------- Fills: an estimate for what a record does not say ----------

// The nutrients an estimate fills when the entry is logged: the label's core values plus saturates,
// caffeine and alcohol. The rest wait for the filler (food-enrich.js), which tries a USDA reference and
// the web before an estimate.
export const FILL_KEYS = [...KEYS.filter((k) => NUTRIENT[k].core), 'satfat', 'caffeine', 'alcohol'];
// Every value an estimate can carry: the core ones first (the order `filled` lists them in), then the
// fats, minerals and vitamins.
export const ESTIMATE_KEYS = [...FILL_KEYS, ...KEYS.filter((k) => !FILL_KEYS.includes(k))];
// The units of the values past the core ones, for prompts that ask for an estimate of all of them.
export const MICRO_TEXT = 'addsugars, mufa (monounsaturated), pufa (polyunsaturated) and transfat in g; chol (cholesterol) in mg; '
  + 'potassium, calcium, iron, magnesium, zinc and phosphorus in mg; selenium in µg; vita (vitamin A as retinol activity equivalents), '
  + 'vitd and vitk in µg; vitc, vite, b1 (thiamin), b2 (riboflavin), b3 (niacin) and b6 in mg; folate and b12 in µg';

// An estimated profile per 100 g or ml: { basis, kcal, protein, ... }. The core values are always
// there (null when unknown); the others only when given. Values that are missing, negative or not
// believable are dropped (they stay unknown), never guessed further.
export function cleanFill(input, basis = 'g') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = { basis: ['g', 'ml'].includes(input.basis) ? input.basis : basis === 'ml' ? 'ml' : 'g' };
  let any = false;
  for (const k of ESTIMATE_KEYS) {
    const raw = input[k];
    const v = Number(raw);
    const ok = raw !== null && raw !== undefined && raw !== '' && typeof raw !== 'boolean' && Number.isFinite(v) && v >= 0 && v <= perHundredCap(k);
    if (ok) out[k] = v;
    else if (FILL_KEYS.includes(k)) out[k] = null;
    any = any || ok;
  }
  // Part of a value is never more than the whole.
  const part = (k, whole) => {
    if (n(out[k]) !== null && n(out[whole]) !== null) out[k] = Math.min(out[k], out[whole]);
  };
  part('sugars', 'carbs');
  for (const k of ['satfat', 'mufa', 'pufa', 'transfat']) part(k, 'fat');
  part('addsugars', 'sugars');
  return any ? out : null;
}

// A value that is part of another: filled in proportion to the entry's own whole where it has one.
const PART_OF = { sugars: 'carbs', satfat: 'fat', mufa: 'fat', pufa: 'fat', transfat: 'fat', addsugars: 'sugars' };

// Fills each nutrient that is unknown (null) from the estimate, scaled to `amount` g or ml of the
// fill's basis. Parts follow the entry's own wholes where it has them (sugars its carbs, saturates its
// fat), so a fill never claims more sugar than the record's carbs. `keys` limits which values may be
// filled. Returns { nutrients, filled: [keys] }.
export function fillGaps(nutrients, amount, fill, keys = ESTIMATE_KEYS) {
  const out = { ...nutrients };
  const filled = [];
  if (!fill || !(Number(amount) > 0)) return { nutrients: out, filled };
  for (const k of keys) {
    if (n(out[k]) !== null || n(fill[k]) === null) continue;
    let v = (fill[k] * amount) / 100;
    const parent = PART_OF[k];
    if (parent && n(out[parent]) !== null) {
      if (n(fill[parent]) > 0) v = (out[parent] * fill[k]) / fill[parent];
      v = Math.min(v, out[parent]);
    }
    out[k] = round(v, 6);
    filled.push(k);
  }
  return { nutrients: out, filled };
}

// The estimate kept with an entry for the filler: the cleaned profile per 100 and the search words the
// reading or the coach gave, so a reference can be found without asking again.
function keptProfile(fill, input) {
  if (!fill) return null;
  const searches = (Array.isArray(input.searches) ? input.searches : []).map((s) => clean(s, 80)).filter(Boolean).slice(0, 4);
  return { ...fill, ...(searches.length ? { searches } : {}) };
}

// Called with every new item or quick-add entry, so the filler can fill its gaps in the background.
// Set by food-enrich.js when the loop starts; nothing happens before that (tests, scripts).
let afterLog = null;
export function setAfterLog(fn) {
  afterLog = typeof fn === 'function' ? fn : null;
}
export function logged(out) {
  if (!out.duplicate && afterLog) {
    try {
      afterLog(out.entry);
    } catch (err) {
      console.error('food fill could not start', err.message);
    }
  }
  return out;
}

// Logs an amount of one catalogue record: { id, key, qty, unit, date, time, slot, estimate, note, fill,
// searches }. `fill` is an estimated profile per 100 (from the photo or text reading, or the coach):
// every core nutrient the record has no value for is taken from it, scaled to the amount, and listed in
// `filled`. The whole profile is kept with the entry for the filler, which tries a USDA reference and
// the web for the rest before falling back to it.
export async function logFood(input, source = 'you') {
  const again = await existingEntry(input.id);
  if (again) return again;
  const r = await itemByRef({ key: input.key, id: input.item_id });
  if (!r) throw new RuleError('That food is not in the catalogue.', 404);
  const item = shapeItem(r);
  const unit = input.unit || (item.last?.unit && item.units.some((u) => u.unit === item.last.unit) ? item.last.unit : item.basis);
  const l = line(item, input.qty, unit);
  if (l.error) throw new RuleError(l.error);
  const fill = cleanFill(input.fill, item.basis);
  const { nutrients, filled } = fillGaps(l.nutrients, fill?.basis === 'ml' ? (l.ml ?? l.g) : (l.g ?? l.ml), fill, FILL_KEYS);
  const place = await placeEntry(input, item.liquid);
  const out = await insertEntry({
    id: input.id || newId(),
    ...place,
    kind: 'item',
    ref_id: item.id,
    ref_key: item.key,
    name: item.name,
    brand: item.brand,
    qty: Number(input.qty),
    unit,
    amount_text: l.note ? `${l.text} (${l.note})` : l.text,
    grams: l.g,
    ml: l.ml,
    liquid: item.liquid,
    nutrients,
    filled,
    fill_source: filled.length ? { estimate: { keys: filled } } : null,
    fill_profile: keptProfile(fill, input),
    estimate: Boolean(input.estimate),
    source,
    note: input.note,
    plan_id: input.plan_id,
  });
  if (!out.duplicate) {
    await db()`update food_items set uses = uses + 1, last_used = now(), last_qty = ${Number(input.qty)}, last_unit = ${unit} where id = ${item.id}`;
  }
  return logged(out);
}

// Calories and whatever macros are known, kept in the diary only and never added to the catalogue.
// `estimate` marks numbers that are a rough guess (a typed meal with no catalogue match); `amount`
// is a short note of how much, such as "about 300 g". With `fill` (an estimated profile per 100) and
// `grams` or `ml` (how much was eaten), every core value not given is worked out from the estimate and
// listed in `filled`; the calories can come from it too. The rest is left to the filler, as in logFood.
// `brand` names the brand or restaurant, when there is one.
export async function quickAdd(input, source = 'you') {
  const again = await existingEntry(input.id);
  if (again) return again;
  const given = (k) => !(input[k] === undefined || input[k] === null || input[k] === '');
  const ml = Number(input.ml) > 0 && Number(input.ml) <= 10000 ? Number(input.ml) : null;
  const grams = Number(input.grams) > 0 && Number(input.grams) <= 10000 ? Number(input.grams) : null;
  const fill = cleanFill(input.fill, ml && !grams ? 'ml' : 'g');
  const nutrients = unknown();
  if (given('kcal')) {
    const kcal = Number(input.kcal);
    if (!(kcal >= 0) || kcal > 10000) throw new RuleError('Give the calories.');
    nutrients.kcal = kcal;
  }
  for (const k of ['protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine', 'alcohol']) {
    if (!given(k)) continue;
    const v = Number(input[k]);
    if (!(v >= 0) || v > 2000) throw new RuleError(`${k} must be zero or more.`);
    nutrients[k] = v;
  }
  const { nutrients: full, filled } = fillGaps(nutrients, fill?.basis === 'ml' ? (ml ?? grams) : (grams ?? ml), fill, FILL_KEYS);
  if (full.kcal === null || !(full.kcal <= 10000)) throw new RuleError('Give the calories.');
  const place = await placeEntry(input, Boolean(ml));
  return logged(await insertEntry({
    id: input.id || newId(),
    ...place,
    kind: 'quick',
    name: clean(input.name, 120) || 'Quick add',
    brand: clean(input.brand, 80) || null,
    amount_text: clean(input.amount, 60) || (ml ? `${ml} ml` : grams ? `${grams} g` : ''),
    grams,
    ml,
    liquid: Boolean(ml),
    nutrients: full,
    filled,
    fill_source: filled.length ? { estimate: { keys: filled } } : null,
    fill_profile: keptProfile(fill, input),
    estimate: Boolean(input.estimate),
    source,
    note: input.note,
  }));
}

export async function deleteEntry(id) {
  if (!idOk(id)) throw new RuleError('Bad entry id.');
  const [r] = await db()`update food_log set deleted_at = coalesce(deleted_at, now()) where id = ${id} returning *`;
  if (!r) return { ok: true, missing: true };
  await db()`update food_plans set logged_id = null where logged_id = ${id}`;
  return { ok: true, entry: shapeEntry(r) };
}

export async function restoreEntry(id) {
  if (!idOk(id)) throw new RuleError('Bad entry id.');
  const [r] = await db()`update food_log set deleted_at = null where id = ${id} returning *`;
  if (!r) throw new RuleError('That entry is gone.', 404);
  return { ok: true, entry: shapeEntry(r) };
}

// Changes the amount, slot or time of an item entry; the nutrients are worked out again from the record.
export async function editEntry(id, input) {
  if (!idOk(id)) throw new RuleError('Bad entry id.');
  const [e] = await db()`select * from food_log where id = ${id} and deleted_at is null`;
  if (!e) throw new RuleError('That entry is gone.', 404);
  const patch = {};
  if (input.slot !== undefined) {
    if (!SLOTS.includes(input.slot)) throw new RuleError('Unknown meal.');
    patch.slot = input.slot;
  }
  // Only a new amount is worked out again: moving an entry to another meal keeps its numbers and its "~".
  const qtyNew = input.qty !== undefined && input.qty !== null && Number(input.qty) !== Number(e.qty);
  const unitNew = input.unit !== undefined && input.unit !== null && input.unit !== e.unit;
  if (qtyNew || unitNew) {
    const qty = input.qty ?? e.qty;
    const unit = input.unit ?? e.unit;
    if (e.kind === 'item') {
      const r = await itemByRef({ key: e.ref_key });
      if (!r) throw new RuleError('The food behind this entry is gone, so its amount cannot change.');
      const l = line(shapeItem(r), qty, unit);
      if (l.error) throw new RuleError(l.error);
      // Values that were estimated because the record has none keep their estimate, scaled to the new amount.
      const before = e.grams ?? e.ml;
      const after = l.g ?? l.ml;
      if (before > 0 && after > 0) {
        for (const k of e.filled || []) {
          if (l.nutrients[k] === null && typeof e.nutrients?.[k] === 'number') l.nutrients[k] = e.nutrients[k] * (after / before);
        }
      }
      Object.assign(patch, { qty: Number(qty), unit, amount_text: l.note ? `${l.text} (${l.note})` : l.text, grams: l.g, ml: l.ml, nutrients: l.nutrients, estimate: false });
    } else if (e.kind === 'batch') {
      const [b] = await db()`select * from food_batches where id = ${e.ref_id}`;
      const p = batchPortion(shapeBatch(b), qty, unit);
      if (p.error) throw new RuleError(p.error);
      Object.assign(patch, { qty: Number(qty), unit, amount_text: batchAmountText(qty, unit), grams: p.g, share: p.share, nutrients: p.nutrients });
    } else if (['recipe', 'meal'].includes(e.kind) && e.qty) {
      const f = Number(qty) / e.qty;
      if (!(f > 0)) throw new RuleError('The amount must be more than zero.');
      Object.assign(patch, { qty: Number(qty), nutrients: scale(e.nutrients, f, 1), grams: e.grams ? e.grams * f : null, ml: e.ml ? e.ml * f : null,
        amount_text: e.kind === 'recipe' ? amountText(qty, unit) : `${round(qty, 2)} × saved meal` });
    } else throw new RuleError('This entry cannot be resized. Delete it and log it again.');
  }
  if (input.time !== undefined) {
    if (!validTime(input.time)) throw new RuleError('Time must be HH:MM.');
    const { tz } = await localNow();
    const { DateTime } = await import('luxon');
    patch.at = DateTime.fromISO(`${e.date}T${input.time}`, { zone: tz }).toUTC().toJSDate();
  }
  if (!Object.keys(patch).length) return { entry: shapeEntry(e) };
  const sql = db();
  const [r] = await sql`update food_log set ${sql(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, k === 'nutrients' ? sql.json(v) : v])))} where id = ${id} returning *`;
  return { entry: shapeEntry(r) };
}

// Copies a day's entries (or one meal of it) to another day, as new entries at the same times of day.
// With an `id` from the phone (an offline copy is replayed later), each copy's id is worked out from it
// and the entry copied, so the same copy sent twice lands once.
export async function repeatDay({ from, to, slot = null, id = null }) {
  const { today, tz } = await localNow();
  const target = to || today;
  if (!validDate(from) || !validDate(target)) throw new RuleError('Bad date.');
  if (id && !idOk(id)) throw new RuleError('Bad entry id.');
  const sql = db();
  const rows = await sql`select * from food_log where date = ${from} and deleted_at is null ${slot ? sql`and slot = ${slot}` : sql``} order by at`;
  if (!rows.length) throw new RuleError('Nothing was logged then.');
  const copyId = (r) => (id ? crypto.createHash('sha256').update(`${id}:${r.id}`).digest('base64url').slice(0, 32) : newId());
  // A copy into the same day must not copy its own copies when it is sent again.
  const mine = id ? new Set(rows.map(copyId)) : new Set();
  const out = [];
  let duplicate = false;
  for (const r of rows) {
    if (mine.has(r.id)) continue;
    const at = DateTime.fromISO(`${target}T${DateTime.fromJSDate(r.at, { zone: tz }).toFormat('HH:mm:ss')}`, { zone: tz }).toUTC().toJSDate();
    const res = await insertEntry({ ...r, id: copyId(r), date: target, at, source: 'repeat', plan_id: null });
    duplicate = duplicate || res.duplicate;
    out.push(res.entry);
  }
  return { entries: out, ...(duplicate ? { duplicate: true } : {}) };
}

// ---------- Grades: Nutri-Score, NOVA and tags for what was eaten ----------

const GRADES = ['a', 'b', 'c', 'd', 'e'];
const gradeOf = (x) => {
  const g = String((typeof x === 'string' ? x : x?.grade) || '').toLowerCase();
  return GRADES.includes(g) ? g : null;
};
const safely = (fn) => {
  try { return fn(); } catch { return null; }
};

// Per 100 g (or ml) of what was eaten, from an entry's frozen nutrients and its weight. A quick add
// has no weight, so it has no per-100 values and no grade.
function per100(e) {
  const amount = e.grams > 0 ? e.grams : e.ml > 0 ? e.ml : null;
  return amount ? scale(e.nutrients, 100, amount) : null;
}

// Adds grade, nova and tags to diary entries. A catalogue food is graded as the food it is (the
// source's own Nutri-Score first, then the shared maths on its per-100 values); a recipe, meal or
// batch is graded on what was eaten, per 100 g. Anything without a weight stays ungraded.
export async function gradeEntries(entries) {
  const keys = [...new Set(entries.filter((e) => e.kind === 'item' && e.refKey).map((e) => e.refKey))];
  // The tagger needs the same fields shapeItem gives it: state for whole foods, density, portions,
  // serving and pack for the per-100 ml and drinks-portion rules.
  const items = keys.length ? await db()`select key, kind, name, name_mt, brand, market, category, state, basis, liquid, density, portions, serving, pack,
    nutrients, nutriscore, nova, source, facts from food_items where key = any(${keys})` : [];
  const habits = keys.length ? await habitStats() : new Map();
  const byKey = new Map(items.map((i) => [i.key, i]));
  return entries.map((e) => {
    const it = e.kind === 'item' ? byKey.get(e.refKey) : null;
    let base = null;
    if (it) base = { ...it };
    else {
      const p = per100(e);
      if (p) base = { name: e.name, kind: e.kind, nutrients: p, liquid: Boolean(e.liquid), basis: !e.grams && e.ml ? 'ml' : 'g', category: null, nova: null };
    }
    let grade = gradeOf(it?.nutriscore);
    if (!grade && base) grade = gradeOf(safely(() => NUT.nutriScore?.(base.nutrients, { category: base.category, liquid: base.liquid })));
    const tags = base ? safely(() => foodTags({ ...base, nutriscore: grade, habits: it ? habits.get(it.key) || null : null })) : null;
    return { ...e, grade, nova: it?.nova ?? null, tags: Array.isArray(tags) ? tags : [] };
  });
}

// Energy by grade: { a, b, c, d, e, none } in kcal. Entries with no known energy add nothing.
export function gradeMix(entries) {
  const out = { a: 0, b: 0, c: 0, d: 0, e: 0, none: 0 };
  for (const e of entries) {
    const k = n(e.nutrients?.kcal);
    if (k) out[e.grade || 'none'] = round(out[e.grade || 'none'] + k, 1);
  }
  return out;
}

export async function foodDay(date) {
  const { today } = await localNow();
  const d = date || today;
  if (!validDate(d)) throw new RuleError('Bad date.');
  const rows = await db()`select * from food_log where date = ${d} and deleted_at is null order by at, created_at`;
  const entries = await gradeEntries(rows.map(shapeEntry));
  const slots = SLOTS.map((s) => {
    const list = entries.filter((e) => e.slot === s);
    return { slot: s, entries: list, total: total(list.map((e) => e.nutrients)) };
  });
  const plans = await listPlans(d, d);
  return {
    date: d,
    today: d === today,
    entries,
    slots,
    total: total(entries.map((e) => e.nutrients)),
    drinksMl: round(entries.filter((e) => e.liquid && e.ml).reduce((a, e) => a + e.ml, 0), 0),
    estimates: entries.filter((e) => e.estimate).length,
    grades: gradeMix(entries),
    plans: plans.filter((p) => !p.loggedId),
    // What 100% stands for on this screen: his daily needs, or null for the EU reference intakes.
    needs: await needRefs(),
  };
}

// ---------- Coverage report ----------

export async function coverageReport() {
  const sql = db();
  const reqs = await sql`select * from food_requirements order by list, category, key`;
  const items = await sql`select key, kind, name, brand, status, req from food_items where hidden = false`;
  const recipes = await sql`select key, name, type, req, status from recipes where deleted_at is null`;
  const byReq = new Map();
  for (const it of items) for (const k of it.req || []) byReq.set(k, [...(byReq.get(k) || []), it]);
  const known = new Set([...items.map((it) => it.key), ...recipes.map((r) => r.key)]);
  const recByReq = new Map();
  for (const r of recipes) for (const k of r.req || []) recByReq.set(k, [...(recByReq.get(k) || []), r]);
  const productsBy = (name) => {
    const words = norm(name.split('/')[0]).split(' ').filter((w) => w.length > 2 && !['and', 'with', 'the', 'drink', 'drinks', 'free'].includes(w)).slice(0, 3);
    return items.filter((it) => it.kind === 'product' && it.status !== 'needs-label' && words.length && words.every((w) => norm(`${it.brand || ''} ${it.name}`).includes(w)));
  };
  const rows = reqs.map((r) => {
    // The records the requirement map names count too: most records from the newer sources carry no req of their own.
    const linked = [...new Set([...(byReq.get(r.key) || []).map((it) => it.key), ...(r.records || []).filter((k) => known.has(k))])];
    const recs = recByReq.get(r.key) || [];
    let state = r.status;
    let found = linked.length;
    if (r.list === 'recipe') {
      state = recs.length ? 'covered' : 'missing';
      found = recs.length;
    } else if (r.status === 'product') {
      const p = productsBy(r.name);
      found = p.length;
      state = p.length ? 'products' : 'missing';
    } else if (r.status === 'recipe') {
      found = recs.length;
      state = recs.length ? 'recipe' : 'missing';
    } else if (['mapped', 'partial', 'estimate'].includes(r.status) && !linked.length) state = 'missing';
    return { key: r.key, list: r.list, category: r.category, categoryLabel: r.category_label, priority: r.priority, name: r.name, type: r.type, status: r.status, state, found, issue: r.issue };
  });
  const group = (list) => {
    const cats = new Map();
    for (const r of rows.filter((x) => x.list === list)) {
      const c = cats.get(r.category) || { category: r.category, label: r.categoryLabel, total: 0, counts: {}, open: [] };
      c.total += 1;
      c.counts[r.state] = (c.counts[r.state] || 0) + 1;
      if (['missing', 'partial', 'estimate', 'gap'].includes(r.state) || r.issue) c.open.push(r);
      cats.set(r.category, c);
    }
    return [...cats.values()];
  };
  const count = (list, states) => rows.filter((r) => r.list === list && states.includes(r.state)).length;
  const recipeTypes = await sql`select type, count(*)::int as n from recipes where deleted_at is null and source = 'oath' group by type`;
  // How much of the catalogue has a value for each nutrient, and how many records carry a grade.
  const values = await sql`select nutrients, nutriscore, nova from food_items where hidden = false and status <> 'needs-label'`;
  const nutrients = NUTRIENTS.map((x) => ({ key: x.key, label: x.label, group: x.group, count: values.filter((v) => typeof v.nutrients?.[x.key] === 'number').length }));
  return {
    nutrients: { total: values.length, list: nutrients, graded: values.filter((v) => gradeOf(v.nutriscore)).length, nova: values.filter((v) => v.nova).length },
    foods: { total: rows.filter((r) => r.list === 'food').length, matched: count('food', ['mapped', 'products', 'recipe']), incomplete: count('food', ['partial', 'estimate']), missing: count('food', ['missing', 'gap']), categories: group('food') },
    recipes: { total: rows.filter((r) => r.list === 'recipe').length, covered: count('recipe', ['covered']), missing: count('recipe', ['missing']), categories: group('recipe'), byType: Object.fromEntries(recipeTypes.map((t) => [t.type, t.n])) },
    catalogue: {
      generic: items.filter((i) => i.kind === 'generic').length,
      products: items.filter((i) => i.kind === 'product' && i.status !== 'needs-label').length,
      needsLabel: items.filter((i) => i.status === 'needs-label').length,
      yours: items.filter((i) => ['custom', 'label'].includes(i.kind)).length,
      estimates: items.filter((i) => i.kind === 'estimate').length,
      web: items.filter((i) => i.kind === 'web').length,
      recipes: recipes.length,
    },
  };
}

// ---------- Snapshot for the coach and the Today card ----------

const DAY_KEYS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'fibre', 'salt', 'caffeine'];

// One line of totals in words: "energy 1,240 kcal, protein 61 g, ..., caffeine 160+ mg".
export const totalsText = (t) => DAY_KEYS.map((k) => `${NUTRIENT[k].label.toLowerCase()} ${show(t, k)}`).join(', ');

export async function foodForCoach(date) {
  const d = await foodDay(date);
  // The snapshot (no date) also carries the clearest link between his food and Apple Health, when one is clear.
  const link = date ? '' : await import('./food-links.js').then((m) => m.foodLinksForCoach()).catch(() => '');
  if (!d.entries.length) return [`Food ${d.today ? 'today' : d.date}: nothing logged.`, link].filter(Boolean).join('\n');
  const lines = [`Food ${d.today ? 'today' : d.date}, as he logged it (a "+" means some items have no value for that nutrient, so it is a floor; "–" means unknown). Food never affects HP, and you never set or invent targets for it: ${totalsText(d.total)}; drinks ${d.drinksMl} ml.`];
  for (const e of d.entries) {
    lines.push(`  entry ${e.id} | ${e.slot} | ${e.name}${e.brand ? ` (${e.brand})` : ''}${e.amountText ? `, ${e.amountText}` : ''} | ${show(e.nutrients, 'kcal')}${e.estimate ? ' | estimated from a photo or a typed description' : ''}`);
  }
  if (link) lines.push(link);
  return lines.join('\n');
}

// ---------- API ----------

async function jsonBody(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export const foodApi = new Hono();
foodApi.get('/food/day', async (c) => c.json(await foodDay(c.req.query('date'))));
foodApi.get('/food/history', async (c) => c.json(await foodHistory({ days: c.req.query('days'), date: c.req.query('date') })));
foodApi.get('/food/search', async (c) => c.json({ items: await searchFoods(c.req.query('q'), { liquid: c.req.query('drinks') === '1' ? true : null }) }));
foodApi.get('/food/recent', async (c) => c.json({ items: await recentFoods({ liquid: c.req.query('drinks') === '1' ? true : null }) }));
foodApi.get('/food/items/:key', async (c) => c.json(await getFood({ key: c.req.param('key') })));
foodApi.post('/food/items', async (c) => c.json(await saveCustomFood(await jsonBody(c))));
foodApi.post('/food/items/:key/favourite', async (c) => c.json(await setFavourite(c.req.param('key'), (await jsonBody(c)).on !== false)));
foodApi.post('/food/log', async (c) => c.json(await logFood(await jsonBody(c))));
foodApi.post('/food/quick', async (c) => c.json(await quickAdd(await jsonBody(c))));
foodApi.patch('/food/log/:id', async (c) => c.json(await editEntry(c.req.param('id'), await jsonBody(c))));
foodApi.delete('/food/log/:id', async (c) => c.json(await deleteEntry(c.req.param('id'))));
foodApi.post('/food/log/:id/restore', async (c) => c.json(await restoreEntry(c.req.param('id'))));
foodApi.post('/food/repeat', async (c) => c.json(await repeatDay(await jsonBody(c))));
foodApi.get('/food/meals', async (c) => c.json({ meals: await listMeals() }));
foodApi.get('/food/meals/:id', async (c) => c.json(await getMeal(c.req.param('id'))));
foodApi.post('/food/meals', async (c) => c.json(await saveMeal(await jsonBody(c))));
foodApi.delete('/food/meals/:id', async (c) => c.json(await deleteMeal(c.req.param('id'))));
foodApi.post('/food/meals/log', async (c) => c.json(await logMeal(await jsonBody(c))));
foodApi.post('/food/preview', async (c) => {
  const b = await jsonBody(c);
  return c.json(await priceLines(cleanMealLines(b.lines), { factor: Number(b.factor) || 1, skip: b.skip || [], with: b.with || [] }));
});
foodApi.get('/food/recipes', async (c) => c.json({ recipes: await listRecipes({ q: c.req.query('q'), family: c.req.query('family'), type: c.req.query('type') }) }));
foodApi.get('/food/recipes/:key', async (c) => c.json(await getRecipe(c.req.param('key'))));
foodApi.post('/food/recipes/:key/preview', async (c) => {
  const b = await jsonBody(c);
  return c.json(await getRecipe(c.req.param('key'), { skip: b.skip || [], with: b.with || [], swap: b.swap || {}, factor: Number(b.factor) || 1 }));
});
foodApi.post('/food/recipes', async (c) => c.json(await saveRecipe(await jsonBody(c))));
foodApi.post('/food/recipes/:key/duplicate', async (c) => c.json(await duplicateRecipe(c.req.param('key'), (await jsonBody(c)).name)));
foodApi.delete('/food/recipes/:key', async (c) => c.json(await deleteRecipe(c.req.param('key'))));
foodApi.post('/food/recipes/log', async (c) => c.json(await logRecipe(await jsonBody(c))));
foodApi.get('/food/batches', async (c) => c.json({ batches: await listBatches({ open: c.req.query('all') !== '1' }) }));
foodApi.post('/food/batches', async (c) => c.json(await cookBatch(await jsonBody(c))));
foodApi.get('/food/batches/:id', async (c) => c.json(await getBatch(c.req.param('id'))));
foodApi.post('/food/batches/:id/finish', async (c) => c.json(await finishBatch(c.req.param('id'), (await jsonBody(c)).done !== false)));
foodApi.post('/food/batches/log', async (c) => c.json(await logBatch(await jsonBody(c))));
foodApi.get('/food/plans', async (c) => {
  const { today, tz } = await localNow();
  return c.json({ plans: await listPlans(c.req.query('from') || today, c.req.query('to') || addDays(today, 7, tz)) });
});
foodApi.post('/food/plans', async (c) => c.json(await addPlan(await jsonBody(c))));
foodApi.delete('/food/plans/:id', async (c) => c.json(await deletePlan(c.req.param('id'))));
foodApi.post('/food/plans/:id/eat', async (c) => c.json(await eatPlan(c.req.param('id'), await jsonBody(c))));
foodApi.get('/food/report', async (c) => c.json(await coverageReport()));
// Replays the phone's offline queue in order; each step is idempotent by its id.
foodApi.post('/food/sync', async (c) => {
  const { ops = [] } = await jsonBody(c);
  const results = [];
  for (const op of ops.slice(0, 200)) {
    try {
      const fn = { log: logFood, quick: quickAdd, meal: logMeal, recipe: logRecipe, batch: logBatch, repeat: repeatDay }[op.op];
      if (op.op === 'delete') results.push({ id: op.id, ok: true, ...(await deleteEntry(op.data?.id || op.id)) });
      else if (fn) results.push({ id: op.id, ok: true, ...(await fn(op.data || {})) });
      else results.push({ id: op.id, ok: false, error: 'Unknown step.' });
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      results.push({ id: op.id, ok: false, error: err.message });
    }
  }
  return c.json({ results });
});

export { resolve as resolveAmount };
