import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadFileScope} from '../../runtime/linux/file-scope.ts';
import {Kernel, Process, SHARES, type Task} from '../../runtime/linux/process.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {Vfs} from '../../runtime/linux/fs.ts';
const enc=new TextEncoder(), dec=new TextDecoder();
function kernel(vfs=new Vfs()){return new Kernel({vfs,translate(){throw Error('unused');},console:{write(){},read:()=>null}});}
function processFor(k:Kernel){const p=new Process(k,null);p.fixed=[];p.mapBase=8192;p.mapEnd=65536;p.stackLow=4096;p.stackTop=8192;return p;}
function memory(users=1){return Object.assign(new WebAssembly.Memory({initial:1}),{users,written:[],keeps:false,imageOf:null});}

test('failed Rust mapping writeback still retires own maps/fds and preserves shared process owners', {skip:!process.env.SODS_FILE_STORE_WASM},async()=>{
  const scope=await loadFileScope(readFileSync(process.env.SODS_FILE_STORE_WASM!),32),vfs=scope.createVfs(),k=kernel(vfs);
  const p=processFor(k),q=processFor(k),mem=memory(2);
  p.pid=2;q.pid=3;k.procs.set(2,p);k.procs.set(3,q);p.memory=mem;q.memory=mem;
  const bad=vfs.writeFile('/bad','aaaa'),good=vfs.writeFile('/good','bbbb');
  p.bytes.set(enc.encode('aaaa'),8192);q.bytes.set(enc.encode('aaaa'),12288);p.bytes.set(enc.encode('bbbb'),16384);
  p.mapShared(bad,8192,4,0);q.mapShared(bad,12288,4,0);p.mapShared(good,16384,4,0);
  p.bytes[8192]=90;p.bytes[16384]=89;
  const writeback=Error('writeback'),fdFailure=Error('fd cleanup'),settle=bad.settle;let finalized=0;
  const first=new Description('file',{node:bad}),second=new Description('file',{node:good});
  first.gone=()=>{finalized++;k.exitProcess(p,9);throw fdFailure;};second.gone=()=>{finalized++;};
  p.fds.install(first,{fd:7});p.fds.install(second,{fd:8});
  bad.settle=()=>{throw writeback;};
  try{
    assert.throws(()=>k.exitProcess(p,9),e=>e instanceof AggregateError&&e.errors[0]===writeback&&e.errors[1]===fdFailure);
    assert.equal(finalized,2);assert.equal(p.fds.slots.size,0);assert.equal(p.maps.length,0);assert.equal(p.memory,null);
    assert.equal(mem.users,1);assert.equal(q.memory,mem);assert.equal(q.state,'live');assert.equal(q.maps.length,1);
    assert.equal(bad.maps?.size,1);assert.equal(good.maps?.size??0,0);assert.equal(k.spareMemories.includes(mem),false);
    bad.settle=settle;
    assert.equal(dec.decode(bad.bytes()),'aaaa'); // Failed dirty bytes are lost, never reported as published.
    assert.equal(dec.decode(good.bytes()),'Ybbb'); // Independent successful writeback remains committed.
    q.bytes[12289]=88;assert.equal(dec.decode(bad.bytes()),'aXaa');
    k.exitProcess(p,9);assert.equal(finalized,2);assert.equal(mem.users,1);
    k.exitProcess(q,0);assert.equal(mem.users,0);
  }finally{bad.settle=settle;scope.dispose();}
});

test('init retirement failure suppresses normal stopped notification but preserves terminal status',()=>{
  const k=kernel(),p=processFor(k);p.pid=1;k.procs.set(1,p);p.memory=memory();let stopped=0;
  k.stopped=()=>{stopped++;};const failure=Error('fd');const d=new Description('file');d.gone=()=>{throw failure;};p.fds.install(d);
  assert.throws(()=>k.exitProcess(p,9),e=>e===failure);
  assert.equal(k.status,9);assert.equal(k.procs.size,0);assert.equal(p.memory,null);assert.equal(stopped,0);
  k.exitProcess(p,9);assert.equal(stopped,0);
});

test('backend task-stop failure never enters memory recycling continuation',()=>{
  const k=kernel(),p=processFor(k),mem=memory();p.memory=mem;
  p.tasks.add({} as Task);const failure=Error('backend stop');k.endTask=()=>{throw failure;};
  assert.throws(()=>k.exitProcess(p,9),e=>e===failure);
  assert.equal(p.memory,mem);assert.equal(mem.users,1);assert.equal(k.spareMemories.includes(mem),false);
});

test('init preserves child owner records when recursive backend stopping fails',()=>{
  const k=kernel(),p=processFor(k),q=processFor(k),mem=memory(2);p.pid=1;q.pid=2;p.memory=mem;q.memory=mem;k.procs.set(1,p);k.procs.set(2,q);
  const task={} as Task;q.tasks.add(task);k.blocked.add(task);k.runq.push(task);
  const original=Error('parent fd'),stop=Error('child stop');const d=new Description('file');d.gone=()=>{throw original;};p.fds.install(d);
  k.endTask=()=>{throw stop;};
  assert.throws(()=>k.exitProcess(p,9),e=>e instanceof AggregateError&&e.errors[0]===original&&e.errors[1]===stop);
  assert.equal(k.procs.get(2),q);assert.equal(k.blocked.has(task),true);assert.equal(k.runq.includes(task),true);
  assert.equal(q.memory,mem);assert.equal(mem.users,1);assert.equal(k.spareMemories.includes(mem),false);assert.equal(k.status,null);
});


test('retiring a shared-memory owner does not zero a surviving process sharing hint',()=>{
  const k=kernel(),p=processFor(k),q=processFor(k),r=processFor(k),mem=memory(2);
  p.pid=2;q.pid=3;r.pid=4;for(const proc of [p,q,r])k.procs.set(proc.pid,proc);
  p.memory=mem;q.memory=mem;r.memory=memory();
  const own=k.vfs.writeFile('/own','a'),shared=k.vfs.writeFile('/shared','b');
  p.bytes[8192]=97;p.mapShared(own,8192,1,0);
  q.bytes[12288]=98;r.bytes[12288]=98;q.mapShared(shared,12288,1,0);r.mapShared(shared,12288,1,0);
  assert.equal(q.view.getInt32(SHARES,true),1);
  k.exitProcess(p,0);assert.equal(q.view.getInt32(SHARES,true),1);assert.equal(mem.users,1);
  k.exitProcess(q,0);k.exitProcess(r,0);
});
