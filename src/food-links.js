// Food and your body: honest links between what he eats and his Apple Health data.
//
// One row per logged day joins the diary (energy, carbs, protein, caffeine after 14:00, alcohol, the
// first and last bite, drinks) to Apple Health (sleep, resting heart rate, HRV, active energy, exercise).
// A few fixed comparisons split those days into two groups, and Welch's t-test says how likely the
// difference is to be chance.
//
// Honest by construction:
// - A day with nothing logged is left out, never counted as zero. So is a day without the Health value a
//   comparison needs, and today, which is still going.
// - Every rule (which days are "late", what counts as a training day) is fixed before the outcome is
//   looked at. Nothing is tuned to make a link look stronger.
// - Every link gives each group's days and how sure it is, and the words never claim a cause.
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { db } from './db.js';
import { addDays } from './time.js';
import { localNow } from './engine.js';
import { total, round } from '../public/nutrition.js';
// health.js is loaded when first needed, as body.js does: a top-level import closes the
// health, push, telegram, coach, food loop and leaves food.js half-loaded at boot.
const metricDays = async (...args) => (await import('./health.js')).metricDays(...args);

export const MIN_DAYS = 6; // each group needs at least this many days before a link is shown
const HEALTH_KEYS = ['sleep_hours', 'resting_hr', 'hrv_ms', 'active_kcal', 'exercise_min'];
const ROW_FIELD = { sleep_hours: 'sleep', resting_hr: 'rhrNext', hrv_ms: 'hrvNext', active_kcal: 'activeKcal', exercise_min: 'exerciseMin' };
const LATE_CUTS = [1230, 1260, 1290, 1320, 1350]; // 20:30 to 22:30, in minutes after midnight
const LATE_DEFAULT = 1290; // 21:30
const CAFFEINE_FROM = 14 * 60; // caffeine "after 14:00"
const CAFFEINE_ANY = 40; // mg: about half an espresso; less (a square of chocolate) counts as none
const ALCOHOL_ANY = 5; // g: about half a drink; less (kefir, ripe fruit) counts as none
const TRAINING_MIN = 45; // exercise minutes that make a training day on their own
const UNDERFUEL_GAP = 300; // kcal: burns this much more on training days than the extra he eats
const DAY_START = 4 * 60; // a bite before 04:00 belongs to the evening before

// ---------- Statistics ----------

// ln Γ(x) by the Lanczos approximation (g = 7, nine terms), accurate to about 1e-15 for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// The continued fraction of the incomplete beta function, by the modified Lentz method
// (Numerical Recipes, 3rd ed., 6.4).
function betacf(x, a, b) {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 2000; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

// The regularised incomplete beta function I_x(a, b).
export function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The fraction converges fast on one side of the mean; use the symmetry I_x(a, b) = 1 − I_(1−x)(b, a) on the other.
  return x < (a + 1) / (a + b + 2) ? (front * betacf(x, a, b)) / a : 1 - (front * betacf(1 - x, b, a)) / b;
}

// Student's t distribution: P(T ≤ t) with df degrees of freedom (df need not be whole).
export function tCdf(t, df) {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const tail = 0.5 * ibeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

// Two-sided p-value for t with df degrees of freedom.
export const tTwoSided = (t, df) => (Number.isFinite(t) ? Math.min(1, ibeta(df / (df + t * t), df / 2, 0.5)) : 0);

const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const variance = (xs) => {
  const m = mean(xs);
  return xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1);
};
const sd = (xs) => (xs.length > 1 ? Math.sqrt(variance(xs)) : 0);

