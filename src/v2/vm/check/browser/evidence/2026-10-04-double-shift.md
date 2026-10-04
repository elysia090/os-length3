# Common SHLD/SHRD SSA — 2026-10-04

## Real red and necessary ordered equations

The previous actual browser refused `shrdq $32,%rdx,%r11`
(`49 0f ac d3 20`) at `0xffffffff8108700f`. The new native fixture first
reproduced common grammar/-102 on memory SHLD, then recorded 113,664 real
x86 observations without invoking lowering. No Linux function, counter,
kernel opcode or architectural state is patched to continue execution.

For width `w` in {16,32,64}, let `D` and `S` be the old width-masked
destination and source; `n = low8(count) & (w == 64 ? 63 : 31)`.
For `0 < n <= w`, the necessary exact value is:

```text
SHLD: ((D << n) | (S >> (w - n))) mod 2^w
SHRD: ((D >> n) | (S << (w - n))) mod 2^w
CF:   old D bit (w - n) for SHLD; bit (n - 1) for SHRD
OF:   old_sign XOR new_sign, only defined for n == 1
SF/ZF/PF: the width-masked result
n == 0: D and all incoming flags survive
```

See [Intel SDM, SHLD/SHRD](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2b-manual.pdf).
At 16 bits the defined domain fits one 32-bit concatenation; count 16
therefore produces exactly S without a shift-by-width masking error.
For masked count > 16, low destination and arithmetic flags are undefined.
Zero is the compiler's explicit representative; all defined high parents,
other registers, accesses and faults remain observable. AF for a nonzero
defined shift and OF for multi-bit shifts also choose zero. These choices
are not physical-hardware guarantees. A 32-bit destination uses the common
parent zero-extension publication, including masked-zero counts; the native
fixtures check this behavior.

All three inputs are captured before any register publication. A memory
destination additionally captures EA, then uses the existing precise C RMW
reservation -> pure value/flag SSA -> C commit -> CPU/RIP/retirement
publication. No double-shift opcode or payload image crosses into the VM.
Failure/wait returns before CPU publication. A masked-zero count still
reserves/commits memory, preserving observed permission faults. Guest page
table A/D effects are translation side effects, not rolled-back payload stores.
Conditional CL flag writers do not kill predecessor definitions: a later
zero count still needs the earlier flags.

## Component evidence and honest scope

222 forms cover two operations, three widths, all CL values and eleven
immediate counts, deterministic zero/all-ones/sign/carry value edges,
self/source/count aliases, extended GPRs, old RSP,
32-bit address truncation, scaled-RCX and RIP-relative writes. ADD
predecessors and CF/ZF/OF consumers run inside pure SSA. 113,664 independent
complete CPU/RAM observations include 11,040 fault frames, 2,284 masked-zero
write faults and 12,516 architecturally undefined destinations. All native
records agree with separate observe-only observations under the declared
definedness masks; undefined destination/flags are not falsely compared as
hardware-defined values. Full RAM/code images are checked for unintended
stores. QEMU TCG executes real x86 only in the independent reference build
VM, never in the product route or as a physical-CPU exception guarantee.

The original red fixture's pre-lowering observations are retained separately.
The final strengthened fixture additionally crosses count edges with sixteen
value edges; fresh native-emission and observe-only runs use those same
inputs. They are not compared to the earlier fixture as if its inputs had
never changed.

All 222 native-C/cold-C emissions are byte-identical. The actual C-Wasm
memory owner and table dispatcher pass 113,664 direct, 113,664 dispatched
and 113,664 RF comparisons. 990 entry refusals preserve CPU/payload, 408
waits/retries publish retirement once and six executable writes revoke
stale execution. Waiting models promote the exact deferred physical row
through a serialized test owner, not guest PTE repair or signed supply.
102 pure-predecessor memory frontiers and nine LOCK/FS/GS refusals pass.
The code-cut harness additionally admits 9,792 GPR/memory/count bindings.

Full `make -j4 -C src/v2 check` passes after the new grammar tests. The
code-cut harness executes the complete sanitized lowering library under
ASan/UBSan; linked decoder/proof/support archives are ordinary builds, not
a whole-TCB sanitizer claim. The unchanged C VM inherits its prior checks,
not a newly sanitized VM binary. The previous 340 memory shift/rotate
forms remain byte-identical and pass 174,080 direct plus 174,080 C-dispatch
comparisons under the new cold compiler, including faults/waits/RF/aliases.

```sh
make -C src/v2/wasm-compiler double-shift-check
src/v2/wasm-compiler/build/double-shift-check FRESH-NATIVE-DIRECTORY
node data/oracle/check-double-shift.mjs VM.WASM COMPILER.WASM FRESH-NATIVE-DIRECTORY OBSERVE-ONLY-DIRECTORY
make -j4 -C src/v2 check
```

```text
VM       60,752 bytes SHA256 630991f1652712b33402b2521c85b77799c703f9a7b1f09d1707322dbcaa83ac
compiler 436,597 bytes SHA256 13e9d5a54260638be1f6b59e30f8629cb1b5591c84969da5913ef41d06b125f6
bundle SHA256 4438d58897f8795a69b77d46fcfd45259717c739f9a0419fd7c1541d089c77cc
```

