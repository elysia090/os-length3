import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {mirror, type Store} from './mirror.ts';
import {desktopFile, pinnedDesktop, pinnedRoots, type Pinned} from './releases.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pin = (file: string, bytes: Uint8Array, tag = 'os-length3-linux-v1.0.0'): Pinned =>
  ({key: `desktop/${file}`, path: `/v1/desktop/${file}`, tag, file, sha256: sha(bytes), bytes: bytes.length, type: 'application/octet-stream'});

/** A bucket as the deploy sees it: what it holds by key (as recorded: its digest and size), and each put. */
function fakeBucket(had: Record<string, Uint8Array> = {}) {
  const held = new Map(Object.entries(had)), puts: string[] = [];
  const store: Store = {
    async has(p) { const b = held.get(p.key); return !!b && b.length === p.bytes && sha(b) === p.sha256; },
    async put(p, file) { puts.push(p.key); held.set(p.key, new Uint8Array(readFileSync(file))); },
  };
  return {store, held, puts};
}

/** GitHub's release API for one tag's files; each request it was asked, and with what token. */
function fakeGitHub(files: Record<string, Uint8Array>, tag = 'os-length3-linux-v1.0.0') {
  const asked: string[] = [], tokens: (string | null)[] = [];
  const names = Object.keys(files);
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    asked.push(u.replace('https://api.test/repos/me/os', ''));
    tokens.push(new Headers(init?.headers).get('authorization'));
    if (u === `https://api.test/repos/me/os/releases/tags/${tag}`) return Response.json({assets: names.map((name, id) => ({id, name}))});
    const m = /\/releases\/assets\/(\d+)$/.exec(u);
    if (m && names[Number(m[1])]) return new Response(files[names[Number(m[1])]] as BodyInit);
    return new Response('Not Found', {status: 404});
  }) as typeof fetch;
  return {fetch: f, asked, tokens, source: {api: 'https://api.test', repo: 'me/os', token: 'read-only', fetch: f}};
}

const a = new TextEncoder().encode('the deb'), b = new TextEncoder().encode('the AppImage, larger');
const quiet = () => {};

test('mirror: what the bucket has at its pinned size is kept untouched; what it lacks is taken, checked and put; again, nothing happens', async () => {
  const pins = [pin('a.deb', a), pin('b.AppImage', b)];
  const bucket = fakeBucket({'desktop/a.deb': a});
  const gh = fakeGitHub({'a.deb': a, 'b.AppImage': b});
  assert.deepEqual(await mirror(pins, bucket.store, gh.source, quiet), {kept: ['desktop/a.deb'], put: ['desktop/b.AppImage']});
  assert.deepEqual(bucket.puts, ['desktop/b.AppImage']);
  assert.deepEqual([...bucket.held.get('desktop/b.AppImage')!], [...b]);
  // Only the missing file was asked of GitHub, with the token.
  assert.deepEqual(gh.asked, ['/releases/tags/os-length3-linux-v1.0.0', '/releases/assets/1']);
  assert.deepEqual(gh.tokens, ['Bearer read-only', 'Bearer read-only']);
  // Idempotent: a second deploy finds both and asks GitHub nothing.
  assert.deepEqual(await mirror(pins, bucket.store, gh.source, quiet), {kept: ['desktop/a.deb', 'desktop/b.AppImage'], put: []});
  assert.equal(gh.asked.length, 2);
});

test('mirror: a copy of another size is put again; bytes that are not the pin are never put, and the rest still go', async () => {
  const bucket = fakeBucket({'desktop/a.deb': a.slice(0, 3)});
  const gh = fakeGitHub({'a.deb': a, 'b.AppImage': new TextEncoder().encode('not what was pinned!')});
  const said: string[] = [];
  await assert.rejects(mirror([pin('a.deb', a), pin('b.AppImage', b)], bucket.store, gh.source, (l) => said.push(l)),
    (e: Error) => /desktop\/b\.AppImage: b\.AppImage from os-length3-linux-v1\.0\.0 is sha256 [0-9a-f]{64} \(20 bytes\); this tree pins/.test(e.message));
  assert.deepEqual(bucket.puts, ['desktop/a.deb']);
  assert.deepEqual([...bucket.held.get('desktop/a.deb')!], [...a]);
  assert.ok(!bucket.held.has('desktop/b.AppImage'));
  assert.ok(said.some((l) => l.startsWith('desktop/a.deb: put')), said.join('\n'));
});

