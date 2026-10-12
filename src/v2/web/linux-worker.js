// One disposable Worker, one C CPU/MMU/device owner and one execution engine.
// The main thread supplies authority/keys; storage tiers never supply trust.
import {runMachine} from './machine-runtime.mjs';
import {openMachineArtifact} from './machine-artifact.mjs';
import {openPreparedMachineRelease,ensurePreparedMachineRelease} from './prepared-release.mjs';
import {retainLegacyWorkspace} from './workspace-authority.mjs';
import {MachineDevices} from './machine-devices.mjs';
import {PersistentBlock,IndexedBlockStore} from './persistent-block.mjs';
import {NetworkTransport} from './network-transport.mjs';
import {waitForClock} from './idle-clock.mjs';
import {ConsoleStream} from './console-stream.mjs';
import {hasReadinessLine} from './console-readiness.mjs';
const send=(type,payload={})=>self.postMessage({type,...payload});
let owner=null,closing=false,pending=null,artifact=null,running=null,ready=false,normal=false,serviceReady=false,closeFailure=null,workspaceLease=null;
let tail='',input=new Uint8Array(8192),head=0,count=0;
const decoder=new TextDecoder();
const consoleStream=new ConsoleStream(bytes=>{let raw='';for(const b of bytes)raw+=String.fromCharCode(b);
  send('trace',{event:{operation:'console_write',data_base64:btoa(raw)}});});
