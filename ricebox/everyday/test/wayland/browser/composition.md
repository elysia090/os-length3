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
