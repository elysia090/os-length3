// UI for real product verification, not a second execution engine. The page
// retains trusted key/head across disposable Workers; tiers retain ciphertext.
import {importStorageMasterKey} from '../../../web/ciphertext-storage.js';
const $=id=>document.getElementById(id),query=new URL(location.href).searchParams;
const gateway=query.get('gateway'),network=gateway?await(await fetch(gateway==='1'?'/config':gateway)).json():null;
$('release').value=query.get('release')??'';$('digest').value=query.get('sha256')??'';
const raw=crypto.getRandomValues(new Uint8Array(32)),masterKey=await importStorageMasterKey(raw);raw.fill(0);
const volumeId=crypto.getRandomValues(new Uint8Array(16)),volumeSalt=crypto.getRandomValues(new Uint8Array(32));
const words=new BigUint64Array(4);crypto.getRandomValues(words);
const storage={masterKey,volumeId,volumeSalt,bytes:268435456,create:true,name:Array.from(volumeId,x=>x.toString(16).padStart(2,'0')).join(''),binding:[...words],expectedHead:null};
let worker,id=0,closing=null;const decoder=new TextDecoder(),receipt={status:'idle',linuxBoot:'not-achieved',worker:'production-linux-worker',restore:'not-tested'};
function show(){ $('result').textContent=JSON.stringify(receipt,null,2); }
function boot(){if(worker)throw new Error('close the live Worker first');worker=new Worker('../../../web/linux-worker.js',{type:'module'});
  receipt.status='starting';receipt.console='';delete receipt.error;delete receipt.diagnostic;$('console').textContent='';show();
  worker.onmessage=({data:m})=>{
  if(m.type==='ready'){const generation=(storage.generation??0n)+1n;storage.generation=generation;
      worker.postMessage({id:++id,action:'boot',generation,releaseUrl:$('release').value,releaseSha256:$('digest').value,storage,network});return;}
    if(m.type==='storage-head'){storage.expectedHead=new Uint8Array(m.envelope);receipt.storageRevision=(receipt.storageRevision??0)+1;show();return;}
    if(m.type==='trace'){const raw=Uint8Array.from(atob(m.event.data_base64),b=>b.charCodeAt(0));$('console').textContent+=decoder.decode(raw,{stream:true});return;}
    if(m.type==='progress'){Object.assign(receipt,{status:'running',retired:m.profile?.retired,nextRip:m.profile?.nextRip,memoryBytes:m.profile?.memoryBytes,console:m.profile?.console?.text,timingMs:m.profile?.timingMs,sourceReuse:m.profile?.sourceReuse,engineReuse:m.profile?.engineReuse,sourceProfile:m.profile?.sourceProfile,systemProfile:m.profile?.systemProfile,devices:m.profile?.devices});show();return;}
    if(m.type==='result'){if(!m.ok){Object.assign(receipt,{status:'fail',error:m.error,diagnostic:m.diagnostic});show();return;}
      if(closing===m.id){worker.terminate();worker=null;closing=null;storage.create=false;receipt.status='closed';receipt.restore='ready-to-reopen';show();return;}
      if(m.result?.ready){receipt.status='shell-ready';receipt.linuxBoot='normal-PID1-and-interactive-ready';if(!storage.create)receipt.restore='Linux-reboot-with-saved-block-root';show();}
    }
    if(m.type==='fault'){Object.assign(receipt,{status:'fail',error:m.error});show();}
  };worker.onerror=e=>{receipt.status='fail';receipt.error=e.message;show();};
}
$('boot').onsubmit=e=>{e.preventDefault();try{boot();}catch(e){receipt.error=e.message;show();}};
$('close').onclick=()=>{if(worker){closing=++id;worker.postMessage({id:closing,action:'release',handle:1});}};
$('reopen').onclick=()=>{try{storage.create=false;boot();}catch(e){receipt.error=e.message;show();}};
$('input-form').onsubmit=e=>{e.preventDefault();if(!worker)return;const line=$('input-line').value+'\n';$('input-line').value='';worker.postMessage({id:++id,action:'input',handle:1,data:line});worker.postMessage({id:++id,action:'drive',handle:1});};
show();
