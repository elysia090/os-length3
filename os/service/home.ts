// Home's settings that are the person's, kept for every device: a few keys
// (the app and l3 use profile, todo and dotfiles), each a value and its
// version, changed only from the version it was read at (src/remote/sync.ts
// syncHome, core/src/home.rs: one protocol, replayed from
// shared/home-sync.json by the tests).
//
//   GET  /v1/home/:key   {value, version} ({value: null, version: 0} when never set)
//   PUT  /v1/home/:key   {value, version} -> {version} | 409 {value, version}

import {and, eq, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {body, LIMIT, lock, rows, type Db, type Vars} from './request.ts';
import {home} from './schema.ts';

export function homeRoutes(d: {db: Db}, v1: Hono<Vars>) {
  const db = d.db;

  v1.get('/home/:key', async (c) => {
    const [row] = await db.select({value: home.value, version: home.version}).from(home).where(and(eq(home.userId, c.get('userId')), eq(home.key, c.req.param('key'))));
    return c.json(row ?? {value: null, version: 0});
  });

  v1.put('/home/:key', async (c) => {
    const k = c.req.param('key'), user = c.get('userId');
    if (!/^[a-z]{1,32}$/.test(k)) return c.json({error: 'Not found'}, 404);
    const b = await body<{value?: unknown; version?: unknown}>(c);
    // A version is a whole number an integer column holds (1.5 and 1e20 were 500s).
    if (!b || typeof b.value !== 'string' || typeof b.version !== 'number' || !Number.isInteger(b.version) || b.version < 0 || b.version >= 2 ** 31 - 1
      || b.value.length > LIMIT.home) return c.json({error: 'a value and its version'}, 400);
    const value = b.value, version = b.version;
    // Changed from the version it was read at: the row's own version says whether another came first, so it is one
    // statement, no lock and no transaction (every save of the TODO and the profile; it was five round trips).
    // Made anew: counted against the most an account keeps and made in one statement, under the account's lock.
    const done: {version: number}[] = version !== 0
      ? await db.update(home).set({value, version: version + 1}).where(and(eq(home.userId, user), eq(home.key, k), eq(home.version, version))).returning({version: home.version})
      : await db.transaction(async (tx: Db) => {
        await lock(tx, user);
        return rows<{version: number}>(tx, sql`insert into home (user_id, key, value, version) select ${user}, ${k}, ${value}, 1
          where (select count(*) from home h where h.user_id = ${user} and h.key <> ${k}) < ${LIMIT.homeKeys} on conflict do nothing returning version`);
      });
    if (!done.length) {
      const [row] = await db.select({value: home.value, version: home.version}).from(home).where(and(eq(home.userId, user), eq(home.key, k)));
      // None there, and none made: the account keeps the most settings it may.
      if (!row && version === 0) return c.json({error: 'Too many settings'}, 429);
      return c.json(row ?? {value: null, version: 0}, 409);
    }
    return c.json({version: done[0].version});
  });
}
