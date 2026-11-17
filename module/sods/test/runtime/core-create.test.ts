import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {Vfs,FsError,E} from '../../runtime/linux/fs.ts';
import {Kernel,Process} from '../../runtime/linux/process.ts';
import {loadFileScope} from '../../runtime/linux/core-files.ts';
const wasm=process.env.SODS_CORE_WASM,enc=new TextEncoder(),dec=new TextDecoder();
const call=(p:Process,nr:number,...args:number[])=>p.syscall(BigInt(nr),...([...args,0,0,0,0,0,0].slice(0,6).map(BigInt) as [bigint,bigint,bigint,bigint,bigint,bigint]));
const errno=(n:number)=>(e:unknown)=>e instanceof FsError&&e.errno===n;
function processFor(vfs:Vfs) {
  const p=new Process(new Kernel({vfs,translate(){throw Error('unused');},console:{write(){},read:()=>null}}),null);
  p.memory=Object.assign(new WebAssembly.Memory({initial:1}),{users:1,written:[],keeps:false,imageOf:null});return p;
}
test('explicit scoped tree covers writeFile/O_CREAT/regular mknod without changing default storage',{skip:!wasm},async()=>{
  const scope=await loadFileScope(readFileSync(wasm!),8),vfs=scope.createVfs(),p=processFor(vfs);
  try {
    const direct=vfs.writeFile('/tmp/direct','abc');assert.throws(()=>direct.data,errno(E.OPNOTSUPP));
    const plain=new Vfs().writeFile('/tmp/plain','abc');assert.equal(dec.decode(plain.data),'abc');
    p.bytes.set(enc.encode('/tmp/created\0'),1024);
    const fd=Number(call(p,2,1024,0x42,0o600));assert.ok(fd>=0);
    const original=vfs.file('/tmp/created');assert.throws(()=>original.data,errno(E.OPNOTSUPP));
    p.bytes.set(enc.encode('old'),4096);assert.equal(call(p,1,fd,4096,3),3n);
    const replacement=vfs.writeFile('/tmp/created','new');assert.notEqual(original,replacement);
    assert.equal(call(p,17,fd,4096,3,0),3n);assert.equal(dec.decode(p.bytes.subarray(4096,4099)),'old');
    assert.equal(dec.decode(replacement.bytes()),'new');
    assert.equal(call(p,18,fd,4096,3,7),-27n);assert.equal(dec.decode(original.bytes()),'old');
    assert.equal(call(p,3,fd),0n);assert.equal(dec.decode(original.bytes()),'old');
    p.bytes.set(enc.encode('/tmp/node\0'),1024);assert.equal(call(p,133,1024,0o100640,0),0n);
    assert.throws(()=>vfs.file('/tmp/node').data,errno(E.OPNOTSUPP));
    p.bytes.set(enc.encode('/tmp/fifo\0'),1024);assert.equal(call(p,133,1024,0o010600,0),0n);
    assert.equal(vfs.lookup('/tmp/fifo').mode&0o170000,0o010000);
  } finally {scope.dispose();}
  assert.throws(()=>scope.createVfs(),/closed/);
  assert.throws(()=>vfs.writeFile('/after/closed','x'),/closed/);
  assert.throws(()=>vfs.lookup('/after'),errno(E.NOENT));
});
test('scoped tree limit failure preserves an existing entry and does not publish a new file',{skip:!wasm},async()=>{
  const scope=await loadFileScope(readFileSync(wasm!),2),vfs=scope.createVfs();
  try {
    const old=vfs.writeFile('/tmp/a','ok');
    assert.throws(()=>vfs.writeFile('/tmp/a','bad'),errno(E.FBIG));assert.equal(vfs.file('/tmp/a'),old);
    assert.throws(()=>vfs.writeFile('/new/failed','bad'),errno(E.FBIG));assert.throws(()=>vfs.lookup('/new'),errno(E.NOENT));
  } finally {scope.dispose();}
});

test('explicit scope.writeFile retires an inode rejected by namespace publication',{skip:!wasm},async()=>{
  const scope=await loadFileScope(readFileSync(wasm!),8),vfs=new Vfs(),dir=vfs.dir('/tmp');
  const set=dir.entries.set;let rejected:ReturnType<Vfs['writeFile']>|undefined;
  dir.entries.set=function(_name,node){rejected=node as typeof rejected;throw Error('entry refused');};
  try {
    assert.throws(()=>scope.writeFile(vfs,'/tmp/refused','abc'),/entry refused/);
    assert.ok(rejected);assert.throws(()=>rejected!.bytes(),/closed/);
    assert.equal(dir.entries.has('refused'),false);
  } finally {dir.entries.set=set;scope.dispose();}
});


test('explicit lazy creation retires its source when namespace publication is rejected', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 8), vfs = new Vfs(), dir = vfs.dir('/tmp');
  const set = dir.entries.set; let rejected: ReturnType<Vfs['writeFile']> | undefined, loads = 0;
  dir.entries.set = function(_name, node) { rejected = node as typeof rejected; throw Error('entry refused'); };
  try {
    assert.throws(() => scope.lazyFile(vfs, '/tmp/refused', () => { loads++; return enc.encode('abc'); }), /entry refused/);
    assert.ok(rejected); assert.throws(() => rejected!.bytes(), /closed/);
    assert.equal(loads, 0); assert.equal(dir.entries.has('refused'), false);
  } finally { dir.entries.set = set; scope.dispose(); }
});

for (const route of ['writeFile', 'open', 'mknod', 'mount'] as const) {
  test(`pending Rust inode is retired on rejected ${route} publication`, {skip: !wasm}, async () => {
    const scope = await loadFileScope(readFileSync(wasm!), 8), vfs = scope.createVfs(), p = processFor(vfs), dir = vfs.dir('/tmp');
    const set = dir.entries.set; let rejected: ReturnType<Vfs['writeFile']> | undefined, loads = 0;
    dir.entries.set = function(_name, node) { rejected = node as typeof rejected; throw Error('entry refused'); };
    p.bytes.set(enc.encode('/tmp/refused\0'), 1024);
    try {
      assert.throws(() => {
        if (route === 'writeFile') vfs.writeFile('/tmp/refused', 'abc');
        if (route === 'open') call(p, 2, 1024, 0x42, 0o600);
        if (route === 'mknod') call(p, 133, 1024, 0o100600, 0);
        if (route === 'mount') scope.mountTarget(vfs).file('/tmp/refused', 0o644, 3, () => { loads++; return enc.encode('abc'); }, 'fixture');
      }, /entry refused/);
      assert.ok(rejected); assert.throws(() => rejected!.bytes(), /closed/);
      assert.equal(loads, 0); assert.equal(dir.entries.has('refused'), false);
    } finally { dir.entries.set = set; scope.dispose(); }
  });
}

test('a published inode survives failure of the later open operation', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 8), vfs = scope.createVfs(), p = processFor(vfs);
  try {
    p.bytes.set(enc.encode('/tmp/created\0'), 1024);
    // Preserve current runtime semantics: publication precedes O_DIRECTORY check.
    assert.equal(call(p, 2, 1024, 0x40 | 0x10000, 0o600), -20n);
    const file = vfs.file('/tmp/created'); file.write(0, enc.encode('ok'));
    assert.equal(dec.decode(file.bytes()), 'ok');
  } finally { scope.dispose(); }
});
