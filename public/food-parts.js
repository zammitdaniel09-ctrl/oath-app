// The pieces every Food screen draws with: meal slots and record kinds, numbers, grades and badges,
// values and reference intakes, the nutrition facts label, the hand-made SVG rings and bars, and the
// small controls of the sheets. Every number comes from nutrition.js.
import { state, num, esc, icon, cap, fmtDay } from './ui.js';
import * as N from './nutrition.js';
import { show, round, NUTRIENT, NUTRIENTS, unitsFor, line } from './nutrition.js';
import { foodTags } from './food-tags.js';
import { rowTag } from './food-tagdb.js';

export const SLOTS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks'], ['drinks', 'Drinks']];
export const SLOT = Object.fromEntries(SLOTS);
const KIND = { generic: 'Generic', product: 'Product', custom: 'Yours', label: 'From your label', estimate: 'Estimate' };
// Generic foods from a table other than USDA say which in search results.
export const SOURCE_TAG = { cofid: 'UK table', ciqual: 'French table' };
export const STRIP = ['protein', 'carbs', 'fat', 'sugars', 'fibre', 'salt'];
export const FAMILIES = {
  'breakfast-fruit-oats': 'Fruit, oats and yogurt', 'breakfast-eggs': 'Eggs and hot breakfasts', sandwiches: 'Sandwiches and wraps',
  lunches: 'Salads and packed lunches', pasta: 'Pasta', bakes: 'Bakes', rice: 'Rice and grains', noodles: 'Noodles and stir-fries',
  sides: 'Potatoes and sides', chicken: 'Chicken and turkey', meat: 'Beef, pork and lamb', fish: 'Fish and seafood',
  vegetarian: 'Beans, lentils and tofu', soups: 'Soups and stews', 'pizza-pies': 'Pizza and pies', sweets: 'Sweet things',
  maltese: 'Maltese', shakes: 'Shakes and smoothies', components: 'Sauces and components', 'saved-meals': 'Simple combinations',
};
export const STATUS = { 'ai-untested': 'Not kitchen-tested', 'user-reviewed': 'Reviewed by you', tested: 'Kitchen-tested', imported: 'Imported from a link' };
export const BUILDERS = {
  shake: { title: 'Shake', icon: 'blend', groups: [['liquid', 'Liquid'], ['powder', 'Powder'], ['fruit', 'Fruit'], ['add', 'Additions']] },
  bowl: { title: 'Fruit bowl', icon: 'bowl', groups: [['fruit', 'Fruit'], ['add', 'Extras']] },
  plate: { title: 'Plate', icon: 'food', groups: [['protein', 'Protein'], ['starch', 'Starch'], ['veg', 'Vegetables'], ['sauce', 'Sauce or oil']] },
  meal: { title: 'Meal', icon: 'food', groups: [['all', 'Foods']] },
};

export const f = () => state.food || (state.food = { date: null });
export const enc = encodeURIComponent;
export const kcal = (n) => show(n, 'kcal');

let uid = 0;
export const nextId = (p) => `${p}${(uid += 1)}`;
export const fmtN = (v, dec = 0) => (num(v) === null ? '–' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: dec }).format(round(v, dec)));
export const share = (v, sum) => (sum > 0 ? Math.round((v / sum) * 100) : 0);

export function strip(n, keys = STRIP, filled = null) {
  return `<dl class="nstrip">${keys.map((k) => `<div><dt>${NUTRIENT[k].label}</dt><dd>${val(n, k, filled)}</dd></div>`).join('')}</dl>`;
}

// ---------- Grades, NOVA and tags ----------

export const GRADES = ['a', 'b', 'c', 'd', 'e'];
export const gradeOf = (x) => {
  const g = String((typeof x === 'string' ? x : x?.grade) || '').toLowerCase();
  return GRADES.includes(g) ? g : null;
};
export const safely = (fn) => {
  try { return fn(); } catch { return null; }
};
export const itemGrade = (it) => (it ? gradeOf(it.nutriscore) || gradeOf(safely(() => N.nutriScore?.(it.nutrients, { category: it.category, liquid: it.liquid }))) : null);
export const itemTags = (it) => {
  if (!it) return [];
  const t = Array.isArray(it.tags) ? it.tags : safely(() => foodTags(it));
  return Array.isArray(t) ? t.filter((x) => x?.label) : [];
};
const novaOf = (x) => {
  const v = Number(x);
  return v >= 1 && v <= 4 ? Math.round(v) : null;
};

