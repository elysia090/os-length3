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
