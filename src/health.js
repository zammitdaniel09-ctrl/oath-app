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
import { nowUTC, addDays, dueOn, validDate } from './time.js';
import {
  localNow, getGame, withGame, completeHabit, RuleError, deathSince, rulesOn, isScheduled, isFlexible, isActive,
  weekStartOf,
} from './engine.js';
import { restSet } from './strength.js';
import { sendPush } from './push.js';
import {
  DEF, INTEGER, SLEEP_STAGES, isSleepKey, aggOf, sumOf, parseLoose, midnight, fmtInt, fmtDec, fmtDay, plural,
  capitalise, roundTo, roundKey, listNames, humanize, metricText, parseHaeMetrics, parseWorkout, minutesOf,
  dedupeWorkouts, parseFlat,
} from './health-parse.js';

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

// ---------- Storage ----------

const RUNNING_TOTALS = Object.values(DEF).filter((d) => d.agg === 'sum').map((d) => d.key);

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
    // The free Shortcut sends running day totals, and a run on a locked phone reads 0, so its totals
    // only ever go up: a lower reading never replaces a higher one already received.
    await sql`insert into health_samples ${sql(chunk, 'metric', 'at', 'source', 'date', 'value', 'unit', 'extra', 'received_at')}
              on conflict (metric, at, source) do update set
                date = excluded.date, unit = excluded.unit, extra = excluded.extra,
                value = case when health_samples.source = 'shortcut' and health_samples.metric = any(${RUNNING_TOTALS})
                             then greatest(health_samples.value, excluded.value) else excluded.value end,
                received_at = case when health_samples.value is distinct from
                                        (case when health_samples.source = 'shortcut' and health_samples.metric = any(${RUNNING_TOTALS})
                                              then greatest(health_samples.value, excluded.value) else excluded.value end)
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

async function applyOne(h, date, ctx, out) {
  const { s, local, today, tz, rest } = ctx;
  const fixed = isScheduled(h, date, tz, rest);
  const flex = !fixed && isFlexible(h, date) && isActive(h, date);
  if (!fixed && !flex) return;
  const target = Number(h.auto_target) > 0 ? Number(h.auto_target) : h.auto_metric === 'workout' ? 1 : 0;
  if (!target) return;
  const [done] = await db()`select 1 from completions where habit_id = ${h.id} and date = ${date}`;
  if (done) return;
  const due = dueOn(date, rulesOn(h, date).deadline, tz);

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

// Day values of a few metrics from one date to another, combined as everywhere else (largest feed for
// totals, newest for weight): [{ date, metric: value }] for the days that have any of them.
export async function metricDays(metrics, from, to) {
  const map = computeDays(await aggRows(from, to, metrics));
  return [...map.keys()].sort().map((date) => {
    const v = map.get(date);
    return { date, ...Object.fromEntries(metrics.map((k) => [k, v[k] === undefined || v[k] === null ? null : roundKey(k, v[k])])) };
  });
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
  const avg = (k) => {
    const v = sum.days.map((d) => d[k]).filter((x) => x !== null);
    return v.length ? sumOf(v) / v.length : null;
  };
  const avgBits = [];
  const a = { steps: avg('steps'), exercise_min: avg('exercise_min'), active_kcal: avg('active_kcal'), resting_hr: avg('resting_hr'), hrv_ms: avg('hrv_ms') };
  if (a.steps !== null) avgBits.push(`${fmtInt(a.steps)} steps`);
  if (a.exercise_min !== null) avgBits.push(`${fmtInt(a.exercise_min)} exercise min`);
  if (a.active_kcal !== null) avgBits.push(`${fmtInt(a.active_kcal)} active kcal`);
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
