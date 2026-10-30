// The account's plan, as the Remote says it (service/plan.ts): the Remote
// decides what an account may do, and this only shows it and asks. The Plan
// part of Remote's page is drawn from planView(): the tier the account is on,
// its use against what that tier keeps, and free and the three paid tiers side
// by side. A place the
// Remote refused for the plan's sake (making a server, claiming a name,
// keeping more) says so in place with planRefusal(), and a way to the Plan.

import {bytes, day} from '../ui/dom.ts';
import {isNative, native} from '../app/host.ts';
import {t, tn} from '../i18n.ts';
import {api, json, leaveFor, RemoteError} from './connection.ts';

/** The tiers one pays for, the least first, and free before them. */
const PAID_TIERS = ['go', 'pro', 'max'] as const;
export type PaidTier = typeof PAID_TIERS[number];
export type Tier = 'free' | PaidTier;
export const isPaidTier = (v: unknown): v is PaidTier => PAID_TIERS.includes(v as PaidTier);
/** A tier's name in a sentence: its own (Go, Pro, Max), or the free plan in the language spoken. */
export const tierName = (tier: Tier): string => (tier === 'free' ? t('Free plan') : {go: 'Go', pro: 'Pro', max: 'Max'}[tier]);
/** A tier as its card and the Plan's head name it: Free plan, Go plan, Pro plan, Max plan. */
const planName = (tier: Tier): string => (tier === 'free' ? t('Free plan') : t('{tier} plan', {tier: tierName(tier)}));

/** What an account may keep on the Remote; null, as many as fit. */
export interface Allowance { repos: number | null; bytes: number; names: number | null }
/** A tier as the Remote says it: what it keeps, whether it is sold here, and what it costs when Stripe could say. */
export interface TierSaid { tier: Tier; allowance: Allowance; sold?: boolean; price?: Price }
/** `none`: this Remote has no plan (everything is open); then nothing else is said. */
export interface Plan {
  plan: 'none' | 'free' | 'paid';
  /** The tier the account is on: free, or the one it pays for. */
  tier?: Tier;
  status?: string | null;
  renews?: number | null;
  ends?: number | null;
  graceUntil?: number | null;
  usage?: {repos: number; bytes: number; names: number};
  /** What the account's tier keeps. */
  allowance?: Allowance;
  free?: Allowance;
  /** Free and each tier sold here (and the account's own), the least first. */
  tiers?: TierSaid[];
  /** Paying is offered here (the Remote has Stripe's keys and a price). */
  buy?: boolean;
  /** There is a subscription to manage. */
  manage?: boolean;
}

export interface Price { amount: number; currency: string; interval: 'day' | 'week' | 'month' | 'year'; every: number }

/** A price in words: ¥800 a month, $5 every 3 months, $4.50 a week (a whole amount has no .00 to read past). */
export function priceWords(p: Price, lang = 'en'): string {
  const currency = p.currency.toUpperCase();
  let money: string;
  try {
    const f = new Intl.NumberFormat(lang, {style: 'currency', currency});
    // Stripe says the amount in the currency's smallest unit: as many places as the currency has.
    const amount = p.amount / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2);
    money = Number.isInteger(amount) ? new Intl.NumberFormat(lang, {style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0}).format(amount)
      : f.format(amount);
  } catch { money = `${p.amount} ${currency}`; }
  const one = {day: t('{price} a day', {price: money}), week: t('{price} a week', {price: money}), month: t('{price} a month', {price: money}),
    year: t('{price} a year', {price: money})}[p.interval];
  if (p.every === 1) return one;
  return {day: t('{price} every {n} days', {price: money, n: p.every}), week: t('{price} every {n} weeks', {price: money, n: p.every}),
    month: t('{price} every {n} months', {price: money, n: p.every}), year: t('{price} every {n} years', {price: money, n: p.every})}[p.interval];
}

/** What subscribing to `tier` is, said before anyone is sent to pay: that it renews, how it ends, what stays. */
export const TERMS = (tier: PaidTier) => [t('Renews automatically until you cancel'),
  t('Cancel any time from Manage the plan; {tier} stays until the paid period ends', {tier: tierName(tier)}),
  t('Nothing you made is lost if it ends')];