Compiler growth is 1,578 bytes over memory shift/rotate. VM, published
native bundle and human UI are unchanged. These component passes are not
Linux/PID 1/shell acceptance; the same shipped-kernel browser Worker is
being verified separately. The full goal and cold shell three seconds
remain unachieved.

The small Node startup check initially pointed at an older fixture directory
and correctly refused its hidden-cache observation at retirement 86. No
assertion was removed and no CPU state was repaired. Rerunning against the
same generated fixtures as the browser, including the independently recorded
current 136-byte segment witness (SHA256
`5ca3956ada5dc86ca360e7b44c87145c19e300de7f96bf998594da22be32473b`),
passes all 86 state/cache and 378 relocation witnesses, then reaches the
unchanged diagnostic quota: 1,616,430 retirements / 1,000,000 admissions.
That quota pass is not Linux boot.

```sh
node data/oracle/prepare-browser-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY CURRENT-NATIVE-SEGMENTS
node data/oracle/check-wasm-startup.mjs VM.WASM COMPILER.WASM src/v2/vm/check/browser/generated-startup
```

## Earlier running observation — preserved without restart

The same ordinary-memory browser tab was normally reloaded once with this
compiler and the current segment witness. It has not been restarted again.
The [saved running UI observation](2026-10-04-double-shift-browser-running.json)
records **152,060,467 retirements / 80,429,141 admissions**, RIP
`0xffffffff810a60c6`, 5,872 console bytes, 4,572 resident pages and
19,398,656 C memory bytes. Linux reports early
`VFS: Finished mounting rootfs on nullfs`, followed by software performance
events and `signal: max sigframe size: 1040`; there is no PID 1/shell receipt.
`status: running` and `linuxBoot: not-achieved` are explicit. A count larger
than the previous run does not prove a particular opcode's retirement or
a boot percentage: timing/calibration and interrupts vary between runs.
This partial observation is not relabeled as the next terminal gate.

Engine construction is the measured largest cost: 9,441,889 constructions /
2,503,869 exact-byte hits. Phases in milliseconds are engine 844,460.6,
cold emission 142,221.8, C execution 75,995.2, admission 34,927.8 and
supply 247.3. Cache quotas are unchanged: at this observation, 736 entries /
262,040 witness bytes, maxima 1,024 / 262,144. Neither these witness quotas
nor C memory bytes bound browser engine RSS. This is not cold-shell latency
or an equal-work speed comparison. Screenshot:
`temp/double-shift-1004/browser-running.png`.

Three bounded diagnostic counters now separate successful request-time
absent-key constructions, changed-body constructions and actual quota
evictions. They add no history, index, guest decision, quota change or
cache policy. Absence means new **or** evicted; it cannot prove either alone.
Changed-body, tiny byte quota, hot/cold streams, invalid emission, duplicate
pending requests and closed owners verify exact counter accounting. The
current Worker loaded the preceding host module, so these new counters are
**not** measurements from this running receipt. They apply only to a later
fresh diagnostic after the present live Worker reaches a terminal state.

Continue the same browser tab/Worker to its next genuine gate or quota;
do not reload merely because observation is slow. The full Linux/development/
authenticated-storage/granted-network objective remains active and unachieved.

## Actual terminal acceptance and next common gate

The [terminal visible result](2026-10-04-double-shift-browser.json) completes
this same Worker normally, without a reload, at 174,000,486 source retirements
and 96,787,852 admissions. General SHLD/SHRD lowering admits the previous
frontier and the subsequent real Linux code reaches the new common refusal:

```asm
# 0xffffffff81034e31: 0f ae 54 24 0c
ldmxcsr 12(%rsp)
```

The refusal is common grammar -102; there is no opcode skip or runtime
interpreter fallback. Next, independently observe general LDMXCSR/STMXCSR
profile, reserved-bit, memory/fault and CPU-publication semantics before
changing common lowering. The browser logs timer/futex initialization and
PF_NETLINK/PF_ROUTE registration, but **not** PID 1, a release root mount,
offline shell or usable networking. `status: pass` covers this bounded
diagnostic only; `linuxBoot: not-achieved` remains explicit.

All 14,622,864 decompressed bytes across 3,571 pages still match SHA256
`6cf2f7d852ac0ca21cd1332425af772065e9e9795e4de813f877c95e2798fbe9`.
The result contains 6,311 console bytes, 4,673 resident pages and 19,922,944
C memory bytes. The extent transport remains 49 fetches / 3,154,432 fetched
bytes / 3,046,912 requested bytes and 65,536 cache high-water bytes. This is
local diagnostic integrity, not signed production admission or engine RSS.

Engine construction 2,216,683.0 ms dominates cold emission 347,245.3,
execution 143,665.4, admission 53,927.6 and supply 248.6. There are
25,229,129 constructions / 2,734,856 exact-body hits; quotas stay unchanged.
Retirement counts vary with calibration: no boot percentage or speedup is
inferred. The separate source-lifetime VM candidate and later diagnostic
counters were **not loaded into this Worker**. Native bundle and human UI
remain unchanged. Cold shell three seconds and the full goal remain unmet.
