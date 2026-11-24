import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomFillSync} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {canonicalExecutableSource, webExecutableSources} from '../../format/executable-source.ts';
import {openDistribution, visitDistributionAssets} from '../../deployment/local.ts';
import {FRAMED_MIN_BYTES} from '../framed-aot.ts';
import {aotFraming, aotObjects} from '../../format/aot-frames.ts';
import {standIn, makeWebroot} from '../../test/fixtures/distribution.ts';

// Real archive reader, packing, AOT CLI boundary, blob and manifest producer;
// stand-in ELF/translator deliberately do not claim execution correctness.
test('actual producer binds its captured hot bytes to the canonical placed entry', () => {
  const work = mkdtempSync(join(tmpdir(), 'ricebox-association-')), out = join(work, 'layers');
  try {
    const root = standIn(work, '9.9.9'), result = makeWebroot(root, out, work);
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const web = openDistribution(out);
    try {
      const translation = web.index.translations[0], source = canonicalExecutableSource(web.index, translation);
      const file = web.index.files.find(f => f.path === translation.path)!;
      const elf = gunzipSync(readFileSync(join(out, translation.elf.path)));
      assert.equal(source.binding, 'explicit');
      assert.deepEqual(translation.association, {version: 1, origin: `${web.index.packs[file.pack].name.slice(0, -5)}_${file.at}_${file.len}`,
        sourceSha256: createHash('sha256').update(elf).digest('hex'), sourceBytes: elf.length, mode: 'whole'});
      assert.equal(source.sha256, translation.sha256);
      assert.equal(source.size, file.size);
      assert.equal(source.size, translation.elf.bytes);
      assert.equal(elf.subarray(0, 4).toString(), '\x7fELF');
      const alias = web.index.files.find(f => f.path === '/usr/bin/busybox.same')!;
      assert.deepEqual([alias.pack, alias.at, alias.len, alias.size], [file.pack, file.at, file.len, file.size]);
      assert.equal(canonicalExecutableSource(web.index, {...translation, path: alias.path}).origin, source.origin);
      const legacy = {...translation}; delete legacy.association;
      assert.equal(canonicalExecutableSource(web.index, legacy).binding, 'legacy-derived');
    } finally { web.close(); }
  } finally { rmSync(work, {recursive: true, force: true}); }
});

