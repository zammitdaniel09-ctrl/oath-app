// What to eat next, and the foods richest in one nutrient. Deterministic and quick: today's gaps
// against his own needs, the foods, recipes and saved meals he has logged lately at his usual amount,
// and a short list of common catalogue foods with sourced portions. No AI call, so it costs nothing.
//
// Honest as the rest of Food: a day total that is missing values is a floor ("at least"), so its gap
// is at most what it says; a candidate is never credited for a nutrient it has no value for; and
// every row says where it came from.
import { Hono } from 'hono';
import { db } from './db.js';
import { localNow, RuleError } from './engine.js';
import { addDays, validDate } from './time.js';
import { NUTRIENT, scale, total, line, round, norm, amountText, refOf, shareOf } from '../public/nutrition.js';
import * as NUT from '../public/nutrition.js';
import { shapeItem, getRecipe, listMeals } from './food.js';
import { bodyNeeds } from './body.js';

// How far back "his foods" reach.
export const OWN_DAYS = 90;
// The vitamins and minerals the day is checked for; one is a gap under 60% of his need.
export const MICRO_KEYS = ['iron', 'calcium', 'potassium', 'magnesium', 'vitc', 'vitd', 'folate', 'b12', 'zinc'];
const MICRO_LOW = 60;
// Protein, fibre and energy count as met from 95% of the need: a few grams short is not a gap.
const MET = 95;
// How much each gap matters, times how much of the day's need is still missing. The vitamins and
// minerals count the biggest four only, so nine small ones never outweigh protein.
const IMPORTANCE = { protein: 3, fibre: 2, kcal: 1 };
const MICRO_IMPORTANCE = 0.6;
const MAX_MICROS = 4;
// Sugars, salt and saturates are limits: pushing past one costs a candidate.
export const LIMIT_KEYS = ['sugars', 'salt', 'satfat'];
const ENERGY_PENALTY = 5;
const LIMIT_PENALTY = 4;
// Caffeine from this local hour keeps him up.
export const CAFFEINE_HOUR = 15;
const MIN_SCORE = 0.05;
// Rows in each list, and how many of the next few may be catalogue ideas.
const NEXT_ROWS = 4;
const MAX_IDEAS = 2;
const RICH_ROWS = { yours: 8, ideas: 10 };
// Per 100 kcal, a food with almost no energy (an espresso, dried herbs) would top every list, so a
// portion has to bring at least this much energy to be ranked that way.
export const KCAL_FLOOR = 20;

