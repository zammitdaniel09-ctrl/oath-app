// His body: sex, birth date, height, weight, body fat, how active he is and his goal. It turns every
// nutrition percentage into a share of what his own body needs (public/nutrition.js personalNeeds).
// Stored in kv, never in code: the repository is public.
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { db, getKV, setKV, logEvent } from './db.js';
import { localNow, RuleError } from './engine.js';
import { validDate, addDays } from './time.js';
// health.js is loaded when first needed: importing it here closes a loop (health, push, telegram, coach,
// coach-tools, food, body) that leaves food.js half-loaded when the server starts.
const metricDays = async (...args) => (await import('./health.js')).metricDays(...args);
// Real burn (food-energy.js) reads the diary, and food.js imports this file, so it too is loaded when needed.
const energy = () => import('./food-energy.js');
import { personalNeeds, energyText, ACTIVITY, GOALS } from '../public/nutrition.js';

const KEY = 'body';
// Apple Health's activity sets the energy need once it covers this many of the last 7 days.
const HEALTH_DAYS = 7;
const HEALTH_MIN_DAYS = 4;
const WEIGHT_DAYS = 90;

const number = (raw, name, min, max, dec = 1) => {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new RuleError(`${name} must be between ${min} and ${max}.`);
  return Math.round(n * 10 ** dec) / 10 ** dec;
};

// Checks the fields given and returns only those; body fat may be cleared with an empty value.
export function cleanBody(b = {}) {
  const out = {};
  if (b.sex !== undefined) {
    if (!['male', 'female'].includes(b.sex)) throw new RuleError('Sex is male or female.');
    out.sex = b.sex;
  }
  if (b.birthDate !== undefined) {
    if (!validDate(String(b.birthDate))) throw new RuleError('Birth date must look like 2000-01-31.');
    out.birthDate = String(b.birthDate);
  }
  const h = number(b.heightCm, 'Height', 120, 230);
  if (h !== undefined) out.heightCm = h;
  const w = number(b.weightKg, 'Weight', 30, 250);
  if (w !== undefined) out.weightKg = w;
  const f = number(b.bodyFat, 'Body fat', 3, 60);
  if (f !== undefined) out.bodyFat = f;
  if (b.activity !== undefined) {
    if (!(b.activity in ACTIVITY)) throw new RuleError('Unknown activity level.');
    out.activity = b.activity;
  }
  if (b.goal !== undefined) {
    if (!(b.goal in GOALS)) throw new RuleError('The goal is keep, gain or lose.');
    out.goal = b.goal;
  }
  // Where the energy need comes from: 'auto' is the formula, or Apple Health's activity once it has
  // enough days; 'burn' is his real burn from his weight trend and logged food (food-energy.js).
  if (b.energyFrom !== undefined) {
    if (!['auto', 'burn'].includes(b.energyFrom)) throw new RuleError('Energy comes from auto or burn.');
    out.energyFrom = b.energyFrom;
  }
  return out;
}

export const getBody = async () => (await getKV(KEY)) || {};

// Average active and resting energy a day from Apple Health day values ([{ active_kcal, basal_kcal }]),
// each null unless at least 4 days have it. A day with no reading is left out, never counted as zero.
export function energyAverages(days) {
  const avg = (k) => {
    const vals = days.map((d) => d[k]).filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
    return vals.length >= HEALTH_MIN_DAYS ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : null;
  };
  return { activeAvg: avg('active_kcal'), restingAvg: avg('basal_kcal') };
}

// The 7 whole days before today: today is still going, so its active energy is only part of a day.
export async function healthEnergy(today, tz) {
  const days = await metricDays(['active_kcal', 'basal_kcal'], addDays(today, -HEALTH_DAYS, tz), addDays(today, -1, tz));
  return energyAverages(days);
}

// His needs, and the real burn report when he chose it (or `report` asks for it anyway). A report
// that fails leaves the usual figure in place: real burn only ever replaces it when it is ready.
async function needsFor(body, today, tz, report = body.energyFrom === 'burn') {
  const health = await healthEnergy(today, tz);
  const E = report ? await energy() : null;
  const burn = E ? await E.energyReport({ today, tz, body, health }).catch((err) => { console.error('real burn failed:', err.message); return null; }) : null;
  return { needs: personalNeeds(body, today, { ...health, burn: E?.burnInput(burn) ?? null }), burn };
}

