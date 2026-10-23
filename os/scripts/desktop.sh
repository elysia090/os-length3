#!/bin/sh
# The desktop app as it ships, a .deb and an AppImage, each with l3 beside the app: /usr/bin/l3 from the .deb
# (on the PATH, beside /usr/bin/length3-os), usr/bin/l3 inside the AppImage. l3 is the command line (`l3 app`
# opens the window; `l3 prompt`, `l3 address`), and it is what the app itself runs for a Prompt and for SSH
# (core/src/prompt.rs l3_path: the l3 beside the app), so an app without it opens neither.
#
#   sh scripts/desktop.sh [VERSION]
#
# The version is RELEASE's unless given. l3 is static (musl) and has SSH, so it runs on any x86-64 Linux
# whatever its libc; the root's own l3 (root-release.sh) is another build, without SSH. Needs Rust with the
# target x86_64-unknown-linux-musl, musl-gcc, Node 22, libgles2 and the Tauri build's packages (release.sh names
# them).
# The bundles are in target/release/bundle/{deb,appimage}.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
version=${1:-$(tr -d ' \n' < RELEASE)}

# The prompt profile: a musl build keeps its relocations (.cargo/config.toml), which a full strip cannot.
cargo build -q --locked --profile prompt -p l3 --target x86_64-unknown-linux-musl
# Tauri takes an external binary by its name and the triple the app is built for (bundle.externalBin).
host=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p src-tauri/binaries
install -m 0755 target/x86_64-unknown-linux-musl/prompt/l3 "src-tauri/binaries/l3-$host"

# WebKitGTK draws through libepoxy, which opens libGLESv2 itself while the app runs: no binary names it, so the
# AppImage's bundler leaves it out, and a machine without libgles2 (Debian 13 as installed, #37) stopped before a
# window with "Couldn't open libGLESv2.so.2". It goes in the AppImage beside libepoxy, whose RUNPATH ($ORIGIN) finds
# it first; what it calls (libGLdispatch) is the machine's, with its libEGL. desktop-smoke.sh holds this.
gles=$(ldconfig -p | sed -n 's/^[[:space:]]*libGLESv2\.so\.2 (libc6,x86-64) => //p' | head -n 1)
[ -n "$gles" ] || { echo "desktop: libGLESv2.so.2 is not here to put in the AppImage (apt install libgles2)" >&2; exit 1; }
gles=$(readlink -f "$gles")

# What is said over src-tauri/tauri.conf.json: this version, l3 beside the app, libGLESv2 in the AppImage, and the
# webview's policy for the Remote the page is built for (VITE_LENGTH3_REMOTE, as vite.config.ts reads it), from
# src/policy.ts.
config=$(VERSION="$version" GLES="$gles" node --input-type=module -e '
import {DEFAULT_REMOTE, desktopPolicy} from "./src/policy.ts";
const remote = process.env.VITE_LENGTH3_REMOTE ?? DEFAULT_REMOTE;
console.log(JSON.stringify({version: process.env.VERSION, build: {beforeBuildCommand: "npx vite build"},
  bundle: {externalBin: ["binaries/l3"], linux: {appimage: {files: {"/usr/lib/libGLESv2.so.2": process.env.GLES}}}},
  app: {security: {csp: desktopPolicy(remote ? new URL(remote).origin : "")}}}));')
# The AppImage is bundled by linuxdeploy, itself an AppImage: without FUSE it unpacks itself.
APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --config "$config"