/**
 * How the last trip to Stripe went, as the page it came back to was told (?plan=paid&tier=…, ?plan=cancelled
 * from Checkout; ?plan=managed from the portal), kept for this tab until the Plan says it.
 */
export interface Back { how: 'paid' | 'cancelled' | 'managed'; tier: PaidTier | null }
const RETURN = 'length3.plan-return';
export function cameBackFromStripe(how: string, tier: string | null) {
  if (how !== 'paid' && how !== 'cancelled' && how !== 'managed') return;
  try { sessionStorage.setItem(RETURN, JSON.stringify({how, tier: isPaidTier(tier) ? tier : null})); } catch { /* said nothing, then: the plan shows as it is */ }
}
export function takeStripeReturn(): Back | null {
  try {
    const kept = JSON.parse(sessionStorage.getItem(RETURN) ?? 'null') as Back | null;
    sessionStorage.removeItem(RETURN);
    return kept && ['paid', 'cancelled', 'managed'].includes(kept.how) ? {how: kept.how, tier: isPaidTier(kept.tier) ? kept.tier : null} : null;
  } catch { return null; }
}

/** The plan as it was when this tab left for the portal: what came back is said against it, once. */
const LEFT = 'length3.plan-left';
export interface Left { tier: Tier; ends: number | null; paid: boolean }
export function leftFor(p: Plan) {
  try { sessionStorage.setItem(LEFT, JSON.stringify({tier: p.tier ?? 'free', ends: p.ends ?? null, paid: p.plan === 'paid'} satisfies Left)); } catch { /* nothing to say against, then */ }
}
export function takeLeft(): Left | null {
  try { const l = JSON.parse(sessionStorage.getItem(LEFT) ?? 'null') as Left | null; sessionStorage.removeItem(LEFT); return l; } catch { return null; }
}
/**
 * What changed in the portal, in a sentence each, from the plan as it was (`was`) to as it is: the end itself; a
 * tier; an end set or taken back; or nothing.
 */
export function changedWords(was: Left, now: Plan): string | null {
  const tier = now.tier ?? 'free';
  if (was.paid && now.plan !== 'paid') return t('The plan has ended; what you made stays.');
  const said = [
    tier !== was.tier && isPaidTier(tier) ? t('You are on {tier} now.', {tier: tierName(tier)}) : '',
    !was.ends && now.ends ? t('Cancelled: {tier} stays until {date}, and nothing more is charged.', {tier: tierName(tier), date: day(now.ends)}) : '',
    was.ends && !now.ends && now.renews ? t('{tier} goes on: it renews {date}.', {tier: tierName(tier), date: day(now.renews)}) : '',
  ].filter(Boolean);
  // One after another as the language writes sentences: a space after a full stop, none after a Japanese one.
  return said.length ? said.reduce((a, s) => (a.endsWith('。') ? a + s : `${a} ${s}`)) : null;
}

export const plan = () => json<Plan>('/v1/plan');

/** A use against what is allowed: what it is, how much, of how much (none: no limit), and the share of it. */
export interface Meter { label: string; used: string; of: string | null; share: number; over: boolean }
/** One tier's card: its name, what it costs, what it keeps, whether it is the account's own, and its one deed. */
export interface TierCard {
  tier: Tier;
  name: string;
  price: string | null;
  keeps: string[];
  current: boolean;
  /** The account keeps more than this tier does: what is there stays, and what would grow waits. */
  over: boolean;
  /** Subscribe (Checkout for it), Upgrade or Downgrade (the portal, at the step that changes to it); none on the account's own. */
  deed: {kind: 'checkout' | 'change'; label: string} | null;
}
export interface PlanView {
  title: string;
  /** The one date that matters, or what free is. */
  line: string;
  /** Said at the heading's right beside the tiers: the line, unless the account's own card says it already (free, as
   * free is); null then. */
  aside: string | null;
  meters: Meter[];
  /** Free and each tier, side by side; none when there is nothing to choose among. */
  tiers: TierCard[];
  /** Manage the plan (the portal), while one is paid for; null otherwise. */
  action: {kind: 'portal'; label: string} | null;
  note: string | null;
}