// Welch's t-test: two groups with possibly different spreads and sizes. diff is a − b.
export function welch(a, b) {
  const nA = a.length;
  const nB = b.length;
  if (nA < 2 || nB < 2) return { meanA: nA ? mean(a) : null, meanB: nB ? mean(b) : null, diff: null, t: null, df: null, p: null, nA, nB };
  const mA = mean(a);
  const mB = mean(b);
  const qa = variance(a) / nA;
  const qb = variance(b) / nB;
  const se = Math.sqrt(qa + qb);
  const diff = mA - mB;
  if (se === 0) return { meanA: mA, meanB: mB, diff, t: diff === 0 ? 0 : Infinity * Math.sign(diff), df: nA + nB - 2, p: diff === 0 ? 1 : 0, nA, nB };
  const t = diff / se;
  const df = (qa + qb) ** 2 / (qa ** 2 / (nA - 1) + qb ** 2 / (nB - 1));
  return { meanA: mA, meanB: mB, diff, t, df, p: tTwoSided(t, df), nA, nB };
}

// How sure, in words. Fixed thresholds, the same for every link.
export function strengthOf(p, nA, nB) {
  const n = Math.min(nA, nB);
  if (p !== null && p < 0.05 && n >= 8) return 'clear';
  if (p !== null && p < 0.2 && n >= MIN_DAYS) return 'maybe';
  return 'no clear link';
}
const TAIL = { clear: 'Clear pattern so far.', maybe: 'Maybe a pattern; more days will tell.', 'no clear link': 'Could be chance.' };

// ---------- Days ----------

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const hm = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
// Eating, not just drinking: water and black coffee don't open or close the window, a milky coffee or
// a can of energy drink does. A food with no energy value still counts; a drink with none does not.
const isEating = (e) => {
  const k = num(e.nutrients?.kcal);
  return k === null ? !e.liquid : k >= 10;
};

// One row per logged day from `from` to `to`, from diary entries ({ date, at, created_at, nutrients,
// liquid, ml }) and metricDays() rows. A day with no entries has no row at all.
//
// Sleep is filed under the date he wakes up (health.js sleepDate: a night that ends after 18:00 counts
// toward the next day), so the night of Monday into Tuesday is Tuesday's sleep. Food on day D is paired
// with the sleep filed under D + 1: the night that follows it. Resting heart rate and HRV are day
// averages that Apple Health mostly measures overnight and on waking, so "the next morning" is D + 1 too.
// Active energy and exercise are D's own.
//
// Times are minutes after the diary day's midnight. A bite between midnight and 04:00 belongs to the
// evening before (a 00:30 snack after futsal is a late dinner, not breakfast), so it can read 24:30.
// An entry added for an earlier day without a time sits at 12:00 (food.js placeEntry); its real time is
// unknown, so that day's first and last bite are left out rather than guessed.
export function buildRows(entries, health, { tz, from, to }) {
  const hByDate = new Map(health.map((h) => [h.date, h]));
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const timeOf = (e) => {
    const local = DateTime.fromJSDate(new Date(e.at)).setZone(tz);
    const created = e.created_at ? DateTime.fromJSDate(new Date(e.created_at)).setZone(tz).toISODate() : null;
    if (local.hour === 12 && local.minute === 0 && created && created > e.date) return null;
    return Math.round(local.diff(DateTime.fromISO(e.date, { zone: tz }), 'minutes').minutes);
  };
  const timed = new Map(); // date -> [{ e, min }] after moving small hours to the evening before
  for (const [date, list] of byDate) {
    for (const e of list) {
      const min = timeOf(e);
      const moved = min !== null && min < DAY_START && byDate.has(addDays(date, -1, tz));
      const d = moved ? addDays(date, -1, tz) : date;
      if (!timed.has(d)) timed.set(d, []);
      timed.get(d).push({ e, min: min === null ? null : moved ? min + 1440 : min });
    }
  }
  const rows = [];
  for (let date = from; date <= to; date = addDays(date, 1, tz)) {
    const list = byDate.get(date);
    if (!list?.length) continue;
    const t = total(list.map((e) => e.nutrients));
    const items = timed.get(date) || [];
    const eats = items.filter((x) => isEating(x.e));
    const known = eats.every((x) => x.min !== null);
    const times = eats.map((x) => x.min);
    const first = known && times.length ? Math.min(...times) : null;
    const last = known && times.length ? Math.max(...times) : null;
    // Caffeine after 14:00 and alcohol on the night. A drink with no value is unknown, not zero, so a day
    // that stays under the line only because of it is left out (as in the caffeine-by-hour chart).
    let caf = 0;
    let cafUnknown = false;
    let alc = 0;
    let alcUnknown = false;
    for (const { e, min } of items) {
      const c = num(e.nutrients?.caffeine);
      if (min !== null && min >= CAFFEINE_FROM) {
        if (c !== null) caf += c;
        else if (e.liquid) cafUnknown = true;
      } else if (min === null && (c > 0 || (c === null && e.liquid))) cafUnknown = true; // could have been after 14:00
      const a = num(e.nutrients?.alcohol);
      if (a !== null) alc += a;
      else if (e.liquid) alcUnknown = true;
    }
    const next = hByDate.get(addDays(date, 1, tz)) || {};
    const own = hByDate.get(date) || {};
    rows.push({
      date,
      entries: list.length,
      kcal: num(t.kcal) === null ? null : round(t.kcal, 0),
      carbs: num(t.carbs) === null ? null : round(t.carbs, 1),
      protein: num(t.protein) === null ? null : round(t.protein, 1),
      // A total missing some lines is a floor ("at least").
      kcalFloor: Boolean(t.missing?.kcal),
      carbsFloor: Boolean(t.missing?.carbs),
      caffeineLate: caf < CAFFEINE_ANY && cafUnknown ? null : round(caf, 0),
      alcohol: alc < ALCOHOL_ANY && alcUnknown ? null : round(alc, 1),
      first,
      last,
      window: first === null ? null : round((last - first) / 60, 2),
      drinksMl: round(list.filter((e) => e.liquid && num(e.ml)).reduce((s, e) => s + e.ml, 0), 0),
      sleep: num(next.sleep_hours),
      hrvNext: num(next.hrv_ms),
      rhrNext: num(next.resting_hr),
      activeKcal: num(own.active_kcal),
      exerciseMin: num(own.exercise_min),
    });
  }
  return rows;
}

