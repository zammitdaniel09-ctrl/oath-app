// The weekly review: the week in numbers, the coach's write-up and the decisions it asks for, the season,
// HP over 30 days and the longest streaks.
import {
  fmtMin, esc, fmtDay, state, icon, strengthChip, pageHead, iconLink, emptyState, toast, act, api, form2obj, smoothPath,
} from './ui.js';
import { richHtml } from './rich.js';
import { goalsStrip } from './today-list.js';

let ctx = { shell: () => {}, skeleton: () => {}, refreshCurrent: () => {} };
export function initReview(c) {
  ctx = { ...ctx, ...c };
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));

function weekStats(w) {
  const hp = w.hpStart !== null && w.hpEnd !== null ? `${w.hpStart} to ${w.hpEnd}` : '–';
  return `<div class="stats four">
    <div class="stat"><b>${w.cleanDays}</b><span>Clean ${w.cleanDays === 1 ? 'day' : 'days'} of ${w.judgedDays}</span></div>
    <div class="stat"><b>${hp}</b><span>HP</span></div>
    <div class="stat"><b>${w.focusMin ? fmtMin(w.focusMin) : '0'}</b><span>Focus time</span></div>
    <div class="stat"><b>${w.tasksDone}</b><span>Tasks done</span></div>
  </div>
  ${w.dodges.length ? `<p class="small muted" style="margin-top:10px">"Not now" reasons: ${w.dodges.map((d) => `${esc(d.reason)} (${d.n})`).join(', ')}.</p>` : ''}`;
}

function reviewCard(r) {
  const rv = r.review;
  const w = r.lastWeek;
  if (rv.doneAt) {
    return `<section class="section"><div class="gh"><h2>Week of ${fmtDay(rv.weekStart)}</h2><span class="gh-count">Reviewed</span></div>
      <div class="card"><p>This week's focus: <b>${esc(rv.focus)}</b></p>${rv.obstaclePlan ? `<p class="small muted" style="margin-top:6px">${esc(rv.obstaclePlan)}</p>` : ''}
      ${rv.coachText ? `<details style="margin-top:10px"><summary class="small">Coach's review</summary><div class="plan-text rich">${richHtml(rv.coachText)}</div></details>` : ''}</div></section>`;
  }
  if (!w.judgedDays) {
    return `<section class="section"><div class="gh"><h2>Weekly review</h2></div>
      <div class="card muted">Opens on Monday.</div></section>`;
  }
  const rows = w.habits.map((h) => {
    const d = state.decisions[h.id] || 'keep';
    const opts = ['keep', 'adjust', 'drop'].map((o) => `<label><input type="radio" name="d-${h.id}" value="${o}"${d === o ? ' checked' : ''} data-decide="${h.id}"><span>${o[0].toUpperCase()}${o.slice(1)}</span></label>`).join('');
    return `<div class="review-row">
      <div><span class="li-title">${esc(h.name)}</span>
        <span class="li-sub">${h.flexible ? `${h.done} of ${h.target} this week` : `kept ${h.done} of ${h.target}`}${h.minimum ? `, ${h.minimum} minimum` : ''}${h.missed ? `, ${h.missed} missed` : ''}. Strength ${h.strength}% (${signed(h.trend)})</span></div>
      <div class="seg small" role="radiogroup" aria-label="Decision for ${esc(h.name)}">${opts}</div>
    </div>`;
  }).join('');
  return `<section class="section"><div class="gh"><h2>Weekly review</h2><span class="gh-count">Week of ${fmtDay(rv.weekStart)}</span></div>
    <div class="card review">
      ${rv.coachText ? `<div class="plan-text rich">${richHtml(rv.coachText)}</div>` : `<button class="btn tinted" data-action="review-write">${icon('coach')}Let the coach pre-fill it</button>`}
      ${weekStats(w)}
      <form data-form="review-finish">
        ${rows ? `<h3 style="margin-top:18px">Each habit: keep, adjust or drop</h3>${rows}` : ''}
        <label class="field"><span>This week's one or two things that matter most</span><input class="input" name="focus" maxlength="300" required autocomplete="off"></label>
        <label class="field"><span>If-then plan for the week's biggest obstacle</span><input class="input" name="obstaclePlan" maxlength="300" autocomplete="off" placeholder="If I skip Monday's gym, then I go Tuesday at 7:00"></label>
        <div class="form-actions"><button class="btn primary" type="submit">Finish the review</button></div>
      </form>
    </div></section>`;
}

