// UI for real product verification, not a second execution engine. The page
// retains trusted key/head across disposable Workers; tiers retain ciphertext.
import {importStorageMasterKey} from '../../../web/ciphertext-storage.js';
import {terminalKey,TerminalReplies} from '../../../web/terminal-bytes.mjs';
import {openWorkspaceSession} from '../../../web/workspace-authority.mjs';
const $=id=>document.getElementById(id),query=new URL(location.href).searchParams;
const volumeMiB=Number(query.get('volumeMiB')??256),faultsEnabled=query.get('faults')==='1';
if(!Number.isInteger(volumeMiB)||volumeMiB<16||volumeMiB>256||(volumeMiB&(volumeMiB-1)))throw new Error('diagnostic volume must be 16,32,64,128 or256 MiB');
$('interrupt').hidden=!faultsEnabled;
const gateway=query.get('gateway'),network=gateway?await(await fetch(gateway==='1'?'/config':gateway)).json():null;
$('release').value=query.get('release')??'';$('digest').value=query.get('sha256')??'';
const workspace=query.get('workspace');let workspaceSession=null,storage;
if(workspace){workspaceSession=await openWorkspaceSession(workspace,{bytes:volumeMiB*1048576});storage=workspaceSession.storage;}
else{const raw=crypto.getRandomValues(new Uint8Array(32)),masterKey=await importStorageMasterKey(raw);raw.fill(0);
  const volumeId=crypto.getRandomValues(new Uint8Array(16)),volumeSalt=crypto.getRandomValues(new Uint8Array(32)),words=new BigUint64Array(4);crypto.getRandomValues(words);
  storage={masterKey,volumeId,volumeSalt,bytes:volumeMiB*1048576,create:true,name:Array.from(volumeId,x=>x.toString(16).padStart(2,'0')).join(''),binding:[...words],expectedHead:null};}
let worker,id=0,closing=null,booting=false;const decoder=new TextDecoder(),receipt={status:'idle',linuxBoot:'not-achieved',worker:'production-linux-worker',restore:'not-tested'};
const profileFields=['retired','admissions','taskYields','nextRip','memoryBytes','residentPages','timingMs','sourceReuse','engineReuse','preparedCode','compilerOutput','sourceProfile','systemProfile','devices','transport'];
const terminalSize=()=>({rows:Math.max(1,Math.min(1000,Math.floor($('console').clientHeight/19.2))),columns:Math.max(1,Math.min(1000,Math.floor($('console').clientWidth/7.2)))});
let terminal=new TerminalReplies(terminalSize,data=>input(data));
function show(){receipt.liveWorkers=worker?1:0;receipt.testVolume={name:storage.name,bytes:storage.bytes}; $('result').textContent=JSON.stringify(receipt,(_,v)=>typeof v==='bigint'?String(v):v,2); }
function retireWorker(){receipt.lastWorkerSample={generation:receipt.generation,memoryBytes:receipt.memoryBytes,residentPages:receipt.residentPages};
  worker.terminate();worker=null;for(const field of profileFields)delete receipt[field];}
