// Apple Health: data in from Health Auto Export or a free Apple Shortcut, day summaries for the
// app and the coach, and habits that tick themselves off when the data shows they were done.
//
// One endpoint takes two formats and tells them apart on its own:
// - Health Auto Export (iOS app by HealthyApps), REST API automation, JSON, export version 1 or 2:
//   { data: { metrics: [{ name, units, data: [{ date, qty, source }] }], workouts: [...] } }.
//   Docs: https://help.healthyapps.dev/en/health-auto-export/export-format
// - A flat body a Shortcut can build with "Get Contents of URL":
//   { date, steps, active_kcal, exercise_min, sleep_hours, ..., workouts: [...] } or { days: [...] }.
//
// Everything is upserted on (metric, at, source), so an hourly sync that re-sends a day replaces it
// instead of adding to it. A day's value is worked out per feed and then combined: totals take the
// largest feed (two feeds of the same truth must not double count), averages are averaged and
// point-in-time values (weight) take the newest. Sources that Health Auto Export joins with "|"
// ("iPhone|Apple Watch" in summarised data) are one feed, so hourly buckets of one feed add up.
//
// Fairness: a miss can only be overturned by data that proves the habit was done before its
// deadline. Workouts must have started before it; for totals, hourly samples count up to the
// deadline and a whole-day number counts only if it was reported before the deadline.
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { db, getKV, setKV, logEvent } from './db.js';
import { nowUTC, addDays, deadlineAt, validDate } from './time.js';
import {
  localNow, getGame, withGame, completeHabit, RuleError,
  rulesOn, isScheduled, isFlexible, isActive, weekStartOf,
} from './engine.js';
import { restSet } from './strength.js';
import { sendPush } from './push.js';

const ts = () => nowUTC().toJSDate();

// ---------- Schema ----------

export const HEALTH_SCHEMA = `
create table if not exists health_samples (
  metric text not null,
  at timestamptz not null,
  source text not null default '',
  date text not null,
  value double precision not null,
  unit text not null default '',
  extra jsonb,
  received_at timestamptz not null,
  primary key (metric, at, source)
);
create index if not exists health_samples_metric_at_idx on health_samples (metric, at);
create index if not exists health_samples_date_idx on health_samples (date, metric);
create table if not exists health_workouts (
  id text primary key,
  type text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  duration_min double precision,
  kcal double precision,
  distance_km double precision,
  avg_hr double precision,
  max_hr double precision,
  source text not null default '',
  extra jsonb,
  received_at timestamptz not null
);
create index if not exists health_workouts_start_idx on health_workouts (start_at);
alter table habits add column if not exists auto_metric text;
alter table habits add column if not exists auto_target double precision;
alter table habits add column if not exists auto_filter text not null default '';
alter table completions add column if not exists source text not null default 'you';
alter table misses add column if not exists overturned boolean not null default false;
`;

export async function migrateHealth() {
  await db().unsafe(HEALTH_SCHEMA);
}

// ---------- Metrics ----------

// key -> label, stored unit, how a day is combined, decimals shown, and the largest believable day value.
const DEF = {};
const def = (key, label, unit, agg, dec, max) => { DEF[key] = { key, label, unit, agg, dec, max }; };
def('steps', 'Steps', 'count', 'sum', 0, 200000);
def('active_kcal', 'Active energy', 'kcal', 'sum', 0, 15000);
def('basal_kcal', 'Resting energy', 'kcal', 'sum', 0, 10000);
def('exercise_min', 'Exercise', 'min', 'sum', 0, 1440);
def('stand_min', 'Stand time', 'min', 'sum', 0, 1440);
def('stand_hours', 'Stand hours', 'count', 'sum', 0, 24);
def('distance_km', 'Walking and running distance', 'km', 'sum', 2, 300);
def('cycling_km', 'Cycling distance', 'km', 'sum', 2, 1000);
def('flights', 'Flights climbed', 'count', 'sum', 0, 1000);
def('mindful_min', 'Mindful minutes', 'min', 'sum', 0, 1440);
def('water_ml', 'Water', 'mL', 'sum', 0, 20000);
def('kcal_in', 'Energy eaten', 'kcal', 'sum', 0, 20000);
def('protein_g', 'Protein', 'g', 'sum', 0, 1000);
def('carbs_g', 'Carbohydrates', 'g', 'sum', 0, 2000);
def('fat_g', 'Fat', 'g', 'sum', 0, 1000);
def('caffeine_mg', 'Caffeine', 'mg', 'sum', 0, 5000);
def('daylight_min', 'Time in daylight', 'min', 'sum', 0, 1440);
def('resting_hr', 'Resting heart rate', 'bpm', 'avg', 0, 250);
def('hrv_ms', 'Heart rate variability', 'ms', 'avg', 0, 500);
def('heart_rate', 'Heart rate', 'bpm', 'avg', 0, 250);
def('walking_hr', 'Walking heart rate', 'bpm', 'avg', 0, 250);
def('respiratory_rate', 'Respiratory rate', 'breaths/min', 'avg', 1, 80);
def('spo2', 'Blood oxygen', '%', 'avg', 0, 100);
def('wrist_temp', 'Wrist temperature', 'degC', 'avg', 2, 45);
def('weight_kg', 'Weight', 'kg', 'latest', 1, 400);
def('body_fat_pct', 'Body fat', '%', 'latest', 1, 100);
def('bmi', 'BMI', '', 'latest', 1, 100);
def('lean_mass_kg', 'Lean body mass', 'kg', 'latest', 1, 300);
def('vo2max', 'VO2 max', 'mL/kg/min', 'latest', 1, 100);
def('sleep_hours', 'Sleep', 'hr', 'sleep', 1, 24);

// Health Auto Export metric names (and a few spellings seen in the wild) -> canonical keys.
const HAE = {
  step_count: 'steps',
  active_energy: 'active_kcal', active_energy_burned: 'active_kcal',
  basal_energy_burned: 'basal_kcal', resting_energy: 'basal_kcal', basal_energy: 'basal_kcal',
  apple_exercise_time: 'exercise_min', exercise_time: 'exercise_min',
  apple_stand_time: 'stand_min',
  apple_stand_hour: 'stand_hours',
  walking_running_distance: 'distance_km', distance_walking_running: 'distance_km',
  cycling_distance: 'cycling_km', distance_cycling: 'cycling_km',
  flights_climbed: 'flights',
  mindful_minutes: 'mindful_min', mindful_session: 'mindful_min', mindfulness: 'mindful_min',
  dietary_water: 'water_ml',
  dietary_energy: 'kcal_in', dietary_energy_consumed: 'kcal_in',
  protein: 'protein_g', dietary_protein: 'protein_g',
  carbohydrates: 'carbs_g', dietary_carbohydrates: 'carbs_g',
  total_fat: 'fat_g', dietary_fat_total: 'fat_g', dietary_total_fat: 'fat_g',
  caffeine: 'caffeine_mg', dietary_caffeine: 'caffeine_mg',
  time_in_daylight: 'daylight_min',
  resting_heart_rate: 'resting_hr',
  heart_rate_variability: 'hrv_ms', heart_rate_variability_sdnn: 'hrv_ms',
  heart_rate: 'heart_rate',
  walking_heart_rate: 'walking_hr', walking_heart_rate_average: 'walking_hr',
  respiratory_rate: 'respiratory_rate',
  blood_oxygen_saturation: 'spo2', oxygen_saturation: 'spo2',
  apple_sleeping_wrist_temperature: 'wrist_temp', sleeping_wrist_temperature: 'wrist_temp',
  weight_body_mass: 'weight_kg', body_mass: 'weight_kg',
  body_fat_percentage: 'body_fat_pct',
  body_mass_index: 'bmi',
  lean_body_mass: 'lean_mass_kg',
  vo2_max: 'vo2max',
};
for (const k of Object.keys(DEF)) HAE[k] = k;

// Field names a Shortcut may send in the flat format.
const FLAT = {
  ...Object.fromEntries(Object.keys(DEF).map((k) => [k, k])),
  ...HAE,
  active_energy: 'active_kcal', active_calories: 'active_kcal', move: 'active_kcal',
  exercise: 'exercise_min', exercise_minutes: 'exercise_min',
  stand: 'stand_hours', stand_hour: 'stand_hours',
  sleep: 'sleep_hours', sleep_hrs: 'sleep_hours',
  distance: 'distance_km', walking_distance: 'distance_km',
  hrv: 'hrv_ms', weight: 'weight_kg', water: 'water_ml', calories_eaten: 'kcal_in',
};
const FLAT_STAGES = {
  deep_hours: 'deep', sleep_deep: 'deep', rem_hours: 'rem', sleep_rem: 'rem', core_hours: 'core', sleep_core: 'core',
  awake_hours: 'awake', sleep_awake: 'awake', in_bed_hours: 'in_bed', time_in_bed: 'in_bed', in_bed: 'in_bed',
};
const INTEGER = new Set(['steps', 'flights', 'stand_hours']);
const SLEEP_STAGES = ['core', 'deep', 'rem', 'asleep', 'awake', 'in_bed'];
const isSleepKey = (m) => m === 'sleep_hours' || (m.startsWith('sleep_') && SLEEP_STAGES.includes(m.slice(6)));