// A grade as a small lettered square in the official colour; an empty outline when there is none.
export function gradeDot(g, cls = '') {
  return g ? `<span class="ns-dot ns-${g}${cls}" role="img" aria-label="Nutri-Score ${g.toUpperCase()}">${g.toUpperCase()}</span>`
    : `<span class="ns-dot ns-none${cls}" aria-hidden="true"></span>`;
}

// The Nutri-Score as packs show it: five letters, the food's own one raised.
export function nutriBadge(g) {
  if (!g) return '';
  return `<span class="nscore" role="img" aria-label="Nutri-Score ${g.toUpperCase()}"><span class="nscore-name" aria-hidden="true">Nutri-Score</span>
    <span class="nscore-row" aria-hidden="true">${GRADES.map((x) => `<i class="ns-${x}${x === g ? ' on' : ''}">${x.toUpperCase()}</i>`).join('')}</span></span>`;
}

export function novaBadge(v) {
  const n = novaOf(v);
  return n ? `<span class="nova nova-${n}" role="img" aria-label="NOVA group ${n}"><small aria-hidden="true">NOVA</small><b aria-hidden="true">${n}</b></span>` : '';
}

export const tagMini = (t) => (t ? `<span class="ftag-mini t-${esc(t.tone || 'neutral')}">${esc(t.label)}</span>` : '');
// The one tag a row shows (food-tagdb.js).
export const topTag = rowTag;

// ---------- Values, estimates and reference intakes ----------

export const filledSet = (x) => (x instanceof Set ? x : new Set(Array.isArray(x) ? x : []));
// A value with its marks: "~" when an estimate filled it, "+" (from show) when it is a floor.
export const val = (n, k, filled, opts) => `${filledSet(filled).has(k) && num(n?.[k]) !== null ? '<i class="est" title="Estimated">~</i>' : ''}${show(n, k, opts)}`;

// A record with an estimate's per-100 values filled into the gaps it has, and which keys were filled.
export function withFill(item, fill) {
  const filled = new Set();
  if (!item || !fill) return { item, filled };
  const nutrients = { ...item.nutrients };
  for (const [k, v] of Object.entries(fill)) {
    if (NUTRIENT[k] && num(nutrients[k]) === null && num(v) !== null) {
      nutrients[k] = v;
      filled.add(k);
    }
  }
  return { item: { ...item, nutrients }, filled };
}

// What 100% stands for: his own daily need once his body is set (Settings, Body), else the EU RI.
export const needs = () => f().day?.needs || f().trend?.needs || state.foodToday?.needs || null;
export const refAt = (k) => N.refOf(k, needs());
export const riWord = () => (needs() ? 'need' : 'RI');
export const riPct = (n, k) => {
  const ri = refAt(k);
  const v = num(n?.[k]);
  return ri && v !== null ? (v / ri) * 100 : null;
};
export const pctText = (p, floor) => (p === null ? '–' : `${fmtN(p, p > 0 && p < 10 ? 1 : 0)}%${floor ? '+' : ''}`);
// Sugars, saturates and salt are amounts to stay under; vitamins, minerals and protein to reach.
const LIMITS = new Set(['satfat', 'sugars', 'salt']);
const REACH = (k) => k === 'protein' || ['mineral', 'vitamin'].includes(NUTRIENT[k]?.group);
export const riTone = (p, k) => (p === null || p < 100 ? '' : LIMITS.has(k) ? ' over' : REACH(k) ? ' full' : '');
// Where a % of need sits along a bar: straight up to the need, which sits at RI_AT of the width; past
// it the scale eases off, so 150%, 300% and 1,000% all fit and still read apart (300% is near 87%).
export const RI_AT = 62;
export const riPos = (p) => (p <= 100 ? (Math.max(0, p) / 100) * RI_AT : RI_AT + (100 - RI_AT) * (1 - 100 / p));
export function riBar(p, k) {
  if (p === null) return '<span class="ri-bar none" aria-hidden="true"></span>';
  return `<span class="ri-bar${riTone(p, k)}" aria-hidden="true" style="--at:${RI_AT}%"><i style="--p:${riPos(p).toFixed(1)}"></i><b class="ri-mark"></b></span>`;
}

