// A stand-in OAuth provider on the service itself, for development and the
// end-to-end checks, in two steps as a real provider's are: its page asks
// only for a name (who you are at the provider), then what length3 asks of
// it (your name and email), Allow or Cancel. Allow signs that person in;
// Cancel goes back to the app with the error a real provider sends then
// (access_denied), which the app says on its sign-in card. Mounted only when
// createApp is asked (dev.ts, tests), never on Workers.

import {Hono} from 'hono';

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Who a name is at this provider: its id, and the email it says for them. */
const who = (name: string) => { const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); return {id: `dev-${id}`, email: `${id}@dev.length3.invalid`}; };
const nameOf = (q: URLSearchParams) => (q.get('name') ?? 'Dev Person').trim().slice(0, 100) || 'Dev Person';

// A provider's own look, plain: a card in the middle, its name on top, its buttons at the foot.
const CSS = `*{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:#111827;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{display:grid;place-items:center;min-height:100vh;padding:24px 16px}
.card{width:min(440px,100%);background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 20px;font-weight:600;color:#374151}
.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#111827;color:#fff;font-size:13px;font-weight:700}
.pair{display:flex;align-items:center;justify-content:center;gap:12px;margin:4px 0 20px}
.app{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:#292b2a;color:#fff;font-weight:700}
.dots{color:#9ca3af;letter-spacing:3px}
h1{font-size:20px;margin:0 0 12px;font-weight:650;text-align:center}
p{margin:0 0 12px}.muted{color:#6b7280}.small{font-size:13px}
label{display:block;font-weight:500;margin:0 0 6px}
input[type=text]{width:100%;height:42px;padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
input[type=text]:focus,button:focus-visible,a:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
ul{list-style:none;margin:0 0 16px;padding:0;border:1px solid #e5e7eb;border-radius:8px}
li{display:flex;gap:10px;padding:12px 14px}li+li{border-top:1px solid #e5e7eb}
.tick{color:#16a34a;font-weight:700}
.as{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin:0 0 16px;padding:10px 14px;background:#f9fafb;border-radius:8px}
.foot{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.foot form{margin:0}
button{height:40px;padding:0 18px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;border:1px solid #d1d5db;background:#fff;color:#111827}
button.go{background:#2563eb;border-color:#2563eb;color:#fff}
a{color:#2563eb}`;
const page = (title: string, body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style><main><div class="card"><p class="brand"><span class="mark" aria-hidden="true">D</span>Development provider</p>${body}</div></main></html>`;
const hidden = (q: URLSearchParams, keys: string[]) => keys.map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? '')}">`).join('');

export function devOAuth(): Hono {
  const app = new Hono();
  // A page, unlike everything else the Remote answers (request.ts API_POLICY): its inline style, and its
  // forms, which go on through the provider's redirects to wherever sign-in returns.
  const policy = {'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"};
  app.get('/authorize', (c) => {
    const q = new URL(c.req.url).searchParams;
    return c.html(page('Sign in · Development provider', `<form action="consent" method="get">
<h1>Sign in</h1><p class="muted small">to continue to length3</p>
<label for="name">Your name</label><input type="text" id="name" name="name" value="${esc(q.get('name') ?? 'Dev Person')}" aria-label="Name" autocomplete="off" spellcheck="false">
${hidden(q, ['redirect_uri', 'state'])}<div class="foot"><button class="go">Continue</button></div></form>`), 200, policy);
  });
  // What the app asks of the provider, as a real one asks it: Allow or Cancel.
  app.get('/consent', (c) => {
    const q = new URL(c.req.url).searchParams;
    const name = nameOf(q), {email} = who(name);
    const back = new URLSearchParams({redirect_uri: q.get('redirect_uri') ?? '', state: q.get('state') ?? '', name});
    return c.html(page('length3 wants to access your account', `<div class="pair" aria-hidden="true"><span class="app">l3</span><span class="dots">• • •</span><span class="mark">D</span></div>
<h1>length3 wants to access your Development account</h1>
<div class="as"><span>${esc(name)}<br><span class="muted small">${esc(email)}</span></span><a class="small" href="authorize?${esc(back.toString())}">Not you?</a></div>
<p>This will let length3:</p>
<ul aria-label="What length3 asks for"><li><span class="tick" aria-hidden="true">✓</span><span>Know your name and email</span></li></ul>
<p class="muted small">length3 is given nothing else, and cannot post or change anything here. You can take its access back at any time.</p>
<div class="foot"><form action="deny" method="get">${hidden(q, ['redirect_uri', 'state'])}<button type="submit">Cancel</button></form>
<form action="approve" method="get">${hidden(q, ['redirect_uri', 'state'])}<input type="hidden" name="name" value="${esc(name)}"><button class="go" type="submit">Allow</button></form></div>`), 200, policy);
  });
  app.get('/approve', (c) => {
    const q = new URL(c.req.url).searchParams;
    const to = new URL(q.get('redirect_uri') ?? '/');
    to.searchParams.set('code', b64(JSON.stringify({name: nameOf(q)})));
    to.searchParams.set('state', q.get('state') ?? '');
    return c.redirect(to.toString());
  });
  // Cancelled: back to the app's callback with no code, as OAuth says (RFC 6749 §4.1.2.1), and the same state.
  app.get('/deny', (c) => {
    const q = new URL(c.req.url).searchParams;
    const to = new URL(q.get('redirect_uri') ?? '/');
    to.searchParams.set('error', 'access_denied');
    to.searchParams.set('error_description', 'The person cancelled signing in');
    to.searchParams.set('state', q.get('state') ?? '');
    return c.redirect(to.toString());
  });
  app.post('/token', async (c) => {
    const body = new URLSearchParams(await c.req.text());
    return c.json({access_token: body.get('code') ?? '', token_type: 'Bearer', expires_in: 3600});
  });
  app.get('/userinfo', (c) => {
    const {name} = JSON.parse(unb64((c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, ''))) as {name: string};
    const {id, email} = who(name);
    return c.json({sub: id, id, name, email, email_verified: true});
  });
  return app;
}
