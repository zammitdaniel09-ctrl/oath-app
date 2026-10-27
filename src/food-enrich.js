// Filling in what a diary entry does not say, so every entry ends up with all 33 nutrients wherever an
// honest source has them. Four sources, in order, each only for what is still unknown:
// 1. The entry's own record: already in the entry when it was logged.
// 2. A USDA reference: the closest USDA record of the same food in the catalogue (a plain cola for a
//    Coca-Cola from Open Food Facts, a gyro for a chicken kebab), found with the photo pipeline's
//    shortlist and choice and scaled to the amount eaten. A quick add has no weight, so one is worked
//    out from its energy (or a typical portion) and noted.
// 3. The web: for a branded, restaurant or local food with no reference, Claude with the web search
//    tool finds the values its maker publishes and the page they are on. They are saved as a catalogue
//    record (kind 'web', with the address and the date), so the next time costs nothing.
// 4. An estimate: the reading's or the coach's own profile per 100, kept with the entry, else one
//    Claude estimate of every value.
// Every filled value is listed in `filled` (marked "~" on screen) and `fill_source` says where each
// came from. Values on a record or typed by Daniel are never touched, and with no source a value stays
// unknown, never zero.
//
// New entries are filled a moment after they are logged; older ones, and any the first try missed, go
// through a queue the loop drains a few at a time. Each entry is filled once (enriched_at), a failing
// one is tried a few times and then left as it is, Claude is asked only when the catalogue cannot
// answer, every answer is kept by name, and web lookups are capped per day. Without the AI key only
// the USDA reference (and an estimate already kept with the entry) is used.
import { db, getKV, setKV, logEvent } from './db.js';
import { localNow } from './engine.js';
import { aiEnabled, readStructured, claudeCall } from './coach.js';
import { KEYS, norm, round } from '../public/nutrition.js';
import { ESTIMATE_KEYS, MICRO_TEXT, cleanFill, fillGaps, perHundredCap, upsertItem, itemByKey, shapeItem, setAfterLog } from './food.js';
import { understood, shortlistFor, chooseRecords } from './food-photo.js';

export const WEB_PER_DAY = 30; // web lookups a day, at most
export const MAX_TRIES = 3; // failed attempts before an entry is left as it is
const PER_TICK = 4; // entries filled per loop tick
const WEB_PER_BATCH = 1; // web lookups per batch; an entry that needs another waits for the next tick
const RETRY_NONE_DAYS = 30; // "nothing found" is asked again after this, when the catalogue or the web may know more
const PAUSE_MS = 10 * 60000; // after a rate limit or an overload, the filler rests this long
const SOON_MS = 400; // entries logged together (a meal the coach logs) are filled together
const KINDS = ['item', 'quick']; // meals, recipes and batches are made of catalogue lines already

const STR = { type: 'string' };
const NUM = { type: 'number' };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const clip = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const missingOf = (nutrients) => KEYS.filter((k) => num(nutrients?.[k]) === null);
const nameKey = (name, brand) => norm(`${brand || ''} ${name || ''}`).slice(0, 160);
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// A rate limit or an overload pauses the filler instead of counting against the entries.
class Paused extends Error {}
const limited = (err) => [429, 529].includes(err?.status) || err?.error?.type === 'overloaded_error' || err?.error?.error?.type === 'overloaded_error';

// ---------- What was already worked out, by name ----------

async function recall(key) {
  const [r] = await db()`select value, at from food_lookups where key = ${key}`;
  if (!r) return undefined;
  if (r.value?.none && Date.now() - new Date(r.at).getTime() > RETRY_NONE_DAYS * 864e5) return undefined;
  return r.value;
}

async function remember(key, value) {
  const sql = db();
  await sql`insert into food_lookups (key, value) values (${key}, ${sql.json(value)})
            on conflict (key) do update set value = excluded.value, at = now()`;
}

async function recordFor(key) {
  const r = await itemByKey(key);
  return r && !r.hidden ? shapeItem(r) : null;
}

