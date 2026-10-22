/* Exact shortest prior-factor parse for the canonical immutable byte word. */

#ifndef ARTIFACT_FACTOR_H
#define ARTIFACT_FACTOR_H

#include <support/types.h>

#define ARTIFACT_ERROR_FACTOR       (-72)
#define ARTIFACT_ERROR_FACTOR_RANGE (-73)

typedef struct {
    pl_u64 *suffix_bits;
    pl_u32 suffix_capacity;
    pl_u32 *source;
    pl_u32 *length;
    pl_u32 choice_capacity;
    pl_u32 *z;
    pl_u32 z_capacity;
} artifact_factor_workspace;

typedef struct {
    pl_u32 bytes;
    pl_u32 coordinate_bits;
    pl_u32 tokens;
    pl_u32 literal_tokens;
    pl_u32 reference_tokens;
    pl_u64 literal_bytes;
    pl_u64 referenced_bytes;
    pl_u64 opened_literal_bits;
    pl_u64 retained_bits;
    pl_u64 unresolved_bit_gap;
} artifact_factor_projection;

int artifact_factor_measure(pl_u32 bytes, pl_u32 *suffix_capacity,
                            pl_u32 *choice_capacity, pl_u32 *z_capacity);

/* The fixed grammar is:
 *
 *   literal   = 0 || byte8
 *   reference = 1 || length[W] || prior_coordinate[W]
 *   W         = ceil(log2(bytes + 1)).
 *
 * A reference may overlap its output, as in LZ77, but its source coordinate
 * is strictly smaller than the destination.  The dynamic program enumerates
 * every valid prior substring and returns the globally shortest token word in
 * this grammar.  Equal costs use literal before reference, then length and
 * source numeric order, which gives one spelling.  This routine is the exact
 * bounded oracle for faster suffix-index publishers; it reports no heuristic
 * saving and no unresolved gap. */
int artifact_factor_exact_project(const pl_u8 *bytes, pl_u32 byte_count,
                                  const artifact_factor_workspace *workspace,
                                  artifact_factor_projection *out);

/* Decode the selected token word.  `target` may not alias `bytes`. */
int artifact_factor_decode(const pl_u8 *bytes, pl_u32 byte_count,
                           const artifact_factor_workspace *workspace,
                           pl_u8 *target, pl_u32 target_capacity);

#endif /* ARTIFACT_FACTOR_H */
