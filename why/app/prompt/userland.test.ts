import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {gunzipSync} from 'node:zlib';
import {makeWebroot, standIn} from '../../../scripts/webroot-standin.ts';
import type {About, Index} from './userland.ts';

// What a Prompt in a browser is given of why: the root's own files at their
// own paths, nothing in place of them. Served from why made from a stand-in
// root (scripts/webroot-standin.ts), as the page fetches it.

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let work = '', out = '';
const asked: string[] = [];

before(() => {
  work = mkdtempSync(join(tmpdir(), 'webroot-page-'));
  out = join(work, 'webroot');
  const r = makeWebroot(standIn(work, '9.9.9'), out, work);
  assert.equal(r.status, 0, r.stderr);
  // The page's origin: /webroot/… is the directory webroot.ts wrote.
  Object.assign(globalThis, {location: new URL('http://page.test/')});
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://page.test/').pathname;
    asked.push(path);
    const file = join(out, path.replace(/^\/webroot\//, ''));
    if (!path.startsWith('/webroot/') || !existsSync(file)) return new Response('', {status: 404});
    return new Response(readFileSync(file), {headers: {'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream'}});
  }) as typeof fetch;
});
after(() => rmSync(work, {recursive: true, force: true}));

test('a Prompt is given the root\'s own BusyBox at its own path, its translation beside it, and the whole root by its index', async () => {
  const {loadWebroot} = await import('./userland.ts');
  const webroot = await loadWebroot();
  const about = JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8')) as About;
  const index = JSON.parse(readFileSync(join(out, about.index.path), 'utf8')) as Index;
  assert.deepEqual([webroot.about.version, webroot.about.sha256], ['9.9.9', about.sha256]);
  assert.deepEqual(webroot.index, index);
  assert.equal(webroot.url, 'http://page.test/webroot/');
  // Each file given is one of the root's, the same bytes and mode as the index (and so the tarball) has: none is the page's own.
  assert.deepEqual(webroot.files.map((f) => f.path), ['/usr/bin/busybox']);
  for (const f of webroot.files) {
    const t = index.translations.find((x) => x.path === f.path)!;
    assert.equal(sha(f.bytes), t.sha256);
    assert.equal(f.mode, index.files.find((x) => x.path === f.path)!.mode);
    assert.ok(f.module instanceof WebAssembly.Module);
    assert.deepEqual(new Uint8Array(gunzipSync(readFileSync(join(out, t.elf.path)))), f.bytes);
  }
  // What a first Prompt waited for: webroot.json, the index, the translator and BusyBox's two blobs. No pack: the Worker reads those as programs open them.
  assert.deepEqual([...new Set(asked.filter((p) => p !== '/webroot/webroot.json'))].sort(), [`/webroot/${about.index.path}`, `/webroot/${index.translator.path}`,
    ...index.translations.flatMap((t) => [`/webroot/${t.elf.path}`, `/webroot/${t.wasm.path}`])].filter((p, k, all) => all.indexOf(p) === k).sort());
});

test('webroot.json names what why is: the version and the root digest core/src/root.rs pins, and the index by its digest', () => {
  const about = JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8')) as About;
  const bytes = readFileSync(join(out, about.index.path));
  assert.equal(sha(bytes), about.index.sha256);
  assert.equal(bytes.length, about.index.size);
  const index = JSON.parse(bytes.toString('utf8')) as Index;
  assert.deepEqual([index.version, index.sha256, index.codec], [about.version, about.sha256, 'zstd']);
  // The links and directories of the root are the index's, the /bin of merged /usr among them.
  assert.ok(index.links.some((l) => l.path === '/bin' && l.target === 'usr/bin'));
});

// why this build carries, when it carries one (npm run webroot, or prompt-files.ts): what webroot.json names is beside it.
const built = new URL('../../../public/webroot/', import.meta.url);
test('the why in public/ is whole: its index is the digest webroot.json says, and names only what is there', {skip: !existsSync(new URL('webroot.json', built))}, () => {
  const about = JSON.parse(readFileSync(new URL('webroot.json', built), 'utf8')) as About;
  const bytes = readFileSync(new URL(about.index.path, built));
  assert.equal(sha(bytes), about.index.sha256);
  const index = JSON.parse(bytes.toString('utf8')) as Index;
  for (const p of index.packs) assert.ok(existsSync(new URL(`packs/${p.name}`, built)), p.name);
  for (const b of [index.translator, ...index.translations.flatMap((t) => [t.elf, t.wasm])]) assert.equal(sha(readFileSync(new URL(b.path, built))), b.sha256);
  assert.ok(index.translations.some((t) => t.path === '/usr/bin/busybox'), 'BusyBox (sh and its applets) is translated ahead of time');
});
