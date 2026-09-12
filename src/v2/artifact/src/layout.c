#include <artifact/layout.h>

static int add_extent(pl_u64 *value, pl_u64 extent)
{
    if (!extent || *value > 0xffffffffffffffffull - extent)
        return ARTIFACT_ERROR_LAYOUT_RANGE;
    *value += extent;
    return 0;
}

int artifact_extent_total(const pl_u64 *extents, pl_u32 count,
                          pl_u64 *total)
{
    if (!extents || !count || !total) return ARTIFACT_ERROR_LAYOUT_RANGE;
    pl_u64 cursor = 0u;
    for (pl_u32 index = 0u; index < count; ++index) {
        int status = add_extent(&cursor, extents[index]);
        if (status) return status;
    }
    *total = cursor;
    return 0;
}

int artifact_extent_locate(const pl_u64 *extents, pl_u32 count, pl_u32 rank,
                           artifact_extent_coordinate *out)
{
    if (!extents || !count || rank >= count || !out)
        return ARTIFACT_ERROR_LAYOUT_RANGE;
    pl_u64 cursor = 0u;
    for (pl_u32 index = 0u; index < rank; ++index) {
        int status = add_extent(&cursor, extents[index]);
        if (status) return status;
    }
    pl_u64 last = cursor;
    int status = add_extent(&last, extents[rank]);
    if (status) return status;
    *out = (artifact_extent_coordinate){ cursor, last };
    return 0;
}

int artifact_extent_select(const pl_u64 *extents, pl_u32 count,
                           pl_u64 coordinate, pl_u32 *rank,
                           pl_u64 *within)
{
    if (!extents || !count || !rank || !within)
        return ARTIFACT_ERROR_LAYOUT_RANGE;
    pl_u64 cursor = 0u;
    for (pl_u32 index = 0u; index < count; ++index) {
        pl_u64 last = cursor;
        int status = add_extent(&last, extents[index]);
        if (status) return status;
        if (coordinate < last) {
            *rank = index;
            *within = coordinate - cursor;
            return 0;
        }
        cursor = last;
    }
    return ARTIFACT_ERROR_LAYOUT_RANGE;
}
