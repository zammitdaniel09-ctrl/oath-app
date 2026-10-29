// Trends: drawings first, short labels, numbers on the graphics. Five tabs (overview, nutrients, foods,
// timing, body); cards below the fold draw when they scroll into view.
import { num, esc, shortDay, icon, localNowHM, state, pageHead, redrawIfIdle } from './ui.js';
import {
  share, fmtN, spokenSplit, barsHtml, axisLabels, barKeys, GRADES, gradeMix, RI_AT, riPos, riTone, shortLabel, needs,
  LABEL_ROWS, riWord, factRow, gradeDot, topTag, tagMini, f, macroParts, donut, MACRO_LABEL, nextId, hatchDef, infoBtn,
  infoLine, enter,
} from './food-parts.js';
import { NUTRIENT, show } from './nutrition.js';
import { weightCard, burnCard } from './food-energy.js';
import { linksStateCard, linksTrainingCard, linksAlcoholCard, linksWindowCard, wantLinks } from './food-links.js';
import { sheetHtml } from './food-sheets.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {}, takeHtml: () => {} };
export function initFoodTrends(c) {
  ctx = { ...ctx, ...c };
}

const SPANS = [7, 30, 90];
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SOURCE_KEYS = ['sugars', 'salt', 'satfat', 'protein', 'fibre'];
const SOURCE_LABEL = { sugars: 'Sugar', salt: 'Salt', satfat: 'Sat fat', protein: 'Protein', fibre: 'Fibre' };

function cardHead(title, side = '') {
  return `<div class="fcard-head"><h2>${title}</h2>${side ? `<span class="fcard-side">${side}</span>` : ''}</div>`;
}

// The period in four numbers.
function kpiRow(h) {
  const g = h.grades?.total;
  const sum = g ? Object.values(g).reduce((a, v) => a + (num(v) || 0), 0) : 0;
  const ab = sum ? share((g.a || 0) + (g.b || 0), sum) : null;
  const logged = h.series.filter((d) => d.logged).length;
  const tile = (v, l) => `<div class="fkpi"><b>${v}</b><span>${l}</span></div>`;
  return `<div class="fkpis">
    ${tile(`${fmtN(h.avg.kcal)}${h.avg.missing?.kcal ? '+' : ''}`, 'kcal a day')}
    ${tile(num(h.avg.protein) === null ? '–' : `${fmtN(h.avg.protein)}<small> g</small>`, 'protein a day')}
    ${tile(ab === null ? '–' : `${ab}<small>%</small>`, 'from A and B')}
    ${tile(`${logged}<small>/${h.days}</small>`, 'days logged')}</div>`;
}

// Energy per day, each column split by macro; the average as a dashed line, the chosen day lit and the
// rest dimmed. Tap a day to choose it.
function energyCard(h, sel) {
  const avg = num(h.avg.kcal);
  const hits = h.series.map((d) => `<button type="button" data-action="food-trend-day" data-date="${d.date}" aria-pressed="${d.date === sel}"
    aria-label="${esc(`${d.date === h.today ? 'Today' : shortDay(d.date)}: ${d.logged ? `${fmtN(d.kcal)} kcal${d.incomplete ? ', incomplete' : ''}, ${spokenSplit(d)}` : 'nothing logged'}`)}"></button>`).join('');
  const side = `<span><i class="fk fk-avg"></i>${avg === null ? '–' : `<b>${fmtN(avg)}${h.avg.missing?.kcal ? '+' : ''}</b> avg`}</span>`;
  return `<section class="card fcard ftr-energy f-wide">${cardHead('Energy', side)}
    <div class="fx-plot">${barsHtml(h.series, { height: 168, sel, values: h.days <= 7, avg })}
      <div class="fx-hits" style="grid-template-columns:repeat(${h.series.length},minmax(0,1fr))">${hits}</div></div>
    ${axisLabels(h.series, h.today)}
    ${barKeys(h.series)}
  </section>`;
}

