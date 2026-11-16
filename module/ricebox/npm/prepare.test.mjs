import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {selectPackages, prepareDistribution} from './prepare.mjs';
function fixture(t) {
  const at = mkdtempSync(join(tmpdir(), 'ricebox-selection-'));
  t.after(() => rmSync(at, {recursive: true, force: true}));
  const cache = join(at, 'cache'); mkdirSync(cache);
  for (const n of ['base', 'extra']) {
    const p = join(cache, n); mkdirSync(join(p, 'tree/usr/bin'), {recursive: true});
    writeFileSync(join(p, 'tree/usr/bin', n), n);
    for (const [k,v] of Object.entries({version:'1.0', source:n+'-source', key:n+'-key'})) writeFileSync(join(p,k),v);
  }
  writeFileSync(join(cache,'record'), 'do not mutate\n');
  return {at, cache};
}
test('declarative selection never mutates shared caches or includes unselected packages', t => {
  const {at,cache}=fixture(t), selected=join(at,'selected');
  selectPackages(['base'],cache,selected);
  assert.equal(readFileSync(join(cache,'record'),'utf8'),'do not mutate\n');
  assert.deepEqual(readdirSync(selected),['base','record']);
  assert.match(readFileSync(join(selected,'record'),'utf8'),/^base 1.0 base-source base-key\n$/);
  assert.throws(()=>selectPackages(['../base'],cache,join(at,'bad')),/package names/);
  assert.throws(()=>selectPackages(['base','base'],cache,join(at,'bad')),/unique/);
});
test('selected packages pass through the real neutral archive assembler', t => {
  const {at,cache}=fixture(t), selected=join(at,'selected'), out=join(at,'root');
  selectPackages(['extra'],cache,selected);
  const script=fileURLToPath(new URL('../make/assemble.sh',import.meta.url));
  const r=spawnSync('sh',[script,selected,out],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const archive=join(out,readdirSync(out).find(n=>n.endsWith('.tar.zst')));
  const list=spawnSync('tar',['--zstd','-tf',archive],{encoding:'utf8'});
  assert.equal(list.status,0,list.stderr);
  assert.match(list.stdout,/root\/usr\/bin\/extra\n/);
  assert.doesNotMatch(list.stdout,/root\/usr\/bin\/base\n/);
});
test('orchestration invokes assemble then AOT and publishes only after success', async t => {
  const {at,cache}=fixture(t), toolchain=join(at,'toolchain'), make=join(toolchain,'module/ricebox/make'); mkdirSync(make,{recursive:true});
  // Contract doubles only. The preceding test exercises real archive assembly;
  // this checks the subprocess boundary, not Linux execution or translation.
  writeFileSync(join(make,'assemble.sh'),'set -eu\nmkdir -p "$2"\nprintf root > "$2/root.tar.zst"\n');
  writeFileSync(join(make,'layers.sh'),'set -eu\nmkdir -p "$2"\nprintf "%s\\n" "$@" > "$2/arguments"\n');
  const output=join(at,'out');
  await prepareDistribution({packages:['base'],packageCache:cache,toolchain,output,cache:join(at,'aot'),hot:['/usr/bin/base']});
  assert.match(readFileSync(join(output,'arguments'),'utf8'),/--cache\n.*\/aot\n--hot\n\/usr\/bin\/base/);
  await assert.rejects(prepareDistribution({packages:['base'],packageCache:cache,toolchain,output}),/already exists/);
  writeFileSync(join(make,'layers.sh'),'exit 4\n');
  await assert.rejects(prepareDistribution({packages:['base'],packageCache:cache,toolchain,output:join(at,'failed')}),/failed/);
  assert.equal(existsSync(join(at,'failed')),false);
  assert.equal(readdirSync(at).some(n=>n.startsWith('.ricebox-build-')),false);
});

test('pinned prebuilt tools compose real layers without cargo or a C build', async t => {
  const {createHash} = await import('node:crypto');
  const {distributionAssets} = await import('./vite.mjs');
  const {at, cache} = fixture(t);
  const artifact = (name, bytes) => {
    const path = join(at,name); writeFileSync(path,bytes);
    return {path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  };
  // Nonexecutable package fixture: no program is claimed to run or translate.
  // Real assemble, layers, manifest and pack validation are exercised here.
  const tools = {
    translator: artifact('translator.wasm',Buffer.from([0,97,115,109,1,0,0,0])),
    sods: artifact('sods',Buffer.from('not invoked: no executable fixture')),
    muk: artifact('muk',Buffer.from('maker fixture')),
  };
  const output=join(at,'layers');
  await prepareDistribution({packages:['base'],packageCache:cache,tools,output,cache:''});
  const assets=distributionAssets(output);
  assert.ok(assets.has('ricebox/muk.json'));
  assert.ok([...assets.keys()].some(n=>n.startsWith('ricebox/packs/')));
  tools.translator.sha256='0'.repeat(64);
  await assert.rejects(prepareDistribution({packages:['base'],packageCache:cache,tools,output:join(at,'bad')}),/integrity mismatch/);
  assert.equal(existsSync(join(at,'bad')),false);
});
