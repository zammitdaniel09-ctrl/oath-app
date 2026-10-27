// The tag database on the phone. On a food: the strongest few tags up front, the UK traffic lights as a
// strip, his habits, and every other tag folded by group, each with its reason a tap away. On its own
// page (#/food/tags): every tag Oath has, with how many of his foods and of the whole catalogue carry it,
// and for one tag (#/food/tags/high-iron) his foods first, then the best of the catalogue.
import { state, esc, api, icon, pageHead } from './ui.js';
import { TAG, TAGS, TAG_GROUPS } from './food-tags.js';

// What food.js lends this module (see initTagDb there).
let D = null;
const F = () => D.f();
const fmt = (n) => new Intl.NumberFormat('en-GB').format(n);
const enc = encodeURIComponent;

export function initTagDb(deps) {
  D = deps;
}

// ---------- On a food ----------

// The four lights and the tags that light them.
const LIGHTS = [
  ['fat', 'Fat', { green: ['fat-free', 'low-fat'], amber: ['medium-fat'], red: ['high-fat'] }],
  ['satfat', 'Saturates', { green: ['saturates-free', 'low-saturates'], amber: ['medium-saturates'], red: ['high-saturates'] }],
  ['sugars', 'Sugars', { green: ['sugar-free', 'low-sugar'], amber: ['medium-sugar'], red: ['sugar-rush'] }],
  ['salt', 'Salt', { green: ['salt-free', 'very-low-salt', 'low-salt'], amber: ['medium-salt'], red: ['salty'] }],
];
const LEVEL_WORD = { green: 'Low', amber: 'Medium', red: 'High' };
const LIT = new Set(LIGHTS.flatMap(([, , l]) => Object.values(l).flat()));
// Groups with a place of their own on the sheet, and tags too quiet to lead with.
const OWN_PLACE = new Set(['lights', 'vitamins', 'body', 'allergens', 'additives', 'habits']);
const QUIET = new Set(['medium-density', 'low-density', 'balanced-macros', 'caffeinated', 'sold-in-malta', 'eco-mid', 'processed', 'culinary-ingredient']);
const HEADLINE = 7;

const chip = (t) => `<button type="button" class="ftag t-${esc(t.tone || 'neutral')}" data-action="food-tag"${t.why ? ` data-why="${esc(t.why)}"` : ''} aria-expanded="false">${esc(t.label)}</button>`;
const box = (inner, cls = '') => `<div class="ftags${cls}" data-tagbox>${inner}<p class="ftag-why" aria-live="polite" hidden></p></div>`;

// The tags that lead: the strongest signals that have no place of their own below.
function headline(tags) {
  return tags.filter((t) => (!OWN_PLACE.has(t.group || TAG[t.key]?.group) || t.key === 'all-green' || t.key === 'red-lights') && !QUIET.has(t.key)).slice(0, HEADLINE);
}

function lightsHtml(tags) {
  const by = new Map(tags.map((t) => [t.key, t]));
  const cells = LIGHTS.map(([, word, levels]) => {
    for (const lv of ['red', 'amber', 'green']) {
      const t = levels[lv].map((k) => by.get(k)).find(Boolean);
      if (t) return { word, lv, t };
    }
    return { word, lv: null, t: null };
  });
  if (!cells.some((c) => c.lv)) return '';
  return `<div class="ftl" role="group" aria-label="UK traffic lights per 100">${cells.map((c) => (c.lv
    ? `<button type="button" class="ftl-c l-${c.lv}" data-action="food-tag" data-why="${esc(c.t.why || '')}" aria-expanded="false"><span class="ftl-k">${c.word}</span><span class="ftl-v">${LEVEL_WORD[c.lv]}</span></button>`
    : `<span class="ftl-c l-none"><span class="ftl-k">${c.word}</span><span class="ftl-v">Not known</span></span>`)).join('')}</div>`;
}

// The top of a food's sheet: the tags that lead, the traffic lights and his habits.
export function tagPanel(tags) {
  const list = (tags || []).filter((t) => t?.label);
  if (!list.length) return '';
  const head = headline(list);
  const habits = list.filter((t) => (t.group || TAG[t.key]?.group) === 'habits');
  return `<div class="ftp">
    ${head.length ? box(head.map(chip).join('')) : ''}
    ${box(lightsHtml(list), ' ftl-box')}
    ${habits.length ? `<div class="ftp-you"><span class="ftp-you-k">You</span>${box(habits.map(chip).join(''), ' in')}</div>` : ''}
  </div>`;
}

