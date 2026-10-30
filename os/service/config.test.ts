import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DEFAULT_REMOTE, desktopPolicy} from '../src/app/policy.ts';

// wrangler.toml is what production is; each other place that says the same (the page, the core, the desktop
// app, the build, the deploy) is held to it here, so one changed alone fails rather than ships.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const wrangler = read('wrangler.toml');
const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(wrangler)?.[1];
const routes = [...wrangler.matchAll(/^pattern\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
const rust = read('core/src/remote/mod.rs');
const constant = (name: string) => new RegExp(`pub const ${name}: &str = "([^"]+)"`).exec(rust)?.[1];
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));

test('the Remote has one name: the Worker\'s, the page\'s, the core\'s and the desktop app\'s', () => {
  assert.equal(value('BASE_URL'), DEFAULT_REMOTE);
  assert.equal(value('APP_ORIGIN'), DEFAULT_REMOTE);
  assert.equal(constant('DEFAULT_URL'), DEFAULT_REMOTE);
  assert.equal(routes[0], new URL(DEFAULT_REMOTE).host);
  assert.equal(tauri.app.security.csp, desktopPolicy(DEFAULT_REMOTE));
  // Its former name still routes to the same Worker, and the page and the core both take it to the one name.
  const former = constant('FORMER_URL')!;
  assert.ok(routes.includes(new URL(former).host), former);
  assert.match(read('src/remote/connection.ts'), new RegExp(`FORMER_REMOTE = '${former.replace(/[.]/g, '\\.')}'`));
});

test('the desktop app\'s webview is an origin the Remote lets in, and never plain http', () => {
  // Tauri on Linux and macOS serves the app from tauri://localhost (useHttpsScheme decides Windows' alone).
  assert.ok(tauri.app.windows.every((w: {useHttpsScheme?: boolean}) => w.useHttpsScheme === true));
  assert.deepEqual(value('APP_ORIGINS')!.split(/\s+/), ['tauri://localhost']);
});

test('the app\'s files are one directory: what the build makes, what the Worker serves, what Tauri takes, what the deploy checks', async () => {
  const assets = value('directory');
  assert.equal(assets, 'dist');
  const {default: vite} = await import('../vite.config.ts');
  assert.equal((vite as {build: {outDir: string}}).build.outDir, assets);
  assert.equal(tauri.build.frontendDist, `../${assets}`);
  assert.match(read('service/deploy.ts'), /built\(new URL\(`\.\.\/\$\{vars\('directory'\) \?\? 'dist'\}`/);
});

test('what reaches the Worker first is the Remote\'s own paths, and the development server passes the same on', async () => {
  const first = JSON.parse(/^run_worker_first\s*=\s*(\[.*\])$/m.exec(wrangler)![1]) as string[];
  assert.deepEqual(first, ['/v1/*', '/api/*', '/.well-known/*']);
  process.env.LENGTH3_DEV_REMOTE = 'http://127.0.0.1:1';
  const {default: vite} = await import(`../vite.config.ts?dev=${Date.now()}`);
  assert.deepEqual(Object.keys((vite as {server: {proxy: Record<string, string>}}).server.proxy), ['/v1', '/api', '/.well-known']);
});
