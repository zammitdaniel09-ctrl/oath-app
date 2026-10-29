// Themes: the whole app in another hand. A theme is one stylesheet, /themes/<id>.css, with every rule
// under :root[data-theme="<id>"]; only the chosen one is loaded. Its icons, its manifest and the status
// bar colour follow it. index.html applies the saved theme before the first paint (from this phone's
// memory); this module switches, saves to the server, and follows a choice made on another device.
import { state, api, esc, reduced, toast, haptic } from './ui.js';

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
    id: 'atelier', name: 'Atelier', line: 'Ink on paper', note: 'Warm paper, black ink and an oxblood rule, set like a private press journal.',
    color: '#f3eee4', light: true,
    p: { bg: '#f3eee4', card: '#fbf8f2', text: '#1b1712', sub: '#7a7064', a: '#7b1e1e', b: '#1b1712', c: '#b08a3e', font: "'Iowan Old Style', 'Palatino', ui-serif, Georgia, serif", r: '2px' },
  },
  {
    id: 'tape', name: 'Tape', line: 'Reading the tape', note: 'A trading terminal: amber phosphor on black, square corners, every number in mono.',
    color: '#050505', light: false,
    p: { bg: '#050505', card: '#0d0b07', text: '#ffb000', sub: '#8a6a2a', a: '#ffb000', b: '#26d07c', c: '#ff4d4d', font: "'Geist Mono', ui-monospace, monospace", r: '0px' },
  },
  {
    id: 'sovereign', name: 'Sovereign', line: 'Black lacquer, gold leaf', note: 'Lacquered black and hand-laid gold, Didone capitals and deco rules.',
    color: '#0a0806', light: false,
    p: { bg: '#0a0806', card: '#15110b', text: '#efe4cc', sub: '#9c8a66', a: '#d4af37', b: '#f1d98a', c: '#8c6a2b', font: "'Didot', 'Bodoni 72', 'Bodoni MT', ui-serif, serif", r: '4px' },
  },
];
const BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));
const KEY = 'oath.theme';

export const themeOf = (id) => BY_ID[id] || BY_ID.oath;
export const currentTheme = () => themeOf(document.documentElement.dataset.theme);

// Where a theme's files live. The original keeps the app's own icons and manifest.
const files = (t) => (t.id === 'oath'
  ? { css: '', manifest: '/manifest.webmanifest', icon: '/icons/favicon.png?v=2', touch: '/icons/apple-touch-icon.png?v=2' }
  : { css: `/themes/${t.id}.css`, manifest: `/themes/${t.id}.webmanifest`, icon: `/icons/themes/${t.id}/favicon.png`, touch: `/icons/themes/${t.id}/apple-touch-icon.png` });

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
  const f = files(t);
  const old = document.getElementById('theme-css');
  if (link && link !== old) { old?.remove(); link.id = 'theme-css'; }
  if (!f.css) old?.remove();
  document.documentElement.dataset.theme = t.id;
  setAttr('meta[name="theme-color"]', 'content', t.color);
  setAttr('meta[name="apple-mobile-web-app-status-bar-style"]', 'content', t.light ? 'default' : 'black');
  setAttr('link[rel="icon"]', 'href', f.icon);
  setAttr('link[rel="apple-touch-icon"]', 'href', f.touch);
  setAttr('link[rel="manifest"]', 'href', f.manifest);
}

// Puts a theme on: loads its stylesheet, then changes everything at once, cross-fading where the
// browser can. save sends it to the server so every device follows.
export async function applyTheme(id, { save = true } = {}) {
  const t = themeOf(id);
  const link = await loadCss(files(t).css);
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
    <p class="muted small theme-foot">Every page, the icon and the status bar change with it, on every device. On iPhone and iPad the Home Screen icon is fixed when Oath is added: to see the new one there, remove Oath from the Home Screen and add it again from Safari.</p>
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
