// Builds data/foods/ciqual.json: the French food composition table Ciqual (ANSES), one generic record per food.
// node scripts/build-ciqual.mjs [ciqual xml dir]   (default ../sources/ciqual/2025-xml, outside the repo)
//
// Source: ANSES, Table de composition nutritionnelle des aliments Ciqual 2025 (published 19 November 2025,
// 3484 foods, 74 constituents), Licence Ouverte / Etalab 2.0. Official download, XML files:
//   https://doi.org/10.57745/RDMHWY  (recherche.data.gouv.fr, which replaces the Ciqual 2020 entry on data.gouv.fr)
//   alim_*.xml (foods), alim_grp_*.xml (groups), compo_*.xml (values), const_*.xml (constituents).
// The script finds the files by prefix, so the 2020 edition's XML (alim_2020_07_07.xml ...) reads the same way;
// the edition year comes from the compo file's date, or --year=YYYY.
//
// Values are per 100 g of edible part, also for drinks, so every record has basis "g" (drinks are flagged liquid).
// How a published value becomes a number:
//   "12,5"     -> 12.5        (decimal comma)
//   "traces"   -> 0
//   "-" / ""   -> null        (not measured)
//   "< 0,5"    -> null        (below a detection or quantification limit: unknown, never 0 and never the limit)
// Mapping to Oath's keys (code = Ciqual const_code):
//   kcal 328 (energy, Regulation EU 1169/2011, kcal), else 327 (kJ) / 4.184
//   protein 25000 (N x Jones' factor), carbs 31000 (available carbohydrate, no fibre), sugars 32000,
//   fibre 34100, fat 40000, satfat 40302, mufa 40303, pufa 40304, chol 75100, alcohol 60000 (g per 100 g),
//   salt 10004, else sodium 10110 x 2.5 / 1000,
//   potassium 10190, calcium 10200, iron 10260, magnesium 10120, zinc 10300, phosphorus 10150, selenium 10340,
//   vita = retinol 51200 + beta-carotene 51330 / 6 (µg retinol equivalent) only when both are known; else null.
//     (51104 "vitamin A activity" is not used: in this edition it is retinol + beta-carotene/6 for some foods and
//     /12 for others.)
//   vitc 55100, vitd 52100, vite 53100, else alpha-tocopherol 71010 (the two are never both given for a food),
//   vitk 54101 (K1 only), b1 56100, b2 56200, b3 56310, b6 56500, folate 56700 (total folates, µg), b12 56600.
//   caffeine, transfat and addsugars: null (Ciqual does not publish them).
// Unknown stays null. Records with no energy value are kept with status "incomplete".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, NUTRIENT } from '../public/nutrition.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(repo, '../sources/ciqual/2025-xml'));
const fileOf = (prefix) => {
  const f = fs.readdirSync(dir).find((x) => new RegExp(`^${prefix}_\\d{4}_\\d{2}_\\d{2}\\.xml$`, 'i').test(x));
  if (!f) throw new Error(`no ${prefix}_YYYY_MM_DD.xml in ${dir}`);
  return path.join(dir, f);
};
const files = { alim: fileOf('alim'), grp: fileOf('alim_grp'), compo: fileOf('compo'), cons: fileOf('const') };
const yearArg = args.find((a) => a.startsWith('--year='));
const YEAR = yearArg ? yearArg.slice(7) : path.basename(files.compo).match(/_(\d{4})_/)[1];
const OUT = path.join(repo, 'data/foods/ciqual.json');

