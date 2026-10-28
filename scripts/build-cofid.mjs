// Builds data/foods/cofid.json: every food in McCance and Widdowson's "Composition of Foods Integrated
// Dataset" (CoFID) 2021, the UK government's food composition table (Office for Health Improvement and
// Disparities, formerly Public Health England), published on gov.uk under the Open Government Licence v3.0:
// https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid
//
// node scripts/build-cofid.mjs [unzipped workbook dir]
//   default C:/Users/zammi/Projects/oath/sources/cofid/xlsx (the gov.uk .xlsx, unzipped: an .xlsx is a zip).
// The workbook is read straight from its XML (xl/sharedStrings.xml and xl/worksheets/*.xml), no packages.
//
// What the numbers mean (CoFID 2021 user guide, "Details of nutrient data", and the "1.1 Notes" sheet):
// - Values are per 100 g of food, except alcoholic beverages (food group Q), which CoFID gives per 100 ml.
//   Those records get basis "ml"; everything else basis "g".
// - "Tr" is a trace: stored as 0. "N" (present in significant amounts but no reliable figure), a blank
//   cell or "-" is unknown: stored as null. Nothing is estimated here.
// - Carbohydrate is CoFID's available carbohydrate (starch, sugars, oligosaccharides; never fibre), which
//   CoFID expresses as MONOSACCHARIDE EQUIVALENTS, as are its total sugars. A label gives the weight of the
//   carbohydrate itself, which the guide says is total carbohydrate / 1.05 (starch / 1.10, sucrose and
//   lactose / 1.05, glucose and fructose as given), so CoFID's figure reads up to about 10% above a label's.
//   The values are kept as CoFID gives them, with one exception: a food whose monosaccharide equivalents
//   exceed its own weight (the pure sugars, e.g. white sugar at 105 g per 100 g) has carbohydrate and sugars
//   converted to actual weight with those factors, so the catalogue never shows more than 100 g per 100 g;
//   its notes say so.
// - Energy is CoFID's kcal column, which CoFID calculates with protein 4, fat 9, available carbohydrate (as
//   monosaccharides) 3.75 and alcohol 7 kcal per g, and no energy for fibre.
// - Fibre is AOAC fibre. When CoFID has no AOAC value the NSP (Englyst non-starch polysaccharide) value is
//   used instead and the notes say so. NSP leaves out resistant starch and lignin, so it reads lower.
// - Salt is not in CoFID: salt g = sodium mg x 2.5 / 1000.
// - Alcohol is g per 100 ml for drinks (group Q), as CoFID gives it.
// - Monounsaturated and polyunsaturated fat are CoFID's cis-monounsaturated and cis-polyunsaturated fatty
//   acids per 100 g food (the labelling definition, without trans). CoFID publishes the cis-only figures for
//   only about 680 foods; for the rest the total (which includes any trans isomers) is used and the notes say so.
// - Saturates, trans fatty acids: per 100 g food (not the per 100 g fatty acid columns).
// - Vitamin A is total retinol equivalent (retinol + beta-carotene equivalent / 6), vitamin E is alpha-
//   tocopherol equivalents, vitamin K is K1 (phylloquinone), niacin is preformed niacin (not niacin
//   equivalent), thiamin, riboflavin, B6, B12, folate (total folates) and vitamin C as given.
// - Caffeine and added sugars are not in CoFID: null.
// - Foods named "weighed with ..." (bone, skin, shells, stones ...) or "weighed as whole fruit" are per 100 g
//   of the food AS WEIGHED with the inedible part; the notes say so.
// - Food code 13-669 appears twice in the 2021 workbook (aubergine roasted, and watercress raw); the second
//   gets the key cofid-13-669-2.
// - One food, dried rosemary, has published protein, carbohydrate, fat and AOAC fibre that add up to more
//   than 100 g per 100 g (109 g); its fibre is left out (null) with the published value in its notes, and it
//   is listed under gaps. The same rule applies to any food that would add up to more than 105 g.
//
// Records are keyed cofid-<food code>, so a rebuild or a re-seed updates in place.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS } from '../public/nutrition.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || 'C:/Users/zammi/Projects/oath/sources/cofid/xlsx');
const out = path.join(repo, 'data/foods/cofid.json');
const YEAR = '2021';
const BUILT = '2026-10-28';

