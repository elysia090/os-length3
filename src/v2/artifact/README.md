# artifact

`artifact` owns semantic identity and the unique reconstructible spelling of a
release. It does not decode x86, lower Wasm, choose delivery locations, or
implement a filesystem.

The build boundary supplies complete typed observations. `future` first joins
the block machines of every ELF and erases their local state names. The
library assigns one canonical rank exactly when the complete domain and response bytes are
equal. Rank order is independent of ELF, archive, path, address, page,
discovery and allocation order. SHA-256 accelerates ordering but never decides
equality; equal-digest candidates are compared in full.

The same quotient is used for executable blocks, pure slices, instruction
meaning, immutable reads, archive-member observations and cells which remain
after derivation. The family tag prevents semantically unrelated objects from
sharing a meaning rank. After semantic canonicalization, exact immutable byte
payloads may still share one untyped payload rank.

The current C gates are:

* `share`: exact typed quotient plus both directions of the equivalence red;
* `payload`: one untyped byte owner across ELF, rodata, archives and proof
  extents before whole-word substring factoring;
* `derive`: delete every proof/coordinate/directory cell reproduced by its
  total generator and share only the exact residual values;
* `rank-map`: replace each construction-only occurrence-to-rank column by the
  minimum ordered residual DAG of its complete fixed-width coordinate
  function, with a distinct absent padding response;
* `future`: form one disjoint-union block machine across every linked ELF,
  erase image-local state names, and share states iff every finite future arm
  word has the same canonical observation;
* `program`: quotient block control, pure-slice topology, lifted parameters
  and instruction witnesses independently; substitute their canonical ranks
  into a fixed block tuple; erase every nonterminal instruction witness; then
  run `future` over the release-wide ELF union. Its storage projection emits
  only class representatives, terminal meanings and stabilized future rows,
  all of which must resolve through the global payload quotient;
* `executable`: split each final ordinary ELF at the compiler's sealed emitted
  block interval, generate every block file coordinate by prefix sum, share
  exact prefix/block/suffix payloads globally, and reconstruct every image;
* `immutable`: minimum residual DAG for a complete finite byte-coordinate
  function;
* `factor`: exact shortest literal/prior-factor parse in the declared bounded
  grammar, used as the oracle for the suffix-index writer;
* `factor-index`: suffix-array/LCP implementation which reproduces the exact
  oracle's cost, token lengths and canonical sources directly from the
  immutable byte view. Its public workspace is exactly four N+1 u32 columns
  plus a block-scaled packed arena; it exposes no alternate count, LCP,
  temporary, opened-word or decoded-word allocation;
* `factor-codec`: the stored literal/prior-reference bit word and a bounded
  reader which reconstructs without access to the opened source;
* `archive`: ordinary GNU ar bytes generated from member payload ranks and the
  observable member/symbol view; its complete gate recomputes the global
  payload quotient, rejects split-equal/merged-unequal ranks, regenerates the
  full non-aliasing archive stream and compares every canonical byte. Its
  bounded C reader opens a canonical stream back into borrowed member extents
  and resolves symbol header coordinates by binary search over the monotone
  member-header column; it never copies member payloads or performs an
  `S*M` scan. Empty archives are the zero view; GNU's semantically empty
  symbol-table NUL and long-name newline alignment spellings are admitted and
  normalized away before publication;
* `namespace`: canonical component-preorder release tree. It retains one
  basename occurrence per non-root path, a `2P-2` bit ordered-tree code, one
  normalized inode descriptor per first occurrence, symlink/xattr bytes and
  sparse hardlink aliases. Complete path prefixes, dense parent/path-to-inode
  columns, content ordinals, readdir intervals and directory coordinates are
  regenerated. Its source-free reader reopens parent, inode and lookup results
  and rejects malformed topology padding or alias rows;
* `layout`: coordinates, endpoints and rank-select regenerated from the one
  retained extent column;
* `complete`: the composition gate which requires the declared occurrence
  cardinality of every enabled semantic family, immutable-owner family,
  archive and generated-cell family, plus the global block population with
  its strict mapping to every BLOCK observation. The gate reruns `program`
  over its authoritative control/topology/parameter/instruction partition and
  compares every derived BLOCK, SLICE and INSTRUCTION response. Every immutable observation
  is bound to one payload occurrence, every archive-member observation to one
  generated member view, and every derived observation to one real exception.
  Declared namespace material must resolve through that same global payload
  quotient; the gate then reopens every future rank, typed rank, archive byte,
  namespace binding, derived cell and canonical byte from the stored factor
  word;
* `artifact-measure-root`: a production-population upper-bound audit whose
  digest is only a candidate index; page identity is confirmed by complete
  extent-byte comparison. It also opens every canonical GNU archive through
  the C reader, counts every member/symbol occurrence, regenerates every
  stream byte, and reports exact member-payload ownership across archives;
* `index`, `object`, `root`, `resource`: authenticated bounded lookup and root
  primitives.  The directory regression rebuilds an identical tree with zero
  new nodes and shows that one changed row replaces only its leaf-to-root
  path.

Run all product checks with:

```sh
make -C src/v2/artifact check
```

`share` produces construction ranks; it does not call the per-occurrence rank
column generated. `rank-map` now removes that dense construction column and
reopens every rank from the exact finite-function residual. Further generator
selection belongs to `derive`, which compares every coordinate against a total
generator before keeping exceptions.

This is not yet a standard-release size result. The suffix-index implementation
matches the bounded exact oracle on 2,046 exhaustive binary words and 512
random words, and `complete` proves the local composition. Publication remains
red until the release writer supplies every optimized ELF and filesystem
object, its block/slice/instruction boundary supplies complete typed
observations, and the resulting full release word decodes every ELF, archive
and VFS byte exactly. A filesystem walk, page-digest count, Deflate result or
historical machine pack is not a substitute for that gate.

`release-sharing-check` exercises the actual boundary rather than a serialized
observer fixture. Two distinct linked inputs are post-link compiled, their
complete block/slice/instruction populations are joined, and the final ordinary
ELF bytes delivered by the successful compiler commit enter the same global
virtual Byte* view. The executable stage now invokes `complete` as its final gate;
block, slice, instruction and immutable observations cannot obtain four
adjacent green results. The test writes selected factor choices directly from
immutable owners and verifies the packed bits against their CSR byte view
without opening either an input or decode word. It requires exact interval
equality and a zero optimality gap. The version-8 executable
stage opens the authoritative release namespace through the POSIX build
adapter, orders ELF/archive/ordinary-payload arguments by the namespace's
generated content ordinals, and reaches the required `0x3f` mask even when an
enabled archive or residual family is correctly empty. The production payload
wrapper invokes that stage once. Canonical archive member payloads, minimal
`ARVM1`/`ARVS1` rows, nonempty ordinary inode payloads and namespace material
enter the same byte view; generated archive streams, complete path prefixes,
dense inode/parent columns and generated proof coordinates do not. The adapter
is build-side only and is not a filesystem or runtime reader.
