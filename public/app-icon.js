// The app icon, the same in every theme: a dark tile, the word, a 0 to 100 scale and a glass gauge of
// liquid. Inside the app it moves the way the reference video does: full and green, it drains through yellow
// and orange to a red sliver, sloshes there, and fills back to green. The Home Screen icons are this
// drawing at rest (rendered to PNG by ../tools/themekit/render-app-icon.cjs): iOS fixes an icon when
// Oath is added, so it cannot move there. Only transform and opacity animate (app-icon.css).

let count = 0;

const W = 800; // the gauge, in a 1024 box
const X0 = 112;

// still: the drawing at rest, no motion (the PNGs; reduced motion is handled in the stylesheet).
// bleed: a full square for the Home Screen, which rounds the corners itself; pad widens it (maskable).
export function appIconSvg(size = 96, { still = false, bleed = false, level = 1, pad = 0 } = {}) {
  count += 1;
  const g = `ai${count}`;
  const rx = bleed ? 0 : 230;
  const front = X0 + W * level;
  const o = -1024 * pad;
  const box = 1024 * (1 + 2 * pad);
  const liq = still ? '' : 'ai-liq';
  // The liquid in its four colours, red at the bottom; the ones above fade as it falls past them.
  const layers = (k) => `<use href="#${g}s" fill="url(#${g}r)"/><use class="ai-o${k}" href="#${g}s" fill="url(#${g}o)"/><use class="ai-y${k}" href="#${g}s" fill="url(#${g}y)"/><use class="ai-g${k}" href="#${g}s" fill="url(#${g}g)"/>`;
  const stops = (list) => list.map(([at, c]) => `<stop offset="${at}" stop-color="${c}"/>`).join('');
  const liquid = (id, list) => `<linearGradient id="${g}${id}" gradientUnits="userSpaceOnUse" x1="-${W}" y1="0" x2="0" y2="0">${stops(list)}</linearGradient>`;
  return `<svg class="ai-svg" width="${size}" height="${size}" viewBox="${o} ${o} ${box} ${box}" aria-hidden="true" font-family="Satoshi, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif">
    <defs>
      <linearGradient id="${g}f" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#3c3836'], [0.55, '#272423'], [1, '#1c1918']])}</linearGradient>
      <linearGradient id="${g}k" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#2c2827'], [1, '#383332']])}</linearGradient>
      ${liquid('g', [[0, '#0b5a05'], [0.55, '#22b80e'], [0.92, '#3fe41c'], [1, '#b0ff60']])}
      ${liquid('y', [[0, '#8a6400'], [0.5, '#e0b000'], [0.93, '#f6cc10'], [1, '#fff07a']])}
      ${liquid('o', [[0, '#b52a06'], [0.5, '#ff4a00'], [0.93, '#ff7400'], [1, '#ffc04a']])}
      ${liquid('r', [[0, '#8f0806'], [0.5, '#e01208'], [0.95, '#ff2414'], [1, '#ff8a3a']])}
      <linearGradient id="${g}h" gradientUnits="userSpaceOnUse" x1="0" y1="560" x2="0" y2="800">${stops([[0, 'rgba(255,255,255,0.5)'], [0.16, 'rgba(255,255,255,0.1)'], [0.55, 'rgba(255,255,255,0)'], [1, 'rgba(0,0,0,0.28)']])}</linearGradient>
      <linearGradient id="${g}l" x1="0" y1="0" x2="0" y2="1">${stops([[0, 'rgba(255,255,255,0.2)'], [0.3, 'rgba(255,255,255,0.03)'], [1, 'rgba(255,255,255,0)']])}</linearGradient>
      <pattern id="${g}d" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="2.4" fill="#000" fill-opacity="0.26"/></pattern>
      <clipPath id="${g}p"><rect x="${X0}" y="560" width="${W}" height="240" rx="120"/></clipPath>
      <filter id="${g}b" filterUnits="userSpaceOnUse" x="0" y="420" width="1024" height="520"><feGaussianBlur stdDeviation="26"/></filter>
      <path id="${g}s" d="M-1000 560H0C46 616-34 744 12 800H-1000Z"/>
    </defs>
    ${bleed ? '' : `<rect width="1024" height="1024" rx="${rx}" fill="#141211"/>`}
    <rect x="${bleed ? o : 22}" y="${bleed ? o : 22}" width="${bleed ? box : 980}" height="${bleed ? box : 980}" rx="${bleed ? 0 : rx - 18}" fill="url(#${g}f)"/>
    <text x="512" y="350" text-anchor="middle" font-size="152" font-weight="800" letter-spacing="-3" fill="#fff">Oath.</text>
    <g font-size="58" font-weight="500" fill="#6c6664" text-anchor="middle"><text x="196" y="502">0</text><text x="512" y="502">50</text><text x="828" y="502">100</text></g>
    <g filter="url(#${g}b)" opacity="0.6"><g clip-path="url(#${g}p)"><g class="${liq}" transform="translate(${front} 0)">${layers('h')}</g></g></g>
    <rect x="${X0}" y="560" width="${W}" height="240" rx="120" fill="url(#${g}k)"/>
    <g clip-path="url(#${g}p)">
      <g class="${liq}" transform="translate(${front} 0)">
        <g class="${still ? '' : 'ai-slosh'}">
          ${layers('')}
          <use href="#${g}s" fill="url(#${g}h)"/>
          <path d="M0 560C46 616-34 744 12 800" fill="none" stroke="#fff4c2" stroke-opacity="0.55" stroke-width="9"/>
        </g>
      </g>
      <rect x="${X0}" y="560" width="${W}" height="240" fill="url(#${g}d)"/>
      <rect x="${X0}" y="560" width="${W}" height="240" fill="url(#${g}l)"/>
    </g>
    <rect x="${X0 + 2}" y="562" width="${W - 4}" height="236" rx="118" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="4"/>
  </svg>`;
}

// The icon as the app shows it: the tile with the gauge's glow spilling under it, moving unless still.
export function appIcon(size = 96, cls = '', opts = {}) {
  const still = Boolean(opts.still);
  const glows = still ? '<i class="ai-glow ai-gg"></i>' : '<i class="ai-glow ai-gr"></i><i class="ai-glow ai-go"></i><i class="ai-glow ai-gy"></i><i class="ai-glow ai-gg"></i>';
  return `<span class="appicon${still ? ' still' : ''}${cls ? ` ${cls}` : ''}" style="--ai:${size}px" aria-hidden="true">${glows}${appIconSvg(size, opts)}</span>`;
}
