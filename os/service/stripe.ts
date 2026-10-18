// Stripe, as the Remote speaks to it: three calls of its REST API (a
// customer, a Checkout session for the one price, a customer portal session)
// and the check of a webhook's signature. With fetch and Web Crypto only, so
// the same code runs on Workers, in dev and in tests, with nothing to bundle.
//
// Why not the official SDK: on Workers it must be told to use fetch
// (createFetchHttpClient) and an async crypto provider (constructEventAsync)
// anyway, and it brings every resource of the API for the three the Remote
// uses. The REST API is stable per version (Stripe-Version below), and its
// webhook signature is one HMAC (https://docs.stripe.com/webhooks#verify-manually).
//
// Tests never reach Stripe: they hand createApp a StripeApi of their own and
// sign their own events (sign() below). The keys come from Worker secrets
// (worker.ts) and are never written anywhere.

/** What the Remote asks of Stripe. A test or dev gives its own. */
export interface StripeApi {
  /** A customer for this account; the same account asking again within a day gets the same one (Idempotency-Key). */
  customer(p: {user: string; email: string; name: string}): Promise<string>;
  /** A Checkout session subscribing `customer` to the price; its URL. */
  checkout(p: {customer: string; user: string; success: string; cancel: string}): Promise<string>;
  /** A customer portal session (manage, cancel, change the card); its URL. */
  portal(p: {customer: string; back: string}): Promise<string>;
}

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

/** The REST API with this secret key, subscribing to `price`. */
export function stripeRest(key: string, price: string, f: typeof fetch = fetch): StripeApi {
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
    checkout: async ({customer, user, success, cancel}) => (await post('checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: user, success_url: success, cancel_url: cancel,
      line_items: {0: {price, quantity: 1}}, subscription_data: {metadata: {user}}, metadata: {user},
    })).url ?? '',
    portal: async ({customer, back}) => (await post('billing_portal/sessions', {customer, return_url: back})).url ?? '',
  };
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
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
export const TOLERANCE = 300;

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
