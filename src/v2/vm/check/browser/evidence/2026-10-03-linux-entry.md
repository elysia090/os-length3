# Complete decompression and actual Linux ELF entry — 2026-10-03

The same published native bundle now reaches its actual Linux ELF entry
`0x14015e4` in an ordinary, non-isolated browser Worker. All **14,622,864
decompressed bytes / 3,571 pages** match independently extracted gzip output.
The guest executes five instructions at that entry and stops on common
unsupported `WRMSR` at `0x14015f7`, ECX `0xc0000101`, EDX:EAX zero.
**Linux/PID 1/shell are not achieved.** This is not a boot percentage or the
complete development/storage/network acceptance. Cold shell three seconds
is unmet. No source interpreter, kernel-address callback, instruction skip
or execution fallback was added; native distribution and human UI are unchanged.

The [final real-browser receipt](2026-10-03-startup-linux-entry.json) is a
projection of visible JSON, retaining the final three trace rows and omitting
the historical relocation trace. `status: pass` means the bounded diagnostic
and its independent observations passed, not Linux boot. Repeated execution
has identical retirements, admissions, source/engine work, exception sequence,
output, complete next-gate CPU coordinates and residence. Only observed
timings differ. Screenshot: `temp/browser-linux-entry-1003.png`.

## The red and its common fix

Widening the explicit diagnostic first reaches 129,057,253 retirements /
64,417,612 admissions, then rejects `6b ff 38` at `0x1e23d8b`: signed
`IMUL edi,edi,56` while Linux parses the decompressed ELF. A normal post-linked
16-bit IMUL fixture independently fails cold emission with `-102` before the
fix. `lower-multiply.c` now accepts two/three-operand register forms at
16/32/64 bits, not a special case for that coordinate or constant.

