// Builds public/fonts/oath-dot.woff: Oath Dot, a 5 by 7 dot-matrix face for the Tape theme's display type
// (titles, big figures), drawn here from the bitmaps below. Original to Oath. No packages: the TrueType
// tables are written by hand (head, hhea, maxp, OS/2, hmtx, cmap, loca, glyf, name, post).
//
// node scripts/build-dot-font.mjs
//
// Capitals, figures and common punctuation. Lower case maps to the capitals, so the face reads in capitals
// whatever the text; anything it lacks falls through to the next font in the stack.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const PITCH = 110; // one dot cell, in font units (1,000 to the em)
const R = 40; // dot radius
const ROWS = 7;

// '#' is a dot. Five columns, except the narrow marks (three).
const G = {
  A: '.###. #...# #...# ##### #...# #...# #...#',
  B: '####. #...# #...# ####. #...# #...# ####.',
  C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '###.. #..#. #...# #...# #...# #..#. ###..',
  E: '##### #.... #.... ####. #.... #.... #####',
  F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .####',
  H: '#...# #...# #...# ##### #...# #...# #...#',
  I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
  K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  N: '#...# #...# ##..# #.#.# #..## #...# #...#',
  O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....',
  Q: '.###. #...# #...# #...# #.#.# #..#. .##.#',
  R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.',
  T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..',
  W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.',
  X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  Z: '##### ....# ...#. ..#.. .#... #.... #####',
  0: '.###. #...# #..## #.#.# ##..# #...# .###.',
  1: '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  2: '.###. #...# ....# ...#. ..#.. .#... #####',
  3: '##### ...#. ..#.. ...#. ....# #...# .###.',
  4: '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  5: '##### #.... ####. ....# ....# #...# .###.',
  6: '..##. .#... #.... ####. #...# #...# .###.',
  7: '##### ....# ...#. ..#.. .#... .#... .#...',
  8: '.###. #...# #...# .###. #...# #...# .###.',
  9: '.###. #...# #...# .#### ....# ...#. .##..',
  '-': '..... ..... ..... .###. ..... ..... .....',
  '–': '..... ..... ..... ##### ..... ..... .....',
  '—': '..... ..... ..... ##### ..... ..... .....',
  '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  '=': '..... ..... ##### ..... ##### ..... .....',
  '%': '##... ##..# ...#. ..#.. .#... #..## ...##',
  '/': '..... ....# ...#. ..#.. .#... #.... .....',
  '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.',
  ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...',
  '[': '.###. .#... .#... .#... .#... .#... .###.',
  ']': '.###. ...#. ...#. ...#. ...#. ...#. .###.',
  '<': '...#. ..#.. .#... #.... .#... ..#.. ...#.',
  '>': '.#... ..#.. ...#. ....# ...#. ..#.. .#...',
  '?': '.###. #...# ....# ...#. ..#.. ..... ..#..',
  '_': '..... ..... ..... ..... ..... ..... #####',
  '&': '.##.. #..#. #.#.. .#... #.#.# #..#. .##.#',
  '#': '.#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.',
  '*': '..... ..#.. #.#.# .###. #.#.# ..#.. .....',
  '@': '.###. #...# #.### #.#.# #.### #.... .###.',
  '$': '..#.. .#### #.#.. .###. ..#.# ####. ..#..',
  '£': '..##. .#..# .#... ###.. .#... .#... #####',
  '€': '..### .#... ####. .#... ####. .#... ..###',
  '°': '.##.. #..#. #..#. .##.. ..... ..... .....',
  '×': '..... #...# .#.#. ..#.. .#.#. #...# .....',
  '…': '..... ..... ..... ..... ..... ..... #.#.#',
  '"': '.#.#. .#.#. ..... ..... ..... ..... .....',
  '|': '..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  '·': '... ... ... .#. ... ... ...',
  '.': '... ... ... ... ... ... .#.',
  ',': '... ... ... ... ... .#. #..',
  ':': '... ... .#. ... ... .#. ...',
  ';': '... ... .#. ... ... .#. #..',
  '!': '.#. .#. .#. .#. .#. ... .#.',
  "'": '.#. .#. ... ... ... ... ...',
  '’': '.#. .#. #.. ... ... ... ...',
  '‘': '..# .#. .#. ... ... ... ...',
};

// A dot as a closed TrueType contour: six on-curve points round it, six off-curve between, clockwise.
function dot(cx, cy) {
  const pts = [];
  const k = R / Math.cos(Math.PI / 6);
  for (let i = 0; i < 6; i += 1) {
    const a = -(i * Math.PI) / 3;
    const b = a - Math.PI / 6;
    pts.push([Math.round(cx + R * Math.cos(a)), Math.round(cy + R * Math.sin(a)), 1]);
    pts.push([Math.round(cx + k * Math.cos(b)), Math.round(cy + k * Math.sin(b)), 0]);
  }
  return pts;
}

