// l3 end to end, against a Remote of its own: what the tests in this folder
// share. One Remote per test file: service/dev.ts on a free port with a data
// directory made for it, stopped when the file is done. l3 is built once (or
// taken from $L3) and copied beside it, so another build cannot swap it
// mid-run. Each device is a home directory of its own, signed in through the
// Remote's stand-in provider and its device approval, as a person would.
//
// Nothing here waits by the clock: the Remote is ready when it says so, and
// l3 login is done when l3 exits (it polls the Remote at the interval the
// Remote names).

import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {request} from 'node:http';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after} from 'node:test';
import {fileURLToPath} from 'node:url';

const OS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = 'http://localhost:4173';
/** Ports this machine's other servers use: never taken here. */
const TAKEN = (p: number) => [1420, 8787, 1430, 8797].includes(p) || (p >= 1450 && p <= 1560) || (p >= 8810 && p <= 8930);

/** l3 built from this tree (cargo build -p l3), or $L3 when given; its path. */
function buildL3(): string {
  if (process.env.L3) return process.env.L3;
  const r = spawnSync('cargo', ['build', '-p', 'l3', '--message-format=json-render-diagnostics'], {cwd: OS, encoding: 'utf8', maxBuffer: 1 << 28});
  assert.equal(r.status, 0, r.stderr);
  const exe = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as {reason?: string; target?: {name: string}; executable?: string | null})
    .find((m) => m.reason === 'compiler-artifact' && m.target?.name === 'l3' && m.executable)?.executable;
  assert.ok(exe, 'cargo named no l3 executable');
  return exe;
}

/** A port nothing listens on now, outside those other servers here use. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const p = (s.address() as {port: number}).port;
        s.close(() => resolve(p));
      });
    });
    if (!TAKEN(port)) return port;
  }
}

/**
 * One HTTP exchange on a connection of its own: a connection kept between
 * requests can be closed by the Remote while l3 runs, and a request sent on
 * it then fails for no fault of either.
 */
function http(method: string, url: string | URL, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{status: number; headers: Record<string, string | string[] | undefined>; text: string}>((resolve, reject) => {
    const r = request(url, {method, headers, agent: false}, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { text += d; });
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, text}));
    });
    r.once('error', reject);
    r.end(body);
  });
}
const cookiesOf = (h: Record<string, string | string[] | undefined>) => ([h['set-cookie'] ?? []].flat() as string[]).map((c) => c.split(';')[0]).join('; ');

export interface Ran { code: number; out: string; err: string; json: any } // eslint-disable-line @typescript-eslint/no-explicit-any

