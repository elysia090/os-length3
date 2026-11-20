import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {MirrorRaster} from './support/mirror-raster.ts';

const [binary, mode, execClient] = process.argv.slice(2);
const {SODS_TRANSLATOR_WASM: translatorPath, RICEBOX_MUK_FILE: mukPath} = process.env;
assert.ok(binary && translatorPath && mukPath && (mode === 'inline' || mode === 'worker'),
  'pass the presenter ELF, inline/worker and optional client ELF; supply the current SODS_TRANSLATOR_WASM and RICEBOX_MUK_FILE');
if (mode === 'inline') process.env.SODS_INLINE = '1'; else delete process.env.SODS_INLINE;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => new Uint8Array(readFileSync(path));
const translator = read(translatorPath), muk = read(mukPath), elf = read(binary);
const receipt=[],frames=[],terminal=[],model=new MirrorRaster();
globalThis.self={ onmessage:undefined, postMessage(m,{transfer=[]}={}){
  const event=structuredClone(m,{transfer});
  receipt.push(event);
  if(event.type==='output')terminal.push(Buffer.from(event.bytes));
  const frame=model.accept(event);
  if(frame)frames.push(frame);
} };
await import('../../../distribution/runtime/worker.ts');
const send=data=>self.onmessage({data:structuredClone(data)});
const input=(bytes)=>{assert.ok(bytes);return send({type:'input',bytes});};
const text=()=>Buffer.concat(terminal).toString();
const until=async(cb,label)=>{
  for(let t=performance.now()+7000;performance.now()<t;){
    if(cb())return;
    const error=receipt.find(e=>e.type==='error');
    if(error)throw new Error(label+': '+error.message+'\n'+text());
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error(label+': timeout '+JSON.stringify(receipt.map(x=>x.type))+'\n'+text());
};
function expected(x,y,marker) {
  const hit=marker && ((x-marker[0])**2+(y-marker[1])**2<=4);
  return hit ? [248,61,105,255] : [18+2*x,28+3*y,42+(x^y),255];
}
const shape=(seq,w,h,marker=null)=>{
  const f=frames.at(-1);
  assert.deepEqual([f.sequence,f.width,f.height],[seq,w,h]);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const at=(x+y*w)*4;
    assert.deepEqual(Array.from(f.pixels.subarray(at,at+4)),expected(x,y,marker),'pixel '+x+','+y);
  }
  return {sequence:seq,width:w,height:h,sha256:hash(f.pixels)};
};
// Reuse the ordinary production Worker/file mirror, not a custom display or host mount.
const path = '/usr/bin/wayland-presenter', separate = '/usr/bin/wayland-socket-client';
const args = execClient ? [path, '/proof', separate] : [path, '/proof'];
const files = [{path,bytes:elf,mode:0o755}];
if (execClient) files.push({path:separate,bytes:read(execClient),mode:0o755});
const config = JSON.stringify({
  ociVersion: '1.0.2',
  process: {args, cwd: '/', env: ['LANG=C.UTF-8'], noNewPrivileges: true},
  root: {path: '/', readonly: true},
  mounts: [{destination:'/proof', type:'bind', source:'/proof-channel', options:['bind','rw','nosuid','nodev','noexec']}],
  linux: {
    namespaces: ['pid','network','ipc','uts','mount','user'].map(type => ({type})),
    uidMappings: [{containerID:0,hostID:0,size:1}], gidMappings: [{containerID:0,hostID:0,size:1}],
  },
});
const start = {
  type:'start', translator, muk, cwd:'/', screen:false,
  box: {config, words:['run','--lend','/','--lend','/proof-channel','--ids','0-0','-b','/run/box','proof']},
  mirror:'/proof-channel', dirs:['/proof','/proof-channel'], files,
};
try{
  await send(start);
  await until(()=>frames.length===1&&text().includes('WAYLAND_COMMIT seq=1'),'initial Wayland surface');
  assert.equal(receipt.find(e=>e.type==='threads')?.apart,mode==='worker');
  await until(()=>receipt.some(e=>e.type==='waiting'&&e.for==='input'),'waiting for presenter input');
  const f=shape(1,32,24);
  await input(Uint8Array.of(1,250,250));
  await until(()=>text().includes('WAYLAND_CONTROL_REFUSED'),'invalid point verification');
  assert.equal(frames.length,1);
  const clip={x:0,y:0,width:245,height:172},original={x:64,y:44,width:256,height:192};
  const panned={...original,x:16,y:8};
  const cmd=model.pointer(panned.x+84,panned.y+100,panned,clip);
  assert.deepEqual(cmd,model.pointer(original.x+84,original.y+100,original,clip));
  assert.deepEqual(cmd,Uint8Array.of(1,10,12));
  assert.equal(frames.length,1,'camera geometry alone is no guest input');
  await input(cmd);
  await until(()=>frames.length===2&&text().includes('WAYLAND_COMMIT seq=2'),'Wayland pointer commit');
  const g=shape(2,32,24,[10,12]);
  assert.notEqual(f.sha256,g.sha256);
  await input(model.resize(47,19));
  await until(()=>frames.length===3&&text().includes('WAYLAND_COMMIT seq=3'),'xdg resized commit');
  const h=shape(3,47,19);
  await input(Uint8Array.of(3,0,0));
  await until(()=>receipt.some(e=>e.type==='exit'),'xdg close');
  assert.equal(receipt.find(e=>e.type==='exit').status,37<<8);
  assert.deepEqual(receipt.filter(e=>e.type==='error'),[]);
  const lines=text().trim().split('\n');
  assert.equal(lines.includes('WAYLAND_CLIENT_EXEC fd_inherited=1 cloexec_sentinel_absent=1 stdin_absent=1'), !!execClient);
  assert.equal(lines.includes('WAYLAND_SOCKET_CONSUMED close_on_exec=1'), !!execClient);
  const initialCommit=lines.find(x=>x.startsWith('WAYLAND_COMMIT seq=1'));
  assert.match(initialCommit,/^WAYLAND_COMMIT seq=1 size=32x24 configure=(\d+) pointer=0 stride=140$/);
  assert.ok(lines.includes('WAYLAND_CONTROL_REFUSED'));
  assert.match(lines.find(x=>x.startsWith('WAYLAND_COMMIT seq=2')),/^WAYLAND_COMMIT seq=2 size=32x24 configure=(\d+) pointer=([1-9]\d*) stride=140$/);
  const initial=Number(initialCommit.match(/configure=(\d+)/)[1]);
  const pointer=Number(lines.find(x=>x.startsWith('WAYLAND_COMMIT seq=2')).match(/configure=(\d+)/)[1]);
  const expanded=Number(lines.find(x=>x.startsWith('WAYLAND_COMMIT seq=3')).match(/configure=(\d+)/)[1]);
  assert.equal(pointer,initial);
  assert.ok(expanded>initial);
  assert.ok(lines.includes('WAYLAND_CLIENT pointer=1 configure=2 frame_done=3 releases=3'));
  assert.equal(lines.at(-1),'WAYLAND_WINDOW_CLOSED');
  model.retire();
  await send({type:'retire'});
  const retired=receipt.find(e=>e.type==='retiring');
  assert.ok(retired);
  assert.deepEqual(retired.failures,[]);
  console.log(JSON.stringify({mode,connection:execClient?'exec-inherited':'fork-direct',elf:hash(elf),frames:[f,g,h],lines,lifecycle:'admission acknowledged'}));
}finally{
  if(!receipt.some(m=>m.type==='retiring'))await send({type:'retire'});
}
