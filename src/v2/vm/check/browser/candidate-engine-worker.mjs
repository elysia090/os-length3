import {IndexedBlockStore,PersistentBlock} from '../../../web/persistent-block.mjs';
import {openPreparedMachineRelease} from '../../../web/prepared-release.mjs';
const ensure=(v,m)=>{if(!v)throw new Error(m);};
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const u32=n=>{const out=[];do{const b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return Uint8Array.from(out);};
function concatenate(parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
function moduleBytes(functions){const count=u32(functions),types=Uint8Array.from([1,4,1,96,0,0]),
  definitions=concatenate([count,new Uint8Array(functions)]),bodies=new Uint8Array(3*functions);
  for(let i=0;i<functions;++i)bodies.set([2,0,11],i*3);
  const code=concatenate([count,bodies]);return concatenate([Uint8Array.from([0,97,115,109,1,0,0,0]),types,
    Uint8Array.of(3),u32(definitions.length),definitions,Uint8Array.of(10),u32(code.length),code]);}
async function tx(db,stores,write,body){return new Promise((resolve,reject)=>{
  const t=db.transaction(stores,write?'readwrite':'readonly',write?{durability:'strict'}:undefined);let out;
  t.oncomplete=()=>resolve(out);t.onabort=()=>reject(t.error??new Error('transaction aborted'));t.onerror=()=>{};body(t,v=>{out=v;});});}
async function run(m){
  ensure(['fixture-linux-recovery-1012','fixture-e67-services-1013'].includes(m.workspace)&&/^[a-f0-9]{64}$/.test(m.candidate??''),'existing fixture and exact candidate');
  const release=await openPreparedMachineRelease(m.candidate);try{await release.verify();}finally{release.close();}
  const report={format:'candidate-engine-quota-v1',candidate:m.candidate,status:'partial',newKeys:false,
    permissionChanges:false,databaseDeletion:false,globalCodeRssExhaustion:'not-tested',originDiskExhaustion:'not-tested'};
  ensure(WebAssembly.validate(moduleBytes(1)),'complete control module');new WebAssembly.Module(moduleBytes(1));
  const large=moduleBytes(1000001);ensure(large.length<4194304,'bounded complete over-limit module');
  try{new WebAssembly.Module(large);throw new Error('engine accepted over-limit module');}
  catch(e){ensure(e instanceof WebAssembly.CompileError&&/functions count.*exceeds.*limit/i.test(e.message),'actual function quota refusal: '+e.message);
    report.moduleAdmission={status:'pass',definedFunctions:1000001,wireBytes:large.length,error:e.message,
      scope:'actual engine per-module declared function quota; not total live native-code/RSS exhaustion'};}
  if(!navigator.storageBuckets){report.indexedDbQuota={status:'not-tested',reason:'Storage Buckets unavailable'};return report;}
  const name='qualification-'+crypto.randomUUID(),quota=1048576,bucket=await navigator.storageBuckets.open(name,{quota,durability:'strict',persisted:false});
  report.bucket={name,requestedQuota:quota,estimate:await bucket.estimate(),maximumAttemptedBytes:2097152};
  if(report.bucket.estimate.quota>quota){report.indexedDbQuota={status:'not-tested',reason:'bounded quota hint not enforced; no fill attempted'};return report;}
  ensure((await indexedDB.databases()).some(d=>d.name==='length3-block-workspace-'+m.workspace),'source database exists');
  const source=await IndexedBlockStore.open('workspace-'+m.workspace),state={};
  await tx(source.db,['head','authority'],false,(t,done)=>{
    t.objectStore('head').get(0).onsuccess=e=>{state.head=e.target.result;};
    t.objectStore('authority').get(0).onsuccess=e=>{state.authority=e.target.result;};
    t.objectStore('authority').get(1).onsuccess=e=>{state.generation=e.target.result;};done(state);});
  source.fence=state.generation;ensure(state.authority.masterKey.extractable===false&&same(state.head,state.authority.expectedHead),'existing exact authority');
  const db=await new Promise((resolve,reject)=>{const r=bucket.indexedDB.open('candidate-physical',2);
    r.onupgradeneeded=()=>{for(const n of ['objects','head','authority'])r.result.createObjectStore(n);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const store=new IndexedBlockStore(db,state.generation);
  try{
    await tx(db,['head','authority'],true,(t)=>{t.objectStore('head').put(state.head,0);t.objectStore('authority').put(state.authority,0);t.objectStore('authority').put(state.generation,1);});
    let quotaError=null,fillBytes=0;
    for(let rank=0;rank<256;++rank){const bytes=crypto.getRandomValues(new Uint8Array(8192));
      try{await store.put('bounded-quota-fixture-'+rank,bytes);fillBytes+=bytes.length;}
      catch(e){ensure(e.name==='QuotaExceededError','native bucket quota error: '+e.name);quotaError=e;break;}}
    if(!quotaError){report.indexedDbQuota={status:'not-tested',reason:'bounded 2 MiB attempt reached without quota failure',fillBytes};return report;}
    ensure(same(await store.read(),state.head),'native failed transaction retained head');
    const wrapped={read:()=>store.read(),get:async k=>await store.get(k)??source.get(k),put:(k,b)=>store.put(k,b),
      compareAndSwap:(a,b)=>store.compareAndSwap(a,b),close:()=>store.close()};
    const volume=await PersistentBlock.open({...state.authority,store:wrapped,create:false,expectedHead:state.head,systemRoot:m.candidate});
    const before=await volume.read(4000,4096),changed=before.slice();changed[0]^=57;await volume.write(4000,changed);
    let publicationError;
    try{await volume.flush();}catch(e){publicationError=e;}
    ensure(publicationError?.name==='QuotaExceededError','candidate publication must hit actual bucket quota');
    ensure(same(await store.read(),state.head),'candidate quota failure retained committed head');
    try{await volume.close();}catch(e){ensure(/failed/.test(e.message),'failed close');}
    report.indexedDbQuota={status:'pass',fillBytes,error:quotaError.name,publicationError:publicationError.name,
      candidateHeadRetained:true,plaintextErased:volume.cache.size===0&&volume.dirty.size===0,
      scope:'actual browser Storage Bucket quota and current PersistentBlock publication; isolated default-origin source remains untouched'};
    report.status='pass';return report;
  }finally{store.close();source.close();}
}
self.onmessage=async({data})=>{try{self.postMessage(await run(data));}catch(e){self.postMessage({status:'fail',candidate:data.candidate,error:e.message});}};
