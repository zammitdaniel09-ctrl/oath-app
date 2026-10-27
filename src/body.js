// His body: sex, birth date, height, weight, body fat, how active he is and his goal. It turns every
// nutrition percentage into a share of what his own body needs (public/nutrition.js personalNeeds).
// Stored in kv, never in code: the repository is public.
import { Hono } from 'hono';
import { getKV, setKV, logEvent } from './db.js';
import { localNow, RuleError } from './engine.js';
import { validDate } from './time.js';
import { personalNeeds, ACTIVITY, GOALS } from '../public/nutrition.js';

const KEY = 'body';

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
  return out;
}

export const getBody = async () => (await getKV(KEY)) || {};

// What the screens and the coach need: the body as saved and the daily needs worked out from it.
export async function bodyNeeds() {
  const { today } = await localNow();
  const body = await getBody();
  return { body, needs: personalNeeds(body, today) };
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
  if (patch.weightKg !== undefined && patch.weightKg !== before.weightKg) await logEvent('weight', { kg: patch.weightKg });
  return bodyNeeds();
}

// One line for the coach's snapshot.
export async function bodyForCoach() {
  const { body, needs } = await bodyNeeds();
  if (!needs) return 'Body profile: not set, so food percentages are against the EU reference intakes.';
  const r = needs.refs;
  return `Body profile: ${needs.about.sex}, ${needs.about.age}, ${body.heightCm} cm, ${body.weightKg} kg${body.bodyFat ? `, ${body.bodyFat}% body fat` : ''}, ${ACTIVITY[body.activity].label.toLowerCase()}, goal: ${GOALS[needs.about.goal].label.toLowerCase()}. `
    + `His daily needs (food percentages use these): ${r.kcal} kcal, protein ${r.protein} g, carbs ${r.carbs} g, fat ${r.fat} g, fibre ${r.fibre} g, salt under ${r.salt} g, sugars under ${r.sugars} g.`;
}

export const bodyApi = new Hono();
bodyApi.get('/body', async (c) => c.json(await bodyNeeds()));
bodyApi.put('/body', async (c) => c.json(await saveBody(await c.req.json().catch(() => ({})))));
