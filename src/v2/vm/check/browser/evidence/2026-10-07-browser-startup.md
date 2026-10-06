# Real-browser startup checkpoint — 2026-10-07

The standard in-app-browser control path works without launch environment
overrides, disabling the sandbox or a second browser automation connection.
These are actual browser Worker observations, separate from Node/native tests.
The native publication and human UI are unchanged.

## Fixed input and independent fixture

The new `generated-startup-literal-1007` diagnostic directory uses publication
`1a0bddc2340a976d859fabfe7c67eeea66efb3a0d4ae21dc24a1299da2753195`,
native bundle SHA-256
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
Its compiler and VM are the exact binaries recorded in
[the literal candidate](2026-10-07-literal-binding.md). Kernel, initramfs and
immutable filesystem image remain the same published inputs. No retained
fixture is overwritten and no live Worker is restarted by regeneration.

Reproduction from the retained same-bundle diagnostic inputs:

```powershell
node data/oracle/prepare-browser-startup.mjs `
  temp/idle-startup-1006/vm.wasm `
  temp/coverage-1006/literal-compiler.wasm `
  temp/multiply-startup-1003 `
  temp/interrupt-1004/boot.segments `
  temp/native-delivery-boot-1a0bddc2340a/system.squashfs `
  src/v2/vm/check/browser/generated-startup-literal-1007
node data/oracle/serve-browser.mjs --port=8080
```

An explicit existing output is refused. Choose a fresh directory after this
one has already been prepared. Generated diagnostic objects are ignored by
Git; they are not another release artifact. The loopback server uses its
existing restricted routes and CSP. No COOP/COEP or storage/network permission
is granted as part of this observation.

## Completed short observation, not Linux boot

Open `startup.html?fixture=generated-startup-literal-1007` on that server.
[Raw browser receipt](2026-10-07-browser-prefix.json) records:

- ordinary dedicated Worker, secure context, isolation false;
- the complete independent 86-instruction CPU/segment checkpoint;
- 1,617,931 retirements and 1,000,000 admissions, then the existing short quota;
- C-Wasm compiler -> C function-table/MMU execution, no JS guest memory callback;
- 7,340,032 bytes of Wasm memory, 1,549 resident pages;
- 47 extent fetches / 3,056,640 fetched bytes, a 65,536-byte transport cache;
- 2,565.5 ms elapsed for this short diagnostic, NOT cold shell readiness.

The local SHA-256 manifest detects stale/corrupt diagnostic fixtures. It is
NOT a signed production root, proof of whole-image closure or a complete
delivery/storage admission path. The default provider fixture separately
fails `explicit cold scalar binding`: its old metadata lacks that ABI field.
Do not weaken the current provider contract or add an old-ABI fallback.

## Explicit long selection and lifetime

The same page now accepts `budget=extended&warm-cuts=64&idle=1`. This uses the
existing warm admission quantum and measured idle transport; it changes no
CPU/device semantics, virtual clock rate, source/engine owner capacity or
extended execution quota. Defaults remain warmCuts=1 and idle disabled.

Invalid warm/idle query values produce a visible failure before creating a
Worker. The Worker independently validates the message before any fetch.
Progress messages retain the same Worker; only a final result or error stops
it. `node data/oracle/check-startup-progress.mjs` verifies that lifetime, the
explicit on/off bounds, nine invalid message cases and pre-fetch rejection.
Actual browser `warm-cuts=0` displays the expected failure rather than leaving
an apparently running page.

The real long Worker is retained while running. A progress snapshot at
151,399,964 retired / 73,984,778 admissions shows network-stack initialization
and `Unpacking initramfs...`; no shell or service readiness follows from those
messages. Construction still dominates: 1,707,761 engine constructions and
9,612,800 source misses in that snapshot. It is not a completed timing or a
paired performance comparison. Do not reload it merely because a browser or
tool call times out.

Whole-ELF emission still refuses -104. Complete compiler-produced module /
coordinate projection and authenticated C Artifact residency remain required
to eliminate reconstruction before already-compiled-body lookup. Full Linux
PID 1 / offline development / workspace / network acceptance and cold shell
three seconds remain unachieved. A diagnostic quota or `status: pass` on this
page must never be published as Linux boot success.
