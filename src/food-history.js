// The Trends history: day stats and period averages, and what a period's food adds up to (the foods
// eaten, coverage, sources of sugar, salt and the rest, and plain advice).
import { DateTime } from 'luxon';
import { db } from './db.js';
import { addDays, validDate } from './time.js';
import { localNow, RuleError } from './engine.js';
import * as NUT from '../public/nutrition.js';
import { total, round, complete, norm, NUTRIENTS, KEYS, NUTRIENT } from '../public/nutrition.js';
import { needRefs } from './body.js';
import { logged, shapeEntry, n, gradeEntries, gradeMix } from './food.js';

const HISTORY_KEYS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'fibre', 'salt', 'caffeine'];
export const HISTORY_SPANS = [7, 30, 90];

// One day's totals. A day with nothing logged is a gap: every value null, never zero. `incomplete`
// means some lines had no value for a core nutrient, so those totals are floors. Real burn
// (food-energy.js) reads its days through this too.
export function dayStats(date, list) {
  if (!list.length) {
    return { date, logged: false, entries: 0, ...Object.fromEntries(HISTORY_KEYS.map((k) => [k, null])), drinksMl: null, incomplete: false, estimates: 0 };
  }
  const t = total(list.map((e) => e.nutrients));
  const missing = Object.fromEntries(HISTORY_KEYS.filter((k) => t.missing?.[k]).map((k) => [k, t.missing[k]]));
  return {
    date,
    logged: true,
    entries: list.length,
    ...Object.fromEntries(HISTORY_KEYS.map((k) => [k, t[k] === null ? null : round(t[k], 2)])),
    drinksMl: round(list.filter((e) => e.liquid && e.ml).reduce((a, e) => a + e.ml, 0), 0),
    incomplete: !complete(t),
    estimates: list.filter((e) => e.estimate).length,
    ...(Object.keys(missing).length ? { missing } : {}),
  };
}

// Averages over the days that have logs only. A nutrient's `missing` count is how many of those days
// were unknown or partial for it, so the screen can mark the average as a floor.
function periodAverages(days) {
  const logged = days.filter((d) => d.logged);
  const avg = {};
  const missing = {};
  for (const k of [...HISTORY_KEYS, 'drinksMl']) {
    const vals = logged.filter((d) => d[k] !== null).map((d) => d[k]);
    avg[k] = vals.length ? round(vals.reduce((a, v) => a + v, 0) / vals.length, 2) : null;
    const m = logged.filter((d) => d[k] === null || d.missing?.[k]).length;
    if (m) missing[k] = m;
  }
  if (Object.keys(missing).length) avg.missing = missing;
  return { loggedDays: logged.length, avg };
}

