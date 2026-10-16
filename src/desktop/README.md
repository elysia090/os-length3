# Length³ OS desktop shell

Native work shell for Length³ OS (issue #17). Tauri v2 with a TypeScript
frontend and no UI framework. The browser preview (`src/v2/hosted`) is a
separate surface and nothing here depends on it.

## Layout

```
┌────┬──────────────────────────────────────────────┐
│ ⌂  │                                              │
│ ▤  │   the chosen purpose, full width             │
│ ⑂  │                                              │
│ …  │   Home: a profile page — avatar, name,       │
│    │   @handle, bio, repo cards, posts            │
│ ⊞  │                                              │
└────┴──────────────────────────────────────────────┘
```

- **Rail**: icons only (Home / File / Git / Forge / Runtime / Remote / Topic /
  Inbox, and the square-plus for a new repo). A name appears beside an icon
  on hover or keyboard focus. Choosing one replaces the main area; there is
  no second pane.
- **Home** is a profile, somewhere between a Twitter and a GitHub profile.
  It looks the same to its owner and to anyone else; the owner also gets
  "edit". Until accounts exist the profile is stored on this device.
- Colours: ground `#D2D2CD`, text `#292B2A`, rules `#929590`. Flat: no
  glow, shadows or depth effects.

## What is real in this step

- The rail, the profile (edit, validate, save locally).
- Runtime shows this device's storage: what the app holds, used, free and
  total, measured by the `capacity` command (statvfs plus allocated bytes
  under the app directory). In a browser it reads the origin's storage
  estimate and says so.
- Every other purpose shows what it will hold, as a dashed empty box.

The webview has no other host access: it reads no repo, runs no shell and
launches no root.

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
