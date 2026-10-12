// User-approved device/origin authority, separate from ciphertext object rows.
// The non-extractable key stays in the browser. No raw-key export or new VFS.
import {IndexedBlockStore} from './persistent-block.mjs';
import {importStorageMasterKey} from './ciphertext-storage.js';
const same=(a,b)=>a===null?b===null:b!==null&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const limit=0xffffffffffffffffn;
function validate(record){
  if(record?.format!=='browser-workspace-authority-v1'||!(record.masterKey instanceof CryptoKey)||record.masterKey?.type!=='secret'
    ||record.masterKey.extractable!==false||record.masterKey.algorithm?.name!=='HKDF'
    ||record.masterKey.usages.length!==1||record.masterKey.usages[0]!=='deriveKey'
    ||!(record.volumeId instanceof Uint8Array)||record.volumeId.length!==16
    ||!(record.volumeSalt instanceof Uint8Array)||record.volumeSalt.length!==32
    ||!Number.isSafeInteger(record.bytes)||record.bytes<16*1048576||record.bytes>256*1048576
    ||record.bytes%4096||!(record.expectedHead===null||record.expectedHead instanceof Uint8Array)
    ||(record.checkpoints!==undefined&&(!Array.isArray(record.checkpoints)||record.checkpoints.length>8
      ||!record.checkpoints.every(row=>typeof row?.label==='string'&&/^[a-z0-9._-]{1,64}$/.test(row.label)
        &&row.head instanceof Uint8Array&&row.head.length>=32&&row.head.length<=4096)
      ||new Set(record.checkpoints.map(row=>row.label)).size!==record.checkpoints.length)))
    throw new Error('workspace recovery authority is missing or invalid');
}
export async function claimWorkspace(name,{bytes=256*1048576}={}){
  if(typeof name!=='string'||!/^[a-z0-9._-]{1,64}$/.test(name))throw new TypeError('workspace name');
  if(!Number.isSafeInteger(bytes)||bytes<16*1048576||bytes>256*1048576||bytes%4096)
    throw new TypeError('workspace extent');
  const storageName=`workspace-${name}`,store=await IndexedBlockStore.open(storageName);
  try{
    const existing=await new Promise((resolve,reject)=>{
      const tx=store.db.transaction(['authority','head','objects'],'readonly');let record,head,count,generation;
      tx.objectStore('authority').get(0).onsuccess=e=>{record=e.target.result??null;};
      tx.objectStore('authority').get(1).onsuccess=e=>{generation=e.target.result;};
      tx.objectStore('head').get(0).onsuccess=e=>{head=e.target.result;};
      tx.objectStore('objects').count().onsuccess=e=>{count=e.target.result;};
      tx.oncomplete=()=>{
        if(!record&&(head!==undefined||count!==0||generation!==undefined))
          reject(new Error('workspace recovery authority missing; existing data retained'));
        else resolve(record);
      };
      tx.onabort=()=>reject(tx.error??new Error('workspace authority read aborted'));tx.onerror=()=>{};
    });
    let candidate=existing;
    if(!candidate){
      const raw=crypto.getRandomValues(new Uint8Array(32));let masterKey;
        try{masterKey=await importStorageMasterKey(raw);}finally{raw.fill(0);}
        candidate={format:'browser-workspace-authority-v1',masterKey,
          volumeId:crypto.getRandomValues(new Uint8Array(16)),volumeSalt:crypto.getRandomValues(new Uint8Array(32)),bytes,expectedHead:null};
    }
    validate(candidate);
    // Key/context registration, retained head and the monotone incarnation share
    // one strict transaction with the physical head. An existing unidentified
    // volume is never adopted or formatted under a newly generated key.
    return await new Promise((resolve,reject)=>{
      const tx=store.db.transaction(['head','authority','objects'],'readwrite',{durability:'strict'}),authority=tx.objectStore('authority');
      let output,failure;
      const fail=message=>{failure=new Error(message);tx.abort();};
      tx.oncomplete=()=>resolve(output);tx.onabort=()=>reject(failure??tx.error??new Error('workspace authority transaction aborted'));tx.onerror=()=>{};
      const a=authority.get(0);a.onsuccess=()=>{
        const record=a.result??candidate;
        try{validate(record);}catch(e){fail(e.message);return;}
        if(record.bytes!==bytes){fail('workspace extent differs; existing data retained');return;}
        const h=tx.objectStore('head').get(0);h.onsuccess=()=>{
          const head=h.result?new Uint8Array(h.result):null;
          if(!same(record.expectedHead,head)){fail('workspace head differs from trusted recovery pin');return;}
          const c=tx.objectStore('objects').count();c.onsuccess=()=>{
          if(!a.result&&(h.result!==undefined||c.result!==0)){fail('workspace recovery authority missing; existing data retained');return;}
          const g=authority.get(1);g.onsuccess=()=>{
            const before=g.result??0n;
            if(typeof before!=='bigint'||before<0n||before>=limit||(!a.result&&before!==0n)
              ||(a.result&&(g.result===undefined||before<1n))){
              fail('workspace recovery generation invalid or exhausted');return;}
            const generation=before+1n,words=new BigUint64Array(4);crypto.getRandomValues(words);
            authority.put(record,0);authority.put(generation,1);
            output={...record,name:storageName,generation,fence:generation,binding:[...words],
              create:head===null,expectedHead:head,recovery:'browser-origin',trusted:true};
          };
          };
        };
      };
    });
  }finally{store.close();}
}
async function checkpointAuthority(storage,label,remember){
  if(typeof label!=='string'||!/^[a-z0-9._-]{1,64}$/.test(label))throw new TypeError('checkpoint label');
  const store=await IndexedBlockStore.open(storage.name,{fence:storage.fence});
  try{return await new Promise((resolve,reject)=>{
    const tx=store.db.transaction(['head','authority'],remember?'readwrite':'readonly',remember?{durability:'strict'}:undefined);
    const authority=tx.objectStore('authority');let output,failure;
    const fail=message=>{failure=new Error(message);tx.abort();};
    tx.oncomplete=()=>resolve(output);tx.onabort=()=>reject(failure??tx.error??new Error('checkpoint authority transaction aborted'));tx.onerror=()=>{};
    const g=authority.get(1);g.onsuccess=()=>{
      if(g.result!==storage.fence){fail('workspace supervisor fence lost');return;}
      const a=authority.get(0);a.onsuccess=()=>{
        const record=a.result;try{validate(record);}catch(error){fail(error.message);return;}
        const h=tx.objectStore('head').get(0);h.onsuccess=()=>{
          const head=h.result?new Uint8Array(h.result):null;
          if(head===null||!same(head,record.expectedHead)||!same(head,storage.expectedHead)){
            fail('checkpoint head differs from trusted recovery pin');return;}
          const rows=record.checkpoints??[],previous=rows.find(row=>row.label===label);
          if(remember){
            if(previous&&!same(previous.head,head)){fail('checkpoint label already belongs to another head');return;}
            if(!previous){if(rows.length>=8){fail('checkpoint retention limit reached');return;}
              authority.put({...record,checkpoints:[...rows,{label,head:head.slice()}]},0);}
            output=head.slice();
          }else{if(!previous){fail('retained workspace checkpoint missing');return;}
            output=previous.head.slice();}
        };
      };
    };
  });}finally{store.close();}
}
export const rememberWorkspaceCheckpoint=(storage,label)=>checkpointAuthority(storage,label,true);
export const readWorkspaceCheckpoint=(storage,label)=>checkpointAuthority(storage,label,false);
export async function openWorkspaceSession(name,options={}){
  if(!navigator.locks?.request)throw new Error('browser workspace recovery requires Web Locks');
  let unlock,closed=false,request;
  const held=new Promise(resolve=>{unlock=resolve;});
  let accept,reject;
  const opened=new Promise((resolve,fail)=>{accept=resolve;reject=fail;});
  request=navigator.locks.request(`length3-workspace-${name}`,{ifAvailable:true},async lock=>{
    if(!lock){reject(new Error('workspace is open in another browser tab'));return;}
    try{const storage=await claimWorkspace(name,options);
      accept({storage,async renew(){if(closed)throw new Error('workspace session closed');return claimWorkspace(name,options);},
        close(){if(!closed){closed=true;unlock();}return request;}});
      await held;
    }catch(error){reject(error);}
  }).catch(reject);
  return opened;
}
