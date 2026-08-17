# postlink-compiler

The post-link compiler turns a linked x86-64 program image into the block
artifact the QM runtime executes. It is the *producer* side of
`x86-native-machine-v5`; `vm.c` is the consumer.

```
artifact/linux-x86-64          artifact/linux-x86-64-postlink
(512 MiB physical RAM image)   (compiled blocks + physical backing)
        |                                   ^              |
        |  decode, close, normalize         |              |  execute
        +---------- postlink-compiler ------+              +--> vm.c
```

It builds with `gcc` and nothing else, and it is meant to run **on x86** —
including inside the guest it compiles for, whose read-only `/usr` layer
carries the pinned GCC. A post-link compiler that needed a host Python or a
browser could not run there, which is why those routes are being removed
rather than kept as fallbacks.

## Build

```sh
make            # the native driver and the self-test
make check      # run the self-test
make parity     # additionally prove the C codec against the Python writer
make guest      # a static binary for the guest's own toolchain
make wasm       # the library objects for the browser runtime
```

`make`, `make check` and `make parity` are verified with gcc 14.3.0, clean
under `-Wall -Wextra -Wpedantic -Wshadow -Wconversion -std=c11`.

`make guest` needs a static libc; it links against the guest's musl, and fails
on a host that ships only dynamic glibc. `make wasm` needs clang. Neither has
been run on the current development host, so both are declared rather than
tested.

The library sources under `src/` are freestanding: no libc, no builtins, no
target assumptions beyond two's complement. Only the drivers under `tools/`
and `check/` use libc, so the browser runtime reuses the same objects without
a second source tree.

## Why this directory exists

The compiler was welded into three places at once, and no two of them could be
changed independently:

| where | what it holds | lines |
| --- | --- | --- |
| `kernel/x86.py` | `X86DBT` — decoder, block former, closure | 22,122 |
| `kernel/x86snapshot.py` | the artifact writer | 3,326 |
| `web/x86-machine.js` | a second, independent artifact *reader* | 970 |
| `vm/wasm/vm.c` | a third reader, plus the executor | 7,083 |
| `tools/*native_x86*` | 15 drivers importing each other | ~3,000 |

The record layout therefore existed three times, in three languages, with no
mechanical check that the three agreed. `include/postlink/format.h` is now the
one definition; `check/format_parity.py` fails the build if the Python writer
drifts from it. That check exists only while the Python writer still produces
artifacts and is deleted with it.

`vm.c` has the same problem internally: five unrelated subsystems share one
translation unit and one `union workspace` —

| lines | subsystem |
| --- | --- |
| 39–1130 | bit codec, sponge, `vm_load`/`vm_read`/`vm_feed` |
| 1132–1520 | `vm_guest_*`, a wasm bytecode interpreter |
| 1521–4230 | `vm_step_*`, `vm_program_*`, the STEP workspace |
| 5334–6960 | `vm_x86_*`, the x86 machine |
| 6963–7083 | `vm_eval_*` |

The x86 and STEP workspaces are deliberately coupled — they share one physical
byte array, so a STEP page and an MMU page are the same bytes. The other three
are only sharing an arena, and separate cleanly.

## What is here now

| path | what it is |
| --- | --- |
| `include/postlink/format.h` | the record layout: magics, header offsets, control codes, tag codes |
| `include/postlink/continuation.h` | the continuation residual codec |
| `include/postlink/machine.h` | the container framing and its region directory |
| `src/format.c` | record parse and validation |
| `src/continuation.c` | canonical continuation encode/decode and RIP projection |
| `src/machine.c` | container framing, with a targeted reader for the header's integer fields |
| `tools/inspect.c` | `postlink-inspect`, the first driver that reads a real artifact with no Python and no JavaScript in the path |
| `check/selftest.c` | codec assertions and 13,932 continuation round-trips |
| `check/format_parity.py` | proves those round-trips against `kernel/x86snapshot.py` |

`postlink-inspect` on the shipped artifact:

```
  schema       x86-native-machine-v5
  payload      32811421 bytes
  header       2657 bytes at 26
  region page  65536 bytes
  memory       offset        65536  length      3342556  ( 10.2%)
  descriptors  offset      3473408  length      8791436  ( 26.8%)
  execution    offset     12320768  length     20490653  ( 62.4%)
```

## What is not here yet

The decoder, the block former and the closure driver are still `X86DBT` in
Python. They are the bulk of the port and the reason this directory starts
with the format rather than with the compiler: every stage that moves to C has
to keep producing the same bytes, and that is only checkable once the bytes
have one definition.

The order the remaining stages move in:

1. **container writer** — C emits the v5 payload the Python writer emits today,
   proven byte-identical on the shipped artifact.
2. **executor** — `vm_x86_*` and `vm_step_*` move out of `vm.c` into `src/`,
   built for both wasm32 and native x86-64. The Python execution path in
   `kernel/x86.py` and the JavaScript reader in `web/x86-machine.js` are
   deleted rather than kept, so there is one execution route.
3. **decoder and closure** — the remaining ~20,000 lines of `X86DBT`. This is
   the stage that lets the compiler run inside the guest.

## Artifact taxonomy

The names under `artifact/` did not say which artifacts were inputs, which
were outputs, and which were subsets of each other:

| name | format | what it is |
| --- | --- | --- |
| `linux-x86-64` | `x86-boot-cache-v1` | **input.** The 512 MiB physical RAM image: bzImage at its load addresses, initramfs, and the toolchain SquashFS mapped through `phram` at a reserved physical address |
| `linux-x86-64-postlink` | `x86-native-machine-v5` | **output.** What this compiler produces from that input |
| `toolchain` | `linux-x86-64-system-v1` | the musl/GCC system tar published on its own with a VFS index. Its bytes are already inside `linux-x86-64` as SquashFS; this is the pre-SquashFS canonical archive, kept for inspection and replacement |
| `compiler` | `webassembly-compiler-v1` | the browser's Clang, which emits **wasm**. Unrelated to the x86 path |
| `vm` | `webassembly-runtime-v1` | `vm.wasm`, built from `vm/wasm/vm.c` |

So `toolchain` is a subset of `linux-x86-64`, and `linux-x86-64-postlink` is a
function of it. The artifact formerly called `linux-x86-64-machine` is renamed
accordingly: "machine" named neither its input nor its producer, and read as
though it were a peer of `linux-x86-64` rather than derived from it.

`toolchain` currently has no runtime consumer — nothing under `web/` or
`kernel/` opens it by name. It is a 126 MB checked-in publication duplicating
bytes that `linux-x86-64` already carries.
