// The Dashboard: Apple Health, business sites, calendars and the way into the weekly review.
import {
  state, esc, api, act, toast, fmtDay, bar, icon, pageHead, iconLink, fmtInt, fmtDec, fmtHours, ago,
  miniRing, barChart, sparkline, localToday, keyBlock, form2obj, haptic, safeColor, emptyState,
} from './ui.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };
export function initData(c) { ctx = c; }

// What a habit can be linked to in Apple Health, and how its number reads.
export const AUTO_LABELS = {
  steps: { name: 'Steps', unit: 'steps' },
  exercise_min: { name: 'Exercise minutes', unit: 'min exercise' },
  active_kcal: { name: 'Active energy, kcal', unit: 'kcal' },
  stand_hours: { name: 'Stand hours', unit: 'stand hours' },
  sleep_hours: { name: 'Sleep, hours', unit: 'h sleep' },
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

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const val = (r) => (r.status === 'fulfilled' ? r.value : null);

export async function loadDashboard() {
  const today = localToday();
  const [health, business, feeds, events, tokens, season] = await Promise.allSettled([
    api('GET', '/api/health?days=14'),
    api('GET', '/api/business'),
    api('GET', '/api/calendar/feeds'),
    api('GET', `/api/calendar/events?from=${today}&to=${addDays(today, 6)}`),
    api('GET', '/api/tokens'),
    api('GET', '/api/season'),
  ]);
  state.dash = {
    season: val(season),
    health: val(health),
    business: val(business),
    feeds: val(feeds)?.feeds || [],
    events: val(events)?.events || [],
    errors: [health, business, feeds, events].filter((r) => r.status === 'rejected' && r.reason?.status !== 401).map((r) => r.reason?.message),
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

function sleepStages(s) {
  if (!s) return '';
  const parts = [['deep', 'Deep'], ['core', 'Core'], ['rem', 'REM'], ['awake', 'Awake']].filter(([k]) => s[k]);
  const total = parts.reduce((n, [k]) => n + s[k], 0);
  if (!total) return '';
  return `<div class="stages">${parts.map(([k]) => `<i class="st-${k}" style="flex:${s[k]}"></i>`).join('')}</div>
    <div class="stages-legend">${parts.map(([k, l]) => `<span class="st-${k}">${l} ${fmtHours(s[k])}</span>`).join('')}</div>`;
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
      <li>Install <b>Health Auto Export - JSON+CSV</b> from the App Store and get Premium (one-time lifetime, about €30, or €1.99 a month). The Basic tier has no automations.</li>
      <li>In the app open <b>Automations</b>, tap <b>New Automation</b>, choose <b>REST API</b> and name it Oath.</li>
      <li>URL: ${urlField}</li>
      <li>Under <b>HTTP Headers</b>, add one: key <b>Authorization</b>, value your key.</li>
      <li>Data Type <b>Health Metrics</b>. Select Step Count, Active Energy, Apple Exercise Time, Apple Stand Hour, Sleep Analysis, Walking + Running Distance, Resting Heart Rate, Heart Rate Variability, Body Mass and Mindful Minutes.</li>
      <li>Export Format <b>JSON</b>, Version <b>2</b>, Date Range <b>Default</b>, Summarize Data <b>on</b>, Time Grouping <b>Hours</b>. Sync every hour. Save and switch it on.</li>
      <li>Make a second automation exactly the same, with Data Type <b>Workouts</b> (route data off).</li>
      <li>Tap <b>Manual Export</b> once. This page then says "Synced just now".</li>
    </ol>`;
  const shortcut = `<ol class="steps">
      ${keyStep}
      <li>Open <b>Shortcuts</b>, tap +, name it <b>Send Health to Oath</b>.</li>
      <li>Add <b>Find Health Samples</b>: Type Steps, Start Date is Today. Then <b>Calculate Statistics</b>: Sum.</li>
      <li>Do the same for <b>Exercise Minutes</b> and <b>Active Energy</b>.</li>
      <li>Add <b>Find Health Samples</b>: Type Sleep Analysis, Start Date is in the last 1 day, Value is not In Bed, Value is not Awake. Then <b>Get Details of Health Samples</b>: Duration, then <b>Calculate Statistics</b>: Sum.</li>
      <li>Add <b>Get Contents of URL</b> with this URL: ${urlField}
        Tap Show More: Method <b>POST</b>, add a Header <b>Authorization</b> with your key as the value, Request Body <b>JSON</b> with fields <b>steps</b>, <b>exercise_min</b>, <b>active_kcal</b> (numbers) and <b>sleep_hours</b> (text), each set to the matching result.</li>
      <li>Run it once with the play button. Oath's setup list on Today turns Apple Health green when it lands.</li>
      <li>In the <b>Automation</b> tab, tap +, <b>Time of Day</b>, <b>Run Immediately</b>, pick this shortcut. Make four: <b>08:00</b> (last night's sleep), <b>12:00</b>, <b>17:00</b> and <b>20:30</b>.</li>
    </ol>`;
  return `<div class="card setup${connected ? ' quiet' : ''}">
    ${connected ? '' : `<div class="setup-hero"><span class="setup-ic">${icon('heart')}</span><div><h3>Connect Apple Health</h3>
      <p class="muted">Steps, workouts and sleep, sent from your iPhone.</p></div></div>`}
    <div class="seg wide-seg" role="tablist" aria-label="How to connect">
      <button role="tab" aria-selected="${tab === 'shortcut'}" data-action="health-setup" data-tab="shortcut">Free shortcut</button>
      <button role="tab" aria-selected="${tab === 'hae'}" data-action="health-setup" data-tab="hae">Paid app, everything</button>
    </div>
    ${tab === 'hae' ? hae : shortcut}
  </div>`;
}

function healthSection(h) {
  if (!h) return `<section class="section"><div class="gh"><h2>Body</h2></div><div class="card muted">Health data could not be loaded.</div></section>`;
  if (!h.connected) return `<section class="section" id="health"><div class="gh"><h2>Body</h2></div>${healthSetup(false)}</section>`;
  const days = h.days || [];
  const todayRow = days.find((d) => d.date === h.today) || {};
  const lastNight = todayRow.sleep_hours !== null && todayRow.sleep_hours !== undefined ? todayRow : [...days].reverse().find((d) => d.sleep_hours);
  const g = h.goals || {};
  // One letter per day on the axis (today in bold); the full day in tooltips and for screen readers.
  const labels = days.map((d) => shortDay(d.date));
  const titles = days.map((d, i) => (i === days.length - 1 ? 'Today' : fmtDay(d.date)));
  const steps = days.map((d) => d.steps);
  const sleep = days.map((d) => d.sleep_hours);
  const withSteps = steps.filter((v) => v !== null && v !== undefined);
  const avgSteps = withSteps.length ? withSteps.reduce((a, b) => a + b, 0) / withSteps.length : null;
  const withSleep = sleep.filter((v) => v);
  const avgSleep = withSleep.length ? withSleep.reduce((a, b) => a + b, 0) / withSleep.length : null;
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
    <div class="gh"><h2>Body</h2><span class="gh-count">${icon('sync')}Synced ${ago(h.lastSync)}</span></div>
    <div class="dtiles">
      ${tile('steps', 'c-move', 'Steps', todayRow.steps, '', g.steps, fmtInt)}
      ${tile('timer', 'c-day', 'Exercise', todayRow.exercise_min, ' min', g.exercise_min, (v) => Math.round(v))}
      ${tile('flame', 'c-hp', 'Active energy', todayRow.active_kcal, ' kcal', g.active_kcal, fmtInt)}
      ${tile('moon', 'c-sleep', 'Sleep', lastNight?.sleep_hours, '', g.sleep_hours, fmtHours)}
    </div>
    <div class="card chart-card">
      <div class="cc-head"><span>${icon('steps')}Steps</span><span class="faint small">${avgSteps === null ? '' : `Average ${fmtInt(avgSteps)} a day`}</span></div>
      ${barChart(steps, { goal: g.steps, labels, titles, cls: 'c-move', unit: ' steps', label: `Steps, last ${days.length} days` })}
    </div>
    <div class="card chart-card">
      <div class="cc-head"><span>${icon('moon')}Sleep</span><span class="faint small">${avgSleep === null ? '' : `Average ${fmtHours(avgSleep)}`}</span></div>
      ${barChart(sleep, { goal: g.sleep_hours, labels, titles, cls: 'c-sleep', label: `Sleep, last ${days.length} nights`, fmt: fmtHours })}
      ${lastNight?.sleep ? `<p class="stages-label">Last night${lastNight.date ? `, ${fmtDay(lastNight.date)}` : ''}</p>${sleepStages(lastNight.sleep)}` : ''}
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
        <label class="field"><span>Sleep, hours</span><input class="input" name="sleep_hours" inputmode="decimal" value="${esc(g.sleep_hours)}"></label>
        <label class="field"><span>Stand hours</span><input class="input" name="stand_hours" inputmode="numeric" value="${esc(g.stand_hours)}"></label>
        <div class="form-actions" style="align-self:end"><button class="btn primary" type="submit">Save targets</button></div>
      </form>
    </details>
    <details class="card disclosure"${state.healthSetupOpen ? ' open' : ''}><summary>${icon('phone')}How your iPhone sends Health data</summary>${healthSetup(true)}</details>
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

function eventsByDay(events) {
  const today = localToday();
  const byDay = new Map();
  for (const e of events) {
    const d = e.allDay ? e.start : e.start.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, list]) => `<div class="day-block">
      <p class="day-h">${d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : fmtDay(d, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      ${list.map((e) => `<div class="ev${e.deadline ? ' deadline' : ''}"${safeColor(e.color) ? ` style="--c:${safeColor(e.color)}"` : ''}><span class="ev-time">${e.allDay ? 'All day' : e.time}</span><span class="ev-title">${esc(e.title)}${e.location ? `<span class="faint"> ${esc(e.location)}</span>` : ''}</span></div>`).join('')}
    </div>`).join('');
}

function calendarSection(d) {
  const feeds = d.feeds.map((f) => `<div class="li li-plain feed">
      <span class="li-ic"${safeColor(f.color) ? ` style="color:${safeColor(f.color)}"` : ''}>${icon(f.kind === 'deadlines' ? 'bolt' : 'calendar')}</span>
      <span class="li-body"><span class="li-title">${esc(f.name)}</span>
        <span class="li-sub">${f.kind === 'deadlines' ? 'Deadlines become tasks' : 'Calendar'}, ${esc(f.host)}. ${f.lastError ? `<span class="bad">${esc(f.lastError)}</span>` : `${f.eventCount} events, synced ${ago(f.lastSync)}`}</span></span>
      <button class="btn tinted small" data-action="cal-remove" data-id="${f.id}">Remove</button></div>`).join('');
  const upcoming = d.events.length ? eventsByDay(d.events) : '';
  // Feeds and the add form fold away once something is connected; the week itself comes first.
  const manageOpen = !d.feeds.length || state.query?.get('section') === 'calendars';
  return `<section class="section" id="calendars"><div class="gh"><h2>Uni and calendar</h2><span class="gh-links"><a class="gh-link" href="#/calendar">${icon('calendar')}Open calendar</a>${d.feeds.length ? `<button class="gh-link" data-action="cal-sync">${icon('sync')}Sync now</button>` : ''}</span></div>
    ${nextEvent(d.events)}
    ${upcoming ? `<div class="card agenda">${upcoming}</div>` : d.feeds.length ? emptyState({ icon: 'calendar', title: 'A clear week', text: 'Nothing on your calendars in the next 7 days.', small: true }) : ''}
    <details class="card disclosure manage-cal"${manageOpen ? ' open' : ''}>
    <summary>${icon('calendar')}Manage calendars<span class="summary-count">${d.feeds.length} connected</span></summary>
    ${feeds ? `<div class="group flush">${feeds}</div>` : ''}
    <form class="cal-add" data-form="cal-add">
      ${d.feeds.length ? '' : `<div class="setup-hero"><span class="setup-ic cal-ic">${icon('calendar')}</span><div><h3>Add your calendars</h3>
        <p class="muted">Events on Today; VLE deadlines become tasks.</p></div></div>`}
      <label class="field"><span>Calendar link (iCal or webcal)</span><input class="input" name="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://calendar.google.com/calendar/ical/..." required></label>
      <div class="seg" role="radiogroup" aria-label="What it is">
        <label><input type="radio" name="kind" value="" checked><span>Work it out</span></label>
        <label><input type="radio" name="kind" value="calendar"><span>Calendar</span></label>
        <label><input type="radio" name="kind" value="deadlines"><span>Deadlines</span></label>
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">${icon('plus')}Add calendar</button></div>
      <details class="howto"><summary>Where to find the link</summary>
        <p class="howto-h">UM VLE deadlines</p>
        <ol><li>Log in at www.um.edu.mt/vle/my and open <b>Calendar</b> from the user menu.</li>
          <li>At the bottom, <b>Import or export calendars</b>, then <b>Export calendar</b>.</li>
          <li>Events: <b>Events related to courses</b>. Period: <b>Recent and next 60 days</b>.</li>
          <li><b>Get calendar URL</b>, copy it and paste it here.</li></ol>
        <p class="howto-h">Google Calendar</p>
        <ol><li>In Safari open calendar.google.com, tap <b>aA</b> and <b>Request Desktop Website</b>.</li>
          <li>Settings, pick the calendar, <b>Integrate calendar</b>, copy <b>Secret address in iCal format</b>.</li></ol>
        <p class="howto-h">iPhone (iCloud) calendar</p>
        <ol><li>Calendar app, <b>Calendars</b>, tap (i) next to the calendar, turn on <b>Public Calendar</b>, <b>Share Link</b>, <b>Copy</b>.</li></ol>
        <p class="howto-h">Outlook, your UM email</p>
        <ol><li>On a computer, outlook.office.com, Settings, <b>Calendar</b>, <b>Shared calendars</b>.</li>
          <li>Under Publish a calendar choose <b>Can view titles and locations</b>, Publish, copy the <b>ICS</b> link.</li></ol>
      </details>
    </form>
    </details>
  </section>`;
}

// The next timed event in the coming week, with how long until it starts.
function nextEvent(events) {
  const now = Date.now();
  const e = events.find((x) => !x.allDay && new Date(x.start).getTime() > now);
  if (!e) return '';
  const min = Math.round((new Date(e.start).getTime() - now) / 60000);
  const when = min < 60 ? `in ${min} min` : min < 24 * 60 ? `in ${Math.floor(min / 60)} h ${min % 60} min` : fmtDay(e.start.slice(0, 10), { weekday: 'long' });
  return `<div class="card next-event${e.deadline ? ' deadline' : ''}"${safeColor(e.color) ? ` style="--c:${safeColor(e.color)}"` : ''}>
    <p class="eyebrow">${icon(e.deadline ? 'bolt' : 'uni')}${e.deadline ? 'Next deadline' : 'Next up'}</p>
    <p class="next-event-title">${esc(e.title)}</p>
    <p class="next-event-when"><b>${when}</b>, ${esc(e.time)}${e.endTime && e.endTime !== e.time ? ` to ${esc(e.endTime)}` : ''}${e.location ? ` · ${esc(e.location)}` : ''}</p>
  </div>`;
}

// ---------- Season ----------

// HP over the last 30 days as a filled line on a fixed 0 to max scale, deaths marked at 0.
function hpArea(days, maxHp) {
  if (days.length < 2) return '<p class="muted small">Not enough days yet</p>';
  const w = 300;
  const h = 84;
  const step = w / (days.length - 1);
  const y = (hp) => (h - 4 - (Math.max(0, hp) / maxHp) * (h - 10)).toFixed(1);
  const pts = days.map((d, i) => `${(i * step).toFixed(1)} ${y(d.hp_end)}`);
  const line = `M${pts.join(' L')}`;
  const deaths = days.map((d, i) => (d.hp_end <= 0 ? `<line x1="${(i * step).toFixed(1)}" x2="${(i * step).toFixed(1)}" y1="0" y2="${h}" class="hp-death"/>` : '')).join('');
  const low = days.reduce((a, d) => (d.hp_end < a.hp_end ? d : a), days[0]);
  const label = `HP at the end of each of the last ${days.length} days, from ${days[0].hp_end} to ${days[days.length - 1].hp_end}, lowest ${low.hp_end} on ${fmtDay(low.date)}.`;
  return `<svg class="hp-area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">
    <defs><linearGradient id="hp-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:rgba(225,6,0,0.45)"/><stop offset="1" style="stop-color:rgba(225,6,0,0)"/></linearGradient></defs>
    ${deaths}<path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#hp-fill)"/><path d="${line}" class="hp-line"/></svg>
    <div class="bc-axis" aria-hidden="true"><span>${fmtDay(days[0].date)}</span><span class="last">${fmtDay(days[days.length - 1].date)}</span></div>`;
}

function seasonSection(s) {
  if (!s) return '';
  const g = s.game;
  const w = s.week;
  const streaks = s.streaks.map((x) => `<li><span class="li-ic">${icon('flame')}</span><span class="streak-name">${esc(x.name)}</span><b>${x.streak}</b><span class="faint small">${x.weekly ? (x.streak === 1 ? 'week' : 'weeks') : (x.streak === 1 ? 'day' : 'days')}</span></li>`).join('');
  return `<section class="section season" id="season">
    <div class="gh"><h2>Season ${g.season}</h2><span class="gh-count">Day ${s.seasonDay}${g.deaths ? `, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'} so far` : ''}</span></div>
    <div class="card season-card${g.hp <= 30 ? ' low' : ''}">
      <div class="season-top">
        <div class="season-hp"><b data-count="season-hp">${g.hp}</b><span>of ${g.maxHp} HP</span></div>
        <dl class="season-stats">
          <div><dt>This week</dt><dd><b>${w.cleanDays}</b> clean ${w.cleanDays === 1 ? 'day' : 'days'} of ${w.judgedDays}</dd></div>
          <div><dt>Pardons</dt><dd><b>${g.pardonsLeft}</b> left this month</dd></div>
          ${w.focusMin ? `<div><dt>Focus</dt><dd><b>${Math.floor(w.focusMin / 60)} h ${w.focusMin % 60}</b> min this week</dd></div>` : ''}
        </dl>
      </div>
      ${hpArea(s.days, g.maxHp)}
      ${streaks ? `<p class="season-sub">Longest streaks</p><ul class="streaks">${streaks}</ul>` : ''}
    </div>
    ${s.reviewDue ? `<a class="banner action" href="#/review">${icon('review')}<span><b>Weekly review is ready</b></span>${icon('chevron', 'chev')}</a>` : ''}
    <div class="group">
      <a class="li li-plain li-nav" href="#/review"><span class="li-ic">${icon('review')}</span><span class="li-body"><span class="li-title">Weekly review</span></span>${icon('chevron', 'chev')}</a>
      <a class="li li-plain li-nav" href="#/review"><span class="li-ic">${icon('trend')}</span><span class="li-body"><span class="li-title">History</span></span>${icon('chevron', 'chev')}</a>
    </div>
  </section>`;
}

// ---------- Page ----------

export function viewDashboard() {
  const d = state.dash;
  const head = pageHead('Dashboard', { actions: iconLink('#/settings', 'settings', 'Settings') });
  if (!d) return ctx.shell(`${head}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`);
  // Your season first, then the week at uni, then your body; the businesses sit alongside.
  ctx.shell(`${head}
    ${d.errors.length ? `<div class="banner warn">${esc(d.errors[0])}</div>` : ''}
    <div class="split">
      <div>${seasonSection(d.season)}<div id="sec-calendars">${calendarSection(d)}</div><div id="sec-health">${healthSection(d.health)}</div></div>
      <aside>${businessSection(d.business)}</aside>
    </div>`);
  // Links like #/dashboard?section=health land on that section.
  const section = state.query?.get('section');
  if (section) document.getElementById(`sec-${section}`)?.scrollIntoView({ block: 'start' });
}

// ---------- Events ----------

export async function dataClick(a, el) {
  switch (a) {
    case 'health-setup':
      state.healthSetup = el.dataset.tab;
      state.healthSetupOpen = true;
      ctx.render();
      return true;
    case 'cal-remove':
      if (!confirm('Remove this calendar? Tasks it already made stay.')) return true;
      if (await act(() => api('DELETE', `/api/calendar/feeds/${el.dataset.id}`), 'Calendar removed.')) { await loadDashboard(); ctx.render(); }
      return true;
    case 'cal-sync': {
      el.disabled = true;
      const r = await act(() => api('POST', '/api/calendar/sync', {}));
      if (r) {
        const made = r.results.reduce((n, x) => n + (x.created || 0), 0);
        const bad = r.results.filter((x) => !x.ok).length;
        toast(bad ? `${bad} calendar${bad === 1 ? '' : 's'} could not sync.` : made ? `Synced. ${made} new deadline${made === 1 ? '' : 's'} added as tasks.` : 'Synced.', Boolean(bad));
        await loadDashboard();
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
        await loadDashboard();
        ctx.render();
      }
      return true;
    }
    case 'health-goals': {
      const f = form2obj(form);
      const r = await act(() => api('PUT', '/api/health/goals', f), 'Targets saved.');
      if (r) { await loadDashboard(); ctx.render(); }
      return true;
    }
    default:
      return false;
  }
}