// ---------- One entry being filled ----------

function jobOf(row) {
  const profile = row.fill_profile && typeof row.fill_profile === 'object' ? row.fill_profile : null;
  const nutrients = { ...(row.nutrients || {}) };
  const named = norm(row.name);
  return {
    row,
    id: row.id,
    name: row.name,
    brand: row.brand || null,
    liquid: Boolean(row.liquid),
    grams: num(row.grams) > 0 ? row.grams : null,
    ml: num(row.ml) > 0 ? row.ml : null,
    refKey: row.kind === 'item' ? row.ref_key : null,
    // A quick add with no name says nothing anyone could look up.
    nameless: !named || named === 'quick add',
    nutrients,
    missing: missingOf(nutrients),
    filled: [...(row.filled || [])],
    source: { ...(row.fill_source || {}) },
    fill: profile ? cleanFill(profile, profile.basis) : null,
    searches: (Array.isArray(profile?.searches) ? profile.searches : []).filter((s) => typeof s === 'string'),
    assumed: null,
    ref: null,
    desc: null,
    trouble: null,
    wait: false,
  };
}

// Words that name a typical portion, for a quick add whose energy cannot give its weight.
const TYPICAL = /\b(serving|medium|regular|can|bottle|sandwich|slice|piece|bar|cup|glass|pot|pack|portion|each)\b/i;
function portionsOf(rec) {
  const out = [];
  if (num(rec.serving?.size) > 0) out.push(rec.serving.size);
  const p = (rec.portions || []).find((x) => TYPICAL.test(x.label || '') && (num(x.g) || num(x.ml)));
  if (p) out.push(num(p.g) ?? num(p.ml));
  return out;
}

// How much of a source's basis the entry stands for: its own weight or volume (a drink with no sourced
// density counts 1 g per ml), or for a quick add the amount a first source worked out; else from its
// energy against the source's, else one typical portion. A worked-out amount is noted in `weight`.
function amountFor(j, { basis, density = null, kcal = null, portions = [] }) {
  const d = num(density) > 0 ? density : 1;
  const have = j.grams || j.ml ? { g: j.grams, ml: j.ml } : j.assumed;
  if (have) return { amount: basis === 'ml' ? (have.ml ?? have.g / d) : (have.g ?? have.ml * d) };
  const own = num(j.nutrients.kcal);
  if (own > 0 && num(kcal) > 0) {
    const a = (own / kcal) * 100;
    if (a <= 5000) return { amount: a, weight: { amount: round(a, 0), unit: basis, from: 'energy' } };
  }
  const p = portions.find((x) => num(x) > 0 && x <= 5000);
  return p ? { amount: p, weight: { amount: round(p, 0), unit: basis, from: 'portion' } } : { amount: null };
}

// Fills the entry's gaps from one source per 100 (a record's nutrients or an estimate) and notes where
// they came from. Returns the keys it filled.
function take(j, fill, at, tag, about = {}) {
  if (!(at.amount > 0)) return [];
  const { nutrients, filled } = fillGaps(j.nutrients, at.amount, fill);
  if (!filled.length) return [];
  j.nutrients = nutrients;
  j.filled.push(...filled);
  j.missing = missingOf(nutrients);
  j.source[tag] = { ...about, keys: [...(j.source[tag]?.keys || []), ...filled] };
  if (at.weight && !j.assumed) {
    j.assumed = at.weight.unit === 'ml' ? { ml: at.weight.amount } : { g: at.weight.amount };
    j.source.weight = at.weight;
  }
  return filled;
}

function applyRecord(j, rec, tag) {
  const basis = rec.basis === 'ml' ? 'ml' : 'g';
  const at = amountFor(j, { basis, density: rec.density, kcal: num(rec.nutrients?.kcal), portions: [j.desc?.portion, ...portionsOf(rec)] });
  const about = { key: rec.key, name: rec.name, ...(tag === 'web' ? { url: rec.source_ref } : {}) };
  return take(j, { basis, ...rec.nutrients }, at, tag, about);
}

