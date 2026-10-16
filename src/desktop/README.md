# Length³ OS desktop shell

Native work shell for Length³ OS (issue #17). Tauri v2 with a TypeScript
frontend and no UI framework. The browser preview (`src/v2/hosted`) is a
separate surface and nothing here depends on it.

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

- **Rail**: icons only (Home / Forge / File / Git / Runtime / Remote / Topic /
  Inbox, and a round + for a new repo). A name appears beside an icon
  on hover or keyboard focus. Choosing one replaces the main area; File is
  the one operation, laying the tree of "/" over the page instead.
- **Home** is a profile, somewhere between a Twitter and a GitHub profile.
  It looks the same to its owner and to anyone else; the owner also gets
  "edit". Until accounts exist the profile is stored on this device.
- The design language (rail order, page structure, colour roles, type,
  spacing) is in `DESIGN.md`.

## What is real in this step

- The rail, with the person's own icon at its foot (profile, edit, this
  device), and the profile (edit, validate, save locally).
- Repos the app manages under its data directory (`repos/`). + creates
  one from a template (standard, C, minimal) and runs `git init` without
  the host's git configuration. Inbox and TODO belong to the app, not to
  repos: TODO is a list on Home. Home lists the repos as cards.
- Forge: the repos out to work on as pills in a band on the top line
  (⊕ at the left brings every other repo out at once, × takes one off;
  with none left the center shows Topic); the center (3/4)
  is the open repo's files one after another like an endless page (README
  first, loaded as they scroll near), each a plain text editor with line
  numbers that saves on its own (natively through `repo_write`, which only
  replaces existing files inside the repo, atomically; files read only in
  part are never written), with a prompt box at its foot that
  types into the repo's `sh`. While the prompt is in use the terminal flies
  up above it from the right pane, where a search box for the repo sits on
  top and the reference (the repo's
  `issue/`; diff and run output not connected yet) grows into the
  room. No tabs: files are chosen from File.
- Prompt: translated BusyBox `sh` and `l3` running on the xlat kernel in a
  Worker, on the open repo. What the shell changes under `/root/<repo>` is
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
l3                          what is here
l3 repo [new NAME -t c]     repos (Home, +)
l3 file [REPO[/PATH]]       File: a directory's entries or a file's text
l3 file write REPO/PATH     replace a file with standard input (Forge's save)
l3 issue [REPO|new …]       Git's issues: numbered files in issue/
l3 git [REPO]               the Git page: issues and changes handed in
l3 todo [add …|done N]      Home's TODO
l3 runtime                  this device's room, and what can be given back
l3 reclaim                  give back this OS's own leftover temporaries
```

On the host it uses the app's data directory (`$LENGTH3_HOME` overrides):
`cargo install --path cli`. The same binary, built static for xlat, is
`/bin/l3` in the Prompt, where only the open repo is present and Home's
TODO, making repos and the device are left to the app.
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
  does. 区切る cuts the changes under the current issue and pushes the cut
  to the Remote.
- Remote: the canonical copy (`remote/`): make an account (a token shown
  once) or join with one; each repo and Home setting with where it stands
  (push 済み, 未 push, Remote が先, ここだけ). Opening takes in what the
  Remote has; in a browser, closing the tab lets go of every copy that is
  pushed, and keeps what is not. Run one here with `node remote/serve.ts
  DIR 8790 http://localhost:1420` and build or serve the app with
  `VITE_LENGTH3_REMOTE=http://127.0.0.1:8790`; on Cloudflare it is
  `remote/worker.ts` over R2 (`remote/wrangler.toml`, not deployed).
- Runtime shows what this OS holds on the device, counted from allocated
  blocks (each repo, how much of it is history), the host's free and total
  marked as estimates, and its own leftover temporaries, which 空ける
  (`reclaim`, or `l3 reclaim`) removes, reporting the bytes and how the
  host's free space was seen to change. Prompts running show their memory
  and can be stopped. In a browser it reads the origin's storage estimate
  and says so.
- Every other purpose shows what it will hold, as a dashed empty box.

The webview has no other host access: it reads nothing outside the app's
data directory, runs no shell and launches no root. The one program the
desktop runs is git, with an empty environment and every setting that could
make it run another program turned off (`core/src/boundary.rs`).

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
