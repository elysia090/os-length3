# Register add/sub: independently observed red — 2026-10-08

Baseline `5792275` closes string I/O, NOT register extended arithmetic. The
actual published make still has 4,728 unlowered coordinates of 233,455. Its
first source, DC ED at 0xa19a, is **FSUB ST(5), ST(0)**, not FSUBR as the earlier
checkpoint mistakenly called it. Intel's
[FSUB and FSUBR opcode tables](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf)
distinguish DC E8+i from DC E0+i. No decoder/product semantics were changed
to conceal this naming correction.

## Existing observer and boundary, not a second execution implementation

`wasm-compiler/check/x87-arithmetic-observe.c DIRECTORY --register` extends
the SAME physical-Windows/no-wait FPU and RFLAGS capture used for integer
memory arithmetic. It calls native x86, not the product compiler, SoftFloat
or a handwritten add/sub implementation. Code is RW only during construction,
then RX; native pointers remain representable by the Windows x87 context.
The existing physical/logical FXSAVE projection supplies complete payload,
tag, TOP, FIP/FDP/FOP and flags. GPR invariance remains an architectural rule,
not an observation of all live host registers.

The population is explicit:

* 72 encodings: D8/DC/DE x add/sub/reverse-subtract x eight register indices.
  Each has 400 masked precision64/nearest rows from twenty x twenty operands.
  Index zero is an intentional alias: both operands are the SAME register,
  so those rows are observations, not 400 distinct inputs.
* Nine index-five groups have 1,536 further rows each: sixteen chosen operand
  pairs x four precision-control encodings x four rounding modes x six mask
  contexts (all masked, or individually unmasked IE/DE/OE/UE/PE).
* Total **81 construction groups / 42,624 complete states**, with all eight
  TOP values and changing incoming flags. These are not the full Cartesian
  product of every operand, control word and encoding, or an ISA certificate.

Operands include signed zeros/finite values, cancellation, one ulp at one,
extreme subnormals, pseudo-denormal, minimum normal, maximum finite, signed
infinities, quiet/signaling NaNs with different signs/payloads, unsupported
encoding and empty stack. Only one form's bounded 1,536-pair record buffer is
resident in the observer, not the whole 107,071,488-byte record population.
Records are disposable ignored Windows temp products, not distribution assets.

The existing `check-x87-state.mjs` adds `--register`, loading those records
through the SAME cold C compiler -> ordinary Wasm -> C MMU/function-table
boundary. It supplies no numeric/guest interpreter. The real DC ED is placed
first and currently refuses **-102**; a separate construction inventory confirms
**all 81 groups refuse -102**, not capacity or source-fetch failures. This is a
test red, NOT a green register execution gate or successful root publication.

## Independent numeric agreement and the important publication distinction

