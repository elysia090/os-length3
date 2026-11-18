# First native display/input profile

Status: design and source-checked requirements, **not a tested or packaged desktop**.
The current theme API remains unchanged. Do not promote the ANSI artwork study into
a compositor or define this module around an arm renderer.

## The smallest connection

For a caller who already has a compatible native Wayland session, reuse that session.
The caller explicitly lends the session and selects the launch domain. Start an
ordinary foot terminal and a basic Waybar panel using their existing executable/config
interfaces. A new everyday daemon, compositor, JS bridge or Rust launcher has not been
shown necessary. Do not wrap those interfaces merely to create an everyday API.

Before launch, record the exact executable versions and build options, compositor,
font/locale availability, session socket, seat/output and registry interface versions.
An environment variable, installed libwayland or a session desktop file is not proof
of a running session. No silent fallback to X11, a private compositor or a host shell
when the requested domain was a guest. Keep unrequested clipboard/service authority
out of the integration.

The first terminal task is a real shell: text, keys and repeat, PTY resize, job signals,
exit and output/session loss. The basic panel task avoids optional tray/network/audio
modules initially, while still exercising layer placement, output selection, resize,
output removal and close. An apparently live PID is not proof of rendering or input.
This is only the first gate; launcher, notifications/actions, wallpaper and Quickshell
need their own selected task and dependencies afterward.

## Evidence, not a dependency lock

