// "Take a photo of anything" and "What did you eat?": Claude reads what Daniel ate, the catalogue
// supplies the numbers, and he confirms before anything is logged. The photo itself is never stored.
//
// Barcodes, packets and labels: one Claude vision reading, held to a JSON schema.
// - Barcode or packet: the digits and name are read, then the catalogue, then Open Food Facts.
// - Nutrition label: the printed values become a draft record for him to check and save.
// - Anything else: he is asked what it is.
//
// Meals, whether photographed, typed or told to the coach, go through one pipeline:
// 1. Understand: the reading lists each food as specifically as it was said or seen (name, brand or
//    restaurant, variety, preparation, the size words, an amount), with search phrases and an
//    estimated nutrient profile per 100 g or ml. The coach supplies its own items instead.
// 2. Retrieve: several catalogue searches per food (brand and name, name and variety, plain name)
//    make a shortlist of about 12 records.
// 3. Choose: one more structured call picks, for every food at once, the most specific record that is
//    honestly the same food (brand or restaurant first, then variety, then state), the portion that
//    matches the size word, and says why. When nothing fits there is no record, and the estimate is
//    logged instead. Without the AI, or when that call fails, a local score makes the same kind of choice.
// The record's own numbers are always used. The estimate only fills what the record does not say: the
// core values as it is logged (logFood's `fill`), the vitamins, minerals and the rest once the filler
// has tried a USDA reference and the web (food-enrich.js). Filled values stay marked as estimated.
import { logEvent } from './db.js';
import { RuleError } from './engine.js';
import { readStructured, aiEnabled } from './coach.js';
import { searchFoods, FILL_KEYS, ESTIMATE_KEYS, MICRO_TEXT, cleanFill } from './food.js';
import { productByBarcode } from './off.js';
import { resolve, round, norm } from '../public/nutrition.js';
import { lookupCode } from '../public/barcode.js';

const STR = { type: 'string' };
const NUM = { type: 'number' };
const maybe = (s) => ({ anyOf: [s, { type: 'null' }] });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const LABEL_KEYS = ['kcal', 'kj', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine_mg'];
const UNITS = ['g', 'ml', 'piece'];

// One food as the reading understood it. Text fields are empty strings when there is nothing to say
// (no extra null unions in the schema). per100 covers every value a record might lack, vitamins and
// minerals included, so the diary never shows a missing sugar, fibre or iron that the food really has.
const MEAL_ITEM = {
  name: STR,
  brand: STR,
  variety: STR,
  preparation: STR,
  size: STR,
  amount: NUM,
  unit: { type: 'string', enum: UNITS },
  weight: NUM,
  confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  searches: { type: 'array', items: STR },
  per100: obj(Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, NUM]))),
};

// How to describe each food, shared by the photo and the typed reading.
const ITEM_RULES = `For each food or drink, be exactly as specific as what was said or can be seen, field by field:
- name: what it is in plain UK English, without size words, e.g. "fries", "red grapes", "chicken shawarma wrap", "flat white".
- brand: the brand or restaurant when it is named or plainly visible (the packaging, a branded cup or box), e.g. "Burger King", "McDonald's", "Kinnie". Never guess one. Empty string when there is none.
- variety: the kind, e.g. "red", "seedless", "wholemeal", "semi-skimmed", "zero sugar". Empty string when it is not said or seen.
- preparation: how it was cooked or served, e.g. "deep fried", "grilled", "boiled", "raw", "toasted". Empty string when unknown.
- size: the size words as said, or as fits what is seen, e.g. "large", "medium", "a bowl of", "two slices". Empty string when there are none.
- amount and unit: the amount eaten: grams for food, ml for drinks, or "piece" with a count for whole countable things (an egg, a banana, a slice of bread). Use any amount given. Otherwise fit it to the size and, for a brand or restaurant, to that place's real portion (a Burger King large fries is about 150 to 175 g); with no size, one typical portion in Malta.
- weight: that same amount in grams (ml for drinks), so a count of pieces is weighed too.
- searches: 2 or 3 short phrases that would find it in a food database that is mostly American (USDA), most specific first, never with size words: the brand or restaurant with the name when there is one ("burger king french fries"), then the name with its variety or preparation ("red grapes", "potato french fries"), then a plain generic phrase ("grapes", "french fries"). Use the American word where it differs: chips are "french fries", crisps are "potato chips", courgette is "zucchini", aubergine is "eggplant", prawns are "shrimp", mince is "ground beef".
- per100: your estimate for this exact food per 100 g (per 100 ml for drinks), for a brand or restaurant its published values if you know them: kcal; protein, carbs, sugars, fat, satfat, fibre and salt in grams; caffeine in mg; alcohol in grams; and, from typical composition data for this food, ${MICRO_TEXT}. Give 0 only when the food really has none (no sugars in plain meat, no alcohol in juice, no vitamin B12 in plants): most foods have some sugars, fibre, salt, potassium and magnesium.
A dish is one item unless its parts are listed or clearly separate (a kebab and chips are two items; a ham sandwich is one). Butter, oil, sauces, dressings and sugar are their own items.`;