// HP over the last 30 days as a smooth filled curve on a fixed 0 to max scale, deaths marked at 0, and
// today's HP in a pill over its point.
function hpArea(days, maxHp) {
  if (days.length < 2) return '<p class="muted small">Not enough days yet</p>';
  const w = 300;
  const h = 84;
  const step = w / (days.length - 1);
  const y = (hp) => (h - 4 - (Math.max(0, hp) / maxHp) * (h - 10)).toFixed(1);
  const pts = days.map((d, i) => [i * step, Number(y(d.hp_end))]);
  const line = smoothPath(pts);
  const [lx, ly] = pts[pts.length - 1];
  const deaths = days.map((d, i) => (d.hp_end <= 0 ? `<line x1="${(i * step).toFixed(1)}" x2="${(i * step).toFixed(1)}" y1="0" y2="${h}" class="hp-death"/>` : '')).join('');
  const low = days.reduce((a, d) => (d.hp_end < a.hp_end ? d : a), days[0]);
  const label = `HP at the end of each of the last ${days.length} days, from ${days[0].hp_end} to ${days[days.length - 1].hp_end}, lowest ${low.hp_end} on ${fmtDay(low.date)}.`;
  return `<div class="hp-plot"><svg class="hp-area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">
    <defs><linearGradient id="hp-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--hp-area-0, rgba(225,6,0,0.45))"/><stop offset="1" style="stop-color:var(--hp-area-1, rgba(225,6,0,0))"/></linearGradient></defs>
    ${deaths}<path d="${line} L${w} ${h} L0 ${h} Z" fill="url(#hp-fill)"/><path d="${line}" class="hp-line"/></svg>
    <i class="hp-dot" style="left:${((lx / w) * 100).toFixed(1)}%;top:${((ly / h) * 100).toFixed(1)}%" aria-hidden="true"></i>
    <span class="tip-pill end" style="left:${((lx / w) * 100).toFixed(1)}%;top:${((ly / h) * 100).toFixed(1)}%" aria-hidden="true">${days[days.length - 1].hp_end} HP</span></div>
    <div class="bc-axis" aria-hidden="true"><span>${fmtDay(days[0].date)}</span><span class="last">${fmtDay(days[days.length - 1].date)}</span></div>`;
}

// The longest streak running, big on a glow: the number, a flame, the habit.
function streakGlow(x) {
  if (!x?.streak) return '';
  const unit = x.weekly ? (x.streak === 1 ? 'week' : 'weeks') : (x.streak === 1 ? 'day' : 'days');
  return `<section class="section"><div class="glow-card" role="img" aria-label="${esc(`Longest streak: ${x.name}, ${x.streak} ${unit}`)}">
      <span class="glow-flame" aria-hidden="true">${icon('flame')}</span>
      <b class="glow-num">${x.streak}</b>
      <span class="glow-label">${unit === 'days' || unit === 'day' ? `${unit === 'day' ? 'Day' : 'Days'} streak` : `${unit === 'week' ? 'Week' : 'Weeks'} streak`}</span>
      <p class="glow-sub">${esc(x.name)}</p>
    </div></section>`;
}

// The season at the head of the review: HP now and over 30 days, pardons, and the longest streaks.
function seasonCard(s) {
  if (!s) return '';
  const g = s.game;
  const streaks = s.streaks.map((x) => `<li><span class="li-ic">${icon('flame')}</span><span class="streak-name">${esc(x.name)}</span><b>${x.streak}</b><span class="faint small">${x.weekly ? (x.streak === 1 ? 'week' : 'weeks') : (x.streak === 1 ? 'day' : 'days')}</span></li>`).join('');
  return `<section class="section season" id="season">
    <div class="gh"><h2>Season ${g.season}</h2><span class="gh-count">Day ${s.seasonDay}${g.deaths ? `, ${g.deaths} ${g.deaths === 1 ? 'death' : 'deaths'} so far` : ''}</span></div>
    <div class="card season-card${g.hp <= 30 ? ' low' : ''}">
      <div class="season-top">
        <div class="season-hp"><b data-count="season-hp">${g.hp}</b><span>of ${g.maxHp} HP</span></div>
        <dl class="season-stats">
          <div><dt>Pardons</dt><dd><b>${g.pardonsLeft}</b> left this month</dd></div>
        </dl>
      </div>
      ${hpArea(s.days, g.maxHp)}
      ${streaks ? `<p class="season-sub">Longest streaks</p><ul class="streaks">${streaks}</ul>` : ''}
    </div>
  </section>`;
}

