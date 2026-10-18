// What the production-like Remote costs, measured (README.md here): the
// first load of the app as served, and each hot route of the Remote on the
// Worker on workerd, over Postgres 16 as remote_worker through the bridge.
//
//   node selftest/prod/measure.ts [--delay MS] [--n N] [--files N] [--commits N] [--out FILE] [--no-cpu] [--no-load]
//
//   --delay MS   each chunk between the Worker and Postgres handed on MS later (a round trip is 2*MS):
//                0 is the same machine; Cloudflare to Neon in one region is a few ms, across regions tens
//   --n N        requests a route is timed over (25), after 3 not counted
//   --files N    the files of the big repo (2000), --commits N its commits (50)
//   --out FILE   the figures as JSON as well
//   --no-cpu     not the CPU time (it is measured in cpuserver.ts: the Worker's fetch in Node, on the same V8)
//
// Per route: the wall time the client saw (median, p90), the Worker's own time
// (Server-Timing worker), its CPU (cpu), and, from the bridge, the database
// connections it opened, the statements it sent, the round trips they took,
// the bytes the database sent, the connection's setup before its first
// statement, and the answer's size (as sent, and gzipped).

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {brotliCompressSync, gzipSync} from 'node:zlib';
import {cluster, freePort} from './postgres.ts';
import {appBuild, bridgeProcess, remote, OS} from './stack.ts';

const argv = process.argv.slice(2);
const flag = (k: string, d: number) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const DELAY = flag('--delay', 0), N = flag('--n', 25), FILES = flag('--files', 2000), COMMITS = flag('--commits', 50);
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const say = (s: string) => console.log(s);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const p90 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : NaN; };
const timing = (h: string | null, k: string) => { const m = new RegExp(`${k};dur=([\\d.]+)`).exec(h ?? ''); return m ? Number(m[1]) : NaN; };

/** Signed in through the stand-in provider at `base`, from address `ip`: the bearer token. */
async function signIn(base: string, name: string, ip: string): Promise<string> {
  const asked = await fetch(`${base}/api/auth/sign-in/social`, {method: 'POST', headers: {Origin: base, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip},
    body: JSON.stringify({provider: 'dev', callbackURL: `${base}/`})});
  const cookie = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const go = new URL(((await asked.json()) as {url: string}).url);
  const approve = new URL(`${base}/dev-oauth/approve`);
  for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
  approve.searchParams.set('name', name);
  const back = (await fetch(approve, {redirect: 'manual', headers: {'CF-Connecting-IP': ip}})).headers.get('location')!;
  const done = await fetch(back, {redirect: 'manual', headers: {Cookie: cookie, 'CF-Connecting-IP': ip}});
  const token = done.headers.get('set-auth-token');
  if (!token) throw new Error(`no session for ${name}: ${done.status}`);
  return token;
}

