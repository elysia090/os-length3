import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

// The app's files are served by Workers Assets, not the Worker, so only public/_headers can say
// these (security audit H1: a framable device-approval page).
test('the app is never framed, and is reached only by HTTPS', () => {
  const rules = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split('\n').filter((l) => !l.startsWith('#'));
  const all = rules.slice(rules.findIndex((l) => l.trim() === '/*') + 1).map((l) => l.trim()).filter(Boolean);
  for (const h of ["Content-Security-Policy: frame-ancestors 'none'", 'X-Frame-Options: DENY', 'Strict-Transport-Security: max-age=31536000'])
    assert.ok(all.includes(h), h);
});