test('mirror: a copy of the pinned size but another digest (a file rebuilt under its name) is put again', async () => {
  const same = new TextEncoder().encode('the DEB');
  const bucket = fakeBucket({'desktop/a.deb': same});
  assert.equal(same.length, a.length);
  assert.deepEqual(await mirror([pin('a.deb', a)], bucket.store, fakeGitHub({'a.deb': a}).source, quiet), {kept: [], put: ['desktop/a.deb']});
  assert.deepEqual([...bucket.held.get('desktop/a.deb')!], [...a]);
});

test('mirror: more bytes than pinned stop the download; a file the release lacks, or a release it cannot read, is said, not put', async () => {
  const big = new Uint8Array(1 << 20).fill(7);
  const short = pin('a.deb', big.slice(0, 10));
  const bucket = fakeBucket();
  await assert.rejects(mirror([short], bucket.store, fakeGitHub({'a.deb': big}).source, quiet), /more than the 10 bytes pinned/);
  await assert.rejects(mirror([pin('gone.deb', a)], bucket.store, fakeGitHub({'a.deb': a}).source, quiet), /os-length3-linux-v1\.0\.0 has no gone\.deb/);
  const noToken = {...fakeGitHub({}, 'another').source, token: undefined};
  await assert.rejects(mirror([pin('a.deb', a)], bucket.store, noToken, quiet), /the release os-length3-linux-v1\.0\.0: 404 \(a private repository needs GITHUB_TOKEN\)/);
  assert.deepEqual(bucket.puts, []);
});

test('the pins: every root core/src/root.rs pins, newest first, and the desktop app of a version, by its file', () => {
  const roots = pinnedRoots(readFileSync(new URL('../core/src/root.rs', import.meta.url), 'utf8'));
  assert.ok(roots.length >= 2);
  for (const r of roots) {
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([r.key, r.path], [`os/${r.sha256}`, `/v1/os/${r.sha256}`]);
    assert.match(r.tag, /^os-length3-linux-v/);
    assert.ok(r.bytes > 1e6 && r.file.endsWith('.tar.zst'), r.file);
  }
  // An entry not as pin-root.mjs writes it is refused, not skipped.
  assert.throws(() => pinnedRoots('pub const RELEASES: &[Release] = &[Release { name: "x" }];'), /not as pin-root\.mjs writes one/);

  // The newest desktop app this tree pins (while a release is made, RELEASE names one not pinned yet).
  const pins = JSON.parse(readFileSync(new URL('../shared/desktop-releases.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const version = Object.keys(pins).sort((a, b) => a.localeCompare(b, 'en', {numeric: true})).at(-1)!;
  const desktop = pinnedDesktop(version);
  assert.deepEqual(desktop.map((p) => [p.key, p.type, p.tag]), [
    [`desktop/os-length3-linux-${version}-desktop-amd64.deb`, 'application/vnd.debian.binary-package', `os-length3-linux-v${version}`],
    [`desktop/os-length3-linux-${version}-desktop-x86_64.AppImage`, 'application/vnd.appimage', `os-length3-linux-v${version}`]]);
  assert.deepEqual(pinnedDesktop('9.9.9'), []);
  assert.equal(desktopFile(desktop[0].file)?.sha256, desktop[0].sha256);
  assert.equal(desktopFile('../x.deb'), null);
  for (const bad of [{deb: {file: 'os-length3-linux-1.0.0-desktop-amd64.deb', bytes: 1, sha256: 'nope'}},
    {deb: {file: '../os-length3-linux-1.0.0-desktop-amd64.deb', bytes: 1, sha256: 'a'.repeat(64)}},
    {exe: {file: 'os-length3-linux-1.0.0-x.exe', bytes: 1, sha256: 'a'.repeat(64)}}]) {
    assert.throws(() => pinnedDesktop('1.0.0', {'1.0.0': bad} as never), /is not a pin/);
  }
});

test('mirror: a file the budget has no room for is neither fetched nor put, the others go, and the deploy is told', async () => {
  const pins = [pin('a.deb', a), pin('b.AppImage', b)];
  const bucket = fakeBucket({'desktop/a.deb': a.slice(0, 3)});
  const gh = fakeGitHub({'a.deb': a, 'b.AppImage': b});
  const allowed: string[] = [];
  const allow = async (p: Pinned) => {
    allowed.push(p.key);
    if (p.key === 'desktop/b.AppImage') throw new Error('R2 would hold more than R2_STORED_MB');
  };
  await assert.rejects(mirror(pins, bucket.store, gh.source, quiet, allow), /desktop\/b\.AppImage: R2 would hold more than R2_STORED_MB/);
  // Asked of each it lacks (a copy of 3 bytes is put again).
  assert.deepEqual(allowed, ['desktop/a.deb', 'desktop/b.AppImage']);
  assert.deepEqual(bucket.puts, ['desktop/a.deb']);
  assert.ok(!gh.asked.includes('/releases/assets/1'));
});
