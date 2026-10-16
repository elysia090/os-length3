// The Remote on this machine: PGlite (Postgres in-process) kept in a
// directory, blobs in files beside it. For development and the app's
// end-to-end checks; the same app as on Workers.
//
//   node service/dev.ts DIR [PORT] [APP_ORIGIN] [OTHER_ORIGIN…]
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp} from './app.ts';
import {createAuth} from './auth.ts';
import type {Bucket} from './bucket.ts';
import * as schema from './schema.ts';

const [dir, port = '8790', appOrigin = 'http://localhost:4173', ...others] = process.argv.slice(2);
if (!dir) { console.error('usage: dev.ts DIR [PORT] [APP_ORIGIN] [OTHER_ORIGIN…]'); process.exit(2); }
mkdirSync(join(dir, 'blobs'), {recursive: true});

const file = (key: string) => join(dir, 'blobs', encodeURIComponent(key));
const bucket: Bucket = {
  async get(k) { return existsSync(file(k)) ? new Uint8Array(readFileSync(file(k))) : null; },
  async put(k, b) { writeFileSync(`${file(k)}.tmp`, b); renameSync(`${file(k)}.tmp`, file(k)); },
  async has(k) { return existsSync(file(k)); },
  async range(k, start, end) {
    if (!existsSync(file(k))) return null;
    const all = readFileSync(file(k));
    return {bytes: new Uint8Array(all.subarray(start, end === null ? undefined : end + 1)), size: all.length};
  },
};

const db = drizzle(new PGlite(join(dir, 'pg')), {schema});
await migrate(db, {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
const secretFile = join(dir, 'secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, crypto.randomUUID() + crypto.randomUUID(), {mode: 0o600});
const baseURL = `http://127.0.0.1:${port}`;
// Sign-in here is the stand-in provider (devoauth.ts): a name, and you are in.
const auth = createAuth({db, secret: readFileSync(secretFile, 'utf8'), baseURL, appOrigin, origins: others, dev: true});
const app = createApp({db, auth, bucket, origins: [appOrigin, ...others], providers: ['dev']});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const r = await app.fetch(new Request(`${baseURL}${req.url}`, {
    method: req.method, headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method!) ? undefined : Buffer.concat(chunks),
  }));
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? r.headers.getSetCookie() : v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(port), '127.0.0.1', () => console.log(`remote on ${baseURL} for ${appOrigin} (${dir})`));
