// Settings: reminders, Face ID, body and daily needs, sounds, alerts, Telegram, Siri and Shortcuts, the
// HP rules, the coach schedule, the password and where the data comes from.
import {
  state, isIOS, isStandalone, icon, fmtDec, fmtDay, esc, fmtInt, localToday, keyBlock, pageHead, api, toast, ago, act,
  confirmSheet, rememberKey, fx, form2obj,
} from './ui.js';
import { NUTRIENT, energyText, ACTIVITY, GOALS } from './nutrition.js';
import { soundsOn, setSounds } from './sound.js';
import { setupRows } from './today-list.js';
import { fresh, createOptions, credentialJSON, deviceName } from './passkeys.js';
import { rememberLockMode, forgetMemory, renderLogin } from './lock.js';
import { pushOn, refreshPushState, pushOff } from './push.js';

let ctx = { shell: () => {}, skeleton: () => {}, load: () => {}, render: () => {}, wipePhone: () => {}, go: () => {} };
export function initSettings(c) {
  ctx = { ...ctx, ...c };
}

function pushCard() {
  const p = state.push;
  let status;
  let action = '';
  if (!p.supported) {
    status = isIOS() && !isStandalone()
      ? 'Add Oath to your Home Screen first: Share, then Add to Home Screen.'
      : 'This browser has no push notifications.';
  } else if (p.permission === 'denied') {
    status = 'Blocked. Turn them on in iOS Settings, Notifications, Oath.';
  } else if (p.subscribed) {
    const devices = p.devices == null ? '' : ` · ${p.devices} ${p.devices === 1 ? 'device' : 'devices'}`;
    status = `On for this device${devices}`;
    action = '<button class="btn tinted" data-action="push-test">Send a test</button><button class="btn tinted" data-action="push-off">Turn off on this device</button>';
  } else {
    status = 'Off on this device';
    action = '<button class="btn primary" data-action="push-on">Turn on reminders</button>';
  }
  return settingsCard('bell', 'Reminders', `<p class="muted">${status}</p>${action ? `<div class="form-actions">${action}</div>` : ''}`);
}

function settingsCard(ic, title, body, id = '') {
  return `<div class="card scard"${id ? ` id="${id}"` : ''}><h3 class="scard-h"><span class="sic sic-${ic}">${icon(ic)}</span>${title}</h3>${body}</div>`;
}

