// The food tables: the catalogue, the diary, saved meals, recipes, batches, plans and the caches, and
// the migration that brings an older database up to them.
import { db } from './db.js';
import { norm } from '../public/nutrition.js';

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
