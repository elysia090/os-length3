# The production-like selftest

`npm run selftest` and `npm run selftest:l3` run the Remote as `service/dev.ts`:
Hono on Node, PGlite, blobs in files. Production is a Worker on workerd over
Neon and R2. This folder runs the same tests, and more, against the Remote as
production runs it, on this machine, reaching nothing else:

| Production | Here |
|---|---|
| `service/worker.ts` on workerd, `nodejs_compat` | the same, under `wrangler dev --local` (workerd and Miniflare from `node_modules`), from a configuration made from `wrangler.toml` (`stack.ts` says each difference and why) |
| Neon Postgres, the Worker as `remote_worker_<when>` (member of `remote_app`), migrations as the owner | a Postgres 16 cluster of its own (`postgres.ts`: `/usr/lib/postgresql/16`, 127.0.0.1 only, a free port, a new directory, gone at the end); migrations by `migrateRemote` and the role by `workerRole` (`service/neon.ts`), exactly what `deploy.ts` runs, a role of its own for each Remote on the cluster |
| the Neon serverless driver over a WebSocket to Neon's proxy, startup pipelined | the same driver code, pointed (`worker.ts` here: `neonConfig.wsProxy`) at `wsbridge.ts`, a process that hands each WebSocket's bytes to a TCP connection to the Postgres; each `remote_worker_…` logs in by password so the driver pipelines its startup as it does to Neon |
| R2 | Miniflare's local R2 (`--persist-to`), or none (`noBucket`) |
| Workers Assets, SPA fallback, `run_worker_first`, `public/_headers` | the same, serving the app built for its own origin (`VITE_LENGTH3_REMOTE=''`, as `build:cloudflare` builds it; without the Prompt's files, which come from the release) |
| the Cron Trigger | wrangler's `/__scheduled` (`--test-scheduled`) |
| secrets | a `.dev.vars` of throwaway values, made for the run in a temporary directory, never in the tree |
| Stripe | `service/devbilling.ts`, answering Stripe's REST API inside the Worker (`LOCAL_STRIPE=1`); nothing reaches Stripe |
| GitHub/Google/Apple sign-in | the stand-in provider (`DEV_SIGN_IN=1`, which `service/worker.ts` takes only when `BASE_URL` is this machine) |

Proxies are taken out of the Worker's environment, so it cannot reach the
network at all; wrangler's attempt to fetch `Request.cf` fails and is said in
its log.

## Running it

    npm run selftest:prod                    # headers, research, web, l3
    npm run selftest:prod -- web l3          # only those
    L3=path/to/l3 npm run selftest:prod -- l3 research
    node selftest/prod/measure.ts [--delay MS] [--out FILE]
    node selftest/prod/explain.ts
    node selftest/prod/drills.ts

- **headers**: real answers of workerd and Workers Assets: `index.html`, the
  SPA fallback and a hashed asset carry `public/_headers` (the whole CSP,
  exactly `src/app/policy.ts`'s with frame-ancestors; X-Frame-Options, HSTS with
  subdomains, CORP, Permissions-Policy, …; the hashed files immutable); `/v1`,
  `/api` and `/.well-known` carry the Remote's own (`no-store`, `nosniff`,
  the API's CSP, X-Frame-Options, HSTS, CORP, Referrer-Policy, CORS), and
  `/.well-known/security.txt` answers (RFC 9116).
- **research**: a Remote for research (`ENTER_AS`, as `wrangler.toml` is
  today): no provider offered, in by the link alone, passkeys refused, l3
  signed in through the device flow approved by the entered session (with
  `L3`), the sweep fired as the Cron Trigger fires it.
- **web**: the app's Playwright selftest (`SELFTEST_REMOTE_KIND=worker npm
  run selftest`): app and Remote on one origin, as `os.length3.com` is. Outside
  research the plan always holds on a Worker, and servers are paid: each
  account the run makes is paid by a trigger in that database alone. A
  second Worker beside it, its accounts free until they pay through
  Stripe's stand-in (each tier's price `service/devbilling.ts` has), is the
  one the specs about paying meet (`SELFTEST_PLAN_APP`).
- **l3**: `selftest/l3` with `SELFTEST_REMOTE_KIND=worker`, a Postgres and a
  Worker per test file, one file at a time; stopping the Remote is the
  Worker restarting. `L3` names the binary (the release's:
  `cargo build --profile prompt -p l3 --no-default-features --target x86_64-unknown-linux-musl`).
- **measure** (`measure.ts`): the first load (requests, bytes, until usable,
  how each file is kept, coming back), then each hot route timed at the
  client, by the Worker (`Server-Timing: worker`), in CPU (`cpuserver.ts`: the
  same fetch in Node, since workerd's clock does not move with CPU), with the
  bridge's counts: connections, statements, round trips, bytes each way, a
  connection's setup before its first statement. `--delay MS` puts MS between
  Worker and database each way, as Cloudflare to Neon has.
- **explain** (`explain.ts`): the hot queries EXPLAIN ANALYZEd on 5,000
  accounts and one heavy one.
- **drills** (`drills.ts`): Postgres restarted mid-session, a slow database,
  the database out of reach, no R2, the Worker restarted, a webhook's clock
  off by minutes; what the web and l3 are told, and whether anything is lost.

Postgres will not run as root: as root, the cluster is the `postgres` user's,
in a directory under the system's temporary one. Every server started
(Postgres, the bridge, workerd) is stopped at the end, however it ends.
