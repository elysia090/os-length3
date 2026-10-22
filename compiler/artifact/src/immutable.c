#include <artifact/immutable.h>

#include <support/arena.h>

typedef struct {
    pl_u64 key;
    pl_u32 coordinate;
    pl_u32 reserved;
} residual_row;

static int power_of_two(pl_u32 value)
{
    return value && !(value & (value - 1u));
}

static int add_workspace(pl_u64 *total, pl_u64 bytes)
{
    if (!total || *total > 0xfffffffffffffff8ull) return 0;
    pl_u64 aligned = (*total + 7u) & ~7ull;
    if (bytes > 0xffffffffull || aligned > 0xffffffffull - bytes)
        return 0;
    *total = aligned + bytes;
    return 1;
}

int artifact_byte_residual_measure(pl_u32 coordinates,
                                   pl_u32 *scratch_bytes,
                                   pl_u32 *node_capacity,
                                   pl_u32 *level_capacity)
{
    if (!power_of_two(coordinates) || !scratch_bytes || !node_capacity
            || !level_capacity)
        return ARTIFACT_ERROR_IMMUTABLE_RANGE;
    pl_u32 levels = 0u;
    for (pl_u32 value = coordinates; value > 1u; value >>= 1u)
        ++levels;
    pl_u64 pairs = coordinates >> 1u;
    pl_u64 total = 0u;
    if (!add_workspace(&total, (pl_u64)coordinates * sizeof(pl_u32))
            || !add_workspace(
                &total, pairs * (pl_u64)sizeof(residual_row))
            || !add_workspace(
                &total, pairs * (pl_u64)sizeof(residual_row))
            || !add_workspace(&total, coordinates))
        return ARTIFACT_ERROR_IMMUTABLE_RANGE;
    *scratch_bytes = (pl_u32)total;
    *node_capacity = coordinates - 1u;
    *level_capacity = levels + 1u;
    return 0;
}

static void radix_rows(residual_row *rows, residual_row *temporary,
                       pl_u32 count)
{
    residual_row *source = rows;
    residual_row *target = temporary;
    for (pl_u32 pass = 0u; pass < 8u; ++pass) {
        pl_u32 bins[256] = { 0 };
        pl_u32 shift = pass * 8u;
        for (pl_u32 index = 0u; index < count; ++index)
            ++bins[(pl_u8)(source[index].key >> shift)];
        pl_u32 offset = 0u;
        for (pl_u32 byte = 0u; byte < 256u; ++byte) {
            pl_u32 size = bins[byte];
            bins[byte] = offset;
            offset += size;
        }
        for (pl_u32 index = 0u; index < count; ++index) {
            pl_u8 byte = (pl_u8)(source[index].key >> shift);
            target[bins[byte]++] = source[index];
        }
        residual_row *swap = source;
        source = target;
        target = swap;
    }
    /* Eight byte passes leave the sorted rows in the original array. */
}

