# Browser conformance gate

This fixture reuses the native lane's freshly built Wayland guest, current
Sods translator, and Muk. It uses the opt-in Everyday surface API with the
fixture's own bounded guest-mirror format. The decoder lends the validated
RGBA span of each fixed, received Worker buffer for its synchronous canvas
draw. It does not allocate another pixel array on that path; the guest mirror
and the canvas backing-store write still do their own work.
Vite runs locally in CI, bound to
loopback only, without production data. The test always requests Chromium's
sandbox.

With the build and locked Node dependencies already present, use the
current runtime artifacts and run from the repository root:

    SODS_TRANSLATOR_WASM=ricebox/sods/target/wasm32-unknown-unknown/release/sods.wasm \
    RICEBOX_MUK_FILE=target/muk/muk \
      sh ricebox/everyday/test/wayland/browser/run.sh target/everyday-fixture/wayland-presenter

This stages a fresh local npm consumer and installs the built Ricebox tarball
offline. The app exercises the public export names without bundling source
modules from the checkout. Use --serve as the second argument for a loopback
preview instead of running Playwright. See [composition](composition.md)
for the optional independent guest shell.

The optional CI input everyday_chrome runs this gate in the existing native
lane. It uses the runner's preinstalled Google Chrome Stable at
`/opt/google/chrome/chrome`, not Playwright's downloaded headless shell.
The job records the runner image, package and browser versions, then checks
the browser's own Linux sandbox report in a separate process before running
the guest test and same-page composition with the native lane's already
installed static BusyBox. A missing prerequisite or inactive sandbox fails the
lane without installing Chrome, adjusting host policy or falling back to an
unsandboxed browser. No fixture/video/screenshot is uploaded. On a supported browser,
the test checks clean capture and pan in both axes, a pointer through the
pan-adjusted canvas geometry, independent CSS vs xdg resize, exact Wayland
receipts, and close. It reads both the canvas backing pixel and the browser's
composited screenshot at DPR 1 and 2; this is not physical display timing.

## Display owner check without a browser

From the repository root with locked dependencies:

    stage="$(mktemp -d)/installed"
    node ricebox/everyday/test/wayland/browser/stage-consumer.mjs "$stage"
    node ricebox/everyday/test/wayland/browser/display-owner.integration.mjs \
      "$stage/consumer/browser"

This checks that delivered frames draw synchronously with no pending renderer
work, and that an injected Worker message decoding error clears the surface,
disables its controls, and retires its owner. The fixture substitutes a DOM
and Worker event target, not a guest or a browser. This is not a Chrome frame
rate, transport backlog, or Wayland buffer-release measurement.

### Reopen the guest view without restarting the shell

With the default line console and an explicitly staged BusyBox, **Open guest view
window** opens a separate window. Keep the original keeper tab open. Closing
the view, including from its title bar, stops the drawing and returns the same
shell to the keeper. Use **Reopen guest view window**, then **Show drawing** to
start a fresh drawing. **Stop drawing** retires that drawing before it can be
started again. The terminal Worker belongs to the keeper; the view has no
separate guest, command endpoint, saved transcript, or automatic reopen.

Use **End guest session** to retire both guests; closing the keeper or the
15-minute keeper expiry also stops admission. A suspended Chrome tab can only
retire its Workers after it resumes; no new input or drawing is admitted then. A blocked popup leaves the
in-page view usable. The separate-window mode is not offered in optional VT,
camera-placement, or overlay variants of this reference fixture.
