// File contents: the one part of the Remote that moves bytes, kept in the
// bucket (bucket.ts, R2 on Workers) under their digests. Everything else the
// Remote keeps is rows in Postgres; a tree there names its files by these
// digests (repos.ts), and whether an account has one is a row (blob).
//
//   GET    /v1/os/:sha               a release bundle, to anyone, by digest (Range, HEAD)
//   POST   /v1/blobs/missing [sha]   which of these the account does not have yet (rows only)
//   PUT    /v1/blobs/:sha            bytes, refused unless they are that digest and fit in its room
//   GET    /v1/blobs/:sha
//
// An account holds its own work, up to its room: the Remote is no free store
// for anything else. A blob no tree names any more goes with the sweep.
//
// With no bucket, each route that moves bytes answers 503 NO_FILES, to
// anyone, before anything else; which digests are missing is rows, and is
// answered all the same.

import {and, eq, inArray} from 'drizzle-orm';
import type {Hono} from 'hono';
import {blobKey, noFiles, releaseKey, type Bucket} from './bucket.ts';
import {body, fits, HEX, LIMIT, lock, sha256, type Db, type Vars} from './request.ts';
import {blob} from './schema.ts';

export function files(d: {db: Db; bucket: Bucket | null; quota?: number}, v1: Hono<Vars>, app: Hono<Vars>) {
  const db = d.db;

  // The OS is public: its canonical copy is the release, named by its digest.
  app.on(['GET', 'HEAD'], '/v1/os/:sha', async (c) => {
    if (!d.bucket) return noFiles(c);
    const sha = c.req.param('sha');
    if (!HEX.test(sha)) return c.json({error: 'Not found'}, 404);
    const m = /^bytes=(\d+)-(\d*)$/.exec(c.req.header('Range') ?? '');
    const start = m ? Number(m[1]) : 0, end = m && m[2] ? Number(m[2]) : null;
    // A range that ends before it starts asks for nothing; HEAD asks only how much there is.
    const backwards = end !== null && end < start, head = c.req.method === 'HEAD';
    const o = await d.bucket.range(releaseKey(sha), backwards ? 0 : start, backwards ? 0 : head ? start : end);
    if (!o) return c.json({error: 'No such release'}, 404);
    if (backwards || (start >= o.size && o.size > 0)) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${o.size}`}});
    const length = head ? Math.min(end ?? o.size - 1, o.size - 1) - start + 1 : o.bytes.length;
    const headers: Record<string, string> = {'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: `"${sha}"`, 'Content-Length': String(length)};
    if (m) headers['Content-Range'] = `bytes ${start}-${start + length - 1}/${o.size}`;
    return new Response(head ? null : o.bytes as BodyInit, {status: m ? 206 : 200, headers});
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

  // Checked, stored and counted under the account's lock, so uploads at once cannot pass its room together.
  v1.put('/blobs/:sha', async (c) => {
    if (!d.bucket) return noFiles(c);
    const bucket = d.bucket;
    const sha = c.req.param('sha'), user = c.get('userId');
    if (!HEX.test(sha)) return c.json({error: 'Not found'}, 404);
    if (Number(c.req.header('Content-Length') ?? 0) > LIMIT.blob) return c.json({error: 'A file is at most 16 MB'}, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > LIMIT.blob) return c.json({error: 'A file is at most 16 MB'}, 413);
    if (await sha256(bytes) !== sha) return c.json({error: 'The bytes are not what their name says'}, 422);
    await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      if ((await tx.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, user), eq(blob.sha256, sha)))).length) return;
      await fits(tx, user, bytes.length, d.quota);
      await bucket.put(blobKey(user, sha), bytes);
      await tx.insert(blob).values({userId: user, sha256: sha, bytes: bytes.length});
    });
    return c.json({sha256: sha}, 201);
  });

  v1.get('/blobs/:sha', async (c) => {
    if (!d.bucket) return noFiles(c);
    const sha = c.req.param('sha');
    if (!HEX.test(sha)) return c.json({error: 'Not found'}, 404);
    const known = await db.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, c.get('userId')), eq(blob.sha256, sha)));
    const bytes = known.length ? await d.bucket.get(blobKey(c.get('userId'), sha)) : null;
    return bytes ? new Response(bytes as BodyInit, {headers: {'Content-Type': 'application/octet-stream', ETag: `"${sha}"`}}) : c.json({error: 'The Remote has no such file'}, 404);
  });
}
