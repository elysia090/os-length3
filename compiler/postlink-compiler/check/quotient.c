/* Global cost-preserving complete-future quotient regressions.
 *
 * This boundary has one normal form: the minimum residual machine.  Storage
 * predictors and row encodings are deliberately absent; constant, affine,
 * run, and dictionary hypotheses must first become real instructions with
 * exact work/frontier/bytes before they can participate here.
 */

#include <stdio.h>
#include <stdlib.h>

#include "../src/internal/quotient.h"

static int weighted_complete_future(void)
{
    enum { STATES = 6, ARMS = 2 };
    static const pl_u32 observation[STATES] = {
        0u, 0u, 0u, 0u, 1u, 1u,
    };
    static const pl_u32 successor[STATES * ARMS] = {
        4u, 4u, 4u, 4u, 4u, 4u, 4u, 4u,
        4u, 4u, 5u, 5u,
    };
    static const pl_u64 work[STATES * ARMS] = {
        2u, 1u, 2u, 1u, 3u, 1u, 2u, 1u,
        0u, 0u, 0u, 0u,
    };
    static const pl_u32 frontier[STATES * ARMS] = {
        3u, 2u, 3u, 2u, 3u, 2u, 4u, 2u,
        0u, 0u, 0u, 0u,
    };
    pl_weighted_future_machine machine = {
        STATES, 2u, ARMS, 5u,
        observation, successor, work, frontier,
    };
    pl_u32 bytes = 0u;
    int status = pl_weighted_future_workspace_measure(
        STATES, ARMS, &bytes);
    pl_u8 *scratch = status ? 0 : malloc(bytes);
    pl_u32 state_class[STATES], order[STATES], immediate[STATES];
    pl_weighted_future_workspace workspace = {
        state_class, order, immediate, STATES, scratch, bytes,
    };
    pl_weighted_future_projection projection = { 0 };
    if (!status && !scratch) status = PL_ERROR_FUTURE_RANGE;
    if (!status)
        status = pl_weighted_future_project(
            &machine, &workspace, &projection);
    if (status || projection.immediate_classes != 4u
            || projection.future.classes != 4u
            || state_class[0] != state_class[1]
            || state_class[0] == state_class[2]
            || state_class[0] == state_class[3]
            || state_class[4] != state_class[5])
        status = PL_ERROR_FUTURE;
    free(scratch);
    return status;
}

static int weighted_observation_alias(void)
{
    enum { STATES = 4, ARMS = 2 };
    pl_u32 observation[STATES] = { 7u, 7u, 7u, 7u };
    static const pl_u32 successor[STATES * ARMS] = {
        0u, 0u, 1u, 1u, 2u, 2u, 3u, 3u,
    };
    static const pl_u64 work[STATES * ARMS] = {
        5u, 5u, 5u, 5u, 9u, 9u, 9u, 9u,
    };
    static const pl_u32 frontier[STATES * ARMS] = {
        2u, 2u, 2u, 2u, 2u, 2u, 2u, 2u,
    };
    pl_weighted_future_machine machine = {
        STATES, 8u, ARMS, 3u,
        observation, successor, work, frontier,
    };
    pl_u32 bytes = 0u;
    int status = pl_weighted_future_workspace_measure(
        STATES, ARMS, &bytes);
    pl_u8 *scratch = status ? 0 : malloc(bytes);
    pl_u32 state_class[STATES], order[STATES];
    pl_weighted_future_workspace workspace = {
        state_class, order, observation, STATES, scratch, bytes,
    };
    pl_weighted_future_projection projection = { 0 };
    if (!status && !scratch) status = PL_ERROR_FUTURE_RANGE;
    if (!status)
        status = pl_weighted_future_project(
            &machine, &workspace, &projection);
    /* The source observation column is replaced only after all tuple
     * comparisons, so 0/1 and 2/3 remain the two exact immediate classes. */
    if (!status && (projection.immediate_classes != 2u
            || observation[0] != observation[1]
            || observation[2] != observation[3]
            || observation[0] == observation[2]))
        status = PL_ERROR_FUTURE;
    free(scratch);
    return status;
}

static pl_u32 next_case(pl_u32 *state)
{
    *state = *state * 1664525u + 1013904223u;
    return *state;
}

