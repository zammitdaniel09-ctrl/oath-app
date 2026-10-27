// A recipe from a link: the sheet for the address, the draft's notice in the recipe editor (what came
// from where, and the lines that still need him), its lines with the page's own words, and the credit on
// the recipe card. The server reads the page and matches the ingredients (src/food-import.js).
import { state, esc, api, icon, toast, haptic } from './ui.js';

const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// The link in whatever was pasted: a share from another app often wraps it in words ("Try this:
// https://…"), and a typed one may leave off the https://.
export function linkIn(text) {
  const t = String(text || '').trim();
  const m = t.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[),.;!?]+$/, '');
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) return `https://${t}`;
  return '';
}

// A line still to sort out before Save: no food picked, or no amount.
export const needsFix = (l) => !(l.ref_key || l.item?.key) || !(Number(l.qty) > 0);

const canPaste = () => Boolean(navigator.clipboard?.readText);

export function importBody(s) {
  if (s.busy) {
    return `<div class="photo-busy rimp-busy" role="status"><div class="msg assistant typing" aria-label="Reading the recipe"><i></i><i></i><i></i></div>
      <p class="note">Reading ${esc(hostOf(s.url) || 'the page')} and matching each ingredient to the catalogue.</p></div>`;
  }
  return `<form data-form="food-recipe-import" class="sheet-form rimp-form">
    <p class="note">Paste a link to a recipe page. Oath reads the ingredients and matches each one to its catalogue, so the nutrition is real. Nothing is saved until you tap Save.</p>
    ${s.error ? `<p class="note bad" role="alert">${esc(s.error)}</p>` : ''}
    <label class="field"><span>Recipe link</span>
      <span class="rimp-row"><input class="input" name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        enterkeyhint="go" placeholder="https://" value="${esc(s.url || '')}" required aria-label="Recipe link">
      ${canPaste() ? '<button class="btn tinted" type="button" data-action="food-imp-paste">Paste</button>' : ''}</span></label>
    <div class="form-actions"><button class="btn primary" type="submit">Import</button></div></form>`;
}

// What the editor shows above an imported draft: where it came from, how many lines are ready, and each
// line still to sort out with the one tap that fixes it.
export function importNotice(d) {
  const im = d.imported;
  const n = d.lines.length;
  const todo = d.lines.map((l, i) => ({ l, i })).filter(({ l }) => needsFix(l));
  const list = todo.map(({ l, i }) => `<li><span class="rimp-q">${esc(l.note || l.name)}</span>
    <span class="rimp-why">${l.item ? `${esc(l.item.name)}: the page gives no amount` : 'Not in the catalogue yet'}</span>
    <button class="btn tinted small" type="button" data-action="food-imp-fix" data-index="${i}">${l.item ? 'Add the amount' : 'Pick the food'}</button></li>`).join('');
  const site = /^https?:\/\//i.test(im.url || '') ? `<a href="${esc(im.url)}" target="_blank" rel="noopener noreferrer">${esc(im.site || hostOf(im.url))}</a>` : esc(im.site || '');
  return `<section class="rimp-note${todo.length ? ' todo' : ''}" aria-label="Imported recipe">
    <p class="rimp-from">${icon('link')}<span>From ${site}. ${n - todo.length} of ${n} ${n === 1 ? 'ingredient is' : 'ingredients are'} matched and measured.</span></p>
    ${todo.length ? `<p class="rimp-k">${todo.length === 1 ? 'One line needs you' : `${todo.length} lines need you`}</p><ul class="rimp-list">${list}</ul>` : ''}
    ${im.servingsUnknown && !(Number(d.servings) > 0) ? '<p class="note">The page does not say how many it serves, so fill in Servings.</p>' : ''}
    <p class="note rimp-check">Check the amounts against the page, then tap Save. Nothing is saved until then.</p>
  </section>`;
}

// One line of an imported draft: the food it was matched to with the page's own words under it, or the
// page's words alone when nothing matched. `unitOptions` is the editor's own.
export function importedRow(l, i, unitOptions) {
  const fix = needsFix(l);
  const said = l.note ? `“${esc(l.note)}”` : '';
  const est = l.estimate && !fix ? ' · <i class="est">~</i>amount worked out' : '';
  const change = `<button class="linkish" type="button" data-action="food-imp-fix" data-index="${i}">${l.item ? 'Change' : 'Pick the food'}</button>`;
  const body = l.item
    ? `<span class="li-title">${esc(l.item.name)}</span><span class="li-sub rimp-said">${said}${est} · ${change}</span>
      <span class="amount-row small"><input class="input" inputmode="decimal" value="${esc(l.qty ?? '')}" placeholder="amount" data-re-index="${i}" data-re-field="qty" aria-label="Amount">
        <select class="input" data-re-index="${i}" data-re-field="unit" aria-label="Unit">${unitOptions(l.item, l.unit)}</select></span>`
    : `<span class="li-title">${said || esc(l.name)}</span><span class="li-sub">Not in the catalogue yet · ${change}</span>`;
  return `<div class="li li-plain bline rimp-line${fix ? ' needs' : ''}"><span class="li-body">${body}</span>
    <span class="li-side"><button class="icon-btn" type="button" data-action="food-re-drop" data-index="${i}" aria-label="Remove">${icon('close')}</button></span></div>`;
}

