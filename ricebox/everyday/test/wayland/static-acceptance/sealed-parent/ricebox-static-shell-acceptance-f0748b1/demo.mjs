import {createRoot,retireRootWorker} from './ricebox-js/distribution/runtime/root.js';
import {launchDeclared,prompt} from './launch.mjs';
const state=document.querySelector('#state'), output=document.querySelector('#output');
const line=document.querySelector('#line');
const decoder=new TextDecoder();
let worker, boot, written=0, boundary=false;
function failed(error) {
  state.dataset.phase='failed';
  state.textContent=String(error);
  line.disabled=true;
  boot?.close();
}
function receive({data}) {
  if (state.dataset.phase==='failed' || state.dataset.phase==='exited') return;
  if (data.type==='output') {
    if (boundary || !(data.bytes instanceof Uint8Array) || (written+=data.bytes.length)>65536) {
      failed(Error('Invalid or unbounded guest output'));return;
    }
    output.append(decoder.decode(data.bytes,{stream:true}));
    worker.postMessage({type:'drained', n:data.bytes.length});
  } else if (data.type==='waiting' && data.for==='input' && output.textContent.includes(prompt)) {
    state.dataset.phase='prompt';
    state.textContent='Guest prompt ready';
    line.disabled=false;
  } else if (data.type==='output-boundary') {
    if (boundary || data.sentBytes!==written) {failed(Error('Invalid guest output boundary'));return;}
    output.append(decoder.decode());
    boundary=true;
  } else if (data.type==='exit') {
    if (data.status!==0 || !boundary) {failed(Error('Guest did not exit cleanly after its output boundary'));return;}
    state.dataset.phase='exited';
    state.textContent='Guest exited 0';
    line.disabled=true;
    boot.close();
  } else if (data.type==='error') failed(data.message);
}
try {
  boot=launchDeclared({
    base:document.baseURI, declaration:document.querySelector('#launch').textContent, createRoot,
    attach(value){
      worker=value;
      worker.addEventListener('message',receive);
      worker.addEventListener('messageerror',()=>failed(Error('Guest Worker decode error')));
      worker.addEventListener('error',event=>failed(Error(event.message)));
    },
    retire(value){value.removeEventListener('message',receive); return retireRootWorker(value);},
  });
  addEventListener('pagehide',()=>boot.close(),{once:true});
  void boot.ready.catch(failed);
} catch(error) {failed(error);}
document.querySelector('#console').addEventListener('submit',event=>{
  event.preventDefault();
  if (!worker || line.disabled || !line.value || /[\n\r]/.test(line.value)) return;
  const bytes=new TextEncoder().encode(line.value+'\r');
  worker.postMessage({type:'input',bytes},{transfer:[bytes.buffer]});
  line.value='';
});