/** What every paid tier adds besides its room and names, said in each paid tier's own lines, the same words in each. */
const PAID_ADDS = () => [t('Make servers'), t('Names on your own domain (name@yourdomain)')];

/** A size as a tier says it: 50 GB, 256 GB, 100 MB (no .0 on a whole one). */
const size = (n: number) => bytes(n).replace(/\.0 /, ' ');

/** What a tier keeps, in a line each: its room, its repos, its names here. */
function keepsOf(a: Allowance): string[] {
  return [t('{bytes} on the Remote', {bytes: size(a.bytes)}),
    a.repos === null ? t('Repos as many as fit') : tn('{n} repo', '{n} repos', a.repos),
    a.names === null ? t('Names here as many as you like') : tn('{n} name here', '{n} names here', a.names)];
}

const rank = (tier: Tier) => (tier === 'free' ? 0 : PAID_TIERS.indexOf(tier) + 1);
const overOf = (a: Allowance, use: {repos: number; bytes: number; names: number}) =>
  use.bytes > a.bytes || (a.repos !== null && use.repos > a.repos) || (a.names !== null && use.names > a.names);

/**
 * The tier cards: each tier said (`list`), the account's own marked (`mine`), and each one's
 * deed: free, Subscribe on each sold; paid and paying, Upgrade or Downgrade on each other sold; else none.
 */
function cardsOf(list: TierSaid[], o: {mine: Tier; buy: boolean; changing: boolean; lang: string; use?: {repos: number; bytes: number; names: number}}): TierCard[] {
  return list.map((x) => {
    const current = x.tier === o.mine;
    const deed = current || x.tier === 'free' || !x.sold || !o.buy ? null
      : o.mine === 'free' ? {kind: 'checkout' as const, label: t('Subscribe')}
      : o.changing ? {kind: 'change' as const, label: rank(x.tier) > rank(o.mine) ? t('Upgrade') : t('Downgrade')} : null;
    return {tier: x.tier, name: planName(x.tier), price: x.price ? priceWords(x.price, o.lang) : x.tier === 'free' ? t('No charge') : t('Price shown at payment'),
      keeps: [...keepsOf(x.allowance), ...(x.tier === 'free' ? [] : PAID_ADDS())], current, over: !!o.use && !current && overOf(x.allowance, o.use), deed};
  });
}

/** The Plan part, from what the Remote said. */
export function planView(p: Plan, now = Date.now(), lang = 'en'): PlanView {
  const paid = p.plan === 'paid', tier: Tier = p.tier ?? (paid ? 'go' : 'free');
  const use = p.usage ?? {repos: 0, bytes: 0, names: 0}, a = p.allowance ?? p.free ?? {repos: 0, bytes: 0, names: 0};
  const free = p.free ?? a;
  const plain = !paid && !(p.status === 'canceled' && p.ends && p.ends <= now) && p.status !== 'past_due' && p.status !== 'unpaid';
  const line = paid
    ? p.graceUntil ? t('A payment did not go through · paid until {date}', {date: day(p.graceUntil)})
      : p.ends ? t('Ends {date}', {date: day(p.ends)})
      : p.renews ? t('Renews {date}', {date: day(p.renews)}) : t('Paid, with no end set')
    : p.status === 'canceled' && p.ends && p.ends <= now ? t('Ended {date}; what you made stays', {date: day(p.ends)})
      : p.status === 'past_due' || p.status === 'unpaid' ? t('A payment did not go through; free until one does')
      : t('Keeps {repos} and {bytes} on the Remote, and one name', {repos: tn('{n} repo', '{n} repos', free.repos ?? 0), bytes: bytes(free.bytes)});
  const meter = (label: string, used: number, of: number | null, show: (n: number) => string): Meter =>
    ({label, used: show(used), of: of === null ? null : show(of), share: of === null || of <= 0 ? 0 : Math.min(1, used / of), over: of !== null && used > of});
  const meters = [meter(t('Repos on the Remote'), use.repos, a.repos, String), meter(t('Kept on the Remote'), use.bytes, a.bytes, bytes),
    meter(t('Names on this Remote'), use.names, a.names, String)];
  // Paying, another tier is a change of the one there is; a payment that failed is put right first (Manage).
  const changing = paid && !p.graceUntil;
  const cards = cardsOf(p.tiers ?? [], {mine: tier, buy: !!p.buy, changing, lang, use});
  // Paid, it is managed (or cancelled) where it was bought; free, each tier is subscribed to from its card.
  const action = paid && p.buy && p.manage ? {kind: 'portal' as const, label: t('Manage the plan')} : null;
  const note = !p.buy && !paid ? t('Paid features cannot be bought on this Remote yet') : meters.some((m) => m.over)
    ? t('The Remote keeps what is there; what is new stays on your device until there is room') : null;
  const tiers = cards.length > 1 ? cards : [];
  return {title: planName(paid ? tier : 'free'), line, aside: plain && tiers.length ? null : line, meters, tiers, action, note};
}