// Per-day totals for the last `days` days (7, 30 or 90) ending today, averages over logged days and
// the same for the period before, the most logged foods, and caffeine and drinks by hour for one day.
// Today is still going, so it is drawn but left out of the averages.
export async function foodHistory({ days = 7, date = null } = {}) {
  const span = HISTORY_SPANS.includes(Number(days)) ? Number(days) : 7;
  const { today, tz } = await localNow();
  const from = addDays(today, -(span - 1), tz);
  const prevFrom = addDays(from, -span, tz);
  const prevTo = addDays(from, -1, tz);
  if (date && !validDate(String(date))) throw new RuleError('Bad date.');
  const chosen = date && String(date) <= today ? String(date) : today;
  const lo = chosen < prevFrom ? chosen : prevFrom;
  const rows = (await db()`select * from food_log where deleted_at is null and date >= ${lo} and date <= ${today} order by at, created_at`).map(shapeEntry);
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) || []), r]);
  const run = (start, n) => Array.from({ length: n }, (_, i) => {
    const d = addDays(start, i, tz);
    return dayStats(d, byDate.get(d) || []);
  });
  const series = run(from, span);
  const prevSeries = run(prevFrom, span);
  const current = periodAverages(series.filter((d) => d.date !== today));
  const prev = periodAverages(prevSeries);

  // Most logged: catalogue foods and recipes by record, everything else by name.
  const counts = new Map();
  for (const r of rows.filter((x) => x.date >= from)) {
    const key = ['item', 'recipe'].includes(r.kind) && r.refKey ? `${r.kind}:${r.refKey}` : `name:${norm(r.name)}`;
    const c = counts.get(key) || { name: r.name, kind: r.kind, count: 0 };
    c.count += 1;
    c.name = r.name;
    counts.set(key, c);
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 6);
  const refs = await needRefs();
  const insights = periodInsights(await gradeEntries(rows.filter((r) => r.date >= from)), { series, today, tz, refs });

  // The chosen day by local hour. A drink with no caffeine value is counted apart, not as zero.
  const dayRows = byDate.get(chosen) || [];
  const hours = { caffeine: Array(24).fill(0), caffeineUnknown: Array(24).fill(0), drinksMl: Array(24).fill(0) };
  for (const r of dayRows) {
    const h = DateTime.fromJSDate(new Date(r.at)).setZone(tz).hour;
    const caf = r.nutrients?.caffeine;
    if (typeof caf === 'number') hours.caffeine[h] = round(hours.caffeine[h] + caf, 1);
    else if (r.liquid) hours.caffeineUnknown[h] += 1;
    if (r.liquid && r.ml) hours.drinksMl[h] = round(hours.drinksMl[h] + r.ml, 0);
  }
  return {
    days: span, today, from, to: today, prevFrom, prevTo,
    series,
    ...current,
    prev,
    top,
    ...insights,
    chosen: { ...dayStats(chosen, dayRows), today: chosen === today, hours },
    needs: refs,
  };
}

// ---------- Insights: what the period's food adds up to ----------

// The nutrients with a daily amount to measure against: his own needs when his body is set, else the EU RIs.
const refList = (refs) => NUTRIENTS.filter((x) => NUT.refOf(x.key, refs));
export const SOURCE_KEYS = ['sugars', 'salt', 'satfat', 'protein', 'fibre'];
const LIMIT_KEYS = ['sugars', 'salt', 'satfat'];
const weekday = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday 0

// One row per food eaten in the period: how often, its grade, and what it added up to.
function foodsEaten(entries) {
  const foods = new Map();
  for (const e of entries) {
    const key = ['item', 'recipe'].includes(e.kind) && e.refKey ? `${e.kind}:${e.refKey}` : `${e.kind === 'quick' ? 'name' : e.kind}:${norm(e.name)}`;
    const f = foods.get(key) || { key, name: e.name, brand: e.brand || null, kind: e.kind, grade: null, nova: null, tags: [], count: 0, sums: {}, known: {} };
    f.count += 1;
    f.name = e.name;
    f.grade = e.grade || f.grade;
    f.nova = e.nova ?? f.nova;
    if (e.tags?.length) f.tags = e.tags;
    for (const k of KEYS) {
      const v = n(e.nutrients?.[k]);
      if (v === null) continue;
      f.sums[k] = (f.sums[k] || 0) + v;
      f.known[k] = (f.known[k] || 0) + 1;
    }
    foods.set(key, f);
  }
  return [...foods.values()];
}

// Average % of his daily need (or the EU reference intake) per nutrient over complete logged days. A day with no value
// for a nutrient is left out of its average, and `partial` counts the days that were unknown or a
// floor, so the screen can say the average is at least that. `est` is the share of it, in %, that was
// filled (from a similar USDA food, the web or an estimate) rather than on the records themselves.
function coverageOf(totals, est = {}, refs = null) {
  return refList(refs).map((x) => {
    const ri = NUT.refOf(x.key, refs);
    const vals = totals.map((t) => n(t[x.key])).filter((v) => v !== null);
    const avg = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    return {
      key: x.key, label: x.label, group: x.group, unit: x.unit, ri,
      avg: avg === null ? null : round(avg, 3),
      pct: avg === null ? null : round((avg / ri) * 100, 1),
      days: vals.length,
      partial: totals.filter((t) => n(t[x.key]) === null || t.missing?.[x.key]).length,
      est: avg === null ? 0 : est[x.key] || 0,
    };
  });
}

