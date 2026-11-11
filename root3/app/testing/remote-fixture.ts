// For client tests: a browser on one Remote, all in this process. Its storage
// is a map, and every fetch goes to the service itself (root3/remote/serve/app.ts), so a
// client module is tested against the Remote it really talks to.

import {createApp} from '../../remote/serve/app.ts';
import {createAuth} from '../../remote/people/auth.ts';
import {memoryBucket} from '../../remote/bytes/bucket.ts';
import * as schema from '../../remote/db/schema.ts';
import {bearerOf, fileDb} from '../../remote/tests/testing.ts';
import {cookieJar} from './cookies.ts';

export const REMOTE = 'http://remote.test';
const APP = 'http://app.test';

export async function inProcessRemote() {
  const shelf = new Map<string, string>();
  Object.assign(globalThis, {localStorage: {
    getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k),
  }});
  // Migrated as every test's database is, and closed when the file is done (an open one keeps the process up).
  const db = await fileDb();
  const auth = createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: REMOTE, appOrigin: APP, rateLimit: false, dev: true});
  const app = createApp({db, auth, bucket: memoryBucket(), origins: [APP], providers: ['dev']});
  // The browser's cookies for the Remote: its session's among them, which no page reads.
  const jar = cookieJar();
  Object.assign(globalThis, {fetch: async (url: string, init?: RequestInit) => {
    const {headers, browser} = jar.sent(init);
    headers.set('Origin', APP);
    const r = await app.request(url, {...init, headers});
    if (browser) jar.keep(r);
    return r;
  }});
  const bearer = (token: string) => ({Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'});

  /** A session of `name`'s account, as a browser gets one from the stand-in provider. */
  const signIn = async (name = 'Ren'): Promise<string> => {
    const asked = await fetch(`${REMOTE}/api/auth/sign-in/social`, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/`})});
    const cookies = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const go = new URL(((await asked.json()) as {url: string}).url);
    const approve = new URL(`${REMOTE}/dev-oauth/approve`);
    for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
    approve.searchParams.set('name', name);
    const back = (await fetch(approve.toString())).headers.get('Location')!;
    return bearerOf((await fetch(back, {headers: {Cookie: cookies}})).headers.getSetCookie())!;
  };

  /** Whether `token` is still a session the Remote answers. */
  const answers = async (token: string) => (await fetch(`${REMOTE}/v1/repos`, {headers: bearer(token)})).status === 200;

  /** A passkey sign-in made this session just now, as auth.ts records one (there is no authenticator here). */
  const prove = async (token: string) => {
    const s = await (await fetch(`${REMOTE}/api/auth/get-session`, {headers: bearer(token)})).json() as {user: {id: string}; session: {id: string}};
    const proof = {proofSession: s.session.id, proofAt: new Date()};
    await db.insert(schema.guard).values({userId: s.user.id, ...proof}).onConflictDoUpdate({target: schema.guard.userId, set: proof});
  };

  /** A repo on the Remote under `token`'s account, with nothing in it. */
  const repo = async (token: string, name: string) => {
    await fetch(`${REMOTE}/v1/repos/${name}/draft`, {method: 'PATCH', headers: bearer(token), body: JSON.stringify({version: 0, set: {}, remove: []})});
  };

  /** This browser in as `token`'s session, as a sign-in leaves it: the session's cookie, and the core told which it is. */
  const browserAs = async (token: string, url = REMOTE) => {
    jar.session(token);
    const {core} = await import('../host/host.ts');
    await core('remote_connect', {url});
    await (await import('../home/state.ts')).loadState(['remote']);
  };

  return {db, signIn, answers, prove, repo, browserAs};
}
