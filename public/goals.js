// Goals and their mind maps. Outline first on iPhone (the research is clear that canvases are the
// weakest way to edit maps on a phone); the map view gives the overview and works best on iPad.
import { state, esc, api, act, toast, fmtDay, bar, strengthChip, haptic, DAY_NAMES, form2obj, localToday, icon, pageHead, miniRing } from './ui.js';

let ctx = { shell: () => {}, render: () => {}, go: async () => {} };
export function initGoals(c) { ctx = c; }

// ---------- Loading ----------

export async function loadGoals() {
  state.goals = (await api('GET', '/api/goals?all=1')).goals;
}

export async function loadGoal(id) {
  state.goal = await api('GET', `/api/goals/${id}`);
  if (!state.plan) state.plan = await api('GET', '/api/plan').catch(() => null);
}

// ---------- List ----------

function dueText(g) {
  if (!g.targetDate) return '';
  if (g.daysLeft < 0) return `${-g.daysLeft} days past ${fmtDay(g.targetDate)}`;
  if (g.daysLeft === 0) return 'Due today';
  return `By ${fmtDay(g.targetDate)}, ${g.daysLeft} ${g.daysLeft === 1 ? 'day' : 'days'} left`;
}

function goalCard(g) {
  const closed = g.status !== 'active';
  return `<a class="goal-card${closed ? ' closed' : ''}" href="#/goals/${g.id}">
    <span class="goal-ring">${miniRing(g.pct ?? 0, 52)}<b>${g.pct === null ? '' : `${g.pct}<small>%</small>`}</b></span>
    <span class="goal-text"><span class="goal-title">${esc(g.title)}</span>
      <span class="goal-meta">${closed ? (g.status === 'done' ? 'Achieved' : 'Dropped') : esc(g.label)}${dueText(g) && !closed ? `. ${dueText(g)}` : ''}</span></span>
    ${icon('chevron', 'chev')}
  </a>`;
}

export function viewGoals() {
  const goals = state.goals;
  if (!goals) return ctx.shell('<p class="muted">Loading</p>');
  const active = goals.filter((g) => g.status === 'active');
  const closed = goals.filter((g) => g.status !== 'active');
  ctx.shell(`${pageHead('Goals', { over: `${active.length} active`, actions: `<a class="icon-btn accent" href="#/goals/new" aria-label="New goal">${icon('plus')}</a>` })}
    <div class="split"><div>
    <section class="section">
      ${active.length ? `<div class="goal-list">${active.map(goalCard).join('')}</div>`
        : `<div class="card empty-goal"><h3>What are you working towards?</h3>
            <p class="muted" style="margin-top:6px">A goal gets a number or a set of steps, a date, and the obstacle you expect. Then you break it down in a map, and any branch can become a habit or a task. Progress rolls back up on its own.</p>
            <div class="form-actions"><a class="btn primary" href="#/goals/new">Set your first goal</a></div></div>`}
    </section>
    ${closed.length ? `<section class="section"><div class="gh"><h2>Closed</h2></div><div class="goal-list">${closed.map(goalCard).join('')}</div></section>` : ''}
  </div><aside>
    <section class="section"><div class="gh"><h2>How goals work here</h2></div>
      <div class="card prose">
        <p>Each goal is written as WOOP: what you want, why it matters, what inside you will get in the way, and your if-then plan for that moment. That format has the best evidence behind it.</p>
        <p>Give it a number when you can. Specific, measurable goals beat "do your best".</p>
        <p>Break it down in the map. Tap any branch to turn it into a task or a habit; finishing them moves the goal.</p>
      </div></section>
  </aside></div>`);
}

// ---------- New and edit ----------