// Per nutrient, the % of what the entries brought that was filled rather than on record. A nutrient
// whose filled values add up to nothing (zeros) still counts as estimated when any were filled.
function filledShare(entries) {
  const all = {};
  const est = {};
  const count = {};
  for (const e of entries) {
    const fl = new Set(e.filled || []);
    for (const k of KEYS) {
      const v = n(e.nutrients?.[k]);
      if (v === null) continue;
      all[k] = (all[k] || 0) + v;
      if (fl.has(k)) {
        est[k] = (est[k] || 0) + v;
        count[k] = (count[k] || 0) + 1;
      }
    }
  }
  return Object.fromEntries(KEYS.filter((k) => count[k]).map((k) => [k, all[k] > 0 ? Math.max(1, round(((est[k] || 0) / all[k]) * 100, 0)) : 100]));
}

// "Eat more of": for his least-covered vitamins and minerals, the food he already eats that brings
// the most of each per time (never one graded D or E). "Eat less of": the top source of any of
// sugars, salt or saturates whose average day is over its reference intake, then D and E foods he
// had more than once. Nothing is invented: every reason is his own data against an official measure.
function adviceFrom(foods, coverage, sources) {
  const more = [];
  const seen = new Set();
  const low = coverage.filter((c) => ['mineral', 'vitamin'].includes(c.group) && c.pct !== null && c.pct < 100).sort((a, b) => a.pct - b.pct).slice(0, 4);
  for (const c of low) {
    const best = foods.filter((f) => !['d', 'e'].includes(f.grade) && f.sums[c.key] > 0 && !seen.has(f.key))
      .map((f) => ({ f, per: f.sums[c.key] / f.count })).sort((a, b) => b.per - a.per)[0];
    if (!best) continue;
    seen.add(best.f.key);
    more.push({ key: best.f.key, name: best.f.name, grade: best.f.grade, nutrient: c.key, reason: c.label, pct: round((best.per / c.ri) * 100, 0), avgPct: c.pct });
  }
  if (!more.length) {
    for (const f of foods.filter((x) => x.grade === 'a').sort((a, b) => b.count - a.count).slice(0, 3)) more.push({ key: f.key, name: f.name, grade: f.grade, reason: 'Nutri-Score A', count: f.count });
  }
  const less = [];
  const out = new Set();
  for (const k of LIMIT_KEYS) {
    const c = coverage.find((x) => x.key === k);
    const top = sources[k]?.items[0];
    if (!c || !(c.pct > 100) || !top || out.has(top.key)) continue;
    out.add(top.key);
    less.push({ key: top.key, name: top.name, grade: top.grade, nutrient: k, reason: NUTRIENT[k].label, share: top.share, avgPct: c.pct });
  }
  for (const f of foods.filter((x) => ['d', 'e'].includes(x.grade) && x.count > 1).sort((a, b) => b.count - a.count || (b.sums.kcal || 0) - (a.sums.kcal || 0))) {
    if (out.has(f.key)) continue;
    out.add(f.key);
    less.push({ key: f.key, name: f.name, grade: f.grade, reason: `Nutri-Score ${f.grade.toUpperCase()}`, count: f.count });
  }
  return { more: more.slice(0, 5), less: less.slice(0, 5) };
}

