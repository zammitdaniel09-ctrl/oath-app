// Mail: his Gmail inbox as Oath reads it. Important email first, each with why, what to do and by
// when, Done and Not important on each; everything else below, grouped by kind. Before Gmail is
// connected the screen walks through making an app password and pasting it in. The password goes to
// the server once and never comes back.
import { state, esc, api, act, toast, icon, pageHead, ago, confirmSheet, haptic, fmtDay } from './ui.js';

let ctx = { shell: () => {}, render: () => {} };
export function initMail(c) {
  ctx = c;
}

const KIND = {
  personal: 'Personal', work: 'Work', studies: 'Studies', finance: 'Money', travel: 'Travel', shopping: 'Orders and deliveries',
  security: 'Security', newsletters: 'Newsletters', promotions: 'Promotions', social: 'Social', notifications: 'Notifications', other: 'Other',
};
const SHOWN = 5;
const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';

const m = () => state.mail;

export async function loadMail() {
  state.mail = await api('GET', '/api/mail');
}

// After connecting, the first read runs on the server: ask again a few times until it lands.
let waitTimer = null;
function waitForFirstRead(tries = 15) {
  clearTimeout(waitTimer);
  waitTimer = setTimeout(async () => {
    if (state.route !== 'mail') return;
    try {
      await loadMail();
    } catch { /* try again */ }
    const a = m()?.account;
    if (a?.lastSync || a?.error || tries <= 1) {
      state.mailReading = false;
      ctx.render();
    } else {
      waitForFirstRead(tries - 1);
    }
  }, 4000);
}

const when = (iso) => {
  const d = new Date(iso);
  const mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 60 * 20) return ago(iso);
  return fmtDay(iso.slice(0, 10), { weekday: 'short', day: 'numeric', month: 'short' });
};

function dueChip(due) {
  if (!due) return '';
  return `<span class="ml-due">${icon('calendar')}${esc(fmtDay(due, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>`;
}

function importantCard(x) {
  return `<article class="card ml-card${x.done ? ' done' : ''}">
    <header class="ml-top"><span class="ml-from">${esc(x.from)}</span><time>${esc(when(x.receivedAt))}</time></header>
    <p class="ml-subject">${esc(x.subject || '(no subject)')}</p>
    ${x.summary ? `<p class="ml-summary">${esc(x.summary)}</p>` : ''}
    ${x.action || x.due || x.reason ? `<div class="ml-meta">${x.action ? `<span class="ml-action">${icon('check')}${esc(x.action)}</span>` : ''}${dueChip(x.due)}${x.reason && !x.action ? `<span class="ml-reason">${esc(x.reason)}</span>` : ''}</div>` : ''}
    <div class="ml-btns">
      ${x.done ? `<button type="button" class="btn tinted small" data-action="mail-undone" data-id="${x.id}">Not done</button>`
        : `<button type="button" class="btn primary small" data-action="mail-done" data-id="${x.id}">${icon('check')}Done</button>
      <button type="button" class="btn tinted small" data-action="mail-unimportant" data-id="${x.id}">Not important</button>`}
      ${x.link ? `<a class="btn plain small ml-open" href="${esc(x.link)}" target="_blank" rel="noopener">Open in Gmail${icon('chevron')}</a>` : ''}
    </div>
  </article>`;
}

function otherRow(x) {
  return `<div class="li li-plain ml-row">
    <span class="li-body"><span class="li-title"><span class="ml-from">${esc(x.from)}</span><time>${esc(when(x.receivedAt))}</time></span>
      <span class="li-sub">${esc(x.subject || '(no subject)')}${x.summary && x.summary !== x.subject ? ` · ${esc(x.summary)}` : ''}</span></span>
    <span class="li-side ml-row-btns">
      ${x.sorted ? `<button type="button" class="icon-btn" data-action="mail-important" data-id="${x.id}" aria-label="${esc(`Mark ${x.subject || 'this email'} important`)}">${icon('star')}</button>` : '<span class="ml-sorting">Sorting</span>'}
      ${x.link ? `<a class="icon-btn" href="${esc(x.link)}" target="_blank" rel="noopener" aria-label="Open in Gmail">${icon('chevron')}</a>` : ''}
    </span></div>`;
}

