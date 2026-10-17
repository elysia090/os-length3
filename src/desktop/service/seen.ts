// Who sees a repo (schema.ts, repoShare and repoPublic): only its owner, the
// servers it is shown in, or everyone. Anyone but its owner only sees it,
// never writes in it, and what they see is what it was last pushed to (the
// commit others may see), its files read one at a time.
//
// In a server, its people see whose a repo is: ren@length3.com:hello. Seen
// by everyone, it answers only to the name it was made public as, its face:
// a server's (trip@length3.com:hello) when it went public from one, so that
// nothing it answers ties it to its owner; its owner's own when they made it
// public themselves. Its owner's name does not open it to everyone either
// way: ren:hello is still for Ren and the people of the servers it is in.
//
//   GET    /v1/seen                          mine: who sees each repo
//   PUT    /v1/repos/NAME/seen               {seen: 'private' | 'servers' | 'everyone', servers?: [ID], as?: ID | 'me'}
//   GET    /v1/servers/ID/repos              the repos shown in a server
//   POST   /v1/servers/ID/repos              {repo}: show one of mine in it
//   DELETE /v1/servers/ID/repos/OWNER/NAME   take it off its list (its owner, or the server's)
// and, for whoever may see it (anyone, signed in or not, when everyone may):
//   GET    /v1/seen/FACE/NAME                what it was last pushed to: its tree
//   GET    /v1/seen/FACE/NAME/blobs/SHA      a file in that tree

import {and, eq, inArray, isNull, not, type SQL} from 'drizzle-orm';
import type {Hono} from 'hono';
import type {Bucket} from './bucket.ts';
import {byCode, HOLD, live} from './names.ts';
import {address, cut, member, repo, repoPublic, repoShare, server} from './schema.ts';

export type Seen = 'private' | 'servers' | 'everyone';

type Vars = {Variables: {userId: string; sessionId: string}};
type Row = typeof repo.$inferSelect;
type Public = typeof repoPublic.$inferSelect;

export interface SeenDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  bucket: Bucket;
  /** Who is asking, if they are signed in. */
  viewer: (req: Request) => Promise<string | null>;
  /** This Remote's own domain: a name written alone is on it. */
  domain: string;
}

const HEX = /^[0-9a-f]{64}$/;