const SHORT = {
  kcal: 'Energy', satfat: 'Saturates', mufa: 'Monounsaturates', pufa: 'Polyunsaturates', transfat: 'Trans fat', chol: 'Cholesterol',
  carbs: 'Carbohydrate', addsugars: 'Added sugars', vita: 'Vit A', vitc: 'Vit C', vitd: 'Vit D', vite: 'Vit E', vitk: 'Vit K',
  b1: 'Thiamin', b2: 'Riboflavin', b3: 'Niacin', b6: 'Vit B6', b12: 'Vit B12', folate: 'Folate',
};
export const shortLabel = (k) => SHORT[k] || NUTRIENT[k]?.label || k;

// ---------- Nutrition facts: the label, then minerals, vitamins and anything else ----------

export const LABEL_ROWS = [['kcal'], ['fat'], ['satfat', 1], ['mufa', 1], ['pufa', 1], ['transfat', 1], ['chol', 1], ['carbs'], ['sugars', 1], ['addsugars', 1], ['fibre'], ['protein'], ['salt']];
// On the label the fats and carbohydrates read as they do on a pack; vitamins keep their full names.
const FACT_NAME = {
  kcal: 'Energy', satfat: 'Saturates', mufa: 'Monounsaturates', pufa: 'Polyunsaturates', transfat: 'Trans fat', chol: 'Cholesterol',
  carbs: 'Carbohydrate', addsugars: 'Added sugars',
};

// With `tap`, a row with a % of need is a button that opens the foods richest in it.
export function factRow(n, k, sub, filled, tap = false) {
  const d = NUTRIENT[k];
  const p = riPct(n, k);
  const unknown = num(n?.[k]) === null;
  const btn = tap && k !== 'kcal' && refAt(k);
  const tag = btn ? `button type="button" data-action="food-rich" data-key="${k}"` : 'div';
  return `<${tag} class="nf-row${sub ? ' sub' : ''}${unknown ? ' unk' : ''}${btn ? ' nf-tap' : ''}"><span class="nf-k">${esc(FACT_NAME[k] || d.label)}${btn ? icon('chevron', 'tap-hint') : ''}</span>
    <span class="nf-v">${val(n, k, filled)}</span><span class="nf-ri">${refAt(k) ? `${riBar(p, k)}<small>${p === null ? '' : pctText(p, n?.missing?.[k])}</small>` : ''}</span></${btn ? 'button' : 'div'}>`;
}

export function factsHtml(n, filled = null, { tap = false } = {}) {
  const fl = filledSet(filled);
  // Sub-rows nobody has a value for are left out; the main rows always show, "–" when unknown.
  const label = LABEL_ROWS.filter(([k, sub]) => !sub || ['satfat', 'sugars'].includes(k) || num(n?.[k]) !== null);
  const group = (g, title) => {
    const all = NUTRIENTS.filter((x) => x.group === g);
    const known = all.filter((x) => num(n?.[x.key]) !== null);
    const rest = all.length - known.length;
    return `<div class="nf-group"><h4 class="nf-h">${title}</h4>${known.map((x) => factRow(n, x.key, false, fl, tap)).join('')}
      ${rest ? `<p class="nf-none">${known.length ? `${rest} more not on record` : 'Not on record'}</p>` : ''}</div>`;
  };
  const other = ['caffeine', 'alcohol'].filter((k) => num(n?.[k]) > 0);
  return `<div class="nf-group nf-label"><div class="nf-cols" aria-hidden="true"><span></span><span></span><span>% ${riWord()}</span></div>
      ${label.map(([k, sub]) => factRow(n, k, sub, fl, tap)).join('')}</div>
    ${group('mineral', 'Minerals')}${group('vitamin', 'Vitamins')}
    ${other.length ? `<div class="nf-group"><h4 class="nf-h">Other</h4>${other.map((k) => factRow(n, k, false, fl)).join('')}</div>` : ''}`;
}

