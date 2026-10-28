// Food and your body: the Body tab in Trends. Each card puts both groups' days side by side as dots,
// marks each group's average, gives the days behind it and how sure it is, and never claims a cause.
// The numbers come from /api/food/links (src/food-links.js); nothing is worked out here.
import { esc, api, icon, num } from './ui.js';

const DAYS = 90;
const FRESH = 5 * 60000; // links move slowly: reload when the tab opens after five minutes
const RETRY = 30000; // after a failed load, wait before trying again on its own

// Loads the links into the food state when the Body tab opens. `redraw` runs when they arrive.
export function wantLinks(F, redraw) {
  const L = F.links;
  if (F.linksLoading || (L && Date.now() - L.at < (L.error ? RETRY : FRESH))) return;
  F.linksLoading = true;
  api('GET', `/api/food/links?days=${DAYS}`)
    .then((r) => { F.links = { ...r, at: Date.now() }; })
    .catch((err) => {
      // A failed refresh keeps the links already shown.
      if (!F.links || F.links.error) F.links = { error: err.status === 0 ? 'offline' : 'error', at: Date.now() };
      else F.links.at = Date.now();
    })
    .finally(() => {
      F.linksLoading = false;
      redraw();
    });
}

// ---------- Small pieces ----------

const nf = (v, dec = 0) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: dec }).format(v);
const head = (title, side = '') => `<div class="fcard-head"><h2>${title}</h2>${side ? `<span class="fcard-side">${side}</span>` : ''}</div>`;
const link = (L, key) => L.links.find((l) => l.key === key);
const hours = (h, short = false) => {
  const m = Math.round(h * 60);
  const hh = Math.floor(m / 60);
  return short ? `${hh} h ${String(m % 60).padStart(2, '0')}` : `${hh} h ${m % 60} min`;
};
const clock = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const value = (v, unit, floor = false) => {
  if (num(v) === null) return '–';
  if (unit === 'h') return hours(v, true);
  return `${nf(v)}${floor ? '+' : ''} ${unit}`;
};

const CHIP = { clear: ['Clear pattern', 'clear'], maybe: ['Maybe', 'maybe'], 'no clear link': ['No clear link', 'none'] };
const chip = (s) => (CHIP[s] ? `<span class="fl-chip s-${CHIP[s][1]}">${CHIP[s][0]}</span>` : '');

// Axis ticks on round numbers: a step of 1, 2 or 5 times a power of ten, about four of them.
function ticks(lo, hi, unit) {
  if (unit === 'h') {
    const step = hi - lo > 5 ? 2 : hi - lo > 2 ? 1 : 0.5;
    return { lo: Math.floor(lo / step) * step, hi: Math.max(Math.ceil(hi / step) * step, Math.floor(lo / step) * step + step), step };
  }
  const raw = Math.max((hi - lo) / 4, 1e-9);
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw);
  const a = Math.floor(lo / step) * step;
  return { lo: a, hi: Math.max(Math.ceil(hi / step) * step, a + step), step };
}

// Each group's days as dots on one shared scale, its average as a bar. Overlapping dots step up and
// down a little so a cluster still shows how many nights are in it.
const JITTER = [12, 7.5, 16.5, 9.75, 14.25, 5.5, 18.5];
function strips(l) {
  const all = [...l.a.values, ...l.b.values];
  const t = ticks(Math.min(...all), Math.max(...all), l.unit);
  const x = (v) => (((v - t.lo) / (t.hi - t.lo)) * 100).toFixed(2);
  const grid = [];
  for (let v = t.lo; v <= t.hi + 1e-9; v += t.step) grid.push(v);
  const lines = grid.map((v) => `<line x1="${x(v)}%" x2="${x(v)}%" y1="0" y2="24" class="fl-grid"/>`).join('');
  const nights = l.key.startsWith('training') ? 'day' : 'night';
  const row = (g, cls) => {
    const sorted = [...g.values].sort((p, q) => p - q);
    const dots = sorted.map((v, i) => `<circle cx="${x(v)}%" cy="${JITTER[i % JITTER.length]}" r="3.5" class="fl-dot ${cls}"/>`).join('');
    return `<div class="fl-grp">
      <div class="fl-grp-k"><span><i class="fl-sw ${cls}"></i>${esc(g.label)} <small>${g.n} ${g.n === 1 ? nights : `${nights}s`}</small></span><b>${value(g.mean, l.unit, g.floor)}</b></div>
      <svg class="fl-strip" width="100%" height="24" aria-hidden="true">${lines}${dots}<line x1="${x(g.mean)}%" x2="${x(g.mean)}%" y1="1" y2="23" class="fl-mean ${cls}"/></svg></div>`;
  };
  const label = (v, last) => (l.unit === 'h' ? `${nf(v, 1)} h` : `${nf(v)}${last ? ` ${l.unit}` : ''}`);
  const axis = grid.map((v, i) => `<span style="left:${x(v)}%"${i === 0 ? ' class="lo"' : i === grid.length - 1 ? ' class="hi"' : ''}>${label(v, i === grid.length - 1)}</span>`).join('');
  const spoken = [l.a, l.b].map((g) => `${g.label}: ${g.n} ${nights}s, average ${value(g.mean, l.unit)}`).join('. ');
  return `<div class="fl-strips" role="img" aria-label="${esc(spoken)}">${row(l.a, 'a')}${row(l.b, 'b')}
    <div class="fl-axis" aria-hidden="true">${axis}</div></div>`;
}

