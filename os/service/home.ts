// Home's settings that are the person's, kept for every device: a few keys
// (the app and l3 use profile, todo and dotfiles), each a value and its
// version, changed only from the version it was read at (src/draft.ts
// syncHome, core/src/home.rs: one protocol, replayed from
// shared/home-sync.json by the tests).
//
//   GET  /v1/home/:key   {value, version} ({value: null, version: 0} when never set)
//   PUT  /v1/home/:key   {value, version} -> {version} | 409 {value, version}

import {and, eq, ne, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {body, LIMIT, lock, refuse, type Db, type Vars} from './request.ts';
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
    if (!b || typeof b.value !== 'string' || typeof b.version !== 'number' || b.value.length > LIMIT.home) return c.json({error: 'a value and its version'}, 400);
    const value = b.value, version = b.version;
    const done = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const where = and(eq(home.userId, user), eq(home.key, k));
      if (version !== 0) return tx.update(home).set({value, version: version + 1}).where(and(where, eq(home.version, version))).returning({version: home.version});
      const [{n}] = await tx.select({n: sql<number>`count(*)::int`}).from(home).where(and(eq(home.userId, user), ne(home.key, k)));
      if (n >= LIMIT.homeKeys) refuse(429, {error: 'Too many settings'});
      return tx.insert(home).values({userId: user, key: k, value, version: 1}).onConflictDoNothing().returning({version: home.version});
    });
    if (!done.length) {
      const [row] = await db.select({value: home.value, version: home.version}).from(home).where(and(eq(home.userId, user), eq(home.key, k)));
      return c.json(row ?? {value: null, version: 0}, 409);
    }
    return c.json({version: done[0].version});
  });
}
