#!/bin/sh
# Everything a release of OS Length3 Linux holds, made from this tree, into OUT:
#
#   os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst  the root: the pinned 0.1.0 root laid out for Prompts
#                                                  with this tree's l3, profile and shell (root-release.sh)
#   os-length3-linux-X.Y.Z-l3-web.tar               the same root as the browser reads it (l3.sh), checked
#                                                  to be the same tree (l3-parity.mjs)
#   os-length3-linux-X.Y.Z-web.zip                  the web build, with that l3 (web-release.sh)
#   os-length3-linux-X.Y.Z-desktop-amd64.deb        the desktop app, its Prompt running that root on the
#   os-length3-linux-X.Y.Z-desktop-x86_64.AppImage  machine, with l3 beside it (desktop.sh)
#   SHA256SUMS, manifest                           the digests; what the root was made from
#
# and OUT/../notes.md, the release's notes. Before the web build and the app are made, the root is pinned
# in core/src/root.rs (pin-root.mjs), so what ships trusts this release's root; once the app is made, it is
# pinned in shared/desktop-releases.json (pin-desktop.mjs). Both changes stay in the tree, to be committed as
# one: release.yml proposes them to main. The release itself is made by publish-release.mjs (or
# .github/workflows/release.yml, which runs this script).
#
#   sh scripts/release.sh OUT
#
# The version is RELEASE ($VERSION overrides); the commit is HEAD ($GITHUB_SHA overrides). GITHUB_TOKEN, when
# set, reads the 0.1.0 release through the API (root-file.mjs); the repository is public. Needs Rust with the targets
# x86_64-unknown-linux-musl, wasm32-unknown-unknown and wasm32-wasip1, Node 22, musl-gcc, zstd, zip, the Tauri
# build's packages (libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf
# libgles2), and for the AppImage's smoke test bubblewrap, xvfb and imagemagick.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
[ $# -eq 1 ] || { echo "usage: sh scripts/release.sh OUT" >&2; exit 2; }
mkdir -p "$1"
out=$(cd "$1" && pwd)
version=${VERSION:-$(tr -d ' \n' < "$here/RELEASE")}
sha=${GITHUB_SHA:-$(git -C "$here" rev-parse HEAD)}
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || { echo "release: not a version: $version" >&2; exit 1; }
if [ -z "${GITHUB_SHA:-}" ] && [ -n "$(git -C "$here" status --porcelain)" ]; then
  echo "release: the tree has changes; a release is made from a commit as it is" >&2; exit 1
fi
cd "$here"

# The root: the 0.1.0 root (root-file.mjs takes it from its release, at its pin) with this tree's l3.
base=$(node scripts/root-file.mjs "$here/target/root" 0.1.0)
sh scripts/root-release.sh "$base" "$out" "$version"
root=$(ls "$out"/os-length3-linux-"$version"-x86_64-*.tar.zst)

# l3 for the browser, the same root: every path, type, mode, link target and sha256 as the app installs.
sh scripts/l3.sh "$root" public/l3
node scripts/l3-parity.mjs "$root" public/l3
l3web=os-length3-linux-$version-l3-web.tar
tar -C public/l3 --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=pax \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime -cf "$out/$l3web" .

# One entry pins both ways in, before anything that trusts it is built.
node scripts/pin-root.mjs "$root" public/l3

# The web build (it checks the types and runs the tests) and the desktop app.
L3_READY=1 sh scripts/web-release.sh
web=os-length3-linux-$version-web.zip
mv length3-web.zip "$out/$web"
rm -f length3-web.zip.sha256
# The app with l3 beside it (scripts/desktop.sh): the command line, and what its Prompt and SSH run. It runs its
# Prompt on the machine, from the root it installs: its build leaves l3 for the browser out (vite.config.ts).
sh scripts/desktop.sh "$version"
deb=os-length3-linux-$version-desktop-amd64.deb
appimage=os-length3-linux-$version-desktop-x86_64.AppImage
cp target/release/bundle/deb/*_"$version"_*.deb "$out/$deb"
cp target/release/bundle/appimage/*_"$version"_*.AppImage "$out/$appimage"
# Started as a machine without the build's extra libraries starts it (#37): a window, or no release.
sh scripts/desktop-smoke.sh "$out/$appimage"
mv "$out/smoke.png" "$out/../smoke.png"
node scripts/pin-desktop.mjs "$version" "$out/$deb" "$out/$appimage"

cd "$out"
sha256sum "$l3web" "$web" "$deb" "$appimage" >> SHA256SUMS
rootfile=$(basename "$root")
size() { stat -c %s "$1"; }
digest() { sha256sum "$1" | cut -d' ' -f1; }
{
  echo "# OS Length3 Linux $version"
  echo
  echo "The 0.1.0 root laid out for Prompts (nothing only a booted machine needs, merged /usr), with l3, its profile and shell from \`$sha\`; the web build of the same tree, whose Prompt runs that whole root (each file fetched when a program first reads it); and the desktop app (Length³ OS for x86-64 Linux, a .deb and an AppImage): the same UI, its Prompt running that root on the machine, which it installs and trusts by the digest pinned in this release."
  echo
  echo "| File | Bytes | SHA-256 |"
  echo "| --- | --- | --- |"
  for f in "$rootfile" "$l3web" "$web" "$deb" "$appimage"; do
    echo "| \`$f\` | $(size "$f") | \`$(digest "$f")\` |"
  done
  echo
  echo "Check and open the root:"
  echo
  echo '```sh'
  echo "sha256sum -c SHA256SUMS"
  echo "mkdir opened && tar --zstd -xf $rootfile -C opened"
  echo '```'
  echo
  echo "l3 $version is the root (the desktop app installs it) and \`$l3web\`, the same root as the browser reads it (the same paths, modes, links and bytes: checked when it was made). One entry of \`os/core/src/root.rs\` RELEASES pins both; the release pinned it:"
  echo
  echo '```rust'
  awk '/^pub const RELEASES/{on=1; sub(/^pub const RELEASES: &\[Release\] = &\[/, "")} on{print} on && /^}/{exit}' "$here/core/src/root.rs"
  echo '```'
  echo
  echo "and its desktop app in \`os/shared/desktop-releases.json\`, as below. Both are proposed to main as one change (Pin $version); once it is in, each deploy of the Remote takes the pinned root and desktop files from this release, checks them against those pins and puts them on the Remote, which hands them to anyone beside this release; a web build takes l3 from \`$l3web\` only at the pinned index (\`os/scripts/prompt-files.mjs\`)."
  echo
  echo '```json'
  echo "\"$version\": {"
  echo "  \"deb\": {\"file\": \"$deb\", \"bytes\": $(size "$deb"), \"sha256\": \"$(digest "$deb")\"},"
  echo "  \"appimage\": {\"file\": \"$appimage\", \"bytes\": $(size "$appimage"), \"sha256\": \"$(digest "$appimage")\"}"
  echo "}"
  echo '```'
  echo
  echo "\`manifest\` names the base, the l3 inside and the script that made it. The web build opens with any static server (\`npx serve\` in the unzipped folder). The desktop app: \`sudo apt install ./$deb\`, or \`chmod +x $appimage\` and run it (x86-64 Linux with glibc 2.39 or newer: Ubuntu 24.04, Debian 13 and later, with a desktop's libEGL)."
} > ../notes.md
cat ../notes.md
