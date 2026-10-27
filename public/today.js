// Today's overview: the ring hero and the small charts under it. Each tile opens the page with the
// detail; the day's own lists follow below them (app.js). Plain strings, drawn on every redraw, so
// anything that moves remembers where it was and never replays on a redraw.
import { state, esc, api, icon, rings, RING_MS, ringEase, ringFx, fmtInt, fmtDay, fmtHours, daysBetween, miniRing, safeColor, redrawIfIdle } from './ui.js';
import { NUTRIENT, refOf, drinksRef } from './nutrition.js';

let ctx = { render: () => {} };
export function initToday(c) {
  ctx = { ...ctx, ...c };
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
// One formatter per number of decimals, kept: counts format every frame.
const formats = new Map();
const fmtN = (v, d = 0) => {
  if (!formats.has(d)) formats.set(d, new Intl.NumberFormat('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }));
  return formats.get(d).format(v);
};
const compact = (v) => (v >= 1000 ? `${fmtN(v / 1000, v % 1000 ? 1 : 0)}k` : fmtN(v));
const addDay = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Fibre has no EU reference intake; 25 g is EFSA's adequate intake for adults, shown as a reference.
const FIBRE_REF = 25;

// ---------- The week behind the tiles ----------

// Apple Health and food for the last seven days, fetched in the background at most every ten minutes.
// Today's own numbers always come from the live day, so only the days before it can be a little old.
const STALE = 10 * 60000;
let loading = false;
export function loadOverview(t) {
  const o = state.overview;
  if (loading || state.offline || (o && Date.now() - o.at < STALE)) return;
  loading = true;
  const health = t.health?.connected ? api('GET', '/api/health?days=7') : Promise.resolve(null);
  Promise.allSettled([health, api('GET', '/api/food/history?days=7')]).then(([h, f]) => {
    state.overview = {
      at: Date.now(),
      health: h.status === 'fulfilled' ? h.value : o?.health || null,
      food: f.status === 'fulfilled' ? f.value : o?.food || null,
    };
    redrawIfIdle('today', ctx.render);
  }).finally(() => { loading = false; });
}

// ---------- Numbers that count with the rings ----------

// A number that counts up on the rings' clock and curve: from 0 the first time it is seen this
// session, from its old value when it changes, and a redraw in the middle carries on the count.
const tallies = new Map();
const tn = (key, v, d = 0) => `<span class="tn" data-tally="${key}" data-v="${v}" data-d="${d}">${fmtN(v, d)}</span>`;

function runTallies() {
  const reduce = reduced();
  const now = performance.now();
  document.querySelectorAll('.page-today [data-tally]').forEach((el) => {
    const key = el.dataset.tally;
    const to = Number(el.dataset.v);
    const d = Number(el.dataset.d) || 0;
    const rec = tallies.get(key);
    if (rec?.run && rec.run.to === to) {
      rec.run.el = el;
      el.textContent = fmtN(rec.run.value, d);
      return;
    }
    const from = rec ? (rec.run ? rec.run.value : rec.v) : 0;
    const next = { v: to, run: null };
    tallies.set(key, next);
    if (reduce || from === to || !Number.isFinite(to)) return;
    const run = { el, to, value: from };
    next.run = run;
    el.textContent = fmtN(from, d);
    const step = (ts) => {
      if (next.run !== run) return;
      const p = Math.min(1, Math.max(0, (ts - now) / RING_MS));
      run.value = from + (to - from) * ringEase(p);
      run.el.textContent = fmtN(run.value, d);
      if (p < 1) requestAnimationFrame(step);
      else next.run = null;
    };
    requestAnimationFrame(step);
  });
}

// ---------- Entrances, once per session ----------

// A chart draws itself the first time it is seen: bars rise, a line runs out, the week's days pop
// in. A redraw in the middle carries on from where it was; after that it simply shows.
const entered = new Map();
const ENTER_MS = 900;
function runEntrances() {
  if (reduced()) return;
  const now = performance.now();
  document.querySelectorAll('.page-today [data-enter]').forEach((el) => {
    const key = el.dataset.enter;
    if (!entered.has(key)) entered.set(key, now);
    const t = now - entered.get(key);
    if (t >= ENTER_MS + 400) return;
    const kind = el.dataset.kind;
    try {
      if (kind === 'bars') {
        el.querySelectorAll('.oc-bar, .oc-none').forEach((b, i) => {
          const a = b.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], { duration: 640, delay: 140 + i * 45, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' });
          a.currentTime = t;
        });
      } else if (kind === 'line') {
        const a = el.animate([{ clipPath: 'inset(-8px 100% -8px 0)' }, { clipPath: 'inset(-8px -8px -8px 0)' }], { duration: ENTER_MS, delay: 120, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'backwards' });
        a.currentTime = t;
      } else if (kind === 'split') {
        const a = el.animate([{ clipPath: 'inset(0 100% 0 0 round 4px)' }, { clipPath: 'inset(0 0 0 0 round 4px)' }], { duration: 720, delay: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' });
        a.currentTime = t;
      } else if (kind === 'dots') {
        el.querySelectorAll('.wk-dot').forEach((b, i) => {
          const a = b.animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 520, delay: 120 + i * 50, easing: 'cubic-bezier(0.34, 1.45, 0.64, 1)', fill: 'backwards' });
          a.currentTime = t;
        });
      }
    } catch { /* no Web Animations: the chart simply shows */ }
  });
}

// ---------- The ring hero ----------

let lastOpen = null;
let allDoneDue = false;

function lg(cls, label, val, unit, sub) {
  return `<div class="lg ${cls}"><span class="lg-label"><i class="lg-dot" aria-hidden="true"></i>${label}</span>
    <span class="lg-val">${val}${unit ? `<small>${unit}</small>` : ''}</span><span class="lg-sub">${sub}</span></div>`;
}

// Movement: steps against the Health goal, or the average habit strength before Health is linked.
function moveRing(t) {
  const h = t.health;
  if (h?.connected && num(h.steps) !== null) {
    const goal = h.goals?.steps || 10000;
    return {
      pct: (h.steps / goal) * 100,
      legend: lg('r-move', 'Steps', tn('steps', h.steps), `/${compact(goal)}`, num(h.exercise_min) ? `${Math.round(h.exercise_min)} min exercise` : 'Apple Health'),
    };
  }
  const list = t.items.filter((i) => i.strength !== undefined);
  const avg = list.length ? Math.round(list.reduce((n, i) => n + i.strength, 0) / list.length) : 0;
  return {
    pct: avg,
    legend: lg('r-move', 'Strength', tn('strength', avg), '%', list.length ? `Average of ${list.length} ${list.length === 1 ? 'habit' : 'habits'}` : 'No habits yet'),
  };
}

// HP, the day and movement on one set; energy, protein, fibre and water on the other, against his
// needs or the EU reference intakes (a guide, not his target). Water counts every drink's ml against a
// reference (nutrition.js drinksRef). foot: the stakes line under both, as HTML.
export function ringHero(t, food, foot) {
  const g = t.game;
  const p = t.progress;
  const dayPct = p.total ? (p.done / p.total) * 100 : 0;
  const dayDone = p.total > 0 && p.done >= p.total;
  const ticked = state.justTicked;
  state.justTicked = false;
  // Everything due today done, by this tick: the day's ring says so as it closes. With a miss on the
  // books the ring cannot close, so the moment is sent once the sweep lands instead.
  const allDone = ticked && lastOpen > 0 && p.open === 0 && p.total > 0;
  if (allDone && !dayDone) allDoneDue = true;
  lastOpen = p.open;
  const seasonDay = daysBetween(g.seasonStart, t.today) + 1;
  const lowHp = g.hp <= 30;
  const move = moveRing(t);
  const daySub = !p.total ? 'Nothing due today' : dayDone ? 'All done' : p.open === 0 ? 'Nothing left open' : p.atStake ? `${p.atStake} HP at stake` : `${p.open} still open`;
  const daySet = rings([
    { pct: (g.hp / g.maxHp) * 100, cls: 'r-hp', close: true },
    { pct: dayPct, cls: `r-day${dayDone ? ' done' : ''}`, key: 'r-day', close: true, fx: allDone ? 'all-done' : 'ring-close' },
    { pct: move.pct, cls: 'r-move', close: true },
  ], { set: 'day', center: `<b${g.hp >= 100 ? ' class="wide"' : ''}>${tn('hp-c', g.hp)}</b><span>HP</span>` });

  const n = food?.total || null;
  // With his body set, each ring is against his own daily need, and energy may close too.
  const need = food?.needs || null;
  const fuel = need ? [
    ['kcal', 'Energy', 'r-kcal', refOf('kcal', need), ' kcal', 'need', true],
    ['protein', 'Protein', 'r-pro', refOf('protein', need), ' g', 'need', true],
    ['fibre', 'Fibre', 'r-fib', refOf('fibre', need), ' g', 'need', true],
  ] : [
    ['kcal', 'Energy', 'r-kcal', NUTRIENT.kcal.ri, ' kcal', 'RI', false],
    ['protein', 'Protein', 'r-pro', NUTRIENT.protein.ri, ' g', 'RI', true],
    ['fibre', 'Fibre', 'r-fib', FIBRE_REF, ' g', 'ref', true],
  ];
  fuel.push(['water', 'Water', 'r-water', drinksRef(need), ' ml', 'ref', true]);
  const fuelRows = fuel.map(([k, label, cls, ref, unit, word, close]) => {
    // Water is the ml of every drink logged. No drinks logged is not known to be none drunk, so "–".
    const v = k === 'water' ? (num(food?.drinksMl) > 0 ? food.drinksMl : null) : num(n?.[k]);
    const plus = v !== null && n?.missing?.[k] ? '<i class="lg-plus" title="Some entries have no value">+</i>' : '';
    const pct = v === null ? 0 : (v / ref) * 100;
    // "92% of your need", "92% of RI"; fibre without a body names its reference, as it is not an RI.
    const of = word === 'need' ? 'your need' : word === 'RI' ? 'RI' : `${fmtInt(ref)}${unit}`;
    const sub = v === null ? (food?.entries?.length === 0 && k === 'kcal' ? 'Nothing logged yet' : `${fmtInt(ref)}${unit} ${word}`) : `${Math.round(pct)}% of ${of}`;
    return {
      ring: { pct, cls, close },
      legend: lg(cls, label, v === null ? '<span class="na">–</span>' : `${tn(`f-${k}`, Math.round(v))}${plus}`, v === null ? '' : unit, sub),
    };
  });
  // The food day arrives a moment after the rest: until then its rings wait, so its arrival is their
  // first sweep and not a change to celebrate.
  const fuelSet = rings(fuelRows.map((f) => f.ring), { set: 'fuel', center: icon('food'), ready: Boolean(food) });

  return `<section class="card rings-card${lowHp ? ' low' : ''}${ticked ? ' ticked' : ''}">
    <div class="rc-set rc-day">${daySet}<div class="legend">
      ${lg(`r-hp${lowHp ? ' low' : ''}`, 'HP', tn('hp', g.hp), `/${g.maxHp}`, `Season ${g.season}, day ${seasonDay}`)}
      ${lg(`r-day${dayDone ? ' done' : ''}`, 'Today', tn('done', p.done), `/${p.total}`, daySub)}
      ${move.legend}
    </div></div>
    <a class="rc-set rc-fuel" href="#/food">${fuelSet}<div class="legend">${fuelRows.map((f) => f.legend).join('')}</div>${icon('chevron', 'chev')}</a>
    ${foot ? `<p class="rings-foot">${foot}</p>` : ''}
  </section>`;
}

// ---------- Small charts ----------

// Columns in a percentage-wide SVG with no viewBox: widths stretch with the tile, heights and
// corners stay in real pixels. Each column is rounded at its top and square on the baseline. A day
// with no reading is a short dotted stub, never a zero. ref: a goal or an average, as a hairline.
function columns(values, { key, labels, titles, fmt, unit = '', ref = null, refLabel = '', refText = null, label, cls = '' }) {
  const H = 54;
  const real = values.filter((v) => v !== null && v !== undefined);
  const max = Math.max(ref || 0, ...real, 1) * 1.1;
  const n = values.length || 1;
  const slot = 100 / n;
  const bw = slot * 0.6;
  const y = (v) => H - (v / max) * H;
  const bars = values.map((v, i) => {
    const x = `${(i * slot + (slot - bw) / 2).toFixed(2)}%`;
    const tip = `<title>${esc(titles[i])}: ${v === null || v === undefined ? 'no reading' : `${fmt(v)}${unit}`}</title>`;
    if (v === null || v === undefined) return `<rect x="${x}" y="${H - 2}" width="${bw.toFixed(2)}%" height="2" rx="1" class="oc-none">${tip}</rect>`;
    const h = Math.max(3, (v / max) * H);
    const met = refLabel === 'goal' && v >= ref ? ' met' : '';
    return `<rect x="${x}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(2)}%" height="${(h + 4).toFixed(1)}" rx="4" class="oc-bar${i === n - 1 ? ' cur' : ''}${met}">${tip}</rect>`;
  }).join('');
  const refY = ref ? y(ref) : null;
  const refLine = ref ? `<line x1="0" x2="100%" y1="${refY.toFixed(1)}" y2="${refY.toFixed(1)}" class="oc-ref"/>` : '';
  const spoken = values.map((v, i) => `${titles[i]} ${v === null || v === undefined ? 'no reading' : `${fmt(v)}${unit}`}`).join(', ');
  return `<div class="ov-chart ${cls}">
    <div class="oc-plot"><svg width="100%" height="${H}" role="img" aria-label="${esc(`${label}${ref ? `, ${refLabel} ${fmt(ref)}${unit}` : ''}. ${spoken}`)}" data-enter="${key}" data-kind="bars">${refLine}${bars}</svg>
      ${ref ? `<span class="oc-ref-label" style="bottom:${(((H - refY) / H) * 100).toFixed(1)}%" aria-hidden="true">${esc(refText ?? compact(ref))}</span>` : ''}</div>
    <div class="oc-axis" aria-hidden="true">${labels.map((l, i) => `<span${i === n - 1 ? ' class="cur"' : ''}>${esc(l)}</span>`).join('')}</div>
  </div>`;
}

// A line with a wash under it and a dot on its last point, on a fixed 0 to max scale so a fall
// looks like one. The line keeps 2 px however wide the tile is.
function spark(values, { key, max, titles, unit, label }) {
  const n = values.length;
  if (n < 2) return '';
  const H = 40;
  const pts = values.map((v, i) => [(i / (n - 1)) * 100, H - 3 - (Math.max(0, Math.min(max, v)) / max) * (H - 6)]);
  const line = pts.map(([x, yy], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${yy.toFixed(2)}`).join(' ');
  const area = `${line} L100 ${H} L0 ${H} Z`;
  const [lx, ly] = pts[n - 1];
  const hits = pts.map(([x], i) => `<rect x="${Math.max(0, x - 50 / (n - 1)).toFixed(2)}" y="0" width="${(100 / (n - 1)).toFixed(2)}" height="${H}" class="sp-hit"><title>${esc(titles[i])}: ${values[i]}${unit}</title></rect>`).join('');
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `<div class="ov-spark" data-enter="${key}" data-kind="line">
    <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${label}: from ${values[0]} to ${values[n - 1]}${unit}, low ${lo}, high ${hi}`)}">
      <defs><linearGradient id="sp-wash-${key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sp-w0"/><stop offset="1" class="sp-w1"/></linearGradient></defs>
      <line x1="0" x2="100" y1="${H - 0.5}" y2="${H - 0.5}" class="sp-base"/>
      <path d="${area}" class="sp-area" fill="url(#sp-wash-${key})"/><path d="${line}" class="sp-line"/>${hits}</svg>
    <i class="sp-dot" style="left:${lx}%;top:${((ly / H) * 100).toFixed(1)}%" aria-hidden="true"></i></div>`;
}

const tile = (href, cls, ic, label, body) => `<a class="card ov-tile ${cls}" href="${href}">
  <span class="ov-h">${icon(ic)}<span>${label}</span>${icon('chevron', 'chev')}</span>${body}</a>`;
const big = (val, unit = '') => `<span class="ov-v">${val}${unit ? `<small>${unit}</small>` : ''}</span>`;
const sub = (s) => `<span class="ov-sub">${s}</span>`;
const dayLetter = (date) => fmtDay(date, { weekday: 'narrow' });

// ---------- Tiles ----------

// What is left of today on the calendar: events still on or ahead, and the deadlines among them.
// rows come from the schedule (app.js), already in time order.
export function nextTile(rows, allDay, now) {
  const ahead = rows.filter((r) => !r.past);
  const shown = ahead.slice(0, 3);
  const more = ahead.length - shown.length;
  const chips = allDay.slice(0, 2).map((e) => `<span class="nx-chip"${safeColor(e.color) ? ` style="--c:${safeColor(e.color)}"` : ''}>${esc(e.title)}</span>`).join('');
  const list = shown.map((r) => {
    const on = r.kind === 'event' && r.time <= now;
    return `<li class="nx-row ${r.kind}${on ? ' on' : ''}"><span class="nx-time">${on ? 'Now' : esc(r.time)}</span>
      <i class="nx-bar"${safeColor(r.color) ? ` style="--c:${safeColor(r.color)}"` : ''}></i>
      <span class="nx-body"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></li>`;
  }).join('');
  const body = `${chips ? `<span class="nx-chips">${chips}</span>` : ''}
    ${list ? `<ol class="nx-list">${list}</ol>` : `<span class="nx-empty">Nothing else on today</span>`}
    ${more > 0 ? sub(`${more} more today`) : ''}`;
  return tile('#/calendar', 'ov-next', 'calendar', 'Next today', body);
}

// The day's energy and how it splits between protein, carbs and fat. Energy a macro can't account
// for (a line with no value for it) is shown hatched as unknown, never shared out.
function foodTile(food) {
  const t = food?.total;
  const kcal = num(t?.kcal);
  if (!food || kcal === null || !food.entries?.length) {
    return tile('#/food', 'ov-food', 'food', 'Food', `${big('<span class="na">–</span>')}${sub(food ? 'Nothing logged yet' : 'Loading')}`);
  }
  const parts = [['protein', 'Protein', 4], ['carbs', 'Carbs', 4], ['fat', 'Fat', 9]].map(([k, label, per]) => ({ k, label, kcal: (num(t[k]) || 0) * per }));
  const known = parts.reduce((a, x) => a + x.kcal, 0);
  const gaps = parts.some((x) => num(t[x.k]) === null || t.missing?.[x.k]);
  const rest = gaps ? Math.max(0, kcal - known) : 0;
  if (rest >= 1) parts.push({ k: 'unknown', label: 'Unknown', kcal: rest });
  const sum = parts.reduce((a, x) => a + x.kcal, 0);
  const live = parts.filter((x) => x.kcal > 0);
  const share = (x) => (sum > 0 ? Math.round((x.kcal / sum) * 100) : 0);
  const spoken = live.map((x) => `${x.label} ${share(x)}%`).join(', ');
  const split = sum > 0 ? `<div class="ov-split" role="img" aria-label="${esc(`Energy split: ${spoken}`)}" data-enter="split" data-kind="split">
      ${live.map((x) => `<i class="m-${x.k}" style="flex-grow:${x.kcal.toFixed(1)}"></i>`).join('')}</div>
    <span class="ov-key" aria-hidden="true">${live.map((x) => `<span><i class="m-${x.k}"></i>${x.label} ${share(x)}%</span>`).join('')}</span>` : '';
  return tile('#/food', 'ov-food', 'food', 'Food', `${big(tn('kcal', Math.round(kcal)), 'kcal')}${split}`);
}

// Energy over the last seven days, today live, against the average of the days before it. A day the
// history has not brought yet is a gap like a day with nothing logged.
function energyTile(t, food, hist) {
  const dates = Array.from({ length: 7 }, (_, i) => addDay(t.today, i - 6));
  const byDate = new Map((hist?.series || []).map((d) => [d.date, d]));
  const today = food?.entries?.length ? num(food.total?.kcal) : null;
  const values = dates.map((d) => (d === t.today ? today : num(byDate.get(d)?.kcal)));
  const avg = num(hist?.avg?.kcal);
  const diff = avg && today ? Math.round(((today - avg) / avg) * 100) : null;
  let note = '';
  if (diff !== null) note = diff === 0 ? 'Today on the average' : `Today ${Math.abs(diff)}% ${diff > 0 ? 'above' : 'below'}`;
  else if (hist) note = hist.loggedDays ? `${hist.loggedDays} ${hist.loggedDays === 1 ? 'day' : 'days'} logged` : 'Nothing logged this week';
  const chart = columns(values, {
    key: 'energy', label: 'Energy, last 7 days', titles: dates.map((d) => fmtDay(d)), labels: dates.map((d) => dayLetter(d)),
    fmt: (v) => fmtInt(v), unit: ' kcal', ref: avg, refLabel: 'average', cls: 'c-kcal',
  });
  return tile('#/food/trends', 'ov-energy', 'trend', 'Energy', `${avg ? big(tn('kcal-avg', Math.round(avg)), 'avg') : big('<span class="na">–</span>')}${chart}${note ? sub(note) : ''}`);
}

// HP at the end of each recent day, and now.
function hpTile(t) {
  const g = t.game;
  const days = (t.recentDays || []).slice(-13);
  const values = [...days.map((d) => d.hp_end), g.hp];
  const titles = [...days.map((d) => fmtDay(d.date)), 'Now'];
  const weekAgo = days.length >= 7 ? days[days.length - 7] : days[0];
  const diff = weekAgo ? g.hp - weekAgo.hp_end : null;
  const note = diff === null ? `Season ${g.season}` : diff === 0 ? 'Level with a week ago' : `${diff > 0 ? 'Up' : 'Down'} ${Math.abs(diff)} on a week ago`;
  const chart = spark(values, { key: 'hp', max: g.maxHp, titles, unit: ' HP', label: `HP over the last ${values.length} days` });
  return tile('#/review', `ov-hp${g.hp <= 30 ? ' low' : ''}`, 'heart', 'HP', `${big(tn('hp-t', g.hp), `/${g.maxHp}`)}${chart}${sub(note)}`);
}

// This week, Monday first: clean days, misses, rest, today in progress, and what is still to come.
function weekTile(t) {
  const byDate = new Map((t.recentDays || []).map((d) => [d.date, d]));
  const dow = (new Date(`${t.today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDay(t.today, -dow);
  const p = t.progress;
  const cells = Array.from({ length: 7 }, (_, i) => {
    const date = addDay(start, i);
    if (date > t.today) return { date, s: 'future', label: 'To come' };
    if (date === t.today) {
      if (t.rest) return { date, s: 'rest today', label: 'Rest day' };
      return { date, s: 'today', label: p.total ? `${p.done} of ${p.total} done so far` : 'Nothing due', pct: p.total ? (p.done / p.total) * 100 : 0 };
    }
    const d = byDate.get(date);
    if (!d) return { date, s: 'none', label: 'No record' };
    if (d.rest) return { date, s: 'rest', label: 'Rest day' };
    if (d.clean) return { date, s: 'clean', label: 'Clean' };
    if (d.missed > 0) return { date, s: 'missed', label: `${d.missed} missed` };
    return { date, s: 'quiet', label: 'Nothing due' };
  });
  const closed = cells.filter((c) => ['clean', 'missed', 'quiet'].includes(c.s));
  const clean = cells.filter((c) => c.s === 'clean').length;
  // Clean days in a row up to yesterday; rest days neither break nor add to it.
  let run = 0;
  for (const d of [...(t.recentDays || [])].reverse()) {
    if (d.rest) continue;
    if (!d.clean) break;
    run += 1;
  }
  const note = run >= 2 ? `${run} clean in a row` : run === 1 ? 'Clean yesterday' : closed.length ? 'A clean day starts a run' : 'The week starts today';
  const dots = cells.map((c) => {
    const inner = c.s === 'today' ? miniRing(c.pct, 26) : c.s === 'clean' ? icon('check') : c.s === 'missed' ? icon('close') : '';
    return `<span class="wk-day ${c.s}" title="${esc(`${fmtDay(c.date)}: ${c.label}`)}"><span class="wk-dot">${inner}</span><span class="wk-l">${esc(dayLetter(c.date))}</span></span>`;
  }).join('');
  const spoken = cells.map((c) => `${fmtDay(c.date, { weekday: 'long' })} ${c.label}`).join(', ');
  const val = closed.length ? big(tn('clean-week', clean), ` of ${closed.length} clean`) : big(tn('clean-week', clean), ' clean');
  return tile('#/plan', 'ov-week', 'today', 'This week', `${val}<span class="wk" role="img" aria-label="${esc(spoken)}" data-enter="week" data-kind="dots">${dots}</span>${sub(note)}`);
}

// Steps and sleep for the last seven days from Apple Health, today live.
function healthTiles(t, hist) {
  const h = t.health;
  if (!h) return '';
  if (!h.connected) {
    return `<a class="card ov-tile ov-connect" href="#/health?section=health">
      <span class="connect-ic">${icon('heart')}</span>
      <span><b>Connect Apple Health</b><span class="li-sub">Steps, sleep and workouts</span></span>${icon('chevron', 'chev')}</a>`;
  }
  const days = hist?.days?.length ? hist.days.slice(-7) : [{ date: t.today, steps: h.steps, sleep_hours: h.sleep_hours }];
  const goals = h.goals || {};
  const series = (k) => days.map((d) => (d.date === t.today ? num(h[k]) : num(d[k])));
  const avgOf = (vals) => {
    const past = vals.slice(0, -1).filter((v) => v !== null);
    return past.length ? past.reduce((a, v) => a + v, 0) / past.length : null;
  };
  const titles = days.map((d) => fmtDay(d.date));
  const labels = days.map((d) => dayLetter(d.date));
  const steps = series('steps');
  const stepsAvg = avgOf(steps);
  const sleep = series('sleep_hours');
  const sleepAvg = avgOf(sleep);
  const stepsTile = tile('#/health', 'ov-steps', 'steps', 'Steps',
    `${num(h.steps) !== null ? big(tn('steps-t', h.steps)) : big('<span class="na">–</span>')}
    ${columns(steps, { key: 'steps', label: 'Steps, last 7 days', titles, labels, fmt: fmtInt, ref: goals.steps || null, refLabel: 'goal', cls: 'c-move' })}
    ${sub(stepsAvg === null ? 'No days before today' : `Average ${fmtInt(stepsAvg)}`)}`);
  const sleepTile = tile('#/health', 'ov-sleep', 'moon', 'Sleep',
    `${num(h.sleep_hours) !== null ? big(esc(fmtHours(h.sleep_hours))) : big('<span class="na">–</span>', 'no reading')}
    ${columns(sleep, { key: 'sleep', label: 'Sleep, last 7 nights', titles, labels, fmt: (v) => fmtHours(v), ref: goals.sleep_hours || null, refLabel: 'goal', refText: `${fmtN(goals.sleep_hours, goals.sleep_hours % 1 ? 1 : 0)}h`, cls: 'c-sleep' })}
    ${sub(sleepAvg === null ? 'No nights before this one' : `Average ${fmtHours(sleepAvg)}`)}`);
  return stepsTile + sleepTile;
}

// The overview under the hero. next: the calendar tile, shown on the phone (the full schedule sits in
// the side column on wide screens).
export function overview(t, food, next = '') {
  loadOverview(t);
  const o = state.overview;
  return `<section class="ov" aria-label="Overview">
    ${next ? `<div class="ov-wide only-narrow">${next}</div>` : ''}
    ${foodTile(food)}${energyTile(t, food, o?.food)}
    ${hpTile(t)}${weekTile(t)}
    ${healthTiles(t, o?.health)}
  </section>`;
}

// After Today is drawn: numbers count, charts that are new draw themselves, and an all-done with a
// miss on the books still gets its moment once the rings have landed.
export function afterToday() {
  runTallies();
  runEntrances();
  if (allDoneDue) {
    allDoneDue = false;
    setTimeout(() => ringFx('all-done'), reduced() ? 0 : RING_MS);
  }
}
