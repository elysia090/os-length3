import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {rasterStart} from './raster-fixture.ts';
import {shellStart} from './shell-fixture.ts';
import {decodeRaster} from '../support/mirror-raster.ts';
// Engine-only corroboration: actual independent Workers/guests, no browser claim.
const [wasm, mukFile, elfFile, busyboxFile] = process.argv.slice(2);
assert.ok(busyboxFile,'pass TRANSLATOR_WASM MUK WAYLAND_TEST_ELF STATIC_BUSYBOX');
const entry = new URL('../../../../distribution/runtime/worker.ts', import.meta.url).href;
const bridge = new URL('data:text/javascript,' + encodeURIComponent([
  "import {parentPort,workerData} from 'node:worker_threads';",
  "globalThis.self={postMessage(value,{transfer=[]}={}){parentPort.postMessage(value,transfer);}};",
  "await import(workerData.entry);",
  "parentPort.on('message',data=>self.onmessage({data}));",
].join('\n')));
const a=new Worker(bridge,{workerData:{entry}});
const b=new Worker(bridge,{workerData:{entry}});
const read=p=>new Uint8Array(readFileSync(p));
const [translator,muk,elf,busybox]=[wasm,mukFile,elfFile,busyboxFile].map(read);
const packets=[], display=[], sh=[], errors=[], retired=[];
const text=()=>Buffer.concat(packets).toString();
const input=(worker,bytes)=>worker.postMessage({type:'input',bytes});
a.on('error',e=>errors.push(e)); b.on('error',e=>errors.push(e));
a.on('message',m=>{
  display.push(m);
  if(m.type==='retiring')retired.push('display');
  if(m.type==='error')errors.push(m);
});
b.on('message',m=>{
  sh.push(m);
  if(m.type==='output'){
    packets.push(Buffer.from(m.bytes));
    b.postMessage({type:'drained',n:m.bytes.length});
  }
  if(m.type==='retiring')retired.push('shell');
  if(m.type==='error')errors.push(m);
});
const pause=cb=>new Promise((ok,bad)=>{
  const deadline=Date.now()+8000;
  const timer=setInterval(()=>{
    if(errors.length||Date.now()>deadline){clearInterval(timer);bad(Error(JSON.stringify(errors)+' '+text()));}
    else if(cb()){clearInterval(timer);ok();}
  },10);
});
const frame=()=>display.filter(c=>c.type==='changes').flatMap(c=>c.files).filter(f=>f.path==='frame.rgba').at(-1);
try {
  a.postMessage(rasterStart(translator,muk,elf));
  b.postMessage(shellStart(translator,muk,busybox));
  await pause(()=>!!frame()&&sh.some(o=>o.type==='waiting'&&o.for==='input'));
  assert.equal(decodeRaster(frame().bytes).sequence,1);
  assert.match(text(), /everyday\$/);
  input(b,new TextEncoder().encode("printf 'shell-result=%s\\n' \"$((6*7))\"\n"));
  await pause(()=>text().includes('shell-result=42'));
  assert.equal(decodeRaster(frame().bytes).sequence,1);
  input(a,Uint8Array.of(2,47,19));
  await pause(()=>decodeRaster(frame().bytes).sequence===2);
  assert.equal(decodeRaster(frame().bytes).width,47);
  assert.equal(sh.filter(o=>o.type==='exit').length,0);
  input(a,Uint8Array.of(3,0,0));
  await pause(()=>display.some(o=>o.type==='exit'));
  assert.equal(display.find(o=>o.type==='exit').status,37<<8);
  a.postMessage({type:'retire'});
  await pause(()=>retired.includes('display'));
  await a.terminate();
  input(b,new TextEncoder().encode("printf 'after-graphic=%s\\n' \"$((9*9))\"\n"));
  await pause(()=>text().includes('after-graphic=81'));
  input(b,new TextEncoder().encode('exit\n'));
  await pause(()=>sh.some(o=>o.type==='exit'));
  assert.equal(sh.find(o=>o.type==='exit').status,0);
  b.postMessage({type:'retire'});
  await pause(()=>retired.length===2);
  const actualCpuWorkers=[display.find(o=>o.type==='threads')?.apart,sh.find(o=>o.type==='threads')?.apart];
  assert.deepEqual(actualCpuWorkers,[true,true]);
  console.log(JSON.stringify({shellResult:42,afterDisplayClose:81,displayFrame:2,stops:retired,actualCpuWorkers}));
} finally {await Promise.all([a.terminate(),b.terminate()]);}