// ---------- Reading the workbook ----------

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const readText = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

const shared = [];
for (const m of readText('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  shared.push(unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
}

// Sheet name -> worksheet file, through the workbook's relationships.
const rels = new Map();
for (const m of readText('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
  const id = (m[1].match(/\bId="([^"]+)"/) || [])[1];
  const target = (m[1].match(/\bTarget="([^"]+)"/) || [])[1];
  if (id && target) rels.set(id, target.replace(/^\/?xl\//, ''));
}
const sheetFiles = new Map();
for (const m of readText('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/>/g)) {
  const name = unxml((m[1].match(/\bname="([^"]+)"/) || [])[1] || '');
  const rid = (m[1].match(/\br:id="([^"]+)"/) || [])[1];
  if (name && rels.has(rid)) sheetFiles.set(name, rels.get(rid));
}

const colIndex = (ref) => {
  let n = 0;
  for (const c of ref.match(/^[A-Z]+/)[0]) n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
};

// A sheet as rows of cell strings (undefined for an empty cell), row 1 at index 0.
function readSheet(name) {
  const file = sheetFiles.get(name);
  if (!file) throw new Error(`sheet "${name}" is not in the workbook`);
  const rows = [];
  for (const rm of readText(path.join('xl', file)).matchAll(/<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b[^>]*?\br="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = (cm[2].match(/\bt="([^"]+)"/) || [])[1];
      const inner = cm[3] || '';
      let v;
      if (type === 's') v = shared[Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1])];
      else if (type === 'inlineStr') v = unxml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else {
        const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        v = raw === undefined ? undefined : unxml(raw);
      }
      row[colIndex(cm[1])] = v;
    }
    rows[Number(rm[1]) - 1] = row;
  }
  return rows;
}

// Each nutrient sheet: row 1 names, row 2 CoFID's column codes, row 3 descriptions, data from row 4.
// Values are found by CoFID's column code, never by position.
function table(name) {
  const rows = readSheet(name);
  const codes = rows[1] || [];
  const at = new Map(codes.map((c, i) => [String(c || '').trim(), i]).filter(([c]) => c));
  const data = new Map();
  rows.slice(3).forEach((r, i) => {
    if (r && r[0]) data.set(i + 3, r);
  });
  return { at, data, rows };
}

const prox = table('1.3 Proximates');
const inorg = table('1.4 Inorganics');
const vits = table('1.5 Vitamins');
const mono = table('1.10 (MUFA per 100gFood)');
const poly = table('1.12 (PUFA per 100gFood)');

// CoFID's cell -> number, 0 (Tr) or null (N, blank, -). Spreadsheet float noise (1.1000000000000001) is cut.
function value(t, rowIndex, code) {
  const col = t.at.get(code);
  if (col === undefined) throw new Error(`column ${code} not found`);
  const row = t.data.get(rowIndex);
  const raw = row ? row[col] : undefined;
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s || s === '-' || s === 'N') return null;
  if (/^tr$/i.test(s)) return 0;
  const x = Number(s);
  if (!Number.isFinite(x)) throw new Error(`row ${rowIndex + 1} ${code}: unreadable value "${s}"`);
  return Number(x.toPrecision(12));
}
const round = (x, d) => (x === null ? null : Number((Math.round(x * 10 ** d) / 10 ** d).toFixed(d)));

// ---------- Categories ----------

// CoFID food sub-group codes (user guide, Appendix B) -> the catalogue's food groups.
const GROUP_CATEGORY = {
  A: 'Rice, pasta and grains', // Cereals and cereal products (foods coded to the main group only)
  AA: 'Flour and baking', // Flours, grains and starches
  AB: 'Sandwiches and burgers', // Sandwiches
  AC: 'Rice, pasta and grains', // Rice
  AD: 'Rice, pasta and grains', // Pasta
  AE: 'Pizza', // Pizzas
  AF: 'Bread and rolls', // Breads
  AG: 'Bread and rolls', // Rolls
  AI: 'Breakfast cereals', // Breakfast cereals
  AK: 'Baby food', // Infant cereal foods
  AM: 'Biscuits and crackers', // Biscuits
  AN: 'Cakes and pastries', // Cakes
  AO: 'Cakes and pastries', // Pastry
  AP: 'Cakes and pastries', // Buns and pastries
  AS: 'Desserts', // Puddings
  AT: 'Mixed dishes', // Savouries
  B: 'Dairy', // Milk and milk products
  BA: 'Milk', // Cows milk
  BAB: 'Milk', // Breakfast milk (Channel Islands)
  BAE: 'Milk', // Skimmed milk
  BAH: 'Milk', // Semi-skimmed milk
  BAK: 'Milk', // Whole milk
  BAN: 'Milk', // Channel Island milk
  BAR: 'Milk', // Processed milks
  BC: 'Milk', // Other milks
  BF: 'Baby food', // Infant formulas
  BFD: 'Baby food', // Whey-based modified milks
  BFG: 'Baby food', // Non-whey-based modified milks
  BFJ: 'Baby food', // Soya-based modified milks
  BFP: 'Baby food', // Follow-on formulas
  BH: 'Drinks', // Milk-based drinks
  BJ: 'Dairy', // Creams
  BJC: 'Dairy', // Fresh creams (pasteurised)
  BJF: 'Dairy', // Frozen creams (pasteurised)
  BJL: 'Dairy', // Sterilised creams
  BJP: 'Dairy', // UHT creams
  BJS: 'Dairy', // Imitation creams
  BL: 'Cheese', // Cheeses
  BN: 'Dairy', // Yogurts
  BNE: 'Dairy', // Whole milk yogurts
  BNH: 'Dairy', // Low fat yogurts
  BNS: 'Dairy', // Other yogurts
  BP: 'Desserts', // Ice creams
  BR: 'Desserts', // Puddings and chilled desserts
  BTM: 'Fats and oils', // (not in Appendix B; its foods are baking fat, compound cooking fat, vegetable ghee)
  BV: 'Mixed dishes', // Savoury dishes and sauces
  C: 'Eggs', // Eggs
  CA: 'Eggs', // Eggs
  CD: 'Eggs', // Egg dishes
  CDE: 'Mixed dishes', // Savoury egg dishes
  CDH: 'Desserts', // Sweet egg dishes
  D: 'Vegetables', // Vegetables
  DA: 'Potatoes', // Potatoes
  DAE: 'Potatoes', // Early potatoes
  DAM: 'Potatoes', // Main crop potatoes
  DAP: 'Potatoes', // Chipped old potatoes
  DAR: 'Potatoes', // Potato products
  DB: 'Legumes', // Beans and lentils
  DF: 'Vegetables', // Peas
  DG: 'Vegetables', // Vegetables, general
  DI: 'Vegetables', // Vegetables, dried
  DR: 'Mixed dishes', // Vegetable dishes
  F: 'Fruit', // Fruit
  FA: 'Fruit', // Fruit, general
  FC: 'Fruit juice', // Fruit juices
  G: 'Nuts and seeds', // Nuts and seeds
  GA: 'Nuts and seeds', // Nuts and seeds, general
  H: 'Herbs and spices', // Herbs and spices
  J: 'Fish and shellfish', // Fish and fish products
  JA: 'Fish and shellfish', // White fish
  JC: 'Fish and shellfish', // Fatty fish
  JK: 'Fish and shellfish', // Crustacea
  JM: 'Fish and shellfish', // Molluscs
  JR: 'Fish and shellfish', // Fish products and dishes
  M: 'Mixed dishes', // Meat and meat products
  MA: 'Beef', // Meat
  MAA: 'Pork', // Bacon
  MAC: 'Beef', // Beef
  MAE: 'Lamb, veal and game', // Lamb
  MAG: 'Pork', // Pork
  MAI: 'Lamb, veal and game', // Veal
  MBG: 'Beef', // Burgers and grillsteaks
  MC: 'Poultry', // Poultry
  MCA: 'Poultry', // Chicken
  MCC: 'Poultry', // Duck
  MCE: 'Poultry', // Goose
  MCG: 'Lamb, veal and game', // Grouse
  MCI: 'Lamb, veal and game', // Partridge
  MCK: 'Lamb, veal and game', // Pheasant
  MCM: 'Lamb, veal and game', // Pigeon
  MCO: 'Poultry', // Turkey
  ME: 'Lamb, veal and game', // Game
  MEA: 'Lamb, veal and game', // Hare
  MEC: 'Lamb, veal and game', // Rabbit
  MEE: 'Lamb, veal and game', // Venison
  MG: 'Other', // Offal (by animal below)
  MI: 'Sausages and cold cuts', // Meat products
  MIG: 'Ready meals', // Other meat products
  MR: 'Mixed dishes', // Meat dishes
  O: 'Fats and oils', // Fats and oils
  OA: 'Fats and oils', // Spreading fats
  OB: 'Fats and oils', // Animal fats
  OC: 'Fats and oils', // Oils
  OE: 'Fats and oils', // Non-animal fats
  OF: 'Fats and oils', // Cooking fats
  P: 'Coffee and tea', // Beverages (foods coded to the main group only)
  PA: 'Coffee and tea', // Powdered drinks, essences and infusions
  PAA: 'Drinks', // Powdered drinks and essences
  PAC: 'Coffee and tea', // Infusions
  PC: 'Drinks', // Soft drinks
  PCA: 'Drinks', // Carbonated drinks
  PCC: 'Drinks', // Squash and cordials
  PE: 'Fruit juice', // Juices
  Q: 'Alcoholic drinks', // Alcoholic beverages
  QA: 'Alcoholic drinks', // Beers
  QC: 'Alcoholic drinks', // Ciders
  QE: 'Alcoholic drinks', // Wines
  QF: 'Alcoholic drinks', // Fortified wines
  QG: 'Alcoholic drinks', // Vermouths
  QI: 'Alcoholic drinks', // Liqueurs
  QK: 'Alcoholic drinks', // Spirits
  S: 'Sugar, syrups and spreads', // Sugars, preserves and snacks
  SC: 'Sugar, syrups and spreads', // Sugars, syrups and preserves
  SE: 'Sweets and chocolate', // Confectionery
  SEA: 'Sweets and chocolate', // Chocolate confectionery
  SEC: 'Sweets and chocolate', // Non-chocolate confectionery
  SN: 'Snacks', // Savoury snacks
  SNA: 'Snacks', // Potato-based snacks
  SNB: 'Snacks', // Potato and mixed cereal snacks
  SNC: 'Snacks', // Non-potato snacks
  W: 'Soups', // Soups, sauces and miscellaneous foods
  WA: 'Soups', // Soups
  WAA: 'Soups', // Homemade soups
  WAC: 'Soups', // Canned soups
  WAE: 'Soups', // Packet soups
  WC: 'Sauces and condiments', // Sauces
  WCD: 'Sauces and condiments', // Dairy sauces
  WCG: 'Sauces and condiments', // Salad sauces, dressings and pickles
  WCN: 'Sauces and condiments', // Non-salad sauces
  WE: 'Sauces and condiments', // Pickles and chutneys
  WY: 'Other', // Miscellaneous foods
};

// Where a sub-group mixes kinds of food, the name decides. First match wins: [group pattern, name pattern, category].
const NAME_RULES = [
  [/^A$/, /^pizza/i, 'Pizza'],
  [/^A$/, /^porridge/i, 'Breakfast cereals'],
  [/^AA$/, /^(barley|buckwheat|wheat, bulgur|sago|tapioca)/i, 'Rice, pasta and grains'],
  [/^AD$/, /homemade/i, 'Mixed dishes'],
  [/^AD$/, /canned/i, 'Ready meals'],
  [/^AP$/, /^(bagels|crumpets|muffins, english)/i, 'Bread and rolls'],
  [/^AT$/, /^(couscous|polenta)/i, 'Rice, pasta and grains'],
  [/^AT$/, /^prawn crackers/i, 'Snacks'],
  [/^BAR$/, /^coffeemate/i, 'Dairy'],
  [/^BAR$/, /^milkshake/i, 'Drinks'],
  [/^BC$/, /soya/i, 'Plant milks'],
  [/^BC$/, /human/i, 'Baby food'],
  [/^BH$/, /^cocoa powder$/i, 'Flour and baking'],
  [/^BH$/, /^complan/i, 'Supplements and powders'],
  [/^BN$/, /^tzatziki/i, 'Sauces and condiments'],
  [/^BN$/, /^lassi/i, 'Drinks'],
  [/^BV$/, /^(sauce|raita)/i, 'Sauces and condiments'],
  [/^CD$/, /^(quiche|souffle)/i, 'Mixed dishes'],
  [/^CDH$/, /^macaroon/i, 'Biscuits and crackers'],
  [/^DB$/, /^(beans, (green|runner|balor|cluster|papri|sword)|beansprouts)/i, 'Vegetables'],
  [/^DF$/, /\b(dried|split|marrowfat|mushy)\b/i, 'Legumes'],
  [/^GA$/, /^quinoa/i, 'Rice, pasta and grains'],
  [/^GA$/, /^marzipan/i, 'Sweets and chocolate'],
  [/^(J|JR)$/, /^(curry|pie, fish|kedgeree|pilau|sushi|szechuan|sesame prawn toast|salmon en croute)/i, 'Mixed dishes'],
  [/^MBG$/, /takeaway/i, 'Fast food'],
  [/^MG$/, /\b(lamb|sheep|calf)\b/i, 'Lamb, veal and game'],
  [/^MG$/, /\b(ox|oxtail)\b/i, 'Beef'],
  [/^MG$/, /\b(pig|pork)\b/i, 'Pork'],
  [/^MG$/, /\b(chicken|turkey)\b/i, 'Poultry'],
  [/^MI$/, /^(pie|chicken\/turkey pasties|sausage roll|samosas|scotch eggs|steak and kidney pudding)/i, 'Mixed dishes'],
  [/^MI$/, /^frankfurter with bun/i, 'Sandwiches and burgers'],
  [/^(MR|DR|CDE|BV|J|JR)$/, /^(coleslaw|salad)/i, 'Mixed dishes'],
  [/^(MR|DR|CDE|BV|J|JR)$/, /\b(retail|reheated)\b/i, 'Ready meals'],
  [/^(MR|DR|CDE|BV|J|JR)$/, /\b(takeaway|restaurant)\b/i, 'Restaurant meals'],
  [/^PAA$/, /^(coffee|tea)\b/i, 'Coffee and tea'],
  [/^PAA$/, /^(build|complan)/i, 'Supplements and powders'],
  [/^PE$/, /^tomato juice/i, 'Drinks'],
  [/^WY$/, /^(baking powder|bicarbonate|cream of tartar|gelatine|yeast, )/i, 'Flour and baking'],
  [/^WY$/, /^(beef extract|gravy|mustard|salt|stock|vinegar)/i, 'Sauces and condiments'],
  [/^WY$/, /^yeast extract/i, 'Sugar, syrups and spreads'],
  [/^WY$/, /^water\b/i, 'Water'],
];

function categoryOf(group, name) {
  for (const [g, n, c] of NAME_RULES) if (g.test(group) && n.test(name)) return c;
  const c = GROUP_CATEGORY[group];
  if (!c) throw new Error(`food group "${group}" (${name}) has no category in GROUP_CATEGORY`);
  return c;
}

// ---------- Names, states, liquids ----------

const NAME_FIXES = [
  [/`/g, "'"],
  [/\bHOMEMADE\b/g, 'homemade'],
  [/\bKernel only\b/g, 'kernel only'],
  [/\bChannel islands\b/g, 'Channel Islands'],
  [/\bof Beef\b/g, 'of beef'],
  [/\bcommerical\b/g, 'commercial'],
];
function readableName(raw) {
  let s = String(raw).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  for (const [re, to] of NAME_FIXES) s = s.replace(re, to);
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// One of raw, boiled, fried, grilled, roasted, baked, canned, dried or as-sold, read from the name. Cooking in
// water, stock or steam (steamed, stewed, braised, poached, microwaved) counts as boiled; toasted bread as
// grilled and toasted nuts or seeds as roasted.
function stateOf(name, group) {
  const d = name.toLowerCase();
  const has = (re) => re.test(d);
  if (has(/\b(canned|tinned)\b/)) return 'canned';
  if (has(/\b(fried|stir-fry|deep fried)\b/)) return 'fried';
  if (has(/\btoasted\b/)) return /^G/.test(group) ? 'roasted' : 'grilled';
  if (has(/\b(grilled|barbecued|chargrilled)\b/)) return 'grilled';
  if (has(/\b(roasted|roast)\b/)) return 'roasted';
  if (has(/\bbaked\b/)) return 'baked';
  if (has(/\b(boiled|poached|simmered|steamed|stewed|braised|casseroled|microwaved)\b/)) return 'boiled';
  if (has(/\bcooked\b/) && !has(/\buncooked\b/)) return group === 'AO' || has(/pastry/) ? 'baked' : 'boiled';
  if (has(/\bsoaked\b/)) return has(/\braw\b/) ? 'raw' : 'as-sold';
  if (has(/\b(as served|made up|reconstituted|diluted)\b/)) return 'as-sold';
  if (has(/\b(dried|dehydrated|freeze-dried|semi-dried)\b/)) return 'dried';
  if (has(/\b(raw|uncooked)\b/)) return 'raw';
  if (has(/\bfresh\b/) && /^(D|F|FA|G|GA|H)/.test(group) && !/^(FC|PE)$/.test(group)) return 'raw';
  // Fresh fruit is named without "raw" ("Bananas, flesh only"); dried vine fruit and prunes without "dried".
  if (/^(F|FA)$/.test(group)) {
    if (has(/^(currants|sultanas|raisins|prunes)\b/)) return 'dried';
    if (!/\b(glace|peel|salad|homemade|pickled|brine|juice|candied|crystallised|jam|puree|pie|tamarind)\b/.test(d.replace(/\bweighed with .*$/, ''))) return 'raw';
  }
  return 'as-sold';
}

// Liquid: drinks, milks, juices and soups as drunk. Powders, concentrates, undiluted squash, condensed or
// dried soups and juices weighed as whole fruit are not.
const NOT_LIQUID = /\b(powder|whitener|condensed|evaporated|dried|concentrate|undiluted|as purchased|weighed as whole fruit)\b/i;
function liquidOf(group, name, category) {
  if (/^Q/.test(group)) return true;
  if (/^W(A|AA|AC|AE)$/.test(group)) return !NOT_LIQUID.test(name.replace(/\bcondensed, as served\b/i, 'as served').replace(/\bdried, as served\b/i, 'as served'));
  if (category === 'Water') return true;
  if (/^(BA|BAB|BAE|BAH|BAK|BAN|BAR|BC|BH|FC|PE|P|PA|PAA|PAC|PC|PCA|PCC)$/.test(group) || /^lassi/i.test(name)) {
    if (/\b(made up|diluted|infusion)\b/i.test(name) && !/\bundiluted\b/i.test(name)) return true;
    return !NOT_LIQUID.test(name) && !/^(cocoa powder|coffee, powder)/i.test(name);
  }
  return false;
}

// ---------- Records ----------

const empty = () => Object.fromEntries(KEYS.map((k) => [k, null]));

// Oddities in the published figures, found when checking the build; the values are kept as CoFID gives them.
const SPECIAL = {
  '16-087': 'CoFID gives 0.00 g saturated, monounsaturated and polyunsaturated fatty acids although fat is 14.6 g, and an energy (187 kcal) well below what its protein, carbohydrate and fat give (about 250 kcal); kept as published.',
};
const items = [];
const gaps = [];
const seenCodes = new Map();
const codeCount = new Map();
for (const r of prox.data.values()) codeCount.set(String(r[0]).trim(), (codeCount.get(String(r[0]).trim()) || 0) + 1);
const count ={ nsp: 0, totalFa: 0, sugarsConverted: 0, fibreDropped: 0, noEnergy: 0, ml: 0, liquid: 0 };

for (const [rowIndex, row] of prox.data) {
  const code = String(row[0]).trim();
  const rawName = String(row[1] || '').trim();
  const description = String(row[2] || '').replace(/\s+/g, ' ').trim();
  const group = String(row[3] || '').trim();
  // Every sheet lists the foods in the same rows (user guide); check it rather than trust it.
  for (const t of [inorg, vits, mono, poly]) {
    if (String(t.data.get(rowIndex)?.[0] || '').trim() !== code) throw new Error(`row ${rowIndex + 1}: sheets disagree on the food code (${code})`);
  }

  const n = seenCodes.get(code) || 0;
  seenCodes.set(code, n + 1);
  const key = `cofid-${code.toLowerCase().replace(/[^a-z0-9]/g, '-')}${n ? `-${n + 1}` : ''}`;
  const name = readableName(rawName);
  const category = categoryOf(group, rawName);
  const perMl = /^Q/.test(group);
  const liquid = liquidOf(group, rawName, category);
  const notes = [perMl ? 'Per 100 ml as published (CoFID gives alcoholic drinks per 100 ml).' : 'Per 100 g as published.'];

  const P = (c) => value(prox, rowIndex, c);
  const I = (c) => value(inorg, rowIndex, c);
  const V = (c) => value(vits, rowIndex, c);
  const nut = empty();
  nut.kcal = P('KCALS');
  nut.protein = P('PROT');
  nut.carbs = P('CHO');
  nut.sugars = P('TOTSUG');
  nut.fat = P('FAT');
  nut.satfat = P('SATFOD');
  const aoac = P('AOACFIB');
  const nsp = P('ENGFIB');
  nut.fibre = aoac !== null ? aoac : nsp;
  if (aoac === null && nsp !== null) {
    count.nsp += 1;
    notes.push('Fibre is NSP (Englyst): CoFID has no AOAC fibre for this food.');
  }
  const sodium = I('NA');
  nut.salt = sodium === null ? null : round((sodium * 2.5) / 1000, 4);
  nut.alcohol = P('ALCO');
  // cis figures when published, else the totals; a total only differs from cis when the food has trans fat,
  // so the note is only added when that total is above 0 and trans fat is not known to be 0.
  let mufa = P('MONOFODc');
  let pufa = P('POLYFODc');
  const totalNote = [];
  const transKnownZero = P('FODTRANS') === 0;
  if (mufa === null && P('MONOFOD') !== null) {
    mufa = P('MONOFOD');
    if (mufa > 0 && !transKnownZero) totalNote.push('monounsaturated');
  }
  if (pufa === null && P('POLYFOD') !== null) {
    pufa = P('POLYFOD');
    if (pufa > 0 && !transKnownZero) totalNote.push('polyunsaturated');
  }
  if (totalNote.length) {
    count.totalFa += 1;
    notes.push(`${totalNote.join(' and ')[0].toUpperCase()}${totalNote.join(' and ').slice(1)} fat ${totalNote.length > 1 ? 'are totals' : 'is the total'} including any trans isomers (no cis-only figure published).`);
  }
  nut.mufa = mufa;
  nut.pufa = pufa;
  nut.transfat = P('FODTRANS');
  nut.chol = P('CHOL');
  nut.potassium = I('K');
  nut.calcium = I('CA');
  nut.iron = I('FE');
  nut.magnesium = I('MG');
  nut.zinc = I('ZN');
  nut.phosphorus = I('P');
  nut.selenium = I('SE');
  nut.vita = V('RETEQU');
  nut.vitc = V('VITC');
  nut.vitd = V('VITD');
  nut.vite = V('VITE');
  nut.vitk = V('VITK1');
  nut.b1 = V('THIA');
  nut.b2 = V('RIBO');
  nut.b3 = V('NIAC');
  nut.b6 = V('VITB6');
  nut.folate = V('FOLT');
  nut.b12 = V('VITB12');
  // caffeine and addsugars stay null: CoFID has neither.

  // Pure sugars: monosaccharide equivalents above the food's own weight -> actual weight (user guide factors).
  if (nut.carbs !== null && nut.carbs > 100) {
    const pub = { carbs: nut.carbs, sugars: nut.sugars };
    nut.carbs = round(nut.carbs / 1.05, 2);
    if (nut.sugars !== null) {
      const di = (P('SUCR') || 0) + (P('LACT') || 0);
      nut.sugars = round(nut.sugars - di + di / 1.05, 2);
    }
    count.sugarsConverted += 1;
    notes[0] = 'Per 100 g.';
    notes.push(`CoFID gives ${pub.carbs} g carbohydrate${pub.sugars !== null ? ` and ${pub.sugars} g sugars` : ''} as monosaccharide equivalents, more than the food's weight; converted to actual weight with the CoFID user guide's factors (total carbohydrate / 1.05, sucrose and lactose / 1.05).`);
  } else if (nut.carbs) {
    notes.push('Carbs and sugars are monosaccharide equivalents, as CoFID gives them (a label would show up to about 10% less).');
  }

  // Published macros that add up to more than the food can hold: fibre is left out rather than guessed at.
  const g = (k) => nut[k] || 0;
  if (g('protein') + g('carbs') + g('fat') + g('fibre') + g('alcohol') > 105 && nut.fibre !== null) {
    const sum = round(g('protein') + g('carbs') + g('fat') + g('fibre') + g('alcohol'), 1);
    notes.push(`Fibre left out: CoFID's ${aoac !== null ? 'AOAC' : 'NSP'} fibre of ${nut.fibre} g with its protein, carbohydrate and fat adds up to ${sum} g per 100 g.`);
    gaps.push({ name: `${name} (${key})`, reason: `fibre left out: CoFID's published protein ${nut.protein} g, carbohydrate ${nut.carbs} g, fat ${nut.fat} g and fibre ${nut.fibre} g add up to ${sum} g per 100 g, so one of them is wrong and the catalogue cannot tell which` });
    nut.fibre = null;
    count.fibreDropped += 1;
  }

  if (/\bweighed (with|as whole)\b/i.test(rawName)) notes.push('Per 100 g as weighed with the inedible part (bone, skin, shell, stone or peel), as the name says.');
  if (codeCount.get(code) > 1) notes.push(`CoFID ${YEAR} lists food code ${code} for ${codeCount.get(code)} different foods; this is number ${n + 1} of them.`);
  if (nut.kcal === null) {
    count.noEnergy += 1;
    notes.push('Energy not published by CoFID (N: present but no reliable figure).');
  }
  if (SPECIAL[code]) notes.push(SPECIAL[code]);
  if (description) notes.push(`CoFID description: ${description}`);
  let noteText = notes.join(' ');
  if (noteText.length > 600) noteText = `${noteText.slice(0, 597)}...`;

  if (perMl) count.ml += 1;
  if (liquid) count.liquid += 1;
  items.push({
    key,
    kind: 'generic',
    name,
    brand: null,
    aliases: [],
    market: 'UK',
    category,
    state: stateOf(rawName, group),
    basis: perMl ? 'ml' : 'g',
    liquid,
    nutrients: nut,
    serving: null,
    pack: null,
    portions: [],
    source: 'cofid',
    source_ref: `CoFID ${YEAR} food code ${code}`,
    source_date: YEAR,
    status: nut.kcal === null ? 'incomplete' : 'ok',
    notes: noteText,
  });
}

// What the workbook has that the catalogue does not take.
gaps.push(
  { name: 'CoFID nutrients with no Oath key', reason: 'copper, manganese, chloride, iodine, pantothenate, biotin, carotene and the vitamin fractions, individual fatty acids, phytosterols and organic acids are in the workbook but have no catalogue key; edible proportion and specific gravity (1.2 Factors) are not carried either' },
  { name: "CoFID 'old foods' workbook (CoFID_oldFoods.xlsx)", reason: "a separate attachment on the gov.uk page (\"McCance and Widdowson's composition of foods: old foods\"); not downloaded or imported" },
);

const doc = {
  source: `McCance and Widdowson's Composition of Foods Integrated Dataset ${YEAR}, Office for Health Improvement and Disparities. Contains public sector information licensed under the Open Government Licence v3.0.`,
  url: 'https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid',
  built: BUILT,
  licence: 'OGL-UK-3.0',
  count: items.length,
  items,
  gaps,
};
fs.writeFileSync(out, JSON.stringify(doc));

const byCategory = {};
for (const i of items) byCategory[i.category] = (byCategory[i.category] || 0) + 1;
const byState = {};
for (const i of items) byState[i.state] = (byState[i.state] || 0) + 1;
console.log(`${path.relative(repo, out).replace(/\\/g, '/')}: ${items.length} foods (${count.ml} per 100 ml, ${count.liquid} liquid, ${count.noEnergy} without energy)`);
console.log(`fibre from NSP: ${count.nsp}; mono/poly totals used: ${count.totalFa}; sugars converted to weight: ${count.sugarsConverted}; fibre left out: ${count.fibreDropped}`);
console.log('categories:', JSON.stringify(Object.fromEntries(Object.entries(byCategory).sort((a, b) => b[1] - a[1]))));
console.log('states:', JSON.stringify(byState));
