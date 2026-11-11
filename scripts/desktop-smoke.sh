#!/bin/sh
# The AppImage as a machine without the build's extra libraries starts it (#37): unpacked, its AppRun is run on a
# display of its own (Xvfb) inside a sandbox (bwrap) whose view of the host has no libGLESv2 (libgles2, which a
# Debian 13 desktop does not have), so the GL that WebKitGTK opens while it runs, not only what ldd lists, has to
# come from the AppImage. It passes when the app is still up after a while and its window has drawn something;
# the screen is kept as smoke.png beside the AppImage. The host itself is not changed.
#
#   sh scripts/desktop-smoke.sh path/to/os-length3-linux-X.Y.Z-desktop-x86_64.AppImage
#
# Needs bubblewrap, Xvfb and ImageMagick (import, convert).
set -eu
[ $# -eq 1 ] || { echo "usage: sh scripts/desktop-smoke.sh APPIMAGE" >&2; exit 2; }
image=$(readlink -f "$1")
tmp=$(mktemp -d)
app=''; x=''
trap 'kill $app $x 2>/dev/null || true; rm -rf "$tmp"' EXIT

(cd "$tmp" && "$image" --appimage-extract > /dev/null)
gles=$(ldconfig -p | sed -n 's/^[[:space:]]*libGLESv2\.so\.2 (libc6,x86-64) => //p' | head -n 1)

# A display of its own, its number said by Xvfb once it listens.
Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp 3> "$tmp/display" 2> /dev/null &
x=$!
for _ in $(seq 50); do [ -s "$tmp/display" ] && break; sleep 0.1; done
display=:$(cat "$tmp/display")

# The host as the sandbox sees it: read only, a /tmp and a home of its own, and the host's libGLESv2 (if it has
# one) an empty file.
mkdir -p "$tmp/home/run"
chmod 700 "$tmp/home/run"
set -- --ro-bind / / --dev-bind /dev /dev --proc /proc --tmpfs /tmp --bind /tmp/.X11-unix /tmp/.X11-unix \
  --bind "$tmp" "$tmp" --die-with-parent
[ -n "$gles" ] && set -- "$@" --ro-bind /dev/null "$(readlink -f "$gles")"
bwrap "$@" env HOME="$tmp/home" XDG_RUNTIME_DIR="$tmp/home/run" DISPLAY="$display" \
  "$tmp/squashfs-root/AppRun" > "$tmp/app.log" 2>&1 &
app=$!

sleep 10
shot=$(dirname "$image")/smoke.png
DISPLAY=$display import -window root "$shot" 2> /dev/null || true
if ! kill -0 "$app" 2> /dev/null; then
  echo "desktop-smoke: the app ended before it showed a window:" >&2
  tail -n 5 "$tmp/app.log" >&2
  exit 1
fi
# A window that drew: the screen is not one colour.
spread=$(convert "$shot" -format '%[fx:standard_deviation]' info: 2> /dev/null || echo 0)
if ! awk -v s="$spread" 'BEGIN { exit !(s > 0.01) }'; then
  echo "desktop-smoke: the app is up but drew nothing ($shot)" >&2
  exit 1
fi
echo "desktop-smoke: the app is up and drew its window, without the host's libGLESv2 ($shot)"