// Common foods worth suggesting to anyone, each with one of the record's own sourced portions (USDA
// FoodData Central measures) and how many of it. Only records that exist with that portion are used.
export const IDEAS = [
  ['yogurt-greek-low-fat', '1 container (7 oz)'],
  ['yogurt-plain-low-fat', '1 container (6 oz)'],
  ['cottage-cheese-low-fat', '4 oz'],
  ['milk-semi-skimmed', '1 US cup'],
  ['egg-whole-boiled', '1 large', 2],
  ['chicken-breast-skinless-grilled', '1 piece'],
  ['turkey-breast-skinless-roasted', '3 oz'],
  ['beef-mince-10-fat-browned', '3 oz'],
  ['tuna-canned-water-light', '1 can'],
  ['salmon-farmed-baked', '0.5 fillet'],
  ['sardines-canned-oil-drained', '1 can (3.75 oz)'],
  ['tofu-firm-calcium', '0.25 block'],
  ['edamame-cooked', '1 US cup'],
  ['lentils-boiled', '1 US cup'],
  ['chickpeas-boiled', '1 US cup'],
  ['black-beans-boiled', '1 US cup'],
  ['hummus-shop', '1 tbsp', 4],
  ['quinoa-cooked', '1 US cup'],
  ['oats-rolled-dry', '1 US cup'],
  ['bread-wholemeal-sliced-as-sold', '1 slice', 2],
  ['potato-white-baked', '1 potato medium (2-1/4" to 3-1/4" dia)'],
  ['sweet-potato-baked', '1 medium (2" dia, 5" long, raw)'],
  ['spinach-boiled', '1 US cup'],
  ['broccoli-boiled', '1 stalk, medium (7-1/2" - 8" long)'],
  ['pepper-red-raw', '1 medium (approx 2-3/4" long, 2-1/2 dia.)'],
  ['banana-raw', '1 medium (7" to 7-7/8" long)'],
  ['orange-raw', '1 fruit (2-5/8" dia)'],
  ['kiwi-raw', '1 fruit (2" dia)', 2],
  ['apple-raw-with-skin', '1 medium (3" dia)'],
  ['pear-raw', '1 medium'],
  ['raspberries-raw', '1 US cup'],
  ['strawberries-raw', '1 serving (US label size)'],
  ['blueberries-raw', '1 US cup'],
  ['almonds-raw', '1 oz (23 whole kernels)'],
  ['walnuts', '1 oz (14 halves)'],
  ['pumpkin-seeds', '1 oz'],
  ['peanut-butter-smooth', '2 tbsp'],
];

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const WORD = {
  kcal: 'energy', protein: 'protein', fibre: 'fibre', iron: 'iron', calcium: 'calcium', potassium: 'potassium', magnesium: 'magnesium',
  vitc: 'vitamin C', vitd: 'vitamin D', folate: 'folate', b12: 'vitamin B12', zinc: 'zinc',
};
const wordOf = (k) => WORD[k] || NUTRIENT[k]?.label.toLowerCase() || k;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Never suggested: alcohol at any time, and caffeine from 15:00. Names catch the drinks whose record
// has no caffeine or alcohol value; decaf and alcohol-free ones are let through.
const CAFFEINE_WORDS = /\b(coffee|espresso|cappuccino|latte|americano|macchiato|mocha|flat white|cold brew|energy drink|red bull|monster|cola|coke|pepsi|matcha|green tea|black tea|iced tea|yerba)\b/i;
const NO_CAFFEINE = /\b(decaf|decaffeinated|caffeine[- ]free)\b/i;
const ALCOHOL_WORDS = /\b(beer|lager|ale|stout|wine|prosecco|champagne|cider|vodka|gin|rum|whisk(e)?y|brandy|liqueur|cocktail|spritz|cisk|sangria)\b/i;
const NO_ALCOHOL = /\b(alcohol[- ]free|non[- ]alcoholic|0\.0|ginger ale|ginger beer|root beer)\b/i;
const caffeinated = (c) => num(c.nutrients?.caffeine) > 0 || (CAFFEINE_WORDS.test(c.name) && !NO_CAFFEINE.test(c.name));
const alcoholic = (c) => num(c.nutrients?.alcohol) > 0 || String(c.category || '').toLowerCase() === 'alcoholic drinks'
  || (ALCOHOL_WORDS.test(c.name) && !NO_ALCOHOL.test(c.name));

// What 100% stands for: his need from his body, else the EU reference intake. Fibre has no EU RI,
// so without a body it takes the same rule his needs use (14 g per 1,000 kcal) on the 2,000 kcal reference.
export function needOf(k, refs = null) {
  if (k === 'fibre') return refs?.fibre ?? round((14 * refOf('kcal', refs)) / 1000);
  return refOf(k, refs);
}

// ---------- Gaps ----------

// Today's gaps: protein, fibre and energy under 95% of his need, and the vitamins and minerals under 60%
// whose day value is known. A nutrient no line had a value for is unknown, never a gap; one some lines
// lacked is a floor, so its gap is "at most". Returns { gaps, unknown, low } with gaps biggest first.
export function dayGaps(t, refs = null) {
  const gaps = [];
  const unknown = [];
  for (const k of ['protein', 'fibre', 'kcal', ...MICRO_KEYS]) {
    const need = needOf(k, refs);
    if (!need) continue;
    const eaten = num(t?.[k]);
    if (eaten === null) {
      unknown.push(k);
      continue;
    }
    const micro = MICRO_KEYS.includes(k);
    const pct = (eaten / need) * 100;
    if (pct >= (micro ? MICRO_LOW : MET)) continue;
    const gap = need - eaten;
    const size = gap / need;
    gaps.push({
      key: k, label: NUTRIENT[k].label, word: wordOf(k), unit: NUTRIENT[k].unit, need, eaten, floor: Boolean(t?.missing?.[k]),
      gap, pct, size, weight: (micro ? MICRO_IMPORTANCE : IMPORTANCE[k]) * size, micro,
    });
  }
  const micros = gaps.filter((g) => g.micro).sort((a, b) => b.size - a.size);
  const kept = new Set(micros.slice(0, MAX_MICROS));
  const out = gaps.filter((g) => !g.micro || kept.has(g)).sort((a, b) => b.weight - a.weight);
  return { gaps: out, unknown, low: micros.slice(MAX_MICROS).map((g) => g.key) };
}

// ---------- Scoring ----------

