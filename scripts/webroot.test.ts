// The web root against the root it is made from, on a stand-in
// release root (a few files of each kind a root has): made by module/ricebox/build/distribution.ts,
// it is the root (webroot-parity.ts), the same twice, and anything changed in it
// is caught; pin-root.ts pins both in one entry, and prompt-files.ts takes
// it from a stand-in release only at that pin. The real root is checked the
// same way by the release and CI (webroot-parity.ts on the pinned root).
import assert from 'node:assert/strict';
import {execFile, execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync, gzipSync} from 'node:zlib';
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {pinnedRoots} from '../why/shipto/remote/ship/releases.ts';
import {makeWebroot, standIn} from '../module/ricebox/test/fixtures/distribution.ts';
import type {Index} from '../module/ricebox/distribution/manifest.ts';
import {readCapturedResultRelease} from '../module/ricebox/deployment/capture-result.ts';
import {capturedResultHost} from '../module/sods/runtime/linux.ts';

const os = fileURLToPath(new URL('..', import.meta.url));
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const node = (args: string[]) => spawnSync(process.execPath, args, {encoding: 'utf8'});
let work = '', rootFile = '', out = '';

const files = (dir: string) => readdirSync(dir, {recursive: true, encoding: 'utf8'}).filter((f) => statSync(join(dir, f)).isFile()).sort()
  .map((f) => `${f} ${sha(readFileSync(join(dir, f)))}`);

const make = (root: string, dir: string) => { const r = makeWebroot(root, dir, work); assert.equal(r.status, 0, r.stderr); };

before(() => {
  work = mkdtempSync(join(tmpdir(), 'why-test-'));
  rootFile = standIn(work, '9.9.9');
  out = join(work, 'webroot');
  make(rootFile, out);
});
after(() => rmSync(work, {recursive: true, force: true}));

const captureArtifact = process.env.SODS_CAPTURE_RESULT_WASM;
test('explicit capture builder emits only the pinned private artifact and ordinary rebuild removes it', {
  skip: captureArtifact ? false : 'Requires the separately built private capture artifact',
}, async () => {
  const wasm = readFileSync(captureArtifact!);
  const approved = process.env.SODS_CAPTURE_RESULT_SHA256;
  assert.equal(sha(wasm), approved, 'the test approves the prior CI build, not the package result');
  const flags = ['--capture-result', captureArtifact!, '--capture-result-sha256', approved!];
  const captureOut = join(work, 'capture-builder');
  const badOut = join(work, 'failed-capture-builder');
  const admitBad = (args: readonly string[], re: RegExp) => {
    const r = makeWebroot(join(work, 'must-not-read'), badOut, work, args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, re);
    assert.throws(() => statSync(badOut), /ENOENT/);
  };
  admitBad(flags.slice(0, 2), /capture-result-sha256/);
  admitBad([...flags, ...flags.slice(0, 2)], /Duplicate --capture-result/);
  admitBad([...flags.slice(0, -1), '0'.repeat(64)], /capture result artifact digest mismatch/i);
  const ordinaryWasm = readFileSync(join(work, 'sods.wasm')); // The fixture translator, not a captured Core.
  admitBad(['--capture-result', join(work, 'sods.wasm'), '--capture-result-sha256', sha(ordinaryWasm)], /artifact identity/);

  const made = makeWebroot(rootFile, captureOut, work, flags);
  assert.equal(made.status, 0, made.stderr);
  const about = JSON.parse(readFileSync(join(captureOut, 'webroot.json'), 'utf8'));
  const indexBytes = readFileSync(join(captureOut, about.index.path));
  const index: Index = JSON.parse(indexBytes.toString('utf8'));
  assert.equal(index.captureResult?.kind, 'sods-linux-capture-result-v5');
  assert.equal(index.captureResult?.wasm, approved);
  const capturePath = index.captureResult!.path;
  assert.deepEqual(gunzipSync(readFileSync(join(captureOut, capturePath))), wasm);
  const selected = await readCapturedResultRelease({sha256: sha(indexBytes), size: indexBytes.length},
    indexBytes, async path => readFileSync(join(captureOut, path)));
  assert.equal(selected.pin.sha256, approved);
  assert.deepEqual(selected.bytes, new Uint8Array(wasm));
  if (process.platform === 'linux' && process.arch === 'x64' && [22, 24].includes(Number(process.versions.node.split('.')[0]))) {
    const privateHost = await capturedResultHost(selected.bytes, selected.pin, 1, 4, {maximumRequest: 4, queueBytes: 4});
    assert.throws(() => privateHost.takeOutput(), /Linux memory admission failed: -9/, 'the packaged pin installs no receiver or Worker');
  }

  make(rootFile, captureOut);
  assert.throws(() => statSync(join(captureOut, capturePath)), /ENOENT/);
  assert.deepEqual(files(captureOut), files(out));
});

