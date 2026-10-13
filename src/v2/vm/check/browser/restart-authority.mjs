import {IndexedBlockStore,PersistentBlock} from '../../../web/persistent-block.mjs';
const q=new URL(location.href).searchParams,name=q.get('workspace'),identity=q.get('sha256'),bytes=Number(q.get('bytes'));
if(!/^[a-z0-9._-]{1,64}$/.test(name)||!/^[a-f0-9]{64}$/.test(identity)||!Number.isSafeInteger(bytes))throw new Error('explicit saved workspace, extent and release pin required');
const storageName=/^legacy-[a-f0-9]{32}$/.test(name)?name.slice(7):`workspace-${name}`;
const databaseName=`length3-block-${storageName}`,record={scope:'read-only saved authority and physical tree; no new key or formatting',workspace:name,origin:location.origin};
let db,volume;
const same=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
try{
  const databases=await indexedDB.databases();
  if(!databases.some(row=>row.name===databaseName))throw new Error('saved workspace database absent; no replacement created');
  db=await new Promise((resolve,reject)=>{const request=indexedDB.open(databaseName,2);
    request.onupgradeneeded=()=>{request.transaction.abort();reject(new Error('saved database schema absent; creation refused'));};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('saved database blocked'));});
  const saved=await new Promise((resolve,reject)=>{const tx=db.transaction(['authority','head'],'readonly');let authority,generation,head;
    tx.objectStore('authority').get(0).onsuccess=e=>{authority=e.target.result;};
    tx.objectStore('authority').get(1).onsuccess=e=>{generation=e.target.result;};
    tx.objectStore('head').get(0).onsuccess=e=>{head=e.target.result;};
    tx.oncomplete=()=>resolve({authority,generation,head});tx.onabort=()=>reject(tx.error);tx.onerror=()=>{};});
  const a=saved.authority;
  if(a?.format!=='browser-workspace-authority-v1'||!(a.masterKey instanceof CryptoKey)||a.masterKey.extractable!==false
      ||a.masterKey.algorithm.name!=='HKDF'||a.bytes!==bytes||!same(a.expectedHead,new Uint8Array(saved.head??[]))
      ||!a.expectedHead?.length||typeof saved.generation!=='bigint'||saved.generation<1n)throw new Error('saved authority, key, generation or exact head invalid');
  const store=new IndexedBlockStore(db,saved.generation);
  volume=await PersistentBlock.open({...a,name:storageName,store,create:false,systemRoot:identity});
  await volume.verifyTree(volume.root,2);
  record.keyExtractable=a.masterKey.extractable;record.head='matches-trusted-recovery-pin';record.generation=String(saved.generation);
  record.sequence=String(volume.revision);record.selectedRelease=volume.systemRoot;record.physicalTree='authenticated';record.status='pass';
}catch(error){record.status='fail';record.error=error.message;}
finally{if(volume)await volume.close();else db?.close();}
document.getElementById('result').textContent=JSON.stringify(record,null,2);
