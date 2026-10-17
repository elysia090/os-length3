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

import {and, eq, inArray, isNull, not, sql} from 'drizzle-orm';
import type {Context, Hono} from 'hono';
import type {Bucket} from './bucket.ts';
import {byCode, HOLD, live, liveAddress, serverAddress, shownAs, takeDown} from './names.ts';
import {body, qualified, refuse, rows, type Db, type Vars} from './request.ts';
import {address, cut, member, repo, repoPublic, repoShare, server} from './schema.ts';

export type Seen = 'private' | 'servers' | 'everyone';

type Public = {face: string; name: string; repo: string; serverId: string | null};

export interface SeenDeps {
  db: Db;
  bucket: Bucket;
  /** Who is asking, if they are signed in. */
  viewer: (req: Request) => Promise<string | null>;
  /** This Remote's own domain: a name written alone is on it. */
  domain: string;
}

const HEX = /^[0-9a-f]{64}$/;

export function seen(d: SeenDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;
  const main = (user: string, name: string) => and(eq(repo.userId, user), eq(repo.name, name), eq(repo.line, 'main'));
  /** `user`'s repo `name`, if it is there and on. */
  const isOn = async (q: Db, user: string, name: string) =>
    (await q.select({name: repo.name}).from(repo).where(and(main(user, name), isNull(repo.offAt))))[0] as {name: string} | undefined;
  /** Those of `ids` that are live servers `me` is in, with their names as principals. */
  const inServers = async (q: Db, me: string, ids: string[]) => (ids.length
    ? await q.select({id: server.id, address: serverAddress(qualified(server.id))}).from(member).innerJoin(server, eq(server.id, member.serverId))
      .where(and(eq(member.userId, me), inArray(member.serverId, ids), isNull(server.goneAt))) as {id: string; address: string}[]
    : []);
  const ofRepo = (user: string, name: string) => and(eq(repoPublic.userId, user), eq(repoPublic.repo, name));

  /** Who sees each of `user`'s repos `names`. */
  const states = async (q: Db, user: string, names: string[]) => {
    const shares = await q.select({repo: repoShare.repo, id: server.id, name: server.name, address: serverAddress(qualified(server.id))}).from(repoShare)
      .innerJoin(server, eq(server.id, repoShare.serverId)).where(and(eq(repoShare.userId, user), isNull(server.goneAt)))
      .orderBy(repoShare.sharedAt) as {repo: string; id: string; name: string; address: string}[];
    const faces = await q.select({face: repoPublic.face, name: repoPublic.name, repo: repoPublic.repo, serverId: repoPublic.serverId}).from(repoPublic)
      .where(and(eq(repoPublic.userId, user), isNull(repoPublic.releasedAt))) as Public[];
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
   * A server's face holds its names for whoever had them; a person's own
   * face holds nothing for someone who no longer has that address.
   */
  const claim = async (tx: Db, user: string, name: string, face: string, serverId: string | null): Promise<{ok: true} | {ok: false; until?: number}> => {
    const at = and(eq(repoPublic.face, face), eq(repoPublic.name, name));
    const [row] = await tx.select({userId: repoPublic.userId, releasedAt: repoPublic.releasedAt, held: sql<boolean>`(${qualified(repoPublic.serverId)} is not null
      or exists (select 1 from address a where a.address = ${qualified(repoPublic.face)} and a.user_id = ${qualified(repoPublic.userId)}))`}).from(repoPublic).where(at) as
      {userId: string; releasedAt: Date | null; held: boolean}[];
    if (row && row.userId !== user && row.held) {
      if (!row.releasedAt) return {ok: false};
      const until = row.releasedAt.getTime() + HOLD;
      if (until > Date.now()) return {ok: false, until};
    }
    // A repo is public as one name: any other it had is taken down.
    await takeDown(tx, and(ofRepo(user, name), not(at!)));
    const values = {userId: user, repo: name, serverId, releasedAt: null};
    if (row) await tx.update(repoPublic).set(values).where(at);
    else await tx.insert(repoPublic).values({face, name, ...values});
    return {ok: true};
  };

  v1.get('/seen', async (c) => {
    const me = c.get('userId');
    const list = await db.select({name: repo.name}).from(repo)
      .where(and(eq(repo.userId, me), eq(repo.line, 'main'), isNull(repo.offAt))).orderBy(repo.name) as {name: string}[];
    return c.json(await states(db, me, list.map((r) => r.name)));
  });

  // Who sees it is said all at once. Everyone: as a server it is in (by
  // default the first it is shown in), or as its owner ('me', by default when
  // it is in none). Anything else takes down its public face.
  v1.put('/repos/:name/seen', async (c) => {
    const me = c.get('userId'), name = c.req.param('name');
    const b = await body<{seen?: unknown; servers?: unknown; as?: unknown}>(c);
    const to = b?.seen;
    if (to !== 'private' && to !== 'servers' && to !== 'everyone') return c.json({error: 'private, servers or everyone'}, 400);
    let ids = Array.isArray(b?.servers) ? [...new Set((b.servers as unknown[]).filter((x): x is string => typeof x === 'string'))] : null;
    if (to === 'servers' && !ids?.length) return c.json({error: 'Choose a server'}, 400);
    return c.json(await db.transaction(async (tx: Db) => {
      if (!await isOn(tx, me, name)) refuse(404, {error: 'That repo is not on the Remote'});
      if (ids && (await inServers(tx, me, ids)).length !== ids.length) refuse(403, {error: 'Only servers you are in'});
      if (to === 'everyone') {
        const now = (await states(tx, me, [name]))[0];
        const as = typeof b?.as === 'string' ? b.as : now.asServer ?? (ids ?? now.servers.map((s) => s.id))[0] ?? 'me';
        let face: string | null, serverId: string | null = null;
        if (as === 'me') face = await liveAddress(tx, me);
        else {
          const [s] = await inServers(tx, me, [as]);
          if (!s) refuse(403, {error: 'Only servers you are in'});
          face = s.address || null;
          serverId = s.id;
          // Its face is that server's: it is shown there too.
          ids = [...new Set([...(ids ?? now.servers.map((x) => x.id)), s.id])];
        }
        if (!face) refuse(409, {error: 'Claim an address first'});
        const got = await claim(tx, me, name, face, serverId);
        if (!got.ok) refuse(409, got.until ? {error: 'That name was let go, and is held for its owner a while', as: `${face}:${name}`, until: got.until}
          : {error: 'That name is taken', as: `${face}:${name}`});
      } else await takeDown(tx, ofRepo(me, name));
      if (to === 'private' || ids) {
        await tx.delete(repoShare).where(and(eq(repoShare.userId, me), eq(repoShare.repo, name)));
        if (to !== 'private' && ids?.length) await tx.insert(repoShare).values(ids.map((serverId) => ({userId: me, repo: name, serverId})));
      }
      return (await states(tx, me, [name]))[0];
    }));
  });

  // ---- in a server, beside its people ----
  /** The repos shown in a server, whose, and as what everyone sees them, if they do: one read. */
  const shownIn = async (serverId: string, me: string) => {
    const list = await db.select({userId: repoShare.userId, name: repoShare.repo, owner: shownAs(qualified(repoShare.userId)), at: cut.time,
      face: repoPublic.face, faceName: repoPublic.name, asServer: repoPublic.serverId}).from(repoShare)
      .innerJoin(member, and(eq(member.serverId, repoShare.serverId), eq(member.userId, repoShare.userId)))
      .innerJoin(repo, and(eq(repo.userId, repoShare.userId), eq(repo.name, repoShare.repo), eq(repo.line, 'main'), isNull(repo.offAt)))
      .leftJoin(cut, and(eq(cut.userId, repo.userId), eq(cut.repo, repo.name), eq(cut.id, repo.pushed)))
      .leftJoin(repoPublic, and(eq(repoPublic.userId, repoShare.userId), eq(repoPublic.repo, repoShare.repo), isNull(repoPublic.releasedAt)))
      .where(eq(repoShare.serverId, serverId)).orderBy(repoShare.sharedAt) as
      {userId: string; name: string; owner: string | null; at: Date | null; face: string | null; faceName: string | null; asServer: string | null}[];
    return list.map((r) => ({owner: r.owner ?? '', name: r.name, at: r.at?.getTime() ?? null, mine: r.userId === me,
      as: r.face ? `${r.face}:${r.faceName}` : null, asServer: r.asServer}));
  };

  v1.get('/servers/:id/repos', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!(await inServers(db, me, [id])).length) return c.json({error: 'No such server of yours'}, 404);
    return c.json(await shownIn(id, me));
  });

  v1.post('/servers/:id/repos', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!(await inServers(db, me, [id])).length) return c.json({error: 'No such server of yours'}, 404);
    const name = (await body<{repo?: unknown}>(c))?.repo;
    const row = typeof name === 'string' ? await isOn(db, me, name) : undefined;
    if (!row) return c.json({error: 'That repo is not on the Remote'}, 404);
    await db.insert(repoShare).values({userId: me, repo: row.name, serverId: id}).onConflictDoNothing();
    return c.json(await shownIn(id, me), 201);
  });

  // Off a server's list: and if it was public as that server, that ends too.
  v1.delete('/servers/:id/repos/:owner/:name', async (c) => {
    const me = c.get('userId'), id = c.req.param('id'), name = c.req.param('name');
    const [r] = await rows<{owner: number; them: string | null}>(db, sql`select m.owner,
      (select t.user_id from server_member t where t.server_id = ${id} and t.user_id = (select a.user_id from address a where a.address = ${c.req.param('owner').toLowerCase()})) as them
      from server_member m join server s on s.id = m.server_id and s.gone_at is null where m.server_id = ${id} and m.user_id = ${me}`);
    if (!r) return c.json({error: 'No such server of yours'}, 404);
    if (!r.them) return c.json({error: 'They are not in this server'}, 404);
    if (r.them !== me && !r.owner) return c.json({error: 'Only its owner, or the server\'s, takes it off'}, 403);
    await db.transaction(async (tx: Db) => {
      await tx.delete(repoShare).where(and(eq(repoShare.userId, r.them!), eq(repoShare.repo, name), eq(repoShare.serverId, id)));
      await takeDown(tx, and(ofRepo(r.them!, name), eq(repoPublic.serverId, id)));
    });
    return c.body(null, 204);
  });

  // ---- seeing one: made before /v1's own routes, which ask who is calling ----
  /** A face as written: name@domain, a name alone (on this Remote), or a code (its owner's first name). */
  const faceOf = async (written: string): Promise<string | null> => {
    const q = written.toLowerCase();
    if (q.includes('@')) return q;
    const who = await byCode(db, q);
    if (!who) return /^\d{6}$/.test(q) ? null : `${q}@${d.domain}`;
    const [r] = await db.select({a: address.address}).from(address)
      .where(and('userId' in who ? eq(address.userId, who.userId) : eq(address.serverId, who.serverId), live)).orderBy(address.createdAt).limit(1) as {a: string}[];
    return r?.a ?? null;
  };
  type Found = {row: {userId: string; name: string; pushed: string | null}; as: string; owner?: string};
  const seenCols = {userId: repo.userId, name: repo.name, pushed: repo.pushed};
  /**
   * What `face:name` shows whoever asks: a public face that still answers
   * (its name still its owner's, and a server's with its owner still in it),
   * told without its owner; else, `face` being its owner, their repo if the
   * asker is them or in a server it is shown in (who is asking is looked up
   * only then).
   */
  const find = async (c: Context, written: string, name: string): Promise<Found | null> => {
    const face = await faceOf(written);
    if (!face) return null;
    const [p] = await db.select(seenCols).from(repoPublic)
      .innerJoin(address, and(eq(address.address, repoPublic.face), live,
        sql`(case when ${qualified(repoPublic.serverId)} is null then ${qualified(address.userId)} = ${qualified(repoPublic.userId)} else ${qualified(address.serverId)} = ${qualified(repoPublic.serverId)} end)`))
      .innerJoin(repo, and(eq(repo.userId, repoPublic.userId), eq(repo.name, repoPublic.repo), eq(repo.line, 'main'), isNull(repo.offAt)))
      .where(and(eq(repoPublic.face, face), eq(repoPublic.name, name), isNull(repoPublic.releasedAt),
        sql`(${qualified(repoPublic.serverId)} is null or exists (select 1 from server_member m join server s on s.id = m.server_id and s.gone_at is null
          where m.server_id = ${qualified(repoPublic.serverId)} and m.user_id = ${qualified(repoPublic.userId)}))`));
    if (p) return {row: p, as: `${face}:${name}`};
    const viewer = await d.viewer(c.req.raw);
    if (!viewer) return null;
    const [o] = await db.select(seenCols).from(address)
      .innerJoin(repo, and(eq(repo.userId, address.userId), eq(repo.name, name), eq(repo.line, 'main'), isNull(repo.offAt)))
      .where(and(eq(address.address, face), live, sql`(${qualified(address.userId)} = ${viewer} or exists (select 1 from repo_share sh
        join server s on s.id = sh.server_id and s.gone_at is null join server_member m on m.server_id = sh.server_id and m.user_id = ${viewer}
        where sh.user_id = ${qualified(address.userId)} and sh.repo = ${name}))`));
    return o ? {row: o, as: `${face}:${name}`, owner: face} : null;
  };
  const pushedAt = (row: Found['row']) => and(eq(cut.userId, row.userId), eq(cut.repo, row.name), eq(cut.id, row.pushed ?? ''));

  app.get('/v1/seen/:face/:name', async (c) => {
    const at = await find(c, c.req.param('face'), c.req.param('name'));
    if (!at) return c.json({error: 'No such repo to see'}, 404);
    const [p] = await db.select({tree: cut.tree, title: cut.title, time: cut.time}).from(cut).where(pushedAt(at.row)) as {tree: Record<string, string | null>; title: string; time: Date}[];
    return c.json({as: at.as, ...(at.owner ? {owner: at.owner} : {}), title: p?.title ?? null, at: p?.time.getTime() ?? null, tree: p?.tree ?? {}});
  });

  // Only what is in the tree it was pushed to: nothing else of its owner's (asked of the database, not by reading the tree here).
  app.get('/v1/seen/:face/:name/blobs/:sha', async (c) => {
    const sha = c.req.param('sha');
    const at = HEX.test(sha) ? await find(c, c.req.param('face'), c.req.param('name')) : null;
    const [inTree] = at ? await db.select({id: cut.id}).from(cut)
      .where(and(pushedAt(at.row), sql`exists (select 1 from jsonb_each_text(${qualified(cut.tree)}) e where e.value = ${sha})`)) : [];
    if (!at || !inTree) return c.json({error: 'No such file to see'}, 404);
    const bytes = await d.bucket.get(`u/${at.row.userId}/${sha}`);
    return bytes ? new Response(bytes as BodyInit, {headers: {'Content-Type': 'application/octet-stream', ETag: `"${sha}"`}}) : c.json({error: 'The Remote has no such file'}, 404);
  });
}
