# Length³ OS desktop shell

Native work shell for Length³ OS (issue #17). Tauri v2 with a TypeScript
frontend and no UI framework; the same frontend is the web build.

## Layout

```
┌────┬──────────────────────────────────────────────┐
│ ⌂  │                                              │
│ >_ │   the chosen purpose, full width             │
│ ⑂  │                                              │
│ ▤  │   Home: a profile page — avatar, name,       │
│ …  │   @handle, bio, TODO, repo cards, servers    │
│ ⊕  │                                              │
└────┴──────────────────────────────────────────────┘
```

- **Rail**: icons only (Home / Forge / File / Git / Runtime / Remote / Server /
  Inbox, and a round + for a new repo). A name appears beside an icon
  on hover or keyboard focus. Choosing one replaces the main area; File and
  Server are the operations, laid over the page instead (the tree of "/";
  the people you know and their boards).
- **Home** is a profile, somewhere between a Twitter and a GitHub profile.
  It looks the same to its owner and to anyone else; the owner also gets
  "edit". The profile is one of Home's settings: a file in the data
  directory (in a browser, its storage), kept on the Remote too once signed
  in, as the TODO is.
- The design language (rail order, page structure, colour roles, type,
  spacing) is in `DESIGN.md`.

## What is real in this step

- The rail, with the person's own icon at its foot (Profile, Account,
  Language), and the profile (edit, validate, save).
- Repos the app manages under its data directory (`repos/`). + creates
  one from a template (standard, C, minimal); history is the Remote's, so
  no `.git` is made. Inbox and TODO belong to the app, not to
  repos: TODO is a list on Home. Home lists the repos as cards.
- Forge: the repos out to work on as pills in a band on the top line
  (⊕ at the left brings every other repo out at once, × takes one off;
  with none left the center says how to bring one out); the center (3/4)
  is the open repo's files one after another like an endless page (README
  first, loaded as they scroll near), each a plain text editor with line
  numbers that saves on its own (natively through `repo_write`, which only
  replaces existing files inside the repo, atomically; files read only in
  part are never written), with a prompt box at its foot that
  types into the repo's `sh`. While the prompt is in use the terminal flies
  up above it from the right pane, where a search box for the repo sits on
  top and the reference (the repo's issues, its diff, and what was run)
  grows into the room. No tabs: files are chosen from File.
- Prompt: in the app with a root installed, the distribution's root itself
  (`l3 prompt`): its sh, gcc, make, git on this kernel, writing the repo
  directly. Every place it writes has an owner and a lifetime (DESIGN.md
  §5): over the read-only root lies the repo's environment (an overlay;
  `apk add` there is the repo's, in `envs/<repo>`), `/var/cache`,
  `/var/tmp`, `/var/log` and `~/.cache` are the repo's caches
  (`caches/<repo>`), `/tmp` and `/run` end with the Prompt. Runtime lists
  each part, and what is derived in the repo (node_modules beside
  package.json, target beside Cargo.toml, a venv, anything with a
  CACHEDIR.TAG), which is never sent to the Remote. Otherwise (and in a browser) translated BusyBox `sh` and `l3`
  running on the xlat kernel in a Worker, on the open repo. What the shell changes under `/root/<repo>` is
  written back through the store (text files up to the read limit), and
  what is saved anywhere else is put into the shell's copy, so the shell,
  File, Forge and Git see one repo. Its one dependency is l3: one file
  (`public/userland/l3-<digest>.bin`, named with its size and digest in
  `l3.json`) carrying the distribution's root (BusyBox from its pinned
  source and config, its `/etc` and `os-release`), the l3 command and the
  translator with ready translations, gzip'd from 12 MB to 2.7 MB. In a
  browser it is fetched at each visit, continued from where a proxy cut or
  stalled it, and checked against its digest; nothing of it is kept. Make it with `npm run
  userland` (`scripts/userland.sh`, then `scripts/bundle.mjs`).

## l3: the same OS on the command line

