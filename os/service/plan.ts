// The plan: what an account may do on this Remote, decided here and only
// here. Every client (the web app, the desktop app, l3) shows what this says
// and asks; none decides.
//
// Free, a signed-in account keeps on the Remote up to an allowance (FREE:
// so many repos, so many bytes; configuration, not constants in routes) and
// one name on the Remote's own domain. Paid adds three things:
//
//   1. keeping more on the Remote than the allowance
//   2. making a server (joining one when asked, and writing in it, stay free)
//   3. a name on a domain of one's own (name@yourdomain), and more names here
//
// Each rule is one function below, called by the one route it guards: a new
// repo and a draft that grows (app.ts PATCH draft), making a server
// (servers.ts), claiming a name (inbox.ts). A refusal is 402 with the rule,
// what is used and what the allowance is, and whether paying is offered
// here, so a client says it in place and keeps the work on the device.
//
// Repos on a device are never limited: only what the Remote keeps is. What
// counts is read from what the Remote holds, never counted again here: the
// account's repos (counted when asked) and its room (room.used, kept by the
// database's own triggers in the same statement as each row it counts, and
// counted again from the rows by the daily sweep, so it cannot drift).
//
// A subscription that ends takes nothing away. What was made stays as it is:
// servers go on, with their boards, people and talk; names on a domain go on
// answering while their DNS says so, and names here are renewed as before;
// every repo on the Remote stays, read and written, and a change that does
// not make a draft larger is taken. Only what would be new is refused: a
// server, a name, a repo past the allowance, a draft growing while the
// account keeps more than the allowance.
//
// A payment that fails leaves the plan paid for GRACE (14 days from the first
// failure; Stripe retries meanwhile), then it reads as free until one goes
// through. A subscription Stripe still calls active but whose period ended
// more than GRACE ago (its renewal never heard of) reads as free too.
//
// Stripe (stripe.ts) is how the plan is bought, when this Remote has its keys
// (worker.ts: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE). Without
// them billing is off: the allowance still holds, and the Remote says paid
// features cannot be bought here yet. A Remote given no plan at all (dev.ts
// unless asked, tests of other things) has no allowance: everything is open.
//
//   GET  /v1/plan                what this account has: free or paid, until when, its use against the allowance
//   POST /v1/plan/checkout {back} a Checkout session to subscribe: {url}
//   POST /v1/plan/portal   {back} the customer portal, to manage or cancel: {url}
//   POST /v1/stripe/webhook      Stripe's events, signed with the webhook secret; each taken once

import {and, eq, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {kept} from './names.ts';
import {body, refuse, rows, type Db, type Vars} from './request.ts';
import {address, billingEvent, plan, user} from './schema.ts';
import {verify, type StripeApi} from './stripe.ts';

const DAY = 86_400_000;

/** What a free account may keep on the Remote: repos, bytes (room.used), names on the Remote's own domain. */
export interface Allowance { repos: number; bytes: number; names: number }
export interface PlanConfig { free: Allowance; grace: number }

export const FREE: Allowance = {repos: 3, bytes: 100 * 1024 ** 2, names: 1};
/** How long a plan whose payment failed stays paid. */
export const GRACE = 14 * DAY;
/** How long a webhook event is remembered as taken; one made longer ago is not taken at all. */
export const KEEP_EVENTS = 30 * DAY;

/** The plan as the deployment says it (FREE_REPOS, FREE_MB, GRACE_DAYS); what it leaves out, as above. */
export function planConfig(env: {FREE_REPOS?: string; FREE_MB?: string; GRACE_DAYS?: string} = {}): PlanConfig {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(x) && x >= 0 ? x : d; };
  return {free: {repos: Math.floor(n(env.FREE_REPOS, FREE.repos)), bytes: Math.floor(n(env.FREE_MB, FREE.bytes / 1024 ** 2) * 1024 ** 2), names: FREE.names},
    grace: n(env.GRACE_DAYS, GRACE / DAY) * DAY};
}

/** How the plan is bought: Stripe, and the secret its webhook events are signed with. */
export interface Billing { stripe: StripeApi; webhookSecret: string }

type Row = Pick<typeof plan.$inferSelect, 'customer' | 'subscription' | 'status' | 'periodEnd' | 'cancelAt' | 'failedAt'>;

/**
 * Where an account stands, from its row: paid or not, and the one date that
 * matters (renews, ends, or the grace a failed payment has left).
 */
export interface Standing { paid: boolean; status: string | null; renews: number | null; ends: number | null; graceUntil: number | null }

