# CALL fault observations outside the build guest — 2026-10-05

The [preceding WHPX/TCG red](2026-10-04-call-fault.md) is not closed by a
convenient repeated pass. `data/oracle/call-fault-windows.c/.S` now provides
an independent native Windows observer: only UCRT/Win32, no product decoder,
compiler, VM, Linux build guest, browser or guest interpreter is linked.

Six exact CALL forms, four stack ends (including split and reproduced word),
three flag images and three prior permission histories form the same 216
groups. Both pages are writable before every CALL. A native register trampoline
enters the instruction; [Win32 VEH](https://learn.microsoft.com/en-us/windows/win32/debug/vectored-exception-handling)
records all 16 GPRs, RIP, flags/RF and exception code/address before recovering
the original observer caller stack. Unknown context/payload, unrelated faults,
missing rows and incomplete totals fail. Recovery never re-executes the CALL.
No product expectation or semantic lowering changes.

The Windows handler needs a generous committed stack below the fixed test RSP,
unlike Linux sigaltstack. Thus this records a native OS/context/payload outcome,
not an isolated CPU fault-vector observation. Windows ACCESS_VIOLATION is not
relabeled as an architectural #GP number. Incoming/recorded flags exclude
only RF for equality, while RF presence is separately counted.

## Actual native observation

Windows NT 10.0.26200.0, UCRT GCC 16.2.0, `-O2 -Wall -Wextra -Wpedantic -Werror`:

| CALLs | Stored return word | Untouched word | Original register/RSP/RIP frame | Advanced frame | Saved RF | Mixed groups |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 884,736 | 884,310 | 426 | 884,736 | 0 | 884,736 | 8 |

Raw observations and
validated receipt retain every group and
CPUID. Leaf 0x40000000 reports Microsoft Hyper-V; this is a native process
outside the WHPX build guest, **not** a bare-metal or universal hardware proof.
Different OS/virtualization exception layers are not assumed equivalent.
It strengthens the fact that the mixed payload result is not caused solely
by the product compiler/VM or Linux-native harness. It does not isolate CPU
vs OS vs virtualization cause or prove a permitted architectural effect set.
The strict product CALL equivalence gate remains red. In particular, neither
always-store nor always-untouched can be universally inferred from this run.

Raw local log SHA-256:
`815bb1b9d6761164f7d69d8e4870fc9ae1151a490217faf908a90ad191b8a211`.
Observed executable SHA-256:
`41ddf4f4f7a4e803d2912c5e77bf9ea06376c73a680931014518e58f9104a83d`.
The source is final except documentation. Smoke 216 calls and the full
884,736-call population both complete; parser validates all 220 lines.

```powershell
gcc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror data/oracle/call-fault-windows.c data/oracle/call-fault-windows.S -o temp/call-fault-windows.exe
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
./temp/call-fault-windows.exe 4096 > temp/call-fault-windows.log
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node data/oracle/observe-call-fault-windows.mjs temp/call-fault-windows.log
```

Native release and human UI are unchanged. This is oracle diagnosis, not
product execution, browser acceptance or Linux/PID 1/shell boot evidence.