function applyEstimate(j) {
  const fill = j.fill || j.desc?.per100;
  if (!fill) return [];
  const at = amountFor(j, { basis: fill.basis, kcal: num(fill.kcal), portions: [j.desc?.portion] });
  return take(j, fill, at, 'estimate');
}

// ---------- 2. A USDA reference ----------

const REFERENCE_NOTE = 'These foods are already in his diary; what is wanted now is a stand-in for the vitamins, minerals and other values '
  + 'their own records lack. Every list holds USDA records only. Pick the closest version of the same food, generic if need be (a plain cola '
  + 'for a branded cola, a gyro for a chicken kebab), and give key "" when no record is the same kind of food. The amount does not matter '
  + 'here: any unit from the record\'s list will do.';

// The same food by its energy too: a diet cola is no stand-in for a regular one, nor a salad for a
// pastry. Per 100 within a factor of three, or both next to nothing. With no weight (a quick add), a
// food with energy needs a reference with energy, so the weight can be worked out from it.
function energyFits(j, r) {
  const ref = num(r.nutrients?.kcal);
  const own = num(j.nutrients.kcal);
  if (ref === null || own === null) return true;
  const amount = j.grams ?? j.ml;
  if (!amount) return own > 0 ? ref > 0 : ref < 5;
  const per = (own / amount) * 100;
  if (per < 5 || ref < 5) return per < 5 && ref < 5;
  return per / ref < 3 && ref / per < 3;
}

// A reference is a USDA record, not the entry's own, with a value for something the entry lacks.
const usableFor = (j) => (r) => r?.source === 'usda' && r.key !== j.refKey && j.missing.some((k) => num(r.nutrients?.[k]) !== null) && energyFits(j, r);

// What to search for: the entry's own words (its name, brand and the reading's searches), or the
// generic words a description gave. A quick add with no amount may be a food or a drink.
function askFor(j, generic) {
  const amount = j.ml ?? j.grams ?? undefined;
  const unit = j.liquid ? 'ml' : 'g';
  const u = generic
    ? understood({ name: j.desc.generic || j.name, brand: '', searches: j.desc.searches, amount, unit: j.desc.basis === 'ml' ? 'ml' : unit })
    : understood({ name: j.name, brand: j.brand || '', searches: [...j.searches, j.name], amount, unit });
  return { ...u, anyForm: !amount && !(generic && j.desc.basis) };
}

// One reference per entry: from what was worked out before, else one choice for all that are new
// (the AI's, or the local score's without it).
async function pickReferences(jobs, generic) {
  const ask = [];
  for (const j of jobs) {
    const key = generic ? `ref:generic:${nameKey(j.desc.generic || j.name)}` : j.refKey ? `ref:item:${j.refKey}` : `ref:name:${nameKey(j.name, j.brand)}`;
    const hit = await recall(key);
    if (hit === undefined) {
      ask.push({ j, key, u: askFor(j, generic) });
      continue;
    }
    const rec = hit.key ? await recordFor(hit.key) : null;
    j.ref = rec && usableFor(j)(rec) ? rec : null;
  }
  if (!ask.length) return;
  const shortlists = await Promise.all(ask.map(({ j, u }) => shortlistFor(u, { keep: usableFor(j) })));
  const picks = await chooseRecords(ask.map((a) => a.u), shortlists, { note: REFERENCE_NOTE });
  const ai = aiEnabled();
  for (const [i, { j, key }] of ask.entries()) {
    const rec = picks[i]?.match || null;
    j.ref = rec;
    // "Nothing" is kept only when it is sure: the AI said so, or there was nothing to choose from.
    if (rec) await remember(key, { key: rec.key, name: rec.name });
    else if (ai || !shortlists[i].list.length) await remember(key, { none: true });
  }
}

// ---------- A description: generic words, whether the web is worth asking, and an estimate ----------

