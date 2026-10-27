// Builds data/foods/usda-all.json: the rest of the USDA catalogue, compact, beside the curated 900 in
// usda-foods.json. Every SR Legacy food, the newest version of each Foundation food and every FNDDS survey
// food, except the foods already in usda-foods.json (and, for Foundation, older or newer versions of those).
// node scripts/build-usda-all.mjs [usda dir]   (default ../usda; run tools/usda-index.mjs first)
//
// Records are keyed fdc-<id>, so a rebuild or a re-seed updates in place. Names, brands, aliases,
// categories, states and portion labels come from scripts/usda-names.mjs; numbers from scripts/usda-lib.mjs.
// Unknown stays null (and is left out of the file); nothing is guessed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nutrientsOf, nutrientProblems, densityOf, readRefuse, round, sig } from './usda-lib.mjs';
import { nameFood, groupOf, stateOf, liquidOf, portionLabel } from './usda-names.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usda = path.resolve(process.argv[2] || path.join(repo, '../usda'));
const index = JSON.parse(fs.readFileSync(path.join(usda, 'index.json'), 'utf8'));
const curated = JSON.parse(fs.readFileSync(path.join(repo, 'data/foods/usda-foods.json'), 'utf8')).items;
const curatedIds = new Set(curated.map((i) => Number(String(i.source_ref || '').replace('fdc:', ''))).filter(Boolean));

const refuse = readRefuse(path.join(usda, 'sr28/FOOD_DES.txt'), fs);

// Foundation Foods publish a food again in each release under a new fdc_id: keep the newest of each family
// (same description), and none of a family the curated set already uses.
const families = new Map();
for (const f of index.filter((x) => x.dataset === 'foundation_food')) {
  const k = f.description.toLowerCase().replace(/\s+/g, ' ').trim();
  const list = families.get(k) || [];
  list.push(f);
  families.set(k, list);
}
const foundation = [];
let familiesSkipped = 0;
for (const list of families.values()) {
  list.sort((a, b) => (b.pub || '').localeCompare(a.pub || '') || b.fdc_id - a.fdc_id);
  if (list.some((f) => curatedIds.has(f.fdc_id))) { familiesSkipped += 1; continue; }
  foundation.push(list[0]);
}

const LABEL = { sr_legacy_food: 'SR Legacy', foundation_food: 'Foundation Foods', survey_fndds_food: 'FNDDS survey foods' };
const pool = [...index.filter((f) => f.dataset === 'sr_legacy_food'), ...foundation, ...index.filter((f) => f.dataset === 'survey_fndds_food')];

const items = [];
const skipped = { curated: 0, noEnergy: 0 };
const problems = [];
const counts = { brands: 0, liquids: 0, density: 0, edible: 0 };
for (const food of pool) {
  if (curatedIds.has(food.fdc_id)) { skipped.curated += 1; continue; }
  const { nutrients, carbsNote } = nutrientsOf(food.nutrients, { rounded: true });
  if (nutrients.kcal === null) { skipped.noEnergy += 1; continue; }
  const bad = nutrientProblems(nutrients);
  if (bad.length) {
    problems.push(`${food.fdc_id} ${food.description}: ${bad.join(', ')}`);
    continue;
  }
  const names = nameFood(food);
  const group = groupOf(food, names.name, names.brand);
  const state = stateOf(food.description);
  const liquid = liquidOf(group, food.description);
  const dens = liquid ? densityOf(food, true, food.description, { units: ['fl oz', 'cup'], ml: false }) : null;

  // Portions: placeholders dropped, US units named as such, size words kept, no repeats.
  const seen = new Set();
  const portions = [];
  const many = food.portions.length > 1;
  for (const p of food.portions) {
    if (!(p.grams > 0)) continue;
    let label = portionLabel(p.label);
    if (!label) continue;
    if (/^1 serving$/i.test(label) && many) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    portions.push({ label, g: sig(p.grams) });
  }

  const ref = food.dataset === 'sr_legacy_food' ? refuse.get(food.ndb) : null;
  const product = Boolean(names.brand);
  const notes = [
    `${LABEL[food.dataset]}.`,
    product ? `US formulation, ${names.brand}: not the product sold in Malta.` : '',
    carbsNote,
    dens ? `Density from USDA portion ${dens.from}.` : '',
    ref ? `Refuse ${ref.pct}% (${ref.desc || 'inedible parts'}) from USDA SR28.` : '',
  ].filter(Boolean).join(' ');

  const item = {
    key: `fdc-${food.fdc_id}`,
    kind: product ? 'product' : 'generic',
    name: names.name,
    aliases: names.aliases,
    ...(product ? { brand: names.brand, market: 'US' } : {}),
    category: group,
    state,
    ...(liquid ? { liquid: true } : {}),
    nutrients: Object.fromEntries(Object.entries(nutrients).filter(([, v]) => v !== null)),
    portions: portions.slice(0, 16),
    ...(ref ? { edible: round(1 - ref.pct / 100, 4), refuse: ref.desc || 'inedible parts' } : {}),
    ...(dens ? { density: dens.density } : {}),
    source: 'usda',
    source_ref: `fdc:${food.fdc_id}`,
    source_date: food.dataset === 'sr_legacy_food' ? '2018-04' : (food.pub || '').slice(0, 7) || null,
    notes,
  };
  items.push(item);
  if (product) counts.brands += 1;
  if (liquid) counts.liquids += 1;
  if (dens) counts.density += 1;
  if (ref) counts.edible += 1;
}

const out = {
  source: 'USDA FoodData Central: SR Legacy (April 2018), Foundation Foods (newest version of each food) and FNDDS survey foods 2021-2023, public domain (CC0). Refuse from SR28.',
  built: new Date().toISOString().slice(0, 10),
  count: items.length,
  items,
};
const file = path.join(repo, 'data/foods/usda-all.json');
fs.writeFileSync(file, `${JSON.stringify(out)}\n`);

const by = (f) => items.reduce((a, i) => { const k = f(i); a[k] = (a[k] || 0) + 1; return a; }, {});
const bytes = fs.statSync(file).size;
console.log(`${items.length} records → ${file} (${(bytes / 1048576).toFixed(2)} MB)`);
console.log(`by dataset: ${JSON.stringify(by((i) => i.notes.match(/^([^.]*)\./)[1].trim()))}`);
console.log(`by kind: ${JSON.stringify(by((i) => i.kind))}`);
console.log(`skipped: ${skipped.curated} already curated, ${familiesSkipped} Foundation families used by the curated set, ${skipped.noEnergy} with no energy value, ${problems.length} failing the limits`);
console.log(`brands ${counts.brands}, liquids ${counts.liquids}, with density ${counts.density}, with refuse ${counts.edible}`);
if (problems.length) console.log(problems.slice(0, 20).join('\n'));
if (process.argv.includes('--groups')) console.log(JSON.stringify(by((i) => i.category), null, 1));
