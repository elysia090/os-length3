/* Minimum residual machine for a finite immutable byte-coordinate function. */

#ifndef ARTIFACT_IMMUTABLE_H
#define ARTIFACT_IMMUTABLE_H

#include <support/types.h>

#define ARTIFACT_ERROR_IMMUTABLE       (-1)
#define ARTIFACT_ERROR_IMMUTABLE_RANGE (-2)

typedef struct {
    pl_u32 coordinates;       /* A nonzero power of two. */
    pl_u32 observation_classes;
    const pl_u32 *observation;
} artifact_byte_function;

typedef struct {
    pl_u8 *scratch;
    pl_u32 scratch_bytes;
    pl_u32 *child_zero;
    pl_u32 *child_one;
    pl_u32 node_capacity;
    /* Entry zero is unused. level_offset[l] begins nodes consuming l bits. */
    pl_u32 *level_offset;
    pl_u32 level_capacity;
} artifact_byte_residual_workspace;

typedef struct {
    pl_u32 coordinates;
    pl_u32 observation_classes;
    pl_u32 levels;
    pl_u32 nodes;
    pl_u32 root_rank;
    pl_u64 opened_child_cells;
    pl_u64 retained_child_cells;
} artifact_byte_residual_projection;

/* Fixed-width request keys make every prefix residual finite.  Two nodes at
 * one level are equal exactly when both child residual ranks are equal.
 * Bottom-up exact interning therefore constructs the unique minimum ordered
 * response DAG, up to rank renaming, without first choosing file or page
 * identity.  A non-power-of-two domain is padded by the caller with one
 * distinct absent observation so the request function remains total. */
int artifact_byte_residual_measure(pl_u32 coordinates,
                                   pl_u32 *scratch_bytes,
                                   pl_u32 *node_capacity,
                                   pl_u32 *level_capacity);
int artifact_byte_residual_project(
    const artifact_byte_function *function,
    const artifact_byte_residual_workspace *workspace,
    artifact_byte_residual_projection *out);

/* Reopen one observation from the retained minimum residual DAG. */
int artifact_byte_residual_lookup(
    const artifact_byte_residual_workspace *workspace,
    const artifact_byte_residual_projection *projection,
    pl_u32 coordinate, pl_u32 *observation);

#endif /* ARTIFACT_IMMUTABLE_H */