// ---------- Drawings: rings, bars and timelines, hand-made SVG ----------

// Charts grow in the first time a screen is seen in a session, never on a re-render.
const seen = new Set();
export const enter = (key) => {
  if (seen.has(key)) return '';
  seen.add(key);
  return ' f-enter';
};
// A striped fill for unknown or incomplete parts, drawn in screen pixels so it never stretches.
export const hatchDef = (id, cls = '') => `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" class="fh-bg ${cls}"/><rect width="1.8" height="5" class="fh-line ${cls}"/></pattern>`;

export const MACROS = [['protein', 4], ['carbs', 4], ['fat', 9]];
export const MACRO_LABEL = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat', unknown: 'Unknown' };

// Energy from protein, carbs and fat (4, 4 and 9 kcal a gram). When some lines have no macro values,
// the energy they leave unexplained is its own "unknown" part rather than shared out among the rest.
export function macroParts(n) {
  const parts = MACROS.map(([k, per]) => ({ key: k, kcal: (num(n?.[k]) || 0) * per }));
  const known = parts.reduce((a, p) => a + p.kcal, 0);
  const gaps = MACROS.some(([k]) => num(n?.[k]) === null || n?.missing?.[k]);
  const rest = gaps && num(n?.kcal) !== null ? Math.max(0, n.kcal - known) : 0;
  if (rest >= 1) parts.push({ key: 'unknown', kcal: rest });
  return { parts, sum: parts.reduce((a, p) => a + p.kcal, 0) };
}

// Parts laid end to end round a ring from twelve o'clock, each a rounded arc with a hair of gap before
// the next. Each arc carries a gradient along its length, deep where it starts and lit where it ends;
// unknown energy is striped. `reach` (0 to 1) is how much of the circle they fill together.
function ringArcs({ size, sw, parts, reach = 1, id, hatch }) {
  const c0 = size / 2;
  const r = (size - sw) / 2;
  const live = parts.filter((p) => p.v > 0);
  const sum = live.reduce((a, p) => a + p.v, 0);
  const span = Math.min(1, Math.max(0, reach)) * 2 * Math.PI;
  if (!(sum > 0) || !(span > 0)) return { defs: '', arcs: '' };
  const cap = sw / 2 / r;
  const gap = live.length > 1 ? 2.5 / r : 0;
  const closed = span > 2 * Math.PI - 1e-6;
  const room = span - gap * (closed ? live.length : live.length - 1);
  const pt = (a) => `${(c0 + r * Math.cos(a)).toFixed(2)} ${(c0 + r * Math.sin(a)).toFixed(2)}`;
  let at = -Math.PI / 2;
  let defs = '';
  const arcs = live.map((p, i) => {
    const len = (p.v / sum) * room;
    const a0 = at;
    at += len + gap;
    // The round caps sit inside the part's own length; a part too short for them is a dot.
    const lone = closed && live.length === 1;
    const s = lone ? a0 : a0 + Math.min(cap, len / 2);
    const e = lone ? a0 + len - 1e-3 : a0 + len - Math.min(cap, len / 2);
    const big = e - s > Math.PI ? 1 : 0;
    const d = lone ? `M${pt(s)} A${r} ${r} 0 1 1 ${pt(s + Math.PI)} A${r} ${r} 0 1 1 ${pt(s)}` : `M${pt(s)} A${r} ${r} 0 ${big} 1 ${pt(e)}`;
    let paint = `url(#${hatch})`;
    if (p.key !== 'unknown') {
      const gid = `${id}g${i}`;
      const far = e - s > 4.5 ? s + Math.PI : e;
      defs += `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${pt(s).split(' ')[0]}" y1="${pt(s).split(' ')[1]}" x2="${pt(far).split(' ')[0]}" y2="${pt(far).split(' ')[1]}">
        <stop offset="0" class="g0 m-${p.key}"/><stop offset="1" class="g1 m-${p.key}"/></linearGradient>`;
      paint = `url(#${gid})`;
    }
    return `<path d="${d}" class="fr-arc m-${p.key}" stroke="${paint}" stroke-width="${sw}" stroke-linecap="${lone ? 'butt' : 'round'}" fill="none"/>`;
  }).join('');
  return { defs, arcs };
}

