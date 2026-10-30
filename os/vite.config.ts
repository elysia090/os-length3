import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {defineConfig, type Plugin} from 'vite';
import {buildCoreWasm, coreWasmPath} from './scripts/core-wasm.ts';
import {DEFAULT_REMOTE, headersOf, webPolicy} from './src/app/policy.ts';
import {shipped} from './service/releases.ts';

// Tauri serves the built files from ../dist and points its dev webview at this
// fixed port, so the port must not drift to a free one. The Terminal's kernel
// lives in ../xlat.

// The web build's policy is src/app/policy.ts's: its own origin and the Remote. Tauri applies its own
// policy (with its ipc: channel) to the desktop build, so the meta tag is only for the web.
// The Remote (service/) is the one other origin it may reach: where the
// canonical copy lives. VITE_LENGTH3_REMOTE points a build at another one;
// '' is this page's own origin, which in development LENGTH3_DEV_REMOTE
// (a `node service/dev.ts`) answers through the dev server.
const REMOTE_URL = process.env.VITE_LENGTH3_REMOTE ?? DEFAULT_REMOTE;
const REMOTE = REMOTE_URL ? new URL(REMOTE_URL).origin : '';
const DEV_REMOTE = process.env.LENGTH3_DEV_REMOTE;
// What the Worker serves (wrangler.toml): the app's files are its [assets] directory, which is where this builds
// them (and Tauri takes them from, tauri.conf.json frontendDist); its own paths (run_worker_first) reach it before
// them, and the development server and the preview pass the same paths to LENGTH3_DEV_REMOTE.
const WRANGLER = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const ASSETS = /^directory\s*=\s*"([^"]+)"/m.exec(WRANGLER)![1];
const WORKER_FIRST = (JSON.parse(/^run_worker_first\s*=\s*(\[.*\])$/m.exec(WRANGLER)![1]) as string[]).map((p) => p.replace(/\/\*$/, ''));
// The release this tree ships (service/releases.ts shipped, the newest pinned; not RELEASE, which names the one being
// made): the web's Runtime offers that version's desktop app, as the deploy puts it on the Remote (service/mirror.ts).
process.env.VITE_LENGTH3_RELEASE ??= shipped();
const WEB_POLICY = webPolicy(REMOTE);

// Which host a build is for, fixed when it is built: the desktop app's (Tauri's CLI sets TAURI_ENV_PLATFORM for the
// build it runs) or the web's. host.ts reads it as isNative, so a branch for the other host is dropped from the build.
const HOST: 'native' | 'web' = process.env.TAURI_ENV_PLATFORM ? 'native' : 'web';

const metaPolicy = (): Plugin => ({
  name: 'length3-web-policy',
  apply: 'build',
  transformIndexHtml(html) {
    if (HOST === 'native') return html;
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WEB_POLICY}">`);
  },
});

/** The commit a build is made from: as the build machine names it (Workers Builds, Actions), else git's; '' when neither can. */
function commit(): string {
  const named = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (named) return named.slice(0, 12);
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch { return ''; }
}

/**
 * The page says which build it is (`<meta name="length3-build">`: the release and the commit; boot.js puts it in
 * what it shows when the app cannot start), so the page a site serves can be told from the tree. On the web its
 * script is marked data-cfasync="false": a CDN that defers scripts (Cloudflare's Rocket Loader) rewrites a
 * module script into one its own loader runs, which this page's policy never lets run, leaving the page blank.
 */
const buildStamp = (): Plugin => ({
  name: 'length3-build-stamp',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const stamped = html.replace('<head>', `<head>\n    <meta name="length3-build" content="${`${process.env.VITE_LENGTH3_RELEASE} ${commit()}`.trim()}">`);
      return HOST === 'native' ? stamped : stamped.replace(/<script type="module"/g, '<script type="module" data-cfasync="false"');
    },
  },
});

/**
 * The core the app runs, built for the browser (core/web) when its sources changed, once per dev-server start
 * and per build; `virtual:length3-core.wasm?url` is the module's URL (a hashed asset in a build), from any
 * bundle, the core's worker's included, as an alias reaches them all.
 */
const coreWasm = (): Plugin => ({
  name: 'length3-core-wasm',
  config: () => ({
    resolve: {alias: [{find: /^virtual:length3-core\.wasm/, replacement: coreWasmPath()}]},
    server: {fs: {allow: [dirname(coreWasmPath())]}},
  }),
  // The desktop app's core is its own (src-tauri), so its build needs none for the browser.
  buildStart() { if (HOST === 'web') buildCoreWasm(); },
});

/**
 * What only one host has, left out of the other's build. A module of one host's alone has a stand-in beside
 * it with the same exports, which the other host's build takes in its place: `X.desktop.ts` for the web's
 * (the browser's core and its worker, l3 as a browser reads it and xlat that runs it, passkeys), since the app
 * runs its own core, the root installed on the machine and signs in through the browser; `X.web.ts` for the
 * app's (Tauri's API), which a browser never has.
 */
const ONLY = {web: ['core/spawn', 'prompt/userland', 'remote/passkeys'], native: ['app/tauri']};
const hostOnly = (): Plugin => {
  const other = HOST === 'native' ? ONLY.web : ONLY.native;
  const suffix = HOST === 'native' ? '.desktop.ts' : '.web.ts';
  const named = new RegExp(`/src/(${other.join('|')})\\.ts$`);
  let out = '';
  return {
    name: 'length3-host',
    enforce: 'pre',
    configResolved(c) { out = resolve(c.root, c.build.outDir); },
    // public/ is copied whole; l3 as a browser reads it (public/l3, made by npm run l3) is the web's alone.
    closeBundle() { if (HOST === 'native' && out) rmSync(resolve(out, 'l3'), {recursive: true, force: true}); },
    async resolveId(source, importer, options) {
      if (!importer || !other.some((m) => source.endsWith(`/${m.split('/').pop()}.ts`))) return null;
      const r = await this.resolve(source, importer, {...options, skipSelf: true});
      if (!r || !named.test(r.id)) return r;
      const stand = r.id.replace(/\.ts$/, suffix);
      if (!existsSync(stand)) throw new Error(`length3: ${r.id} is one host's alone and has no ${stand} for this build`);
      return stand;
    },
  };
};

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
    proxy: DEV_REMOTE ? Object.fromEntries(WORKER_FIRST.map((p) => [p, DEV_REMOTE])) : undefined},
  worker: {format: 'es'},
  define: {__LENGTH3_HOST__: JSON.stringify(HOST)},
  build: {target: 'es2022', outDir: ASSETS, emptyOutDir: true},
  plugins: [hostOnly(), coreWasm(), metaPolicy(), buildStamp()],
});
