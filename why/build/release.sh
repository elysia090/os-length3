#!/bin/sh
# Everything a release of OS Length3 Linux holds, made from this tree, into OUT:
#
#   os-length3-linux-X.Y.Z-x86_64-<sha256>.tar.zst  the root: every package made from this tree's pins by its
#                                                  recipe (ricebox/distribution/build/packages.sh), with this tree's Why CLI (why/build/guest-root.sh)
#   os-length3-linux-X.Y.Z-webroot.tar               the same root as the browser reads it (webroot.sh), checked
#                                                  to be the same tree (ricebox/distribution/verification/distribution.ts)
#   os-length3-linux-X.Y.Z-web.zip                  the web build, with that why (web-release.sh)
#   os-length3-linux-X.Y.Z-desktop-amd64.deb        the desktop app, its Prompt running that root on the
#   os-length3-linux-X.Y.Z-desktop-x86_64.AppImage  machine, with why beside it (desktop.sh)
#   os-length3-linux-X.Y.Z-film.mp4                a film of the release at work, when the release-film branch
#                                                  holds one (film.mp4, its sha256 in film.sha256)
#   SHA256SUMS, manifest                           the digests; what the root was made from
#
# and OUT/../notes.md, the release's notes. Before the web build and the app are made, the root is pinned
# in why/prompt/roots/pins.rs (pin-root.ts), so what ships trusts this release's root; once the app is made, it is
# pinned in why/shipto/desktop-releases.json (pin-desktop.ts). Both changes stay in the tree, to be committed as
# one: release.yml proposes them to main. The release itself is made by publish-release.ts (or
# .github/workflows/release.yml, which runs this script).
#
#   sh why/build/release.sh OUT
#
# The version is why/LEGACY_RELEASE ($VERSION overrides); the commit is HEAD ($GITHUB_SHA overrides). The root's packages are
# ROOT_PACKAGES, what ricebox/distribution/build/packages.sh made on Alpine 3.24 (release.yml makes them through the root-packages action and
# keeps them from release to release; see why/docs/operations.md for the manual build). Needs Rust with the targets
# x86_64-unknown-linux-musl, wasm32-unknown-unknown and wasm32-wasip1, Node 22, musl-gcc, zstd, zip, the Tauri
# build's packages (libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf
# libgles2), and for the AppImage's smoke test bubblewrap, xvfb and imagemagick.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
[ $# -eq 1 ] || { echo "usage: sh why/build/release.sh OUT" >&2; exit 2; }
mkdir -p "$1"
out=$(cd "$1" && pwd)
version=${VERSION:-$(tr -d ' \n' < "$here/why/LEGACY_RELEASE")}
why_version=$(cat "$here/why/VERSION")
sha=${GITHUB_SHA:-$(git -C "$here" rev-parse HEAD)}
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || { echo "release: not a version: $version" >&2; exit 1; }
if [ -z "${GITHUB_SHA:-}" ] && [ -n "$(git -C "$here" status --porcelain)" ]; then
  echo "release: the tree has changes; a release is made from a commit as it is" >&2; exit 1
fi
cd "$here"
# Do not publish under a new-line version via the legacy pipeline while the
# Ricebox target matrix still has unverified or unimplemented entries.
case "$version" in 0.[0-5].*) node ricebox/sods/runtime/targets.ts --owed ;; esac

# The root: its packages, made from this tree's pins, with this tree's why.
sh why/build/guest-root.sh "${ROOT_PACKAGES:?the root's packages, as ricebox/distribution/build/packages.sh made them}" "$out" "$version"
root=$(ls "$out"/os-length3-linux-"$version"-x86_64-*.tar.zst)

# The film of the release, from the branch that holds it (kept out of main's history), checked against its digest.
film=os-length3-linux-$version-film.mp4
if git -C "$here" fetch -q --depth=1 "${FILM_REMOTE:-https://github.com/${GITHUB_REPOSITORY:-elysia090/os-length3}.git}" release-film 2>/dev/null \
  && git -C "$here" cat-file -e FETCH_HEAD:film.mp4 2>/dev/null; then
  git -C "$here" show FETCH_HEAD:film.mp4 > "$out/$film"
  echo "$(git -C "$here" show FETCH_HEAD:film.sha256 | cut -d' ' -f1)  $out/$film" | sha256sum -c - >/dev/null \
    || { echo "release: the film is not the one film.sha256 names" >&2; exit 1; }
else
  film=
fi

