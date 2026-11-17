import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openDistribution} from '../local.ts';
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
