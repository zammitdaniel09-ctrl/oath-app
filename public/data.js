// The Dashboard: Apple Health, business sites, calendars and the way into the weekly review.
import {
  state, esc, api, act, toast, fmtDay, bar, icon, pageHead, iconLink, fmtInt, fmtDec, fmtHours, ago,
  miniRing, barChart, sparkline, localToday, keyBlock, form2obj, haptic,
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
  const [health, business, feeds, events, tokens] = await Promise.allSettled([
    api('GET', '/api/health?days=14'),
    api('GET', '/api/business'),
    api('GET', '/api/calendar/feeds'),
    api('GET', `/api/calendar/events?from=${today}&to=${addDays(today, 6)}`),
    api('GET', '/api/tokens'),
  ]);
  state.dash = {
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
    <div><span class="dtile-label">${label}</span><span class="dtile-val">${value === null || value === undefined ? '-' : display(value)}<small>${unit}</small></span>
      <span class="dtile-goal">${goal ? `of ${display(goal)}${unit}` : ''}</span></div>
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
  const tab = state.healthSetup || 'hae';
  const url = `${location.origin}/api/shortcut/health`;
  const count = state.tokens?.count || 0;
  const keyStep = `<li><b>Make your key.</b> ${count && !state.newToken ? 'You already have one (it was only shown once). If you no longer have it, make a new one; the old one keeps working.' : 'It lets your iPhone send data to Oath and nothing else.'}
      ${keyBlock()}${state.newToken ? '' : `<div class="form-actions"><button class="btn ${count ? 'tinted' : 'primary'} small" data-action="token-new">${icon('key')}${count ? 'Make a new key' : 'Make a key'}</button></div>`}</li>`;
  const hae = `<ol class="steps">
      ${keyStep}
      <li>Install <b>Health Auto Export - JSON+CSV</b> from the App Store and get Premium (one-time lifetime, about €30, or €1.99 a month). The Basic tier has no automations.</li>
      <li>In the app open <b>Automations</b>, tap <b>New Automation</b>, choose <b>REST API</b> and name it Oath.</li>
      <li>URL: <code>${esc(url)}</code></li>
      <li>Under <b>HTTP Headers</b>, add one: key <b>Authorization</b>, value <b>Bearer</b>, a space, then your key.</li>
      <li>Data Type <b>Health Metrics</b>. Select Step Count, Active Energy, Apple Exercise Time, Apple Stand Hour, Sleep Analysis, Walking + Running Distance, Resting Heart Rate, Heart Rate Variability, Body Mass and Mindful Minutes.</li>
      <li>Export Format <b>JSON</b>, Version <b>2</b>, Date Range <b>Default</b>, Summarize Data <b>on</b>, Time Grouping <b>Hours</b>. Sync every hour. Save and switch it on.</li>
      <li>Make a second automation exactly the same, with Data Type <b>Workouts</b> (route data off).</li>
      <li>Tap <b>Manual Export</b> once. This page then says "Synced just now".</li>
    </ol>
    <p class="note">iOS does not let any app read Health while the phone is locked, so syncs happen when you use your phone. Keep Background App Refresh on.</p>`;
  const shortcut = `<ol class="steps">
      ${keyStep}
      <li>Open <b>Shortcuts</b>, tap +, name it <b>Send Health to Oath</b>.</li>
      <li>Add <b>Find Health Samples</b>: Type Steps, Start Date is Today. Then <b>Calculate Statistics</b>: Sum.</li>
      <li>Do the same for <b>Exercise Minutes</b> and <b>Active Energy</b>.</li>
      <li>Add <b>Find Health Samples</b>: Type Sleep Analysis, Start Date is in the last 1 day, Value is not In Bed, Value is not Awake. Then <b>Get Details of Health Samples</b>: Duration, then <b>Calculate Statistics</b>: Sum.</li>
      <li>Add <b>Get Contents of URL</b>: <code>${esc(url)}</code>. Show More: Method <b>POST</b>, Header <b>Authorization</b> = <b>Bearer</b> and your key, Request Body <b>JSON</b> with fields <b>steps</b>, <b>exercise_min</b>, <b>active_kcal</b> (numbers) and <b>sleep_hours</b> (text), each set to the matching result.</li>
      <li>In the <b>Automation</b> tab, tap +, <b>Time of Day</b>, every day at 20:30, <b>Run Immediately</b>, and pick this shortcut. Add a second one for 08:00 to send last night's sleep.</li>
    </ol>
    <p class="note">Free, but it only sends four numbers and no workouts. The app above sends everything, every hour.</p>`;
  return `<div class="card setup${connected ? ' quiet' : ''}">
    ${connected ? '' : `<div class="setup-hero"><span class="setup-ic">${icon('heart')}</span><div><h3>Connect Apple Health</h3>
      <p class="muted">Apple does not let web apps read Health directly, so your iPhone sends it here. Then habits like "10k steps" or "Gym" tick themselves off, and a miss that Health proves wrong is overturned.</p></div></div>`}
    <div class="seg wide-seg" role="tablist" aria-label="How to connect">
      <button role="tab" aria-selected="${tab === 'hae'}" data-action="health-setup" data-tab="hae">Automatic, recommended</button>
      <button role="tab" aria-selected="${tab === 'shortcut'}" data-action="health-setup" data-tab="shortcut">Free shortcut</button>
    </div>
    ${tab === 'hae' ? hae : shortcut}
  </div>`;
}

function healthSection(h) {
  if (!h) return `<section class="section"><div class="gh"><h2>Health</h2></div><div class="card muted">Health data could not be loaded.</div></section>`;
  if (!h.connected) return `<section class="section" id="health"><div class="gh"><h2>Health</h2></div>${healthSetup(false)}</section>`;
  const days = h.days || [];
  const todayRow = days.find((d) => d.date === h.today) || {};
  const lastNight = todayRow.sleep_hours !== null && todayRow.sleep_hours !== undefined ? todayRow : [...days].reverse().find((d) => d.sleep_hours);
  const g = h.goals || {};
  const labels = days.map((d, i) => (i === days.length - 1 ? 'Today' : shortDay(d.date)));
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
    <div class="gh"><h2>Health</h2><span class="gh-count">${icon('sync')}Synced ${ago(h.lastSync)}</span></div>
    <div class="dtiles">
      ${tile('steps', 'c-move', 'Steps', todayRow.steps, '', g.steps, fmtInt)}
      ${tile('timer', 'c-day', 'Exercise', todayRow.exercise_min, ' min', g.exercise_min, (v) => Math.round(v))}
      ${tile('flame', 'c-hp', 'Active energy', todayRow.active_kcal, ' kcal', g.active_kcal, fmtInt)}
      ${tile('moon', 'c-sleep', 'Sleep', lastNight?.sleep_hours, '', g.sleep_hours, fmtHours)}
    </div>
    <div class="card chart-card">
      <div class="cc-head"><span>${icon('steps')}Steps</span><span class="faint small">${avgSteps === null ? '' : `Average ${fmtInt(avgSteps)} a day`}</span></div>
      ${barChart(steps, { goal: g.steps, labels, cls: 'c-move', unit: ' steps' })}
    </div>
    <div class="card chart-card">
      <div class="cc-head"><span>${icon('moon')}Sleep</span><span class="faint small">${avgSleep === null ? '' : `Average ${fmtHours(avgSleep)}`}</span></div>
      ${barChart(sleep, { goal: g.sleep_hours, labels, cls: 'c-sleep', unit: ' h' })}
      ${lastNight?.sleep ? `<p class="small faint" style="margin-top:12px">Last night</p>${sleepStages(lastNight.sleep)}` : ''}
    </div>
    ${autos ? `<div class="gh sub"><h3>Habits Health ticks off</h3></div><div class="group">${autos}</div>` : `<p class="note">Link a habit to Health in Plan: open the habit, then "Tick it off from Apple Health".</p>`}
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
        <p class="muted">Revenue, sales, licences, trials and whether your EAs are online for GoldenStraddler, and members, activity and backups for Exposed FX Journal. Each site needs a small read-only update first; it is ready and waiting for your go-ahead.</p></div></div></div>
    </section>`;
  }
  return `<section class="section" id="business"><div class="gh"><h2>Business</h2><button class="gh-link" data-action="biz-refresh">${icon('sync')}Refresh</button></div>
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
      ${list.map((e) => `<div class="ev${e.deadline ? ' deadline' : ''}" style="--c:${esc(e.color || '')}"><span class="ev-time">${e.allDay ? 'All day' : e.time}</span><span class="ev-title">${esc(e.title)}${e.location ? `<span class="faint"> ${esc(e.location)}</span>` : ''}</span></div>`).join('')}
    </div>`).join('');
}

function calendarSection(d) {
  const feeds = d.feeds.map((f) => `<div class="li li-plain">
      <span class="li-ic" style="color:${esc(f.color || 'inherit')}">${icon(f.kind === 'deadlines' ? 'bolt' : 'calendar')}</span>
      <span class="li-body"><span class="li-title">${esc(f.name)}</span>
        <span class="li-sub">${f.kind === 'deadlines' ? 'Deadlines become tasks' : 'Calendar'}, ${esc(f.host)}. ${f.lastError ? `<span class="bad">${esc(f.lastError)}</span>` : `${f.eventCount} events, synced ${ago(f.lastSync)}`}</span></span>
      <button class="btn tinted small" data-action="cal-remove" data-id="${f.id}">Remove</button></div>`).join('');
  const upcoming = d.events.length ? eventsByDay(d.events) : '';
  return `<section class="section" id="calendars"><div class="gh"><h2>Calendars</h2>${d.feeds.length ? `<button class="gh-link" data-action="cal-sync">${icon('sync')}Sync now</button>` : ''}</div>
    ${upcoming ? `<div class="card agenda">${upcoming}</div>` : d.feeds.length ? '<div class="card muted">Nothing in the next 7 days.</div>' : ''}
    ${feeds ? `<div class="group">${feeds}</div>` : ''}
    <form class="card cal-add" data-form="cal-add">
      ${d.feeds.length ? '' : `<div class="setup-hero"><span class="setup-ic cal-ic">${icon('calendar')}</span><div><h3>Add your calendars</h3>
        <p class="muted">Events show on Today and the day plan only counts the time you actually have free. Your UM VLE calendar turns every assignment deadline into a task on its own.</p></div></div>`}
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
        <p class="note">These links are private. Anyone with one can read that calendar, so keep them to yourself.</p>
      </details>
    </form>
  </section>`;
}

// ---------- Page ----------

export function viewDashboard() {
  const d = state.dash;
  const head = pageHead('Dashboard', { over: 'Your body, your businesses, your week', actions: iconLink('#/settings', 'settings', 'Settings') });
  if (!d) return ctx.shell(`${head}<div class="skeleton"><i></i><i></i><i class="short"></i></div>`);
  const review = `<section class="section"><div class="gh"><h2>Review</h2></div>
    <div class="group">
      <a class="li li-plain li-nav" href="#/review"><span class="li-ic">${icon('review')}</span><span class="li-body"><span class="li-title">Weekly review</span><span class="li-sub">Keep, adjust or drop each habit. Pick the week's focus.</span></span>${icon('chevron', 'chev')}</a>
      <a class="li li-plain li-nav" href="#/review"><span class="li-ic">${icon('trend')}</span><span class="li-body"><span class="li-title">History</span><span class="li-sub">HP, habit strength, misses, pardons and deaths</span></span>${icon('chevron', 'chev')}</a>
    </div></section>`;
  ctx.shell(`${head}
    ${d.errors.length ? `<div class="banner warn">${esc(d.errors[0])}</div>` : ''}
    <div class="split">
      <div>${healthSection(d.health)}</div>
      <aside>${businessSection(d.business)}${calendarSection(d)}${review}</aside>
    </div>`);
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
        haptic();
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
