# Wayland mirror conformance fixture

This is a single-window test, not an Everyday or generic compositor API. Two
Linux guest processes exchange real Wayland messages over their own anonymous
AF_UNIX socket pair. The server exports only acknowledged wl_surface commits
via the runtime's existing virtual file mirror. The C client has no access to
browser input, host sockets, a display server, network or graphics devices.

The test covers padded XRGB8888 SHM, separate release and frame-completion
events, a Wayland pointer redraw, independent host camera geometry, and actual
xdg configure/ack resize. Both native and translated consumers verify every
pixel and receive the same three serial stages. Frame callbacks are not
physical presentation or browser measurements.

The C control gives libwayland a sealed memfd for the SHM pool over that
socket, closes its original descriptor, and destroys the pool proxy. The
mapping and buffer survive. Only after that buffer's release can the client
write the distinct pointer redraw to the same mapping and reattach the same
buffer. The server tracks that live resource across commits, so recycling
an object ID is not evidence of reuse. The checks require one release after
each actual read, with new, reused, and new resources for the three frames.
Resize replaces the backing; close drains the client and reaps it without
another frame. The translated harness also checks Worker retirement
acknowledgment. This static control does not establish that a dynamically
linked client works in the guest.

The native Sods CI lane stages the pinned upstream Wayland, Wayland Protocols
and libffi trees before running this fixture. The same offline stages can be
run with those trees in SOURCE_ROOT and the existing Linux x86-64 GNU tools:

    sh build.sh scanner SOURCE_ROOT OUT
    sh build.sh guest SOURCE_ROOT OUT
    python3 native-check.py OUT/wayland-presenter
    SODS_TRANSLATOR_WASM=/path/to/current/sods.wasm RICEBOX_MUK_FILE=/path/to/muk \
      node guest.integration.ts OUT/wayland-presenter inline
    SODS_TRANSLATOR_WASM=/path/to/current/sods.wasm RICEBOX_MUK_FILE=/path/to/muk \
      node guest.integration.ts OUT/wayland-presenter worker

The scanner uses host Expat; its outputs are checksum-checked before building
guest code. The guest uses musl-gcc by default (CC can name another musl
compiler). No host objects are linked into the fixture and it has no dynamic
loader or shared-library dependency. None of these files or test artifacts
is a requested release package or visible desktop.


The same checks also run with a separately executed static client. Pass
OUT/wayland-socket-client as the final argument to any of the three test
commands. The guest server deliberately inherits only its guest-owned
WAYLAND_SOCKET endpoint across exec (stdout/stderr remain normal). The client
has no stdin and verifies an unrelated close-on-exec descriptor disappeared;
ordinary libwayland consumes the environment value and takes that endpoint
back to close-on-exec. This also keeps the in-process fork test as a control.

### Optional native Qt Quick control

This separate Linux x86-64 check reuses the test compositor with the real Alpine
3.24 Qt 6.11.1-r0 Wayland client. It is not part of the default test path and
does not install Qt into Ricebox or run Qt under Sods. Stage the official signed
`qt6-qtdeclarative=6.11.1-r0` and `qt6-qtbase-wayland=6.11.1-r0` APKs and
their dependencies in a disposable Alpine filesystem. The package manager also
selects `qt6-qtbase-x11`, which contains the Wayland platform plugin despite
its name. `qmlscene` lives in the runtime package; the dev package is not
required. The runner checks the pinned qmlscene executable digest before running.

After the scanner stage above, build with `EVERYDAY_WITH_QT=1` for the guest
stage, then on the Linux host run:

```sh
python3 ricebox/everyday/test/wayland/qt/native-check.py \
  "$ALPINE_ROOT" "$BUILD_ROOT/wayland-qt-launch"
```

The read-only root runs under normal unprivileged bubblewrap with no host
display/device mounts. The launcher's local socketpair supplies
`WAYLAND_SOCKET`; the display backend is Wayland, not offscreen or X11. The
fixture checks Qt's software-renderer selection, every RGBA pixel of the first
rectangle and its xdg resize, and close without a third frame. This optional
control is not a general Qt, Chrome, or Quickshell compatibility claim.

For a separate top-layer panel control, also stage the signed
`layer-shell-qt=6.6.6-r0` runtime package and take
`wlr-layer-shell-unstable-v1.xml` from the signed Alpine
`wlr-protocols=0_git20250702-r0` package. Pass that XML as
`EVERYDAY_WLR_LAYER_XML` during the scanner stage and
`EVERYDAY_WITH_QT_LAYER=1` during the guest stage. Neither is enabled by
default. Then run the same host check with:

