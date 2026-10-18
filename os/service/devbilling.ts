// A stand-in for Stripe on this machine, for development and the end-to-end
// checks, as devoauth.ts stands in for a sign-in provider: Checkout is a page
// with one button, the portal a page with what Stripe's lets one do, and each
// press sends the Remote the event Stripe would, signed with the webhook
// secret, to its own webhook. Mounted only by dev.ts when it is asked for a
// plan (LENGTH3_PLAN=1), never on Workers; nothing reaches Stripe.

import {Hono} from 'hono';
import {sign, type StripeApi} from './stripe.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const word = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);

/**
 * The stand-in: `base` is the Remote's own address, `secret` the webhook's, `origins` the app's pages,
 * and `deliver` hands a signed event to the Remote (its app, in this process).
 */
export function devBilling(base: string, secret: string, origins: string[], deliver: (payload: string, signature: string) => Promise<Response>) {
  let n = 0;
  /** Back only to one of the app's pages. */
  const back = (v: string | null) => { try { const u = new URL(v ?? ''); return origins.includes(u.origin) ? u.toString() : origins[0]; } catch { return origins[0]; } };
  const api: StripeApi = {
    async customer({user}) { return `cus_dev${word(user)}`; },
    async checkout({customer, user, success}) {
      return `${base}/dev-billing/checkout?${new URLSearchParams({customer, user, back: success})}`;
    },
    async portal({customer, back}) { return `${base}/dev-billing/portal?${new URLSearchParams({customer, back})}`; },
  };
  const send = async (type: string, object: Record<string, unknown>) => {
    const payload = JSON.stringify({id: `evt_dev${Date.now()}x${++n}`, object: 'event', type, created: Math.floor(Date.now() / 1000), data: {object}});
    const r = await deliver(payload, await sign(payload, secret));
    if (!r.ok) throw new Error(`webhook ${r.status}: ${await r.text()}`);
  };
  const sub = (customer: string, user: string, o: Record<string, unknown> = {}) => ({id: `sub_dev${customer.slice(7)}`, object: 'subscription', customer,
    status: 'active', cancel_at_period_end: false, cancel_at: null, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
    metadata: user ? {user} : {}, ...o});
  const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<div style="font:16px system-ui;max-width:440px;margin:15vh auto;display:grid;gap:12px"><h1 style="font-size:20px">${esc(title)}</h1>${body}</div>`;
  const app = new Hono();
  app.get('/checkout', (c) => {
    const q = new URL(c.req.url).searchParams;
    const hidden = ['customer', 'user', 'back'].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? '')}">`).join('');
    return c.html(page('Development payments', `<p>Subscribe to the paid plan. Nothing is charged: this is the Remote on this machine.</p>
<form action="act" method="get" style="display:grid;gap:12px">${hidden}<input type="hidden" name="do" value="subscribe"><button>Subscribe</button></form>
<a href="${esc(back(q.get('back')))}">Back</a>`));
  });
  app.get('/portal', (c) => {
    const q = new URL(c.req.url).searchParams;
    const hidden = ['customer', 'back'].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? '')}">`).join('');
    const act = (what: string, label: string) => `<form action="act" method="get">${hidden}<input type="hidden" name="do" value="${what}"><button>${esc(label)}</button></form>`;
    return c.html(page('Development portal', `${act('cancel', 'Cancel at the end of the period')}${act('resume', 'Keep it')}${act('fail', 'A payment fails')}${act('paid', 'A payment goes through')}${act('end', 'End it now')}
<a href="${esc(back(q.get('back')))}">Back</a>`));
  });
  app.get('/act', async (c) => {
    const q = new URL(c.req.url).searchParams;
    const customer = q.get('customer') ?? '', user = q.get('user') ?? '', what = q.get('do');
    if (!/^cus_dev[A-Za-z0-9]+$/.test(customer)) return c.text('no such customer', 400);
    if (what === 'subscribe') {
      await send('checkout.session.completed', {object: 'checkout.session', mode: 'subscription', customer, client_reference_id: user});
      await send('customer.subscription.created', sub(customer, user));
    } else if (what === 'cancel') await send('customer.subscription.updated', sub(customer, '', {cancel_at_period_end: true}));
    else if (what === 'resume') await send('customer.subscription.updated', sub(customer, ''));
    else if (what === 'fail') {
      await send('invoice.payment_failed', {object: 'invoice', customer});
      await send('customer.subscription.updated', sub(customer, '', {status: 'past_due'}));
    } else if (what === 'paid') {
      await send('invoice.paid', {object: 'invoice', customer});
      await send('customer.subscription.updated', sub(customer, ''));
    } else if (what === 'end') await send('customer.subscription.deleted', sub(customer, '', {status: 'canceled', ended_at: Math.floor(Date.now() / 1000)}));
    else return c.text('nothing to do', 400);
    return c.redirect(back(q.get('back')));
  });
  return {api, app};
}
