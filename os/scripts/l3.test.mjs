// l3 for the browser against the root it is made from, on a stand-in
// release root (a few files of each kind a root has): made by scripts/l3.mjs,
// it is the root (l3-parity.mjs), the same twice, and anything changed in it
// is caught; pin-root.mjs pins both in one entry, and prompt-files.mjs takes
// it from a stand-in release only at that pin. The real root is checked the
// same way by the release and CI (l3-parity.mjs on the pinned root).
import assert from 'node:assert/strict';
import {execFile, execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {zstdCompressSync} from 'node:zlib';
import {pinnedRoots} from '../service/releases.ts';
import {makeL3, standIn} from './l3-standin.mjs';

const os = fileURLToPath(new URL('..', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const node = (args, opts = {}) => spawnSync(process.execPath, args, {encoding: 'utf8', ...opts});
let work, rootFile, out;

const files = (dir) => readdirSync(dir, {recursive: true}).filter((f) => statSync(join(dir, f)).isFile()).sort()
  .map((f) => `${f} ${sha(readFileSync(join(dir, f)))}`);

const make = (root, dir) => { const r = makeL3(root, dir, work); assert.equal(r.status, 0, r.stderr); };

before(() => {
  work = mkdtempSync(join(tmpdir(), 'l3-test-'));
  rootFile = standIn(work, '9.9.9');
  out = join(work, 'l3');
  make(rootFile, out);
});
after(() => rmSync(work, {recursive: true, force: true}));

test('l3 for the browser is the root: every path, type, mode, link target and sha256', () => {
  const r = node([join(os, 'scripts/l3-parity.mjs'), rootFile, out, '--manifests', join(work, 'm')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^same: /m);
  const native = readFileSync(join(work, 'm/native.txt'), 'utf8');
  // As l3 installs a root: no set-id bit from an archive, the sticky bit kept, a hard link the same bytes.
  assert.match(native, /^\/usr\/bin\/su\tfile\t0755\t/m);
  assert.match(native, /^\/tmp\tdir\t1777\t/m);
  assert.match(native, /^\/bin\tlink\t0777\tusr\/bin$/m);
  const line = (p) => native.split('\n').find((l) => l.startsWith(`${p}\t`)).split('\t').slice(3).join('\t');
  assert.equal(line('/usr/bin/busybox.same'), line('/usr/bin/busybox'));
  assert.equal(native, readFileSync(join(work, 'm/web.txt'), 'utf8'));
  const about = JSON.parse(readFileSync(join(out, 'l3.json'), 'utf8'));
  assert.deepEqual([about.name, about.version, about.sha256, about.root.profile], ['l3', '9.9.9', /-([0-9a-f]{64})\.tar\.zst$/.exec(rootFile)[1], 'development-standard-v1']);
});

test('the same root and translator make the same l3, byte for byte', () => {
  const again = join(work, 'again');
  make(rootFile, again);
  assert.deepEqual(files(again), files(out));
});

test('a pack or an index that is not the root is caught', () => {
  const bad = join(work, 'bad');
  cpSync(out, bad, {recursive: true});
  const pack = join(bad, 'packs', readdirSync(join(bad, 'packs'))[0]);
  const b = readFileSync(pack); b[b.length - 1] ^= 1; writeFileSync(pack, b);
  let r = node([join(os, 'scripts/l3-parity.mjs'), rootFile, bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /its bytes are sha256/);

  rmSync(bad, {recursive: true, force: true});
  cpSync(out, bad, {recursive: true});
  // An index that says another mode, made to look like l3's own: the parity reads past the digests and finds it.
  const about = JSON.parse(readFileSync(join(bad, 'l3.json'), 'utf8'));
  const index = JSON.parse(readFileSync(join(bad, about.index.path), 'utf8'));
  index.files.find((f) => f.path === '/usr/bin/busybox').mode = 0o4755;
  const json = Buffer.from(JSON.stringify(index));
  writeFileSync(join(bad, about.index.path), json);
  writeFileSync(join(bad, 'l3.json'), JSON.stringify({...about, index: {...about.index, sha256: sha(json), size: json.length}}));
  r = node([join(os, 'scripts/l3-parity.mjs'), rootFile, bad]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /different \(1\):\n {2}\/usr\/bin\/busybox\tfile\t0755/);
});

test('one entry pins l3 for both: the root, and the index the browser reads it by', () => {
  const rs = join(work, 'root.rs');
  copyFileSync(join(os, 'core/src/root.rs'), rs);
  const before = pinnedRoots(readFileSync(rs, 'utf8')).length;
  const r = node([join(os, 'scripts/pin-root.mjs'), rootFile, out, '--rs', rs]);
  assert.equal(r.status, 0, r.stderr);
  const pins = pinnedRoots(readFileSync(rs, 'utf8'));
  const about = JSON.parse(readFileSync(join(out, 'l3.json'), 'utf8'));
  assert.equal(pins.length, before + 1);
  assert.deepEqual([pins[0].version, pins[0].sha256, pins[0].web, pins[0].bytes], ['9.9.9', about.sha256, about.index.sha256, statSync(rootFile).size]);
  // Again: nothing changes. Another index for a root pinned with one: refused, never changed.
  assert.match(node([join(os, 'scripts/pin-root.mjs'), rootFile, out, '--rs', rs]).stdout, /pinned already/);
  const other = join(work, 'other');
  cpSync(out, other, {recursive: true});
  const json = Buffer.concat([readFileSync(join(other, about.index.path)), Buffer.from(' ')]);
  writeFileSync(join(other, about.index.path), json);
  writeFileSync(join(other, 'l3.json'), JSON.stringify({...about, index: {...about.index, sha256: sha(json)}}));
  assert.match(node([join(os, 'scripts/pin-root.mjs'), rootFile, other, '--rs', rs]).stderr, /a released index is never changed/);
});

test('a Node-only build takes l3 from its release only at the pin, and refuses anything else', async () => {
  // A tree as prompt-files.mjs reads it: RELEASE, the pins, and the scripts; and a release that has l3's tar.
  const tree = join(work, 'tree');
  for (const d of ['core/src', 'scripts', 'service', 'shared', 'public']) mkdirSync(join(tree, d), {recursive: true});
  writeFileSync(join(tree, 'RELEASE'), '9.9.9\n');
  copyFileSync(join(os, 'core/src/root.rs'), join(tree, 'core/src/root.rs'));
  for (const f of ['scripts/prompt-files.mjs', 'scripts/l3-tree.mjs', 'service/releases.ts', 'shared/desktop-releases.json']) copyFileSync(join(os, f), join(tree, f));
  const refused = node([join(tree, 'scripts/prompt-files.mjs')]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pins no l3 9\.9\.9/);
  assert.equal(node([join(os, 'scripts/pin-root.mjs'), rootFile, out, '--rs', join(tree, 'core/src/root.rs')]).status, 0);

  const tarOf = (dir) => execFileSync('tar', ['-C', dir, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=pax', '-cf', '-', '.'], {maxBuffer: 1 << 28});
  let tar = tarOf(out);
  let sums = null;
  const name = 'os-length3-linux-9.9.9-l3-web.tar';
  const server = createServer((req, res) => {
    if (req.url === '/repos/x/y/releases/tags/os-length3-linux-v9.9.9') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({assets: [{id: 1, name: 'SHA256SUMS'}, {id: 2, name}]}));
    }
    if (req.url === '/repos/x/y/releases/assets/1') return res.end(`${sums ?? sha(tar)}  ${name}\n`);
    if (req.url === '/repos/x/y/releases/assets/2') return res.end(tar);
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // Run in a child the server here can answer (spawnSync would hold this process, and the server, still).
  const go = () => new Promise((resolve) => {
    const env = {...process.env, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: 'x/y'};
    execFile(process.execPath, [join(tree, 'scripts/prompt-files.mjs')], {env}, (e, stdout, stderr) => resolve({status: e ? e.code ?? 1 : 0, stdout, stderr}));
  });
  try {
    let r = await go();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(files(join(tree, 'public/l3')), files(out));

    // A tar whose index is not the pinned one (a pack changed, its index renamed to match): refused, and public/l3 stays as it was.
    const bad = join(work, 'bad-release');
    rmSync(bad, {recursive: true, force: true});
    cpSync(out, bad, {recursive: true});
    const about = JSON.parse(readFileSync(join(bad, 'l3.json'), 'utf8'));
    const index = JSON.parse(readFileSync(join(bad, about.index.path), 'utf8'));
    index.files[0].mode = 0o600;
    const json = Buffer.from(JSON.stringify(index));
    rmSync(join(bad, about.index.path));
    writeFileSync(join(bad, `index-${sha(json)}.json`), json);
    writeFileSync(join(bad, 'l3.json'), JSON.stringify({...about, index: {path: `index-${sha(json)}.json`, sha256: sha(json), size: json.length}}));
    tar = tarOf(bad);
    r = await go();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /this tree pins/);
    assert.deepEqual(files(join(tree, 'public/l3')), files(out));
    // The pinned l3, but not what the release's SHA256SUMS says of its file: refused too.
    tar = tarOf(out);
    sums = sha(Buffer.from('another'));
    r = await go();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SHA256SUMS of os-length3-linux-v9\.9\.9 says/);
  } finally { server.close(); }

  // On Workers Builds without the token: a branch's preview goes on without the Prompt; main's build stops and says where it goes.
  rmSync(join(tree, 'public/l3'), {recursive: true, force: true});
  const ci = (branch) => spawnSync(process.execPath, [join(tree, 'scripts/prompt-files.mjs')],
    {encoding: 'utf8', env: {...process.env, GITHUB_TOKEN: '', WORKERS_CI: '1', WORKERS_CI_BRANCH: branch, GITHUB_API_URL: 'http://127.0.0.1:9'}});
  const preview = ci('claude/some-change');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stderr, /not production\): the app is built without the Prompt/);
  assert.equal(existsSync(join(tree, 'public/l3')), false);
  const production = ci('main');
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /Settings → Build → Variables and secrets/);
});
