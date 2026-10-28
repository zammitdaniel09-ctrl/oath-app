// Loads the food catalogue, the blueprint's requirement lists and the recipe library into the database.
// Runs at boot and only does work when the data files have changed. Everything is keyed, so a re-run
// updates rows in place: ids stay stable and nothing is duplicated. Daniel's edits and deletions of
// library recipes are left alone, and his favourites and use counts are never touched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getKV, setKV, logEvent } from './db.js';
import { upsertItems } from './food.js';
import { norm } from '../public/nutrition.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const jsonIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f)) : []);

function seedFiles() {
  return [
    path.join(DATA, 'food-requirements.json'),
    path.join(DATA, 'recipe-requirements.json'),
    path.join(DATA, 'foods/usda-foods.json'),
    path.join(DATA, 'foods/usda-all.json'),
    path.join(DATA, 'foods/cofid.json'),
    path.join(DATA, 'foods/ciqual.json'),
    ...jsonIn(path.join(DATA, 'foods/brands')),
    path.join(DATA, 'foods/placeholders.json'),
    ...jsonIn(path.join(DATA, 'foods/map')),
    ...jsonIn(path.join(DATA, 'recipes')),
  ].filter((p) => fs.existsSync(p));
}

export function seedHash() {
  const h = crypto.createHash('sha1');
  for (const f of seedFiles()) h.update(path.basename(f)).update(fs.readFileSync(f));
  return h.digest('hex');
}

const RECIPE_ORDER = { component: 0, base: 1, template: 2, variant: 3 };
// Rows per multi-row upsert: about 500 keeps each statement small and the whole catalogue in seconds.
const SEED_BATCH = 500;

function loadRecipes() {
  const out = [];
  for (const f of jsonIn(path.join(DATA, 'recipes'))) {
    const data = readJson(f);
    for (const r of Array.isArray(data) ? data : data.recipes || []) out.push(r);
  }
  return out.sort((a, b) => (RECIPE_ORDER[a.type] ?? 9) - (RECIPE_ORDER[b.type] ?? 9));
}

async function seedRecipe(r, tx) {
  const hash = crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex');
  const [row] = await tx`select id, edited, seed_hash, deleted_at from recipes where key = ${r.key}`;
  if (row && (row.edited || row.deleted_at || row.seed_hash === hash)) return 'kept';
  const fields = {
    name: r.name,
    name_mt: r.name_mt || null,
    family: r.family || '',
    type: r.type,
    parent_key: r.parent_key || null,
    req: r.req || [],
    summary: r.summary || '',
    servings: r.servings,
    final_weight: r.final_weight || null,
    prep_min: r.prep_min || null,
    cook_min: r.cook_min || null,
    equipment: r.equipment || [],
    tags: r.tags || [],
    notes: r.notes || '',
    search: [norm(r.name), norm(r.name_mt), norm((r.aliases || []).join(' ')), norm((r.tags || []).join(' ')), norm(r.family)].filter(Boolean).join(' '),
  };
  let id;
  if (row) {
    await tx`update recipes set name = ${fields.name}, name_mt = ${fields.name_mt}, family = ${fields.family}, type = ${fields.type},
      parent_key = ${fields.parent_key}, req = ${fields.req}::text[], summary = ${fields.summary}, servings = ${fields.servings},
      final_weight = ${fields.final_weight}, prep_min = ${fields.prep_min}, cook_min = ${fields.cook_min}, equipment = ${fields.equipment}::text[],
      tags = ${fields.tags}::text[], method = ${tx.json(r.method || [])}, notes = ${fields.notes}, search = ${fields.search},
      version = version + 1, seed_hash = ${hash}, updated_at = now() where id = ${row.id}`;
    await tx`delete from recipe_lines where recipe_id = ${row.id}`;
    id = row.id;
  } else {
    [{ id }] = await tx`insert into recipes (key, name, name_mt, family, type, parent_key, req, summary, servings, final_weight, prep_min, cook_min,
      equipment, tags, method, notes, search, source, licence, status, seed_hash)
      values (${r.key}, ${fields.name}, ${fields.name_mt}, ${fields.family}, ${fields.type}, ${fields.parent_key}, ${fields.req}::text[],
      ${fields.summary}, ${fields.servings}, ${fields.final_weight}, ${fields.prep_min}, ${fields.cook_min}, ${fields.equipment}::text[],
      ${fields.tags}::text[], ${tx.json(r.method || [])}, ${fields.notes}, ${fields.search}, 'oath', 'Original to Oath', 'ai-untested', ${hash})
      returning id`;
  }
  for (const [i, l] of (r.lines || []).entries()) {
    await tx`insert into recipe_lines (recipe_id, sort, grp, ref, ref_key, qty, unit, optional, label, note)
      values (${id}, ${i}, ${l.grp || ''}, ${l.ref === 'recipe' ? 'recipe' : 'item'}, ${l.ref_key}, ${l.qty}, ${l.unit}, ${Boolean(l.optional)},
        ${l.label || ''}, ${l.note || ''})`;
  }
  return row ? 'updated' : 'added';
}

