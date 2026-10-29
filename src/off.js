// Open Food Facts: packaged products by barcode or name, cached in the catalogue.
// Data © Open Food Facts contributors, under the Open Database License (ODbL); credited in the app.
//
// Their limits are 15 product reads and 10 searches a minute per IP, with a User-Agent that names the
// app. Calls queue behind a spacer so Oath never goes over, and a product is fetched once and kept.
import { db, getKV, setKV, logEvent } from './db.js';
import { RuleError } from './engine.js';
import { upsertItem, shapeItem, itemByKey } from './food.js';
import { NUTRIENT } from '../public/nutrition.js';
import { barcodeVariants } from '../public/barcode.js';

const BASE = 'https://world.openfoodfacts.org';
// Name and country searches go to Open Food Facts' search service; the main site now refuses
// anonymous searches, while single-product reads by barcode still work there.
const SEARCH = 'https://search.openfoodfacts.org/search';
// The contact Open Food Facts asks for is the app's own address, read from the environment (the same
// variables the rest of the app uses) because this repository is public. Without one it is generic.
export function userAgent() {
  const domain = process.env.PUBLIC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN;
  const contact = process.env.PUBLIC_URL || process.env.APP_URL || (domain ? `https://${domain}` : '');
  return `Oath/1.0 (personal food diary${contact ? `; ${contact}` : ''})`;
}
const FIELDS = [
  'code', 'product_name', 'product_name_en', 'product_name_mt', 'generic_name', 'brands', 'quantity', 'product_quantity', 'product_quantity_unit',
  'serving_size', 'serving_quantity', 'serving_quantity_unit', 'nutriments', 'nutrition_data_per', 'countries_tags', 'categories_tags',
  'last_modified_t', 'no_nutrition_data', 'nutriscore_grade', 'nova_group',
  // What the tags read beyond the numbers (public/food-tags.js): labels, allergens and traces, additives,
  // the ingredients analysis (vegan, vegetarian, palm oil), the number of ingredients, origins and the
  // Green-Score (named ecoscore_grade before 2025; both are asked for).
  'labels_tags', 'allergens_tags', 'traces_tags', 'additives_tags', 'ingredients_analysis_tags', 'ingredients_n', 'origins_tags',
  'environmental_score_grade', 'ecoscore_grade',
].join(',');

let fetcher = (url, init) => fetch(url, init);
// Lets tests stand in for the network.
export function setOffFetch(fn) {
  fetcher = fn;
}

// One queue per kind of call, spaced to stay under the published limits.
const lanes = { product: { gap: 4100, next: 0, chain: Promise.resolve() }, search: { gap: 6100, next: 0, chain: Promise.resolve() } };
let spacing = true;
export function setOffSpacing(on) {
  spacing = on;
}
function slot(kind) {
  const lane = lanes[kind];
  const run = lane.chain.then(async () => {
    const wait = spacing ? lane.next - Date.now() : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lane.next = Date.now() + lane.gap;
  });
  lane.chain = run.catch(() => {});
  return run;
}

// A failure on their side is said plainly, as a 502, never as Oath's own error.
async function getJson(kind, url) {
  await slot(kind);
  let res;
  try {
    res = await fetcher(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new RuleError('Open Food Facts could not be reached. Try again in a minute.', 502);
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new RuleError('Open Food Facts asked us to slow down. Try again in a minute.', 502);
  if (!res.ok) throw new RuleError(`Open Food Facts is not answering properly (error ${res.status}). Try again later.`, 502);
  try {
    return await res.json();
  } catch {
    throw new RuleError('Open Food Facts sent an answer that could not be read. Try again later.', 502);
  }
}

// ---------- Mapping ----------

const UNIT = { g: 1, kg: 1000, mg: 0.001, ml: 1, cl: 10, dl: 100, l: 1000 };
const isVol = (u) => ['ml', 'cl', 'dl', 'l'].includes(u);

// "6 x 330 ml", "500g", "1,5 L", "4 x 25 g" → { size, unit, count }
export function parseQuantity(q) {
  const s = String(q || '').toLowerCase().replace(',', '.');
  const multi = s.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|mg|ml|cl|dl|l)\b/);
  if (multi) {
    const count = Number(multi[1]);
    const each = Number(multi[2]) * UNIT[multi[3]];
    return { size: each * count, unit: isVol(multi[3]) ? 'ml' : 'g', count };
  }
  const one = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|mg|ml|cl|dl|l)\b/);
  if (one) return { size: Number(one[1]) * UNIT[one[2]], unit: isVol(one[2]) ? 'ml' : 'g' };
  return null;
}

