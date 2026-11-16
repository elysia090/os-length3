import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkedRange, packOf} from '../layers/table.ts';
const hash = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

test('verified table does not retain a view into a full HTTP 200 response', () => {
  const files = [new Uint8Array(4096).fill(17), new Uint8Array(8192).fill(23)];
  const pack = packOf(files, hash);
  const index = {packs: [{name: pack.name, bytes: pack.bytes.length}], files: files.map((b,i) => ({pack: 0, at: pack.at[i], len: b.length}))};
  const response = pack.bytes.slice();
  let tables = 0;
  const read = checkedRange(index, (_name, at, length) => {
    if (at === 0) { tables++; return response.subarray(0, length); }
    return pack.bytes.subarray(at, at + length);
  }, hash);
  assert.deepEqual(read(0, pack.at[0], files[0].length), files[0]);
  // The provider reuses/releases its response after the reader accepted its table.
  response.fill(0);
  assert.deepEqual(read(0, pack.at[0], files[0].length), files[0]);
  assert.deepEqual(read(0, pack.at[1], files[1].length), files[1]);
  assert.equal(tables, 1);
});

test('compacting a table does not admit a wrong table or corrupt file', () => {
  const file = new Uint8Array(4096).fill(17), pack = packOf([file], hash);
  const index = {packs: [{name: pack.name, bytes: pack.bytes.length}], files: [{pack: 0, at: pack.at[0], len: file.length}]};
  const wrong = pack.bytes.slice(); wrong[0] ^= 1;
  assert.throws(() => checkedRange(index, (_name, at, length) => wrong.subarray(at, at + length), hash)(0, pack.at[0], file.length), /table/);
  const corrupt = pack.bytes.slice(); corrupt[pack.at[0]] ^= 1;
  assert.throws(() => checkedRange(index, (_name, at, length) => corrupt.subarray(at, at + length), hash)(0, pack.at[0], file.length), /file/);
});
test('verified exact-size table is owned even when provider reuses its buffer', () => {
  const file=new Uint8Array([1]),other=new Uint8Array([2]),pack=packOf([file],hash);
  const index={packs:[{name:pack.name,bytes:pack.bytes.length}],files:[{pack:0,at:pack.at[0],len:1}]};
  const table=pack.bytes.slice(0,32);let changed=false;
  const read=checkedRange(index,(_name,at)=>at===0?table:changed?other:file,hash);
  assert.deepEqual(read(0,pack.at[0],1),file);
  table.set(hash(other));changed=true;
  assert.throws(()=>read(0,pack.at[0],1),/file/);
});
