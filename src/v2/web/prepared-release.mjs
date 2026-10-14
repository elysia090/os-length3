// Public immutable delivery bodies. Pins/approval never come from this cache.
import {openMachineArtifact,decodeMachineManifest} from './machine-artifact.mjs';
const names=['kernel','initramfs','system','vm','compiler'];
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const digest=async bytes=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
async function cache(){
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('length3-prepared-release-v1',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('chunks');request.result.createObjectStore('manifests');};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  db.onversionchange=()=>db.close();
  const transaction=(store,write,body)=>new Promise((resolve,reject)=>{
    const tx=db.transaction(store,write?'readwrite':'readonly',write?{durability:'strict'}:undefined);let value,failure;
    tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(failure??tx.error??new Error('prepared release transaction aborted'));tx.onerror=()=>{};
    body(tx.objectStore(store),result=>{value=result;},message=>{failure=new Error(message);tx.abort();});
  });
  return {close(){db.close();},get(store,key){return transaction(store,false,(s,done)=>{
    const r=s.get(key);r.onsuccess=()=>done(r.result?new Uint8Array(r.result):null);});},
    put(store,key,bytes){return transaction(store,true,(s,done,fail)=>{
      const r=s.get(key);r.onsuccess=()=>{
        if(r.result){const old=new Uint8Array(r.result);if(old.length!==bytes.length||!old.every((v,i)=>v===bytes[i])){
          fail('occupied immutable release body differs; retained');return;}}
        else s.add(bytes.slice(),key);done(true);
      };
    });},putChunks(rows){
      const unique=new Map();for(const [key,bytes] of rows){const previous=unique.get(key);
        if(previous&&(previous.length!==bytes.length||!previous.every((v,i)=>v===bytes[i])))throw new Error('duplicate immutable chunk differs');unique.set(key,bytes);}
      return transaction('chunks',true,(s,done,fail)=>{
        for(const [key,bytes] of unique){const r=s.get(key);r.onsuccess=()=>{
          if(r.result){const old=new Uint8Array(r.result);if(old.length!==bytes.length||!old.every((v,i)=>v===bytes[i])){fail('occupied immutable release body differs; retained');return;}}
          else s.add(bytes.slice(),key);
        };}done(true);
      });
    }};
}
export async function prepareMachineRelease(url,pin,{onProgress=()=>{}}={}){
  const artifact=await openMachineArtifact(url,pin);let store;
  try{
    store=await cache();
    let completed=0,total=names.reduce((n,name)=>n+artifact.manifest.objects[name].bytes,0);
    for(const name of names){const row=artifact.manifest.objects[name],whole=new Uint8Array(row.bytes);
      let next=0,failure=null;const transferBytes=1048576;
      await Promise.all(Array.from({length:Math.min(4,Math.ceil(row.bytes/transferBytes))},async()=>{
        while(!failure&&next<row.bytes){const at=next,n=Math.min(transferBytes,row.bytes-at);next+=n;
          try{const bytes=await artifact.readTransfer(name,at,n),chunks=[];
            for(let done=0;done<n;done+=65536)chunks.push([row.chunks[(at+done)/65536],bytes.subarray(done,Math.min(n,done+65536))]);
            await store.putChunks(chunks);whole.set(bytes,at);completed+=n;onProgress({completed,total,name});
          }catch(error){failure??=error;}
        }
      }));if(failure)throw failure;
      if(await digest(whole)!==row.sha256)throw new Error('prepared release whole-object identity differs');
    }
    // An interrupted preparation leaves unselected chunks. Its descriptor is
    // published only after all five role populations are durable and checked.
    await store.put('manifests',pin,artifact.raw);
    return {identity:pin,manifest:artifact.manifest};
  }finally{artifact.close();store?.close();}
}
export async function openPreparedMachineRelease(pin){
  if(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))throw new Error('independently pinned release SHA-256 required');
  const store=await cache();let closed=false;
  try{
    const raw=await store.get('manifests',pin);
    if(!raw){const error=new Error('prepared release descriptor missing');error.code='PREPARED_RELEASE_MISSING';throw error;}
    if(raw.length<1||raw.length>1048576||await digest(raw)!==pin)throw new Error('prepared release descriptor corrupt');
    const manifest=decodeMachineManifest(raw),stats={fetches:0,fetchedBytes:0,cacheHits:0};
    async function read(name,at,n){
      if(closed)throw new Error('prepared release owner closed');const row=manifest.objects[name];
      if(!row||!Number.isSafeInteger(at)||!Number.isInteger(n)||at<0||n<1||n>4194304||at>row.bytes-n)throw new Error('bounded prepared artifact extent');
      const output=new Uint8Array(n);
      for(let done=0;done<n;){const position=at+done,rank=Math.floor(position/65536),bytes=await store.get('chunks',row.chunks[rank]);
        const length=Math.min(65536,row.bytes-rank*65536);
        if(!bytes||bytes.length!==length||await digest(bytes)!==row.chunks[rank])throw new Error('prepared release body missing or corrupt');
        const within=position%65536,take=Math.min(n-done,length-within);output.set(bytes.subarray(within,within+take),done);done+=take;++stats.cacheHits;
      }
      return output;
    }
    async function verify(){const roles={};
      for(const name of names){const row=manifest.objects[name],whole=new Uint8Array(row.bytes);
        for(let at=0;at<row.bytes;at+=65536){const n=Math.min(65536,row.bytes-at);whole.set(await read(name,at,n),at);}
        if(await digest(whole)!==row.sha256)throw new Error('prepared release whole-object identity differs');
        roles[name]={bytes:row.bytes,sha256:row.sha256};
      }
      return roles;
    }
    return {manifest,identity:pin,raw,read,verify,stats,close(){if(!closed){closed=true;store.close();}}};
  }catch(error){store.close();throw error;}
}
// Reopening a prepared release needs no network. Only a never-prepared pin
// permits initial delivery; damaged cached bodies remain an explicit failure.
export async function ensurePreparedMachineRelease(url,pin,options={}){
  let artifact;
  try{artifact=await openPreparedMachineRelease(pin);await artifact.verify();}
  catch(error){if(error.code!=='PREPARED_RELEASE_MISSING')throw error;
    return prepareMachineRelease(url,pin,options);
  }finally{artifact?.close();}
  return {identity:pin,manifest:artifact.manifest};
}
