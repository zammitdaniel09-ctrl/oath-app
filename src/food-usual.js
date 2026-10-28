// "Usually now": what he tends to have at this time of day, from his own last 60 days of the diary,
// ready to log in one tap. The ranking is plain functions (exported for the tests); the database
// layer below turns their picks into chips with an amount, a meal and a ready-to-log payload.
//
// Honest by construction: a chip is only ever something he logged himself, more than once, at about
// this time of day; its amount is the one he last had at about this time; and each one carries how
// often he had it and when, so the screen can say what it is based on.
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { db } from './db.js';
import { addDays } from './time.js';
import { localNow } from './engine.js';
import { norm, line, amountText, round, batchPortion } from '../public/nutrition.js';
import { shapeItem, getBatch } from './food.js';

export const USUAL = {
  days: 60, // how far back the diary is read
  sigma: 75, // minutes: the spread of the time-of-day kernel
  halfLife: 21, // days: a meal three weeks ago counts half as much as one today
  dayBonus: 1.25, // the same kind of day (weekday or weekend) counts a quarter more
  near: 120, // minutes either side of now: "the amount he has at this time"
  minTimes: 2, // logged at least twice in the window to be usual at all
  minScore: 0.35, // and often enough at about this time of day
  comboGap: 20, // minutes from the first line of a meal to count as logged together
  comboTimes: 3, // together at least this often to be a usual combination
  comboKeep: 0.75, // a bigger combination stands in for a smaller one inside it when it happens this often
  maxNow: 6,
  maxCombos: 2,
};

const DAY = 1440;
const SLOT_WORD = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snacks: 'snacks', drinks: 'drinks' };

// ---------- Pure ranking ----------

// Minutes apart on the 24-hour circle: 23:30 and 00:15 are 45 minutes apart.
export const gap = (a, b) => {
  const d = Math.abs(a - b) % DAY;
  return Math.min(d, DAY - d);
};
export const timeWeight = (a, b, sigma = USUAL.sigma) => Math.exp(-(gap(a, b) ** 2) / (2 * sigma * sigma));
export const ageWeight = (days, half = USUAL.halfLife) => 0.5 ** (Math.max(0, days) / half);
const dayNum = (date) => Math.round(Date.parse(`${date}T12:00:00Z`) / 864e5);
export const isWeekend = (date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const stamp = (e) => dayNum(e.date) * DAY + e.min;
const latest = (list) => list.reduce((a, e) => (!a || stamp(e) > stamp(a) ? e : a), null);

// What counts as the same thing: a catalogue food or a recipe by its key, a saved meal by its id,
// anything else (quick adds, batches, one-off meals) by its name.
export function usualKey(e) {
  if (e.kind === 'item' && e.ref_key) return `item:${e.ref_key}`;
  if (e.kind === 'recipe' && e.ref_key) return `recipe:${e.ref_key}`;
  if (e.kind === 'meal' && e.ref_id) return `meal:${e.ref_id}`;
  const n = norm(e.name);
  return n ? `name:${n}` : null;
}

// How much one past entry says about now: close in time of day, recent, the same kind of day.
function weightOf(e, now, o) {
  const age = dayNum(now.date) - dayNum(e.date);
  if (age < 0 || age > o.days) return 0;
  const sameDay = isWeekend(e.date) === isWeekend(now.date);
  return timeWeight(e.min, now.min, o.sigma) * ageWeight(age, o.halfLife) * (sameDay ? o.dayBonus : 1);
}

// Already in today's diary in that meal. Drinks come round again (a second coffee, more water), so
// a drink only counts as had when it was logged within `near` minutes of now.
function hadToday(entries, key, slot, now, o) {
  return entries.some((e) => e.date === now.date && e.key === key && e.slot === slot && (slot !== 'drinks' || gap(e.min, now.min) <= o.near));
}

// The time he usually has it: the weighted mean on the 24-hour circle.
function usualMin(list) {
  let x = 0;
  let y = 0;
  for (const { e, w } of list) {
    const a = (e.min / DAY) * 2 * Math.PI;
    x += w * Math.cos(a);
    y += w * Math.sin(a);
  }
  const m = Math.round((Math.atan2(y, x) / (2 * Math.PI)) * DAY);
  return (m + DAY) % DAY;
}

// The amount to offer: the most recent one logged within `near` minutes of now, else the most recent.
const amountFrom = (list, now, o) => latest(list.filter((e) => gap(e.min, now.min) <= o.near)) || latest(list);

// entries: [{ key, date, min (minutes into his local day), slot, ... }]; now: { date, min }.
// Returns every candidate that clears the bar, best first: { key, score, times, slot, min, from },
// where `from` is the entry the amount comes from.
export function rankUsual(entries, now, opts = {}) {
  const o = { ...USUAL, ...opts };
  const groups = new Map();
  for (const e of entries) {
    if (!e.key) continue;
    const age = dayNum(now.date) - dayNum(e.date);
    if (age < 0 || age > o.days) continue;
    const w = weightOf(e, now, o);
    let g = groups.get(e.key);
    if (!g) groups.set(e.key, (g = { key: e.key, score: 0, times: 0, slots: {}, list: [] }));
    g.score += w;
    g.times += 1;
    g.slots[e.slot] = (g.slots[e.slot] || 0) + w;
    g.list.push({ e, w });
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.times < o.minTimes || g.score < o.minScore) continue;
    // The meal he has it in at this time of day.
    const slot = Object.entries(g.slots).sort((a, b) => b[1] - a[1])[0][0];
    if (hadToday(entries, g.key, slot, now, o)) continue;
    out.push({ key: g.key, score: g.score, times: g.times, slot, min: usualMin(g.list), from: amountFrom(g.list.map((x) => x.e), now, o) });
  }
  return out.sort((a, b) => b.score - a.score || b.times - a.times);
}

