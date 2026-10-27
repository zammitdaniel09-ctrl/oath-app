// The coach writes a little Markdown: **bold**, *italics*, `code`, "- " and "1. " lists, blank lines
// between paragraphs. One reader turns it into safe HTML for the app, Telegram's small HTML set, or
// plain text for notifications. Text is escaped before any tag is added, so nothing else gets through.
// Shared by the phone and the server.

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escTg = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Bold before italics, so "**x**" is never read as two italic markers. Markers must hug their words
// ("2 * 3 * 4" and snake_case stay as they are).
const BOLD = [/\*\*([^*\s](?:[^*]*?[^*\s])?)\*\*/g, /__([^_\s](?:[^_]*?[^_\s])?)__/g];
const ITALIC = [/(^|[^\w*])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![\w*])/g, /(^|[^\w])_([^_\s](?:[^_]*?[^_\s])?)_(?!\w)/g];
const CODE = /`([^`\n]+)`/g;

function inline(s, esc, tags) {
  let out = esc(s);
  for (const re of BOLD) out = out.replace(re, `${tags.b[0]}$1${tags.b[1]}`);
  for (const re of ITALIC) out = out.replace(re, `$1${tags.i[0]}$2${tags.i[1]}`);
  return out.replace(CODE, `${tags.code[0]}$1${tags.code[1]}`);
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;

// Lines grouped into paragraphs, bulleted lists and numbered lists, in order.
function blocks(text) {
  const out = [];
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const lineText = raw.trimEnd();
    const kind = !lineText.trim() ? 'gap' : BULLET.test(lineText) ? 'ul' : NUMBER.test(lineText) ? 'ol' : HEADING.test(lineText) ? 'h' : 'p';
    const last = out[out.length - 1];
    if (kind === 'gap') { if (last) last.closed = true; continue; }
    const body = kind === 'ul' ? lineText.replace(BULLET, '') : kind === 'ol' ? lineText.replace(NUMBER, '') : kind === 'h' ? lineText.replace(HEADING, '') : lineText.trim();
    const start = kind === 'ol' ? Number(lineText.match(NUMBER)[1]) : null;
    if (last && !last.closed && last.kind === kind && kind !== 'h') last.lines.push(body);
    else out.push({ kind, lines: [body], start, closed: kind === 'h' });
  }
  return out;
}

const HTML_TAGS = { b: ['<strong>', '</strong>'], i: ['<em>', '</em>'], code: ['<code>', '</code>'] };
const TG_TAGS = { b: ['<b>', '</b>'], i: ['<i>', '</i>'], code: ['<code>', '</code>'] };
const PLAIN_TAGS = { b: ['', ''], i: ['', ''], code: ['', ''] };

// For the app: <p>, <ul>, <ol>, <strong>, <em>, <code> and nothing else.
export function richHtml(text) {
  const md = (s) => inline(s, escHtml, HTML_TAGS);
  return blocks(text).map((b) => {
    if (b.kind === 'ul') return `<ul>${b.lines.map((l) => `<li>${md(l)}</li>`).join('')}</ul>`;
    if (b.kind === 'ol') return `<ol${b.start > 1 ? ` start="${b.start}"` : ''}>${b.lines.map((l) => `<li>${md(l)}</li>`).join('')}</ol>`;
    if (b.kind === 'h') return `<p><strong>${md(b.lines[0])}</strong></p>`;
    return `<p>${b.lines.map(md).join('<br>')}</p>`;
  }).join('');
}

function flat(text, esc, tags) {
  const md = (s) => inline(s, esc, tags);
  return blocks(text).map((b) => {
    if (b.kind === 'ul') return b.lines.map((l) => `• ${md(l)}`).join('\n');
    if (b.kind === 'ol') return b.lines.map((l, i) => `${(b.start || 1) + i}. ${md(l)}`).join('\n');
    if (b.kind === 'h') return `${tags.b[0]}${md(b.lines[0])}${tags.b[1]}`;
    return b.lines.map(md).join('\n');
  }).join('\n\n');
}

// For Telegram with parse_mode HTML: <b>, <i>, <code>, bullets as "•".
export const telegramHtml = (text) => flat(text, escTg, TG_TAGS);

// For notifications, which show text only: the markers dropped, bullets as "•".
export const plainText = (text) => flat(text, (s) => String(s ?? ''), PLAIN_TAGS);
