// Real burn: what his body actually burns in a day, measured from his own food log and weight trend
// instead of a formula. Over a window of whole days, the energy eaten minus the energy stored (or taken
// from store) is the energy burnt: the mean intake of the fully logged days, minus the weight trend's
// slope × 7,700 kcal a kilo. MacroFactor works this way; this one also says how sure it is, and why.
//
// Honest by construction:
// - a day with nothing logged is left out, never counted as zero; so is a day whose energy total is
//   missing some lines, and a day so far under his usual burn (under 45%) that it can only have been
//   partly logged. Each kind is counted, so the screen can say what was left out;
// - the slope comes from the scale readings themselves, by least squares. The smoothed trend lags a
//   change by about ten days and each of its days leans on the one before, so a fit to it would
//   understate both the change and how unsure it is. The smoothed trend is what the screen draws;
// - how sure it is follows the fully logged days, the weigh-ins and the span they cover. The result
//   leans on the usual burn (the formula, or Apple Health) by that much, and carries a ± range from the
//   slope's standard error and the spread of the logged days.
import { Hono } from 'hono';
import { db } from './db.js';
import { localNow } from './engine.js';
import { addDays } from './time.js';
import { dayStats } from './food.js';
import { getBody, healthEnergy, weightHistory } from './body.js';
import { personalNeeds, GOALS, round } from '../public/nutrition.js';

