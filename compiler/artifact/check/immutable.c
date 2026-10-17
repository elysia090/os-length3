#include <artifact/immutable.h>

#include <stdio.h>
#include <stdlib.h>

int main(void)
{
    static const pl_u32 observation[] = {
        0u, 1u, 2u, 3u, 0u, 1u, 2u, 3u,
    };
    artifact_byte_function function = { 8u, 4u, observation };
    pl_u32 scratch_bytes = 0u, node_capacity = 0u, level_capacity = 0u;
    int status = artifact_byte_residual_measure(
        function.coordinates, &scratch_bytes,
        &node_capacity, &level_capacity);
    pl_u8 *scratch = status ? 0 : malloc(scratch_bytes);
    pl_u32 *children = status ? 0 : malloc(
        (size_t)node_capacity * 2u * sizeof(*children));
    pl_u32 *levels = status ? 0 : malloc(
        (size_t)level_capacity * sizeof(*levels));
    if (!status && (!scratch || !children || !levels))
        status = ARTIFACT_ERROR_IMMUTABLE_RANGE;
    artifact_byte_residual_workspace workspace = {
        scratch, scratch_bytes, children, children + node_capacity,
        node_capacity, levels, level_capacity,
    };
    artifact_byte_residual_projection projection = { 0 };
    if (!status)
        status = artifact_byte_residual_project(
            &function, &workspace, &projection);
    for (pl_u32 coordinate = 0u;
            !status && coordinate < function.coordinates; ++coordinate) {
        pl_u32 reopened = 0u;
        status = artifact_byte_residual_lookup(
            &workspace, &projection, coordinate, &reopened);
        if (!status && reopened != observation[coordinate])
            status = ARTIFACT_ERROR_IMMUTABLE;
    }
    if (status || projection.levels != 3u || projection.nodes != 4u
            || projection.opened_child_cells != 14u
            || projection.retained_child_cells != 8u) {
        fprintf(stderr,
                "immutable build residual: RED "
                "(status=%d levels=%u nodes=%u child-cells=%llu/%llu)\n",
                status, projection.levels, projection.nodes,
                (unsigned long long)projection.opened_child_cells,
                (unsigned long long)projection.retained_child_cells);
        free(levels);
        free(children);
        free(scratch);
        return 1;
    }
    printf("immutable build residual: green "
           "(8 coordinate leaves -> 4 complete residual nodes)\n");
    free(levels);
    free(children);
    free(scratch);
    return 0;
}
