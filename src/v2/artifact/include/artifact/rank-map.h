/* Exact occurrence-to-rank function without a retained dense rank column. */

#ifndef ARTIFACT_RANK_MAP_H
#define ARTIFACT_RANK_MAP_H

#include <artifact/immutable.h>

#define ARTIFACT_ERROR_RANK_MAP       (-81)
#define ARTIFACT_ERROR_RANK_MAP_RANGE (-82)

typedef struct {
    pl_u32 *observation;
    pl_u32 observation_capacity;
    artifact_byte_residual_workspace residual;
} artifact_rank_map_workspace;

typedef struct {
    pl_u32 occurrences;
    pl_u32 classes;
    pl_u32 padded_coordinates;
    pl_u32 padding_class;
    artifact_byte_residual_projection residual;
} artifact_rank_map_projection;

int artifact_rank_map_measure(pl_u32 occurrences,
                              pl_u32 *padded_coordinates,
                              pl_u32 *scratch_bytes,
                              pl_u32 *node_capacity,
                              pl_u32 *level_capacity);

/* `rank` is a construction column.  The output is the unique minimum ordered
 * residual DAG for the complete fixed-width coordinate function.  Padding is
 * one distinct absent response, so it can neither merge with rank zero nor
 * make a real rank unreachable. */
int artifact_rank_map_project(
    const pl_u32 *rank, pl_u32 occurrences, pl_u32 classes,
    const artifact_rank_map_workspace *workspace,
    artifact_rank_map_projection *out);

int artifact_rank_map_lookup(
    const artifact_rank_map_workspace *workspace,
    const artifact_rank_map_projection *projection,
    pl_u32 occurrence, pl_u32 *rank);

#endif /* ARTIFACT_RANK_MAP_H */
