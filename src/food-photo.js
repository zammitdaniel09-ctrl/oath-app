// "Take a photo of anything": one Claude vision reading, held to a JSON schema, turned into something
// Daniel confirms before it is logged.
//
// - Barcode or packet: the digits and name are read, then the catalogue, then Open Food Facts.
// - Nutrition label: the printed values become a draft record for him to check and save.
// - Meal or plate: each food is matched to a catalogue record, so the nutrition always comes from a
//   record. Only the amounts are estimated, and they are flagged as estimates until he changes them.
// - Anything else: he is asked what it is.
// The photo itself is never stored.
import { logEvent } from './db.js';
import { RuleError } from './engine.js';
import { readStructured } from './coach.js';
import { searchFoods } from './food.js';
import { productByBarcode } from './off.js';
import { resolve, round } from '../public/nutrition.js';

const STR = { type: 'string' };
const NUM = { type: 'number' };
const maybe = (s) => ({ anyOf: [s, { type: 'null' }] });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const LABEL_KEYS = ['kcal', 'kj', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine_mg'];

export const PHOTO_SCHEMA = obj({
  kind: { type: 'string', enum: ['barcode', 'label', 'packet', 'meal', 'unclear'] },
  summary: STR,
  barcode: maybe(STR),
  product: maybe(obj({
    name: STR,
    brand: maybe(STR),
    variant: maybe(STR),
    pack_size: maybe(NUM),
    pack_unit: maybe({ type: 'string', enum: ['g', 'ml'] }),
    pack_count: maybe({ type: 'integer' }),
  })),
  label: maybe(obj({
    basis: { type: 'string', enum: ['100g', '100ml', 'serving'] },
    serving_size: maybe(NUM),
    serving_unit: maybe({ type: 'string', enum: ['g', 'ml'] }),
    serving_label: maybe(STR),
    ...Object.fromEntries(LABEL_KEYS.map((k) => [k, maybe(NUM)])),
  })),
  items: {
    type: 'array',
    items: obj({
      name: STR,
      search: STR,
      amount: NUM,
      unit: { type: 'string', enum: ['g', 'ml', 'piece'] },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    }),
  },
  question: maybe(STR),
});

const SYSTEM = `You read photos for Oath, a personal food diary used in Malta. Say what the photo shows using the schema.

kind:
- "barcode": a barcode is readable. Put every digit in barcode, exactly as printed under the bars. Also fill product if the packet is visible.
- "packet": a packaged product with no readable barcode. Fill product with the name, brand and variant as printed, and pack size if printed (for "6 x 330 ml" give pack_size 1980, pack_unit "ml", pack_count 6).
- "label": a nutrition information table. Fill label with the values exactly as printed in the per 100 g or per 100 ml column; use the per serving column (basis "serving", with serving_size) only if there is no per 100 column. Copy numbers, never work them out. A value that is not printed is null. Salt as printed; if only sodium is printed, leave salt null. caffeine_mg only if a caffeine amount is printed. Fill product from the packet if visible.
- "meal": food or drink ready to eat (a plate, a bowl, a sandwich, a glass). List each separate food in items: name in plain UK English, search as 2 to 4 generic words that would find it in a food database (for example "chicken breast roasted", "white rice cooked", "olive oil", "banana"), your best estimate of the edible amount in grams (ml for drinks, "piece" with a count for whole countable items like an egg or a banana), and how confident you are. Include visible oil, butter, sauces and dressings as their own items. Never give calories or nutrients for a meal.
- "unclear": you cannot tell what it is, or it is not food or drink. Put a short question in question.

Use null for anything you cannot read. Never guess a barcode digit, a brand or a label value. summary is one short line saying what you see.`;

const validEan = (code) => {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((a, d, i) => a + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
};

// The label as a draft record per 100 g or ml. Values per serving are scaled by the printed serving size;
// kcal comes from kJ ÷ 4.184 only when kcal was not printed. Warnings flag readings that don't add up.
export function labelDraft(read) {
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
    barcode: read.barcode && validEan(read.barcode.replace(/\D/g, '')) ? read.barcode.replace(/\D/g, '') : '',
    basis,
    nutrients,
    serving: l.serving_size > 0 ? { size: l.serving_size, unit: l.serving_unit === 'ml' ? 'ml' : 'g', label: l.serving_label || '' } : null,
    pack: p?.pack_size > 0 ? { size: p.pack_size, unit: p.pack_unit === 'ml' ? 'ml' : 'g', count: p.pack_count > 1 ? p.pack_count : null } : null,
    warnings,
  };
}

// The amount the reading gave, in a unit this record can take. A count of pieces uses the record's
// "medium" portion (or its first portion); without a portion the amount is left for Daniel to fill in.
function amountFor(item, est) {
  if (!item) return { qty: est.unit === 'piece' ? null : round(est.amount, 0), unit: est.unit === 'piece' ? 'g' : est.unit };
  if (est.unit === 'piece') {
    const p = item.portions.find((x) => /\bmedium\b/i.test(x.label)) || item.portions.find((x) => x.g || x.ml);
    return p ? { qty: est.amount, unit: `p:${p.label}` } : { qty: null, unit: item.basis };
  }
  const unit = est.unit;
  if (!resolve(item, est.amount || 1, unit).error) return { qty: round(est.amount, 0), unit };
  return { qty: round(est.amount, 0), unit: item.basis };
}

// Shared with the coach and the "type what you ate" box: one estimated item matched to a record.
export async function matchMealItem(est) {
  let found = await searchFoods(est.search, { limit: 6 });
  if (!found.length) found = await searchFoods(est.name, { limit: 6 });
  const match = found[0] || null;
  return {
    name: est.name,
    search: est.search,
    confidence: est.confidence,
    ...amountFor(match, est),
    estimate: true,
    match,
    alternatives: found.slice(1, 5),
  };
}

export async function readFoodPhoto({ image, media_type: mediaType = 'image/jpeg', note = '' } = {}) {
  if (typeof image !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) throw new RuleError('Send the photo as base64.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) throw new RuleError('Send a JPEG, PNG or WebP photo.');
  if (Buffer.byteLength(image, 'base64') > 4.5 * 1024 * 1024) throw new RuleError('That photo is too big. Try again; the app shrinks it first.');
  const read = await readStructured({
    system: SYSTEM,
    schema: PHOTO_SCHEMA,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
      { type: 'text', text: note ? `Daniel says: ${String(note).slice(0, 300)}` : 'What is in this photo?' },
    ],
  });
  if (read.refused) return { kind: 'unclear', summary: '', question: 'I could not read that photo. What is it?' };
  await logEvent('food_photo', { kind: read.kind });
  const code = read.barcode ? read.barcode.replace(/\D/g, '') : '';
  const goodCode = code && validEan(code) ? code : null;

  if (read.kind === 'label') return { kind: 'label', summary: read.summary, draft: labelDraft(read) };

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
      draft: read.label ? labelDraft(read) : null,
    };
  }

  if (read.kind === 'meal' && read.items.length) {
    const items = [];
    for (const est of read.items.slice(0, 12)) items.push(await matchMealItem(est));
    return { kind: 'meal', summary: read.summary, items };
  }
  return { kind: 'unclear', summary: read.summary, question: read.question || 'What is it?' };
}