// His body sets his daily needs, and every food percentage is a share of them (nutrition.js personalNeeds).
const NEED_ROWS = [['kcal', 'Energy'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['fibre', 'Fibre'], ['sugars', 'Sugars, at most'], ['satfat', 'Saturates, at most'], ['salt', 'Salt, at most']];
const MICRO_NEEDS = ['calcium', 'iron', 'magnesium', 'potassium', 'zinc', 'vitc', 'vitd', 'b12', 'folate'];

// Weight over the last 90 days: one reading a day, saved here or from Apple Health. A line on a scale
// that fits the readings (a change of a kilo should show), dated from the first reading to today, so a
// gap in the readings is a gap in time. Each point names its day and value on hover.
function weightChart(list, today) {
  if (!list?.length) return '';
  const last = list[list.length - 1];
  const first = list[0];
  const change = last.kg - first.kg;
  const sinceText = list.length > 1
    ? `${change === 0 ? 'Level' : `${change > 0 ? '+' : '−'}${fmtDec(Math.abs(change))} kg`} since ${fmtDay(first.date, { day: 'numeric', month: 'short' })}`
    : 'First reading';
  const head = `<div class="wt-head"><span class="wt-v">${fmtDec(last.kg)}<small>kg</small></span>
    <span class="wt-sub">${esc(sinceText)}<br>Latest ${esc(last.date === today ? 'today' : fmtDay(last.date, { day: 'numeric', month: 'short' }))}${last.from === 'health' ? ', Apple Health' : ''}</span></div>`;
  if (list.length < 2) return `<div class="body-weight"><h4 class="need-h">Weight</h4>${head}</div>`;
  const H = 96;
  const pad = 10;
  const day = (d) => Date.parse(`${d}T12:00:00Z`) / 86400000;
  const x0 = day(first.date);
  const span = Math.max(14, day(today) - x0);
  const lo = Math.min(...list.map((p) => p.kg));
  const hi = Math.max(...list.map((p) => p.kg));
  const mid = (lo + hi) / 2;
  const half = Math.max(0.5, (hi - lo) / 2);
  const x = (d) => ((day(d) - x0) / span) * 100;
  const y = (kg) => pad + ((mid + half - kg) / (half * 2)) * (H - pad * 2);
  const path = list.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(2)} ${y(p.kg).toFixed(2)}`).join(' ');
  // Every reading is a point while there are few; with many, only the latest.
  const dots = list.map((p, i) => {
    const tip = `${fmtDay(p.date)}: ${fmtDec(p.kg)} kg${p.from === 'health' ? ' (Apple Health)' : ''}`;
    const show = list.length <= 30 || i === list.length - 1;
    return `<i class="wt-dot${show ? '' : ' hit'}${i === list.length - 1 ? ' last' : ''}" style="left:${x(p.date).toFixed(2)}%;top:${((y(p.kg) / H) * 100).toFixed(2)}%" title="${esc(tip)}"></i>`;
  }).join('');
  const spoken = `Weight from ${fmtDec(first.kg)} kg on ${fmtDay(first.date)} to ${fmtDec(last.kg)} kg on ${fmtDay(last.date)}, low ${fmtDec(lo)}, high ${fmtDec(hi)}`;
  return `<div class="body-weight"><h4 class="need-h">Weight</h4>${head}
    <div class="wt-chart" role="img" aria-label="${esc(spoken)}">
      <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="100" y1="${y(hi).toFixed(2)}" y2="${y(hi).toFixed(2)}" class="wt-grid"/><line x1="0" x2="100" y1="${y(lo).toFixed(2)}" y2="${y(lo).toFixed(2)}" class="wt-grid"/>
        <path d="${path}" class="wt-line"/></svg>
      <span class="wt-y" style="top:${((y(hi) / H) * 100).toFixed(2)}%" aria-hidden="true">${fmtDec(hi)}</span>
      ${hi !== lo ? `<span class="wt-y" style="top:${((y(lo) / H) * 100).toFixed(2)}%" aria-hidden="true">${fmtDec(lo)}</span>` : ''}
      ${dots}</div>
    <div class="wt-axis" aria-hidden="true"><span>${esc(fmtDay(first.date, { day: 'numeric', month: 'short' }))}</span><span>Today</span></div></div>`;
}

// Where the energy need comes from: the formula (with Apple Health's activity when it has enough days),
// or his real burn from his weight trend and logged food (src/food-energy.js), once it has enough data.
function energyFromHtml(view) {
  const e = view?.energy;
  const on = view?.body?.energyFrom === 'burn';
  const ready = Boolean(e) && e.confidence !== 'none';
  const btn = (value, label, pressed, disabled) => `<button type="button" data-action="body-energy" data-value="${value}" aria-pressed="${pressed}"${disabled ? ' disabled' : ''}>${label}</button>`;
  let why;
  if (!e) why = 'Real burn could not be worked out just now.';
  else if (ready) why = `Real burn: about ${fmtInt(e.burn)} kcal a day, ${e.confidence} confidence, from ${e.good} fully logged days and ${e.weighIns} weigh-ins.`;
  else if (on) why = 'Chosen. The formula stands in until there is enough data.';
  else why = `Real burn needs ${e.missing?.text || 'more fully logged days and weigh-ins'} first.`;
  return `<div class="energy-from"><p class="need-h" id="energy-from-h">Energy from</p>
    <div class="seg small" role="group" aria-labelledby="energy-from-h">${btn('auto', 'Formula and Health', !on, false)}${btn('burn', 'Real burn', on, !ready && !on)}</div>
    <p class="need-how small">${esc(why)}${ready || on ? ' <a href="#/food/trends?tab=body">See it</a>' : ''}</p></div>`;
}

function bodyCard() {
  const b = state.body?.body || {};
  const n = state.body?.needs;
  const opt = (list, cur) => Object.entries(list).map(([k, x]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
  const amount = (k) => `${fmtInt(n.refs[k])}${NUTRIENT[k].unit === 'kcal' ? ' kcal' : ` ${NUTRIENT[k].unit}`}`;
  const needs = n ? `<div class="need-grid">${NEED_ROWS.map(([k, label]) => `<div class="need"><span>${label}</span><b>${amount(k)}</b></div>`).join('')}</div>
      <p class="need-how small">${esc(energyText(n))}</p>${energyFromHtml(state.body)}
      <details class="need-more"><summary>Vitamins and minerals</summary><div class="need-grid">${MICRO_NEEDS.map((k) => `<div class="need"><span>${esc(NUTRIENT[k].label)}</span><b>${fmtDec(n.refs[k])} ${NUTRIENT[k].unit}</b></div>`).join('')}</div></details>`
    : '';
  return settingsCard('scale', 'Body', `<form data-form="body">
      <div class="grid2">
        <label class="field"><span>Sex</span><select class="input" name="sex" required><option value="">Choose</option><option value="male"${b.sex === 'male' ? ' selected' : ''}>Male</option><option value="female"${b.sex === 'female' ? ' selected' : ''}>Female</option></select></label>
        <label class="field"><span>Born</span><input class="input" type="date" name="birthDate" value="${esc(b.birthDate || '')}" required></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Height, cm</span><input class="input" name="heightCm" inputmode="decimal" value="${esc(b.heightCm ?? '')}" required></label>
        <label class="field"><span>Weight, kg</span><input class="input" name="weightKg" inputmode="decimal" value="${esc(b.weightKg ?? '')}" required></label>
        <label class="field"><span>Body fat, %</span><input class="input" name="bodyFat" inputmode="decimal" value="${esc(b.bodyFat ?? '')}" placeholder="Optional"></label>
      </div>
      <label class="field"><span>Activity</span><select class="input" name="activity" required><option value="">Choose</option>${opt(ACTIVITY, b.activity)}</select></label>
      <label class="field"><span>Goal</span><select class="input" name="goal">${opt(GOALS, b.goal || 'keep')}</select></label>
      <div class="form-actions"><button class="btn primary" type="submit">Save</button></div>
    </form>
    ${weightChart(state.body?.weights, localToday())}
    ${needs ? `<div class="body-needs"><h4 class="need-h">Your daily needs</h4>${needs}</div>` : ''}`, 'body');
}

// Sounds belong to the device, not the account: the choice is kept in this browser's storage (sound.js).
function soundsCard() {
  return settingsCard('sound', 'Sounds', `<label class="switch-row"><span class="switch-text"><b>Play sounds on this device</b></span>
      <input class="switch" type="checkbox" role="switch" data-action="sounds"${soundsOn() ? ' checked' : ''}></label>`);
}

function alertsCard(s) {
  const opt = (v, label) => `<label class="radio-row"><input type="radio" name="alerts" value="${v}"${(s.alerts || 'both') === v ? ' checked' : ''}><span><b>${label}</b></span></label>`;
  return settingsCard('phone', 'Where alerts go', `<form data-form="alerts">
      ${opt('smart', 'One channel per alert')}
      ${opt('both', 'Everything, everywhere')}
      ${opt('push', 'App only')}
      <div class="form-actions"><button class="btn primary" type="submit">Save</button></div>
    </form>`);
}

function telegramCard() {
  const tg = state.telegram || {};
  let body;
  let actions = '';
  if (!state.telegram) {
    body = 'Could not load.';
  } else if (!tg.enabled) {
    body = 'Off: add TELEGRAM_BOT_TOKEN in Railway.';
  } else if (tg.linked) {
    body = `Connected${tg.botUsername ? ` to @${esc(tg.botUsername)}` : ''}. /today, /next, /hp, /add, /done.`;
    actions = '<button class="btn tinted" data-action="tg-test">Send a test</button><button class="btn tinted" data-action="tg-unlink">Disconnect</button>';
  } else {
    body = 'Not connected';
    actions = '<button class="btn primary" data-action="tg-link">Connect Telegram</button>';
    if (tg.linkUrl) body += `. <a href="${esc(tg.linkUrl)}">Open the link</a>`;
  }
  return settingsCard('telegram', 'Telegram', `<p class="muted">${body}</p>${actions ? `<div class="form-actions">${actions}</div>` : ''}`);
}

function siriCard() {
  const host = location.origin;
  const count = state.tokens?.count || 0;
  return settingsCard('mic', 'Siri and Shortcuts', `
    ${keyBlock()}
    <div class="form-actions">
      <button class="btn ${count ? 'tinted' : 'primary'}" data-action="token-new">${count ? 'Make a new key' : 'Make a key'}</button>
      ${count ? '<button class="btn tinted" data-action="token-revoke">Turn off all keys</button>' : ''}
    </div>
    <details class="howto"><summary>How to connect</summary>
      <ol>
        <li>In Shortcuts, tap +, name it <b>Add to Oath</b>.</li>
        <li>Add <b>Ask for Input</b>, type Text.</li>
        <li>Add <b>Get Contents of URL</b>: <code>${esc(host)}/api/shortcut/add</code>. Under Show More, Method <b>POST</b>, header <b>Authorization</b> = <code>Bearer</code> then a space and your key, JSON body <b>text</b> = Provided Input.</li>
        <li>Add <b>Get Dictionary Value</b> for <b>say</b>, then <b>Show Result</b>.</li>
        <li>For <b>Oath done</b>, repeat with <code>${esc(host)}/api/shortcut/done</code>.</li>
        <li>For <b>What's next in Oath</b>, use <code>${esc(host)}/api/shortcut/next</code>, Method GET, the same header, then <b>Speak Text</b>.</li>
      </ol>
    </details>`);
}

// The game's numbers, editable. Ranges match the server's (src/settings.js), which checks them again.
const RULE_FIELDS = [
  ['maxHp', 'Max HP', 50, 500, 1],
  ['dailyLossCap', 'Most HP one day can cost', 10, 500, 1],
  ['taskPenalty', 'HP a hard task costs', 1, 100, 1],
  ['repeatMultiplier', 'Second miss in a row costs ×', 1, 3, 0.25],
  ['comebackBonus', 'Comeback bonus, HP', 0, 50, 1],
  ['cleanBonus', 'Clean-day bonus, HP', 0, 50, 1],
  ['pardonsPerMonth', 'Pardons a month', 0, 10, 1],
  ['restDaysPerMonth', 'Rest days a month', 0, 10, 1],
  ['maxNonNegotiables', 'Non-negotiables allowed', 1, 10, 1],
  ['undoMinutes', 'Minutes to undo a tick', 1, 120, 1],
];
function rulesForm(s) {
  const fields = RULE_FIELDS.map(([k, label, min, max, step]) => `<label class="field"><span>${label}</span>
      <input class="input" type="number" name="${k}" min="${min}" max="${max}" step="${step}" inputmode="decimal" value="${esc(s[k])}" required></label>`).join('');
  return `<form class="card rules-form" data-form="rules">
    <div class="grid2">${fields}</div>
    <div class="form-actions"><button class="btn primary" type="submit">Save rules</button></div>
  </form>`;
}

export function viewSettings() {
  const s = state.settings;
  if (!s) return ctx.shell(ctx.skeleton('Settings'));
  const connections = settingsCard('link', 'Your data', `
    <div class="group flush">
      ${state.setup ? setupRows(state.setup) : `
      <a class="li li-plain li-nav" href="#/health?section=health"><span class="li-body"><span class="li-title">Apple Health</span><span class="li-sub">Steps, workouts, heart</span></span>${icon('chevron', 'chev')}</a>
      <a class="li li-plain li-nav" href="#/health?section=calendars"><span class="li-body"><span class="li-title">Calendars and VLE deadlines</span><span class="li-sub">Google, iCloud, Outlook, UM VLE</span></span>${icon('chevron', 'chev')}</a>`}
      <a class="li li-plain li-nav" href="#/health?section=business"><span class="li-body"><span class="li-title">Business sites</span><span class="li-sub">GoldenStraddler, Exposed FX Journal</span></span>${icon('chevron', 'chev')}</a>
      <a class="li li-plain li-nav" href="#/mail"><span class="li-body"><span class="li-title">Gmail</span><span class="li-sub">Important email, sorted by the AI</span></span>${icon('chevron', 'chev')}</a>
    </div>
    <div class="form-actions"><a class="btn tinted" href="/api/export" download>${icon('download')}Download all my data</a><button type="button" class="btn tinted" data-action="report-problem">Report a problem</button></div>`);
  // Where the food numbers come from: credits and licences live here, not on the screens.
  const src = (name, what, licence, href = '') => `<${href ? `a href="${href}"` : 'div'} class="li li-plain${href ? ' li-nav' : ''}"><span class="li-body"><span class="li-title">${name}</span><span class="li-sub">${what}${licence ? ` · ${licence}` : ''}</span></span>${href ? icon('chevron', 'chev') : ''}</${href ? 'a' : 'div'}>`;
  const sources = settingsCard('food', 'Data sources', `<div class="group flush">
      ${src('USDA FoodData Central', 'Generic foods and their nutrients', 'public domain')}
      ${src('CoFID (McCance and Widdowson)', 'UK foods and their nutrients', 'Office for Health Improvement and Disparities, Open Government Licence v3.0')}
      ${src('Ciqual', 'French and Mediterranean foods and their nutrients', 'ANSES, Licence Ouverte / Etalab')}
      ${src('Brands and chains', 'Products and menus with the values their makers publish', 'each record links its source')}
      ${src('Open Food Facts', 'Packaged products', '© Open Food Facts contributors, ODbL')}
      ${src('Your daily needs', 'Energy: Katch-McArdle or Mifflin-St Jeor × activity; protein: ISSN position stand; vitamins and minerals: EFSA dietary reference values', '', '#/settings?section=body')}
      ${src('EU reference intakes', 'The % RI until your body is set', 'Regulation (EU) 1169/2011, Annex XIII')}
      ${src('Nutri-Score', 'Grades A to E', 'Santé publique France')}
      ${src('NOVA', 'Processing groups 1 to 4', 'Monteiro et al., as given by Open Food Facts')}
      ${src('Recipe library', 'Written for Oath by AI, not kitchen-tested', '')}
      ${src('Coverage report', 'What the catalogue holds', '', '#/food/report')}
    </div>`, 'data-sources');
  ctx.shell(`${pageHead('Settings')}
    <div class="split"><div>
      ${bodyCard()}
      ${connections}
      ${faceIdCard()}
      ${pushCard()}
      ${soundsCard()}
      ${alertsCard(s)}
      ${telegramCard()}
      ${siriCard()}
      ${settingsCard('clock', 'Coach schedule', `<form data-form="settings">
          <div class="grid3">
            <label class="field"><span>Morning brief</span><input class="input" type="time" name="morningTime" value="${esc(s.morningTime)}" required></label>
            <label class="field"><span>Midday check</span><input class="input" type="time" name="middayTime" value="${esc(s.middayTime || '13:00')}" required></label>
            <label class="field"><span>Evening check</span><input class="input" type="time" name="eveningTime" value="${esc(s.eveningTime)}" required></label>
          </div>
          <div class="grid2">
            <label class="field"><span>Your day ends at</span><input class="input" type="time" name="dayEnd" value="${esc(s.dayEnd || '22:00')}" required></label>
            <label class="field"><span>Time zone</span><input class="input" name="timezone" value="${esc(s.timezone)}" required></label>
          </div>
          <div class="form-actions"><button class="btn primary" type="submit">Save schedule</button></div>
        </form>`)}
      ${settingsCard('lock', 'Password', `<form data-form="password">
          <label class="field"><span>Current password</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field"><span>New password</span><input class="input" type="password" name="next" autocomplete="new-password" minlength="10" required></label>
          <div class="form-actions"><button class="btn primary" type="submit">Change password</button><button class="btn tinted" type="button" data-action="logout">Log out</button></div>
        </form>`)}
    </div>
    <aside><section class="section"><div class="gh"><h2>Game rules</h2></div>
      ${rulesForm(s)}</section>
      <section class="section">${sources}</section></aside></div>`);
}

async function faceIdAdd(el) {
  el.disabled = true;
  try {
    const pre = fresh(state.faceIdRegister) ? state.faceIdRegister : { options: await api('POST', '/api/passkey/register/options', {}) };
    state.faceIdRegister = null;
    const cred = await navigator.credentials.create({ publicKey: createOptions(pre.options) });
    await api('POST', '/api/passkey/register', { response: credentialJSON(cred), device: deviceName() });
    toast('Face ID is on. Next time, log in with your face.');
    await ctx.load('settings');
    rememberLockMode(state.settings?.faceIdLock !== false && (state.passkeys || []).length > 0);
    ctx.render();
  } catch (err) {
    const msg = err.name === 'NotAllowedError' ? 'Face ID setup was cancelled.'
      : err.name === 'InvalidStateError' ? 'This device already logs in to Oath with Face ID.' : err.message;
    toast(msg, true);
    el.disabled = false;
  }
}

function faceIdCard() {
  if (!window.PublicKeyCredential) {
    return settingsCard('faceid', 'Face ID', '<p class="muted">Not available in this browser. Open Oath from the Home Screen.</p>');
  }
  const keys = state.passkeys || [];
  const rows = keys.map((k) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(k.device || 'Device')}</span>
      <span class="li-sub">Added ${fmtDay(String(k.createdAt).slice(0, 10))}${k.lastUsed ? `, last used ${ago(k.lastUsed)}` : ', not used yet'}</span></span>
      <button class="btn tinted small" data-action="faceid-remove" data-id="${esc(k.id)}">Remove</button></div>`).join('');
  const lockOn = state.settings?.faceIdLock !== false;
  // The one line kept: with the lock on, the password alone is not enough to get back in.
  const text = keys.length && lockOn ? 'Password login then needs the recovery code.' : '';
  const lock = keys.length
    ? `<label class="check"><input type="checkbox" data-action="faceid-lock"${lockOn ? ' checked' : ''}> Face ID every time Oath opens</label>`
    : '';
  return settingsCard('faceid', 'Face ID', `${text ? `<p class="muted small">${text}</p>` : ''}
    ${rows ? `<div class="group flush">${rows}</div>` : ''}${lock}
    <div class="form-actions"><button class="btn primary" data-action="faceid-add">${icon('faceid')}${keys.length ? 'Add this device too' : 'Turn on Face ID'}</button></div>`);
}