// A ring of rounded arcs with its glow, a track, and whatever goes in the middle. `grow` draws it in.
function ringSvg({ size, sw, parts, reach = 1, label, center = '', grow = false, glow = true, cls = '' }) {
  const id = nextId('fr');
  const hatch = `${id}h`;
  const c0 = size / 2;
  const r = (size - sw) / 2;
  const { defs, arcs } = ringArcs({ size, sw, parts, reach, id, hatch });
  // The draw-in mask reaches past the ring so the glow round it is not cut off.
  const pad = size / 4;
  const mask = grow ? `<mask id="${id}m" maskUnits="userSpaceOnUse" x="${-pad}" y="${-pad}" width="${size + 2 * pad}" height="${size + 2 * pad}"><circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke="#fff"
      stroke-width="${sw * 3}" pathLength="1" class="fr-draw" transform="rotate(-90 ${c0} ${c0})"/></mask>` : '';
  const halo = glow && arcs ? `<filter id="${id}f" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${(sw / 2.4).toFixed(1)}"/></filter>` : '';
  const body = `${halo ? `<g class="fr-glow" filter="url(#${id}f)">${arcs}</g>` : ''}${arcs}`;
  return `<div class="fring${cls}" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
      <defs>${hatchDef(hatch)}${defs}${mask}${halo}</defs><circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke-width="${sw}" class="fr-track"/>
      <g${grow ? ` mask="url(#${id}m)"` : ''}>${body}</g></svg>
    ${center ? `<span class="fring-c" aria-hidden="true">${center}</span>` : ''}</div>`;
}

const macroArcParts = (n) => macroParts(n).parts.map((p) => ({ key: p.key, v: p.kcal }));
export const spokenSplit = (n) => {
  const { parts, sum } = macroParts(n);
  return sum > 0 ? parts.filter((p) => p.kcal > 0).map((p) => `${MACRO_LABEL[p.key]} ${share(p.kcal, sum)}%`).join(', ') : 'nothing logged';
};

// The macro energy split as a whole ring, with whatever goes in the middle.
export function donut(n, { size = 112, sw = 12, center = '', label = 'Energy split', grow = false } = {}) {
  return ringSvg({ size, sw, parts: macroArcParts(n), label: `${label}: ${spokenSplit(n)}`, center, grow });
}

// The day's energy against its need: the arc goes as far round as he has eaten, split by where the
// energy came from. At the need it closes.
export function energyRing(t, need, { size = 168, sw = 15, center = '', grow = false, glow = true } = {}) {
  const kcal = num(t?.kcal) || 0;
  const reach = need > 0 ? kcal / need : kcal > 0 ? 1 : 0;
  const label = `${show(t, 'kcal')} of ${fmtN(need)} kcal, energy from ${spokenSplit(t)}`;
  return ringSvg({ size, sw, parts: macroArcParts(t), reach, label, center, grow, glow, cls: ' fring-energy' });
}

// A food's own small ring: where its energy comes from, with its Nutri-Score letter in the middle.
export function foodRing(n, grade = null) {
  const size = 36;
  const sw = 3.6;
  const c0 = size / 2;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const { parts, sum } = macroParts(n);
  const live = parts.filter((p) => p.kcal > 0);
  const gap = live.length > 1 ? 2.2 : 0;
  let off = 0;
  const arcs = sum > 0 ? live.map((p) => {
    const len = (p.kcal / sum) * c;
    const arc = `<circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke-width="${sw}" class="fr-seg m-${p.key}" stroke-dasharray="${Math.max(0.6, len - gap).toFixed(2)} ${c.toFixed(2)}"
      stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${c0} ${c0})"/>`;
    off += len;
    return arc;
  }).join('') : '';
  const g = gradeOf(grade);
  return `<span class="fmini${g ? ` g-${g}` : ''}" role="img" aria-label="${esc(`${g ? `Nutri-Score ${g.toUpperCase()}. ` : ''}Energy from ${spokenSplit(n)}`)}">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${c0}" cy="${c0}" r="${r}" fill="none" stroke-width="${sw}" class="fr-track"/>${arcs}</svg>
    ${g ? `<b aria-hidden="true">${g.toUpperCase()}</b>` : ''}</span>`;
}

