// The Remote on this machine: PGlite (Postgres in-process) kept in a
// directory, blobs in files beside it. For development and the app's
// end-to-end checks; the same app as on Workers.
//
//   node service/dev.ts DIR [PORT] [APP_ORIGIN] [OTHER_ORIGIN…] [--no-bucket]
//
// --no-bucket (or LENGTH3_NO_BUCKET=1): a Remote that holds no files, as a
// Worker without its R2 binding is; every route that would move bytes says so.
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp} from './app.ts';
import {createAuth} from './auth.ts';
import {devBilling} from './devbilling.ts';
import {enterEmail} from './enter.ts';
import {memoryMarks} from './mark.ts';
import {planConfig} from './plan.ts';
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
  async size(k) { return existsSync(file(k)) ? statSync(file(k)).size : null; },
  async read(k, start, end) { return existsSync(file(k)) ? new Uint8Array(readFileSync(file(k)).subarray(start, end + 1)) : null; },
  async delete(keys) { for (const k of keys) rmSync(file(k), {force: true}); },
};

const db = drizzle(new PGlite(join(dir, 'pg')), {schema});
await migrate(db, {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
// The mark (mark.ts), in this process: looks answered without the database while nothing was written, as on Workers.
const marks = memoryMarks();
// What was held long enough goes: a moment after it listens, and each day while it runs (on Workers, a Cron Trigger,
// beside the requests); the mark moves after. Not before it listens, nor as it does: the sweep's statements, a
// transaction each, hold PGlite half a second and more even when nothing goes, and the first request waited behind
// them (in every start, each selftest's two Remotes' among them).
const swept = () => sweep(db, bucket).then(async (gone) => { console.log(`sweep ${JSON.stringify(gone)}`); await marks.move(); }, (e: unknown) => console.error('sweep', e));
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
const auth = createAuth({db, secret, baseURL, appOrigin, origins: others, dev: !enter, only: enter && enterEmail(enter.as), domain: 'length3.test'});
// LENGTH3_PLAN=1 gives it the plan the Remote on Workers has (LENGTH3_FREE_REPOS, LENGTH3_FREE_MB to say it
// otherwise), bought from a stand-in for Stripe (devbilling.ts); without it, no plan: everything is open.
const plan = process.env.LENGTH3_PLAN === '1' ? planConfig({FREE_REPOS: process.env.LENGTH3_FREE_REPOS, FREE_MB: process.env.LENGTH3_FREE_MB}) : undefined;
const hook = `whsec_dev_${secret.slice(0, 24)}`;
// What the stand-in's Stripe holds (its customers, their cards' last digits, subscriptions, invoices) is kept beside the database.
const stripeFile = join(dir, 'stripe.json');
const stripe = plan && devBilling(baseURL, hook, [appOrigin, ...others],
  async (payload, signature) => app.fetch(new Request(`${baseURL}/v1/stripe/webhook`, {method: 'POST', body: payload, headers: {'Stripe-Signature': signature, 'Content-Type': 'application/json'}})),
  {load: () => (existsSync(stripeFile) ? readFileSync(stripeFile, 'utf8') : null), save: (text) => { writeFileSync(`${stripeFile}.tmp`, text, {mode: 0o600}); renameSync(`${stripeFile}.tmp`, stripeFile); }});
const app = createApp({db, auth, bucket, origins: [appOrigin, ...others], appOrigin, providers: enter ? [] : ['dev'], domain: 'length3.test', baseURL, secret, enter,
  plan, billing: stripe ? {stripe: stripe.api, webhookSecret: hook, prices: stripe.prices} : undefined, marks});
const serve = (r: Request) => (stripe && new URL(r.url).pathname.startsWith('/dev-billing/')
  ? stripe.app.fetch(new Request(r.url.replace('/dev-billing/', '/'), r)) : app.fetch(r));

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const r = await serve(new Request(`${baseURL}${req.url}`, {
    method: req.method, headers: req.headers as Record<string, string>,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method!) ? undefined : Buffer.concat(chunks),
  }));
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? r.headers.getSetCookie() : v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(port), '127.0.0.1', () => {
  console.log(`remote on ${baseURL} for ${appOrigin} (${dir}${noBucket ? ', no bucket: files are not kept' : ''})`);
  setTimeout(() => void swept(), 3000);
});