export async function settingsClick(a, el) {
  if (a === 'body-energy') {
    const to = el.dataset.value;
    if (to === (state.body?.body?.energyFrom || 'auto')) return true;
    const r = await act(() => api('PUT', '/api/body', { energyFrom: to }));
    if (r) {
      state.body = r;
      state.food = null;
      toast(to === 'burn' ? `Saved. Your daily need now comes from your real burn: ${fmtInt(r.needs?.refs.kcal)} kcal.` : `Saved. Back to the formula: ${fmtInt(r.needs?.refs.kcal)} kcal a day.`);
      ctx.render();
    }
  } else if (a === 'tg-link') {
    const r = await act(() => api('POST', '/api/telegram/link', {}));
    if (r) {
      state.telegram = { ...state.telegram, linkUrl: r.url };
      ctx.render();
      window.location.href = r.appUrl || r.url;
    }
  } else if (a === 'tg-test') {
    await act(() => api('POST', '/api/telegram/test', {}), (r) => (r.sent ? 'Sent. Check Telegram.' : 'Not linked yet.'));
  } else if (a === 'tg-unlink') {
    if (!await confirmSheet('Disconnect Telegram?', 'You can connect it again any time.', 'Disconnect')) return true;
    if (await act(() => api('POST', '/api/telegram/unlink', {}), 'Telegram disconnected.')) { await ctx.load('settings'); ctx.render(); }
  } else if (a === 'token-new') {
    const r = await act(() => api('POST', '/api/tokens', { label: 'Shortcuts' }));
    if (r) { rememberKey(r.token); state.tokens = { count: (state.tokens?.count || 0) + 1 }; ctx.render(); }
  } else if (a === 'key-hide') {
    rememberKey(null);
    ctx.render();
  } else if (a === 'token-revoke') {
    if (!await confirmSheet('Turn off every key?', 'Shortcuts and Health sync stop until you make a new one.', 'Turn off')) return true;
    if (await act(() => api('DELETE', '/api/tokens'), 'All keys turned off.')) { rememberKey(null); await ctx.load(state.route); ctx.render(); }
  } else if (a === 'faceid-add') {
    await faceIdAdd(el);
  } else if (a === 'faceid-lock') {
    const on = el.checked;
    const r = await act(() => api('PATCH', '/api/settings', { faceIdLock: on }),
      on ? 'Oath now opens with Face ID only.' : 'Face ID lock is off. The password works on its own again.');
    if (r) {
      state.settings = r;
      rememberLockMode(on && (state.passkeys || []).length > 0);
      ctx.render();
    } else {
      el.checked = !on;
    }
  } else if (a === 'sounds') {
    // A setting of this device only. Turning them on clicks, so it can be heard straight away.
    setSounds(el.checked);
    if (el.checked) fx('toggle');
  } else if (a === 'faceid-remove') {
    if (!await confirmSheet('Remove Face ID here?', 'The password keeps working.', 'Remove')) return true;
    if (await act(() => api('DELETE', `/api/passkeys/${encodeURIComponent(el.dataset.id)}`), 'Face ID removed for that device.')) {
      await ctx.load('settings');
      // With the last key gone the app no longer opens with Face ID only; a phone that still thought so would
      // lock itself behind a Face ID the server no longer knows.
      rememberLockMode(state.settings?.faceIdLock !== false && (state.passkeys || []).length > 0);
      ctx.render();
    }
  } else if (a === 'push-on') {
    if (await act(pushOn, 'Reminders are on for this device.')) { await refreshPushState(); ctx.render(); }
  } else if (a === 'push-off') {
    if (await act(pushOff, 'Reminders are off for this device.')) { await refreshPushState(); ctx.render(); }
  } else if (a === 'push-test') {
    await act(() => api('POST', '/api/push/test', {}), (r) => (r.sent ? 'Test sent. It should arrive in a few seconds.' : 'No device is registered. Turn reminders on again.'));
  } else if (a === 'logout') {
    await act(() => api('POST', '/api/logout', {}));
    forgetMemory();
    ctx.wipePhone();
    renderLogin(null, { auto: false });
  } else return false;
  return true;
}

