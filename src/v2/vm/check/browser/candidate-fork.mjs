import {IndexedBlockStore,PersistentBlock} from '../../../web/persistent-block.mjs';
const candidate='e67a26ffd99d66d48c5f54d516e0402496067d2cbfc54eb4eb9950be7d4fabde';
const fork='fixture-e67-services-1013',sourceName='workspace-fixture-linux-recovery-1012',targetName='workspace-'+fork;
const result=document.getElementById('result'),report={candidate,source:sourceName,fork,sourceWrites:false,newKeys:false,status:'running'};
const ensure=(v,m)=>{if(!v)throw new Error(m);};
const show=()=>result.textContent=JSON.stringify(report,null,2);show();let source,volume,target;
try{
  const names=await indexedDB.databases();ensure(names.some(d=>d.name==='length3-block-'+sourceName),'existing source required');
  ensure(!names.some(d=>d.name==='length3-block-'+targetName),'fresh target name required');
  source=await IndexedBlockStore.open(sourceName);const state={};
  await new Promise((resolve,reject)=>{const tx=source.db.transaction(['head','authority'],'readonly');
    tx.objectStore('head').get(0).onsuccess=e=>{state.head=e.target.result;};
    tx.objectStore('authority').get(0).onsuccess=e=>{state.record=e.target.result;};
    tx.objectStore('authority').get(1).onsuccess=e=>{state.generation=e.target.result;};
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
  ensure(state.record.masterKey.extractable===false&&state.head instanceof Uint8Array
    &&state.record.expectedHead?.length===state.head.length
    &&state.head.every((b,i)=>b===state.record.expectedHead[i]),'existing non-extractable key and exact recovery pin');source.fence=state.generation;
  volume=await PersistentBlock.open({...state.record,store:source,create:false,expectedHead:state.head,systemRoot:candidate});
  await volume.verifyTree(volume.root,2);const keys=new Set();
  async function collect(key,level){if(!key)return;keys.add(key);ensure(keys.size<9000,'bounded reachable physical tree');
    for(const child of (await volume.node(key,level)).values()){if(level)await collect(child,level-1);else keys.add(child);}}
  await collect(volume.root,2);const objects=[];let bytes=0;
  for(const key of keys){const body=await source.get(key);ensure(body,'reachable ciphertext required');bytes+=body.length;
    ensure(bytes<=40*1048576,'bounded copy');objects.push([key,body]);}
  target=await IndexedBlockStore.open(targetName,{fence:state.generation});
  await new Promise((resolve,reject)=>{const tx=target.db.transaction(['objects','head','authority'],'readwrite',{durability:'strict'});
    for(const [key,body]of objects)tx.objectStore('objects').add(body,key);
    tx.objectStore('head').add(state.head,0);tx.objectStore('authority').add({...state.record,
      checkpoints:[{label:'before-e67-service-faults',head:state.head.slice()}]},0);tx.objectStore('authority').add(state.generation,1);
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
  Object.assign(report,{status:'pass',ciphertextObjects:objects.length,ciphertextBytes:bytes,keyExtractable:false,
    sourceGeneration:String(state.generation),checkpoint:'before-e67-service-faults',scope:'isolated physical workspace copy; no process-state snapshot'});
}catch(e){report.status='fail';report.error=e.message;}
finally{await volume?.close();source?.close();target?.close();show();}