# The web root, the same root: every path, type, mode, link target and sha256 as the app installs.
sh why/build/webroot.sh "$root" why/app/public/webroot
node ricebox/distribution/verification/distribution.ts "$root" why/app/public/webroot
webroot=os-length3-linux-$version-webroot.tar
tar -C why/app/public/webroot --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=pax \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime -cf "$out/$webroot" .

# One entry pins both ways in, before anything that trusts it is built.
node why/build/pin-root.ts "$root" why/app/public/webroot

# The web build (it checks the types and runs the tests) and the desktop app.
WEBROOT_READY=1 sh why/build/web-release.sh
web=os-length3-linux-$version-web.zip
mv why-web.zip "$out/$web"
rm -f why-web.zip.sha256
# The app with why beside it (why/build/desktop.sh): the command line, and what its Prompt and SSH run. It runs its
# Prompt on the machine, from the root it installs: its build leaves the web root out (vite.config.ts).
sh why/build/desktop.sh
deb=os-length3-linux-$version-desktop-amd64.deb
appimage=os-length3-linux-$version-desktop-x86_64.AppImage
# Tauri names the local packages by Why's version; published files are
# named by this distribution release, like the other assets and its pins.
cp target/release/bundle/deb/*_"$why_version"_*.deb "$out/$deb"
cp target/release/bundle/appimage/*_"$why_version"_*.AppImage "$out/$appimage"
# Started as a machine without the build's extra libraries starts it (#37): a window, or no release.
sh why/build/desktop-smoke.sh "$out/$appimage"
mv "$out/smoke.png" "$out/../smoke.png"
node why/build/pin-desktop.ts "$version" "$out/$deb" "$out/$appimage"

cd "$out"
sha256sum "$webroot" "$web" "$deb" "$appimage" $film >> SHA256SUMS
rootfile=$(basename "$root")
size() { stat -c %s "$1"; }
digest() { sha256sum "$1" | cut -d' ' -f1; }
{
  echo "# OS Length3 Linux $version"
  echo
  echo "The root, laid out for Prompts (merged /usr): each of its $(grep -c '^package\.' manifest) packages made by its recipe (\`ricebox/distribution/packages\`) from the source this tree pins, checked against its digest, on one pinned Alpine, static and hardened, with why, its profile and shell from \`$sha\` (\`manifest\` says each package's version, its source's digest and the key it was made under); the web build of the same tree, whose Prompt runs that whole root (each file fetched when a program first reads it); and the desktop app (why* for x86-64 Linux, a .deb and an AppImage): the same UI, its Prompt running that root on the machine, which it installs and trusts by the digest pinned in this release.${film:+ \`$film\` shows it at work.}"
  echo
  echo "| File | Bytes | SHA-256 |"
  echo "| --- | --- | --- |"
  for f in "$rootfile" "$webroot" "$web" "$deb" "$appimage" $film; do
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
  echo "Why is $why_version. The distribution release $version contains the root (the desktop app installs it) and \`$webroot\`, the same root as the browser reads it (the same paths, modes, links and bytes: checked when it was made). One entry of \`why/prompt/roots/pins.rs\` RELEASES pins both; the release pinned it:"
  echo
  echo '```rust'
  awk '/^pub const RELEASES/{on=1; sub(/^pub const RELEASES: &\[Release\] = &\[/, "")} on{print} on && /^}/{exit}' "$here/why/prompt/roots/pins.rs"
  echo '```'
  echo
  echo "and its desktop app in \`why/shipto/desktop-releases.json\`, as below. Both are proposed to main as one change (Pin $version); once it is in, each deploy of the Remote takes the pinned root and desktop files from this release, checks them against those pins and puts them on the Remote, which hands them to anyone beside this release; a web build takes the root from \`$webroot\` only at the pinned index (\`why/build/fetch-webroot.ts\`)."
  echo
  echo '```json'
  echo "\"$version\": {"
  echo "  \"deb\": {\"file\": \"$deb\", \"bytes\": $(size "$deb"), \"sha256\": \"$(digest "$deb")\"},"
  echo "  \"appimage\": {\"file\": \"$appimage\", \"bytes\": $(size "$appimage"), \"sha256\": \"$(digest "$appimage")\"}"
  echo "}"
  echo '```'
  echo
  echo "\`manifest\` names each package, the why inside and the script that put them together. The web build opens with any static server (\`npx serve\` in the unzipped folder). The desktop app: \`sudo apt install ./$deb\`, or \`chmod +x $appimage\` and run it (x86-64 Linux with glibc 2.39 or newer: Ubuntu 24.04, Debian 13 and later, with a desktop's libEGL)."
} > ../notes.md
cat ../notes.md