// What he ate by Nutri-Score: the period as one bar, then each day as a column of energy shares.
function gradeCard(h) {
  const gr = h.grades;
  if (!gr) return '';
  const days = gr.days || [];
  const height = 88;
  const n = days.length || 1;
  const slot = 100 / n;
  const bw = slot * (n > 40 ? 0.74 : 0.56);
  const cols = days.map((d, i) => {
    const sum = [...GRADES, 'none'].reduce((a, g) => a + (num(d[g]) || 0), 0);
    const x = (i * slot + (slot - bw) / 2).toFixed(3);
    if (!(sum > 0)) return `<rect x="${x}%" y="${height - 2}" width="${bw.toFixed(3)}%" height="2" class="fx-gap"/>`;
    let y = height;
    const segs = [...GRADES, 'none'].map((g) => {
      const v = num(d[g]) || 0;
      if (!v) return '';
      const hh = (v / sum) * height;
      y -= hh;
      return `<rect x="${x}%" y="${(y + 0.5).toFixed(1)}" width="${bw.toFixed(3)}%" height="${Math.max(0.5, hh - 1).toFixed(1)}" rx="${n > 40 ? 0.5 : 1.5}" class="gx gx-${g}"/>`;
    }).join('');
    return `<g class="gx-col" style="animation-delay:${Math.round((i * 320) / n)}ms">${segs}</g>`;
  }).join('');
  const mix = gradeMix(gr.total);
  return `<section class="card fcard fgrades">${cardHead('Nutri-Score', h.rank ? `<span><b>${h.rank.graded}</b> of ${h.rank.foods} foods graded</span>` : '')}
    ${mix || '<p class="fempty-line">Nothing graded yet</p>'}
    ${mix ? `<svg class="fx-svg fgrade-cols" width="100%" height="${height}" aria-hidden="true"><line x1="0" x2="100%" y1="${height - 0.5}" y2="${height - 0.5}" class="fx-base"/>${cols}</svg>${axisLabels(h.series, h.today)}` : ''}
  </section>`;
}

// Bars against the reference intake, with a mark at 100%.
// With `tap`, each row is a button that opens the foods richest in it.
function riRows(list, { best = new Set(), low = new Set(), tap = false } = {}) {
  const at = RI_AT;
  return list.map((c, i) => {
    const p = num(c.pct);
    const w = p === null ? 0 : riPos(p) / 100;
    const tone = `${riTone(p, c.key)}${best.has(c.key) ? ' best' : ''}${low.has(c.key) ? ' low' : ''}`;
    // "~" when some of it was filled from a similar food, the web or an estimate rather than on record.
    const est = p !== null && c.est > 0 ? `<i class="est" title="${c.est >= 100 ? 'Estimated' : `About ${fmtN(c.est)}% estimated`}">~</i>` : '';
    const tag = tap ? `button type="button" data-action="food-rich" data-key="${esc(c.key)}"` : 'div';
    return `<${tag} class="rirow${tone}${p === null ? ' unk' : ''}${tap ? ' ri-tap' : ''}" style="--i:${i}"><span class="rirow-k">${tap ? `<span>${esc(shortLabel(c.key))}</span>${icon('chevron', 'tap-hint')}` : esc(shortLabel(c.key))}</span>
      <span class="rirow-bar"><i style="--f:${w.toFixed(3)}"></i><b class="rirow-100" style="left:${at}%"></b></span>
      <span class="rirow-v">${p === null ? '–' : `${est}${fmtN(p)}%${c.partial ? '+' : ''}`}</span></${tap ? 'button' : 'div'}>`;
  }).join('');
}

function riLegend() {
  return `<div class="rirow rirow-legend" aria-hidden="true"><span></span><span class="rirow-bar bare"><b class="rirow-100" style="left:${RI_AT}%"><em>${needs() ? 'Need' : 'RI'}</em></b></span><span></span></div>`;
}

// The average day against the label's reference intakes.
function labelCard(h) {
  const list = ['kcal', 'protein', 'carbs', 'sugars', 'fat', 'satfat', 'salt'].map((k) => h.coverage?.find((c) => c.key === k)).filter(Boolean);
  if (!list.length) return '';
  return `<section class="card fcard">${cardHead('Average day', `<span><b>${h.loggedDays}</b> ${h.loggedDays === 1 ? 'day' : 'days'}</span>`)}
    ${riLegend()}${riRows(list)}</section>`;
}

