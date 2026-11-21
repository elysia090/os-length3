// Observation only: these counters never complete, merge or admit a transport receipt.
import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

const phaseNames=['first','revisit'],profiles=['local-revalidate','local-immutable'];
const MAX_EVENTS=32768, MAX_ROWS=8192, MAX_COUNTER=8192;
const headerName='x-ricebox-receipt';
const keys=[
  'origin-worker-script-responses','worker-request-without-response','worker-response-without-request',
  'worker-raw-orphan-current-origin','worker-cross-session-same-id-unique',
  'worker-split-request-and-response','worker-split-request-and-response-ancestor',
  'worker-split-finish-only-on-response-side','worker-split-neither-has-finish',
  'worker-cross-session-same-id-ambiguous','worker-orphan-conflicting-header',
  'duplicate-origin-receipts','duplicate-origin-worker-scripts','duplicate-within-session',
  'duplicate-across-sessions','duplicate-across-sessions-same-request-id','duplicate-across-sessions-distinct-request-id',
  'duplicate-across-related-sessions','duplicate-with-page-and-worker','duplicate-all-raw-extra',
  'duplicate-all-renderer','duplicate-mixed-header-sources','duplicate-header-source-unproven',
  'duplicate-raw-renderer-id-conflict',
  'matched-raw-status-mismatch','matched-effective-status-mismatch-without-raw','matched-wire-304-effective-200',
  'matched-request-range-mismatch','matched-content-range-mismatch',
  'capture-duplicate-session','capture-child-not-paused','capture-runtime-exception','capture-unattached-target','capture-other',
];
const eventsOfInterest=new Map([
  ['Network.requestWillBeSent','req'],['Network.responseReceived','res'],
  ['Network.responseReceivedExtraInfo','extra'],['Network.loadingFinished','finish'],
]);
const rowLimit=rows=>Array.isArray(rows)&&rows.length<=MAX_ROWS;
const idString=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\u0000-\u001f\u007f]/.test(x);
const worker=x=>['worker','shared_worker','service_worker'].includes(x);
const browserKey=(session,id)=>JSON.stringify([session,id]);
const header=(headers,name)=>{
  const values=Object.entries(headers??{}).filter(([k])=>k.toLowerCase()===name);
  return values.length===1&&typeof values[0][1]==='string'?values[0][1]:null;
};
function ancestor(targets,a,b){
  if(a===b||!targets.has(a)||!targets.has(b))return false;
  for(let current=b,n=0;n<16;n++){
    current=targets.get(current)?.parent;
    if(current===a)return true;
    if(!current) return false;
  }
  return false;
}