// What the screens and the coach need: the body as saved and the daily needs worked out from it.
export async function bodyNeeds() {
  const { today, tz } = await localNow();
  const body = await getBody();
  return { body, needs: (await needsFor(body, today, tz)).needs };
}

// Weight over the last 90 days, one reading a day: what he saved in Oath (by hand or through the
// coach), else Apple Health's body mass. [{ date, kg, from: 'oath' | 'health' }], oldest first.
export async function weightHistory(today, tz) {
  const from = addDays(today, -(WEIGHT_DAYS - 1), tz);
  const byDate = new Map();
  for (const d of await metricDays(['weight_kg'], from, today)) {
    if (d.weight_kg !== null) byDate.set(d.date, { date: d.date, kg: d.weight_kg, from: 'health' });
  }
  const start = DateTime.fromISO(from, { zone: tz }).startOf('day').toJSDate();
  const rows = await db()`select data, at from events where type = 'weight' and at >= ${start} order by at`;
  for (const r of rows) {
    const kg = Number(r.data?.kg);
    if (!(kg > 0)) continue;
    const date = DateTime.fromJSDate(new Date(r.at)).setZone(tz).toISODate();
    if (date >= from && date <= today) byDate.set(date, { date, kg, from: 'oath' });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The Body card: the body, its needs, the weight chart and, for the choice of where energy comes
// from, how ready real burn is.
async function bodyView() {
  const { today, tz } = await localNow();
  const body = await getBody();
  const { needs, burn } = await needsFor(body, today, tz, true);
  const energySummary = burn && {
    confidence: burn.confidence, burn: burn.burn, measured: burn.measured, range: burn.range, missing: burn.missing,
    good: burn.counts.good, weighIns: burn.counts.weighIns, days: burn.window.days, using: needs?.about.energy.from === 'burn',
  };
  return { body, needs, weights: await weightHistory(today, tz), energy: energySummary || null };
}

// His needs a day, or null for the EU reference intakes.
export async function needRefs() {
  return (await bodyNeeds()).needs?.refs || null;
}

export async function saveBody(input) {
  const patch = cleanBody(input);
  if (!Object.keys(patch).length) throw new RuleError('Nothing to save.');
  const before = await getBody();
  const body = { ...before, ...patch, updatedAt: new Date().toISOString() };
  if (patch.bodyFat === null) delete body.bodyFat;
  await setKV(KEY, body);
  // A changed weight is a new reading. A weigh-in (Trends' "Add today's weight") is one even when it
  // matches the last, so a steady weight still counts towards the trend.
  if (patch.weightKg !== undefined && (patch.weightKg !== before.weightKg || input?.weighIn === true)) await logEvent('weight', { kg: patch.weightKg });
  return bodyView();
}

// One line for the coach's snapshot, and one on his real burn when there is anything to say.
export async function bodyForCoach() {
  const { today, tz } = await localNow();
  const body = await getBody();
  const { needs, burn } = await needsFor(body, today, tz, true);
  const real = burn && (burn.counts.good || burn.counts.weighIns) ? `\n${(await energy()).burnForCoach(burn, needs)}` : '';
  if (!needs) return `Body profile: not set, so food percentages are against the EU reference intakes.${real}`;
  const r = needs.refs;
  return `Body profile: ${needs.about.sex}, ${needs.about.age}, ${body.heightCm} cm, ${body.weightKg} kg${body.bodyFat ? `, ${body.bodyFat}% body fat` : ''}, ${ACTIVITY[body.activity].label.toLowerCase()}, goal: ${GOALS[needs.about.goal].label.toLowerCase()}. `
    + `His daily needs (food percentages use these): ${r.kcal} kcal, protein ${r.protein} g, carbs ${r.carbs} g, fat ${r.fat} g, fibre ${r.fibre} g, salt under ${r.salt} g, sugars under ${r.sugars} g, water from drinks about ${r.water} ml. `
    + `Energy: ${energyText(needs)}${real}`;
}

export const bodyApi = new Hono();
bodyApi.get('/body', async (c) => c.json(await bodyView()));
bodyApi.put('/body', async (c) => c.json(await saveBody(await c.req.json().catch(() => ({})))));