function goalForm(g) {
  const isNum = g?.measure === 'number';
  return `<form data-form="${g ? 'edit-goal' : 'new-goal'}"${g ? ` data-id="${g.id}"` : ''} class="woop">
    <ol class="woop-steps">
      <li><h3>What do you want?</h3>
        <label class="field"><span>The goal, as specific as you can make it</span>
          <input class="input" name="title" maxlength="160" required value="${esc(g?.title || '')}" placeholder="50 paying users on the Journal"></label>
        <div class="seg" role="radiogroup" aria-label="How it is measured">
          <label><input type="radio" name="measure" value="steps"${isNum ? '' : ' checked'}><span>By steps I finish</span></label>
          <label><input type="radio" name="measure" value="number"${isNum ? ' checked' : ''}><span>By a number</span></label>
        </div>
        <div class="num-only grid3">
          <label class="field"><span>Start</span><input class="input" name="start_value" inputmode="decimal" value="${esc(g?.startValue ?? '')}" placeholder="12"></label>
          <label class="field"><span>Target</span><input class="input" name="target_value" inputmode="decimal" value="${esc(g?.targetValue ?? '')}" placeholder="50"></label>
          <label class="field"><span>Unit</span><input class="input" name="unit" maxlength="20" value="${esc(g?.unit || '')}" placeholder="users"></label>
        </div>
        <label class="field"><span>By when</span><input class="input" type="date" name="target_date" value="${esc(g?.targetDate || '')}"></label>
      </li>
      <li><h3>Why does it matter?</h3>
        <label class="field"><span>The best outcome if you get there</span>
          <textarea class="input" name="why" maxlength="500" placeholder="The Journal pays for itself and I can stop trading for rent">${esc(g?.why || '')}</textarea></label></li>
      <li><h3>What inside you will get in the way?</h3>
        <label class="field"><span>Your own habit or feeling, not the world</span>
          <textarea class="input" name="obstacle" maxlength="500" placeholder="I polish features instead of talking to users">${esc(g?.obstacle || '')}</textarea></label></li>
      <li><h3>Your if-then plan</h3>
        <label class="field"><span>If that happens, then I will...</span>
          <textarea class="input" name="plan" maxlength="500" placeholder="If I open the code before noon, then I message two VIP members first">${esc(g?.plan || '')}</textarea></label></li>
    </ol>
    <div class="form-actions">
      <button class="btn primary" type="submit">${g ? 'Save goal' : 'Set the goal'}</button>
      ${g ? '<button class="btn tinted" type="button" data-action="goal-edit-cancel">Cancel</button>' : '<a class="btn tinted" href="#/goals">Cancel</a>'}
    </div>
  </form>`;
}

export function viewGoalNew() {
  ctx.shell(`<a class="back" href="#/goals">${icon('back')}Goals</a>${pageHead('New goal', { over: 'Wish, outcome, obstacle, plan' })}<div class="narrow">
      <div class="card">${goalForm(null)}</div></div>`);
}

// ---------- One goal ----------

function nodeIndicator(n) {
  if (n.kind === 'task') {
    return `<button class="node-box${n.ref?.done ? ' done' : ''}" data-action="node-toggle" data-id="${n.id}" aria-label="${n.ref?.done ? 'Mark not done' : 'Mark done'}">${n.ref?.done ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>' : ''}</button>`;
  }
  if (n.kind === 'habit') return '<span class="node-habit" aria-hidden="true"></span>';
  return '<span class="node-dot" aria-hidden="true"></span>';
}

function nodeMeta(n) {
  if (n.kind === 'task' && n.ref) {
    const due = n.ref.dueDate ? `${fmtDay(n.ref.dueDate)}${n.ref.deadline ? ` ${n.ref.deadline}` : ''}` : 'task';
    return `<span class="node-meta">${n.ref.done ? 'done' : due}${n.ref.hard ? ', hard' : ''}</span>`;
  }
  if (n.kind === 'habit' && n.ref) return `<span class="node-meta">habit ${strengthChip(n.ref.strength)}</span>`;
  if (n.children.length && n.pct !== null) return `<span class="node-meta">${n.pct}%</span>`;
  return '';
}

