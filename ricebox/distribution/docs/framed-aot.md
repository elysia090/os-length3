# Framed AOT trial

The standard builder still emits the established whole-Wasm assets. To stage a
local trial with the matching runtime from this checkout, write a **separate**
distribution and opt in:

```sh
node ricebox/distribution/build/distribution.ts ROOT.tar.zst TRIAL_DIR \
  --deploy --framed-aot --translator TOOLS/sods.wasm --sods TOOLS/sods --maker TOOLS/muk
```

`ROOT.tar.zst` stands for a versioned release archive with its digest in the
name. `--framed-aot` is a build-time option, not compatibility negotiation. Use
the new runtime and trial assets together; the earlier runtime does not read
framed assets. The current runtime still reads earlier unframed indices.
The small-module path and the Muk artifact are unchanged. The trial emits
`sods-framed-v2`; its runtime also reads the earlier single-object framed trial.

For Wasm larger than the 32 MiB threshold, the producer separates initialized
guest bytes from code and prepares both memory-import modes. Only the small
initial code frame has a second variant. The static visitor checks both the
logical artifact digest, every independently addressed physical object and every
member digest. A small first object permits an early start; later objects are at
most 16 MiB. No frame crosses a physical boundary and no separate aggregate
file is shipped. The runtime retries and can resume each object within its
declared size and retires outstanding reads. It verifies Cache Storage hits, if
available, and keeps only fully authenticated objects. It authenticates members
before expanding them into at most 4 MiB per decoded buffer, then supplies code
to the engine in order. There is one physical-object lookahead and at most two
decoded work slots. HTTP/decoder/engine internals and verified initial data
retained for exec are not covered by those slot bounds.
The complete module and initial image must both pass before either can be used by
the guest. An unsupported or overlapping framed layout, bad frame/EOF, engine
failure or retirement does not turn into a demand translation.

## Baseline and remaining work

A Node 24.22.3/V8 local-asset comparison compiled two tiny C translation units
with GCC 16.2.0, then linked static PIE. Every resulting binary separately ran
natively and printed `42`. Three fresh processes per variant and five further
builds per process gave:

| | Whole | Two-slot framed, sharded |
| --- | ---: | ---: |
| First build, median | 5.850 s | 4.828 s |
| Same-guest repeat, median | 0.362 s | 0.373 s |
| Process peak, median | 1,827 MiB | 1,198 MiB |
| cc1 bytes read | 61,437,389 | 61,485,358 |
| cc1 objects read | 1 | 5 |

Samples are small, and this was the canonical Worker with local stream transport
on a Xeon Platinum 8573C, not a browser, HTTP, or deployed SLA benchmark. An
earlier one-slot trial had approximately the same cold median as whole loading.
The measured five compiler objects include a 956,765-byte initial object and a
16,182,531-byte largest object. The actual packaged starter staged the same
fixture. The 25 MiB asset-limit visitor rejects the unframed fixture and admits
the sharded fixture. The current evidence is strongest for memory and
deployability at that limit, not an assured network speedup.

Before making framing the default, check these independently:

- **Artifact footprint and delivery:** Two slots remove a large JS allocation,
  not GCC's transfer cost; measure alternate compression and smaller
  translation output. Compare object sizes and lookahead on slower networks,
  cache-hit versus cache-miss, and the effects of additional requests. Test
  whole-distribution assets separately: not every other package, such as large
  ordinary file packs, is subject to this compiler-object cap.
- **Compile/guest work:** Check shared and unshared startup, first verified byte
  to engine, compile completion, init placement and actual cc1 execution. The
  earlier whole-path probe found only ~16 ms in instance construction, but
  ~1.14 s after cc1's first syscall (guest work and any first-hit engine work).
  A frame layout does not by itself improve that execution.
- **Revisit and failure policy:** With default unframed delivery nothing changes.
  v2 fixture tests exercise range-resume, transient failures, cache validation
  and a network-free revisit. Confirm on real browser Cache Storage, quota
  exhaustion, generation change, and slow-link retirement; do not equate
  same-guest module reuse with fresh-guest cache hits. Cache Storage operations
  use browser promises that have no abort API; in-flight work is drained
  rather than allowed to publish a partial image.
- **Browser/main-thread and terminal:** Measure stock sandboxed Chrome on
  loopback and a representative network, cold and revisit, including peak
  renderer memory, idle/startup/no-op shell, terminal responsiveness and a real
  multi-file `.o` plus link. Only the Node Worker, transport/integrity, fixture
  staging, and real linked-output controls were exercised here.
