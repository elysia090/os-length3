import {receiptHeader} from './origin.mjs';

const header=(headers,name)=>Object.entries(headers??{}).find(([k])=>k.toLowerCase()===name)?.[1]??null;
const http=url=>/^https?:/.test(url??'');
const frozenGroups=new Set(['index','wasm','root']);
const targetWorker=type=>['worker','shared_worker','service_worker'].includes(type);
const counts=()=>({requests:0,bodyBytes:0,status:{},pageRequests:0,workerRequests:0});

export function collectBrowser(events,targets) {
  const ledger=new Map();
  for(const {method,sessionId,params:p} of events) {
    if(!p.requestId) continue;
    const key=sessionId+'\t'+p.requestId;
    if(!ledger.has(key)) ledger.set(key,{sessionId,requestId:p.requestId,encodedData:0,sawEncodedData:false});
    const row=ledger.get(key);
    if(method==='Network.requestWillBeSent') {
      if(row.request||p.redirectResponse) row.redirect=true;
      row.request=p.request;
    } else if(method==='Network.requestWillBeSentExtraInfo') row.requestExtra=p.headers;
    else if(method==='Network.responseReceived') {
      if(row.response) row.ambiguous=true;
      row.response=p.response; row.hasExtra=!!p.hasExtraInfo;
    } else if(method==='Network.responseReceivedExtraInfo') {
      if(row.responseExtra) row.ambiguous=true;
      row.responseExtra=p;
    } else if(method==='Network.requestServedFromCache') row.memoryCache=true;
    else if(method==='Network.loadingFailed') row.failed=p.errorText??'unknown';
    else if(method==='Network.loadingFinished') row.finishedEncodedTotal=p.encodedDataLength;
    else if(method==='Network.dataReceived' && Number.isFinite(p.encodedDataLength) && p.encodedDataLength>0) {
      row.sawEncodedData=true; row.encodedData+=p.encodedDataLength;
    }
  }
  return Array.from(ledger.values(),row=>{
    const req=row.request, rsp=row.response, extra=row.responseExtra, target=targets.get(row.sessionId);
    const effectiveStatus=rsp?.status??null, rawStatus=extra?.statusCode??null;
    const cacheFlags={memory:!!row.memoryCache,disk:!!rsp?.fromDiskCache,
      prefetch:!!rsp?.fromPrefetchCache,serviceWorker:!!rsp?.fromServiceWorker};
    const cache=Object.values(cacheFlags).some(Boolean)&&rawStatus===null;
    const reqHeader=name=>header(row.requestExtra,name)??header(rsp?.requestHeaders,name)??header(req?.headers,name);
    const responseHeaders=extra?.headers??rsp?.headers;
    return {
      target:target?.type??null,targetUrl:target?.url??null,sessionId:row.sessionId,requestId:row.requestId,
      url:req?.url??rsp?.url??null,requested:!!req,method:req?.method??null,
      range:reqHeader('range'),conditional:reqHeader('if-none-match'),requestCacheControl:reqHeader('cache-control'),
      effectiveStatus,rawStatus,status:rawStatus??effectiveStatus,
      receiptId:cache?null:header(responseHeaders,receiptHeader),cache,cacheFlags,
      cacheControl:header(responseHeaders,'cache-control'),encoding:header(responseHeaders,'content-encoding'),
      contentRange:header(responseHeaders,'content-range'),
      // Positive CDP chunk counters are a second body observation. Their absence
      // is unknown, not zero. loadingFinished is a separate transport total.
      cdpEncodedBodyBytes:row.sawEncodedData?row.encodedData:null,
      cdpFinishedEncodedTotal:row.finishedEncodedTotal??null,
      redirect:!!row.redirect,ambiguous:!!row.ambiguous,failed:row.failed??null,
      missingExtra:row.hasExtra&&!extra,complete:row.finishedEncodedTotal!==undefined,
    };
  });
}