// The rest of a food's tags, folded by group, for under its nutrition facts: what the panel above
// does not already show.
export function tagMore(tags, { all = true } = {}) {
  const list = (tags || []).filter((t) => t?.label);
  if (!list.length) return '';
  const shown = new Set([...headline(list).map((t) => t.key), ...list.filter((t) => LIT.has(t.key) || (t.group || TAG[t.key]?.group) === 'habits').map((t) => t.key)]);
  const rest = TAG_GROUPS.map((g) => ({ ...g, tags: list.filter((t) => !shown.has(t.key) && (t.group || TAG[t.key]?.group) === g.key) })).filter((g) => g.tags.length);
  const folded = rest.map((g) => `<details class="ftg"><summary><span class="ftg-name">${esc(g.label)}</span><span class="ftg-n">${g.tags.length}</span>${icon('chevron', 'chev')}</summary>
    ${box(g.tags.map(chip).join(''), ' in')}</details>`).join('');
  return `<section class="ftp-more" aria-label="Every tag">
    <div class="nf-top"><h3>Tags</h3><span class="nf-per">${list.length} on this food</span></div>
    ${folded ? `<div class="ftg-list">${folded}</div>` : ''}
    ${all ? `<a class="ftp-all" href="#/food/tags">Browse all ${TAGS.length} tags${icon('chevron', 'chev')}</a>` : ''}
  </section>`;
}

// The one tag a diary row shows: the first that says more than the grade dot beside it already does.
const ROW_SKIP = new Set(['good-choice', 'eat-less', ...QUIET]);
export function rowTag(tags) {
  return (tags || []).find((t) => t?.label && !ROW_SKIP.has(t.key) && !String(t.key).startsWith('medium-')
    && !['vitamins', 'body', 'habits', 'additives'].includes(t.group || TAG[t.key]?.group)) || null;
}

// The first few for a diary row, one per kind of thing they say (one light, one food group).
export function rowTags(tags, n = 2) {
  const out = [];
  const seen = new Set();
  for (const t of tags || []) {
    if (out.length >= n) break;
    if (!rowTag([t])) continue;
    const g = t.group || TAG[t.key]?.group;
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(t);
  }
  return out;
}

// A tap on a tag or a light shows why, under its own group; a second tap hides it.
function showWhy(el) {
  const b = el.closest('[data-tagbox]');
  const why = b?.querySelector(':scope > .ftag-why');
  if (!why) return;
  const open = el.getAttribute('aria-expanded') === 'true';
  b.querySelectorAll('[aria-expanded]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  if (open || !el.dataset.why) {
    why.hidden = true;
    return;
  }
  el.setAttribute('aria-expanded', 'true');
  why.textContent = el.dataset.why;
  why.hidden = false;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) why.animate?.([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
}

// ---------- The browser ----------

export async function loadTags(key) {
  if (key) {
    if (F().tag?.tag?.key !== key) F().tag = null;
    F().tag = await api('GET', `/api/food/tags/${enc(key)}`);
  } else {
    F().tagIndex = await api('GET', '/api/food/tags');
  }
}

const back = (href, label) => `<a class="back" href="${href}">${icon('back')}${label}</a>`;

function indexHtml(T) {
  const mode = F().tagMode === 'all' ? 'all' : 'mine';
  const q = String(F().tagQ || '').trim().toLowerCase();
  const groups = T.groups.map((g) => ({
    ...g,
    tags: g.tags.filter((t) => (mode === 'all' || t.mine > 0) && (!q || t.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q))),
  })).filter((g) => g.tags.length);
  const used = T.groups.reduce((n, g) => n + g.tags.filter((t) => t.mine > 0).length, 0);
  const row = (t) => `<a class="tg-row t-${esc(t.tone)}${!t.mine && !t.all ? ' none' : ''}" href="#/food/tags/${enc(t.key)}">
      <span class="tg-dot" aria-hidden="true"></span><span class="tg-name">${esc(t.label)}</span>
      <span class="tg-n"><b>${t.mine ? fmt(t.mine) : '–'}</b><small>yours</small></span>
      <span class="tg-n all"><b>${t.all ? fmt(t.all) : '–'}</b><small>all</small></span>${icon('chevron', 'chev')}</a>`;
  return `<div class="tg-stats">
      <div class="tg-stat"><b>${fmt(T.total)}</b><span>tags</span></div>
      <div class="tg-stat"><b>${fmt(used)}</b><span>on your foods</span></div>
      <div class="tg-stat"><b>${fmt(T.foods.all)}</b><span>foods tagged</span></div>
    </div>
    <div class="tg-tools">
      <input class="input" type="search" placeholder="Find a tag" value="${esc(F().tagQ || '')}" data-tags-q aria-label="Find a tag" autocomplete="off">
      <div class="seg" role="group" aria-label="Show">
        <button type="button" class="seg-b" data-action="food-tags-mode" data-mode="mine" aria-pressed="${mode === 'mine'}">Yours</button>
        <button type="button" class="seg-b" data-action="food-tags-mode" data-mode="all" aria-pressed="${mode === 'all'}">All ${fmt(T.total)}</button>
      </div>
    </div>
    <div id="tg-groups">${groups.length ? groups.map((g) => `<section class="tg-group"><h2 class="tg-h">${esc(g.label)}<span>${g.tags.length}</span></h2>
      <div class="group">${g.tags.map(row).join('')}</div></section>`).join('')
    : `<p class="note">${q ? `No tag matches "${esc(q)}".` : 'None of your foods carry a tag yet. Log a few and they will.'}</p>`}</div>`;
}

