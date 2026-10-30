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

Two merges, and nothing by hand between them:

1. A change that writes the new version into [`os/RELEASE`](../os/RELEASE)
   is merged to main. `.github/workflows/release.yml` makes everything the
   release holds (`os/scripts/release.sh`), publishes it at that commit,
   and opens **Pin vX.Y.Z**: the release's root in `os/core/src/root.rs`
   RELEASES and its desktop app in `os/shared/desktop-releases.json`.
2. **Pin vX.Y.Z** is merged. The tree now ships it: the web build takes
   that l3, devices trust that root, and the Remote's deploy puts the
   release's files on the Remote.

Until the pins are merged, the tree ships the newest version it pins (RELEASE
names the one being made), so nothing in between is broken. A version
already published is left as it is.

Without Actions, the same is done from a clean checkout of main with Rust
(targets `x86_64-unknown-linux-musl`, `wasm32-unknown-unknown`,
`wasm32-wasip1`), Node 22, musl-tools and the Tauri build packages
(`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf`),
then the two pinned files committed as the pins' change:

```sh
cd os
sh scripts/release.sh ../out                          # everything the release holds, notes.md, and the pins in the tree
GITHUB_TOKEN=… node scripts/publish-release.mjs ../out  # the release at this commit, with those files
```

The sources the root is built from are pinned in
[`distribution/sources.env`](../distribution/sources.env);
`.github/workflows/sources-next.yml` says every week which have a newer
release, with the digests to pin it by.

## The native base

[`native/`](native/) holds the 0.1.0 base's notes, its verification receipts
and the evidence they cite (`native/evidence/`). A receipt keeps the paths of
the tree it was made from.
