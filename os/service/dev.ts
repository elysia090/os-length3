// The Remote on this machine: PGlite (Postgres in-process) kept in a
// directory, blobs in files beside it. For development and the app's
// end-to-end checks; the same app as on Workers.
//
//   node service/dev.ts DIR [PORT] [APP_ORIGIN] [OTHER_ORIGIN…] [--no-bucket]
//
// --no-bucket (or LENGTH3_NO_BUCKET=1): a Remote that holds no files, as a
// Worker without its R2 binding is; every route that would move bytes says so.
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp} from './app.ts';
import {createAuth} from './auth.ts';
import {enterEmail} from './enter.ts';
import type {Bucket} from './bucket.ts';
import * as schema from './schema.ts';
import {sweep} from './sweep.ts';

const args = process.argv.slice(2);
const noBucket = args.includes('--no-bucket') || process.env.LENGTH3_NO_BUCKET === '1';
const [dir, port = '8790', appOrigin = 'http://localhost:4173', ...others] = args.filter((a) => a !== '--no-bucket');
if (!dir) { console.error('usage: dev.ts DIR [PORT] [APP_ORIGIN] [OTHER_ORIGIN…] [--no-bucket]'); process.exit(2); }
mkdirSync(noBucket ? dir : join(dir, 'blobs'), {recursive: true});

const file = (key: string) => join(dir, 'blobs', encodeURIComponent(key));
const bucket: Bucket | null = noBucket ? null : {
  async get(k) { return existsSync(file(k)) ? new Uint8Array(readFileSync(file(k))) : null; },
  async put(k, b) { writeFileSync(`${file(k)}.tmp`, b); renameSync(`${file(k)}.tmp`, file(k)); },
  async range(k, start, end) {
    if (!existsSync(file(k))) return null;
    const all = readFileSync(file(k));
    return {bytes: new Uint8Array(all.subarray(start, end === null ? undefined : end + 1)), size: all.length};
  },
  async delete(keys) { for (const k of keys) rmSync(file(k), {force: true}); },
};

const db = drizzle(new PGlite(join(dir, 'pg')), {schema});
await migrate(db, {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
// What was held long enough goes: now, and each day while it runs (on Workers, a Cron Trigger).
const swept = () => sweep(db, bucket).then((gone) => console.log(`sweep ${JSON.stringify(gone)}`), (e: unknown) => console.error('sweep', e));
await swept();
setInterval(() => void swept(), 86_400_000).unref();
const secretFile = join(dir, 'secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, crypto.randomUUID() + crypto.randomUUID(), {mode: 0o600});
// LENGTH3_DEV_BASE names it otherwise (http://localhost:PORT, where passkeys work: not on an IP address).
const baseURL = process.env.LENGTH3_DEV_BASE ?? `http://127.0.0.1:${port}`;
// Sign-in here is the stand-in provider (devoauth.ts): a name, and you are in.
const secret = readFileSync(secretFile, 'utf8');
// LENGTH3_ENTER_AS and LENGTH3_ENTER_KEY make it a Remote for research, as on Workers (enter.ts): no
// provider then, the link …/#enter=KEY the only way in.
const enter = process.env.LENGTH3_ENTER_AS ? {as: process.env.LENGTH3_ENTER_AS, key: process.env.LENGTH3_ENTER_KEY ?? ''} : undefined;
const auth = createAuth({db, secret, baseURL, appOrigin, origins: others, dev: !enter, only: enter && enterEmail(enter.as)});
const app = createApp({db, auth, bucket, origins: [appOrigin, ...others], appOrigin, providers: enter ? [] : ['dev'], domain: 'length3.test', baseURL, secret, enter});

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
}).listen(Number(port), '127.0.0.1', () => console.log(`remote on ${baseURL} for ${appOrigin} (${dir}${noBucket ? ', no bucket: files are not kept' : ''})`));
