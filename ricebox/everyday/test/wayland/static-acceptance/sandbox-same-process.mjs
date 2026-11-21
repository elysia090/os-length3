import {armCapture} from './capture.mjs';
import {linuxSandboxReport} from './stock-chrome.ts';

// Consult the exact source's existing policy in the identical stock process.
// This opens a chrome:// tab before any test-origin traffic, not a cache warmup.
export async function verifySandbox(browser) {
  if(!/^(?:Headless)?Chrome\/[0-9.]+$/.test(browser.version?.product??'')) throw Error('Stock Chrome product did not identify itself');
  const page=await armCapture(browser);
  try {
    const nav=await page.call('Page.navigate',{url:'chrome://sandbox/'});
    if(nav.errorText)throw Error('chrome sandbox report navigation failed');
    const end=Date.now()+8_000;
    do {
      const rows=await page.evaluate(`Array.from(document.querySelectorAll('#sandbox-status tr'), element=>[
        element.cells[0]?.textContent?.trim()??'',element.cells[1]?.textContent?.trim()??''])`).catch(()=>null);
      if(rows?.some(([label])=>label==='Seccomp-BPF sandbox'))return linuxSandboxReport(rows);
      await new Promise(r=>setTimeout(r,80));
    }while(Date.now()<end);
    throw Error('Stock Chrome sandbox report did not become available');
  } finally {await page.close()}
}
