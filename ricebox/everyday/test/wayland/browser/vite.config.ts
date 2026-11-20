import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = process.env.EVERYDAY_CHROME_ASSETS, outDir = process.env.EVERYDAY_CHROME_DIST;
if (!publicDir || !outDir) throw new Error('The Wayland browser test requires its isolated staged assets and output');
export default defineConfig({root, publicDir, worker:{format:'es'}, build:{target:'esnext',outDir,emptyOutDir:false}});