// The average day as a pack's nutrition label: the fats and carbohydrates broken down, each against
// his need or the RI. Sub-rows nobody has a value for are left out, as on the day's label.
function nutritionLabelCard(h) {
  const n = h.label;
  if (!n) return '';
  const rows = LABEL_ROWS.filter(([k, sub]) => !sub || ['satfat', 'sugars'].includes(k) || num(n[k]) !== null);
  return `<section class="card fcard">${cardHead('Nutrition label', `<span>Average of <b>${n.days}</b> ${n.days === 1 ? 'day' : 'days'}</span>`)}
    <div class="nf-group nf-label"><div class="nf-cols" aria-hidden="true"><span></span><span></span><span>% ${riWord()}</span></div>
      ${rows.map(([k, sub]) => factRow(n, k, sub, n.filled)).join('')}</div></section>`;
}

// Vitamins and minerals: the average % of reference intake, best first; the three highest and the
// three lowest marked. Nutrients nothing he ate has a value for are named, never drawn as zero.
function microCard(h) {
  const all = (h.coverage || []).filter((c) => ['mineral', 'vitamin'].includes(c.group));
  if (!all.length) return '';
  const known = all.filter((c) => num(c.pct) !== null).sort((a, b) => b.pct - a.pct);
  const unknown = all.filter((c) => num(c.pct) === null);
  const best = new Set(known.slice(0, 3).map((c) => c.key));
  const low = new Set(known.length > 3 ? known.slice(Math.max(3, known.length - 3)).map((c) => c.key) : []);
  return `<section class="card fcard f-wide fmicro-card">${cardHead('Vitamins and minerals', known.length ? '<span><i class="fk fk-best"></i>Top</span><span><i class="fk fk-low"></i>Lowest</span>' : '')}
    ${known.length ? `${riLegend()}<div class="rirows" style="--rows:${Math.ceil(known.length / 2)}">${riRows(known, { best, low, tap: true })}</div>` : '<p class="fempty-line">No values on record yet</p>'}
    ${known.some((c) => c.est > 0) ? '<p class="rirow-none"><i class="est">~</i> Partly filled from similar foods, published values or estimates</p>' : ''}
    ${unknown.length ? `<p class="rirow-none">No data: ${unknown.map((c) => esc(shortLabel(c.key))).join(', ')}</p>` : ''}</section>`;
}

function rankList(list, empty) {
  if (!list?.length) return `<p class="fempty-line">${empty}</p>`;
  return `<ol class="frank-list">${list.map((x) => `<li>${gradeDot(x.grade)}<span class="frank-name">${esc(x.name)}${topTag(x.tags) ? ` ${tagMini(topTag(x.tags))}` : ''}</span><b>×${x.count}</b></li>`).join('')}</ol>`;
}

// The best and worst foods he ate, by grade then how often.
function rankCard(h) {
  if (!h.rank) return '';
  return `<section class="card fcard f-wide">${cardHead('Food rankings')}
    <div class="frank"><div><h3 class="frank-h good">Best</h3>${rankList(h.rank.best, 'No A or B foods yet')}</div>
    <div><h3 class="frank-h bad">Worst</h3>${rankList(h.rank.worst, 'No D or E foods')}</div></div></section>`;
}

export function sourceList(h, k) {
  const s = h.sources?.[k];
  if (!s?.items.length) return '<p class="fempty-line">Nothing on record</p>';
  const top = s.items[0].amount || 1;
  const unit = NUTRIENT[k].unit;
  return `<ol class="fsrc-list">${s.items.map((x) => `<li>${gradeDot(x.grade)}<span class="fsrc-name">${esc(x.name)}</span>
    <span class="fsrc-bar"><i style="--f:${(x.amount / top).toFixed(3)}"></i></span><b>${fmtN(x.share)}%</b><small>${fmtN(x.amount, unit === 'g' && x.amount < 10 ? 1 : 0)} ${unit}</small></li>`).join('')}</ol>`;
}