export function observeWorkerAttribution({events,targets,origin,browser,errors,isAllowedWorker}){
  if(!Array.isArray(events)||events.length>MAX_EVENTS||!(targets instanceof Map)||targets.size>128||
     ![origin,browser,errors].every(rowLimit)||typeof isAllowedWorker!=='function')return null;
  const counts=Object.fromEntries(keys.map(k=>[k,0])), bump=k=>{counts[k]++};
  const byReceipt=new Map(), raw=new Map(), byRequest=new Map();
  for(const row of origin){
    if(!idString(row.id)||byReceipt.has(row.id))return null; // Same server ID is a different failure, not attribution.
    byReceipt.set(row.id,row);
    if(isAllowedWorker(row.url))bump('origin-worker-script-responses');
  }
  for(const {method,sessionId,params} of events){
    const field=eventsOfInterest.get(method), id=params?.requestId;
    if(!field||!idString(sessionId)||!idString(id))continue;
    const key=browserKey(sessionId,id);
    if(!raw.has(key)){
      const item={sessionId,id,req:[],res:[],extra:[],finish:[]};
      raw.set(key,item);
      if(!byRequest.has(id))byRequest.set(id,[]);
      byRequest.get(id).push(item);
    }
    raw.get(key)[field].push(params);
    if(raw.size>MAX_ROWS)return null;
  }
  for(const item of raw.values()){
    const request=item.req.length===1&&!item.req[0].redirectResponse?item.req[0].request:null;
    if(request?.url&&isAllowedWorker(request.url)&&!item.res.length&&!item.extra.length)bump('worker-request-without-response');
    if(item.req.length||item.res.length>1||item.extra.length>1)continue;
    const rawId=header(item.extra[0]?.headers,headerName);
    const rendererId=header(item.res[0]?.response?.headers,headerName);
    const candidates=[rawId,rendererId].filter(Boolean);
    const linked=candidates.map(id=>byReceipt.get(id)).filter(o=>o&&isAllowedWorker(o.url));
    if(new Set(candidates).size>1){
      if(linked.length)bump('worker-orphan-conflicting-header');
      continue;
    }
    if(!linked.length)continue;
    const o=linked[0];
    bump('worker-response-without-request');
    if(rawId===o.id)bump('worker-raw-orphan-current-origin');
    if(item.res.length&&item.res[0].response?.url!==o.url)continue;
    const partners=(byRequest.get(item.id)??[]).filter(r=>r.sessionId!==item.sessionId&&
      targets.has(r.sessionId)&&targets.has(item.sessionId)&&r.req.length===1&&!r.req[0].redirectResponse&&
      r.req[0].request?.url===o.url&&r.req[0].request?.method===o.method);
    if(partners.length>1){bump('worker-cross-session-same-id-ambiguous');continue;}
    if(partners.length!==1)continue;
    bump('worker-cross-session-same-id-unique');
    const [partner]=partners;
    if(partner.res.length||partner.extra.length)continue;
    // A correlation candidate, not a claim these rows are one request.
    bump('worker-split-request-and-response');
    if(!partner.finish.length&&item.finish.length===1)bump('worker-split-finish-only-on-response-side');
    if(!partner.finish.length&&!item.finish.length)bump('worker-split-neither-has-finish');
    if(ancestor(targets,partner.sessionId,item.sessionId)||ancestor(targets,item.sessionId,partner.sessionId))
      bump('worker-split-request-and-response-ancestor');
  }
  const joined=new Map();
  for(const item of browser){
    // Only rows already joined by the original gate. Missing rows stay missing.
    if(!Object.hasOwn(item,'originReceipt'))continue;
    const o=byReceipt.get(item.originReceipt);
    if(!o)return null;
    if(!joined.has(o.id))joined.set(o.id,[]);
    const views=joined.get(o.id);
    views.push(item);
    if(views.length>64)return null;
    if(item.rawStatus!==null){
      if(item.rawStatus!==o.status)bump('matched-raw-status-mismatch');
      if(o.status===304&&item.rawStatus===304&&item.effectiveStatus===200)bump('matched-wire-304-effective-200');
    }else if(item.effectiveStatus!==o.status)bump('matched-effective-status-mismatch-without-raw');
    if(item.range!==o.range)bump('matched-request-range-mismatch');
    if(item.contentRange!==o.contentRange)bump('matched-content-range-mismatch');
  }
  for(const [id,views] of joined){
    if(views.length<2)continue;
    bump('duplicate-origin-receipts');
    if(isAllowedWorker(byReceipt.get(id).url))bump('duplicate-origin-worker-scripts');
    const sessions=new Set(views.map(x=>x.sessionId));
    if(sessions.size===1)bump('duplicate-within-session');
    else{
      bump('duplicate-across-sessions');
      if(views.some((a,i)=>views.slice(i+1).some(b=>a.sessionId!==b.sessionId&&a.requestId===b.requestId)))
        bump('duplicate-across-sessions-same-request-id');
      if(views.some((a,i)=>views.slice(i+1).some(b=>a.sessionId!==b.sessionId&&a.requestId!==b.requestId)))
        bump('duplicate-across-sessions-distinct-request-id');
      if(views.some((a,i)=>views.slice(i+1).some(b=>ancestor(targets,a.sessionId,b.sessionId)||ancestor(targets,b.sessionId,a.sessionId))))
        bump('duplicate-across-related-sessions');
    }
    if(views.some(v=>v.target==='page')&&views.some(v=>worker(v.target)))bump('duplicate-with-page-and-worker');
    let conflicting=false;
    const sources=views.map(v=>{
      const r=raw.get(browserKey(v.sessionId,v.requestId));
      if(!r||r.extra.length>1||r.res.length>1)return null;
      const rawId=header(r.extra[0]?.headers,headerName);
      const rendererId=header(r.res[0]?.response?.headers,headerName);
      if(rawId&&rendererId&&rawId!==rendererId)conflicting=true;
      if(r.extra.length===1)return rawId===id?'raw':null;
      return rendererId===id?'renderer':null;
    });
    if(conflicting)bump('duplicate-raw-renderer-id-conflict');
    if(sources.some(s=>s===null))bump('duplicate-header-source-unproven');
    else if(sources.every(s=>s==='raw'))bump('duplicate-all-raw-extra');
    else if(sources.every(s=>s==='renderer'))bump('duplicate-all-renderer');
    else bump('duplicate-mixed-header-sources');
  }
  for(const message of errors){
    if(typeof message!=='string')return null;
    if(message.startsWith('Duplicate target session: '))bump('capture-duplicate-session');
    else if(message.startsWith('Child not paused before capture: '))bump('capture-child-not-paused');
    else if(message.startsWith('Uncaught page/Worker exception: '))bump('capture-runtime-exception');
    else if(/^Unattached (worker|shared_worker|service_worker|iframe) detected: /.test(message))bump('capture-unattached-target');
    else bump('capture-other');
  }
  return {schema:'rx-worker-attribution-v1',counts};
}

