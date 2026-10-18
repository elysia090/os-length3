// The account's plan, as the Remote says it (service/plan.ts): the Remote
// decides what an account may do, and this only shows it and asks. The Plan
// part of Remote's page is drawn from planView(); a place the Remote refused
// for the plan's sake (making a server, claiming a name, keeping more) says
// so in place with planRefusal(), and a way to the Plan.

import {bytes, day} from './dom.ts';
import {isNative, native} from './host.ts';
import {t, tn} from './i18n.ts';
import {api, json, RemoteError} from './remote.ts';

/** What a free account may keep on the Remote. */
export interface Allowance { repos: number; bytes: number; names: number }
/** `none`: this Remote has no plan (everything is open); then nothing else is said. */
export interface Plan {
  plan: 'none' | 'free' | 'paid';
  status?: string | null;
  renews?: number | null;
  ends?: number | null;
  graceUntil?: number | null;
  usage?: {repos: number; bytes: number; names: number};
  free?: Allowance;
  /** Paying is offered here (the Remote has Stripe's keys). */
  buy?: boolean;
  /** There is a subscription to manage. */
  manage?: boolean;
}

export const plan = () => json<Plan>('/v1/plan');

/** A use against what is allowed: what it is, how much, of how much (none: no limit), and the share of it. */
export interface Meter { label: string; used: string; of: string | null; share: number; over: boolean }
export interface PlanView {
  title: string;
  /** The one date that matters, or what free is. */
  line: string;
  meters: Meter[];
  /** What paid adds, in plain words. */
  adds: string[];
  /** The one deed: subscribe (Checkout) or manage (the portal); null when neither can be done here. */
  action: {kind: 'checkout' | 'portal'; label: string} | null;
  note: string | null;
}

/** What paid adds, the same words wherever they are said. */
export const PAID_ADDS = () => [t('Keep more than the free allowance on the Remote'), t('Make servers: boards and talk with people you know'),
  t('Names on your own domain (name@yourdomain), and more names here')];

/** The Plan part, from what the Remote said. */
export function planView(p: Plan, now = Date.now()): PlanView {
  const paid = p.plan === 'paid', use = p.usage ?? {repos: 0, bytes: 0, names: 0}, free = p.free ?? {repos: 0, bytes: 0, names: 0};
  const line = paid
    ? p.graceUntil ? t('A payment did not go through · paid until {date}', {date: day(p.graceUntil)})
      : p.ends ? t('Ends {date}', {date: day(p.ends)})
      : p.renews ? t('Renews {date}', {date: day(p.renews)}) : t('Paid, with no end set')
    : p.status === 'canceled' && p.ends && p.ends <= now ? t('Ended {date}; what you made stays', {date: day(p.ends)})
      : p.status === 'past_due' || p.status === 'unpaid' ? t('A payment did not go through; free until one does')
      : t('Keeps {repos} and {bytes} on the Remote, and one name', {repos: tn('{n} repo', '{n} repos', free.repos), bytes: bytes(free.bytes)});
  const meter = (label: string, used: number, of: number, show: (n: number) => string): Meter =>
    ({label, used: show(used), of: paid ? null : show(of), share: paid || of <= 0 ? 0 : Math.min(1, used / of), over: !paid && used > of});
  const meters = [meter(t('Repos on the Remote'), use.repos, free.repos, String), meter(t('Kept on the Remote'), use.bytes, free.bytes, bytes)];
  // Paid, it is managed (or cancelled) where it was bought; free, even after a subscription ended, subscribed to.
  const action = paid
    ? (p.buy && p.manage ? {kind: 'portal' as const, label: t('Manage the plan')} : null)
    : p.buy ? {kind: 'checkout' as const, label: t('Subscribe')} : null;
  const note = !p.buy && !paid ? t('Paid features cannot be bought on this Remote yet') : meters.some((m) => m.over)
    ? t('The Remote keeps what is there; what is new stays on your device until there is room') : null;
  return {title: paid ? t('Paid plan') : t('Free plan'), line, meters, adds: PAID_ADDS(), action, note};
}

/** What the Remote refused for the plan's sake: which rule, and whether paying is offered here. */
export interface PlanRefusal { rule: 'repos' | 'bytes' | 'server' | 'domain' | 'names'; buy: boolean }

export function planRefusal(e: unknown): PlanRefusal | null {
  if (!(e instanceof RemoteError) || e.status !== 402) return null;
  const rule = e.detail.rule as PlanRefusal['rule'];
  return ['repos', 'bytes', 'server', 'domain', 'names'].includes(rule) ? {rule, buy: e.detail.buy === true} : null;
}

/** The refusal in place: what is paid, and what happens to the work (it stays here). */
export function refusalWords(r: PlanRefusal): string {
  const said = {
    repos: t('The free plan keeps no more repos on the Remote. This one stays on your device.'),
    bytes: t('The free plan keeps no more on the Remote. What changed stays on your device.'),
    server: t('Making a server is part of the paid plan.'),
    domain: t('A name on your own domain is part of the paid plan.'),
    names: t('More names on this Remote are part of the paid plan.'),
  }[r.rule];
  return r.buy ? said : `${said} ${t('Paid features cannot be bought on this Remote yet.')}`;
}

/**
 * Go to Checkout or the portal. On the web the page goes there and comes back
 * (`back`); the app opens it in the browser (its core asks the Remote, and opens
 * only a page of Stripe's or the Remote's own).
 */
export async function openPlan(kind: 'checkout' | 'portal', back = location.href): Promise<void> {
  if (isNative) { await native('plan_open', {kind}); return; }
  const r = await api(`/v1/plan/${kind}`, {method: 'POST', body: JSON.stringify({back})});
  const body = await r.json() as {url?: string; error?: string};
  if (!r.ok || !body.url) throw new RemoteError(r.status, t(body.error ?? `Remote: ${r.status}`));
  location.assign(body.url);
}