const DESCRIBE_SCHEMA = obj({
  foods: {
    type: 'array',
    items: obj({
      item: { type: 'integer' },
      generic: STR,
      searches: { type: 'array', items: STR },
      web: { type: 'boolean' },
      basis: { type: 'string', enum: ['g', 'ml'] },
      portion: NUM,
      per100: obj(Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, NUM]))),
    }),
  },
});

const DESCRIBE_SYSTEM = `You help Oath, a personal food diary used in Malta, fill in what its records lack. Daniel already logged these foods and drinks. For each item give:
- generic: what it is in a few plain words, without the brand, e.g. "bitter orange soft drink" for Kinnie, "cheese puff snack" for Twistees, "chicken kebab in pitta bread".
- searches: 2 or 3 short phrases that would find the closest generic food in a mostly American (USDA) database, most specific first, never a brand and never size words, e.g. "orange soda" and "soft drink" for Kinnie, "gyro sandwich" and "chicken pita" for a chicken kebab. Use the American word where it differs: chips are "french fries", crisps are "potato chips", courgette is "zucchini".
- web: true when it is a branded product, a restaurant or chain item, or a local speciality whose nutrition values are likely published online; false for plain generic food and home cooking.
- basis: "ml" for drinks, otherwise "g".
- portion: one typical portion in grams (ml for drinks), as served in Malta.
- per100: your estimate per 100 g (per 100 ml for drinks) of this exact food, every value, for a brand or restaurant its published values where you know them: kcal; protein, carbs, sugars, fat, satfat, fibre and salt in g; caffeine in mg; alcohol in g; and from typical composition data ${MICRO_TEXT}. Give 0 only when the food really has none.
Give one entry per item, with its item number.`;

function describeLine(j, i) {
  const amount = j.ml ? `${round(j.ml, 0)} ml` : j.grams ? `${round(j.grams, 0)} g` : 'amount not given';
  const kcal = num(j.nutrients.kcal) === null ? 'energy unknown' : `${round(j.nutrients.kcal, 0)} kcal`;
  return `Item ${i}: "${clip(j.name)}"${j.brand ? `, brand or restaurant "${clip(j.brand, 80)}"` : ''}, ${amount}, ${kcal}${j.liquid ? ', a drink' : ''}`;
}

function cleanDescription(f) {
  const basis = f?.basis === 'ml' ? 'ml' : 'g';
  return {
    generic: clip(f?.generic),
    searches: (Array.isArray(f?.searches) ? f.searches : []).map((s) => clip(s, 80)).filter(Boolean).slice(0, 3),
    web: f?.web === true,
    basis,
    portion: num(f?.portion) > 0 && f.portion <= 3000 ? f.portion : null,
    per100: cleanFill(f?.per100, basis),
  };
}

// One structured call for every entry whose name has not been described before.
async function describe(jobs) {
  const ask = [];
  for (const j of jobs) {
    const key = `desc:${nameKey(j.name, j.brand)}`;
    const hit = await recall(key);
    if (hit) j.desc = hit;
    else ask.push({ j, key });
  }
  if (!ask.length) return;
  let read;
  try {
    read = await readStructured({
      system: DESCRIBE_SYSTEM, schema: DESCRIBE_SCHEMA, content: [{ type: 'text', text: ask.map(({ j }, i) => describeLine(j, i)).join('\n') }], maxTokens: 16000,
    });
  } catch (err) {
    if (limited(err)) throw new Paused(err.message);
    for (const { j } of ask) j.trouble = `The estimate failed: ${clip(err.message, 160)}`;
    return;
  }
  if (read.refused) return;
  for (const f of Array.isArray(read.foods) ? read.foods : []) {
    const a = ask[Number(f?.item)];
    if (!a || a.j.desc) continue;
    a.j.desc = cleanDescription(f);
    await remember(a.key, a.j.desc);
  }
}

// ---------- 3. The web ----------

