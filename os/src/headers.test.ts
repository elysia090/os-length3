import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {headersOf, webPolicy} from './policy.ts';

// The app's files are served by Workers Assets, not the Worker, so only public/_headers can say
// these (security audit H1: a framable device-approval page; OWASP ASVS 14.4.1-14.4.7).
const all = headersOf(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));

test('the app is never framed, and is reached only by HTTPS', () => {
  assert.match(all['Content-Security-Policy'], /(^|; )frame-ancestors 'none'(;|$)/);
  assert.equal(all['X-Frame-Options'], 'DENY');
  assert.equal(all['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
});

test('the header policy is the build\'s own (for the Remote on its own origin), with frame-ancestors', () => {
  assert.equal(all['Content-Security-Policy'], `${webPolicy('')}; frame-ancestors 'none'`);
  // Strict where it can be: no script but the app's own files, nothing from text but WebAssembly.
  assert.doesNotMatch(webPolicy(''), /'unsafe-eval'|script-src[^;]*'unsafe-inline'|\*/);
});

test('no referrer, no sniffing, no window shared with another site, no file taken by one, no feature but passkeys and the clipboard', () => {
  assert.equal(all['Referrer-Policy'], 'no-referrer');
  assert.equal(all['X-Content-Type-Options'], 'nosniff');
  assert.equal(all['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(all['Cross-Origin-Resource-Policy'], 'same-origin');
  const allowed = all['Permissions-Policy'].split(', ').filter((p) => !p.endsWith('=()'));
  assert.deepEqual(allowed, ['publickey-credentials-get=(self)', 'publickey-credentials-create=(self)', 'clipboard-write=(self)']);
  for (const off of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) assert.ok(all['Permissions-Policy'].includes(`${off}=()`), off);
});
