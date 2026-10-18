// For tests: a browser on one Remote, all in this process. Its storage is a
// map, and every fetch goes to the service itself (service/testing.ts), so
// the app's own sync (draft.ts, history.ts) runs as it does in a page. Not
// part of the app; only the tests import it.
//
// The app's modules read the browser as they load, so they are loaded here,
// after it is set up: a test takes them from what `browserOnRemote()` gives.
// One per file (a process); its tests keep apart by using repos of their own.

import assert from 'node:assert/strict';
import {createApp, sha256} from '../service/app.ts';
import {createAuth} from '../service/auth.ts';
import {memoryBucket} from '../service/bucket.ts';
import {fileDb, SECRET} from '../service/testing.ts';
import type {Billing, PlanConfig} from '../service/plan.ts';

const URL_ = 'http://remote.test', APP = 'http://app.test';
const enc = new TextEncoder();

/** `o`: the Remote's plan and how it is bought (service/plan.ts); none, as before: everything open. */
export async function browserOnRemote(o: {plan?: PlanConfig; billing?: Billing} = {}) {
  const shelf = new Map<string, string>();
  Object.assign(globalThis, {localStorage: {
    getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k),
  }});
  const db = await fileDb();
  const auth = createAuth({db, secret: SECRET, baseURL: URL_, appOrigin: APP, rateLimit: false, dev: true});
  const app = createApp({db, auth, bucket: memoryBucket(), origins: [APP], providers: ['dev'], domain: 'length3.test', baseURL: URL_, ...o});
  /** What this browser asked the Remote, by path. */
  const asked: string[] = [];
  Object.assign(globalThis, {fetch: (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', APP);
    asked.push(new URL(url).pathname);
    return app.request(url, {...init, headers});
  }});

  const {store} = await import('./repos.ts');
  const draft = await import('./draft.ts');
  const history = await import('./history.ts');
  const state = await import('./state.ts');

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
    const out: Record<string, string | null> = {};
    for (const [p, sha] of Object.entries(tree)) {
      out[p] = sha === null ? null : new TextDecoder().decode(await (await fetch(`${URL_}/v1/blobs/${sha}`, {headers: auth_})).arrayBuffer());
    }
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

  return {URL: URL_, token, db, signIn, store, draft, history, state, asked, elsewhere, elsewhereFolder, elsewhereHome, remoteFiles, remoteHome, text, names, files};
}
