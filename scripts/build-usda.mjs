// Builds data/foods/usda-foods.json, the curated generic part of the catalogue, from the requirement maps in
// data/foods/map and the USDA FoodData Central downloads (public domain, kept outside the repo):
//   SR Legacy (April 2018) and Foundation Foods CSVs, indexed by ../tools/usda-index.mjs, plus the
//   SR28 ASCII release for refuse (the inedible share: banana skin, bones, stones).
// node scripts/build-usda.mjs [usda dir]   (default ../usda)
// The rest of USDA is built by scripts/build-usda-all.mjs, which skips every food in this file.
//
// Conversions are in scripts/usda-lib.mjs, all deterministic and noted on the record:
// - Carbs are "available carbohydrate" as on EU labels: USDA's carbohydrate by difference minus fibre.
// - Salt is sodium × 2.5.
// - Every nutrient on the NUTRIENTS list is taken where USDA has it (minerals, vitamins, fat types,
//   cholesterol, added sugars); unknown stays null.
// - Density (g per ml) only from USDA's own volume portions (fl oz, cup, tbsp, tsp) on liquids and
//   pourable sauces, so drinks can be logged in ml without inventing a density.
// - The category is a readable group worked out from USDA's own category and the food's description.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nutrientsOf, nutrientProblems, densityOf, readRefuse, round } from './usda-lib.mjs';
import { groupOf } from './usda-names.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usda = path.resolve(process.argv[2] || path.join(repo, '../usda'));
const index = new Map(JSON.parse(fs.readFileSync(path.join(usda, 'index.json'), 'utf8')).map((f) => [f.fdc_id, f]));
const refuse = readRefuse(path.join(usda, 'sr28/FOOD_DES.txt'), fs);

const POURABLE = /\b(oil|vinegar|syrup|honey|sauce|ketchup|dressing|mayonnaise|cream|milk|juice|squash|cordial|soy|passata|puree|purée)\b/i;

// USDA portion labels, kept as USDA wrote them apart from naming US cups and dropping sample-size noise.
function portionsOf(food) {
  const out = [];
  const seen = new Set();
  for (const p of food.portions) {
    if (!(p.grams > 0)) continue;
    let label = p.label.replace(/\s+/g, ' ').trim();
    if (/^(portion|1 serving)$/i.test(label) && food.portions.length > 1) continue;
    label = label.replace(/^(\d+(?:\.\d+)?) cup\b/i, '$1 US cup').replace(/NLEA serving/i, 'serving (US label size)');
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, g: p.grams, source: 'usda' });
  }
  return out.slice(0, 12);
}

const files = fs.readdirSync(path.join(repo, 'data/foods/map')).filter((f) => f.endsWith('.json')).sort();
const items = new Map();
const problems = [];
let entries = 0;
for (const file of files) {
  const list = JSON.parse(fs.readFileSync(path.join(repo, 'data/foods/map', file), 'utf8'));
  for (const e of list) {
    entries += 1;
    for (const r of e.records || []) {
      const food = index.get(r.fdc_id);
      if (!food) { problems.push(`${file}: ${r.key} → fdc ${r.fdc_id} not in the index`); continue; }
      if (food.nutrients.energy_kcal === null || food.nutrients.energy_kcal === undefined) problems.push(`${r.key}: no energy value`);
      const prior = items.get(r.key);
      if (prior) {
        if (prior.source_ref !== `fdc:${r.fdc_id}`) problems.push(`${r.key}: used twice for different foods`);
        if (e.req && !prior.req.includes(e.req)) prior.req.push(e.req);
        continue;
      }
      const sr = food.dataset !== 'foundation_food';
      const ref = sr ? refuse.get(food.ndb) : null;
      const { nutrients, carbsNote } = nutrientsOf(food.nutrients);
      for (const bad of nutrientProblems(nutrients)) problems.push(`${r.key}: ${bad}`);
      const liquid = Boolean(r.liquid);
      const dens = densityOf(food, liquid, `${r.name} ${food.description}`, { pourable: POURABLE });
      const product = r.kind === 'product';
      const notes = [
        `USDA: ${food.description} (FDC ${r.fdc_id}, ${sr ? 'SR Legacy' : 'Foundation Foods'}).`,
        product ? `US formulation, ${r.brand || 'branded'}: not the product sold in Malta.` : '',
        e.status === 'estimate' && e.note ? `Estimate: ${e.note}` : '',
        carbsNote,
        dens ? `Density from USDA portion ${dens.from}.` : '',
        ref ? `Refuse ${ref.pct}% (${ref.desc || 'inedible parts'}) from USDA SR28.` : '',
      ].filter(Boolean).join(' ');
      items.set(r.key, {
        key: r.key,
        kind: product ? 'product' : e.status === 'estimate' ? 'estimate' : 'generic',
        name: r.name,
        aliases: r.aliases || [],
        brand: product ? r.brand || null : null,
        market: product ? r.market || 'US' : null,
        category: groupOf(food, r.name, product ? r.brand || 'brand' : null),
        state: r.state || null,
        basis: 'g',
        liquid,
        nutrients,
        portions: portionsOf(food),
        edible: ref ? round(1 - ref.pct / 100, 4) : null,
        refuse: ref ? ref.desc || 'inedible parts' : null,
        density: dens ? dens.density : null,
        source: 'usda',
        source_ref: `fdc:${r.fdc_id}`,
        source_date: sr ? '2018-04' : '2026-04',
        status: e.status === 'partial' ? 'partial' : 'ok',
        notes,
        req: e.req ? [e.req] : [],
      });
    }
  }
}

const out = {
  source: 'USDA FoodData Central: SR Legacy (April 2018) and Foundation Foods (April 2026), public domain (CC0). Refuse from SR28.',
  built: new Date().toISOString().slice(0, 10),
  count: items.size,
  items: [...items.values()].sort((a, b) => a.key.localeCompare(b.key)),
};
fs.writeFileSync(path.join(repo, 'data/foods/usda-foods.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`${entries} requirement entries in ${files.length} map files → ${items.size} records`);
console.log(`with refuse: ${out.items.filter((i) => i.edible).length}, with density: ${out.items.filter((i) => i.density).length}, liquids: ${out.items.filter((i) => i.liquid).length}`);
const groups = {};
for (const i of out.items) groups[i.category] = (groups[i.category] || 0) + 1;
console.log(`categories: ${JSON.stringify(groups)}`);
if (problems.length) {
  console.log(`${problems.length} problems:\n${problems.join('\n')}`);
  process.exitCode = 1;
}