`l3` speaks the app's words and goes through the same Rust core
(`core/`), so the app and the command cannot disagree about a repo, a file,
an issue or a TODO. Templates and the naming rules live once in `shared/`,
read by the core, the app and both test suites.

```
Home      todo · profile · lang
Forge     repo · band · prompt
File      file (write · mkdir · rm)
Git       git · issue · start · main · commit · push · reset · diff · log
          review · reply · merge · reject
Runtime   runtime · free · root · network · dotfile · address
Remote    remote · login · logout
Server    server
Inbox     inbox · name
```

Nobody has to learn these first. At a terminal, `l3` alone is the rail:
the same purposes in the same order and words, each with what is there now;
pick one (↑↓, a number or its first letter, Enter) and its page is printed
as `l3 <page>` prints it, then its things with their deeds, the ones where
they stand (an issue not started: Start; changed: Commit; committed: Push;
handed in: Approve, Merge…). A deed asks for what it needs in place, one line
each, says the command it runs (`→ l3 issue new notes "Fix：title"`) and
then offers what comes next; q or Esc leaves, and what stays in the
scrollback is plain text. After a command typed by hand, its next deeds come
in one short row that Enter or Esc passes by. It is all lines under what is
there (over SSH, in a Prompt), redrawn only on a key, the focus a › and
brackets. Through a pipe, with `--json`, `TERM=dumb` or `L3_PLAIN=1`, nothing
is offered or asked and l3 writes exactly what it always did.

```
$ l3
Length³ OS · length3.com
  › 1  Home     Profile · TODO 1 open of 2
    2  Forge    Your workshop · 1 repo · 1 on the band
    3  File     The tree of / · /root holds 1 repo
    4  Git      Issues and commits · 1 issue open
    …
    9  +        New repo
  ↑↓ choose · Enter open · 1-9 or a letter jumps · q leaves
```