export function standing(row: Row | undefined, grace: number, now = Date.now()): Standing {
  const none: Standing = {paid: false, status: row?.status ?? null, renews: null, ends: null, graceUntil: null};
  if (!row?.status) return none;
  const end = row.periodEnd?.getTime() ?? null, cancel = row.cancelAt?.getTime() ?? null;
  if (row.status === 'active' || row.status === 'trialing') {
    // Its renewal never heard of, or set to end and the end come: free, whatever was last said.
    const stale = end !== null && now > end + grace, over = cancel !== null && now >= cancel;
    return {...none, paid: !stale && !over, renews: cancel === null ? end : null, ends: cancel};
  }
  if (row.status === 'past_due' || row.status === 'unpaid') {
    const from = row.failedAt?.getTime() ?? end ?? now;
    return {...none, paid: now < from + grace, graceUntil: from + grace, ends: cancel};
  }
  // canceled, incomplete, incomplete_expired, paused: not paid; when it ended, if it did.
  return {...none, ends: row.status === 'canceled' ? cancel ?? end : null};
}

/** What an account keeps on the Remote, read from what is there: its repos (those turned off among them, still kept) and its room. */
export async function usage(q: Db, userId: string): Promise<{repos: number; bytes: number}> {
  const [u] = await rows<{repos: number; bytes: number}>(q, sql`select (select count(*)::int from repo where user_id = ${userId}) as repos,
    coalesce((select used from room where user_id = ${userId}), 0)::float8 as bytes`);
  return {repos: Number(u?.repos ?? 0), bytes: Number(u?.bytes ?? 0)};
}

/** Names the account keeps on the Remote's own domain (those let go and still held for it among them). */
const homeNames = async (q: Db, userId: string, domain: string, but = '') =>
  ((await q.select({n: sql<number>`count(*)::int`}).from(address)
    .where(and(eq(address.userId, userId), eq(address.domain, domain), kept, sql`${address.address} <> ${but}`))) as {n: number}[])[0]?.n ?? 0;

export type Plans = ReturnType<typeof plans>;

/** The rules, over `db`; with no `config`, none (everything is open). */
export function plans(d: {db: Db; config?: PlanConfig; billing?: Billing; domain: string}) {
  const config = d.config;
  const rowOf = async (q: Db, userId: string) => (await q.select().from(plan).where(eq(plan.userId, userId)) as Row[])[0];
  const standingOf = async (q: Db, userId: string) => standing(await rowOf(q, userId), config?.grace ?? GRACE);
  const paid = async (q: Db, userId: string) => !config || (await standingOf(q, userId)).paid;
  /** A refusal: what the rule says, and enough for a client to say it in place and point at the plan. */
  const over = (said: {error: string}, rule: string, extra: Record<string, number> = {}): never =>
    refuse(402, {...said, rule, plan: 'free', buy: !!d.billing, ...extra});
  return {
    on: !!config,
    config,
    billing: d.billing,
    rowOf,
    standingOf,
    paid,
    /** Rule 1: a new repo on the Remote, past the free allowance. The caller holds the account's lock. */
    async newRepo(q: Db, userId: string) {
      if (!config) return;
      const {repos} = await usage(q, userId);
      if (repos >= config.free.repos && !await paid(q, userId)) over({error: 'The free plan keeps no more repos on the Remote'}, 'repos', {used: repos, limit: config.free.repos});
    },
    /**
     * Rule 1: a draft that grew by `growth` bytes (its tree and files), now
     * written in the caller's transaction: refused, and so undone, when the
     * account now keeps more than the allowance. A change that does not make
     * a draft larger is always taken, however much is kept.
     */
    async grew(q: Db, userId: string, growth: number) {
      if (!config || growth <= 0) return;
      const {bytes} = await usage(q, userId);
      if (bytes > config.free.bytes && !await paid(q, userId)) over({error: 'The free plan keeps no more on the Remote'}, 'bytes', {used: bytes, limit: config.free.bytes});
    },
    /** Rule 2: making a server. */
    async makeServer(q: Db, userId: string) {
      if (config && !await paid(q, userId)) over({error: 'Making a server is part of the paid plan'}, 'server');
    },
    /**
     * Rule 3: claiming `name@domain` (`theirs`: it is already the account's, renewed or
     * taken back, which is never new). On another domain, paid; on this Remote's, one free.
     */
    async claimName(q: Db, userId: string, a: string, domain: string, theirs: boolean) {
      if (!config || theirs) return;
      if (domain !== d.domain) {
        if (!await paid(q, userId)) over({error: 'A name on your own domain is part of the paid plan'}, 'domain');
        return;
      }
      const n = await homeNames(q, userId, domain, a);
      if (n >= config.free.names && !await paid(q, userId)) over({error: 'More names on this Remote are part of the paid plan'}, 'names', {used: n, limit: config.free.names});
    },
  };
}

