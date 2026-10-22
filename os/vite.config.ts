import {readFileSync} from 'node:fs';
import {defineConfig, type Plugin} from 'vite';
import {headersOf, webPolicy} from './src/policy.ts';

// Tauri serves the built files from ../dist and points its dev webview at this
// fixed port, so the port must not drift to a free one. The Terminal's kernel
// lives in ../xlat.

// The web build's policy is src/policy.ts's: its own origin and the Remote. Tauri applies its own
// policy (with its ipc: channel) to the desktop build, so the meta tag is only for the web.
// The Remote (service/) is the one other origin it may reach: where the
// canonical copy lives. VITE_LENGTH3_REMOTE points a build at another one;
// '' is this page's own origin, which in development LENGTH3_DEV_REMOTE
// (a `node service/dev.ts`) answers through the dev server.
const REMOTE_URL = process.env.VITE_LENGTH3_REMOTE ?? 'https://os.length3.com';
const REMOTE = REMOTE_URL ? new URL(REMOTE_URL).origin : '';
const DEV_REMOTE = process.env.LENGTH3_DEV_REMOTE;
// The release this tree ships (RELEASE): the web's Runtime offers that version's desktop app
// (shared/desktop-releases.json), as the deploy puts it on the Remote (service/mirror.ts).
process.env.VITE_LENGTH3_RELEASE ??= readFileSync(new URL('./RELEASE', import.meta.url), 'utf8').trim();
const WEB_POLICY = webPolicy(REMOTE);

const metaPolicy = (): Plugin => ({
  name: 'length3-web-policy',
  apply: 'build',
  transformIndexHtml(html) {
    if (process.env.TAURI_ENV_PLATFORM) return html;
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WEB_POLICY}">`);
  },
});

/**
 * Cross-origin isolation, as public/_headers gives it in production: the page
 * may share memory, so the Prompt runs each guest thread in a Worker of its
 * own. The development server and the preview (the selftest's) say the same.
 */
const ISOLATED = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'};

export default defineConfig({
  clearScreen: false,
  // The preview (the selftest's) serves the build with the headers Workers Assets gives it (public/_headers),
  // so the app is tested under its real policy, frame-ancestors and all.
  preview: {headers: headersOf(readFileSync(new URL('./public/_headers', import.meta.url), 'utf8'))},
  server: {port: 1420, strictPort: true, fs: {allow: ['..']}, headers: ISOLATED,
    proxy: DEV_REMOTE ? {'/api': DEV_REMOTE, '/v1': DEV_REMOTE} : undefined},
  worker: {format: 'es'},
  build: {target: 'es2022', outDir: 'dist', emptyOutDir: true},
  plugins: [metaPolicy()],
});
