// The coach's take on the Food screens: a few friendly sentences about the day, or about the period on
// Trends, written from the same numbers the screen shows. A take is kept until those numbers change,
// so opening the tab costs one Claude call per change to the diary, not one per visit.
import crypto from 'node:crypto';
import { db } from './db.js';
import { localNow, RuleError } from './engine.js';
import { validDate } from './time.js';
import { foodDay, foodHistory, HISTORY_SPANS } from './food.js';
import { NUTRIENT } from '../public/nutrition.js';
import { aiEnabled, writeTake } from './coach.js';

const DAY_KEYS = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'fibre', 'salt'];
const MICRO_KEYS = ['potassium', 'calcium', 'iron', 'magnesium', 'vitc', 'vitd', 'b12', 'folate'];
const SLOT_WORDS = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snacks: 'snack', drinks: 'drink' };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (v, dec = 0) => (num(v) === null ? 'unknown' : Number(v.toFixed(dec)).toLocaleString('en-GB'));
const pctOf = (k, v) => (num(v) !== null && NUTRIENT[k]?.ri ? Math.round((v / NUTRIENT[k].ri) * 100) : null);

// "Protein 84 g (168% RI)"; a "+" marks a total missing some lines, so it is at least that.
function amount(k, v, missing) {
  const x = NUTRIENT[k];
  if (num(v) === null) return `${x.label} unknown`;
  const p = pctOf(k, v);
  return `${x.label} ${fmt(v, x.dec)}${missing ? '+' : ''} ${x.unit}${p === null ? '' : ` (${p}% RI)`}`;
}