const snake = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
const normUnit = (u) => String(u ?? '').trim().toLowerCase().replace(/\s+/g, '_');

// Unknown metrics: rates and levels are averaged, everything else is a daily total.
function inferAgg(unit, key) {
  const u = normUnit(unit);
  if (u.includes('/') || u.includes('%')) return 'avg';
  if (/^(ms|bpm|degc|degf|mmhg|db|dbaspl|dbhl|w|spm|rpm|met|kph|kmph|mph|lux|iu|mg\/dl|mmol\/l)$/.test(u)) return 'avg';
  if (/(speed|length|height|circumference|pressure|temperature|index|percentage|rate|level|glucose|power|oscillation|asymmetry|support|depth|cadence|audio|exposure|perfusion|burden|vo2)/.test(key)) return 'avg';
  return 'sum';
}
const aggOf = (key, unit) => DEF[key]?.agg ?? inferAgg(unit, key);

// ---------- Units ----------

const CONVERT = {
  kcal: { kcal: 1, cal: 1, cals: 1, calorie: 1, calories: 1, kilocalories: 1, kj: 1 / 4.184, j: 1 / 4184 },
  min: { min: 1, mins: 1, minute: 1, minutes: 1, m: 1, s: 1 / 60, sec: 1 / 60, secs: 1 / 60, second: 1 / 60, seconds: 1 / 60, ms: 1 / 60000, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60 },
  hr: { h: 1, hr: 1, hrs: 1, hour: 1, hours: 1, min: 1 / 60, mins: 1 / 60, minute: 1 / 60, minutes: 1 / 60, m: 1 / 60, s: 1 / 3600, sec: 1 / 3600, seconds: 1 / 3600 },
  km: { km: 1, kms: 1, kilometre: 1, kilometres: 1, kilometer: 1, kilometers: 1, mi: 1.609344, mile: 1.609344, miles: 1.609344, m: 0.001, metre: 0.001, metres: 0.001, meter: 0.001, meters: 0.001, yd: 0.0009144, yds: 0.0009144, ft: 0.0003048, cm: 0.00001 },
  kg: { kg: 1, kgs: 1, lb: 0.45359237, lbs: 0.45359237, g: 0.001, st: 6.35029318, oz: 0.028349523125 },
  ml: { ml: 1, l: 1000, cl: 10, dl: 100, fl_oz: 29.5735295625, fl_oz_us: 29.5735295625, floz: 29.5735295625, oz: 29.5735295625, fl_oz_imp: 28.4130625, cup: 236.5882365, cup_us: 236.5882365 },
  g: { g: 1, mg: 0.001, kg: 1000, oz: 28.349523125, mcg: 0.000001 },
  mg: { mg: 1, g: 1000, mcg: 0.001, ug: 0.001, 'µg': 0.001 },
};

function convert(v, from, target) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const t = normUnit(target);
  const f = normUnit(from);
  let out = v;
  if (t === 'degc' && /^(degf|f|°f)$/.test(f)) out = ((v - 32) * 5) / 9;
  else if (f && f !== t && CONVERT[t] && CONVERT[t][f] !== undefined) out = v * CONVERT[t][f];
  if (t === '%' && out > 0 && out <= 1) out *= 100; // HealthKit percentages arrive as fractions
  return out;
}

const num = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return null;
};
const firstNum = (...xs) => xs.find((x) => typeof x === 'number' && Number.isFinite(x)) ?? null;
const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);

