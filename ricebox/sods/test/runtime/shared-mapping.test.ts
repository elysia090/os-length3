import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, type Mapping} from '../../runtime/linux/fs.ts';

function world(C: typeof File) { return {file: new C(new Uint8Array(256)), maps: [] as Mapping[]}; }
function map(w: ReturnType<typeof world>, off: number, length: number) {
  const bytes = new Uint8Array(length + 16);
  bytes.set(w.file.read(off, off + length), 8);
  const m = {proc: {bytes}, start: 8, off, length};
  w.file.map(m); w.maps.push(m);
}
test('different writers merge nonoverlapping bytes and file writes remain visible', () => {
  const w = world(File); map(w, 0, 256); map(w, 0, 256);
  w.maps[0].proc.bytes[8] = 7; w.maps[1].proc.bytes[9] = 8;
  w.file.settle();
  assert.deepEqual([...w.file.data.slice(0, 2)], [7, 8]);
  w.file.write(2, Uint8Array.of(9));
  for (const m of w.maps) assert.deepEqual([...m.proc.bytes.slice(8,11)], [7,8,9]);
});
test('equal extents reuse the existing baseline without another full-length allocation', () => {
  const w = world(File); map(w,0,256); map(w,0,256);
  assert.equal(w.maps[0].seen!, w.maps[1].seen!);
});
test('registering the same record again resets a dirty baseline', () => {
  const w=world(File); map(w,0,256); const m=w.maps[0], old=m.seen;
  m.proc.bytes[8]=77; w.file.map(m);
  assert.notEqual(m.seen,old); assert.equal(w.file.maps!.size,1);
  w.file.settle(); assert.equal(w.file.data[0],0);
});
test('equal declared extents with different actual lengths do not share', () => {
  const file = new File(new Uint8Array(8));
  const full: Mapping = {proc: {bytes: new Uint8Array(8)}, start: 0, off: 0, length: 8};
  const short: Mapping = {proc: {bytes: new Uint8Array(4)}, start: 0, off: 0, length: 8};
  file.map(full);
  assert.doesNotThrow(() => file.map(short));
  assert.notEqual(full.seen, short.seen);
  assert.equal(short.seen!.length, 4);
});
test('mixed extents use a bounded fast path and follow the first surviving mapping', () => {
  const w=world(File); map(w,0,16); map(w,32,16); map(w,32,16);
  const [first,second,third]=w.maps;
  assert.notEqual(second.seen,third.seen); // Do not scan all extents to find a match.
  w.file.unmap(first); w.maps.shift(); map(w,32,16);
  assert.equal(w.maps.at(-1)!.seen,second.seen);
  third.proc.bytes[8]=51; w.file.settle();
  for(const m of w.maps) assert.equal(m.proc.bytes[8],51);
});
test('mutable aliases preserve the previous baseline contract', () => {
  for(const alias of ['constructor','read','data','share']) {
    const worlds=[File].map(C=>{ const bytes=new Uint8Array(256); const w={file:new C(bytes),maps:[] as Mapping[]}; map(w,0,256); return {w,bytes}; });
    for(const {w,bytes} of worlds) {
      const view=alias==='constructor'?bytes:alias==='read'?w.file.read(0,256):alias==='share'?w.file.share():w.file.data;
      view[0]=9;
      map(w,0,256); // The second mapping sees a different starting value.
      assert.notEqual(w.maps[0].seen!,w.maps[1].seen!);
      w.file.settle();
    }
    assert.equal(worlds[0].w.file.data[0],9,alias);
    assert.equal(worlds[0].w.maps[0].proc.bytes[8],0,alias);
    assert.equal(worlds[0].w.maps[1].proc.bytes[8],9,alias);
  }
});
test('shared baseline survives one owner leaving and does not pin a larger extent', () => {
  const w=world(File); map(w,0,256); map(w,0,256);
  const [first,second]=w.maps;
  w.file.unmap(first); w.maps.shift(); second.proc.bytes[8+10]=7;
  w.file.settle(); assert.equal(w.file.data[10],7);
  map(w,0,16); const small=w.maps.at(-1)!;
  assert.notEqual(small.seen!.buffer,second.seen!.buffer);
  assert.equal(small.seen!.buffer.byteLength,16);
  w.file.truncate(4); w.file.truncate(256);
  assert.equal(second.proc.bytes[8+10],0);
  w.file.write(2,Uint8Array.of(11));
  assert.equal(small.proc.bytes[8+2],11);
  const kept=w.file.share(); second.proc.bytes[8+3]=12; w.file.settle();
  assert.equal(kept[3],0); assert.equal(w.file.data[3],12);
});
test('fork copies after settling, split unmap retains both surviving segments, remap grows', () => {
  for (const C of [File]) {
    const w=world(C); map(w,0,128);
    const parent=w.maps[0]; parent.proc.bytes[8+17]=41;
    w.file.settle(0,128,parent);
    const child={...parent,proc:{bytes:parent.proc.bytes.slice()}};
    w.file.map(child); w.maps.push(child);
    child.proc.bytes[8+18]=42;
    w.file.settle(0,128,child);
    assert.equal(parent.proc.bytes[8+18],42);
    w.file.unmap(parent);
    const left={proc:parent.proc,start:8,off:0,length:32};
    const right={proc:parent.proc,start:8+64,off:64,length:64};
    w.file.map(left); w.file.map(right);
    w.file.write(40,Uint8Array.of(43));
    assert.equal(parent.proc.bytes[8+40],0);
    assert.equal(child.proc.bytes[8+40],43);
    const moved={proc:{bytes:new Uint8Array(256)},start:0,off:0,length:256};
    moved.proc.bytes.set(child.proc.bytes.subarray(8,136));
    w.file.unmap(child);
    moved.proc.bytes.set(w.file.read(128,256),128);
    w.file.map(moved);
    moved.proc.bytes[200]=44; w.file.settle(0,256,moved);
    assert.equal(w.file.data[200],44);
    for(const m of [left,right,moved]) w.file.unmap(m);
    assert.equal(w.file.maps,null);
  }
});
