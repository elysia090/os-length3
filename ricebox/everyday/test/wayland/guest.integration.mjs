import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeRaster, rasterFile} from './support/mirror-raster.ts';
import {mountGuestSurface, surfaceFromMirror} from '../../src/surface.ts';

const [binary, mode, execClient] = process.argv.slice(2);
const {SODS_TRANSLATOR_WASM: translatorPath, RICEBOX_MUK_FILE: mukPath} = process.env;
assert.ok(binary && translatorPath && mukPath && (mode === 'inline' || mode === 'worker'),
  'pass the presenter ELF, inline/worker and optional client ELF; supply the current SODS_TRANSLATOR_WASM and RICEBOX_MUK_FILE');
if (mode === 'inline') process.env.SODS_INLINE = '1'; else delete process.env.SODS_INLINE;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => new Uint8Array(readFileSync(path));
const translator = read(translatorPath), muk = read(mukPath), elf = read(binary);
const receipt=[],frames=[],terminal=[];
// Node has no browser backing store. Use a synchronous recording 2D surface;
// the frames, pointer responses and resize below still come from the real guest.
globalThis.ImageData=class {
  constructor(data,width,height) { Object.assign(this,{data,width,height}); }
};
const original={left:64,top:44,width:256,height:192};
const clip={left:0,top:0,width:245,height:172};
let box=original, rendered, sent, inputFence;
const canvas=Object.assign(new EventTarget(), {
  width:0,height:0,getBoundingClientRect:()=>box,
  getContext:()=>({clearRect(){},putImageData(image){
    rendered={width:image.width,height:image.height,pixels:new Uint8ClampedArray(image.data)};
  }}),
});
const viewport={clientLeft:0,clientTop:0,clientWidth:clip.width,clientHeight:clip.height,
  getBoundingClientRect:()=>clip,contains:target=>target===canvas};
const transport=Object.assign(new EventTarget(), {postMessage({type,bytes}) {
  assert.equal(type,'input');
  sent=bytes;
  inputFence=input(bytes);
}});
const source=surfaceFromMirror({worker:transport,file:rasterFile,maxEncodedBytes:16+64*48*4,
  decode(bytes) {
    const frame=decodeRaster(bytes);
    return frame && {serial:frame.sequence,width:frame.width,height:frame.height,rgba:frame.pixels};
  },
  encodePointer:({x,y})=>Uint8Array.of(1,x,y),
  encodeResize:({width,height})=>Uint8Array.of(2,width,height),
});
const presenter=mountGuestSurface({canvas,viewport,limits:{width:64,height:48,bytes:64*48*4},source});
globalThis.self={ onmessage:undefined, postMessage(m,{transfer=[]}={}){
  const event=structuredClone(m,{transfer});
  receipt.push(event);
  if(event.type==='output')terminal.push(Buffer.from(event.bytes));
  rendered=undefined;
  transport.dispatchEvent(new MessageEvent('message',{data:event}));
  if(rendered) {
    assert.ok(source.current,'product source admitted the guest frame');
    frames.push({sequence:source.current.serial,...rendered});
  }
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
  box={...original,left:16,top:8};
  assert.equal(frames.length,1,'camera geometry alone is no guest input');
  canvas.dispatchEvent(Object.assign(new Event('pointerdown'), {
    button:0,isPrimary:true,clientX:box.left+84,clientY:box.top+100,
  }));
  assert.deepEqual(sent,Uint8Array.of(1,10,12));
  await inputFence;
  await until(()=>frames.length===2&&text().includes('WAYLAND_COMMIT seq=2'),'Wayland pointer commit');
  const g=shape(2,32,24,[10,12]);
  assert.notEqual(f.sha256,g.sha256);
  assert.equal(presenter.resize(47,19),true);
  assert.deepEqual(sent,Uint8Array.of(2,47,19));
  await inputFence;
  await until(()=>frames.length===3&&text().includes('WAYLAND_COMMIT seq=3'),'xdg resized commit');
  const h=shape(3,47,19);
  const closingAt=receipt.length;
  await input(Uint8Array.of(3,0,0));
  await until(()=>receipt.some(e=>e.type==='exit'),'xdg close');
  assert.equal(receipt.find(e=>e.type==='exit').status,37<<8);
  assert.equal(frames.length,3,'xdg close must not draw another frame');
  assert.equal(source.current,null,'guest exit must end the surface source');
  assert.deepEqual(receipt.filter(e=>e.type==='error'),[]);
  const lines=text().trim().split('\n');
  assert.equal(lines.includes('WAYLAND_CLIENT_EXEC fd_inherited=1 cloexec_sentinel_absent=1 stdin_absent=1'), !!execClient);
  assert.equal(lines.includes('WAYLAND_SOCKET_CONSUMED close_on_exec=1'), !!execClient);
  const lifecycle=lines.filter(x=>x.startsWith('WAYLAND_COMMIT ')||x.startsWith('WAYLAND_RELEASE '));
  assert.equal(lifecycle.length,6,'one released buffer for each of three commits');
  const [initialCommit, initialRelease, redrawCommit, redrawRelease, resizedCommit, resizedRelease]=lifecycle;
  assert.match(initialCommit,/^WAYLAND_COMMIT seq=1 size=32x24 configure=(\d+) pointer=0 stride=140$/);
  assert.ok(lines.includes('WAYLAND_CONTROL_REFUSED'));
  assert.match(redrawCommit,/^WAYLAND_COMMIT seq=2 size=32x24 configure=(\d+) pointer=([1-9]\d*) stride=140$/);
  assert.match(resizedCommit,/^WAYLAND_COMMIT seq=3 size=47x19 configure=(\d+) pointer=([1-9]\d*) stride=200$/);
  assert.deepEqual([initialRelease,redrawRelease,resizedRelease],[
    'WAYLAND_RELEASE seq=1 buffer=new','WAYLAND_RELEASE seq=2 buffer=reused','WAYLAND_RELEASE seq=3 buffer=new',
  ]);
  const initial=Number(initialCommit.match(/configure=(\d+)/)[1]);
  const pointer=Number(redrawCommit.match(/configure=(\d+)/)[1]);
  const expanded=Number(resizedCommit.match(/configure=(\d+)/)[1]);
  assert.equal(pointer,initial);
  assert.ok(expanded>initial);
  assert.deepEqual(lines.slice(-2),['WAYLAND_CLIENT pointer=1 configure=2 frame_done=3 releases=3','WAYLAND_WINDOW_CLOSED']);
  presenter.close();
  await send({type:'retire'});
  const retirements=receipt.filter(e=>e.type==='retiring');
  assert.equal(retirements.length,1);
  const [retired]=retirements;
  assert.deepEqual(retired.failures,[]);
  assert.ok(!receipt.slice(closingAt).some(e=>e.type==='changes'&&e.files.some(f=>f.path===rasterFile&&f.bytes)),
    'close and retirement must not publish another raster');
  console.log(JSON.stringify({mode,connection:execClient?'exec-inherited':'fork-direct',elf:hash(elf),frames:[f,g,h],lines,lifecycle:'admission acknowledged'}));
}finally{
  presenter.close();
  if(!receipt.some(m=>m.type==='retiring'))await send({type:'retire'});
}