// The usual working figure for a kilo of body weight gained or lost: mostly fat, some lean tissue and water.
export const KCAL_PER_KG = 7700;
// Smoothing a day for the trend line, as in The Hacker's Diet: a tenth of the gap to each new reading.
export const ALPHA = 0.1;
export const WINDOW_DAYS = 28;
// A day under this share of his usual burn was only partly logged; without a body, of 2,000 kcal.
export const PARTIAL_SHARE = 0.45;
const NO_BODY_BURN = 2000;
// What each level needs: fully logged days, weigh-ins, and days from the first weigh-in to the last,
// all inside the window. With ±0.5 kg of day-to-day water, 5 readings over two weeks put the slope
// within about ±350 kcal a day, which the blend halves; 16 over four weeks, about ±120.
export const CONFIDENCE = {
  low: { days: 10, weighIns: 5, span: 14 },
  medium: { days: 18, weighIns: 10, span: 21 },
  high: { days: 24, weighIns: 16, span: 26 },
};
// How far the result leans on the measurement rather than the usual burn.
export const WEIGHT = { none: 0, low: 0.5, medium: 0.75, high: 0.9 };
export const BURN_MIN = 1200;
export const BURN_MAX = 6000;
// A measurement this unsure (± in kcal), or one outside the sane range, is never more than low.
export const WIDE = 500;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const clamp = (v) => Math.min(BURN_MAX, Math.max(BURN_MIN, v));
const round10 = (v) => round(v / 10) * 10;
const mean = (list) => list.reduce((a, v) => a + v, 0) / list.length;
// Dates here are plain calendar dates, so the arithmetic is done at noon UTC, clear of any clock change.
const shift = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const joinAnd = (parts) => (parts.length < 2 ? parts[0] || '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const kcalText = (v) => Math.round(v).toLocaleString('en-GB');

// ---------- The maths, pure ----------

// The smoothed weight, one point a day from the first reading to `to`: each reading pulls the trend a
// tenth of the way towards it, and a day with no reading carries the trend over unchanged.
// readings: [{ date, kg }] → [{ date, kg (that day's reading or null), trendKg }].
export function trendLine(readings, to, alpha = ALPHA) {
  const list = (readings || []).filter((r) => num(r?.kg) > 0 && r.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return [];
  const byDate = new Map(list.map((r) => [r.date, r.kg]));
  const out = [];
  let t = null;
  for (let d = list[0].date; d <= to; d = shift(d, 1)) {
    const kg = byDate.get(d) ?? null;
    if (kg !== null) t = t === null ? kg : t + alpha * (kg - t);
    out.push({ date: d, kg, trendKg: round(t, 2) });
  }
  return out;
}

// A straight line through [{ x, y }] by least squares: { slope, se, n }, or null with fewer than two
// points or one x. `se` is the slope's standard error, null with only two points.
export function slopeFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const ssr = points.reduce((a, p) => a + (p.y - (my + slope * (p.x - mx))) ** 2, 0);
  return { slope, se: n > 2 ? Math.sqrt(ssr / (n - 2) / sxx) : null, n };
}

// Why a day (from food.js dayStats) is left out, or null when it counts: 'none' nothing logged,
// 'incomplete' some lines with no energy, 'partial' under `floor` kcal, too low to be a whole day.
export function dayKind(d, floor) {
  if (!d?.logged) return 'none';
  if (num(d.kcal) === null || d.missing?.kcal) return 'incomplete';
  if (d.kcal < floor) return 'partial';
  return null;
}

// { days, weighIns, span } → 'none' | 'low' | 'medium' | 'high'.
export function confidenceOf(c) {
  for (const level of ['high', 'medium', 'low']) {
    const t = CONFIDENCE[level];
    if (c.days >= t.days && c.weighIns >= t.weighIns && c.span >= t.span) return level;
  }
  return 'none';
}

// What is still missing for a first, low-confidence reading, in numbers and in words:
// "6 more fully logged days and 3 more weigh-ins over at least 9 more days". `daysToGo` is the
// fewest days it can take, logging and weighing in every day.
export function missingFor(c) {
  const t = CONFIDENCE.low;
  const days = Math.max(0, t.days - c.days);
  const weighIns = Math.max(0, t.weighIns - c.weighIns);
  const span = Math.max(0, t.span - c.span);
  const parts = [];
  if (days) parts.push(`${days} more fully logged ${days === 1 ? 'day' : 'days'}`);
  if (weighIns) parts.push(`${weighIns} more ${weighIns === 1 ? 'weigh-in' : 'weigh-ins'}${span ? ` over at least ${plural(span, 'more day', 'more days')}` : ''}`);
  else if (span) parts.push(`weigh-ins over ${plural(span, 'more day', 'more days')}`);
  return { days, weighIns, span, daysToGo: Math.max(days, weighIns, span), text: joinAnd(parts) };
}

const kgWeek = (v) => `${Math.abs(v).toFixed(1)} kg a week`;

// Is the weight going the way the goal wants? { key, label, kcal, ok: true | false | null, text }.
// `enough` is false until the weigh-ins could show a trend at all.
export function goalCheck(goal, perWeek, enough) {
  const key = goal in GOALS ? goal : 'keep';
  const base = { key, label: GOALS[key].label, kcal: GOALS[key].kcal };
  if (!enough || num(perWeek) === null) return { ...base, ok: null, text: 'Too early to tell: the trend needs more weigh-ins.' };
  const flat = Math.abs(perWeek) < 0.1;
  const say = (ok, text) => ({ ...base, ok, text });
  if (key === 'gain') {
    if (perWeek > 0.75) return say(false, `Gaining about ${kgWeek(perWeek)}, faster than planned.`);
    if (perWeek >= 0.1) return say(true, `Gaining about ${kgWeek(perWeek)}, as planned.`);
    return say(false, flat ? 'Not gaining yet: the trend is flat.' : `Not gaining yet: losing about ${kgWeek(perWeek)}.`);
  }
  if (key === 'lose') {
    if (perWeek < -1) return say(false, `Losing about ${kgWeek(perWeek)}, faster than planned.`);
    if (perWeek <= -0.1) return say(true, `Losing about ${kgWeek(perWeek)}, as planned.`);
    return say(false, flat ? 'Not losing yet: the trend is flat.' : `Not losing yet: gaining about ${kgWeek(perWeek)}.`);
  }
  if (Math.abs(perWeek) <= 0.15) return say(true, 'Steady, as planned.');
  return say(false, `${perWeek > 0 ? 'Gaining' : 'Losing'} about ${kgWeek(perWeek)}, while the goal is to keep it steady.`);
}

// Real burn over the window from..to (both whole days). days: food.js dayStats for the days that have
// logs (a date with none is a day with nothing logged). readings: [{ date, kg }], one a day, as far back
// as there are (the trend needs a run-up before the window). prior: the usual burn before the goal,
// or null without a body. today: where the trend line ends (else the last reading or `to`).
// Everything the screen and the coach need, rounded for showing.
export function measure({ days = [], readings = [], from, to, today = null, prior = null, goal = 'keep', alpha = ALPHA }) {
  const dates = [];
  for (let d = from; d <= to; d = shift(d, 1)) dates.push(d);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const usual = num(prior);
  const floor = PARTIAL_SHARE * (usual ?? NO_BODY_BURN);
  const end = (readings || []).reduce((a, r) => (r?.date > a ? r.date : a), today && today > to ? today : to);
  const line = trendLine(readings, end, alpha);
  const point = new Map(line.map((p) => [p.date, p]));

  const series = dates.map((date) => {
    const d = byDate.get(date);
    const reason = dayKind(d, floor);
    const p = point.get(date);
    return { date, kcal: d?.logged && num(d.kcal) !== null ? round(d.kcal) : null, good: reason === null, reason, weightKg: p?.kg ?? null, trendKg: p?.trendKg ?? null };
  });
  const good = series.filter((s) => s.good);
  const weighed = series.filter((s) => s.weightKg !== null);
  const counts = {
    good: good.length,
    none: series.filter((s) => s.reason === 'none').length,
    incomplete: series.filter((s) => s.reason === 'incomplete').length,
    partial: series.filter((s) => s.reason === 'partial').length,
    weighIns: weighed.length,
    span: weighed.length ? dayDiff(weighed[0].date, weighed[weighed.length - 1].date) : 0,
  };

  const fit = slopeFit(weighed.map((s) => ({ x: dayDiff(from, s.date), y: s.weightKg })));
  const intake = good.length ? mean(good.map((s) => s.kcal)) : null;
  const raw = fit && intake !== null ? intake - fit.slope * KCAL_PER_KG : null;
  // ± one standard error: the slope's, and the mean intake's as a sample of the window's days (the
  // days left out were eaten too; the fully logged ones stand in for them).
  let margin = null;
  if (raw !== null && fit.se !== null) {
    const n = good.length;
    const N = dates.length;
    const sd = n > 1 ? Math.sqrt(good.reduce((a, s) => a + (s.kcal - intake) ** 2, 0) / (n - 1)) : 0;
    const intakeSe = N > 1 ? (sd / Math.sqrt(n)) * Math.sqrt(Math.max(0, (N - n) / (N - 1))) : 0;
    margin = Math.sqrt((fit.se * KCAL_PER_KG) ** 2 + intakeSe ** 2);
  }
  const clamped = raw !== null && (raw < BURN_MIN || raw > BURN_MAX);
  let confidence = raw === null ? 'none' : confidenceOf({ days: counts.good, weighIns: counts.weighIns, span: counts.span });
  if (confidence !== 'none' && (clamped || margin > WIDE)) confidence = 'low';

  const measured = raw === null ? null : round10(clamp(raw));
  const w = confidence === 'none' ? 0 : usual === null ? 1 : WEIGHT[confidence];
  let blended = usual;
  if (measured !== null && w > 0) blended = usual === null ? clamp(raw) : w * clamp(raw) + (1 - w) * usual;
  const burn = blended === null ? null : round10(clamp(blended));
  const pm = margin === null ? null : round10(margin);
  const range = confidence === 'none' || pm === null || burn === null ? null : { low: clamp(burn - pm), high: clamp(burn + pm), margin: pm };
  const enough = counts.weighIns >= CONFIDENCE.low.weighIns && counts.span >= CONFIDENCE.low.span;
  const check = goalCheck(goal, fit ? fit.slope * 7 : null, enough);
  const last = line[line.length - 1];

  return {
    window: { from, to, days: dates.length },
    today: end,
    series,
    weights: line.map((p) => ({ date: p.date, kg: p.kg, trendKg: p.trendKg })),
    trend: {
      kg: last ? round(last.trendKg, 1) : null,
      date: last?.date ?? null,
      perDay: fit ? round(fit.slope, 4) : null,
      perWeek: fit ? round(fit.slope * 7, 2) : null,
    },
    intake: { avg: intake === null ? null : round(intake), days: good.length },
    counts,
    measured,
    clamped,
    prior: usual === null ? null : round(usual),
    burn,
    range,
    confidence,
    weight: w,
    missing: confidence === 'none' ? missingFor({ days: counts.good, weighIns: counts.weighIns, span: counts.span }) : null,
    goal: check,
    suggested: burn === null ? null : round10(burn + check.kcal),
  };
}

// What personalNeeds takes as health.burn.
export const burnInput = (r) => (r ? { kcal: r.burn, confidence: r.confidence, days: r.window.days, missing: r.missing?.text || '' } : null);

// ---------- From the database ----------

// The window's days with logs, as the Trends screen totals them.
async function intakeDays(from, to) {
  const rows = await db()`select date, nutrients, liquid, ml, estimate from food_log where deleted_at is null and date >= ${from} and date <= ${to} order by at`;
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) || []), r]);
  return [...byDate].map(([date, list]) => dayStats(date, list));
}

