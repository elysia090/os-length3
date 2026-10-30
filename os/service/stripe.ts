// Stripe, as the Remote speaks to it: four calls of its REST API (a
// customer, a Checkout session for a tier's price, a customer portal session,
// what a price is) and the check of a webhook's signature. With fetch and Web
// Crypto only, so the same code runs on Workers, in dev and in tests, with
// nothing to bundle.
//
// Why not the official SDK: on Workers it must be told to use fetch
// (createFetchHttpClient) and an async crypto provider (constructEventAsync)
// anyway, and it brings every resource of the API for the four the Remote
// uses. The REST API is stable per version (Stripe-Version below), and its
// webhook signature is one HMAC (https://docs.stripe.com/webhooks#verify-manually).
//
// Tests never reach Stripe: they hand createApp a StripeApi of their own and
// sign their own events (sign() below). The keys come from Worker secrets
// (worker.ts) and are never written anywhere; the prices, one a tier, are
// variables (STRIPE_PRICE_GO, STRIPE_PRICE_PRO, STRIPE_PRICE_MAX).

/** What the Remote asks of Stripe. A test or dev gives its own. */
export interface StripeApi {
  /** A customer for this account; the same account asking again within a day gets the same one (Idempotency-Key). */
  customer(p: {user: string; email: string; name: string}): Promise<string>;
  /** A Checkout session subscribing `customer` to `price`, the price of `tier`; its URL. */
  checkout(p: {customer: string; user: string; tier: string; price: string; success: string; cancel: string}): Promise<string>;
  /**
   * A customer portal session (the card, the invoices, cancelling); its URL. With `change`, it opens at the
   * step that changes the subscription to that price (Stripe says what it costs now, and asks), and goes back
   * to `back` once it is done.
   */
  portal(p: {customer: string; back: string; change?: Change}): Promise<string>;
  /** What a price is: so much (in the currency's smallest unit), every so many days, weeks, months or years. */
  price(id: string): Promise<Price>;
}

/** A change of tier asked in the portal: the subscription, its one item (when it is known), the price it is to. */
export interface Change { subscription: string; item: string | null; price: string }

/** A price as Stripe says it, as much as a person is shown before paying. */
export interface Price { amount: number; currency: string; interval: 'day' | 'week' | 'month' | 'year'; every: number }

/** The API version the Remote's requests are read as. */
export const STRIPE_VERSION = '2024-06-20';

/** Stripe's form encoding: nested keys as a[b][c]. */
export function form(o: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') out.push(...form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

/** The REST API with this secret key. */
export function stripeRest(key: string, f: typeof fetch = fetch): StripeApi {
  const post = async (path: string, body: Record<string, unknown>, idem?: string): Promise<{id: string; url?: string}> => {
    const r = await f(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': STRIPE_VERSION,
        ...(idem ? {'Idempotency-Key': idem} : {})},
      body: form(body).join('&'),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json().catch(() => ({})) as {id?: string; url?: string; error?: {message?: string}};
    // Said in the log, never to the person: Stripe's words may name the account's keys or settings.
    if (!r.ok || !j.id) { console.error('stripe', path, r.status, j.error?.message ?? ''); throw new Error(`Stripe ${r.status}`); }
    return j as {id: string; url?: string};
  };
  return {
    customer: async ({user, email, name}) => (await post('customers', {email, name, metadata: {user}}, `customer-${user}`)).id,
    // Asked twice for the same tier from the same page within ten minutes (a double click, a retry after a lost
    // answer), it is the same Checkout, not two, each of which could be paid for (two subscriptions, billed both).
    // Another tier is another key: Stripe refuses one used again with other words.
    checkout: async ({customer, user, tier, price, success, cancel}) => (await post('checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: user, success_url: success, cancel_url: cancel,
      line_items: {0: {price, quantity: 1}}, subscription_data: {metadata: {user, tier}}, metadata: {user, tier},
    }, `checkout-${user}-${Math.floor(Date.now() / 600_000)}-${(await sha(`${price}\n${success}\n${cancel}`)).slice(0, 16)}`)).url ?? '',
    // A change of tier opens at its own step: confirming it, when the subscription's item is known (then back to the
    // page that asked); else choosing there, among the prices the portal is set to offer.
    portal: async ({customer, back, change}) => (await post('billing_portal/sessions', {customer, return_url: back,
      ...(change ? {flow_data: change.item
        ? {type: 'subscription_update_confirm', subscription_update_confirm: {subscription: change.subscription, items: {0: {id: change.item, price: change.price, quantity: 1}}},
          after_completion: {type: 'redirect', redirect: {return_url: back}}}
        : {type: 'subscription_update', subscription_update: {subscription: change.subscription}}} : {})})).url ?? '',
    async price(price) {
      const r = await f(`https://api.stripe.com/v1/prices/${encodeURIComponent(price)}`, {
        headers: {Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_VERSION}, signal: AbortSignal.timeout(10_000)});
      const j = await r.json().catch(() => ({})) as {unit_amount?: number; currency?: string; recurring?: {interval?: string; interval_count?: number}};
      const interval = j.recurring?.interval;
      if (!r.ok || typeof j.unit_amount !== 'number' || typeof j.currency !== 'string' || !['day', 'week', 'month', 'year'].includes(interval ?? '')) {
        console.error('stripe', 'prices', r.status);
        throw new Error(`Stripe ${r.status}`);
      }
      return {amount: j.unit_amount, currency: j.currency, interval: interval as Price['interval'], every: j.recurring?.interval_count ?? 1};
    },
  };
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (text: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
async function hmac(secret: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}
/** The same, in time that does not depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** How far a signature's time may be from now: Stripe's own libraries take five minutes. */
const TOLERANCE = 300;

/**
 * Whether `payload` (the body exactly as it came) was signed with `secret`:
 * the Stripe-Signature header is `t=<seconds>,v1=<hex HMAC-SHA256 of "t.payload">`
 * (more than one v1 while a secret is being rolled). A time too far from now is
 * refused too, so an old event replayed with its old signature is not taken.
 */
export async function verify(payload: string, header: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const v1 = parts.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v);
  if (!Number.isInteger(t) || !v1.length || Math.abs(now / 1000 - t) > TOLERANCE) return false;
  const want = await hmac(secret, `${t}.${payload}`);
  return v1.some((v) => same(v, want));
}

/** A Stripe-Signature for `payload` at `t` (seconds): what Stripe sends; tests and dev's stand-in sign with it. */
export async function sign(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmac(secret, `${t}.${payload}`)}`;
}