/** A Stripe object's moment (seconds), as a Date; none for anything else. */
const secs = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null);
const STATUSES = new Set(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']);
const CUSTOMER = /^cus_[A-Za-z0-9_]{1,250}$/, SUBSCRIPTION = /^sub_[A-Za-z0-9_]{1,250}$/, EVENT = /^evt_[A-Za-z0-9_]{1,250}$/;
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Take one event (already checked and recorded as taken) into the account it
 * is about. An event about no account of this Remote (another product on the
 * same Stripe account) changes nothing.
 */
export async function apply(tx: Db, event: {type: string; created: number; data: {object: Obj}}) {
  const o = event.data.object, at = new Date(event.created * 1000);
  const customer = typeof o.customer === 'string' ? o.customer : str((o.customer as Obj | null)?.id);
  /** The account a customer is: by its row, else by the account Checkout was made for (and then the row says so). */
  const whose = async (asked: string): Promise<string | null> => {
    if (!CUSTOMER.test(customer)) return null;
    const [r] = await tx.select({userId: plan.userId}).from(plan).where(eq(plan.customer, customer)) as {userId: string}[];
    if (r) return r.userId;
    if (!asked || !(await tx.select({id: user.id}).from(user).where(eq(user.id, asked))).length) return null;
    await tx.insert(plan).values({userId: asked, customer}).onConflictDoUpdate({target: plan.userId, set: {customer, updatedAt: sql`now()`}, setWhere: sql`${plan.customer} is null`});
    const [now] = await tx.select({customer: plan.customer}).from(plan).where(eq(plan.userId, asked)) as {customer: string | null}[];
    return now?.customer === customer ? asked : null;
  };
  const meta = (o.metadata ?? {}) as Obj;
  switch (event.type) {
    case 'checkout.session.completed':
      if (o.mode === 'subscription') await whose(str(o.client_reference_id) || str(meta.user));
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = await whose(str(meta.user));
      const id = str(o.id), deleted = event.type === 'customer.subscription.deleted';
      if (!userId || !SUBSCRIPTION.test(id)) return;
      // Newer API versions say the period on the subscription's item.
      const item = ((o.items as Obj | undefined)?.data as Obj[] | undefined)?.[0] ?? {};
      const periodEnd = secs(o.current_period_end) ?? secs(item.current_period_end);
      const status = deleted ? 'canceled' : STATUSES.has(str(o.status)) ? str(o.status) : null;
      const cancelAt = secs(o.cancel_at) ?? (o.cancel_at_period_end === true ? periodEnd : null) ?? (deleted ? secs(o.ended_at) ?? at : null);
      const set = {subscription: id, status, periodEnd, cancelAt, eventAt: at, updatedAt: new Date()};
      // Stripe does not send events in order: one made before the last taken changes nothing; nor does
      // the end of another subscription than the one this account now has.
      await tx.insert(plan).values({userId, ...set}).onConflictDoUpdate({target: plan.userId, set,
        setWhere: sql`(${plan.eventAt} is null or ${plan.eventAt} <= ${at})${deleted ? sql` and (${plan.subscription} is null or ${plan.subscription} = ${id})` : sql``}`});
      return;
    }
    case 'invoice.payment_failed': {
      const userId = await whose('');
      if (userId) await tx.update(plan).set({failedAt: sql`coalesce(${plan.failedAt}, ${at})`, updatedAt: new Date()}).where(eq(plan.userId, userId));
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const userId = await whose('');
      if (userId) await tx.update(plan).set({failedAt: null, updatedAt: new Date()}).where(and(eq(plan.userId, userId), sql`${plan.failedAt} <= ${at}`));
      return;
    }
  }
}

export interface PlanDeps { db: Db; plans: Plans; origins: string[]; appOrigin?: string; now?: () => number }