// How much a candidate helps: each gap's coverage (min(it brings, gap) / gap) times the gap's weight,
// less what it costs: energy past what is left when he keeps or loses weight, and sugars, salt or
// saturates pushed past their limits. Alcohol, and caffeine from 15:00, are out. His own foods get a
// small bonus for being his. Returns { score, gain, penalty, parts, excluded }.
export function scoreCandidate(c, { gaps = [], refs = null, total: t = {}, goal = 'keep', hour = 12 } = {}) {
  if (alcoholic(c)) return { score: -Infinity, excluded: 'alcohol', parts: [] };
  if (hour >= CAFFEINE_HOUR && caffeinated(c)) return { score: -Infinity, excluded: 'caffeine', parts: [] };
  const n = c.nutrients || {};
  const parts = [];
  let gain = 0;
  for (const g of gaps) {
    const has = num(n[g.key]);
    if (has === null || has <= 0) continue; // unknown is never credited
    const cover = Math.min(has, g.gap) / g.gap;
    gain += g.weight * cover;
    parts.push({ key: g.key, amount: has, cover, weighted: g.weight * cover });
  }
  let penalty = 0;
  const kcalNeed = needOf('kcal', refs);
  const kcal = num(n.kcal);
  if (goal !== 'gain' && kcal !== null && kcalNeed) {
    const left = Math.max(0, kcalNeed - (num(t?.kcal) || 0));
    penalty += (ENERGY_PENALTY * Math.max(0, kcal - left)) / kcalNeed;
  }
  for (const k of LIMIT_KEYS) {
    const limit = refOf(k, refs);
    const add = num(n[k]);
    if (!limit || !(add > 0)) continue;
    const before = num(t?.[k]) || 0;
    // Only the part this food adds past the limit counts.
    const over = Math.max(0, before + add - Math.max(limit, before));
    penalty += (LIMIT_PENALTY * over) / limit;
  }
  let score = gain - penalty;
  if (score > 0 && c.own) score *= 1.1 + Math.min(0.2, 0.04 * (c.count || 1));
  // Something already eaten today ranks a little lower, for variety.
  if (score > 0 && c.today) score *= 0.85;
  return { score, gain, penalty, parts, excluded: null };
}

const COVER_WORDS = [[0.9, 'Covers'], [0.6, 'Covers most of'], [0.4, 'Covers about half of'], [0.28, 'Covers about a third of']];
const amountWords = (v, k) => `${NUT.show({ [k]: v }, k)}`;

// One line on why: the gap it helps most, and a second one when it helps that nearly as much.
export function reasonOf(parts, gaps) {
  const sorted = [...parts].sort((a, b) => b.weighted - a.weighted);
  const best = sorted[0];
  if (!best) return '';
  const g = gaps.find((x) => x.key === best.key);
  const what = g.key === 'kcal' ? 'the energy you have left' : `your ${g.word} gap`;
  const words = COVER_WORDS.find(([at]) => best.cover >= at)?.[1];
  let out = words ? `${words} ${what}` : `Adds ${amountWords(best.amount, best.key)}${g.key === 'kcal' ? '' : ` of ${g.word}`}`;
  const next = sorted[1];
  if (next && next.cover >= 0.4 && next.key !== 'kcal') out += `, plus ${gaps.find((x) => x.key === next.key).word}`;
  return out;
}

// Its best vitamin or mineral as % of need: a gap one first when it brings at least 10%, else any.
export function bestMicro(n, refs = null, gapKeys = []) {
  const list = MICRO_KEYS.map((k) => {
    const v = num(n?.[k]);
    const need = needOf(k, refs);
    return v !== null && v > 0 && need ? { key: k, label: cap(wordOf(k)), amount: round(v, NUTRIENT[k].dec + 1), unit: NUTRIENT[k].unit, pct: round((v / need) * 100, 0), floor: Boolean(n?.missing?.[k]) } : null;
  }).filter(Boolean);
  const gapBest = list.filter((x) => gapKeys.includes(x.key) && x.pct >= 10).sort((a, b) => b.pct - a.pct)[0];
  return gapBest || list.sort((a, b) => b.pct - a.pct)[0] || null;
}

const addsOf = (n, refs, gapKeys) => ({
  kcal: num(n?.kcal) === null ? null : round(n.kcal, 0),
  protein: num(n?.protein) === null ? null : round(n.protein, 1),
  fibre: num(n?.fibre) === null ? null : round(n.fibre, 1),
  missing: Object.fromEntries(['kcal', 'protein', 'fibre'].filter((k) => n?.missing?.[k]).map((k) => [k, true])),
  micro: bestMicro(n, refs, gapKeys),
});

