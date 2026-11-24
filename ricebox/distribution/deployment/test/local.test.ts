import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,zstdCompressSync} from 'node:zlib';
import {openDistribution} from '../local.ts';
import {distributionAssets} from '../assets.ts';
import {fixture} from './fixture.ts';

test('local distribution reader retains lazy range and explicit close semantics',t=>{
  const {root}=fixture(t),local=openDistribution(root);
  try {
    local.checkAll();
    const file=local.index.files[0];
    assert.equal(local.read(file).toString(),'file contents');
    const into=new Uint8Array(file.len);
    assert.equal(local.readRange(local.index.packs[0].name,file.at,file.len,into),into);
    assert.equal(new TextDecoder().decode(into),'file contents');
    local.close(); local.close();
    // Existing close releases current descriptors, but is not permanent reader disposal.
    assert.equal(local.read(file).toString(),'file contents');
  } finally { local.close(); }
});
test('local reader rejects a changed index and allows caller close after file failure',t=>{
  const {root,pack}=fixture(t),local=openDistribution(root);
  try {
    pack.bytes[pack.bytes.length-1]^=1;
    writeFileSync(join(root,'packs',pack.name),pack.bytes);
    assert.throws(()=>local.read(local.index.files[0]),/not the file its table names/);
  } finally {local.close();}
  const about=JSON.parse(readFileSync(join(root,'webroot.json'),'utf8'));
  writeFileSync(join(root,about.index.path),'{}');
  assert.throws(()=>openDistribution(root),/not the index/);
});

test('local and deployment readers reject a valid index attached to another release', t => {
  const {root} = fixture(t), file = join(root, 'webroot.json');
  const about = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({...about, version: 'another version'}));
  assert.throws(() => openDistribution(root), /distribution and index disagree/);
  assert.throws(() => distributionAssets(root), /distribution and index disagree/);
});


test('the local reader checks both the stored and decoded blob sizes', t => {
  const {root} = fixture(t), reader = openDistribution(root);
  t.after(() => reader.close());
  const decoded = Buffer.from('guest program'), stored = gzipSync(decoded);
  const sha256 = createHash('sha256').update(stored).digest('hex'), path = `blobs/${sha256}.bin`;
  const blob = {path, sha256, size: stored.length, bytes: decoded.length};
  writeFileSync(join(root, path), stored);
  assert.deepEqual(reader.blob(blob), decoded);
  assert.throws(() => reader.blob({...blob, size: blob.size + 1}), /not the stored blob/);
  assert.throws(() => reader.blob({...blob, bytes: blob.bytes + 1}), /wrong decoded size/);
});

test('a sized pack decode returns the exact member and enforces its size', t => {
  const {root} = fixture(t), reader = openDistribution(root);
  t.after(() => reader.close());
  const decoded = Buffer.alloc(128 << 10, 65), stored = zstdCompressSync(decoded);
  assert.deepEqual(reader.unzstd(stored, decoded.length), decoded);
  assert.deepEqual(reader.unzstd(stored), decoded);
  assert.deepEqual(reader.unzstd(zstdCompressSync(Buffer.alloc(0)), 0), Buffer.alloc(0));
  assert.throws(() => reader.unzstd(stored, decoded.length - 1));
  assert.throws(() => reader.unzstd(stored, decoded.length + 1), /decoded .* bytes/);
});