// Open Food Facts keeps minerals, vitamins and cholesterol in grams per 100: [Oath key, their key, factor to
// Oath's unit]. Milligrams are 1000 per gram, micrograms 1,000,000.
const MICRO = [
  ['addsugars', 'added-sugars_100g', 1], ['mufa', 'monounsaturated-fat_100g', 1], ['pufa', 'polyunsaturated-fat_100g', 1], ['transfat', 'trans-fat_100g', 1],
  ['chol', 'cholesterol_100g', 1e3],
  ['potassium', 'potassium_100g', 1e3], ['calcium', 'calcium_100g', 1e3], ['iron', 'iron_100g', 1e3], ['magnesium', 'magnesium_100g', 1e3],
  ['zinc', 'zinc_100g', 1e3], ['phosphorus', 'phosphorus_100g', 1e3], ['selenium', 'selenium_100g', 1e6],
  ['vita', 'vitamin-a_100g', 1e6], ['vitc', 'vitamin-c_100g', 1e3], ['vitd', 'vitamin-d_100g', 1e6], ['vite', 'vitamin-e_100g', 1e3], ['vitk', 'vitamin-k_100g', 1e6],
  ['b1', 'vitamin-b1_100g', 1e3], ['b2', 'vitamin-b2_100g', 1e3], ['b3', 'vitamin-pp_100g', 1e3], ['b6', 'vitamin-b6_100g', 1e3],
  ['folate', 'vitamin-b9_100g', 1e6], ['b12', 'vitamin-b12_100g', 1e6],
];

