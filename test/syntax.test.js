// Every file the phone loads must parse: the server tests never run them, so a slip such as a name
// declared twice would only show as a blank app. node --check reads each one as the browser would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = new URL('../public/', import.meta.url);

test('every script in public parses', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(dir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), f)], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(`${f} does not parse:\n${String(err.stderr || err.message).split('\n').slice(0, 4).join('\n')}`);
    }
  }
});

// The app checks its own name against sw.js each time it comes back and reloads when they differ, so
// the two are bumped together: a mismatch would reload the phone on every return.
test('the app and its service worker carry the same version', () => {
  const sw = fs.readFileSync(new URL('sw.js', dir), 'utf8').match(/const CACHE = '(oath-v\d+)'/)?.[1];
  const app = fs.readFileSync(new URL('app.js', dir), 'utf8').match(/const BUILD = '(oath-v\d+)'/)?.[1];
  assert.ok(sw, 'sw.js names its cache');
  assert.equal(app, sw);
});