/** What the Remote refused for the plan's sake: which rule, the tier it is about, and whether paying is offered here. */
export interface PlanRefusal { rule: 'repos' | 'bytes' | 'server' | 'domain' | 'names'; buy: boolean; tier?: Tier }

export function planRefusal(e: unknown): PlanRefusal | null {
  if (!(e instanceof RemoteError) || e.status !== 402) return null;
  const rule = e.detail.rule as PlanRefusal['rule'];
  const tier = isPaidTier(e.detail.tier) ? e.detail.tier : 'free';
  return ['repos', 'bytes', 'server', 'domain', 'names'].includes(rule) ? {rule, buy: e.detail.buy === true, tier} : null;
}

/** The refusal in place: what is paid, or what the tier keeps, and what happens to the work (it stays here). */
export function refusalWords(r: PlanRefusal): string {
  const tier = r.tier && r.tier !== 'free' ? tierName(r.tier) : null;
  const said = tier && (r.rule === 'repos' || r.rule === 'bytes' || r.rule === 'names') ? {
    repos: t('{tier} keeps no more repos on the Remote. This one stays on your device.', {tier}),
    bytes: t('{tier} keeps no more on the Remote. What changed stays on your device.', {tier}),
    names: t('{tier} keeps no more names on this Remote.', {tier}),
  }[r.rule] : {
    repos: t('The free plan keeps no more repos on the Remote. This one stays on your device.'),
    bytes: t('The free plan keeps no more on the Remote. What changed stays on your device.'),
    server: t('Making a server is part of the paid plan.'),
    domain: t('A name on your own domain is part of the paid plan.'),
    names: t('More names on this Remote are part of the paid plan.'),
  }[r.rule];
  return r.buy ? said : `${said} ${t('Paid features cannot be bought on this Remote yet.')}`;
}

/**
 * Go to Checkout for `tier`, or the portal (with `tier`, at the step that changes to it). On the web the page
 * goes there and comes back (`back`); the app opens it in the browser (its core asks the Remote, and opens only
 * a page of Stripe's or the Remote's own).
 */
export async function openPlan(kind: 'checkout' | 'portal', o: {tier?: PaidTier; back?: string} = {}): Promise<void> {
  if (isNative) { await native('plan_open', {kind, ...(o.tier ? {tier: o.tier} : {})}); return; }
  const r = await api(`/v1/plan/${kind}`, {method: 'POST', body: JSON.stringify({back: o.back ?? location.href, ...(o.tier ? {tier: o.tier} : {})})});
  const body = await r.json().catch(() => ({})) as {url?: string; error?: string; tier?: unknown; manage?: boolean; checkout?: boolean};
  if (!r.ok || !body.url) throw new RemoteError(r.status, planError(r.status, body), body as Record<string, unknown>);
  leaveFor(body.url);
}

/** Why the Remote would not open Checkout or the portal, in the app's words: by the tier it names, else as it said it. */
function planError(status: number, body: {error?: string; tier?: unknown; manage?: boolean}): string {
  if (isPaidTier(body.tier)) {
    const tier = tierName(body.tier);
    if (status === 409 && body.manage) return t('This account is on {tier} already; another tier is chosen under Manage the plan', {tier});
    if (status === 409) return t('This account is on {tier} already', {tier});
    if (status === 400) return t('{tier} is not sold on this Remote', {tier});
  }
  return t(body.error ?? `Remote: ${status}`);
}