async function boot(){if(worker||booting)throw new Error('close the live Worker first');booting=true;
  try{if(workspace){if(!workspaceSession)workspaceSession=await openWorkspaceSession(workspace,{bytes:volumeMiB*1048576});
      storage=await workspaceSession.renew();}
    worker=new Worker('../../../web/linux-worker.js',{type:'module'});
  }finally{booting=false;}
  receipt.status='starting';receipt.console='';receipt.linuxBoot='not-achieved';receipt.serviceReady=false;
  delete receipt.error;delete receipt.diagnostic;for(const field of profileFields)delete receipt[field];
  $('console').textContent='';show();
  terminal=new TerminalReplies(terminalSize,data=>input(data));
  worker.onmessage=({data:m})=>{
  if(m.type==='ready'){receipt.workerProtocol=m.protocol;const generation=storage.trusted?storage.generation:(storage.generation??0n)+1n;storage.generation=generation;
      receipt.generation=String(generation);show();
      worker.postMessage({id:++id,action:'boot',generation,releaseUrl:$('release').value,releaseSha256:$('digest').value,storage,network});return;}
    if(m.type==='storage-head'){storage.expectedHead=new Uint8Array(m.envelope);receipt.storageRevision=(receipt.storageRevision??0)+1;show();return;}
    if(m.type==='service-ready'){receipt.serviceReady=true;show();return;}
    if(m.type==='trace'){const raw=Uint8Array.from(atob(m.event.data_base64),b=>b.charCodeAt(0)),text=decoder.decode(raw,{stream:true});$('console').textContent+=text;terminal.feed(text);return;}
    if(m.type==='progress'){Object.assign(receipt,{status:'running',retired:m.profile?.retired,admissions:m.profile?.admissions,taskYields:m.profile?.taskYields,nextRip:m.profile?.nextRip,memoryBytes:m.profile?.memoryBytes,residentPages:m.profile?.residentPages,console:m.profile?.console?.text,timingMs:m.profile?.timingMs,sourceReuse:m.profile?.sourceReuse,engineReuse:m.profile?.engineReuse,preparedCode:m.profile?.preparedCode,compilerOutput:m.profile?.compilerOutput,sourceProfile:m.profile?.sourceProfile,systemProfile:m.profile?.systemProfile,devices:m.profile?.devices,transport:m.profile?.transport});show();return;}
    if(m.type==='result'){if(!m.ok){Object.assign(receipt,{status:'fail',error:m.error,diagnostic:m.diagnostic});show();return;}
      if(Number.isInteger(m.accepted)){receipt.inputAcceptedBytes=(receipt.inputAcceptedBytes??0)+m.accepted;show();return;}
      if(closing===m.id){retireWorker();closing=null;storage.create=false;workspaceSession?.close();workspaceSession=null;
        receipt.workerTerminations=(receipt.workerTerminations??0)+1;receipt.status='closed';receipt.restore=workspace?'browser-restart-recovery-ready':'ready-to-reopen';show();return;}
      if(m.result?.ready){receipt.status='shell-ready';receipt.linuxBoot='normal-PID1-and-console-ready';receipt.serviceReady=m.result.serviceReady;if(!storage.create)receipt.restore='Linux-reboot-with-saved-block-root';show();}
    }
    if(m.type==='fault'){Object.assign(receipt,{status:'fail',error:m.error,diagnostic:m.diagnostic});show();}
  };worker.onerror=e=>{receipt.status='fail';receipt.error=e.message;show();};
}
$('boot').onsubmit=async e=>{e.preventDefault();try{await boot();}catch(e){receipt.error=e.message;show();}};
$('close').onclick=()=>{if(worker){closing=++id;worker.postMessage({id:closing,action:'release',handle:1});}};
$('interrupt').onclick=()=>{if(!faultsEnabled||!worker)return;retireWorker();closing=null;storage.create=false;
  receipt.workerTerminations=(receipt.workerTerminations??0)+1;receipt.workerInterruptions=(receipt.workerInterruptions??0)+1;
  receipt.status='interrupted';receipt.restore='ready-to-reopen';show();};
$('reopen').onclick=async()=>{try{storage.create=false;await boot();}catch(e){receipt.error=e.message;show();}};
function input(data){if(!worker)return;worker.postMessage({id:++id,action:'input',handle:1,data});worker.postMessage({id:++id,action:'drive',handle:1});}
$('input-form').onsubmit=e=>{e.preventDefault();const line=$('input-line').value+'\n';$('input-line').value='';input(line);};
// Transport terminal bytes, not host signals. The guest line discipline alone
// decides which foreground process group receives SIGINT/SIGTSTP.
for(const element of [$('console'),$('input-line')])element.addEventListener('keydown',e=>{
  if(e.ctrlKey&&!e.altKey&&!e.metaKey&&['c','z'].includes(e.key.toLowerCase())){
    e.preventDefault();receipt.lastControlKey=e.key.toLowerCase();receipt.controlKeyEvents=(receipt.controlKeyEvents??0)+1;show();input(e.key.toLowerCase()==='c'?'\x03':'\x1a');
  }
});
$('console').addEventListener('keydown',e=>{
  if(e.defaultPrevented||e.isComposing)return;
  const data=terminalKey(e);if(data!==null){e.preventDefault();input(data);}
});
show();
