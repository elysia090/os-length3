// For client tests: a browser on one Remote, all in this process. Its storage
// is a map, and every fetch goes to the service itself (service/app.ts), so a
// client module is tested against the Remote it really talks to.

import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp} from '../service/app.ts';
import {createAuth} from '../service/auth.ts';
import {memoryBucket} from '../service/bucket.ts';
import * as schema from '../service/schema.ts';

export const REMOTE = 'http://remote.test';
const APP = 'http://app.test';

export async function inProcessRemote() {
  const shelf = new Map<string, string>();
  Object.assign(globalThis, {localStorage: {
    getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k),
  }});
  const db = drizzle(new PGlite(), {schema});
  await migrate(db, {migrationsFolder: new URL('../service/migrations', import.meta.url).pathname});
  const auth = createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: REMOTE, appOrigin: APP, rateLimit: false, dev: true});
  const app = createApp({db, auth, bucket: memoryBucket(), origins: [APP], providers: ['dev']});
  Object.assign(globalThis, {fetch: (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Origin', APP);
    return app.request(url, {...init, headers});
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
    return (await fetch(back, {headers: {Cookie: cookies}})).headers.get('set-auth-token')!;
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

  /** The code a repo is turned off with, set for `token`'s account (proven first, as the Remote asks). */
  const setCode = async (token: string, code: string) => {
    await prove(token);
    await fetch(`${REMOTE}/v1/off-code`, {method: 'POST', headers: bearer(token), body: JSON.stringify({code})});
  };

  return {db, signIn, answers, prove, repo, setCode};
}