// ---------- XML (flat records, no npm) ----------
const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
function records(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([^]*?)</${tag}>`, 'g');
  for (const m of xml.matchAll(re)) {
    const r = {};
    for (const f of m[1].matchAll(/<(\w+)(?:\s+missing="[^"]*")?\s*(?:\/>|>([^<]*)<\/\1>)/g)) r[f[1]] = f[2] === undefined ? null : decode(f[2]).trim();
    out.push(r);
  }
  return out;
}

// ---------- constituents ----------
// code -> what it must be called in const_*.xml (checked, so a renumbered edition fails loudly instead of mis-mapping).
const CONST = {
  327: /^Energy, Regulation EU No 1169\/2011 \(kJ\/100 ?g\)/i,
  328: /^Energy, Regulation EU No 1169\/2011 \(kcal\/100 ?g\)/i,
  10004: /^Salt/i, 10110: /^Sodium/i, 10120: /^Magnesium/i, 10150: /^Phosphorus/i, 10190: /^Potassium/i, 10200: /^Calcium/i,
  10260: /^Iron/i, 10300: /^Zinc/i, 10340: /^Selenium/i,
  25000: /^Protein \(g/i, 31000: /^Carbohydrate/i, 32000: /^Sugars/i, 34100: /^Fib/i, 40000: /^Fat/i,
  40302: /^FA saturated/i, 40303: /^FA mono/i, 40304: /^FA poly/i, 60000: /^Alcohol/i, 75100: /^Cholesterol/i,
  51200: /^Retinol/i, 51330: /^Beta-carotene/i, 52100: /^Vitamin D \(/i, 53100: /^Vitamin E/i, 71010: /^Alpha-tocopherol/i,
  54101: /^Vitamin K1/i, 55100: /^Vitamin C/i, 56100: /^Vitamin B1/i, 56200: /^Vitamin B2/i, 56310: /^Vitamin B3/i,
  56500: /^Vitamin B6/i, 56600: /^Vitamin B12/i, 56700: /^Vitamin B9 or total folates \(/i,
  34000: /^Polyols/i, // not an Oath key: only read for a note on foods whose energy runs below their carbs
};
// Plain one-to-one copies: Oath key <- Ciqual code.
const DIRECT = {
  protein: 25000, carbs: 31000, sugars: 32000, fibre: 34100, fat: 40000, satfat: 40302, mufa: 40303, pufa: 40304,
  chol: 75100, alcohol: 60000, potassium: 10190, calcium: 10200, iron: 10260, magnesium: 10120, zinc: 10300,
  phosphorus: 10150, selenium: 10340, vitc: 55100, vitd: 52100, vitk: 54101, b1: 56100, b2: 56200, b3: 56310,
  b6: 56500, folate: 56700, b12: 56600,
};
const constNames = new Map(records(read(files.cons), 'CONST').map((c) => [Number(c.const_code), c.const_nom_eng || '']));
const absent = [];
for (const [code, re] of Object.entries(CONST)) {
  const name = constNames.get(Number(code));
  if (name === undefined) absent.push(Number(code));
  else if (!re.test(name)) throw new Error(`constituent ${code} is "${name}", expected ${re}`);
}
for (const required of [328, 25000, 31000, 40000]) if (absent.includes(required)) throw new Error(`constituent ${required} missing from ${files.cons}`);

// ---------- groups -> catalogue categories ----------
// Ciqual group (2 digits), subgroup (4) or sub-subgroup (6) -> closest catalogue category. The most specific code
// listed wins; refine() then moves single foods by their name (juices, crisps, pizza, offal by animal ...).
const GROUP = {
  '0101': 'Mixed dishes', // mixed salads
  '0102': 'Soups',
  '0103': 'Mixed dishes', // dishes (prepacked ones -> Ready meals, below)
  '0104': 'Mixed dishes', // pizzas, crepes and pies (pizza -> Pizza, below)
  '0105': 'Sandwiches and burgers',
  '0106': 'Mixed dishes', // savoury pastries and other starters
  '0201': 'Vegetables',
  '0202': 'Potatoes', // potatoes and other tubers (crisps -> Snacks, below)
  '0203': 'Legumes',
  '0204': 'Fruit', // fresh, puréed, canned, dried (juices -> Fruit juice, below)
  '0205': 'Nuts and seeds',
  '0301': 'Rice, pasta and grains',
  '0302': 'Bread and rolls', // breads and rusks
  '0303': 'Snacks', // savoury biscuits and salty snacks (crackers -> Biscuits and crackers, below)
  '0304': 'Flour and baking',
  '0305': 'Flour and baking', // pastry dough
  '0401': 'Other', // cooked meat, averages over several animals (by animal, below)
  '040101': 'Beef', '040201': 'Beef', // beef and veal (veal -> Lamb, veal and game, below)
  '040102': 'Pork', '040202': 'Pork',
  '040103': 'Poultry', '040203': 'Poultry',
  '040104': 'Poultry', '040204': 'Poultry', // turkey
  '040105': 'Lamb, veal and game', '040205': 'Lamb, veal and game', // lamb and mutton
  '040106': 'Lamb, veal and game', '040206': 'Lamb, veal and game', // game
  '040107': 'Lamb, veal and game', '040207': 'Lamb, veal and game', // other meats: horse, kid, rabbit (birds -> Poultry)
  '040108': 'Other', '040208': 'Other', // offal (by animal, below)
  '0403': 'Sausages and cold cuts', // delicatessen meats, including plant-based ones
  '0404': 'Other', // other meat products (by animal, below)
  '0405': 'Fish and shellfish', '0406': 'Fish and shellfish', '0407': 'Fish and shellfish', '0408': 'Fish and shellfish',
  '0409': 'Fish and shellfish',
  '0410': 'Eggs',
  '0411': 'Other', // plant-based alternatives to meat
  '050101': 'Milk', '050102': 'Milk', '050103': 'Dairy', // liquid milk; concentrated or powdered milk
  '050201': 'Dairy', '050202': 'Dairy', // yoghurts, fromages blancs
  '050203': 'Desserts', '050204': 'Desserts', '050205': 'Desserts', // dairy, other and plant-based desserts
  '0503': 'Cheese', // including plant-based alternatives
  '0504': 'Dairy', // cream
  '0601': 'Water',
  '060201': 'Fruit juice', '060202': 'Fruit juice', // juices (fruit and vegetable), nectars
  '060203': 'Drinks', // soft drinks
  '060204': 'Drinks', // dairy drinks (flavoured milk -> Milk, below)
  '060205': 'Plant milks', // plant-based drinks (coconut water -> Drinks, below)
  '060206': 'Coffee and tea', // coffee, tea, cocoa ready to drink (cocoa -> Drinks, below)
  '060207': 'Drinks', // to reconstitute: syrups, cocoa powder (coffee, tea, chicory -> Coffee and tea, below)
  '0603': 'Alcoholic drinks',
  '0701': 'Sugar, syrups and spreads', // sugars, honey, sweeteners
  '0702': 'Sweets and chocolate',
  '0703': 'Sweets and chocolate',
  '0704': 'Sugar, syrups and spreads', // jam
  '0705': 'Cakes and pastries', // Viennese pastries
  '0706': 'Biscuits and crackers', // sweet biscuits
  '0707': 'Breakfast cereals',
  '0708': 'Snacks', // cereal bars
  '0709': 'Cakes and pastries',
  '08': 'Desserts', // ice cream, sorbet, frozen desserts
  '09': 'Fats and oils',
  '1001': 'Sauces and condiments',
  '1002': 'Sauces and condiments', // condiments (olives -> Fruit, below)
  '1003': 'Flour and baking', // cooking aids: yeast, raising agents, gelatin (stocks, bran, syrups ... below)
  '1004': 'Herbs and spices', // salts
  '1005': 'Herbs and spices',
  '1006': 'Herbs and spices',
  '1007': 'Vegetables', // seaweed
  '1008': 'Supplements and powders', // meal replacements
  '1009': 'Legumes', // tofu, tempeh, soy protein (seitan, soy cream below)
  '1010': 'Sauces and condiments', // dips and plant-based spreads (hummus -> Legumes, below)
  '11': 'Baby food',
};
const groupOf = (f) => GROUP[f.alim_ssssgrp_code] || GROUP[f.alim_ssgrp_code] || GROUP[f.alim_grp_code] || 'Other';

function byAnimal(n, fallback) {
  if (/\b(chicken|turkey|poultry|duck|goose|capon|quail|pigeon|guinea fowl|ostrich|gizzards?)\b/.test(n)) return 'Poultry';
  if (/\b(veal|calf|lamb|mutton|sheep|kid|rabbit|horse|venison|deer|boar|hare)\b/.test(n)) return 'Lamb, veal and game';
  if (/\b(pork|pig)\b/.test(n)) return 'Pork';
  if (/\b(beef|heifer|ox|bull)\b/.test(n)) return 'Beef';
  return fallback;
}

function refine(cat, f, name) {
  const n = name.toLowerCase();
  const sg = f.alim_ssgrp_code;
  const ssg = f.alim_ssssgrp_code;
  if (sg === '0103' && /\b(prepacked|canned)\b/.test(n)) return 'Ready meals';
  if (sg === '0104' && /\bpizza\b/.test(n)) return 'Pizza';
  if (sg === '0202' && /\bcrisps\b/.test(n)) return 'Snacks';
  if (sg === '0201' && /\bjuice\b/.test(n)) return 'Fruit juice';
  if (sg === '0204' && /\b(juice|nectar)\b/.test(n)) return 'Fruit juice';
  if (sg === '0303' && /\b(crackers?|grissini|bread stick)\b/.test(n) && !/prawn crackers/.test(n)) return 'Biscuits and crackers';
  if (sg === '0401' && ssg === '000000') return /poultry|white/.test(n) ? (/poultry/.test(n) ? 'Poultry' : 'Other') : 'Other';
  if (['040101', '040201'].includes(ssg) && /\b(veal|calf)\b/.test(n)) return 'Lamb, veal and game';
  if (['040107', '040207'].includes(ssg)) return byAnimal(n, cat);
  if (['040108', '040208'].includes(ssg) || sg === '0404') return /sausage/.test(n) ? 'Sausages and cold cuts' : byAnimal(n, 'Other');
  if (ssg === '050204' && /eggnog/.test(n)) return 'Drinks';
  if (ssg === '060204' && /\bflavoured milk\b/.test(n)) return 'Milk';
  if (ssg === '060205' && /coconut water/.test(n)) return 'Drinks';
  if (ssg === '060206' && /\b(cocoa|chocolate)\b/.test(n)) return 'Drinks';
  if (ssg === '060207' && /\b(coffee|tea|chicory)\b/.test(n)) return 'Coffee and tea';
  if (sg === '0603' && /alcohol-free|non-alcoholic|without alcohol/.test(n)) return 'Drinks';
  if (sg === '1002' && /^olives?\b/.test(n)) return 'Fruit';
  if (sg === '1003') {
    if (/\b(broth|stock)\b/.test(n)) return 'Soups';
    if (/tomato sauce|tapenade|aspic/.test(n)) return 'Sauces and condiments';
    if (/\bpizza\b/.test(n)) return 'Pizza';
    if (/\b(bran|germ)\b/.test(n)) return 'Rice, pasta and grains';
    if (/\bsyrup\b|yeast extract spread/.test(n)) return 'Sugar, syrups and spreads';
    if (/coconut milk/.test(n)) return 'Nuts and seeds';
    if (/royal jelly|pollen/.test(n)) return 'Supplements and powders';
    if (/\b(wine|rum)\b/.test(n)) return 'Other';
  }
  if (sg === '1009' && /seitan/.test(n)) return 'Other';
  if (sg === '1009' && /cream/.test(n)) return 'Dairy';
  if (sg === '1010' && /hummus/.test(n)) return 'Legumes';
  return cat;
}

// Drinks, milks, juices and soups are liquids; powders, concentrates and syrups to dilute are not.
function liquidOf(cat, f, name) {
  const n = name.toLowerCase();
  const sg = f.alim_ssgrp_code;
  const ssg = f.alim_ssssgrp_code;
  if (ssg === '060207') return false;
  if (/\b(powder|dehydrated|tablets?)\b/.test(n) && !/reconstituted|ready[- ]to[- ]drink|diluted in water/.test(n)) return false;
  if (f.alim_grp_code === '06') return true;
  if (['050101', '050102'].includes(ssg) || cat === 'Soups') return true;
  if (cat === 'Fruit juice') return true;
  if (sg === '1101') return /\b(milk|beverage|drink)\b/.test(n);
  if (sg === '1008') return /ready-to-drink|reconstituted/.test(n) && !/dessert/.test(n);
  if (/^(eggnog|coconut milk)\b/.test(n)) return true;
  return false;
}

// State from the name: Ciqual puts it in its own comma-separated part ("..., raw", "..., boiled/cooked in water").
// The first part is the food itself, so a cooking word there counts only when it leads ("Cooked ham", "Baked
// Alaska"), not in "Sauce for fried spring rolls" or "Syrup for canned fruits". "Pre-fried" is how a frozen
// product was made, not how it is eaten.
const STATE_WORD = /^(cooked|baked|stewed|roasted|fried|grilled|boiled|steamed|braised|dried|canned)\b/;
function stateOf(name, f) {
  const parts = name.toLowerCase().split(/,\s*/).map((p) => p.trim());
  const tail = parts.slice(STATE_WORD.test(parts[0]) ? 0 : 1);
  const s = tail.join(', ').replace(/\bpre-fried\b/g, '');
  if (/\bcanned\b/.test(s)) return 'canned';
  if (tail.some((p) => /^(raw|aw|uncooked)\b/.test(p))) return 'raw'; // "aw": a typo for raw in one source name
  if (/grilled\/pan-fried/.test(s)) return 'grilled';
  if (/\b(boiled|poached|simmered)\b|cooked in water/.test(s)) return 'boiled';
  if (/\b(deep-fried|pan-fried|stir-fried|sautéed|fried)\b/.test(s)) return 'fried';
  if (/\bdry-(grilled|roasted)\b|\broasted\b/.test(s)) return 'roasted';
  if (/\bbaked\b/.test(s)) return 'baked';
  if (/\b(grilled|barbecued|broiled)\b/.test(s)) return 'grilled';
  if (/\b(cooked|steamed|braised|stewed|microwaved|toasted|reheated)\b/.test(s) && !/to be reheated|to cook\b/.test(s)) return 'cooked';
  if (/\b(dried|dehydrated|freeze-dried)\b/.test(s) && !/reconstituted/.test(s)) return 'dried';
  if (f.alim_grp_code !== '06' && tail.some((p) => p === 'dry')) return 'dried';
  return 'as-sold';
}

// Names: entities decoded, spacing around commas and brackets tidied, first letter upper case; words kept.
function tidy(s) {
  return String(s || '')
    .replace(/\s*-\s*>\s*ARCHIVE\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,(\s*,)+/g, ',')
    .replace(/,\s*\)/g, ')')
    .replace(/,(?=[^\s\d])/g, ', ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}
const sentence = (s) => s.charAt(0).toLocaleUpperCase('en') + s.slice(1);
// English names write decimals with a point ("Milk, 1.2% fat"); the French alias keeps its comma.
const english = (s) => s.replace(/(\d),(\d)/g, '$1.$2');

// ---------- values ----------
const below = { n: 0 };
function value(raw) {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  if (v === '' || v === '-') return null;
  if (/^traces$/i.test(v)) return 0;
  if (v.startsWith('<')) return null;
  const x = Number(v.replace(',', '.'));
  if (!Number.isFinite(x)) throw new Error(`unreadable value "${raw}"`);
  return x;
}
const r4 = (x) => (x === null ? null : Math.round(x * 1e4) / 1e4);

// ---------- read ----------
const foods = records(read(files.alim), 'ALIM');
const compo = new Map();
for (const c of records(read(files.compo), 'COMPO')) {
  const code = Number(c.const_code);
  if (!CONST[code]) continue;
  const a = c.alim_code;
  if (!compo.has(a)) compo.set(a, {});
  compo.get(a)[code] = c.teneur ?? null;
}

const LABELS = { 10004: 'salt', 10110: 'sodium', 51200: 'retinol', 51330: 'beta-carotene', 53100: 'vitamin E', 71010: 'alpha-tocopherol', 327: 'energy (kJ)', 328: 'energy (kcal)' };
for (const [k, c] of Object.entries(DIRECT)) LABELS[c] = NUTRIENT[k].label.replace(/^[A-Z](?=[a-z])/, (x) => x.toLowerCase());

const items = [];
const stats = { saltFromSodium: 0, kcalFromKj: 0, vitaKnown: 0, viteFromAlpha: 0, incomplete: 0, liquids: 0 };
for (const f of foods) {
  const raw = compo.get(f.alim_code) || {};
  const val = (code) => value(raw[code]);
  const isBelow = (code) => typeof raw[code] === 'string' && raw[code].trim().startsWith('<');
  const notes = [];

  const n = Object.fromEntries(KEYS.map((k) => [k, null]));
  for (const [k, code] of Object.entries(DIRECT)) n[k] = val(code);

  n.kcal = val(328);
  if (n.kcal === null && val(327) !== null) {
    n.kcal = r4(val(327) / 4.184);
    notes.push('Energy from kJ / 4.184.');
    stats.kcalFromKj += 1;
  }
  n.salt = val(10004);
  if (n.salt === null && val(10110) !== null) {
    n.salt = r4((val(10110) * 2.5) / 1000);
    notes.push('Salt worked out as sodium x 2.5.');
    stats.saltFromSodium += 1;
  }
  const ret = val(51200);
  const bc = val(51330);
  if (ret !== null && bc !== null) {
    n.vita = Math.round((ret + bc / 6) * 100) / 100;
    stats.vitaKnown += 1;
  }
  n.vite = val(53100);
  if (n.vite === null && val(71010) !== null) {
    n.vite = val(71010);
    notes.push('Vitamin E is alpha-tocopherol.');
    stats.viteFromAlpha += 1;
  }

  // Constituents below a limit, except where a fallback still gave the Oath value (vitamin E, salt, vitamin A).
  const covered = new Set([...(n.vite !== null ? [53100, 71010] : []), ...(n.salt !== null ? [10004, 10110] : []), ...(n.vita !== null ? [51200, 51330] : [])]);
  const lim = Object.keys(CONST).map(Number).filter((c) => isBelow(c) && LABELS[c] && !covered.has(c));
  below.n += lim.length;
  if (lim.length) notes.push(`Below the lab's limit, left unknown: ${lim.map((c) => LABELS[c]).join(', ')}.`);

  const nameRaw = f.alim_nom_eng || f.alim_nom_fr;
  if (/->\s*ARCHIVE/i.test(nameRaw)) notes.push('Marked "archive" in the Ciqual English name.');
  const name = sentence(english(tidy(nameRaw)));
  const fr = tidy(f.alim_nom_fr);
  const category = refine(groupOf(f), f, name);
  const liquid = liquidOf(category, f, name);
  if (liquid) {
    notes.push('Per 100 g, as Ciqual publishes it (also for drinks).');
    stats.liquids += 1;
  }
  const polyols = val(34000);
  if (polyols !== null && polyols >= 1) notes.push(`Contains ${polyols} g polyols per 100 g (2.4 kcal per g), so energy runs below 4 kcal per g of carbohydrate.`);
  const status = n.kcal === null ? 'incomplete' : 'ok';
  if (status === 'incomplete') stats.incomplete += 1;

  items.push({
    key: `ciqual-${f.alim_code}`,
    kind: 'generic',
    name,
    aliases: fr && fr.toLowerCase() !== name.toLowerCase() ? [fr] : [],
    brand: null,
    market: 'France',
    category,
    state: stateOf(name, f),
    basis: 'g',
    liquid,
    nutrients: n,
    serving: null,
    pack: null,
    portions: [],
    source: 'ciqual',
    source_ref: `Ciqual ${YEAR} code ${f.alim_code}`,
    source_date: YEAR,
    status,
    notes: [`Ciqual ${YEAR}, per 100 g.`, ...notes].join(' '),
  });
}

items.sort((a, b) => Number(a.key.slice(7)) - Number(b.key.slice(7)));
const out = {
  source: `ANSES. Ciqual French food composition table ${YEAR}. Licence Ouverte / Etalab.`,
  built: new Date().toISOString().slice(0, 10),
  licence: 'etalab-2.0',
  count: items.length,
  items,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);

const by = (fn) => Object.fromEntries(Object.entries(items.reduce((a, i) => { const k = fn(i); a[k] = (a[k] || 0) + 1; return a; }, {})).sort((x, y) => y[1] - x[1]));
console.log(`${items.length} records from ${path.basename(files.alim)} -> ${path.relative(repo, OUT)} (${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB)`);
console.log(`constituents not in this edition: ${absent.length ? absent.join(', ') : 'none'}`);
console.log(`values below a limit set to null: ${below.n}`);
console.log(JSON.stringify(stats));
console.log('by category', JSON.stringify(by((i) => i.category)));
console.log('by state', JSON.stringify(by((i) => i.state)));
