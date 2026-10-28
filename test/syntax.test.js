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
