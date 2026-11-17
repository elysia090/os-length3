import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadFileScope} from '../../runtime/linux/core-files.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import type {Vfs} from '../../runtime/linux/fs.ts';
const wasm = process.env.SODS_CORE_WASM, enc = new TextEncoder(), dec = new TextDecoder();
const call = (p: Process, nr: number, ...args: number[]) => p.syscall(BigInt(nr),
  ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
function processFor(vfs: Vfs) {
  const k = new Kernel({vfs, translate() { throw Error('unused'); }, console: {write() {}, read: () => null}});
  const p = new Process(k, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}

test('zero links and closed fd still retain a split shared mapping and an embedding handle', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 8192), vfs = scope.createVfs(), p = processFor(vfs);
  try {
    const file = vfs.writeFile('/tmp/a', new Uint8Array(8192).fill(65));
    p.bytes.set(enc.encode('/tmp/a\0'), 1024); p.bytes.set(enc.encode('/tmp/b\0'), 2048);
    assert.equal(call(p, 86, 1024, 2048), 0n); // link
    assert.equal(file.nlink, 2);
    const fd = Number(call(p, 2, 1024, 2)); assert.ok(fd >= 0);
    assert.equal(call(p, 9, 8192, 8192, 3, 0x11, fd, 0), 8192n);
    assert.equal(call(p, 87, 1024), 0n); assert.equal(file.nlink, 1);
    assert.equal(vfs.file('/tmp/b'), file);
    assert.equal(call(p, 87, 2048), 0n); assert.equal(file.nlink, 0);
    assert.equal(call(p, 3, fd), 0n);
    // unmapShared removes the old map before constructing the surviving suffix.
    assert.equal(call(p, 11, 8192, 4096), 0n);
    assert.equal(file.maps?.size, 1);
    p.bytes[12288] = 90;
    assert.equal(file.read(4096, 4097)[0], 90);
    assert.equal(call(p, 11, 12288, 4096), 0n);
    assert.equal(file.maps?.size ?? 0, 0);
    // The host received File from writeFile: it remains usable until scope end.
    file.write(0, enc.encode('host'));
    assert.equal(dec.decode(file.read(0, 4)), 'host');
  } finally { scope.dispose(); }
});

test('unlinked prebuilt image retains a deferred source even without namespace or descriptor', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 32), vfs = scope.createVfs(), p = processFor(vfs);
  try {
    let loads = 0;
    const file = scope.lazyFile(vfs, '/tmp/image', () => { loads++; return enc.encode('deferred'); });
    // Minimal metadata module exercises Image/readLater, not CPU execution.
    const name = enc.encode('sods.facts'), facts = enc.encode('{}');
    const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,0,1+name.length+facts.length,name.length,...name,...facts]));
    p.kernel.prebuilt(file, module);
    const image = p.kernel.images.get(file)!.image;
    p.bytes.set(enc.encode('/tmp/image\0'), 1024);
    assert.equal(call(p, 87, 1024), 0n); assert.equal(file.nlink, 0); assert.equal(loads, 0);
    // Worker keeps Image observers separately from Kernel.images. Cache deletion
    // and ended() therefore cannot be used as deferred-source release events.
    p.kernel.images.delete(file); p.kernel.ended();
    assert.equal(p.kernel.images.size, 0);
    assert.equal(dec.decode(image.source!()), 'deferred'); assert.equal(loads, 1);
    assert.equal(dec.decode(image.source!()), 'deferred'); assert.equal(loads, 1);
  } finally { scope.dispose(); }
});


test('raw namespace changes are not a reliable link-count ownership ledger', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 8), vfs = scope.createVfs();
  try {
    const file = vfs.writeFile('/tmp/a', 'old'), dir = vfs.dir('/tmp');
    dir.entries.set('b', file);
    assert.equal(file.nlink, 1); // Two actual namespace edges, one POSIX metadata value.
    dir.entries.delete('a'); assert.equal(vfs.file('/tmp/b'), file);
    dir.entries.clear(); assert.equal(file.nlink, 1); // No namespace edge remains.
    assert.equal(dec.decode(file.bytes()), 'old'); // Raw embedding ownership still exists.
  } finally { scope.dispose(); }
});

test('deferred capture retains its source through failure, then works after owner disposal', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 32), vfs=scope.createVfs(), p=processFor(vfs);
  let fail=true, loads=0;
  const file=scope.lazyFile(vfs,'/tmp/image',()=>{loads++;if(fail)throw Error('source unavailable');return enc.encode('old');});
  const name=enc.encode('sods.facts'), facts=enc.encode('{}');
  const module=new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,0,1+name.length+facts.length,name.length,...name,...facts]));
  p.kernel.prebuilt(file,module); const image=p.kernel.images.get(file)!.image;
  try {
    assert.throws(()=>image.source!()); assert.equal(loads,1);
    fail=false; const captured=image.source!(); assert.equal(dec.decode(captured),'old'); assert.equal(loads,2);
    file.write(0,enc.encode('new')); assert.equal(dec.decode(image.source!()),'old');
    p.kernel.images.delete(file); vfs.dir('/tmp').entries.delete('image'); p.kernel.ended();
    // Deliberately end this finite owner to demonstrate the captured byte path
    // no longer accesses it. This is not permission to dispose a live shared tree.
    scope.dispose(); assert.equal(image.source!(),captured); assert.equal(loads,2);
  } finally {scope.dispose();}
});