const WEB_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'MT', timezone: 'Europe/Malta' } };

const WEB_SYSTEM = `You look up the published nutrition values of one food or drink for Oath, a personal food diary used in Malta.
Search for the values its maker or restaurant publishes: their own website or nutrition PDF first, then a supermarket or retailer page showing the product's label, then a well-known nutrition database. Never use a forum, a recipe site or another brand's product, and never work values out yourself.
Then say in plain text:
- the exact product or menu item the values are for, and its brand;
- whether they are per 100 g, per 100 ml or per serving, with the serving size in g or ml when per serving;
- every value the page gives: energy, protein, carbohydrate, sugars, fat, saturates, fibre, salt or sodium, and any vitamins, minerals, caffeine or alcohol, each with its unit;
- the address of the page they come from.
If no reliable page gives values for this exact item, say so plainly.`;

const WEB_READ_SYSTEM = `You turn the notes of a web search into a nutrition record for Oath, a personal food diary. Copy each value exactly as the notes give it, converted only into these units: energy in kcal (from kJ divided by 4.184 only when kcal is not given); grams for protein, carbs, sugars, fat, satfat (saturates), fibre, salt, alcohol, addsugars, mufa, pufa and transfat; mg for caffeine, chol, potassium, calcium, iron, magnesium, zinc, phosphorus, vitc, vite, b1, b2, b3 and b6; µg for selenium, vita, vitd, vitk, folate and b12.
values lists only what the notes give, one entry per value (key and number): never estimate one, and leave out anything not given. When only sodium is given, list it as sodium_mg in mg and leave salt out.
per is "100g", "100ml" or "serving" as the notes say, with serving_size and serving_unit when per serving (0 and "" otherwise).
url is the address the values come from, exactly as it appears in the list of pages read. name and brand are the product or menu item as the page names it.
found is false when the notes give no reliable values for this exact item.`;

// No nullable fields (the API allows at most 16 in a schema): a serving size of 0 means none, and the
// values come as a list of only those the notes give, sodium among them.
const WEB_SCHEMA = obj({
  found: { type: 'boolean' },
  name: STR,
  brand: STR,
  url: STR,
  per: { type: 'string', enum: ['100g', '100ml', 'serving'] },
  serving_size: NUM,
  serving_unit: { type: 'string', enum: ['g', 'ml', ''] },
  values: { type: 'array', items: obj({ key: { type: 'string', enum: [...KEYS, 'sodium_mg'] }, value: NUM }) },
});

// The values list as { key: number }, the last of any repeat winning.
const valuesOf = (list) => Object.fromEntries((Array.isArray(list) ? list : []).filter((x) => typeof x?.value === 'number').map((x) => [x.key, x.value]));

// The pages the search really returned or cited, by address: { url: title }.
function sourcesOf(blocks) {
  const out = new Map();
  const add = (url, title) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url) && !out.has(url)) out.set(url, clip(title, 160));
  };
  for (const b of blocks) {
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) add(r?.url, r?.title);
    if (b?.type === 'text') for (const c of b.citations || []) add(c?.url, c?.title);
  }
  return out;
}

