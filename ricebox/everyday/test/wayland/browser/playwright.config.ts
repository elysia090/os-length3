import {fileURLToPath} from 'node:url';
import {defineConfig} from '@playwright/test';
const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.EVERYDAY_CHROME_PORT ?? '36685');
const url = 'http://127.0.0.1:'+port;
const vite = fileURLToPath(new URL('../../../../../node_modules/vite/bin/vite.js', import.meta.url));
const args = [process.execPath,vite,'preview','--config',here+'vite.config.ts',
  '--strictPort','--host','127.0.0.1','--port',String(port)];
export default defineConfig({
  testDir:here, testMatch:'browser.spec.ts', timeout:12000, workers:1, retries:0,
  outputDir:process.env.EVERYDAY_CHROME_RESULTS,
  use:{baseURL:url,browserName:'chromium',headless:true,
    // Playwright otherwise hides native scrollbars in headless mode.
    launchOptions:{chromiumSandbox:true,executablePath:process.env.EVERYDAY_CHROME_BIN,
      ignoreDefaultArgs:['--hide-scrollbars']}},
  projects:[{name:'DPR 1',use:{deviceScaleFactor:1}},{name:'DPR 2',use:{deviceScaleFactor:2}}],
  webServer:{command:args.map(x=>JSON.stringify(x)).join(' '),url,reuseExistingServer:false,timeout:9000},
});