function partOfDay(hour) {
  if (hour < 11) return 'morning';
  if (hour < 15) return 'around midday';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function gradeLine(mix) {
  const sum = Object.values(mix || {}).reduce((a, v) => a + (num(v) || 0), 0);
  if (!sum) return null;
  const parts = ['a', 'b', 'c', 'd', 'e', 'none'].filter((g) => mix[g] > 0)
    .map((g) => `${g === 'none' ? 'ungraded' : g.toUpperCase()} ${Math.round((mix[g] / sum) * 100)}%`);
  return `Energy by Nutri-Score: ${parts.join(', ')}.`;
}

function averagesLine(avg, keys = ['kcal', 'protein', 'fibre', 'sugars', 'salt']) {
  return keys.map((k) => amount(k, avg?.[k] ?? null, avg?.missing?.[k])).join('; ');
}

async function dayFacts(date) {
  const { local, today } = await localNow();
  const d = await foodDay(date);
  const week = await foodHistory({ days: 7 });
  if (!d.entries.length && !week.loggedDays) return null;
  const isToday = d.date === today;
  const lines = [isToday
    ? `The Food tab for today, ${local.toFormat('cccc')}, ${partOfDay(local.hour)}.`
    : `The Food tab for ${d.date}, a past day.`];
  if (d.entries.length) {
    lines.push(`Logged: ${d.entries.length} ${d.entries.length === 1 ? 'item' : 'items'}${d.estimates ? `, ${d.estimates} of them estimates` : ''}.`);
    for (const e of d.entries.slice(0, 30)) {
      const tags = (e.tags || []).slice(0, 3).map((t) => t.label).join(', ');
      lines.push(`- ${SLOT_WORDS[e.slot] || e.slot}: ${e.brand && !e.name.includes(e.brand) ? `${e.brand} ` : ''}${e.name}${e.amountText ? ` (${e.amountText})` : ''}, ${fmt(num(e.nutrients?.kcal))} kcal${e.grade ? `, Nutri-Score ${e.grade.toUpperCase()}` : ''}${tags ? `, ${tags}` : ''}`);
    }
    const t = d.total;
    lines.push(`Totals: ${DAY_KEYS.map((k) => amount(k, num(t[k]), t.missing?.[k])).join('; ')}.`);
    const micros = MICRO_KEYS.map((k) => [k, pctOf(k, num(t[k]))]).filter(([, p]) => p !== null);
    if (micros.length) lines.push(`Vitamins and minerals, % of reference intake: ${micros.map(([k, p]) => `${NUTRIENT[k].label} ${p}%`).join(', ')}.`);
    const g = gradeLine(d.grades);
    if (g) lines.push(g);
    const caf = num(t.caffeine);
    lines.push(`Drinks ${fmt(d.drinksMl)} ml${caf !== null ? `, caffeine ${fmt(caf)} mg` : ''}.`);
  } else {
    lines.push(`Nothing logged ${isToday ? 'yet today' : 'that day'}.`);
  }
  if (week.loggedDays) lines.push(`This past week, today left out (${week.loggedDays} logged days): average ${averagesLine(week.avg)}.`);
  lines.push('RI is the EU reference intake for an average adult: a guide, not his target. A "+" means at least that, as some items have no value.');
  const ask = isToday
    ? 'Give your take on his food so far today, as if glancing at his diary with him: two to four short sentences. Say what stands out, good or not, and if it helps, one easy idea for the rest of the day. If it is early and little is logged, keep it brief and look ahead. Do not list every food or number. No greeting, no sign-off, no question.'
    : 'Give your take on what he ate that day, as if looking back at his diary with him: two to four short sentences. What stood out, good or not, and one easy idea for next time if there is one. No greeting, no sign-off, no question.';
  return { facts: lines.join('\n'), ask, date: d.date };
}

async function trendFacts(days) {
  const h = await foodHistory({ days });
  if (!h.loggedDays && !h.series.some((s) => s.logged)) return null;
  const lines = [`The Food Trends screen: the last ${h.days} days, ${h.loggedDays} of them fully logged (today is left out of averages).`];
  if (h.loggedDays) lines.push(`Average day: ${averagesLine(h.avg, ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'fibre', 'salt'])}.`);
  if (h.prev?.loggedDays) lines.push(`The ${h.days} days before (${h.prev.loggedDays} logged): ${averagesLine(h.prev.avg)}.`);
  const cov = (h.coverage || []).filter((c) => ['mineral', 'vitamin'].includes(c.group) && c.pct !== null);
  const low = [...cov].sort((a, b) => a.pct - b.pct).slice(0, 4);
  if (low.length) lines.push(`Lowest vitamins and minerals, % RI on an average day: ${low.map((c) => `${c.label} ${Math.round(c.pct)}%`).join(', ')}.`);
  const g = gradeLine(h.grades?.total);
  if (g) lines.push(g);
  if (h.rank?.best?.length) lines.push(`Best graded foods he ate: ${h.rank.best.map((f) => `${f.name} (${f.grade.toUpperCase()}, ${f.count}x)`).join(', ')}.`);
  if (h.rank?.worst?.length) lines.push(`Lowest graded: ${h.rank.worst.map((f) => `${f.name} (${f.grade.toUpperCase()}, ${f.count}x)`).join(', ')}.`);
  for (const k of ['sugars', 'salt', 'protein']) {
    const top = h.sources?.[k]?.items?.slice(0, 2) || [];
    if (top.length) lines.push(`Top ${NUTRIENT[k].label.toLowerCase()} sources: ${top.map((s) => `${s.name} ${s.share === null ? '' : `${Math.round(s.share)}%`}`.trim()).join(', ')}.`);
  }
  if (h.top?.length) lines.push(`Most logged: ${h.top.map((f) => `${f.name} (${f.count}x)`).join(', ')}.`);
  lines.push('RI is the EU reference intake for an average adult: a guide, not his target. A "+" means at least that, as some items have no value.');
  const ask = `Give your take on how he has been eating over these ${h.days} days, as a friend looking at the charts with him: three to five short sentences. The pattern, what is going well, and one or two concrete ideas built on foods he already eats. A number or two, not all of them. No greeting, no sign-off, no question.`;
  return { facts: lines.join('\n'), ask, date: h.today };
}

const inflight = new Map();

// { text, at } or { text: null } when there is nothing to say or the coach is off. `view` is "day"
// (with an optional date) or "trends" (with days: 7, 30 or 90).
export async function foodTake({ view = 'day', date = null, days = 7 } = {}) {
  if (!aiEnabled()) return { text: null, off: true };
  if (date && !validDate(String(date))) throw new RuleError('Bad date.');
  const span = HISTORY_SPANS.includes(Number(days)) ? Number(days) : 7;
  const built = view === 'trends' ? await trendFacts(span) : await dayFacts(date || null);
  if (!built) return { text: null };
  const name = view === 'trends' ? `trends-${span}` : 'day';
  const hash = crypto.createHash('sha1').update(`${built.ask}\n${built.facts}`).digest('hex');
  const [kept] = await db()`select text, at, hash from food_takes where view = ${name} and date = ${built.date}`;
  if (kept && kept.hash === hash) return { text: kept.text, at: kept.at };
  const key = `${name}:${built.date}:${hash}`;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      try {
        const text = await writeTake(built.facts, built.ask);
        if (!text) return { text: kept?.text || null, at: kept?.at || null };
        const [row] = await db()`insert into food_takes (view, date, hash, text) values (${name}, ${built.date}, ${hash}, ${text})
          on conflict (view, date) do update set hash = excluded.hash, text = excluded.text, at = now() returning text, at`;
        return { text: row.text, at: row.at };
      } catch (err) {
        console.error('food take error', err.status || '', err.message);
        return { text: kept?.text || null, at: kept?.at || null };
      } finally {
        inflight.delete(key);
      }
    })());
  }
  return inflight.get(key);
}
