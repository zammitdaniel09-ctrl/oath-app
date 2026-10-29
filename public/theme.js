// Themes: the whole app in another hand. A theme is one stylesheet, /themes/<id>.css, with every rule
// under :root[data-theme="<id>"]; only the chosen one is loaded. The status bar colour follows it; the app
// icon (app-icon.js) is the same in every theme. index.html applies the saved theme before the first paint (from this phone's
// memory); this module switches, saves to the server, and follows a choice made on another device.
import { state, api, esc, reduced, toast, haptic } from './ui.js';
import { appIcon } from './app-icon.js';

// p: the colours, type and corner of the small preview in Settings, drawn without loading the theme.
export const THEMES = [
  {
    id: 'oath', name: 'Oath', line: 'The original', note: 'Black, graphite and chrome, Merlot when it counts.',
    color: '#000000', light: false,
    p: { bg: '#000', card: '#111114', text: '#f2f2f4', sub: '#8a8a94', a: '#e10600', b: '#d9dde4', c: '#2f8af2', font: "'Satoshi', system-ui, sans-serif", r: '14px' },
  },
  {
    id: 'liquid', name: 'Liquid', line: 'Smoke and chrome', note: 'Pure black, slow liquid smoke, frosted glass and polished silver numbers.',
    color: '#000000', light: false,
    p: { bg: '#000', card: 'rgba(255,255,255,0.07)', text: '#f5f5f7', sub: '#8e8e99', a: '#f5f5f7', b: '#9d9da8', c: '#28c840', font: "'Satoshi', system-ui, sans-serif", r: '20px', fx: 'liquid' },
  },
  {
    id: 'atelier', name: 'Atelier', line: 'A journal in colour', note: 'Dark glass under a lime glow, big figures in vivid gradients, pills and a lime key action.',
    color: '#030303', light: false,
    p: { bg: '#030303', card: '#181818', text: '#f6f6f4', sub: '#8e8e8a', a: '#ffc53d', b: '#c6f03a', c: '#2fd4ae', font: "'Satoshi', system-ui, sans-serif", r: '16px', fx: 'atelier' },
  },
  {
    id: 'tape', name: 'Tape', line: 'Dot-matrix dashboard', note: 'Charcoal tiles on a warm peach ground, figures in dots and one orange-red signal.',
    color: '#f2bc95', light: true,
    p: { bg: '#eeb08a', card: '#1e1d1c', text: '#fffaf5', sub: '#5a4337', a: '#ff3b1f', b: '#ffffff', c: '#a39c94', font: "'Oath Dot', 'Geist Mono', ui-monospace, monospace", r: '12px', fx: 'tape' },
  },
  {
    id: 'sovereign', name: 'Blueprint', line: 'Cobalt on white', note: 'White drafting paper, cobalt line work on a grid, serif capitals and technical panels.',
    color: '#f7f8fc', light: true,
    p: { bg: '#f7f8fc', card: '#ffffff', text: '#2341c4', sub: '#5a69b6', a: '#2341c4', b: '#5b7cff', c: '#3a9ae0', font: "'New York', 'Iowan Old Style', ui-serif, Georgia, serif", r: '2px', fx: 'blueprint' },
  },
];
const BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));
const KEY = 'oath.theme';

export const themeOf = (id) => BY_ID[id] || BY_ID.oath;
export const currentTheme = () => themeOf(document.documentElement.dataset.theme);

// A theme's stylesheet. The original has none.
const cssOf = (t) => (t.id === 'oath' ? '' : `/themes/${t.id}.css`);

const setAttr = (sel, attr, value) => document.querySelector(sel)?.setAttribute(attr, value);

function remember(t) {
  try { localStorage.setItem(KEY, JSON.stringify({ id: t.id, color: t.color, light: t.light })); } catch { /* storage unavailable */ }
}

// The stylesheet arrives before the switch, so the change is one frame, never a half-styled page.
function loadCss(href) {
  return new Promise((resolve) => {
    if (!href) { resolve(null); return; }
    const old = document.getElementById('theme-css');
    if (old?.getAttribute('href') === href) { resolve(old); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve(link);
    link.onerror = () => resolve(null);
    document.head.append(link);
  });
}

function swap(t, link) {
  const old = document.getElementById('theme-css');
  if (link && link !== old) { old?.remove(); link.id = 'theme-css'; }
  if (!cssOf(t)) old?.remove();
  document.documentElement.dataset.theme = t.id;
  setAttr('meta[name="theme-color"]', 'content', t.color);
  setAttr('meta[name="apple-mobile-web-app-status-bar-style"]', 'content', t.light ? 'default' : 'black');
}

// Puts a theme on: loads its stylesheet, then changes everything at once, cross-fading where the
// browser can. save sends it to the server so every device follows.
export async function applyTheme(id, { save = true } = {}) {
  const t = themeOf(id);
  const link = await loadCss(cssOf(t));
  const go = () => swap(t, link);
  if (document.startViewTransition && !reduced() && document.documentElement.dataset.theme !== t.id) {
    await document.startViewTransition(go).finished.catch(() => {});
  } else go();
  remember(t);
  if (save) {
    try {
      state.settings = await api('PATCH', '/api/settings', { theme: t.id });
    } catch (err) { toast(err.message, true); }
  }
}

// A theme chosen on another device arrives with the day's data; this one follows quietly.
export function followTheme(id) {
  if (id && id !== currentTheme().id && BY_ID[id]) applyTheme(id, { save: false });
}

// The small phone each theme card shows: its own colours, type and corners, nothing loaded.
function shot(t) {
  const p = t.p;
  const style = Object.entries({ bg: p.bg, card: p.card, text: p.text, sub: p.sub, a: p.a, b: p.b, c: p.c, r: p.r })
    .map(([k, v]) => `--p-${k}:${v}`).join(';');
  return `<span class="theme-shot${p.fx ? ` fx-${p.fx}` : ''}" style="${esc(style)};font-family:${esc(p.font)}" aria-hidden="true">
    <span class="ts-over">Thursday</span><span class="ts-title">Today</span>
    <span class="ts-ring"><i></i><i></i><i></i></span>
    <span class="ts-row"><b></b><i></i></span><span class="ts-row"><b></b><i></i></span>
    <span class="ts-tab"><i></i><i></i><i></i><i></i></span>
  </span>`;
}

export function themesSection() {
  const on = currentTheme().id;
  const cards = THEMES.map((t) => `<button type="button" class="theme-card${t.id === on ? ' on' : ''}" data-action="theme" data-theme="${t.id}" aria-pressed="${t.id === on}">
      ${shot(t)}
      <span class="theme-meta"><span class="theme-name" style="font-family:${esc(t.p.font)}">${esc(t.name)}</span><span class="theme-line">${esc(t.line)}</span></span>
      <span class="theme-note">${esc(t.note)}</span>
    </button>`).join('');
  return `<section class="section themes" id="themes"><div class="gh"><h2>Themes</h2><span class="gh-count">${THEMES.length} looks</span></div>
    <div class="theme-rail" role="group" aria-label="Themes">${cards}</div>
    <p class="muted small theme-foot">Every page and the status bar change with it, on every device.</p>
    <div class="appicon-row">${appIcon(64)}<p class="muted small">The app icon, the same in every theme. Here it drains and fills like a charge; on the Home Screen it rests full, as iOS keeps an icon still once Oath is added.</p></div>
  </section>`;
}

export async function themeClick(a, el) {
  if (a !== 'theme') return false;
  const id = el.dataset.theme;
  if (id === currentTheme().id) return true;
  haptic('tick');
  await applyTheme(id);
  return true;
}