// Too few days yet: how far each side has got, and what would fill it.
function needBlock(l) {
  const groups = l.key === 'eating-window' ? [{ label: 'Timed days', n: l.a.n }] : [l.a, l.b];
  const meter = (g) => {
    const have = Math.min(g.n, 6);
    return `<div class="fl-meter"><span class="fl-meter-k">${esc(g.label)}</span><span class="fl-segs" aria-hidden="true">${Array.from({ length: 6 }, (_, i) => `<i${i < have ? ' class="on"' : ''}></i>`).join('')}</span><b>${have} of 6</b></div>`;
  };
  return `<div class="fl-need"><p class="fl-need-n">Needs ${l.need} more ${l.need === 1 ? 'day' : 'days'}</p>
    ${groups.map(meter).join('')}<p class="fl-quiet">${esc(l.how || l.text)}</p></div>`;
}

function linkBlock(l, name) {
  const top = `<div class="fl-link-head"><h3>${name}</h3>${l.state === 'ok' ? chip(l.strength) : ''}</div>`;
  if (l.state === 'no-health') return `<div class="fl-link">${top}<p class="fl-quiet">${esc(l.text)}</p><a class="fl-go" href="#/health">Apple Health settings${icon('chevron')}</a></div>`;
  if (l.state === 'needs-data') return `<div class="fl-link">${top}${needBlock(l)}</div>`;
  return `<div class="fl-link">${top}${strips(l)}<p class="fl-text">${esc(l.text)}</p></div>`;
}

// ---------- Cards ----------

function loadingCard() {
  return `<section class="card fcard fl-card" aria-busy="true">${head('Food and your body')}
    <div class="fl-wait"><i></i><i></i><i class="short"></i></div><p class="sr" role="status">Loading how your food lines up with Apple Health</p></section>`;
}

function errorCard(L) {
  return `<section class="card fcard fl-card">${head('Food and your body')}
    <p class="fempty-line">${L.error === 'offline' ? 'These need a connection. Try again when you are back online.' : 'These did not load.'}</p>
    <button type="button" class="btn tinted fl-retry" data-action="food-links-retry">Try again</button></section>`;
}

// With no Apple Health at all: what connecting it would show.
function connectCard() {
  const li = (ic, text) => `<li><span class="fl-unlock-ic">${icon(ic)}</span><span>${text}</span></li>`;
  return `<section class="card fcard fl-card fl-connect">${head('Food and your body')}
    <p class="fl-lead">Connect Apple Health and this tab lines up what you eat with how you train and recover, using your own days.</p>
    <ul class="fl-unlock">
      ${li('dumbbell', 'What you eat on training days against what you burn')}
      ${li('heart', 'Alcohol against your heart the next morning')}
    </ul>
    <a class="btn tinted fl-cta" href="#/health">${icon('heart')}Connect Apple Health</a></section>`;
}

// The group's first place: loading, an error, or what connecting Apple Health would show. Nothing once
// the links are in; the cards below carry them.
export function linksStateCard(L) {
  if (!L) return loadingCard();
  if (L.error) return errorCard(L);
  if (!L.health) return connectCard();
  return '';
}

