// Real burn on the phone: the Trends Body tab's cards (what he actually burns, and his weight trend)
// and a small tile on the diary. The numbers come from /api/food/energy (src/food-energy.js): energy
// eaten on fully logged days, less what the weight trend says was stored, blended with the formula by
// how sure it is. Every figure says what it rests on; a day left out is drawn faded, never as zero.
import { state, esc, api, act, toast, icon, num, fmtDay, haptic, plural } from './ui.js';

const F = () => state.food || (state.food = { date: null });
const fmt = (v, dec = 0) => (num(v) === null ? '–' : new Intl.NumberFormat('en-GB', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v));
const dayMonth = (d) => fmtDay(d, { day: 'numeric', month: 'short' });
let uid = 0;
const nextId = (p) => `${p}${(uid += 1)}`;
// The same striped fill the other charts use (food.js hatchDef) for days that are not counted.
const hatchDef = (id) => `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" class="fh-bg"/><rect width="1.8" height="5" class="fh-line"/></pattern>`;

const CONF = { none: 'Not enough data yet', low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence' };
const NEED = { days: 10, weighIns: 5, span: 14 }; // src/food-energy.js CONFIDENCE.low
const GOAL_WORDS = { gain: 'to gain muscle', lose: 'to lose fat' };
const usualName = (e) => (e.priorFrom === 'health' ? 'Formula and Apple Health' : 'Formula');
const rate = (w) => (num(w) === null ? '–' : `${w > 0 ? '+' : w < 0 ? '−' : ''}${fmt(Math.abs(w), 1)}`);
const arrow = (w) => (num(w) === null || Math.abs(w) < 0.05 ? ['→', 'steady'] : w > 0 ? ['↗', 'going up'] : ['↘', 'going down']);

// ---------- Loading ----------

// Kept in the food state; a failed fetch keeps the last copy, so the screen never goes blank.
export async function loadEnergy() {
  try {
    F().energy = await api('GET', '/api/food/energy');
    F().energyError = false;
  } catch {
    F().energyError = !F().energy;
  }
  return F().energy;
}

// ---------- The intake chart ----------

// One bar per day of the window, the real burn as a line across. A day that counts is a plain bar; a
// day left out (missing values, or only partly logged) is faded and striped; a day with nothing logged
// is the small dashed gap mark the other charts use.
function intakeChart(e) {
  const series = e.series || [];
  const n = series.length || 1;
  const height = 128;
  const top = 18;
  const burn = num(e.burn);
  const showBurn = e.confidence !== 'none' && burn !== null;
  const peak = Math.max(1, ...series.map((d) => d.kcal || 0), showBurn ? burn : 0);
  const max = Math.ceil(peak / 500) * 500;
  const y = (v) => height - ((height - top) * v) / max;
  const slot = 100 / n;
  const bw = slot * 0.62;
  const hatch = nextId('fb');
  const bars = series.map((d, i) => {
    const x = (i * slot + (slot - bw) / 2).toFixed(3);
    if (d.kcal === null || d.reason === 'none') return `<rect x="${x}%" y="${height - 2}" width="${bw.toFixed(3)}%" height="2" class="fx-gap"/>`;
    const bh = Math.max(2, height - y(d.kcal));
    const out = !d.good;
    return `<rect x="${x}%" y="${(height - bh).toFixed(1)}" width="${bw.toFixed(3)}%" height="${bh.toFixed(1)}" rx="2" class="fx-bar${out ? ' inc fburn-out' : ''}" style="${out ? `fill:url(#${hatch});` : ''}animation-delay:${Math.round((i * 320) / n)}ms"/>`;
  }).join('');
  const line = showBurn ? `<line x1="0" x2="100%" y1="${y(burn).toFixed(1)}" y2="${y(burn).toFixed(1)}" class="fburn-line"/>
    <text x="100%" y="${(y(burn) - 6).toFixed(1)}" text-anchor="end" class="fx-val fburn-lv">${fmt(burn)}</text>` : '';
  const c = e.counts;
  const spoken = `Energy logged each day, ${dayMonth(e.window.from)} to ${dayMonth(e.window.to)}: ${plural(c.good, 'day')} counted, ${c.partial + c.incomplete} left out, ${c.none} with nothing logged.${showBurn ? ` Real burn about ${fmt(burn)} kcal a day.` : ''}`;
  const keys = [
    showBurn ? '<span><i class="fk fk-burn"></i>Real burn</span>' : '',
    c.partial + c.incomplete ? '<span><i class="fk fk-inc"></i>Left out</span>' : '',
    c.none ? '<span><i class="fk fk-gap"></i>No log</span>' : '',
  ].join('');
  return `<div class="fburn-plot" role="img" aria-label="${esc(spoken)}"><svg class="fx-svg" width="100%" height="${height}" aria-hidden="true"><defs>${hatchDef(hatch)}</defs>
      <line x1="0" x2="100%" y1="${height - 0.5}" y2="${height - 0.5}" class="fx-base"/>${bars}${line}</svg></div>
    <div class="fx-axis" aria-hidden="true"><span>${esc(dayMonth(e.window.from))}</span><span>${esc(dayMonth(e.window.to))}</span></div>
    ${keys ? `<p class="fx-keys">${keys}</p>` : ''}`;
}

// What the window rests on, and what it left out.
function basisLine(e) {
  const c = e.counts;
  const out = [
    c.none ? `${c.none} with nothing logged` : '',
    c.partial ? `${c.partial} only partly logged` : '',
    c.incomplete ? `${c.incomplete} missing some energy values` : '',
  ].filter(Boolean);
  return `From ${plural(c.good, 'fully logged day')} and ${plural(c.weighIns, 'weigh-in')}, ${dayMonth(e.window.from)} to ${dayMonth(e.window.to)}.${out.length ? ` Left out: ${out.join(', ')}.` : ''}`;
}

function confChip(level) {
  return `<span class="fconf c-${esc(level)}"><i aria-hidden="true"></i>${CONF[level] || ''}</span>`;
}

function progressRow(label, have, need) {
  const f = Math.min(1, have / need);
  return `<div class="fprog${have >= need ? ' done' : ''}"><span class="fprog-k">${label}</span><b>${fmt(Math.min(have, need))}<small>/${need}</small></b>
    <span class="fprog-bar" role="img" aria-label="${esc(`${label}: ${have} of ${need}`)}"><i style="--f:${f.toFixed(3)}"></i></span></div>`;
}

// ---------- Real burn card ----------

export function burnCard(e) {
  const head = (side) => `<div class="fcard-head"><h2>Real burn</h2>${side ? `<span class="fcard-side">${side}</span>` : ''}</div>`;
  if (!e) {
    const failed = F().energyError;
    return `<section class="card fcard fburn">${head('')}${failed ? '<p class="fempty-line">Could not load your real burn. Come back to this tab to try again.</p>' : '<div class="fburn-wait" aria-hidden="true"></div>'}</section>`;
  }
  const c = e.counts;
  const anyData = c.good + c.partial + c.incomplete > 0;
  if (e.confidence === 'none') {
    const m = e.missing || {};
    const spanRow = c.weighIns >= NEED.weighIns && c.span < NEED.span ? progressRow('Days between first and last weigh-in', c.span, NEED.span) : '';
    const until = num(e.need) !== null ? `<p class="fburn-note">Until then your daily need comes from the ${e.priorFrom === 'health' ? 'formula and Apple Health' : 'formula'}: ${fmt(e.need)} kcal.</p>` : '';
    return `<section class="card fcard fburn">${head(confChip('none'))}
      <p class="fburn-intro">Real burn works out what you actually burn from the food you log and your weight trend. It needs ${NEED.days} fully logged days and ${NEED.weighIns} weigh-ins over 2 weeks, all in the last ${e.window.days} days.</p>
      <div class="fburn-prog">${progressRow('Fully logged days', c.good, NEED.days)}${progressRow('Weigh-ins', c.weighIns, NEED.weighIns)}${spanRow}</div>
      ${m.text ? `<p class="fburn-basis"><b>Still to go:</b> ${esc(m.text)}.</p>` : ''}
      ${anyData ? intakeChart(e) : ''}${until}</section>`;
  }

  const r = e.range;
  const blend = e.weight < 1 && num(e.prior) !== null
    ? `<p class="fburn-note">Weighted ${Math.round(e.weight * 100)}% to your log and ${Math.round((1 - e.weight) * 100)}% to the ${e.priorFrom === 'health' ? 'formula and Apple Health' : 'formula'}; it leans more on your log as days and weigh-ins add up.</p>`
    : '';
  const round10 = (v) => Math.round(v / 10) * 10;
  const diff = (v) => {
    const d = round10(v - e.burn);
    return d === 0 ? 'The same as your real burn' : `${fmt(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than your real burn`;
  };
  const goalAdj = e.goal?.kcal ? `, ${e.goal.kcal > 0 ? '+' : '−'}${fmt(Math.abs(e.goal.kcal))} ${GOAL_WORDS[e.goal.key] || 'for your goal'}` : '';
  const rows = [
    e.measured !== null && e.weight < 1 ? ['Measured from your log', e.measured, 'Your food and weight alone'] : null,
    num(e.prior) !== null ? [usualName(e), round10(e.prior), diff(e.prior)] : null,
    num(e.need) !== null ? ['Your daily need now', e.need, `${e.using ? 'From real burn' : 'From the formula'}${goalAdj}`] : null,
  ].filter(Boolean);
  const cmp = rows.length ? `<dl class="fburn-cmp">${rows.map(([k, v, note]) => `<div><dt>${esc(k)}<small>${esc(note)}</small></dt><dd><b>${fmt(v)}</b> kcal</dd></div>`).join('')}</dl>` : '';
  let actions;
  if (!e.profile) actions = '<p class="fburn-note">To use it for your daily needs, <a href="#/settings">set up your body in Settings</a>.</p>';
  else if (e.using) actions = `<div class="fburn-act"><span class="fburn-using">${icon('check')}Using it for your needs</span><button type="button" class="btn plain small" data-action="food-burn-undo">Undo</button></div>`;
  else actions = `<div class="fburn-act"><button type="button" class="btn primary small" data-action="food-burn-use">Use this for my needs</button></div>`;
  return `<section class="card fcard fburn">${head(confChip(e.confidence))}
    <div class="fburn-top"><p class="fburn-v"><span aria-hidden="true">≈</span><span class="sr">About</span><b>${fmt(e.burn)}</b><small>kcal a day</small></p>
      ${r ? `<p class="fburn-pm"><b>± ${fmt(r.margin)}</b> kcal<span aria-hidden="true"> · </span><span>${fmt(r.low)} to ${fmt(r.high)}</span></p>` : ''}</div>
    ${intakeChart(e)}
    ${cmp}${blend}
    <p class="fburn-basis">${esc(basisLine(e))}${e.clamped ? ' The measurement came out beyond what a body burns, so it is held at the limit; check for days logged twice or missed.' : ''}</p>
    ${actions}</section>`;
}

// ---------- Weight trend card ----------

// Scale readings as dots and the smoothed trend as a line, from the first reading (at most 90 days
// back) to today. Widths stretch with the card; heights and dot sizes stay in pixels.
function weightChart(list) {
  const height = 136;
  const pad = 12;
  const day = (d) => Date.parse(`${d}T12:00:00Z`) / 86400000;
  // At least two weeks wide, ending today, so a few days of readings sit at the right, not stretched.
  const last = list[list.length - 1].date;
  const span = Math.max(14, day(last) - day(list[0].date));
  const x0 = day(last) - span;
  const first = new Date(x0 * 86400000).toISOString().slice(0, 10);
  const vals = list.flatMap((p) => [p.kg, p.trendKg]).filter((v) => num(v) !== null);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const mid = (lo + hi) / 2;
  const half = Math.max(0.5, (hi - lo) / 2);
  const x = (d) => (((day(d) - x0) / span) * 100).toFixed(2);
  const y = (kg) => (pad + ((mid + half - kg) / (half * 2)) * (height - pad * 2)).toFixed(1);
  const pts = list.filter((p) => num(p.trendKg) !== null);
  const trend = pts.slice(1).map((p, i) => `<line x1="${x(pts[i].date)}%" y1="${y(pts[i].trendKg)}" x2="${x(p.date)}%" y2="${y(p.trendKg)}" class="fwt-line"/>`).join('');
  const readings = list.filter((p) => num(p.kg) !== null);
  const dots = readings.map((p, i) => `<circle cx="${x(p.date)}%" cy="${y(p.kg)}" r="${i === readings.length - 1 ? 4 : 2.6}" class="fwt-dot${i === readings.length - 1 ? ' last' : ''}"><title>${esc(`${fmtDay(p.date)}: ${fmt(p.kg, 1)} kg`)}</title></circle>`).join('');
  const grid = [hi, lo].map((v) => `<line x1="0" x2="100%" y1="${y(v)}" y2="${y(v)}" class="fwt-grid"/>`).join('');
  const labels = [hi, ...(hi !== lo ? [lo] : [])].map((v) => `<span class="fwt-y" style="top:${y(v)}px">${fmt(v, 1)}</span>`).join('');
  const spoken = `Weight from ${dayMonth(first)} to ${dayMonth(last)}: ${plural(readings.length, 'reading')}, between ${fmt(lo, 1)} and ${fmt(hi, 1)} kg; the trend is now ${fmt(pts[pts.length - 1]?.trendKg, 1)} kg.`;
  return `<div class="fwt-plot" role="img" aria-label="${esc(spoken)}"><svg class="fx-svg" width="100%" height="${height}" aria-hidden="true">${grid}${trend}${dots}</svg>${labels}</div>
    <div class="fx-axis fwt-axis" aria-hidden="true"><span>${esc(dayMonth(first))}</span><span>Today</span></div>
    <p class="fx-keys"><span><i class="fk fk-dot"></i>Scale</span><span><i class="fk fk-trend"></i>Trend, smoothed over about 10 days</span></p>`;
}

export function weightCard(e) {
  if (!e) return '<section class="card fcard fweight"><div class="fcard-head"><h2>Weight trend</h2></div><div class="fburn-wait" aria-hidden="true"></div></section>';
  const t = e.trend || {};
  const list = e.weights || [];
  const readings = list.filter((p) => num(p.kg) !== null);
  const latest = readings[readings.length - 1];
  const todayDate = e.today || list[list.length - 1]?.date;
  // A weekly rate only once the weigh-ins could show one (the same bar as the goal check).
  const c = e.counts || {};
  const side = num(t.perWeek) !== null && c.weighIns >= NEED.weighIns && c.span >= NEED.span ? `<span><b>${rate(t.perWeek)}</b> kg a week</span>` : '';
  const top = num(t.kg) !== null ? `<div class="fwt-top"><p class="fwt-v"><b>${fmt(t.kg, 1)}</b><small>kg trend</small></p>
      ${latest ? `<p class="fwt-sub">Scale ${fmt(latest.kg, 1)} kg<br>${latest.date === todayDate ? 'today' : esc(dayMonth(latest.date))}</p>` : ''}</div>` : '';
  const g = e.goal;
  const tone = g?.ok === true ? 'ok' : g?.ok === false ? 'off' : 'wait';
  const goal = g ? `<p class="fwt-goal ${tone}"><span class="fwt-goal-k">${esc(g.label)}</span>${esc(g.text)}</p>` : '';
  let sug = '';
  if (num(e.suggested) !== null) {
    const adj = g?.kcal ? ` ${g.kcal > 0 ? '+' : '−'} ${fmt(Math.abs(g.kcal))} ${GOAL_WORDS[g.key] || ''}` : '';
    const from = e.confidence === 'none' ? `${e.priorFrom === 'health' ? 'formula and Apple Health' : 'formula'} ${fmt(e.burn)}${adj}, until real burn has enough data` : `real burn ${fmt(e.burn)}${adj}`;
    sug = `<p class="fwt-sug"><span>Suggested intake</span><b><i class="est" title="Estimate">~</i>${fmt(e.suggested)} kcal</b> a day<small>${esc(from)}</small></p>`;
  }
  const loggedToday = latest && latest.date === todayDate;
  const form = `<form class="fwt-add" data-form="food-weight">
      <label class="fwt-add-k" for="fwt-kg">${loggedToday ? 'Weighed again today?' : 'Add today’s weight'}</label>
      <div class="fwt-row"><input id="fwt-kg" class="input" name="weightKg" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="kg" required aria-describedby="fwt-kg-u"><span id="fwt-kg-u" class="fwt-unit">kg</span>
        <button class="btn tinted" type="submit">Save</button></div></form>`;
  return `<section class="card fcard fweight">
    <div class="fcard-head"><h2>Weight trend</h2>${side ? `<span class="fcard-side">${side}</span>` : ''}</div>
    ${top}
    ${readings.length ? weightChart(list) : '<p class="fempty-line">No weigh-ins yet. Add one below, or let Apple Health send them.</p>'}
    ${goal}${sug}${form}</section>`;
}

// ---------- Diary tile ----------

// A small link to the Body tab: the real burn and the trend once there is a reading, a quieter line
// on how far off it is while there is some data, nothing before that.
export function burnTile(e) {
  if (!e?.counts) return '';
  const c = e.counts;
  if (e.confidence === 'none') {
    if (!(c.good + c.partial + c.incomplete + c.weighIns)) return '';
    const left = e.missing?.daysToGo;
    return `<a class="card fburn-tile quiet" href="#/food/trends?tab=body"><span class="fburn-tile-ic">${icon('flame')}</span>
      <span class="fburn-tile-w"><span class="eyebrow">Real burn</span><span class="fburn-tile-q">${left ? `${plural(left, 'more day')} to go` : 'Nearly there'}</span></span>${icon('chevron', 'chev')}</a>`;
  }
  const [arr, word] = arrow(e.trend?.perWeek);
  const trend = num(e.trend?.kg) !== null ? `<span class="fburn-tile-t">trend ${fmt(e.trend.kg, 1)} kg <span aria-hidden="true">${arr}</span><span class="sr">${word}</span></span>` : '';
  return `<a class="card fburn-tile" href="#/food/trends?tab=body"><span class="fburn-tile-ic">${icon('flame')}</span>
    <span class="fburn-tile-w"><span class="eyebrow">Real burn</span><span class="fburn-tile-v"><b><span aria-hidden="true">≈ </span>${fmt(e.burn)}</b><small> kcal</small>${trend ? '<span class="fburn-tile-dot" aria-hidden="true"> · </span>' : ''}${trend}</span></span>${icon('chevron', 'chev')}</a>`;
}

// ---------- Actions ----------

// "Use this for my needs" and "Undo": where his daily energy need comes from. `after` reloads the screen.
export async function energyClick(a, el, after) {
  if (a !== 'food-burn-use' && a !== 'food-burn-undo') return false;
  const to = a === 'food-burn-use' ? 'burn' : 'auto';
  el.disabled = true;
  const r = await act(() => api('PUT', '/api/body', { energyFrom: to }), (x) => (to === 'burn'
    ? `Your daily need now comes from your real burn: ${fmt(x.needs?.refs.kcal)} kcal.`
    : `Back to the formula: ${fmt(x.needs?.refs.kcal)} kcal a day.`));
  if (!r) {
    el.disabled = false;
    return true;
  }
  haptic();
  state.body = r;
  await after();
  return true;
}

// "Add today's weight": a weigh-in through the body API, so it lands in the same place as Settings.
export async function energySubmit(kind, form, after) {
  if (kind !== 'food-weight') return false;
  const raw = String(form.weightKg?.value || '').trim().replace(',', '.');
  const kg = Number(raw);
  if (!raw || !(kg >= 30 && kg <= 250)) {
    toast('Weight must be between 30 and 250 kg.', true);
    return true;
  }
  const r = await act(() => api('PUT', '/api/body', { weightKg: kg, weighIn: true }), `Saved ${fmt(Math.round(kg * 10) / 10, 1)} kg for today.`);
  if (!r) return true;
  haptic();
  state.body = r;
  await after();
  return true;
}