// Where his sugar, salt, saturates, protein and fibre came from.
function sourcesCard(h) {
  if (!h.sources) return '';
  const k = SOURCE_KEYS.includes(f().src) ? f().src : 'sugars';
  return `<section class="card fcard">${cardHead('Top sources')}
    <div class="hscroll"><div class="seg small fsrc-seg" role="radiogroup" aria-label="Nutrient">${SOURCE_KEYS.map((x) => `<label><input type="radio" name="fsrc" value="${x}" data-food-src${x === k ? ' checked' : ''}><span>${SOURCE_LABEL[x]}</span></label>`).join('')}</div></div>
    <div id="fsrc-list">${sourceList(h, k)}</div></section>`;
}

// Eat more of, eat less of: from his own foods, measured against reference intakes and Nutri-Score.
function adviceCard(h) {
  const a = h.advice;
  if (!a) return '';
  const row = (x, more) => {
    const why = more
      ? (x.nutrient ? `${esc(shortLabel(x.nutrient))} <small>${fmtN(x.pct)}% ${riWord()}</small>` : esc(x.reason))
      : (x.nutrient ? `${esc(shortLabel(x.nutrient))} <small>${fmtN(x.share)}% of yours</small>` : `${esc(x.reason)} <small>×${x.count}</small>`);
    return `<li>${gradeDot(x.grade)}<span class="fadv-name">${esc(x.name)}</span><span class="fadv-why ${more ? 't-good' : 't-warn'}">${why}</span></li>`;
  };
  return `<section class="card fcard f-wide">${cardHead('Eat more of, less of')}
    <div class="fadv"><div><h3 class="frank-h good">${icon('plus')}More</h3>${a.more.length ? `<ul class="fadv-list">${a.more.map((x) => row(x, true)).join('')}</ul>` : '<p class="fempty-line">Nothing stands out</p>'}</div>
    <div><h3 class="frank-h bad">Less</h3>${a.less.length ? `<ul class="fadv-list">${a.less.map((x) => row(x, false)).join('')}</ul>` : '<p class="fempty-line">Nothing over the limits</p>'}</div></div></section>`;
}

// When he eats: average energy by weekday and hour.
function timingCard(h) {
  const t = h.timing;
  if (!t) return '';
  const vals = t.kcal.flat().filter((v) => num(v) !== null);
  const max = Math.max(1, ...vals);
  const byHour = Array.from({ length: 24 }, (_, hr) => t.kcal.reduce((a, row) => a + (num(row[hr]) || 0), 0));
  const peak = byHour.indexOf(Math.max(...byHour));
  const any = vals.some((v) => v > 0);
  const rows = t.kcal.map((row, w) => `<span class="fheat-d">${WEEK[w].slice(0, 1)}</span>${row.map((v, hr) => (num(v) === null ? '<i class="na"></i>'
    : `<i style="--a:${(v / max).toFixed(3)}"${v > 0 ? ` title="${WEEK[w]} ${String(hr).padStart(2, '0')}:00, ${fmtN(v)} kcal"` : ''}></i>`)).join('')}`).join('');
  return `<section class="card fcard">${cardHead('Meal timing', any ? `<span>Peak <b>${String(peak).padStart(2, '0')}:00</b></span>` : '')}
    ${any ? `<div class="fheat" role="img" aria-label="${esc(`Energy by hour and weekday, busiest around ${peak}:00`)}"><div class="fheat-grid">${rows}</div>
      <div class="fheat-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div>` : '<p class="fempty-line">Not enough days yet</p>'}</section>`;
}

// The average day by weekday, against the period's average.
function weekdayCard(h) {
  const w = h.weekdays;
  if (!w?.some((x) => x.n)) return '';
  const series = w.map((x) => ({ date: `w${x.day}`, logged: x.n > 0, kcal: x.kcal, protein: x.protein, carbs: x.carbs, fat: x.fat }));
  const best = [...w].filter((x) => x.n).sort((a, b) => b.kcal - a.kcal)[0];
  return `<section class="card fcard">${cardHead('By weekday', best ? `<span>Most on <b>${WEEK[best.day]}</b></span>` : '')}
    ${barsHtml(series, { height: 132, values: true, avg: num(h.avg.kcal) })}
    <div class="fx-axis cols" style="grid-template-columns:repeat(7,minmax(0,1fr))" aria-hidden="true">${WEEK.map((d) => `<span>${d}</span>`).join('')}</div>
    ${barKeys(series, 'Average day')}</section>`;
}