static int weighted_complete_future_oracle(void)
{
    enum { MAX_STATES = 8, MAX_ARMS = 3, CASES = 20000 };
    pl_u32 observation[MAX_STATES];
    pl_u32 successor[MAX_STATES * MAX_ARMS];
    pl_u64 work[MAX_STATES * MAX_ARMS];
    pl_u32 frontier[MAX_STATES * MAX_ARMS];
    pl_u8 different[MAX_STATES * MAX_STATES];
    pl_u32 state_class[MAX_STATES], order[MAX_STATES];
    pl_u32 immediate[MAX_STATES];
    pl_u32 seed = 0x57465154u;

    for (pl_u32 trial = 0u; trial < CASES; ++trial) {
        pl_u32 states = 2u + next_case(&seed) % (MAX_STATES - 1u);
        pl_u32 arms = 1u + next_case(&seed) % MAX_ARMS;
        for (pl_u32 state = 0u; state < states; ++state)
            observation[state] = next_case(&seed) % 3u;
        for (pl_u32 at = 0u; at < states * arms; ++at) {
            successor[at] = next_case(&seed) % states;
            work[at] = next_case(&seed) % 4u;
            frontier[at] = next_case(&seed) % 4u;
        }

        for (pl_u32 left = 0u; left < states; ++left) {
            for (pl_u32 right = 0u; right < states; ++right) {
                int distinct = observation[left] != observation[right];
                for (pl_u32 arm = 0u; !distinct && arm < arms; ++arm) {
                    pl_u32 left_at = left * arms + arm;
                    pl_u32 right_at = right * arms + arm;
                    distinct = work[left_at] != work[right_at]
                            || frontier[left_at] != frontier[right_at];
                }
                different[left * states + right] = (pl_u8)distinct;
            }
        }
        int changed = 1;
        while (changed) {
            changed = 0;
            for (pl_u32 left = 0u; left < states; ++left) {
                for (pl_u32 right = left + 1u; right < states; ++right) {
                    if (different[left * states + right]) continue;
                    for (pl_u32 arm = 0u; arm < arms; ++arm) {
                        pl_u32 next_left = successor[left * arms + arm];
                        pl_u32 next_right = successor[right * arms + arm];
                        if (!different[next_left * states + next_right])
                            continue;
                        different[left * states + right] = 1u;
                        different[right * states + left] = 1u;
                        changed = 1;
                        break;
                    }
                }
            }
        }

        pl_weighted_future_machine machine = {
            states, 3u, arms, 4u,
            observation, successor, work, frontier,
        };
        pl_u32 scratch_bytes = 0u;
        int status = pl_weighted_future_workspace_measure(
            states, arms, &scratch_bytes);
        pl_u8 *scratch = status ? NULL : malloc(scratch_bytes);
        pl_weighted_future_workspace workspace = {
            state_class, order, immediate, MAX_STATES,
            scratch, scratch_bytes,
        };
        pl_weighted_future_projection projection = { 0 };
        if (!status && !scratch) status = PL_ERROR_FUTURE_RANGE;
        if (!status)
            status = pl_weighted_future_project(
                &machine, &workspace, &projection);
        for (pl_u32 left = 0u; !status && left < states; ++left)
            for (pl_u32 right = 0u; right < states; ++right)
                if ((state_class[left] == state_class[right])
                        == !!different[left * states + right])
                    status = PL_ERROR_FUTURE;
        free(scratch);
        if (status) {
            fprintf(stderr,
                    "global weighted quotient oracle: RED "
                    "(trial=%u states=%u arms=%u status=%d)\n",
                    trial, states, arms, status);
            return status;
        }
    }
    printf("global weighted quotient oracle: green (%u machines)\n",
           CASES);
    return 0;
}

int main(void)
{
    const char *stage = "weighted-future";
    int status = weighted_complete_future();
    if (!status) { stage = "weighted-alias"; status = weighted_observation_alias(); }
    if (!status) {
        stage = "weighted-oracle";
        status = weighted_complete_future_oracle();
    }
    if (status) {
        fprintf(stderr, "global weighted quotient: RED (%s: %d)\n",
                stage, status);
        return 1;
    }
    printf("global weighted quotient: green "
           "(one complete-future partition preserves observation, "
           "work, live frontier, and successor class)\n");
    return 0;
}
