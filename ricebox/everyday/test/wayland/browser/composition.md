# Serve the optional shell and display composition

Use the pinned Wayland producer and the sandbox-on browser fixture's ordinary
[setup](README.md). For the same-page composition, also supply a trusted,
static x86-64 BusyBox executable, such as the release's /bin/busybox:

    EVERYDAY_SHELL_ELF=/path/to/static/busybox \
    SODS_TRANSLATOR_WASM=ricebox/sods/target/wasm32-unknown-unknown/release/sods.wasm \
    RICEBOX_MUK_FILE=target/muk/muk \
      sh ricebox/everyday/test/wayland/browser/run.sh target/everyday-fixture/wayland-presenter

Append --serve to that command to open only the loopback preview for a manual
check (by default the script runs Playwright). Use the current repository's
already-installed locked Node tooling. The script builds a Ricebox tarball,
installs it offline into a fresh npm consumer, typechecks that consumer against
the installed package, and bundles the copy. The application imports the
public ricebox and ricebox/everyday subpaths, not checkout source or aliases.

Without that opt-in binary there is no shell attachment. Even when it is
staged, the page fetches it and starts its Worker only when **Open guest
shell** is clicked. [shell-fixture.ts](shell-fixture.ts) opens the real BusyBox
interactive shell behind a simple bounded line console; this is not a full
terminal emulator. [demo.mts](demo.mts) owns the separate display Worker and
mounts its Wayland-produced surface with the public guest-surface routines.
They share the page and staged runtime assets, but not a guest, root
filesystem, stdin, session or retirement. Closing the display must not stop
the shell.

For an independent engine check against the same clean installed JavaScript
package and both real CPU Worker lanes, stage a temporary consumer:

    WORK=$(mktemp -d)
    node ricebox/everyday/test/wayland/browser/stage-consumer.mjs "$WORK/installed"
    node "$WORK/installed/consumer/browser/guest-pair.integration.mjs" \
      "$SODS_TRANSLATOR_WASM" "$RICEBOX_MUK_FILE" "$WAYLAND_ELF" "$EVERYDAY_SHELL_ELF"

The Node check does not establish browser pixels, physical presentation, or
Quickshell running in Sods.

## Preserve guest transparency over the host

For the opt-in alpha witness, also build the static Wayland client/server with
EVERYDAY_WITH_ALPHA=1 in the guest build stage and pass its resulting executable:

    EVERYDAY_ALPHA_ELF=/path/to/wayland-alpha-presenter

Set that together with the environment above. With --serve, open the loopback
page with ?surface=alpha to see the actual guest's transparent, half-alpha, and
opaque strips. Add &over=shell and open the optional shell to place its real
transcript behind the guest image. Shell controls remain separate. The default
page still loads only the opaque fixture.

The alpha fixture negotiates actual ARGB8888 SHM with padded rows, and the
test-owned mirror converts it to straight RGBA once. Browser tests distinguish
backing pixels from composited pixels over two CSS backdrops and hold the
guest serial fixed, so a host backdrop change is not a guest repaint. Exact
alpha, visible shell text and independent transport are not transparency in
stock Quickshell under Sods, nor a timing measurement.

For an engine-only alpha check, pass the alpha executable instead of the
opaque executable to the installed guest-pair check above and append --alpha.
It checks every RGBA pixel in both real guest buffer sizes without claiming
browser composition.

## Place the browser camera without moving the guest

Open the preview with ?camera=floating to position the browser view
independently of the page layout. Drag **Move view**, or focus it and use arrow
keys (Shift moves farther). **Pin position** locks placement; ?camera=pinned
starts locked. The viewport still scrolls inside the camera, and a smaller host
window clamps the frame into view. No placement or pin command is sent to the
guest, and it does not change the guest's resolution. This is browser camera
placement, not pinning an actual native Wayland or Quickshell window.
