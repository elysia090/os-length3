import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel, Process, type Task} from '../../runtime/linux/process.ts';
import {SHARES} from '../../runtime/linux/thread-abi.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {Vfs} from '../../runtime/linux/fs.ts';
function kernel(vfs=new Vfs()){return new Kernel({vfs,translate(){throw Error('unused');},console:{write(){},read:()=>null}});}
function processFor(k:Kernel){const p=new Process(k,null);p.fixed=[];p.mapBase=8192;p.mapEnd=65536;p.stackLow=4096;p.stackTop=8192;return p;}
function memory(users=1){return Object.assign(new WebAssembly.Memory({initial:1}),{users,written:[],keeps:false,imageOf:null});}


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
