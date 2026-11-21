// Only this closed trace grammar is public. Raw process output remains in runner temp.
import {appendFileSync,constants,lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {release} from 'node:os';

const stages=['doctor-invoke','doctor-owner','socket-unix','socket-ipv4','sandbox-fixture',
  'launch-storage','launch-spawn-call','browser-get-version','stock-product','cdp-target-arm',
  'cdp-sandbox-navigation','cdp-sandbox-report','cdp-sandbox-policy','cdp-target-cleanup','browser-cleanup'];
const statuses=new Set(['start','pass','hold']);
const socketCodes=new Set(['EPERM','EACCES','EAFNOSUPPORT','EPROTONOSUPPORT','EADDRINUSE','EMFILE','ENFILE','ENOSYS','OTHER']);
const chromeDigits='[0-9]{1,3}(?:\\.[0-9]{1,6}){3}';
const version=new RegExp('^'+chromeDigits+'$');
const bounded={
  image: /^ubuntu24\/[0-9]{8}\.[0-9]{1,5}(?:\.[0-9]{1,5})?$/,
  kernel: /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}-[0-9]{1,6}-(?:aws|azure|gcp|generic)$/,
  'chrome-package':version, 'chrome-cdp':version,
};
const doctorCodes=new Set(['STOCK_CHROME_MISSING','STOCK_CHROME_PROVENANCE_FAILED','REQUIRED_SOCKET_UNAVAILABLE']);
const append=(path,items)=>appendFileSync(path,JSON.stringify(items)+'\n',
  {flag:constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW});
const meta=(path,k,value)=>{
  if(Object.hasOwn(bounded,k)&&typeof value==='string'&&bounded[k].test(value))append(path,['meta',k,value]);
};
export function initTrace(path,env=process.env,kernel=release()){
  writeFileSync(path,'',{flag:'wx',mode:0o600});
  meta(path,'image',(env.ImageOS??'')+'/'+(env.ImageVersion??''));
  meta(path,'kernel',kernel);
}
export function traceMarker(path,stage,status,value){
  if(!stages.includes(stage)||!statuses.has(status))throw Error('Invalid trace marker');
  let code;
  if((stage==='socket-unix'||stage==='socket-ipv4')&&status==='hold'){
    code=socketCodes.has(value)?value:'OTHER';
  }
  append(path,code?['stage',stage,status,code]:['stage',stage,status]);
  if(stage==='browser-get-version'&&status==='pass'&&typeof value==='string'){
    const id=new RegExp('^(?:Headless)?Chrome/('+chromeDigits+')$').exec(value)?.[1];
    meta(path,'chrome-cdp',id);
  }
}
function getText(path,limit){
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw Error('Invalid private report');
  return readFileSync(path,'utf8');
}
export function readDoctor(path,file,exit){
  let doctor;
  try{doctor=JSON.parse(getText(file,4096));}catch{}
  if(!Number.isSafeInteger(exit)||doctor?.schema!=='ricebox-static-browser-doctor-v1'||doctor.navigation!=='not_run'||
    !['ready','blocked'].includes(doctor.status)||(doctor.status==='ready'?doctor.code!==null:!doctorCodes.has(doctor.code))){
    traceMarker(path,'doctor-invoke','hold');
    return false;
  }
  const pkg=typeof doctor.version==='string'&&new RegExp('^[0-9][0-9a-z.+:~\\-]{1,63}$','i').test(doctor.version);
  const owned=Boolean(pkg)&&(doctor.status==='ready'||doctor.code==='REQUIRED_SOCKET_UNAVAILABLE');
  traceMarker(path,'doctor-owner','start');
  traceMarker(path,'doctor-owner',owned?'pass':'hold');
  if(owned){
    const digits=new RegExp('^('+chromeDigits+')(?:-[0-9]{1,6})?$').exec(doctor.version)?.[1];
    meta(path,'chrome-package',digits);
  }
  for(const [key,stage] of [['unix','socket-unix'],['ipv4','socket-ipv4']]){
    const input=doctor.sockets?.[key];
    traceMarker(path,stage,'start');
    traceMarker(path,stage,input==='ok'?'pass':'hold',input);
  }
  const ready=exit===0&&doctor.status==='ready'&&owned&&doctor.sockets?.unix==='ok'&&doctor.sockets.ipv4==='ok';
  traceMarker(path,'doctor-invoke',ready?'pass':'hold');
  return ready;
}
export function renderTrace(path,requireComplete=false){
  const text=getText(path,8192);
  if(text&&!text.endsWith('\n'))throw Error('Partial trace record');
  const messages=[],seen=new Map(),reportedMeta=new Set();
  for(const line of text.split('\n').slice(0,-1)){
    const row=JSON.parse(line);
    if(!Array.isArray(row))throw Error('Malformed trace record');
    const [type,k,v,code]=row;
    if(type==='meta'){
      if(row.length!==3||!Object.hasOwn(bounded,k)||reportedMeta.has(k)||typeof v!=='string'||!bounded[k].test(v))throw Error('Malformed trace metadata');
      reportedMeta.add(k);
      messages.push('RX_EVERYDAY_CHROME_ENV '+k+'='+v);
    }else if(type==='stage'){
      if(!stages.includes(k)||!statuses.has(v)||!(row.length===3||
        (row.length===4&&['socket-unix','socket-ipv4'].includes(k)&&v==='hold'&&socketCodes.has(code))))throw Error('Malformed stage record');
      if(v==='start'?seen.has(k):seen.get(k)!=='start')throw Error('Contradictory trace record');
      seen.set(k,v);
      messages.push('RX_EVERYDAY_CHROME_STAGE '+k+' '+v+(code?' '+code:''));
    }else throw Error('Malformed trace record type');
  }
  const complete=stages.every(k=>seen.get(k)==='pass');
  if(requireComplete&&!complete)messages.push('RX_EVERYDAY_CHROME_TRACE incomplete');
  return {messages,ok:!requireComplete||complete};
}
if(import.meta.main){
  try{
    const [mode,path,...args]=process.argv.slice(2);
    let ok;
    if(!path)throw Error();
    if(mode==='init'&&!args.length){initTrace(path);ok=true;}
    else if(mode==='mark'&&args.length===2){traceMarker(path,...args);ok=true;}
    else if(mode==='doctor'&&args.length===2&&/^[0-9]{1,3}$/.test(args[1]))ok=readDoctor(path,args[0],Number(args[1]));
    else if(mode==='report'&&args.length===1&&['complete','partial'].includes(args[0])){
      const report=renderTrace(path,args[0]==='complete');
      for(const message of report.messages)console.log(message);
      ok=report.ok;
    }else throw Error();
    if(!ok)process.exitCode=1;
  }catch{
    console.log('RX_EVERYDAY_CHROME_TRACE unavailable');
    process.exitCode=1;
  }
}