// The API allows at most 16 nullable fields in a schema, so nothing here is nullable: text is "" and a
// size 0 when not seen, and the label's values come as a list of only those printed. photoFromWire
// turns it back into nulls for the code below.
export const PHOTO_SCHEMA = obj({
  kind: { type: 'string', enum: ['barcode', 'label', 'packet', 'meal', 'unclear'] },
  summary: STR,
  barcode: STR,
  product: obj({
    name: STR,
    brand: STR,
    variant: STR,
    pack_size: NUM,
    pack_unit: { type: 'string', enum: ['g', 'ml', ''] },
    pack_count: { type: 'integer' },
  }),
  label: obj({
    basis: { type: 'string', enum: ['100g', '100ml', 'serving', 'none'] },
    serving_size: NUM,
    serving_unit: { type: 'string', enum: ['g', 'ml', ''] },
    serving_label: STR,
    values: { type: 'array', items: obj({ key: { type: 'string', enum: LABEL_KEYS }, value: NUM }) },
  }),
  items: { type: 'array', items: obj(MEAL_ITEM) },
  question: STR,
});

// The reading as the rest of this file expects it: null for anything not seen. Readings already in that
// shape (tests, older callers) pass through.
export function photoFromWire(w = {}) {
  const text = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);
  const size = (v) => (typeof v === 'number' && v > 0 ? v : null);
  const p = w.product;
  const product = p && (text(p.name) || text(p.brand)) ? {
    name: text(p.name) || '', brand: text(p.brand), variant: text(p.variant),
    pack_size: size(p.pack_size), pack_unit: text(p.pack_unit), pack_count: size(p.pack_count),
  } : null;
  const l = w.label;
  let label = null;
  if (l && l.basis && l.basis !== 'none') {
    const given = Array.isArray(l.values) ? Object.fromEntries(l.values.filter((x) => LABEL_KEYS.includes(x?.key) && typeof x.value === 'number').map((x) => [x.key, x.value])) : l;
    label = {
      basis: l.basis, serving_size: size(l.serving_size), serving_unit: text(l.serving_unit), serving_label: text(l.serving_label),
      ...Object.fromEntries(LABEL_KEYS.map((k) => [k, typeof given[k] === 'number' ? given[k] : null])),
    };
  }
  return { ...w, barcode: text(w.barcode), product, label, question: text(w.question) };
}

const SYSTEM = `You read photos for Oath, a personal food diary used in Malta. Say what the photo shows using the schema.

kind:
- "barcode": a barcode is readable. Put every digit in barcode, exactly as printed under the bars. Also fill product if the packet is visible.
- "packet": a packaged product with no readable barcode. Fill product with the name, brand and variant as printed, and pack size if printed (for "6 x 330 ml" give pack_size 1980, pack_unit "ml", pack_count 6).
- "label": a nutrition information table. Fill label with the values exactly as printed in the per 100 g or per 100 ml column; use the per serving column (basis "serving", with serving_size) only if there is no per 100 column. Copy numbers, never work them out. In values, list only what is printed, one entry per value (key and number); leave out anything not printed. Salt as printed; if only sodium is printed, leave salt out. caffeine_mg only if a caffeine amount is printed. Fill product from the packet if visible.
- "meal": food or drink ready to eat (a plate, a bowl, a sandwich, a glass, a takeaway box). List each separate food in items, following the item rules below. Include visible oil, butter, sauces and dressings as their own items.
- "unclear": you cannot tell what it is, or it is not food or drink. Put a short question in question.

Anything you cannot read stays empty: "" for text, 0 for a size or count, label basis "none" when there is no nutrition table, and product name "" when no packet is visible. Never guess a barcode digit, a brand or a label value. summary is one short line saying what you see. items is empty unless kind is "meal".

Item rules:
${ITEM_RULES}`;

