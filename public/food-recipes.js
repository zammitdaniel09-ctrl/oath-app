// Recipes (Oath's library and your own), a recipe's page, saved meals and the coverage report.
import { esc, icon, pageHead, cap } from './ui.js';
import {
  enc, FAMILIES, kcal, f, STATUS, gradeOf, safely, nutriBadge, strip, factsHtml, BUILDERS, shortLabel,
} from './food-parts.js';
import * as N from './nutrition.js';
import { round, norm, show } from './nutrition.js';
import { sheetHtml } from './food-sheets.js';
import { sourceCredit } from './food-import.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };
export function initFoodRecipes(c) {
  ctx = { ...ctx, ...c };
}

function recipeRow(r) {
  const time = (r.prep_min || 0) + (r.cook_min || 0);
  return `<a class="li li-nav recipe-row" href="#/food/recipe/${enc(r.key)}"><span class="li-body">
    <span class="li-title">${esc(r.name)}${r.name_mt ? ` <em class="serif mt">${esc(r.name_mt)}</em>` : ''}</span>
    <span class="li-sub">${esc(FAMILIES[r.family] || r.family || '')}${r.type === 'template' ? ' · combination' : r.type === 'component' ? ' · component' : r.type === 'variant' ? ' · variant' : ''} · serves ${round(r.servings, 1)}${time ? ` · ${time} min` : ''}${r.perServing ? ` · ${kcal(r.perServing)} a serving` : ''}${r.source === 'you' ? ' <span class="tag">Yours</span>' : ''}</span></span>${icon('chevron', 'chev')}</a>`;
}

