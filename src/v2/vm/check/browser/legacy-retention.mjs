import {openWorkspaceSession,claimWorkspace,retainLegacyWorkspace} from '../../../web/workspace-authority.mjs';
import {IndexedBlockStore,PersistentBlock} from '../../../web/persistent-block.mjs';
const query=new URL(location.href).searchParams,name=query.get('workspace'),pin=query.get('sha256');
if(!/^legacy-[a-f0-9]{32}$/.test(name)||!/^[a-f0-9]{64}$/.test(pin))throw new Error('explicit retained test workspace and pin required');
const record={scope:'closed existing legacy authority refusal; no new keys or authority deletion',browserProcessRestart:'not-tested'},result=document.getElementById('result');
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);let session,other,volume;
async function rejects(action){try{const unexpected=await action();await unexpected?.close?.();throw new Error('retention incorrectly accepted');}
 catch(error){if(error.message==='retention incorrectly accepted')throw error;}}
try{
 session=await openWorkspaceSession(name,{bytes:32*1048576});const storage=session.storage;await session.close();session=null;
 const generation=storage.generation+1n,badHead=storage.expectedHead.slice();badHead[0]^=1;
 await rejects(()=>retainLegacyWorkspace({...storage,expectedHead:badHead},{generation,systemRoot:pin}));record.changedHead='rejected';
 const badSalt=storage.volumeSalt.slice();badSalt[0]^=1;
 await rejects(()=>retainLegacyWorkspace({...storage,volumeSalt:badSalt},{generation,systemRoot:pin}));record.changedContext='rejected';
 await rejects(()=>retainLegacyWorkspace(storage,{generation:storage.generation,systemRoot:pin}));record.staleGeneration='rejected';
 // Reuse an already-existing fixture key; never generate a replacement key.
 other=await IndexedBlockStore.open('workspace-fixture-recovery-1012-final');
 const wrongKey=await new Promise((resolve,reject)=>{const tx=other.db.transaction('authority','readonly');let key;
   tx.objectStore('authority').get(0).onsuccess=e=>{key=e.target.result?.masterKey;};tx.oncomplete=()=>resolve(key);tx.onabort=()=>reject(tx.error);});
 other.close();other=null;if(!(wrongKey instanceof CryptoKey)||wrongKey.extractable!==false)throw new Error('existing second fixture key required; no replacement generated');
 await rejects(()=>retainLegacyWorkspace({...storage,masterKey:wrongKey},{generation,systemRoot:pin}));record.wrongExistingKey='rejected';
 await rejects(()=>claimWorkspace('legacy-'+'00'.repeat(16),{bytes:32*1048576}));record.unregisteredLegacy='refused-without-key';
 session=await openWorkspaceSession(name,{bytes:32*1048576});const current=session.storage;
 if(!same(current.expectedHead,storage.expectedHead)||current.masterKey.extractable!==false)throw new Error('retained authority changed');
 const store=await IndexedBlockStore.open(current.name,{fence:current.fence});volume=await PersistentBlock.open({...current,store,systemRoot:pin});
 await volume.verifyTree(volume.root,2);record.head='exactly-retained';record.keyExtractable=current.masterKey.extractable;record.status='pass';
}catch(error){record.status='fail';record.error=error.message;}
finally{await volume?.close();await session?.close();await other?.close();}
result.textContent=JSON.stringify(record,null,2);
