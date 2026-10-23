// The Worker the production-like selftest runs on workerd: service/worker.ts
// itself, its fetch and its scheduled as they are, with only what this
// machine needs in place of Cloudflare's network around it:
//
//   - the Neon driver reaches the Postgres here through the bridge
//     (wsbridge.ts) named by LOCAL_WS_PROXY, plain inside the WebSocket and
//     its startup pipelined, as it reaches Neon's proxy (inside TLS);
//   - with LOCAL_STRIPE=1, Stripe's REST API is answered here by the
//     stand-in dev.ts uses (devbilling.ts), whose pages are /dev-billing/*
//     and whose events reach the Worker's own webhook, signed with its
//     STRIPE_WEBHOOK_SECRET: nothing reaches Stripe;
//   - each answer says how long the Worker took (Server-Timing: worker;dur=),
//     as workerd's clock tells it (it moves with I/O, not with CPU alone).
//
// Nothing here is deployed: wrangler.toml's main is service/worker.ts.

import {neonConfig} from '@neondatabase/serverless';
import {devBilling} from '../../service/devbilling.ts';
import worker, {type Env} from '../../service/worker.ts';

type Local = Env & {LOCAL_WS_PROXY?: string; LOCAL_STRIPE?: string};
interface Ctx { waitUntil(p: Promise<unknown>): void }

let wired = false;
let billing: ReturnType<typeof devBilling> | null = null;

function wire(env: Local, ctx: Ctx) {
  if (wired) return;
  wired = true;
  if (env.LOCAL_WS_PROXY) {
    const at = env.LOCAL_WS_PROXY;
    neonConfig.wsProxy = (host, port) => `${at}/v1?address=${host}:${port}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.forceDisablePgSSL = true;
    neonConfig.pipelineTLS = false;
    // As to Neon: startup and password in one go (the Postgres here takes remote_worker's password so).
    neonConfig.pipelineConnect = 'password';
  }
  if (env.LOCAL_STRIPE === '1' && env.STRIPE_WEBHOOK_SECRET) {
    const b = billing = devBilling(env.BASE_URL, env.STRIPE_WEBHOOK_SECRET, [env.APP_ORIGIN, ...(env.APP_ORIGINS ?? '').split(/\s+/).filter(Boolean)],
      (payload, signature) => worker.fetch(new Request(`${env.BASE_URL}/v1/stripe/webhook`, {method: 'POST', body: payload,
        headers: {'Stripe-Signature': signature, 'Content-Type': 'application/json'}}), env, ctx));
    const real = globalThis.fetch;
    // Stripe's REST API, as stripe.ts asks it (form-encoded POSTs), answered by the stand-in.
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.stripe.com/v1/')) return real(input, init);
      const form = new URLSearchParams(String(init?.body ?? ''));
      const path = url.slice('https://api.stripe.com/v1/'.length);
      // The price, as a GET of prices/<id> (what the Plan shows before anyone pays).
      if (path.startsWith('prices/')) {
        const p = await b.api.price();
        return Response.json({id: path.slice(7), unit_amount: p.amount, currency: p.currency, recurring: {interval: p.interval, interval_count: p.every}});
      }
      const id = `${path.replace(/\W/g, '_')}_${Date.now().toString(36)}`;
      if (path === 'customers') return Response.json({id: await b.api.customer({user: form.get('metadata[user]') ?? '', email: form.get('email') ?? '', name: form.get('name') ?? ''})});
      if (path === 'checkout/sessions') return Response.json({id, url: await b.api.checkout({customer: form.get('customer') ?? '', user: form.get('client_reference_id') ?? '',
        success: form.get('success_url') ?? '', cancel: form.get('cancel_url') ?? ''})});
      if (path === 'billing_portal/sessions') return Response.json({id, url: await b.api.portal({customer: form.get('customer') ?? '', back: form.get('return_url') ?? ''})});
      return Response.json({error: {message: `the stand-in has no ${path}`}}, {status: 404});
    };
  }
}

export default {
  async fetch(request: Request, env: Local, ctx: Ctx) {
    wire(env, ctx);
    const began = Date.now();
    const path = new URL(request.url).pathname;
    const r = billing && path.startsWith('/dev-billing/')
      ? await billing.app.fetch(new Request(request.url.replace('/dev-billing/', '/'), request))
      : await worker.fetch(request, env, ctx);
    const out = new Response(r.body, r);
    out.headers.append('Server-Timing', `worker;dur=${Date.now() - began}`);
    return out;
  },
  async scheduled(event: unknown, env: Local, ctx: Ctx) {
    wire(env, ctx);
    return worker.scheduled(event, env, ctx);
  },
};
