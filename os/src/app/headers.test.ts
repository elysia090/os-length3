import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DEFAULT_REMOTE, desktopPolicy, headersOf, webPolicy} from './policy.ts';

// The app's files are served by Workers Assets, not the Worker, so only public/_headers can say
// these (security audit H1: a framable device-approval page; OWASP ASVS 14.4.1-14.4.7).
const all = headersOf(readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8'));

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

// The desktop app (Tauri's security checklist): its webview's policy as strict as the web's but for its
// ipc: channel, no remote page, the plain-http origin never, and a window that may do almost nothing.
test('the desktop webview runs only the app\'s own files, under a strict policy, with no host permission but events and its title', () => {
  const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const csp: string = conf.app.security.csp;
  // One policy, src/app/policy.ts's, for the Remote the app ships with (scripts/desktop.sh gives Tauri it for another).
  assert.equal(csp, desktopPolicy(DEFAULT_REMOTE));
  assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'|'wasm-unsafe-eval'|\*|http:\/\/(?!ipc\.localhost)/);
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"]) assert.ok(csp.includes(d), d);
  assert.equal(conf.build.frontendDist, '../dist');
  assert.ok(conf.app.windows.every((w: {url?: string; useHttpsScheme?: boolean}) => !w.url && w.useHttpsScheme === true));
  assert.equal(JSON.stringify(conf).includes('dangerous'), false);
  const cap = JSON.parse(readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  assert.deepEqual(cap.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten', 'core:window:allow-set-title']);
  assert.equal(cap.remote, undefined);
  const wrangler = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
  assert.doesNotMatch(/^APP_ORIGINS = "(.*)"$/m.exec(wrangler)![1], /http:/);
});