// The chosen day's macro split against the period's average.
function splitCard(h) {
  const ch = h.chosen;
  const avg = h.avg;
  const dayName = ch.today ? 'Today' : shortDay(ch.date);
  const a = macroParts(avg);
  const d = macroParts(ch);
  const keys = ['protein', 'carbs', 'fat', ...([d, a].some((m) => m.parts.some((p) => p.key === 'unknown')) ? ['unknown'] : [])];
  const pc = (m, k) => {
    const p = m.parts.find((x) => x.key === k);
    return m.sum > 0 && p ? `${share(p.kcal, m.sum)}%` : '–';
  };
  const ring = (n, title, tot, plus) => `<figure class="fsplit-ring">${donut(n, { size: 104, sw: 12, label: `${title}, energy from`,
    center: `<b>${fmtN(tot)}${plus ? '+' : ''}</b><small>kcal</small>` })}<figcaption>${title}</figcaption></figure>`;
  return `<section class="card fcard">${cardHead('Energy split')}
    <div class="fsplit">${ring(ch, dayName, ch.kcal, ch.missing?.kcal)}${ring(avg, `${h.days}-day avg`, avg.kcal, avg.missing?.kcal)}</div>
    <table class="fsplit-table"><thead><tr><th scope="col"><span class="sr">Macro</span></th><th scope="col">${esc(dayName)}</th><th scope="col">Avg</th></tr></thead>
      <tbody>${keys.map((k) => `<tr><th scope="row"><i class="fdot m-${k}"></i>${MACRO_LABEL[k]}</th><td>${pc(d, k)}</td><td>${pc(a, k)}</td></tr>`).join('')}</tbody></table>
  </section>`;
}

// This period against the one before, as paired bars with the change beside them.
function compareCard(h) {
  const rows = [['kcal', 'Energy', 'kcal'], ['protein', 'Protein', 'g'], ['sugars', 'Sugars', 'g'], ['fibre', 'Fibre', 'g'], ['salt', 'Salt', 'g'], ['caffeine', 'Caffeine', 'mg']];
  const now = h.avg;
  const before = h.prev.avg;
  const body = rows.map(([k, label, unit]) => {
    const a = num(now[k]);
    const b = num(before[k]);
    const top = Math.max(a || 0, b || 0) || 1;
    const bar = (v, cls, plus) => `<span class="fcmp-bar ${cls}">${v === null ? '' : `<i style="--f:${(v / top).toFixed(3)}"></i>`}<b>${fmtN(v, k === 'kcal' || k === 'caffeine' ? 0 : 1)}${v !== null && plus ? '+' : ''}</b></span>`;
    let delta = '<span class="fcmp-delta none" aria-hidden="true">–</span>';
    if (a !== null && b !== null && b > 0) {
      const c = Math.round(((a - b) / b) * 100);
      delta = `<span class="fcmp-delta${c > 0 ? ' up' : c < 0 ? ' down' : ''}"><i aria-hidden="true"></i>${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c)}%</span>`;
    }
    return `<div class="fcmp-row"><span class="fcmp-label">${label}<small>${unit}</small></span>
      <span class="fcmp-bars">${bar(a, 'cur', now.missing?.[k])}${bar(b, 'prev', before.missing?.[k])}</span>${delta}</div>`;
  }).join('');
  const key = `<span><i class="fk fk-now"></i>Last ${h.days} days</span><span><i class="fk fk-prev"></i>${h.days} before</span>`;
  return `<section class="card fcard">${cardHead('Against the period before')}
    <p class="fx-keys top">${key}</p>${body}
  </section>`;
}