export async function seedFood({ force = false, log = () => {} } = {}) {
  const hash = seedHash();
  const prev = await getKV('food_seed');
  if (!force && prev?.hash === hash) return { skipped: true, ...prev.counts };
  const sql = db();
  const counts = { items: 0, usdaAll: 0, rejected: 0, foodRequirements: 0, recipeRequirements: 0, recipes: { added: 0, updated: 0, kept: 0 } };
  const started = Date.now();

  // The hand-picked records (USDA generics for the blueprint list, and foods with no generic source:
  // every value unknown until a label is added). A bad record here is a bug in the data, so it stops the seed.
  const curated = [...readJson(path.join(DATA, 'foods/usda-foods.json')).items];
  const holders = path.join(DATA, 'foods/placeholders.json');
  if (fs.existsSync(holders)) curated.push(...readJson(holders).items);
  const first = await upsertItems(curated, sql, { batch: SEED_BATCH });
  if (first.rejected.length) throw new Error(`food seed: ${first.rejected.length} curated records failed: ${first.rejected.slice(0, 3).map((r) => `${r.key} ${r.error}`).join('; ')}`);
  counts.items += first.saved;

  // The rest of USDA (SR Legacy, Foundation, FNDDS), in multi-row upserts. Portions were built from USDA's
  // own labels, so they are marked as such. A record that fails validation is skipped and counted.
  const all = path.join(DATA, 'foods/usda-all.json');
  if (fs.existsSync(all)) {
    const rest = readJson(all).items.map((i) => ({ ...i, portions: (i.portions || []).map((p) => ({ source: 'usda', ...p })) }));
    const r = await upsertItems(rest, sql, { batch: SEED_BATCH });
    counts.usdaAll = r.saved;
    counts.rejected = r.rejected.length;
    counts.items += r.saved;
    if (r.rejected.length) log(`food seed: ${r.rejected.length} USDA records skipped, first: ${r.rejected[0].key} ${r.rejected[0].error}`);
  }
  // The UK and French composition tables (CoFID, Ciqual) and branded products and chain menus with their
  // published values (data/foods/brands). Each file stands alone: a record that fails validation is skipped
  // and counted, and a file that cannot be read is logged, never fatal.
  const extra = [['cofid', path.join(DATA, 'foods/cofid.json')], ['ciqual', path.join(DATA, 'foods/ciqual.json')],
    ...jsonIn(path.join(DATA, 'foods/brands')).map((f) => [`brands/${path.basename(f, '.json')}`, f])];
  for (const [name, file] of extra) {
    if (!fs.existsSync(file)) continue;
    try {
      const r = await upsertItems(readJson(file).items || [], sql, { batch: SEED_BATCH });
      counts.sources = { ...(counts.sources || {}), [name]: r.saved };
      counts.items += r.saved;
      counts.rejected += r.rejected.length;
      if (r.rejected.length) log(`food seed: ${name}: ${r.rejected.length} records skipped, first: ${r.rejected[0].key} ${r.rejected[0].error}`);
    } catch (e) {
      log(`food seed: ${name} could not be read: ${e.message}`);
    }
  }
  log(`food seed: ${counts.items} catalogue records in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // The blueprint's food list, with what each requirement was matched to.
  const maps = new Map();
  for (const f of jsonIn(path.join(DATA, 'foods/map'))) for (const e of readJson(f)) if (e.req) maps.set(e.req, e);
  const foodReqs = readJson(path.join(DATA, 'food-requirements.json')).items;
  for (const r of foodReqs) {
    const m = maps.get(r.key);
    await sql`insert into food_requirements (key, list, category, category_label, priority, name, handling, type, status, records, issue, updated_at)
      values (${r.key}, 'food', ${r.category}, ${r.categoryLabel || ''}, ${r.priority || ''}, ${r.name}, ${r.handling || ''}, null,
        ${m ? m.status : 'gap'}, ${(m?.records || []).map((x) => x.key)}::text[], ${m ? m.note || '' : 'Not mapped yet.'}, now())
      on conflict (list, key) do update set category = excluded.category, category_label = excluded.category_label, priority = excluded.priority,
        name = excluded.name, handling = excluded.handling, status = excluded.status, records = excluded.records, issue = excluded.issue,
        updated_at = now()`;
    counts.foodRequirements += 1;
  }

  // The recipe starting points; coverage is worked out live from the recipes that name them.
  const recipeReqs = readJson(path.join(DATA, 'recipe-requirements.json')).items;
  for (const r of recipeReqs) {
    await sql`insert into food_requirements (key, list, category, category_label, priority, name, handling, type, status, records, issue, updated_at)
      values (${r.key}, 'recipe', ${r.family}, ${r.familyLabel || ''}, '', ${r.name}, ${r.rule || ''}, ${r.type}, 'open', '{}'::text[], '', now())
      on conflict (list, key) do update set category = excluded.category, category_label = excluded.category_label, name = excluded.name,
        handling = excluded.handling, type = excluded.type, updated_at = now()`;
    counts.recipeRequirements += 1;
  }

  // The recipe library: components first, so everything that uses them finds them.
  const recipes = loadRecipes();
  await sql.begin(async (tx) => {
    for (const r of recipes) counts.recipes[await seedRecipe(r, tx)] += 1;
  });
  log(`food seed: recipes ${JSON.stringify(counts.recipes)}`);

  await setKV('food_seed', { hash, at: new Date().toISOString(), counts });
  await logEvent('food_seeded', counts);
  return counts;
}

// At boot: seeds in the background when the data changed; failures are logged, never fatal.
export async function ensureFoodSeed() {
  return seedFood({ log: (m) => console.log(m) });
}
