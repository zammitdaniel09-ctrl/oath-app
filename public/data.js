// Health: Apple Health in detail, the business sites, and the calendars Oath reads.
import {
  state, esc, api, act, toast, fmtDay, icon, pageHead, iconLink, fmtInt, fmtDec, fmtHours, ago,
  miniRing, barChart, sparkline, localToday, keyBlock, form2obj, haptic, safeColor, emptyState, addDays, confirmSheet,
} from './ui.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };
export function initData(c) { ctx = c; }

// What a habit can be linked to in Apple Health, and how its number reads.
export const AUTO_LABELS = {
  steps: { name: 'Steps', unit: 'steps' },
  exercise_min: { name: 'Exercise minutes', unit: 'min exercise' },
  active_kcal: { name: 'Active energy, kcal', unit: 'kcal' },
  stand_hours: { name: 'Stand hours', unit: 'stand hours' },
  distance_km: { name: 'Walking and running, km', unit: 'km' },
  mindful_min: { name: 'Mindful minutes', unit: 'mindful min' },
  flights: { name: 'Flights climbed', unit: 'flights' },
  workout: { name: 'Workout minutes', unit: 'min of workout' },
  water_ml: { name: 'Water, mL', unit: 'mL water' },
};

// Today's value for a linked habit, from the Today payload's health block. null when unknown.
export function autoValue(auto, h) {
  if (!h?.connected) return null;
  if (auto.metric === 'workout') {
    const f = (auto.filter || '').toLowerCase();
    return (h.workouts || []).filter((w) => !f || String(w.type).toLowerCase().includes(f)).reduce((n, w) => n + (w.duration_min || 0), 0);
  }
  if (!(auto.metric in h)) return null;
  return h[auto.metric] ?? 0;
}

const val = (r) => (r.status === 'fulfilled' ? r.value : null);

export async function loadHealth() {
  const [health, business, feeds, tokens] = await Promise.allSettled([
    api('GET', '/api/health?days=14'),
    api('GET', '/api/business'),
    api('GET', '/api/calendar/feeds'),
    api('GET', '/api/tokens'),
  ]);
  state.dash = {
    health: val(health),
    business: val(business),
    feeds: val(feeds)?.feeds || [],
    errors: [health, business, feeds].filter((r) => r.status === 'rejected' && r.reason?.status !== 401).map((r) => r.reason?.message),
  };
  state.tokens = val(tokens) || state.tokens;
}

// ---------- Health ----------