const bits = (m) => {
  let n = 0;
  for (let x = m; x; x >>= 1) n += x & 1;
  return n;
};

// Usual combinations: two or more things logged together (the same date and meal, within `comboGap`
// minutes of the meal's first line) at least `comboTimes` times. A bigger set replaces a smaller one
// inside it when it happens nearly as often (`comboKeep`), so "oats, milk, banana" wins over "oats,
// milk" only when the banana is usually there too. Returns the best first, none overlapping:
// { key, slot, keys, times, score, min, lines: [{ key, from }] }.
export function findCombos(entries, now, opts = {}) {
  const o = { ...USUAL, ...opts };
  const meals = new Map();
  for (const e of entries) {
    if (!e.key) continue;
    const age = dayNum(now.date) - dayNum(e.date);
    if (age < 0 || age > o.days) continue;
    const k = `${e.date}|${e.slot}`;
    if (!meals.has(k)) meals.set(k, []);
    meals.get(k).push(e);
  }
  const clusters = [];
  for (const list of meals.values()) {
    list.sort((a, b) => a.min - b.min);
    let cur = null;
    for (const e of list) {
      if (!cur || e.min - cur.min > o.comboGap) clusters.push((cur = { date: e.date, slot: e.slot, min: e.min, items: new Map() }));
      if (!cur.items.has(e.key)) cur.items.set(e.key, e);
    }
  }
  // Every set of two or more things in each cluster, and the clusters it turns up in.
  const sets = new Map();
  for (const c of clusters) {
    const keys = [...c.items.keys()].sort().slice(0, 8);
    if (keys.length < 2) continue;
    for (let mask = 1; mask < 1 << keys.length; mask += 1) {
      if (bits(mask) < 2) continue;
      const ks = keys.filter((_, i) => mask & (1 << i));
      const sig = `${c.slot}|${ks.join('|')}`;
      if (!sets.has(sig)) sets.set(sig, { slot: c.slot, keys: ks, clusters: [] });
      sets.get(sig).clusters.push(c);
    }
  }
  const often = [...sets.values()].filter((s) => s.clusters.length >= o.comboTimes);
  const inside = (big, small) => big.slot === small.slot && big.keys.length > small.keys.length && small.keys.every((k) => big.keys.includes(k));
  const kept = often.filter((s) => !often.some((t) => inside(t, s) && t.clusters.length >= s.clusters.length * o.comboKeep));
  const scored = kept.map((s) => {
    const list = s.clusters.map((c) => ({ e: c, w: weightOf(c, now, o) }));
    return { ...s, times: s.clusters.length, score: list.reduce((a, x) => a + x.w, 0), min: usualMin(list) };
  }).filter((s) => s.score >= o.minScore && !s.keys.some((k) => hadToday(entries, k, s.slot, now, o)))
    .sort((a, b) => b.score - a.score || b.keys.length - a.keys.length);
  const picked = [];
  for (const s of scored) {
    if (picked.length >= o.maxCombos) break;
    if (picked.some((p) => inside(p, s) || inside(s, p))) continue;
    // The amounts and the order of the lines (as he logged them) come from the latest time he had it near now.
    const c = amountFrom(s.clusters, now, o);
    const lines = [...c.items.keys()].filter((k) => s.keys.includes(k)).map((k) => ({ key: k, from: c.items.get(k) }));
    picked.push({ key: `combo:${s.slot}:${s.keys.join('+')}`, slot: s.slot, keys: lines.map((l) => l.key), times: s.times, score: s.score, min: s.min, lines });
  }
  return picked;
}

