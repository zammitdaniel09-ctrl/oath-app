// Food: the catalogue (USDA generics, Open Food Facts products, labels read from photos, Daniel's own
// foods), the diary, saved meals, recipes, cooked batches, plans and the coverage report.
//
// Honest by construction: every record says where its numbers came from, unknown values stay null,
// diary lines keep a frozen copy of what was logged, and food never touches HP.
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { db, logEvent } from './db.js';
import { nowUTC, addDays, validDate, validTime } from './time.js';
import { localNow, RuleError } from './engine.js';
import {
  KEYS, NUTRIENT, norm, scale, total, line, recipeTotals, shareOf, batchPortion, batchLeft, unknown, round, amountText, unitsFor, resolve, show,
} from '../public/nutrition.js';

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
`;

export async function migrateFood() {
  await db().unsafe(FOOD_SCHEMA);
}

// ---------- Records ----------

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks', 'drinks'];
const KINDS = ['generic', 'product', 'custom', 'label', 'estimate'];
const SOURCE_TEXT = {
  usda: 'USDA FoodData Central',
  off: 'Open Food Facts',
  label: 'Read from a label photo',
  you: 'Entered by you',
  estimate: 'Generic estimate',
};

const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ts = () => nowUTC().toJSDate();

// Only the nutrient keys we know, as numbers or null. Negative or absurd values are refused.
export function cleanNutrients(input = {}, { basisMax = 100 } = {}) {
  const out = {};
  for (const k of KEYS) {
    const raw = input[k];
    if (raw === null || raw === undefined || raw === '') { out[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new RuleError(`${k} must be a number of zero or more, or left blank.`);
    const cap = k === 'kcal' ? 950 : k === 'caffeine' ? 6000 : k === 'salt' ? 100 : basisMax;
    if (v > cap) throw new RuleError(`${k} of ${v} per 100 is not believable.`);
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

// What the maths and the screens need from a row.
export function shapeItem(r) {
  if (!r) return null;
  return {
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
    last: r.last_unit ? { qty: r.last_qty, unit: r.last_unit } : null,
    units: unitsFor(r),
    // Only crowd-sourced and typed-in values are checked; USDA uses food-specific energy factors.
    check: ['off', 'label', 'you'].includes(r.source) ? energyCheck(r.nutrients) : null,
  };
}

// Inserts or updates one record by its key. Seeds and imports call this; Daniel's favourites, use
// counts and hidden flags are never touched by an update.
export async function upsertItem(input, tx = db()) {
  const key = clean(input.key, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9:._-]*$/.test(key)) throw new RuleError(`Bad food key "${key}".`);
  const kind = KINDS.includes(input.kind) ? input.kind : 'generic';
  const name = clean(input.name, 160);
  if (!name) throw new RuleError('A food needs a name.');
  const aliases = [...new Set((input.aliases || []).map((a) => clean(a, 80)).filter(Boolean))];
  const nameNorm = norm(name);
  const aliasNorm = [...new Set(aliases.map(norm).concat(input.name_mt ? [norm(input.name_mt)] : []).filter(Boolean))];
  const search = [nameNorm, ...aliasNorm, norm(input.brand), norm(input.barcode)].filter(Boolean).join(' ');
  const basis = input.basis === 'ml' ? 'ml' : 'g';
  const nutrients = cleanNutrients(input.nutrients || {});
  const edible = n(Number(input.edible)) && input.edible > 0 && input.edible <= 1 ? Number(input.edible) : null;
  const density = n(Number(input.density)) && input.density > 0.3 && input.density < 3 ? Number(input.density) : null;
  const concentrate = input.concentrate && Number(input.concentrate.water) > 0 ? { water: Number(input.concentrate.water) } : null;
  const row = {
    key, kind, name, name_mt: input.name_mt ? clean(input.name_mt, 160) : null, aliases, name_norm: nameNorm, alias_norm: aliasNorm, search,
    brand: input.brand ? clean(input.brand, 80) : null,
    barcode: input.barcode ? String(input.barcode).replace(/\D/g, '').slice(0, 14) || null : null,
    market: input.market ? clean(input.market, 40) : null,
    category: input.category ? clean(input.category, 60) : null,
    state: input.state ? clean(input.state, 30) : null,
    basis, nutrients, portions: portionList(input.portions), edible, refuse: input.refuse ? clean(input.refuse, 80) : null, density,
    pack: sizeOf(input.pack), serving: sizeOf(input.serving), concentrate,
    liquid: Boolean(input.liquid) || basis === 'ml',
    source: clean(input.source || 'you', 20),
    source_ref: input.source_ref ? clean(input.source_ref, 200) : null,
    source_date: input.source_date ? clean(input.source_date, 30) : null,
    status: clean(input.status || 'ok', 30),
    notes: clean(input.notes, 600),
    req: (input.req || []).map((x) => clean(x, 120)),
  };
  const [saved] = await tx`
    insert into food_items (key, kind, name, name_mt, aliases, name_norm, alias_norm, search, brand, barcode, market, category, state,
      basis, nutrients, portions, edible, refuse, density, pack, serving, concentrate, liquid, source, source_ref, source_date, status, notes, req)
    values (${row.key}, ${row.kind}, ${row.name}, ${row.name_mt}, ${row.aliases}::text[], ${row.name_norm}, ${row.alias_norm}::text[], ${row.search},
      ${row.brand}, ${row.barcode}, ${row.market}, ${row.category}, ${row.state}, ${row.basis}, ${tx.json(row.nutrients)}, ${tx.json(row.portions)},
      ${row.edible}, ${row.refuse}, ${row.density}, ${row.pack ? tx.json(row.pack) : null}, ${row.serving ? tx.json(row.serving) : null},
      ${row.concentrate ? tx.json(row.concentrate) : null}, ${row.liquid}, ${row.source}, ${row.source_ref}, ${row.source_date}, ${row.status},
      ${row.notes}, ${row.req}::text[])
    on conflict (key) do update set kind = excluded.kind, name = excluded.name, name_mt = excluded.name_mt, aliases = excluded.aliases,
      name_norm = excluded.name_norm, alias_norm = excluded.alias_norm, search = excluded.search, brand = excluded.brand, barcode = excluded.barcode,
      market = excluded.market, category = excluded.category, state = excluded.state, basis = excluded.basis, nutrients = excluded.nutrients,
      portions = excluded.portions, edible = excluded.edible, refuse = excluded.refuse, density = excluded.density, pack = excluded.pack,
      serving = excluded.serving, concentrate = excluded.concentrate, liquid = excluded.liquid, source = excluded.source,
      source_ref = excluded.source_ref, source_date = excluded.source_date, status = excluded.status, notes = excluded.notes, req = excluded.req,
      updated_at = now()
    returning *`;
  return saved;
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
  return shapeItem(r);
}

// Local ranking: exact name, an exact alias, name starts with the words, an alias starts with them,
// then anything containing every word. Plain foods before products, then what Daniel uses most,
// then shorter names. Aliases only lead to a record; they never merge two foods.
export async function searchFoods(q, { limit = 30, kind = null, liquid = null } = {}) {
  const query = norm(q);
  if (!query) return [];
  const words = query.split(' ').slice(0, 6);
  const sql = db();
  const all = words.reduce((acc, w) => sql`${acc} and search like ${`%${w}%`}`, sql``);
  const rows = await sql`
    select *, case
      when name_norm = ${query} then 0
      when ${query} = any(alias_norm) then 1
      when name_norm like ${`${query} %`} then 2
      when exists (select 1 from unnest(alias_norm) a where a like ${`${query}%`}) then 3
      when name_norm like ${`%${query}%`} then 4
      when name_norm like ${`${words[0]} %`} then 5
      else 6 end as rank
    from food_items
    where hidden = false ${all}
      ${kind ? sql`and kind = ${kind}` : sql``}
      ${liquid === null ? sql`` : sql`and liquid = ${liquid}`}
    order by rank, (kind = 'generic') desc, (market = 'Malta') desc, uses desc, length(name), name
    limit ${Math.min(Number(limit) || 30, 80)}`;
  return rows.map(shapeItem);
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
const newId = () => crypto.randomUUID();

function slotFor(local, liquid) {
  if (liquid) return 'drinks';
  const h = local.hour;
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 18 && h < 23) return 'dinner';
  return 'snacks';
}

// When and where an entry goes. A date in the future is a plan, not a log.
async function placeEntry(input, liquid) {
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

const shapeEntry = (r) => ({
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
  amountText: r.amount_text,
  grams: r.grams,
  ml: r.ml,
  share: r.share,
  liquid: r.liquid,
  nutrients: r.nutrients,
  lines: r.lines,
  estimate: r.estimate,
  source: r.source,
  note: r.note,
  planId: r.plan_id,
});

// Writes one entry once. The id comes from the phone, so an offline entry replayed later lands once.
async function insertEntry(e, tx = db()) {
  const rows = await tx`
    insert into food_log (id, date, at, slot, kind, ref_id, ref_key, name, brand, qty, unit, amount_text, grams, ml, share, liquid,
      nutrients, lines, estimate, source, note, plan_id)
    values (${e.id}, ${e.date}, ${e.at}, ${e.slot}, ${e.kind}, ${e.ref_id ?? null}, ${e.ref_key ?? null}, ${e.name}, ${e.brand ?? null},
      ${e.qty ?? null}, ${e.unit ?? null}, ${e.amount_text || ''}, ${e.grams ?? null}, ${e.ml ?? null}, ${e.share ?? null}, ${Boolean(e.liquid)},
      ${tx.json(e.nutrients)}, ${e.lines ? tx.json(e.lines) : null}, ${Boolean(e.estimate)}, ${e.source || 'you'}, ${clean(e.note, 300)},
      ${e.plan_id ?? null})
    on conflict (id) do nothing returning *`;
  if (rows.length) return { entry: shapeEntry(rows[0]), duplicate: false };
  const [existing] = await tx`select * from food_log where id = ${e.id}`;
  return { entry: shapeEntry(existing), duplicate: true };
}

async function existingEntry(id) {
  if (!id) return null;
  if (!idOk(id)) throw new RuleError('Bad entry id.');
  const [r] = await db()`select * from food_log where id = ${id}`;
  return r ? { entry: shapeEntry(r), duplicate: true } : null;
}

// Logs an amount of one catalogue record: { id, key, qty, unit, date, time, slot, estimate, note }.
export async function logFood(input, source = 'you') {
  const again = await existingEntry(input.id);
  if (again) return again;
  const r = await itemByRef({ key: input.key, id: input.item_id });
  if (!r) throw new RuleError('That food is not in the catalogue.', 404);
  const item = shapeItem(r);
  const unit = input.unit || (item.last?.unit && item.units.some((u) => u.unit === item.last.unit) ? item.last.unit : item.basis);
  const l = line(item, input.qty, unit);
  if (l.error) throw new RuleError(l.error);
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
    nutrients: l.nutrients,
    estimate: Boolean(input.estimate),
    source,
    note: input.note,
    plan_id: input.plan_id,
  });
  if (!out.duplicate) {
    await db()`update food_items set uses = uses + 1, last_used = now(), last_qty = ${Number(input.qty)}, last_unit = ${unit} where id = ${item.id}`;
  }
  return out;
}

// Calories and whatever macros are known, kept in the diary only and never added to the catalogue.
export async function quickAdd(input, source = 'you') {
  const again = await existingEntry(input.id);
  if (again) return again;
  const kcal = Number(input.kcal);
  if (!(kcal >= 0) || kcal > 10000 || input.kcal === '' || input.kcal === null || input.kcal === undefined) throw new RuleError('Give the calories.');
  const nutrients = unknown();
  nutrients.kcal = kcal;
  for (const k of ['protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine', 'alcohol']) {
    if (input[k] === undefined || input[k] === null || input[k] === '') continue;
    const v = Number(input[k]);
    if (!(v >= 0) || v > 2000) throw new RuleError(`${k} must be zero or more.`);
    nutrients[k] = v;
  }
  const ml = Number(input.ml) > 0 ? Number(input.ml) : null;
  const place = await placeEntry(input, Boolean(ml));
  return insertEntry({
    id: input.id || newId(),
    ...place,
    kind: 'quick',
    name: clean(input.name, 120) || 'Quick add',
    amount_text: ml ? `${ml} ml` : '',
    ml,
    liquid: Boolean(ml),
    nutrients,
    source,
    note: input.note,
  });
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
  if (input.qty !== undefined || input.unit !== undefined) {
    const qty = input.qty ?? e.qty;
    const unit = input.unit ?? e.unit;
    if (e.kind === 'item') {
      const r = await itemByRef({ key: e.ref_key });
      if (!r) throw new RuleError('The food behind this entry is gone, so its amount cannot change.');
      const l = line(shapeItem(r), qty, unit);
      if (l.error) throw new RuleError(l.error);
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

// Copies a day's entries (or one meal of it) to another day, as new entries.
export async function repeatDay({ from, to, slot = null }) {
  const { today } = await localNow();
  const target = to || today;
  if (!validDate(from) || !validDate(target)) throw new RuleError('Bad date.');
  const sql = db();
  const rows = await sql`select * from food_log where date = ${from} and deleted_at is null ${slot ? sql`and slot = ${slot}` : sql``} order by at`;
  if (!rows.length) throw new RuleError('Nothing was logged then.');
  const out = [];
  for (const r of rows) {
    const e = { ...r, id: newId(), date: target, at: ts(), source: 'repeat', plan_id: null };
    out.push((await insertEntry(e)).entry);
  }
  return { entries: out };
}

export async function foodDay(date) {
  const { today } = await localNow();
  const d = date || today;
  if (!validDate(d)) throw new RuleError('Bad date.');
  const rows = await db()`select * from food_log where date = ${d} and deleted_at is null order by at, created_at`;
  const entries = rows.map(shapeEntry);
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
    plans: plans.filter((p) => !p.loggedId),
  };
}

// ---------- Saved meals: shakes, fruit bowls, plates and anything else logged together ----------

const MEAL_KINDS = ['meal', 'shake', 'bowl', 'plate'];

function cleanMealLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new RuleError('A saved meal needs at least one food.');
  if (lines.length > 40) throw new RuleError('Too many lines.');
  return lines.map((l) => {
    const ref = l.ref === 'recipe' ? 'recipe' : 'item';
    if (!l.ref_key) throw new RuleError('Each line needs a food.');
    const qty = Number(l.qty);
    if (!(qty > 0)) throw new RuleError('Each line needs an amount.');
    return { ref, ref_key: String(l.ref_key), qty, unit: String(l.unit || (ref === 'recipe' ? 'serving' : 'g')), optional: Boolean(l.optional), grp: clean(l.grp, 30) };
  });
}

// Works out a meal's lines against the catalogue: [{ name, amount_text, nutrients, ... }].
async function priceLines(lines, opts = {}) {
  const all = [...lines, ...Object.values(opts.swap || {})];
  const graph = await loadGraph(all.filter((l) => l.ref === 'recipe').map((l) => l.ref_key), all.filter((l) => l.ref !== 'recipe').map((l) => l.ref_key));
  const pseudo = { key: '__meal__', servings: 1, lines };
  const t = recipeTotals(pseudo, graph.get, opts);
  const rows = t.rows.map((r) => {
    const it = r.ref === 'recipe' ? graph.recipes.get(r.ref_key) : graph.items.get(r.ref_key);
    return {
      ref: r.ref, ref_key: r.ref_key, name: it?.name || r.ref_key, qty: r.qty, unit: r.unit,
      amount_text: r.ref === 'recipe' ? amountText(r.qty, r.unit) : it ? amountText(r.qty, r.unit, it) : '',
      g: r.g ?? (r.basis === 'g' ? r.amount : null), ml: r.ml ?? null, liquid: Boolean(it?.liquid), nutrients: r.nutrients, error: r.error,
    };
  });
  return { rows, nutrients: t.nutrients, errors: t.errors };
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
  } else lines = cleanMealLines(input.lines);
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
    estimate: Boolean(input.estimate),
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
  return sql.begin(async (tx) => {
    let row;
    if (existing) {
      [row] = await tx`update recipes set name = ${fields.name}, name_mt = ${fields.name_mt}, family = ${fields.family}, type = ${fields.type},
        parent_key = ${fields.parent_key}, summary = ${fields.summary}, servings = ${fields.servings}, final_weight = ${fields.final_weight},
        prep_min = ${fields.prep_min}, cook_min = ${fields.cook_min}, equipment = ${fields.equipment}::text[], tags = ${fields.tags}::text[],
        method = ${tx.json(method)}, notes = ${fields.notes}, req = ${fields.req}::text[], search = ${fields.search},
        version = version + 1, edited = ${source === 'you'}, status = ${source === 'you' && existing.status === 'ai-untested' ? 'user-reviewed' : existing.status},
        updated_at = now() where id = ${existing.id} returning *`;
      await tx`delete from recipe_lines where recipe_id = ${existing.id}`;
    } else {
      [row] = await tx`insert into recipes (key, name, name_mt, family, type, parent_key, summary, servings, final_weight, prep_min, cook_min,
        equipment, tags, method, notes, req, search, source, licence, status)
        values (${key}, ${fields.name}, ${fields.name_mt}, ${fields.family}, ${fields.type}, ${fields.parent_key}, ${fields.summary}, ${fields.servings},
        ${fields.final_weight}, ${fields.prep_min}, ${fields.cook_min}, ${fields.equipment}::text[], ${fields.tags}::text[], ${tx.json(method)},
        ${fields.notes}, ${fields.req}::text[], ${fields.search}, ${source}, ${input.licence || null}, ${input.status || (source === 'you' ? 'user-reviewed' : 'ai-untested')})
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