const shortDay = (d) => new Intl.DateTimeFormat('en-GB', { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

function tile(ic, cls, label, value, unit, goal, display) {
  const pct = value === null || value === undefined || !goal ? 0 : (value / goal) * 100;
  return `<div class="dtile ${cls}">
    <div class="dtile-ring">${miniRing(pct, 44)}<span>${icon(ic)}</span></div>
    <div><span class="dtile-label">${label}</span>${value === null || value === undefined
      ? `<span class="dtile-val na">–</span><span class="dtile-goal">No reading yet${goal ? `, goal ${display(goal)}${unit}` : ''}</span>`
      : `<span class="dtile-val">${display(value)}<small>${unit}</small></span><span class="dtile-goal">${goal ? `of ${display(goal)}${unit}` : ''}</span>`}</div>
  </div>`;
}

function healthSetup(connected) {
  const tab = state.healthSetup || 'shortcut';
  const url = `${location.origin}/api/shortcut/health`;
  const urlField = `<span class="copy-row"><input class="input mono" id="health-url" readonly value="${esc(url)}"><button class="btn tinted small" data-action="copy" data-target="health-url">Copy</button></span>`;
  const count = state.tokens?.count || 0;
  const keyStep = `<li><b>Make your key.</b> ${count && !state.newToken ? 'You have one. Lost it? Make another.' : ''}
      ${keyBlock()}${state.newToken ? '' : `<div class="form-actions"><button class="btn ${count ? 'tinted' : 'primary'} small" data-action="token-new">${icon('key')}${count ? 'Make a new key' : 'Make a key'}</button></div>`}</li>`;
  const hae = `<ol class="steps">
      ${keyStep}
      <li>Install <b>Health Auto Export - JSON+CSV</b> and get Premium, which automations need.</li>
      <li>Open <b>Automations</b>, <b>New Automation</b>, <b>REST API</b>, and name it Oath.</li>
      <li>URL: ${urlField}</li>
      <li>Under <b>HTTP Headers</b>, add <b>Authorization</b> with your key as the value.</li>
      <li>Data Type <b>Health Metrics</b>: Step Count, Active Energy, Apple Exercise Time, Apple Stand Hour, Walking + Running Distance, Resting Heart Rate, Heart Rate Variability, Body Mass, Mindful Minutes.</li>
      <li>Export Format <b>JSON</b>, Version <b>2</b>, Date Range <b>Default</b>, Summarize Data <b>on</b>, Time Grouping <b>Hours</b>. Sync every hour, save and switch it on.</li>
      <li>Make a second one the same, with Data Type <b>Workouts</b> (route data off).</li>
      <li>Tap <b>Manual Export</b> once. This page then says "Synced just now".</li>
    </ol>`;
  const shortcut = `<ol class="steps">
      ${keyStep}
      <li>In Shortcuts, tap +, name it <b>Send Health to Oath</b>.</li>
      <li>Add <b>Find Health Samples</b>: Type Steps, Start Date is Today. Then <b>Calculate Statistics</b>: Sum.</li>
      <li>Do the same for <b>Exercise Minutes</b> and <b>Active Energy</b>.</li>
      <li>Add <b>Get Contents of URL</b>: ${urlField}
        Under Show More, Method <b>POST</b>, header <b>Authorization</b> with your key as the value, JSON body with <b>steps</b>, <b>exercise_min</b> and <b>active_kcal</b> (numbers), each set to its result.</li>
      <li>Run it once. Apple Health turns green in Today's setup list when it lands.</li>
      <li>In <b>Automation</b>, tap +, <b>Time of Day</b>, <b>Run Immediately</b>, pick this shortcut. Make three: <b>12:00</b>, <b>17:00</b>, <b>20:30</b>.</li>
    </ol>`;
  // One disclosure holds the steps; the hero above it is only a title and a label.
  return `<div class="card setup${connected ? ' quiet' : ''}">
    ${connected ? '' : `<div class="setup-hero"><span class="setup-ic">${icon('heart')}</span><div><h3>Connect Apple Health</h3></div></div>`}
    <details class="howto"${state.healthSetupOpen ? ' open' : ''}><summary>How to connect</summary>
      <div class="seg wide-seg" role="tablist" aria-label="How to connect">
        <button role="tab" aria-selected="${tab === 'shortcut'}" data-action="health-setup" data-tab="shortcut">Free shortcut</button>
        <button role="tab" aria-selected="${tab === 'hae'}" data-action="health-setup" data-tab="hae">Paid app, everything</button>
      </div>
      ${tab === 'hae' ? hae : shortcut}
    </details>
  </div>`;
}

function healthSection(h) {
  if (!h) return `<section class="section"><div class="gh"><h2>Apple Health</h2></div><div class="card muted">Health data could not be loaded.</div></section>`;
  if (!h.connected) return `<section class="section" id="health"><div class="gh"><h2>Apple Health</h2></div>${healthSetup(false)}</section>`;
  const days = h.days || [];
  const todayRow = days.find((d) => d.date === h.today) || {};
  const g = h.goals || {};
  // One letter per day on the axis (today in bold); the full day in tooltips and for screen readers.
  const labels = days.map((d) => shortDay(d.date));
  const titles = days.map((d, i) => (i === days.length - 1 ? 'Today' : fmtDay(d.date)));
  const steps = days.map((d) => d.steps);
  const withSteps = steps.filter((v) => v !== null && v !== undefined);
  const avgSteps = withSteps.length ? withSteps.reduce((a, b) => a + b, 0) / withSteps.length : null;
  const workouts = (h.workouts || []).slice(0, 6).map((w) => `<div class="li li-plain">
      <span class="li-ic">${icon('dumbbell')}</span>
      <span class="li-body"><span class="li-title">${esc(w.type)}</span><span class="li-sub">${fmtDay(w.date || (w.start || '').slice(0, 10))}${w.kcal ? `, ${fmtInt(w.kcal)} kcal` : ''}${w.distance_km ? `, ${fmtDec(w.distance_km)} km` : ''}${w.avg_hr ? `, ${Math.round(w.avg_hr)} bpm` : ''}</span></span>
      <span class="li-side"><b>${Math.round(w.duration_min || 0)}</b> min</span></div>`).join('');
  const series = (k) => days.map((d) => d[k]);
  const body = [
    ['scale', 'Weight', h.latest?.weight_kg, (v) => `${fmtDec(v)} kg`, series('weight_kg')],
    ['heart', 'Resting heart rate', h.latest?.resting_hr, (v) => `${Math.round(v)} bpm`, series('resting_hr')],
    ['bolt', 'Heart rate variability', h.latest?.hrv_ms, (v) => `${Math.round(v)} ms`, series('hrv_ms')],
    ['trend', 'VO2 max', h.latest?.vo2max, (v) => fmtDec(v), null],
  ].filter(([, , x]) => x && x.value !== null && x.value !== undefined).map(([ic, label, x, fmt, s]) => `<div class="body-tile">
      <span class="dtile-label">${icon(ic)}${label}</span><span class="body-val">${fmt(x.value)}</span>
      ${s ? sparkline(s) : ''}<span class="faint small">${fmtDay(x.date)}</span></div>`).join('');
  const autos = (h.autoHabits || []).map((a) => {
    const lab = AUTO_LABELS[a.metric] || { unit: a.metric };
    return `<div class="li li-plain${a.met ? ' kept' : ''}"><span class="chk">${a.met ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>' : ''}</span>
      <span class="li-body"><span class="li-title">${esc(a.name)}</span><span class="li-sub">${fmtInt(a.todayValue ?? 0)} of ${fmtInt(a.target)} ${lab.unit}${a.filter ? `, ${esc(a.filter)}` : ''}</span></span></div>`;
  }).join('');
  const other = (h.other || []).map((o) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(o.label)}</span><span class="li-sub">${fmtDay(o.date)}</span></span><span class="li-side">${fmtDec(o.value)} ${esc(o.unit || '')}</span></div>`).join('');

  return `<section class="section" id="health">
    <div class="gh"><h2>Apple Health</h2><span class="gh-count">${icon('sync')}Synced ${ago(h.lastSync)}</span></div>
    <div class="dtiles">
      ${tile('steps', 'c-move', 'Steps', todayRow.steps, '', g.steps, fmtInt)}
      ${tile('timer', 'c-day', 'Exercise', todayRow.exercise_min, ' min', g.exercise_min, (v) => Math.round(v))}
      ${tile('flame', 'c-hp', 'Active energy', todayRow.active_kcal, ' kcal', g.active_kcal, fmtInt)}
    </div>
    <div class="card chart-card">
      <div class="cc-head"><span>${icon('steps')}Steps</span><span class="faint small">${avgSteps === null ? '' : `Average ${fmtInt(avgSteps)} a day`}</span></div>
      ${barChart(steps, { goal: g.steps, labels, titles, cls: 'c-move', unit: ' steps', label: `Steps, last ${days.length} days` })}
    </div>
    ${autos ? `<div class="gh sub"><h3>Habits Health ticks off</h3></div><div class="group">${autos}</div>` : ''}
    ${workouts ? `<div class="gh sub"><h3>Workouts</h3></div><div class="group">${workouts}</div>` : ''}
    ${body ? `<div class="gh sub"><h3>Body</h3></div><div class="body-grid">${body}</div>` : ''}
    ${other ? `<div class="gh sub"><h3>Everything else</h3></div><div class="group">${other}</div>` : ''}
    <details class="card disclosure"><summary>${icon('settings')}Daily targets</summary>
      <form data-form="health-goals" class="grid2">
        <label class="field"><span>Steps</span><input class="input" name="steps" inputmode="numeric" value="${esc(g.steps)}"></label>
        <label class="field"><span>Exercise, min</span><input class="input" name="exercise_min" inputmode="numeric" value="${esc(g.exercise_min)}"></label>
        <label class="field"><span>Active energy, kcal</span><input class="input" name="active_kcal" inputmode="numeric" value="${esc(g.active_kcal)}"></label>
        <label class="field"><span>Stand hours</span><input class="input" name="stand_hours" inputmode="numeric" value="${esc(g.stand_hours)}"></label>
        <div class="form-actions" style="align-self:end"><button class="btn primary" type="submit">Save targets</button></div>
      </form>
    </details>
    ${healthSetup(true)}
  </section>`;
}

// ---------- Business ----------

function money(v, unit) {
  const sym = { EUR: '€', USD: '$', GBP: '£' }[unit] || '';
  return `${sym}${fmtInt(v)}${sym ? '' : unit ? ` ${esc(unit)}` : ''}`;
}

function metricValue(m) {
  if (m.format === 'money') return money(m.value, m.unit);
  if (m.format === 'percent') return `${fmtDec(m.value)}%`;
  if (m.format === 'count') return fmtInt(m.value);
  return `${fmtDec(m.value)}${m.unit ? ` ${esc(m.unit)}` : ''}`;
}

function bizCard(src) {
  const d = src.data;
  if (!d) {
    return `<div class="card biz"><div class="biz-head"><b>${esc(src.name)}</b><span class="dot bad"></span></div>
      <p class="muted small">Could not reach it yet: ${esc(src.error || 'no answer')}.</p></div>`;
  }
  const metrics = (d.metrics || []).map((m) => {
    const ch = m.change === null || m.change === undefined ? '' : `<span class="chg ${m.change >= 0 ? 'up' : 'down'}">${m.change >= 0 ? 'up' : 'down'} ${fmtDec(Math.abs(m.change))}%</span>`;
    const spark = m.series?.length > 1 ? sparkline(m.series.map((x) => x.value)) : '';
    return `<div class="bm"><span class="bm-label">${esc(m.label)}</span><span class="bm-val">${metricValue(m)}</span>${ch}${spark}</div>`;
  }).join('');
  const alerts = (d.alerts || []).map((a) => `<li>${esc(a)}</li>`).join('');
  const events = (d.events || []).slice(0, 4).map((e) => `<li><span>${esc(e.text)}</span><span class="faint">${ago(e.at)}</span></li>`).join('');
  return `<div class="card biz">
    <div class="biz-head"><b>${esc(d.site || src.name)}</b>${d.status ? `<span class="dot ${d.status.ok ? 'ok' : 'bad'}"></span><span class="small muted">${esc(d.status.text || '')}</span>` : ''}</div>
    ${src.ok ? '' : `<p class="note bad">Last check failed (${esc(src.error || 'no answer')}). Showing ${ago(src.fetchedAt)}.</p>`}
    <div class="bm-grid">${metrics}</div>
    ${alerts ? `<ul class="biz-alerts">${alerts}</ul>` : ''}
    ${events ? `<ul class="biz-events">${events}</ul>` : ''}
  </div>`;
}

function businessSection(b) {
  if (!b || !b.configured) {
    return `<section class="section" id="business"><div class="gh"><h2>Business</h2></div>
      <div class="card setup quiet"><div class="setup-hero"><span class="setup-ic biz-ic">${icon('business')}</span><div><h3>Your sites, on one screen</h3>
        <p class="muted">GoldenStraddler and Exposed FX Journal. Not connected yet.</p></div></div>
        ${b?.problem ? `<p class="note bad">${esc(b.problem)}</p>` : ''}</div>
    </section>`;
  }
  return `<section class="section" id="business"><div class="gh"><h2>Business</h2><button class="gh-link" data-action="biz-refresh">${icon('sync')}Refresh</button></div>
    ${b.problem ? `<p class="note bad">${esc(b.problem)}</p>` : ''}
    ${b.sources.map(bizCard).join('')}
  </section>`;
}

// ---------- Calendars ----------

// The feeds Oath reads. The days themselves are on the Calendar tab.
function calendarSection(d) {
  const feeds = d.feeds.map((f) => `<div class="li li-plain feed">
      <span class="li-ic"${safeColor(f.color) ? ` style="color:${safeColor(f.color)}"` : ''}>${icon(f.kind === 'deadlines' ? 'bolt' : 'calendar')}</span>
      <span class="li-body"><span class="li-title">${esc(f.name)}</span>
        <span class="li-sub">${f.kind === 'deadlines' ? 'Deadlines become tasks' : 'Calendar'}, ${esc(f.host)}. ${f.lastError ? `<span class="bad">${esc(f.lastError)}</span>` : `${f.eventCount} events, synced ${ago(f.lastSync)}`}</span></span>
      <button class="btn tinted small" data-action="cal-remove" data-id="${f.id}">Remove</button></div>`).join('');
  // Feeds and the add form fold away once something is connected.
  const manageOpen = !d.feeds.length || state.query?.get('section') === 'calendars';
  return `<section class="section" id="calendars"><div class="gh"><h2>Calendars</h2>${d.feeds.length ? `<button class="gh-link" data-action="cal-sync">${icon('sync')}Sync now</button>` : ''}</div>
    <div class="group"><a class="li li-plain li-nav" href="#/calendar"><span class="li-ic">${icon('calendar')}</span><span class="li-body"><span class="li-title">Open calendar</span></span>${icon('chevron', 'chev')}</a></div>
    <details class="card disclosure manage-cal"${manageOpen ? ' open' : ''}>
    <summary>${icon('calendar')}Manage calendars<span class="summary-count">${d.feeds.length} connected</span></summary>
    ${feeds ? `<div class="group flush">${feeds}</div>` : ''}
    <form class="cal-add" data-form="cal-add">
      ${d.feeds.length ? '' : `<div class="setup-hero"><span class="setup-ic cal-ic">${icon('calendar')}</span><div><h3>Add your calendars</h3></div></div>`}
      <label class="field"><span>Calendar link (iCal or webcal)</span><input class="input" name="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://calendar.google.com/calendar/ical/..." required></label>
      <div class="seg" role="radiogroup" aria-label="What it is">
        <label><input type="radio" name="kind" value="" checked><span>Work it out</span></label>
        <label><input type="radio" name="kind" value="calendar"><span>Calendar</span></label>
        <label><input type="radio" name="kind" value="deadlines"><span>Deadlines</span></label>
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">${icon('plus')}Add calendar</button></div>
      <details class="howto"><summary>How to connect</summary>
        <p class="howto-h">UM VLE deadlines</p>
        <ol><li>On www.um.edu.mt/vle/my, open <b>Calendar</b> from the user menu.</li>
          <li>At the bottom, <b>Import or export calendars</b>, then <b>Export calendar</b>.</li>
          <li>Events: <b>Events related to courses</b>. Period: <b>Recent and next 60 days</b>.</li>
          <li><b>Get calendar URL</b>, copy it and paste it above.</li></ol>
        <p class="howto-h">Google Calendar</p>
        <ol><li>In Safari on calendar.google.com, tap <b>aA</b>, <b>Request Desktop Website</b>.</li>
          <li>Settings, pick the calendar, <b>Integrate calendar</b>, copy <b>Secret address in iCal format</b>.</li></ol>
        <p class="howto-h">iCloud</p>
        <ol><li>In Calendar, tap (i) by the calendar, turn on <b>Public Calendar</b>, then <b>Share Link</b>, <b>Copy</b>.</li></ol>
        <p class="howto-h">Outlook</p>
        <ol><li>On a computer: outlook.office.com, Settings, <b>Calendar</b>, <b>Shared calendars</b>.</li>
          <li>Publish a calendar: <b>Can view titles and locations</b>, Publish, copy the <b>ICS</b> link.</li></ol>
      </details>
    </form>
    </details>
  </section>`;
}

// ---------- Page ----------

export function viewHealth() {
  const d = state.dash;
  const head = pageHead('Health', { actions: iconLink('#/settings', 'settings', 'Settings') });
  if (!d) return ctx.shell(`${head}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`);
  // Your body first; the businesses and the calendar feeds sit alongside.
  ctx.shell(`${head}
    ${d.errors.length ? `<div class="banner warn">${esc(d.errors[0])}</div>` : ''}
    <div class="split">
      <div><div id="sec-health">${healthSection(d.health)}</div></div>
      <aside><div id="sec-business">${businessSection(d.business)}</div><div id="sec-calendars">${calendarSection(d)}</div></aside>
    </div>`);
  // Links like #/health?section=calendars land on that section, once per visit: a redraw after a tap or a
  // return from Shortcuts leaves him where he scrolled.
  const section = state.query?.get('section');
  if (section && scrolledTo !== location.hash) {
    scrolledTo = location.hash;
    document.getElementById(`sec-${section}`)?.scrollIntoView({ block: 'start' });
  }
}
let scrolledTo = '';
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/health')) scrolledTo = ''; });

// ---------- Events ----------

export async function dataClick(a, el) {
  switch (a) {
    case 'health-setup':
      state.healthSetup = el.dataset.tab;
      state.healthSetupOpen = true;
      ctx.render();
      return true;
    case 'cal-remove':
      if (!await confirmSheet('Remove this calendar?', 'Tasks it made stay.', 'Remove')) return true;
      if (await act(() => api('DELETE', `/api/calendar/feeds/${el.dataset.id}`), 'Calendar removed.')) { await loadHealth(); ctx.render(); }
      return true;
    case 'cal-sync': {
      el.disabled = true;
      const r = await act(() => api('POST', '/api/calendar/sync', {}));
      if (r) {
        const made = r.results.reduce((n, x) => n + (x.created || 0), 0);
        const bad = r.results.filter((x) => !x.ok).length;
        toast(bad ? `${bad} calendar${bad === 1 ? '' : 's'} could not sync.` : made ? `Synced. ${made} new deadline${made === 1 ? '' : 's'} added as tasks.` : 'Synced.', Boolean(bad));
        await loadHealth();
        ctx.render();
      } else el.disabled = false;
      return true;
    }
    case 'biz-refresh': {
      el.disabled = true;
      const r = await act(() => api('GET', '/api/business?refresh=1'));
      if (r) { state.dash.business = r; ctx.render(); toast('Refreshed.'); } else el.disabled = false;
      return true;
    }
    default:
      return false;
  }
}

export async function dataSubmit(kind, form) {
  switch (kind) {
    case 'cal-add': {
      const f = form2obj(form);
      toast('Checking the calendar');
      const r = await act(() => api('POST', '/api/calendar/feeds', { url: f.url.trim(), kind: f.kind || undefined }));
      if (r) {
        haptic('success');
        toast(`Added ${r.feed.name}: ${r.events} events${r.created ? `, ${r.created} deadlines added as tasks` : ''}.`);
        await loadHealth();
        ctx.render();
      }
      return true;
    }
    case 'health-goals': {
      const f = form2obj(form);
      const r = await act(() => api('PUT', '/api/health/goals', f), 'Targets saved.');
      if (r) { await loadHealth(); ctx.render(); }
      return true;
    }
    default:
      return false;
  }
}
