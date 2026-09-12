/* Exact residual of a retained cell family against one total generator. */

#ifndef ARTIFACT_DERIVE_H
#define ARTIFACT_DERIVE_H

#include <artifact/share.h>

#define ARTIFACT_ERROR_DERIVE       (-77)
#define ARTIFACT_ERROR_DERIVE_RANGE (-78)

typedef struct {
    const pl_u8 *bytes;
    pl_u32 length;
} artifact_cell;

typedef struct {
    pl_u8 *support;
    pl_u32 support_bytes;
    pl_u32 *rank;
    pl_u32 *exception_coordinate;
    pl_u32 *representative_coordinate;
    artifact_complete_observation *observation;
    artifact_share_workspace share;
    pl_u32 capacity;
} artifact_derive_workspace;

typedef struct {
    pl_u32 coordinates;
    pl_u32 generated_cells;
    pl_u32 exception_cells;
    pl_u32 exception_classes;
    pl_u64 opened_bytes;
    pl_u64 retained_exception_bytes;
    pl_u64 removed_generated_bytes;
} artifact_derive_projection;

int artifact_derive_measure(pl_u32 coordinates, pl_u32 *support_bytes,
                            pl_u32 *share_digest_bytes,
                            pl_u32 *share_index_capacity);

/* `actual[i]` is retained iff it differs byte-for-byte from `generated[i]`.
 * Equal exceptions share one untyped value rank.  Thus the result rejects
 * both failure modes: storing a generated cell and dropping a real residual.
 * Support/ranks are construction output to the later finite-function encoder,
 * not an assertion that a dense bitmap or rank column should be published. */
int artifact_derive_project(
    const artifact_cell *actual, const artifact_cell *generated,
    pl_u32 coordinates, const artifact_derive_workspace *workspace,
    artifact_derive_projection *out);

/* Reopen one construction result.  A generated coordinate selects the total
 * generator; an exception selects its canonical representative. */
int artifact_derive_cell(
    const artifact_cell *actual, const artifact_cell *generated,
    pl_u32 coordinates, const artifact_derive_workspace *workspace,
    pl_u32 coordinate, artifact_cell *out);

#endif /* ARTIFACT_DERIVE_H */