function outlineRows(nodes) {
  return nodes.map((n) => `<div class="node-row kind-${n.kind}${state.mapParent === n.id ? ' parent-sel' : ''}" style="--depth:${n.depth}">
      ${nodeIndicator(n)}
      <button class="node-text" data-action="node-open" data-id="${n.id}">${esc(n.text)}</button>
      ${nodeMeta(n)}
    </div>${outlineRows(n.children)}`).join('');
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

function outline(goal, tree) {
  const parent = state.mapParent ? findNode(tree, state.mapParent) : null;
  return `<div class="outline">
    <div class="node-root"><span>${esc(goal.title)}</span></div>
    ${tree.length ? outlineRows(tree) : '<p class="muted outline-empty">Start with the 3 to 5 big pieces this goal breaks into. Then add the steps under each.</p>'}
    <form class="node-add" data-form="node-add">
      <label class="sr" for="node-add-text">New branch</label>
      <input id="node-add-text" class="input" name="text" maxlength="200" autocomplete="off" placeholder="${parent ? `Add under "${esc(parent.text)}"` : 'Add a branch'}" required>
      <button class="btn primary" type="submit">Add</button>
    </form>
    ${parent ? `<p class="note">Adding under "${esc(parent.text)}". <button class="linkish" data-action="node-parent-clear">Add at the top level instead</button></p>` : ''}
  </div>`;
}

// ---------- The map (SVG overview) ----------

const COL = 184;
const ROW = 58;
const BOX_W = 164;
const BOX_H = 44;

function wrap(text, max = 22) {
  const words = String(text).split(/\s+/);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((`${cur} ${w}`).trim().length <= max) lines[lines.length - 1] = `${cur} ${w}`.trim();
    else if (lines.length < 2) lines.push(w);
    else {
      lines[1] = `${lines[1].slice(0, max - 1).trimEnd()}...`;
      break;
    }
  }
  return lines.map((l) => (l.length > max ? `${l.slice(0, max - 1)}...` : l));
}

function layout(goal, tree) {
  const placed = [];
  const links = [];
  let y = 0;
  const walk = (n, depth) => {
    const me = { n, depth, x: depth * COL, y: 0 };
    const kids = (n.children || []).map((c) => walk(c, depth + 1));
    if (!kids.length) {
      me.y = y;
      y += ROW;
    } else {
      me.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    }
    for (const k of kids) links.push([me, k]);
    placed.push(me);
    return me;
  };
  walk({ id: 0, text: goal.title, kind: 'root', children: tree }, 0);
  const maxDepth = Math.max(...placed.map((p) => p.depth));
  return { placed, links, width: (maxDepth + 1) * COL + 16, height: Math.max(y, ROW) + 16 };
}

function mapSvg(goal, tree) {
  const { placed, links, width, height } = layout(goal, tree);
  const z = state.mapZoom ?? 1;
  const linkPaths = links.map(([a, b]) => {
    const x1 = a.x + BOX_W + 8;
    const y1 = a.y + 8 + BOX_H / 2;
    const x2 = b.x + 8;
    const y2 = b.y + 8 + BOX_H / 2;
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" class="map-link"/>`;
  }).join('');
  const boxes = placed.map((p) => {
    const n = p.n;
    const lines = wrap(n.text);
    const cls = n.kind === 'root' ? 'root' : `${n.kind}${n.kind === 'task' && n.ref?.done ? ' done' : ''}`;
    const x = p.x + 8;
    const yTop = p.y + 8;
    const textY = yTop + (lines.length === 1 ? BOX_H / 2 + 5 : BOX_H / 2 - 3);
    const strength = n.kind === 'habit' && n.ref ? `<rect x="${x}" y="${yTop + BOX_H - 4}" width="${(BOX_W * n.ref.strength) / 100}" height="4" class="map-strength"/>` : '';
    const pct = n.kind === 'idea' && n.children?.length && n.pct !== null ? `<text x="${x + BOX_W - 8}" y="${yTop + 13}" class="map-pct" text-anchor="end">${n.pct}%</text>` : '';
    const attrs = n.kind === 'root' ? '' : ` data-action="node-open" data-id="${n.id}" role="button" tabindex="0" aria-label="${esc(n.text)}"`;
    return `<g class="map-node ${cls}"${attrs}>
      <rect x="${x}" y="${yTop}" width="${BOX_W}" height="${BOX_H}" rx="7"/>
      ${strength}${pct}
      <text x="${x + 12}" y="${textY}">${lines.map((l, i) => `<tspan x="${x + 12}" dy="${i ? 15 : 0}">${esc(l)}</tspan>`).join('')}</text>
    </g>`;
  }).join('');
  return `<div class="map-wrap">
    <div class="map-tools" role="group" aria-label="Zoom">
      <button class="btn tinted small" data-action="map-zoom" data-z="-1" aria-label="Zoom out">-</button>
      <button class="btn tinted small" data-action="map-zoom" data-z="1" aria-label="Zoom in">+</button>
    </div>
    <div class="map-scroll">
      <svg class="map" viewBox="0 0 ${width} ${height}" data-w="${width}" data-h="${height}" width="${Math.round(width * z)}" height="${Math.round(height * z)}" role="img" aria-label="Mind map of ${esc(goal.title)}">
        ${linkPaths}${boxes}
      </svg>
    </div>
  </div>`;
}

