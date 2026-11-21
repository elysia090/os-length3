import {launchIsolatedChrome} from './capture.mjs';
import {verifySandbox} from './sandbox-same-process.mjs';
import {traceMarker} from './preflight-diagnostics.mjs';

const [trace,...extra]=process.argv.slice(2);
if(!trace||extra.length)throw Error('Missing private preflight trace');
let traceFailed=false;
const observe=(...fields)=>{
  // A private trace write error must not interrupt browser cleanup.
  try{traceMarker(trace,...fields);}catch{traceFailed=true;}
};
const browser=await launchIsolatedChrome('/opt/google/chrome/chrome',observe);
try{
  await verifySandbox(browser,observe);
}finally{
  await browser.close();
}
if(traceFailed)throw Error('Private preflight trace write failed');