// A full glyph has a dot's width of air on each side; a narrow mark half that.
function glyph(rows) {
  const cols = rows[0].length;
  const wide = cols === 5;
  const contours = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch === '#') contours.push(dot((c + (wide ? 1 : 0.5)) * PITCH, (ROWS - 1 - r) * PITCH + PITCH / 2));
  }));
  return { contours, advance: (wide ? cols + 1 : cols) * PITCH };
}

// Glyph order: .notdef, space, then the table above.
const glyphs = [{ contours: [], advance: 6 * PITCH, chars: [] }, { contours: [], advance: 4 * PITCH, chars: [0x20, 0xa0] }];
for (const [ch, art] of Object.entries(G)) {
  const g = glyph(art.split(' '));
  g.chars = [ch.codePointAt(0)];
  if (/^[A-Z]$/.test(ch)) g.chars.push(ch.toLowerCase().codePointAt(0));
  glyphs.push(g);
}

// ---------- Binary helpers ----------

class Buf {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) { return this.u16(Math.floor(v / 0x10000)).u16(v & 0xffff); }
  tag(s) { [...s].forEach((c) => this.u8(c.charCodeAt(0))); return this; }
  bytes(a) { a.forEach((v) => this.u8(v)); return this; }
  pad() { while (this.b.length % 4) this.u8(0); return this; }
  get length() { return this.b.length; }
}

const checksum = (bytes) => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + ((bytes[i] << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0))) >>> 0;
  return sum;
};

// ---------- glyf and loca ----------

const glyf = new Buf();
const loca = [];
let maxPoints = 0;
let maxContours = 0;
const box = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
for (const g of glyphs) {
  loca.push(glyf.length);
  if (!g.contours.length) { g.xMin = 0; continue; }
  const all = g.contours.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  g.xMin = Math.min(...xs);
  g.xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  box.xMax = Math.max(box.xMax, g.xMax);
  box.yMax = Math.max(box.yMax, yMax);
  box.yMin = Math.min(box.yMin, yMin);
  maxPoints = Math.max(maxPoints, all.length);
  maxContours = Math.max(maxContours, g.contours.length);
  glyf.i16(g.contours.length).i16(g.xMin).i16(yMin).i16(g.xMax).i16(yMax);
  let end = -1;
  for (const c of g.contours) { end += c.length; glyf.u16(end); }
  glyf.u16(0); // no instructions
  // Each coordinate is a delta from the last: none when unchanged, one byte when under 256, else two.
  const dx = all.map((p, i) => p[0] - (i ? all[i - 1][0] : 0));
  const dy = all.map((p, i) => p[1] - (i ? all[i - 1][1] : 0));
  const flag = (d, short, same) => (d === 0 ? same : Math.abs(d) < 256 ? short | (d > 0 ? same : 0) : 0);
  all.forEach((p, i) => glyf.u8(p[2] | flag(dx[i], 0x02, 0x10) | flag(dy[i], 0x04, 0x20)));
  const coord = (d) => { if (d !== 0) { if (Math.abs(d) < 256) glyf.u8(Math.abs(d)); else glyf.i16(d); } };
  dx.forEach(coord);
  dy.forEach(coord);
  glyf.pad();
}
loca.push(glyf.length);
const locaT = new Buf();
loca.forEach((o) => locaT.u32(o));

// ---------- The rest of the tables ----------

const ASC = 900;
const DESC = -250;
const n = glyphs.length;
const advMax = Math.max(...glyphs.map((g) => g.advance));

const head = new Buf().u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0x0009).u16(1000)
  .u32(0).u32(0xe0000000).u32(0).u32(0xe0000000) // created and modified: 2023, fixed so builds match
  .i16(box.xMin).i16(box.yMin).i16(box.xMax).i16(box.yMax).u16(0).u16(8).i16(2).i16(1).i16(0);

const hhea = new Buf().u32(0x00010000).i16(ASC).i16(DESC).i16(0).u16(advMax)
  .i16(Math.min(...glyphs.filter((g) => g.contours.length).map((g) => g.xMin))).i16(Math.min(...glyphs.filter((g) => g.contours.length).map((g) => g.advance - g.xMax))).i16(box.xMax)
  .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(n);

const maxp = new Buf().u32(0x00010000).u16(n).u16(maxPoints).u16(maxContours).u16(0).u16(0).u16(2)
  .u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

const hmtx = new Buf();
glyphs.forEach((g) => hmtx.u16(g.advance).i16(g.xMin));

