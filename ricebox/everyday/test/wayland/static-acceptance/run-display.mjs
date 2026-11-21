import {randomInt} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {launchIsolatedChrome,armCapture} from './capture.mjs';
import {verifySandbox} from './sandbox-same-process.mjs';
import {stagedPlan} from './routes.mjs';
import {framePins,protocol} from './wayland-contract.mjs';

const [binary,site,...extra]=process.argv.slice(2);
if(!binary||!site||extra.length)throw Error('DISPLAY_RUN_ARGUMENTS');
const result={scope:'static-musl-c-wayland-fallback',pass:false,proof:[]};
const plan=await stagedPlan(site,'local-revalidate');
let browser,page,phase='chrome';
const guard=(v,code)=>{if(!v)throw Error(code)};
try{
  browser=await launchIsolatedChrome(binary);
  result.sandbox=await verifySandbox(browser);
  page=await armCapture(browser);
  const call=page.call;
  await call('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false});
  const ev=(fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  async function wait(fn,...args){
    const deadline=Date.now()+35_000;
    while(Date.now()<deadline){
      const x=await ev(fn,...args).catch(e=>/context was destroyed|cannot find (?:default )?context/i.test(String(e))?null:Promise.reject(e));
      if(x)return x;
      const failed=await ev(()=>['failed','error'].includes(document.querySelector('#state')?.dataset.phase)||
        document.querySelector('#fallback-state')?.dataset.phase==='error').catch(()=>false);
      if(failed)throw Error('GUEST_REPORTED_ERROR');
      await sleep(100);
    }
    throw Error('GUEST_WITNESS_TIMEOUT');
  }
  const rootUrl=new URL('./ricebox-js/distribution/runtime/worker.js',plan.url).href;
  const requestUrls=()=>page.events.filter(e=>e.method==='Network.requestWillBeSent').map(e=>e.params.request.url);
  const display=url=>/\/(?:display-fallback|everyday)\//.test(new URL(url).pathname);
  const roots=()=>[...page.targets.values()].filter(t=>t.type==='worker'&&t.url===rootUrl);
  const click=async(x,y)=>{
    for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
  };
  const clickControl=async(id)=>{
    const point=await ev(id=>{
      const e=document.getElementById(id);if(!e||e.disabled)return null;
      const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
      return document.elementFromPoint(x,y)===e?{x,y}:null;
    },id);
    guard(point,'DISPLAY_CONTROL_NOT_CLICKABLE');await click(point.x,point.y);
  };
  const frame=(n)=>wait(async(n,pin)=>{
    const c=document.querySelector('#fallback-camera canvas');
    if(Number(c.dataset.sequence)!==n)return null;
    const {width:w,height:h}=c,rgba=c.getContext('2d').getImageData(0,0,w,h).data;
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',rgba)),z=>z.toString(16).padStart(2,'0')).join('');
    return hash===pin?{w,h}:null;
  },n,framePins[n-1]);
  const sample=async(x,y)=>{
    const {data}=await call('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
    return ev(async(encoded,x,y)=>{
      const b=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
      try{
        const c=document.createElement('canvas');c.width=1;c.height=1;
        const cx=c.getContext('2d');cx.drawImage(b,Math.floor(x),Math.floor(y),1,1,0,0,1,1);
        return Array.from(cx.getImageData(0,0,1,1).data);
      }finally{b.close()}
    },data,x,y);
  };
  async function visible(point,want){
    const end=Date.now()+3000;
    do{
      if(JSON.stringify(await sample(point.x,point.y))===JSON.stringify(want))return;
      await sleep(75);
    }while(Date.now()<end);
    throw Error('COMPOSITED_PIXEL_MISMATCH');
  }

  phase='lazy-before-opt-in';
  const nav=await call('Page.navigate',{url:plan.url});
  guard(!nav.errorText,'DEMO_NAVIGATION_FAILED');
  guard(await wait(()=>document.querySelector('#state')?.dataset.phase==='prompt'&&
    document.querySelector('#output')?.textContent.includes('ricebox-accept$ ')),'NO_SHELL_PROMPT');
  await page.drain();
  guard(!page.errors.length&&roots().length===1&&requestUrls().every(x=>!display(x)),'DISPLAY_WORK_BEFORE_OPT_IN');
  const shell=roots()[0].sessionId;
  guard(await ev(()=>document.activeElement.id==='host-focus'&&
    document.querySelector('#fallback-ui').hidden&&document.querySelector('#fallback-state').dataset.phase==='off'),'INITIAL_FOCUS_OR_DISPLAY_CHANGED');
  result.proof.push(phase);
  phase='display-first';
  await clickControl('show-fallback');
  const one=await frame(1);guard(one.w===32&&one.h===24,'FIRST_DIMENSIONS');
  await page.drain();
  guard(roots().length===2&&roots().some(t=>t.sessionId!==shell)&&requestUrls().some(display),'NO_DISTINCT_DISPLAY_WORKER');
  result.proof.push(phase);
  phase='host-pan-and-pointer';
  await clickControl('fallback-pan');
  guard(await wait(()=>{
    const v=document.querySelector('#fallback-camera'),c=v.querySelector('canvas');
    return v.scrollLeft===48&&v.scrollTop===36&&c.dataset.sequence==='1'&&c.width===32&&c.height===24;
  }), 'CAMERA_DID_NOT_STAY_HOST_ONLY');
  const point=await ev(()=>{
    const c=document.querySelector('#fallback-camera canvas'),r=c.getBoundingClientRect();
    const x=r.x+10.5*r.width/32,y=r.y+12.5*r.height/24;
    return document.elementFromPoint(x,y)===c?{x,y}:null;
  });
  guard(point,'NO_VISIBLE_GUEST_PIXEL');
  await visible(point,[38,64,48,255]);await click(point.x,point.y);
  await frame(2);await visible(point,[248,61,105,255]);
  result.proof.push(phase);
  phase='explicit-resize';
  await clickControl('fallback-resize');
  const three=await frame(3);guard(three.w===47&&three.h===19,'RESIZE_DIMENSIONS');
  await clickControl('fallback-pan');
  const resizedPoint=await wait(()=>{
    const v=document.querySelector('#fallback-camera'),c=v.querySelector('canvas'),r=c.getBoundingClientRect();
    if(v.scrollLeft||v.scrollTop||c.dataset.sequence!=='3')return null;
    const x=r.x+4,y=r.y+4;return document.elementFromPoint(x,y)===c?{x,y}:null;
  });
  await visible(resizedPoint,[18,28,42,255]);
  result.proof.push(phase);
  phase='retire-and-resume-shell';
  await clickControl('fallback-quit');
  await wait(()=>document.querySelector('#fallback-state').dataset.phase==='closed');
  const words=await ev(()=>document.querySelector('#fallback-protocol').textContent.split('\n'));
  guard(protocol.every(line=>words.filter(x=>x===line).length===1)&&
    words.filter(x=>x.startsWith('WAYLAND_COMMIT ')).length===3,'WAYLAND_PROTOCOL_RECEIPT_MISMATCH');
  guard(await ev(()=>{
    const c=document.querySelector('#fallback-camera canvas');
    return c.getContext('2d').getImageData(0,0,c.width,c.height).data.every(v=>v===0);
  }), 'CLOSED_CANVAS_RETAINED_PIXELS');
  guard(await ev(()=>document.querySelector('#state').dataset.phase==='prompt'),'SHELL_DID_NOT_SURVIVE');
  const a=randomInt(10000,40000),b=randomInt(10000,40000),mark='AFTER-WAYLAND:'+a*b;
  const before=await ev(()=>document.querySelector('#output').textContent);
  guard(!before.includes(mark),'STALE_SHELL_WITNESS');
  await clickControl('line');
  await call('Input.insertText',{text:`printf '%s%s:%s\\n' AFTER- WAYLAND "$((${a}*${b}))"; exit 0`});
  for(const type of ['keyDown','keyUp']) await call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})});
  await wait((before,mark)=>{
    if(document.querySelector('#state').dataset.phase!=='exited')return null;
    const t=document.querySelector('#output').textContent;
    return t.startsWith(before)&&t.slice(before.length).replaceAll('\r','').split('\n').filter(x=>x===mark).length===1;
  },before,mark);
  await page.drain();
  guard(page.errors.length===0&&requestUrls().every(x=>new URL(x).origin===new URL(plan.url).origin),'INCOMPLETE_BROWSER_CAPTURE');
  result.proof.push(phase);
  result.pass=true;
}catch(error){result.failedPhase=phase;result.error=String(error)}
finally{
  try{await page?.close()}catch{}
  try{await browser?.close()}finally{for(const o of plan.origins)await o.close()}
}
console.log(JSON.stringify(result));
if(!result.pass)process.exitCode=2;
