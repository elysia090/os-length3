#include <artifact/derive.h>

#include <stdio.h>
#include <stdlib.h>

#define CELL(text) { (const pl_u8 *)(text), (pl_u32)(sizeof(text) - 1u) }

static int equal_cell(artifact_cell left, artifact_cell right)
{
    if (left.length != right.length) return 0;
    for (pl_u32 index = 0u; index < left.length; ++index)
        if (left.bytes[index] != right.bytes[index]) return 0;
    return 1;
}

int main(void)
{
    static const artifact_cell actual[] = {
        CELL("proof(source,optimized)"),
        CELL("offset[17]=4096"),
        CELL("directory(alpha)=rank-3"),
        CELL("exception-A"),
        CELL("exception-A"),
        CELL("exception-B"),
    };
    static const artifact_cell generated[] = {
        CELL("proof(source,optimized)"),
        CELL("offset[17]=4096"),
        CELL("directory(alpha)=rank-3"),
        CELL("wrong-A"),
        CELL("wrong-A"),
        CELL("wrong-B"),
    };
    enum { COUNT = sizeof(actual) / sizeof(actual[0]) };
    pl_u32 support_bytes = 0u, digest_bytes = 0u, capacity = 0u;
    int status = artifact_derive_measure(
        COUNT, &support_bytes, &digest_bytes, &capacity);
    pl_u8 *support = status ? 0 : malloc(support_bytes);
    pl_u8 *digest = status ? 0 : malloc(digest_bytes);
    pl_u32 *indices = status ? 0 : malloc(
        (size_t)capacity * 7u * sizeof(*indices));
    artifact_complete_observation *observation = status ? 0 : malloc(
        (size_t)capacity * sizeof(*observation));
    artifact_derive_workspace workspace = {
        support, support_bytes,
        indices,
        indices ? indices + capacity : 0,
        indices ? indices + capacity * 2u : 0,
        observation,
        { digest, digest_bytes,
          indices ? indices + capacity * 3u : 0,
          indices ? indices + capacity * 4u : 0,
          indices ? indices + capacity * 5u : 0,
          indices ? indices + capacity * 6u : 0,
          capacity },
        capacity,
    };
    artifact_derive_projection projection = { 0 };
    if (!status && (!support || !digest || !indices || !observation))
        status = ARTIFACT_ERROR_DERIVE_RANGE;
    if (!status)
        status = artifact_derive_project(
            actual, generated, COUNT, &workspace, &projection);
    for (pl_u32 coordinate = 0u; !status && coordinate < COUNT;
            ++coordinate) {
        artifact_cell reopened = { 0 };
        status = artifact_derive_cell(
            actual, generated, COUNT, &workspace,
            coordinate, &reopened);
        if (!status && !equal_cell(reopened, actual[coordinate]))
            status = ARTIFACT_ERROR_DERIVE;
    }
    if (!status && (projection.generated_cells != 3u
            || projection.exception_cells != 3u
            || projection.exception_classes != 2u
            || workspace.rank[3] != workspace.rank[4]
            || workspace.rank[3] == workspace.rank[5]))
        status = ARTIFACT_ERROR_DERIVE;

    if (status) {
        fprintf(stderr, "derived cells: RED (%d)\n", status);
    } else {
        printf("derived cells: green "
               "(%u coordinates -> %u generated + %u exceptions / "
               "%u shared values)\n",
               (unsigned)COUNT, projection.generated_cells,
               projection.exception_cells, projection.exception_classes);
    }
    free(observation);
    free(indices);
    free(digest);
    free(support);
    return status ? 1 : 0;
}