const map = [];
glyphs.forEach((g, id) => g.chars.forEach((c) => map.push([c, id])));
map.sort((a, b) => a[0] - b[0]);
const codes = map.map(([c]) => c);
const segs = [...map.map(([c, id]) => ({ start: c, end: c, delta: (id - c + 0x10000) % 0x10000 })), { start: 0xffff, end: 0xffff, delta: 1 }];
const sc = segs.length;
const pow = 2 ** Math.floor(Math.log2(sc));
const sub = new Buf().u16(4).u16(16 + 8 * sc).u16(0).u16(sc * 2).u16(pow * 2).u16(Math.log2(pow)).u16(sc * 2 - pow * 2);
segs.forEach((s) => sub.u16(s.end));
sub.u16(0);
segs.forEach((s) => sub.u16(s.start));
segs.forEach((s) => sub.u16(s.delta));
segs.forEach(() => sub.u16(0));
const cmap = new Buf().u16(0).u16(1).u16(3).u16(1).u32(12).bytes(sub.b);

const avg = Math.round(glyphs.reduce((t, g) => t + g.advance, 0) / n);
const os2 = new Buf().u16(4).i16(avg).u16(400).u16(5).u16(0)
  .i16(650).i16(700).i16(0).i16(140).i16(650).i16(700).i16(0).i16(480).i16(50).i16(330).i16(0)
  .bytes([2, 11, 6, 9, 0, 0, 0, 0, 0, 0]) // panose: monospaced-looking sans
  .u32(1).u32(0).u32(0).u32(0).tag('OATH').u16(0x00c0)
  .u16(Math.min(...codes)).u16(Math.min(0xffff, Math.max(...codes)))
  .i16(ASC).i16(DESC).i16(0).u16(ASC).u16(-DESC).u32(1).u32(0)
  .i16(5 * PITCH).i16(7 * PITCH).u16(0).u16(0x20).u16(1);

const names = [[1, 'Oath Dot'], [2, 'Regular'], [3, 'Oath Dot Regular 1.000'], [4, 'Oath Dot'], [5, 'Version 1.000'], [6, 'OathDot-Regular']];
const strs = new Buf();
const recs = names.map(([id, s]) => {
  const off = strs.length;
  [...s].forEach((c) => strs.u16(c.charCodeAt(0)));
  return { id, off, len: strs.length - off };
});
const name = new Buf().u16(0).u16(recs.length).u16(6 + 12 * recs.length);
recs.forEach((r) => name.u16(3).u16(1).u16(0x409).u16(r.id).u16(r.len).u16(r.off));
name.bytes(strs.b);

const post = new Buf().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

// ---------- The file ----------

const tables = { 'OS/2': os2, cmap, glyf, head, hhea, hmtx, loca: locaT, maxp, name, post };
const tags = Object.keys(tables).sort();
const nt = tags.length;
const tp = 2 ** Math.floor(Math.log2(nt));
const out = new Buf().u32(0x00010000).u16(nt).u16(tp * 16).u16(Math.log2(tp)).u16(nt * 16 - tp * 16);
let offset = 12 + 16 * nt;
const body = new Buf();
for (const t of tags) {
  const bytes = tables[t].b;
  out.tag(t).u32(checksum(bytes)).u32(offset).u32(bytes.length);
  body.bytes(bytes).pad();
  offset = 12 + 16 * nt + body.length;
}
const file = [...out.b, ...body.b];
// head.checkSumAdjustment, so the whole file sums to 0xB1B0AFBA.
const headAt = 12 + 16 * nt + tags.slice(0, tags.indexOf('head')).reduce((t, k) => t + Math.ceil(tables[k].b.length / 4) * 4, 0);
const adj = (0xb1b0afba - checksum(file) + 0x100000000) % 0x100000000;
file[headAt + 8] = adj >>> 24; file[headAt + 9] = (adj >>> 16) & 0xff; file[headAt + 10] = (adj >>> 8) & 0xff; file[headAt + 11] = adj & 0xff;

// Wrapped as WOFF: the same tables, each deflated.
const woffDir = new Buf();
const woffBody = new Buf();
const dirLen = 44 + 20 * nt;
for (const t of tags) {
  const raw = Buffer.from(tables[t].b);
  const z = deflateSync(raw, { level: 9 });
  const data = z.length < raw.length ? z : raw;
  const sum = t === 'head' ? checksum([...file.slice(headAt, headAt + raw.length)]) : checksum(tables[t].b);
  woffDir.tag(t).u32(dirLen + woffBody.length).u32(data.length).u32(raw.length).u32(sum);
  woffBody.bytes([...data]).pad();
}
const woff = new Buf().tag('wOFF').u32(0x00010000).u32(dirLen + woffBody.length).u16(nt).u16(0).u32(file.length)
  .u16(1).u16(0).u32(0).u32(0).u32(0).u32(0).u32(0);
const bytes = Buffer.from([...woff.b, ...woffDir.b, ...woffBody.b]);
writeFileSync(new URL('../public/fonts/oath-dot.woff', import.meta.url), bytes);
console.log(`public/fonts/oath-dot.woff: ${n} glyphs, ${codes.length} characters, ${bytes.length} bytes (${file.length} as TrueType)`);