// ---------- The branch sheet ----------

function sheet(tree) {
  if (!state.sheetNode) return '';
  const n = findNode(tree, state.sheetNode);
  if (!n) return '';
  let extra = '';
  if (state.sheetMode === 'task') {
    extra = `<form class="sheet-form" data-form="node-task" data-id="${n.id}">
      <h3>Make it a task</h3>
      <div class="grid2">
        <label class="field"><span>Due date</span><input class="input" type="date" name="due_date" min="${localToday()}"></label>
        <label class="field"><span>Time</span><input class="input" type="time" name="deadline"></label>
      </div>
      <label class="field"><span>Estimate in minutes</span><input class="input" type="number" name="estimate_min" min="5" max="600" step="5" inputmode="numeric" placeholder="30"></label>
      <div class="form-actions"><button class="btn primary" type="submit">Make it a task</button><button class="btn tinted" type="button" data-action="sheet-mode" data-mode="">Back</button></div>
    </form>`;
  } else if (state.sheetMode === 'habit') {
    const dayBoxes = DAY_NAMES.map((d, i) => `<label><input type="checkbox" name="days" value="${i + 1}" checked><span>${d.slice(0, 2)}</span></label>`).join('');
    extra = `<form class="sheet-form habit-form" data-form="node-habit" data-id="${n.id}">
      <h3>Make it a habit</h3>
      <label class="field"><span>After I...</span><input class="input" name="cue" maxlength="120" placeholder="pour my morning coffee"></label>
      <div class="seg" role="radiogroup" aria-label="How often">
        <label><input type="radio" name="freq" value="fixed" checked><span>Fixed days</span></label>
        <label><input type="radio" name="freq" value="weekly"><span>Times a week</span></label>
      </div>
      <div class="field fixed-only"><span>Days</span><div class="days">${dayBoxes}</div></div>
      <label class="field weekly-only"><span>Times a week</span><input class="input" type="number" name="weekly_target" min="1" max="7" value="3" inputmode="numeric"></label>
      <label class="field"><span>Due by</span><input class="input" type="time" name="deadline" value="21:00"></label>
      <label class="check"><input type="checkbox" name="non_negotiable"> Non-negotiable</label>
      <div class="form-actions"><button class="btn primary" type="submit">Make it a habit</button><button class="btn tinted" type="button" data-action="sheet-mode" data-mode="">Back</button></div>
    </form>`;
  }
  const converted = n.kind !== 'idea';
  return `<div class="sheet-backdrop" data-action="sheet-close"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Branch">
    <div class="sheet-grab" aria-hidden="true"></div>
    <form data-form="node-edit" data-id="${n.id}">
      <label class="field"><span>Branch</span><input class="input" name="text" maxlength="200" required value="${esc(n.text)}"></label>
      <div class="form-actions"><button class="btn primary" type="submit">Save</button><button class="btn tinted" type="button" data-action="sheet-close">Close</button></div>
    </form>
    ${extra || `<div class="sheet-actions">
      <button class="btn tinted" data-action="node-parent" data-id="${n.id}">Add a branch under it</button>
      ${converted ? `<p class="note">This branch is a ${n.kind}${n.kind === 'habit' && n.ref ? ` at ${n.ref.strength}% strength` : ''}.</p>`
        : `<button class="btn tinted" data-action="sheet-mode" data-mode="task">Make it a task</button>
           <button class="btn tinted" data-action="sheet-mode" data-mode="habit">Make it a habit</button>`}
      <div class="sheet-move" role="group" aria-label="Move">
        <button class="btn tinted small" data-action="node-move" data-op="up" data-id="${n.id}">Up</button>
        <button class="btn tinted small" data-action="node-move" data-op="down" data-id="${n.id}">Down</button>
        <button class="btn tinted small" data-action="node-move" data-op="outdent" data-id="${n.id}">Out a level</button>
        <button class="btn tinted small" data-action="node-move" data-op="indent" data-id="${n.id}">In a level</button>
      </div>
      <button class="btn tinted danger-text" data-action="node-delete" data-id="${n.id}">Delete branch</button>
    </div>`}
  </div>`;
}

