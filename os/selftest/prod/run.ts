// npm run selftest:prod: the web app and l3 against the Remote as production
// runs it (README.md here), each part in turn, one heavy thing at a time:
//
//   node selftest/prod/run.ts [headers] [research] [web] [l3] [measure] [drills]
//
// With no part named: headers, research, web, l3. L3=path runs l3's part with
// that binary (the release's: cargo build --profile prompt -p l3
// --no-default-features --target x86_64-unknown-linux-musl); without it, l3 is
// built as selftest:l3 builds it. Every server it starts (Postgres, the
// bridge, workerd) is stopped when it ends, however it ends.

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cluster} from './postgres.ts';
import {appBuild, bridgeProcess, OS, remote} from './stack.ts';

const ALL = ['headers', 'research', 'web', 'l3', 'measure', 'drills'];
const asked = process.argv.slice(2);
const bad = asked.filter((a) => !ALL.includes(a));
if (bad.length) { console.error(`selftest:prod: not a part: ${bad.join(' ')} (${ALL.join(', ')})`); process.exit(2); }
const parts = asked.length ? asked : ['headers', 'research', 'web', 'l3'];
const say = (s: string) => console.log(`selftest:prod: ${s}`);

/** Run `args` with node from os/, its output passed on; its exit code. */
const node = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<number>((done) => {
  const c = spawn(process.execPath, args, {cwd: OS, stdio: 'inherit', env: {...process.env, ...env}});
  c.once('exit', (code) => done(code ?? 1));
});

/** A Postgres, the bridge and one Worker, for `f`; all stopped after. */
async function withRemote<T>(o: Omit<Parameters<typeof remote>[1], 'dir' | 'assets' | 'bridge'>, f: (r: Awaited<ReturnType<typeof remote>>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'length3-prod-run-'));
  const pg = await cluster();
  const b = await bridgeProcess();
  let r: Awaited<ReturnType<typeof remote>> | null = null;
  try {
    r = await remote(pg, {dir, assets: appBuild(), bridge: b.port, ...o});
    return await f(r);
  } finally {
    await r?.stop();
    await b.stop();
    pg.destroy();
    rmSync(dir, {recursive: true, force: true});
  }
}

/** What public/_headers says of every file of the app (Workers Assets puts it there). */
const APP_HEADERS: [string, RegExp][] = [['content-security-policy', /frame-ancestors 'none'/], ['x-frame-options', /^DENY$/],
  ['strict-transport-security', /max-age=31536000/], ['referrer-policy', /^no-referrer$/], ['cross-origin-opener-policy', /^same-origin$/],
  ['cross-origin-embedder-policy', /^require-corp$/],
  ['x-content-type-options', /^nosniff$/]];