// The top few for today, best first: one row per food, and at least one catalogue idea he has not
// logged when one helps at all. Candidates: { kind, key, mealId, name, own, count, today, nutrients, ... }.
export function rankNext(candidates, { gaps = [], refs = null, total: t = {}, goal = 'keep', hour = 12, rows = NEXT_ROWS } = {}) {
  const ctx = { gaps, refs, total: t, goal, hour };
  const scored = candidates.map((c) => ({ c, ...scoreCandidate(c, ctx) }))
    .filter((x) => x.score > MIN_SCORE)
    .sort((a, b) => b.score - a.score || Number(b.c.own) - Number(a.c.own) || a.c.name.localeCompare(b.c.name));
  const seen = new Set();
  // A catalogue idea that is a version of one of his own foods ("Salmon, Atlantic, farmed, baked" when
  // he eats the raw one) gives way to his.
  const family = (c) => norm(c.name).split(' ').slice(0, 2).join(' ');
  const ownFamilies = new Set(scored.filter((x) => x.c.own).map((x) => family(x.c)));
  const unique = scored.filter((x) => {
    const ids = [`${x.c.kind}:${x.c.key || x.c.mealId}`, `name:${norm(x.c.name)}`];
    if (ids.some((id) => seen.has(id)) || (!x.c.own && ownFamilies.has(family(x.c)))) return false;
    ids.forEach((id) => seen.add(id));
    return true;
  });
  // His own foods lead: at most two catalogue ideas, from different groups (not two kinds of beans),
  // unless too few of his own foods help to fill the rows.
  const top = [];
  const later = [];
  const groups = new Set();
  for (const x of unique) {
    if (top.length >= rows) break;
    const group = String(x.c.category || '').toLowerCase();
    if (!x.c.own && (top.filter((t) => !t.c.own).length >= MAX_IDEAS || (group && groups.has(group)))) {
      later.push(x);
      continue;
    }
    if (!x.c.own && group) groups.add(group);
    top.push(x);
  }
  for (const x of later) if (top.length < rows) top.push(x);
  top.sort((a, b) => b.score - a.score);
  if (!top.some((x) => !x.c.own)) {
    const idea = unique.find((x) => !x.c.own);
    if (idea) {
      if (top.length >= rows) top[rows - 1] = idea;
      else top.push(idea);
    }
  }
  const gapKeys = gaps.map((g) => g.key);
  return top.map(({ c, score, parts }) => ({
    kind: c.kind, key: c.key ?? null, mealId: c.mealId ?? null, name: c.name, brand: c.brand ?? null, grade: c.grade ?? null,
    own: Boolean(c.own), count: c.count || 0, fresh: Boolean(c.fresh), liquid: Boolean(c.liquid),
    qty: c.qty, unit: c.unit, amountText: c.amountText, g: c.g ?? null, ml: c.ml ?? null,
    adds: addsOf(c.nutrients, refs, gapKeys),
    reason: reasonOf(parts, gaps),
    source: c.source,
    log: c.log,
    score: round(score, 3),
  }));
}

// ---------- Rich in ----------

// One row of "Rich in": the amount in its portion and per 100 kcal, each with its % of need. Null when
// the value is unknown or nothing; per 100 kcal is null when the energy is unknown or the portion
// brings under 20 kcal.
export function richRow(c, key, need) {
  const v = num(c.nutrients?.[key]);
  if (v === null || v <= 0) return null;
  const kcal = num(c.nutrients?.kcal);
  const pct = (x) => (need ? round((x / need) * 100, x / need < 0.1 ? 1 : 0) : null);
  const dec = NUTRIENT[key].dec + 1;
  const perKcal = kcal !== null && kcal >= KCAL_FLOOR ? (v * 100) / kcal : null;
  const weight = c.g ?? c.ml ?? null;
  return {
    kind: c.kind, key: c.key ?? null, mealId: c.mealId ?? null, name: c.name, brand: c.brand ?? null, grade: c.grade ?? null,
    own: Boolean(c.own), count: c.count || 0, liquid: Boolean(c.liquid), floor: Boolean(c.nutrients?.missing?.[key]),
    portion: { qty: c.qty, unit: c.unit, text: c.amountText, g: c.g ?? null, ml: c.ml ?? null, kcal: kcal === null ? null : round(kcal, 0) },
    amount: round(v, dec), pct: pct(v),
    perKcal: perKcal === null ? null : {
      amount: round(perKcal, dec), pct: pct(perKcal),
      // How much of the food makes 100 kcal.
      g: weight && kcal ? round((weight * 100) / kcal, 0) : null, basis: c.ml && !c.g ? 'ml' : 'g',
    },
    source: c.source,
    log: c.log,
  };
}

