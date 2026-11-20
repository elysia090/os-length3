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

The native Sods CI lane stages the pinned upstream Wayland, Wayland Protocols
and libffi trees before running this fixture. The same offline stages can be
run with those trees in SOURCE_ROOT and the existing Linux x86-64 GNU tools:

    sh build.sh scanner SOURCE_ROOT OUT
    sh build.sh guest SOURCE_ROOT OUT
    python3 native-check.py OUT/wayland-presenter
    SODS_TRANSLATOR_WASM=/path/to/current/sods.wasm RICEBOX_MUK_FILE=/path/to/muk \
      node guest.integration.mjs OUT/wayland-presenter inline
    SODS_TRANSLATOR_WASM=/path/to/current/sods.wasm RICEBOX_MUK_FILE=/path/to/muk \
      node guest.integration.mjs OUT/wayland-presenter worker

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
