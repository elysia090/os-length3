// Optional opaque HTTP tier. Grants locate bytes; they never supply keys or
// approve a release/head. PersistentBlock still authenticates every envelope.
const same=(a,b)=>a===null?b===null:b!==null&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
function objectKey(key){if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new TypeError('ciphertext object identity');}
function body(bytes,limit){if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>limit)throw new RangeError('bounded opaque body');return bytes;}
function strongTag(tag){if(typeof tag!=='string'||!/^"[^"\r\n]{1,256}"$/.test(tag))throw new Error('strong conditional-write ETag required');return tag;}
export class PublicationUncertain extends Error{
  constructor(){super('head publication outcome unknown; retain and reconcile the exact prepared envelope');this.name='PublicationUncertain';}
}
export class HttpCiphertextStore{
  constructor({grant,fetch:fetcher=globalThis.fetch,objectBytes=65536,headBytes=4096,timeoutMs=30000,allowLoopback=false}={}){
    if(typeof grant!=='function'||typeof fetcher!=='function'||!Number.isSafeInteger(objectBytes)||objectBytes<1||objectBytes>1048576
      ||!Number.isSafeInteger(headBytes)||headBytes<1||headBytes>65536||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)
      throw new TypeError('explicit bounded object-store grant');
    Object.assign(this,{grant,fetcher,objectBytes,headBytes,timeoutMs,allowLoopback});this.closed=false;this.abort=new AbortController();
  }
  async request(method,key,{bytes,condition}={}){
    if(this.closed)throw new Error('object-store transport closed');
    // The trusted Supervisor issues an operation-specific URL/authorization.
    // No ambient cookies, redirect authority, bucket listing or delete API.
    let url,headers;try{const permit=await this.grant({method,key,condition});url=new URL(permit?.url);headers=new Headers(permit.headers);}
    catch{throw new Error('object-store grant unavailable or invalid');}
    if(url.username||url.password||url.hash||!(url.protocol==='https:'||(this.allowLoopback&&url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname))))
      throw new Error('approved HTTPS object-store endpoint required');
    if(condition)headers.set(condition.name,condition.value);
    if(bytes)headers.set('Content-Type','application/octet-stream');
    // Keep the deadline alive through body consumption, not only headers.
    const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(this.timeoutMs)]);
    try{return await this.fetcher(url,{method,headers,body:bytes,signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});}
    catch{throw new Error('object-store request failed');} // never leak signed URLs/tokens
  }
  async bounded(response,limit){
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^[0-9]+$/.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>limit)){
      await response.body?.cancel();throw new Error('object-store response extent');}
    const reader=response.body?.getReader();if(!reader)throw new Error('object-store response body missing');
    const chunks=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;
      if(length>limit)throw new Error('object-store response extent');chunks.push(value);}
    }catch{await reader.cancel().catch(()=>{});throw new Error('object-store body incomplete or oversized');}
    finally{reader.releaseLock();}
    if(!length||(declared!==null&&Number(declared)!==length))throw new Error('object-store response extent');
    const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;
  }
  async get(key){objectKey(key);const response=await this.request('GET',key);
    if(response.status===404){await response.body?.cancel();return null;}
    if(response.status!==200){await response.body?.cancel();throw new Error('object-store fetch refused');}
    const bytes=await this.bounded(response,this.objectBytes);if(await digest(bytes)!==key)throw new Error('ciphertext object digest mismatch');return bytes;
  }
  async put(key,bytes){objectKey(key);body(bytes,this.objectBytes);bytes=bytes.slice();
    if(await digest(bytes)!==key)throw new Error('ciphertext object digest mismatch');
    const response=await this.request('PUT',key,{bytes,condition:{name:'If-None-Match',value:'*'}});
    const accepted=[200,201,204,412].includes(response.status);await response.body?.cancel();
    if(!accepted)throw new Error('immutable object push refused');
    // A successful status/ETag is not an integrity proof or a durable head.
    if(!same(await this.get(key),bytes))throw new Error('immutable object readback differs');return true;
  }
  async head(){const response=await this.request('GET',null);
    if(response.status===404){await response.body?.cancel();return {bytes:null,etag:null};}
    if(response.status!==200){await response.body?.cancel();throw new Error('head fetch refused');}
    let etag;try{etag=strongTag(response.headers.get('etag'));}catch(error){await response.body?.cancel();throw error;}
    const bytes=await this.bounded(response,this.headBytes);return {bytes,etag};
  }
  async read(){return (await this.head()).bytes;}
  async compareAndSwap(expected,replacement){
    if(expected!==null)body(expected,this.headBytes);body(replacement,this.headBytes);replacement=replacement.slice();
    const prior=await this.head();if(!same(expected,prior.bytes))return false;
    let response;
    try{response=await this.request('PUT',null,{bytes:replacement,condition:prior.etag===null
      ?{name:'If-None-Match',value:'*'}:{name:'If-Match',value:prior.etag}});}
    catch{throw new PublicationUncertain();}
    const status=response.status;await response.body?.cancel().catch(()=>{});
    if(status===412||status===409)return false;
    if(![200,201,204].includes(status))throw new PublicationUncertain();
    try{if(!same((await this.head()).bytes,replacement))throw new PublicationUncertain();}
    catch{throw new PublicationUncertain();}return true;
  }
  // Supply BOTH envelopes from trusted retained intent, never from a mirror.
  async reconcile(expected,replacement){body(replacement,this.headBytes);if(expected!==null)body(expected,this.headBytes);
    const current=await this.read();if(same(current,replacement))return 'committed';if(same(current,expected))return 'unchanged';return 'conflict';
  }
  close(){this.closed=true;this.abort.abort();}
}