// A number with a thousands separator or a decimal comma, as Shortcuts may send it.
function normNumber(tok, { integer = false, max = Infinity } = {}) {
  let t = tok.replace(/[\s  '’]/g, '');
  let sign = 1;
  if (t.startsWith('-')) { sign = -1; t = t.slice(1); } else if (t.startsWith('+')) t = t.slice(1);
  t = t.replace(/[.,]+$/, '');
  const commas = (t.match(/,/g) || []).length;
  const dots = (t.match(/\./g) || []).length;
  if (commas && dots) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (commas > 1) {
    t = t.replace(/,/g, '');
  } else if (dots > 1) {
    t = t.replace(/\./g, '');
  } else if (commas === 1 || dots === 1) {
    const sep = commas ? ',' : '.';
    const [a, b] = t.split(sep);
    const grouped = /^[1-9]\d{0,2}$/.test(a) && /^\d{3}$/.test(b);
    // "8,123" steps is eight thousand; "7,2" hours and "1,500" km are decimals; "8.123" steps is eight thousand.
    const thousands = grouped && (integer || (sep === ',' && Number(a + b) <= max));
    t = thousands ? a + b : `${a}.${b}`;
  }
  if (!/^\d*\.?\d+$/.test(t)) return null;
  return sign * Number(t);
}

function combineList(values, agg) {
  const v = values.filter((x) => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  if (agg === 'avg') return sumOf(v) / v.length;
  if (agg === 'latest') return v[v.length - 1];
  return sumOf(v);
}

// Lenient parsing for values typed or produced by Shortcuts: 8123, "8,123", "8123 steps", "7.2 hr",
// "7,2", "7 hr 12 min", "450 kcal", "3.1 mi", a list of numbers, or { qty, units }.
function parseLoose(raw, meta = {}) {
  const { unit = '', agg = 'sum', max = Infinity } = meta;
  let out = null;
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') out = Number.isFinite(raw) ? raw : null;
  else if (Array.isArray(raw)) out = combineList(raw.map((x) => parseLoose(x, meta)), agg);
  else if (typeof raw === 'object') {
    if ('qty' in raw) out = convert(parseLoose(raw.qty, { ...meta, unit: '', max: Infinity }), raw.units ?? raw.unit, unit);
    else if ('value' in raw) out = parseLoose(raw.value, meta);
  } else {
    const s = String(raw).trim();
    // "Find Health Samples" without "Calculate Statistics" gives one number per line: add them up.
    const parts = s.split(/[\n\r;]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) {
      out = combineList(parts.map((x) => parseLoose(x, meta)), agg);
    } else {
      const hm = /^(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hours?)\.?\s*(?:and\s+)?(\d+(?:[.,]\d+)?)\s*(?:m|min|mins|minutes?)\.?$/i.exec(s);
      if (hm) {
        out = convert(Number(hm[1].replace(',', '.')) + Number(hm[2].replace(',', '.')) / 60, 'hr', unit);
      } else {
        const m = /[-+]?\d[\d.,'’\s  ]*/.exec(s);
        if (m) {
          const n = normNumber(m[0].trim(), meta);
          const u = s.slice(m.index + m[0].length).trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, '_');
          out = n === null ? null : convert(n, u, unit);
        }
      }
    }
  }
  if (out === null || !Number.isFinite(out) || out > max) return null;
  return out;
}

// ---------- Time ----------

const WHEN_FORMATS = [
  'yyyy-MM-dd HH:mm:ss ZZZ', 'yyyy-MM-dd HH:mm:ss ZZ', 'yyyy-MM-dd HH:mm ZZZ', 'yyyy-MM-dd h:mm:ss a ZZZ',
  'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm',
];
const LOCAL_FORMATS = [
  'd MMM yyyy HH:mm', 'd MMMM yyyy HH:mm', 'MMM d, yyyy h:mm a', 'MMMM d, yyyy h:mm a', 'd/M/yyyy HH:mm',
  'd MMM yyyy', 'd MMMM yyyy', 'MMM d, yyyy', 'MMMM d, yyyy', 'd/M/yyyy', 'd.M.yyyy', 'yyyy/MM/dd',
];

// Health Auto Export dates look like "2026-10-08 07:05:00 +0200". Shortcuts may send ISO or a
// localised "8 Oct 2026 at 07:05". Strings with no offset are read in the app's time zone.
function parseWhen(v, tz) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : DateTime.fromJSDate(v).setZone(tz);
  if (typeof v === 'number') return DateTime.fromMillis(v > 1e12 ? v : v * 1000).setZone(tz);
  const s = String(v).trim();
  for (const f of WHEN_FORMATS) {
    const d = DateTime.fromFormat(s, f, { setZone: true, zone: tz, locale: 'en-US' });
    if (d.isValid) return d;
  }
  const iso = DateTime.fromISO(s, { setZone: true, zone: tz });
  if (iso.isValid) return iso;
  const plain = s.replace(/\s+at\s+/i, ' ');
  for (const f of LOCAL_FORMATS) {
    const d = DateTime.fromFormat(plain, f, { zone: tz, locale: 'en-GB' });
    if (d.isValid) return d;
  }
  return null;
}

const isMidnight = (d) => d.hour === 0 && d.minute === 0 && d.second === 0 && d.millisecond === 0;
// A day bucket ("... 00:00:00 +0400") belongs to its own calendar date, even when the phone was in
// another time zone. Anything else is placed in the app's time zone.
const dayOf = (d, tz) => (isMidnight(d) ? d.toISODate() : d.setZone(tz).toISODate());
// Sleep belongs to the day you wake up: anything ending after 18:00 counts toward the next day.
function sleepDate(d, tz) {
  const l = d.setZone(tz);
  return (l.hour >= 18 ? l.plus({ days: 1 }) : l).toISODate();
}
const midnight = (date, tz) => DateTime.fromISO(date, { zone: tz });

// ---------- Formatting ----------

const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const fmtInt = (v) => nf0.format(Math.round(v));
const fmtDec = (v, d = 1) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: d }).format(v);
const fmtDay = (date) => DateTime.fromISO(date).setLocale('en-GB').toFormat('ccc d LLL');
const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${Math.round(n) === 1 ? one : many}`;
const capitalise = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const roundTo = (v, dec) => (v === null || v === undefined ? null : Math.round(v * 10 ** dec) / 10 ** dec);
const roundKey = (key, v) => roundTo(v, DEF[key]?.dec ?? 2);
function listNames(names) {
  const u = [...new Set(names)];
  if (u.length <= 1) return u.join('');
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}
const humanize = (key) => capitalise(key.replace(/_/g, ' '));

const METRIC_TEXT = {
  steps: (v) => plural(v, 'step'),
  exercise_min: (v) => plural(v, 'exercise minute'),
  active_kcal: (v) => `${fmtInt(v)} active kcal`,
  stand_hours: (v) => plural(v, 'stand hour'),
  sleep_hours: (v) => `${fmtDec(v, 1)} hours of sleep`,
  distance_km: (v) => `${fmtDec(v, 1)} km walked or run`,
  mindful_min: (v) => plural(v, 'mindful minute'),
  flights: (v) => plural(v, 'flight climbed', 'flights climbed'),
  water_ml: (v) => `${fmtInt(v)} mL of water`,
};
const metricText = (metric, v) => (METRIC_TEXT[metric] ? METRIC_TEXT[metric](v) : `${fmtDec(v, 1)} ${metric}`);

// ---------- Parsing Health Auto Export ----------

const cleanSource = (s) => String(s ?? '').trim().slice(0, 200);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

function pushSample(out, metric, when, source, value, unit, extra, tz) {
  const day = isMidnight(when);
  out.samples.push({
    metric, at: when.toJSDate(), source: cleanSource(source), date: dayOf(when, tz), value, unit: String(unit ?? ''),
    extra: day ? { ...(extra || {}), day: true } : extra || null,
  });
}

function sleepStage(v) {
  const s = String(v || '').toLowerCase().replace(/^asleep\s*/, '').trim();
  if (s === 'core') return 'core';
  if (s === 'deep') return 'deep';
  if (s === 'rem') return 'rem';
  if (s === 'awake') return 'awake';
  if (s === 'in bed' || s === 'inbed' || s === 'in_bed') return 'in_bed';
  if (s === '' || s === 'unspecified' || String(v).toLowerCase() === 'asleep') return 'asleep';
  return null;
}

function haeSleep(p, units, tz, out) {
  if (!p || typeof p !== 'object') return;
  const hrs = (x) => (num(x) === null ? null : convert(num(x), units || 'hr', 'hr'));
  const stage = typeof p.value === 'string' ? sleepStage(p.value) : null;
  if (stage && (p.startDate || p.endDate || p.start || p.end)) {
    // One segment of a night (Summarize Data off).
    const start = parseWhen(p.startDate ?? p.start ?? p.date, tz);
    const end = parseWhen(p.endDate ?? p.end, tz);
    if (!start) return;
    const hours = hrs(p.qty) ?? (end ? (end.toMillis() - start.toMillis()) / 3600000 : null);
    if (hours === null || hours < 0 || hours > 24) return;
    out.samples.push({
      metric: `sleep_${stage}`, at: start.toJSDate(), source: cleanSource(p.source), date: sleepDate(end || start, tz),
      value: hours, unit: 'hr', extra: end ? { end: end.toUTC().toISO() } : null,
    });
    return;
  }
  // One night, already summed (Summarize Data on).
  const core = hrs(p.core);
  const deep = hrs(p.deep);
  const rem = hrs(p.rem);
  const asleep = hrs(p.asleep);
  const awake = hrs(p.awake);
  const inBed = hrs(p.inBed ?? p.in_bed);
  const total = hrs(p.totalSleep) ?? (asleep || 0) + (core || 0) + (deep || 0) + (rem || 0);
  const hours = total > 0 ? total : inBed || 0;
  if (!(hours > 0) || hours > 24) return;
  const start = parseWhen(p.sleepStart ?? p.inBedStart ?? p.startDate, tz);
  const end = parseWhen(p.sleepEnd ?? p.inBedEnd ?? p.endDate, tz);
  let date;
  if (end) date = sleepDate(end, tz);
  else {
    const d = parseWhen(p.date, tz);
    if (!d) return;
    date = isMidnight(d) ? d.toISODate() : sleepDate(d, tz);
  }
  out.samples.push({
    metric: 'sleep_hours', at: midnight(date, tz).toJSDate(), source: cleanSource(p.source), date, value: hours, unit: 'hr',
    extra: {
      deep, rem, core, awake, in_bed: inBed, asleep, in_bed_only: !(total > 0),
      start: start ? start.toUTC().toISO() : null, end: end ? end.toUTC().toISO() : null,
    },
  });
}

function parseHaeMetrics(metrics, tz, out) {
  for (const m of Array.isArray(metrics) ? metrics : []) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.data)) continue;
    const raw = snake(m.name);
    if (!raw) continue;
    const units = m.units ?? m.unit ?? '';
    if (raw === 'sleep_analysis') {
      for (const p of m.data) haeSleep(p, units, tz, out);
      continue;
    }
    if (raw === 'blood_pressure') {
      for (const p of m.data) {
        const when = p && parseWhen(p.date, tz);
        if (!when) continue;
        if (num(p.systolic) !== null) pushSample(out, 'bp_systolic', when, p.source, num(p.systolic), 'mmHg', null, tz);
        if (num(p.diastolic) !== null) pushSample(out, 'bp_diastolic', when, p.source, num(p.diastolic), 'mmHg', null, tz);
      }
      continue;
    }
    const key = HAE[raw] || raw;
    const d = DEF[key];
    for (const p of m.data) {
      if (!p || typeof p !== 'object') continue;
      const when = parseWhen(p.date ?? p.startDate ?? p.start, tz);
      if (!when) continue;
      let qty;
      let extra = null;
      if (p.Avg !== undefined || p.avg !== undefined) {
        qty = num(p.Avg ?? p.avg);
        const lo = num(p.Min ?? p.min);
        const hi = num(p.Max ?? p.max);
        if (lo !== null || hi !== null) extra = { min: lo, max: hi };
      } else {
        qty = num(p.qty);
        if (qty === null && typeof p.value !== 'string') qty = num(p.value);
        if (qty === null) {
          // Shapes like sexual_activity carry counts in named fields.
          const counts = Object.entries(p).filter(([k, v]) => k !== 'date' && typeof v === 'number').map(([, v]) => v);
          qty = counts.length ? sumOf(counts) : null;
        }
      }
      if (qty === null) continue;
      const value = d ? convert(qty, p.units ?? units, d.unit) : qty;
      if (value === null || (d && value < 0 && key !== 'wrist_temp')) continue;
      pushSample(out, key, when, p.source, value, d ? d.unit : units, extra, tz);
    }
  }
}

// ---------- Workouts ----------

function energy(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return x;
  if (Array.isArray(x)) {
    const v = x.map((p) => (p && typeof p === 'object' ? convert(num(p.qty), p.units, 'kcal') : num(p))).filter((n) => n !== null);
    return v.length ? sumOf(v) : null;
  }
  if (typeof x === 'object' && 'qty' in x) return convert(num(x.qty), x.units, 'kcal');
  return null;
}

function qtyTo(x, unit) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return x;
  if (typeof x === 'object' && 'qty' in x) return convert(num(x.qty), x.units, unit);
  return null;
}

function hrStat(arr, which) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const v = arr.map((p) => num(which === 'max' ? p?.Max ?? p?.max ?? p?.qty : p?.Avg ?? p?.avg ?? p?.qty)).filter((n) => n !== null);
  if (!v.length) return null;
  return which === 'max' ? Math.max(...v) : sumOf(v) / v.length;
}

// Version 2 sends duration in seconds. Older exports varied, so check it against start and end.
function durationMinutes(d, start, end) {
  if (d && typeof d === 'object') return convert(num(d.qty), d.units || 's', 'min');
  const n = num(d);
  if (n === null) return null;
  const span = start && end ? (end.toMillis() - start.toMillis()) / 60000 : null;
  if (span === null || span <= 0) return n / 60;
  const near = (a) => Math.abs(a - span) <= Math.max(2, span * 0.1);
  if (near(n / 60)) return n / 60;
  if (near(n)) return n;
  if (n / 60 <= span + 1) return n / 60; // paused workouts are shorter than their span
  return span;
}

function parseWorkout(w, feed, ctx) {
  if (!w || typeof w !== 'object') return null;
  const { tz, today, date } = ctx;
  const type = String(w.type ?? w.name ?? w.workoutActivityType ?? 'Workout').trim().slice(0, 80) || 'Workout';
  let start = parseWhen(w.start ?? w.startDate ?? w.start_at, tz);
  let end = parseWhen(w.end ?? w.endDate ?? w.end_at, tz);
  let minutes = null;
  if (w.duration_min !== undefined) minutes = parseLoose(w.duration_min, { unit: 'min', max: 1440 });
  else if (w.duration !== undefined) minutes = durationMinutes(w.duration, start, end);
  let noTime = false;
  if (!start && end && minutes) start = end.minus({ minutes });
  if (!start) {
    if (feed !== 'shortcut') return null;
    // No time given: today means "just now", an earlier day has no proven time of day.
    const day = w.date ? (parseWhen(w.date, tz)?.toISODate() ?? date) : date;
    start = day === today ? nowUTC().setZone(tz).minus({ minutes: minutes || 0 }) : midnight(day, tz);
    noTime = true;
  }
  if (!end && minutes) end = start.plus({ minutes });
  if (minutes === null && end) minutes = (end.toMillis() - start.toMillis()) / 60000;
  if (minutes !== null && (minutes < 0 || minutes > 1440)) minutes = null;
  const KCAL = { unit: 'kcal', max: 10000 };
  const HR = { unit: 'bpm', max: 250 };
  const kcal = firstNum(
    parseLoose(w.kcal, KCAL), parseLoose(w.active_kcal, KCAL),
    energy(w.activeEnergyBurned), energy(w.activeEnergy), energy(w.totalEnergy),
  );
  const distance = firstNum(parseLoose(w.distance_km, { unit: 'km', max: 1000 }), qtyTo(w.distance, 'km'));
  const avgHr = firstNum(parseLoose(w.avg_hr, HR), qtyTo(w.heartRate?.avg, 'bpm'), qtyTo(w.avgHeartRate, 'bpm'), hrStat(w.heartRateData, 'avg'));
  const maxHr = firstNum(parseLoose(w.max_hr, HR), qtyTo(w.heartRate?.max, 'bpm'), qtyTo(w.maxHeartRate, 'bpm'), hrStat(w.heartRateData, 'max'));
  const extra = {};
  if (w.location) extra.location = String(w.location).slice(0, 40);
  if (typeof w.isIndoor === 'boolean') extra.indoor = w.isIndoor;
  const met = qtyTo(w.intensity, 'MET');
  if (met !== null) extra.intensity_met = roundTo(met, 1);
  const total = energy(w.totalEnergy);
  if (total !== null) extra.total_kcal = Math.round(total);
  if (noTime) extra.noTime = true;
  const id = w.id
    ? String(w.id).slice(0, 120)
    : `${feed === 'shortcut' ? 'sc' : 'hae'}_${hash(`${type.toLowerCase()}|${start.toUTC().startOf('minute').toISO()}`)}`;
  return {
    id, type, start_at: start.toJSDate(), end_at: end ? end.toJSDate() : null,
    duration_min: minutes === null ? null : roundTo(minutes, 2), kcal: kcal === null ? null : roundTo(kcal, 1),
    distance_km: distance === null ? null : roundTo(distance, 3), avg_hr: avgHr === null ? null : roundTo(avgHr, 1),
    max_hr: maxHr === null ? null : roundTo(maxHr, 1),
    source: feed === 'shortcut' ? 'shortcut' : cleanSource(w.source ?? w.sourceName ?? ''),
    extra: Object.keys(extra).length ? extra : null,
    date: start.setZone(tz).toISODate(),
  };
}

const minutesOf = (w) => Number(w.duration_min ?? (w.end_at ? (new Date(w.end_at) - new Date(w.start_at)) / 60000 : 0)) || 0;

// The same session sent by two feeds (or logged by two apps) counts once.
function dedupeWorkouts(list) {
  const span = (w) => {
    const s = new Date(w.start_at).getTime();
    return [s, w.end_at ? new Date(w.end_at).getTime() : s + minutesOf(w) * 60000];
  };
  const kept = [];
  for (const w of [...list].sort((a, b) => new Date(a.start_at) - new Date(b.start_at))) {
    const [s, e] = span(w);
    const i = kept.findIndex((k) => {
      const [ks, ke] = span(k);
      const sameKind = k.type.toLowerCase() === w.type.toLowerCase() || k.source === 'shortcut' || w.source === 'shortcut';
      if (!sameKind) return false;
      const overlap = Math.min(e, ke) - Math.max(s, ks);
      const shorter = Math.min(e - s, ke - ks);
      return shorter > 0 ? overlap >= shorter * 0.5 : Math.abs(s - ks) < 5 * 60000;
    });
    if (i === -1) kept.push(w);
    else if (kept[i].source === 'shortcut' && w.source !== 'shortcut') kept[i] = w;
  }
  return kept;
}

// ---------- Parsing the flat Shortcut format ----------

const normKey = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');

function flatDate(v, today, tz) {
  if (v === undefined || v === null || v === '') return today;
  const s = String(v).trim();
  if (/^today$/i.test(s)) return today;
  if (/^yesterday$/i.test(s)) return addDays(today, -1, tz);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (validDate(s)) return s;
  } else {
    const d = parseWhen(s, tz);
    if (d) return dayOf(d, tz);
  }
  throw new RuleError('The date must look like 2026-10-08.');
}

// A summed duration from Shortcuts can arrive as a bare number of minutes or seconds
// (sleep_hours: 450 or 27000). Only used when the number is too big to be the stated unit.
function bareDuration(v, meta) {
  if (!(typeof v === 'number' || /^[\d\s.,]+$/.test(String(v).trim()))) return null;
  const n = parseLoose(v, { ...meta, max: Infinity });
  if (n === null) return null;
  if (meta.unit === 'hr') return [n / 60, n / 3600].find((x) => x <= meta.max) ?? null;
  if (meta.unit === 'min') return n / 60 <= meta.max ? n / 60 : null;
  return null;
}

function parseFlat(p, ctx, out) {
  const entries = [];
  if (Array.isArray(p.days)) entries.push(...p.days.filter((e) => e && typeof e === 'object'));
  const topHasData = Object.keys(p).some((k) => FLAT[normKey(k)]) || Array.isArray(p.workouts);
  if (topHasData || !Array.isArray(p.days)) entries.push(p);
  for (const e of entries) {
    const date = flatDate(e.date ?? e.day, ctx.today, ctx.tz);
    if (date > ctx.today) throw new RuleError('That date is in the future.');
    const at = midnight(date, ctx.tz).toJSDate();
    let sleep = null;
    for (const [k0, v] of Object.entries(e)) {
      const key = FLAT[normKey(k0)];
      if (!key || v === null || v === undefined || v === '') continue;
      const d = DEF[key];
      const meta = { unit: d.unit, integer: INTEGER.has(key), max: d.max, agg: d.agg };
      let value = parseLoose(v, meta);
      if (value === null) value = bareDuration(v, meta);
      if (value === null || (value < 0 && key !== 'wrist_temp')) continue;
      const sample = { metric: key, at, source: 'shortcut', date, value, unit: d.unit, extra: { day: true } };
      out.samples.push(sample);
      if (key === 'sleep_hours') sleep = sample;
    }
    if (sleep) {
      for (const [k0, v] of Object.entries(e)) {
        const stage = FLAT_STAGES[normKey(k0)];
        if (!stage) continue;
        const h = parseLoose(v, { unit: 'hr', max: 24 });
        if (h !== null && h >= 0) sleep.extra[stage] = h;
      }
    }
    for (const w of Array.isArray(e.workouts) ? e.workouts : []) {
      const pw = parseWorkout(w, 'shortcut', { ...ctx, date });
      if (pw) out.workouts.push(pw);
    }
  }
}

// ---------- Storage ----------

async function upsertSamples(samples, now) {
  const sql = db();
  const byKey = new Map();
  for (const x of samples) byKey.set(`${x.metric}\u0000${x.at.getTime()}\u0000${x.source}`, x);
  const rows = [...byKey.values()].map((x) => ({
    metric: x.metric, at: x.at, source: x.source, date: x.date, value: x.value, unit: x.unit,
    extra: x.extra ? sql.json(x.extra) : null, received_at: now,
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    // received_at only moves when the value changes, so "reported before the deadline" stays provable.
    await sql`insert into health_samples ${sql(chunk, 'metric', 'at', 'source', 'date', 'value', 'unit', 'extra', 'received_at')}
              on conflict (metric, at, source) do update set
                date = excluded.date, unit = excluded.unit, extra = excluded.extra, value = excluded.value,
                received_at = case when health_samples.value is distinct from excluded.value
                                   then excluded.received_at else health_samples.received_at end`;
  }
  return rows.length;
}

async function upsertWorkouts(workouts, now) {
  const sql = db();
  const byId = new Map();
  for (const w of workouts) byId.set(w.id, w);
  const rows = [...byId.values()].map((w) => ({
    id: w.id, type: w.type, start_at: w.start_at, end_at: w.end_at, duration_min: w.duration_min, kcal: w.kcal,
    distance_km: w.distance_km, avg_hr: w.avg_hr, max_hr: w.max_hr, source: w.source,
    extra: w.extra ? sql.json(w.extra) : null, received_at: now,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await sql`insert into health_workouts ${sql(chunk, 'id', 'type', 'start_at', 'end_at', 'duration_min', 'kcal', 'distance_km', 'avg_hr', 'max_hr', 'source', 'extra', 'received_at')}
              on conflict (id) do update set
                type = excluded.type, start_at = excluded.start_at, end_at = excluded.end_at,
                duration_min = excluded.duration_min, kcal = excluded.kcal, distance_km = excluded.distance_km,
                avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, source = excluded.source, extra = excluded.extra,
                received_at = excluded.received_at`;
  }
  return rows.length;
}

// ---------- Ingest ----------

const MAX_SAMPLES = 1500000;

export async function ingestHealth(payload) {
  let p = payload;
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p);
    } catch {
      throw new RuleError('Send JSON.');
    }
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new RuleError('Send a JSON object.');
  const { today, tz } = await localNow();
  const now = ts();
  const data = p.data && typeof p.data === 'object' && !Array.isArray(p.data) ? p.data : null;
  const hae = Boolean((data && (Array.isArray(data.metrics) || Array.isArray(data.workouts))) || Array.isArray(p.metrics));
  const out = { samples: [], workouts: [] };
  if (hae) {
    const d = data || p;
    parseHaeMetrics(d.metrics, tz, out);
    for (const w of Array.isArray(d.workouts) ? d.workouts : []) {
      const pw = parseWorkout(w, 'hae', { tz, today, date: today });
      if (pw) out.workouts.push(pw);
    }
  } else {
    parseFlat(p, { tz, today }, out);
    if (!out.samples.length && !out.workouts.length) {
      throw new RuleError('No health values found. Send fields like steps, exercise_min or sleep_hours.');
    }
  }
  if (out.samples.length > MAX_SAMPLES) {
    throw new RuleError('That is too much data at once. Turn on Batch Requests in Health Auto Export, or pick a shorter date range.', 413);
  }
  const samples = await upsertSamples(out.samples, now);
  const workouts = await upsertWorkouts(out.workouts, now);
  const dates = [...new Set([...out.samples.map((x) => x.date), ...out.workouts.map((w) => w.date)])].sort();
  await setKV('health_last_sync', { at: now.toISOString(), samples, workouts, format: hae ? 'health-auto-export' : 'shortcut' });
  const applied = await applyHealth(dates);
  return {
    ok: true,
    format: hae ? 'health-auto-export' : 'shortcut',
    samples,
    workouts,
    dates,
    autoKept: applied.kept,
    overturned: applied.overturned,
    notes: applied.notes,
    say: sayFor(dates, applied, hae),
  };
}

function sayFor(dates, applied, hae) {
  const parts = [];
  if (dates.length) parts.push(`Synced ${dates.length} ${dates.length === 1 ? 'day' : 'days'}.`);
  else parts.push(hae ? 'Nothing new from Apple Health.' : 'Nothing new to sync.');
  const kept = applied.kept.filter((k) => !k.overturned);
  if (kept.length) parts.push(`${listNames(kept.map((k) => k.name))} ticked off from Apple Health.`);
  const o = applied.overturned;
  if (o.length) {
    const hp = sumOf(o.map((x) => x.hpBack));
    parts.push(`Apple Health overturned ${o.length === 1 ? `the miss on ${o[0].name}` : `${o.length} misses`}${hp ? `: +${hp} HP` : ''}.`);
  }
  return parts.join(' ');
}

// ---------- Reading days back ----------

// One row per (metric, date, source), summed, averaged and latest, for combining across feeds.
async function aggRows(from, to, metrics = null) {
  const sql = db();
  if (metrics && !metrics.length) return [];
  return sql`
    select metric, date, source, max(unit) as unit, sum(value) as sum, avg(value) as avg, count(*)::int as n,
           (array_agg(value order by at desc))[1] as latest, max(at) as latest_at,
           (array_agg(extra order by at desc))[1] as extra
    from health_samples
    where date >= ${from} and date <= ${to} ${metrics ? sql`and metric in ${sql(metrics)}` : sql``}
    group by metric, date, source`;
}

// The same shape from raw rows, for when some rows have to be left out first.
function aggregateRaw(rows) {
  const g = new Map();
  for (const r of rows) {
    const k = `${r.metric}\u0000${r.date}\u0000${r.source}`;
    let a = g.get(k);
    if (!a) {
      a = { metric: r.metric, date: r.date, source: r.source, unit: r.unit, sum: 0, n: 0, latest: null, latest_at: null, extra: null };
      g.set(k, a);
    }
    a.sum += r.value;
    a.n += 1;
    if (!a.latest_at || r.at > a.latest_at) {
      a.latest = r.value;
      a.latest_at = r.at;
      a.extra = r.extra;
    }
  }
  for (const a of g.values()) a.avg = a.sum / a.n;
  return [...g.values()];
}

// Group feeds: sources that appear joined with "|" belong to one feed.
function feeds(rows) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  const toks = rows.map((r) => String(r.source ?? '').split('|').map((t) => t.trim()));
  for (const t of toks) {
    for (const x of t) if (!parent.has(x)) parent.set(x, x);
    for (const x of t.slice(1)) {
      const a = find(t[0]);
      const b = find(x);
      if (a !== b) parent.set(a, b);
    }
  }
  const groups = new Map();
  rows.forEach((r, i) => {
    const k = find(toks[i][0]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  return [...groups.values()];
}

function combine(key, rows) {
  if (!rows.length) return null;
  const agg = aggOf(key, rows[0].unit);
  const groups = feeds(rows).map((g) => ({
    sum: sumOf(g.map((r) => Number(r.sum))),
    n: sumOf(g.map((r) => Number(r.n))),
    weighted: sumOf(g.map((r) => Number(r.avg) * Number(r.n))),
    newest: g.reduce((b, r) => (!b || new Date(r.latest_at) > new Date(b.latest_at) ? r : b), null),
  }));
  if (agg === 'avg') return sumOf(groups.map((x) => x.weighted / x.n)) / groups.length;
  if (agg === 'latest') return Number(groups.map((x) => x.newest).sort((a, b) => new Date(b.latest_at) - new Date(a.latest_at))[0].latest);
  return Math.max(...groups.map((x) => x.sum));
}

function sleepFrom(rows) {
  const cands = [];
  const seg = new Map();
  for (const r of rows) {
    if (r.metric === 'sleep_hours') {
      const e = r.extra || {};
      cands.push({
        hours: Number(r.latest), inBedOnly: Boolean(e.in_bed_only),
        stages: { deep: e.deep ?? null, rem: e.rem ?? null, core: e.core ?? null, awake: e.awake ?? null, in_bed: e.in_bed ?? null },
      });
    } else if (isSleepKey(r.metric)) {
      if (!seg.has(r.source)) seg.set(r.source, Object.fromEntries(SLEEP_STAGES.map((s) => [s, 0])));
      seg.get(r.source)[r.metric.slice(6)] += Number(r.sum);
    }
  }
  for (const st of seg.values()) {
    const asleep = st.core + st.deep + st.rem + st.asleep;
    cands.push({
      hours: asleep > 0 ? asleep : st.in_bed, inBedOnly: !(asleep > 0),
      stages: { deep: st.deep, rem: st.rem, core: st.core, awake: st.awake, in_bed: st.in_bed || null },
    });
  }
  if (!cands.length) return null;
  // Time in bed (an iPhone without a Watch) only stands in when no feed measured actual sleep.
  const real = cands.filter((c) => !c.inBedOnly && c.hours > 0);
  const pool = real.length ? real : cands;
  pool.sort((a, b) => b.hours - a.hours);
  const best = pool[0];
  const stages = { ...best.stages };
  if (!stages.in_bed) stages.in_bed = Math.max(0, ...cands.map((c) => c.stages.in_bed || 0)) || null;
  const anyStage = ['deep', 'rem', 'core', 'awake', 'in_bed'].some((k) => stages[k]);
  return {
    hours: best.hours,
    stages: anyStage ? Object.fromEntries(['deep', 'rem', 'core', 'awake', 'in_bed'].map((k) => [k, roundTo(stages[k] ?? null, 2)])) : null,
  };
}

// date -> { metric: value, sleep_hours, sleep (stages) }
function computeDays(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    const m = byDate.get(r.date);
    if (!m.has(r.metric)) m.set(r.metric, []);
    m.get(r.metric).push(r);
  }
  const out = new Map();
  for (const [date, byMetric] of byDate) {
    const v = { units: {} };
    const sleepRows = [];
    for (const [metric, rs] of byMetric) {
      if (isSleepKey(metric)) {
        sleepRows.push(...rs);
        continue;
      }
      v[metric] = combine(metric, rs);
      v.units[metric] = rs[0].unit;
    }
    const sl = sleepFrom(sleepRows);
    if (sl) {
      v.sleep_hours = sl.hours;
      v.sleep = sl.stages;
    }
    out.set(date, v);
  }
  return out;
}

// One metric on one date, optionally only what can be proven to come before a cutoff.
async function metricValueOn(metric, date, cutoff = null) {
  const sql = db();
  const sleep = metric === 'sleep_hours';
  const names = sleep ? ['sleep_hours', ...SLEEP_STAGES.map((s) => `sleep_${s}`)] : [metric];
  let rows = await sql`select * from health_samples where date = ${date} and metric in ${sql(names)}`;
  if (cutoff) {
    const c = cutoff.toMillis();
    rows = rows.filter((r) => {
      if (sleep) return !(r.extra?.end && Date.parse(r.extra.end) > c);
      if (r.extra?.day) return new Date(r.received_at).getTime() < c;
      return new Date(r.at).getTime() < c;
    });
  }
  const agg = aggregateRaw(rows);
  if (sleep) return sleepFrom(agg)?.hours ?? 0;
  return combine(metric, agg) ?? 0;
}

async function workoutsBetween(fromDate, toDate, tz) {
  const from = midnight(fromDate, tz).toJSDate();
  const to = midnight(addDays(toDate, 1, tz), tz).toJSDate();
  return db()`select * from health_workouts where start_at >= ${from} and start_at < ${to} order by start_at`;
}

function workoutMatches(w, filter) {
  const words = String(filter || '').toLowerCase().split(/[,|]/).map((x) => x.trim()).filter(Boolean);
  if (!words.length) return true;
  const t = w.type.toLowerCase();
  return words.some((x) => t.includes(x));
}

function workoutText(ws) {
  const total = sumOf(ws.map(minutesOf));
  return `${listNames(ws.map((w) => w.type))}, ${fmtInt(total)} min`;
}

// The value a linked habit is judged on for a date, with the words used in notes.
async function habitValue(h, date, tz, cutoff = null) {
  if (h.auto_metric === 'workout') {
    let ws = (await workoutsBetween(date, date, tz)).filter((w) => workoutMatches(w, h.auto_filter));
    if (cutoff) ws = ws.filter((w) => new Date(w.start_at).getTime() < cutoff.toMillis() && !w.extra?.noTime);
    ws = dedupeWorkouts(ws);
    return { value: sumOf(ws.map(minutesOf)), label: ws.length ? workoutText(ws) : 'no matching workout' };
  }
  const value = await metricValueOn(h.auto_metric, date, cutoff);
  return { value, label: metricText(h.auto_metric, value) };
}

// ---------- Habits that tick themselves off ----------

export const AUTO_METRICS = ['steps', 'exercise_min', 'active_kcal', 'stand_hours', 'sleep_hours', 'distance_km', 'mindful_min', 'flights', 'workout', 'water_ml'];
const AUTO_MAX = { steps: 100000, exercise_min: 600, active_kcal: 10000, stand_hours: 24, sleep_hours: 16, distance_km: 300, mindful_min: 600, flights: 500, workout: 600, water_ml: 10000 };
const AUTO_EXAMPLE = { steps: '10000', exercise_min: '30', active_kcal: '500', stand_hours: '10', sleep_hours: '7.5', distance_km: '5', mindful_min: '10', flights: '10', water_ml: '2000' };

export async function setHabitAuto(habitId, input = {}) {
  const id = Number.parseInt(habitId, 10);
  if (!Number.isFinite(id)) throw new RuleError('Bad id.');
  const [h] = await db()`select * from habits where id = ${id}`;
  if (!h) throw new RuleError('That habit does not exist.', 404);
  const { metric, target, filter } = input && typeof input === 'object' ? input : {};
  if (metric === null || metric === undefined || metric === '') {
    await db()`update habits set auto_metric = null, auto_target = null, auto_filter = '' where id = ${id}`;
    await logEvent('habit_auto_unlinked', { id, name: h.name });
    return { ok: true, habit: { id, autoMetric: null, autoTarget: null, autoFilter: '' }, keptNow: false };
  }
  const m = String(metric).trim().toLowerCase();
  if (!AUTO_METRICS.includes(m)) {
    throw new RuleError(`Apple Health can tick a habit off from one of: ${AUTO_METRICS.join(', ')}.`);
  }
  const { today } = await localNow();
  if (h.archived_from && h.archived_from <= today) throw new RuleError('That habit is archived.', 409);
  let t;
  if (target === undefined || target === null || target === '') {
    if (m !== 'workout') throw new RuleError(`Set a target, for example ${AUTO_EXAMPLE[m]}.`);
    t = 1;
  } else {
    t = typeof target === 'number' ? target : parseLoose(target, { unit: m === 'workout' ? 'min' : DEF[m].unit, integer: INTEGER.has(m) });
    if (t === null || !Number.isFinite(t) || t <= 0 || t > AUTO_MAX[m]) {
      throw new RuleError(`The target must be a number above 0 and at most ${fmtInt(AUTO_MAX[m])}.`);
    }
  }
  const f = m === 'workout' ? String(filter ?? '').trim().slice(0, 60) : '';
  await db()`update habits set auto_metric = ${m}, auto_target = ${t}, auto_filter = ${f} where id = ${id}`;
  await logEvent('habit_auto_linked', { id, name: h.name, metric: m, target: t, filter: f });
  // If today's data already shows it, tick it now rather than at the next sync.
  const applied = await applyHealth([today]);
  return { ok: true, habit: { id, autoMetric: m, autoTarget: t, autoFilter: f }, keptNow: applied.kept.some((k) => k.habitId === id) };
}

const weekEnd = (date, tz) => addDays(weekStartOf(date, tz), 6, tz);

// Did the season end (a death) after this miss was charged? Then there is nothing to give back.
async function deathSince(tx, m) {
  const [ev] = await tx`select id from events where type = 'miss' and data->>'kind' = 'habit'
                        and data->>'refId' = ${String(m.ref_id)} and data->>'date' = ${m.date} order by id limit 1`;
  if (ev) return (await tx`select 1 from events where type = 'death' and id > ${ev.id} limit 1`).length > 0;
  return (await tx`select 1 from events where type = 'death' and at > ${m.created_at} limit 1`).length > 0;
}

async function applyOne(h, date, ctx, out) {
  const { s, local, today, tz, rest } = ctx;
  const fixed = isScheduled(h, date, tz, rest);
  const flex = !fixed && isFlexible(h, date) && isActive(h, date);
  if (!fixed && !flex) return;
  const target = Number(h.auto_target) > 0 ? Number(h.auto_target) : h.auto_metric === 'workout' ? 1 : 0;
  if (!target) return;
  const [done] = await db()`select 1 from completions where habit_id = ${h.id} and date = ${date}`;
  if (done) return;
  const due = deadlineAt(date, rulesOn(h, date).deadline, tz);

  // Today, before the deadline: the normal keep, comeback bonus included.
  if (date === today && local < due) {
    const [miss] = await db()`select 1 from misses where kind = 'habit' and ref_id = ${h.id} and date = ${date}`;
    if (!miss) {
      const v = await habitValue(h, date, tz);
      if (v.value < target) return;
      const r = await completeHabit(h.id, { note: `Apple Health: ${v.label}` });
      if (r.already) return;
      await db()`update completions set source = 'health' where habit_id = ${h.id} and date = ${date}`;
      out.kept.push({ habitId: h.id, name: h.name, date, metric: h.auto_metric, value: roundTo(v.value, 2), label: v.label, comeback: r.comeback || 0 });
      out.notes.push({
        title: `Kept from Apple Health: ${h.name}`,
        body: `${capitalise(v.label)}. Ticked off for you${r.comeback ? `, and +${r.comeback} HP for coming back` : ''}.`,
        tag: `health-kept-${h.id}-${date}`,
        url: '/#/today',
      });
      return;
    }
  }

  // An earlier day, or today after the deadline. X-a-week habits never reopen a settled week.
  if (flex && weekEnd(date, tz) <= (await getGame()).lastFinalized) return;
  const v = await habitValue(h, date, tz, flex ? null : due);
  if (v.value < target) return;
  const note = `Apple Health: ${v.label}`;
  await withGame(async (tx, game) => {
    if (flex && weekEnd(date, tz) <= game.lastFinalized) return;
    const ins = await tx`insert into completions (habit_id, date, note, minimum, completed_at, source)
                         values (${h.id}, ${date}, ${note.slice(0, 500)}, false, ${ts()}, 'health')
                         on conflict (habit_id, date) do nothing returning id`;
    if (!ins.length) return;
    await logEvent('habit_kept', { id: h.id, name: h.name, date, minimum: false, source: 'health', value: v.value }, tx);
    const [m] = await tx`select * from misses where kind = 'habit' and ref_id = ${h.id} and date = ${date} for update`;
    const overturn = Boolean(m && !m.pardoned_at && !m.overturned);
    const entry = { habitId: h.id, name: h.name, date, metric: h.auto_metric, value: roundTo(v.value, 2), label: v.label, comeback: 0 };
    if (!overturn) {
      await tx`update days set kept = kept + 1 where date = ${date}`;
      out.kept.push(entry);
      out.notes.push({
        title: `Kept from Apple Health: ${h.name}`,
        body: `${capitalise(v.label)} on ${fmtDay(date)}. Counted as kept.`,
        tag: `health-kept-${h.id}-${date}`,
        url: '/#/today',
      });
      return;
    }
    // Overturn: like a pardon, but proven by data, and it never uses up a monthly pardon.
    const death = await deathSince(tx, m);
    const before = game.hp;
    if (!death) game.hp = Math.min(s.maxHp, game.hp + m.hp_lost);
    const back = game.hp - before;
    const reason = `Apple Health shows it was done: ${v.label}`;
    await tx`update misses set overturned = true, pardoned_at = ${ts()}, pardon_reason = ${reason.slice(0, 1000)} where id = ${m.id}`;
    await tx`update days set missed = greatest(missed - 1, 0), kept = kept + 1 where date = ${date}`;
    await logEvent('miss_overturned', {
      missId: m.id, habitId: h.id, title: m.title, date, value: v.value, label: v.label, hpLost: m.hp_lost, hpBack: back, afterDeath: death, hpAfter: game.hp,
    }, tx);
    out.kept.push({ ...entry, overturned: true });
    out.overturned.push({ habitId: h.id, name: h.name, date, missId: m.id, hpLost: m.hp_lost, hpBack: back, label: v.label });
    const tail = back > 0 ? `+${back} HP back.` : death ? 'Your season has ended since, so no HP comes back.' : 'You were already at full HP.';
    out.notes.push({
      title: 'Apple Health overturned a miss',
      body: `${h.name} on ${fmtDay(date)} was done after all. ${tail}`,
      tag: `health-overturn-${h.id}-${date}`,
      url: '/#/ledger',
    });
  });
}

// Tick off linked habits for the given dates (only today and the 3 days before count).
export async function applyHealth(dates) {
  const out = { kept: [], overturned: [], notes: [] };
  const { s, local, today, tz } = await localNow();
  const earliest = addDays(today, -3, tz);
  const list = [...new Set((dates || []).filter((d) => validDate(d) && d >= earliest && d <= today))].sort();
  if (!list.length) return out;
  const habits = await db()`select * from habits where auto_metric is not null and auto_metric <> '' order by sort, id`;
  if (!habits.length) return out;
  const rest = await restSet();
  for (const date of list) {
    for (const h of habits) {
      try {
        await applyOne(h, date, { s, local, today, tz, rest }, out);
      } catch (err) {
        if (!(err instanceof RuleError)) throw err;
      }
    }
  }
  return out;
}

// ---------- Read side ----------

export const DEFAULT_HEALTH_GOALS = { steps: 10000, exercise_min: 30, active_kcal: 500, stand_hours: 12, sleep_hours: 7.5 };
const GOAL_MAX = { steps: 100000, exercise_min: 600, active_kcal: 5000, stand_hours: 24, sleep_hours: 14 };
const GOAL_NAME = { steps: 'steps', exercise_min: 'exercise', active_kcal: 'active energy', stand_hours: 'stand hours', sleep_hours: 'sleep' };

async function getGoals() {
  const saved = await getKV('health_goals', {});
  return { ...DEFAULT_HEALTH_GOALS, ...(saved && typeof saved === 'object' ? saved : {}) };
}

export async function setHealthGoals(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new RuleError('Send the goals as JSON.');
  const next = await getGoals();
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_HEALTH_GOALS)) throw new RuleError(`Unknown goal: ${k}.`);
    const n = typeof v === 'number' ? v : parseLoose(v, { unit: DEF[k].unit, integer: INTEGER.has(k) });
    if (n === null || !Number.isFinite(n) || n <= 0 || n > GOAL_MAX[k]) {
      throw new RuleError(`The ${GOAL_NAME[k]} goal must be a number above 0 and at most ${fmtInt(GOAL_MAX[k])}.`);
    }
    next[k] = k === 'sleep_hours' ? roundTo(n, 2) : Math.round(n);
  }
  await setKV('health_goals', next);
  await logEvent('health_goals', next);
  return next;
}

async function connection() {
  const [r] = await db()`select exists (select 1 from health_samples) or exists (select 1 from health_workouts) as c`;
  const last = await getKV('health_last_sync');
  let lastSync = last?.at || null;
  if (!lastSync && r.c) {
    const [m] = await db()`select greatest((select max(received_at) from health_samples), (select max(received_at) from health_workouts)) as at`;
    lastSync = m.at ? new Date(m.at).toISOString() : null;
  }
  return { connected: Boolean(r.c), lastSync };
}

const DAY_KEYS = ['steps', 'active_kcal', 'exercise_min', 'stand_hours', 'sleep_hours', 'distance_km', 'flights', 'resting_hr', 'hrv_ms', 'weight_kg', 'mindful_min', 'kcal_in', 'water_ml'];
const LATEST_KEYS = ['weight_kg', 'vo2max', 'body_fat_pct', 'resting_hr', 'hrv_ms'];

function dayEntry(date, v) {
  const e = { date };
  for (const k of DAY_KEYS) {
    e[k] = v && v[k] !== undefined && v[k] !== null ? roundKey(k, v[k]) : null;
    if (k === 'sleep_hours') e.sleep = v?.sleep || null;
  }
  return e;
}

const workoutOut = (w, tz) => ({
  id: w.id,
  type: w.type,
  date: DateTime.fromJSDate(new Date(w.start_at)).setZone(tz).toISODate(),
  start: new Date(w.start_at).toISOString(),
  end: w.end_at ? new Date(w.end_at).toISOString() : null,
  duration_min: Math.round(minutesOf(w)),
  kcal: w.kcal === null ? null : Math.round(w.kcal),
  distance_km: w.distance_km === null ? null : roundTo(w.distance_km, 2),
  avg_hr: w.avg_hr === null ? null : Math.round(w.avg_hr),
});

async function latestValues() {
  const sql = db();
  const rows = await sql`select distinct on (metric) metric, date from health_samples
                         where metric in ${sql(LATEST_KEYS)} order by metric, date desc`;
  const out = Object.fromEntries(LATEST_KEYS.map((k) => [k, null]));
  for (const r of rows) {
    const value = combine(r.metric, await aggRows(r.date, r.date, [r.metric]));
    if (value !== null) out[r.metric] = { value: roundKey(r.metric, value), date: r.date };
  }
  return out;
}

async function autoHabitsOn(today, tz) {
  const habits = (await db()`select * from habits where auto_metric is not null and auto_metric <> '' order by sort, id`)
    .filter((h) => !(h.archived_from && h.archived_from <= today));
  const out = [];
  for (const h of habits) {
    const v = await habitValue(h, today, tz);
    const target = Number(h.auto_target) > 0 ? Number(h.auto_target) : h.auto_metric === 'workout' ? 1 : null;
    out.push({
      habitId: h.id, name: h.name, metric: h.auto_metric, target, filter: h.auto_filter || '',
      todayValue: h.auto_metric === 'workout' ? Math.round(v.value) : roundKey(h.auto_metric, v.value),
      met: target !== null && v.value >= target,
    });
  }
  return out;
}

export async function healthSummary({ days = 30 } = {}) {
  const n = Math.max(1, Math.min(120, Number.parseInt(days, 10) || 30));
  const { today, tz } = await localNow();
  const from = addDays(today, -(n - 1), tz);
  const { connected, lastSync } = await connection();
  const map = computeDays(await aggRows(from, today));
  const list = [];
  for (let d = from; d <= today; d = addDays(d, 1, tz)) list.push(dayEntry(d, map.get(d)));

  // Anything else seen in the last week, with its most recent day's value.
  const other = [];
  const weekFrom = addDays(today, -6, tz);
  const shown = new Set([...DAY_KEYS, ...LATEST_KEYS]);
  const seen = new Map();
  for (const d of [...map.keys()].filter((x) => x >= weekFrom).sort()) {
    for (const [k, v] of Object.entries(map.get(d))) {
      if (k === 'units' || k === 'sleep' || shown.has(k) || isSleepKey(k) || v === null) continue;
      seen.set(k, { date: d, value: v, unit: map.get(d).units[k] || '' });
    }
  }
  for (const [key, x] of seen) {
    other.push({ key, label: DEF[key]?.label ?? humanize(key), unit: DEF[key]?.unit ?? x.unit, value: roundKey(key, x.value), date: x.date });
  }
  other.sort((a, b) => a.label.localeCompare(b.label));

  const workouts = dedupeWorkouts(await workoutsBetween(from, today, tz))
    .sort((a, b) => new Date(b.start_at) - new Date(a.start_at))
    .map((w) => workoutOut(w, tz));

  return {
    today,
    connected,
    lastSync,
    days: list,
    latest: await latestValues(),
    workouts,
    goals: await getGoals(),
    autoHabits: await autoHabitsOn(today, tz),
    other,
  };
}

export async function todayHealth() {
  const { today, tz } = await localNow();
  const { connected, lastSync } = await connection();
  const v = computeDays(await aggRows(today, today)).get(today) || {};
  const pick = (k) => (v[k] === undefined || v[k] === null ? null : roundKey(k, v[k]));
  const ws = dedupeWorkouts(await workoutsBetween(today, today, tz));
  return {
    date: today,
    connected,
    lastSync,
    steps: pick('steps'),
    exercise_min: pick('exercise_min'),
    active_kcal: pick('active_kcal'),
    stand_hours: pick('stand_hours'),
    sleep_hours: pick('sleep_hours'),
    workouts: ws.map((w) => ({ type: w.type, duration_min: Math.round(minutesOf(w)) })),
    goals: await getGoals(),
  };
}

// A few plain lines for the coach's context, or '' when no data has ever arrived.
export async function healthForCoach() {
  const sum = await healthSummary({ days: 7 });
  if (!sum.connected) return '';
  const { tz } = await localNow();
  const lines = [];
  const synced = sum.lastSync ? DateTime.fromISO(sum.lastSync).setZone(tz).setLocale('en-GB').toFormat('ccc d LLL HH:mm') : null;
  lines.push(`Apple Health${synced ? ` (last sync ${synced})` : ''}:`);
  const t = sum.days[sum.days.length - 1];
  const todayBits = [];
  if (t.steps !== null) todayBits.push(plural(t.steps, 'step'));
  if (t.exercise_min !== null) todayBits.push(`${fmtInt(t.exercise_min)} exercise min`);
  if (t.active_kcal !== null) todayBits.push(`${fmtInt(t.active_kcal)} active kcal`);
  if (t.stand_hours !== null) todayBits.push(plural(t.stand_hours, 'stand hour'));
  if (todayBits.length) lines.push(`  Today so far: ${todayBits.join(', ')}.`);
  if (t.sleep_hours !== null) {
    const st = t.sleep;
    const parts = st ? [['deep', st.deep], ['REM', st.rem], ['core', st.core], ['awake', st.awake]].filter(([, x]) => x).map(([k, x]) => `${k} ${fmtDec(x, 1)} h`) : [];
    lines.push(`  Last night: ${fmtDec(t.sleep_hours, 1)} h asleep${parts.length ? ` (${parts.join(', ')})` : ''}.`);
  }
  const avg = (k) => {
    const v = sum.days.map((d) => d[k]).filter((x) => x !== null);
    return v.length ? sumOf(v) / v.length : null;
  };
  const avgBits = [];
  const a = { steps: avg('steps'), exercise_min: avg('exercise_min'), active_kcal: avg('active_kcal'), sleep_hours: avg('sleep_hours'), resting_hr: avg('resting_hr'), hrv_ms: avg('hrv_ms') };
  if (a.steps !== null) avgBits.push(`${fmtInt(a.steps)} steps`);
  if (a.exercise_min !== null) avgBits.push(`${fmtInt(a.exercise_min)} exercise min`);
  if (a.active_kcal !== null) avgBits.push(`${fmtInt(a.active_kcal)} active kcal`);
  if (a.sleep_hours !== null) avgBits.push(`${fmtDec(a.sleep_hours, 1)} h sleep`);
  if (a.resting_hr !== null) avgBits.push(`resting heart rate ${fmtInt(a.resting_hr)}`);
  if (a.hrv_ms !== null) avgBits.push(`HRV ${fmtInt(a.hrv_ms)} ms`);
  if (avgBits.length) lines.push(`  Last 7 days, average per day with data: ${avgBits.join(', ')}.`);
  const monday = weekStartOf(sum.today, tz);
  const week = sum.workouts.filter((w) => w.date >= monday).reverse();
  lines.push(week.length
    ? `  Workouts this week: ${week.map((w) => `${fmtDay(w.date).slice(0, 3)} ${w.type} ${w.duration_min} min${w.distance_km ? `, ${fmtDec(w.distance_km, 1)} km` : ''}`).join('; ')}.`
    : '  Workouts this week: none logged.');
  if (sum.latest.weight_kg) lines.push(`  Weight: ${fmtDec(sum.latest.weight_kg.value, 1)} kg on ${sum.latest.weight_kg.date}.`);
  if (sum.autoHabits.length) {
    const desc = sum.autoHabits.map((h) => {
      const what = h.metric === 'workout'
        ? `a ${h.filter ? `${h.filter} ` : ''}workout of at least ${fmtInt(h.target)} min, today ${fmtInt(h.todayValue ?? 0)} min`
        : `${metricText(h.metric, h.target)}, today ${metricText(h.metric, h.todayValue ?? 0)}`;
      return `${h.name} (${what}${h.met ? ', done' : ''})`;
    });
    lines.push(`  Habits ticked off by Apple Health data: ${desc.join('; ')}.`);
  }
  return lines.join('\n');
}

// ---------- HTTP ----------

async function jsonBody(c, strict = false) {
  try {
    return await c.req.json();
  } catch {
    if (strict) throw new RuleError('Send JSON.');
    return {};
  }
}

// Mounted under the authenticated /api.
export const healthApi = new Hono();
healthApi.get('/health', async (c) => c.json(await healthSummary({ days: c.req.query('days') })));
healthApi.put('/health/goals', async (c) => c.json({ ok: true, goals: await setHealthGoals(await jsonBody(c, true)) }));
healthApi.patch('/health/habits/:id', async (c) => c.json(await setHabitAuto(c.req.param('id'), await jsonBody(c))));
healthApi.post('/health/ingest', async (c) => c.json(await ingestHealth(await jsonBody(c, true))));

// Mounted under /api/shortcut, which checks the Bearer token. Health Auto Export and the Shortcut both post here.
export const healthShortcut = new Hono();
healthShortcut.post('/health', async (c) => {
  let r;
  try {
    r = await ingestHealth(await jsonBody(c, true));
  } catch (err) {
    if (err instanceof RuleError) return c.json({ error: err.message, say: err.message }, err.status);
    throw err;
  }
  for (const note of r.notes) {
    try {
      await sendPush(note);
    } catch (err) {
      console.error('health push failed', err.message);
    }
  }
  return c.json(r);
});
