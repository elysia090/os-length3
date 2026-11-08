#!/bin/sh
# The desktop app as it ships, a .deb and an AppImage, each with root3 beside the app: /usr/bin/root3 from the .deb
# (on the PATH, beside /usr/bin/length3-os), usr/bin/root3 inside the AppImage. root3 is the command line (`root3 app`
# opens the window; `root3 prompt`, `root3 address`), and it is what the app itself runs for a Prompt and for SSH
# (core/src/prompt.rs root3_path: the root3 beside the app), so an app without it opens neither.
#
#   sh scripts/desktop.sh [VERSION]
#
# The version is RELEASE's unless given. root3 is static (musl) and has SSH, so it runs on any x86-64 Linux
# whatever its libc; the root's own root3 (root-assemble.sh) is another build, without SSH. Needs Rust with the
# target x86_64-unknown-linux-musl, musl-gcc, Node 22, libgles2 and the Tauri build's packages (release.sh names
# them).
# The bundles are in target/release/bundle/{deb,appimage}.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
version=${1:-$(tr -d ' \n' < RELEASE)}

# The prompt profile: a musl build keeps its relocations (.cargo/config.toml), which a full strip cannot.
cargo build -q --locked --profile prompt -p root3 --target x86_64-unknown-linux-musl
# Tauri takes an external binary by its name and the triple the app is built for (bundle.externalBin).
host=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p src/desktop/binaries
install -m 0755 target/x86_64-unknown-linux-musl/prompt/root3 "src/desktop/binaries/root3-$host"

# WebKitGTK draws through libepoxy, which opens libGLESv2 itself while the app runs: no binary names it, so the
# AppImage's bundler leaves it out, and a machine without libgles2 (Debian 13 as installed, #37) stopped before a
# window with "Couldn't open libGLESv2.so.2". It goes in the AppImage beside libepoxy, whose RUNPATH ($ORIGIN) finds
# it first; what it calls (libGLdispatch) is the machine's, with its libEGL. desktop-smoke.sh holds this.
gles=$(ldconfig -p | sed -n 's/^[[:space:]]*libGLESv2\.so\.2 (libc6,x86-64) => //p' | head -n 1)
[ -n "$gles" ] || { echo "desktop: libGLESv2.so.2 is not here to put in the AppImage (apt install libgles2)" >&2; exit 1; }
gles=$(readlink -f "$gles")

# On Ubuntu 23.10 and later AppArmor keeps user namespaces from unprivileged programs, and root3's Prompts are made in
# them: the .deb carries a profile that lets /usr/bin/root3 make them (src/desktop/deb), which its postinst puts in place
# where the kernel has that restriction. An AppImage's root3 has no fixed path for a profile to name.
# What is said over src/desktop/tauri.conf.json: this version, root3 beside the app, libGLESv2 in the AppImage, the
# .deb's profile and its scripts, and the
# webview's policy for the Remote the page is built for (VITE_LENGTH3_REMOTE, as vite.config.ts reads it), from
# src/app/host/policy.ts.
config=$(VERSION="$version" GLES="$gles" node --input-type=module -e '
import {DEFAULT_REMOTE, desktopPolicy} from "./src/app/host/policy.ts";
const remote = process.env.VITE_LENGTH3_REMOTE ?? DEFAULT_REMOTE;
console.log(JSON.stringify({version: process.env.VERSION, build: {beforeBuildCommand: "npx vite build"},
  bundle: {externalBin: ["binaries/root3"], linux: {appimage: {files: {"/usr/lib/libGLESv2.so.2": process.env.GLES}},
    deb: {files: {"/usr/share/length3-os/apparmor/length3-root3": "deb/length3-root3.apparmor"},
      postInstallScript: "deb/postinst", postRemoveScript: "deb/postrm"}}},
  app: {security: {csp: desktopPolicy(remote ? new URL(remote).origin : "")}}}));')
# The AppImage is bundled by linuxdeploy, itself an AppImage: without FUSE it unpacks itself.
APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --config "$config"
