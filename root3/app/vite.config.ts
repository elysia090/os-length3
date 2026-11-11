import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig, type Plugin} from 'vite';
import {bootScript} from '../../scripts/boot.ts';
import {buildCoreWasm, coreWasmPath} from '../../scripts/core-wasm.ts';
import {DEFAULT_REMOTE, headersOf, webPolicy} from './host/policy.ts';
import {shipped} from '../remote/ship/releases.ts';

// Tauri serves the built files from dist/ and points its dev webview at this
// fixed port, so the port must not drift to a free one. The Terminal's kernel
// lives in module/sods (the translator) and module/ricebox (the kernel).

// The web build's policy is root3/app/host/policy.ts's: its own origin and the Remote. Tauri applies its own
// policy (with its ipc: channel) to the desktop build, so the meta tag is only for the web.
// The Remote (remote/) is the one other origin it may reach: where the
// canonical copy lives. VITE_LENGTH3_REMOTE points a build at another one;
// '' is this page's own origin, which in development LENGTH3_DEV_REMOTE
// (a `node root3/remote/serve/dev.ts`) answers through the dev server.
const REMOTE_URL = process.env.VITE_LENGTH3_REMOTE ?? DEFAULT_REMOTE;
const REMOTE = REMOTE_URL ? new URL(REMOTE_URL).origin : '';
const DEV_REMOTE = process.env.LENGTH3_DEV_REMOTE;
// What the Worker serves (wrangler.toml): the app's files are its [assets] directory, which is where this builds
// them (and Tauri takes them from, tauri.conf.json frontendDist); its own paths (run_worker_first) reach it before
// them, and the development server and the preview pass the same paths to LENGTH3_DEV_REMOTE.
const WRANGLER = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
const ASSETS = /^directory\s*=\s*"([^"]+)"/m.exec(WRANGLER)![1];
const WORKER_FIRST = (JSON.parse(/^run_worker_first\s*=\s*(\[.*\])$/m.exec(WRANGLER)![1]) as string[]).map((p) => p.replace(/\/\*$/, ''));
// The release this tree ships (root3/remote/ship/releases.ts shipped, the newest pinned; not module/ricebox/RELEASE, which names the one being
// made): the web's Runtime offers that version's desktop app, as the deploy puts it on the Remote (root3/remote/bytes/mirror.ts).
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
      return HOST === 'native' ? stamped : stamped.replace(/<script(?=[^>]*\stype="module")/g, '<script data-cfasync="false"');
    },
  },
});

/**
 * The core the app runs, built for the browser (root3/core/web) when its sources changed, once per dev-server start
 * and per build; `virtual:length3-core.wasm?url` is the module's URL (a hashed asset in a build), from any
 * bundle, the core's worker's included, as an alias reaches them all.
 */
const coreWasm = (): Plugin => ({
  name: 'length3-core-wasm',
  config: () => ({
    resolve: {alias: [{find: /^virtual:length3-core\.wasm/, replacement: coreWasmPath()}]},
    server: {fs: {allow: [dirname(coreWasmPath())]}},
  }),
  // The desktop app's core is its own (desktop), so its build needs none for the browser.
  buildStart() { if (HOST === 'web') buildCoreWasm(); },
});

/**
 * What only one host has, left out of the other's build. A module of one host's alone has a stand-in beside
 * it with the same exports, which the other host's build takes in its place: `X.desktop.ts` for the web's
 * (the browser's core and its worker, the web root and xlat that runs it, passkeys), since the app
 * runs its own core, the root installed on the machine and signs in through the browser; `X.web.ts` for the
 * app's (Tauri's API), which a browser never has.
 */
