/* Coordinates generated from canonical extent ranks, never stored endpoints. */

#ifndef ARTIFACT_LAYOUT_H
#define ARTIFACT_LAYOUT_H

#include <support/types.h>

#define ARTIFACT_ERROR_LAYOUT       (-68)
#define ARTIFACT_ERROR_LAYOUT_RANGE (-69)

typedef struct {
    pl_u64 first;
    pl_u64 last;
} artifact_extent_coordinate;

/* `extents` is the irreducible canonical-rank column.  Prefix endpoints,
 * object offsets and total extent are total functions of it and therefore do
 * not have a serialized column.  A reader may cache opened prefixes, but a
 * publisher must be able to drop that cache and reproduce the same answer. */
int artifact_extent_total(const pl_u64 *extents, pl_u32 count,
                          pl_u64 *total);
int artifact_extent_locate(const pl_u64 *extents, pl_u32 count, pl_u32 rank,
                           artifact_extent_coordinate *out);
int artifact_extent_select(const pl_u64 *extents, pl_u32 count,
                           pl_u64 coordinate, pl_u32 *rank,
                           pl_u64 *within);

#endif /* ARTIFACT_LAYOUT_H */