export function viewRecipes() {
  const F = f();
  const all = F.recipes;
  const head = pageHead('Recipes', { over: '<a class="back-inline" href="#/food">Food</a>', actions: `<button class="icon-btn" data-action="food-imp-open" aria-label="Import from a link" title="Import from a link">${icon('link')}</button><button class="icon-btn accent" data-action="food-recipe-new" aria-label="New recipe">${icon('plus')}</button>` });
  if (!all) return ctx.shell(`${head}<div class="skeleton"><i></i><i class="short"></i></div>${sheetHtml()}`);
  const fl = F.filter || (F.filter = { q: '', family: '', type: 'all', limit: 60 });
  const q = norm(fl.q);
  const list = all.filter((r) => (!fl.family || r.family === fl.family)
    && (fl.type === 'all' || (fl.type === 'recipes' && ['base', 'variant'].includes(r.type)) || (fl.type === 'combos' && r.type === 'template') || (fl.type === 'components' && r.type === 'component') || (fl.type === 'mine' && r.source === 'you'))
    && (!q || q.split(' ').every((w) => norm(`${r.name} ${r.name_mt || ''} ${(r.tags || []).join(' ')}`).includes(w))));
  const fams = [...new Set(all.map((r) => r.family))].filter(Boolean);
  const types = [['all', 'All'], ['recipes', 'Recipes'], ['combos', 'Combos'], ['components', 'Components'], ['mine', 'Yours']];
  ctx.shell(`${head}
    <div class="recipe-filters"><input class="input" type="search" placeholder="Search ${all.length} recipes" value="${esc(fl.q)}" data-recipe-q aria-label="Search recipes">
      <select class="input" data-recipe-family aria-label="Family"><option value="">All families</option>${fams.map((x) => `<option value="${x}"${x === fl.family ? ' selected' : ''}>${esc(FAMILIES[x] || x)}</option>`).join('')}</select></div>
    <div class="seg small type-seg" role="group" aria-label="Kind">${types.map(([v, l]) => `<button type="button" data-action="food-recipe-type" data-type="${v}" class="${fl.type === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="recipe-list"><div class="group">${list.slice(0, fl.limit).map(recipeRow).join('') || '<p class="note pad">No recipes match.</p>'}</div>
    ${list.length > fl.limit ? `<div class="form-actions"><button class="btn tinted small" data-action="food-recipe-more">Show more (${list.length - fl.limit})</button></div>` : ''}</div>
    ${sheetHtml()}`);
}

export function viewRecipe() {
  const r = f().recipe;
  const back = `<a class="back" href="#/food/recipes">${icon('back')}Recipes</a>`;
  if (!r) return ctx.shell(`${back}<div class="skeleton"><i></i><i class="short"></i></div>`);
  const o = f().opts;
  const per = r.perServing || r.totals;
  const groups = [...new Set(r.lines.map((l) => l.grp || ''))];
  const lineRow = (l) => {
    const off = l.optional && l.skipped;
    const swapped = o.swap[l.index];
    return `<div class="li li-plain rline${off ? ' off' : ''}">
      ${l.optional ? `<input class="ropt" type="checkbox" data-action="food-r-opt" data-index="${l.index}"${off ? '' : ' checked'} aria-label="Include ${esc(l.label || l.name)}">` : ''}
      <span class="li-body"><span class="li-title">${esc(cap(l.label || l.name))}${l.optional ? ' <small class="faint">optional</small>' : ''}</span>
        <span class="li-sub">${esc(l.amount_text)} · ${l.ref === 'recipe' ? `<a href="#/food/recipe/${enc(l.ref_key)}">${esc(l.name)}</a>` : esc(l.name)}${swapped ? ' · swapped' : ''}${l.missing ? ' · <b>not in the catalogue</b>' : ''}</span></span>
      <span class="li-side">${off ? '' : l.nutrients ? kcal(l.nutrients) : ''}${l.ref === 'item' ? `<button class="btn plain small" data-action="food-r-swap" data-index="${l.index}">Swap</button>` : ''}</span></div>`;
  };
  const factors = [[0.5, '×½'], [1, '×1'], [2, '×2'], [3, '×3']];
  const status = STATUS[r.status] || r.status;
  const mine = r.source === 'you';
  const g = r.per100 ? gradeOf(safely(() => N.nutriScore?.(r.per100, { liquid: false }))) : null;
  ctx.shell(`${back}${pageHead(esc(r.name), { over: esc(FAMILIES[r.family] || r.family || '') })}
    ${r.name_mt ? `<p class="serif mt-big">${esc(r.name_mt)}</p>` : ''}
    ${r.summary ? `<p class="rsum">${esc(r.summary)}</p>` : ''}
    <p class="rtags"><span class="tag">${r.type === 'template' ? 'Combination' : r.type === 'component' ? 'Component' : r.type === 'variant' ? 'Variant' : 'Recipe'}</span><span class="tag ${r.status === 'ai-untested' ? 'ftag-est' : ''}">${esc(status)}</span>${mine ? '<span class="tag">Yours</span>' : ''}${r.parent ? ` <a class="tag" href="#/food/recipe/${enc(r.parent.key)}">Based on ${esc(r.parent.name)}</a>` : ''}</p>
    ${sourceCredit(r)}
    <div class="split"><div>
    <section class="card food-total"><div class="ft-main"><b class="ft-kcal">${show(per, 'kcal', { unit: false })}</b><span class="ft-unit">kcal a serving</span>${g ? nutriBadge(g) : ''}</div>${strip(per)}
      <p class="ft-extra"><span>Whole recipe ${kcal(r.totals)} · serves ${round(r.servings * o.factor, 2)}${r.per100 ? ` · ${kcal(r.per100)} per 100 g` : ''}${(r.prep_min || r.cook_min) ? ` · ${(r.prep_min || 0) + (r.cook_min || 0)} min` : ''}</span></p>
      ${r.errors?.length ? `<p class="note bad">${esc(r.errors.join(' '))}</p>` : ''}</section>
    <div class="seg small" role="group" aria-label="Scale">${factors.map(([v, l]) => `<button type="button" data-action="food-r-factor" data-factor="${v}" class="${o.factor === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="form-actions recipe-actions"><button class="btn primary" data-action="food-r-log">Log a serving</button>
      ${r.type === 'template' ? '<button class="btn tinted" data-action="food-r-builder">Open in the builder</button>' : '<button class="btn tinted" data-action="food-r-cook">Cook a batch</button>'}
      <button class="btn tinted" data-action="food-r-plan">Plan</button><button class="btn tinted" data-action="food-r-dup">${icon('copy')}Make my version</button>
      ${mine ? '<button class="btn tinted" data-action="food-r-edit">Edit</button><button class="btn plain" data-action="food-r-del">Delete</button>' : ''}</div>
    <section class="section"><div class="gh"><h2>Ingredients</h2>${Object.keys(o.swap).length || o.skip.length || o.with.length ? '<button class="gh-link" data-action="food-r-reset">Reset</button>' : ''}</div>
      ${groups.map((gr) => `${gr ? `<p class="eyebrow">${esc(gr)}</p>` : ''}<div class="group">${r.lines.filter((l) => (l.grp || '') === gr).map(lineRow).join('')}</div>`).join('')}</section>
    </div><div>
    ${r.method?.length ? `<section class="section"><div class="gh"><h2>Method</h2></div><ol class="method">${r.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ol></section>` : ''}
    ${r.variants?.length ? `<section class="section"><div class="gh"><h2>Variants</h2></div><div class="group">${r.variants.map((v) => `<a class="li li-nav" href="#/food/recipe/${enc(v.key)}"><span class="li-body"><span class="li-title">${esc(v.name)}</span></span>${icon('chevron', 'chev')}</a>`).join('')}</div></section>` : ''}
    ${r.notes ? `<details class="card disclosure"><summary>Notes</summary><p class="note">${esc(r.notes)}</p></details>` : ''}
    <section class="section"><div class="gh"><h2>Nutrition</h2><span class="gh-count">a serving</span></div><div class="card nf nf-card">${factsHtml(per)}</div></section>
    </div></div>${sheetHtml()}`);
}

// ---------- Saved meals ----------

export function viewMeals() {
  const meals = f().meals;
  const head = pageHead('Saved meals', { over: '<a class="back-inline" href="#/food">Food</a>' });
  if (!meals) return ctx.shell(`${head}<div class="skeleton"><i class="short"></i><i class="short"></i></div>${sheetHtml()}`);
  ctx.shell(`${head}
    <div class="fcap-tools meal-tools" role="group" aria-label="New">${['shake', 'bowl', 'plate', 'meal'].map((m) => `<button type="button" class="fcap-tool" data-action="food-builder" data-mode="${m}"><span>${BUILDERS[m].title}</span></button>`).join('')}</div>
    ${meals.length ? `<div class="group">${meals.map((m) => `<div class="li li-plain">
      <span class="li-ic">${icon((BUILDERS[m.kind] || BUILDERS.meal).icon)}</span>
      <button class="li-body linkish-block" data-action="food-meal-open" data-id="${m.id}"><span class="li-title">${esc(m.name)}</span><span class="li-sub">${m.lines.length} items · ${kcal(m.nutrients)}</span></button>
      <span class="li-side meal-actions"><button class="btn tinted small" data-action="food-meal-log" data-id="${m.id}">Log</button><button class="icon-btn" data-action="food-meal-del" data-id="${m.id}" aria-label="Delete ${esc(m.name)}">${icon('trash')}</button></span></div>`).join('')}</div>`
      : '<div class="card fempty"><p>No saved meals yet</p></div>'}
    ${sheetHtml()}`);
}

// ---------- Coverage report: what the catalogue holds ----------

export function viewReport() {
  const r = f().report;
  const head = pageHead('Coverage', { over: '<a class="back-inline" href="#/settings">Settings</a>' });
  if (!r) return ctx.shell(`${head}<div class="skeleton"><i></i><i class="short"></i></div>`);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const cat = (c, list) => {
    const good = list === 'food' ? (c.counts.mapped || 0) + (c.counts.products || 0) + (c.counts.recipe || 0) : c.counts.covered || 0;
    return `<details class="disclosure cov"><summary><span class="cov-name">${esc(c.label || c.category)}</span><span class="cov-n">${good}/${c.total}</span>
      <span class="pbar thin"><i style="width:${pct(good, c.total)}%"></i></span></summary>
      <p class="note">${Object.entries(c.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      ${c.open.length ? `<ul class="cov-open">${c.open.map((o) => `<li><b>${esc(o.name)}</b> <span class="tag">${esc(o.state)}</span>${o.issue ? ` ${esc(o.issue)}` : ''}</li>`).join('')}</ul>` : ''}</details>`;
  };
  const nut = r.nutrients;
  const nutRows = nut ? nut.list.map((x) => `<div class="rirow"><span class="rirow-k">${esc(shortLabel(x.key))}</span><span class="rirow-bar"><i style="--f:${(nut.total ? x.count / nut.total : 0).toFixed(3)}"></i></span><span class="rirow-v">${pct(x.count, nut.total)}%</span></div>`).join('') : '';
  ctx.shell(`${head}
    <div class="stats cov-stats">
      <div class="card"><p class="eyebrow">Foods</p><b class="big">${r.foods.matched}<small>/${r.foods.total}</small></b><p class="li-sub">${r.foods.incomplete} partial · ${r.foods.missing} missing</p></div>
      <div class="card"><p class="eyebrow">Recipes</p><b class="big">${r.recipes.covered}<small>/${r.recipes.total}</small></b><p class="li-sub">${r.recipes.byType.base || 0} base · ${r.recipes.byType.variant || 0} variants</p></div>
      <div class="card"><p class="eyebrow">Catalogue</p><b class="big">${r.catalogue.generic + r.catalogue.estimates + r.catalogue.products + r.catalogue.yours}</b><p class="li-sub">${r.catalogue.products} products · ${r.catalogue.yours} yours${nut ? ` · ${nut.graded} graded` : ''}</p></div>
    </div>
    ${nutRows ? `<section class="section"><div class="gh"><h2>Values on record</h2><span class="gh-count">of ${nut.total} foods</span></div><div class="card fcard">${nutRows}</div></section>` : ''}
    <section class="section"><div class="gh"><h2>Foods by category</h2></div>${r.foods.categories.map((c) => cat(c, 'food')).join('')}</section>
    <section class="section"><div class="gh"><h2>Recipes by family</h2></div>${r.recipes.categories.map((c) => cat(c, 'recipe')).join('')}</section>`);
}