```sh
python3 ricebox/everyday/test/wayland/qt/native-check.py \
  "$ALPINE_ROOT" "$BUILD_ROOT/wayland-qt-layer-launch" --layer
```

The Qt/KDE client must request a top-layer role with top-left anchors for
the explicitly advertised, private test output. The test checks that role
and the software-rendered buffer/resize/close independently of xdg-shell.
The renderer mirrors the committed buffer only; it does not show or
measure a physically pinned panel or claim a Quickshell session.

### Optional native Quickshell application

This is the real Debian trixie-backports `quickshell 0.3.0-1~bpo13+1`
application with a small `Quickshell.PanelWindow` QML configuration.
It uses a Debian x86-64 test host with matching Qt 6.8.2 runtime libraries and
the supplementary official `.deb` files listed in
[`qt/quickshell/debs.sha256`](qt/quickshell/debs.sha256). Stage those files from
Debian's authenticated trixie and trixie-backports archives; the optional
staging script verifies their recorded hashes and only extracts payloads,
without installing anything or running scripts.

Use the same pinned protocol XML in the scanner stage as for the Qt layer
test above. Then build the guest fixture with `EVERYDAY_WITH_QUICKSHELL=1`
and run:

```sh
q=ricebox/everyday/test/wayland/qt/quickshell
sh "$q/stage-debs.sh" "$DEB_CACHE" "$NEW_OVERLAY"
python3 "$q/native-check.py" "$NEW_OVERLAY" "$BUILD_ROOT/wayland-quickshell-launch"
```

Only system `/usr` and the staged payloads are mounted read-only, with fresh
home, runtime, and display state; there is no external Wayland socket. The QML
must render an actual translucent rectangle from ARGB8888 SHM at both sizes.
The mirror converts premultiplied color to straight RGBA; the runner compares
every pixel and checks the client destroys the layer after close. A finite
QML timer exits the test application, not the behavior of a normal shell
daemon. Shell IPC and physical/browser presentation are not tested. The
official Quickshell executable is dynamically linked and this is not a
translated Sods Quickshell result.

### Optional Quickshell browser check

The `EVERYDAY_WITH_QUICKSHELL=1` guest build also produces
`wayland-quickshell-listener`. The browser check starts it and the official
Quickshell binary in two Sods kernels sharing one guest VFS. Quickshell opens
its Wayland socket there. The listener mirrors the committed SHM raster to the
Everyday canvas. The check reads both canvas pixels and Chrome's composited
screenshot at the original size and after a layer configure. It closes the
layer and checks that both guest owners retire.

Supply an offline fixture directory with `web/` (the packed Debian root with
the QML above at `/etc/ricebox/shell.qml`), `sods.wasm` built with `mapped-code`,
`muk`, `utc`, and `guest-sources.json`. The source file names the canonical
`main`, `interpreter` and `libraries` paths in that index and the `pin` of the
Quickshell binary. The checker does not establish fixture provenance: use
trusted inputs and supply the expected index SHA-256 separately. For a fixture
imported from another run, obtain the expected digest independently of the
fixture. With Node and the repository's locked dependencies, run:

```sh
EVERYDAY_CHROME_BIN=/opt/google/chrome/chrome \
  node ricebox/everyday/test/wayland/qt/quickshell/browser/check.ts \
  "$FIXTURE_INPUTS" "$BUILD_ROOT/wayland-quickshell-listener" "$EXPECTED_INDEX_SHA256"
```

For a root with a matching `prepared/index.json` and its content-addressed
Wasm pieces, add `--prepared`. Set `EVERYDAY_QUICKSHELL_SCREENSHOT` to save
Chrome's first composited frame. This check uses a loopback fixture server and
requires Chrome's Linux namespace and seccomp sandbox.

#### Offline audit of the Quickshell Debian test inputs