export async function remote() {
  const dir = mkdtempSync(join(tmpdir(), 'l3-selftest-'));
  const l3bin = join(dir, 'l3');
  copyFileSync(buildL3(), l3bin);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let log = '';
  /** The Remote started (again: on the same port, from the same data, so every session stays). */
  async function start() {
    const p = spawn(process.execPath, [join(OS, 'service', 'dev.ts'), join(dir, 'remote'), String(port), APP], {cwd: OS, stdio: ['ignore', 'pipe', 'pipe']});
    server = p;
    p.stderr.on('data', (d: Buffer) => { log += d; });
    const from = log.length;
    await new Promise<void>((resolve, reject) => {
      p.stdout.on('data', (d: Buffer) => { log += d; if (log.slice(from).includes(`remote on ${url}`)) resolve(); });
      p.once('exit', (code) => reject(new Error(`the Remote stopped (${code}) before it was ready:\n${log}`)));
    });
  }
  /** The Remote stopped: out of every device's reach until it is started again. */
  async function stop() {
    const p = server;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const stopped = new Promise((r) => p.once('exit', r));
    p.kill();
    await stopped;
  }
  await start();
  // Should this process end before its tests do, the Remote ends with it.
  process.once('exit', () => { server?.kill(); });
  after(async () => {
    await stop();
    rmSync(dir, {recursive: true});
  });

  let browsers = 0;
  /** Each browser's address, by its token. */
  const addressOf = new Map<string, string>();
  /**
   * A browser signed in as `name` (the stand-in provider): its bearer token.
   * Each is a person at an address of their own (as Cloudflare would say it):
   * the Remote holds off a fourth sign-in from one address in ten seconds.
   */
  async function browser(name: string): Promise<string> {
    const at = `198.51.100.${++browsers}`;
    const asked = await http('POST', `${url}/api/auth/sign-in/social`, {Origin: APP, 'Content-Type': 'application/json', 'CF-Connecting-IP': at},
      JSON.stringify({provider: 'dev', callbackURL: `${APP}/`}));
    assert.equal(asked.status, 200, asked.text);
    const go = new URL((JSON.parse(asked.text) as {url: string}).url);
    const approve = new URL(`${url}/dev-oauth/approve`);
    for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
    approve.searchParams.set('name', name);
    const back = (await http('GET', approve, {'CF-Connecting-IP': at})).headers.location as string;
    const done = await http('GET', back, {Cookie: cookiesOf(asked.headers), 'CF-Connecting-IP': at});
    const token = done.headers['set-auth-token'] as string | undefined;
    assert.ok(token, `no session for ${name}: ${done.status} ${done.text}`);
    addressOf.set(token, at);
    return token;
  }
  /** The Remote's HTTP surface, as `token`'s browser. */
  const api = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await http(method, `${url}${path}`, {Origin: APP, Authorization: `Bearer ${token}`, 'CF-Connecting-IP': addressOf.get(token) ?? '', ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      body === undefined ? undefined : JSON.stringify(body));
    let json: unknown = null;
    try { json = JSON.parse(r.text); } catch { /* not json */ }
    return {status: r.status, json: json as any, text: r.text}; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  let devices = 0;
  /** A device of its own: l3 with its own home, on no Remote until it logs in. */
  function device() {
    const home = join(dir, `device-${++devices}`);
    mkdirSync(home);
    const env = {PATH: process.env.PATH ?? '', HOME: home, LENGTH3_HOME: join(home, 'length3'), LENGTH3_LANG: 'en', LENGTH3_REMOTE: url, NO_COLOR: '1'};
    const parse = (out: string) => { try { return JSON.parse(out); } catch { return null; } };
    /** Run l3 with these words (and standard input), to its end. */
    const l3 = (args: string[], input = ''): Ran => {
      const r = spawnSync(l3bin, args, {env, input, encoding: 'utf8', cwd: home, timeout: 120_000});
      return {code: r.status ?? -1, out: r.stdout, err: r.stderr, json: parse(r.stdout)};
    };
    /** l3 login, approved in `token`'s browser when l3 shows its code. */
    const login = (token: string) => new Promise<Ran>((resolve, reject) => {
      const p = spawn(l3bin, ['login', url], {env, cwd: home, stdio: ['ignore', 'pipe', 'pipe']});
      let out = '', err = '', approved = false;
      p.stderr.on('data', (d: Buffer) => { err += d; });
      p.stdout.on('data', (d: Buffer) => {
        out += d;
        const code = /[?&]user_code=([^&\s]+)/.exec(out)?.[1];
        if (code && !approved) {
          approved = true;
          const userCode = decodeURIComponent(code);
          void (async () => {
            assert.equal((await api(token, 'GET', `/api/auth/device?user_code=${encodeURIComponent(userCode)}`)).status, 200);
            const ok = await api(token, 'POST', '/api/auth/device/approve', {userCode});
            assert.equal(ok.status, 200, ok.text);
          })().catch(reject);
        }
      });
      p.once('exit', (code) => resolve({code: code ?? -1, out, err, json: null}));
    });
    return {home, env, l3, login};
  }

  return {url, dir, browser, api, device, start, stop, log: () => log};
}