export function viewGoal() {
  const d = state.goal;
  if (!d || d.goal.id !== Number(state.param)) return ctx.shell('<p class="muted">Loading</p>');
  const g = d.goal;
  if (state.editingGoal) {
    return ctx.shell(`${pageHead('Edit goal')}<div class="narrow"><div class="card">${goalForm(g)}</div></div>`);
  }
  const closed = g.status !== 'active';
  const head = `<header class="goal-head">
    <a class="back" href="#/goals">${icon('back')}Goals</a>
    <h1 class="goal-h">${esc(g.title)}</h1>
    <div class="goal-progress">
      <span class="goal-big">${g.pct === null ? '' : `${g.pct}<small>%</small>`}</span>
      <span class="goal-sub">${closed ? (g.status === 'done' ? 'Achieved' : 'Dropped') : esc(g.label)}${g.targetDate ? `<br>${dueText(g)}` : ''}</span>
    </div>
    ${bar(g.pct, 'big')}
    ${g.measure === 'number' && !closed ? `<form class="inline-form log-form" data-form="goal-log" data-id="${g.id}">
      <label class="sr" for="goal-log">New value</label>
      <input id="goal-log" class="input" name="value" inputmode="decimal" autocomplete="off" placeholder="New total, or +${g.unit ? `N ${esc(g.unit)}` : 'N'}" required>
      <button class="btn primary" type="submit">Update</button></form>
      <p class="note">Now at ${g.currentValue ?? g.startValue ?? 0}${g.unit ? ` ${esc(g.unit)}` : ''}, aiming for ${g.targetValue}${g.unit ? ` ${esc(g.unit)}` : ''}.</p>` : ''}
  </header>`;

  const woop = `<details class="card woop-card disclosure"${d.tree.length ? '' : ' open'}>
    <summary>${icon('shield')}Why, obstacle and plan</summary>
    <dl>
      <dt>Why it matters</dt><dd>${g.why ? esc(g.why) : '<span class="faint">Not written yet</span>'}</dd>
      <dt>What will get in the way</dt><dd>${g.obstacle ? esc(g.obstacle) : '<span class="faint">Not written yet</span>'}</dd>
      <dt>If-then plan</dt><dd>${g.plan ? esc(g.plan) : '<span class="faint">Not written yet</span>'}</dd>
    </dl>
    <div class="form-actions">
      <button class="btn tinted small" data-action="goal-edit">Edit</button>
      <a class="btn tinted small" href="#/coach?ask=${encodeURIComponent(`Help me sharpen my goal "${g.title}". Walk me through WOOP one step at a time, then suggest the next 3 steps.`)}">Sharpen with the coach</a>
      ${closed ? `<button class="btn tinted small" data-action="goal-status" data-status="active">Reopen</button>`
        : `<button class="btn tinted small" data-action="goal-status" data-status="done">Mark achieved</button>
           <button class="btn tinted small" data-action="goal-status" data-status="dropped">Drop</button>`}
    </div>
  </details>`;

  const linkedHabits = d.habits.map((h) => `<div class="li li-plain">
      <span class="li-body"><span class="li-title">${esc(h.title)}</span>${h.cue ? `<span class="li-sub">After ${esc(h.cue)}</span>` : ''}</span>
      <span class="li-side">${strengthChip(h.strength)}</span></div>`).join('');
  const linkedTasks = d.tasks.map((t) => `<div class="li li-plain${t.done ? ' done' : ''}">
      <span class="li-body"><span class="li-title">${esc(t.title)}</span></span>
      <span class="li-side small faint">${t.done ? 'done' : t.dueDate ? fmtDay(t.dueDate) : 'no date'}</span></div>`).join('');

  const seg = `<div class="seg map-seg only-narrow-flex" role="tablist" aria-label="View">
      <button role="tab" aria-selected="${state.mapView === 'outline'}" data-action="map-view" data-view="outline">Outline</button>
      <button role="tab" aria-selected="${state.mapView === 'map'}" data-action="map-view" data-view="map">Map</button>
    </div>`;

  ctx.shell(`${head}
    <div class="split goal-split">
      <div>
        <section class="section"><div class="gh"><h2>Map</h2>${seg}</div>
          <div class="map-panes view-${state.mapView}">
            <div class="pane-outline">${outline(g, d.tree)}</div>
            <div class="pane-map">${mapSvg(g, d.tree)}</div>
          </div>
        </section>
      </div>
      <aside>
        ${woop}
        ${linkedHabits ? `<section class="section"><div class="gh"><h2>Habits</h2></div><div class="group">${linkedHabits}</div></section>` : ''}
        ${linkedTasks ? `<section class="section"><div class="gh"><h2>Tasks</h2><span class="gh-count">${d.tasks.filter((t) => t.done).length} of ${d.tasks.length} done</span></div><div class="group">${linkedTasks}</div></section>` : ''}
      </aside>
    </div>
    ${sheet(d.tree)}`);
  fitMap();
}