[foot 1.13.1 source](https://gitlab.com/dnkl/foot/-/raw/1.13.1/wayland.c)
checks compositor, subcompositor, shared memory, xdg-shell, data-device support and a
seat. Its seat binding needs version 5; initialization also checks ARGB surface
support. Primary selection is optional, and presentation-time is required when the
corresponding timing mode is enabled. A generic window-only profile is therefore
insufficient. This historical tag is a reference, not the selected shipped client.

[Waybar fixed source](https://github.com/Alexays/Waybar/blob/5b36b1a82f9630576dca2840b8dca15b2aca2cff/src/client.cpp)
checks gtk-layer-shell support and requires an xdg-output manager bound at its
compiled name-event version. Record the generated protocol version and actual
advertisement together. A `layer-shell present` flag alone does not establish this
client's startup requirements. This revision is also a reference, not a compatible
stack proven alongside the foot tag.

The repository currently has no foot/Waybar/compositor recipes establishing a full
profile. A foot terminfo entry is not the terminal binary. Select an obtainable,
coherent client/library/config set and verify it before adopting a release lock.

## Ownership and failure

- Borrowed compositor, bus and session live beyond the integration. Never stop them
  when a client fails. The integration owns only the clients/configs it created.
- Report the failed component and step. Do not hide missing libraries, unsupported
  globals or denied sockets behind a replacement UI.
- Stop/reap owned clients on cancellation; distinguish process termination from
  completion of a compositor's buffer reads. Existing client libraries own their
  protocol-object lifetimes. Do not invent release evidence from frame callbacks.
- A guest route must demonstrate FD passing, shared-file visibility and resize/lifetime
  behavior for the chosen compositor/bridge. A native socket name copied into sods is
  not a bridge. Keep the existing AF_UNIX/SCM_RIGHTS/memfd/mapping implementation as
  evidence to test, not proof that Wayland works.

## Necessary resources versus representation costs

Borrowed-session incremental cost includes the clients' processes, event loops,
fonts/toolkit state and submitted buffers. The existing compositor is shared cost,
not free or newly owned. Owned-session mode adds its compositor/backend resources.

For a selected buffer geometry/stride, let B be its backing bytes and k the number
of simultaneously unreleasable generations. Retained backing depends on their actual
sizes and sharing; k*B is the uniform-size accounting case, not an asserted required
buffer count. Committed buffer bytes that the consumer is entitled to read must be visible, but shm sharing
does not inherently require a JS copy. Actual client, compositor and GPU transfers
must be measured separately. Without trusted damage/producer state, comparing an
arbitrary replacement buffer can require inspecting all B bytes; with such evidence,
that full scan is not a universal lower bound. No-change still leaves input/event
lifetime work. A native claim does not apply to a non-native bridge's copies/queues.

The Sods guest implements the memfd size seals used by foot's shared-pool path
([foot 1.13.1 source](https://gitlab.com/dnkl/foot/-/raw/1.13.1/shm.c)):
`F_SEAL_SHRINK`, `F_SEAL_GROW`, and `F_SEAL_SEAL`. The same backing file carries
those seals across guest descriptor passing and retains writable shared mappings.
Unsupported write/execute seals are rejected, not reported as enforced. Native
Linux and translated Sods parity tests cover these file operations, not a running
Wayland client, compositor, or a guest-to-host descriptor bridge.

Do not move native protocol handling into TS merely because the current theme parser
is TS, or replace existing clients in Rust as an end in itself. Language placement
follows the concrete missing work. Existing parser tests validate that parser only.

## Execution gate

Run the profile only in an explicitly lent native session with the selected clients.
Check visible output, input, resize, output loss and cancellation, recording versions,
protocols and ownership. In an environment with no such session or clients, report
that gate as blocked. Do not install tools, create a new desktop session or operate a
shared display just to convert an untested claim into a green fixture test.

## Borrowed-session proof runbook

This is a manual native-Linux acceptance exercise, not an installed everyday API.
The offline fixture `test/native-panel.ts CONNECTOR` only prints JSON. It requires
one literal connector (letters/digits, dots, underscores and hyphens), rejects broad
or multiple selectors, and neither reads display variables nor launches clients.
Its tests prove that configuration contract, not Wayland support.

Before running graphical commands, obtain authorization for the **existing session,
execution domain and output**. Record the versions, protocol inventory and client
requirements above. Select an available font and shell. Do not infer authorization
from inherited environment variables or silently substitute a host shell for a guest.
The following commands are for that authorized native domain only. Supply exact
values for `session_dir`, `display`, `output`, `shell_path`, `foot_path`,
`waybar_path` and `wayland_info_path` from its inventory;
these are not defaults or discovery commands.

```sh
# From the repository root, in the explicitly authorized session/domain:
: "${session_dir:?}" "${display:?}" "${output:?}" "${shell_path:?}"
: "${foot_path:?}" "${waybar_path:?}" "${wayland_info_path:?}"
proof=$(mktemp -d) || exit 1
node ricebox/everyday/test/native-preflight.ts "$session_dir" "$display" \
  "$foot_path" "$waybar_path" "$wayland_info_path" > "$proof/preflight.json" || exit 1
node ricebox/everyday/test/native-panel.ts "$output" > "$proof/panel.json" || exit 1
# Inspect its JSON before launching.
printf '# Isolated proof configuration; installed defaults only.\n' > "$proof/foot.ini"
printf 'window#waybar { background: #222222; color: #ffffff; }\n' > "$proof/panel.css"
```

Run each client in its own supervised foreground shell, using the same `proof`
directory and selected session values. Do not use foot's server mode or a session
manager/autostart entry. Keep the logs and exact configuration with the observation.
These examples select a socket by name. Clear `WAYLAND_SOCKET` locally because
[libwayland's descriptor selection](https://wayland.pages.freedesktop.org/wayland.freedesktop.org/docs/html/apb.html)
otherwise takes precedence over the chosen display.

```sh
# Terminal test:
(
  unset WAYLAND_SOCKET DISPLAY
  XDG_RUNTIME_DIR="$session_dir" WAYLAND_DISPLAY="$display" \
    exec "$foot_path" -c "$proof/foot.ini" --app-id=everyday-native-proof "$shell_path"
) 2> "$proof/foot.log"

# Panel test, run separately:
(
  unset WAYLAND_SOCKET DISPLAY
  XDG_RUNTIME_DIR="$session_dir" WAYLAND_DISPLAY="$display" GDK_BACKEND=wayland \
    exec "$waybar_path" -c "$proof/panel.json" -s "$proof/panel.css"
) 2> "$proof/waybar.log"
```

The panel requests one output, a top layer, no reserved space, pointer pass-through,
no Sway IPC and only a built-in clock. No custom commands or optional panel modules
are configured. This is **not** a sandbox: GTK and other client libraries can still
consult their ordinary settings, accessibility or session services. Inventory those
connections; do not claim the fixture disables them or disconnect shared services.
Foot's data-device support likewise does not authorize a clipboard exercise.

Record pass/fail/untested separately for:

- Visible terminal text, focus, key entry/repeat; shell job control and interrupt;
  `stty size` before/after an ordinary window resize; normal shell exit.
- One visible clock on the chosen output, advancing with time; no other output gets
  this panel; windows retain their usable area and pointer events reach underneath.
  The app-id labels foot; it does not force terminal output placement.
- Closing each owned client and repeating the run, with no surviving owned process
  or unexpected restart. Stop/reap only the clients started for this proof; never
  use broad process-name kills. Remove the temporary configs only after they stop.
- Output changes/loss, session disconnection and cancellation only on explicitly
  authorized disposable connections/outputs. Otherwise mark those cases untested;
  never stop the borrowed compositor or alter another person's display for a test.

An alive PID, clean log or frame callback is not rendering/input or buffer-release
proof. Failure names its component and stage; no fallback desktop is started.
Native success does not prove guest socket/FD/mapping transport, translated clients
or browser presentation. Keep those separate gates as described above.

The pinned [Waybar configuration manual](https://github.com/Alexays/Waybar/blob/5b36b1a82f9630576dca2840b8dca15b2aca2cff/man/waybar.5.scd.in)
and [foot 1.13.1 command manual](https://gitlab.com/dnkl/foot/-/raw/1.13.1/doc/foot.1.scd)
plus Waybar’s [CLI option definitions](https://github.com/Alexays/Waybar/blob/5b36b1a82f9630576dca2840b8dca15b2aca2cff/src/client.cpp)
are interface references, not a selected or jointly verified stack. Check the installed
clients' `--help` and manuals before using these options. No release lock is added.

### Preflight evidence, not acceptance

`test/native-preflight.ts ABS_RUNTIME_DIR SOCKET_NAME ABS_FOOT ABS_WAYBAR
ABS_WAYLAND_INFO` records an already authorized native session. All paths must be
explicit and absolute; the display is one literal socket name. The recorder refuses
a missing, regular-file or symlink socket. It runs the two selected binaries only
with `--version`, with display selectors removed. Only the selected `wayland-info`
child receives the chosen runtime directory and display; none inherits
`DISPLAY` or `WAYLAND_SOCKET`. There is no shell or executable discovery. Each child
has a five-second deadline and a one-MiB bound per captured stream. Failure produces
no JSON report.
The CLI always checks the socket with `lstat`; the unit tests inject only that stat
result to exercise fake subprocesses without binding a socket or opening a display.

The report preserves client stdout/stderr and raw registry stdout/stderr. It labels
visual acceptance untested and protocol compatibility unvalidated. Review interface
versions against the **selected builds**, and record missing build options, font,
locale, shell, seat and output details manually. A version banner cannot supply all
of these. Use exactly the selected absolute client paths, session directory and
display for the later manual launch. Recheck if the binaries or session change.

This file check is not authorization, identity authentication, a race-free socket
handle or proof of a complete compatible stack. The registry probe connects to a
real session and itself requires permission; do not run it on a discovered desktop.
Do not install tools or start a compositor when it fails. Raw registry output may
identify monitors, devices, serials and local paths; keep it private and redact it
before sharing. Optional toolkit/service behavior still needs the separate inventory
above. Offline recorder tests and fake banners prove no live Wayland behavior.

### Offline comparison of caller-declared advertisements

After saving preflight evidence, `test/native-registry.ts` compares its raw registry
stdout with **explicit caller-listed** `INTERFACE=MIN_VERSION` requirements:

```sh
node ricebox/everyday/test/native-registry.ts "$proof/preflight.json" "$requirement_1" "$requirement_2"
```

Set each requirement from the exact selected client/library build's source or
manual, including enabled features. There are no built-in foot/Waybar minimums,
and no default requirement list. This example does not supply a compatible stack.
The recorder and comparison tool do not discover requirements or prove provenance.

The [wayland-utils 1.1.0 README example](https://sources.debian.org/src/wayland-utils/1.1.0-1/README.md)
shows unindented global headers containing interface, version and numeric name.
This diagnostic reads only that header form, ignoring indented device properties.
It refuses malformed global headers, captures without globals, duplicate numeric
IDs, repeated requirements and versions outside positive U32 range. A different
output format needs review, not guessed interpretation. Input must be a regular,
non-symlink preflight JSON file no larger than 40 MiB, allowing the escaped
representation of the recorder's bounded streams. The comparison reads one
buffer sized to the file, not to that limit.

JSON reports each requested name as `missing`, `too-old` or `met`, its requested
minimum and highest captured advertised version. Multiple distinct instances count
as **at least one**, not all: choosing the intended seat/output and verifying its
actual capabilities remains manual. Exit 0 means every declared advertisement
matched; exit 1 supplies an unsatisfied comparison; exit 2 rejects input and emits
no JSON. Subordinate properties, protocol behavior, required formats, client build
features and visual/input acceptance are not validated. Neither a match nor a
saved report authenticates the compositor or authorizes access. Keep the original
capture private as above; this is an offline diagnostic, not a security gate.
