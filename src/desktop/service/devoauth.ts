// A stand-in OAuth provider on the service itself, for development and the
// end-to-end checks: its page asks only for a name and signs that person
// in. Mounted only when createApp is asked (dev.ts, tests), never on Workers.

import {Hono} from 'hono';

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function devOAuth(): Hono {
  const app = new Hono();
  app.get('/authorize', (c) => {
    const q = new URL(c.req.url).searchParams;
    const hidden = ['redirect_uri', 'state'].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? '')}">`).join('');
    return c.html(`<!doctype html><meta charset="utf-8"><title>Dev sign-in</title>
<form action="approve" method="get" style="font:16px system-ui;max-width:420px;margin:15vh auto;display:grid;gap:12px">
<h1 style="font-size:20px">Development provider</h1><p>Sign in as</p>
<input name="name" value="Dev Person" aria-label="Name">${hidden}<button>Continue</button></form>`);
  });
  app.get('/approve', (c) => {
    const q = new URL(c.req.url).searchParams;
    const name = (q.get('name') ?? 'Dev Person').trim() || 'Dev Person';
    const to = new URL(q.get('redirect_uri') ?? '/');
    to.searchParams.set('code', b64(JSON.stringify({name})));
    to.searchParams.set('state', q.get('state') ?? '');
    return c.redirect(to.toString());
  });
  app.post('/token', async (c) => {
    const body = new URLSearchParams(await c.req.text());
    return c.json({access_token: body.get('code') ?? '', token_type: 'Bearer', expires_in: 3600});
  });
  app.get('/userinfo', (c) => {
    const {name} = JSON.parse(unb64((c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, ''))) as {name: string};
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return c.json({sub: `dev-${id}`, id: `dev-${id}`, name, email: `${id}@dev.length3.invalid`, email_verified: true});
  });
  return app;
}