// ---------- From a pick to a chip ----------

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// "Oats, rolled, dry" reads as "Oats" and "Semi-skimmed milk (US 2% milk)" as "Semi-skimmed milk" on a
// chip; the full name stays with it.
const shortName = (name) => String(name || '').split(',')[0].replace(/\s*\([^)]*\)/g, '').trim() || String(name || '');
// "1 medium (7" to 7-7/8" long)" reads as "1 medium".
const shortAmount = (t) => String(t || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
const QUICK_KEYS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine', 'alcohol'];
const kcalOf = (n) => (typeof n?.kcal === 'number' ? round(n.kcal, 0) : null);

// What logging this past entry again takes, at its amount, in `slot`: { op, data, name, label, amount,
// kcal }, or null when it can no longer be logged (the food, recipe, meal or batch is gone or used up).
// `data` has no id: the phone gives each log its own.
function readyToLog(src, slot, ref) {
  if (!src) return null;
  if (src.kind === 'item') {
    const item = ref.items.get(src.ref_key);
    if (!item || item.hidden || item.status === 'needs-label') return null;
    const l = line(item, src.qty, src.unit);
    if (l.error) return null;
    return { op: 'log', data: { key: item.key, qty: src.qty, unit: src.unit, slot }, name: item.name, label: shortName(item.name), brand: item.kind === 'product', amount: shortAmount(amountText(src.qty, src.unit, item)), kcal: kcalOf(l.nutrients) };
  }
  if (src.kind === 'recipe') {
    const r = ref.recipes.get(src.ref_key);
    if (!r) return null;
    const qty = src.qty ?? 1;
    const unit = src.unit === 'g' ? 'g' : 'serving';
    return { op: 'recipe', data: { key: r.key, qty, unit, slot }, name: r.name, label: r.name, amount: amountText(qty, unit), kcal: kcalOf(src.nutrients) };
  }
  if (src.kind === 'meal' && src.ref_id) {
    const m = ref.meals.get(src.ref_id);
    if (!m) return null;
    return { op: 'meal', data: { meal_id: m.id, factor: src.qty || 1, slot }, name: m.name, label: m.name, amount: src.amount_text, kcal: kcalOf(src.nutrients) };
  }
  if (src.kind === 'meal') {
    const own = (l) => ({ ref: 'own', name: l.name, amount: l.amount_text, grams: l.g, ml: l.ml, estimate: l.estimate,
      ...Object.fromEntries(['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt', 'caffeine', 'alcohol'].map((k) => [k, l.nutrients?.[k] ?? null])) });
    const lines = (Array.isArray(src.lines) ? src.lines : []).filter((l) => l && !l.error && (l.ref === 'own' ? typeof l.nutrients?.kcal === 'number' : l.ref_key && Number(l.qty) > 0 && l.unit))
      .map((l) => (l.ref === 'own' ? own(l) : { ref: l.ref === 'recipe' ? 'recipe' : 'item', ref_key: l.ref_key, qty: l.qty, unit: l.unit }));
    if (!lines.length || lines.length !== (src.lines || []).length) return null;
    return { op: 'meal', data: { lines, name: src.name, slot }, name: src.name, label: src.name, amount: src.amount_text, kcal: kcalOf(src.nutrients) };
  }
  if (src.kind === 'batch') {
    const b = ref.batches.get(src.ref_id);
    if (!b || b.finished) return null;
    const p = batchPortion(b, src.qty, src.unit);
    if (p.error || p.share > b.left.share + 1e-9) return null;
    return { op: 'batch', data: { batch_id: b.id, qty: src.qty, unit: src.unit, slot }, name: b.name, label: b.name, amount: src.amount_text, kcal: kcalOf(p.nutrients) };
  }
  if (src.kind === 'quick') {
    // The values he gave come back as given; ones an estimate filled are filled again from the same
    // estimate, so they keep their "~".
    const filled = new Set(src.filled || []);
    const data = { name: src.name, slot, estimate: Boolean(src.estimate) };
    for (const k of QUICK_KEYS) if (typeof src.nutrients?.[k] === 'number' && !filled.has(k)) data[k] = src.nutrients[k];
    if (src.brand) data.brand = src.brand;
    if (src.amount_text) data.amount = src.amount_text;
    if (src.liquid && src.ml) data.ml = src.ml;
    else if (src.grams) data.grams = src.grams;
    if (src.fill_profile && (data.ml || data.grams)) data.fill = src.fill_profile;
    if (data.kcal === undefined && !data.fill) return null;
    // A quick add with no amount says its energy instead, as he logged it ("~" when it was an estimate).
    const kcal = kcalOf(src.nutrients);
    const amount = src.amount_text || (kcal === null ? '' : `${src.estimate || filled.has('kcal') ? '~' : ''}${kcal.toLocaleString('en-GB')} kcal`);
    return { op: 'quick', data, name: src.name, label: src.name, amount, kcal };
  }
  return null;
}

// What GET /api/food/usual answers: { date, at, days, now: [up to 6], combos: [up to 2], items }.
// A prediction: { key, kind, name, label, amount, slot, at (usual time), times, kcal, log: { op, data } }.
// A combination: { key, slot, label, names, at, times, kcal, lines: [predictions] }. `items` holds the
// catalogue records the chips point at, so the phone can open a food to change its amount offline.
export async function usualNow() {
  const { local, today, tz } = await localNow();
  const sql = db();
  const rows = await sql`select id, date, at, slot, kind, ref_id, ref_key, name from food_log
    where deleted_at is null and date >= ${addDays(today, -USUAL.days, tz)} and date <= ${today} order by at, created_at`;
  const entries = rows.map((r) => {
    const t = DateTime.fromJSDate(r.at, { zone: tz });
    return { ...r, key: usualKey(r), min: t.hour * 60 + t.minute };
  });
  const now = { date: today, min: local.hour * 60 + local.minute };
  const ranked = rankUsual(entries, now).slice(0, USUAL.maxNow * 2);
  const combos = findCombos(entries, now);
  const out = { date: today, at: hm(now.min), days: USUAL.days, now: [], combos: [], items: {} };
  const picks = [...ranked.map((p) => p.from), ...combos.flatMap((c) => c.lines.map((l) => l.from))];
  if (!picks.length) return out;

  // The past entries the amounts come from, in full, and what they point at today.
  const full = await sql`select id, kind, ref_id, ref_key, name, brand, qty, unit, amount_text, grams, ml, liquid, nutrients, lines, estimate, filled, fill_profile
    from food_log where id = any(${[...new Set(picks.map((e) => e.id))]})`;
  const byId = new Map(full.map((r) => [r.id, r]));
  const of = (kind) => full.filter((r) => r.kind === kind);
  const itemKeys = [...new Set(of('item').map((r) => r.ref_key))];
  const recipeKeys = [...new Set(of('recipe').map((r) => r.ref_key))];
  const mealIds = [...new Set(of('meal').filter((r) => r.ref_id).map((r) => r.ref_id))];
  const batchIds = [...new Set(of('batch').filter((r) => r.ref_id).map((r) => r.ref_id))];
  const [items, recipes, meals] = await Promise.all([
    itemKeys.length ? sql`select * from food_items where key = any(${itemKeys})` : [],
    recipeKeys.length ? sql`select key, name from recipes where key = any(${recipeKeys}) and deleted_at is null` : [],
    mealIds.length ? sql`select id, name from food_meals where id = any(${mealIds}) and deleted_at is null` : [],
  ]);
  const batches = new Map();
  for (const id of batchIds) batches.set(id, await getBatch(id).catch(() => null));
  const ref = {
    items: new Map(items.map((r) => [r.key, { ...shapeItem(r), hidden: r.hidden }])),
    recipes: new Map(recipes.map((r) => [r.key, r])),
    meals: new Map(meals.map((r) => [r.id, r])),
    batches,
  };
  const used = new Set();
  const chip = (key, src, slot) => {
    const r = readyToLog(src, slot, ref);
    if (!r) return null;
    if (r.op === 'log') used.add(r.data.key);
    return { key, kind: src.kind, name: r.name, label: r.label, brand: Boolean(r.brand), amount: r.amount, slot, kcal: r.kcal, log: { op: r.op, data: r.data } };
  };

  for (const p of ranked) {
    if (out.now.length >= USUAL.maxNow) break;
    const c = chip(p.key, byId.get(p.from.id), p.slot);
    if (c) out.now.push({ ...c, at: hm(p.min), times: p.times });
  }
  for (const s of combos) {
    const lines = s.lines.map((l) => chip(l.key, byId.get(l.from.id), s.slot)).filter(Boolean);
    if (lines.length < 2) continue;
    // The list reads as a sentence ("oats, banana, milk"): a name starts in lower case unless it is a
    // brand's product or starts with an acronym.
    const names = lines.map((l) => (!l.brand && /^[A-Z][a-z]/.test(l.label) ? l.label[0].toLowerCase() + l.label.slice(1) : l.label)).join(', ');
    const kcal = lines.every((l) => l.kcal !== null) ? lines.reduce((a, l) => a + l.kcal, 0) : null;
    out.combos.push({ key: s.key, slot: s.slot, label: `Usual ${SLOT_WORD[s.slot] || s.slot}`, names, at: hm(s.min), times: s.times, kcal, lines });
  }
  for (const k of used) {
    const it = ref.items.get(k);
    if (it) {
      const { hidden, ...rest } = it;
      out.items[k] = rest;
    }
  }
  return out;
}

export const usualApi = new Hono();
usualApi.get('/food/usual', async (c) => c.json(await usualNow()));
