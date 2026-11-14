#!/bin/sh
# The desktop app as it ships, a .deb and an AppImage, each with why beside the app: /usr/bin/why from the .deb
# (on the PATH, beside /usr/bin/why-desktop), usr/bin/why inside the AppImage. why is the command line (`why app`
# opens the window; `why prompt`, `why address`), and it is what the app itself runs for a Prompt and for SSH
# (core/src/prompt/running.rs why_path: the why beside the app), so an app without it opens neither. Beside why,
# the two programs it starts a box with (core/src/prompt/start.rs): muk, which makes it (module/muk), and prompt,
# which holds the other end of its terminal (module/prompt).
#
#   sh scripts/desktop.sh [VERSION]
#
# The version is module/ricebox/RELEASE's unless given. why is static (musl) and has SSH, so it runs on any x86-64 Linux
# whatever its libc; the root's own why (root-assemble.sh) is another build, without SSH. Needs Rust with the
# target x86_64-unknown-linux-musl, musl-gcc, Node 22, libgles2 and the Tauri build's packages (release.sh names
# them).
# The bundles are in target/release/bundle/{deb,appimage}.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
version=${1:-$(tr -d ' \n' < module/ricebox/RELEASE)}

# The prompt profile: a musl build keeps its relocations (.cargo/config.toml), which a full strip cannot.
cargo build -q --locked --profile prompt -p why --target x86_64-unknown-linux-musl
# Tauri takes an external binary by its name and the triple the app is built for (bundle.externalBin).
host=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p why/desktop/binaries
install -m 0755 target/x86_64-unknown-linux-musl/prompt/why "why/desktop/binaries/why-$host"
# muk is one unit of C with no library (module/lib/build.sh makes and checks it); prompt is static too, of its own
# cargo (module/prompt is no member of this workspace).
sh module/lib/build.sh module/muk/src/muk.c "why/desktop/binaries/muk-$host"
cargo build -q --locked --release --manifest-path module/prompt/Cargo.toml --target x86_64-unknown-linux-musl --target-dir target/prompt
install -m 0755 target/prompt/x86_64-unknown-linux-musl/release/prompt "why/desktop/binaries/prompt-$host"

# WebKitGTK draws through libepoxy, which opens libGLESv2 itself while the app runs: no binary names it, so the
# AppImage's bundler leaves it out, and a machine without libgles2 (Debian 13 as installed, #37) stopped before a
# window with "Couldn't open libGLESv2.so.2". It goes in the AppImage beside libepoxy, whose RUNPATH ($ORIGIN) finds
# it first; what it calls (libGLdispatch) is the machine's, with its libEGL. desktop-smoke.sh holds this.
gles=$(ldconfig -p | sed -n 's/^[[:space:]]*libGLESv2\.so\.2 (libc6,x86-64) => //p' | head -n 1)
[ -n "$gles" ] || { echo "desktop: libGLESv2.so.2 is not here to put in the AppImage (apt install libgles2)" >&2; exit 1; }
gles=$(readlink -f "$gles")

# On Ubuntu 23.10 and later AppArmor keeps user namespaces from unprivileged programs, and a Prompt's box is made in
# one: the .deb carries a profile that lets /usr/bin/muk make them (why/desktop/deb), which its postinst puts in place
# where the kernel has that restriction. An AppImage's muk has no fixed path for a profile to name.
# What is said over why/desktop/tauri.conf.json: this version, why beside the app, libGLESv2 in the AppImage, the
# .deb's profile and its scripts (and that it takes the place of length3-os, the package it was up to 0.6.4), and the
# webview's policy for the Remote the page is built for (VITE_LENGTH3_REMOTE, as vite.config.ts reads it), from
# why/app/host/policy.ts.
config=$(VERSION="$version" GLES="$gles" node --input-type=module -e '
import {DEFAULT_REMOTE, desktopPolicy} from "./why/app/host/policy.ts";
const remote = process.env.VITE_LENGTH3_REMOTE ?? DEFAULT_REMOTE;
console.log(JSON.stringify({version: process.env.VERSION, build: {beforeBuildCommand: "npx vite build --config why/app/vite.config.ts"},
  bundle: {externalBin: ["binaries/why", "binaries/muk", "binaries/prompt"], linux: {appimage: {files: {"/usr/lib/libGLESv2.so.2": process.env.GLES}},
    deb: {files: {"/usr/share/why/apparmor/why": "deb/why.apparmor"},
      postInstallScript: "deb/postinst", postRemoveScript: "deb/postrm",
      conflicts: ["length3-os"], replaces: ["length3-os"]}}},
  app: {security: {csp: desktopPolicy(remote ? new URL(remote).origin : "")}}}));')
# The AppImage is bundled by linuxdeploy, itself an AppImage: without FUSE it unpacks itself.
APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --config "$config"
