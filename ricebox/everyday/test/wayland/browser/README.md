# Browser conformance gate

This fixture reuses the native lane's freshly built Wayland guest, current
Sods translator, and Muk. It does not replace the bounded guest mirror
with a new product display API or serve production data. Vite runs locally
in CI, bound to loopback only. The test always requests Chromium's sandbox.

With the build and locked Node dependencies already present, use the
current runtime artifacts and run from the repository root:

    SODS_TRANSLATOR_WASM=ricebox/sods/target/wasm32-unknown-unknown/release/sods.wasm \
    RICEBOX_MUK_FILE=target/muk/muk \
      sh ricebox/everyday/test/wayland/browser/run.sh target/everyday-fixture/wayland-presenter

The optional CI input everyday_chrome runs this gate in the existing native
lane. No fixture/video/screenshot is uploaded. On a supported browser,
the test checks clean capture and pan in both axes, a pointer through the
pan-adjusted canvas geometry, independent CSS vs xdg resize, exact Wayland
receipts, and close. It reads both the canvas backing pixel and the browser's
composited screenshot at DPR 1 and 2; this is not physical display timing.
