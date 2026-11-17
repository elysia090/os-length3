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

Do not move native protocol handling into TS merely because the current theme parser
is TS, or replace existing clients in Rust as an end in itself. Language placement
follows the concrete missing work. Existing parser tests validate that parser only.

## Execution gate

Run the profile only in an explicitly lent native session with the selected clients.
Check visible output, input, resize, output loss and cancellation, recording versions,
protocols and ownership. In an environment with no such session or clients, report
that gate as blocked. Do not install tools, create a new desktop session or operate a
shared display just to convert an untested claim into a green fixture test.
