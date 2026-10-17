#include <artifact/rank-map.h>

#include <stdio.h>
#include <stdlib.h>

int main(void)
{
    static const pl_u32 ranks[] = { 0u, 1u, 2u, 3u, 0u, 1u, 2u };
    enum { COUNT = sizeof(ranks) / sizeof(ranks[0]) };
    pl_u32 padded = 0u, scratch_bytes = 0u;
    pl_u32 node_capacity = 0u, level_capacity = 0u;
    int status = artifact_rank_map_measure(
        COUNT, &padded, &scratch_bytes, &node_capacity, &level_capacity);
    pl_u32 *observation = status ? 0 : malloc(
        (size_t)padded * sizeof(*observation));
    pl_u8 *scratch = status ? 0 : malloc(scratch_bytes);
    pl_u32 *children = status ? 0 : malloc(
        (size_t)node_capacity * 2u * sizeof(*children));
    pl_u32 *levels = status ? 0 : malloc(
        (size_t)level_capacity * sizeof(*levels));
    artifact_rank_map_workspace workspace = {
        observation, padded,
        { scratch, scratch_bytes, children,
          children ? children + node_capacity : 0,
          node_capacity, levels, level_capacity },
    };
    artifact_rank_map_projection projection = { 0 };
    if (!status && (!observation || !scratch || !children || !levels))
        status = ARTIFACT_ERROR_RANK_MAP_RANGE;
    if (!status)
        status = artifact_rank_map_project(
            ranks, COUNT, 4u, &workspace, &projection);
    for (pl_u32 coordinate = 0u; !status && coordinate < COUNT;
            ++coordinate) {
        pl_u32 reopened = 0u;
        status = artifact_rank_map_lookup(
            &workspace, &projection, coordinate, &reopened);
        if (!status && reopened != ranks[coordinate])
            status = ARTIFACT_ERROR_RANK_MAP;
    }
    if (!status && (projection.padded_coordinates != 8u
            || projection.padding_class != 4u
            || projection.residual.observation_classes != 5u
            || projection.residual.opened_child_cells != 14u
            || projection.residual.retained_child_cells >= 14u))
        status = ARTIFACT_ERROR_RANK_MAP;
    if (status) {
        fprintf(stderr, "rank-map residual: RED (%d)\n", status);
    } else {
        printf("rank-map residual: green "
               "(%u occurrences, dense rank column removed, "
               "%llu/%llu child cells retained)\n",
               (unsigned)COUNT,
               (unsigned long long)projection.residual.retained_child_cells,
               (unsigned long long)projection.residual.opened_child_cells);
    }
    free(levels);
    free(children);
    free(scratch);
    free(observation);
    return status ? 1 : 0;
}
