// What an Apple Health export means: the metrics Oath keeps and how each adds up over a day, units and
// their conversions, times and days, how values are said, and the parsers for Health Auto Export and the
// flat Shortcut format, into samples and workouts. Pure: no database.
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { nowUTC, addDays, validDate } from './time.js';
import { RuleError } from './engine.js';

// key -> label, stored unit, how a day is combined, decimals shown, and the largest believable day value.
export const DEF = {};
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
export const INTEGER = new Set(['steps', 'flights', 'stand_hours']);
export const SLEEP_STAGES = ['core', 'deep', 'rem', 'asleep', 'awake', 'in_bed'];
export const isSleepKey = (m) => m === 'sleep_hours' || (m.startsWith('sleep_') && SLEEP_STAGES.includes(m.slice(6)));

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
export const aggOf = (key, unit) => DEF[key]?.agg ?? inferAgg(unit, key);

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
export const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);

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
export function parseLoose(raw, meta = {}) {
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
export const midnight = (date, tz) => DateTime.fromISO(date, { zone: tz });

// ---------- Formatting ----------

const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
export const fmtInt = (v) => nf0.format(Math.round(v));
export const fmtDec = (v, d = 1) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: d }).format(v);
export const fmtDay = (date) => DateTime.fromISO(date).setLocale('en-GB').toFormat('ccc d LLL');
export const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${Math.round(n) === 1 ? one : many}`;
export const capitalise = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
export const roundTo = (v, dec) => (v === null || v === undefined ? null : Math.round(v * 10 ** dec) / 10 ** dec);
export const roundKey = (key, v) => roundTo(v, DEF[key]?.dec ?? 2);
export function listNames(names) {
  const u = [...new Set(names)];
  if (u.length <= 1) return u.join('');
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}
export const humanize = (key) => capitalise(key.replace(/_/g, ' '));

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
export const metricText = (metric, v) => (METRIC_TEXT[metric] ? METRIC_TEXT[metric](v) : `${fmtDec(v, 1)} ${metric}`);

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

export function parseHaeMetrics(metrics, tz, out) {
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

export function parseWorkout(w, feed, ctx) {
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

export const minutesOf = (w) => Number(w.duration_min ?? (w.end_at ? (new Date(w.end_at) - new Date(w.start_at)) / 60000 : 0)) || 0;

// The same session sent by two feeds (or logged by two apps) counts once.
export function dedupeWorkouts(list) {
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

export function parseFlat(p, ctx, out) {
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