// Insight 3: training days against rest days, as paired bars.
export function linksTrainingCard(L) {
  if (!L || L.error || !L.health) return '';
  const l = link(L, 'training-fuel');
  if (l.state !== 'ok') return `<section class="card fcard fl-card">${head('Training days')}${linkBlock(l, 'Eating against training')}</section>`;
  const pair = (label, a, b, unit, floor = false) => {
    const top = Math.max(num(a) || 0, num(b) || 0) || 1;
    const bar = (v, cls) => `<span class="fl-bar ${cls}">${num(v) === null ? '' : `<i style="--f:${(v / top).toFixed(3)}"></i>`}<b>${num(v) === null ? '–' : `${nf(v)}${floor ? '+' : ''}`}</b></span>`;
    const d = num(a) !== null && num(b) !== null ? Math.round(a - b) : null;
    return `<div class="fl-pair"><span class="fl-pair-k">${label}<small>${unit}</small></span><span class="fl-bars">${bar(a, 'a')}${bar(b, 'b')}</span>
      <span class="fl-pair-d">${d === null ? '–' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${nf(Math.abs(d))}`}</span></div>`;
  };
  const floor = l.a.floor || l.b.floor;
  return `<section class="card fcard fl-card">${head('Training days', chip(l.strength))}
    <p class="fx-keys top fl-keys"><span><i class="fk fl-k a"></i>Training days <b>${l.a.n}</b></span><span><i class="fk fl-k b"></i>Rest days <b>${l.b.n}</b></span></p>
    ${pair('Eaten', l.a.mean, l.b.mean, 'kcal', floor)}${pair('Carbs', l.carbs.a, l.carbs.b, 'g', l.carbs.floor)}${pair('Burned', l.burn.a, l.burn.b, 'active kcal')}
    ${l.underfuel ? `<p class="fl-flag"><i aria-hidden="true"></i>Possibly under-fuelling: about ${nf(l.gap)} kcal short of the extra you burn</p>` : ''}
    <p class="fl-text">${esc(l.text)}</p>
    <p class="fl-foot">Averages a day. A training day has 45 or more exercise minutes, or active energy in your top third.${floor ? ' A “+” means some foods have no energy value, so it is at least that.' : ''}</p></section>`;
}

// Insight 4: alcohol against the next morning's heart. Hidden until he logs a drink with alcohol.
export function linksAlcoholCard(L) {
  if (!L || L.error || !L.health || !L.alcohol) return '';
  return `<section class="card fcard fl-card">${head('Alcohol and recovery', `<span>Next morning</span>`)}
    ${linkBlock(link(L, 'alcohol-hrv'), 'Heart rate variability')}
    ${linkBlock(link(L, 'alcohol-rhr'), 'Resting heart rate')}
    <p class="fl-foot">Higher heart rate variability and a lower resting heart rate usually mean better recovery.</p></section>`;
}

// Insight 5: first and last bite on a day's clock, with the usual window shaded.
export function linksWindowCard(L) {
  if (!L || L.error) return '';
  const l = link(L, 'eating-window');
  if (l.state !== 'ok') return `<section class="card fcard fl-card">${head('Eating window')}${linkBlock(l, 'First and last bite')}</section>`;
  const vals = [...l.a.values, ...l.b.values];
  // Lines every two hours, times every four, so they never crowd at 320 px.
  const lo = Math.max(240, Math.floor((Math.min(...vals) - 30) / 120) * 120);
  const hi = Math.min(1680, Math.ceil((Math.max(...vals) + 30) / 120) * 120);
  const x = (v) => (((v - lo) / (hi - lo)) * 100).toFixed(2);
  const grid = [];
  for (let v = lo; v <= hi; v += 120) grid.push(v);
  const marks = grid.filter((v) => v % 240 === 0);
  const dots = (g, cls) => [...g.values].sort((p, q) => p - q).map((v, i) => `<circle cx="${x(v)}%" cy="${JITTER[i % JITTER.length] + 4}" r="3.5" class="fl-dot ${cls}"/>`).join('');
  const ma = l.a.mean;
  const mb = l.b.mean;
  const svg = `<svg class="fl-strip tall" width="100%" height="32" aria-hidden="true">
    ${grid.map((v) => `<line x1="${x(v)}%" x2="${x(v)}%" y1="0" y2="32" class="fl-grid"/>`).join('')}
    <rect x="${x(ma)}%" y="4" width="${(x(mb) - x(ma)).toFixed(2)}%" height="24" rx="6" class="fl-band"/>
    ${dots(l.a, 'b')}${dots(l.b, 'a')}
    <line x1="${x(ma)}%" x2="${x(ma)}%" y1="1" y2="31" class="fl-mean b"/><line x1="${x(mb)}%" x2="${x(mb)}%" y1="1" y2="31" class="fl-mean a"/></svg>`;
  const edge = (v) => (v === lo ? ' class="lo"' : v === hi ? ' class="hi"' : '');
  const axis = marks.map((v) => `<span style="left:${x(v)}%"${edge(v)}>${clock(v)}</span>`).join('');
  const tile = (v, k) => `<div class="fl-tile"><b>${v}</b><span>${k}</span></div>`;
  return `<section class="card fcard fl-card">${head('Eating window', `<span class="fl-chip s-plain">${esc(l.steady.charAt(0).toUpperCase() + l.steady.slice(1))}</span>`)}
    <div class="fl-tiles">${tile(l.a.at, 'First bite')}${tile(l.b.at, 'Last bite')}${tile(hours(l.diff, true), 'Window')}</div>
    <div class="fl-strips" role="img" aria-label="${esc(`First bite around ${l.a.at}, last bite around ${l.b.at}, over ${l.a.n} days`)}">${svg}
      <div class="fl-axis" aria-hidden="true">${axis}</div></div>
    <p class="fx-keys"><span><i class="fk fl-k b"></i>First bites</span><span><i class="fk fl-k a"></i>Last bites</span><span><i class="fk fl-k band"></i>Usual window</span></p>
    <p class="fl-text">${esc(l.text)}</p></section>`;
}