const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX_COUNTER;
function render(phase,profile,observation){
  const prefix='RX_EVERYDAY_WORKER_ATTRIBUTION '+profile+' '+phase+' ';
  const counts=observation?.counts;
  if(observation?.schema!=='rx-worker-attribution-v1'||!counts||Object.keys(counts).length!==keys.length||
     !keys.every(k=>Object.hasOwn(counts,k)&&integer(counts[k])))return [prefix+'unavailable'];
  return [prefix+'observed',...keys.filter(k=>counts[k]>0).map(k=>prefix+k+'='+counts[k])];
}
const validRun=(r,profile,pin)=>{
  const sandbox=r?.sandbox;
  if(r?.profile!==profile||r.sameReleaseDigest!==pin||r.runError!==null||r.diagnosticFailure!==null||
     !/^(?:Headless)?Chrome\/[0-9.]+$/.test(r.browser?.product??'')||
     !['Namespace','SUID'].includes(sandbox?.layer)||sandbox?.pid!=='Yes'||sandbox?.network!=='Yes'||sandbox?.seccomp!=='Yes'||
     typeof r.pass!=='boolean'||!Array.isArray(r.phases)||r.phases.length!==2)return false;
  if(!r.phases.every((p,i)=>p?.phase===phaseNames[i]&&typeof p.pass==='boolean'&&
    typeof p.coverageComplete==='boolean'&&p.observations?.stage==='prompt'&&
    p.observations.focus==='host-focus'&&p.observations.marker===true&&p.observations.cleanExit===true&&
    /^RICEBOX-BOOT:[0-9]+$/.test(p.observations.expectedMarker??'')))return false;
  return r.phases[0].observations.expectedMarker!==r.phases[1].observations.expectedMarker;
};
function load(file,max){
  const s=lstatSync(file);
  if(!s.isFile()||s.size>max)throw Error('Invalid private input');
  return JSON.parse(readFileSync(file,'utf8'));
}
export function renderWorkerAttribution(directory,pinsFile){
  const pin=load(pinsFile,4096)?.webroot;
  if(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))throw Error('Invalid expected pin');
  const out=[];
  for(const profile of profiles){
    let r;
    try{r=load(join(directory,profile+'.stdout'),16*1024*1024);}catch{}
    if(!validRun(r,profile,pin)){out.push('RX_EVERYDAY_WORKER_ATTRIBUTION '+profile+' unavailable');continue;}
    for(const p of r.phases)out.push(...render(p.phase,profile,p.workerAttribution));
  }
  return out;
}
if(import.meta.main){
  try{
    const [directory,pins,...extra]=process.argv.slice(2);
    if(!directory||!pins||extra.length)throw Error('Invalid diagnostic input');
    for(const line of renderWorkerAttribution(directory,pins))console.log(line);
  }catch{console.log('RX_EVERYDAY_WORKER_ATTRIBUTION unavailable');process.exitCode=1;}
}
