# Corpus

This is the top-level home for small, reusable programs and physical forms.
Entries are grouped by the structure that makes them compact, not by the
language they were first written in.

| category | purpose |
| --- | --- |
| `physical-array/` | coordinate substitution, region cuts, grouped spans, endpoint moments |
| `storage/` | run compression, erasure distribution, and cryptographic lane kernels |
| `crypto/` | fixed-width field arithmetic and cryptographic inner kernels |
| `vm/` | machine layouts and transition kernels built from those physical forms |
| `bit-linear/` | fixed bit permutations and GF(2)-linear maps |
| `whole-word/` | affine integer arithmetic, comparisons, and reductions |
| `lanes/` | fixed-width field and lane kernels |
| `text/` | bounded string and rolling-hash kernels |
| `floating/` | explicitly observed floating-point bit kernels |
| `residual-state/` | word, rank, and finite-predicate layouts for future queries |
| `residual-state-pressure/` | multi-coordinate residual queries that intentionally exceed the scalar entrance |

The browser's current examples remain in `src/v2/examples` as a compatibility
surface. They are not moved while the UI is frozen. New VM and physical-array
work is canonical here; the older examples can be migrated category by
category after their loader no longer assumes a flat directory.

Every compact entry should state:

1. the coordinate or region it carries;
2. the exact algebraic condition that keeps it compact;
3. the explicit fallback or rejection when that condition fails;
4. a small dense comparison suitable for differential testing.