// The label as a draft record per 100 g or ml. Values per serving are scaled by the printed serving size;
// kcal comes from kJ ÷ 4.184 only when kcal was not printed. Warnings flag readings that don't add up.
// `scanned` is a barcode the live scanner already read for this product; it beats one read off the photo.
export function labelDraft(read, scanned = null) {
  const l = read.label;
  if (!l) return null;
  const warnings = [];
  const raw = Object.fromEntries(LABEL_KEYS.map((k) => [k, typeof l[k] === 'number' && l[k] >= 0 ? l[k] : null]));
  let factor = 1;
  let basis = l.basis === '100ml' ? 'ml' : 'g';
  if (l.basis === 'serving') {
    if (!(l.serving_size > 0)) warnings.push('Only per-serving values were read and no serving size, so add the serving size before saving.');
    else factor = 100 / l.serving_size;
    basis = l.serving_unit === 'ml' ? 'ml' : 'g';
  }
  const per = (v) => (v === null ? null : round(v * factor, 3));
  let kcal = per(raw.kcal);
  if (kcal === null && raw.kj !== null) {
    kcal = round((raw.kj * factor) / 4.184, 1);
    warnings.push('Energy worked out from kJ.');
  }
  const nutrients = {
    kcal, protein: per(raw.protein), carbs: per(raw.carbs), sugars: per(raw.sugars), fat: per(raw.fat), satfat: per(raw.satfat),
    fibre: per(raw.fibre), salt: per(raw.salt), caffeine: raw.caffeine_mg === null ? null : per(raw.caffeine_mg), alcohol: null,
  };
  // EU energy factors: 4 kcal/g protein and carbs, 9 fat, 2 fibre. A big gap usually means a misread.
  if (kcal !== null && [nutrients.protein, nutrients.carbs, nutrients.fat].every((v) => v !== null)) {
    const est = 4 * nutrients.protein + 4 * nutrients.carbs + 9 * nutrients.fat + 2 * (nutrients.fibre || 0);
    if (Math.abs(est - kcal) > Math.max(15, kcal * 0.2)) warnings.push(`The energy (${round(kcal, 0)} kcal) does not match the macros (about ${round(est, 0)} kcal). Check the numbers against the label.`);
  }
  if (nutrients.sugars !== null && nutrients.carbs !== null && nutrients.sugars > nutrients.carbs + 0.5) warnings.push('Sugars read higher than carbs. Check both.');
  if (nutrients.satfat !== null && nutrients.fat !== null && nutrients.satfat > nutrients.fat + 0.5) warnings.push('Saturates read higher than fat. Check both.');
  const p = read.product;
  return {
    name: [p?.name, p?.variant].filter(Boolean).join(' ') || '',
    brand: p?.brand || '',
    barcode: scanned || lookupCode(read.barcode) || '',
    basis,
    nutrients,
    serving: l.serving_size > 0 ? { size: l.serving_size, unit: l.serving_unit === 'ml' ? 'ml' : 'g', label: l.serving_label || '' } : null,
    pack: p?.pack_size > 0 ? { size: p.pack_size, unit: p.pack_unit === 'ml' ? 'ml' : 'g', count: p.pack_count > 1 ? p.pack_count : null } : null,
    warnings,
  };
}

// ---------- 1. Understand ----------

const clip = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const positive = (v, max) => (Number.isFinite(v) && v > 0 && v <= max ? v : null);

// One understood food, cleaned: empty strings become null, amounts must be believable, and the
// estimated profile is checked like any other fill. Takes the reading's items and the coach's.
export function understood(raw = {}) {
  const unit = UNITS.includes(raw.unit) ? raw.unit : 'g';
  const amount = positive(Number(raw.amount), unit === 'piece' ? 50 : 5000);
  const weight = positive(Number(raw.weight), 5000) ?? (unit === 'piece' ? null : amount);
  const phrases = [raw.searches, raw.search].flat().map((s) => clip(s, 80)).filter(Boolean);
  const name = clip(raw.name) || phrases[0] || 'Food';
  return {
    name,
    brand: clip(raw.brand, 80) || null,
    variety: clip(raw.variety, 60) || null,
    preparation: clip(raw.preparation, 60) || null,
    size: clip(raw.size, 40) || null,
    amount,
    unit,
    weight,
    confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'medium',
    searches: [...new Set(phrases.length ? phrases : [name])].slice(0, 4),
    fill: cleanFill(raw.per100, unit === 'ml' ? 'ml' : 'g'),
  };
}

// ---------- 2. Retrieve ----------

// Words that say how much rather than what. Every word of a search must match a record, so these
// stay out of searches, and "large fries" looks for fries.
const AMOUNT_WORDS = new Set(['a', 'an', 'the', 'of', 'some', 'from', 'about', 'large', 'medium', 'small', 'regular', 'big', 'little',
  'extra', 'jumbo', 'mini', 'portion', 'portions', 'serving', 'servings', 'handful']);
const words = (s) => norm(s).split(' ').filter((w) => w && !AMOUNT_WORDS.has(w));
const phrase = (...parts) => words(parts.filter(Boolean).join(' ')).slice(0, 6).join(' ');
const looser = (q) => q.split(' ').map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');