One table (`cli/src/spec.rs`) says every form: its words and what each
slot is (a repo, a path, an issue, text…), its flags, what it needs (the
Remote; whether it may run inside the app's Prompt) and how it keeps in step
with the Remote, and, for the menu, which forms make a purpose's page and
which deeds a form is offered as (its word in both languages, what it is
pressed on, the facts it is offered under, what it asks). Parsing, the help,
the completion, the menu, what a Prompt may run and what is sent and taken
in around each command are all read from it. `l3 help` lists the
commands by the rail, `l3 help COMMAND` (or `l3 COMMAND --help`) gives one
command's forms, `l3 help all` every form, a mistyped word gets the nearest
one ("Did you mean: l3 commit"), and `l3 completion bash|zsh|fish` completes
commands, verbs, flags and what fits each slot (repo names, paths, issues,
dotfiles). In a repo (its copy, an issue's copy, or its Prompt) the repo may
be left out and `#N` is that repo's issue N: `l3 commit`, `l3 start #3`,
`l3 merge #3`, and `l3 file src` reads from where you are. An issue is named
by its number (`3`, `#3`, `hello#3`) or by words of its title (`l3 start
restart`); words that fit more than one are refused with the choices. What
l3 says names issues the same way (`#3 Fix：title`), never by the file that
holds them. Any repo takes an issue (`issue/` is made for the first), and
issues sort by number; a file there without one (written by hand, or two
devices' issues that met under one number) is given the next free number
when Git is drawn while the repo shows main, as the app does, unless a work
or change refers to it. `--` ends the
flags for every command (`l3 todo add -- "-1 day"`). Every command takes
`--json` (data, camelCase keys; an error is `{"error":{"kind","message"}}`),
and exits 0 when done, 1 when not, 2 when not how it is written, 3 when the
Remote is out of reach, 4 when what was named is not there, 5 when it is
turned off here (`l3 address` with SSH off, in a script). `l3 -V` gives
l3's version and the root's.

Names are written owner first, as DESIGN.md §5 "Names" sets out (one
namespace of principals, people and servers alike): `hello`,
`hello/src/a.c`, `hello#3`, `ren:hello` (a repo of `ren`'s), `trip#general`
(a server's board; `#general` when one is in one server). A name on the
Remote (`ren`, `trip`) is first come and held five years at a time:
`l3 name list` shows each name's term and your code (six digits anyone can
find you by, or write to), `l3 name renew NAME` holds it five more years,
and `l3 name release NAME` lets it go (held for you 30 days). A name of
your choosing on a domain you own (`ren@ren.dev`) is shown beside it.

### SSH into a repo's Prompt

From the host (or another machine on its network), an ordinary OpenSSH
client lands in a repo's Prompt: the same shell `l3 prompt REPO` gives,
inside the root, without privileges, with the repo's network grant.
`l3 address` says where, one line a repo, ready to paste:

```
$ l3 address
ssh -p 23000 notes@192.168.1.5
ssh -p 23000 trip@192.168.1.5
$ ssh -p 23000 notes@192.168.1.5 'make test'; echo $?
```

The SSH user is the repo. A command runs in the Prompt (`/bin/sh -c`) and
its exit code comes back; with a terminal (`ssh -t`, or no command) it is
the interactive shell. Standard input reaches the command, so `ssh …
'cat > notes.txt' < notes.txt` writes into the repo itself, and `scp -O`
(the classic protocol, which runs `scp` in the Prompt: l3's root has it)
copies in and out. There is no sftp subsystem, so `sftp`, and `scp`
without `-O` (it speaks sftp), do not work; and no port, agent or X11
forwarding.

- **Off at first.** `l3 address` with SSH off asks on a terminal whether
  to turn it on (y/N, No by default); in a script it never asks: it says
  how and exits 5. `l3 address ssh on|off` sets it without asking; the
  app's Runtime has the same switch for its own device.
- **Keys**: public keys only (no password, no keyboard-interactive), one
  OpenSSH public key a line in the Runtime dotfile `.authorized_keys`
  (`l3 dotfile write .authorized_keys < ~/.ssh/id_ed25519.pub`). Dotfiles
  are kept on the Remote, so a key added (or removed) on one device counts
  on every one; the listener takes them in at most every 10 s as keys are
  tried. Ed25519 and ECDSA keys; not RSA. A line with options before its
  key is left out (they are not honoured), and turning on says which.
- **Port**: one per person on the host, the same every time: 22000 plus
  their user number (uid 1000 → 23000), whatever repos there are, never
  another person's; `LENGTH3_SSH_PORT` names another when that one is taken.
- **Where**: it listens on every IPv4 address but takes a connection only
  if it came in on loopback or a private network (10/8, 172.16/12,
  192.168/16, a VPN's 100.64/10, link-local), so a host with a public
  address is not reachable from the Internet. `l3 address` names the LAN
  address the host's traffic leaves by, or 127.0.0.1 when it has none.
- **Host key**: Ed25519, made once per device in `<data>/ssh/host_ed25519`;
  turning on shows its fingerprint (what ssh asks about the first time).
- **Who runs it**: turning on starts `l3 address ssh serve` in the
  background (its own session, its log in `<data>/ssh/log`), recorded in
  `<data>/ssh/listening.json` while it runs, as a Prompt records itself;
  `l3 runtime` shows it and `l3 address ssh off` stops it. Each session is
  an `l3 prompt REPO` it starts, so `l3 prompt ls` lists it, and every one
  ends with the listener. A failed key from an address counts; twenty in a
  minute and that address is not heard for a minute. A connection not
  signed in within a minute is closed.
- **Off from anywhere**: which devices listen is kept on the Remote, per
  device (its session), and Runtime shows a card for each, its
  destinations copied by a press, and a switch that turns it off; a page
  can only turn SSH off. The listener asks the Remote every 5 s, and when
  it was turned off (or the device signed out, here or from another
  device: `l3 logout` stops it at once) it stops taking connections and
  ends every session.

There is no sync command. Connected, l3 keeps each repo in step with the
Remote by itself: a command that reads a repo takes in the Remote's changes
to it first, and after every command each repo whose files differ from what
was last agreed is sent (which differ is seen from the digests kept, so a
repo in step costs no request). Home's settings kept on the Remote
(profile, TODO, dotfiles) go the same way, by the app's protocol and rules
(`core/src/home.rs`, as `src/draft.ts`): a command that reads one (`l3
todo`, `l3 profile`, `l3 dotfile`, `l3 prompt`) takes it in first, and one
that differs from what was last agreed is sent after any command; two TODO
lists changed on two devices are joined item by item. What a person does to the Remote is only
taking a repo off it; Git's words (commit, push, review, merge) are about
history, never about getting files there. Signing out (`l3 logout`, or the
app's) sends every copy first; one that cannot be sent keeps the device
signed in, since forgetting what was agreed would undo an unsent change (a
file removed here) at the next sign-in.

On the host it uses the app's data directory (`$LENGTH3_HOME` overrides):
`cargo install --path cli`. The same binary, built static for xlat, is
`/usr/bin/l3` in the root and `/bin/l3` in a browser's Prompt, where only
the open repo is present and Home, the Remote and the device are left to
the app.
- File: hovering or pressing its icon lays the tree of "/" over any page —
  the whole system as the shell sees it (`/bin` from the fetched
  distribution, repos under `/root`) — and it stays 8 s after the pointer
  leaves. ▷/▽ before a folder opens it; a name inside a repo opens that
  place in Forge. Every path from the webview is checked
  to stay inside its repo after following symlinks.
- Git: the repos' issues ("#3 Fix：件名", then the detail), filtered by repo
  chips, as boxes side by side; 「Issue を書く」 writes the next one, as
  `l3 issue new` does (kept as one file in the repo's `issue/`, made natively
  through `repo_add`, which only makes new files in existing directories).
  An issue is worked on with Start, then Commit and Push, which hand it to
  main as its change, then Review and Merge (or Reject) under it.
- Remote: the canonical copy (`service/`). A browser signs in with a
  provider (GitHub で続ける) and then adds a passkey, so the next time needs
  none (パスキーでサインイン); with every passkey lost, the provider again.
  The app and l3 show a code that a browser approves
  (`?device&user_code=`). Signed in: each repo with where it stands
  (Remote と同じ, 送っています, まだ送れていません; Remote にだけあります for
  one not here, which Forge brings here and opens), then passkeys, the code
  to turn a repo off and the providers, then the devices (sessions), as a
  history (`l3 remote devices rm N` signs another out). Every change is sent
  as a diff within half a second; the Remote's changes are seen within five
  seconds and on focus; a file changed on both sides keeps, at its name, the
  version that reached the Remote first, and puts this device's beside it as
  "name (<this device>).ext". In a browser, closing the tab lets go of every
  copy the Remote holds all of.
- Remote → Plan (`service/plan.ts`): the Remote decides what an account
  may do; the app, the desktop app and `l3 remote plan` only show it. Free
  keeps 3 repos and 100 MB on the Remote and one name there; paid adds
  keeping more, making servers, and names on one's own domain (and more
  names on the Remote). Repos on a device are never limited: past the
  allowance the Remote refuses only what would exceed (a new repo, a draft
  that grows), and the repo stays on the device and waits (この端末に保存 ·
  Remote に空きができるのを待っています), with See the plan beside it; a server
  or a domain name refused says so in place. The Plan part shows Free or
  Paid and until when, the use against the allowance as meters, what paid
  adds, and Subscribe (Stripe Checkout) or Manage the plan (Stripe's
  portal); `l3 remote plan subscribe|manage` prints the same page. A
  subscription that ends takes nothing away: servers, names and repos stay
  as they were, only what would be new is refused. A failed payment stays
  paid 14 days.
- Runtime: この端末, then everything this OS holds on it in one list,
  largest first — repos, roots, leftovers, Home — each with what can be
  done: 空ける (a repo's changes not on the Remote yet are sent first; it
  comes back when opened), or why it stays (a Prompt has it open, a link that cannot be
  sent, the root in use). Sizes are allocated blocks; the host's free and
  total are marked as estimates, and after freeing the change the host
  shows is reported as observed. Prompts running show their memory and can
  be stopped, with a switch for the repo's network (`l3 prompt ls`, `l3
  prompt stop REPO`, `l3 network on|off REPO`; every Prompt, the app's or a
  terminal's, records itself while it runs); then the environment in effect.
- Server (under Remote in the rail, laid over any page like File): the one
  purpose whose subject is people, not a repo (`service/servers.ts`). A
  server is people who know each other (added from someone's Inbox
  contacts); its boards are each a conversation and a TODO they keep
  together: Home's TODO box (`pages/todo-box.ts`), kept on the Remote item
  by item and field by field, so people writing at once do not undo each
  other. Boards are boxes slid like the issues, each with its TODO pinned
  at its top and its talk under it; the plain box at the foot writes in
  the board on screen. The
  right only shows who is in it and the repos they show in it (seen as last
  pushed). What changes it for everyone is behind its gear: people, repos
  shown, how far each board is open (its owner's, asked before it widens),
  its guests, taking a board home as text (`l3 server get`), leaving or
  removing it. A board that takes guests lets outsiders write by invitation,
  never by email: any of its people makes a link (one person, once, a week)
  and passes it on themselves; the guest picks a name, always shown as a
  guest's; guests are held to so many posts an hour, each and per board,
  and whoever invited one (or the owner) removes them with their posts.
- Who sees a repo (`service/seen.ts`): only you, the servers it is shown
  in, or everyone, set on its card in Remote. Everyone sees it under the
  name it went public as: the server's (`trip@length3.com:hello`) when it
  went public from one, so nothing it answers names you; your own when you
  choose. Others only see it, as it was last pushed.

The webview has no other host access: it reads nothing outside the app's
data directory, runs no shell and launches no root. The app starts no host
program for a repo; its own tools run inside the root (`core/src/launch.rs`).

The Remote (`service/`): Hono with Better Auth (provider sign-in, then
passkeys; device authorization; bearer sessions) on Drizzle; Neon in
production, PGlite in tests and here. Its schema is the migrations in
`service/migrations`: those Drizzle generates from `service/schema.ts`, and
`0001` for what Drizzle cannot say (the counted room, the service's role). The service connects as
`remote_worker`, a member of `remote_app`, which reads and writes rows and
nothing else.

```
node service/dev.ts DIR 8787 http://localhost:1420     # the Remote, here (no plan: everything open)
LENGTH3_PLAN=1 node service/dev.ts DIR 8787 http://localhost:1420   # with the plan, bought from a stand-in for Stripe
LENGTH3_DEV_REMOTE=http://127.0.0.1:8787 VITE_LENGTH3_REMOTE= npx vite
LENGTH3_REMOTE=http://127.0.0.1:8787 l3 login
```

On Cloudflare it is one Worker on one origin, the app's files and the Remote
together (`wrangler.toml`), under one name: `os.length3.com` is the app, the
Remote the desktop app and l3 sign in to (`core/src/remote.rs` DEFAULT_URL,
the desktop CSP), what a domain's DNS record names (`remote=os.length3.com`,
and `/.well-known/length3`) and where passkeys belong. Its former name,
`remote.length3.com`, still reaches the same Worker, so released clients
(0.4.x) that sign in by it keep working; nothing names it any more, and a
newer client that finds it kept goes on by `os.length3.com` with the same
session. For research it has one account,
`ENTER_AS`: nobody signs up, nothing is shown to everyone, and whoever is
given the link `https://os.length3.com/#enter=KEY` comes in as it (a day at a
time; a new key ends every old link and session at once).

**Billing (the plan, Stripe).** On Workers the plan always holds (but on
a Remote for research, `ENTER_AS`, which is one person's): `FREE_REPOS`
(3), `FREE_MB` (100) and `GRACE_DAYS` (14) say it otherwise, as variables.
It is bought with Stripe when all three are given; with any missing,
billing is off and the Remote says paid features cannot be bought here yet.
Stripe is reached over its REST API with fetch (`service/stripe.ts`: a
customer, a Checkout session, a portal session; the webhook's signature
checked with Web Crypto); tests and dev never reach it. To connect it:

1. In Stripe, a product with one recurring price; its id is `STRIPE_PRICE`
   (a variable in `wrangler.toml` or the Worker's settings).
2. The secret key: `npx wrangler secret put STRIPE_SECRET_KEY` (a restricted
   key may do: Customers, Checkout Sessions and Customer portal, write).
3. A webhook endpoint at `https://os.length3.com/v1/stripe/webhook`, sending
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed` and `invoice.paid`; its signing secret:
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
4. The customer portal turned on in Stripe (Settings → Billing → Customer
   portal), with cancelling allowed.

Each event is taken once by its id (kept 30 days in `billing_event`; one
made longer ago is not taken) and in the order Stripe made it; a payment
that fails leaves the plan paid for `GRACE_DAYS` from the first failure.
Migration `0006_plan_and_billing` holds each account's plan as Stripe last
said it; what an account uses is read from what the Remote holds.

It ships from main with Cloudflare's Workers Builds: the Worker is connected
to this repository, and its Settings → Build say, once:

| | |
|---|---|
| Root directory | `os` |
| Build command | `npm run build:cloudflare`: the Prompt from the release `RELEASE` names (`scripts/prompt-files.mjs`, checked against the digest `shared/web-releases.json` pins for it), then the app |
| Deploy command | `node service/deploy.ts`: the migrations on Neon's production branch (no branch is made for a deploy), the bucket, then the Worker with the secrets it lacks (the first build prints the link in its log), then the release's files the Remote serves to anyone (`service/mirror.ts`): each root `core/src/root.rs` pins and the desktop app `shared/desktop-releases.json` pins for `RELEASE`, taken from the GitHub release where the bucket lacks them, checked against those pins, and put with wrangler |
| Variables and secrets | `NEON_PROJECT_ID`; secrets `NEON_API_KEY` (a Neon API key for the project) and `GITHUB_TOKEN` (read-only, for this private repository's releases: the build's Prompt and the deploy's release files) |
| Branch control | main; no preview builds |

The Prompt the web serves is a released one: a newer one ships by releasing
it (a new version in `RELEASE`, `.github/workflows/release.yml`), then
pinning what was released, as its notes give them: the root in
`core/src/root.rs`, the web zip in `shared/web-releases.json` and the
desktop app in `shared/desktop-releases.json`. A build takes only the web
zip this tree pins, and a deploy puts on the Remote only the roots and
desktop files this tree pins, so a release made under that tag by anyone
else is not what production serves. The Remote serves them to anyone, the
roots by digest (`/v1/os/<sha256>`, what the app and l3 fetch first) and
the desktop app by its file's name (`/v1/desktop/<file>`, what the web's
Runtime offers to download); GitHub keeps no Cloudflare credentials. A new link
is a new `ENTER_KEY`: set in the Worker's Variables and Secrets, the old
link opens nothing at once. By hand, from a machine that reaches Neon and
Cloudflare (`npx wrangler login`):

```
npm run build:cloudflare
OWNER_URL='postgresql://neondb_owner:…' node service/deploy.ts        # migrations, bucket, secrets, the Worker
OWNER_URL='postgresql://neondb_owner:…' node service/deploy.ts link   # a new link, and every session of the account ends
```

## Develop

Linux needs the WebKitGTK toolchain:
`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`.

```
npm ci
npm run check                  # tsc + node:test
npm run selftest               # the app end to end in Chromium (below)
npm run selftest:l3            # l3 end to end against a Remote of its own (selftest/l3)
npx tauri dev                  # window against the Vite dev server
npx tauri build --debug --no-bundle
```

### Selftest

`npm run selftest` uses the web app the way a person does, in Chromium
(`@playwright/test`, `selftest/`). One run builds the app for a Remote on
its own origin into `selftest/.dist` (again only when a source is newer),
starts a fresh Remote (`service/dev.ts` with a new temporary data
directory) and `vite preview` on free ports, runs every `selftest/*.spec.ts`
in parallel, and stops both whatever happened (`global-setup.ts`). The
browser reaches both as `localhost` (a passkey's relying party is a name,
never an address); nothing listens on a fixed port and nothing outside the
repository is read. About 45 journeys take under two minutes on four cores.

- One test, by its words: `npm run selftest -- -g 'Share'`; one area:
  `npm run selftest -- git.spec`.
- A failure leaves its trace and screenshot in `selftest/.results`
  (`npx playwright show-trace …/trace.zip`), the HTML report in
  `selftest/.report`, and what the two servers printed in `selftest/.logs`.
- Locally Chromium is `npx playwright install chromium` (or
  `PLAYWRIGHT_BROWSERS_PATH` where one is installed).
- The Prompt's tests are tagged `@slow` (BusyBox and l3 through the
  translator) and run with `SELFTEST_SLOW=1` once `public/userland` and
  `public/root` hold the Prompt (`npm run userland`, or `node
  scripts/prompt-files.mjs`); the build then carries it.
- CI (`selftest` in `.github/workflows/desktop.yml`) runs everything on each
  push and pull request that touches `os/`, retries a failure once, and
  uploads the report, the traces and the servers' logs when it fails (the
  traces alone when a test passed only on its retry).

A spec is one area (`git.spec.ts`, `inbox.spec.ts`…), a test one thing a
person does, and it asserts what they then see. Writing one:

- Start from a fixture (`fixtures.ts`): `app` (a fresh browser, no one
  signed in, from an address of its own as the Remote sees it, with a
  virtual authenticator that makes and gives passkeys at once), `signedIn` (signed in through the development provider as this
  test's own person), `another('Bo')` (a second person, in a browser of
  their own; `another('Ada')` is the same person on a second device).
  Every test is its own person on the run's Remote, so tests share nothing
  and names can stay plain (`hello`).
- Say it in the app's words through `app.ts`: `app.rail.go('forge')`,
  `app.newRepo.make('hello', {template: 'C', summary})`,
  `app.forge.editFile('README.md', text)`, `app.file.open('hello',
  'src/main.c')`, `app.file.named('hello', '', 'New file', 'a.txt')`,
  `app.git.write('hello', 'Fix: …')` then `app.git.step('Commit')`,
  `app.git.commitOnMain('hello', 'Docs: …')`, `app.remote.turnOff('hello',
  code)`, `app.inbox.claim()`, `app.server.make('Trip', handle)`. A step
  the app gains goes there once.
- Find things by role and accessible name (`getByRole`, labels), never by
  CSS class: restyling keeps the tests, and a word changed is a one-line
  change in `app.ts`. When something a test needs has no name, the fix is
  in the app: an `aria-label` through `t()`, its Japanese in the catalog.
- No sleeps: wait for what a person would see, with web-first assertions
  (`await expect(locator).toHaveText(…)`, `toBeVisible`, `toBeChecked`);
  what the app does a moment later is `expect(…).toPass()`. The page is
  `aria-busy` until its first look at the Remote is drawn, and
  `app.settled()` waits for that. A deed that comes under the pointer holds
  still for a moment (no double press answers it): `app.answer(yes, ask)`
  presses until the ask is gone.
- What the app looks for every little while (news, the Remote's changes)
  it also looks for when its window comes back: `app.comeBack()` says so,
  rather than waiting out the interval. Where the app's own time matters
  (a file left unsaved while another device saves it), the page's clock is
  held: `app.forge.writeOn(…)`, `lookUntil(…)`, `writingDone()`.

Icons in `src-tauri/icons` are generated from `src-tauri/icon.svg` with
`npx tauri icon src-tauri/icon.svg -o src-tauri/icons`.