// Energy by Nutri-Score grade as one stacked bar, with each grade's share under it.
export function gradeMix(mix) {
  const parts = [...GRADES, 'none'].map((g) => ({ g, v: num(mix?.[g]) || 0 }));
  const sum = parts.reduce((a, p) => a + p.v, 0);
  if (!(sum > 0)) return '';
  const live = parts.filter((p) => p.v > 0);
  const name = (g) => (g === 'none' ? 'ungraded' : g.toUpperCase());
  const spoken = live.map((p) => `${name(p.g)} ${share(p.v, sum)}%`).join(', ');
  return `<div class="gmix" role="img" aria-label="${esc(`Energy by Nutri-Score: ${spoken}`)}">
    <div class="gmix-bar">${live.map((p) => `<i class="gx-${p.g}" style="flex-grow:${p.v.toFixed(1)}"></i>`).join('')}</div>
    <div class="gmix-key" aria-hidden="true">${live.map((p) => `<span>${gradeDot(p.g === 'none' ? null : p.g, ' sm')}${share(p.v, sum)}%</span>`).join('')}</div></div>`;
}

// One meal's share of the day's energy as a short bar, split by macro.
export function mealBar(n, dayKcal) {
  const k = num(n?.kcal);
  if (!(dayKcal > 0) || !(k > 0)) return '';
  const { parts, sum } = macroParts(n);
  const segs = sum > 0 ? parts.filter((p) => p.kcal > 0).map((p) => `<i class="m-${p.key}" style="flex-grow:${p.kcal.toFixed(1)}"></i>`).join('') : '<i class="m-unknown" style="flex-grow:1"></i>';
  const pc = Math.max(2, Math.min(100, (k / dayKcal) * 100));
  return `<div class="fmeal" role="img" aria-label="${share(k, dayKcal)}% of the day's energy"><span class="fmeal-bar" style="width:${pc.toFixed(1)}%">${segs}</span></div>`;
}

// Energy per day as columns, each split by where its energy came from (protein at the foot, then
// carbs, fat, and striped for energy with no macros on record), or one plain column with `plain`. A day
// with nothing logged is a short dashed mark on the baseline, never a zero bar. Columns are HTML, so
// their rounded tops stay round at any width; the scale tops out at a round number with headroom.
export function barsHtml(series, { height = 150, sel = null, values = false, selValue = true, avg = null, plain = false, mini = false } = {}) {
  const n = series.length || 1;
  const vals = series.map((d) => (d.logged ? num(d.kcal) : null));
  const peak = Math.max(...vals.map((v) => v || 0), num(avg) || 0, 1);
  const step = peak > 1500 ? 500 : peak > 300 ? 100 : 50;
  const max = Math.ceil((peak * (mini ? 1 : 1.1)) / step) * step;
  const pc = (v) => ((v / max) * 100).toFixed(2);
  const cols = series.map((d, i) => {
    const v = vals[i];
    const cls = `fxb-c${d.date === sel ? ' sel' : ''}${d.incomplete ? ' inc' : ''}`;
    if (v === null) return `<span class="${cls} gap"></span>`;
    let segs = '<i class="m-energy"></i>';
    if (!plain) {
      const { parts, sum } = macroParts(d);
      segs = sum > 0 ? parts.filter((p) => p.kcal > 0).map((p) => `<i class="m-${p.key}" style="flex-grow:${p.kcal.toFixed(1)}"></i>`).join('') : '<i class="m-unknown"></i>';
    }
    const label = (values || (selValue && d.date === sel)) && v > 0 ? `<b class="fxb-v">${fmtN(v)}${d.missing?.kcal ? '+' : ''}</b>` : '';
    return `<span class="${cls}" style="--h:${pc(Math.max(v, max / 80))}%;--d:${Math.round((i * 320) / n)}ms">${label}<span class="fxb-bar">${segs}</span></span>`;
  }).join('');
  const avgLine = num(avg) !== null ? `<span class="fxb-avg" style="bottom:${pc(avg)}%"></span>` : '';
  return `<div class="fxb${mini ? ' mini' : ''}${n > 40 ? ' dense' : n > 14 ? ' mid' : ''}" style="height:${height}px" aria-hidden="true">${avgLine}
    <div class="fxb-cols" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${cols}</div></div>`;
}