const ONLY = {web: ['core/spawn', 'remote/passkeys'], native: ['app/tauri']};
const hostOnly = (): Plugin => {
  const other = HOST === 'native' ? ONLY.web : ONLY.native;
  const suffix = HOST === 'native' ? '.desktop.ts' : '.web.ts';
  const named = new RegExp(`/app/(${other.join('|')})\\.ts$`);
  let out = '';
  return {
    name: 'length3-host',
    enforce: 'pre',
    configResolved(c) { out = resolve(c.root, c.build.outDir); },
    // public/ is copied whole; the web root (public/webroot, made by npm run webroot) is the web's alone.
    closeBundle() { if (HOST === 'native' && out) rmSync(resolve(out, 'webroot'), {recursive: true, force: true}); },
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
 * The app's code is the import of the page's first script (root3/app/start.ts starts the core, then imports main.ts), so it
 * is named in the page to be fetched at once (modulepreload, with what it imports), beside the first script rather
 * than after it has run.
 */
const preloadApp = (): Plugin => ({
  name: 'length3-preload-app',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html, {chunk, bundle}) {
      if (!chunk || !bundle) return html;
      const files = new Set<string>();
      const add = (name: string) => {
        const c = bundle[name];
        if (name === chunk.fileName || files.has(name) || c?.type !== 'chunk') return;
        files.add(name);
        c.imports.forEach(add);
      };
      chunk.dynamicImports.forEach(add);
      return {html, tags: [...files].map((f) => ({tag: 'link', attrs: {rel: 'modulepreload', crossorigin: true, href: `/${f}`}, injectTo: 'head' as const}))};
    },
  },
});

/**
 * /boot.js, the page's first script (boot.ts: what the page says when the app cannot start), its types
 * taken away (scripts/boot.ts): a file of the build, and answered as it is by the development server.
 */
const boot = (): Plugin => ({
  name: 'length3-boot',
  configureServer(server) {
    server.middlewares.use('/boot.js', (_, res, next) => {
      bootScript().then((code) => { res.setHeader('Content-Type', 'text/javascript'); res.end(code); }, next);
    });
  },
  async generateBundle() { this.emitFile({type: 'asset', fileName: 'boot.js', source: await bootScript()}); },
});

/**
 * Cross-origin isolation, as public/_headers gives it in production: the page
 * may share memory, so the Prompt runs each guest thread in a Worker of its
 * own. The development server and the preview (the selftest's) say the same.
 */
const ISOLATED = {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'};

/** The repository's root: public/, the Worker's assets directory (wrangler.toml) and node_modules are there. */
const TOP = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  clearScreen: false,
  // The page is this folder (index.html beside this file); what it ships beside its build is the repository's public/.
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: resolve(TOP, 'public'),
  envDir: TOP,
  cacheDir: resolve(TOP, 'node_modules/.vite'),
  // The preview (the selftest's) serves the build with the headers Workers Assets gives it (public/_headers),
  // so the app is tested under its real policy, frame-ancestors and all.
  preview: {headers: headersOf(readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8'))},
  server: {port: 1420, strictPort: true, fs: {allow: [TOP]}, headers: ISOLATED,
    proxy: DEV_REMOTE ? Object.fromEntries(WORKER_FIRST.map((p) => [p, DEV_REMOTE])) : undefined},
  worker: {format: 'es'},
  // xlat's runtime reaches for Node's workers only under Node: in the browser bundle that module is nothing.
  resolve: {alias: [{find: 'node:worker_threads', replacement: fileURLToPath(new URL('./shims/worker-threads.ts', import.meta.url))}]},
  define: {__LENGTH3_HOST__: JSON.stringify(HOST)},
  // Most of a build is the core compiled for the browser (coreWasm's buildStart, cargo), which Rolldown would
  // report each time as a plugin's slow callback: it is the build's work, not a plugin's overhead.
  build: {target: 'es2022', outDir: resolve(TOP, ASSETS), emptyOutDir: true, rolldownOptions: {checks: {bundlerTimings: false}}},
  plugins: [hostOnly(), coreWasm(), boot(), metaPolicy(), buildStamp(), preloadApp()],
});