`data/oracle/check-x87-register.c` uses authenticated official SoftFloat 3e
(8086-SSE, FAST_INT64/LITTLEENDIAN). **22,347 canonical, masked, non-reserved-PC
numeric results and IE/OE/UE/PE flags agree**. The remaining 20,277 observations
are explicitly outside that gate. No pseudo-denormal, unsupported/empty input,
reserved PC or unmasked state publication is certified by SoftFloat. Its
[noncanonical limitation](https://www.jhauser.us/arithmetic/SoftFloat-3/doc/SoftFloat.html)
is not waived. It remains a build-only oracle.

The hardware matrix contains 2,208 unmasked-pending states. Destination
payload changes in 554; 192 pop despite pending error:

| Newly unmasked cause | Pending rows | Changed payload | Popped |
| --- | ---: | ---: | ---: |
| IE | 912 | 0 | 0 |
| DE | 720 | 0 | 0 |
| OE | 48 | 48 | 16 |
| UE | 216 | 216 | 72 |
| PE | 312 | 290 | 104 |

Thus `ES != 0 -> no write/no pop` would be a real implementation defect.
An equal payload in 22 PE rows does not prove the write was suppressed.
These are the local CPU's observations, not universal silicon certification.
Intel's [NaN and invalid-operation rules, Tables 4-7/8-10](https://cdrdv2-public.intel.com/782149/253665-sdm-vol-1.pdf)
also require classifying BOTH raw operands: quiet versus signaling priority,
larger NaN significand, unsupported format, empty stack and infinity conflict.
The consuming operation owns NaN handling; do not quiet or flip a NaN payload
while converting its source to the pure expression inputs.

## Next common normal form

Reuse the existing exact two-word alignment/jam/cancellation/normalization/
precision-rounding core in `x86/src/x87-arithmetic.c`. Generalize its operand
projection from extended-plus-integer to TWO raw extended operands. Classify
both before sign changes; select raw NaN payload by the observed/reference
priority, handle conflicting infinities/unsupported/empty inputs, and retain
denormal priority separately from numeric OE/UE/PE. Return one pure result,
tag, raised flags, C1 and the IE/DE suppression decision.

The backend consumes the common descriptor's source/destination/pop roles,
publishes the same payload/tag/status/frontier and uses the existing deferred
#MF/FERR owner. Pop depends on the actual suppression decision, NOT simply
pending ES. Register arithmetic must retain FDP; prefix/FOP, aliasing,
destination direction and precise wait/fault boundaries still need their own
constructor/full-state gates. No f64 rounding, VM math callback, opcode
interpreter, product SoftFloat or guessed minimum/work/span certificate.

## Reproduction and retained greens

In PowerShell from the repo, use a fresh output directory:

```powershell
$scratch = 'temp/x87-register-1008'
New-Item -ItemType Directory "$scratch/hardware"
gcc -O2 -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion `
  -Isrc/v2/support/include -Isrc/v2/machine-abi/include `
  src/v2/wasm-compiler/check/x87-arithmetic-observe.c -o "$scratch/observe.exe"
& "$scratch/observe.exe" "$scratch/hardware" --register
gcc -O2 -std=c11 -Wall -Wextra -Wpedantic -Wshadow -Wconversion `
  -DSOFTFLOAT_FAST_INT64 -DLITTLEENDIAN `
  -Idata/upstream/softfloat/3e/SoftFloat-3e/source/include `
  -Isrc/v2/support/include -Isrc/v2/machine-abi/include `
  data/oracle/check-x87-register.c temp/float-oracle/softfloat-build/softfloat.a `
  -o "$scratch/reference.exe"
& "$scratch/reference.exe" "$scratch/hardware"
node data/oracle/check-x87-state.mjs temp/string-io-1008/vm.wasm `
  temp/string-io-1008/compiler.wasm "$scratch/hardware" --register
# EXPECTED RED: x87-register dced must compile, actual -102.
```

Observer SHA-256 `2ca3cc54193898a981e151175a30c5e4bdf3ae630639d17876849224ca515900`;
reference executable `e5916ecb1e828921e34ee1ebc82cd7facc7530d0c35d825f535b562c8606453d`.
Original official SoftFloat archive remains pinned to `21130ce885d35c1fe73fc1e1bf2244178167e05c6747cad5f450cc991714c746`.
The new Makefile observer target builds the same source without product linkage;
it is optional and physical-Windows-only, not a default Linux acceptance test.

The observer's original integer mode still reports 36,864 rows, 4,460 pending
and 2,096 changed-payload-pending states. The common C-state driver re-passes
**36,864 integer arithmetic** and **44,032 status-comparison** rows using the
unchanged current compiler/VM. The correct status population is
`temp/x87-status-1008/hardware-complete`; its old partial `hardware` directory
lacks the final FTST groups and is NOT the whole gate.

Native bundle, human UI, compiler/VM bytes and actual-make coverage are
unchanged in this red-only step. No fresh browser run, Linux boot/offline shell,
signed root, distribution size/speed, RSS reclamation or global minimum claim.
