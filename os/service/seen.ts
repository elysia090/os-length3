// Who sees a repo (schema.ts, repoShare and repoPublic): only its owner, the
// servers it is shown in, or everyone. Anyone but its owner only sees it,
// never writes in it, and what they see is what it was last pushed to (the
// commit others may see), its files read one at a time by their paths.
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
//   GET    /v1/seen/FACE/NAME/file?path=P    a file in that tree, by its path

import {and, eq, inArray, isNull, not, sql} from 'drizzle-orm';
import type {Context, Hono} from 'hono';
import {blobKey, noFiles, type Bucket} from './bucket.ts';
import {byCode, HOLD, live, nameFor, serverAddress, shownAs, takeDown} from './names.ts';
import {addressOf, body, lock, qualified, refuse, rows, throttled, unchanged, type Db, type Vars} from './request.ts';
import type {Edge} from './files.ts';
import {address, blob, cut, line, member, repo, repoPublic, repoShare, server} from './schema.ts';

/** Codes one address may resolve to a face in an hour, as Inbox lets an account look them up (inbox.ts INBOX.codesPerHour). */
const CODES_PER_HOUR = 30;

export type Seen = 'private' | 'servers' | 'everyone';

type Public = {face: string; name: string; repo: string; serverId: string | null};

interface SeenDeps {
  db: Db;
  /** Where file contents are kept; none, and a file is not to be seen (bucket.ts). */
  bucket: Bucket | null;
  /** Who is asking, if they are signed in. */
  viewer: (req: Request) => Promise<string | null>;
  /** This Remote's own domain: a name written alone is on it. */
  domain: string;
  /** Nothing is shown to everyone (a Remote for research: enter.ts). */
  closed?: boolean;
  /** A cache in front of R2 (files.ts Edge): a file read by many is read from R2 once where it is asked. */
  edge?: Edge;
}

/** A repo that is on: its number and name. */
type On = {id: number; name: string};

