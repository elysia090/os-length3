#include <artifact/future.h>

#include <stdio.h>
#include <stdlib.h>

#define OBS(TEXT) { \
    ARTIFACT_OBSERVATION_BLOCK, \
    (const pl_u8 *)"cpu-v2/event-arm", 16u, \
    (const pl_u8 *)(TEXT), (pl_u32)(sizeof(TEXT) - 1u) \
}

typedef struct {
    artifact_future_workspace value;
    pl_u8 *digest;
    pl_u32 *order;
    pl_u32 *temporary;
    pl_u32 *immediate_rank;
    pl_u32 *representative;
    pl_u32 *future_rank;
    pl_u8 *future_scratch;
} owned_workspace;

static void release(owned_workspace *workspace)
{
    free(workspace->future_scratch);
    free(workspace->future_rank);
    free(workspace->representative);
    free(workspace->immediate_rank);
    free(workspace->temporary);
    free(workspace->order);
    free(workspace->digest);
}

static int allocate(pl_u32 states, pl_u32 arms, owned_workspace *workspace)
{
    pl_u32 digest_bytes = 0u, capacity = 0u, future_bytes = 0u;
    int status = artifact_share_measure(
        states, &digest_bytes, &capacity);
    if (!status)
        status = pl_finite_future_workspace_measure(
            states, arms, &future_bytes);
    if (status) return status;
    workspace->digest = malloc(digest_bytes);
    workspace->order = malloc((size_t)capacity * sizeof(pl_u32));
    workspace->temporary = malloc((size_t)capacity * sizeof(pl_u32));
    workspace->immediate_rank = malloc(
        (size_t)capacity * sizeof(pl_u32));
    workspace->representative = malloc(
        (size_t)capacity * sizeof(pl_u32));
    workspace->future_rank = malloc((size_t)states * sizeof(pl_u32));
    workspace->future_scratch = malloc(future_bytes);
    if (!workspace->digest || !workspace->order || !workspace->temporary
            || !workspace->immediate_rank || !workspace->representative
            || !workspace->future_rank || !workspace->future_scratch) {
        release(workspace);
        return ARTIFACT_ERROR_FUTURE_RANGE;
    }
    workspace->value.immediate = (artifact_share_workspace){
        workspace->digest, digest_bytes,
        workspace->order, workspace->temporary,
        workspace->immediate_rank, workspace->representative, capacity,
    };
    workspace->value.future = (pl_finite_future_workspace){
        workspace->future_rank, states,
        workspace->future_scratch, future_bytes,
    };
    return 0;
}

static int project(const pl_u32 *successor, pl_u32 expected_classes,
                   int expect_images_equal)
{
    static const artifact_complete_observation observation[] = {
        OBS("write-r0;continue"), OBS("write-r1;continue"),
        OBS("write-r0;continue"), OBS("write-r0;continue"),
        OBS("write-r1;continue"), OBS("write-r0;continue"),
    };
    artifact_future_population population = {
        observation, successor, 6u, 2u,
    };
    owned_workspace workspace = { 0 };
    int status = allocate(population.states, population.arms, &workspace);
    artifact_future_projection projection = { 0 };
    if (!status)
        status = artifact_future_project(
            &population, &workspace.value, &projection);
    int images_equal = workspace.future_rank
        && workspace.future_rank[0] == workspace.future_rank[3]
        && workspace.future_rank[1] == workspace.future_rank[4]
        && workspace.future_rank[2] == workspace.future_rank[5];
    if (!status && (projection.immediate.classes != 2u
            || projection.future.classes != expected_classes
            || projection.future.checked_transitions != 12u
            || images_equal != expect_images_equal
            || projection.shared_state_occurrences
                != 6u - expected_classes))
        status = ARTIFACT_ERROR_FUTURE;
    release(&workspace);
    return status;
}

int main(void)
{
    static const pl_u32 equal_images[] = {
        1u, 2u, 1u, 2u, 2u, 2u,
        4u, 5u, 4u, 5u, 5u, 5u,
    };
    pl_u32 distinguished_images[12];
    for (pl_u32 index = 0u; index < 12u; ++index)
        distinguished_images[index] = equal_images[index];
    distinguished_images[8] = 3u;

    int status = project(equal_images, 3u, 1);
    if (!status) status = project(distinguished_images, 5u, 0);
    if (status) {
        fprintf(stderr, "release block future: RED (%d)\n", status);
        return 1;
    }
    printf("release block future: green "
           "(two ELF-local state graphs -> one exact future quotient)\n");
    return 0;
}