// The key under a chart of split columns: the parts that are on it, and the average line.
export function barKeys(series, avgText = '') {
  const on = new Set(series.filter((d) => d.logged).flatMap((d) => macroParts(d).parts.filter((p) => p.kcal > 0).map((p) => p.key)));
  const keys = ['protein', 'carbs', 'fat', 'unknown'].filter((k) => on.has(k)).map((k) => `<span><i class="fdot m-${k}"></i>${MACRO_LABEL[k]}</span>`);
  if (series.some((d) => !d.logged)) keys.push('<span><i class="fk fk-gap"></i>No log</span>');
  if (avgText) keys.push(`<span><i class="fk fk-avg"></i>${avgText}</span>`);
  return keys.length ? `<p class="fx-keys">${keys.join('')}</p>` : '';
}

export function axisLabels(series, today) {
  const n = series.length;
  if (n <= 7) {
    return `<div class="fx-axis cols" style="grid-template-columns:repeat(${n},minmax(0,1fr))" aria-hidden="true">${series.map((d) => `<span${d.date === today ? ' class="is-today"' : ''}>${d.date === today ? 'Today' : fmtDay(d.date, { weekday: 'short' })}</span>`).join('')}</div>`;
  }
  const mid = series[Math.floor(n / 2)].date;
  return `<div class="fx-axis" aria-hidden="true"><span>${fmtDay(series[0].date, { day: 'numeric', month: 'short' })}</span><span>${fmtDay(mid, { day: 'numeric', month: 'short' })}</span><span class="is-today">Today</span></div>`;
}

export function kindTag(it) {
  const k = it.kind;
  return `<span class="tag ftag ftag-${k}">${KIND[k] || k}${it.market && k === 'product' ? `, ${esc(it.market)}` : ''}</span>`;
}

