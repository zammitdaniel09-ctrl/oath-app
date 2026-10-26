// Checks the recipe library in data/recipes against the catalogue before it is seeded.
// node scripts/check-recipes.mjs [--list] [files...]
//
// A recipe passes when every ingredient resolves to a catalogue record or another recipe, every amount
// is positive and in a unit that record supports, the method names every ingredient (by its `label`),
// a yield is declared, sub-recipes have no loops, nutrition adds up with energy known, and keys and
// names are unique. Warnings flag things worth a look without failing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recipeTotals, resolve, norm, round } from '../public/nutrition.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const list = args.includes('--list');
const only = args.filter((a) => !a.startsWith('--'));

const catalogue = JSON.parse(fs.readFileSync(path.join(repo, 'data/foods/usda-foods.json'), 'utf8')).items;
const holders = JSON.parse(fs.readFileSync(path.join(repo, 'data/foods/placeholders.json'), 'utf8')).items;
const items = new Map([...catalogue, ...holders].map((i) => [i.key, i]));
const reqs = new Set(JSON.parse(fs.readFileSync(path.join(repo, 'data/recipe-requirements.json'), 'utf8')).items.map((r) => r.key));

const TYPES = ['base', 'variant', 'component', 'template'];
const dir = path.join(repo, 'data/recipes');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && (!only.length || only.some((o) => f.includes(o)))).sort();
const recipes = new Map();
const errors = [];
const warnings = [];
const err = (k, m) => errors.push(`${k}: ${m}`);
const warn = (k, m) => warnings.push(`${k}: ${m}`);

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (e) {
    err(file, `not valid JSON (${e.message})`);
    continue;
  }
  for (const r of Array.isArray(data) ? data : data.recipes || []) {
    if (recipes.has(r.key)) err(r.key, `duplicate key (also in ${recipes.get(r.key).file})`);
    recipes.set(r.key, { ...r, file });
  }
}

const get = { item: (k) => items.get(k), recipe: (k) => recipes.get(k) };
const names = new Map();
const counts = {};
for (const r of recipes.values()) {
  if (only.length && !files.includes(r.file)) continue;
  const k = r.key || '(no key)';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(r.key || '')) err(k, 'key must be lowercase-hyphen');
  if (!r.name) err(k, 'no name');
  if (!TYPES.includes(r.type)) err(k, `type must be one of ${TYPES.join(', ')}`);
  if (!r.family) err(k, 'no family');
  if (!(r.servings > 0)) err(k, 'servings must be more than zero');
  if (r.final_weight !== undefined && r.final_weight !== null && !(r.final_weight > 0)) err(k, 'final_weight must be positive or null');
  if (r.type === 'variant' && !recipes.has(r.parent_key)) err(k, `variant without a known parent_key (${r.parent_key})`);
  if (r.type !== 'variant' && r.parent_key) err(k, 'only variants have a parent_key');
  for (const q of r.req || []) if (!reqs.has(q)) err(k, `unknown requirement ${q}`);
  if (!Array.isArray(r.lines) || !r.lines.length) err(k, 'no ingredients');
  const method = (r.method || []).join(' ').toLowerCase();
  if (r.type !== 'template' && (r.method || []).length < 2) err(k, 'method needs at least two steps');
  for (const [i, l] of (r.lines || []).entries()) {
    const at = `${k} line ${i + 1}`;
    if (!(l.qty > 0)) err(at, 'qty must be more than zero');
    if (!l.label) err(at, 'label (the ingredient as the method names it) is missing');
    else if (r.type !== 'template' && !method.includes(String(l.label).toLowerCase())) err(at, `the method never mentions "${l.label}"`);
    if (l.ref === 'recipe') {
      const sub = recipes.get(l.ref_key);
      if (!sub) err(at, `unknown recipe ${l.ref_key}`);
      else if (!['serving', 'g', 'share'].includes(l.unit)) err(at, `sub-recipe unit must be serving, g or share, not ${l.unit}`);
      else if (l.unit === 'g' && !(sub.final_weight > 0)) err(at, `${l.ref_key} has no final_weight, so use servings`);
    } else {
      const it = items.get(l.ref_key);
      if (!it) err(at, `unknown food ${l.ref_key}`);
      else {
        const res = resolve(it, l.qty || 1, l.unit);
        if (res.error) err(at, `${l.ref_key} ${l.qty} ${l.unit}: ${res.error}`);
        if (it.status === 'needs-label') warn(at, `${l.ref_key} has no values until a label is added, so this total is incomplete`);
        else if (it.kind === 'product') warn(at, `${l.ref_key} is a US branded reference`);
      }
    }
  }
  try {
    const t = recipeTotals(r, get);
    for (const e of t.errors) err(k, e);
    if (t.nutrients.kcal === null) err(k, 'energy unknown');
    const per = t.perServing?.kcal;
    if (per !== null && per !== undefined && (per < 5 || per > 2500)) warn(k, `${round(per, 0)} kcal per serving looks off`);
    if (list) console.log(`${r.type.padEnd(9)} ${k.padEnd(44)} ${String(round(per, 0)).padStart(5)} kcal/serving  ${r.name}`);
  } catch (e) {
    err(k, e.message);
  }
  const nn = norm(r.name);
  if (names.has(nn)) warn(k, `same name as ${names.get(nn)}`);
  names.set(nn, k);
  counts[r.type] = (counts[r.type] || 0) + 1;
}

const covered = new Set([...recipes.values()].flatMap((r) => r.req || []));
console.log(`${files.length} files, ${[...recipes.values()].filter((r) => !only.length || files.includes(r.file)).length} recipes:`, counts);
console.log(`requirements covered: ${covered.size} of ${reqs.size}`);
if (warnings.length) console.log(`\n${warnings.length} warnings:\n${warnings.join('\n')}`);
if (errors.length) {
  console.log(`\n${errors.length} errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
} else console.log('\nno errors');