export function buildReceipt({phase,events,targets,errors=[],origin,scope,requireAssets=[],requireWorkerAssets=[],
  requireWorkers=[],requireWorkerPack=false,isAllowedWorker=()=>false,isDisplay=()=>false,observations=null}) {
  const coverage=[...errors], misuse=[], results=[], totals={}, matched=new Set(), addresses=new Map();
  const originRows=origin.filter(row=>row.phase===phase);
  const captured=collectBrowser(events,targets);
  const browserRows=captured.filter(row=>http(row.url));
  const originByID=new Map(originRows.map(row=>[row.id,row]));
  if(originRows.length!==originByID.size) coverage.push('Duplicate controlled-origin receipt ID');
  const workerURLs=new Set();
  for(const target of targets.values()) {
    if(!target.enabled) coverage.push('Network not enabled for target '+target.sessionId);
    if(!targetWorker(target.type)) continue;
    if(!target.url) coverage.push('Unknown Worker script: '+target.sessionId);
    else if(isDisplay(target.url)) misuse.push('Display Worker before opt-in: '+target.url);
    else if(!isAllowedWorker(target.url)) coverage.push('Unrecognized Worker script: '+target.url);
    workerURLs.add(target.url);
  }
  for(const url of requireWorkers) if(!workerURLs.has(url)) coverage.push('Missing Worker target: '+url);

  // Ancillary favicon omitted by caller's scope must not mask unknown asset paths.
  for(const b of captured) if(!b.url&&(b.status!==null||b.failed||b.complete)) {
    coverage.push('CDP network event missing its request URL: '+b.sessionId+'/'+b.requestId);
  }
  for(const b of browserRows) {
    if(isDisplay(b.url)) misuse.push('Display request before opt-in: '+b.url);
    const group=scope(b.url);
    if(group==='ignore') continue;
    if(!group) {coverage.push('Unexpected browser URL: '+b.url);continue;}
    if(b.redirect||b.ambiguous||!b.requested||b.failed||b.missingExtra||!b.complete||!b.target||b.status===null) {
      coverage.push('Incomplete or ambiguous CDP request: '+b.url+' '+b.requestId+(b.failed?' '+b.failed:''));
    }
    if(b.cacheFlags.serviceWorker) coverage.push('Unexpected Service Worker cache path: '+b.url);
    const o=originByID.get(b.receiptId);
    if(b.cache) {
      if(![200,206].includes(b.status)) coverage.push('Unexpected local-cache status '+b.status+': '+b.url);
      if(b.cdpEncodedBodyBytes!==null) coverage.push('Local cache classification conflicts with encoded CDP data: '+b.url);
      // Do not match a stale cache-stored receipt header for an earlier response.
      results.push({...b,group,classification:'browser-cache',bodyBytes:null});
      continue;
    }
    if(!o) {
      coverage.push('Browser request without a matching current origin receipt: '+b.url);
      results.push({...b,group,classification:'unknown',bodyBytes:null});continue;
    }
    if(matched.has(o.id)) coverage.push('Duplicate CDP receipt for origin response: '+o.id);
    matched.add(o.id);
    if(!o.completed||!Number.isSafeInteger(o.bytes)||o.bytes<0) coverage.push('Incomplete origin response: '+b.url);
    if(b.url!==o.url||b.status!==o.status||b.method!==o.method||b.range!==o.range||
      b.contentRange!==o.contentRange||b.encoding!==o.encoding) coverage.push('Browser/origin mismatch: '+b.url);
    // The raw request headers are not implemented on every target; the origin
    // remains authoritative for If-None-Match and Cache-Control sent on wire.
    if(b.cdpEncodedBodyBytes!==null&&b.cdpEncodedBodyBytes!==o.bytes) {
      coverage.push('Encoded CDP chunk total disagrees with origin: '+b.url);
    }
    if(o.status===304&&o.bytes!==0) coverage.push('Invalid body on 304: '+b.url);
    if(![200,206,304].includes(o.status)) coverage.push('Unexpected HTTP '+o.status+': '+b.url);
    if(o.method==='GET'&&o.status===200&&o.range&&group==='root') {
      // A server can ignore a Range; don't call the resulting full response 206.
      misuse.push('Root Range answered 200; full body served: '+b.url+' '+o.range);
    }
    const classification=o.status===304?'network-revalidation':o.status===206?'network-range':'network-response';
    const summary=totals[group]??=counts();
    summary.requests++;summary.bodyBytes+=o.bytes??0;summary.status[o.status]=(summary.status[o.status]??0)+1;
    if(b.target==='page') summary.pageRequests++;
    else if(targetWorker(b.target)) summary.workerRequests++;
    if(o.method==='GET'&&[200,206].includes(o.status)&&frozenGroups.has(group)) {
      const k=o.url+'\t'+(o.status===206?o.contentRange:'(full)');
      addresses.set(k,(addresses.get(k)??0)+1);
    }
    results.push({...b,group,classification,bodyBytes:o.bytes,originReceipt:o.id});
  }
  for(const o of originRows) {
    if(isDisplay(o.url)) misuse.push('Origin served display before opt-in: '+o.url);
    const group=scope(o.url);
    if(group!=='ignore'&&!matched.has(o.id)) coverage.push('Origin response missing from page/Worker capture: '+o.url+' '+o.status);
  }
  for(const u of requireAssets) {
    const found=results.filter(r=>r.url===u&&['network-response','network-range'].includes(r.classification)&&r.bodyBytes>0&&r.complete);
    if(!found.length) coverage.push('Expected first-load body missing: '+u);
    if(found.length>1) misuse.push('Expected exactly one first-load asset response: '+u);
  }
  if(requireWorkerPack&&!results.some(r=>r.group==='root'&&new URL(r.url).pathname.endsWith('.pack')
    &&targetWorker(r.target)&&r.bodyBytes>0&&r.complete)) coverage.push('Missing first-load Worker pack data');
  for(const u of requireWorkerAssets) {
    if(!results.some(r=>r.url===u&&targetWorker(r.target)&&r.classification==='network-range'&&r.bodyBytes>0&&r.complete)) {
      coverage.push('Expected first-load Worker Range body missing: '+u);
    }
  }
  for(const [key,count] of addresses) {
    if(count>1) misuse.push('Repeated full request or identical Content-Range: '+key+' × '+count);
  }
  const repeatedPayloadBodyBytes=[...frozenGroups].reduce((n,k)=>n+(totals[k]?.bodyBytes??0),0);
  if(phase==='revisit'&&repeatedPayloadBodyBytes>0) misuse.push('Revisit sent '+repeatedPayloadBodyBytes+' index/Wasm/root response body bytes');
  return {phase,observations,coverageComplete:!coverage.length,pass:!coverage.length&&!misuse.length,coverage,failures:misuse,
    payloadBodyBytes:coverage.length?null:repeatedPayloadBodyBytes,totals,browser:results,origin:originRows,targets:[...targets.values()]};
}
