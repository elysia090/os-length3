import {launchIsolatedChrome} from './capture.mjs';
import {verifySandbox} from './sandbox-same-process.mjs';
const browser=await launchIsolatedChrome('/opt/google/chrome/chrome');
try{
  await verifySandbox(browser);
}finally{
  await browser.close();
}