test('deployment prepares every packaged executable and the maker with one entry per hardlinked file', t => {
  const work = mkdtempSync(join(tmpdir(), 'ricebox-deploy-')), out = join(work, 'layers');
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const other = Buffer.from('\x7fELF user program');
  const root = standIn(work, '9.9.9', directory => {
    writeFileSync(join(directory, 'usr/bin/customer'), other, {mode: 0o755});
    writeFileSync(join(directory, 'usr/bin/data'), other, {mode: 0o644});
    writeFileSync(join(directory, 'usr/bin/script'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  });
  const maker = join(work, 'maker');
  writeFileSync(maker, Buffer.from('\x7fELF maker'));
  // This fixture still passes --hot for BusyBox. The inventory also includes
  // the customer's program and excludes data and the hardlink's second name.
  const result = makeWebroot(root, out, work, ['--deploy', '--maker', maker]);
  assert.equal(result.status, 0, result.stderr);
  const assets: string[] = [];
  const {index, maker: made} = visitDistributionAssets(out, {}, path => assets.push(path));
  assert.deepEqual(index.translations, []);
  assert.deepEqual(index.execution?.maker, made);
  assert.deepEqual([...webExecutableSources(index).values()].map(({source}) => source.path), ['/usr/bin/busybox', '/usr/bin/customer']);
  const blobs = [index.translator, made, ...index.execution!.programs.map(t => t.wasm)];
  assert.deepEqual(assets.filter(path => path.includes('/blobs/')).sort(), [...new Set(blobs.map(blob => `ricebox/${blob.path}`))].sort());
  assert.equal(WebAssembly.validate(readFileSync(join(out, made.path))), true);
});

test('paired opt-in stages cap-sized shards while ordinary and small output remain compatible', t => {
  const work = mkdtempSync(join(tmpdir(), 'ricebox-deploy-framed-')), out = join(work, 'layers');
  t.after(() => rmSync(work, {recursive: true, force: true}));
  const root = standIn(work, '9.9.9', directory => {
    writeFileSync(join(directory, 'usr/bin/compiler'), Buffer.from('\x7fELF large fixture'), {mode: 0o755});
  });
  const small = join(work, 'small.wasm'), large = join(work, 'large.wasm'), translator = join(work,'sods');
  const empty = Buffer.from([0,97,115,109,1,0,0,0]);
  writeFileSync(small, empty);
  // A well-formed custom section makes the standard size policy test cheap.
  const size = FRAMED_MIN_BYTES, body = Buffer.alloc(size);
  randomFillSync(body.subarray(1)); // first byte is the empty custom-section name
  const len: number[] = [];
  let n = size;
  for (; n > 127; n >>>= 7) len.push((n & 127) | 128);
  len.push(n);
  writeFileSync(large, Buffer.concat([empty, Buffer.from([0, ...len]), body]));
  writeFileSync(translator, `#!${process.execPath}\nconst f=require('node:fs');const out=f.readFileSync(process.argv.at(-2)).includes('large fixture')?${JSON.stringify(large)}:${JSON.stringify(small)};f.copyFileSync(out,process.argv.at(-1));\n`, {mode:0o755});
  const cli = fileURLToPath(new URL('../distribution.ts', import.meta.url));
  const publish = (where: string, extra: string[]) => {
    const run = spawnSync(process.execPath, [cli, root, where, '--deploy', '--maker', small, '--translator', small,
      '--sods', translator, '--cache', '', ...extra], {encoding:'utf8'});
    assert.equal(run.status, 0, run.stderr);
  };
  const compatible = join(work,'legacy');
  publish(compatible,[]);
  assert.ok(visitDistributionAssets(compatible,{},()=>{}).index.execution?.programs.every(t => !aotFraming(t.wasm)));
  publish(out,['--framed-aot']);
  const names: string[] = [];
  const {index} = visitDistributionAssets(out, {maxAssetBytes: 25 << 20}, path => names.push(path));
  const compiler = index.execution!.programs.find(p => p.path.endsWith('/compiler'))!;
  const busybox = index.execution!.programs.find(p => p.path.endsWith('/busybox'))!;
  const framed = aotFraming(compiler.wasm)!;
  assert.ok(framed.code.length > 2);
  assert.equal(aotFraming(busybox.wasm), undefined);
  const objects = aotObjects(compiler.wasm);
  assert.ok(objects.length >= 3);
  assert.ok(compiler.wasm.size > (25 << 20));
  assert.ok(objects.every(p => p.size <= (16 << 20)));
  assert.ok(!names.includes('ricebox/' + compiler.wasm.path), 'no aggregate compiler file is staged');
  for (const object of objects) assert.equal(names.filter(path => path === 'ricebox/' + object.path).length, 1);
  assert.equal(names.filter(path => path === 'ricebox/' + busybox.wasm.path).length, 1);

  // The entire blob still has its correct content digest. An authenticated
  // but internally inconsistent frame list must not pass static staging.
  framed.code[1]!.sha256 = 'a'.repeat(64);
  const json = Buffer.from(JSON.stringify(index)), sha256 = createHash('sha256').update(json).digest('hex');
  const descriptor = {sha256, path: `index-${sha256}.json`, size: json.length};
  const about = JSON.parse(readFileSync(join(out,'webroot.json'),'utf8'));
  writeFileSync(join(out,descriptor.path),json);
  writeFileSync(join(out,'webroot.json'),JSON.stringify({...about,index:descriptor}));
  const kept:string[] = [];
  assert.throws(()=>visitDistributionAssets(out,{},path=>kept.push(path)), /wrong frame digest/);
  assert.ok(!kept.includes('ricebox/' + objects.find(p => 'at' in p && p.at <= framed.code[1]!.at &&
    p.at + p.size > framed.code[1]!.at)!.path));
});