// Typing an amount into a marked line clears its mark and updates the notice, without redrawing the
// sheet under his fingers.
export function importTyped(d, i) {
  const box = document.querySelector('.rimp-note');
  if (box) box.outerHTML = importNotice(d);
  document.querySelector(`[data-re-index="${i}"]`)?.closest('.rimp-line')?.classList.toggle('needs', needsFix(d.lines[i]));
}

// Under the search while he picks the food for an imported line: Open Food Facts, for a product the
// catalogue does not have yet. Other picks keep their plain list.
export function fixExtras(s) {
  if (s.pick?.purpose !== 'recipe-fix') return '';
  return `<div class="food-none"><p class="eyebrow">Not here?</p><div class="sheet-actions">
    ${s.q ? `<button class="btn tinted" data-action="food-off">${icon('search')}Search Open Food Facts for "${esc(s.q)}"</button>` : ''}</div>
    <p class="note">Or close this and remove the line, if the recipe works without it.</p></div>`;
}

// What an imported draft adds when it is saved: its status and the page it came from.
export const importFields = (d) => (d.imported ? { status: 'imported', source_url: d.source_url, source_name: d.source_name } : {});

// The credit on a recipe card: "From <site>", linking to the page.
export function sourceCredit(r) {
  if (!/^https?:\/\//i.test(r?.source_url || '')) return '';
  return `<p class="rsrc">${icon('link')}<span>From <a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer">${esc(r.source_name || hostOf(r.source_url))}</a></span></p>`;
}

// The link sheet's submit: busy while the server reads, then the editor with the draft. A sheet closed
// meanwhile stays closed.
export async function importSubmit(form, { open, render }) {
  const s = state.foodSheet;
  const url = linkIn(form.url?.value);
  if (!url) {
    // What he typed stays in the box to correct.
    s.url = String(form.url?.value || '').trim();
    s.error = 'That does not look like a link. Paste the address of the recipe page.';
    render();
    return;
  }
  Object.assign(s, { url, busy: true, error: null });
  haptic('send');
  render();
  try {
    const r = await api('POST', '/api/food/recipes/import', { url });
    if (state.foodSheet !== s) return;
    const d = r.draft;
    if (d.servings === null || d.servings === undefined) d.servings = '';
    haptic('receive');
    open({ kind: 'recipe-edit', draft: d });
  } catch (err) {
    if (state.foodSheet !== s) return;
    Object.assign(s, { busy: false, error: err.status === 0 ? 'Importing a recipe needs a connection.' : err.message });
    render();
  }
}

// The actions of this feature. `h` carries the editor's helpers: open, render, save (keeps what is typed
// in the editor), defaults (a first amount for a food) and search (runs a catalogue search).
export async function importClick(a, el, h) {
  const s = state.foodSheet;
  switch (a) {
    case 'food-imp-open':
      h.open({ kind: 'recipe-import', url: '' });
      return true;
    case 'food-imp-paste': {
      const input = document.querySelector('.rimp-form input[name="url"]');
      try {
        const text = await navigator.clipboard.readText();
        if (input) {
          input.value = linkIn(text) || text.trim();
          input.focus();
        }
      } catch {
        toast('Long-press the box and choose Paste.');
      }
      return true;
    }
    case 'food-imp-fix': {
      // A line he fixes: its matched food straight to the amount, or a search that starts with the
      // matcher's other candidates and the amount the page gave.
      h.save(s);
      const i = Number(el.dataset.index);
      const l = s.draft.lines[i];
      if (!l) return true;
      const pick = { purpose: 'recipe-fix', index: i, amount: l.hint || (Number(l.qty) > 0 ? { qty: Number(l.qty), unit: l.unit } : null) };
      if (l.item && !(Number(l.qty) > 0)) {
        const d = h.defaults(l.item);
        h.open({ kind: 'food', item: l.item, qty: d.qty, unit: d.unit, pick, back: s });
        return true;
      }
      const alts = (l.alternatives || []).filter((x) => x?.key && x.key !== l.item?.key);
      const q = l.search || l.label || '';
      h.open({ kind: 'search', q, results: alts.length ? [l.item, ...alts].filter(Boolean) : null, pick, back: s });
      if (q && !alts.length) await h.search(q, true);
      return true;
    }
    default:
      return false;
  }
}
