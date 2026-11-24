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
    node ricebox/everyday/test/wayland/browser/stage-consumer.ts "$WORK/installed"
    node "$WORK/installed/consumer/browser/guest-pair.integration.ts" \
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

## Keep a thin camera scrollbar without a thin hit target

Use ?scrollbars=hairline (combine it with &camera=floating if wanted). The
[camera stylesheet](camera-scrollbars.css) paints both native scrollbar thumbs
at 1.6 CSS px in supported Chrome, with a 24 CSS px native drag gutter.
Physical pixels round according to device scale. The camera still uses ordinary
browser overflow for wheel, keyboard, touch and pointer dragging; no guest
input or resize is sent. Browsers without the exact styling, and forced-colors
or custom contrast modes, keep their normal scrollbars. Omit the parameter to
use the platform look.

## Use the opt-in guest terminal screen

With BusyBox staged as above, add ?terminal=screen to the URL and select
**Open guest shell**. The regular line console is still the default. The
opt-in view draws the same guest's ordered output through the shared bounded
VT model. It uses existing guest termios to switch from a line form to raw
keystrokes, shows the alternate screen, and interrupts a running guest with
Ctrl+C from the command field or its **Interrupt** button. The guest screen
is fixed at 80×24 unless you opt into the fit mode below. This reference
does not offer terminal scrollback or complete terminal/IME compatibility.
The independent Wayland guest is not affected.


### Fit the terminal viewport (separate opt-in)

Add &terminalResize=fit to ?terminal=screen for the separately laid-out
terminal. After the shell is ready for input, the fixed terminal output box
and its monospace cell size determine the columns and rows in CSS pixels,
up to the screen's 240×100 cell budget. Hidden or undersized boxes don't
request a new geometry. Changing the browser viewport doesn't change the
other guest's Wayland surface, camera, or pointer. Fit is not enabled for
the transparency sample's moved shell underlay (?surface=alpha&over=shell).

One request waits for the Worker's ordered geometry marker while a single
latest layout can replace any intervening layout. The view verifies the
marker's cumulative byte position, including bytes discarded by a Ctrl+C
epoch, and resizes before parsing subsequent bytes without resetting an
incomplete character or escape sequence. The ordinary size ACK does not
resize the view. The bounded VT keeps visible cells without reflowing old
lines; it clips a wide glyph if only half fits and has no scrollback. The
foreground guest gets the normal Linux SIGWINCH on a change, not a browser
resize callback or repaint guarantee.

A typed refusal stops fitting and keeps the last confirmed grid with
ordinary scrollable output. A missing or inconsistent marker is different:
the guest and screen may disagree, so this reference closes the shell rather
than guessing or retrying. End of output or page departure stops observation
and discards pending layout work. The other guest and its display are not
involved.