function foodRow(x) {
  const v = x.value ? `${fmt(Math.round(x.value.amount * 10) / 10)} ${esc(x.value.unit)}` : x.share ? `${x.share}%` : x.kcal !== null ? `${fmt(Math.round(x.kcal))} kcal` : '';
  return `<button type="button" class="li li-plain fr tg-food" data-action="food-pick" data-key="${esc(x.key)}">
    ${x.grade ? `<span class="ns-dot ns-${esc(x.grade)}" aria-hidden="true">${esc(x.grade.toUpperCase())}</span>` : '<span class="ns-dot ns-none" aria-hidden="true"></span>'}
    <span class="li-body"><span class="li-title">${esc(x.name)}${x.brand ? ` <small class="faint">${esc(x.brand)}</small>` : ''}</span>
    <span class="li-sub">${esc(x.value || x.share ? [x.kcal !== null ? `${fmt(Math.round(x.kcal))} kcal / 100 ${x.liquid ? 'ml' : 'g'}` : null, x.kind === 'product' ? 'product' : null].filter(Boolean).join(' · ') : x.why || '')}</span></span>
    ${v ? `<span class="tg-val">${v}<small>/ 100 ${x.liquid ? 'ml' : 'g'}</small></span>` : ''}</button>`;
}

function tagHtml(T) {
  const t = T.tag;
  return `<p class="tg-about">${esc(t.about)}</p>
    <section class="tg-sec"><h2 class="tg-h">Your foods<span>${fmt(T.mine.length)}</span></h2>
      ${T.mine.length ? `<div class="group">${T.mine.map(foodRow).join('')}</div>` : '<p class="note">None of the foods you have logged carry it yet.</p>'}</section>
    ${t.group === 'habits' ? '' : `<section class="tg-sec"><h2 class="tg-h">In the catalogue<span>${fmt(T.total)}</span></h2>
      ${T.all.length ? `<div class="group">${T.all.map(foodRow).join('')}</div>${T.total > T.all.length + T.mine.length ? `<p class="note">The best ${T.all.length} of ${fmt(T.total)}, ranked by what the tag is about. Search finds the rest.</p>` : ''}`
        : '<p class="note">No other food in the catalogue carries it.</p>'}</section>`}`;
}

export function viewTags() {
  const key = state.param2;
  if (key) {
    const T = F().tag;
    const head = `${back('#/food/tags', 'Tags')}${pageHead(esc(T?.tag?.label || TAG[key]?.label || 'Tag'), { over: esc(T?.tag?.groupLabel || '') })}`;
    if (!T || T.tag.key !== key) return D.shell(`${head}<div class="skeleton"><i></i><i class="short"></i></div>`);
    return D.shell(`${head}<div class="tg-page t-${esc(T.tag.tone)}">${tagHtml(T)}</div>${D.sheetHtml()}`);
  }
  const T = F().tagIndex;
  const head = `${back('#/food', 'Food')}${pageHead('Tags')}`;
  if (!T) return D.shell(`${head}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`);
  return D.shell(`${head}<div class="tg-page">${indexHtml(T)}</div>${D.sheetHtml()}`);
}

export function tagsClick(a, el) {
  if (a === 'food-tag') {
    showWhy(el);
    return true;
  }
  if (a === 'food-tags-mode') {
    F().tagMode = el.dataset.mode === 'all' ? 'all' : 'mine';
    D.render();
    return true;
  }
  return false;
}

// Typing in "Find a tag" redraws only the list, so the keyboard stays up.
export function tagsInput(el) {
  if (!el.matches('[data-tags-q]')) return false;
  F().tagQ = el.value;
  const T = F().tagIndex;
  const box2 = document.getElementById('tg-groups');
  if (!T || !box2) return true;
  const tmp = document.createElement('div');
  tmp.innerHTML = indexHtml(T);
  box2.replaceWith(tmp.querySelector('#tg-groups'));
  return true;
}