const bare = (u) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`.toLowerCase();
  } catch {
    return null;
  }
};
function sourceFor(url, sources) {
  const want = bare(url);
  if (!want) return null;
  for (const [u, title] of sources) if (bare(u) === want) return { url: u, title };
  return null;
}

// Searches the web for one food's published values and saves them as a catalogue record (kind 'web',
// source 'web', the page's address and today's date). Two steps, because structured output cannot be
// combined with web search (its citations are always on): a search that writes notes, then a reading
// of those notes held to a schema. Values are taken only from a page the search really returned; a
// page the model names but the search never saw is not a source. Returns the shaped record, or null.
export async function lookUpOnWeb({ name, brand = null, generic = '', liquid = false }) {
  const what = clip(`${brand && !norm(name).includes(norm(brand)) ? `${brand} ` : ''}${name}`, 160);
  const messages = [{ role: 'user', content: `Find the published nutrition values of: ${what}${generic ? ` (${clip(generic)})` : ''}${liquid ? ', a drink' : ''}.` }];
  const blocks = [];
  let res = null;
  // A long search can pause; sending the turn back as it is lets it carry on, twice at most.
  for (let i = 0; i < 3; i += 1) {
    // Searching and reading pages takes longer than a reply, so this call gets three minutes.
    res = await claudeCall({ max_tokens: 8000, system: WEB_SYSTEM, messages, tools: [WEB_TOOL], output_config: { effort: 'low' } }, { timeout: 180_000 });
    blocks.push(...(res.content || []));
    if (res.stop_reason !== 'pause_turn') break;
    messages.splice(1, messages.length - 1, { role: 'assistant', content: [...blocks] });
  }
  if (!res || ['refusal', 'pause_turn'].includes(res.stop_reason)) return null;
  const notes = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const sources = sourcesOf(blocks);
  if (!notes || !sources.size) return null;
  const pages = [...sources].map(([u, t]) => `- ${u}${t ? ` (${t})` : ''}`).join('\n');
  const read = await readStructured({
    system: WEB_READ_SYSTEM, schema: WEB_SCHEMA, maxTokens: 8000,
    content: [{ type: 'text', text: `Item: ${what}\n\nNotes from the search:\n${notes.slice(0, 8000)}\n\nPages it read:\n${pages}` }],
  });
  if (read.refused || read.found !== true) return null;
  const given = valuesOf(read.values);
  const src = sourceFor(read.url, sources);
  if (!src) return null;
  const per = ['100g', '100ml', 'serving'].includes(read.per) ? read.per : null;
  const size = num(read.serving_size);
  if (!per || (per === 'serving' && !(size > 0))) return null;
  const basis = per === '100ml' || (per === 'serving' && read.serving_unit === 'ml') ? 'ml' : 'g';
  const factor = per === 'serving' ? 100 / size : 1;
  const nutrients = {};
  for (const k of KEYS) {
    const v = num(given[k]);
    const x = v === null || v < 0 ? null : round(v * factor, 4);
    nutrients[k] = x !== null && x <= perHundredCap(k) ? x : null;
  }
  let derived = '';
  const sodium = num(given.sodium_mg);
  if (nutrients.salt === null && sodium !== null && sodium >= 0) {
    const salt = round((sodium * factor * 2.5) / 1000, 4);
    if (salt <= 100) {
      nutrients.salt = salt;
      derived = ' Salt worked out from sodium (× 2.5).';
    }
  }
  // A record needs its energy; values with none are not a record worth keeping.
  if (nutrients.kcal === null) return null;
  const { today } = await localNow();
  const itemName = clip(read.name, 160) || clip(name, 160);
  const itemBrand = clip(read.brand, 80) || brand || null;
  const label = itemBrand && !norm(itemName).includes(norm(itemBrand)) ? `${itemBrand} ${itemName}` : itemName;
  const row = await upsertItem({
    key: `web:${norm(label).replace(/ /g, '-').slice(0, 80) || 'food'}`,
    kind: 'web',
    name: itemName,
    brand: itemBrand,
    aliases: norm(what) !== norm(itemName) ? [what] : [],
    basis,
    liquid: basis === 'ml' || Boolean(liquid),
    state: 'as-sold',
    nutrients,
    serving: per === 'serving' ? { size, unit: basis } : null,
    source: 'web',
    source_ref: src.url,
    source_date: today,
    status: 'ok',
    notes: `Published values from ${src.title || hostOf(src.url)}, found by a web search on ${today}.${derived}`,
  });
  await logEvent('food_web_lookup', { key: row.key, url: src.url });
  return shapeItem(row);
}

// The day's web lookups, kept in kv so a restart does not reset the cap.
async function takeWebSlot() {
  const { today } = await localNow();
  const s = await getKV('food_web_lookups');
  const used = s?.date === today ? Number(s.n) || 0 : 0;
  if (used >= WEB_PER_DAY) return false;
  await setKV('food_web_lookups', { date: today, n: used + 1 });
  return true;
}

export async function webLookupsToday() {
  const { today } = await localNow();
  const s = await getKV('food_web_lookups');
  return s?.date === today ? Number(s.n) || 0 : 0;
}

async function webRecord(j, budget) {
  const key = `web:${nameKey(j.name, j.brand)}`;
  const hit = await recall(key);
  // Logged from the saved web record itself: its values are already the entry's own.
  if (hit !== undefined) return hit.key && hit.key !== j.refKey ? recordFor(hit.key) : null;
  // One lookup a batch; another entry that needs one waits for the next tick.
  if (budget.left <= 0) {
    j.wait = true;
    return null;
  }
  // The day's lookups are used up: an estimate will do for this entry.
  if (!(await takeWebSlot())) return null;
  budget.left -= 1;
  try {
    const rec = await lookUpOnWeb({ name: j.name, brand: j.brand, generic: j.desc?.generic, liquid: j.liquid });
    await remember(key, rec ? { key: rec.key, url: rec.source_ref } : { none: true });
    return rec;
  } catch (err) {
    if (limited(err)) throw new Paused(err.message);
    j.trouble = `The web lookup failed: ${clip(err.message, 160)}`;
    return null;
  }
}

// ---------- A batch ----------

// Writes one entry once. The update only lands if the entry is still there, still unfilled and
// unchanged since it was read; an entry edited in between is left for the next tick, and that counts
// as a try, so nothing can come round for ever.
async function finish(j) {
  if (j.wait) return 'waiting';
  const sql = db();
  if (j.trouble && (j.row.enrich_tries || 0) + 1 < MAX_TRIES) {
    await sql`update food_log set enrich_tries = enrich_tries + 1, enrich_error = ${j.trouble} where id = ${j.id}`;
    return 'failed';
  }
  const added = j.filled.length > (j.row.filled || []).length;
  const rows = await sql`update food_log set nutrients = ${sql.json(j.nutrients)}, filled = ${j.filled}::text[],
      fill_source = ${Object.keys(j.source).length ? sql.json(j.source) : null}, enriched_at = now(), enrich_error = ${j.trouble},
      enrich_tries = enrich_tries + ${j.trouble ? 1 : 0}
    where id = ${j.id} and deleted_at is null and enriched_at is null and nutrients = ${sql.json(j.row.nutrients)}
    returning id`;
  if (!rows.length) {
    await sql`update food_log set enrich_tries = enrich_tries + 1 where id = ${j.id} and enriched_at is null`;
    return 'changed';
  }
  return added ? 'filled' : 'checked';
}

async function fillBatch(rows) {
  const jobs = rows.map(jobOf);
  const todo = jobs.filter((j) => j.missing.length && !j.nameless);
  const ai = aiEnabled();
  try {
    if (todo.length) {
      // 2. A USDA reference, by the entry's own words.
      await pickReferences(todo, false);
      for (const j of todo) if (j.ref) applyRecord(j, j.ref, 'usda');
      if (ai) {
        // One description for those with no reference (it gives generic words to search with and says
        // whether the web is worth asking) or with gaps left and no estimate of their own.
        await describe(todo.filter((j) => j.missing.length && (!j.ref || !j.fill)));
        const again = todo.filter((j) => !j.ref && j.missing.length && j.desc?.searches?.length);
        await pickReferences(again, true);
        for (const j of again) if (j.ref) applyRecord(j, j.ref, 'usda');
        // 3. The web, for branded, restaurant or local food with no reference.
        const budget = { left: WEB_PER_BATCH };
        for (const j of todo) {
          if (j.ref || !j.missing.length || !j.desc?.web) continue;
          const rec = await webRecord(j, budget);
          if (rec) applyRecord(j, rec, 'web');
        }
      }
      // 4. An estimate for whatever is left.
      for (const j of todo) if (j.missing.length && !j.wait) applyEstimate(j);
    }
  } catch (err) {
    if (err instanceof Paused) {
      pausedUntil = Date.now() + PAUSE_MS;
      console.warn('food filler paused:', err.message);
      return { paused: true };
    }
    // Anything else counts as a failed try for the whole batch, so a bad entry can never loop forever.
    console.error('food fill batch failed', err);
    for (const j of todo) {
      j.wait = false;
      j.trouble = `Unexpected: ${clip(err.message, 160)}`;
    }
  }
  const out = { filled: 0, checked: 0, failed: 0, waiting: 0, changed: 0 };
  for (const j of jobs) out[await finish(j)] += 1;
  if (out.filled) await logEvent('food_filled', { entries: out.filled, ai });
  return out;
}

// ---------- The queue ----------

let pausedUntil = 0;
let chain = Promise.resolve();
const soon = new Set();
let timer = null;

// One batch at a time, so new entries and the backfill never race or burst the API.
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function fillRows(rows) {
  if (Date.now() < pausedUntil) return { paused: true };
  const out = { entries: rows.length, filled: 0, checked: 0, failed: 0, waiting: 0, changed: 0 };
  for (let i = 0; i < rows.length; i += PER_TICK) {
    const r = await fillBatch(rows.slice(i, i + PER_TICK));
    if (r.paused) return { ...out, paused: true };
    for (const k of ['filled', 'checked', 'failed', 'waiting', 'changed']) out[k] += r[k];
  }
  return out;
}

// Fills these entries now, if they still need it. New entries come here a moment after they are logged.
export function enrichEntries(ids) {
  return serial(async () => {
    const list = [...new Set((ids || []).map(String))].filter(Boolean);
    if (!list.length) return { entries: 0 };
    const rows = await db()`select * from food_log where id = any(${list}) and deleted_at is null and enriched_at is null
      and enrich_tries < ${MAX_TRIES} and kind = any(${KINDS}) order by at`;
    return fillRows(rows);
  });
}

// One tick of the backfill: the newest entries not filled yet, `limit` at a time. Entries with nothing
// missing are only marked, so they never use up the batch.
export function drainEnrichment({ limit = PER_TICK } = {}) {
  return serial(async () => {
    if (Date.now() < pausedUntil) return { paused: true };
    const sql = db();
    const rows = await sql`select * from food_log where deleted_at is null and enriched_at is null and enrich_tries < ${MAX_TRIES}
      and kind = any(${KINDS}) order by date desc, at desc limit ${limit * 10}`;
    const whole = rows.filter((r) => !missingOf(r.nutrients).length).map((r) => r.id);
    if (whole.length) await sql`update food_log set enriched_at = now() where id = any(${whole}) and enriched_at is null`;
    const out = await fillRows(rows.filter((r) => missingOf(r.nutrients).length).slice(0, limit));
    return { ...out, complete: whole.length };
  });
}

// A new entry: filled within a second, together with anything else logged in the same moment.
export function enrichSoon(id) {
  if (!id) return;
  soon.add(String(id));
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const ids = [...soon];
    soon.clear();
    enrichEntries(ids).catch((err) => console.error('food fill failed', err.message));
  }, SOON_MS);
  timer.unref?.();
}

// Turns filling new entries on as they are logged. The loop does this at start-up; tests and scripts
// leave it off, so nothing changes behind their backs.
export function setAutoEnrich(on) {
  setAfterLog(on ? (entry) => { if (KINDS.includes(entry?.kind)) enrichSoon(entry.id); } : null);
}

// Resolves once nothing is waiting or running (for tests).
export async function enrichIdle() {
  for (;;) {
    while (timer || soon.size) await new Promise((r) => { setTimeout(r, 20); });
    const current = chain;
    await current;
    if (current === chain && !timer && !soon.size) return;
  }
}

export function resumeEnrichment() {
  pausedUntil = 0;
}
