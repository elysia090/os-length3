# Precise unpack as selected-word SSA — 2026-10-05

The completed engine-demand run reaches the same real PUNPCKLDQ gate:
[separate receipt](2026-10-05-node-startup-cohort-unpack-red.json),
`66 0f 62 e5` at 0xffffffff81204e1e. It retires 160,653,998 instructions
in 86,601,736 admissions; all 14,622,864 decompressed bytes agree.
This is independent Node execution, not current browser acceptance or PID 1.
The rootfs/nullfs message is not a mount of the release SquashFS.
Raw local receipt SHA-256:
`931d500f638b6c129b08cf6523f763208a16556b8f3a8e4e4a12f27b00e77c1d`.

## Red and derivation

[Red first](2026-10-05-vector-unpack-red.log): the native fixture captures
29,696 observations / 13,328 fault frames while the old common compiler
rejects form 136 with -102. Twelve unpack encodings add 96 forms to the
unchanged 136 transfer/add/logic forms: packed byte/word/dword/qword low/high
and PS/PD low/high. Each uses distinct registers, self-alias and six memory
address topologies. All earlier 17,408 native records, 136 source pages and
136 emitted modules remain byte-identical.

Intel [SDM revision 093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Vol. 2B PUNPCKH/L and UNPCKH/L PS/PD, defines these operations as bit
interleaving with no numeric exception. The legacy operand still requires
16-byte alignment and normal segment checks even when only the selected
64-bit half is fetched. Type-4 control/fault priority is unchanged.

Take only the selected old destination/source words `a,b`. The other halves
are not live. For a 64-bit element the result is simply `(a,b)`. For 32 bits:

```text
r0 = (a & 0xffffffff) | (b << 32)
r1 = (a >> 32) | (b & 0xffffffff00000000)
```

For 8/16-bit elements, each output word comes from one 32-bit fragment of
`a,b`. Spread that fragment into the even element positions:

```text
spread16(x) = (x | (x << 16)) & 0x0000ffff0000ffff
spread8(x)  = (spread16(x) | (spread16(x) << 8)) & 0x00ff00ff00ff00ff
rj = spread_w(fragment32(a,j)) | (spread_w(fragment32(b,j)) << w)
```

These are fixed mask/shift networks, not runtime loops over lanes or a
materialized vector image. The two output words are captured before either
publication. Register forms load only the selected old words. The common
memory pair provider still preflights and reads the full 16-byte operand;
only one returned word is consumed. Removing that unused provider load
requires a general live-projection frontier and its own precise-fault proof,
not dropping the alignment/segment checks or substituting two scalar reads.

Self-alias removes the second old-word load and the second spreading network.
Because the resulting fields are disjoint, `s | (s << w)` is exactly
`s * (1 + 2^w)` modulo 2^64. This holds for every input, not observed samples
only. For 64-bit elements the same captured word is published twice. Alias
module sizes decrease 593→491 bytes (8-bit), 509→451 (16-bit), 427→417
(32-bit) and 393→385 (64-bit), including the unchanged precise scaffolding.
This is an exact local substitution, not a global work/span minimum proof.

## Checks and remaining work

[Final comparisons](2026-10-05-vector-unpack-comparisons.json): 232 exact
native/cold emissions, 29,696 unchanged pre-lowering observations, 29,696
direct and 29,696 C-dispatch full CPU/RAM comparisons, 59,392 RF checks,
53,312 native fault comparisons, 3,248 control models, 596 wait/retries,
3,136 entry refusals, 112 aliases and 14 pair-boundary refusals pass.
Native element-by-element and alias byte-copy references are independent of
the emitted spreading network. MMX, VEX, LOCK and unsupported FS/GS forms
remain explicit grammar refusals with untouched output/report.

Full native compiler checks/CLI and scoped ASan/UBSan pass. The 108 scalar
forms / 6,912 observations and 16 MXCSR forms / 4,096 observations retain
exact emissions and full comparisons. Borrowed input/output-growth checks
pass. Matched no-image one-million-admission startup retains every non-size,
non-UTC/clock/timing observation: 1,616,430 retirements, 620,243 emitted bytes,
7,262,208 borrowed source bytes, zero copied bytes and unchanged resident
allocation. A run with the root-image command line is not compared as though
it were the same default input; its parser and counts legitimately differ.

The final alias-normalized compiler is 443,354 bytes (+1,043), SHA-256
`54cc4e53812ea46753bb1093cf68e8e450fe3d1143412345fd59b82ca8b79c94`.
The VM, native distribution and human UI are unchanged. An extended
same-bundle run using the initial correct unpack compiler (443,212 bytes,
SHA-256 `e6663ce86f1aaa211eb60ba265511fca29c5c184b0cb20a2d8085c0d90878954`)
has completed; it predates only the additional alias substitution and is not
silently restarted or described as the final compiler run. It actually
passes unpack and reaches PADDD at 0xffffffff81204e2a. See
[next actual gate and general carry-isolated addition](2026-10-05-vector-add-narrow.md).

The completed cohort run still has 14,944,237 engine constructions,
14,943,493 quota evictions, 743 entries / 262,139 retained module bytes under
unchanged quotas. Phase milliseconds: cold 147,998.4; engine 372,439.7;
execution 85,483.4; admission 21,295.9; supply 194.4; elapsed 762,434.5.
Calibration and retired work vary; this is not a speedup comparison.
See [engine lifetime boundary](2026-10-05-engine-demand.md).

PID 1, release-root mount, offline shell/development commands, authenticated
storage/recovery, granted NIC networking and real-browser acceptance remain
open. Cold shell within three seconds is unmet. Engine churn and region
closure are unresolved. Strict native CALL and Windows RTC oracle reds are
not cancelled by unrelated green fixtures. Browser policy is not bypassed.
