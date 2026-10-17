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
│ …  │   @handle, bio, repo cards, posts            │
│ ⊕  │                                              │
└────┴──────────────────────────────────────────────┘
```

- **Rail**: icons only (Topic / Home / Forge / File / Git / Runtime / Remote /
  Inbox, and a round + for a new repo). A name appears beside an icon
  on hover or keyboard focus. Choosing one replaces the main area; File and
  Topic are the operations, laid over the page instead (the tree of "/";
  Topic with the field to post from and the right pane).
- **Home** is a profile, somewhere between a Twitter and a GitHub profile.
  It looks the same to its owner and to anyone else; the owner also gets
  "edit". Until accounts exist the profile is stored on this device.
- The design language (rail order, page structure, colour roles, type,
  spacing) is in `DESIGN.md`.

## What is real in this step

- The rail, with the person's own icon at its foot (profile, edit, this
  device), and the profile (edit, validate, save locally).
- Repos the app manages under its data directory (`repos/`). + creates
  one from a template (standard, C, minimal); history is the Remote's, so
  no `.git` is made. Inbox and TODO belong to the app, not to
  repos: TODO is a list on Home. Home lists the repos as cards.
- Forge: the repos out to work on as pills in a band on the top line
  (⊕ at the left brings every other repo out at once, × takes one off;
  with none left the center shows Topic); the center (3/4)
  is the open repo's files one after another like an endless page (README
  first, loaded as they scroll near), each a plain text editor with line
  numbers that saves on its own (natively through `repo_write`, which only
  replaces existing files inside the repo, atomically; files read only in
  part are never written), with a field at its foot in two lanes: Shell
  (yellow, `>_`: Enter runs in the repo's `sh`) and Post (purple, `#`: Enter
  posts to Topic, which is then laid over the center); the other lane waits
  as a strip at the side (a press or Alt+←/→ slides it out), Shift+Enter is
  a new line in both, and ⏻ above the field's right end turns the repo's
  Prompt on and off. While the shell lane is in use the terminal flies
  up above it from the right pane, where a search box for the repo sits on
  top and the reference (the repo's
  `issue/`; diff and run output not connected yet) grows into the
  room. No tabs: files are chosen from File.
- Prompt: in the app with a root installed, the distribution's root itself
  (`l3 prompt`): its sh, gcc, make, git on this kernel, writing the repo
  directly. Every place it writes has an owner and a lifetime (DESIGN.md
  §0): over the read-only root lies the repo's environment (an overlay;
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
File      file
Git       git · issue · start · main · commit · push · reset · diff · log
          review · reply · merge · reject
Runtime   runtime · free · root · ssh · dotfiles
Remote    remote · login · logout
Inbox     inbox · address
```

One table (`cli/src/help.rs`) says what each command does and how it is
written; `l3 help` lists them by the rail, `l3 help COMMAND` (or
`l3 COMMAND --help`) gives one command's forms, `l3 help all` every form, a
mistyped word gets the nearest one ("Did you mean: l3 commit"), and
`l3 completion bash|zsh|fish` completes commands, what follows them and the
repo names. In a repo (its copy, an issue's copy, or its Prompt) the repo
may be left out and `#N` is that repo's issue N: `l3 commit`, `l3 start #3`,
`l3 merge #3`, and `l3 file src` reads from where you are. `l3 -V` gives
l3's version and the root's.

There is no sync command. Connected, l3 keeps each repo in step with the
Remote by itself: a command that reads a repo takes in the Remote's changes
to it first, and after every command each repo whose files differ from what
was last agreed is sent (which differ is seen from the digests kept, so a
repo in step costs no request). What a person does to the Remote is only
taking a repo off it; Git's words (commit, push, review, merge) are about
history, never about getting files there.

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
- Git: the repos' issues, read from each `issue/` (one file each, first line
  "Fix：件名"), filtered by repo chips; a row opens the file in Forge, and
  「Issue を書く」 adds the next numbered file (natively through `repo_add`,
  which only makes new files in existing directories), as `l3 issue new`
  does. Below: what is not cut yet (the draft against the last cut, by
  folder) and 区切る under the current issue, then the cuts.
- Remote: the canonical copy (`service/`). A browser signs in with a
  provider (GitHub で続ける) and then adds a passkey, so the next time needs
  none (パスキーでサインイン); with every passkey lost, the provider again.
  The app and l3 show a code that a browser approves
  (`?device&user_code=`). Signed in: each repo with where it stands
  (同期済み, 送っています, まだ送れていません), repos only on the Remote with
  開く, then passkeys, providers and the devices (sessions), each of which
  can be ended. Every change is sent as a
  diff within half a second; the Remote's changes are seen within five
  seconds and on focus; a file changed on both sides keeps this device's
  and puts the other beside it as "name (別の端末).ext". In a browser,
  closing the tab lets go of every copy the Remote holds all of.
- Runtime: この端末, then everything this OS holds on it in one list,
  largest first — repos, roots, leftovers, Home — each with what can be
  done: 空ける (a repo's changes not on the Remote yet are sent first; it
  comes back when opened), or why it stays (a Prompt has it open, a link that cannot be
  sent, the root in use). Sizes are allocated blocks; the host's free and
  total are marked as estimates, and after freeing the change the host
  shows is reported as observed. Prompts running show their memory and can
  be stopped; then the environment in effect.
- Topic (first in the rail, laid over any page like File): short posts on
  the Remote (`service/topic.ts`), read as a conversation (oldest above,
  newest at the foot by the purple lane one posts from, runs of one
  address shown once, a line where a day starts, Keep and Take down on
  hover), a page at a time as a range of ids. Anyone reads what
  has gone everywhere; posting needs an account and an Inbox address. A
  post starts with its author's contacts and a few readers and widens ring
  by ring (1/64, 1/16, 1/4, everyone signed in, everyone) as the readers of
  each ring keep it; who is in a ring is a per-post salt against a
  per-reader seed in the page's own query, so nothing runs per post. Near
  the top the next older page is read in without moving the reader; what
  came meanwhile goes at the foot (followed, or a pill to go down to it); pages far out of view fold to empty boxes of their
  height and, further still, let go of their posts, read again by their
  range when they come back. A post is text, 500 characters at most, 30 an
  hour, taken down only by its author, and keeps no profile.
- Every other purpose shows what it will hold, as a dashed empty box.

The webview has no other host access: it reads nothing outside the app's
data directory, runs no shell and launches no root. The app starts no host
program for a repo; its own tools run inside the root (`core/src/launch.rs`).

The Remote (`service/`): Hono with Better Auth (anonymous accounts held by
passkeys, a recovery code, device authorization, bearer sessions) on
Drizzle; Neon in production, PGlite in tests and here:

```
node service/dev.ts DIR 8787 http://localhost:1420     # the Remote, here
LENGTH3_DEV_REMOTE=http://127.0.0.1:8787 VITE_LENGTH3_REMOTE= npx vite
LENGTH3_REMOTE=http://127.0.0.1:8787 l3 login
npx wrangler deploy -c service/wrangler.toml            # on Cloudflare (not done)
```

## Develop

Linux needs the WebKitGTK toolchain:
`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`.

```
npm ci
npm run check                  # tsc + node:test
npx tauri dev                  # window against the Vite dev server
npx tauri build --debug --no-bundle
```

Icons in `src-tauri/icons` are generated from `src-tauri/icon.svg` with
`npx tauri icon src-tauri/icon.svg -o src-tauri/icons`.
