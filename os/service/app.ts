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
//   repos.ts    /v1/moved, /v1/repos…, /v1/off-code    the canonical copy: drafts, history, off and on
//   plan.ts     /v1/plan…, /v1/stripe/webhook          what the account's plan allows, buying it (stripe.ts)
//   home.ts     /v1/home/:key                          Home's settings
//   inbox.ts    /v1/inbox…, /.well-known/length3       names and messages
//   servers.ts  /v1/servers…, /v1/boards…, /v1/open…   servers, boards, guests
//   seen.ts     /v1/seen…, /v1/repos/:name/seen, /v1/servers/:id/repos   who sees a repo
//   news.ts     /v1/news                               what came in, for the rail
//   ssh.ts      /v1/ssh…                               which devices listen for SSH
// and request.ts, what every request passes through (origins, limits, refusals, what fails unforeseen).

import {Hono} from 'hono';
import {about} from './about.ts';
import {signedIn, signIn, type Auth} from './auth.ts';
import type {Bucket} from './bucket.ts';
import {enter, type Enter} from './enter.ts';
import {files} from './files.ts';
import {homeRoutes} from './home.ts';
import {inbox} from './inbox.ts';
import {news} from './news.ts';
import {planRoutes, plans, type Billing, type PlanConfig} from './plan.ts';
import {repos} from './repos.ts';
import {bounded, failed, fromOrigins, unkept, type Db, type Vars} from './request.ts';
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
  /** The key Inbox domain proofs are made with (the service's secret). */
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
}

export function createApp(d: Deps) {
  const app = new Hono<Vars>();
  app.onError(failed);
  const db = d.db, domain = d.domain ?? 'length3.com', closed = !!d.enter;
  // The plan's rules, which the routes that make something new ask (repos, servers, inbox).
  const plan = plans({db, config: d.plan, billing: d.billing, domain});
  app.use('*', fromOrigins(d.origins));
  app.use('*', unkept);
  app.use('*', bounded);

  signIn({auth: d.auth, providers: d.providers, enter: closed}, app);
  about({db, providers: d.providers, domain, appOrigin: d.appOrigin, enter: closed}, app);
  if (d.enter) enter({db, auth: d.auth, enter: d.enter}, app);

  const v1 = new Hono<Vars>();
  v1.use('*', signedIn(d.auth, d.origins));
  files({db, bucket: d.bucket, quota: d.quota}, v1, app);
  repos({db, quota: d.quota, plans: plan}, v1);
  homeRoutes({db}, v1);
  inbox({db, domain, baseURL: d.baseURL ?? '', secret: d.secret ?? '', txt: d.txt, recheck: d.recheck, plans: plan}, v1, app);
  servers({db, domain, appOrigin: d.appOrigin, secret: d.secret, closed, plans: plan}, v1, app);
  planRoutes({db, plans: plan, origins: d.origins, appOrigin: d.appOrigin, now: d.now}, v1, app);
  news({db}, v1);
  sshRoutes({db}, v1);
  seen({db, bucket: d.bucket, domain, closed, viewer: async (req) => (await d.auth.api.getSession({headers: req.headers}))?.user.id ?? null}, v1, app);

  app.route('/v1', v1);
  return app;
}