/** The headers of real answers of workerd and Workers Assets: the app's files carry _headers; the Remote's routes their own. */
async function headers() {
  await withRemote({paid: true}, async (r) => {
    const get = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${r.url}${path}`, init);
      await res.arrayBuffer();
      return res;
    };
    const page = await get('/', {headers: {'Sec-Fetch-Mode': 'navigate', Accept: 'text/html'}});
    const html = await (await fetch(`${r.url}/`)).text();
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert.ok(asset, 'index.html names a hashed script');
    const answers: [string, Response][] = [
      ['GET / (index.html)', page],
      ['GET /a/page (SPA fallback)', await get('/a/page', {headers: {'Sec-Fetch-Mode': 'navigate', Accept: 'text/html'}})],
      [`GET ${asset}`, await get(asset, {headers: {'Sec-Fetch-Mode': 'no-cors'}})],
      ['GET /v1/health', await get('/v1/health')],
      ['GET /v1/about', await get('/v1/about')],
      ['GET /v1/repos (no session)', await get('/v1/repos')],
      ['GET /api/auth/get-session', await get('/api/auth/get-session', {headers: {Origin: r.url}})],
      ['OPTIONS /v1/repos (preflight)', await get('/v1/repos', {method: 'OPTIONS', headers: {Origin: r.url, 'Access-Control-Request-Method': 'PATCH'}})],
      ['GET /.well-known/length3', await get('/.well-known/length3?name=x')],
    ];
    const shown = ['cache-control', 'content-security-policy', 'x-frame-options', 'strict-transport-security', 'x-content-type-options', 'access-control-allow-origin', 'etag'];
    for (const [what, res] of answers) say(`${what.padEnd(34)} ${res.status} ${shown.map((h) => `${h}=${res.headers.get(h) ?? '-'}`).join(' ')}`);
    for (const [what, res] of answers.slice(0, 3)) {
      assert.equal(res.status, 200, what);
      for (const [h, want] of APP_HEADERS) assert.match(res.headers.get(h) ?? '', want, `${what}: ${h}`);
    }
    // The hashed files are kept for good; the page itself is asked again (by its ETag) each time.
    assert.equal(answers[2][1].headers.get('cache-control'), 'public, max-age=31536000, immutable', 'a hashed file is immutable');
    for (const [what, res] of answers.slice(0, 2)) assert.doesNotMatch(res.headers.get('cache-control') ?? '', /immutable/, `${what} is asked again`);
    // The Remote's own: never kept by a cache, nosniff, CORS for the app's origin; and _headers is not served as a file.
    for (const [what, res] of answers.slice(3).filter(([w]) => !w.startsWith('OPTIONS'))) {
      assert.equal(res.headers.get('cache-control'), 'no-store', `${what}: cache-control`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
    }
    assert.equal(answers[7][1].headers.get('access-control-allow-origin'), r.url, 'preflight: the app\'s origin');
    const file = await (await fetch(`${r.url}/_headers`, {headers: {'Sec-Fetch-Mode': 'no-cors'}})).text();
    assert.ok(!file.includes('frame-ancestors'), '_headers is not served as a file');
    say('headers: the app\'s files carry public/_headers as Workers Assets serves them; /v1, /api and /.well-known carry the Remote\'s own');
  });
}

/** Run l3 with `args` in its own home against `url`. */
function l3(bin: string, home: string, url: string, args: string[]) {
  const r = spawnSync(bin, args, {env: {PATH: process.env.PATH ?? '', HOME: home, LENGTH3_HOME: join(home, 'length3'), LENGTH3_LANG: 'en', LENGTH3_REMOTE: url, NO_COLOR: '1'},
    encoding: 'utf8', cwd: home, timeout: 120_000});
  return {code: r.status ?? -1, out: r.stdout, err: r.stderr};
}

/** A Remote for research (ENTER_AS), as production is configured today: in by the link alone; l3 through the device flow. */
async function research() {
  const key = randomBytes(30).toString('base64url');
  await withRemote({enter: {as: 'banana000000', key}}, async (r) => {
    const json = async (method: string, path: string, o: {token?: string; body?: unknown} = {}) => {
      const res = await fetch(`${r.url}${path}`, {method, headers: {Origin: r.url, ...(o.token ? {Authorization: `Bearer ${o.token}`} : {}),
        ...(o.body === undefined ? {} : {'Content-Type': 'application/json'}), 'CF-Connecting-IP': '10.8.0.1'}, body: o.body === undefined ? undefined : JSON.stringify(o.body)});
      const text = await res.text();
      let j: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { j = JSON.parse(text); } catch { /* not json */ }
      return {status: res.status, json: j, text};
    };
    const about = await json('GET', '/v1/about');
    assert.equal(about.json.enter, true);
    assert.deepEqual(about.json.providers, [], 'no provider is offered for research (the stand-in neither)');
    const dev = await fetch(`${r.url}/dev-oauth/authorize`, {headers: {'Sec-Fetch-Mode': 'navigate', Accept: 'text/html'}});
    assert.ok(!(await dev.text()).includes('Development provider'), 'the stand-in provider is not there');
    assert.notEqual((await json('POST', '/v1/enter', {body: {key: `${key}x`}})).status, 200, 'a wrong key opens nothing');
    const entered = await json('POST', '/v1/enter', {body: {key}});
    assert.equal(entered.status, 200, entered.text);
    const token = entered.json.token as string;
    assert.equal((await json('GET', '/api/auth/passkey/list-user-passkeys', {token})).status, 403, 'no passkey for research');
    assert.equal((await json('PUT', '/v1/home/todo', {token, body: {value: '[]', version: 0}})).status, 200);
    const bin = process.env.L3;
    if (bin) {
      const home = mkdtempSync(join(tmpdir(), 'length3-prod-l3-'));
      try {
        const login = await new Promise<{code: number; out: string}>((resolve, reject) => {
          const p = spawn(bin, ['login', r.url], {env: {PATH: process.env.PATH ?? '', HOME: home, LENGTH3_HOME: join(home, 'length3'), LENGTH3_LANG: 'en', NO_COLOR: '1'}, cwd: home});
          let out = '', approved = false;
          p.stdout.on('data', (d: Buffer) => {
            out += d;
            const code = /[?&]user_code=([^&\s]+)/.exec(out)?.[1];
            if (code && !approved) {
              approved = true;
              const userCode = decodeURIComponent(code);
              void (async () => {
                await json('GET', `/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {token});
                const a = await json('POST', '/api/auth/device/approve', {token, body: {userCode}});
                if (a.status !== 200) throw new Error(a.text);
              })().catch(reject);
            }
          });
          p.once('exit', (c) => resolve({code: c ?? -1, out}));
        });
        assert.equal(login.code, 0, login.out);
        const made = l3(bin, home, r.url, ['repo', 'new', 'notes', '-t', 'empty']);
        assert.equal(made.code, 0, made.err);
        const listed = l3(bin, home, r.url, ['remote']);
        assert.match(listed.out, /notes {2}in step/, listed.out + listed.err);
        say('research: l3 signed in through the device flow approved by the entered session, and keeps a repo in step');
      } finally { rmSync(home, {recursive: true, force: true}); }
    } else say('research: no L3 given: l3\'s part of it is left out');
    assert.equal((await json('GET', '/v1/repos', {token})).status, 200);
    assert.equal(await r.sweep(), 200);
    for (let i = 0; i < 50 && !/sweep \{/.test(r.log()); i++) await new Promise((x) => setTimeout(x, 100));
    assert.match(r.log(), /sweep \{/, 'the Cron Trigger ran the sweep');
    say(`research: entered by the link, nothing else offered; the sweep: ${/sweep (\{.*\})/.exec(r.log())?.[1]}`);
  });
}

