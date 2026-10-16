# Length³ OS desktop shell

Native work shell for Length³ OS (issue #17). Tauri v2 with a TypeScript
frontend and no UI framework. The browser preview (`src/v2/hosted`) is a
separate surface and nothing here depends on it.

## Layout

```
┌────┬──────────┬──────────────────────────┬──────────────┐
│Home│ target   │ repo strip               │ reference    │
│File│ column   ├──────────────────────────┤ (switchable) │
│Git │          │ center: one vertical     │              │
│... │          │ flow, browser-like       ├──────────────┤
│    │          │                          │ Terminal     │
│ □+ │          │                          │              │
└────┴──────────┴──────────────────────────┴──────────────┘
```

- **Rail**: purpose. Home / File / Git / Forge / Runtime / Remote / Topic /
  Inbox, then the square-plus for a new repo at the foot.
- **Target column**: the targets for the chosen purpose.
- **Center**: the repo strip, then the only page-like scroll.
- **Right pane**: a switchable reference over the terminal.

A purpose switch only rewrites the target column. The center scroll and the
right pane are never rebuilt by it.

## Stage

The window is a lit WebGL2 stage (`src/scene`) with glass panels in front.
Each purpose is a place on one floor; choosing it flies the camera there on
critically damped springs. Magnitudes are volumes: a cube's edge is the cube
root of the bytes it stands for. Dashed frames are places with nothing
connected yet, so the shell never explains absence in sentences or fakes
content. The stage renders only while something moves.

## What is real in this step

- The rail and the camera stations.
- Home measures the filesystem holding the app's data (`capacity` command:
  statvfs totals plus allocated bytes under the app directory). In a browser
  the same view reads the origin's storage estimate and says so.

The webview has no other host access: it reads no repo, runs no shell and
launches no root.

- Click or ↑/↓/Home/End selects a purpose (vertical tab list, roving focus).
- The last purpose view is remembered locally. The new-repo step is not,
  because reopening the app into a creation step would be wrong.

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
`npx tauri icon src-tauri/icon.svg -o src-tauri/icons`. Intel One Mono is
bundled under the SIL OFL (`public/fonts/OFL.txt`).
