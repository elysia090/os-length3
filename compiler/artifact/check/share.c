#include <artifact/share.h>

#include <stdio.h>
#include <stdlib.h>

#define BYTES(text) ((const pl_u8 *)(text)), ((pl_u32)(sizeof(text) - 1u))

static artifact_complete_observation read_generated(const void *context, pl_u32 index)
{
    const artifact_complete_observation *rows = context;
    return rows[index];
}

static int run_projection(const artifact_complete_observation *observation,
                          pl_u32 count, pl_u32 *rank,
                          artifact_share_projection *projection)
{
    pl_u32 digest_bytes = 0u, capacity = 0u;
    int status = artifact_share_measure(count, &digest_bytes, &capacity);
    pl_u8 *digest = status ? 0 : malloc(digest_bytes);
    pl_u32 *indices = status ? 0 : malloc(
        (size_t)capacity * 4u * sizeof(*indices));
    if (!status && (!digest || !indices)) status = ARTIFACT_ERROR_SHARE_RANGE;
    artifact_share_workspace workspace = {
        digest, digest_bytes,
        indices, indices + capacity, indices + capacity * 2u,
        indices + capacity * 3u, capacity,
    };
    if (!status)
        status = artifact_share_project(observation, count,
                                        &workspace, projection);
    if (!status)
        for (pl_u32 index = 0u; index < count; ++index)
            rank[index] = workspace.rank[index];
    free(indices);
    free(digest);
    return status;
}

int main(void)
{
    static const artifact_complete_observation observations[] = {
        { ARTIFACT_OBSERVATION_BLOCK, BYTES("x86-v2/state"),
          BYTES("output-A/fault-none/future-7") },
        { ARTIFACT_OBSERVATION_BLOCK, BYTES("x86-v2/state"),
          BYTES("output-A/fault-none/future-7") },
        { ARTIFACT_OBSERVATION_BLOCK, BYTES("x86-v2/state"),
          BYTES("output-B/fault-none/future-9") },
        { ARTIFACT_OBSERVATION_SLICE, BYTES("u8,u8"), BYTES("total-table") },
        { ARTIFACT_OBSERVATION_INSTRUCTION, BYTES("u8,u8"),
          BYTES("total-table") },
        { ARTIFACT_OBSERVATION_IMMUTABLE_READ, BYTES("offset,length"),
          BYTES("shared-rodata-factor") },
        { ARTIFACT_OBSERVATION_IMMUTABLE_READ, BYTES("offset,length"),
          BYTES("shared-rodata-factor") },
        { ARTIFACT_OBSERVATION_ARCHIVE_MEMBER, BYTES("read,symbol,bytes"),
          BYTES("payload-rank-41") },
        { ARTIFACT_OBSERVATION_DERIVED_CELL, BYTES("root,lengths,index"),
          BYTES("generated-coordinate-55") },
        { ARTIFACT_OBSERVATION_DERIVED_CELL, BYTES("root,lengths,index"),
          BYTES("generated-coordinate-55") },
    };
    enum { COUNT = sizeof(observations) / sizeof(observations[0]) };
    pl_u32 rank[COUNT];
    artifact_share_projection projection = { 0 };
    int status = run_projection(observations, COUNT, rank, &projection);
    if (!status && (projection.classes != 7u
            || rank[0] != rank[1] || rank[0] == rank[2]
            || rank[3] == rank[4] || rank[5] != rank[6]
            || rank[8] != rank[9]
            || projection.projected_rank_cells != COUNT))
        status = ARTIFACT_ERROR_SHARE;

    artifact_complete_observation reversed[COUNT];
    pl_u32 reversed_rank[COUNT];
    artifact_share_projection reversed_projection = { 0 };
    for (pl_u32 index = 0u; index < COUNT; ++index)
        reversed[index] = observations[COUNT - 1u - index];
    if (!status)
        status = run_projection(reversed, COUNT, reversed_rank,
                                &reversed_projection);
    for (pl_u32 index = 0u; !status && index < COUNT; ++index)
        if (rank[index] != reversed_rank[COUNT - 1u - index])
            status = ARTIFACT_ERROR_SHARE_RANK;

    /* Both directions of the iff are explicit publication reds. */
    pl_u32 digest_bytes = 0u, capacity = 0u;
    if (!status)
        status = artifact_share_measure(COUNT, &digest_bytes, &capacity);
    pl_u8 *digest = status ? 0 : malloc(digest_bytes);
    pl_u32 *indices = status ? 0 : malloc(
        (size_t)capacity * 4u * sizeof(*indices));
    artifact_share_workspace workspace = {
        digest, digest_bytes,
        indices, indices ? indices + capacity : 0,
        indices ? indices + capacity * 2u : 0,
        indices ? indices + capacity * 3u : 0, capacity,
    };
    pl_u32 bad[COUNT];
    for (pl_u32 index = 0u; index < COUNT; ++index) bad[index] = rank[index];
    if (!status) {
        bad[1] = rank[2];
        if (artifact_share_verify(observations, COUNT, bad,
                                  projection.classes, &workspace,
                                  &reversed_projection)
                != ARTIFACT_ERROR_SHARE_RANK)
            status = ARTIFACT_ERROR_SHARE;
    }
    for (pl_u32 index = 0u; index < COUNT; ++index) bad[index] = rank[index];
    if (!status) {
        bad[2] = rank[0];
        if (artifact_share_verify(observations, COUNT, bad,
                                  projection.classes, &workspace,
                                  &reversed_projection)
                != ARTIFACT_ERROR_SHARE_RANK)
            status = ARTIFACT_ERROR_SHARE;
    }
    /* A generated view has exactly the array's canonical spelling, including
     * rank naming, byte accounting and exact equality of duplicate rows. */
    artifact_observation_view view = { observations, read_generated };
    artifact_share_projection generated = { 0 };
    if (!status) status = artifact_share_project_view(&view, COUNT, &workspace, &generated);
    if (!status && (generated.classes != projection.classes
            || generated.opened_observation_bytes != projection.opened_observation_bytes
            || generated.retained_observation_bytes != projection.retained_observation_bytes))
        status = ARTIFACT_ERROR_SHARE;
    for (pl_u32 index = 0u; !status && index < COUNT; ++index)
        if (workspace.rank[index] != rank[index]) status = ARTIFACT_ERROR_SHARE_RANK;
    free(indices);
    free(digest);

    if (status) {
        fprintf(stderr, "artifact complete-sharing quotient: RED (%d)\n",
                status);
        return 1;
    }
    printf("artifact complete-sharing quotient: green "
           "(%u occurrences -> %u exact typed classes)\n",
           (unsigned)COUNT, projection.classes);
    return 0;
}
