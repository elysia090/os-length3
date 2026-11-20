# Everyday terminal Worker contract

The [installed shell and display reference](../wayland/browser/composition.md)
uses a simple line console. Before composing a full terminal view, this test
exercises the same guest's terminal interface through the installed package's
public createRoot. It does not substitute a host shell or render ANSI in the browser.

From the repository root, with the ordinary locked Node dependencies, supply
the same trusted static x86-64 BusyBox, Sods translator and Muk as the
composition:

    sh ricebox/everyday/test/terminal/run.sh \
      "$SODS_TRANSLATOR_WASM" "$RICEBOX_MUK_FILE" "$EVERYDAY_SHELL_ELF"

The script stages a fresh offline npm consumer. The public factory starts its
installed Worker through the existing Node Worker bridge; the guest and its
CPU Worker run the real static BusyBox. The checks exercise:

- The guest seeing 12 rows and 53 columns through stty, not the default size.
- Unmodified ANSI SGR from the guest, ready for a renderer to interpret.
- Entering noncanonical no-echo mode, reading one literal key without Enter,
  then getting canonical mode back. The shared VT core paints the expected
  ANSI color in its grid, enters the real guest’s alternate screen, and
  restores the primary screen after that key.
- Interrupting a guest foreground sleep and typing another command in the same
  shell in the new output epoch.
- Draining the published bytes, receiving the final byte count before exit,
  and observing admission retirement without errors.

This is an engine/transport test, not a browser terminal, keyboard/IME or
accessibility test. It proves the initial terminal dimensions, not live
window resize, and makes no dependency or deployment changes.

The fixed-budget core shares the workbench's existing VT parser rather than
starting a second one. The guest-mode grid retains no scrollback and
bounds dimensions, partial control strings, code units per cell and retained
styles. It does not expose title, clipboard or other OSC host operations.
To run the separate defensive limits checks:

    node --test ricebox/everyday/test/terminal/bounded-screen.test.ts

This does not change the npm package or the default installed preview.

## Change the existing guest console's dimensions

The start message can opt its first foreground Worker session in with
screen:true and terminalResize:true. Clients keep one Worker for one
interactive terminal. The Worker latches trusted Muk's first published
direct child and admits requests only after that same child's exec commits
and while both it and the launcher remain live. It never adopts a
reparented descendant. Once the session is live (the fixture waits for the
actual initial prompt), send:

    {type: 'terminal-resize', request: 1, cols: 93, rows: 31}

Request IDs are positive safe integers, increasing for accepted requests;
cols and rows are positive Linux 16-bit cell counts. The matching reply is
{type:'terminal-size', request, cols, rows, changed}. A changed reply records
that the size was committed to the existing root console and the current
foreground group was notified if present. TIOCGWINSZ reads its current
geometry (another resize can supersede it). The notice neither orders all
guest output with respect to the receipt nor proves a repaint or unique
delivery of standard signals. Repeating the current dimensions with a fresh
ID reports changed:false and sends no additional signal. A lost reply leaves
the result unknown to the client; it can retry the same dimensions using a
larger ID. Rejection is correlated with {type:'terminal-size', request, error}
for inactive, stale, invalid-size or closed; an unusable request ID is ignored.
No request is queued for a later guest. Startup failures invalidate the
lease. The box program's exit closes it even while a background descendant
is still alive and before the Worker exit receipt. A legacy replacement
cannot inherit the resize opt-in; retirement never reopens it. The control does not clear queued input or flush
terminal output.

The test changes a running BusyBox foreground child from 12×53 to 31×93 and
back, checking stty inside its real WINCH handler. It also tests stale/invalid
requests, no extra signal on the same geometry, typed data already waiting
behind a guest sleep, and close. A separate lifecycle fixture uses a
non-executable trusted launcher, a missing configured guest, and a real
background child observable at the end of its owning guest, without
changing namespace configuration or delaying cleanup. These controls run the same installed
script on the inline lane, simulate one missing reply in the test transport,
or test a live screen without opt-in respectively:

    SODS_INLINE=1 EVERYDAY_DROP_RESIZE_REPLY=1 sh ricebox/everyday/test/terminal/run.sh \
      "$SODS_TRANSLATOR_WASM" "$RICEBOX_MUK_FILE" "$EVERYDAY_SHELL_ELF"
    EVERYDAY_NO_RESIZE=1 sh ricebox/everyday/test/terminal/run.sh \
      "$SODS_TRANSLATOR_WASM" "$RICEBOX_MUK_FILE" "$EVERYDAY_SHELL_ELF"

This is the root terminal transport, not a resize of a separate /dev/pts peer,
Wayland buffer, browser viewport or material browser presentation. The
reference browser grid is not yet wired to send or apply the new message.