// Everything the Trends screen draws past the energy bars: reference-intake coverage, the grade mix
// by day, best and worst foods, top sources, eat more or less, meal timing and weekday averages.
// Averages use complete logged days (not today); counts, sources and grades use the whole period.
function periodInsights(entries, { series, today, tz, refs = null }) {
  const completeDates = new Set(series.filter((d) => d.logged && d.date !== today).map((d) => d.date));
  const byDate = new Map();
  for (const e of entries) byDate.set(e.date, [...(byDate.get(e.date) || []), e]);
  const totals = [...completeDates].map((d) => total((byDate.get(d) || []).map((e) => e.nutrients)));
  const est = filledShare([...completeDates].flatMap((d) => byDate.get(d) || []));
  const coverage = coverageOf(totals, est, refs);
  const label = labelOf(totals, est);

  const grades = { total: gradeMix(entries), days: series.map((d) => ({ date: d.date, ...gradeMix(byDate.get(d.date) || []) })) };

  const foods = foodsEaten(entries);
  const card = (f) => ({ key: f.key, name: f.name, brand: f.brand, kind: f.kind, grade: f.grade, nova: f.nova, count: f.count, kcal: round(f.sums.kcal ?? null, 0), tags: f.tags.slice(0, 3) });
  const byCount = (a, b) => b.count - a.count || (b.sums.kcal || 0) - (a.sums.kcal || 0) || a.name.localeCompare(b.name);
  const rank = {
    best: foods.filter((f) => ['a', 'b'].includes(f.grade)).sort((a, b) => a.grade.localeCompare(b.grade) || byCount(a, b)).slice(0, 5).map(card),
    worst: foods.filter((f) => ['d', 'e'].includes(f.grade)).sort((a, b) => b.grade.localeCompare(a.grade) || byCount(a, b)).slice(0, 5).map(card),
    graded: foods.filter((f) => f.grade).length,
    foods: foods.length,
  };

  const sources = {};
  for (const k of SOURCE_KEYS) {
    const sum = foods.reduce((a, f) => a + (f.sums[k] || 0), 0);
    sources[k] = {
      total: round(sum, 2),
      items: foods.filter((f) => f.sums[k] > 0).sort((a, b) => b.sums[k] - a.sums[k]).slice(0, 5)
        .map((f) => ({ key: f.key, name: f.name, grade: f.grade, count: f.count, amount: round(f.sums[k], 2), share: sum ? round((f.sums[k] / sum) * 100, 1) : null })),
    };
  }

  // Meal timing: average kcal by weekday and local hour, over complete days.
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const perWeekday = Array(7).fill(0);
  for (const d of completeDates) perWeekday[weekday(d)] += 1;
  for (const e of entries) {
    if (!completeDates.has(e.date)) continue;
    const k = n(e.nutrients?.kcal);
    if (!k) continue;
    heat[weekday(e.date)][DateTime.fromJSDate(new Date(e.at)).setZone(tz).hour] += k;
  }
  const timing = { kcal: heat.map((row, w) => row.map((v) => (perWeekday[w] ? round(v / perWeekday[w], 0) : null))), days: perWeekday };

  const weekdays = Array.from({ length: 7 }, (_, w) => {
    const list = series.filter((d) => completeDates.has(d.date) && weekday(d.date) === w);
    const avg = (k) => {
      const vals = list.map((d) => d[k]).filter((v) => v !== null);
      return vals.length ? round(vals.reduce((a, v) => a + v, 0) / vals.length, 1) : null;
    };
    return { day: w, n: list.length, kcal: avg('kcal'), protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat'), sugars: avg('sugars') };
  });

  return { coverage, label, grades, rank, sources, advice: adviceFrom(foods, coverage, sources), timing, weekdays };
}

// The average day as a nutrition label: every nutrient averaged over the complete days with a value
// for it. `missing` counts the days it was unknown or a floor (so the average is at least that), and
// `filled` names the nutrients partly filled by estimate. Null when no day is complete.
function labelOf(totals, est) {
  if (!totals.length) return null;
  const out = { days: totals.length, missing: {}, filled: Object.keys(est) };
  for (const k of KEYS) {
    const vals = totals.map((t) => n(t[k])).filter((v) => v !== null);
    out[k] = vals.length ? round(vals.reduce((a, v) => a + v, 0) / vals.length, 3) : null;
    const m = totals.filter((t) => n(t[k]) === null || t.missing?.[k]).length;
    if (m) out.missing[k] = m;
  }
  return out;
}
