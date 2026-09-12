#include <support/future.h>

#include <stdio.h>
#include <stdlib.h>

static int project(const pl_u32 *successor, pl_u32 expected_classes,
                   int expect_images_equal)
{
    /* States 0..2 and 3..5 are two separately linked images with identical
     * observations and control futures.  A global quotient must not preserve
     * their image-local state names. */
    static const pl_u32 observation[] = { 0u, 1u, 0u, 0u, 1u, 0u };
    pl_finite_future_machine machine = {
        6u, 2u, 2u, observation, successor,
    };
    pl_u32 scratch_bytes = 0u;
    int status = pl_finite_future_workspace_measure(
        machine.states, machine.arms, &scratch_bytes);
    pl_u32 state_class[6] = { 0u };
    pl_u8 *scratch = status ? 0 : malloc(scratch_bytes);
    pl_finite_future_workspace workspace = {
        state_class, 6u, scratch, scratch_bytes,
    };
    pl_finite_future_projection projection = { 0 };
    if (!status && !scratch) status = PL_ERROR_FUTURE_RANGE;
    if (!status)
        status = pl_finite_future_project(
            &machine, &workspace, &projection);
    int images_equal = state_class[0] == state_class[3]
                    && state_class[1] == state_class[4]
                    && state_class[2] == state_class[5];
    if (!status && (projection.classes != expected_classes
            || projection.checked_transitions != 12u
            || images_equal != expect_images_equal))
        status = PL_ERROR_FUTURE;
    free(scratch);
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
    /* Change one arm in the second image.  Its corresponding source state
     * must no longer share a complete future with the first image. */
    distinguished_images[8] = 3u;

    int status = project(equal_images, 3u, 1);
    /* The changed observation-1 state also distinguishes its predecessor, so
     * the one semantic change produces two additional future classes. */
    if (!status) status = project(distinguished_images, 5u, 0);
    if (status) {
        fprintf(stderr, "global complete-future quotient: RED (%d)\n",
                status);
        return 1;
    }
    printf("global complete-future quotient: green "
           "(two image-local machines -> one 3-state future)\n");
    return 0;
}