interface Figures { route: string; status: number; wall: number; wallP90: number; worker: number; cpu: number; conns: number; queries: number;
  roundTrips: number; fromDb: number; toDb: number; setup: number; bytes: number; gzip: number }

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'length3-measure-'));
  const pg = await cluster();
  const b = await bridgeProcess(DELAY);
  const cleanup: (() => Promise<void> | void)[] = [() => b.stop(), () => pg.destroy(), () => rmSync(dir, {recursive: true, force: true})];
  const report: Record<string, unknown> = {delay: DELAY, n: N, files: FILES, commits: COMMITS, at: new Date().toISOString()};
  try {
    const assets = appBuild();
    const r = await remote(pg, {dir: join(dir, 'worker'), assets, bridge: b.port, paid: true});
    cleanup.unshift(() => r.stop());
    say(`measure: the Worker on ${r.url}, Postgres ${pg.port} as remote_worker, bridge delay ${DELAY} ms each way`);

    if (!argv.includes('--no-load')) report.firstLoad = await firstLoad(r.url, assets);
    if (argv.includes('--load-only')) return;

    // The CPU server: the same Worker in Node, on the same database, through the same bridge.
    let cpuBase = '';
    if (!argv.includes('--no-cpu')) {
      const port = await freePort();
      cpuBase = `http://127.0.0.1:${port}`;
      const env = {...r.env, BASE_URL: cpuBase, APP_ORIGIN: cpuBase};
      const c = spawn(process.execPath, [join(OS, 'selftest', 'prod', 'cpuserver.ts'), String(port)], {cwd: OS, env: {...process.env, WORKER_ENV: JSON.stringify(env)}, stdio: ['ignore', 'pipe', 'inherit']});
      await new Promise<void>((resolve, reject) => { c.stdout!.on('data', (d: Buffer) => { if (String(d).includes('cpuserver')) resolve(); }); c.once('exit', () => reject(new Error('cpuserver stopped'))); });
      cleanup.unshift(() => { c.kill(); });
    }

    const token = await signIn(r.url, 'Mei Measure', '10.9.0.1');
    const user = pg.psql(`select id from "user" where name = 'Mei Measure'`, r.db).trim();
    // Its files' blobs, as if sent (rows: the bucket is not what is measured here), each version a commit makes too.
    pg.psql(`insert into blob (user_id, sha256, bytes) select '${user}', encode(sha256(convert_to('content ' || i || ' v' || v, 'UTF8')), 'hex'), 1000 + i
      from generate_series(0, ${FILES - 1}) i, generate_series(0, ${COMMITS}) v where v = 0 or i % ${Math.max(1, Math.floor(FILES / 3))} < 1 or i < 3`, r.db);
    const path = (i: number) => `src/part${i % 40}/file${i}.ts`;
    const api = async (base: string, method: string, p: string, body?: unknown, o: {origin?: boolean} = {}) => {
      const t = performance.now();
      const res = await fetch(`${base}${p}`, {method, headers: {Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '10.9.0.1', 'Accept-Encoding': 'gzip, br',
        ...(o.origin === false ? {} : {Origin: r.url}), ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)});
      const bytes = Buffer.from(await res.arrayBuffer());
      return {status: res.status, ms: performance.now() - t, bytes, headers: res.headers, json: () => JSON.parse(bytes.toString())};
    };

    // The big repo: FILES files in one diff, then COMMITS commits, each changing three files.
    const set: Record<string, string> = {};
    for (let i = 0; i < FILES; i++) set[path(i)] = sha(`content ${i} v0`);
    const made = await api(r.url, 'PATCH', '/v1/repos/big/draft', {version: 0, set, remove: []});
    if (made.status !== 200) throw new Error(`the big repo: ${made.status} ${made.bytes}`);
    report.bigDiff = {files: FILES, ms: Math.round(made.ms), body: JSON.stringify({version: 0, set, remove: []}).length};
    let version = 1, head: string | null = null;
    const step = Math.max(1, Math.floor(FILES / 3));
    for (let v = 1; v <= COMMITS; v++) {
      const change: Record<string, string> = {};
      for (const i of [0, 1, 2, step, 2 * step].filter((i) => i < FILES)) change[path(i)] = sha(`content ${i} v${v}`);
      const p = await api(r.url, 'PATCH', '/v1/repos/big/draft', {version, set: change, remove: []});
      if (p.status !== 200) throw new Error(`commit ${v}: ${p.status} ${p.bytes}`);
      version = p.json().version;
      const c = await api(r.url, 'POST', '/v1/repos/big/cuts', {version, parent: head, title: `Change ${v}`});
      if (c.status !== 201) throw new Error(`cut ${v}: ${c.status} ${c.bytes}`);
      head = c.json().id;
    }
    // Small repos beside it, as an account has; SSH on, as a device turns it.
    for (const name of ['notes', 'site', 'todo-app']) await api(r.url, 'PATCH', `/v1/repos/${name}/draft`, {version: 0, set: {'README.md': sha('content 0 v0')}, remove: []});
    const ssh = await api(r.url, 'PUT', '/v1/ssh/this', {port: 2222, destinations: ['ssh -p 2222 big@127.0.0.1']}, {origin: false});
    if (ssh.status !== 200) throw new Error(`ssh: ${ssh.status} ${ssh.bytes}`);
    const missing50 = Array.from({length: 50}, (_, i) => sha(`content ${i} v0`));
    let n = 0;
    const routes: [string, string, string, () => unknown, {origin?: boolean}?][] = [
      ['moved (the poll)', 'GET', '/v1/moved', () => undefined],
      ['news poll', 'GET', '/v1/news', () => undefined],
      ['SSH beat', 'POST', '/v1/ssh/this/beat', () => ({}), {origin: false}],
      ['repos list', 'GET', '/v1/repos', () => undefined],
      ['blobs missing (50)', 'POST', '/v1/blobs/missing', () => missing50],
      [`draft read (${FILES} files)`, 'GET', '/v1/repos/big', () => undefined],
      ['draft PATCH (1 file)', 'PATCH', '/v1/repos/big/draft', () => ({version: version + n, set: {[path(5)]: sha(`content 5 v${(n % 2) * 0}`)}, remove: []})],
      [`log (50 of ${COMMITS} commits, ${FILES} files)`, 'GET', '/v1/repos/big/log?limit=50', () => undefined],
      ['log, as the clients ask it (summary)', 'GET', '/v1/repos/big/log?limit=50&summary=1', () => undefined],
      ['get-session', 'GET', '/api/auth/get-session', () => undefined],
    ];
    const results: Figures[] = [];
    for (const [route, method, p, body, o] of routes) {
      const toDb: number[] = [], walls: number[] = [], workers: number[] = [], cpus: number[] = [], conns: number[] = [], queries: number[] = [], trips: number[] = [], fromDb: number[] = [], setup: number[] = [];
      let last = {status: 0, bytes: Buffer.alloc(0)};
      for (let i = 0; i < N + 3; i++) {
        await b.control('/reset');
        const res = await api(r.url, method, p, body(), o);
        // A PATCH that changes nothing still moves the version; its next one is asked at the version it said.
        if (method === 'PATCH' && res.status === 200) n = res.json().version - version;
        if (method === 'PATCH' && res.status === 409) n = (res.json().version ?? version) - version;
        // The connection is let go after the answer (waitUntil): its close is counted with this request.
        for (let k = 0; k < 50 && (await b.control('/stats', 'GET')).open; k++) await new Promise((x) => setTimeout(x, 10));
        const s = await b.control('/stats', 'GET');
        last = res;
        if (i < 3) continue;
        walls.push(res.ms); workers.push(timing(res.headers.get('server-timing'), 'worker')); conns.push(s.opened); queries.push(s.queries);
        trips.push(s.roundTrips); fromDb.push(s.fromDb); toDb.push(s.toDb); if (s.setupMs.length) setup.push(...s.setupMs);
      }
      if (cpuBase) {
        for (let i = 0; i < Math.max(8, Math.floor(N / 2)) + 2; i++) {
          const res = await api(cpuBase, method, p, body(), o);
          if (method === 'PATCH' && res.status === 200) n = res.json().version - version;
          if (i >= 2) cpus.push(timing(res.headers.get('server-timing'), 'cpu'));
        }
      }
      const f: Figures = {route, status: last.status, wall: +median(walls).toFixed(1), wallP90: +p90(walls).toFixed(1), worker: median(workers), cpu: +median(cpus).toFixed(2),
        conns: median(conns), queries: median(queries), roundTrips: median(trips), fromDb: median(fromDb), toDb: median(toDb), setup: +median(setup).toFixed(1),
        bytes: last.bytes.length, gzip: gzipSync(last.bytes).length};
      results.push(f);
      say(`${route.padEnd(36)} ${String(f.status).padEnd(4)} wall ${f.wall} ms (p90 ${f.wallP90}) worker ${f.worker} cpu ${f.cpu} ms | conn ${f.conns} q ${f.queries} rt ${f.roundTrips} db→ ${f.fromDb} B →db ${f.toDb} B setup ${f.setup} ms | answer ${f.bytes} B (gz ${f.gzip})`);
    }
    report.routes = results;

    // The daily sweep, fired as the Cron Trigger is, on an account with something to sweep.
    pg.psql(`update room set unswept = true`, r.db);
    await b.control('/reset');
    const t = performance.now();
    await r.sweep();
    for (let k = 0; k < 100 && (await b.control('/stats', 'GET')).open; k++) await new Promise((x) => setTimeout(x, 20));
    const s = await b.control('/stats', 'GET');
    report.sweep = {ms: Math.round(performance.now() - t), conns: s.opened, queries: s.queries, roundTrips: s.roundTrips};
    say(`sweep (1 room to recount)                  ${report.sweep && JSON.stringify(report.sweep)}`);
  } finally {
    for (const c of cleanup) await c();
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
}

