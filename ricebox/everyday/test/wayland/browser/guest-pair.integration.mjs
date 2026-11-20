import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {rasterStart} from './raster-fixture.ts';
import {shellStart} from './shell-fixture.ts';
import {decodeRaster, rasterFile} from '../support/mirror-raster.ts';
import {createRoot} from 'ricebox';
import {surfaceFromMirror} from 'ricebox/everyday';
// Engine-only corroboration: actual independent Workers/guests, no browser claim.
const [wasm, mukFile, elfFile, busyboxFile] = process.argv.slice(2);
assert.ok(busyboxFile,'pass TRANSLATOR_WASM MUK WAYLAND_TEST_ELF STATIC_BUSYBOX');
const bridge = new URL('data:text/javascript,' + encodeURIComponent([
  "import {parentPort,workerData} from 'node:worker_threads';",
  "globalThis.self={postMessage(value,{transfer=[]}={}){parentPort.postMessage(value,transfer);}};",
  "await import(workerData.entry);",
  "parentPort.on('message',data=>self.onmessage({data}));",
].join('\n')));
// Give the installed browser factory a Node thread harness for its exact
// worker.js URL. Guest translation and child workers are unmodified.
const entry=new URL('./worker.js', import.meta.resolve('ricebox')).href;
const root=createRoot({base:'/fixture/', first:[], usedKey:'everyday-proof-used',
  planKey:'everyday-proof-plan', message:key=>key, missing:()=> 'No default root',
  errorText:error=>String(error)});
function startRoot() {
  const original=globalThis.Worker;
  globalThis.Worker=class {
    constructor(url) {
      assert.equal(url.href,entry);
      return new NodeWorker(bridge,{workerData:{entry}});
    }
  };
  try { return root.rootWorker(); }
  finally { globalThis.Worker=original; }
}
const a=startRoot(), b=startRoot();
const port=Object.assign(new EventTarget(), {postMessage: data=>a.postMessage(data)});
const source=surfaceFromMirror({worker:port,file:rasterFile,maxEncodedBytes:16+64*48*4,
  decode(bytes) {
    const frame=decodeRaster(bytes);
    return frame && {serial:frame.sequence,width:frame.width,height:frame.height,rgba:frame.pixels};
  },
  encodeResize:({width,height})=>Uint8Array.of(2,width,height),
});
let displayEnded=false;
const stopSource=source.observe({frame:()=>true,end:()=>{displayEnded=true;}});
const read=p=>new Uint8Array(readFileSync(p));
const [translator,muk,elf,busybox]=[wasm,mukFile,elfFile,busyboxFile].map(read);
const packets=[], display=[], sh=[], errors=[], retired=[];
const text=()=>Buffer.concat(packets).toString();
const input=(worker,bytes)=>worker.postMessage({type:'input',bytes});
a.on('error',e=>errors.push(e)); b.on('error',e=>errors.push(e));
a.on('message',m=>{
  display.push(m);
  port.dispatchEvent(new MessageEvent('message',{data:m}));
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
try {
  a.postMessage(rasterStart(translator,muk,elf));
  b.postMessage(shellStart(translator,muk,busybox));
  await pause(()=>!!source.current&&sh.some(o=>o.type==='waiting'&&o.for==='input'));
  assert.equal(source.current?.serial,1);
  assert.match(text(), /everyday\$/);
  input(b,new TextEncoder().encode("printf 'shell-result=%s\\n' \"$((6*7))\"\n"));
  await pause(()=>text().includes('shell-result=42'));
  assert.equal(source.current?.serial,1);
  source.resize({serial:1,width:47,height:19});
  await pause(()=>source.current?.serial===2);
  assert.equal(source.current?.width,47);
  assert.equal(sh.filter(o=>o.type==='exit').length,0);
  input(a,Uint8Array.of(3,0,0));
  await pause(()=>display.some(o=>o.type==='exit'));
  assert.equal(display.find(o=>o.type==='exit').status,37<<8);
  assert.ok(displayEnded);
  assert.equal(source.current,null);
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
  console.log(JSON.stringify({installedWorker:entry.endsWith('/node_modules/ricebox/ricebox/distribution/runtime/worker.js'),shellResult:42,afterDisplayClose:81,displayFrame:2,stops:retired,actualCpuWorkers}));
} finally {stopSource(); await Promise.all([a.terminate(),b.terminate()]);}