// The richest first, per portion or per 100 kcal; unknown values were left out by richRow.
export function richRank(candidates, key, need, by = 'portion', rows = 10) {
  const list = candidates.map((c) => richRow(c, key, need)).filter(Boolean);
  const value = (r) => (by === 'kcal' ? r.perKcal?.amount ?? null : r.amount);
  const seen = new Set();
  return list.filter((r) => value(r) !== null)
    .sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name))
    .filter((r) => {
      // One of a family ("Yogurt, Greek, low fat" and "..., fat free") so the list shows variety.
      const fam = r.own ? `${r.kind}:${r.key || r.mealId}` : norm(r.name).split(' ').slice(0, 2).join(' ');
      if (seen.has(fam)) return false;
      seen.add(fam);
      return true;
    })
    .slice(0, rows);
}

// ---------- Portions ----------

// Words of a portion as people say it: "1 medium (3" dia)" is "1 medium".
const tidy = (s) => String(s || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

// A typical portion of a catalogue record from what its source gives: the label's serving, one of a
// multipack, else a sourced portion that reads like one helping. Null when there is none.
const NOT_A_HELPING = /\b(lb|pound|quart|pint|gallon|package|bag|bunch|loaf|block|cubic|dash|pinch|tsp|teaspoon|jar|bottle \(2|yield)\b/i;
const HELPING = /\b(medium|serving|slice|piece|fillet|breast|egg|fruit|container|pot|can|bar|cookie|biscuit|muffin|roll|bun|pita|tortilla|sausage|rasher|patty|burger|stalk|potato|banana|apple|orange|pepper|avocado|wrap)\b/i;
const CUP_GROUPS = new Set(['rice, pasta and grains', 'legumes', 'vegetables', 'fruit', 'milk', 'plant milks', 'soups', 'breakfast cereals', 'dairy', 'drinks', 'fruit juice', 'potatoes']);
// More than this in one portion is a meal or a tub, not a helping to suggest.
const HELPING_KCAL = 700;
export function portionOf(it) {
  if (num(it.serving?.size) > 0) return { qty: 1, unit: 'serving' };
  if (num(it.pack?.size) > 0 && num(it.pack?.count) > 1) return { qty: 1, unit: 'each' };
  const ps = (it.portions || []).filter((p) => {
    const w = num(p.g) ?? num(p.ml);
    return w !== null && w >= 10 && w <= 350 && !NOT_A_HELPING.test(p.label);
  });
  // A cup is a helping of grains, beans, vegetables, fruit, milk or soup, not of syrup or sauce.
  const cupOk = CUP_GROUPS.has(String(it.category || '').toLowerCase());
  const pick = ps.find((p) => /^1 (medium|serving)\b/i.test(p.label)) || ps.find((p) => HELPING.test(p.label))
    || ps.find((p) => /^(1|3|4) oz\b/i.test(p.label)) || (cupOk && ps.find((p) => /^1 (US )?cup\b/i.test(p.label))) || ps.find((p) => /\b(tbsp|tablespoon)\b/i.test(p.label));
  if (pick) return { qty: 1, unit: `p:${pick.label}` };
  if (num(it.pack?.size) > 0 && it.pack.size <= 500) return { qty: 1, unit: 'pack' };
  return null;
}

// ---------- Candidates from the database ----------

function gradeOfAmount(n, g, liquid) {
  if (!(g > 0)) return null;
  try {
    return NUT.nutriScore?.(scale(n, 100, g), { liquid })?.grade || null;
  } catch {
    return null;
  }
}

// A catalogue record at an amount, as a candidate.
function itemCandidate(row, qty, unit, extra = {}) {
  const it = shapeItem(row);
  const l = line(it, qty, unit);
  if (l.error) return null;
  const source = extra.source?.kind === 'catalogue' ? { ...extra.source, text: it.sourceText } : extra.source;
  return {
    kind: 'item', key: it.key, name: it.name, brand: it.brand, grade: it.nutriscore, category: it.category, liquid: it.liquid,
    qty: Number(qty), unit, amountText: tidy(l.text) || l.text, g: l.g, ml: l.ml,
    nutrients: l.nutrients,
    log: { op: 'log', body: { key: it.key, qty: Number(qty), unit } },
    ...extra,
    source,
  };
}

// The foods, recipes and saved meals he logged in the last 90 days, each at his usual amount (the
// amount he logged most, the latest on a tie). Item values come from the record as it is now, so an
// estimate filled into one entry is never credited; recipes and meals are worked out from their
// current lines.
export async function ownCandidates(today, tz, { date = today } = {}) {
  const sql = db();
  const from = addDays(today, -(OWN_DAYS - 1), tz);
  const rows = await sql`select kind, ref_id, ref_key, qty, unit, date, at from food_log
    where deleted_at is null and date >= ${from} and date <= ${today} and kind in ('item', 'recipe', 'meal') order by at`;
  const groups = new Map();
  for (const r of rows) {
    const id = r.kind === 'meal' ? (r.ref_id ? `meal:${r.ref_id}` : null) : r.ref_key ? `${r.kind}:${r.ref_key}` : null;
    if (!id || !(Number(r.qty) > 0)) continue;
    const g = groups.get(id) || { kind: r.kind, refKey: r.ref_key, refId: r.ref_id, count: 0, today: false, amounts: new Map() };
    g.count += 1;
    if (r.date === date) g.today = true;
    const a = `${r.qty}|${r.unit}`;
    const x = g.amounts.get(a) || { qty: Number(r.qty), unit: r.unit, n: 0, at: 0 };
    x.n += 1;
    x.at = new Date(r.at).getTime();
    g.amounts.set(a, x);
    groups.set(id, g);
  }
  const usual = (g) => [...g.amounts.values()].sort((a, b) => b.n - a.n || b.at - a.at)[0];
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  const out = [];
  const source = (g) => ({ own: true, count: g.count, today: g.today, source: { kind: 'yours', count: g.count, days: OWN_DAYS } });

  const items = list.filter((g) => g.kind === 'item');
  if (items.length) {
    const recs = await sql`select * from food_items where key = any(${items.map((g) => g.refKey)}) and hidden = false`;
    const byKey = new Map(recs.map((r) => [r.key, r]));
    for (const g of items) {
      const r = byKey.get(g.refKey);
      const u = usual(g);
      const c = r && itemCandidate(r, u.qty, u.unit, source(g));
      if (c) out.push(c);
    }
  }

  // A handful of recipes: each is worked out from its current lines.
  for (const g of list.filter((x) => x.kind === 'recipe').slice(0, 12)) {
    let r;
    try {
      r = await getRecipe(g.refKey);
    } catch {
      continue;
    }
    const u = usual(g);
    const unit = u.unit === 'g' ? 'g' : 'serving';
    const s = shareOf({ servings: r.servings, final_weight: r.final_weight }, u.qty, unit);
    if (s.error || r.errors?.length) continue;
    const nutrients = scale(r.totals, s.share, 1);
    const grams = unit === 'g' ? u.qty : r.final_weight ? round(s.share * r.final_weight, 1) : null;
    out.push({
      kind: 'recipe', key: r.key, name: r.name, grade: gradeOfAmount(nutrients, grams, false), qty: u.qty, unit,
      amountText: amountText(u.qty, unit), g: grams, ml: null, nutrients,
      log: { op: 'recipe', body: { key: r.key, qty: u.qty, unit } },
      ...source(g),
    });
  }

  const mealGroups = list.filter((g) => g.kind === 'meal');
  if (mealGroups.length) {
    const meals = new Map((await listMeals()).map((m) => [m.id, m]));
    for (const g of mealGroups) {
      const m = meals.get(Number(g.refId));
      if (!m || m.errors?.length) continue;
      const factor = usual(g).qty;
      const nutrients = scale(m.nutrients, factor, 1);
      const grams = (m.priced || []).reduce((a, p) => a + (p.g || 0), 0) * factor || null;
      const liquid = (m.priced || []).every((p) => p.liquid);
      const ml = (m.priced || []).filter((p) => p.liquid && p.ml).reduce((a, p) => a + p.ml, 0) * factor || null;
      out.push({
        kind: 'meal', mealId: m.id, key: null, name: m.name, grade: gradeOfAmount(nutrients, grams, false), liquid, qty: factor, unit: 'share',
        amountText: factor === 1 ? `${m.lines.length} items` : `${round(factor, 2)} of it, ${m.lines.length} items`, g: grams ? round(grams, 0) : null, ml: ml ? round(ml, 0) : null,
        nutrients,
        log: { op: 'meal', body: { meal_id: m.id, factor } },
        ...source(g),
      });
    }
  }
  return out;
}

// The common catalogue foods of IDEAS at their sourced portion, leaving out the ones in `skip`.
export async function ideaCandidates(skip = new Set()) {
  const keys = IDEAS.map(([k]) => k).filter((k) => !skip.has(k));
  if (!keys.length) return [];
  const recs = await db()`select * from food_items where key = any(${keys}) and hidden = false and kind = 'generic' and status <> 'needs-label'`;
  const byKey = new Map(recs.map((r) => [r.key, r]));
  const out = [];
  for (const [key, label, qty = 1] of IDEAS) {
    const r = byKey.get(key);
    if (!r || skip.has(key) || !(r.portions || []).some((p) => p.label === label)) continue;
    const c = itemCandidate(r, qty, `p:${label}`, { own: false, fresh: !(r.uses > 0), source: { kind: 'catalogue', portion: 'sourced' } });
    if (c) out.push(c);
  }
  return out;
}

// ---------- What to eat next ----------

// Today's gaps and the top few foods to close them. Covered when every need is met.
export async function nextSuggestions(date = null) {
  const { today, tz, local } = await localNow();
  const d = date ? String(date) : today;
  if (!validDate(d) || d > today) throw new RuleError('Bad date.');
  const sql = db();
  const rows = await sql`select nutrients from food_log where date = ${d} and deleted_at is null`;
  const t = total(rows.map((r) => r.nutrients));
  const { needs } = await bodyNeeds();
  const refs = needs?.refs || null;
  const goal = needs?.about?.goal || 'keep';
  // A past day is looked at as its evening.
  const hour = d === today ? local.hour : 23;
  const { gaps, unknown, low } = dayGaps(t, refs);
  const kcalNeed = needOf('kcal', refs);
  const base = {
    date: d, today: d === today, entries: rows.length, based: refs ? 'needs' : 'ri', goal, hour,
    gaps: gaps.map((g) => ({ key: g.key, label: g.label, unit: g.unit, need: round(g.need, 1), eaten: round(g.eaten, 1), gap: round(g.gap, 1), pct: round(g.pct, 0), floor: g.floor })),
    // Vitamins and minerals nothing logged today has a value for, and low ones past the four counted.
    unknown, low,
    kcal: { need: kcalNeed, eaten: num(t.kcal) === null ? null : round(t.kcal, 0), left: num(t.kcal) === null ? null : round(Math.max(0, kcalNeed - t.kcal), 0), floor: Boolean(t.missing?.kcal) },
  };
  if (!gaps.length) return { ...base, covered: true, items: [] };
  const own = await ownCandidates(today, tz, { date: d });
  const ownKeys = new Set(own.filter((c) => c.kind === 'item').map((c) => c.key));
  // Catalogue ideas need a value for every gap, so each one's coverage is real; his own foods are
  // taken as they are and only credited where they have a value.
  const ideas = (await ideaCandidates(ownKeys)).filter((c) => num(c.nutrients.kcal) !== null && gaps.every((g) => num(c.nutrients[g.key]) !== null));
  const items = rankNext([...own, ...ideas], { gaps, refs, total: t, goal, hour });
  return { ...base, covered: false, items };
}

// ---------- Rich in ----------

// The catalogue's generic and product records with a value for `key`: the hand-picked records only
// (the bulk USDA file is for search), at a typical portion. Herbs, supplements, alcohol, flour, sauces,
// syrups and anything dry or raw meat is left out: nobody eats a cup of dried thyme, a can of tomato
// paste or a raw chicken breast.
const RICH_SKIP_GROUPS = new Set(['herbs and spices', 'supplements and powders', 'alcoholic drinks', 'flour and baking', 'sauces and condiments', 'sugar, syrups and spreads']);
const RAW_MEAT_GROUPS = new Set(['beef', 'pork', 'lamb, veal and game', 'poultry', 'fish and shellfish', 'sausages and cold cuts']);
// Ingredients rather than foods: a cup of evaporated milk or a can of tomato paste is not a helping.
const INGREDIENT_WORDS = /\b(evaporated|condensed|powder|powdered|dehydrated|granules|flakes|bouillon|stock|paste|puree|purée|flour)\b/i;
async function catalogueRich(key, skip, { limit = false } = {}) {
  const sql = db();
  const rows = await sql`select * from food_items
    where hidden = false and status <> 'needs-label' and kind in ('generic', 'product') and key not like 'fdc-%'
      and jsonb_typeof(nutrients -> ${key}) = 'number' and (nutrients ->> ${key})::float > 0
      and jsonb_typeof(nutrients -> 'kcal') = 'number'`;
  const ideaPortion = new Map(IDEAS.map(([k, label, qty = 1]) => [k, { qty, unit: `p:${label}` }]));
  const out = [];
  for (const r of rows) {
    if (skip.has(r.key)) continue;
    const group = String(r.category || '').toLowerCase();
    const picked = ideaPortion.get(r.key);
    if (!picked && (RICH_SKIP_GROUPS.has(group) || r.state === 'dry' || (r.state === 'raw' && RAW_MEAT_GROUPS.has(group)) || INGREDIENT_WORDS.test(r.name))) continue;
    const p = picked && (r.portions || []).some((x) => `p:${x.label}` === picked.unit) ? picked : portionOf(r);
    if (!p) continue;
    const c = itemCandidate(r, p.qty, p.unit, { own: false, source: { kind: 'catalogue', portion: p.unit === 'serving' || p.unit === 'each' ? 'label' : 'sourced' } });
    if (!c || num(c.nutrients.kcal) > HELPING_KCAL) continue;
    // An idea to eat more of is never a food graded D or E; for a limit (salt, sugars) the list is
    // where it comes from, so every grade stays.
    if (!limit && ['d', 'e'].includes(c.grade)) continue;
    out.push(c);
  }
  return out;
}

// The foods richest in one nutrient: his own (logged in the last 90 days, at his usual amount) and
// more ideas from the catalogue, per typical portion or per 100 kcal.
export async function richIn(key, { by = 'portion' } = {}) {
  const k = String(key || '');
  if (!NUTRIENT[k] || k === 'kcal') throw new RuleError('Unknown nutrient.');
  const rank = by === 'kcal' ? 'kcal' : 'portion';
  const { today, tz } = await localNow();
  const { needs } = await bodyNeeds();
  const refs = needs?.refs || null;
  const need = needOf(k, refs);
  const own = await ownCandidates(today, tz);
  const ownKeys = new Set(own.filter((c) => c.kind === 'item').map((c) => c.key));
  const ideas = await catalogueRich(k, ownKeys, { limit: LIMIT_KEYS.includes(k) });
  return {
    key: k, label: NUTRIENT[k].label, unit: NUTRIENT[k].unit, need, based: refs ? 'needs' : NUTRIENT[k].ri ? 'ri' : 'reference',
    limit: LIMIT_KEYS.includes(k), by: rank, days: OWN_DAYS, kcalFloor: KCAL_FLOOR,
    yours: richRank(own, k, need, rank, RICH_ROWS.yours),
    ideas: richRank(ideas, k, need, rank, RICH_ROWS.ideas),
  };
}

// One line per food for the coach: "Lentils, boiled | 1 US cup (198 g) | 6.6 mg iron, 60% of need".
export async function richForCoach(key, by = 'portion') {
  const r = await richIn(key, { by });
  const unit = r.unit;
  const row = (x) => {
    const p = by === 'kcal' ? x.perKcal : x;
    const amt = by === 'kcal' ? `per 100 kcal${x.perKcal?.g ? ` (about ${x.perKcal.g} ${x.perKcal.basis})` : ''}` : `${x.portion.text}${x.portion.g ? ` (${round(x.portion.g, 0)} g)` : ''}`;
    return `${x.name}${x.brand ? ` (${x.brand})` : ''} | ${amt} | ${p.amount}${x.floor ? '+' : ''} ${unit} ${r.label.toLowerCase()}${p.pct === null ? '' : `, ${p.pct}% of ${r.based === 'needs' ? 'his need' : 'the reference intake'}`}`;
  };
  const yours = r.yours.length ? r.yours.map(row).join('\n') : 'none with a value on record';
  const ideas = r.ideas.length ? r.ideas.map(row).join('\n') : 'none';
  return `Richest in ${r.label.toLowerCase()} ${by === 'kcal' ? 'per 100 kcal' : 'per typical portion'}. Foods with no value for it are left out, not counted as zero.\nHis foods (last ${r.days} days, at his usual amount):\n${yours}\nMore ideas from the catalogue:\n${ideas}`;
}

// ---------- API ----------

export const foodNextApi = new Hono();
foodNextApi.get('/food/next', async (c) => c.json(await nextSuggestions(c.req.query('date') || null)));
foodNextApi.get('/food/rich', async (c) => c.json(await richIn(c.req.query('k'), { by: c.req.query('by') })));
