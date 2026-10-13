import {IndexedBlockStore,PersistentBlock} from '../../../web/persistent-block.mjs';
import {openPreparedMachineRelease} from '../../../web/prepared-release.mjs';
const ensure=(v,m)=>{if(!v)throw new Error(m);};
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
async function rejects(fn,test){try{await fn();}catch(e){ensure(test(e),e.message);return e;}throw new Error('failure was accepted');}
async function authority(store){return new Promise((resolve,reject)=>{
  const tx=store.db.transaction(['authority','head'],'readonly');let record,head,generation;
  tx.objectStore('authority').get(0).onsuccess=e=>{record=e.target.result;};
  tx.objectStore('authority').get(1).onsuccess=e=>{generation=e.target.result;};
  tx.objectStore('head').get(0).onsuccess=e=>{head=e.target.result;};
  tx.oncomplete=()=>resolve({record,head,generation});tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};
});}
async function branch(name,state){const store=await IndexedBlockStore.open(name,{fence:state.generation});
  await new Promise((resolve,reject)=>{const tx=store.db.transaction(['head','authority'],'readwrite',{durability:'strict'});
    tx.objectStore('head').put(state.head,0);tx.objectStore('authority').put(state.record,0);tx.objectStore('authority').put(state.generation,1);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});return store;}
async function run(m){
  ensure(m.workspace==='fixture-linux-recovery-1012'&&/^qualification-20261013-[a-f0-9-]{36}$/.test(m.namespace),'isolated branch names');
  const release=await openPreparedMachineRelease(m.release);try{await release.verify();}finally{release.close();}
  ensure((await indexedDB.databases()).some(d=>d.name==='length3-block-workspace-'+m.workspace),'existing source database required');
  const source=await IndexedBlockStore.open('workspace-'+m.workspace),state=await authority(source);
  source.fence=state.generation;
  ensure(state.record?.masterKey?.extractable===false&&same(state.head,state.record.expectedHead),'existing key and exact head');
  const storage={...state.record,expectedHead:state.head,create:false,systemRoot:m.release};
  let publicationPuts=0;const retained=[];
  async function one(scenario,faultAt=0){
    const name=m.namespace+'-'+scenario+(faultAt?'-'+faultAt:''),store=await branch(name,state);retained.push(name);
    let puts=0,closes=0,corrupt=false;
    const wrapped={read:()=>store.read(),async get(k){const bytes=await store.get(k)??await source.get(k);
        if(corrupt&&bytes){const copy=bytes.slice();copy[40]^=1;return copy;}return bytes;},
      async put(k,b){if(++puts===faultAt)throw new DOMException('injected bounded candidate publication quota','QuotaExceededError');await store.put(k,b);},
      compareAndSwap(a,b){if(scenario!=='head-abort')return store.compareAndSwap(a,b);
        return store.transaction('head',true,s=>{s.put(b,0);s.transaction.abort();});},
      close(){++closes;store.close();}};
    const volume=await PersistentBlock.open({...storage,store:wrapped});
    ensure(volume.systemRoot===m.release&&!volume.fresh,'actual candidate selected in saved head');
    const offsets=[4000,16*1048576],before=await Promise.all(offsets.map(at=>volume.read(at,4096)));
    if(scenario==='corruption'){
      volume.cache.clear();corrupt=true;
      await rejects(()=>volume.read(4000,4096),e=>/corrupt/.test(e.message));corrupt=false;
      await volume.close();return {scenario,status:'pass',candidate:m.release,corruptionRefused:true,sourceBytesUnchanged:true};
    }
    for(let i=0;i<offsets.length;++i){const bytes=before[i].slice();for(let j=0;j<bytes.length;++j)bytes[j]^=0x39+i;await volume.write(offsets[i],bytes);}
    const plaintext=[...volume.cache.values(),...volume.dirty.values()];
    if(scenario==='count'){await volume.flush();publicationPuts=puts;await volume.close();return {scenario,status:'pass',publicationPuts};}
    await rejects(()=>volume.flush(),e=>scenario==='quota'?e.name==='QuotaExceededError':/abort/i.test(e.message));
    ensure(same(await store.read(),state.head),'failed publication retained exact head');
    await rejects(()=>volume.read(4000,1),e=>/failed/.test(e.message));
    await rejects(()=>volume.close(),e=>/failed/.test(e.message));
    ensure(closes===1&&plaintext.every(b=>b.every(v=>v===0)),'failed close erased plaintext and closed once');
    const reopened=await IndexedBlockStore.open(name,{fence:state.generation}),readOnly={read:()=>reopened.read(),get:async k=>await reopened.get(k)??source.get(k),close:()=>reopened.close()};
    const restored=await PersistentBlock.open({...storage,store:readOnly});
    for(let i=0;i<offsets.length;++i)ensure(same(await restored.read(offsets[i],4096),before[i]),'committed candidate bytes restored');
    await restored.close();
    return {scenario,faultAt,status:'pass',candidate:m.release,exactHeadRetained:true,
      restoredHashes:await Promise.all(before.map(sha)),plaintextErased:true};
  }
  try{
    self.postMessage({event:'case',result:await one('count')});
    for(let at=1;at<=publicationPuts;++at)self.postMessage({event:'case',result:await one('quota',at)});
    self.postMessage({event:'case',result:await one('head-abort')});
    self.postMessage({event:'case',result:await one('corruption')});
    const memory=new WebAssembly.Memory({initial:1,maximum:2});ensure(memory.grow(1)===1,'actual engine growth');
    await rejects(()=>Promise.resolve(memory.grow(1)),e=>e instanceof RangeError);
    ensure(memory.buffer.byteLength===131072,'engine maximum failure preserves current extent');
    return {status:'pass',publicationPuts,retainedBranches:retained,keyExtractable:false,
      engineMemoryMaximum:{status:'pass',initialPages:1,maximumPages:2,bytesAfterRefusal:131072,
        scope:'actual browser engine declared memory maximum; not global engine/code or physical IndexedDB quota'}};
  }finally{source.close();}
}
self.onmessage=async({data})=>{try{self.postMessage({event:'result',result:await run(data)});}
  catch(e){self.postMessage({event:'result',result:{status:'fail',error:e.message}});}};
