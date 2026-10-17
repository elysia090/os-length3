#include <artifact/executable.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Empty state spans have no payload. Capacity must count only the actual
 * nonempty spans and image gaps, never every semantic state. */
enum { IMAGES = 2u, STATES = 6u, CAPACITY = 8u };

int main(void)
{
    static const pl_u8 first[] = "ELF!abcXYZproof";
    static const pl_u8 second[] = "ELF!abcXYZprooF";
    static const artifact_cell images[] = {
        { first, sizeof(first) - 1u }, { second, sizeof(second) - 1u },
    };
    artifact_cell emitted[] = {
        { first + 4u, 3u }, { 0, 0u }, { first + 7u, 3u },
        { second + 4u, 3u }, { 0, 0u }, { second + 7u, 3u },
    };
    pl_u64 file_offset[] = { 4u, 7u, 7u, 4u, 7u, 7u };
    static const pl_u32 state_offset[] = { 0u, 3u, 6u };
    artifact_executable_population population = {
        images, state_offset, emitted, file_offset, IMAGES, STATES,
    };

    artifact_payload fragments[CAPACITY];
    pl_u32 image_fragment_offset[IMAGES + 1u];
    artifact_complete_observation observation[CAPACITY];
    pl_u8 digest[CAPACITY * PL_SHA256_BYTES];
    pl_u32 vector[CAPACITY * 4u];
    artifact_executable_workspace workspace = {
        fragments, CAPACITY,
        image_fragment_offset, IMAGES + 1u,
        {
            observation, CAPACITY,
            { digest, sizeof(digest),
              vector, vector + CAPACITY, vector + CAPACITY * 2u,
              vector + CAPACITY * 3u, CAPACITY },
        },
    };
    artifact_executable_projection projection = { 0 };
    pl_u32 measured = 0u;
    int status = artifact_executable_measure(&population, &measured);
    if (!status && measured != CAPACITY) status = ARTIFACT_ERROR_EXECUTABLE;
    if (!status)
        status = artifact_executable_project(&population, &workspace, &projection);
    if (!status && (projection.images != IMAGES
            || projection.states != STATES
            || projection.nonempty_emitted_states != 4u
            || projection.generated_file_coordinates != STATES
            || projection.fragment_occurrences != 8u
            || projection.fragment.classes != 5u
            || projection.opened_image_bytes != 30u
            || projection.emitted_bytes != 12u
            || projection.gap_bytes != 18u
            || projection.reconstructed_bytes != 30u))
        status = ARTIFACT_ERROR_EXECUTABLE;

    /* A claimed emitted span must be the actual final ELF interval. */
    emitted[3] = (artifact_cell){ (const pl_u8 *)"abd", 3u };
    if (!status && artifact_executable_project(
            &population, &workspace, &projection)
            != ARTIFACT_ERROR_EXECUTABLE)
        status = ARTIFACT_ERROR_EXECUTABLE;
    emitted[3] = (artifact_cell){ second + 4u, 3u };

    /* Coordinates are generated prefix sums; a retained gap is red. */
    file_offset[4] = 8u;
    if (!status && artifact_executable_project(
            &population, &workspace, &projection)
            != ARTIFACT_ERROR_EXECUTABLE)
        status = ARTIFACT_ERROR_EXECUTABLE;

    /* A large sparse semantic population still has one actual payload. Every
     * empty state's coordinate remains checked, including the final state. */
    enum { SPARSE_STATES = 65536u };
    artifact_cell *sparse_emitted = calloc(SPARSE_STATES, sizeof(*sparse_emitted));
    pl_u64 *sparse_offset = malloc(SPARSE_STATES * sizeof(*sparse_offset));
    if (!sparse_emitted || !sparse_offset) status = ARTIFACT_ERROR_EXECUTABLE_RANGE;
    if (!status) {
        sparse_emitted[0] = images[0];
        sparse_offset[0] = 0u;
        for (pl_u32 state = 1u; state < SPARSE_STATES; ++state)
            sparse_offset[state] = images[0].length;
        const pl_u32 ends[] = { 0u, SPARSE_STATES };
        artifact_executable_population sparse = {
            images, ends, sparse_emitted, sparse_offset, 1u, SPARSE_STATES,
        };
        workspace.fragment_capacity = 1u;
        status = artifact_executable_measure(&sparse, &measured);
        if (!status && measured != 1u) status = ARTIFACT_ERROR_EXECUTABLE;
        if (!status) status = artifact_executable_project(&sparse, &workspace, &projection);
        if (!status && (projection.fragment_occurrences != 1u
                || projection.generated_file_coordinates != SPARSE_STATES
                || projection.reconstructed_bytes != images[0].length))
            status = ARTIFACT_ERROR_EXECUTABLE;
        sparse_offset[SPARSE_STATES - 1u] = 0u;
        if (!status && artifact_executable_project(&sparse, &workspace, &projection)
                != ARTIFACT_ERROR_EXECUTABLE)
            status = ARTIFACT_ERROR_EXECUTABLE;
    }
    free(sparse_offset);
    free(sparse_emitted);

    if (status) {
        fprintf(stderr, "optimized ELF fragment sharing: RED (%d)\n", status);
        return 1;
    }
    printf("optimized ELF fragment sharing: green "
           "(2 images/6 states -> 5 payload owners; all coordinates generated)\n");
    return 0;
}
