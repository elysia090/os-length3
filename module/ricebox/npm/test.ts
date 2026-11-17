import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import ricebox, {distributionAssets} from './vite.ts';
import {packOf} from '../layers/table.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'ricebox-assets-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'blobs')); mkdirSync(join(root, 'packs'));
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const blob = (text: string) => { const bytes = Buffer.from(text), sha256 = hash(bytes); const path = `blobs/${sha256}.bin`; writeFileSync(join(root, path), bytes); return {path, sha256, size: bytes.length}; };
  const translator = blob('translator'), muk = blob('maker');
  const pack = packOf([Buffer.from('file contents')], b => createHash('sha256').update(b).digest());
  writeFileSync(join(root, 'packs', pack.name), pack.bytes);
  const index = {sha256: 'root', version: '0.0.1', translator, translations: [], packs: [{name:pack.name,bytes:pack.bytes.length}], files: [{pack:0,at:pack.at[0],len:13}]};
  const bytes = Buffer.from(JSON.stringify(index)), sha256 = hash(bytes), path = `index-${sha256}.json`;
  writeFileSync(join(root, path), bytes);
  writeFileSync(join(root, 'webroot.json'), JSON.stringify({sha256:'root', version:'0.0.1', index: {path, sha256, size:bytes.length}}));
  writeFileSync(join(root, 'muk.json'), JSON.stringify(muk));
  writeFileSync(join(root, '.env'), 'must never be deployed');
  return {root, translator, pack};
}

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
test('uses ES Workers and emits existing AOT distribution unchanged', t => {
  const {root} = fixture(t), plugin = ricebox({distribution:root,base:'runtime/assets'}), emitted: {type: string; fileName: string}[]=[];
  assert.equal(plugin.config().worker.format,'es');
  plugin.generateBundle.call({emitFile: a => emitted.push(a)});
  assert.equal(emitted.length,6);
  assert.ok(emitted.every(a => a.type === 'asset' && a.fileName.startsWith('runtime/assets/')));
});

test('rejects a pack with changed bytes using the shared pack verifier', t => {
  const {root, pack} = fixture(t);
  pack.bytes[pack.bytes.length - 1] ^= 1;
  writeFileSync(join(root,'packs',pack.name),pack.bytes);
  assert.throws(() => distributionAssets(root), /not the file its table names/);
});
