#include <artifact/rank-map.h>

#define U32_MAX_VALUE 0xffffffffu

static int padded_extent(pl_u32 occurrences, pl_u32 *out)
{
    if (!occurrences || !out) return 0;
    pl_u32 value = 1u;
    while (value < occurrences) {
        if (value > 0x40000000u) return 0;
        value <<= 1u;
    }
    *out = value;
    return 1;
}

int artifact_rank_map_measure(pl_u32 occurrences,
                              pl_u32 *padded_coordinates,
                              pl_u32 *scratch_bytes,
                              pl_u32 *node_capacity,
                              pl_u32 *level_capacity)
{
    pl_u32 padded = 0u;
    if (!padded_extent(occurrences, &padded) || !padded_coordinates)
        return ARTIFACT_ERROR_RANK_MAP_RANGE;
    int status = artifact_byte_residual_measure(
        padded, scratch_bytes, node_capacity, level_capacity);
    if (status) return status;
    *padded_coordinates = padded;
    return 0;
}

int artifact_rank_map_project(
    const pl_u32 *rank, pl_u32 occurrences, pl_u32 classes,
    const artifact_rank_map_workspace *workspace,
    artifact_rank_map_projection *out)
{
    pl_u32 padded = 0u, scratch = 0u, nodes = 0u, levels = 0u;
    if (!rank || !classes || classes > occurrences || classes == U32_MAX_VALUE
            || !workspace || !workspace->observation || !out
            || artifact_rank_map_measure(
                occurrences, &padded, &scratch, &nodes, &levels)
            || workspace->observation_capacity < padded)
        return ARTIFACT_ERROR_RANK_MAP_RANGE;
    pl_u8 *seen = workspace->residual.scratch;
    if (!seen || workspace->residual.scratch_bytes < classes)
        return ARTIFACT_ERROR_RANK_MAP_RANGE;
    for (pl_u32 value = 0u; value < classes; ++value) seen[value] = 0u;
    for (pl_u32 occurrence = 0u; occurrence < occurrences; ++occurrence) {
        if (rank[occurrence] >= classes)
            return ARTIFACT_ERROR_RANK_MAP_RANGE;
        workspace->observation[occurrence] = rank[occurrence];
        seen[rank[occurrence]] = 1u;
    }
    for (pl_u32 value = 0u; value < classes; ++value)
        if (!seen[value]) return ARTIFACT_ERROR_RANK_MAP;
    pl_u32 padding = padded == occurrences ? U32_MAX_VALUE : classes;
    for (pl_u32 coordinate = occurrences; coordinate < padded; ++coordinate)
        workspace->observation[coordinate] = padding;
    artifact_byte_function function = {
        padded, classes + (padding != U32_MAX_VALUE), workspace->observation,
    };
    artifact_byte_residual_projection residual = { 0 };
    int status = artifact_byte_residual_project(
        &function, &workspace->residual, &residual);
    if (status) return status;
    *out = (artifact_rank_map_projection){
        occurrences, classes, padded, padding, residual,
    };
    return 0;
}

int artifact_rank_map_lookup(
    const artifact_rank_map_workspace *workspace,
    const artifact_rank_map_projection *projection,
    pl_u32 occurrence, pl_u32 *rank)
{
    if (!workspace || !projection || occurrence >= projection->occurrences
            || !rank)
        return ARTIFACT_ERROR_RANK_MAP_RANGE;
    int status = artifact_byte_residual_lookup(
        &workspace->residual, &projection->residual, occurrence, rank);
    if (status) return status;
    return *rank < projection->classes ? 0 : ARTIFACT_ERROR_RANK_MAP;
}