/** The app's first load as a browser gets it: requests, bytes, until it can be used; and how each file is kept. */
async function firstLoad(url: string, assets: string) {
  const {chromium} = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({viewport: {width: 1400, height: 900}})).newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const seen = new Map<string, {url: string; bytes: number; status: number; cache: string; encoding: string}>();
    cdp.on('Network.responseReceived', (e) => { seen.set(e.requestId, {url: e.response.url, bytes: 0, status: e.response.status,
      cache: String(e.response.headers['cache-control'] ?? e.response.headers['Cache-Control'] ?? ''), encoding: String(e.response.headers['content-encoding'] ?? '')}); });
    cdp.on('Network.loadingFinished', (e) => { const s = seen.get(e.requestId); if (s) s.bytes = e.encodedDataLength; });
    const t = performance.now();
    await page.goto(url);
    await page.getByRole('navigation', {name: /^(Purposes|目的)$/}).waitFor();
    const interactive = performance.now() - t;
    await page.waitForLoadState('networkidle');
    const list = [...seen.values()];
    // What Cloudflare's edge would send of each text file (it compresses; wrangler dev does not): gzip and brotli of the build.
    const files: {file: string; raw: number; gzip: number; brotli: number}[] = [];
    const walk = (d: string, pre = '') => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, `${pre}${f}/`); else if (/\.(js|css|html|json|svg|wasm)$/.test(f)) {
      const b = readFileSync(p); files.push({file: `${pre}${f}`, raw: b.length, gzip: gzipSync(b, {level: 9}).length, brotli: brotliCompressSync(b).length}); } } };
    walk(assets);
    const loaded = list.filter((x) => !x.url.includes('/v1/') && !x.url.includes('/api/'));
    const sum = (k: 'raw' | 'gzip' | 'brotli') => files.filter((f) => loaded.some((x) => x.url.endsWith(f.file) || (f.file === 'index.html' && new URL(x.url).pathname === '/'))).reduce((a, f) => a + f[k], 0);
    // How each is kept: the hashed files, and the page itself.
    const headers = async (p: string) => { const h = (await fetch(`${url}${p}`, {headers: {'Sec-Fetch-Mode': 'no-cors', 'Accept-Encoding': 'gzip, br'}})).headers;
      return {cache: h.get('cache-control'), etag: h.get('etag'), encoding: h.get('content-encoding')}; };
    const hashed = loaded.map((x) => new URL(x.url).pathname).find((p) => p.startsWith('/assets/')) ?? '/assets/';
    const out = {requests: list.length, appRequests: loaded.length, apiRequests: list.length - loaded.length, wireBytes: list.reduce((a, x) => a + x.bytes, 0),
      appRawBytes: sum('raw'), appGzipBytes: sum('gzip'), appBrotliBytes: sum('brotli'), interactiveMs: Math.round(interactive),
      indexHtml: await headers('/'), hashedAsset: {path: hashed, ...await headers(hashed)},
      // As the page itself asks (not a navigation): a hashed file that is not there.
      missingAsset: await page.evaluate(async () => (await fetch('/assets/none-0000.js')).status),
      list: list.map((x) => ({path: new URL(x.url).pathname, status: x.status, bytes: x.bytes, cache: x.cache, encoding: x.encoding})),
      repeat: {} as {requests?: number; revalidated?: number; fromCache?: number; wireBytes?: number}};
    // Coming back to it: what is asked of the network again, what is answered 304, what comes from the cache.
    seen.clear();
    const cached = new Set<string>();
    cdp.on('Network.requestServedFromCache', (e) => { cached.add(e.requestId); });
    const fromCache = new Set<string>();
    cdp.on('Network.responseReceived', (e) => { if (e.response.fromDiskCache || e.response.fromMemoryCache) fromCache.add(e.requestId); });
    await page.goto('about:blank');
    await page.goto(url);
    await page.getByRole('navigation', {name: /^(Purposes|目的)$/}).waitFor();
    await page.waitForLoadState('networkidle');
    const again = [...seen.entries()].filter(([, x]) => !x.url.includes('/v1/') && !x.url.includes('/api/'));
    out.repeat = {requests: again.length, revalidated: again.filter(([, x]) => x.status === 304).length,
      fromCache: again.filter(([id]) => cached.has(id) || fromCache.has(id)).length, wireBytes: again.reduce((a, [, x]) => a + x.bytes, 0)};
    say(`first load: ${out.requests} requests (${out.appRequests} app files, ${out.apiRequests} to the Remote), ${out.wireBytes} B over the wire as wrangler serves it; the app's files ${out.appRawBytes} B raw, ${out.appGzipBytes} B gzip, ${out.appBrotliBytes} B brotli; usable in ${out.interactiveMs} ms`);
    say(`  index.html: ${JSON.stringify(out.indexHtml)}  hashed ${out.hashedAsset.path}: ${JSON.stringify({...out.hashedAsset, path: undefined})}  a hashed file not there: ${out.missingAsset}`);
    say(`  coming back: ${JSON.stringify(out.repeat)}`);
    return out;
  } finally {
    await browser.close();
  }
}

await main();