const num = (x) => {
  const v = typeof x === 'string' ? Number(x.replace(',', '.')) : x;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

// A product from Open Food Facts as a catalogue record. Values are taken as given per 100 g or ml;
// energy comes from kcal, or kJ divided by 4.184 when only kJ was entered. Missing stays missing.
export function mapProduct(p) {
  const code = String(p.code || '').replace(/\D/g, '');
  if (!code) return null;
  const nm = p.nutriments || {};
  const name = (p.product_name_en || p.product_name || p.generic_name || '').trim();
  if (!name) return null;
  const brand = (Array.isArray(p.brands) ? p.brands[0] : String(p.brands || '').split(',')[0])?.trim() || null;
  const pack = parseQuantity(p.quantity) || (num(p.product_quantity) ? { size: num(p.product_quantity), unit: isVol(String(p.product_quantity_unit || '').toLowerCase()) ? 'ml' : 'g' } : null);
  const servingQty = num(p.serving_quantity);
  const servingUnit = String(p.serving_quantity_unit || '').toLowerCase();
  const servingParsed = parseQuantity(p.serving_size);
  const serving = servingQty ? { size: servingQty, unit: isVol(servingUnit) ? 'ml' : servingParsed?.unit || 'g', label: p.serving_size || null } : servingParsed ? { ...servingParsed, label: p.serving_size } : null;
  const liquid = pack?.unit === 'ml' || serving?.unit === 'ml' || (p.categories_tags || []).includes('en:beverages');
  let kcal = num(nm['energy-kcal_100g']);
  let notes = '';
  if (kcal === null && num(nm['energy-kj_100g']) !== null) {
    kcal = Math.round((num(nm['energy-kj_100g']) / 4.184) * 10) / 10;
    notes = 'Energy worked out from kJ (÷ 4.184). ';
  }
  const salt = num(nm.salt_100g) ?? (num(nm.sodium_100g) !== null ? num(nm.sodium_100g) * 2.5 : null);
  if (num(nm.salt_100g) === null && salt !== null) notes += 'Salt worked out from sodium (× 2.5). ';
  // Caffeine is stored by Open Food Facts in grams per 100; Oath keeps mg.
  const caffeine = num(nm.caffeine_100g) !== null ? num(nm.caffeine_100g) * 1000 : null;
  // Alcohol is % by volume there; ethanol weighs 0.789 g per ml.
  const alcohol = num(nm.alcohol_100g) !== null ? Math.round(num(nm.alcohol_100g) * 0.789 * 100) / 100 : null;
  if (alcohol) notes += 'Alcohol in grams from % vol (× 0.789). ';
  const nutrients = {
    kcal, protein: num(nm.proteins_100g), carbs: num(nm.carbohydrates_100g), sugars: num(nm.sugars_100g), fat: num(nm.fat_100g),
    satfat: num(nm['saturated-fat_100g']), fibre: num(nm.fiber_100g), salt, caffeine, alcohol,
  };
  for (const [key, theirs, factor] of MICRO) {
    const v = num(nm[theirs]);
    nutrients[key] = v === null ? null : Math.round(v * factor * 1e4) / 1e4;
  }
  // Values nobody could believe per 100 are dropped rather than kept: the limits are the ones the catalogue enforces.
  for (const k of Object.keys(nutrients)) {
    const v = nutrients[k];
    if (v === null) continue;
    const unit = NUTRIENT[k]?.unit;
    const cap = k === 'kcal' ? 950 : k === 'caffeine' ? 6000 : unit === 'g' ? 100 : unit === 'mg' ? 100000 : 1000000;
    if (v < 0 || v > cap) nutrients[k] = null;
  }
  // The grade and the processing level, as the source gives them. Open Food Facts says "unknown" or
  // "not-applicable" when it has none.
  const grade = String(p.nutriscore_grade || '').trim().toLowerCase();
  const nova = Number(p.nova_group);
  const countries = p.countries_tags || [];
  return {
    key: `off:${code}`,
    kind: 'product',
    name,
    name_mt: p.product_name_mt || null,
    brand,
    barcode: code,
    market: countries.includes('en:malta') ? 'Malta' : countries.includes('en:united-kingdom') ? 'UK' : countries.includes('en:italy') ? 'Italy' : countries[0]?.replace(/^en:/, '') || null,
    category: 'product',
    state: 'as-sold',
    basis: liquid ? 'ml' : 'g',
    nutrients,
    nutriscore: ['a', 'b', 'c', 'd', 'e'].includes(grade) ? grade : null,
    nova: Number.isInteger(nova) && nova >= 1 && nova <= 4 ? nova : null,
    pack: pack ? { ...pack, label: p.quantity || null } : null,
    serving,
    liquid,
    source: 'off',
    source_ref: `${BASE}/product/${code}`,
    source_date: p.last_modified_t ? new Date(p.last_modified_t * 1000).toISOString().slice(0, 10) : null,
    status: kcal === null ? 'incomplete' : 'ok',
    notes: `${notes}Open Food Facts, ODbL.`.trim(),
    facts: {
      labels: p.labels_tags, allergens: p.allergens_tags, traces: p.traces_tags, additives: p.additives_tags, analysis: p.ingredients_analysis_tags,
      categories: p.categories_tags, origins: p.origins_tags, countries: p.countries_tags, ingredients: num(p.ingredients_n),
      eco: p.environmental_score_grade || p.ecoscore_grade || null, from: 'off',
    },
  };
}

// ---------- Calls ----------

function searchUrl(q, { page = 1, limit = 20, popular = false } = {}) {
  const u = new URL(SEARCH);
  u.searchParams.set('q', q);
  u.searchParams.set('page', String(page));
  u.searchParams.set('page_size', String(limit));
  u.searchParams.set('fields', FIELDS);
  if (popular) u.searchParams.set('sort_by', '-unique_scans_n');
  return u.toString();
}

// One barcode: the catalogue first, then Open Food Facts once, cached either way. The catalogue is
// asked for the code with or without leading zeros too, so a UPC-A scan finds the product kept under
// its EAN-13 (and the other way round) without a second record or a call out. A label he photographed
// wins, then a brand's own values (read from its label), then a cached Open Food Facts copy.
export async function productByBarcode(barcode, { refresh = false } = {}) {
  const code = String(barcode || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) return null;
  if (!refresh) {
    const [mine] = await db()`select * from food_items where barcode = any(${barcodeVariants(code)}) and hidden = false
      order by (kind = 'label') desc, (source = 'brand') desc, (barcode = ${code}) desc limit 1`;
    if (mine) return shapeItem(mine);
    const miss = await getKV(`off_miss:${code}`);
    if (miss && Date.now() - miss.at < 7 * 864e5) return null;
  }
  const data = await getJson('product', `${BASE}/api/v2/product/${code}.json?fields=${FIELDS}`);
  const mapped = data?.status === 1 || data?.product ? mapProduct({ ...data.product, code }) : null;
  if (!mapped) {
    await setKV(`off_miss:${code}`, { at: Date.now() });
    return null;
  }
  return shapeItem(await upsertItem(mapped));
}

// A name search on Open Food Facts; results with a name are cached as products.
export async function searchOff(text, { limit = 20 } = {}) {
  // Plain words only: the service reads Lucene syntax, so its operators are stripped.
  const words = String(text || '').slice(0, 80).replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return [];
  const data = await getJson('search', searchUrl(words, { limit }));
  const out = [];
  for (const p of data?.hits || []) {
    const m = mapProduct(p);
    if (m) out.push(shapeItem(await upsertItem(m)));
  }
  return out;
}

// ---------- Import: products sold in Malta, then the brands Daniel buys ----------

export const PRIORITY_BRANDS = ['kinnie', 'red-bull', 'monster-energy', 'cisk', 'twistees', 'lay-s', 'walkers', 'coca-cola', 'pepsi', 'fanta', 'sprite', 'kitkat', 'cadbury', 'nestle', 'mulino-bianco', 'barilla', 'benna', 'farsons', 'magnum', 'ferrero'];

// Resumable: progress is kept in kv, so a stopped run carries on where it left off. `pages` caps one run.
export async function importMalta({ pages = 60, brandPages = 2, log = () => {} } = {}) {
  const state = (await getKV('off_import')) || { malta: 1, maltaDone: false, brands: {}, saved: 0 };
  let used = 0;
  const save = async (products) => {
    let n = 0;
    for (const p of products) {
      const m = mapProduct(p);
      if (m && m.nutrients.kcal !== null) {
        const existing = await itemByKey(m.key);
        if (!existing || existing.source === 'off') {
          await upsertItem(m);
          n += 1;
        }
      }
    }
    state.saved += n;
    return n;
  };
  while (!state.maltaDone && used < pages) {
    const data = await getJson('search', searchUrl('countries_tags:"en:malta"', { page: state.malta, limit: 100, popular: true }));
    used += 1;
    const products = data?.hits || [];
    const n = await save(products);
    log(`malta page ${state.malta}: ${products.length} products, ${n} saved`);
    if (products.length < 100) state.maltaDone = true;
    else state.malta += 1;
    await setKV('off_import', state);
  }
  for (const brand of PRIORITY_BRANDS) {
    const page = state.brands[brand] || 1;
    if (page > brandPages || used >= pages) continue;
    for (let p = page; p <= brandPages && used < pages; p += 1) {
      const data = await getJson('search', searchUrl(`brands_tags:"${brand}"`, { page: p, limit: 100, popular: true }));
      used += 1;
      const products = data?.hits || [];
      const n = await save(products);
      log(`${brand} page ${p}: ${products.length} products, ${n} saved`);
      state.brands[brand] = products.length < 100 ? brandPages + 1 : p + 1;
      await setKV('off_import', state);
      if (products.length < 100) break;
    }
  }
  await logEvent('off_import', { saved: state.saved, calls: used });
  const [{ n }] = await db()`select count(*)::int as n from food_items where source = 'off'`;
  return { calls: used, savedTotal: state.saved, productsInCatalogue: n, done: state.maltaDone && PRIORITY_BRANDS.every((b) => (state.brands[b] || 1) > brandPages) };
}