function flushConsole(){consoleStream.flush();}
function consoleWrite(bytes){consoleStream.write(bytes);
  tail=(tail+decoder.decode(bytes,{stream:true})).slice(-4096);
  if(hasReadinessLine(tail,'console-ready'))normal=true;
  if(!serviceReady&&hasReadinessLine(tail,'boot-offline-complete')){
    serviceReady=true;send('service-ready');
  }
  if(!normal&&(tail.includes('Offline service transition failed; terminal remains down.')||tail.includes('Boot root handoff failed.')))
    throw new Error('Linux normal boot failed; inspect the C machine diagnostic (no rescue fallback)');
  ready=normal&&/(?:^|\r?\n)[^\r\n]{0,128}[#$] $/.test(tail);
  if(ready&&pending){flushConsole();send('result',{id:pending,ok:true,handle:1,result:{ready:true,serviceReady,state:{halted:false},layout:artifact.stats}});pending=null;}
}
function consume(take){if(!count)return null;const b=input[head];if(take){head=(head+1)&8191;--count;}return b;}
async function boot(message){
  if(owner||running)throw new Error('one live machine per Worker');
  if(message.architecture&&message.architecture!=='x86-64')throw new Error('x86-64 release required');
  if(!message.releaseUrl||!message.releaseSha256||!message.storage)throw new Error('pinned Linux release and workspace authority required');
  if(typeof message.generation!=='bigint'||message.generation<1n||message.generation>0xffffffffffffffffn)throw new Error('supervisor machine generation required');
  closing=false;closeFailure=null;pending=message.id;ready=false;normal=false;serviceReady=false;tail='';head=count=0;
  send('progress',{id:message.id,phase:'download',label:'Authenticating Linux release'});
  const retain=message.retainLegacyWorkspace===true||new URL(message.releaseUrl,self.location.href).hash==='#retain-workspace';
  if(retain){
    await ensurePreparedMachineRelease(message.releaseUrl,message.releaseSha256);
    workspaceLease=await retainLegacyWorkspace(message.storage,{generation:message.generation,systemRoot:message.releaseSha256,
      onHead:envelope=>send('storage-head',{envelope})});
    message.storage=workspaceLease.storage;message.preparedRelease=true;
    send('workspace-retained',{workspace:message.storage.workspace});
  }
  artifact=message.preparedRelease===true?await openPreparedMachineRelease(message.releaseSha256):
    await openMachineArtifact(message.releaseUrl,message.releaseSha256);
  const m=artifact.manifest,s=message.storage,store=await IndexedBlockStore.open(s.name,{fence:s.fence??null});
  let volume;
  try{volume=await PersistentBlock.open({...s,store,
    systemRoot:message.preparedRelease===true?message.releaseSha256:null,
    onHead:envelope=>send('storage-head',{envelope})});
    if(volume.systemRoot!==null&&message.preparedRelease!==true)throw new Error('selected workspace requires its prepared release');}
  catch(e){await volume?.close();store.close();artifact.close();throw e;}
  owner=new MachineDevices({volume,binding:s.binding,network:message.network?new NetworkTransport(message.network):null});
  const system=m.objects.system,command=m.command+
    ' virtio_mmio.device=4K@'+owner.address+':10 virtio_mmio.device=4K@0x'+(BigInt(owner.address)+4096n).toString(16)+':11'+
    (volume.fresh?' length3.workspace=new':'');
  // Boot header and fixed command are the only initial inputs. C creates the
  // boot parameters/CPU; every image/RAM/MMIO page thereafter is demanded.
  const header=await artifact.read('kernel',0,4096),metadata=new TextEncoder().encode(JSON.stringify({imageBytes:m.objects.kernel.bytes,initramfsBytes:m.objects.initramfs.bytes,ramBytes:m.ramBytes}));
  const reader=async name=>name==='boot.header'?header:name==='boot.command'?new TextEncoder().encode(command):name==='boot.json'?metadata:Promise.reject(new Error('undeclared runtime input'));
  const readExtent=(kind,at,n)=>artifact.read(({2:'kernel',3:'initramfs',5:'system'})[kind],at,n);
  const entropy=crypto.getRandomValues(new Uint8Array(64));
  const provider=await artifact.read('vm',0,m.objects.vm.bytes),compiler=await artifact.read('compiler',0,m.objects.compiler.bytes);
  send('booted',{id:message.id,handle:1,architecture:'x86-64'});
  running=runMachine(reader,provider,compiler,readExtent,{extended:true,keepAlive:true,warmCuts:64,bootEntropy:entropy,generation:message.generation,
    immutableImage:{address:'0x30000000',bytes:system.bytes},devices:owner,onConsole:consoleWrite,readInput:consume,idleWait:waitForClock,shouldClose:()=>closing,
    onProgress:p=>{flushConsole();send('progress',{id:pending,phase:'execute',label:ready?'Linux is resident':'Starting Linux',detail:p.retired+' source instructions',profile:{...p,transport:owner.status()}});}})
    .then(result=>{if(!closing){const error=new Error('C machine stopped: '+JSON.stringify(result.nextGate,(_,v)=>typeof v==='bigint'?String(v):v));error.diagnostic=result;throw error;}return result;})
    .finally(async()=>{try{await owner?.close();}catch(e){closeFailure=e;throw e;}
      finally{artifact.close();owner=null;running=null;await workspaceLease?.close();workspaceLease=null;}})
    .catch(error=>{send('fault',{error:error.message??String(error)});flushConsole();
      if(pending)send('result',{id:pending,ok:false,error:error.message??String(error),diagnostic:error.diagnostic});throw error;});
  running.catch(()=>{});
}
self.onmessage=async({data:m})=>{try{
  if(m.action==='boot'){await boot(m);return;}
  if(m.action==='input'){if(!owner||closing||typeof m.data!=='string'||m.data.length>4096)throw new Error('bounded console input');
    const bytes=new TextEncoder().encode(m.data);if(count+bytes.length>input.length)throw new Error('console backpressure');
    ready=false;tail='';for(const b of bytes){input[(head+count)&8191]=b;++count;}send('result',{id:m.id,ok:true,handle:1,accepted:bytes.length});return;}
  if(m.action==='drive'){if(!owner||closing)throw new Error('machine not resident');pending=m.id;if(ready){send('result',{id:m.id,ok:true,handle:1,result:{ready:true,serviceReady,state:{halted:false}}});pending=null;}return;}
  if(m.action==='release'){closing=true;await running?.catch(()=>{});if(closeFailure)throw closeFailure;flushConsole();send('result',{id:m.id,ok:true,handle:1});return;}
  throw new Error('unknown machine action');
}catch(e){if(m.action==='boot'&&!running){try{await owner?.close();}catch(closeError){closeFailure=closeError;}
  finally{owner=null;artifact?.close();artifact=null;await workspaceLease?.close();workspaceLease=null;}}
  send('result',{id:m.id,ok:false,error:e.message});}};
send('ready',{protocol:'linux-machine-worker-v2'});