function shapeBatch(b) {
  return b ? { ...b, final_weight: b.final_weight, servings: b.servings } : null;
}
const batchAmountText = (qty, unit) => (unit === 'g' ? `${round(qty, 0)} g of the batch` : unit === 'serving' ? `${round(qty, 2)} ${Number(qty) === 1 ? 'serving' : 'servings'}` : `${round(qty * 100, 0)}% of the batch`);

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

// ---------- Coverage report ----------

export async function coverageReport() {
  const sql = db();
  const reqs = await sql`select * from food_requirements order by list, category, key`;
  const items = await sql`select key, kind, name, brand, status, req from food_items where hidden = false`;
  const recipes = await sql`select key, name, type, req, status from recipes where deleted_at is null`;
  const byReq = new Map();
  for (const it of items) for (const k of it.req || []) byReq.set(k, [...(byReq.get(k) || []), it]);
  const recByReq = new Map();
  for (const r of recipes) for (const k of r.req || []) recByReq.set(k, [...(recByReq.get(k) || []), r]);
  const productsBy = (name) => {
    const words = norm(name.split('/')[0]).split(' ').filter((w) => w.length > 2 && !['and', 'with', 'the', 'drink', 'drinks', 'free'].includes(w)).slice(0, 3);
    return items.filter((it) => it.kind === 'product' && it.status !== 'needs-label' && words.length && words.every((w) => norm(`${it.brand || ''} ${it.name}`).includes(w)));
  };
  const rows = reqs.map((r) => {
    const linked = byReq.get(r.key) || [];
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
  return {
    foods: { total: rows.filter((r) => r.list === 'food').length, matched: count('food', ['mapped', 'products', 'recipe']), incomplete: count('food', ['partial', 'estimate']), missing: count('food', ['missing', 'gap']), categories: group('food') },
    recipes: { total: rows.filter((r) => r.list === 'recipe').length, covered: count('recipe', ['covered']), missing: count('recipe', ['missing']), categories: group('recipe'), byType: Object.fromEntries(recipeTypes.map((t) => [t.type, t.n])) },
    catalogue: {
      generic: items.filter((i) => i.kind === 'generic').length,
      products: items.filter((i) => i.kind === 'product' && i.status !== 'needs-label').length,
      needsLabel: items.filter((i) => i.status === 'needs-label').length,
      yours: items.filter((i) => ['custom', 'label'].includes(i.kind)).length,
      estimates: items.filter((i) => i.kind === 'estimate').length,
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
  if (!d.entries.length) return `Food ${d.today ? 'today' : d.date}: nothing logged.`;
  const lines = [`Food ${d.today ? 'today' : d.date}, as he logged it (a "+" means some items have no value for that nutrient, so it is a floor; "—" means unknown). Food never affects HP, and you never set or invent targets for it: ${totalsText(d.total)}; drinks ${d.drinksMl} ml.`];
  for (const e of d.entries) {
    lines.push(`  entry ${e.id} | ${e.slot} | ${e.name}${e.brand ? ` (${e.brand})` : ''}${e.amountText ? `, ${e.amountText}` : ''} | ${show(e.nutrients, 'kcal')}${e.estimate ? ' | amount estimated from a photo' : ''}`);
  }
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
      const fn = { log: logFood, quick: quickAdd, meal: logMeal, recipe: logRecipe, batch: logBatch }[op.op];
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