The test-only [closure lock](qt/quickshell/debian-fixture.lock.json) freezes the
Debian amd64 packages selected for this browser fixture, not a Ricebox release
or another installation profile. It records the exact signed trixie and
trixie-backports catalogs and all locked package versions, sizes and SHA-256
values, including the five existing Quickshell .deb pins. Debian Snapshot IDs
are immutable [transport locators](https://snapshot.debian.org/), not integrity
or signing authorities.

To verify already available files, use a trusted Debian archive keyring
containing the [official public signers](https://ftp-master.debian.org/keys.html).
Put `trixie.InRelease`, `trixie.Packages.xz`,
`trixie-backports.InRelease` and `trixie-backports.Packages.xz` in
`CATALOG_CACHE`, and the exact .deb files, by their basenames, in `DEB_CACHE`.
Using Python 3.11 or newer and GnuPG, run:

```sh
q=ricebox/everyday/test/wayland/qt/quickshell
python3 -B "$q/verify-debian-fixture.py" "$CATALOG_CACHE" "$DEB_CACHE" \
  --keyring "$DEBIAN_ARCHIVE_KEYRING"
python3 -B "$q/verify-debian-fixture.test.py"
```

This validates the historic freeze against the original signed validity window
and the exact current verification keyring; it does not configure APT, fetch,
extract, install or execute any package. Unlisted cache files are not read.
The cache also supplies the separately pinned signed Debian tzdata package.
The audit checks that package against the same authenticated catalog; it is
not counted in the 206-package guest root. This audit never runs Chrome or
the guest.

#### Assemble the browser fixture from the audited cache

With the same local inputs, Node 24, GNU tar, zstd, dpkg-deb and readelf, and
the checkout's existing source-built mapped Sods and Muk outputs:

```sh
q=ricebox/everyday/test/wayland/qt/quickshell
python3 -B "$q/stage-browser-fixture.py" "$CATALOG_CACHE" "$DEB_CACHE" \
  "$MAPPED_SODS_WASM" "$RICEBOX_MUK_FILE" "$NEW_OUTPUT" \
  --keyring "$DEBIAN_ARCHIVE_KEYRING" \
  --sods-sha256 "$MAPPED_SODS_SHA256" --muk-sha256 "$RICEBOX_MUK_SHA256"
python3 -B "$q/stage-browser-fixture.test.py"
```

Run the producer from the reviewed checkout; it takes the Debian pins from
that checkout's lock. Record both tool digests from the trusted source build
independently of the fixture files. The producer takes a private copy before
verification, extracts only authenticated package payloads, and does not
install anything or run maintainer scripts, a guest, or Chrome. It uses the
existing distributor without executable translation. It inspects the ELF
dependency paths without running a loader and retains the mapped library size
limit. The UTC bytes come from the exact pinned tzdata member, not the host.
The original packed `shell.qml` stays distinct from the checkout's optional
pointer overlay.

For this throwaway fixture, keep `NEW_OUTPUT` private to the trusted run and
pass `NEW_OUTPUT/fixture` and the contents of `NEW_OUTPUT/index-sha256.txt` to
the checker in that same run. The receipt separates the input pins from the
generated index digest. Neither the digest file nor the receipt is an
independent attestation: do not use them to trust an imported or cached
fixture. The listener is still built through the existing Wayland fixture
recipe below. This producer has no network acquisition or workflow changes and
makes no runtime/interaction claim.

#### Optional first Quickshell pointer response

Use the same trusted offline guest inputs and expected index digest described
above. Build the scanner with the same pinned layer-shell XML, then build the
opt-in pointer listener and select it explicitly:

```sh
test_dir=ricebox/everyday/test/wayland
EVERYDAY_WITH_QUICKSHELL_POINTER=1 sh "$test_dir/build.sh" guest "$SOURCE_ROOT" "$BUILD_ROOT"
EVERYDAY_CHROME_BIN=/opt/google/chrome/chrome \
  node "$test_dir/qt/quickshell/browser/check.ts" \
  "$FIXTURE_INPUTS" "$BUILD_ROOT/wayland-quickshell-pointer-listener" "$EXPECTED_INDEX_SHA256" --pointer
```

The checker pins its own test QML and gives it to the guest without rebuilding
the root. The visual-only check still uses the original QML from the root.
Chrome clicks outside the canvas and must not forward a contact, then clicks
once inside it through Everyday. The guest must make a second Wayland panel
commit at the **same** size and configure serial after that pointer contact.
Both canvas backing pixels and the Chrome composited pixels must change to
the QML click handler's color, and the original retirement checks still apply.
The listener accepts Qt's separate cursor surface but never mirrors it.
This is an on-demand fixture lane, not a packaging, timing, or general input
compatibility claim.