export function slotSelect(value) {
  return `<label class="field"><span>Meal</span><select class="input" name="slot">${SLOTS.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
}

export function slotNow(liquid = false) {
  if (liquid) return 'drinks';
  const h = new Date().getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 15) return 'lunch';
  if (h >= 18 && h < 23) return 'dinner';
  return 'snacks';
}

export function unitOptions(item, selected) {
  return unitsFor(item).map((u) => {
    const w = u.g ? ` · ${round(u.g, 1)} g` : u.ml ? ` · ${round(u.ml, 0)} ml` : '';
    return `<option value="${esc(u.unit)}"${u.unit === selected ? ' selected' : ''}>${esc(u.label)}${w}</option>`;
  }).join('');
}

// A sensible first amount: what he logged last time, a pack for packaged drinks (one can of a
// multipack), a "medium" for fruit.
export function defaults(item) {
  const units = unitsFor(item);
  const has = (u) => units.some((x) => x.unit === u);
  if (item.last && has(item.last.unit)) return { qty: item.last.qty, unit: item.last.unit };
  if (item.liquid && item.pack?.unit === 'ml') return item.pack.count > 1 && has('each') ? { qty: 1, unit: 'each' } : { qty: 1, unit: 'pack' };
  if (item.liquid && has('ml')) return { qty: 250, unit: 'ml' };
  if (item.serving) return { qty: 1, unit: 'serving' };
  const medium = units.find((u) => u.unit.startsWith('p:') && /\bmedium\b/i.test(u.label));
  if (medium) return { qty: 1, unit: medium.unit };
  return { qty: 100, unit: item.basis === 'ml' ? 'ml' : 'g' };
}

export function quickChips(item) {
  const units = unitsFor(item);
  const has = (u) => units.some((x) => x.unit === u);
  const chips = [];
  if (item.pack) {
    chips.push([1, 'pack', item.pack.count > 1 ? 'Whole pack' : `${item.pack.unit === 'ml' ? 'Whole' : '1 pack'} (${round(item.pack.size, 0)} ${item.pack.unit})`]);
    chips.push([0.5, 'pack', 'Half']);
    if (item.pack.count > 1) chips.push([1, 'each', `One of ${item.pack.count}`]);
  }
  if (item.serving) chips.push([1, 'serving', item.serving.label || `1 serving (${round(item.serving.size, 0)} ${item.serving.unit})`]);
  if (has('ml')) for (const ml of [250, 330, 500]) chips.push([ml, 'ml', `${ml} ml`]);
  for (const u of units.filter((x) => x.unit.startsWith('p:') && !/US cup/.test(x.label)).slice(0, 3)) chips.push([1, u.unit, u.label.replace(/^1 /, '').replace(/\s*\([^)]*\)\s*$/, '') || u.label]);
  if (!has('ml') || !item.liquid) for (const g of [50, 100]) chips.push([g, 'g', `${g} g`]);
  return chips.slice(0, 8).map(([q, u, l]) => `<button type="button" class="pchip-btn" data-action="food-chip" data-qty="${q}" data-unit="${esc(u)}">${esc(l)}</button>`).join('');
}

export function previewHtml(item, qty, unit, filled = null) {
  const l = line(item, qty, unit);
  if (l.error) return `<p class="note bad">${esc(l.error)}</p>`;
  const amt = l.g !== null && l.basis === 'g' ? `${round(l.g, 1)} g` : l.ml !== null ? `${round(l.ml, 0)} ml` : '';
  return `<div class="fprev"><div class="fprev-main"><b>${val(l.nutrients, 'kcal', filled)}</b><span>${esc(amt)}${l.note ? `, ${esc(l.note)}` : ''}</span></div>
    ${strip(l.nutrients, STRIP, filled)}</div>`;
}

// The facts for a food: the portion on screen, or per 100 of its basis.
export function itemFacts(s) {
  const { item, filled } = withFill(s.item, s.fill);
  if (s.per === '100') return factsHtml(item.nutrients, filled);
  const l = line(item, s.qty, s.unit);
  return l.error ? '' : factsHtml(l.nutrients, filled);
}

export const sourceLine = (it) => `${esc(it.sourceText || it.source || '')}${it.source_date ? `, ${esc(it.source_date)}` : ''}`;

// Where a diary entry's filled values ("~") came from, one short line under its facts: "Vitamins and
// minerals filled from USDA: Cola. Values from mcdonalds.com." The wording is the shared maths'.
export function fillSourceHtml(src) {
  const parts = N.fillSourceParts?.(src) || [];
  if (!parts.length) return '';
  const html = parts.map((p) => `${esc(p.text)}${p.link ? `<a href="${esc(p.link.url)}" target="_blank" rel="noopener">${esc(p.link.text)}</a>` : ''}`);
  return `<p class="nf-none nf-from">${html.join('. ')}.</p>`;
}

export function dateLabel(d) {
  if (!d) return '';
  if (d.today) return 'Today';
  return fmtDay(d.date, { weekday: 'long', day: 'numeric', month: 'long' });
}

// One small affordance per screen that says what the marks mean.
export function infoBtn(key) {
  const open = Boolean(f().info?.[key]);
  return `<button type="button" class="finfo-btn${open ? ' on' : ''}" data-action="food-info" data-key="${key}" aria-expanded="${open}" aria-label="What the marks mean">i</button>`;
}
export function infoLine(key, extra = '') {
  if (!f().info?.[key]) return '';
  return `<p class="finfo"><span><i class="est">~</i> estimate</span><span><b>+</b> at least</span><span><b>–</b> unknown</span>${extra}</p>`;
}