export function viewReview() {
  const r = state.review;
  if (!r) return ctx.shell(ctx.skeleton('Review'));
  const strengthRows = r.habitStrength.map((h) => `<div class="li li-plain"><span class="li-body"><span class="li-title">${esc(h.name)}</span><span class="li-sub">Kept ${h.kept14} of ${h.sched14} in 14 days</span></span><span class="li-side">${strengthChip(h.strength)}</span></div>`).join('');
  const dayRows = r.days.slice(0, 30).map((d) => `<tr><td>${fmtDay(d.date)}${d.rest ? ' <span class="faint">rest</span>' : ''}</td><td class="num">${d.kept}</td><td class="num">${d.missed ? `<span class="bad">${d.missed}</span>` : 0}</td><td class="num">${d.hp_end}${d.bonus ? ` <span class="faint">(+${d.bonus})</span>` : ''}</td></tr>`).join('');
  const missRows = r.misses.slice(0, 40).map((m) => `<div class="li li-plain">
      <span class="li-body"><span class="li-title">${esc(m.title)}</span>${m.pardoned || m.overturned ? `<span class="li-sub">${m.overturned ? 'Overturned by Apple Health' : `Pardoned: ${esc(m.reason)}${m.plan ? `<br>Plan: ${esc(m.plan)}` : ''}`}</span>` : ''}</span>
      <span class="li-side small miss-side">${fmtDay(m.date)}${m.overturned ? `<span class="st ok">${icon('check')}Overturned</span>` : m.pardoned ? '<span class="st off">Pardoned</span>' : `<span class="st bad">${icon('close')}${m.hpLost} HP${m.repeat ? ', twice' : ''}</span>`}</span></div>`).join('');
  const deaths = r.deaths.map((d) => `<div class="li li-plain"><span class="li-body"><span class="li-title">Killed by ${esc(d.cause)}</span></span><span class="li-side small faint">${fmtDay(d.date)}, season ${d.season - 1} ended</span></div>`).join('');
  const stale = r.stale.map((k) => `<div class="triage-row"><span class="li-title">${esc(k.title)}</span>
      <div class="triage-actions" role="group" aria-label="Decide">
        <button class="btn tinted small" data-action="triage" data-do="week" data-id="${k.id}">Next week</button>
        <button class="btn tinted small" data-action="triage" data-do="someday" data-id="${k.id}">Someday</button>
        <button class="btn plain small danger-text" data-action="triage" data-do="drop" data-id="${k.id}">Drop</button>
      </div></div>`).join('');

  ctx.shell(`${pageHead('Review', { actions: iconLink('#/settings', 'settings', 'Settings') })}
    <div class="split"><div>
      ${seasonCard(state.season)}
      ${streakGlow(state.season?.streaks?.[0])}
      ${reviewCard(r)}
      <section class="section"><div class="gh"><h2>This week so far</h2></div><div class="card">${weekStats(r.thisWeek)}</div></section>
      ${stale ? `<section class="section"><div class="gh"><h2>Clear the backlog</h2><span class="gh-count">${r.stale.length}</span></div><div class="card triage">${stale}</div></section>` : ''}
      <section class="section"><div class="gh"><h2>Habit strength</h2></div>
        ${strengthRows ? `<div class="group">${strengthRows}</div>` : emptyState({ icon: 'plan', title: 'No habits yet', small: true })}
      </section>
    </div><aside>
      ${goalsStrip(r.goals)}
      <section class="section"><div class="gh"><h2>Days</h2></div>
        ${dayRows ? `<div class="card flush table-wrap"><table class="table"><thead><tr><th>Day</th><th class="num">Kept</th><th class="num">Missed</th><th class="num">HP</th></tr></thead><tbody>${dayRows}</tbody></table></div>` : '<div class="card muted">Your first day closes at midnight.</div>'}
      </section>
      <section class="section"><div class="gh"><h2>Misses</h2><span class="gh-count">${r.misses.length}</span></div>
        ${missRows ? `<div class="group">${missRows}</div>` : '<div class="card muted">No misses yet.</div>'}</section>
      ${deaths ? `<section class="section"><div class="gh"><h2>Deaths</h2></div><div class="group">${deaths}</div></section>` : ''}
    </aside></div>`);
}

export async function reviewClick(a, el) {
  if (a === 'review-write') {
    el.disabled = true;
    toast('The coach is writing your review');
    if (await act(() => api('POST', '/api/review/write', {}))) await ctx.refreshCurrent(); else el.disabled = false;
  } else return false;
  return true;
}

export async function reviewSubmit(kind, form) {
  if (kind === 'review-finish') {
    const f = form2obj(form);
    const decisions = {};
    for (const [k, val] of Object.entries(f)) if (k.startsWith('d-')) decisions[k.slice(2)] = val;
    const r = await act(() => api('POST', '/api/review/finish', { decisions, focus: f.focus, obstaclePlan: f.obstaclePlan }), 'Review done. The week starts now.');
    if (r) {
      state.decisions = {};
      if (r.adjust?.length) {
        state.sheet = { kind: 'habit', id: r.adjust[0] };
        location.hash = '#/plan';
      } else await ctx.refreshCurrent();
    }
  } else return false;
  return true;
}