// Real burn over the 28 whole days ending yesterday. body and health (Apple Health's averages) are
// passed in when the caller has them. The usual burn is his needs worked out without real burn.
export async function energyReport({ today, tz, body, health } = {}) {
  if (!today) ({ today, tz } = await localNow());
  const b = body || (await getBody());
  const h = health || (await healthEnergy(today, tz));
  const usual = personalNeeds({ ...b, energyFrom: 'auto' }, today, h);
  const to = addDays(today, -1, tz);
  const from = addDays(to, -(WINDOW_DAYS - 1), tz);
  const [days, readings] = await Promise.all([intakeDays(from, to), weightHistory(today, tz)]);
  return {
    ...measure({ days, readings, from, to, today, prior: usual?.about.energy.burn ?? null, goal: b.goal }),
    priorFrom: usual?.about.energy.from ?? null,
    energyFrom: b.energyFrom === 'burn' ? 'burn' : 'auto',
  };
}

// One line for the coach's snapshot. `needs` are his needs as they stand.
export function burnForCoach(r, needs) {
  const using = needs?.about?.energy?.from === 'burn';
  const usualWord = r.priorFrom === 'health' ? 'Apple Health and the formula' : 'the formula';
  if (r.confidence === 'none') {
    const chose = r.energyFrom === 'burn' ? ' He chose to use it for his needs, so it takes over once ready; until then they use the formula.' : '';
    return `Real burn (measured from his logged food and weight trend, ${r.window.days} days to ${r.window.to}): not enough data yet; it needs ${r.missing.text}.${chose}`;
  }
  const t = r.trend;
  const rate = t.perWeek === null ? '' : `, ${t.perWeek > 0 ? '+' : t.perWeek < 0 ? '−' : ''}${Math.abs(t.perWeek).toFixed(2)} kg a week`;
  const usual = r.prior === null ? '' : `; ${usualWord} says ${kcalText(r.prior)}`;
  return `Real burn, measured from his logged food and weight trend over the ${r.window.days} days to ${r.window.to}: about ${kcalText(r.burn)} kcal a day`
    + `${r.range ? ` (± ${kcalText(r.range.margin)})` : ''}, ${r.confidence} confidence, from ${plural(r.counts.good, 'fully logged day')} and ${plural(r.counts.weighIns, 'weigh-in')}`
    + ` (measured alone ${kcalText(r.measured)}${usual}). Weight trend ${t.kg} kg${rate}. Goal check: ${r.goal.text}`
    + ` ${using ? 'His daily needs use the real burn.' : 'His daily needs do not use it; he can switch in Settings or on the Trends Body tab.'}`;
}

// ---------- API ----------

export const energyApi = new Hono();
energyApi.get('/food/energy', async (c) => {
  const { today, tz } = await localNow();
  const body = await getBody();
  const health = await healthEnergy(today, tz);
  const r = await energyReport({ today, tz, body, health });
  const needs = personalNeeds(body, today, { ...health, burn: burnInput(r) });
  // need: his daily need as it stands (with the goal), and whether it uses the real burn.
  return c.json({ ...r, need: needs?.refs.kcal ?? null, using: needs?.about.energy.from === 'burn', profile: Boolean(needs) });
});
