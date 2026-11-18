import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {distributionAssets} from '../assets.ts';
import {fixture} from './fixture.ts';

test('connects only manifest-listed assets, no secrets or product paths', t => {
  const {root} = fixture(t), files = distributionAssets(root);
  assert.equal(files.size, 6);
  assert.ok([...files.keys()].every(p => p.startsWith('ricebox/')));
  assert.ok(![...files.keys()].some(p => /why|\.env/.test(p)));
});
test('rejects a changed translator before emission', t => {
  const {root, translator} = fixture(t);
  writeFileSync(join(root, translator.path), 'translatox');
  assert.throws(() => distributionAssets(root), /wrong digest/);
});
test('fails before deployment when asset limit is exceeded', t => {
  const {root} = fixture(t);
  assert.throws(() => distributionAssets(root, {maxAssetBytes: 1}), /deployment asset limit/);
});
test('refuses missing maker instead of producing a broken first launch', t => {
  const {root} = fixture(t); rmSync(join(root, 'muk.json'));
  assert.throws(() => distributionAssets(root), /ENOENT/);
});
test('refuses symbolic links and path escape declarations', t => {
  const {root, translator} = fixture(t);
  const bytes = readFileSync(join(root, translator.path));
  rmSync(join(root, translator.path)); writeFileSync(join(root,'outside'),bytes);
  symlinkSync('../outside', join(root, translator.path));
  assert.throws(() => distributionAssets(root), /symbolic link/);
  assert.throws(() => distributionAssets(root, {base:'../oops'}), /relative asset directory/);
});
test('rejects a pack with changed bytes using the shared pack verifier', t => {
  const {root, pack} = fixture(t);
  pack.bytes[pack.bytes.length - 1] ^= 1;
  writeFileSync(join(root,'packs',pack.name),pack.bytes);
  assert.throws(() => distributionAssets(root), /not the file its table names/);
});

test('staging rejects old selected indexes and mixed names instead of omitting the store', t => {
  const {root}=fixture(t),about=JSON.parse(readFileSync(join(root,'webroot.json'),'utf8'));
  const original=JSON.parse(readFileSync(join(root,about.index.path),'utf8'));
  for(const selection of [{fileCore:null},{fileCore:false},{fileCore:{}},{fileCore:{},fileStore:{}}]) {
    const bytes=Buffer.from(JSON.stringify({...original,...selection})),sha256=createHash('sha256').update(bytes).digest('hex'),path=`index-${sha256}.json`;
    writeFileSync(join(root,path),bytes);writeFileSync(join(root,'webroot.json'),JSON.stringify({...about,index:{path,sha256,size:bytes.length}}));
    assert.throws(()=>distributionAssets(root),/fileCore.*regenerate/);
  }
});

test('collects only the capture asset selected by the distribution index', t => {
  const {root} = fixture(t);
  const about = JSON.parse(readFileSync(join(root, 'webroot.json'), 'utf8'));
  const original = JSON.parse(readFileSync(join(root, about.index.path), 'utf8'));
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const expanded = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  const stored = gzipSync(expanded), sha256 = digest(stored);
  const selected = {kind: 'sods-linux-capture-result-v3', host: 'linux-x64-node22-24',
    path: `blobs/${sha256}.bin`, size: stored.length, sha256, bytes: expanded.length, wasm: digest(expanded)};
  const publish = (captureResult: unknown) => {
    const bytes = Buffer.from(JSON.stringify({...original, captureResult})), sha256 = digest(bytes);
    const path = `index-${sha256}.json`;
    writeFileSync(join(root, path), bytes);
    writeFileSync(join(root, 'webroot.json'), JSON.stringify({...about, index: {path, sha256, size: bytes.length}}));
  };
  writeFileSync(join(root, selected.path), stored);
  assert.equal(distributionAssets(root).has(`ricebox/${selected.path}`), false, 'unselected bytes grant no inclusion');
  publish(selected);
  assert.deepEqual(distributionAssets(root).get(`ricebox/${selected.path}`), stored);
  publish({...selected, wasm: '0'.repeat(64)});
  assert.throws(() => distributionAssets(root), /expanded Wasm digest mismatch/);
  publish({...selected, host: 'workerd'});
  assert.throws(() => distributionAssets(root), /capture result descriptor/);
  publish(selected);
  rmSync(join(root, selected.path));
  assert.throws(() => distributionAssets(root), /ENOENT/);
  writeFileSync(join(root, 'outside'), stored);
  symlinkSync('../outside', join(root, selected.path));
  assert.throws(() => distributionAssets(root), /symbolic link/);
});