export function seen(d: SeenDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;
  /** `user`'s repo `name`, if it is there and on. */
  const isOn = async (q: Db, user: string, name: string) =>
    (await q.select({id: repo.id, name: repo.name}).from(repo).where(and(eq(repo.userId, user), eq(repo.name, name), isNull(repo.offAt))))[0] as On | undefined;
  /** Those of `ids` that are live servers `me` is in, with their names as principals. */
  const inServers = async (q: Db, me: string, ids: string[]) => (ids.length
    ? await q.select({id: server.id, address: serverAddress(qualified(server.id))}).from(member).innerJoin(server, eq(server.id, member.serverId))
      .where(and(eq(member.userId, me), inArray(member.serverId, ids), isNull(server.goneAt))) as {id: string; address: string}[]
    : []);

  /** Who sees each of `user`'s repos `names`. */
  const states = async (q: Db, user: string, names: string[]) => {
    const shares = await q.select({repo: repo.name, id: server.id, name: server.name, address: serverAddress(qualified(server.id))}).from(repoShare)
      .innerJoin(repo, eq(repo.id, repoShare.repoId)).innerJoin(server, eq(server.id, repoShare.serverId))
      .where(and(eq(repoShare.userId, user), isNull(server.goneAt))).orderBy(repoShare.sharedAt) as {repo: string; id: string; name: string; address: string}[];
    const faces = await q.select({face: repoPublic.face, name: repoPublic.name, repo: repo.name, serverId: repoPublic.serverId}).from(repoPublic)
      .innerJoin(repo, eq(repo.id, repoPublic.repoId)).where(and(eq(repoPublic.userId, user), isNull(repoPublic.releasedAt))) as Public[];
    return names.map((name) => {
      const servers = shares.filter((s) => s.repo === name).map(({id, name, address}) => ({id, name, address}));
      const f = faces.find((x) => x.repo === name);
      return {name, seen: (f ? 'everyone' : servers.length ? 'servers' : 'private') as Seen, servers,
        as: f ? `${f.face}:${f.name}` : null, asServer: f?.serverId ?? null};
    });
  };

  /**
   * Make `user`'s repo `r` public as `face:name`: free, theirs already (or
   * held for them), or not (another's, or held for another until `until`).
   * A server's face holds its names for whoever had them; a person's own
   * face holds nothing for someone who no longer has that address.
   */
  const claim = async (tx: Db, user: string, r: On, face: string, serverId: string | null): Promise<{ok: true} | {ok: false; until?: number}> => {
    const at = and(eq(repoPublic.face, face), eq(repoPublic.name, r.name));
    const [row] = await tx.select({userId: repoPublic.userId, releasedAt: repoPublic.releasedAt, held: sql<boolean>`(${qualified(repoPublic.serverId)} is not null
      or exists (select 1 from address a where a.address = ${qualified(repoPublic.face)} and a.user_id = ${qualified(repoPublic.userId)}))`}).from(repoPublic).where(at) as
      {userId: string; releasedAt: Date | null; held: boolean}[];
    if (row && row.userId !== user && row.held) {
      if (!row.releasedAt) return {ok: false};
      const until = row.releasedAt.getTime() + HOLD;
      if (until > Date.now()) return {ok: false, until};
    }
    // A repo is public as one name: any other it had is taken down first.
    await takeDown(tx, and(eq(repoPublic.repoId, r.id), not(at!)));
    const values = {repoId: r.id, userId: user, serverId, releasedAt: null};
    if (row) await tx.update(repoPublic).set(values).where(at);
    else await tx.insert(repoPublic).values({face, name: r.name, ...values});
    return {ok: true};
  };

  // Each repo that is on, the servers it is shown in (as `states` says them) and its face, in one read: three before,
  // each its own round trip, and Remote and Home ask it each time they are shown.
  v1.get('/seen', async (c) => {
    const me = c.get('userId');
    const list = await rows<{name: string; servers: {id: string; name: string; address: string}[]; face: string | null; face_name: string | null; as_server: string | null}>(db, sql`
      select r.name, coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name, 'address', ${serverAddress(sql`s.id`)}) order by k.shared_at)
          from repo_share k join server s on s.id = k.server_id and s.gone_at is null where k.repo_id = r.id), '[]') as servers,
        p.face, p.name as face_name, p.server_id as as_server
      from repo r left join repo_public p on p.repo_id = r.id and p.released_at is null
      where r.user_id = ${me} and r.off_at is null order by r.name`);
    return c.json(list.map((r) => ({name: r.name, seen: (r.face ? 'everyone' : r.servers.length ? 'servers' : 'private') as Seen, servers: r.servers,
      as: r.face ? `${r.face}:${r.face_name}` : null, asServer: r.face ? r.as_server : null})));
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
    if (to === 'servers' && !ids?.length) return c.json({error: 'Select server'}, 400);
    if (to === 'everyone' && d.closed) return c.json({error: 'Public sharing disabled on this Remote'}, 403);
    return c.json(await db.transaction(async (tx: Db) => {
      // One at a time for the account (a double click, two tabs): both took down, then both put in, and the second was a 500.
      await lock(tx, `seen:${me}`);
      const r = await isOn(tx, me, name);
      if (!r) refuse(404, {error: 'Repo not found on Remote'});
      if (ids && (await inServers(tx, me, ids)).length !== ids.length) refuse(403, {error: 'Servers you belong to only'});
      if (to === 'everyone') {
        const now = (await states(tx, me, [name]))[0];
        const as = typeof b?.as === 'string' ? b.as : now.asServer ?? (ids ?? now.servers.map((s) => s.id))[0] ?? 'me';
        let face: string | null, serverId: string | null = null;
        if (as === 'me') face = await nameFor(tx, me, d.domain);
        else {
          const [s] = await inServers(tx, me, [as]);
          if (!s) refuse(403, {error: 'Servers you belong to only'});
          face = s.address || null;
          serverId = s.id;
          // Its face is that server's: it is shown there too.
          ids = [...new Set([...(ids ?? now.servers.map((x) => x.id)), s.id])];
        }
        if (!face) refuse(409, {error: 'Server has no assigned name'});
        const got = await claim(tx, me, r, face, serverId);
        if (!got.ok) refuse(409, got.until ? {error: 'Name recently released; temporarily reserved for prior owner.', as: `${face}:${name}`, until: got.until}
          : {error: 'Username already taken', as: `${face}:${name}`});
      } else await takeDown(tx, eq(repoPublic.repoId, r.id));
      if (to === 'private' || ids) {
        await tx.delete(repoShare).where(eq(repoShare.repoId, r.id));
        if (to !== 'private' && ids?.length) await tx.insert(repoShare).values(ids.map((serverId) => ({repoId: r.id, serverId, userId: me})));
      }
      return (await states(tx, me, [name]))[0];
    }));
  });

  // ---- in a server, beside its people ----
  /** The repos shown in a server, whose, when last pushed, and as what everyone sees them, if they do: one read. */
  const shownIn = async (serverId: string, me: string) => {
    const list = await db.select({userId: repoShare.userId, name: repo.name, owner: shownAs(qualified(repoShare.userId)), at: cut.time,
      face: repoPublic.face, faceName: repoPublic.name, asServer: repoPublic.serverId}).from(repoShare)
      .innerJoin(repo, and(eq(repo.id, repoShare.repoId), isNull(repo.offAt)))
      .innerJoin(line, and(eq(line.repoId, repo.id), eq(line.name, 'main')))
      .leftJoin(cut, and(eq(cut.repoId, repo.id), eq(cut.id, line.pushed)))
      .leftJoin(repoPublic, and(eq(repoPublic.repoId, repo.id), isNull(repoPublic.releasedAt)))
      .where(eq(repoShare.serverId, serverId)).orderBy(repoShare.sharedAt) as
      {userId: string; name: string; owner: string | null; at: Date | null; face: string | null; faceName: string | null; asServer: string | null}[];
    return list.map((r) => ({owner: r.owner ?? '', ownerId: `id:${r.userId}`, name: r.name, at: r.at?.getTime() ?? null, mine: r.userId === me,
      as: r.face ? `${r.face}:${r.faceName}` : null, asServer: r.asServer}));
  };

  v1.get('/servers/:id/repos', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!(await inServers(db, me, [id])).length) return c.json({error: 'Server not found in your account'}, 404);
    return c.json(await shownIn(id, me));
  });

  v1.post('/servers/:id/repos', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    if (!(await inServers(db, me, [id])).length) return c.json({error: 'Server not found in your account'}, 404);
    const name = (await body<{repo?: unknown}>(c))?.repo;
    const r = typeof name === 'string' ? await isOn(db, me, name) : undefined;
    if (!r) return c.json({error: 'Repo not found on Remote'}, 404);
    await db.insert(repoShare).values({repoId: r.id, serverId: id, userId: me}).onConflictDoNothing();
    return c.json(await shownIn(id, me), 201);
  });

  // Off a server's list: and if it was public as that server, that ends too.
  v1.delete('/servers/:id/repos/:owner/:name', async (c) => {
    const me = c.get('userId'), id = c.req.param('id');
    const [r] = await rows<{owner: boolean; repo: number | null; them: string | null}>(db, sql`select m.owner, t.user_id as them, r.id as repo
      from server_member m join server s on s.id = m.server_id and s.gone_at is null
      left join server_member t on t.server_id = m.server_id and t.user_id = ${c.req.param('owner').startsWith('id:') ? sql`${c.req.param('owner').slice(3)}`
        : sql`(select a.user_id from address a where a.address = ${c.req.param('owner').toLowerCase()})`}
      left join repo r on r.user_id = t.user_id and r.name = ${c.req.param('name')}
      where m.server_id = ${id} and m.user_id = ${me}`);
    if (!r) return c.json({error: 'Server not found in your account'}, 404);
    if (!r.them) return c.json({error: 'User is not a member of this server'}, 404);
    if (r.them !== me && !r.owner) return c.json({error: 'Only repo owner or server owner can unpublish'}, 403);
    if (r.repo !== null) {
      const repoId = r.repo;
      await db.transaction(async (tx: Db) => {
        await tx.delete(repoShare).where(and(eq(repoShare.repoId, repoId), eq(repoShare.serverId, id)));
        await takeDown(tx, and(eq(repoPublic.repoId, repoId), eq(repoPublic.serverId, id)));
      });
    }
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
  /** A repo found to be seen: whose, its number, and the commit it was last pushed to. */
  type Found = {row: {userId: string; repoId: number; pushed: string | null}; as: string; owner?: string};
  const seenCols = {userId: repo.userId, repoId: repo.id, pushed: line.pushed};
  /**
   * What `face:name` shows whoever asks: a public face that still answers
   * (its name still its owner's, and a server's with its owner still in it),
   * told without its owner; else, `face` being its owner, their repo if the
   * asker is them or in a server it is shown in (who is asking is looked up
   * only then).
   */
  const find = async (c: Context, written: string, name: string): Promise<Found | null> => {
    // A code is a short number: resolving one, signed out, is counted by address as looking one up in
    // Inbox is by account (inbox.ts codeAsked), so codes are not read off for addresses by trying them
    // all (audit N1; ASVS 2.2.1, 11.1.4). The app itself asks by address, never by code.
    const from = addressOf(c);
    if (from && /^\d{6}$/.test(written)) await throttled(db, `seen-code:${from}`, CODES_PER_HOUR, 3600_000, {error: 'Too many lookups from this client; retry later'});
    const face = await faceOf(written);
    if (!face) return null;
    const [p] = await db.select(seenCols).from(repoPublic)
      .innerJoin(address, and(eq(address.address, repoPublic.face), live,
        sql`(case when ${qualified(repoPublic.serverId)} is null then ${qualified(address.userId)} = ${qualified(repoPublic.userId)} else ${qualified(address.serverId)} = ${qualified(repoPublic.serverId)} end)`))
      .innerJoin(repo, and(eq(repo.id, repoPublic.repoId), isNull(repo.offAt)))
      .innerJoin(line, and(eq(line.repoId, repo.id), eq(line.name, 'main')))
      .where(and(eq(repoPublic.face, face), eq(repoPublic.name, name), isNull(repoPublic.releasedAt),
        sql`(${qualified(repoPublic.serverId)} is null or exists (select 1 from server_member m join server s on s.id = m.server_id and s.gone_at is null
          where m.server_id = ${qualified(repoPublic.serverId)} and m.user_id = ${qualified(repoPublic.userId)}))`));
    if (p) return {row: p, as: `${face}:${name}`};
    const viewer = await d.viewer(c.req.raw);
    if (!viewer) return null;
    const [o] = await db.select(seenCols).from(address)
      .innerJoin(repo, and(eq(repo.userId, address.userId), eq(repo.name, name), isNull(repo.offAt)))
      .innerJoin(line, and(eq(line.repoId, repo.id), eq(line.name, 'main')))
      .where(and(eq(address.address, face), live, sql`(${qualified(address.userId)} = ${viewer} or exists (select 1 from repo_share sh
        join server s on s.id = sh.server_id and s.gone_at is null join server_member m on m.server_id = sh.server_id and m.user_id = ${viewer}
        where sh.repo_id = ${qualified(repo.id)}))`));
    return o ? {row: o, as: `${face}:${name}`, owner: face} : null;
  };
  const pushedAt = (row: Found['row']) => and(eq(cut.repoId, row.repoId), eq(cut.id, row.pushed ?? ''));

  app.get('/v1/seen/:face/:name', async (c) => {
    const at = await find(c, c.req.param('face'), c.req.param('name'));
    if (!at) return c.json({error: 'Repo inaccessible or not found'}, 404);
    const [p] = await db.select({tree: cut.tree, title: cut.title, time: cut.time}).from(cut).where(pushedAt(at.row)) as {tree: Record<string, string | null>; title: string; time: Date}[];
    return c.json({as: at.as, ...(at.owner ? {owner: at.owner} : {}), title: p?.title ?? null, at: p?.time.getTime() ?? null, tree: p?.tree ?? {}});
  });

  // A file by its path in the tree it was pushed to: one lookup of that path, so nothing else of
  // its owner's can be asked for, and reading a large repo file by file costs each file once.
  app.get('/v1/seen/:face/:name/file', async (c) => {
    if (!d.bucket) return noFiles(c);
    const bucket = d.bucket;
    const path = c.req.query('path') ?? '';
    const at = path && path.length <= 1024 ? await find(c, c.req.param('face'), c.req.param('name')) : null;
    const [f] = at ? await db.select({sha: sql<string | null>`${cut.tree} ->> ${path}`}).from(cut).where(pushedAt(at.row)) as {sha: string | null}[] : [];
    if (!at || !f?.sha) return c.json({error: 'File inaccessible or not found'}, 404);
    // What is at a path changes with a push: kept by the browser, and asked again each time by its digest, which
    // answers 304 without R2 when it is the same; HEAD is answered from the blob's row.
    const headers = {'Content-Type': 'application/octet-stream', ETag: `"${f.sha}"`, 'Cache-Control': 'private, no-cache'};
    if (unchanged(c, `"${f.sha}"`)) return new Response(null, {status: 304, headers});
    if (c.req.method === 'HEAD') {
      const [b] = await db.select({bytes: blob.bytes}).from(blob).where(and(eq(blob.userId, at.row.userId), eq(blob.sha256, f.sha))) as {bytes: number}[];
      return b ? new Response(null, {headers: {...headers, 'Content-Length': String(b.bytes)}}) : c.json({error: 'File not found on Remote'}, 404);
    }
    // Who may see it was asked above, every time; its bytes are the same for all who may, by owner and digest, so the
    // edge keeps them: a public repo read by many costs R2 (and the month's read budget all accounts share) once a place.
    const whole = new Request(`https://seen.cache/${at.row.userId}/${f.sha}`);
    const hit = d.edge ? await d.edge.match(whole).catch(() => undefined) : undefined;
    if (hit?.ok) return new Response(hit.body, {headers});
    const bytes = await bucket.get(blobKey(at.row.userId, f.sha));
    if (!bytes) return c.json({error: 'File not found on Remote'}, 404);
    if (d.edge) await d.edge.put(whole, new Response(bytes.slice() as BodyInit, {headers: {'Cache-Control': 'public, max-age=31536000, immutable'}})).catch(() => {});
    return new Response(bytes as BodyInit, {headers});
  });
}
