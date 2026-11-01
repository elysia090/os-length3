// File contents: the one part of the Remote that moves bytes, kept in the
// bucket (bucket.ts, R2 on Workers) under their digests. Everything else the
// Remote keeps is rows in Postgres; a tree there names its files by these
// digests (repos.ts), and whether an account has one is a row (blob).
//
//   GET    /v1/os/:sha               a release's root, to anyone, by digest (Range, HEAD)
//   GET    /v1/desktop/:file         the desktop app (.deb, AppImage), to anyone, by its pinned file's name (Range, HEAD)
//   POST   /v1/blobs/missing [sha]   which of these the account does not have yet (rows only)
//   PUT    /v1/blobs/:sha            bytes, refused unless they are that digest and fit in its room
//   GET    /v1/blobs/:sha
//   POST   /v1/blobs/read [sha]      several at once (base64 by digest), so a diff of many files is one wait
//
// An account holds its own work, up to its room: the Remote is no free store
// for anything else. A blob no tree names any more goes with the sweep.
//
// With no bucket, each route that moves bytes answers 503 NO_FILES, to
// anyone, before anything else; which digests are missing is rows, and is
// answered all the same. With a budget (budget.ts), R2 is asked nothing past
// what it may do this month, an upload is counted against what R2 may hold
// and what the account may send today, and a release's file is handed out
// from the edge's cache once it is there: R2 is read once per place, not
// once per download.

import {and, eq, inArray} from 'drizzle-orm';
import type {Context, Hono} from 'hono';
import type {Budget} from './budget.ts';
import {blobKey, noFiles, type Bucket} from './bucket.ts';
import {desktopFile, rootKey} from './releases.ts';
import {body, fits, HEX, LIMIT, lock, sha256, unchanged, type Db, type Vars} from './request.ts';
import {blob, releaseFile} from './schema.ts';

