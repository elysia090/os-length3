# The Remote

What lives on the Remote and stays there however the OS is reached: a
browser, the desktop app or l3. The app and l3 run the OS on the device,
but who someone is, the canonical copy of their repos, their names and the
people they work with are kept here, so every device answers to the same
account and agrees with the others. This is the map of that: each part,
its routes, its tables and who uses it. What the Remote is for, in prose, is
`DESIGN.md` §6 ("The canonical copy is on the Remote"); this file is the
reference beside the code, which is why it is here and not there (DESIGN.md
names no routes or tables).

Clients: **page** is the web app (in a browser, and in the desktop app's
webview: the same code, `src/`); **core** is the native side (`core/src`),
which the desktop app's commands (`src-tauri`) and l3 (`cli/`) both use.
**anyone** needs no session.

## The parts

One module a part, its routes, rules and queries together; `app.ts` only
assembles them, `request.ts` holds what every request shares (the origins
that may call, body limits, `LIMIT`, refusals, the account's lock and room,
and `failed`: what no route foresaw is JSON too, `{error, id}`, 503 with
`Retry-After` when the database is busy or out of reach, else 500, the id
in the log beside it), `auth.ts` who is asking (`signedIn`).

| Part | Module | Routes | Tables | Clients |
|---|---|---|---|---|
| What this Remote is | `about.ts` | `GET /v1/about`, `GET /v1/health`, `GET /.well-known/security.txt` (RFC 9116) | (reads nothing; health `select 1`) | page, core (app and l3 read `app` to know where a device code is approved), deploy |
| Who someone is | `auth.ts` (Better Auth), `devoauth.ts` | `/api/auth/*`: social sign-in, passkeys, `get-session`, `list-sessions`, `revoke-session`, `sign-out`, linked providers; the device flow `device/code`, `device/token` (core), `device`, `device/approve`, `device/deny` (page); `/dev-oauth/*` only where `dev` is offered | `user`, `session`, `account`, `verification`, `passkey`, `device_code`, `rate_limit`; `guard` (a passkey sign-in is proof of presence) | page, core |
| A Remote for research | `enter.ts` | `POST /v1/enter` | `user`, `session`, `guard`, `throttle` | page |
| File contents and releases | `files.ts`, `bucket.ts`, `releases.ts` (what is pinned), `mirror.ts` (the deploy puts it in the bucket) | `GET /v1/os/:sha`, `GET /v1/desktop/:file` (anyone, Range, streamed), `POST /v1/blobs/missing`, `PUT/GET /v1/blobs/:sha` | `blob` (and `room.used`, by trigger); bytes in the bucket: `u/USER/SHA`, `os/SHA`, `desktop/FILE` | page (the desktop app's download), core (`/v1/os` for a Prompt's root, falling back to the release) |
| Repos kept | `repos.ts` | `GET /v1/moved`; `/v1/repos`, `/v1/repos/gone`, `/v1/repos/:name` (`?line=`), `draft`, `cuts`, `cuts/:id`, `log`, `lines`, `lines/:line/push`, `changes`, `changes/:id/reviews\|merge\|reject\|reset`, `off`, `on`, `discard`; `/v1/off-code` | `repo`, `line`, `cut`, `change`, `review`, `repo_gone`, `room` (stamp, used), `guard` (the code), `throttle` (wrong codes) | page, core (sync, history, work); off and discard only from the page (they ask a passkey) |
| The plan and billing | `plan.ts` (the rules and routes), `stripe.ts` (Stripe's REST and webhook signatures), `devbilling.ts` (a stand-in for Stripe in `dev.ts`) | `GET /v1/plan`, `POST /v1/plan/checkout`, `POST /v1/plan/portal`; `POST /v1/stripe/webhook` (anyone, signed by Stripe); its rules are asked by the routes that make something new: a new repo and a draft that grows (`repos.ts` PATCH draft), making a server (`servers.ts`), claiming a name (`inbox.ts`), each 402 with the rule | `plan`, `billing_event`; reads `repo`, `room.used` (counted again from the rows by the sweep), `address` | page (Remote → Plan), core (`l3 remote plan`); 402 is said in place and the work stays on the device |
| Home | `home.ts` | `GET/PUT /v1/home/:key` (profile, todo, dotfiles) | `home` | page, core |
| Names and Inbox | `inbox.ts`, `names.ts` | `/v1/inbox/me`, `addresses` (claim, renew, let go), `domains/:domain`, `lookup`, `messages`, `threads`, `threads/:address(/read)`, `contacts`, `signals` (send), `signals/take` (POST: taking deletes); `GET /.well-known/length3` (anyone: other Remotes) | `address`, `principal_code`, `contact`, `message`, `signal`, `throttle` | page, core (l3 name, l3 inbox) |
| Servers, boards, guests | `servers.ts` | `/v1/servers…` (people, boards, renew, back), `/v1/boards/:id…` (todos, posts, seen, archive, invites, guests), `/v1/open…` (anyone: open boards, a guest by invitation) | `server`, `server_member`, `board`, `board_todo`, `board_post`, `board_seen`, `board_invite`, `board_guest`, `throttle` | page, core (l3 server, `archive` as text) |
| Who sees a repo | `seen.ts` | `GET /v1/seen`, `PUT /v1/repos/:name/seen`, `/v1/servers/:id/repos…`; `GET /v1/seen/:face/:name(/file)` (anyone, when public) | `repo_share`, `repo_public` | page |
| News | `news.ts` | `GET /v1/news` | reads `message`, `contact`, `board_post`, `board_seen` | page |
| SSH, per device | `ssh.ts` | `GET /v1/ssh`, `POST /v1/ssh/:device/off` (any session); `PUT/DELETE /v1/ssh/this`, `POST /v1/ssh/this/beat` (the device itself: refused with an Origin) | `ssh` (one row a session: its scope, `device` or `network`, and when; never an address, port or repo) | core (the listener), page (see, stop) |
| The sweep | `sweep.ts`, `worker.ts` `scheduled` | (none: once a day, and when `dev.ts` starts) | every table above (Stripe's events 30 days old; each changed room counted again from its rows); the bucket's unnamed blobs | |

`GET /v1/repos/gone` is asked by no client today (a device learns a repo
went from `GET /v1/repos/:name`'s `gone` and `PATCH draft`'s 410); the tests
read the sweep through it.

## What native and l3 need that the web does not

- **The device flow.** The app and l3 hold no passkey and no cookie: they
  ask `device/code`, a browser where the person is signed in approves it
  on the app's origin (`/v1/about` `app`, so a Remote reached by another
  name sends them to its own page only), and they poll `device/token` for a
  session of their own, sent as a bearer token. Each device is a session,
  listed and ended from any other (`list-sessions`, `revoke-session`).
- **Requests without an Origin.** core never sends one; `signedIn` takes a
  bearer token from anywhere and a cookie only from the app's own pages,
  and `PUT /v1/ssh/this` is refused to anything with an Origin, so only a
  device turns its own SSH on.
- **The desktop webview's origins** (`APP_ORIGINS`: `tauri://localhost`,
  `http://tauri.localhost`) in CORS and Better Auth's trusted origins.
