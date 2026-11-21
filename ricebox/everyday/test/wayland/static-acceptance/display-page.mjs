import {createRoot,retireRootWorker} from '../ricebox-js/distribution/runtime/root.js';
import {mountGuestSurface,surfaceFromMirror} from '../ricebox-js/everyday/src/surface.js';
import {rasterStart} from './raster-fixture.mjs';
import {lendRaster,rasterFile} from './mirror-raster.mjs';
import {presenter} from './wayland-contract.mjs';

const node=id=>document.querySelector('#'+id);
const bytesSha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
export async function startDisplay(){
  const state=node('fallback-state'),pane=node('fallback-ui'),camera=node('fallback-camera'),canvas=camera.querySelector('canvas');
  const q=node('fallback-protocol'),base=new URL('ricebox/',document.baseURI).href;
  state.dataset.phase='starting';
  const root=createRoot({base,first:[],usedKey:'ricebox-accept-display-used',planKey:'ricebox-accept-display-plan',
    message:k=>k,missing:()=> 'Missing approved root for control',errorText:String});
  const response=await fetch(new URL('wayland-presenter.bin',import.meta.url),{redirect:'error'});
  if(!response.ok)throw Error('Missing verified fixture');
  const elf=new Uint8Array(await response.arrayBuffer());
  if(elf.length!==257976||await bytesSha(elf)!==presenter)throw Error('Unapproved fixture bytes');
  const loaded=await root.execution.load();
  if(!loaded||loaded.url!==base||loaded.profile!=='canonical-aot-v1'||!loaded.translator||!loaded.muk)throw Error('Incomplete approved root');
  const w=root.rootWorker(),d=new TextDecoder();
  const input=bytes=>w.postMessage({type:'input',bytes});
  const source=surfaceFromMirror({worker:w,file:rasterFile,maxEncodedBytes:16+64*48*4,
    decode(bytes){const f=lendRaster(bytes);return f&&{serial:f.sequence,width:f.width,height:f.height,rgba:f.pixels};},
    encodePointer:({x,y})=>Uint8Array.of(1,x,y),encodeResize:({width,height})=>Uint8Array.of(2,width,height)});
  let surface;
  try {surface=mountGuestSurface({viewport:camera,canvas,source,limits:{width:64,height:48,bytes:64*48*4}});}
  catch(error){w.terminate();throw error}
  pane.hidden=false;
  let closed=false,taken=0,sent=0,boundary=false;
  async function close(ok,why){
    if(closed)return;closed=true;
    surface.close();
    node('fallback-pan').disabled=node('fallback-resize').disabled=node('fallback-quit').disabled=true;
    try {const r=await retireRootWorker(w,1000);if(r.admission!=='acknowledged'||r.failures?.length)ok=false;}
    catch{ok=false}
    state.dataset.phase=ok?'closed':'error';
    state.textContent=ok?'Wayland control retired':String(why??'Worker retirement failed');
  }
  w.addEventListener('error',e=>void close(false,e.message));
  w.addEventListener('messageerror',()=>void close(false,'Worker message decode error'));
  addEventListener('pagehide',()=>void close(false,'Page departed'),{once:true});
  w.addEventListener('message',({data:m})=>{
    if(closed)return;
    if(m.type==='error'){void close(false,m.message);return}
    if(m.type==='output'){
      if(boundary||!(m.bytes instanceof Uint8Array)||(sent+=m.bytes.length)>65536){void close(false,'Output bounds');return}
      q.append(d.decode(m.bytes,{stream:true}));w.postMessage({type:'drained',n:m.bytes.length});
    }
    if(m.type==='output-boundary'){boundary=!boundary&&sent===m.sentBytes;if(!boundary){void close(false,'Output boundary mismatch');return}q.append(d.decode())}
    if(m.type==='exit'){void close(m.status===(37<<8)&&boundary,'Abnormal guest exit or missing boundary');return}
    if(m.type==='changes'&&source.current&&source.current.serial!==taken){
      const f=source.current;
      taken=f.serial;canvas.style.width=f.width*8+'px';canvas.style.height=f.height*8+'px';
      canvas.dataset.sequence=String(taken);state.dataset.phase='frame';state.textContent='Acknowledged guest raster';
    }
  });
  node('fallback-pan').onclick=()=>camera.scrollTo(camera.scrollLeft?0:48,camera.scrollTop?0:36);
  node('fallback-resize').onclick=()=>surface.resize(47,19);
  node('fallback-quit').onclick=()=>input(Uint8Array.of(3,0,0));
  w.postMessage(rasterStart(loaded.translator,loaded.muk,elf));
}