// Caffeine through the chosen day by hour, with drinks hanging below the line.
function caffeineCard(h) {
  const ch = h.chosen;
  const { caffeine, caffeineUnknown, drinksMl } = ch.hours;
  const height = 112;
  const mid = 74;
  const cmax = Math.max(100, ...caffeine);
  const mmax = Math.max(500, ...drinksMl);
  const slot = 100 / 24;
  const bw = slot * 0.62;
  const hatch = nextId('fc');
  let lastLabel = -9;
  const marks = caffeine.map((v, i) => {
    const x = (i * slot + (slot - bw) / 2).toFixed(3);
    let out = '';
    let topY = mid;
    if (v > 0) {
      const bh = Math.max(3, ((mid - 20) * v) / cmax);
      topY = mid - bh;
      out += `<rect x="${x}%" y="${topY.toFixed(1)}" width="${bw.toFixed(3)}%" height="${bh.toFixed(1)}" rx="2" class="fc-bar" style="animation-delay:${i * 12}ms"/>`;
    }
    if (caffeineUnknown[i]) {
      topY -= 9;
      out += `<rect x="${x}%" y="${topY.toFixed(1)}" width="${bw.toFixed(3)}%" height="8" rx="2" class="fc-unk" style="fill:url(#${hatch})"/>`;
    }
    if (v > 0 && i - lastLabel > 2) {
      lastLabel = i;
      out += `<text x="${((i + 0.5) * slot).toFixed(2)}%" y="${(topY - 5).toFixed(1)}" text-anchor="${i > 21 ? 'end' : i < 2 ? 'start' : 'middle'}" class="fx-val">${fmtN(v)}</text>`;
    }
    if (drinksMl[i] > 0) {
      const dh = Math.max(3, ((height - mid - 6) * drinksMl[i]) / mmax);
      out += `<rect x="${x}%" y="${mid + 3}" width="${bw.toFixed(3)}%" height="${dh.toFixed(1)}" rx="2" class="fd-bar" style="animation-delay:${i * 12}ms"/>`;
    }
    return out;
  }).join('');
  let now = '';
  if (ch.today) {
    const [hh, mm] = localNowHM().split(':').map(Number);
    now = `<line x1="${(((hh + mm / 60) / 24) * 100).toFixed(2)}%" x2="${(((hh + mm / 60) / 24) * 100).toFixed(2)}%" y1="8" y2="${height}" class="fc-now"/>`;
  }
  const unknown = caffeineUnknown.some(Boolean);
  const spoken = caffeine.map((v, i) => (v > 0 ? `${i}:00 ${fmtN(v)} mg` : '')).filter(Boolean).join(', ') || 'no caffeine logged';
  const side = `<span><i class="fk fk-caf"></i><b>${show(ch, 'caffeine', { unit: false })}</b> mg</span><span><i class="fk fk-drink"></i><b>${fmtN(ch.drinksMl)}</b> ml</span>`;
  return `<section class="card fcard">${cardHead(`Caffeine, ${ch.today ? 'today' : esc(shortDay(ch.date))}`, side)}
    <div class="fc-plot"><svg class="fx-svg" width="100%" height="${height}" role="img" aria-label="${esc(`Caffeine by hour: ${spoken}`)}"><defs>${hatchDef(hatch, 'caf')}</defs>
      <line x1="0" x2="100%" y1="${mid + 1}" y2="${mid + 1}" class="fx-base"/>${marks}${now}</svg></div>
    <div class="fc-axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    ${unknown ? '<p class="fx-keys"><span><i class="fk fk-unk"></i>No caffeine value</span></p>' : ''}
  </section>`;
}

// Cards below the fold are drawn when they come near the screen, once per session.
// [draw, height held while waiting, full width on wide screens]
const LAZY = {
  label: [labelCard, 300], micro: [microCard, 520, true], nlabel: [nutritionLabelCard, 420], rank: [rankCard, 260, true], sources: [sourcesCard, 300], timing: [timingCard, 250],
  advice: [adviceCard, 240, true], weekdays: [weekdayCard, 220], caffeine: [caffeineCard, 220], split: [splitCard, 300], compare: [compareCard, 330],
  weight: [() => weightCard(f().energy), 470],
  // Food and your body (food-links.js): drawn from the links, not the period.
  lstate: [() => linksStateCard(f().links), 240],
  lfuel: [() => linksTrainingCard(f().links), 330], lalcohol: [() => linksAlcoholCard(f().links), 300], lwindow: [() => linksWindowCard(f().links), 280],
};