test('the web root is the root: every path, type, mode, link target and sha256', () => {
  const r = node([join(os, 'module/ricebox/verification/distribution.ts'), rootFile, out, '--manifests', join(work, 'm')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^same: /m);
  const native = readFileSync(join(work, 'm/native.txt'), 'utf8');
  // As why installs a root: no set-id bit from an archive, the sticky bit kept, a hard link the same bytes.
  assert.match(native, /^\/usr\/bin\/su\tfile\t0755\t/m);
  assert.match(native, /^\/tmp\tdir\t1777\t/m);
  assert.match(native, /^\/bin\tlink\t0777\tusr\/bin$/m);
  const line = (p: string) => (native.split('\n').find((l) => l.startsWith(`${p}\t`)) ?? '').split('\t').slice(3).join('\t');
  assert.equal(line('/usr/bin/busybox.same'), line('/usr/bin/busybox'));
  assert.equal(native, readFileSync(join(work, 'm/web.txt'), 'utf8'));
  const about = JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8'));
  assert.deepEqual([about.name, about.version, about.sha256, about.root.profile], ['why', '9.9.9', /-([0-9a-f]{64})\.tar\.zst$/.exec(rootFile)?.[1], 'development-standard-v1']);
});

test('the same root and translator make the same why, byte for byte', () => {
  const again = join(work, 'again');
  make(rootFile, again);
  assert.deepEqual(files(again), files(out));
});

test('a pack or an index that is not the root is caught', () => {
  const bad = join(work, 'bad');
  cpSync(out, bad, {recursive: true});
  const pack = join(bad, 'packs', readdirSync(join(bad, 'packs'))[0] ?? '');
  const b = readFileSync(pack); b[b.length - 1] ^= 1; writeFileSync(pack, b);
  let r = node([join(os, 'module/ricebox/verification/distribution.ts'), rootFile, bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /not the file its table names/);

  rmSync(bad, {recursive: true, force: true});
  cpSync(out, bad, {recursive: true});
  // An index that says another mode, made to look like why's own: the parity reads past the digests and finds it.
  const about = JSON.parse(readFileSync(join(bad, 'webroot.json'), 'utf8'));
  const index: Index = JSON.parse(readFileSync(join(bad, about.index.path), 'utf8'));
  const busybox = index.files.find((f) => f.path === '/usr/bin/busybox');
  assert.ok(busybox);
  busybox.mode = 0o4755;
  const json = Buffer.from(JSON.stringify(index));
  writeFileSync(join(bad, about.index.path), json);
  writeFileSync(join(bad, 'webroot.json'), JSON.stringify({...about, index: {...about.index, sha256: sha(json), size: json.length}}));
  r = node([join(os, 'module/ricebox/verification/distribution.ts'), rootFile, bad]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /different \(1\):\n {2}\/usr\/bin\/busybox\tfile\t0755/);
});

test('one entry pins why for both: the root, and the index the browser reads it by', () => {
  const rs = join(work, 'root.rs');
  copyFileSync(join(os, 'why/prompt/roots/pins.rs'), rs);
  const r = node([join(os, 'scripts/pin-root.ts'), rootFile, out, '--rs', rs]);
  assert.equal(r.status, 0, r.stderr);
  const pins = pinnedRoots(readFileSync(rs, 'utf8'));
  const about = JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8'));
  // Only the release made is pinned: a device installs the newest pin alone, and the releases before it are deleted.
  assert.equal(pins.length, 1);
  assert.deepEqual([pins[0]?.version, pins[0]?.sha256, pins[0]?.web, pins[0]?.bytes], ['9.9.9', about.sha256, about.index.sha256, statSync(rootFile).size]);
  // Again: nothing changes. Another index for a root pinned with one: refused, never changed.
  assert.match(node([join(os, 'scripts/pin-root.ts'), rootFile, out, '--rs', rs]).stdout, /pinned already/);
  const other = join(work, 'other');
  cpSync(out, other, {recursive: true});
  const json = Buffer.concat([readFileSync(join(other, about.index.path)), Buffer.from(' ')]);
  writeFileSync(join(other, about.index.path), json);
  writeFileSync(join(other, 'webroot.json'), JSON.stringify({...about, index: {...about.index, sha256: sha(json)}}));
  assert.match(node([join(os, 'scripts/pin-root.ts'), rootFile, other, '--rs', rs]).stderr, /a released index is never changed/);
});

function copyPromptSources(tree: string) {
  for (const d of ['why/prompt/roots', 'scripts', 'why/shipto/remote/ship', 'public', 'module/ricebox/runtime', 'module/ricebox/build']) mkdirSync(join(tree, d), {recursive: true});
  // And what both of those check packs by, where the repository has it (module/ricebox/runtime).
  for (const f of ['why/prompt/roots/pins.rs', 'scripts/prompt-files.ts', 'module/ricebox/host/node/tar.ts', 'module/ricebox/host/node/hash.ts', 'module/ricebox/distribution/inventory.ts', 'module/ricebox/distribution/manifest.ts', 'why/shipto/remote/ship/releases.ts', 'why/shipto/desktop-releases.json',
    'module/ricebox/distribution/pack.ts', 'module/ricebox/deployment/capture-result.ts']) {
    mkdirSync(dirname(join(tree,f)),{recursive:true});
    copyFileSync(join(os,f),join(tree,f));
  }
}

test('release downloader fixture includes the archive reader dependency closure',()=>{
  const tree=join(work,'reader-closure');
  copyPromptSources(tree);
  const result=node(['--input-type=module','-e',`const reader=await import(${JSON.stringify(pathToFileURL(join(tree,'module/ricebox/host/node/tar.ts')).href)}); if(typeof reader.tarMembers!=='function') throw Error('missing reader');`]);
  assert.equal(result.status,0,result.stderr);
});

test('a Node-only build takes why from its release only at the pin, and refuses anything else', async () => {
  // A tree as prompt-files.ts reads it: the pins, newest 9.9.9, and the scripts; and a release that has why's tar.
  const tree = join(work, 'repo');
  copyPromptSources(tree);
  assert.equal(node([join(os, 'scripts/pin-root.ts'), rootFile, out, '--rs', join(tree, 'why/prompt/roots/pins.rs')]).status, 0);

  const tarOf = (dir: string) => execFileSync('tar', ['-C', dir, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=pax', '-cf', '-', '.'], {maxBuffer: 1 << 28});
  let tar = tarOf(out);
  let sums: string | null = null;
  let name = 'os-length3-linux-9.9.9-webroot.tar';
  // The release's download links, as GitHub serves a public release's files.
  const server = createServer((req, res) => {
    if (req.url === '/os-length3-linux-v9.9.9/SHA256SUMS') return res.end(`${sums ?? sha(tar)}  ${name}\n`);
    if (req.url === `/os-length3-linux-v9.9.9/${name}`) return res.end(tar);
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const at = server.address();
  const port = typeof at === 'object' && at ? at.port : 0;
  // Run in a child the server here can answer (spawnSync would hold this process, and the server, still).
  const go = () => new Promise<{status: number; stdout: string; stderr: string}>((resolve) => {
    const env = {...process.env, WHY_RELEASES: `http://127.0.0.1:${port}`};
    execFile(process.execPath, [join(tree, 'scripts/prompt-files.ts')], {env}, (e, stdout, stderr) =>
      resolve({status: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr}));
  });
  try {
    let r = await go();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(files(join(tree, 'public/webroot')), files(out));


    // The release may carry muk beside the indexed root. It is part of the
    // checked archive, and its descriptor must bind exactly one checked blob.
    const withMuk = join(work, 'with-muk');
    cpSync(out, withMuk, {recursive: true});
    const muk = Buffer.from('stand-in muk');
    const said = {path: `blobs/${sha(muk)}.bin`, sha256: sha(muk), size: muk.length};
    writeFileSync(join(withMuk, said.path), muk);
    const describe = (value: unknown) => writeFileSync(join(withMuk, 'muk.json'), JSON.stringify(value));
    describe(said);
    tar = tarOf(withMuk);
    r = await go();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(files(join(tree, 'public/webroot')), files(withMuk));
    const accepted = files(join(tree, 'public/webroot'));
    for (const broken of [
      {...said, size: said.size + 1},
      {...said, size: -1},
      {...said, path: '../muk'},
      {...said, path: `blobs/${'0'.repeat(64)}.bin`, sha256: '0'.repeat(64)},
    ]) {
      describe(broken); tar = tarOf(withMuk); r = await go();
      assert.notEqual(r.status, 0);
      assert.deepEqual(files(join(tree, 'public/webroot')), accepted);
    }
    describe(said);
    writeFileSync(join(withMuk, said.path), Buffer.alloc(muk.length));
    tar = tarOf(withMuk); r = await go();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /its index says/);
    assert.deepEqual(files(join(tree, 'public/webroot')), accepted);
    // A release with no sidecar remains supported.
    tar = tarOf(out); r = await go();
    assert.equal(r.status, 0, r.stderr);

    // A separately pinned archive may include an optional Node capture asset.
    const withCapture = join(work, 'with-capture');
    cpSync(out, withCapture, {recursive: true});
    const aboutCapture = JSON.parse(readFileSync(join(withCapture, 'webroot.json'), 'utf8'));
    const indexCapture = JSON.parse(readFileSync(join(withCapture, aboutCapture.index.path), 'utf8'));
    const captureWasm = captureArtifact ? readFileSync(captureArtifact) : Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
    const storedCapture = gzipSync(captureWasm), storedSha = sha(storedCapture);
    const capture = {kind: 'sods-linux-capture-result-v5', host: 'linux-x64-node22-24', wasm: sha(captureWasm),
      bytes: captureWasm.byteLength, size: storedCapture.byteLength, sha256: storedSha, path: `blobs/${storedSha}.bin`};
    const oldIndex = aboutCapture.index.path;
    rmSync(join(withCapture, oldIndex));
    const current = (captureResult: unknown) => {
      const bytes = Buffer.from(JSON.stringify({...indexCapture, captureResult})), sha256 = sha(bytes);
      const path = `index-${sha256}.json`;
      writeFileSync(join(withCapture, path), bytes);
      writeFileSync(join(withCapture, 'webroot.json'), JSON.stringify({...aboutCapture, index: {path, sha256, size: bytes.length}}));
      return {path, sha256};
    };
    const captureIndex = current(capture);
    writeFileSync(join(withCapture, capture.path), storedCapture);
    tar = tarOf(withCapture);
    r = await go();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /this tree pins/, 'rewriting both archive index and descriptor is not authority');
    const pinFile = join(tree, 'why/prompt/roots/pins.rs'), pinned = readFileSync(pinFile, 'utf8');
    const choose = (sha256: string) => writeFileSync(pinFile, pinned.replace(aboutCapture.index.sha256, sha256));
    choose(captureIndex.sha256); // The policy is deliberately chosen outside the supplied archive.
    r = await go();
    assert.equal(r.status, 0, r.stderr);
    const capturedFiles = files(join(tree, 'public/webroot'));
    assert.deepEqual(capturedFiles, files(withCapture));
    rmSync(join(withCapture, captureIndex.path));
    const mismatch = current({...capture, wasm: '0'.repeat(64)});
    choose(mismatch.sha256);
    tar = tarOf(withCapture);
    r = await go();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /expanded Wasm digest mismatch/);
    assert.deepEqual(files(join(tree, 'public/webroot')), capturedFiles);
    writeFileSync(pinFile, pinned);

    // A release from before the web root had its name: -l3-web.tar, its webroot.json as l3.json. Taken the same.
    const old = join(work, 'old-release');
    rmSync(old, {recursive: true, force: true});
    cpSync(out, old, {recursive: true});
    renameSync(join(old, 'webroot.json'), join(old, 'l3.json'));
    tar = tarOf(old);
    name = 'os-length3-linux-9.9.9-l3-web.tar';
    rmSync(join(tree, 'public/webroot'), {recursive: true, force: true});
    r = await go();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(files(join(tree, 'public/webroot')), files(out));
    name = 'os-length3-linux-9.9.9-webroot.tar';

    // A tar whose index is not the pinned one (a pack changed, its index renamed to match): refused, and public/webroot stays as it was.
    const bad = join(work, 'bad-release');
    rmSync(bad, {recursive: true, force: true});
    cpSync(out, bad, {recursive: true});
    const about = JSON.parse(readFileSync(join(bad, 'webroot.json'), 'utf8'));
    const index: Index = JSON.parse(readFileSync(join(bad, about.index.path), 'utf8'));
    const first = index.files[0];
    assert.ok(first);
    first.mode = 0o600;
    const json = Buffer.from(JSON.stringify(index));
    rmSync(join(bad, about.index.path));
    writeFileSync(join(bad, `index-${sha(json)}.json`), json);
    writeFileSync(join(bad, 'webroot.json'), JSON.stringify({...about, index: {path: `index-${sha(json)}.json`, sha256: sha(json), size: json.length}}));
    tar = tarOf(bad);
    r = await go();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /this tree pins/);
    assert.deepEqual(files(join(tree, 'public/webroot')), files(out));
    // The pinned why, but not what the release's SHA256SUMS says of its file: refused too.
    tar = tarOf(out);
    sums = sha(Buffer.from('another'));
    r = await go();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SHA256SUMS of os-length3-linux-v9\.9\.9 says/);
  } finally { server.close(); }
});
