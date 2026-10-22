/* Suffix-index implementation of the exact prior-factor grammar. */

#ifndef ARTIFACT_FACTOR_INDEX_H
#define ARTIFACT_FACTOR_INDEX_H

#include <artifact/factor.h>
#include <artifact/payload.h>

typedef struct {
    /* Exactly four N+1 columns. `source` is construction scratch until LCP
     * dies; `length` is SA-IS scratch, then LCP, LPF and the final choice.
     * `rank` is SA bucket/name scratch before becoming ISA, then holds sparse
     * selected-rank intervals. No caller-provided alias or opened Byte* exists. */
    pl_u32 *source;
    pl_u32 *length;
    pl_u32 *suffix_array;
    pl_u32 *rank;
    pl_u32 vector_capacity;

    /* One B-word arena, B=ceil(N/16), has disjoint phases: an
     * N/4096-page direct directory for the immutable byte view, a 2B-u32 LCP
     * block RMQ, then one u32 tail cost per block. Each 4-bit cost delta is
     * substituted into the dead high nibble of its LPF cell as that target is
     * finalized. SA bucket scratch uses the not-yet-live inverse-SA column; a
     * fixed stack table handles the 257-symbol alphabet when N is smaller. */
    pl_u64 *cost_tree;
    pl_u32 tree_capacity;
} artifact_factor_index_workspace;

int artifact_factor_index_measure(pl_u32 bytes,
                                  pl_u32 *vector_capacity,
                                  pl_u32 *tree_capacity);

/* Exact for the same grammar and tie order as factor.h. SA-IS constructs the
 * canonical suffix array directly from the immutable byte view. Kasai LCP
 * plus both ordered prior sides proves the longest prior factor at every
 * coordinate. Monotone suffix-cost deltas are packed at four bits each; no
 * duplicate N-wide cost column is accepted. Digest, compressor windows and
 * heuristic match candidates are not involved. */
int artifact_factor_index_project(
    const artifact_byte_view *bytes,
    const artifact_factor_index_workspace *workspace,
    artifact_factor_projection *out);

int artifact_factor_index_decode(
    const artifact_byte_view *bytes,
    const artifact_factor_index_workspace *workspace,
    pl_u8 *target, pl_u32 target_capacity);

#endif /* ARTIFACT_FACTOR_INDEX_H */
