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
    node ricebox/everyday/test/wayland/browser/stage-consumer.ts "$stage"
    node ricebox/everyday/test/wayland/browser/display-owner.integration.ts \
      "$stage/consumer/browser"
    node ricebox/everyday/test/wayland/browser/display-owner.integration.ts \
      "$stage/consumer/browser" --inner-window

This checks that delivered frames draw synchronously with no pending renderer
work, and that an injected Worker message decoding error clears the surface,
disables its controls, and retires its owner. The fixture substitutes a DOM
and Worker event target, not a guest or a browser. The inner-window case checks that
an early reopen cannot overtake retirement or accept stale frames. This is not a Chrome frame
rate, transport backlog, or Wayland buffer-release measurement.

### Close and reopen the drawing window

With the default line console and an explicitly staged BusyBox, use **Close**
in the **Drawing window** title bar. It hides the drawing and retires its
renderer. The guest shell remains in the same page and keeps running. Once
retirement is confirmed, **Open drawing window** brings the drawing back
with a fresh renderer. It does not open a Chrome window or tab. **Stop
drawing** and **Show drawing** restart the drawing without hiding its window.

**End guest session**, leaving the page, or the 15-minute expiry ends the
session. A suspended page may not retire its Workers until it resumes;
expired sessions admit no new input or drawing. This window control is not
offered in the optional VT, camera-placement, or shell-overlay variants.
