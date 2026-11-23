# Installed static Everyday acceptance

Private-run QA tools; no scheduled or triggered workflow, Vite, or deployment.
The exact product checkout is PR #217 at `28c45a65649b1058da0ad5077624e8fd4fa3cee9`. Keep it detached and clean, separate from the commit carrying this test suite. Test artefacts are not product runtime or reference guest packages.

```sh
node self-test.mjs "$EXACT_CHECKOUT/ricebox/everyday/test/wayland/browser/stock-chrome.ts"
node run-static-acceptance.mjs --doctor
node run-static-acceptance.mjs "$EXACT_CHECKOUT" "$APPROVED_PREPARED_ROOT" \
  "$APPROVED_ROOT_JSON" ./sealed-parent "$NEW_PRIVATE_REPORT_DIR" [PINNED_MUSL_PRESENTER]
```

Use Node 24 and an x86-64 Linux runner with normal IPv4/Unix sockets and installed `google-chrome-stable` owning `/opt/google/chrome/chrome`. The test checks the exact running browser's sandbox report; it will not use an ineligible Chromium or pass sandbox-disabling switches. Add `EVERYDAY_MUSL_PRESENTER=/absolute/approved/path` to the self-test invocation to exercise the regular-file positive pin control.

The prepared root is a separate authorized input, produced by the exact Ricebox recipe/selected package manifest and pinned source. See `approved-root.example.json` and the product distribution installation guide for trusted inputs. The harness validates the immutable archive SHA in raw `webroot.json` plus decoded translator Wasm, raw Muk and canonical unpacked BusyBox. It does not acquire root data, make approval from self-reported hashes, or substitute an injected Vite guest. Outputs and provenance stay in the new private report folder.

The base gate builds and offline-installs the exact Ricebox npm package and serves the sealed shell-only test under `/demo/`. It verifies module/Worker routes, a proper HTTP range and fallback absence, focus, real BusyBox prompt, fresh input arithmetic, output boundary, clean exit, and separate cold vs same-profile revisit payload bytes under two explicit loopback cache policies. A cache miss is reported as a measured failure; absent coverage is not zero.

With the pinned musl ELF only, a separate static page run adds the installed display modules. Before activation no display module, ELF or separate Worker may start. After a real click, it jointly checks the independent C Wayland Worker, reference raw frame hashes and protocol receipts, visible browser pixels, host-only pan, guest pointer, explicit guest resize, retirement/cleared canvas and a fresh shell witness after closure. That cooperative test guest is **not Quickshell**; it does not qualify display revisit/timing, guest keyboard, app scrolling, deployment network, or optical scanout. No transfer or display acceptance is established by the local HTTP/mocked-browser tests.