// ---------- Links ----------

const r2 = (v) => (v === null ? null : round(v, 2));
const group = (label, values, extra = {}) => ({ label, mean: values.length ? r2(mean(values)) : null, n: values.length, values: values.map(r2), ...extra });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minutesText = (h) => {
  const m = Math.round(Math.abs(h) * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

// The parts every comparison shares: the test, the strength, and the state when there are too few days.
function compare({ key, title, unit, a, b, labels, nouns, how }) {
  const need = Math.max(0, MIN_DAYS - a.length) + Math.max(0, MIN_DAYS - b.length);
  const base = { key, title, unit, a: group(labels[0], a), b: group(labels[1], b), need };
  if (need) {
    const parts = [[a.length, nouns[0]], [b.length, nouns[1]]].filter(([n]) => n < MIN_DAYS).map(([n, w]) => `${MIN_DAYS - n} more ${w}`);
    return { ...base, state: 'needs-data', strength: null, diff: null, p: null, how, text: `Needs ${parts.join(' and ')}. ${how}` };
  }
  const w = welch(a, b);
  return { ...base, state: 'ok', strength: strengthOf(w.p, a.length, b.length), diff: r2(w.diff), p: round(w.p, 4) };
}

const noHealth = (key, title, unit, text) => ({ key, title, unit, state: 'no-health', strength: null, a: null, b: null, diff: null, p: null, need: null, text });

// The late-eating cut-off is picked from 20:30, 21:00, 21:30, 22:00 and 22:30 by one fixed rule that never
// looks at sleep: the one that splits his days most evenly (the most days in the smaller group), ties
// going to 21:30 and then to the earlier time. Even groups give the fairest test; picking the cut-off by
// its p-value would find links that are not there.
export function lateCut(lasts) {
  let best = LATE_DEFAULT;
  let bestN = -1;
  const order = [...LATE_CUTS].sort((x, y) => Math.abs(x - LATE_DEFAULT) - Math.abs(y - LATE_DEFAULT) || x - y);
  for (const cut of order) {
    const late = lasts.filter((m) => m > cut).length;
    const n = Math.min(late, lasts.length - late);
    if (n > bestN) {
      best = cut;
      bestN = n;
    }
  }
  return best;
}

function sleepLink(key, title, a, b, labels, nouns, how, say) {
  const out = compare({ key, title, unit: 'h', a, b, labels, nouns, how });
  if (out.state !== 'ok') return out;
  const d = out.diff;
  const what = Math.abs(d) * 60 < 5 ? 'slept about the same' : `slept ${minutesText(d)} ${d < 0 ? 'less' : 'more'}`;
  return { ...out, text: `${say} you ${what} (${a.length} nights vs ${b.length}). ${TAIL[out.strength]}` };
}

// rows: buildRows(). present: the Health metrics seen at all in the period (defaults to those in rows).
export function linksFrom(rows, { present = null } = {}) {
  const has = present || new Set(HEALTH_KEYS.filter((k) => rows.some((r) => num(r[ROW_FIELD[k]]) !== null)));
  const links = [];
  const SLEEP_HOW = 'Log your evening food and drinks with their times, and wear your watch to bed.';
  const NO_SLEEP = 'No sleep from Apple Health yet. Wear your watch to bed, and send sleep with your Health export.';

  // 1. Late eating and that night's sleep.
  const sl = rows.filter((r) => r.last !== null && r.sleep !== null);
  const cut = lateCut(sl.map((r) => r.last));
  if (!has.has('sleep_hours')) links.push(noHealth('late-sleep', 'Late eating and sleep', 'h', NO_SLEEP));
  else {
    const at = hm(cut);
    links.push({
      ...sleepLink('late-sleep', 'Late eating and sleep', sl.filter((r) => r.last > cut).map((r) => r.sleep), sl.filter((r) => r.last <= cut).map((r) => r.sleep),
        [`After ${at}`, `By ${at}`], [`nights you ate after ${at}`, `nights you finished by ${at}`], SLEEP_HOW, `On nights you ate after ${at}`),
      cut: at,
    });
  }

  // 2. Caffeine after 14:00 and that night's sleep.
  const sc = rows.filter((r) => r.caffeineLate !== null && r.sleep !== null);
  if (!has.has('sleep_hours')) links.push(noHealth('caffeine-sleep', 'Caffeine after 14:00 and sleep', 'h', NO_SLEEP));
  else {
    links.push(sleepLink('caffeine-sleep', 'Caffeine after 14:00 and sleep', sc.filter((r) => r.caffeineLate >= CAFFEINE_ANY).map((r) => r.sleep),
      sc.filter((r) => r.caffeineLate < CAFFEINE_ANY).map((r) => r.sleep), ['Caffeine after 14:00', 'Little or none'],
      ['days with caffeine after 14:00', 'days with little or none'], 'Log coffee, tea and energy drinks with their times, and wear your watch to bed.',
      'On days with caffeine after 14:00'));
  }

  // 3. Training-day fuel. A training day has 45+ exercise minutes or active energy in his top third of
  // the period. The strength is the test on what he ate minus what he burned, because the question is
  // whether eating keeps up with training, not whether he eats more.
  const tr = rows.filter((r) => r.kcal !== null && r.activeKcal !== null);
  if (!has.has('active_kcal')) {
    links.push(noHealth('training-fuel', 'Training-day fuel', 'kcal', 'No active energy from Apple Health yet. Send active energy and exercise with your Health export.'));
  } else {
    const sorted = tr.map((r) => r.activeKcal).sort((x, y) => x - y);
    const top = sorted.length ? sorted[Math.floor((sorted.length * 2) / 3)] : Infinity;
    const isTraining = (r) => (r.exerciseMin !== null && r.exerciseMin >= TRAINING_MIN) || r.activeKcal >= top;
    const A = tr.filter(isTraining);
    const B = tr.filter((r) => !isTraining(r));
    const out = compare({
      key: 'training-fuel', title: 'Training-day fuel', unit: 'kcal', a: A.map((r) => r.kcal), b: B.map((r) => r.kcal),
      labels: ['Training days', 'Rest days'], nouns: ['training days', 'rest days'],
      how: 'Log full days of food; Apple Health adds the training.',
    });
    out.a.floor = A.some((r) => r.kcalFloor);
    out.b.floor = B.some((r) => r.kcalFloor);
    if (out.state === 'ok') {
      const carbsA = A.filter((r) => r.carbs !== null).map((r) => r.carbs);
      const carbsB = B.filter((r) => r.carbs !== null).map((r) => r.carbs);
      const burnA = mean(A.map((r) => r.activeKcal));
      const burnB = mean(B.map((r) => r.activeKcal));
      const net = welch(A.map((r) => r.kcal - r.activeKcal), B.map((r) => r.kcal - r.activeKcal));
      const eat = out.diff;
      const burn = burnA - burnB;
      const gap = burn - eat;
      const strength = strengthOf(net.p, A.length, B.length);
      const underfuel = gap > UNDERFUEL_GAP;
      const n = `(${A.length} training days vs ${B.length} rest days)`;
      const ate = Math.abs(eat) < 25 ? 'ate about the same' : `ate ${Math.round(Math.abs(eat))} kcal ${eat < 0 ? 'less' : 'more'}`;
      const burned = `burned about ${Math.round(Math.abs(burn))} kcal ${burn < 0 ? 'less' : 'more'}`;
      // Every sentence is about the gap between the extra burned and the extra eaten, which is what the strength tests.
      let text;
      if (underfuel) {
        text = `On training days you ${burned} but ${ate} ${n}. You may be under-fuelling on those days: a bigger meal or a carb-rich snack around training could help. ${TAIL[strength]}`;
      } else if (gap < -UNDERFUEL_GAP) {
        text = `On training days you ${ate} and ${burned} ${n}, so you eat well ahead of what training burns. ${TAIL[strength]}`;
      } else {
        const g = Math.round(Math.abs(gap) / 10) * 10;
        text = `On training days you ${ate} and ${burned} ${n}${g >= 100 ? `, a gap of about ${g} kcal` : ''}. Your eating roughly keeps pace with your training. ${TAIL[strength]}`;
      }
      Object.assign(out, {
        strength, p: round(net.p, 4), text, underfuel, gap: Math.round(gap),
        carbs: { a: carbsA.length ? r2(mean(carbsA)) : null, b: carbsB.length ? r2(mean(carbsB)) : null, floor: A.concat(B).some((r) => r.carbsFloor) },
        burn: { a: Math.round(burnA), b: Math.round(burnB), diff: Math.round(burn) },
      });
    }
    links.push(out);
  }

  // 4. Alcohol and the next morning's heart rate variability and resting heart rate.
  const alcoholDays = rows.filter((r) => r.alcohol !== null && r.alcohol >= ALCOHOL_ANY).length;
  const ALC_HOW = 'Log drinks with alcohol, and wear your watch overnight.';
  for (const [key, title, field, metric, unit, word, label, better] of [
    ['alcohol-hrv', 'Alcohol and heart rate variability', 'hrvNext', 'hrv_ms', 'ms', 'heart rate variability', 'HRV', 1],
    ['alcohol-rhr', 'Alcohol and resting heart rate', 'rhrNext', 'resting_hr', 'bpm', 'resting heart rate', 'Resting HR', -1],
  ]) {
    if (!has.has(metric)) {
      links.push(noHealth(key, title, unit, `No ${word} from Apple Health yet. Wear your watch overnight, and send it with your Health export.`));
      continue;
    }
    const rs = rows.filter((r) => r.alcohol !== null && r[field] !== null);
    const out = compare({
      key, title, unit, a: rs.filter((r) => r.alcohol >= ALCOHOL_ANY).map((r) => r[field]), b: rs.filter((r) => r.alcohol < ALCOHOL_ANY).map((r) => r[field]),
      labels: ['After alcohol', 'Without'], nouns: ['nights with alcohol', 'nights without'], how: ALC_HOW,
    });
    out.short = label;
    if (out.state === 'ok') {
      const d = out.diff;
      const what = Math.abs(d) < 1 ? 'was about the same' : `was ${Math.round(Math.abs(d))} ${unit} ${d < 0 ? 'lower' : 'higher'}`;
      out.text = `The morning after alcohol your ${word} ${what} (${out.a.n} nights vs ${out.b.n}). ${TAIL[out.strength]}`;
      out.better = better; // which way is the healthier reading: higher HRV, lower resting heart rate
    }
    links.push(out);
  }

  // 5. The eating window: average first and last bite, its length, and how much it moves.
  const ew = rows.filter((r) => r.first !== null && r.last !== null);
  if (ew.length < MIN_DAYS) {
    const need = MIN_DAYS - ew.length;
    links.push({
      key: 'eating-window', title: 'Eating window', unit: 'h', state: 'needs-data', strength: null, a: group('First bite', ew.map((r) => r.first)),
      b: group('Last bite', ew.map((r) => r.last)), diff: null, p: null, need, how: 'Log meals at the time you eat them, or add the time.',
      text: `Needs ${plural(need, 'more day')} with food logged at the time you ate it.`,
    });
  } else {
    const firsts = ew.map((r) => r.first);
    const lasts = ew.map((r) => r.last);
    const windows = ew.map((r) => r.window);
    const moves = Math.max(sd(firsts), sd(lasts));
    const steady = moves <= 30 ? 'very steady' : moves <= 60 ? 'steady' : moves <= 90 ? 'fairly steady' : 'varies a lot';
    const which = sd(lasts) >= sd(firsts) ? 'last bite' : 'first bite';
    const len = mean(windows);
    links.push({
      key: 'eating-window', title: 'Eating window', unit: 'h', state: 'ok', strength: null,
      a: group('First bite', firsts, { at: hm(mean(firsts)), sd: Math.round(sd(firsts)) }),
      b: group('Last bite', lasts, { at: hm(mean(lasts)), sd: Math.round(sd(lasts)) }),
      diff: r2(len), p: null, need: 0, steady, sdWindow: r2(sd(windows)),
      text: `You usually eat between ${hm(mean(firsts))} and ${hm(mean(lasts))}, a window of about ${minutesText(len)} (${ew.length} days). Your ${which} moves by about ${Math.round(moves)} min from day to day, so it is ${steady === 'varies a lot' ? 'not very steady' : steady}.`,
    });
  }
  return { rows: rows.length, health: has.size > 0, alcohol: alcoholDays > 0, links };
}

// ---------- The period ----------

export async function foodBodyLinks({ days = 90 } = {}) {
  const span = Math.max(14, Math.min(365, Number.parseInt(days, 10) || 90));
  const { today, tz } = await localNow();
  const from = addDays(today, -span, tz);
  const to = addDays(today, -1, tz); // today is still going
  const entries = await db()`select date, at, created_at, nutrients, liquid, ml from food_log
                             where deleted_at is null and date >= ${from} and date <= ${today}`;
  const health = await metricDays(HEALTH_KEYS, from, today);
  const present = new Set(HEALTH_KEYS.filter((k) => health.some((h) => h[k] !== null)));
  const rows = buildRows(entries, health, { tz, from, to });
  return { days: span, from, to, ...linksFrom(rows, { present }) };
}

// One line for the coach: the clearest link, only when one is clear. '' otherwise.
export async function foodLinksForCoach() {
  const r = await foodBodyLinks({ days: 90 });
  const clear = r.links.filter((l) => l.state === 'ok' && l.strength === 'clear').sort((a, b) => a.p - b.p)[0];
  if (!clear) return '';
  return `Food and body, the clearest link in his own last ${r.days} days of food and Apple Health (a pattern, not proof of cause; p = ${clear.p}): "${clear.text}"`;
}

// ---------- API ----------

// Mounted under the authenticated /api.
export const foodLinksApi = new Hono();
foodLinksApi.get('/food/links', async (c) => c.json(await foodBodyLinks({ days: c.req.query('days') })));
