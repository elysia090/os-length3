import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {publishTree} from '../publish-tree.ts';

function toolchain(t: TestContext) {
  const work = mkdtempSync(join(tmpdir(), 'ricebox producer '));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const build = join(work, 'ricebox/distribution/build'), bin = join(work, 'bin');
  mkdirSync(build, {recursive: true});
  mkdirSync(join(work, 'ricebox/sods'));
  mkdirSync(bin);
  const launcher = join(build, 'distribution.sh');
  const script = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
  copyFileSync(script('distribution.sh'), launcher);
  copyFileSync(script('publish-tree.ts'), join(build, 'publish-tree.ts'));
  writeFileSync(join(bin, 'cargo'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'cargo'), 0o755);
  writeFileSync(join(build, 'distribution.ts'), `import {mkdirSync,writeFileSync} from 'node:fs';
const [, , root, out, flag, translator] = process.argv;
if (flag!=='--translator') throw new Error('translator argument missing');
mkdirSync(out,{recursive:true}); writeFileSync(out+'/webroot.json',JSON.stringify({root,translator}));\n`);
  writeFileSync(join(build, 'muk-artifact.ts'), `import {writeFileSync} from 'node:fs';
if (process.env.FIXTURE_FAIL==='1') throw new Error('Muk fixture failed');
writeFileSync(process.argv[2]+'/muk.json','complete');\n`);
  const staging = join(work, 'private staging'), out = join(work, 'public', 'webroot');
  mkdirSync(out, {recursive: true});
  writeFileSync(join(out, 'webroot.json'), 'previous');
  writeFileSync(join(out, 'old-only'), 'only previous');
  const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, CARGO_TARGET_DIR: 'relative target', RICEBOX_STAGE_PARENT: staging};
  const run = (fail: boolean, preload?: string) => spawnSync('sh', [launcher, 'release root.tar.zst', out],
    {cwd: work, env: {...env, ...(preload ? {NODE_OPTIONS: `--import=${preload}`} : {}), FIXTURE_FAIL: fail ? '1' : '0'}, encoding: 'utf8'});
  return {work, out, staging, run};
}

test('a maker failure leaves the previous distribution unchanged', t => {
  const {out, staging, run} = toolchain(t), result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Muk fixture failed/);
  assert.equal(readFileSync(join(out, 'webroot.json'), 'utf8'), 'previous');
  assert.deepEqual(readdirSync(out).sort(), ['old-only', 'webroot.json']);
  assert.deepEqual(readdirSync(staging), []);
});

test('publishing replaces the generation, rather than keeping its stale members', t => {
  const {work, out, staging, run} = toolchain(t), result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(out).sort(), ['muk.json', 'webroot.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'webroot.json'), 'utf8')), {root: 'release root.tar.zst', translator: join(work, 'relative target/wasm32-unknown-unknown/release/sods.wasm')});
  assert.equal(readFileSync(join(out, 'muk.json'), 'utf8'), 'complete');
  assert.deepEqual(readdirSync(staging), []);
});

test('a failed restore leaves the previous tree outside the launcher cleanup', t => {
  const {work, out, staging, run} = toolchain(t);
  const preload = join(work, 'fail-renames.mjs');
  writeFileSync(preload, `
import fs from 'node:fs';
import {basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (basename(to) === 'webroot') throw new Error('injected failure from ' + basename(from));
  return rename(from, to);
};
syncBuiltinESMExports();
`);
  const result = run(false, pathToFileURL(preload).href);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /injected failure from next/);
  assert.match(result.stderr, /injected failure from previous/);
  const dirs = readdirSync(staging);
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /^\.ricebox-recovery-/);
  const recovered = join(staging, dirs[0], 'previous');
  assert.match(result.stderr, /previous copy is at/);
  assert.equal(readFileSync(join(recovered, 'webroot.json'), 'utf8'), 'previous');
  assert.equal(readFileSync(join(recovered, 'old-only'), 'utf8'), 'only previous');
  assert.deepEqual(readdirSync(join(out, '..')), []);
});

test('aliases cannot stage a recovery copy inside either generation', t => {
  const work = mkdtempSync(join(tmpdir(), 'ricebox aliases '));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const next = join(work, 'next'), old = join(work, 'old'), alias = join(work, 'alias'), safe = join(work, 'safe');
  for (const dir of [next, old, safe]) mkdirSync(dir);
  writeFileSync(join(old, 'previous'), 'intact');
  symlinkSync(old, alias, 'dir');
  assert.throws(() => publishTree(next, old, alias), /must not overlap/);
  assert.throws(() => publishTree(next, old, next), /must not overlap/);
  assert.throws(() => publishTree(next, join(next, 'missing', 'out'), safe), /must not overlap/);
  assert.deepEqual(readdirSync(next), []);
  assert.equal(readFileSync(join(old, 'previous'), 'utf8'), 'intact');
});
