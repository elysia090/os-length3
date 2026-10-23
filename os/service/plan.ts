// The plan: what an account may do on this Remote, decided here and only
// here. Every client (the web app, the desktop app, l3) shows what this says
// and asks; none decides.
//
// Free, a signed-in account keeps on the Remote up to an allowance (FREE:
// so many repos, so many bytes; configuration, not constants in routes) and
// one name on the Remote's own domain. Three tiers are paid for, Go, Pro and
// Max (PAID), each keeping more on the Remote than the last (50 GB, 256 GB,
// 512 GB; repos as many as fit, and more names here each step up). Any of
// them adds three things to what free has:
//
//   1. keeping more on the Remote than the free allowance (up to the tier's)
//   2. making a server (joining one when asked, and writing in it, stay free)
//   3. a name on a domain of one's own (name@yourdomain), and more names here
//
// Each rule is one function below, called by the one route it guards: a new
// repo and a draft that grows (repos.ts PATCH draft), making a server
// (servers.ts), claiming a name (inbox.ts). A refusal is 402 with the rule,
// the tier the account is on, what is used and what the allowance is, and
// whether paying is offered here, so a client says it in place and keeps the
// work on the device.
//
// Repos on a device are never limited: only what the Remote keeps is. What
// counts is read from what the Remote holds, never counted again here: the
// account's repos (counted when asked) and its room (room.used, kept by the
// database's own triggers in the same statement as each row it counts, and
// counted again from the rows by the daily sweep, so it cannot drift).
//
// A subscription that ends, or goes to a tier that keeps less, takes nothing
// away. What was made stays as it is: servers go on, with their boards,
// people and talk; names on a domain go on answering while their DNS says so,
// and names here are renewed as before; every repo on the Remote stays, read
// and written, and a change that does not make a draft larger is taken. Only
// what would be new is refused: a server, a name, a repo past the allowance,
// a draft growing while the account keeps more than the allowance.
//
// A payment that fails leaves the plan paid for GRACE (14 days from the first
// failure; Stripe retries meanwhile), then it reads as free until one goes
// through. A subscription Stripe still calls active but whose period ended
// more than GRACE ago (its renewal never heard of) reads as free too.
//
// Stripe (stripe.ts) is how a tier is bought, when this Remote has its keys
// and a price for it (worker.ts: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_GO, STRIPE_PRICE_PRO, STRIPE_PRICE_MAX). Which tier a
// subscription is to is read from its price as each of its events comes, so a
// tier changed in Stripe's portal is the account's allowance at once. Without
// the keys, or without any price, billing is off: the allowance still holds,
// and the Remote says paid features cannot be bought here yet. A Remote given
// no plan at all (dev.ts unless asked, tests of other things) has no
// allowance: everything is open.
//
//   GET  /v1/plan                        what this account has: its tier, until when, its use against its allowance, the tiers
//   POST /v1/plan/checkout {back, tier}  a Checkout session to subscribe to a tier: {url}
//   POST /v1/plan/portal   {back, tier?} the customer portal, to manage or cancel; with a tier, at the step that changes to it: {url}
//   POST /v1/stripe/webhook              Stripe's events, signed with the webhook secret; each taken once

import {and, eq, sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import {kept} from './names.ts';
import {body, refuse, rows, type Db, type Vars} from './request.ts';
import {address, billingEvent, plan, user} from './schema.ts';
import {verify, type Price, type StripeApi} from './stripe.ts';

const DAY = 86_400_000;
/** A megabyte as the app shows one (dom.ts bytes): a million bytes. */
export const MB = 1_000_000;
/** A gigabyte, likewise: a thousand megabytes. */
export const GB = 1000 * MB;

/** What an account may keep on the Remote: repos, bytes (room.used), names on the Remote's own domain; null, as many as fit. */
export interface Allowance { repos: number | null; bytes: number; names: number | null }

/** The tiers one pays for, the least first. */
export const TIERS = ['go', 'pro', 'max'] as const;
export type Tier = typeof TIERS[number];
export const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier);
/** Each tier's name, as Stripe's pages and every client say it. */
export const TIER_NAME: Record<Tier, string> = {go: 'Go', pro: 'Pro', max: 'Max'};

export interface PlanConfig {
  free: Allowance;
  /** What each paid tier keeps; PAID unless said. */
  paid?: Record<Tier, Allowance>;
  grace: number;
}

