// Finds catalogue records for recipe writing: node scripts/find-food.mjs "words" [limit]
// Prints key | name | state | how it can be measured (g, ml, whole, USDA portions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm, unitsFor } from '../public/nutrition.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The UK and French tables and the branded files, when present, can be used too.
const more = ['data/foods/cofid.json', 'data/foods/ciqual.json', ...(fs.existsSync(path.join(repo, 'data/foods/brands')) ? fs.readdirSync(path.join(repo, 'data/foods/brands')).filter((f) => f.endsWith('.json')).map((f) => `data/foods/brands/${f}`) : [])]
  .map((f) => path.join(repo, f)).filter((f) => fs.existsSync(f)).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).items || []);
const items = [...JSON.parse(fs.readFileSync(path.join(repo, 'data/foods/usda-foods.json'), 'utf8')).items,
  ...JSON.parse(fs.readFileSync(path.join(repo, 'data/foods/placeholders.json'), 'utf8')).items, ...more];
const words = norm(process.argv[2] || '').split(' ').filter(Boolean);
const limit = Number(process.argv[3] || 25);
const hits = items.filter((i) => words.every((w) => norm(`${i.key} ${i.name} ${(i.aliases || []).join(' ')}`).includes(w))).slice(0, limit);
for (const i of hits) {
  const units = unitsFor(i).map((u) => u.unit).join(', ');
  console.log(`${i.key} | ${i.name} | ${i.state || ''}${i.kind !== 'generic' ? ` | ${i.kind}` : ''} | ${Math.round(i.nutrients.kcal ?? -1)} kcal/100g | units: ${units}`);
}
if (!hits.length) console.log('no match');