function otherGroups(list) {
  const open = state.mailOpen || {};
  const groups = new Map();
  for (const x of list) {
    const k = x.sorted ? (x.category || 'other') : 'sorting';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const order = ['sorting', ...Object.keys(KIND)];
  return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, rows]) => {
    const shown = open[k] ? rows : rows.slice(0, SHOWN);
    const more = rows.length - shown.length;
    return `<section class="section ml-group"><div class="gh"><h2>${k === 'sorting' ? 'Being sorted' : KIND[k] || k}</h2><span class="gh-count">${rows.length}</span></div>
      <div class="group">${shown.map(otherRow).join('')}</div>
      ${more > 0 ? `<button type="button" class="gh-link ml-more" data-action="mail-more" data-kind="${esc(k)}">Show ${more} more${icon('chevron')}</button>` : ''}</section>`;
  }).join('');
}

function setupHtml() {
  return `<section class="card ml-setup">
    <h2>Connect Gmail</h2>
    <p class="muted">Oath reads your inbox every few minutes. The AI marks what needs you as important, stars it in Gmail and tells you; everything else is logged and sorted by kind.</p>
    <ol class="ml-steps">
      <li><a href="${APP_PASSWORDS}" target="_blank" rel="noopener">Open your Google app passwords</a>. It needs 2-Step Verification turned on.</li>
      <li>Name it <b>Oath</b> and tap Create.</li>
      <li>Copy the 16 letters Google shows and paste them below.</li>
    </ol>
    <form data-form="mail-connect" class="ml-form" autocomplete="off">
      <label class="field"><span>Gmail address</span><input class="input" type="email" name="address" inputmode="email" autocomplete="email" required placeholder="you@gmail.com"></label>
      <label class="field"><span>App password</span><input class="input mono" type="password" name="password" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="abcd efgh ijkl mnop"></label>
      <label class="ml-toggle"><input type="checkbox" name="star" checked><span>Star important emails in Gmail</span></label>
      <label class="ml-toggle"><input type="checkbox" name="notify" checked><span>Tell me when an important email arrives</span></label>
      <div class="form-actions"><button class="btn primary" type="submit">Connect Gmail</button></div>
    </form>
    <p class="ml-fine">Oath only reads your inbox and stars important emails. The app password stays on Oath's server and is never shown again. Disconnect here any time, or remove the app password in your Google account.</p>
  </section>`;
}

export function viewMail() {
  const data = m();
  const sync = data?.account?.connected ? `<button class="icon-btn" data-action="mail-sync" aria-label="Check now">${icon('sync')}</button>` : '';
  const head = pageHead('Mail', { over: data?.account?.connected ? esc(data.account.address) : '', actions: sync });
  if (!data) return ctx.shell(`${head}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`);
  const a = data.account;
  if (!a.connected) return ctx.shell(`${head}${setupHtml()}`);
  const reading = state.mailReading && !a.lastSync;
  const status = a.error
    ? `<div class="banner warn">${icon('close')}<span>${esc(a.error)}</span><button class="btn tinted small" data-action="mail-reconnect">Reconnect</button></div>`
    : `<p class="ml-status">${reading ? 'Reading your inbox for the first time…' : `Checked ${esc(ago(a.lastSync))} · every 5 minutes`}</p>`;
  const imp = data.important;
  const important = `<section class="section"><div class="gh"><h2>Important</h2><span class="gh-count">${imp.length}</span></div>
    ${imp.length ? `<div class="ml-cards">${imp.map(importantCard).join('')}</div>` : `<div class="card ml-empty"><p>${reading ? 'Nothing sorted yet.' : 'Nothing important waiting.'}</p></div>`}</section>`;
  const done = data.done.length ? `<details class="ml-done"><summary>Done this week <span class="gh-count">${data.done.length}</span></summary><div class="ml-cards">${data.done.map(importantCard).join('')}</div></details>` : '';
  const rest = data.other.length ? `<div class="ml-rest"><p class="ml-rest-h">Everything else, last 7 days</p>${otherGroups(data.other)}</div>` : '';
  const settings = `<section class="card ml-settings">
    <label class="ml-toggle"><input type="checkbox" data-mail-setting="star"${a.star ? ' checked' : ''}><span>Star important emails in Gmail</span></label>
    <label class="ml-toggle"><input type="checkbox" data-mail-setting="notify"${a.notify ? ' checked' : ''}><span>Tell me when an important email arrives</span></label>
    <div class="form-actions"><button type="button" class="btn tinted small danger-text" data-action="mail-disconnect">Disconnect Gmail</button></div></section>`;
  return ctx.shell(`${head}${status}${important}${done}${rest}${settings}`);
}