// The map starts fitted to the screen width (never below 60%), then the zoom buttons take over.
function fitMap() {
  const svg = document.querySelector('svg.map');
  const box = svg?.closest('.map-scroll');
  if (!svg || !box || state.mapZoom !== null || !box.clientWidth) return;
  const w = Number(svg.dataset.w);
  const h = Number(svg.dataset.h);
  const z = Math.max(0.6, Math.min(1, box.clientWidth / w));
  state.mapFit = z;
  svg.setAttribute('width', Math.round(w * z));
  svg.setAttribute('height', Math.round(h * z));
}

// ---------- Events ----------

async function reloadGoal() {
  await loadGoal(state.param);
  ctx.render();
}

export async function goalsClick(a, el) {
  const id = Number(el.dataset.id);
  switch (a) {
    case 'map-view':
      state.mapView = el.dataset.view;
      ctx.render();
      if (state.mapView === 'map') fitMap();
      return true;
    case 'map-zoom':
      state.mapZoom = Math.max(0.5, Math.min(2, (state.mapZoom ?? state.mapFit ?? 1) + Number(el.dataset.z) * 0.2));
      ctx.render();
      return true;
    case 'node-open':
      state.sheetNode = id;
      state.sheetMode = null;
      ctx.render();
      return true;
    case 'sheet-close':
      state.sheetNode = null;
      state.sheetMode = null;
      ctx.render();
      return true;
    case 'sheet-mode':
      state.sheetMode = el.dataset.mode || null;
      ctx.render();
      return true;
    case 'node-parent':
      state.mapParent = id;
      state.sheetNode = null;
      state.mapView = 'outline';
      ctx.render();
      document.getElementById('node-add-text')?.focus();
      return true;
    case 'node-parent-clear':
      state.mapParent = null;
      ctx.render();
      return true;
    case 'node-toggle': {
      haptic();
      if (await act(() => api('POST', `/api/nodes/${id}/toggle`, {}))) await reloadGoal();
      return true;
    }
    case 'node-move':
      if (await act(() => api('POST', `/api/nodes/${id}/move`, { op: el.dataset.op }))) await reloadGoal();
      return true;
    case 'node-delete':
      if (!confirm('Delete this branch? Branches under it move up a level. A task or habit made from it stays.')) return true;
      if (await act(() => api('DELETE', `/api/nodes/${id}`), 'Branch deleted.')) {
        state.sheetNode = null;
        if (state.mapParent === id) state.mapParent = null;
        await reloadGoal();
      }
      return true;
    case 'goal-edit':
      state.editingGoal = true;
      ctx.render();
      return true;
    case 'goal-edit-cancel':
      state.editingGoal = false;
      ctx.render();
      return true;
    case 'goal-status': {
      const s = el.dataset.status;
      if (s === 'dropped' && !confirm('Drop this goal? Its tasks and habits stay.')) return true;
      if (await act(() => api('POST', `/api/goals/${state.param}/status`, { status: s }), s === 'done' ? 'Achieved. Set the next one.' : s === 'dropped' ? 'Dropped.' : 'Reopened.')) await reloadGoal();
      return true;
    }
    default:
      return false;
  }
}