export async function settingsSubmit(kind, form) {
  if (kind === 'rules') {
    const f = form2obj(form);
    const patch = Object.fromEntries(Object.entries(f).filter(([k, x]) => x !== '' && Number(x) !== Number(state.settings?.[k])).map(([k, x]) => [k, Number(x)]));
    if (!Object.keys(patch).length) { toast('Nothing changed.'); return true; }
    if (patch.maxHp !== undefined && patch.maxHp < (state.settings?.maxHp ?? 0)
      && !await confirmSheet(`Lower max HP to ${patch.maxHp}?`, 'HP above that comes down with it.', 'Lower it')) return true;
    if (await act(() => api('PATCH', '/api/settings', patch), 'Rules saved. They apply from now on.')) await ctx.go();
  } else if (kind === 'body') {
    const r = await act(() => api('PUT', '/api/body', form2obj(form)));
    if (r) {
      state.body = r;
      state.food = null;
      toast(r.needs ? `Saved. You need about ${fmtInt(r.needs.refs.kcal)} kcal and ${r.needs.refs.protein} g of protein a day.` : 'Saved.');
      ctx.render();
    }
  } else if (kind === 'settings') {
    if (await act(() => api('PATCH', '/api/settings', form2obj(form)), 'Schedule saved.')) await ctx.go();
  } else if (kind === 'alerts') {
    if (await act(() => api('PATCH', '/api/settings', form2obj(form)), 'Saved.')) await ctx.go();
  } else if (kind === 'password') {
    if (await act(() => api('POST', '/api/password', form2obj(form)), 'Password changed.')) form.reset();
  } else return false;
  return true;
}