Both sources are captured before any destination publication. Low product
is multiplication modulo 2^width; 16-bit writes retain the parent and 32-bit
writes zero it. CF=OF iff the full signed product differs from sign-extension
of the truncated value. The 64-bit high word is derived from four 32-bit limb
products and sign correction, with bounded modular i64 arithmetic: no
division, floating point, i128 or host arithmetic import. Backward flag
liveness omits unobserved definitions while retaining interior CF/OF consumers.
SF/ZF/AF/PF are undefined and keep the implementation's chosen value, not an
invented defined-hardware contract. See Intel's
[IMUL specification, Vol. 2A §3-504–507](https://cdrdv2-public.intel.com/819712/253666-sdm-vol-2a.pdf).
Memory/implicit double-width/LOCK forms remain explicit refusals and have
no-publication regressions; this is not all multiply-family closure.

32 ordinary post-linked ELF fixtures / 16,384 actual x86 cases pass both
direct Wasm and separately the C table dispatcher, including signed boundaries,
negative imm8/imm16/imm32, zero, self and extended-register aliases, preserved
parents, interior flag consumers and later kills. Native/cold C-Wasm emission
matches byte-for-byte for 98 fresh shipped-prefix/fixture cases. Full
`make -C src/v2 -j2 check` and selected compiler/lowering ASan/UBSan pass;
linked decoder/provider archives in the latter are normal builds, not whole-TCB
sanitizer coverage. Previous carry: 66 modules / 33,792 comparisons in direct
Wasm and separately C dispatch. The real source-admission regression passes.

The old pure-module observer still rejected incoming RF, contrary to the
already implemented IRETQ contract. It now tests successful RF clearing and
rejects TF with/without RF; this was a stale test expectation, not permission
to suppress a runtime error. Old startup fixtures also predated that contract;
fresh native fixtures from the exact shipped archive restore byte parity.

## Independent output observation, not a substitute decompressor

`decompression-oracle.mjs` accepts only the shipped kernel SHA-256, obtains
the gzip payload from bzImage header coordinates and independently verifies
CRC `380732796` and ISIZE. Output SHA-256 is
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
It generates only per-4-KiB digests for the browser, not output bytes.
The 239,664-byte diagnostic hash-list JSON has SHA-256
`23a41ce335d21cf784abaa4049e47c6ea22565497ec6dde6271cda3cea44256d`.
Corrupt source input is refused by the exact-source gate.

Actual Linux `arch/x86/boot/compressed/misc.c` calls `__decompress` then
`parse_elf`, whose PT_LOAD memmoves overwrite the temporary ELF representation.
Exact native disassembly identifies `0x1e23d31`, `49 8b 55 08`, as the first
ELF-header read. The observation checks this byte witness, then borrows each
resident output page through C `vm_code`, hashes at most 4 KiB and compares
the digest before allowing execution to continue. No whole output is rebuilt
or copied into the guest; no JS address translator or guest decompressor runs.
Complete CPU and hidden-cache state remain unchanged across the observation.
Previously accessed identity-mapped output is present and executable here;
this observation is not a general access-bypass API or eviction mechanism.

Upstream `lib/decompress_inflate.c` PREBOOT uses raw DEFLATE and does **not**
verify the gzip trailer. The CRC statement therefore belongs to the independent
oracle; the guest is verified by exact per-page output equality. A diagnostic
read coordinate does not choose a guest branch or bypass the decompressor.
The complete relocated copy/BSS/memset and 86/378-instruction observations
also remain green. This is not a full-machine native differential proof.

## Current resources and remaining work

Final repeat: 129,057,478 source retirements / 64,417,773 admissions.
368,647 engine constructions, 64 retained instances / 21,991 module bytes.
C source reuse: 64,049,126 hits / 368,648 misses; 6,216 bytes metadata, zero
source-witness payload. Cumulative 1,509,982,208 copied code bytes and
129,292,045 emitted bytes are repeated construction work, not resident RAM,
distribution storage or downloaded object bytes.

3,674 physical supplies / 3,687 resident pages, 15,728,640 VM memory bytes /
1 MiB compiler memory. Directory capacity 8,192 and reserved bytes 393,200;
maximum ordinary VM memory is 32 MiB. Five Linux #PF(2) handlers map missing
identity ranges and return through compiled IRETQ; the host does not repair PTEs.
The 47 HTTP 206 object ranges / 3,056,640 fetched bytes exclude diagnostic
fixtures, compiler/provider modules and the output hash-list request. They are
not a total production-transfer metric or signed-root/AEAD/ECC admission proof.
Native archive SHA-256 remains
`4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc`.
VM: 28,419 bytes / `bf0b5560ad5c5aea4ff13bd5138ab3239a4291280ee4ff1d997530349453c1ae`.
Cold compiler: 413,506 bytes /
`1c1bb4c662559df7992a177f86f4e790dc459637e89eb3a0cf12f75d363bd50c`.

Final observed sub-times: engine 34,213.2 ms, execution 30,094.5 ms,
source admission 19,858.5 ms, cold construction 5,812.3 ms, supply 230.9 ms.
These exclude fixture setup, output hashing, trace/assertion and other host
work; no controlled speedup or cold-shell timing is claimed. The preceding
run measured 35,380.5 / 30,417.6 / 19,813.0 / 6,101.1 / 191.5 ms.
Source/engine topology reuse and C-owned multi-cut dispatch still need work.
Do not replace exact write/A-D/fault validation with an unbounded or JS source cache.

Default budget remains 1,000,000 admissions / 2,000,000 retirements and
reproduces 1,616,430 retirements / 1,967 compilations / RIP `0x1e21a1a`.
`?budget=extended` now permits 150,000,000 / 300,000,000, not unbounded execution.
Observational progress messages retain one Worker and are not resume snapshots.
The progress lifetime unit check passes.

Next implement common WRMSR/RDMSR and corresponding hidden-cache/profile/fault
semantics, then kernel MMU/exception/device/root demand, PID 1 and full offline
tooling, authenticated workspace recovery and granted NIC/network acceptance.
Whole-image `-104`, production admission, cold shell and the full goal remain red.

Reproduce: fresh `prepare-startup-cuts.sh` from the shipped archive,
`prepare-multiply-cuts.sh` -> `check-wasm-cuts.mjs` / `check-wasm-dispatch.mjs`,
`wasm-tools.ps1 -Compiler`, `check-cold-compiler.mjs`;
`check-decompression-oracle.mjs`, `check-startup-progress.mjs`,
`prepare-browser-startup.mjs`, then the actual browser
`/src/v2/vm/check/browser/startup.html?budget=extended`.
Node `check-wasm-startup.mjs` has the same optional `--extended` budget but
is an engine oracle, not the real-browser evidence above.
