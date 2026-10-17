# Coordinate binding is not execution topology — 2026-10-05

This is a new **red**, not a compiler/runtime optimization or Linux boot.
The final fence compiler, 446,566 bytes / SHA-256
`f5b8e31bfe9649d9f5eae79c4b0cd2a88c1065fb216e891acabd590f2a0ebeb5`,
emits twelve distinct exact modules for each of ten operation shapes at twelve
canonical virtual page coordinates. Default invocation exits 1: all ten
families violate the desired one-topology-per-shape condition. `--observe`
records the same red without making it an acceptance pass.

## What was actually checked

The independent cold C compiler emits NOP, register MOV/ADD/XOR/CMP, direct and
conditional relative branches, RIP/EIP-relative LEA, and the newly supported
serialized LFENCE. No emitted bytes are patched or disassembled in JavaScript.
Twelve coordinates include low addresses, a 32-bit boundary, high user addresses
and the kernel's high half. Eight seeded state inputs exercise both conditional
branch outcomes and RF clearing.

All 960 complete **normalized state** results agree. Normalization removes only
the explicitly declared coordinate outputs: RIP, and RAX for the two LEA
fixtures (with the correct 64-/32-bit modulus). All other 1,256 state bytes,
retirement and the private window outside state remain exact. All 120 wrong-RIP
entries refuse without mutation. A grown ordinary Memory still executes the
unchanged compiled instance.

These are metamorphic covariance checks, **not independent native ISA evidence**,
a complete future-equivalence proof, an SMP claim or a source lease check. In
particular, a relocated LEA's absolute result is intentionally different. The
two machine states are not declared observationally interchangeable. The
existing native/precise-frontier tests remain the semantic oracles.

See the actual red receipt.
The raw observation SHA-256 is
`7591a030dc4f7ec4e597f524573001af003b0c9b70b2095c4e2f31929377050b`.

## Factorization derived from the required observations

Let `b` be the admitted cut's entry coordinate and `T` its fixed operation
topology. For an address originating from the decoder's instruction coordinates,
substitution gives

```
instruction_rip        = b + instruction_offset       (mod 2^64)
instruction_fallthrough = b + fallthrough_offset      (mod 2^64)
relative_target        = b + target_offset            (mod 2^64)
EIP-relative_base      = (b + fallthrough_offset) mod 2^32
```

The decoder already supplied and validated these values. Taking the difference
from its admitted `b` preserves the exact modulo-64-bit value, including negative
branch displacements. Address-size truncation stays at the existing operation,
not at an earlier arbitrary stage. Ordinary immediate literals, guest pointers,
segment bases and loaded branch targets must **not** be guessed to be relative
just because their numeric bits happen to equal an instruction address.

The desired compiled representation is therefore a fixed function `F_T(S,b)`
plus the existing admitted coordinate, rather than a new embedded-address body
`F_(T,b)` for every coordinate. This factors a recipe; it does not discard the
binding or quotient away externally observable addresses.

The local sufficiency obligation is equality with today's lowering for every
accepted state and binding:

```
F_T(S,b) == F_(T,b)(S)
```

Equality includes returned machine result, CPU/port/RAM writes, precise fault
order, partial REP progress, RF and retirement. A fault or residency wait must
not use the caller's next row or another coordinate. The source owner's code,
CPU/MMU and generation validation remains **per coordinate**. An identical
template is never permission to reuse another coordinate's admission.

These obligations explain why simply deleting the current RIP test, stripping
constant bytes, or caching only an entry/hash cannot turn the red green.

## Placement is a second independent coefficient

The same observation separates engine stages. At 4,096 previously unused NOP
coordinates, measured cold C emission is 25.7482 ms, Module construction
158.1622 ms and Instance placement 82.5032 ms. Reconstructing previously
compiled exact bodies is much cheaper: the warmed rounds measure Module
10.552–10.9641 ms and Instance 19.1422–34.0919 ms.

The real bounded owner, under unchanged 1,024-entry / 262,144-byte limits, also
constructs 4,096 instances when 120 known exact bodies are requested under
4,096 different synthetic keys. It retains 252,056 bytes and evicts 3,072
entries. This last stream diagnoses owner placement, **not a measured kernel
coordinate population**; its keys deliberately do not confer guest admission.

These are Node constructor microbenchmarks under concurrent host load, not
native x86 throughput, a Linux speedup, RSS reclamation or browser acceptance.
Module sharing alone leaves coordinate-by-coordinate Instance construction.
An immutable global bound at each instance also leaves that coefficient.

The minimal next contract is to pass the already C-admitted entry by value to
the fixed template call, retaining the exact RIP comparison. It needs no
reconstructed binding image: `vm_execution_row.entry` and the latched in-flight
row already own this value. The current two-argument machine-entry ABI does
**not** yet do so. Its typed call, all module signatures, native/cold emissions
and precise-frontier tests must migrate together before shared instances can
be used. The entry ABI version must advance and mixed old/new table types
must be refused, not repaired through a two-argument execution fallback.
This is an outstanding design/implementation obligation, not an
alternate runtime installed by this checkpoint.

An engine owner can then share an exact C-emitted template within its existing
byte quota, while source slots/leases separately bind and revoke coordinates.
The exact template witness still matters when a source write or compile limit
changes the body. Descriptor lifetime cannot resurrect an evicted witness, and
foreign Worker imports cannot share an instance. Necessary/sufficient equality
must be established in the admitted grammar; these fixtures do not prove a
global minimum for arbitrary x86 programs.

## Reproduction and scope

```sh
node data/oracle/check-cut-coordinate-sharing.mjs COMPILER.WASM --observe
node data/oracle/check-cut-coordinate-sharing.mjs COMPILER.WASM
# The second command currently exits 1 after reporting the ten red families.
```

No production source/compiler/VM/engine quota, bundle or human UI changed.
The same-bundle fence startup is still running independently. PID 1, release
root, shell/toolchain, storage/recovery, granted network and real browser boot
remain unachieved; no status is inferred from this red or from live-process CPU.