// Most specific first: the brand with each phrase, the name with its variety, then the plain phrases
// and the plain name. The last word of the name ("fries", "grapes") is a last resort.
function queriesFor(u) {
  const out = [];
  const add = (q) => { if (q && !out.includes(q)) out.push(q); };
  const brand = phrase(u.brand);
  const plain = u.searches.map((s) => phrase(s)).filter(Boolean);
  if (brand) {
    for (const s of plain) add(s.includes(brand) ? s : phrase(brand, s));
    add(phrase(brand, u.name));
  }
  if (u.variety) add(phrase(u.variety, u.name));
  for (const s of plain) add(brand ? phrase(s.replace(brand, '')) : s);
  add(phrase(u.name));
  const head = words(u.name).filter((w) => w.length > 2).pop() || null;
  return { queries: out.slice(0, 9), head: head && !out.includes(head) ? head : null };
}

// Versions that change what is in it are different foods: "Capri Sun Zero" is not Capri Sun, and decaf
// is not coffee. Each kind has its words; a kind he named must be on the record (or, for sugar free,
// the record must have next to no sugar), and a kind only the record names counts against it.
const VARIANTS = {
  'sugar free': ['zero', 'diet', 'sugar free', 'sugarfree', 'sugarless', 'no sugar', 'no sugars', 'no added sugar', 'no added sugars', 'zero sugar', 'unsweetened'],
  light: ['light', 'lite', 'low fat', 'reduced fat', 'fat free', 'skinny', 'low calorie'],
  decaf: ['decaf', 'decaffeinated', 'caffeine free'],
  'alcohol free': ['alcohol free', 'non alcoholic', 'alcoholfree', '0 0'],
};
// Only these words on a record mark it as a different version from the plain food: "light" and
// "unsweetened" are everyday words in plain names (chicken light meat, unsweetened cocoa).
const STRONG = {
  'sugar free': ['zero', 'diet', 'sugar free', 'sugarfree', 'no sugar', 'no added sugar', 'zero sugar'],
  decaf: ['decaf', 'decaffeinated', 'caffeine free'],
  'alcohol free': ['alcohol free', 'non alcoholic', 'alcoholfree', '0 0'],
};
export function variantsOf(...texts) {
  const t = ` ${norm(texts.flat().filter(Boolean).join(' '))} `;
  return new Set(Object.entries(VARIANTS).filter(([, list]) => list.some((w) => t.includes(` ${w} `))).map(([k]) => k));
}
const strongOf = (rec) => {
  const t = ` ${norm([rec.brand, rec.name].filter(Boolean).join(' '))} `;
  return new Set(Object.entries(STRONG).filter(([, list]) => list.some((w) => t.includes(` ${w} `))).map(([k]) => k));
};
const recordVariants = (rec) => variantsOf(rec.brand, rec.name, ...(rec.aliases || []));
const saidVariants = (u) => variantsOf(u.name, u.brand, u.variety, ...u.searches);
// A version he named that the record is not. Sugar free also passes a record with at most 1 g of sugars per 100.
function missingVariant(rec, said) {
  const has = recordVariants(rec);
  return [...said].find((k) => !has.has(k) && !(k === 'sugar free' && num(rec.nutrients?.sugars) !== null && rec.nutrients.sugars <= 1)) || null;
}

