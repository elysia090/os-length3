// The Remote's HTTP surface (Hono; the same app on Workers, in dev and in
// tests), assembled from its parts. Each part keeps its routes, its rules
// and its queries together; service/README.md maps them, with their tables
// and which clients use them. /api/auth/* is Better Auth. Everything under
// /v1 but the release bundles, open boards and public repos needs a session
// (auth.ts signedIn): a bearer token, or the session cookie on a request
// from one of the app's own pages.
//
//   about.ts    /v1/about, /v1/health                  what this Remote is; whether it answers
//   auth.ts     /api/auth/*, /dev-oauth/*              who someone is: providers, passkeys, devices
//   enter.ts    /v1/enter                              a Remote for research: in by its link
//   files.ts    /v1/os, /v1/desktop, /v1/blobs…        the only bytes: releases and file contents
//   repos.ts    /v1/moved, /v1/repos…    the canonical copy: drafts, history, off and on
//   plan.ts     /v1/plan…, /v1/stripe/webhook          what the account's plan allows, buying it (stripe.ts)
//   home.ts     /v1/home/:key                          Home's settings
//   inbox.ts    /v1/inbox…, /.well-known/length3       names and messages
//   servers.ts  /v1/servers…, /v1/boards…, /v1/open…   servers, boards, guests
//   seen.ts     /v1/seen…, /v1/repos/:name/seen, /v1/servers/:id/repos   who sees a repo
//   news.ts     /v1/news                               what came in, for the rail
//   ssh.ts      /v1/ssh…                               which devices listen for SSH
// and request.ts, what every request passes through (origins, limits, refusals, what fails unforeseen), and
// budget.ts, what R2 and the database may be asked for (counted before either is asked).

import {Hono} from 'hono';
import {about} from './about.ts';
import {signedIn, signIn, type Auth} from './auth.ts';
import type {Bucket} from './bucket.ts';
import {Budget, FULL_WAIT, metered, type Limits} from './budget.ts';
import {enter, type Enter} from './enter.ts';
import {files, type Edge} from './files.ts';
import {homeRoutes} from './home.ts';
import {inbox} from './inbox.ts';
import {keyFor, type Purpose} from './keys.ts';
import {marked, type Marks} from './mark.ts';
import {news} from './news.ts';
import {planRoutes, plans, type Billing, type PlanConfig} from './plan.ts';
import {repos} from './repos.ts';
import {addressOf, bounded, failed, fromOrigins, slowDown, unkept, type Db, type Vars} from './request.ts';
import {seen} from './seen.ts';
import {servers} from './servers.ts';
import {sshRoutes} from './ssh.ts';

// What tests and the clients' fixtures read from here, wherever it is kept now.
export {LIMIT, roomFor, sha256} from './request.ts';
export {applyDiff, cutId, issueOf, merge3, validLine, validName, validPath} from './repos.ts';

export interface Deps {
  db: Db;
  auth: Auth;
  /** Where file contents are kept; none (null) and every route that would move bytes says so (bucket.ts). */
  bucket: Bucket | null;
  /** Pages that may call: the web app, the desktop app's webview. */
  origins: string[];
  /**
   * The web app's origin, where a device's code is approved (auth.ts verificationUri): said in
   * /v1/about, so a device that reaches the Remote by another name opens that page and no other.
   */
  appOrigin?: string;
  /** The providers offered for sign-in (auth.ts providers()). */
  providers: string[];
  /** Bytes one account may keep: its blobs and the trees its repos hold. */
  quota?: number;
  /** This Remote's own domain, for Inbox addresses (name@domain). */
  domain?: string;
  /** The Remote's own address (a domain's DNS record names its host). */
  baseURL?: string;
  /** The service's one secret: each purpose gets a key derived from it (keys.ts), never the secret itself. */
  secret?: string;
  /** TXT records of a name (DNS over HTTPS by default; a stand-in in tests). */
  txt?: (name: string) => Promise<string[]>;
  /** How long a domain's DNS is taken as still saying what it said (inbox.ts). */
  recheck?: number;
  /** A Remote for research: one account, entered by its link (enter.ts); nobody signs up, nothing is shown to everyone. */
  enter?: Enter;
  /** What a free account may keep, and the rest of the plan (plan.ts); without it, no plan: everything is open. */
  plan?: PlanConfig;
  /** How the plan is bought (Stripe); without it, billing is off and paid features cannot be bought here yet. */
  billing?: Billing;
  /** The clock, for tests of what depends on when (a webhook's signature). */
  now?: () => number;
  /** What R2 and the database may be asked for (budget.ts); without them, nothing is counted (dev, tests). */
  limits?: Limits;
  /** A cache in front of R2 for the release files (on Workers, caches.default). */
  edge?: Edge;
  /** How often one address may ask, counted at the edge before anything else is asked. */
  limiter?: {limit(o: {key: string}): Promise<{success: boolean}>};
  /** How long a session looked up is taken as still there by this process (ms; none by default). */
  sessionKept?: number;
  /**
   * The mark (mark.ts): looks answered without the database while nothing was written, and moved by every write;
   * without it, every look asks the database (the tests, a Worker with no MARK).
   */
  marks?: Marks;
}

