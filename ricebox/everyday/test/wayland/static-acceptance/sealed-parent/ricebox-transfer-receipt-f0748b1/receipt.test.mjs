import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {armCapture} from './capture.mjs';
import {buildReceipt,collectBrowser} from './receipt.mjs';
import {receiptHeader,serveRoutes,immutable,revalidate} from './origin.mjs';
import {diagnosticPlan,isDisplay} from './routes.mjs';

const get=(url,headers={},method='GET')=>new Promise((resolve,reject)=>{
  request(url,{headers,method},response=>{
    const chunks=[];
    response.on('data',b=>chunks.push(b));response.on('error',reject);
    response.on('end',()=>resolve({body:Buffer.concat(chunks),status:response.statusCode,headers:response.headers}));
  }).on('error',reject).end();
});

function synthetic({o,reply,sessionId,id,url,range,local=false,observedChunk=null,includeExtra=true,method='GET'}) {
  // This function synthesizes **CDP events**, not a browser request. o/reply
  // in integration tests come from actual Node-origin traffic.
  url??=o.url;
  const msg=(method,data)=>({method,sessionId,params:{requestId:id,...data}});
  const visible=o?.status===304?200:reply?.status??200;
  return [
    ...(includeExtra&&!local?[msg('Network.responseReceivedExtraInfo',{statusCode:o.status,headers:reply.headers})]:[]),
    msg('Network.requestWillBeSent',{request:{url,method,headers:range?{Range:range}:{}}}),
    ...(local?[msg('Network.requestServedFromCache',{})]:[]),
    msg('Network.responseReceived',{hasExtraInfo:includeExtra&&!local,
      response:{url,status:visible,headers:reply?.headers??{},fromDiskCache:local||o?.status===304}}),
    ...(observedChunk!==null?[msg('Network.dataReceived',{dataLength:99,encodedDataLength:observedChunk})]:[]),
    msg('Network.loadingFinished',{encodedDataLength:local?0:248+(o?.bytes??0)}),
  ];
}

test('real loopback statuses, payload lengths, validators, Range and gzip; synthetic CDP join',async t=>{
  const plan=await diagnosticPlan();t.after(async()=>{for(const server of plan.origins)await server.close();});
  const [main,cross]=plan.origins;
  const assets=plan.requireAssets;
  const [wasm,pack,manifest]=assets;
  const getId=reply=>reply.headers[receiptHeader];
  const find=(server,r)=>server.rows.find(row=>row.id===getId(r));
  const configsFor=phase=>({phase,origin:[...main.rows,...cross.rows],scope:plan.scope,isDisplay,isAllowedWorker:plan.isAllowedWorker,
    requireWorkers:plan.requireWorkers,targets});
  const targets=new Map([
    ['page',{sessionId:'page',type:'page',url:plan.url,enabled:true}],
    ['parent',{sessionId:'parent',type:'worker',url:plan.requireWorkers[0],enabled:true}],
    ['leaf',{sessionId:'leaf',type:'worker',url:plan.requireWorkers[1],enabled:true}],
  ]);
  for(const s of plan.origins)s.setPhase('first');
  const a=await get(wasm), b=await get(pack,{Range:'bytes=2-5'}), c=await get(manifest);
  assert.equal(a.status,200);assert.equal(a.body.length,28);assert.equal(gunzipSync(a.body).length,8);
  assert.equal(a.headers['access-control-allow-origin'],'*');assert.equal(a.headers['timing-allow-origin'],undefined);
  assert.equal(b.status,206);assert.equal(b.body.toString(),'cdef');assert.equal(b.headers['content-range'],'bytes 2-5/10');
  assert.equal(c.status,200);assert.equal(c.body.length,19);
  const firstEvents=[
    ...synthetic({o:find(cross,a),reply:a,sessionId:'page',id:'same-id',observedChunk:28}),
    ...synthetic({o:find(main,b),reply:b,sessionId:'leaf',id:'same-id',range:'bytes=2-5',observedChunk:4}),
    ...synthetic({o:find(main,c),reply:c,sessionId:'page',id:'manifest'}),
  ];
  const first=buildReceipt({...configsFor('first'),events:firstEvents,requireAssets:assets,requireWorkerAssets:[pack],
    observations:{resourceTiming:[{url:wasm,transferSize:0,encodedBodySize:0,decodedBodySize:0}]}});
  assert.deepEqual(first.coverage,[]);assert.deepEqual(first.failures,[]);assert.equal(first.payloadBodyBytes,32);
  assert.equal(first.totals.root.workerRequests,1);assert.deepEqual(first.totals.root.status,{206:1});
  assert.equal(first.totals.manifest.bodyBytes,19);
  const missingWorker=buildReceipt({...configsFor('first'),events:firstEvents.filter(e=>e.sessionId!=='leaf'),requireWorkerAssets:[pack]});
  assert.equal(missingWorker.pass,false);assert.equal(missingWorker.payloadBodyBytes,null);
  assert.match(missingWorker.coverage.join(' '),/Origin response missing from page\/Worker capture/);
  const wrongEncoded=firstEvents.map(e=>e.sessionId==='leaf'&&e.method==='Network.dataReceived'?
    {...e,params:{...e.params,encodedDataLength:3}}:e);
  assert.match(buildReceipt({...configsFor('first'),events:wrongEncoded}).coverage.join(' '),/Encoded CDP chunk total disagrees/);

  for(const s of plan.origins)s.setPhase('revisit');
  const d=await get(manifest,{'If-None-Match':c.headers.etag});
  assert.equal(d.status,304);assert.equal(d.body.length,0);assert.notEqual(getId(c),getId(d));
  const revisitEvents=[
    ...synthetic({reply:a,sessionId:'page',id:'same-id',url:wasm,local:true}),
    ...synthetic({o:find(main,d),reply:d,sessionId:'page',id:'manifest'}),
    // No browser network events for root when the application uses its cache.
  ];
  const revisit=buildReceipt({...configsFor('revisit'),events:revisitEvents});
  assert.equal(revisit.pass,true);assert.equal(revisit.payloadBodyBytes,0);
  assert.deepEqual(revisit.totals.manifest.status,{304:1});assert.equal(revisit.totals.manifest.bodyBytes,0);
  assert.equal(revisit.browser[0].classification,'browser-cache');
  assert.equal(revisit.browser[0].receiptId,null);
  assert.equal(revisit.browser[1].effectiveStatus,200);assert.equal(revisit.browser[1].rawStatus,304);
  assert.equal(revisit.browser[1].classification,'network-revalidation');

  const e=await get(pack,{range:'bytes=2-5'});
  const repeated=buildReceipt({...configsFor('revisit'),events:[
    ...revisitEvents,...synthetic({o:find(main,e),reply:e,sessionId:'leaf',id:'repeat',range:'bytes=2-5'}),
  ]});
  assert.equal(repeated.coverageComplete,true);assert.equal(repeated.pass,false);
  assert.equal(repeated.payloadBodyBytes,4);assert.match(repeated.failures.join(' '),/Revisit sent 4/);
  const f=await get(pack,{range:'bytes=2-5','if-range':'"does-not-match"'});
  assert.equal(f.status,200);assert.equal(f.body.length,10);
  const full=buildReceipt({...configsFor('revisit'),events:[
    ...revisitEvents,...synthetic({o:find(main,e),reply:e,sessionId:'leaf',id:'repeat',range:'bytes=2-5'}),
    ...synthetic({o:find(main,f),reply:f,sessionId:'leaf',id:'full',range:'bytes=2-5'}),
  ]});
  assert.equal(full.coverageComplete,true);assert.equal(full.payloadBodyBytes,14);
  assert.deepEqual(full.totals.root.status,{200:1,206:1});assert.match(full.failures.join(' '),/Range answered 200/);

  const display=await get(main.base+'/demo/display-worker.mjs');
  assert.equal(display.status,200); // prove the fixture made the script available
  targets.set('display',{sessionId:'display',type:'worker',enabled:true,url:main.base+'/demo/display-worker.mjs'});
  const displayFail=buildReceipt({...configsFor('revisit'),events:revisitEvents});
  assert.equal(displayFail.pass,false);
  assert.match(displayFail.failures.join(' '),/Display Worker before opt-in/);
  assert.match(displayFail.failures.join(' '),/Origin served display before opt-in/);
});

