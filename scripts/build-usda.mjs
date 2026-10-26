// Builds data/foods/usda-foods.json, the generic part of the catalogue, from the requirement maps in
// data/foods/map and the USDA FoodData Central downloads (public domain, kept outside the repo):
//   SR Legacy (April 2018) and Foundation Foods CSVs, indexed by ../tools/usda-index.mjs, plus the
//   SR28 ASCII release for refuse (the inedible share: banana skin, bones, stones).
// node scripts/build-usda.mjs [usda dir]   (default ../usda)
//
// Conversions, all deterministic and noted on the record:
// - Carbs are "available carbohydrate" as on EU labels: USDA's carbohydrate by difference minus fibre.
// - Salt is sodium × 2.5.
// - Density (g per ml) only from USDA's own volume portions (fl oz, cup, tbsp, tsp) on liquids and
//   pourable sauces, so drinks can be logged in ml without inventing a density.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usda = path.resolve(process.argv[2] || path.join(repo, '../usda'));
const index = new Map(JSON.parse(fs.readFileSync(path.join(usda, 'index.json'), 'utf8')).map((f) => [f.fdc_id, f]));

// Refuse from SR28: NDB number → { pct, desc }, then FDC id → NDB number from SR Legacy.
const refuse = new Map();
const desc = fs.readFileSync(path.join(usda, 'sr28/FOOD_DES.txt'), 'latin1');
for (const line of desc.split(/\r?\n/)) {
  const f = line.split('^').map((x) => x.replace(/^~|~$/g, ''));
  if (f.length > 9 && Number(f[8]) > 0) refuse.set(f[0], { pct: Number(f[8]), desc: f[7] });
}
const srDir = fs.readdirSync(path.join(usda, 'sr')).find((d) => d.startsWith('FoodData_Central_sr_legacy'));
const ndb = new Map();
for (const line of fs.readFileSync(path.join(usda, 'sr', srDir, 'sr_legacy_food.csv'), 'utf8').split(/\r?\n/).slice(1)) {
  const m = line.match(/^"(\d+)","(\d+)"/);
  if (m) ndb.set(Number(m[1]), m[2].padStart(5, '0'));
}

const ML = { 'fl oz': 29.5735, cup: 236.588, tbsp: 14.7868, tsp: 4.92892 };
const POURABLE = /\b(oil|vinegar|syrup|honey|sauce|ketchup|dressing|mayonnaise|cream|milk|juice|squash|cordial|soy|passata|puree|purée)\b/i;

function densityOf(food, liquid, name) {
  if (!liquid && !POURABLE.test(name)) return null;
  const order = liquid ? ['fl oz', 'cup', 'tbsp', 'tsp'] : ['tbsp', 'tsp'];
  for (const unit of order) {
    for (const p of food.portions) {
      const m = p.label.match(/^(\d+(?:\.\d+)?)\s*(fl oz|cup|tbsp|tsp)\b(.*)$/i);
      if (!m || m[2].toLowerCase() !== unit) continue;
      // A cup of something chopped or packed is not a measure of liquid.
      if (/chopped|sliced|diced|packed|pieces|whole|mashed|crushed|cubes|shredded|grated/i.test(m[3])) continue;
      const d = p.grams / (Number(m[1]) * ML[unit]);
      if (d > 0.5 && d < 2) return { density: Math.round(d * 10000) / 10000, from: `${p.label} = ${p.grams} g` };
    }
  }
  // One container described by its volume: "1 can 8.4 fl oz", "1 serving 12 fl oz", "240 ml".
  if (liquid) {
    for (const p of food.portions) {
      const oz = p.label.match(/^1\s+(?:can|bottle|serving|drink|glass|pouch|carton)\b[^\d]*(\d+(?:\.\d+)?)\s*fl oz\b/i);
      const ml = p.label.match(/^(?:1\s+\w+\s*)?\(?(\d+(?:\.\d+)?)\s*ml\b/i);
      const vol = oz ? Number(oz[1]) * ML['fl oz'] : ml ? Number(ml[1]) : null;
      if (!vol) continue;
      const d = p.grams / vol;
      if (d > 0.5 && d < 2) return { density: Math.round(d * 10000) / 10000, from: `${p.label} = ${p.grams} g` };
    }
  }
  return null;
}

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

const round = (v, d = 3) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

function nutrientsOf(n) {
  const fibre = n.fibre_g ?? null;
  const carbsBd = n.carbs_g ?? null;
  return {
    nutrients: {
      kcal: n.energy_kcal ?? null,
      protein: n.protein_g ?? null,
      carbs: carbsBd === null ? null : fibre === null ? carbsBd : Math.max(0, round(carbsBd - fibre)),
      sugars: n.sugars_g ?? null,
      fat: n.fat_g ?? null,
      satfat: n.sat_fat_g ?? null,
      fibre,
      salt: n.sodium_mg === undefined || n.sodium_mg === null ? null : round((n.sodium_mg * 2.5) / 1000, 4),
      caffeine: n.caffeine_mg ?? null,
      alcohol: n.alcohol_g ?? null,
    },
    carbsNote: carbsBd !== null && fibre === null ? 'Carbs include fibre here (USDA has no fibre value for this food).' : '',
  };
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
      const ref = sr ? refuse.get(ndb.get(r.fdc_id)) : null;
      const { nutrients, carbsNote } = nutrientsOf(food.nutrients);
      const liquid = Boolean(r.liquid);
      const dens = densityOf(food, liquid, `${r.name} ${food.description}`);
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
        category: r.category || (e.req ? e.req.split('/')[0] : file.replace(/\.json$/, '')),
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
if (problems.length) {
  console.log(`${problems.length} problems:\n${problems.join('\n')}`);
  process.exitCode = 1;
}