// How close a record is to what was understood. A named brand or restaurant decides first (its own
// record far ahead, another brand's product pushed back), then the name or search words, variety and
// preparation; a drink against a food, and words he never said, count against it.
function scoreFor(rec, u) {
  const tokens = new Set(norm([rec.brand, rec.name, ...(rec.aliases || []), rec.state].filter(Boolean).join(' ')).split(' '));
  const has = (w) => tokens.has(w) || tokens.has(`${w}s`) || tokens.has(`${w}es`) || (w.endsWith('s') && tokens.has(w.slice(0, -1)))
    || (w.endsWith('es') && tokens.has(w.slice(0, -2)));
  const share = (s) => {
    const ws = words(s);
    return ws.length ? ws.filter(has).length / ws.length : 0;
  };
  const brandWords = new Set(words(u.brand));
  const nameShare = share(u.name);
  const searchShare = Math.max(0, ...u.searches.map((s) => share(words(s).filter((w) => !brandWords.has(w)).join(' '))));
  // The same food at all: most of its name or of a search phrase. A brand alone never makes a match.
  const same = nameShare >= 0.5 || searchShare >= 0.5;
  const brandMatch = brandWords.size > 0 && share(u.brand) === 1;
  let score = 30 * nameShare + 15 * searchShare;
  if (brandMatch && same) score += 100;
  else if (rec.brand || rec.kind === 'product') score -= u.brand && !brandMatch ? 30 : 5;
  if (u.variety) score += 20 * share(u.variety);
  if (u.preparation) score += 10 * share(u.preparation);
  // `anyForm`: nothing says whether it was eaten or drunk (the filler's quick adds with no amount).
  if (!u.anyForm && (u.unit === 'ml') !== Boolean(rec.liquid)) score -= 15;
  const said = new Set(words([u.name, u.brand, u.variety, u.preparation, ...u.searches].filter(Boolean).join(' ')));
  score -= Math.min(10, [...tokens].filter((t) => t && !said.has(t) && !said.has(`${t}s`) && !said.has(t.replace(/s$/, ''))).length);
  // The same version: a zero for a zero gains; a diet or light record for a plain request loses.
  const saidV = saidVariants(u);
  const recV = recordVariants(rec);
  const otherVersion = [...strongOf(rec)].some((k) => !saidV.has(k));
  score += 20 * [...saidV].filter((k) => recV.has(k)).length - (otherVersion ? 40 : 0);
  // Hand-picked records (clean names, checked portions) win a tie with the bulk USDA rows.
  if (!String(rec.key).startsWith('fdc-')) score += 3;
  // Good enough to log without the AI: every word of the name, or of a search phrase of two words or
  // more ("french fries" for "chips"), and never another brand's product passed off as the one he named.
  const whole = nameShare === 1 || u.searches.some((s) => {
    const ws = words(s).filter((w) => !brandWords.has(w));
    return ws.length >= 2 && ws.every(has);
  });
  const otherBrand = Boolean(u.brand) && !brandMatch && Boolean(rec.brand);
  return { score, brandMatch: brandMatch && same, fits: whole && !otherBrand && !otherVersion };
}

const SHORTLIST = 12;

