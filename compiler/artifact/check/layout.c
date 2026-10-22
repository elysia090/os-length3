#include <artifact/layout.h>

#include <stdio.h>

int main(void)
{
    static const pl_u64 extents[] = { 3u, 5u, 2u, 9u };
    pl_u64 total = 0u;
    artifact_extent_coordinate interval = { 0u, 0u };
    pl_u32 rank = 0u;
    pl_u64 within = 0u;
    int status = artifact_extent_total(extents, 4u, &total);
    if (!status) status = artifact_extent_locate(extents, 4u, 2u, &interval);
    if (!status) status = artifact_extent_select(
        extents, 4u, 13u, &rank, &within);
    if (!status && (total != 19u || interval.first != 8u
            || interval.last != 10u || rank != 3u || within != 3u))
        status = ARTIFACT_ERROR_LAYOUT;
    if (!status && artifact_extent_select(
            extents, 4u, 19u, &rank, &within)
            != ARTIFACT_ERROR_LAYOUT_RANGE)
        status = ARTIFACT_ERROR_LAYOUT;
    if (!status) {
        static const pl_u64 overflow[] = {
            0xffffffffffffffffull, 1u,
        };
        if (artifact_extent_total(overflow, 2u, &total)
                != ARTIFACT_ERROR_LAYOUT_RANGE)
            status = ARTIFACT_ERROR_LAYOUT;
    }
    if (status) {
        fprintf(stderr, "artifact generated coordinates: RED (%d)\n", status);
        return 1;
    }
    printf("artifact generated coordinates: green "
           "(4 extents, 0 retained prefix/end cells)\n");
    return 0;
}
