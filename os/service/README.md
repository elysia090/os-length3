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
| What this Remote is | `about.ts` | `GET /v1/about`, `GET /v1/health` | (reads nothing; health `select 1`) | page, core (app and l3 read `app` to know where a device code is approved), deploy |
| Who someone is | `auth.ts` (Better Auth), `devoauth.ts` | `/api/auth/*`: social sign-in, passkeys, `get-session`, `list-sessions`, `revoke-session`, `sign-out`, linked providers; the device flow `device/code`, `device/token` (core), `device`, `device/approve`, `device/deny` (page); `/dev-oauth/*` only where `dev` is offered | `user`, `session`, `account`, `verification`, `passkey`, `device_code`, `rate_limit`; `guard` (a passkey sign-in is proof of presence) | page, core |
| A Remote for research | `enter.ts` | `POST /v1/enter` | `user`, `session`, `guard`, `throttle` | page |
| File contents and releases | `files.ts`, `bucket.ts`, `releases.ts` (what is pinned), `mirror.ts` (the deploy puts it in the bucket) | `GET /v1/os/:sha`, `GET /v1/desktop/:file` (anyone, Range, streamed), `POST /v1/blobs/missing`, `PUT/GET /v1/blobs/:sha` | `blob` (and `room.used`, by trigger); bytes in the bucket: `u/USER/SHA`, `os/SHA`, `desktop/FILE` | page (the desktop app's download), core (`/v1/os` for a Prompt's root, falling back to the release) |
| Repos kept | `repos.ts` | `GET /v1/moved`; `/v1/repos`, `/v1/repos/gone`, `/v1/repos/:name` (`?line=`), `draft`, `cuts`, `cuts/:id`, `log`, `lines`, `lines/:line/push`, `changes`, `changes/:id/reviews\|merge\|reject\|reset`, `off`, `on`, `discard`; `/v1/off-code` | `repo`, `line`, `cut`, `change`, `review`, `repo_gone`, `room` (stamp, used), `guard` (the code), `throttle` (wrong codes) | page, core (sync, history, work); off and discard only from the page (they ask a passkey) |
| Home | `home.ts` | `GET/PUT /v1/home/:key` (profile, todo, dotfiles) | `home` | page, core |
| Names and Inbox | `inbox.ts`, `names.ts` | `/v1/inbox/me`, `addresses` (claim, renew, let go), `domains/:domain`, `lookup`, `messages`, `threads`, `threads/:address(/read)`, `contacts`, `signals`; `GET /.well-known/length3` (anyone: other Remotes) | `address`, `principal_code`, `contact`, `message`, `signal`, `throttle` | page, core (l3 name, l3 inbox) |
| Servers, boards, guests | `servers.ts` | `/v1/servers…` (people, boards, renew, back), `/v1/boards/:id…` (todos, posts, seen, archive, invites, guests), `/v1/open…` (anyone: open boards, a guest by invitation) | `server`, `server_member`, `board`, `board_todo`, `board_post`, `board_seen`, `board_invite`, `board_guest`, `throttle` | page, core (l3 server, `archive` as text) |
| Who sees a repo | `seen.ts` | `GET /v1/seen`, `PUT /v1/repos/:name/seen`, `/v1/servers/:id/repos…`; `GET /v1/seen/:face/:name(/file)` (anyone, when public) | `repo_share`, `repo_public` | page |
| News | `news.ts` | `GET /v1/news` | reads `message`, `contact`, `board_post`, `board_seen` | page |
| SSH, per device | `ssh.ts` | `GET /v1/ssh`, `POST /v1/ssh/:device/off` (any session); `PUT/DELETE /v1/ssh/this`, `POST /v1/ssh/this/beat` (the device itself: refused with an Origin) | `ssh` (one row a session) | core (the listener), page (see, stop) |
| The sweep | `sweep.ts`, `worker.ts` `scheduled` | (none: once a day, and when `dev.ts` starts) | every table above; the bucket's unnamed blobs | |

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
there is no bucket to take their bytes from.

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