// Several searches for one food, deduplicated into a ranked shortlist of about 12 records. Records
// with no energy value of their own (placeholders waiting for a label) are left out: logging one
// would be the estimate under a record's name. `keep` narrows the pool further (the filler takes
// USDA records only, as references).
export async function shortlistFor(u, { keep = null } = {}) {
  const pool = new Map();
  // A zero, diet, light, decaf or alcohol-free version he named is never offered the regular one.
  const said = saidVariants(u);
  const take = (rows) => {
    for (const r of rows) {
      if (pool.has(r.key) || num(r.nutrients?.kcal) === null || r.status === 'needs-label') continue;
      if (keep && !keep(r)) continue;
      if (said.size && missingVariant(r, said)) continue;
      pool.set(r.key, r);
    }
  };
  const { queries, head } = queriesFor(u);
  for (const q of queries) {
    // A narrowed pool looks further down each search, past the records it leaves out.
    const limit = keep ? 30 : 10;
    let rows = await searchFoods(q, { limit });
    if (!rows.length && looser(q) !== q) rows = await searchFoods(looser(q), { limit });
    take(rows);
  }
  if (pool.size < 4 && head) take(await searchFoods(head, { limit: keep ? 30 : 10 }));
  const ranked = [...pool.values()].map((r, order) => ({ r, ...scoreFor(r, u), order }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, SHORTLIST);
  return { list: ranked.map((x) => x.r), rank: new Map(ranked.map((x) => [x.r.key, x])) };
}

// ---------- 3. Choose ----------

const SIZES = ['small', 'medium', 'large', 'regular', 'extra', 'jumbo', 'kids', 'king', 'mini', 'big'];

// The portion named by his size words: "large" finds "1 large serving" but not "1 extra large".
// "regular" falls back to medium, "big" means large.
function sizedPortion(rec, size) {
  const said = norm(size).split(' ').filter((w) => SIZES.includes(w)).map((w) => (w === 'big' ? 'large' : w));
  if (!said.length) return null;
  const tries = said.includes('regular') ? [said, said.map((w) => (w === 'regular' ? 'medium' : w))] : [said];
  for (const want of tries) {
    const p = (rec.portions || []).find((x) => {
      const t = new Set(norm(x.label).split(' '));
      return (x.g || x.ml) && want.every((w) => t.has(w)) && SIZES.every((w) => want.includes(w) || !t.has(w));
    });
    if (p) return p;
  }
  return null;
}

function inGrams(rec, amount, unit) {
  if (!amount) return { qty: null, unit: rec.basis };
  const u = unit === 'ml' ? 'ml' : 'g';
  return { qty: round(amount, 0), unit: resolve(rec, amount, u).error ? rec.basis : u };
}

// The amount in a unit this record takes: the portion his size word names, a count of pieces as the
// record's medium (or first) portion, otherwise the estimate in grams or ml.
function localUnit(rec, u) {
  const pw = (x) => x.g || x.ml || null;
  const sized = sizedPortion(rec, u.size);
  if (sized) {
    let qty = 1;
    if (u.unit === 'piece' && u.amount) qty = u.amount;
    else if (u.weight && pw(sized)) {
      const r = u.weight / pw(sized);
      if (r < 0.75 || r > 1.4) qty = Math.max(0.5, Math.round(r * 2) / 2);
    }
    return { qty, unit: `p:${sized.label}` };
  }
  if (u.unit === 'piece') {
    const p = (rec.portions || []).find((x) => /\bmedium\b/i.test(x.label) && pw(x)) || (rec.portions || []).find((x) => pw(x));
    if (p) return { qty: u.amount || 1, unit: `p:${p.label}` };
    return inGrams(rec, u.weight, 'g');
  }
  return inGrams(rec, u.amount, u.unit);
}

function localWhy(rec, u, unit, brandMatch) {
  const portion = unit?.startsWith('p:') ? `, ${unit.slice(2)}` : '';
  if (u.brand && !brandMatch) return `No ${u.brand} record in the catalogue, so the closest general one${portion}`;
  if (u.brand) return `${u.brand}'s own record${portion}`;
  return `Closest record in the catalogue${portion}`;
}

// The choice made without the AI: the best-scoring record that is plausibly the same food.
function localPick(u, short) {
  const best = short.list.find((r) => short.rank.get(r.key)?.fits);
  if (!best) return { match: null, qty: null, unit: null, why: null };
  const amount = localUnit(best, u);
  return { match: best, ...amount, why: localWhy(best, u, amount.unit, short.rank.get(best.key).brandMatch) };
}

export const CHOOSE_SCHEMA = obj({
  choices: { type: 'array', items: obj({ item: { type: 'integer' }, key: STR, unit: STR, qty: NUM, why: STR }) },
});

const CHOOSE_SYSTEM = `You pick catalogue records for foods Daniel ate, for Oath, his personal food diary in Malta. He wants every entry as specific as what he said, in every way: the exact restaurant item or brand, the variety and the size. Never a general stand-in when a specific record exists.

For each item you get what was understood (name, brand or restaurant, variety, preparation, size words, an estimated amount) and a shortlist of records from the catalogue with their keys, states, energy and units. Choose one record per item, only from that item's own list:
1. When he named a brand or restaurant, that brand's or restaurant's own record wins over every generic one.
2. Then the variety he named (red grapes over grapes, wholemeal over white).
3. Then the state or preparation (cooked over dry when he ate it cooked, fried when it was fried).
4. A generic record only when no record in the list is more specific and still the same food. Then say so in why, e.g. "No Burger King fries in the catalogue, so generic fast-food fries".
5. key "" (empty) when nothing in the list is honestly the same food, including another brand's version of a branded food. An empty key is better than a wrong match: his estimate is logged instead.
6. A version that changes what is in it is a different food: zero, diet, sugar free, light, decaf, alcohol free. Never pick the regular version for one of these (Capri Sun for a Capri Sun Zero, Coke for a Coke Zero), or one of these for the regular food. With no record of the right version, key "".

Unit and qty, from the chosen record's units only, written exactly as listed:
- When his size word matches a portion ("large" and "p:1 large serving"), use that portion, with qty how many of it (usually 1).
- Otherwise a portion whose weight fits the estimate, with qty how many of it, or "g" (or "ml" for a drink measured by volume) with qty the estimated amount.
- qty is more than zero.

why: one short line in plain UK English, at most 12 words, saying why this record and amount, e.g. "Burger King's own large fries" or "Red grapes; a medium bowl is about a cup". Never judge the food.

Give one choice per item, with its item number.`;

function candidateLine(r) {
  const units = (r.units || []).slice(0, 10).map((x) => {
    if (x.unit.startsWith('p:')) return `${x.unit} (${round(x.g ?? x.ml, 1)} ${x.g ? 'g' : 'ml'})`;
    if (x.unit === 'serving' && r.serving) return `serving (${r.serving.size} ${r.serving.unit})`;
    if (x.unit === 'pack' && r.pack) return `pack (${r.pack.size} ${r.pack.unit})`;
    return x.unit;
  });
  return `  - key ${r.key} | ${r.name}${r.brand ? ` | brand ${r.brand}` : ''} | ${r.state || 'state not given'} | ${r.kind}, ${r.source} | ${round(r.nutrients.kcal, 0)} kcal per 100 ${r.basis} | units: ${units.join('; ')}`;
}

function itemBlock(u, i, list) {
  const amount = u.amount
    ? `estimated ${round(u.amount, 1)} ${u.unit === 'piece' ? (u.amount === 1 ? 'piece' : 'pieces') : u.unit}${u.unit === 'piece' && u.weight ? ` (about ${round(u.weight, 0)} g)` : ''}`
    : 'no amount estimate';
  const said = [
    `name "${u.name}"`,
    u.brand ? `brand or restaurant "${u.brand}"` : 'no brand named',
    u.variety ? `variety "${u.variety}"` : null,
    u.preparation ? `preparation "${u.preparation}"` : null,
    u.size ? `size words "${u.size}"` : 'no size words',
    amount,
  ].filter(Boolean).join(', ');
  return `Item ${i}: ${said}\n${list.map(candidateLine).join('\n')}`;
}

const validUnit = (rec, unit, qty) => Number.isFinite(qty) && qty > 0 && (rec.units || []).some((x) => x.unit === unit) && !resolve(rec, qty, unit).error;

// One choice from the AI, checked: the key must be on this item's list (an unknown key leaves the
// local choice standing) and the unit one the record takes (otherwise the local amount is used).
function applyChoice(u, short, c) {
  const why = clip(c.why, 160);
  const key = clip(c.key, 160);
  if (!key || key === 'null') return { match: null, qty: null, unit: null, why: why || 'Nothing in the catalogue is this food.' };
  const rec = short.list.find((r) => r.key === key);
  if (!rec) return null;
  const qty = Number(c.qty);
  const amount = validUnit(rec, c.unit, qty) ? { qty: round(qty, c.unit === 'g' || c.unit === 'ml' ? 1 : 2), unit: c.unit } : localUnit(rec, u);
  return { match: rec, ...amount, why: why || localWhy(rec, u, amount.unit, short.rank.get(rec.key)?.brandMatch) };
}

// One structured call for every item that has a shortlist. Returns one pick per item:
// { match, qty, unit, why }, with match null when nothing fits. `note` tells the model what the
// choice is for when it is not a meal being logged (the filler's references).
export async function chooseRecords(items, shortlists, { context = '', note = '' } = {}) {
  const local = items.map((u, i) => localPick(u, shortlists[i]));
  const asked = items.map((_, i) => i).filter((i) => shortlists[i].list.length);
  if (!asked.length || !aiEnabled()) return local;
  const prompt = [
    note || null,
    context ? `What he said, or what the photo showed: ${clip(context, 600)}` : null,
    ...asked.map((i) => itemBlock(items[i], i, shortlists[i].list)),
  ].filter(Boolean).join('\n\n');
  let read;
  try {
    read = await readStructured({ system: CHOOSE_SYSTEM, schema: CHOOSE_SCHEMA, content: [{ type: 'text', text: prompt }], maxTokens: 8000 });
  } catch (err) {
    console.warn('food choice failed, using the local choice:', err.status || '', err.message);
    return local;
  }
  if (read.refused || !Array.isArray(read.choices)) return local;
  const out = [...local];
  const done = new Set();
  for (const c of read.choices) {
    const i = Number(c?.item);
    if (!asked.includes(i) || done.has(i)) continue;
    done.add(i);
    out[i] = applyChoice(items[i], shortlists[i], c) ?? local[i];
  }
  return out;
}

// ---------- The review item ----------

// The estimate for the whole amount, from the profile per 100 and the weight: what an item with no
// record logs as a quick add.
function guessFor(u) {
  const values = Object.fromEntries(FILL_KEYS.map((k) => [k, u.fill && u.weight && u.fill[k] !== null ? round((u.fill[k] * u.weight) / 100, k === 'salt' ? 2 : 1) : null]));
  return { ...values, amount: u.amount === null ? null : round(u.amount, 1), unit: u.unit, weight: u.weight === null ? null : round(u.weight, 0) };
}

// What the phone shows for one food: the chosen record and amount (or none), the shortlist as
// alternatives, why it was chosen, and the estimate: `fill` per 100 for the gaps in the record,
// `guess` for the whole amount when there is no record.
function reviewItem(u, short, pick) {
  const match = pick?.match || null;
  const amount = match ? { qty: pick.qty, unit: pick.unit } : { qty: u.unit === 'piece' || !u.amount ? null : round(u.amount, 0), unit: u.unit === 'piece' ? 'g' : u.unit };
  return {
    name: u.name,
    brand: u.brand,
    size: u.size,
    search: u.searches[0] || u.name,
    confidence: u.confidence,
    ...amount,
    estimate: true,
    match,
    alternatives: short.list.filter((r) => r.key !== match?.key).slice(0, 6),
    why: pick?.why || 'Nothing in the catalogue is this food, so it is logged as an estimate.',
    fill: u.fill,
    guess: guessFor(u),
  };
}

// Retrieve and Choose for understood foods: one review item each, in order.
export async function matchItems(items, { context = '' } = {}) {
  if (!items.length) return [];
  const shortlists = await Promise.all(items.map((u) => shortlistFor(u)));
  const picks = await chooseRecords(items, shortlists, { context });
  const out = items.map((u, i) => reviewItem(u, shortlists[i], picks[i]));
  await logEvent('food_match', { items: out.length, matched: out.filter((x) => x.match).length });
  return out;
}

// ---------- Photos ----------

// `barcode` is a hint from the live scanner: a code it read and no database knew. A label photographed
// after it is saved under that code, so the next scan finds it.
export async function readFoodPhoto({ image, media_type: mediaType = 'image/jpeg', note = '', barcode = '' } = {}) {
  if (typeof image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) throw new RuleError('Send the photo as base64.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) throw new RuleError('Send a JPEG, PNG or WebP photo.');
  if (Buffer.byteLength(image, 'base64') > 4.5 * 1024 * 1024) throw new RuleError('That photo is too big. Try again; the app shrinks it first.');
  const said = note ? String(note).slice(0, 300) : '';
  const scanned = barcode ? lookupCode(barcode) : null;
  const read = await readStructured({
    system: SYSTEM,
    schema: PHOTO_SCHEMA,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
      { type: 'text', text: said ? `Daniel says: ${said}` : 'What is in this photo?' },
    ],
    maxTokens: 10000,
  });
  if (read.refused) return { kind: 'unclear', summary: '', question: 'I could not read that photo. What is it?' };
  Object.assign(read, photoFromWire(read));
  await logEvent('food_photo', { kind: read.kind });
  const code = read.barcode ? read.barcode.replace(/\D/g, '') : '';
  const goodCode = scanned || lookupCode(code);

  if (read.kind === 'label') return { kind: 'label', summary: read.summary, draft: labelDraft(read, scanned) };

  if (read.kind === 'barcode' || read.kind === 'packet') {
    let item = null;
    let offError = null;
    if (goodCode) {
      try {
        item = await productByBarcode(goodCode);
      } catch (err) {
        offError = err.message;
      }
    }
    if (item) return { kind: 'product', summary: read.summary, barcode: goodCode, item };
    const words = [read.product?.brand, read.product?.name, read.product?.variant].filter(Boolean).join(' ');
    const suggestions = words ? await searchFoods(words, { limit: 8 }) : [];
    return {
      kind: 'product-unknown',
      summary: read.summary,
      barcode: goodCode,
      unreadBarcode: Boolean(code && !goodCode),
      read: read.product,
      suggestions,
      offError,
      draft: read.label ? labelDraft(read, scanned) : null,
    };
  }

  if (read.kind === 'meal' && read.items?.length) {
    const context = [read.summary, said && `Daniel says: ${said}`].filter(Boolean).join('. ');
    const items = await matchItems(read.items.slice(0, 12).map(understood), { context });
    return { kind: 'meal', summary: read.summary, items };
  }
  return { kind: 'unclear', summary: read.summary, question: read.question || 'What is it?' };
}

// ---------- "What did you eat?" ----------

export const TEXT_SCHEMA = obj({
  kind: { type: 'string', enum: ['meal', 'unclear'] },
  summary: STR,
  items: { type: 'array', items: obj(MEAL_ITEM) },
  question: maybe(STR),
});

const TEXT_SYSTEM = `You read what Daniel typed into Oath, a personal food diary used in Malta, and list what he ate or drank using the schema.

kind:
- "meal": the text says what he ate or drank. List each separate food or drink in items, following the item rules below.
- "unclear": the text is not food or drink, or you cannot tell what he had. Put one short, friendly question in question, and leave items empty.

summary is one short line, such as "Large Burger King fries and a Coke". Never judge the food or call it good or bad.

Item rules:
${ITEM_RULES}`;

export async function readFoodText({ text } = {}) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!words) throw new RuleError('Type what you ate first.');
  if (words.length > 600) throw new RuleError('That is a lot at once. Type one meal at a time.');
  if (!aiEnabled()) throw new RuleError('Working out a typed meal needs the AI key, which is not set on the server.', 503);
  const read = await readStructured({ system: TEXT_SYSTEM, schema: TEXT_SCHEMA, content: [{ type: 'text', text: words }], maxTokens: 10000 });
  const unclear = (question) => ({ kind: 'unclear', source: 'text', summary: read.summary || '', question });
  if (read.refused) return unclear('I could not read that as food. What did you have?');
  await logEvent('food_text', { kind: read.kind, items: read.items?.length || 0 });
  if (read.kind !== 'meal' || !read.items?.length) {
    return unclear(read.question || 'That does not read like food or drink. Try something like "two eggs on toast and a flat white".');
  }
  const items = await matchItems(read.items.slice(0, 12).map(understood), { context: words });
  return { kind: 'meal', source: 'text', summary: read.summary, items };
}
