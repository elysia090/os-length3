import {prepareMachineRelease,openPreparedMachineRelease,ensurePreparedMachineRelease} from '../../../web/prepared-release.mjs';
const query=new URL(location.href).searchParams,pin=query.get('sha256'),url=query.get('release');
const fixtureUrl='/src/v2/vm/check/browser/prepared-cache-fixture/release.json';
if((!url?.startsWith('/artifact/')&&url!==fixtureUrl)||!/^[a-f0-9]{64}$/.test(pin))throw new Error('explicit local artifact and pin required');
const result=document.getElementById('result'),record={scope:'public immutable release bodies; no workspace selection',browserProcessRestart:'not-tested'};
const show=()=>{result.textContent=JSON.stringify(record,null,2);};
let artifact;
try{
  if(query.get('phase')==='negative'){
    if(url!==fixtureUrl)throw new Error('explicit isolated synthetic cache fixture required');
    await prepareMachineRelease(url,pin);artifact=await openPreparedMachineRelease(pin);
    if(artifact.manifest.command!=='fixture-cache-validation-no-execution'||Object.values(artifact.manifest.objects).some(r=>r.bytes>4096))
      throw new Error('isolated synthetic fixture contract');
    await artifact.verify();const key=artifact.manifest.objects.system.chunks[0];artifact.close();artifact=null;
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('length3-prepared-release-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const tx=(store,write,operation)=>new Promise((resolve,reject)=>{const t=db.transaction(store,write?'readwrite':'readonly',write?{durability:'strict'}:undefined);let value;
      operation(t.objectStore(store),v=>{value=v;});t.oncomplete=()=>resolve(value);t.onabort=()=>reject(t.error);t.onerror=()=>{};});
    const get=(store,key)=>tx(store,false,(s,done)=>{s.get(key).onsuccess=e=>done(e.target.result);});
    const put=(store,key,value)=>tx(store,true,s=>s.put(value,key));
    const raw=await get('manifests',pin),body=await get('chunks',key);
    const reject=async(fn,pattern)=>{try{await fn();throw new Error('expected cache refusal absent');}catch(error){if(!pattern.test(error.message))throw error;}};
    const check=async()=>{const a=await openPreparedMachineRelease(pin);try{await a.verify();}finally{a.close();}};
    try{
      await put('manifests',pin,new Uint8Array([1,2,3]));await reject(()=>openPreparedMachineRelease(pin),/descriptor corrupt/);
      record.corruptDescriptor='rejected';await put('manifests',pin,raw);
      await put('chunks',key,new Uint8Array([3,2,1]));await reject(check,/body missing or corrupt/);record.corruptBody='rejected';
      await reject(()=>prepareMachineRelease(url,pin),/occupied immutable release body differs/);record.occupiedBody='retained';
      const nativeFetch=globalThis.fetch;let fetches=0;globalThis.fetch=(...args)=>{++fetches;return nativeFetch(...args);};
      try{await reject(()=>ensurePreparedMachineRelease(url,pin),/body missing or corrupt/);if(fetches!==0)throw new Error('corrupt cache silently redelivered');
        record.corruptCacheNetworkFallback='refused';}finally{globalThis.fetch=nativeFetch;}
      await tx('chunks',true,s=>s.delete(key));await reject(check,/body missing or corrupt/);record.missingBody='rejected';
    }finally{await put('chunks',key,body);await put('manifests',pin,raw);db.close();}
    await check();record.fixtureRestored='exact';record.status='pass';show();
  }else{
  if(query.get('phase')!=='read')await prepareMachineRelease(url,pin,{onProgress:p=>{record.preparedBytes=p.completed;record.totalBytes=p.total;show();}});
  artifact=await openPreparedMachineRelease(pin);record.identity=artifact.identity;record.roles=await artifact.verify();
  record.networkFetchesDuringReopen=artifact.stats.fetches;record.status='pass';artifact.close();artifact=null;
  const link=document.getElementById('reopen'),next=new URL(location.href);next.searchParams.set('phase','read');link.href=next;link.hidden=false;
  }
}catch(error){artifact?.close();record.status='fail';record.error=error.message;}
show();