/** Take down what answers to `where` among public faces: held HOLD for whoever had it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function takeDown(db: any, where: SQL | undefined, now = new Date()) {
  await db.update(repoPublic).set({releasedAt: now}).where(and(where, isNull(repoPublic.releasedAt)));
}

export function seen(d: SeenDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;
  const main = (user: string, name: string) => and(eq(repo.userId, user), eq(repo.name, name), eq(repo.line, 'main'));
  const mainRow = async (user: string, name: string) => (await db.select().from(repo).where(main(user, name)))[0] as Row | undefined;
  /** Those of `ids` that are live servers `me` is in, with their names as principals. */
  const inServers = async (me: string, ids: string[]) => (ids.length
    ? await db.select({id: server.id, address: server.address}).from(member).innerJoin(server, eq(server.id, member.serverId))
      .where(and(eq(member.userId, me), inArray(member.serverId, ids), isNull(server.goneAt))) as {id: string; address: string}[]
    : []);
  const firstAddress = async (me: string) =>
    ((await db.select({a: address.address}).from(address).where(and(eq(address.userId, me), live)).orderBy(address.createdAt)) as {a: string}[])[0]?.a ?? null;
  const ofRepo = (user: string, name: string) => and(eq(repoPublic.userId, user), eq(repoPublic.repo, name));

  /** Who sees each of `user`'s repos `names`. */
  const states = async (user: string, names: string[]) => {
    const shares = await db.select({repo: repoShare.repo, id: server.id, name: server.name, address: server.address}).from(repoShare)
      .innerJoin(server, eq(server.id, repoShare.serverId)).where(and(eq(repoShare.userId, user), isNull(server.goneAt)))
      .orderBy(repoShare.sharedAt) as {repo: string; id: string; name: string; address: string}[];
    const faces = await db.select().from(repoPublic).where(and(eq(repoPublic.userId, user), isNull(repoPublic.releasedAt))) as Public[];
    return names.map((name) => {
      const servers = shares.filter((s) => s.repo === name).map(({id, name, address}) => ({id, name, address}));
      const f = faces.find((x) => x.repo === name);
      return {name, seen: (f ? 'everyone' : servers.length ? 'servers' : 'private') as Seen, servers,
        as: f ? `${f.face}:${f.name}` : null, asServer: f?.serverId ?? null};
    });
  };

  /**
   * Make `user`'s repo `name` public as `face:name`: free, theirs already (or
   * held for them), or not (another's, or held for another until `until`).
   */
  const claim = async (user: string, name: string, face: string, serverId: string | null, now = Date.now()): Promise<{ok: true} | {ok: false; until?: number}> => {
    const at = and(eq(repoPublic.face, face), eq(repoPublic.name, name));
    const [row] = await db.select().from(repoPublic).where(at) as Public[];
    if (row && row.userId !== user) {
      if (!row.releasedAt) return {ok: false};
      const until = row.releasedAt.getTime() + HOLD;
      if (until > now) return {ok: false, until};
    }
    // A repo is public as one name: any other it had is taken down.
    await takeDown(db, and(ofRepo(user, name), not(at!)));
    const values = {userId: user, repo: name, serverId, publishedAt: new Date(now), releasedAt: null};
    if (row) await db.update(repoPublic).set(values).where(at);
    else await db.insert(repoPublic).values({face, name, ...values});
    return {ok: true};
  };

  v1.get('/seen', async (c) => {
    const me = c.get('userId');
    const rows = await db.select({name: repo.name}).from(repo)
      .where(and(eq(repo.userId, me), eq(repo.line, 'main'), isNull(repo.offAt))).orderBy(repo.name) as {name: string}[];
    return c.json(await states(me, rows.map((r) => r.name)));
  });

  // Who sees it is said all at once. Everyone: as a server it is in (by
  // default the first it is shown in), or as its owner ('me', by default when
  // it is in none). Anything else takes down its public face.
  v1.put('/repos/:name/seen', async (c) => {
    const me = c.get('userId'), name = c.req.param('name');
    const row = await mainRow(me, name);
    if (!row || row.offAt) return c.json({error: 'no repo'}, 404);
    const b = await c.req.json().catch(() => null) as {seen?: unknown; servers?: unknown; as?: unknown} | null;
    const to = b?.seen;
    if (to !== 'private' && to !== 'servers' && to !== 'everyone') return c.json({error: 'private, servers or everyone'}, 400);
    let ids = Array.isArray(b?.servers) ? [...new Set((b.servers as unknown[]).filter((x): x is string => typeof x === 'string'))] : null;
    if (to === 'servers' && !ids?.length) return c.json({error: 'which servers'}, 400);
    if (ids && (await inServers(me, ids)).length !== ids.length) return c.json({error: 'only servers you are in'}, 403);
    if (to === 'everyone') {
      const now = (await states(me, [name]))[0];
      const as = typeof b?.as === 'string' ? b.as : now.asServer ?? (ids ?? now.servers.map((s) => s.id))[0] ?? 'me';
      let face: string | null, serverId: string | null = null;
      if (as === 'me') face = await firstAddress(me);
      else {
        const [s] = await inServers(me, [as]);
        if (!s) return c.json({error: 'only servers you are in'}, 403);
        face = s.address || null;
        serverId = s.id;
        // Its face is that server's: it is shown there too.
        ids = [...new Set([...(ids ?? now.servers.map((x) => x.id)), s.id])];
      }
      if (!face) return c.json({error: 'claim an address first'}, 409);
      const got = await claim(me, name, face, serverId);
      if (!got.ok) return c.json({error: got.until ? 'held' : 'taken', as: `${face}:${name}`, ...(got.until ? {until: got.until} : {})}, 409);
    } else await takeDown(db, ofRepo(me, name));
    if (to === 'private' || ids) {
      await db.delete(repoShare).where(and(eq(repoShare.userId, me), eq(repoShare.repo, name)));
      if (to !== 'private' && ids?.length) await db.insert(repoShare).values(ids.map((serverId) => ({userId: me, repo: name, serverId})));
    }
    return c.json((await states(me, [name]))[0]);
  });

  // ---- in a server, beside its people ----
  /** The repos shown in a server, whose, and as what everyone sees them, if they do. */
  const shownIn = async (serverId: string, me: string) => {
    const rows = await db.select({userId: repoShare.userId, name: repoShare.repo, owner: member.address, at: cut.time}).from(repoShare)
      .innerJoin(member, and(eq(member.serverId, repoShare.serverId), eq(member.userId, repoShare.userId)))
      .innerJoin(repo, and(eq(repo.userId, repoShare.userId), eq(repo.name, repoShare.repo), eq(repo.line, 'main')))
      .leftJoin(cut, and(eq(cut.userId, repo.userId), eq(cut.repo, repo.name), eq(cut.id, repo.pushed)))
      .where(and(eq(repoShare.serverId, serverId), isNull(repo.offAt))).orderBy(repoShare.sharedAt) as {userId: string; name: string; owner: string; at: Date | null}[];
    const faces = rows.length ? await db.select().from(repoPublic)
      .where(and(inArray(repoPublic.userId, [...new Set(rows.map((r) => r.userId))]), isNull(repoPublic.releasedAt))) as Public[] : [];
    return rows.map((r) => {
      const f = faces.find((x) => x.userId === r.userId && x.repo === r.name);
      return {owner: r.owner, name: r.name, at: r.at?.getTime() ?? null, mine: r.userId === me, as: f ? `${f.face}:${f.name}` : null, asServer: f?.serverId ?? null};
    });
  };

  v1.get('/servers/:id/repos', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!(await inServers(me, [id])).length) return c.json({error: 'no such server of yours'}, 404);
    return c.json(await shownIn(id, me));
  });

  v1.post('/servers/:id/repos', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!(await inServers(me, [id])).length) return c.json({error: 'no such server of yours'}, 404);
    const name = (await c.req.json().catch(() => null) as {repo?: unknown} | null)?.repo;
    const row = typeof name === 'string' ? await mainRow(me, name) : undefined;
    if (!row || row.offAt) return c.json({error: 'no repo'}, 404);
    await db.insert(repoShare).values({userId: me, repo: row.name, serverId: id}).onConflictDoNothing();
    return c.json(await shownIn(id, me), 201);
  });

  // Off a server's list: and if it was public as that server, that ends too.
  v1.delete('/servers/:id/repos/:owner/:name', async (c) => {
    const me = c.get('userId'), id = c.req.param('id'), name = c.req.param('name');
    const people = await db.select({userId: member.userId, address: member.address, owner: member.owner}).from(member).innerJoin(server, eq(server.id, member.serverId))
      .where(and(eq(member.serverId, id), isNull(server.goneAt))) as {userId: string; address: string; owner: number}[];
    const mine = people.find((p) => p.userId === me);
    if (!mine) return c.json({error: 'no such server of yours'}, 404);
    const them = people.find((p) => p.address === c.req.param('owner').toLowerCase());
    if (!them) return c.json({error: 'not in this server'}, 404);
    if (them.userId !== me && !mine.owner) return c.json({error: 'only its owner, or the server\'s, takes it off'}, 403);
    await db.delete(repoShare).where(and(eq(repoShare.userId, them.userId), eq(repoShare.repo, name), eq(repoShare.serverId, id)));
    await takeDown(db, and(ofRepo(them.userId, name), eq(repoPublic.serverId, id)));
    return c.body(null, 204);
  });

  // ---- seeing one: made before /v1's own routes, which ask who is calling ----
  /**
   * What `face:name` shows `viewer`: a public face that still answers (its
   * server live with its owner still in it, or its owner's address still
   * theirs), told without its owner; else, `face` being its owner, their repo
   * if `viewer` is them or in a server it is shown in.
   */
  const find = async (written: string, name: string, viewer: string | null): Promise<{row: Row; as: string; owner?: string} | null> => {
    const face = await faceOf(written);
    if (!face) return null;
    const [p] = await db.select().from(repoPublic).where(and(eq(repoPublic.face, face), eq(repoPublic.name, name), isNull(repoPublic.releasedAt))) as Public[];
    if (p) {
      // A face answers while its name does (let go, lapsed or past its term, it does not), and, a server's, while its owner is in it.
      const named = (await db.select({a: address.address}).from(address)
        .where(and(eq(address.address, face), p.serverId ? eq(address.serverId, p.serverId) : eq(address.userId, p.userId), live))).length > 0;
      const answers = named && (!p.serverId
        || (await db.select({u: member.userId}).from(member).innerJoin(server, eq(server.id, member.serverId))
          .where(and(eq(member.serverId, p.serverId), eq(member.userId, p.userId), isNull(server.goneAt)))).length > 0);
      const row = answers ? await mainRow(p.userId, p.repo) : undefined;
      if (row && !row.offAt) return {row, as: `${face}:${name}`};
    }
    if (!viewer) return null;
    const [who] = await db.select({userId: address.userId}).from(address).where(and(eq(address.address, face), live)) as {userId: string | null}[];
    if (!who?.userId) return null;
    const row = await mainRow(who.userId, name);
    if (!row || row.offAt) return null;
    if (viewer !== who.userId) {
      const [via] = await db.select({id: repoShare.serverId}).from(repoShare)
        .innerJoin(server, eq(server.id, repoShare.serverId))
        .innerJoin(member, and(eq(member.serverId, repoShare.serverId), eq(member.userId, viewer)))
        .where(and(eq(repoShare.userId, who.userId), eq(repoShare.repo, name), isNull(server.goneAt))).limit(1);
      if (!via) return null;
    }
    return {row, as: `${face}:${name}`, owner: face};
  };
  /** A face as written: name@domain, a name alone (on this Remote), or a code (its owner's first name). */
  const faceOf = async (written: string): Promise<string | null> => {
    const q = written.toLowerCase();
    if (q.includes('@')) return q;
    const who = await byCode(db, q);
    if (!who) return /^\d{6}$/.test(q) ? null : `${q}@${d.domain}`;
    const [r] = await db.select({a: address.address}).from(address)
      .where(and('userId' in who ? eq(address.userId, who.userId) : eq(address.serverId, who.serverId), live)).orderBy(address.createdAt) as {a: string}[];
    return r?.a ?? null;
  };
  const pushed = async (row: Row) => (row.pushed
    ? (await db.select({tree: cut.tree, title: cut.title, time: cut.time}).from(cut)
      .where(and(eq(cut.userId, row.userId), eq(cut.repo, row.name), eq(cut.id, row.pushed))))[0] as {tree: Record<string, string | null>; title: string; time: Date} | undefined
    : undefined);

  app.get('/v1/seen/:face/:name', async (c) => {
    const at = await find(c.req.param('face'), c.req.param('name'), await d.viewer(c.req.raw));
    if (!at) return c.json({error: 'no such repo to see'}, 404);
    const p = await pushed(at.row);
    return c.json({as: at.as, ...(at.owner ? {owner: at.owner} : {}), title: p?.title ?? null, at: p?.time.getTime() ?? null, tree: p?.tree ?? {}});
  });

  app.get('/v1/seen/:face/:name/blobs/:sha', async (c) => {
    const sha = c.req.param('sha');
    const at = HEX.test(sha) ? await find(c.req.param('face'), c.req.param('name'), await d.viewer(c.req.raw)) : null;
    const p = at && await pushed(at.row);
    // Only what is in the tree it was pushed to: nothing else of its owner's.
    if (!at || !p || !Object.values(p.tree).includes(sha)) return c.json({error: 'no such file to see'}, 404);
    const bytes = await d.bucket.get(`u/${at.row.userId}/${sha}`);
    return bytes ? new Response(bytes as BodyInit, {headers: {'Content-Type': 'application/octet-stream', ETag: `"${sha}"`}}) : c.json({error: 'no blob'}, 404);
  });
}