export const FREE: Allowance = {repos: 3, bytes: 100 * MB, names: 1};
/** What each tier keeps: repos as many as fit in its bytes, and more names here each step up. */
export const PAID: Record<Tier, Allowance> = {
  go: {repos: null, bytes: 50 * GB, names: 5},
  pro: {repos: null, bytes: 256 * GB, names: 10},
  max: {repos: null, bytes: 512 * GB, names: 20},
};
/** How long a plan whose payment failed stays paid. */
export const GRACE = 14 * DAY;
/** How long a webhook event is remembered as taken; one made longer ago is not taken at all. */
export const KEEP_EVENTS = 30 * DAY;

/** The plan as the deployment says it (FREE_REPOS, FREE_MB, GRACE_DAYS); what it leaves out, as above. */
export function planConfig(env: {FREE_REPOS?: string; FREE_MB?: string; GRACE_DAYS?: string} = {}): PlanConfig {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return v !== undefined && v.trim() !== '' && Number.isFinite(x) && x >= 0 ? x : d; };
  return {free: {repos: Math.floor(n(env.FREE_REPOS, FREE.repos!)), bytes: Math.floor(n(env.FREE_MB, FREE.bytes / MB) * MB), names: FREE.names},
    paid: PAID, grace: n(env.GRACE_DAYS, GRACE / DAY) * DAY};
}

/** How the plan is bought: Stripe, the secret its webhook events are signed with, and each tier's price (a tier without one is not sold). */
export interface Billing { stripe: StripeApi; webhookSecret: string; prices: Partial<Record<Tier, string>> }

/** The tiers sold here, the least first. */
export const sold = (b: Billing | undefined): Tier[] => (b ? TIERS.filter((t) => !!b.prices[t]) : []);

type Row = Pick<typeof plan.$inferSelect, 'customer' | 'subscription' | 'status' | 'periodEnd' | 'cancelAt' | 'failedAt'>
  & {tier?: string | null; item?: string | null; eventAt?: Date | null};

/**
 * Where an account stands, from its row: paid or not, the tier paid for, and the one date that matters (renews,
 * ends, or the grace a failed payment has left). A subscription from before there were tiers is the first.
 */
export interface Standing { paid: boolean; tier: Tier | null; status: string | null; renews: number | null; ends: number | null; graceUntil: number | null }

