// Conditional GET for the web app's files. Hono's serve-static sends Last-Modified but never looks at
// If-Modified-Since, so every launch downloaded every file again. This adds a weak ETag (size and
// modified time) and answers 304 when the browser's copy is current. The files stay `no-cache`, so
// a deploy still lands at once: the browser asks every time, and the answer is a 304 until a file
// really changes.
import { statSync } from 'node:fs';
import { join } from 'node:path';

const statOf = (path) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

// The file serve-static would send for a request path, or null. It follows serve-static's own rules
// (no percent signs, no dot segments, no backslashes, a folder means its index.html), so the ETag
// always belongs to the file that is sent.
export function publicFile(root, reqPath) {
  if (reqPath.includes('%')) return null;
  if (/(?:^|[/\\])\.{1,2}(?:$|[/\\])|[/\\]{2,}|\\/.test(reqPath)) return null;
  let path = join(root, reqPath);
  let stats = statOf(path);
  if (stats?.isDirectory()) {
    path = join(path, 'index.html');
    stats = statOf(path);
  }
  return stats?.isFile() ? { path, stats } : null;
}

export const etagOf = (stats) => `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;

const bare = (tag) => tag.trim().replace(/^W\//, '');

// If-None-Match wins when it is sent; otherwise If-Modified-Since, compared to the second like the
// Last-Modified header it echoes.
function notModified(c, etag, stats) {
  const none = c.req.header('if-none-match');
  if (none) return none.trim() === '*' || none.split(',').some((t) => bare(t) === bare(etag));
  const since = Date.parse(c.req.header('if-modified-since') || '');
  return Number.isFinite(since) && Math.floor(stats.mtimeMs / 1000) <= Math.floor(since / 1000);
}

// Goes in front of serveStatic. `find(c)` says which file the request is for (see publicFile).
export function conditionalGet(find) {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const file = find(c);
    if (!file) return next();
    const etag = etagOf(file.stats);
    c.header('ETag', etag);
    if (notModified(c, etag, file.stats)) {
      c.header('Last-Modified', file.stats.mtime.toUTCString());
      return c.body(null, 304);
    }
    return next();
  };
}