let failed = 0;
const assets = mkdtempSync(join(tmpdir(), 'length3-prod-assets-'));
try {
  say('building the app for its own origin, as build:cloudflare does');
  const built = spawnSync(process.execPath, [join(OS, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', assets, '--logLevel', 'error'],
    {cwd: OS, stdio: 'inherit', env: {...process.env, VITE_LENGTH3_REMOTE: ''}});
  if (built.status !== 0) throw new Error('the app did not build');
  assert.ok(existsSync(join(assets, '_headers')), 'the build carries public/_headers');
  process.env.PROD_ASSETS = assets;
  for (const part of parts) {
    say(`— ${part}`);
    try {
      if (part === 'headers') await headers();
      else if (part === 'research') await research();
      else if (part === 'web') { const c = await node([join(OS, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', 'selftest'], {SELFTEST_REMOTE_KIND: 'worker'}); if (c) throw new Error(`the app's selftest failed (${c})`); }
      else if (part === 'l3') {
        if (spawnSync(process.execPath, [join(OS, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'selftest/l3'], {cwd: OS, stdio: 'inherit'}).status !== 0) throw new Error('selftest/l3 does not compile');
        const c = await node(['--test', '--test-concurrency=1', 'selftest/l3/*.test.ts'], {SELFTEST_REMOTE_KIND: 'worker'});
        if (c) throw new Error(`l3's selftest failed (${c})`);
      } else if (part === 'measure') { const c = await node([join(OS, 'selftest', 'prod', 'measure.ts')]); if (c) throw new Error(`measure failed (${c})`); }
      else if (part === 'drills') { const c = await node([join(OS, 'selftest', 'prod', 'drills.ts')]); if (c) throw new Error(`drills failed (${c})`); }
      say(`${part}: passed`);
    } catch (e) {
      failed++;
      console.error(`selftest:prod: ${part} FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
} finally {
  rmSync(assets, {recursive: true, force: true});
}
say(failed ? `${failed} part(s) failed` : `passed: ${parts.join(', ')}`);
process.exit(failed ? 1 : 0);