export function standing(row: Row | undefined, grace: number, now = Date.now()): Standing {
  const none: Standing = {paid: false, tier: null, status: row?.status ?? null, renews: null, ends: null, graceUntil: null};
  if (!row?.status) return none;
  const end = row.periodEnd?.getTime() ?? null, cancel = row.cancelAt?.getTime() ?? null;
  const tier = isTier(row.tier) ? row.tier : TIERS[0];
  if (row.status === 'active' || row.status === 'trialing') {
    // Its renewal never heard of, or set to end and the end come: free, whatever was last said.
    const stale = end !== null && now > end + grace, over = cancel !== null && now >= cancel;
    const paid = !stale && !over;
    return {...none, paid, tier: paid ? tier : null, renews: cancel === null ? end : null, ends: cancel};
  }
  if (row.status === 'past_due' || row.status === 'unpaid') {
    const from = row.failedAt?.getTime() ?? end ?? now;
    const paid = now < from + grace;
    return {...none, paid, tier: paid ? tier : null, graceUntil: from + grace, ends: cancel};
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

/** Whether `used` is still within `limit` (null: no limit). */
const within = (used: number, limit: number | null) => limit === null || used < limit;

export type Plans = ReturnType<typeof plans>;

/** The rules, over `db`; with no `config`, none (everything is open). */
export function plans(d: {db: Db; config?: PlanConfig; billing?: Billing; domain: string}) {
  const config = d.config;
  const paidAllowance = (tier: Tier) => config?.paid?.[tier] ?? PAID[tier];
  const rowOf = async (q: Db, userId: string) => (await q.select().from(plan).where(eq(plan.userId, userId)) as Row[])[0];
  const standingOf = async (q: Db, userId: string) => standing(await rowOf(q, userId), config?.grace ?? GRACE);
  const paid = async (q: Db, userId: string) => !config || (await standingOf(q, userId)).paid;
  /** The tier an account is on (free, or the one it pays for), and what that keeps. */
  const allowanceOf = async (q: Db, userId: string): Promise<{tier: Tier | 'free'; allowance: Allowance}> => {
    const s = await standingOf(q, userId);
    return s.tier ? {tier: s.tier, allowance: paidAllowance(s.tier)} : {tier: 'free', allowance: config!.free};
  };
  /** A refusal: what the rule says, and enough for a client to say it in place (by the tier, in its own words) and point at the plan. */
  const over = (said: {error: string}, rule: string, tier: Tier | 'free', extra: Record<string, number> = {}): never =>
    refuse(402, {...said, rule, plan: tier === 'free' ? 'free' : 'paid', tier, buy: sold(d.billing).length > 0, ...extra});
  return {
    on: !!config,
    config,
    billing: d.billing,
    domain: d.domain,
    paidAllowance,
    rowOf,
    standingOf,
    paid,
    allowanceOf,
    /** Rule 1: a new repo on the Remote, past the allowance. The caller holds the account's lock. */
    async newRepo(q: Db, userId: string) {
      if (!config) return;
      const {repos} = await usage(q, userId);
      if (within(repos, config.free.repos)) return;
      const {tier, allowance} = await allowanceOf(q, userId);
      if (!within(repos, allowance.repos)) {
        over(tier === 'free' ? {error: 'The free plan keeps no more repos on the Remote'} : {error: 'Your plan keeps no more repos on the Remote'}, 'repos', tier,
          {used: repos, limit: allowance.repos!});
      }
    },
    /**
     * Rule 1: a draft that grew by `growth` bytes (its tree and files), now
     * written in the caller's transaction: refused, and so undone, when the
     * account now keeps more than its allowance. A change that does not make
     * a draft larger is always taken, however much is kept.
     */
    async grew(q: Db, userId: string, growth: number) {
      if (!config || growth <= 0) return;
      const {bytes} = await usage(q, userId);
      if (bytes <= config.free.bytes) return;
      const {tier, allowance} = await allowanceOf(q, userId);
      if (bytes > allowance.bytes) {
        over(tier === 'free' ? {error: 'The free plan keeps no more on the Remote'} : {error: 'Your plan keeps no more on the Remote'}, 'bytes', tier,
          {used: bytes, limit: allowance.bytes});
      }
    },
    /** Rule 2: making a server. */
    async makeServer(q: Db, userId: string) {
      if (config && !await paid(q, userId)) over({error: 'Making a server is part of the paid plan'}, 'server', 'free');
    },
    /**
     * Rule 3: claiming `name@domain` (`theirs`: it is already the account's, renewed or
     * taken back, which is never new). On another domain, paid; on this Remote's, as many as the tier keeps.
     */
    async claimName(q: Db, userId: string, a: string, domain: string, theirs: boolean) {
      if (!config || theirs) return;
      if (domain !== d.domain) {
        if (!await paid(q, userId)) over({error: 'A name on your own domain is part of the paid plan'}, 'domain', 'free');
        return;
      }
      const n = await homeNames(q, userId, domain, a);
      if (within(n, config.free.names)) return;
      const {tier, allowance} = await allowanceOf(q, userId);
      if (!within(n, allowance.names)) {
        over(tier === 'free' ? {error: 'More names on this Remote are part of the paid plan'} : {error: 'Your plan keeps no more names on this Remote'}, 'names', tier,
          {used: n, limit: allowance.names!});
      }
    },
  };
}

/** A Stripe object's moment (seconds), as a Date; none for anything else. */
const secs = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null);
const STATUSES = new Set(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']);
const CUSTOMER = /^cus_[A-Za-z0-9_]{1,250}$/, SUBSCRIPTION = /^sub_[A-Za-z0-9_]{1,250}$/, ITEM = /^si_[A-Za-z0-9_]{1,250}$/, EVENT = /^evt_[A-Za-z0-9_]{1,250}$/;
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Take one event (already checked and recorded as taken) into the account it
 * is about. An event about no account of this Remote (another product on the
 * same Stripe account) changes nothing. `tierOf` names the tier a price is
 * of (none: a price this Remote does not sell).
 */
export async function apply(tx: Db, event: {type: string; created: number; data: {object: Obj}}, tierOf: (price: string) => Tier | null = () => null) {
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
      // Newer API versions say the period on the subscription's item, and the item says the price it is to.
      const item = ((o.items as Obj | undefined)?.data as Obj[] | undefined)?.[0] ?? {};
      const periodEnd = secs(o.current_period_end) ?? secs(item.current_period_end);
      const status = deleted ? 'canceled' : STATUSES.has(str(o.status)) ? str(o.status) : null;
      const cancelAt = secs(o.cancel_at) ?? (o.cancel_at_period_end === true ? periodEnd : null) ?? (deleted ? secs(o.ended_at) ?? at : null);
      // The tier by its price, as this Remote sells it (a change in the portal changes the price, never the
      // metadata Checkout gave it); a price it does not know, by what Checkout said; else as it was.
      const price = str((item.price as Obj | undefined)?.id) || str((item.plan as Obj | undefined)?.id);
      const tier = (price && tierOf(price)) || (isTier(meta.tier) ? meta.tier : null);
      const itemId = ITEM.test(str(item.id)) ? str(item.id) : null;
      // Paying again (active, trialing) ends a failure before it: the next one gets its grace whole.
      const set = {subscription: id, status, periodEnd, cancelAt, eventAt: at, updatedAt: new Date(),
        ...(tier ? {tier} : {}), ...(itemId ? {item: itemId} : {}),
        ...(status === 'active' || status === 'trialing' ? {failedAt: null} : {})};
      // Stripe does not send events in order, and says their moment in whole seconds: one made before the last
      // taken changes nothing, and one of the same second as it does, but for `incomplete` over a subscription
      // already paying (made as incomplete, then active, is one Checkout). Nor does another subscription than the
      // one this account has and pays for (two Checkouts in two tabs) take its place, nor its end end the one paid for.
      const unmade = status === 'incomplete' || status === 'incomplete_expired';
      // One being paid for takes the place of one whose payment failed (paid again past its grace): before, the new
      // one was heard and kept out, and the account stayed free while it paid.
      const paying = status === 'active' || status === 'trialing';
      await tx.insert(plan).values({userId, ...set}).onConflictDoUpdate({target: plan.userId, set,
        setWhere: sql`(${plan.eventAt} is null or ${plan.eventAt} < ${at} or (${plan.eventAt} = ${at}${unmade ? sql` and ${plan.status} not in ('active', 'trialing')` : sql``}))
          and (${plan.subscription} is null or ${plan.subscription} = ${id} or ${plan.status} is null
            or ${plan.status} not in ('active', 'trialing'${paying ? sql`` : sql`, 'past_due'`}))`});
      return;
    }
    case 'invoice.payment_failed': {
      const userId = await whose('');
      // A failure older than the subscription as last heard of (delivered late, after a payment went through) is past.
      if (userId) await tx.update(plan).set({failedAt: sql`coalesce(${plan.failedAt}, ${at})`, updatedAt: new Date()})
        .where(and(eq(plan.userId, userId), sql`(${plan.eventAt} is null or ${plan.eventAt} <= ${at})`));
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

/**
 * `back` with how the trip to Stripe went, for the page it comes back to: ?plan=paid (and the tier) or
 * ?plan=cancelled from Checkout, ?plan=managed from the portal.
 */
export function marked(back: string, how: 'paid' | 'cancelled' | 'managed', tier?: Tier): string {
  try {
    const u = new URL(back);
    u.searchParams.set('plan', how);
    if (tier) u.searchParams.set('tier', tier); else u.searchParams.delete('tier');
    return u.toString();
  } catch { return back; }
}

/** Each price as Stripe said it last, kept an hour by this isolate: one ask of Stripe an hour for each, not one a page. */
let priced: {key: Billing; at: Map<string, {at: number; price: Price | null}>} | null = null;
async function priceOf(b: Billing, id: string): Promise<Price | null> {
  if (priced?.key !== b) priced = {key: b, at: new Map()};
  const was = priced.at.get(id);
  if (was && Date.now() - was.at < (was.price ? 3600_000 : 60_000)) return was.price;
  const price = await b.stripe.price(id).catch(() => null);
  priced.at.set(id, {at: Date.now(), price});
  return price;
}

/** A tier as a client is told it: what it keeps, whether it is sold here, and what it costs when Stripe could say. */
export interface TierSaid { tier: Tier | 'free'; allowance: Allowance; sold?: boolean; price?: Price }

/** The routes: the account's plan (v1, signed in), and Stripe's webhook (app, signed by Stripe). */
export function planRoutes(d: PlanDeps, v1: Hono<Vars>, app: Hono<Vars>) {
  const {db, plans: p} = d;
  /** Where Stripe sends the person back: the page that asked, if it is one of the app's, else the app. */
  const backTo = (asked: unknown) => {
    try { const u = new URL(str(asked)); if (d.origins.includes(u.origin)) return u.toString(); } catch { /* the app's own */ }
    return d.appOrigin ?? d.origins[0] ?? '';
  };
  /**
   * Free and every tier, the least first: what each keeps and, sold here, what it costs (asked of Stripe at
   * once for each, never one after another). A tier not sold here is said only while it is the account's own.
   */
  const tiersSaid = async (mine?: Tier | null): Promise<TierSaid[]> => {
    const b = p.billing, selling = sold(b);
    const shown = TIERS.filter((t) => selling.includes(t) || t === mine);
    const prices = await Promise.all(shown.map((t) => (b && b.prices[t] ? priceOf(b, b.prices[t]!) : Promise.resolve(null))));
    return [{tier: 'free', allowance: p.config!.free},
      ...shown.map((t, i): TierSaid => ({tier: t, allowance: p.paidAllowance(t), sold: selling.includes(t), ...(prices[i] ? {price: prices[i]!} : {})}))];
  };

  v1.get('/plan', async (c) => {
    const me = c.get('userId');
    if (!p.on || !p.config) return c.json({plan: 'none'});
    // One after another on the request's one connection: asked at once, each would open a connection of its own (worker.ts).
    const row = await p.rowOf(db, me), use = await usage(db, me);
    // Names as the rule counts them: those on this Remote's own domain (one on a domain of one's own is paid, not counted).
    const names = await homeNames(db, me, p.domain);
    const s = standing(row, p.config.grace);
    const allowance = s.tier ? p.paidAllowance(s.tier) : p.config.free;
    return c.json({plan: s.paid ? 'paid' : 'free', tier: s.tier ?? 'free', status: s.status, renews: s.renews, ends: s.ends, graceUntil: s.graceUntil,
      usage: {...use, names}, allowance, free: p.config.free, tiers: await tiersSaid(s.tier),
      buy: sold(p.billing).length > 0, manage: !!p.billing && !!row?.customer});
  });

  const off = () => (p.on ? refuse(503, {error: 'Paid features cannot be bought on this Remote yet', buy: false}) : refuse(404, {error: 'This Remote has no plan'}));
  /** The tier asked for, as sold here: none named is the least one sold (as a client from before there were tiers asks). */
  const tierAsked = (asked: unknown): Tier => {
    const selling = sold(p.billing);
    if (asked === undefined || asked === null || asked === '') return selling[0];
    if (!isTier(asked)) return refuse(400, {error: 'No such tier: go, pro or max'});
    if (!selling.includes(asked)) return refuse(400, {error: 'That tier is not sold on this Remote', tier: asked});
    return asked;
  };

  v1.post('/plan/checkout', async (c) => {
    const me = c.get('userId');
    if (!p.on || !p.billing || !sold(p.billing).length) return off();
    const asked = await body<{back?: unknown; tier?: unknown}>(c);
    const tier = tierAsked(asked?.tier);
    const now = await p.standingOf(db, me);
    // One subscription an account: another tier is a change of the one there is, in the portal, never a second beside it.
    if (now.paid) {
      return c.json({error: 'This account is on a paid plan already; another tier is chosen under Manage the plan', tier: now.tier, manage: true}, 409);
    }
    // One subscription an account: one being made (a Checkout in another tab) is finished, or runs out, first.
    const was = await p.rowOf(db, me);
    // A subscription whose payment failed is paid in the portal (its card changed), not by a second one beside it,
    // which Stripe would bill as well as the first it still tries.
    if (was?.status === 'past_due' || was?.status === 'unpaid') {
      return c.json({error: 'The payment for this account\'s subscription failed; change how it is paid in Manage', manage: true}, 409);
    }
    if (was?.status === 'incomplete' && was.eventAt && Date.now() - new Date(was.eventAt).getTime() < 86_400_000) {
      return c.json({error: 'A subscription is being made for this account; finish it, or try again tomorrow'}, 409);
    }
    const back = backTo(asked?.back);
    let customer = was?.customer ?? null;
    if (!customer) {
      const [u] = await db.select({email: user.email, name: user.name}).from(user).where(eq(user.id, me)) as {email: string; name: string}[];
      const made = await p.billing.stripe.customer({user: me, email: u.email, name: u.name}).catch(() => refuse(502, {error: 'Stripe did not answer; try again'}));
      if (!CUSTOMER.test(made)) refuse(502, {error: 'Stripe did not answer; try again'});
      // One customer an account: asked twice at once, the first kept is the one used (Stripe's idempotency makes them the same anyway).
      await db.insert(plan).values({userId: me, customer: made}).onConflictDoUpdate({target: plan.userId, set: {customer: made}, setWhere: sql`${plan.customer} is null`});
      customer = (await p.rowOf(db, me))!.customer!;
    }
    // Back to the page that asked, which is told how it went (the plan itself it reads from here, as Stripe tells it).
    const url = await p.billing.stripe.checkout({customer, user: me, tier, price: p.billing.prices[tier]!,
      success: marked(back, 'paid', tier), cancel: marked(back, 'cancelled')})
      .catch(() => refuse(502, {error: 'Stripe did not answer; try again'}));
    return c.json({url});
  });

  v1.post('/plan/portal', async (c) => {
    const me = c.get('userId');
    if (!p.on || !p.billing) return off();
    const row = await p.rowOf(db, me);
    if (!row?.customer) return c.json({error: 'Nothing to manage yet: this account has not subscribed'}, 409);
    const asked = await body<{back?: unknown; tier?: unknown}>(c);
    const back = marked(backTo(asked?.back), 'managed');
    let change;
    // Another tier: the portal opens at the step that changes the subscription to its price, and asks there.
    if (asked?.tier !== undefined && asked.tier !== null) {
      const tier = tierAsked(asked.tier), now = standing(row, p.config!.grace);
      if (!now.paid || !row.subscription) return c.json({error: 'This account has no subscription to change; subscribe to a tier first', checkout: true}, 409);
      if (now.tier === tier) return c.json({error: 'This account is on that tier already', tier}, 409);
      if (row.status !== 'active' && row.status !== 'trialing') {
        return c.json({error: 'The payment for this account\'s subscription failed; change how it is paid in Manage first', manage: true}, 409);
      }
      change = {subscription: row.subscription, item: row.item ?? null, price: p.billing.prices[tier]!};
    }
    const url = await p.billing.stripe.portal({customer: row.customer, back, ...(change ? {change} : {})}).catch(() => refuse(502, {error: 'Stripe did not answer; try again'}));
    return c.json({url});
  });

  // Stripe's events: the body exactly as sent is what is signed. A bad signature changes nothing and says
  // so (Stripe shows it in its dashboard); an event taken before is answered as taken and changes nothing.
  app.post('/v1/stripe/webhook', async (c) => {
    if (!p.billing) return c.json({error: 'This Remote takes no payments'}, 404);
    const billing = p.billing;
    const raw = await c.req.text();
    const now = d.now?.() ?? Date.now();
    if (!await verify(raw, c.req.header('Stripe-Signature'), billing.webhookSecret, now)) return c.json({error: 'The signature does not match'}, 400);
    let event: {id?: unknown; type?: unknown; created?: unknown; data?: {object?: unknown}};
    try { event = JSON.parse(raw); } catch { return c.json({error: 'Not an event'}, 400); }
    const id = str(event.id), type = str(event.type), created = typeof event.created === 'number' ? event.created : 0;
    const object = event.data?.object;
    if (!EVENT.test(id) || !type || type.length > 100 || !created || !object || typeof object !== 'object') return c.json({error: 'Not an event'}, 400);
    if (created * 1000 < now - KEEP_EVENTS) return c.json({received: true, taken: false});
    const tierOf = (price: string) => TIERS.find((t) => billing.prices[t] === price) ?? null;
    const taken = await db.transaction(async (tx: Db) => {
      const fresh = await tx.insert(billingEvent).values({id, type}).onConflictDoNothing().returning({id: billingEvent.id});
      if (!fresh.length) return false;
      await apply(tx, {type, created, data: {object: object as Obj}}, tierOf);
      return true;
    });
    return c.json({received: true, taken});
  });
}