/** The routes: the account's plan (v1, signed in), and Stripe's webhook (app, signed by Stripe). */
export function planRoutes(d: PlanDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const {db, plans: p} = d;
  /** Where Stripe sends the person back: the page that asked, if it is one of the app's, else the app. */
  const backTo = (asked: unknown) => {
    try { const u = new URL(str(asked)); if (d.origins.includes(u.origin)) return u.toString(); } catch { /* the app's own */ }
    return d.appOrigin ?? d.origins[0] ?? '';
  };

  v1.get('/plan', async (c) => {
    const me = c.get('userId');
    if (!p.on || !p.config) return c.json({plan: 'none'});
    const [row, use, names] = await Promise.all([p.rowOf(db, me), usage(db, me), db.select({domain: address.domain, n: sql<number>`count(*)::int`})
      .from(address).where(and(eq(address.userId, me), kept)).groupBy(address.domain) as Promise<{domain: string; n: number}[]>]);
    const s = standing(row, p.config.grace);
    return c.json({plan: s.paid ? 'paid' : 'free', status: s.status, renews: s.renews, ends: s.ends, graceUntil: s.graceUntil,
      usage: {...use, names: names.reduce((a, r) => a + r.n, 0)}, free: p.config.free,
      buy: !!p.billing, manage: !!p.billing && !!row?.customer});
  });

  const off = () => (p.on ? refuse(503, {error: 'Paid features cannot be bought on this Remote yet', buy: false}) : refuse(404, {error: 'This Remote has no plan'}));

  v1.post('/plan/checkout', async (c) => {
    const me = c.get('userId');
    if (!p.on || !p.billing) return off();
    if (await p.paid(db, me)) return c.json({error: 'This account is on the paid plan already'}, 409);
    const back = backTo((await body<{back?: unknown}>(c))?.back);
    let customer = (await p.rowOf(db, me))?.customer ?? null;
    if (!customer) {
      const [u] = await db.select({email: user.email, name: user.name}).from(user).where(eq(user.id, me)) as {email: string; name: string}[];
      const made = await p.billing.stripe.customer({user: me, email: u.email, name: u.name}).catch(() => refuse(502, {error: 'Stripe did not answer; try again'}));
      if (!CUSTOMER.test(made)) refuse(502, {error: 'Stripe did not answer; try again'});
      // One customer an account: asked twice at once, the first kept is the one used (Stripe's idempotency makes them the same anyway).
      await db.insert(plan).values({userId: me, customer: made}).onConflictDoUpdate({target: plan.userId, set: {customer: made}, setWhere: sql`${plan.customer} is null`});
      customer = (await p.rowOf(db, me))!.customer!;
    }
    const url = await p.billing.stripe.checkout({customer, user: me, success: back, cancel: back}).catch(() => refuse(502, {error: 'Stripe did not answer; try again'}));
    return c.json({url});
  });

  v1.post('/plan/portal', async (c) => {
    const me = c.get('userId');
    if (!p.on || !p.billing) return off();
    const customer = (await p.rowOf(db, me))?.customer;
    if (!customer) return c.json({error: 'Nothing to manage yet: this account has not subscribed'}, 409);
    const back = backTo((await body<{back?: unknown}>(c))?.back);
    const url = await p.billing.stripe.portal({customer, back}).catch(() => refuse(502, {error: 'Stripe did not answer; try again'}));
    return c.json({url});
  });

  // Stripe's events: the body exactly as sent is what is signed. A bad signature changes nothing and says
  // so (Stripe shows it in its dashboard); an event taken before is answered as taken and changes nothing.
  app.post('/v1/stripe/webhook', async (c) => {
    if (!p.billing) return c.json({error: 'This Remote takes no payments'}, 404);
    const raw = await c.req.text();
    const now = d.now?.() ?? Date.now();
    if (!await verify(raw, c.req.header('Stripe-Signature'), p.billing.webhookSecret, now)) return c.json({error: 'The signature does not match'}, 400);
    let event: {id?: unknown; type?: unknown; created?: unknown; data?: {object?: unknown}};
    try { event = JSON.parse(raw); } catch { return c.json({error: 'Not an event'}, 400); }
    const id = str(event.id), type = str(event.type), created = typeof event.created === 'number' ? event.created : 0;
    const object = event.data?.object;
    if (!EVENT.test(id) || !type || type.length > 100 || !created || !object || typeof object !== 'object') return c.json({error: 'Not an event'}, 400);
    if (created * 1000 < now - KEEP_EVENTS) return c.json({received: true, taken: false});
    const taken = await db.transaction(async (tx: Db) => {
      const fresh = await tx.insert(billingEvent).values({id, type}).onConflictDoNothing().returning({id: billingEvent.id});
      if (!fresh.length) return false;
      await apply(tx, {type, created, data: {object: object as Obj}});
      return true;
    });
    return c.json({received: true, taken});
  });
}
