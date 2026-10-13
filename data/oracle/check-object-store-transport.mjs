import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {HttpCiphertextStore,PublicationUncertain} from '../../src/v2/web/object-store-transport.mjs';
import {importStorageMasterKey,commitRootPublication} from '../../src/v2/web/ciphertext-storage.js';
import {PersistentBlock} from '../../src/v2/web/persistent-block.mjs';
const objects=new Map(),requests=[];let head=null,sequence=0,corrupt=false,oversize=false,loseAck=false,race=false,weak=false,slow=false;
const server=createServer(async(req,res)=>{
  const key=req.url==='/head'?null:req.url.slice('/objects/'.length);requests.push({method:req.method,key,condition:req.headers['if-match']??req.headers['if-none-match']??null});
  if(req.method==='GET'){
    const bytes=key===null?head:objects.get(key);if(!bytes){res.writeHead(404).end();return;}
    const tag=weak?'W/"weak"':`"revision-${sequence}"`;
    res.writeHead(200,{'Content-Length':oversize?'9999999':bytes.length,...(key===null?{ETag:tag}:{})});
    const out=bytes.slice();if(corrupt)out[0]^=1;
    if(slow){res.write(out.subarray(0,1));const timer=setTimeout(()=>res.end(out.subarray(1)),1000);res.on('close',()=>clearTimeout(timer));return;}
    res.end(out);return;
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=new Uint8Array(Buffer.concat(chunks));
  if(key!==null){if(req.headers['if-none-match']!=='*'){res.writeHead(400).end();return;}
    if(objects.has(key)){res.writeHead(412).end();return;}objects.set(key,bytes);res.writeHead(201).end();return;}
  if(race){race=false;head=new Uint8Array([98]);++sequence;}
  if(head===null?req.headers['if-none-match']!=='*':req.headers['if-match']!==`"revision-${sequence}"`){res.writeHead(412).end();return;}
  head=bytes;++sequence;if(loseAck){loseAck=false;req.socket.destroy();return;}res.writeHead(204).end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const store=new HttpCiphertextStore({grant:({key})=>({url:origin+(key===null?'/head':`/objects/${key}`)}),allowLoopback:true,timeoutMs:5000});
try{
  const bytes=new Uint8Array([1,2,3]),key=createHash('sha256').update(bytes).digest('hex');
  await store.put(key,bytes);await store.put(key,bytes);assert.deepEqual(await store.get(key),bytes);
  corrupt=true;await assert.rejects(store.get(key),/digest/);corrupt=false;
  oversize=true;await assert.rejects(store.get(key),/extent/);oversize=false;
  await assert.rejects(store.put(key,new Uint8Array([4])),/digest/);
  slow=true;const timed=new HttpCiphertextStore({grant:()=>({url:origin+`/objects/${key}`}),allowLoopback:true,timeoutMs:50});
  await assert.rejects(timed.get(key),/incomplete|request failed/);timed.close();
  const closing=new HttpCiphertextStore({grant:()=>({url:origin+`/objects/${key}`}),allowLoopback:true});
  const interrupted=assert.rejects(closing.get(key),/incomplete|request failed/);await new Promise(r=>setTimeout(r,20));closing.close();await interrupted;slow=false;
  const first=new Uint8Array([10]),next=new Uint8Array([11]);assert(await store.compareAndSwap(null,first));
  race=true;assert.equal(await store.compareAndSwap(first,next),false);assert.equal(await store.reconcile(first,next),'conflict');
  head=first;++sequence;loseAck=true;await assert.rejects(store.compareAndSwap(first,next),PublicationUncertain);
  assert.equal(await store.reconcile(first,next),'committed');assert.deepEqual(await commitRootPublication({register:store,expectedEnvelope:first,envelope:next}),next);
  assert.equal(await store.reconcile(next,first),'unchanged');weak=true;await assert.rejects(store.read(),/strong/);weak=false;
  // Real encryption/radix publication on this HTTP tier, no guest VFS substitute.
  head=null;++sequence;const config={store,masterKey:await importStorageMasterKey(new Uint8Array(32).fill(45)),
    volumeId:new Uint8Array(16).fill(20),volumeSalt:new Uint8Array(32).fill(30),bytes:16*1048576};
  let volume=await PersistentBlock.open({...config,create:true});await volume.write(4000,new Uint8Array(4096).fill(17));
  const checkpoint=await volume.checkpoint();assert(requests.filter(r=>r.method==='PUT'&&r.key!==null).every(r=>r.condition==='*'));
  await volume.close();const reopened=new HttpCiphertextStore({grant:({key})=>({url:origin+(key===null?'/head':`/objects/${key}`)}),allowLoopback:true});
  volume=await PersistentBlock.open({...config,store:reopened,expectedHead:checkpoint});assert.deepEqual(await volume.read(4000,4096),new Uint8Array(4096).fill(17));
  const stale=checkpoint.slice();stale[0]^=1;await assert.rejects(PersistentBlock.open({...config,store:reopened,expectedHead:stale}),/rollback/);
  await volume.close();
  const redirect=new HttpCiphertextStore({grant:()=>({url:origin+'/head'}),allowLoopback:true,fetch:async(_url,init)=>{
    assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.referrerPolicy,'no-referrer');throw new Error('secret-url-token');}});
  await assert.rejects(redirect.read(),e=>e.message==='object-store request failed');
  const remote=new HttpCiphertextStore({grant:()=>({url:'http://example.com/objects/token'})});await assert.rejects(remote.read(),/HTTPS/);
  const badGrant=new HttpCiphertextStore({grant:()=>{throw new Error('secret-url-token');}});await assert.rejects(badGrant.read(),e=>e.message==='object-store grant unavailable or invalid');
  console.log(JSON.stringify({status:'pass',scope:'loopback HTTP transport plus real PersistentBlock encryption; no deployed S3/CORS/credential claim',
    cases:['idempotent immutable push/readback','corruption','response bound','invalid local digest','conditional head race','lost successful CAS acknowledgement/exact envelope reconcile',
      'weak ETag refusal','real encrypted page publication/reopen','trusted stale head refusal','no ambient credentials/redirects/secret error output','HTTPS requirement',
      'body-consumption timeout','close aborts in-flight response','grant error redaction']}));
}finally{store.close();await new Promise(r=>server.close(r));}