/**
 * What a request asks that is let through a database at all it may take, though not a GET or a DELETE: signing in
 * (a provider, the stand-in's, a link), reading files many at once, and what only takes away (a repo discarded, a
 * signal taken, SSH turned off, a device's beat saying it still listens) or must be heard (Stripe's word on a payment).
 */
const ADDS_NOTHING = /^\/(api\/auth\/|dev-oauth\/|v1\/enter$|v1\/blobs\/(missing|read)$|v1\/repos\/[^/]+\/discard$|v1\/inbox\/signals\/take$|v1\/ssh\/[^/]+\/off$|v1\/ssh\/this\/beat$|v1\/stripe\/webhook$)/;

export function createApp(d: Deps) {
  const app = new Hono<Vars>();
  app.onError(failed);
  // Every answer is JSON, a path that is no route's too (not Hono's text).
  app.notFound((c) => c.json({error: 'Not found'}, 404));
  const db = d.db, domain = d.domain ?? 'length3.com', closed = !!d.enter;
  // The plan's rules, which the routes that make something new ask (repos, servers, inbox).
  const plan = plans({db, config: d.plan, billing: d.billing, domain});
  const key = (purpose: Purpose) => keyFor(d.secret ?? '', purpose);
  app.use('*', fromOrigins(d.origins));
  app.use('*', unkept);
  // Asked too often, refused at the edge, before the database or R2 is asked anything: by the address it came from.
  if (d.limiter) {
    const limiter = d.limiter;
    app.use('*', async (c, next) => {
      if (c.req.method === 'OPTIONS') return next();
      // By address alone: a token is not known good until the database is asked, and one made up each time
      // would be a count of its own each time.
      const {success} = await limiter.limit({key: addressOf(c) || 'here'});
      if (!success) slowDown(60, {error: 'Request rate limit reached; retry in a minute'});
      await next();
    });
  }
  app.use('*', bounded);
  // Before the database is asked anything (the budget's size included): a look answered by the mark asks it nothing.
  if (d.marks) app.use('*', marked({marks: d.marks, key: key('mark')}));
  const budget = d.limits ? new Budget(d.limits, d.now) : null;
  // Every read of R2 counted first (a put, by the route that makes it); with no budget, the bucket as it is.
  const bucket = d.bucket && budget ? metered(d.bucket, budget, db) : d.bucket;
  // The database at all it may take: what would add to it is refused until room comes back (the sweep, a delete).
  if (budget) {
    app.use('*', async (c, next) => {
      const adds = !['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(c.req.method) && !ADDS_NOTHING.test(c.req.path);
      if (adds && await budget.full(db)) {
        return c.json({error: 'Remote not accepting updates right now; changes remain local', budget: true, retryAfter: FULL_WAIT}, 507, {'Retry-After': String(FULL_WAIT)});
      }
      await next();
    });
  }

  signIn({auth: d.auth, db, providers: d.providers, enter: closed, origins: d.origins}, app);
  about({db, providers: d.providers, domain, appOrigin: d.appOrigin, enter: closed, baseURL: d.baseURL}, app);
  if (d.enter) enter({db, auth: d.auth, enter: d.enter}, app);

  const v1 = new Hono<Vars>();
  v1.use('*', signedIn(d.auth, d.origins, d.sessionKept));
  files({db, bucket, raw: d.bucket, quota: d.quota, budget, edge: d.edge}, v1, app);
  repos({db, quota: d.quota, plans: plan}, v1);
  homeRoutes({db}, v1);
  const names = inbox({db, domain, baseURL: d.baseURL ?? '', secret: key('domain-proof'), txt: d.txt, recheck: d.recheck, plans: plan}, v1, app);
  servers({db, domain, appOrigin: d.appOrigin, secret: key('invite'), closed, plans: plan, proven: names.proven}, v1, app);
  planRoutes({db, plans: plan, origins: d.origins, appOrigin: d.appOrigin, now: d.now}, v1, app);
  news({db}, v1);
  sshRoutes({db, marks: d.marks}, v1);
  seen({db, bucket, domain, closed, edge: d.edge, viewer: async (req) => (await d.auth.api.getSession({headers: req.headers}))?.user.id ?? null}, v1, app);

  app.route('/v1', v1);
  return app;
}