function goalPayload(form) {
  const f = form2obj(form);
  return {
    title: f.title, measure: f.measure, unit: f.unit, start_value: f.start_value, target_value: f.target_value,
    target_date: f.target_date || null, why: f.why, obstacle: f.obstacle, plan: f.plan,
  };
}

export async function goalsSubmit(kind, form) {
  switch (kind) {
    case 'new-goal': {
      const r = await act(() => api('POST', '/api/goals', goalPayload(form)), 'Goal set. Now break it into its big pieces.');
      if (r) {
        state.mapParent = null;
        state.mapView = 'outline';
        location.hash = `#/goals/${r.id}`;
      }
      return true;
    }
    case 'edit-goal':
      if (await act(() => api('PATCH', `/api/goals/${form.dataset.id}`, goalPayload(form)), 'Saved.')) {
        state.editingGoal = false;
        await reloadGoal();
      }
      return true;
    case 'goal-log': {
      const r = await act(() => api('POST', `/api/goals/${form.dataset.id}/log`, { value: form2obj(form).value }));
      if (r) {
        haptic();
        toast(`Updated to ${r.value}.`);
        await reloadGoal();
      }
      return true;
    }
    case 'node-add': {
      const text = form2obj(form).text.trim();
      if (!text) return true;
      if (await act(() => api('POST', `/api/goals/${state.param}/nodes`, { text, parentId: state.mapParent }))) {
        await reloadGoal();
        document.getElementById('node-add-text')?.focus();
      }
      return true;
    }
    case 'node-edit':
      if (await act(() => api('PATCH', `/api/nodes/${form.dataset.id}`, { text: form2obj(form).text }), 'Saved.')) {
        state.sheetNode = null;
        await reloadGoal();
      }
      return true;
    case 'node-task': {
      const f = form2obj(form);
      const options = { due_date: f.due_date || null, deadline: f.deadline || null, estimate_min: f.estimate_min || null };
      if (await act(() => api('POST', `/api/nodes/${form.dataset.id}/convert`, { to: 'task', options }), 'Now a task. It shows on Today when it is due.')) {
        state.sheetNode = null;
        state.sheetMode = null;
        await reloadGoal();
      }
      return true;
    }
    case 'node-habit': {
      const f = new FormData(form);
      const weekly = f.get('freq') === 'weekly';
      const options = {
        cue: f.get('cue') || '',
        deadline: f.get('deadline') || (weekly ? '23:59' : '21:00'),
        days: weekly ? undefined : f.getAll('days').map(Number),
        weekly_target: weekly ? Number(f.get('weekly_target')) : null,
        non_negotiable: f.get('non_negotiable') === 'on',
      };
      const r = await act(() => api('POST', `/api/nodes/${form.dataset.id}/convert`, { to: 'habit', options }));
      if (r) {
        toast(r.startsToday ? 'Now a habit. It counts from today.' : 'Now a habit. It starts tomorrow.');
        state.sheetNode = null;
        state.sheetMode = null;
        state.plan = null;
        await reloadGoal();
      }
      return true;
    }
    default:
      return false;
  }
}