- **Roots by digest** (`/v1/os/:sha`, Range), which the app's Prompt
  installs from, falling back to the publisher's release.
- **Text to take home** (`/v1/boards/:id/archive`, markdown) for `l3 server get`.

## A Remote without a bucket

The database and the bucket are separate: Postgres (Neon) holds every row,
the bucket (R2) only bytes. With no bucket bound, the Remote starts and
answers everything that does not move bytes, and each route that would
(`PUT/GET /v1/blobs/:sha`, `GET /v1/os/:sha`, `GET /v1/desktop/:file`,
`GET /v1/seen/:face/:name/file`)
answers one thing:

    503 {"error": "The Remote cannot hold files just now", "files": false}

`POST /v1/blobs/missing` still answers (it reads rows), so a client finds
what to send, is told the Remote cannot take it, and keeps the work where it
is: the web keeps the repo as not sent yet (まだ送れていません) and tries
again later, core and l3 say so (`The Remote cannot hold files just now; your work stays on this device`,
`Remote はいまファイルを置けません。作業はこの端末に残ります`)
and leaves what was agreed as it was. The sweep leaves blobs alone while
there is no bucket to take their bytes from; it still counts each changed room
again, which the plan reads.

On Workers that is a Worker without its `BLOBS` binding; here,
`node service/dev.ts DIR --no-bucket` (or `LENGTH3_NO_BUCKET=1`). The
contract tests run twice, with a bucket and without
(`contract.test.ts`, `contract.nobucket.test.ts`), and `worker.test.ts`
runs the Worker itself, with no bucket, through its Neon driver.

## Against a real database

    DATABASE_URL='postgresql://…' npm run verify:remote