test('real controlled origin treats ignored range, suffix, 416 and HEAD separately',async t=>{
  const asset={body:'abcdefghij',mime:'application/octet-stream'};
  const o=await serveRoutes([
    ['/none',{...asset,cacheControl:revalidate}],
    ['/range',{...asset,ranges:true,cacheControl:immutable}],
  ]);t.after(()=>o.close());
  const full=await get(o.base+'/none',{range:'bytes=2-5'});
  assert.equal(full.status,200);assert.equal(full.body.length,10);
  const suffix=await get(o.base+'/range',{range:'bytes=-3'});
  assert.equal(suffix.status,206);assert.equal(suffix.body.toString(),'hij');
  const invalid=await get(o.base+'/range',{range:'bytes=11-30'});
  assert.equal(invalid.status,416);assert.equal(invalid.headers['content-range'],'bytes */10');
  const head=await get(o.base+'/range',{},'HEAD');
  assert.equal(head.status,200);assert.equal(head.headers['content-length'],'10');assert.equal(head.body.length,0);
  assert.deepEqual(o.rows.map(x=>x.bytes),[10,3,0,0]);
});

test('synthetic CDP does not infer body from decoded or loadingFinished sizes',()=>{
  const target={sessionId:'p',type:'page',url:'http://127.0.0.1:9000/demo/',enabled:true};
  const url=target.url;
  const row=collectBrowser(synthetic({o:{url,bytes:8,status:200},reply:{status:200,headers:{}},
    sessionId:'p',id:'1',url,observedChunk:0}),new Map([['p',target]]))[0];
  assert.equal(row.cdpEncodedBodyBytes,null);assert.equal(row.cdpFinishedEncodedTotal,256);
});

test('capture arms page, recursive Worker and child Worker before allowing them to run (mock transport)',async()=>{
  const calls=[];let listen;
  const fake={
    subscribe(fn){listen=fn;return()=>{listen=null;};},
    async command(method,params,session) {
      calls.push({method,params,session});
      if(method==='Target.createTarget')return {targetId:'page-id'};
      if(method==='Target.attachToTarget')return {sessionId:'page'};
      if(method==='Target.getTargets')return {targetInfos:[]};
      if(method==='Runtime.runIfWaitingForDebugger'&&session==='worker') spawn('leaf',session);
      return {};
    },
  };
  function spawn(sessionId,owner) {
    listen({method:'Target.attachedToTarget',sessionId:owner,params:{sessionId,
      waitingForDebugger:true,targetInfo:{targetId:sessionId+'-id',url:'http://localhost/'+sessionId+'.js',type:'worker'}}});
  }
  const armed=await armCapture(fake);spawn('worker','page');await armed.drain();
  assert.deepEqual(armed.errors,[]);
  const order=session=>calls.filter(c=>c.session===session).map(c=>c.method);
  assert.deepEqual(order('worker'),['Network.enable','Runtime.enable','Target.setAutoAttach','Runtime.runIfWaitingForDebugger']);
  assert.deepEqual(order('leaf'),order('worker'));assert.ok(armed.targets.get('leaf').enabled);
  await armed.close();
});
