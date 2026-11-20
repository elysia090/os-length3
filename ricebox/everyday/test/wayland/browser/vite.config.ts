import {defineConfig} from 'vite';

const root = process.env.EVERYDAY_CHROME_APP;
const publicDir = process.env.EVERYDAY_CHROME_ASSETS, outDir = process.env.EVERYDAY_CHROME_DIST;
if (!root || !publicDir || !outDir) throw new Error('Stage the installed app, guest assets and isolated output before building');
export default defineConfig({root, publicDir, worker:{format:'es'}, build:{target:'esnext',outDir,emptyOutDir:false}});
