// For tests: a browser on one Remote, all in this process. Its core is the one a page runs (testing/node-core.ts),
// and every fetch, the core's too, goes to the service itself (service/testing.ts), so the app's own sync
// runs as it does in a page. Not
// part of the app; only the tests import it.
//
// The app's modules read the browser as they load, so they are loaded here,
// after it is set up: a test takes them from what `browserOnRemote()` gives.
// One per file (a process); its tests keep apart by using repos of their own.

import assert from 'node:assert/strict';
import {createApp, sha256} from '../../service/app.ts';
import {createAuth} from '../../service/auth.ts';
import {memoryBucket} from '../../service/bucket.ts';
import {fileDb, SECRET} from '../../service/testing.ts';
import type {Billing, PlanConfig} from '../../service/plan.ts';
import {buildCoreWasm} from '../../scripts/core-wasm.ts';
import {nodeCore} from './node-core.ts';

const URL_ = 'http://remote.test', APP = 'http://app.test';
const enc = new TextEncoder();

/**
 * `o`: the Remote's plan and how it is bought (service/plan.ts), none as before: everything open;
 * `bucket: false`: a Remote that holds no files (service/bucket.ts), as a Worker without R2 is.
 */
export async function browserOnRemote(o: {plan?: PlanConfig; billing?: Billing; bucket?: boolean} = {}) {
  const shelf = new Map<string, string>();
  Object.assign(globalThis, {localStorage: {
    getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k),
  }});
  const db = await fileDb();
  const auth = createAuth({db, secret: SECRET, baseURL: URL_, appOrigin: APP, rateLimit: false, dev: true});
  const {bucket: keeps, ...plan} = o;
  // Each session kept a few seconds as the Worker keeps it (auth.ts signedIn): a client's many requests ask the
  // database once, as in production, which is most of what the client tests took.
  const app = createApp({db, auth, bucket: keeps === false ? null : memoryBucket(), origins: [APP], providers: ['dev'], domain: 'length3.test', baseURL: URL_,
    sessionKept: 10_000, ...plan});
  /** What this browser asked the Remote, by path. */
  const asked: string[] = [];
  Object.assign(globalThis, {fetch: (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', APP);
    asked.push(new URL(url).pathname);
    return app.request(url, {...init, headers});
  }});

  // The core this browser runs, the very one (core/web), over files of its own; it is the device named in
  // a file both sides changed.
  const {useCore} = await import('../app/host.ts');
  useCore(nodeCore(buildCoreWasm({quiet: true}), {LENGTH3_HOME: '/data', LENGTH3_REMOTE: URL_, LENGTH3_DEVICE: 'Chrome Linux'}));
  const {store} = await import('../repos/repos.ts');
  const draft = await import('../remote/sync.ts');
  const history = await import('../repos/history.ts');
  const state = await import('../home/state.ts');

  /** Signing in as the browser does: the stand-in provider's page, then back (as `name`: another person). */
  const signIn = async (name?: string) => {
    const start = await fetch(`${URL_}/api/auth/sign-in/social`, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/`})});
    const cookies = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const go = new URL(((await start.json()) as {url: string}).url);
    const approve = new URL(`${URL_}/dev-oauth/approve`);
    for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
    if (name) approve.searchParams.set('name', name);
    const back = (await fetch(approve.toString())).headers.get('Location')!;
    return (await fetch(back, {headers: {Cookie: cookies}})).headers.get('set-auth-token')!;
  };
  const token = await signIn();
  await state.setState('remote', JSON.stringify({url: URL_, token}));
  const auth_ = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};

  /** Another device on the same account, speaking to the Remote directly: a file's text or bytes, or null to remove it. */
  async function elsewhere(repo: string, change: Record<string, Uint8Array | string | null>) {
    const now = await (await fetch(`${URL_}/v1/repos/${repo}`, {headers: auth_})).json() as {version?: number};
    const set: Record<string, string | null> = {};
    const remove: string[] = [];
    for (const [p, v] of Object.entries(change)) {
      if (v === null) { remove.push(p); continue; }
      const bytes = typeof v === 'string' ? enc.encode(v) : v;
      const sha = await sha256(bytes);
      await fetch(`${URL_}/v1/blobs/${sha}`, {method: 'PUT', headers: {Authorization: auth_.Authorization}, body: bytes as BodyInit});
      set[p] = sha;
    }
    const r = await fetch(`${URL_}/v1/repos/${repo}/draft`, {method: 'PATCH', headers: auth_, body: JSON.stringify({version: now.version ?? 0, set, remove})});
    assert.equal(r.status, 200, await r.clone().text());
  }
  /** Another device making an empty folder on the Remote. */
  async function elsewhereFolder(repo: string, path: string) {
    const now = await (await fetch(`${URL_}/v1/repos/${repo}`, {headers: auth_})).json() as {version?: number};
    const r = await fetch(`${URL_}/v1/repos/${repo}/draft`, {method: 'PATCH', headers: auth_, body: JSON.stringify({version: now.version ?? 0, set: {[path]: null}, remove: []})});
    assert.equal(r.status, 200, await r.clone().text());
  }
  /** The draft the Remote holds for a repo, as text by path (null: a folder; undefined: not text). */
  async function remoteFiles(repo: string): Promise<Record<string, string | null>> {
    const {draft: tree} = await (await fetch(`${URL_}/v1/repos/${repo}`, {headers: auth_})).json() as {draft: Record<string, string | null>};
    // Read 64 at a time, as a diff of many files is (POST /v1/blobs/read), not one request a file.
    const shas = [...new Set(Object.values(tree).filter((v): v is string => typeof v === 'string'))];
    const bytes = new Map<string, string>();
    for (let i = 0; i < shas.length; i += 64) {
      const got = await (await fetch(`${URL_}/v1/blobs/read`, {method: 'POST', headers: {...auth_, 'Content-Type': 'application/json'}, body: JSON.stringify(shas.slice(i, i + 64))})).json() as Record<string, string>;
      for (const [sha, b64] of Object.entries(got)) bytes.set(sha, new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
    }
    const out: Record<string, string | null> = {};
    for (const [p, sha] of Object.entries(tree)) out[p] = sha === null ? null : bytes.get(sha) ?? '';
    return out;
  }
  /** Another device changing a Home setting, from the version the Remote has. */
  async function elsewhereHome(key: string, value: string) {
    const now = await (await fetch(`${URL_}/v1/home/${key}`, {headers: auth_})).json() as {version: number};
    const r = await fetch(`${URL_}/v1/home/${key}`, {method: 'PUT', headers: auth_, body: JSON.stringify({value, version: now.version})});
    assert.ok(r.status === 200 || r.status === 201, await r.clone().text());
  }
  const remoteHome = async (key: string) => (await (await fetch(`${URL_}/v1/home/${key}`, {headers: auth_})).json() as {value: string | null; version: number});

  const text = async (repo: string, path: string) => (await store.read(repo, path)).text;
  /** A file at `path` as a Prompt writes it back, of any size, its folders made (null: an empty folder). */
  async function put(repo: string, path: string, value: string | null) {
    if (value === null) { await store.mkdir(repo, path); return; }
    await store.put(repo, path, enc.encode(value));
  }
  const names = async (repo: string, dir = '') => (await store.tree(repo, dir)).map((e) => e.name);
  /** Every file here, as text by path. */
  async function files(repo: string, dir = ''): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const e of await store.tree(repo, dir)) {
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') Object.assign(out, await files(repo, p));
      else out[p] = (await store.read(repo, p)).text!;
    }
    return out;
  }

  return {URL: URL_, token, db, signIn, store, draft, history, state, asked, elsewhere, elsewhereFolder, elsewhereHome, remoteFiles, remoteHome, text, put, names, files};
}
