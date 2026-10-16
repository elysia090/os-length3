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
- Forge: the repos out to work on as pills in a band set low at the top
  (⊕ at the left brings every other repo out at once, × takes one off;
  with none left the center shows Topic); the center (3/4)
  is the open repo's files one after another like an endless page (README
  first, loaded as they scroll near), each shown like a plain text editor
  with line numbers, kind, lines and size, with a prompt box at its foot that
  types into the repo's `sh`. While the prompt is in use the terminal flies
  up above it from the right pane, where the reference (the repo's
  `issue/`; diff and run output not connected yet) grows into the
  room. No tabs: files are chosen from File.
- Terminal: translated BusyBox `sh` running on the xlat kernel in a
  Worker, on a copy of the open repo. Changes there are not written back
  yet, and it says so. Prepare its files with `npm run userland` (see
  `scripts/userland.sh`).
- File: hovering or pressing its icon lays the tree of "/" over any page —
  the whole system as the shell sees it (`/bin` from the fetched
  distribution, repos under `/root`) — and it stays 8 s after the pointer
  leaves. ▷/▽ before a folder opens it; a name inside a repo opens that
  place in Forge. Every path from the webview is checked
  to stay inside its repo after following symlinks.
- Runtime shows this device's storage: what the app holds, used, free and
  total, measured by the `capacity` command (statvfs plus allocated bytes
  under the app directory). In a browser it reads the origin's storage
  estimate and says so.
- Every other purpose shows what it will hold, as a dashed empty box.

The webview has no other host access: it reads nothing outside the app's
data directory, runs no shell and launches no root.

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
