import {setTimeout as sleep} from 'node:timers/promises';
import {armCapture,launchIsolatedChrome} from './capture.mjs';
import {diagnosticPlan,isDisplay,stagedPlan} from './routes.mjs';
import {buildReceipt} from './receipt.mjs';

const [mode,executable,stage,profile,...extra]=process.argv.slice(2);
if(!['staged','diagnostic'].includes(mode)||!executable||extra.length||
  (mode==='staged'?(!stage||!profile):(profile||stage&&stage!=='uncached-range'))) {
  throw Error('Usage: node run-receipt.mjs staged /absolute/chrome STAGED_SITE local-revalidate|local-immutable\n'+
    '   or: node run-receipt.mjs diagnostic /absolute/chromium [uncached-range]');
}
const evidence=mode==='staged'?
  'Controlled loopback shell fixture only; independently verify the exact staged release and browser sandbox before acceptance':
  'Synthetic HTTP diagnostic only; no guest, pinned runtime, or stock Chrome claim';
const config=mode==='staged'?await stagedPlan(stage,profile):await diagnosticPlan(stage?{rootCache:'no-store'}:{});
let browser;
async function waitFor(page,expression) {
  const end=Date.now()+30_000;
  while(Date.now()<end) {
    try {
      const value=await page.evaluate(expression);
      if(value?.error) throw Error(value.error);
      if(value) return value;
    } catch(error) {
      if(!/execution context was destroyed|cannot find (?:default )?context/i.test(String(error))) throw error;
    }
    await sleep(80);
  }
  throw Error('Timed out waiting for page/guest witness: '+expression);
}
let result={evidence,profile:config.profile,sameReleaseDigest:config.sameReleaseDigest??null,
  startedAt:new Date().toISOString(),runnerMode:'headless isolated temp profile, no cache manipulation',
  revisit:'ordinary Page.navigate to the identical URL in a fresh tab of the same browser/profile',
  observation:'through normal command exit (staged) or completed fixture reads (diagnostic), then four-second observation and at least 400 ms quiet',
  phases:[],browser:null,runError:null};
try {
  browser=await launchIsolatedChrome(executable);
  result.browser=browser.version;
  for(const phase of ['first','revisit']) {
    for(const o of config.origins) o.setPhase(phase);
    const page=await armCapture(browser);
    try {
      const nav=await page.call('Page.navigate',{url:config.url});
      if(nav.errorText) throw Error(nav.errorText);
      const readiness=await waitFor(page,mode==='staged'?`(()=>{
        const p=document.querySelector('#state')?.dataset.phase;
        if(p==='failed') return {error:document.querySelector('#state').textContent};
        if(p==='prompt'&&document.querySelector('#output')?.textContent.includes('ricebox-accept$ ')){
          return {stage:p,focus:document.activeElement.id};
        }
        return null;
      })()`:`window.receiptError?{error:window.receiptError}:window.receiptReady?{stage:'diagnostic',focus:document.activeElement.id}:null`);
      if(readiness.focus!=='host-focus') throw Error('Unrelated host input lost focus before readiness');
      if(mode==='staged') {
        await page.evaluate(`document.querySelector('#line').focus()`);
        // Ordinary keyboard input, not direct invocation of the guest API.
        await page.call('Input.insertText',{text:`printf '%s%s:%s\\n' RICEBOX- BOOT "$((6*7))"; exit 0`});
        await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
        await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        const guest=await waitFor(page,`(()=>{
          const state=document.querySelector('#state'), p=state?.dataset.phase;
          if(p==='failed') return {error:state.textContent};
          if(p!=='exited')return null;
          return {marker:document.querySelector('#output').textContent.replaceAll('\\r','').split('\\n').includes('RICEBOX-BOOT:42'),
            cleanExit:state.textContent==='Guest exited 0'};
        })()`);
        if(!guest.marker||!guest.cleanExit) throw Error('Calculated guest marker and clean exit not both observed');
        Object.assign(readiness,guest);
      }
      await sleep(4_000);
      let previous=-1;
      const end=Date.now()+5_000;
      while(Date.now()<end) {
        const current=page.events.length+config.origins.reduce((n,o)=>n+o.rows.length,0);
        if(current===previous) break;
        previous=current;
        await sleep(400);
      }
      if(Date.now()>=end) throw Error('Observation did not reach a quiet interval');
      await page.drain();
      const perfs=await page.evaluate(`({nav:performance.getEntriesByType('navigation').map(x=>x.type),
        crossOriginIsolated,resourceTiming:performance.getEntriesByType('resource').map(x=>({
          url:x.name,transferSize:x.transferSize,encodedBodySize:x.encodedBodySize,decodedBodySize:x.decodedBodySize
        }))})`);
      if(perfs.nav.length!==1||perfs.nav[0]!=='navigate') throw Error('Not an ordinary forward navigation');
      const receipt=buildReceipt({phase,events:page.events,targets:page.targets,errors:page.errors,
        origin:config.origins.flatMap(o=>o.rows),scope:config.scope,isAllowedWorker:config.isAllowedWorker,isDisplay,
        requireWorkers:config.requireWorkers,requireAssets:phase==='first'?config.requireAssets:[],
        requireWorkerAssets:phase==='first'?config.requireWorkerAssets:[],
        requireWorkerPack:phase==='first'&&config.requireWorkerPack,observations:{...readiness,...perfs}});
      result.phases.push(receipt);
    } catch(error) {
      result.failedPhase={phase,events:page.events.length,origin:config.origins.flatMap(o=>o.rows).filter(r=>r.phase===phase)};
      throw error;
    } finally {await page.close();}
  }
} catch(error){result.runError=String(error);}
finally{
  try {await browser?.close();}
  finally {for(const o of config.origins) await o.close();}
}
result.pass=!result.runError&&result.phases.length===2&&result.phases.every(p=>p.pass);
process.stdout.write(JSON.stringify(result,null,2)+'\n');
if(!result.pass) process.exitCode=1;
