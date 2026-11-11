# The Remote

What lives on the Remote and stays there however the OS is reached: a
browser, the desktop app or root3. The app and root3 run the OS on the device,
but who someone is, the canonical copy of their repos, their names and the
people they work with are kept here, so every device answers to the same
account and agrees with the others. This is the map of that: each part,
its routes, its tables and who uses it. What the Remote is for, in prose, is
`DESIGN.md` §6 ("The canonical copy is on the Remote"); this file is the
reference beside the code, which is why it is here and not there (DESIGN.md
names no routes or tables).

Clients: **page** is the web app (in a browser, and in the desktop app's
webview: the same code, `src/`); **core** is the native side (`root3/core/src`),
which the desktop app's commands (`desktop`) and root3 (`cli/`) both use.
**anyone** needs no session.

## The parts

The folders are the parts by what each holds: `serve/` (the one HTTP app, the Worker and the Remote on this machine,
what every request shares and the mark), `people/` (who someone is and what they are called), `repos/` (repos kept,
who sees them, Home's settings, SSH per device, the sweep), `bytes/` (what is at rest: the bucket, file contents, trees,
the releases' files), `talk/` (Inbox, servers, news), `plan/` (the plan, the budget, Stripe and its stand-in), `db/`
(the schema, the migrations' stages, the database as the deploy reaches it), `ship/` (the deploy and the releases
pinned), `tests/` (the Remote as a whole, and what the tests share); `migrations/` is drizzle-kit's, as it writes it.

One module a part, its routes, rules and queries together; `serve/app.ts` only
assembles them, `serve/request.ts` holds what every request shares (the origins
that may call, body limits, `LIMIT`, refusals, the account's lock and room,
and `failed`: what no route foresaw is JSON too, `{error, id}`, 503 with
`Retry-After` when the database is busy or out of reach, else 500, the id
in the log beside it), `people/auth.ts` who is asking (`signedIn`: a request that names
no session is refused before the database is asked, and the Worker keeps a
session it looked up for 10 s), `plan/budget.ts` what R2 and the database may be
asked for, and `serve/mark.ts` what is answered without asking the database at all.

### What R2 and Neon may be asked for

Counted before either is asked (`plan/budget.ts`, rows of `usage`), each figure a
variable of `wrangler.toml`, within what Cloudflare and Neon give free:

| Limit | Variable | Past it |
|---|---|---|
| bytes R2 holds: blobs (by trigger with their rows) and release files (by the deploy; one no deploy has pinned for 90 days goes) | `R2_STORED_MB` 8192 | an upload is 507, `files: false`, `retryAfter` an hour: the work stays on the device. Bytes no row names (a failed upload's) are found by the sweep, a thousand keys a day, and go |
| R2 puts in a month (class A) | `R2_WRITES_MONTH` 900000 | 503, `files: false`, `Retry-After` the next month |
| R2 gets and heads in a month (class B) | `R2_READS_MONTH` 9000000 | the same; an isolate takes 64 at a time, so most reads ask the database nothing |
| what one account uploads in a day | `UPLOAD_MB_DAY` 512 | 429, `Retry-After` the next day |
| the database's size (asked every 5 min by each isolate) | `PG_MB` 450 | what would add to it is 507 (`retryAfter` an hour); reads, deletes, discarding, signing in (a link too) and Stripe go on. Postgres's files do not shrink as rows go, but their room is used again: past it, the size is taken less the room rows let go of (`room_free()`, 0014, by pgstattuple, which the deploy makes), so deletes bring writes back; without pgstattuple, only `VACUUM FULL` does |
| requests a minute, by session or else by address, at the edge (`[[ratelimits]]` LIMITER) | 600 | 429, before the database or R2 is asked |

A put is counted in the transaction that names its blob, so one undone is
not counted; a delete costs R2 nothing and is never refused. A release file
is read from R2 once per place and then answered from the edge's cache
(`caches.default`, by its pinned digest), range and HEAD alike; a blob asked
for with its digest as `If-None-Match` is 304 without R2. The deploy's
mirror counts each put and the bytes it adds against the same rows, and
puts nothing past them. The sweep lets go of what was counted of days and
months gone.

### What is answered without the database

Neon sleeps once nothing has asked it anything for five minutes, and a query
wakes it for five more: what it costs is the time it is awake, not the
queries. What clients ask on a timer, whether or not anyone does anything,
kept it awake around the clock: a page left open looks at what moved and what
came every few seconds (`GET /v1/moved`, `/v1/news`; a conversation's rows, a
board's posts and TODO while they are on screen; a minute or ten apart while
nobody is at it), and a device whose SSH is on asks every 30 s whether it
still is (`POST /v1/ssh/this/beat`), each a connection, a session looked up
and a statement (on the Worker over Postgres, `tests/prod`'s stack: 1
connection, 2 statements, 3 round trips). Counted on the page's own clock: one
page left open in view, nobody at it, kept Neon awake 30 of every 60 minutes;
a page someone reads, all 60; a device listening, all of them, all day.

The mark (`serve/mark.ts`) is a number kept outside the database, in a Durable
Object (`MarkObject`, `wrangler.toml` `MARK`; this process's memory in
`serve/dev.ts`), that moves after every request that writes, but those that write
nothing a look reads (a beat, the live line's signals, a file's bytes, a
device's sign-in polling), and after the sweep. Each of those looks is
answered with a tag (its `ETag`; the beat's, `tag` in its JSON) that says,
under a key of its own (`serve/keys.ts` `mark`), what was asked, by which bearer
token, at which mark and until when; asked again with it (`If-None-Match`;
the beat's body) while the mark has not moved, the answer is 304 (the beat:
`{on: true}`) and nothing else is asked, the session included: no connection,
no statement (10 to 40 ms on that stack, against 50 to 90). A cookie
alone is never answered so. A tag holds until the next six hours of UTC and
never past its session's end, so what changed outside any request (SQL by
hand, a session ended in the database) is read by then; a session ended
through the Remote is a write, and moves the mark at once. The page asks
afresh, without tags, when its window comes back (`root3/app/remote/looks.ts`). A beat
answered by the mark is heard there: `GET /v1/ssh` says the later of the
database's moment and the mark's. One mark for the whole Remote: a write by
anyone has each look read again once, while the database is awake for that
write anyway. What it costs is a Durable Object request for each look and
each write (100,000 a day on Cloudflare's free plan; past them, or with the
object not answering in 3 s, a look is answered from the database as without
it). Without `MARK` bound every look asks the database, as before, and it is
not bound yet: binding it (`wrangler.toml`, a `[[durable_objects.bindings]]`
`MARK` for `MarkObject` and a `[[migrations]]` with `new_sqlite_classes =
["MarkObject"]`) makes the object at main's next `wrangler deploy`, and until
main has made it Cloudflare refuses another branch's `versions upload`.

| Part | Module | Routes | Tables | Clients |
|---|---|---|---|---|
| What this Remote is | `serve/about.ts` | `GET /v1/about`, `GET /v1/health`, `GET /.well-known/security.txt` (RFC 9116) | (reads nothing; health `select 1`) | page, core (app and root3 read `app` to know where a device code is approved), deploy |
| Who someone is | `people/auth.ts` (Better Auth), `people/devoauth.ts` | `/api/auth/*`: social sign-in, passkeys, `get-session`, `list-sessions`, `revoke-session`, `sign-out`, linked providers; the device flow `device/code`, `device/token` (core), `device`, `device/approve`, `device/deny` (page); `/dev-oauth/*` only where `dev` is offered | `user`, `session`, `account`, `verification`, `passkey`, `device_code`, `rate_limit`; `guard` (a passkey sign-in is proof of presence) | page, core |
| A Remote for research | `people/enter.ts` | `POST /v1/enter` | `user`, `session`, `guard`, `throttle` | page |
| File contents and releases | `repos/files.ts`, `bytes/bucket.ts`, `ship/releases.ts` (what is pinned), `bytes/mirror.ts` (the deploy puts it in the bucket) | `GET /v1/os/:sha`, `GET /v1/desktop/:file` (anyone, Range, streamed), `POST /v1/blobs/missing`, `PUT/GET /v1/blobs/:sha` | `blob` (and `room.used`, by trigger); bytes in the bucket: `u/USER/SHA`, `release/VERSION/FILE`, `distro/ID-VERSION/FILE` (below) | page (the desktop app's download), core (`/v1/os` for a Prompt's root, falling back to the release) |
| Repos kept | `repos/repos.ts` | `GET /v1/moved`; `/v1/repos`, `/v1/repos/gone`, `/v1/repos/:name` (`?line=`), `draft`, `cuts`, `cuts/:id`, `log`, `lines`, `lines/:line/push`, `changes`, `changes/:id/reviews\|merge\|reject\|reset`, `off`, `on`, `discard` (a passkey just now and the repo's name) | `repo`, `line`, `cut`, `change`, `review`, `repo_gone`, `room` (stamp, used), `guard` (sign-ins just now) | page, core (sync, history, work); off and discard only from the page (they ask a passkey) |
| The plan and billing | `plan/plan.ts` (the rules and routes), `plan/stripe.ts` (Stripe's REST and webhook signatures), `plan/devbilling.ts` (a stand-in for Stripe in `serve/dev.ts`: Checkout, 3-D Secure and the portal in test mode) | `GET /v1/plan` (the tier, its use, the tiers), `POST /v1/plan/checkout` (a tier), `POST /v1/plan/portal` (with a tier, at the step that changes to it); `POST /v1/stripe/webhook` (anyone; the webhook signed by Stripe, the tier read from the price); its rules are asked by the routes that make something new: a new repo and a draft that grows (`repos/repos.ts` PATCH draft), making a server (`talk/servers.ts`), claiming a name (`talk/inbox.ts`), each 402 with the rule | `plan`, `billing_event`; reads `repo`, `room.used` (counted again from the rows by the sweep), `address` | page (Remote → Plan), core (`root3 remote plan`); 402 is said in place and the work stays on the device |
| Home | `repos/home.ts` | `GET/PUT /v1/home/:key` (profile, todo, dotfiles) | `home` | page, core |
| Names and Inbox | `talk/inbox.ts`, `people/names.ts` | `/v1/inbox/me` (gives the username if there is none yet), `username` (PUT: change it), `addresses` (claim another, let go), `domains/:domain`, `lookup`, `messages`, `threads`, `threads/:address(/read)`, `contacts`, `signals` (send), `signals/take` (POST: taking deletes); `GET /.well-known/length3` (anyone: other Remotes) | `address`, `principal_code`, `contact`, `message`, `signal`, `throttle` | page, core (root3 name, root3 inbox) |
| Servers, boards, guests | `talk/servers.ts` | `/v1/servers…` (people, boards, renew, back), `/v1/boards/:id…` (todos, posts, seen, archive, invites, guests), `/v1/open…` (anyone: open boards, a guest by invitation) | `server`, `server_member`, `board`, `board_todo`, `board_post`, `board_seen`, `board_invite`, `board_guest`, `throttle` | page, core (root3 server, `archive` as text) |
| Who sees a repo | `repos/seen.ts` | `GET /v1/seen`, `PUT /v1/repos/:name/seen`, `/v1/servers/:id/repos…`; `GET /v1/seen/:face/:name(/file)` (anyone, when public) | `repo_share`, `repo_public` | page |
| News | `talk/news.ts` | `GET /v1/news` | reads `message`, `contact`, `board_post`, `board_seen` | page |
| SSH, per device | `repos/ssh.ts` | `GET /v1/ssh`, `POST /v1/ssh/:device/off` (any session); `PUT/DELETE /v1/ssh/this`, `POST /v1/ssh/this/beat` (the device itself: refused with an Origin; with the tag its last answer gave, answered by the mark) | `ssh` (one row a session: its scope, `device` or `network`, and when; never an address, port or repo) | core (the listener), page (see, stop) |
| What moved, without the database | `serve/mark.ts` (`MarkObject`, `serve/worker.ts` exports it) | (none of its own: it answers `GET /v1/moved`, `/v1/news`, `/v1/inbox/threads`, `/v1/boards/:id/posts`, `/v1/boards/:id/todos` and the beat, given their tags, and every other write moves it) | (none: the Durable Object's own storage, its mark and the beats it heard) | page, core |
| The sweep | `repos/sweep.ts`, `serve/worker.ts` `scheduled` | (none: once a day, and when `serve/dev.ts` starts) | every table above (Stripe's events 30 days old; each changed room counted again from its rows); the bucket's unnamed blobs; then the mark moves, and lets go of beats heard a day ago | |

`GET /v1/repos/gone` is asked by no client today (a device learns a repo
went from `GET /v1/repos/:name`'s `gone` and `PATCH draft`'s 410); the tests
read the sweep through it.

## What native and root3 need that the web does not

- **The device flow.** The app and root3 hold no passkey and no cookie: they
  ask `device/code`, a browser where the person is signed in approves it
  on the app's origin (`/v1/about` `app`, so a Remote reached by another
  name sends them to its own page only), and they poll `device/token` for a
  session of their own, sent as a bearer token. Each device is a session,
  listed and ended from any other (`list-sessions`, `revoke-session`). A
  browser's session is its cookie alone: no answer hands a page a token
  (`people/auth.ts` takes the bearer plugin's `set-auth-token` out of every one,
  and `/v1/enter` sets the cookie), so no script on a page can carry a
  session off.
- **Requests without an Origin.** core never sends one; `signedIn` takes a
  bearer token from anywhere and a cookie only from the app's own pages,
  and `PUT /v1/ssh/this` is refused to anything with an Origin, so only a
  device turns its own SSH on.
- **The desktop webview's origin** (`APP_ORIGINS`: `tauri://localhost`; a
  Windows build would add `https://tauri.localhost`, never plain `http`) in
  CORS and Better Auth's trusted origins.
- **Roots by digest** (`/v1/os/:sha`, Range), which the app's Prompt
  installs from, falling back to the publisher's release.
- **Text to take home** (`/v1/boards/:id/archive`, markdown) for `root3 server get`.

## What R2 holds, and what may be deleted by hand

Every object in the bucket is under a folder that says what it is, and a
person reading its list in Cloudflare's dashboard may delete any of them:
nothing breaks, and what is still wanted comes back by itself.

| Folder | What it is | Deleted by hand |
| --- | --- | --- |
| `release/VERSION/` | root3's release of that version: its root (`os-length3-linux-VERSION-x86_64-SHA.tar.zst`) and desktop app (`.deb`, `.AppImage`), put by the deploy (`ship/deploy.ts`, `bytes/mirror.ts`) | A version this tree no longer pins: gone for good (the deploy lets it go by itself 90 days after it last pinned it). The pinned one: put again by the next deploy |
| `distro/ID-VERSION/` | another distribution's root (Ubuntu's, Debian's), from its makers, put by the deploy the same way | The same |
| `u/USER/` | an account's files, one object a digest (`USER` is `user.id`) | Each is let go as it is first asked for (`repos/files.ts` `lost`): its row goes, the account's room counts it no more, and a device that still has the file sends it again. A file no device has any more is lost, as a deleted file is |
| `os/SHA`, `desktop/FILE` | where deploys before these names put a release; each is let go by the next deploy once it is under its own name | Nothing to it |

A release file is served from where the deploy recorded it (`release_file`,
which `/v1/os/:sha` reads by digest): deleted by hand, the first request for
it is 404 and takes its record with it, so the next deploy puts it again
rather than taking it for there. The edge's cache may answer for it until
then; it never needs to be emptied by hand. The sweep (`repos/sweep.ts`)
deletes, the other way round, the bytes under `u/` that no row names.

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
again later, core and root3 say so (`The Remote cannot hold files just now; your work stays on this device`,
`Remote はいまファイルを置けません。作業はこの端末に残ります`)
and leaves what was agreed as it was. The sweep leaves blobs alone while
there is no bucket to take their bytes from; it still counts each changed room
again, which the plan reads.

On Workers that is a Worker without its `BLOBS` binding; here,
`node root3/remote/serve/dev.ts DIR --no-bucket` (or `ROOT3_NO_BUCKET=1`). The
contract tests run twice, with a bucket and without
(`tests/contract.test.ts`, `tests/contract.nobucket.test.ts`), and `serve/worker.test.ts`
runs the Worker itself, with no bucket, through its Neon driver.

## Against a real database

    DATABASE_URL='postgresql://…' npm run verify:remote

(`db/verify.ts`) makes a database of its own on that server
(`remote_verify_<time>_<hex>`), migrates it with `migrateRemote`
(`db/neon.ts`, the function `ship/deploy.ts` runs), runs `tests/contract.test.ts` there
with no bucket through the Worker's own pool code (`serve/worker.ts` `open` and
`served`: `@neondatabase/serverless` over WebSocket, straight to a Neon
host, through `serve/bridge.ts` to a Postgres on this machine), and drops that
database, and `remote_app` only if its migrations made it. It refuses what
looks like production unless `--production`, and never prints the URL or
anything in it. README.md, Deploy, says how to run it on a Neon branch.

## What every request passes, and the one secret

What the Remote holds itself to, item by item against OWASP ASVS 4.0.3
L2, RFC 9700, RFC 8628 and WebAuthn, is tested in `tests/security.test.ts`
(each test names its items). In short:

- **Headers** (`serve/request.ts` `unkept`). Every answer: `Cache-Control:
  no-store`, `nosniff`, `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (the
  Remote answers data, never a page; the stand-in provider's page says its
  own), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS a
  year with subdomains, `Cross-Origin-Resource-Policy: same-origin`. The
  app's own files get theirs from `public/_headers`.
- **CORS** (`fromOrigins`): only the app's origins (`APP_ORIGIN`,
  `APP_ORIGINS`) are answered, with credentials; a preflight is kept ten
  minutes. `If-None-Match` is taken and `ETag` shown, for a look's tag.
- **Cross-site requests** (`people/auth.ts` `fromElsewhere`, asked by `signedIn`
  and by the session routes the Remote answers itself beside Better Auth's:
  `list-sessions`, `revoke-session` by `id:`). A bearer token is taken
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
  Per account: codes looked up, messages, signals, posts, servers made,
  username changes.
- **One person, one account**: a second provider joins an account only when
  it says it verified the same address, and the account's own was verified;
  no provider is taken at its word without that (Better Auth's
  `trustedProviders` is empty).
- **Passkeys** must verify the person (PIN or biometrics) when made and when
  used; the relying party is `APP_ORIGIN`'s host and its origin is checked;
  a counter that goes back is refused (SimpleWebAuthn); attestation is not
  asked for.
- **Cookies** over HTTPS are `__Host-length3.*`: Secure, HttpOnly,
  SameSite=Lax, Path=/, no Domain.

### The secret, and rotating it

The Worker is given one secret, `BETTER_AUTH_SECRET` (made once by
`ship/deploy.ts`, 48 random bytes). Nothing uses it as it is: each purpose has a
key derived from it with HKDF-SHA256 under its own label (`serve/keys.ts`):
`better-auth` (sign-in's cookies and state), `domain-proof` (an Inbox
domain's TXT proof), `invite` (what is kept of an invitation and a guest's
token) and `mark` (a look's tag). Before `serve/keys.ts` the secret itself keyed
all of these; the Remote had no accounts in production when this changed,
so nothing was carried over. (There was an `off-code` key, for a code a repo
was turned off with; turning off now asks for a passkey and the repo's name,
and nothing of it is kept.)

To rotate it (a leak, or someone who held it leaving), put a new one, 48
random bytes as base64url, with `npx wrangler secret put BETTER_AUTH_SECRET`
(it reads the value on its standard input), and end every session, as the
database's owner: `delete from session;`. The secret signs the browsers'
cookies and the devices' bearer tokens alike, so a new one alone stops
every session being taken; deleting the rows ends them in the database
too. Then, at once and by design:
every session ends (everyone signs in again; devices pair again), every
custom domain's TXT record must be given anew (the Remote shows the new one
under Inbox; until then the address lapses, and is let go after its hold),
and invitations out and guests' tokens stop opening their boards. One purpose's key alone can be moved on by
raising its version in `serve/keys.ts`. The other secrets (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, the providers' client secrets, `ENTER_KEY`) are
each rotated where they are made (Stripe's dashboard rolls a webhook secret
with both valid for a while; `deploy.ts link` for `ENTER_KEY`) and put with
`wrangler secret put`.