async function mark(id, body, note) {
  const r = await act(() => api('POST', `/api/mail/${id}`, body));
  if (!r) return;
  haptic('tick');
  if (note) toast(note);
  await loadMail();
  ctx.render();
}

export async function mailClick(a, el) {
  if (!a.startsWith('mail-')) return false;
  const id = el.dataset.id;
  switch (a) {
    case 'mail-done': await mark(id, { done: true }); return true;
    case 'mail-undone': await mark(id, { done: false }); return true;
    case 'mail-unimportant': await mark(id, { important: false }, 'Moved to everything else.'); return true;
    case 'mail-important': await mark(id, { important: true }, 'Marked important.'); return true;
    case 'mail-more':
      state.mailOpen = { ...(state.mailOpen || {}), [el.dataset.kind]: true };
      ctx.render();
      return true;
    case 'mail-sync': {
      el.disabled = true;
      const r = await act(() => api('POST', '/api/mail/sync', {}));
      if (r) {
        state.mail = r;
        toast('Inbox checked.');
      }
      ctx.render();
      return true;
    }
    case 'mail-reconnect':
      state.mail = { ...m(), account: { connected: false } };
      ctx.render();
      return true;
    case 'mail-disconnect': {
      if (!(await confirmSheet('Disconnect Gmail?', 'Oath stops reading your inbox and forgets the app password. The emails already logged here are removed too.', 'Disconnect'))) return true;
      if (await act(() => api('POST', '/api/mail/disconnect', { forget: true }), 'Gmail disconnected.')) {
        await loadMail();
        ctx.render();
      }
      return true;
    }
    default:
      return false;
  }
}

export async function mailSubmit(kind, form) {
  if (kind !== 'mail-connect') return false;
  const body = { address: form.address.value, password: form.password.value, star: form.star.checked, notify: form.notify.checked };
  const r = await act(() => api('POST', '/api/mail/connect', body));
  form.password.value = '';
  if (!r) return true;
  haptic('success');
  toast('Gmail connected. Reading your inbox.');
  state.mailReading = true;
  await loadMail();
  ctx.render();
  waitForFirstRead();
  return true;
}

// The two switches save as soon as they change.
export async function mailChange(el) {
  const key = el.dataset.mailSetting;
  if (!key) return false;
  const r = await act(() => api('POST', '/api/mail/settings', { [key]: el.checked }));
  if (r && state.mail) state.mail.account = r;
  return true;
}

// The chip under Today's rings when something important is waiting, or Gmail needs reconnecting.
export function mailChip(t) {
  const x = t?.mail;
  if (!x) return '';
  if (x.error) return `<a class="tchip warn" href="#/mail">${icon('close')}Gmail needs reconnecting${icon('chevron', 'chev')}</a>`;
  if (!x.important) return '';
  return `<a class="tchip act" href="#/mail">${icon('mail')}${x.important} important ${x.important === 1 ? 'email' : 'emails'}${icon('chevron', 'chev')}</a>`;
}