// Trends in five tabs. Each tab's first card is drawn at once and the rest as they come near the
// screen. The tab is in the address (#/food/trends?tab=nutrients) and kept for the session.
const TABS = [['overview', 'Overview'], ['nutrients', 'Nutrients'], ['foods', 'Foods'], ['timing', 'Timing'], ['body', 'Body']];
export const TAB_CARDS = {
  overview: [(h, sel) => energyCard(h, sel), 'label'],
  nutrients: [(h) => microCard(h), 'nlabel', 'sources'],
  foods: [(h) => gradeCard(h), 'rank', 'advice'],
  timing: [(h) => timingCard(h), 'weekdays', 'caffeine', 'split', 'compare'],
  body: [(h) => burnCard(f().energy), 'weight', 'lstate', 'lfuel', 'lalcohol', 'lwindow'],
};
export const TAB_KEY = 'oath.trendsTab';
export function trendTab() {
  const q = state.query?.get('tab');
  if (TAB_CARDS[q]) return q;
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    if (TAB_CARDS[kept]) return kept;
  } catch { /* storage unavailable */ }
  return 'overview';
}
function lazy(name, h) {
  const F = f();
  if (F.shown?.has(name)) return LAZY[name][0](h);
  return `<section class="card fcard f-lazy${LAZY[name][2] ? ' f-wide' : ''}" data-lazy="${name}" style="min-height:${LAZY[name][1]}px" aria-hidden="true"></section>`;
}

let lazyIO = null;
function watchLazy() {
  lazyIO?.disconnect();
  const els = [...document.querySelectorAll('[data-lazy]')];
  if (!els.length) return;
  const draw = (el) => {
    const h = f().trend;
    const name = el.dataset.lazy;
    if (!h || !el.isConnected) return;
    (f().shown || (f().shown = new Set())).add(name);
    const html = LAZY[name][0](h);
    if (!html) {
      el.remove();
      return;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const card = tpl.content.firstElementChild;
    card.classList.add('f-enter', 'f-in');
    el.replaceWith(card);
  };
  if (!('IntersectionObserver' in window)) {
    els.forEach(draw);
    return;
  }
  lazyIO = new IntersectionObserver((list) => list.forEach((e) => {
    if (!e.isIntersecting) return;
    lazyIO.unobserve(e.target);
    draw(e.target);
  }), { rootMargin: '240px 0px' });
  els.forEach((el) => lazyIO.observe(el));
}

export function viewTrends() {
  const F = f();
  const h = F.trend;
  const span = F.span || 7;
  const head = pageHead('Trends', { over: '<a class="back-inline" href="#/food">Food</a>', actions: infoBtn('trends') });
  const seg = `<div class="seg small ftr-span" role="group" aria-label="Period">${SPANS.map((n) => `<button type="button" data-action="food-span" data-days="${n}" class="${span === n ? 'on' : ''}" aria-pressed="${span === n}">${n} days</button>`).join('')}</div>`;
  if (!h) return ctx.shell(`${head}${seg}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`);
  const sel = h.chosen.date;
  const tab = trendTab();
  // The Body tab's links load on first view and land in place (food-links.js).
  if (tab === 'body') wantLinks(F, () => redrawIfIdle('food', ctx.render));
  const legend = infoLine('trends', h.needs ? '<span><b>100%</b> your daily need, from your body</span>' : '<span><b>RI</b> EU reference intake</span>');
  const tabs = `<div class="seg ftr-tabs" role="tablist" aria-label="Trends">${TABS.map(([k, label]) => `<button type="button" role="tab" id="ftab-${k}" aria-controls="ftr-panel" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}" data-action="food-tab" data-tab="${k}">${label}</button>`).join('')}</div>`;
  const [first, ...rest] = TAB_CARDS[tab];
  const top = tab === 'overview' ? `${ctx.takeHtml('trends')}${kpiRow(h)}` : '';
  // The Body tab keeps its own windows (28 days for the real burn, 90 for the links), so it has no period.
  ctx.shell(`${head}${legend}${tabs}${tab === 'body' ? '' : seg}
    <div id="ftr-panel" role="tabpanel" aria-labelledby="ftab-${tab}">${top}
    <div class="ftr-grid${enter(`trends-${tab}`)}">${first(h, sel)}${rest.map((x) => lazy(x, h)).join('')}</div></div>${sheetHtml()}`);
  watchLazy();
}
