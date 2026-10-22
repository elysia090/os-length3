# Releases

Each release is a GitHub release tagged `os-length3-linux-vX.Y.Z`, made from
a commit on main. Its notes (on the release page) list every file with its
size and SHA-256, and `SHA256SUMS` beside them holds the same digests.

| Version | What it is |
| --- | --- |
| [0.5.0](https://github.com/elysia090/os-length3/releases/tag/os-length3-linux-v0.5.0) | Length³ OS with one core for the app and the web (the web runs the core the app runs, built for `wasm32-wasip1`), the desktop app opened from `l3 app`, SSH into a repo's Prompt, Runtime's environments (l3, Ubuntu, Debian, Custom) |
| [0.4.1](https://github.com/elysia090/os-length3/releases/tag/os-length3-linux-v0.4.1) | the root laid out for Prompts, the web build and the desktop app (.deb, AppImage) |
| [0.4.0](https://github.com/elysia090/os-length3/releases/tag/os-length3-linux-v0.4.0) | the first release with the desktop app |
| [0.3.0](https://github.com/elysia090/os-length3/releases/tag/os-length3-linux-v0.3.0) | the 0.1.0 root with l3 in it, and the web build whose Prompt runs that whole root |
| [0.1.0](https://github.com/elysia090/os-length3/releases/tag/os-length3-linux-v0.1.0) | the native base: `development-standard-v1` post-link compiled, packaged and booted ([notes](native/RELEASE-0.1.0.md)) |
| [0.1.0-rc.1](https://github.com/elysia090/os-length3/releases/tag/os-length3-linux-v0.1.0-rc.1) | its candidate ([notes](native/RELEASE.md), [measurements](native/README.md)) |

Every release from 0.3.0 on is the 0.1.0 root repackaged
(`os/scripts/root-release.sh`: what only a booted machine needs goes, `/usr`
is merged, and `/usr/bin/l3` from that release's commit goes in), so its root
is a few megabytes smaller and otherwise the same programs. 0.2.0 was
prepared ([notes](native/RELEASE-0.2.0.md)) and not published.

## Making one

The version is [`os/RELEASE`](../os/RELEASE). Changing it on main runs
`.github/workflows/release.yml`; a version already published is left as it
is. Without Actions, the same is done by hand from a clean checkout of main
with Rust (targets `x86_64-unknown-linux-musl`, `wasm32-unknown-unknown`,
`wasm32-wasip1`), Node 22, musl-tools and the Tauri build packages
(`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf`):

```sh
cd os
GITHUB_TOKEN=… sh scripts/release.sh ../out           # everything the release holds, and notes.md
GITHUB_TOKEN=… node scripts/publish-release.mjs ../out  # the release at this commit, with those files
```

Then the pins the notes give are committed to main (`os/core/src/root.rs`
RELEASES, which `release.sh` already wrote in the tree, and
`os/shared/desktop-releases.json`), since the web build and the Remote's
deploy take only what this tree pins.

## The native base

[`native/`](native/) holds the 0.1.0 base's notes, its verification receipts
and the evidence they cite (`native/evidence/`). A receipt keeps the paths of
the tree it was made from.