int artifact_byte_residual_project(
    const artifact_byte_function *function,
    const artifact_byte_residual_workspace *workspace,
    artifact_byte_residual_projection *out)
{
    if (!function || !workspace || !out
            || !power_of_two(function->coordinates)
            || !function->observation_classes
            || function->observation_classes > function->coordinates
            || !function->observation || !workspace->scratch
            || !workspace->child_zero || !workspace->child_one
            || !workspace->level_offset)
        return ARTIFACT_ERROR_IMMUTABLE_RANGE;
    pl_u32 required = 0u, node_capacity = 0u, level_capacity = 0u;
    int status = artifact_byte_residual_measure(
        function->coordinates, &required,
        &node_capacity, &level_capacity);
    if (status || workspace->scratch_bytes < required
            || workspace->node_capacity < node_capacity
            || workspace->level_capacity < level_capacity)
        return ARTIFACT_ERROR_IMMUTABLE_RANGE;

    pl_arena arena = {
        workspace->scratch, workspace->scratch_bytes, 0u,
    };
    pl_u32 *rank = pl_arena_take(
        &arena, function->coordinates * (pl_u32)sizeof(pl_u32));
    pl_u32 maximum_pairs = function->coordinates >> 1u;
    residual_row *rows = pl_arena_take(
        &arena, maximum_pairs * (pl_u32)sizeof(residual_row));
    residual_row *temporary = pl_arena_take(
        &arena, maximum_pairs * (pl_u32)sizeof(residual_row));
    pl_u8 *seen = pl_arena_take(&arena, function->coordinates);
    if (!rank || (maximum_pairs && (!rows || !temporary)) || !seen)
        return ARTIFACT_ERROR_IMMUTABLE_RANGE;

    for (pl_u32 index = 0u; index < function->coordinates; ++index)
        seen[index] = 0u;
    for (pl_u32 coordinate = 0u;
            coordinate < function->coordinates; ++coordinate) {
        pl_u32 observation = function->observation[coordinate];
        if (observation >= function->observation_classes)
            return ARTIFACT_ERROR_IMMUTABLE_RANGE;
        rank[coordinate] = observation;
        seen[observation] = 1u;
    }
    for (pl_u32 observation = 0u;
            observation < function->observation_classes; ++observation)
        if (!seen[observation]) return ARTIFACT_ERROR_IMMUTABLE_RANGE;

    pl_u32 levels = 0u;
    for (pl_u32 value = function->coordinates; value > 1u; value >>= 1u)
        ++levels;
    workspace->level_offset[0] = 0u;
    pl_u32 nodes = 0u;
    pl_u32 width = function->coordinates;
    for (pl_u32 level = 1u; level <= levels; ++level) {
        pl_u32 pairs = width >> 1u;
        for (pl_u32 pair = 0u; pair < pairs; ++pair) {
            rows[pair].key = (pl_u64)rank[pair * 2u] << 32u
                           | rank[pair * 2u + 1u];
            rows[pair].coordinate = pair;
            rows[pair].reserved = 0u;
        }
        radix_rows(rows, temporary, pairs);
        workspace->level_offset[level] = nodes;
        pl_u32 classes = 0u;
        pl_u64 previous = 0u;
        for (pl_u32 at = 0u; at < pairs; ++at) {
            pl_u64 key = rows[at].key;
            if (!classes || key != previous) {
                if (nodes + classes >= workspace->node_capacity)
                    return ARTIFACT_ERROR_IMMUTABLE_RANGE;
                workspace->child_zero[nodes + classes] =
                    (pl_u32)(key >> 32u);
                workspace->child_one[nodes + classes] = (pl_u32)key;
                previous = key;
                ++classes;
            }
            rank[rows[at].coordinate] = classes - 1u;
        }
        nodes += classes;
        width = pairs;
    }
    if (width != 1u) return ARTIFACT_ERROR_IMMUTABLE;
    *out = (artifact_byte_residual_projection){
        .coordinates = function->coordinates,
        .observation_classes = function->observation_classes,
        .levels = levels,
        .nodes = nodes,
        .root_rank = rank[0],
        .opened_child_cells =
            2u * ((pl_u64)function->coordinates - 1u),
        .retained_child_cells = 2u * (pl_u64)nodes,
    };
    return 0;
}

int artifact_byte_residual_lookup(
    const artifact_byte_residual_workspace *workspace,
    const artifact_byte_residual_projection *projection,
    pl_u32 coordinate, pl_u32 *observation)
{
    if (!workspace || !projection || !observation
            || !projection->coordinates
            || coordinate >= projection->coordinates
            || !workspace->child_zero || !workspace->child_one
            || !workspace->level_offset
            || workspace->node_capacity < projection->nodes
            || workspace->level_capacity <= projection->levels)
        return ARTIFACT_ERROR_IMMUTABLE_RANGE;
    pl_u32 rank = projection->root_rank;
    for (pl_u32 level = projection->levels; level; --level) {
        pl_u32 offset = workspace->level_offset[level];
        pl_u32 end = level == projection->levels
                   ? projection->nodes
                   : workspace->level_offset[level + 1u];
        if (offset > end || end > projection->nodes
                || rank >= end - offset)
            return ARTIFACT_ERROR_IMMUTABLE;
        pl_u32 node = offset + rank;
        rank = coordinate & (1u << (level - 1u))
             ? workspace->child_one[node]
             : workspace->child_zero[node];
    }
    if (rank >= projection->observation_classes)
        return ARTIFACT_ERROR_IMMUTABLE;
    *observation = rank;
    return 0;
}
