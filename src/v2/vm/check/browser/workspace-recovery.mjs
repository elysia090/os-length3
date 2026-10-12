import {openWorkspaceSession,claimWorkspace} from '../../../web/workspace-authority.mjs';
import {IndexedBlockStore,PersistentBlock} from '../../../web/persistent-block.mjs';
const query=new URL(location.href).searchParams,name=query.get('name');
if(!name||!/^fixture-[a-z0-9-]{1,40}$/.test(name))throw new Error('explicit disposable fixture namespace required');
const result=document.getElementById('result'),payload=new TextEncoder().encode('workspace-recovery-1012');
let session,volume;
const record={scope:'isolated-physical-block-browser-authority',linuxRecovery:'not-tested',browserProcessRestart:'not-tested'};
const show=()=>{result.textContent=JSON.stringify(record,null,2);};
const equal=(a,b)=>a.length===b.length&&a.every((value,i)=>value===b[i]);
async function transaction(db,write,body){return new Promise((resolve,reject)=>{
  const tx=db.transaction(['head','authority','objects'],write?'readwrite':'readonly',write?{durability:'strict'}:undefined);
  let value;tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error??new Error('fixture transaction aborted'));
  tx.onerror=()=>{};body(tx,v=>{value=v;});
});}
async function snapshot(db){return transaction(db,false,(tx,done)=>{
  const state={};tx.objectStore('head').get(0).onsuccess=e=>{state.head=e.target.result;};
  tx.objectStore('authority').get(0).onsuccess=e=>{state.authority=e.target.result;};
  tx.objectStore('authority').get(1).onsuccess=e=>{state.generation=e.target.result;};
  tx.objectStore('objects').count().onsuccess=e=>{state.objects=e.target.result;};done(state);
});}
async function rejectClaim(expected){try{await claimWorkspace(name,{bytes:16*1048576});throw new Error('invalid recovery accepted');}
  catch(error){if(error.message!==expected)throw error;}}
try{
  session=await openWorkspaceSession(name,{bytes:16*1048576});
  const s=session.storage;
  record.generation=String(s.generation);record.keyExtractable=s.masterKey.extractable;record.storageName=s.name;
  const store=await IndexedBlockStore.open(s.name,{fence:s.fence});
  volume=await PersistentBlock.open({...s,store});
  if(query.get('phase')==='negative'){
    const first=await snapshot(store.db);
    await volume.write(4096,payload);await volume.flush();
    const committed=await snapshot(store.db);
    if(!equal(committed.head,committed.authority.expectedHead)||equal(first.head,committed.head))
      throw new Error('physical head and trusted recovery pin did not commit together');
    record.atomicHeadPin='pass';
    try{await transaction(store.db,true,(tx)=>{
      tx.objectStore('head').put(first.head,0);
      tx.objectStore('authority').put({...committed.authority,expectedHead:first.head},0);tx.abort();
    });throw new Error('aborted transaction accepted');}
    catch(error){if(error.message!=='fixture transaction aborted')throw error;}
    const afterAbort=await snapshot(store.db);
    if(!equal(afterAbort.head,committed.head)||!equal(afterAbort.authority.expectedHead,committed.head))
      throw new Error('aborted publication changed head or pin');
    record.abortedPublication='retained-head-and-pin';
    await volume.close();volume=null;session.close();session=null;
    const metadata=await IndexedBlockStore.open(s.name,{fence:s.fence});
    try{
      await transaction(metadata.db,true,tx=>{tx.objectStore('head').put(first.head,0);});
      await rejectClaim('workspace head differs from trusted recovery pin');
      const rejected=await snapshot(metadata.db);
      if(rejected.generation!==committed.generation||!equal(rejected.head,first.head)
        ||!equal(rejected.authority.expectedHead,committed.head))throw new Error('failed recovery mutated authority');
      record.physicalHeadRollback='rejected-without-reinitialization';
      await transaction(metadata.db,true,tx=>{
        tx.objectStore('head').put(committed.head,0);tx.objectStore('authority').delete(0);
      });
      await rejectClaim('workspace recovery authority missing; existing data retained');
      const missing=await snapshot(metadata.db);
      if(missing.authority!==undefined||missing.generation!==committed.generation
        ||missing.objects!==committed.objects||!equal(missing.head,committed.head))throw new Error('missing authority replaced existing data');
      record.missingAuthority='rejected-without-new-key-or-format';
      await transaction(metadata.db,true,tx=>{tx.objectStore('authority').put(committed.authority,0);});
    }finally{metadata.close();}
    const orphanName=name+'-orphan',orphan=await IndexedBlockStore.open('workspace-'+orphanName);
    try{
      await orphan.put('unidentified-fixture-object',new Uint8Array([3,7,11]));
      try{await claimWorkspace(orphanName,{bytes:16*1048576});throw new Error('unidentified object rows adopted');}
      catch(error){if(error.message!=='workspace recovery authority missing; existing data retained')throw error;}
      const retained=await snapshot(orphan.db);
      if(retained.head!==undefined||retained.authority!==undefined||retained.generation!==undefined
        ||retained.objects!==1||!equal(await orphan.get('unidentified-fixture-object'),new Uint8Array([3,7,11])))
        throw new Error('unidentified object rows changed');
      record.orphanObjects='rejected-and-retained-without-key-generation';
    }finally{orphan.close();}
    record.status='pass';
  }else if(query.get('phase')==='read'){
    const bytes=await volume.read(4096,payload.length);
    if(!bytes.every((value,i)=>value===payload[i]))throw new Error('recovered physical bytes differ');
    if(s.generation<=BigInt(query.get('prior')))throw new Error('supervisor generation did not advance');
    const stale=await IndexedBlockStore.open(s.name,{fence:s.generation-1n});
    try{await stale.compareAndSwap(volume.head,new Uint8Array([1]));throw new Error('old writer accepted');}
    catch(error){if(error.message!=='workspace supervisor fence lost')throw error;record.staleWriter='rejected';}
    finally{stale.close();}
    try{const other=await openWorkspaceSession(name,{bytes:16*1048576});other.close();throw new Error('concurrent tab accepted');}
    catch(error){if(error.message!=='workspace is open in another browser tab')throw error;record.concurrentSupervisor='rejected';}
    await volume.close();volume=null;session.close();session=null;
    record.status='pass';record.restore='fresh-document-real-IndexedDB-CryptoKey-and-physical-bytes';
  }else{
    await volume.write(4096,payload);await volume.close();volume=null;session.close();session=null;
    record.status='committed-and-closed';
    const link=document.getElementById('reopen'),url=new URL(location.href);
    url.searchParams.set('phase','read');url.searchParams.set('prior',String(s.generation));
    link.href=url;link.hidden=false;
  }
}catch(error){record.status='fail';record.error=error.message;
  if(volume)try{await volume.close();}catch{}
  session?.close();}
show();