(`verify.ts`) makes a database of its own on that server
(`remote_verify_<time>_<hex>`), migrates it with `migrateRemote`
(`neon.ts`, the function `deploy.ts` runs), runs `contract.test.ts` there
with no bucket through the Worker's own pool code (`worker.ts` `open` and
`served`: `@neondatabase/serverless` over WebSocket, straight to a Neon
host, through `bridge.ts` to a Postgres on this machine), and drops that
database, and `remote_app` only if its migrations made it. It refuses what
looks like production unless `--production`, and never prints the URL or
anything in it. README.md, Deploy, says how to run it on a Neon branch.

## What every request passes, and the one secret

What the Remote holds itself to, item by item against OWASP ASVS 4.0.3
L2, RFC 9700, RFC 8628 and WebAuthn, is tested in `security.test.ts`
(each test names its items). In short:

- **Headers** (`request.ts` `unkept`). Every answer: `Cache-Control:
  no-store`, `nosniff`, `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (the
  Remote answers data, never a page; the stand-in provider's page says its
  own), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS a
  year with subdomains, `Cross-Origin-Resource-Policy: same-origin`. The
  app's own files get theirs from `public/_headers`.
- **CORS** (`fromOrigins`): only the app's origins (`APP_ORIGIN`,
  `APP_ORIGINS`) are answered, with credentials; a preflight is kept ten
  minutes.
- **Cross-site requests** (`auth.ts` `signedIn`). A bearer token is taken
  from anywhere (no other site's page can send one). The session cookie
  alone is taken for a write only with one of the app's `Origin`s, and for
  a read only when the browser does not say another site started it
  (`Sec-Fetch-Site: cross-site` or `same-site` without the app's origin is
  403). No GET changes anything a person would miss: taking WebRTC signals
  is `POST /v1/inbox/signals/take` (a GET of them is 405).
- **Bodies** are counted as they come and refused past what the route takes
  (`bounded`, `roomFor`: 16 MB for a file, a draft's diff or a setting,
  1 MB for anything else, Stripe's webhook too), before anything parses them.
- **Asking too often** is `429` with `Retry-After` and `retryAfter` (seconds)
  beside the words, everywhere a rate refused (`slowDown`; Better Auth's own
  are said the same way). Per address (`CF-Connecting-IP`, only behind
  Cloudflare): Better Auth's routes (120 a minute; social sign-in 3 in
  10 s; `device/code`, `device/approve`, `device/deny`, the passkey
  ceremonies 10 a minute; `device/token` 40; looking a user code up 5 in its
  10 minutes: `AUTH_LIMITS`), a research link's key (20 an hour), joining a
  board as a guest (30 an hour), resolving a code signed out (30 an hour).
  Per account: codes looked up, messages, signals, posts, servers made, wrong
  off-codes.
- **Passkeys** must verify the person (PIN or biometrics) when made and when
  used; the relying party is `APP_ORIGIN`'s host and its origin is checked;
  a counter that goes back is refused (SimpleWebAuthn); attestation is not
  asked for.
- **Cookies** over HTTPS are `__Host-length3.*`: Secure, HttpOnly,
  SameSite=Lax, Path=/, no Domain.

### The secret, and rotating it

The Worker is given one secret, `BETTER_AUTH_SECRET` (made once by
`deploy.ts`, 48 random bytes). Nothing uses it as it is: each purpose has a
key derived from it with HKDF-SHA256 under its own label (`keys.ts`):
`better-auth` (sign-in's cookies and state), `domain-proof` (an Inbox
domain's TXT proof), `invite` (what is kept of an invitation and a guest's
token) and `off-code` (what is kept of the code that turns a repo off, an
HMAC, so a copy of the database does not give the codes up). Before
`keys.ts` the secret itself keyed all of these and the off-code was a bare
digest; the Remote had no accounts in production when this changed, so
nothing was carried over.

To rotate it (a leak, or someone who held it leaving), put a new one, 48
random bytes as base64url, with `npx wrangler secret put BETTER_AUTH_SECRET`
(it reads the value on its standard input). Then, at once and by design:
every session ends (everyone signs in again; devices pair again), every
custom domain's TXT record must be given anew (the Remote shows the new one
under Inbox; until then the address lapses, and is let go after its hold),
invitations out and guests' tokens stop opening their boards, and every
account sets its off-code again. One purpose's key alone can be moved on by
raising its version in `keys.ts`. The other secrets (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, the providers' client secrets, `ENTER_KEY`) are
each rotated where they are made (Stripe's dashboard rolls a webhook secret
with both valid for a while; `deploy.ts link` for `ENTER_KEY`) and put with
`wrangler secret put`.
