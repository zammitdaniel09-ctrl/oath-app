// Checks catalogue files that are not built from USDA before they are seeded: branded products and chain
// menus (data/foods/brands/*.json) and whole datasets (data/foods/cofid.json, data/foods/ciqual.json).
// node scripts/check-brands.mjs [files...]   (no files: every brands file and both datasets)
//
// A file passes when every record has a valid unique key, a known category, nutrients only under Oath's
// keys and inside believable limits per 100, energy that fits its macros (EU factors), a source it was
// read from, and portions with a weight. Warnings flag things worth a look without failing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, NUTRIENT } from '../public/nutrition.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(repo, p).replace(/\\/g, '/');

// The food groups the rest of the catalogue uses (data/foods/usda-all.json); the tags read them.
export const CATEGORIES = [
  'Fruit', 'Vegetables', 'Legumes', 'Nuts and seeds', 'Potatoes', 'Herbs and spices', 'Rice, pasta and grains', 'Flour and baking',
  'Bread and rolls', 'Breakfast cereals', 'Biscuits and crackers', 'Cakes and pastries', 'Desserts', 'Sweets and chocolate', 'Snacks',
  'Sugar, syrups and spreads', 'Milk', 'Dairy', 'Cheese', 'Eggs', 'Plant milks', 'Beef', 'Pork', 'Lamb, veal and game', 'Poultry',
  'Sausages and cold cuts', 'Fish and shellfish', 'Fats and oils', 'Sauces and condiments', 'Soups', 'Ready meals', 'Mixed dishes',
  'Pizza', 'Sandwiches and burgers', 'Fast food', 'Restaurant meals', 'Drinks', 'Fruit juice', 'Coffee and tea', 'Water',
  'Alcoholic drinks', 'Supplements and powders', 'Baby food', 'Other',
];

const args = process.argv.slice(2);
const brandsDir = path.join(repo, 'data/foods/brands');
const files = args.length ? args.map((a) => path.resolve(a))
  : [...(fs.existsSync(brandsDir) ? fs.readdirSync(brandsDir).filter((f) => f.endsWith('.json')).map((f) => path.join(brandsDir, f)) : []),
    ...['data/foods/cofid.json', 'data/foods/ciqual.json'].map((f) => path.join(repo, f)).filter((f) => fs.existsSync(f))];

// Keys already taken by the seeded catalogue, so a new record never overwrites one.
const taken = new Set();
for (const f of ['data/foods/usda-foods.json', 'data/foods/usda-all.json', 'data/foods/placeholders.json']) {
  const p = path.join(repo, f);
  if (fs.existsSync(p)) for (const i of JSON.parse(fs.readFileSync(p, 'utf8')).items) taken.add(i.key);
}

const seen = new Map();
let errors = 0;
let warnings = 0;
let total = 0;
const err = (f, k, m) => { errors += 1; console.log(`ERROR ${rel(f)} ${k}: ${m}`); };
const warn = (f, k, m) => { warnings += 1; console.log(`warn  ${rel(f)} ${k}: ${m}`); };
const num = (x) => typeof x === 'number' && Number.isFinite(x);

for (const f of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    err(f, '-', `not valid JSON: ${e.message}`);
    continue;
  }
  const items = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(items)) {
    err(f, '-', 'needs { items: [...] }');
    continue;
  }
  const dataset = /cofid|ciqual/.test(path.basename(f));
  for (const it of items) {
    total += 1;
    const k = it?.key || '(no key)';
    if (!/^[a-z0-9][a-z0-9:._-]*$/.test(String(it?.key || ''))) err(f, k, 'key must be lower case a-z, 0-9 and : . _ -');
    if (seen.has(k)) err(f, k, `key also in ${rel(seen.get(k))}`);
    else seen.set(k, f);
    if (taken.has(k)) err(f, k, 'key already used by the USDA catalogue');
    if (!it.name || String(it.name).length > 160) err(f, k, 'needs a name (160 characters at most)');
    if (!CATEGORIES.includes(it.category)) err(f, k, `category "${it.category}" is not one of the catalogue's food groups`);
    if (!['g', 'ml'].includes(it.basis)) err(f, k, 'basis must be "g" or "ml"');
    if (it.basis === 'ml' && !it.liquid) err(f, k, 'a record per 100 ml must be liquid');
    if (!dataset && it.kind !== 'product') err(f, k, 'a branded record has kind "product"');
    if (!dataset && !it.brand) err(f, k, 'a branded record names its brand');
    if (!it.source || String(it.source).length > 20) err(f, k, 'needs a short source ("brand", "cofid", "ciqual")');
    if (!dataset && !/^https?:\/\//.test(String(it.source_ref || ''))) err(f, k, 'source_ref must be the URL the values were read from');
    const nut = it.nutrients || {};
    for (const key of Object.keys(nut)) if (!KEYS.includes(key)) err(f, k, `unknown nutrient "${key}"`);
    for (const key of KEYS) {
      const v = nut[key];
      if (v === null || v === undefined) continue;
      if (!num(v) || v < 0) { err(f, k, `${key} must be a number of 0 or more, or null`); continue; }
      const unit = NUTRIENT[key].unit;
      const cap = key === 'kcal' ? 950 : key === 'caffeine' ? 6000 : unit === 'g' ? 100 : unit === 'mg' ? 100000 : 1000000;
      if (v > cap) err(f, k, `${key} ${v} per 100 is not believable`);
    }
    if (!num(nut.kcal)) (dataset ? warn : err)(f, k, 'energy (kcal per 100) is unknown');
    const g = (x) => (num(nut[x]) ? nut[x] : 0);
    if (num(nut.protein) && num(nut.carbs) && num(nut.fat) && g('protein') + g('carbs') + g('fat') + g('fibre') + g('alcohol') > 105) err(f, k, 'macros add up to more than 100 g per 100');
    if (num(nut.sugars) && num(nut.carbs) && nut.sugars > nut.carbs + 1) warn(f, k, 'sugars above carbs');
    if (num(nut.satfat) && num(nut.fat) && nut.satfat > nut.fat + 0.5) err(f, k, 'saturates above fat');
    if ([nut.kcal, nut.protein, nut.carbs, nut.fat].every(num) && nut.kcal > 0) {
      const est = 4 * nut.protein + 4 * nut.carbs + 9 * nut.fat + 2 * g('fibre') + 7 * g('alcohol');
      if (Math.abs(est - nut.kcal) > Math.max(20, nut.kcal * 0.25)) (dataset ? warn : err)(f, k, `energy ${nut.kcal} kcal does not fit the macros (about ${Math.round(est)} kcal): check per 100 against per portion`);
    }
    for (const p of it.portions || []) if (!p.label || !(num(p.g) || num(p.ml))) err(f, k, 'each portion needs a label and g or ml');
    for (const s of ['serving', 'pack']) if (it[s] && !(num(it[s].size) && it[s].size > 0)) err(f, k, `${s} needs a size`);
  }
}
console.log(`${files.length} files, ${total} records, ${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