/** Bytes as base64, a piece at a time. */
function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What never changes under its name. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A cache in front of R2 (on Workers, the edge's: caches.default), which answers a Range request from what it holds whole. */
export interface Edge {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * One file of a release from the edge's cache, which answers the range asked for and HEAD from what it holds
 * whole; null when it holds nothing for it (the caller answers from R2, and puts the whole there for next time).
 */
async function fromEdge(c: Context<Vars>, edge: Edge, whole: Request): Promise<Response | null> {
  const range = c.req.header('Range');
  const hit = await edge.match(new Request(whole.url, {headers: range ? {Range: range} : {}})).catch(() => undefined);
  if (!hit) return null;
  return c.req.method === 'HEAD' ? new Response(null, {status: hit.status, headers: hit.headers}) : hit;
}

/**
 * One file of a release, whole or the one range asked for (bytes=a-b, bytes=a-), streamed from the bucket. With
 * the edge's cache, the cache answers once it has it; a GET it lacks is read whole from R2 once and put there
 * (one entry per file and pinned digest, so a file pinned anew under the same name is another entry, never the
 * old bytes), and answered from it; a HEAD, or a cache that takes nothing, is answered from R2 by range alone.
 */
async function release(c: Context<Vars>, bucket: Bucket, key: string, o: {type: string; etag: string; name?: string}, edge?: Edge,
  known: () => Promise<boolean> = async () => true) {
  const fixed: Record<string, string> = {'Content-Type': o.type, 'Accept-Ranges': 'bytes', ETag: `"${o.etag}"`, 'Cache-Control': IMMUTABLE};
  if (o.name) fixed['Content-Disposition'] = `attachment; filename="${o.name}"`;
  const whole = new Request(`https://release.cache/${key}?sha256=${o.etag}`);
  // Had already (a client that kept it asks by its digest): nothing is looked up, nor read.
  if (unchanged(c, `"${o.etag}"`)) return new Response(null, {status: 304, headers: fixed});
  if (edge) {
    const hit = await fromEdge(c, edge, whole);
    if (hit) return hit;
  }
  // Not in the cache: only what the deploy recorded is asked of R2.
  if (!await known()) return c.json({error: 'Release not found'}, 404);
  const m = /^bytes=(\d+)-(\d*)$/.exec(c.req.header('Range') ?? '');
  const size = await bucket.size(key);
  if (size === null) return c.json({error: 'Release not found'}, 404);
  if (edge && c.req.method === 'GET' && size > 0) {
    const body = await bucket.read(key, 0, size - 1);
    if (!body) return c.json({error: 'Release not found'}, 404);
    const kept = await edge.put(whole, new Response(body as BodyInit, {headers: {...fixed, 'Content-Length': String(size)}})).then(() => true, () => false);
    const hit = kept ? await fromEdge(c, edge, whole) : null;
    if (hit) return hit;
  }
  const start = m ? Number(m[1]) : 0, asked = m && m[2] ? Number(m[2]) : null;
  // A range that ends before it starts, or starts past the end, asks for nothing there is.
  if (m && ((asked !== null && asked < start) || start >= size)) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
  const end = Math.min(asked ?? size - 1, size - 1), length = Math.max(0, end - start + 1);
  // Named by its digest or its pinned name, it never changes: kept by any cache for a year, asked again by none.
  const headers: Record<string, string> = {...fixed, 'Content-Length': String(length)};
  if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  // HEAD asks only how much there is; an empty file has nothing to read.
  const body = c.req.method === 'HEAD' || !length ? null : await bucket.read(key, start, end);
  if (length && c.req.method !== 'HEAD' && !body) return c.json({error: 'Release not found'}, 404);
  return new Response(body as BodyInit | null, {status: m ? 206 : 200, headers});
}

export function files(d: {db: Db; bucket: Bucket | null; quota?: number; budget?: Budget | null; edge?: Edge;
  /** The bucket uncounted, for reads the route counted itself, all at once (blobs/read). */
  raw?: Bucket | null}, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;
  /**
   * With a budget, a release file is handed out only once the deploy recorded it (release_file): a digest or a
   * name it never put is 404 without R2 being asked, so nobody can spend R2's reads asking for what is not there.
   */
  const recorded = async (key: string) =>
    !d.budget || (await db.select({key: releaseFile.key}).from(releaseFile).where(eq(releaseFile.key, key))).length > 0;

  // The OS is public: its canonical copy is the release, a root named by its digest and the desktop
  // app by its file's name, as this tree pins them (releases.ts); the deploy puts them here (mirror.ts).
  // There is no listing: a path names one file or nothing.
  app.on(['GET', 'HEAD'], '/v1/os/:sha', async (c) => {
    if (!d.bucket) return noFiles(c);
    const sha = c.req.param('sha');
    if (!HEX.test(sha)) return c.json({error: 'Release not found'}, 404);
    return release(c, d.bucket, rootKey(sha), {type: 'application/octet-stream', etag: sha}, d.edge, () => recorded(rootKey(sha)));
  });
  app.on(['GET', 'HEAD'], '/v1/desktop/:file', async (c) => {
    if (!d.bucket) return noFiles(c);
    const p = desktopFile(c.req.param('file'));
    if (!p) return c.json({error: 'Release not found'}, 404);
    return release(c, d.bucket, p.key, {type: p.type, etag: p.sha256, name: p.file}, d.edge, () => recorded(p.key));
  });

  v1.post('/blobs/missing', async (c) => {
    const list = await body<unknown[]>(c);
    if (!Array.isArray(list) || list.length > LIMIT.diff || !list.every((s) => typeof s === 'string' && HEX.test(s))) return c.json({error: 'a list of digests'}, 400);
    const wanted = [...new Set(list as string[])];
    if (!wanted.length) return c.json([]);
    const have = await db.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, c.get('userId')), inArray(blob.sha256, wanted)));
    const got = new Set(have.map((r: {sha: string}) => r.sha));
    return c.json(wanted.filter((s) => !got.has(s)));
  });

  // Put in R2 first, outside the account's lock (its name is its digest, so a put is never partial or another's),
  // then checked and counted under the lock with the row that names it: uploads at once cannot pass the account's
  // room, nor R2's, together. Refused there, the bytes go again unless a row names them by then.
  v1.put('/blobs/:sha', async (c) => {
    if (!d.bucket) return noFiles(c);
    const bucket = d.bucket;
    const sha = c.req.param('sha'), user = c.get('userId');
    if (!HEX.test(sha)) return c.json({error: 'Not found'}, 404);
    const declared = Number(c.req.header('Content-Length') ?? NaN);
    if (declared > LIMIT.blob) return c.json({error: 'File size cannot exceed 16 MB'}, 413);
    const named = async (q: Db) => (await q.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, user), eq(blob.sha256, sha)))).length > 0;
    // Had already: nothing is read, nor put (it is named by its digest, and the row says it is here).
    if (await named(db)) return c.json({sha256: sha}, 201);
    // What it says it is, asked before its bytes are read at all: a refusal costs no upload read and hashed.
    if (declared > 0) {
      await fits(db, user, declared, d.quota);
      await d.budget?.ahead(db, user, declared);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > LIMIT.blob) return c.json({error: 'File size cannot exceed 16 MB'}, 413);
    if (await sha256(bytes) !== sha) return c.json({error: 'File content does not match extension'}, 422);
    // Nothing is put that the account may not keep at all (counted again under the lock); as it is, not as it said.
    if (bytes.length !== declared) {
      await fits(db, user, bytes.length, d.quota);
      await d.budget?.ahead(db, user, bytes.length);
    }
    await d.budget?.write(db);
    const key = blobKey(user, sha);
    await bucket.put(key, bytes);
    try {
      await db.transaction(async (tx: Db) => {
        await lock(tx, user);
        if (await named(tx)) return;
        await fits(tx, user, bytes.length, d.quota);
        await d.budget?.upload(tx, user, bytes.length);
        await tx.insert(blob).values({userId: user, sha256: sha, bytes: bytes.length});
        await d.budget?.held(tx, bytes.length);
      });
    } catch (e) {
      // Refused after all (uploads at once): the bytes go, under the lock, unless a row names them by then.
      await db.transaction(async (tx: Db) => {
        await lock(tx, user);
        if (!await named(tx)) await bucket.delete([key]);
      }).catch(() => {});
      throw e;
    }
    // The bytes may have gone between the put and the row (the sweep, or another upload refused, lets a key go that
    // no row names, under the same lock): once the row is in nothing lets them go, so they are asked for now, and
    // put again if they went. Before, the row said the file was kept and every read of it was 404 for good. Asked
    // of R2 uncounted: one head an upload, within what its put (counted) allows, and never refused for the month's reads.
    if (await (d.raw ?? bucket).size(key) === null) {
      await d.budget?.write(db);
      await bucket.put(key, bytes);
    }
    return c.json({sha256: sha}, 201);
  });

  // Up to 64 at once, and as many as fit in 8 MB: what is left out the client reads by itself (GET).
  v1.post('/blobs/read', async (c) => {
    if (!d.bucket) return noFiles(c);
    const bucket = d.bucket, user = c.get('userId');
    const list = await body<unknown[]>(c);
    if (!Array.isArray(list) || list.length > 64 || !list.every((s) => typeof s === 'string' && HEX.test(s))) return c.json({error: 'at most 64 digests'}, 400);
    const wanted = [...new Set(list as string[])];
    const known = wanted.length ? await db.select({sha: blob.sha256, bytes: blob.bytes}).from(blob).where(and(eq(blob.userId, user), inArray(blob.sha256, wanted))) : [];
    // As many as fit, in the order asked: one too large is left out, not every one after it.
    let room = 8 << 20;
    const take = known.filter((r: {bytes: number}) => r.bytes <= room && (room -= r.bytes, true));
    // Counted once for all of them, then read from R2 uncounted.
    const from = d.raw && d.budget ? (await d.budget.read(db, take.length), d.raw) : bucket;
    const got = take.length ? await Promise.all(take.map(async (r: {sha: string}) => [r.sha, await from.get(blobKey(user, r.sha))] as const)) : [];
    return c.json(Object.fromEntries(got.filter(([, b]) => b).map(([sha, b]) => [sha, base64(b!)])));
  });

  v1.get('/blobs/:sha', async (c) => {
    if (!d.bucket) return noFiles(c);
    const sha = c.req.param('sha');
    if (!HEX.test(sha)) return c.json({error: 'Not found'}, 404);
    // Asked again by one who has it (its name is its digest): nothing changed, and nothing is read.
    if (unchanged(c, `"${sha}"`)) return new Response(null, {status: 304, headers: {ETag: `"${sha}"`, 'Cache-Control': 'private, max-age=31536000, immutable'}});
    const [known] = await db.select({bytes: blob.bytes}).from(blob).where(and(eq(blob.userId, c.get('userId')), eq(blob.sha256, sha))) as {bytes: number}[];
    // Its name is its digest: this browser keeps it (it is the account's: no shared cache does).
    const headers = {'Content-Type': 'application/octet-stream', ETag: `"${sha}"`, 'Cache-Control': 'private, max-age=31536000, immutable'};
    if (!known) return c.json({error: 'File not found on Remote'}, 404);
    // HEAD is answered from the row: R2 is not asked.
    if (c.req.method === 'HEAD') return new Response(null, {headers: {...headers, 'Content-Length': String(known.bytes)}});
    const bytes = await d.bucket.get(blobKey(c.get('userId'), sha));
    return bytes ? new Response(bytes as BodyInit, {headers}) : c.json({error: 'File not found on Remote'}, 404);
  });
}
