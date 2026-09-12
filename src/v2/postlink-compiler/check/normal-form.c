/* A build-visible program future, not its source instruction count, is the
 * executable identity.  These two ordinary x86 bodies differ only by an
 * internal NOP and therefore must receive one normalized transfer rank. */

#include <stdio.h>
#include <stdlib.h>

#include "../src/internal/block.h"
#include "../src/internal/quotient.h"

#define ARENA_BYTES (64u * 1024u)

static int minimum_work_membership(void)
{
    pl_u32 bytes = 0u;
    int status = pl_finite_future_workspace_measure(1024u, 2u, &bytes);
    /* Six minimally-wide state vectors, one affected-class run, two
     * inverse-offset rows, minimally-wide inverse-state and work runs, and
     * exactly one bit per (state,arm) queue-membership fact. */
    return status || bytes != 42248u ? PL_ERROR_FUTURE : 0;
}

static int instruction_history(void)
{
    static const pl_u8 source[] = {
        0xb8u, 0x2au, 0x00u, 0x00u, 0x00u, 0x90u, 0xc3u,
        0xc7u, 0xc0u, 0x2au, 0x00u, 0x00u, 0x00u, 0xc3u,
    };
    pl_x86_map map = {
        source, 0x1000u, sizeof source, sizeof source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_u8 *arenas = malloc(ARENA_BYTES * 4u);
    if (!arenas) return 2;
    pl_x86_block_workspace formation = {
        arenas, arenas + ARENA_BYTES, ARENA_BYTES, 16u,
    };
    pl_x86_block_workspace comparison = {
        arenas + ARENA_BYTES * 2u,
        arenas + ARENA_BYTES * 3u,
        ARENA_BYTES, 16u,
    };
    pl_x86_block_identity identities[4];
    pl_u32 slots[8];
    pl_x86_block_builder builder;
    int status = pl_x86_block_builder_open(
        &builder, &image, &formation, &comparison,
        identities, 4u, slots, 8u);
    pl_x86_block first, second;
    pl_u32 first_rank = 0xffffffffu, second_rank = 0xffffffffu;
    if (!status)
        status = pl_x86_block_lower(
            &builder.frontend, 0x1000u, &builder.formation, &first);
    if (!status) status = pl_x86_block_intern(&builder, &first, &first_rank);
    if (!status)
        status = pl_x86_block_lower(
            &builder.frontend, 0x1007u, &builder.formation, &second);
    if (!status)
        status = pl_x86_block_intern(&builder, &second, &second_rank);
    if (status || first_rank != second_rank || builder.identity_count != 1u
            || builder.shared != 1u) {
        fprintf(stderr,
                "build normal form: RED (status=%d ranks=%u/%u "
                "classes=%u shared=%llu instructions=%u/%u "
                "kind=%u/%u flow=%u/%u dynamic=%u/%u successors=%u/%u "
                "plan=%u,%u,%u,%u/%u,%u,%u,%u)\n",
                status, first_rank, second_rank, builder.identity_count,
                (unsigned long long)builder.shared,
                first.instruction_count, second.instruction_count,
                first.kind, second.kind, first.flow, second.flow,
                first.dynamic_target, second.dynamic_target,
                first.successor_count, second.successor_count,
                first.plan.node_count, first.plan.argument_count,
                first.plan.local_count, first.plan.stack_inputs,
                second.plan.node_count, second.plan.argument_count,
                second.plan.local_count, second.plan.stack_inputs);
        free(arenas);
        return PL_ERROR_FUTURE;
    }
    printf("build normal form: green "
           "(different source instruction histories -> one transfer rank)\n");
    free(arenas);
    return 0;
}

static int complete_future(void)
{
    static const pl_u32 observation[] = { 0u, 0u, 1u, 1u, 0u };
    static const pl_u32 successor[] = {
        2u, 2u,
        3u, 3u,
        2u, 2u,
        3u, 3u,
        4u, 4u,
    };
    pl_finite_future_machine machine = {
        5u, 2u, 2u, observation, successor,
    };
    pl_u32 scratch_bytes = 0u;
    int status = pl_finite_future_workspace_measure(
        machine.states, machine.arms, &scratch_bytes);
    pl_u8 *scratch = status ? 0 : malloc(scratch_bytes);
    pl_u32 state_class[5];
    pl_finite_future_workspace workspace = {
        state_class, 5u, scratch, scratch_bytes,
    };
    pl_finite_future_projection projection = { 0 };
    if (!status && !scratch) status = PL_ERROR_FUTURE_RANGE;
    if (!status)
        status = pl_finite_future_project(
            &machine, &workspace, &projection);
    if (status || projection.classes != 3u
            || projection.checked_transitions != 10u
            || state_class[0] != state_class[1]
            || state_class[2] != state_class[3]
            || state_class[0] == state_class[2]
            || state_class[0] == state_class[4]) {
        fprintf(stderr,
                "build future quotient: RED "
                "(status=%d classes=%u ranks=%u/%u/%u/%u/%u)\n",
                status, projection.classes,
                state_class[0], state_class[1], state_class[2],
                state_class[3], state_class[4]);
        free(scratch);
        return PL_ERROR_FUTURE;
    }
    free(scratch);
    return 0;
}

static pl_u32 next_case(pl_u32 *state)
{
    *state = *state * 1664525u + 1013904223u;
    return *state;
}

static int complete_future_oracle(void)
{
    enum { MAX_STATES = 8, MAX_ARMS = 3, CASES = 20000 };
    pl_u32 observation[MAX_STATES];
    pl_u32 successor[MAX_STATES * MAX_ARMS];
    pl_u8 different[MAX_STATES * MAX_STATES];
    pl_u32 state_class[MAX_STATES];
    pl_u32 seed = 0x4e46554du;
    for (pl_u32 trial = 0u; trial < CASES; ++trial) {
        pl_u32 states = 2u + next_case(&seed) % (MAX_STATES - 1u);
        pl_u32 arms = 1u + next_case(&seed) % MAX_ARMS;
        pl_u32 observations = 1u + next_case(&seed)
                                      % (states < 3u ? states : 3u);
        for (pl_u32 state = 0u; state < states; ++state)
            observation[state] = state < observations
                               ? state
                               : next_case(&seed) % observations;
        for (pl_u32 index = 0u; index < states * arms; ++index)
            successor[index] = next_case(&seed) % states;
        for (pl_u32 left = 0u; left < states; ++left)
            for (pl_u32 right = 0u; right < states; ++right)
                different[left * states + right] =
                    observation[left] != observation[right];
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
        pl_finite_future_machine machine = {
            states, observations, arms, observation, successor,
        };
        pl_u32 scratch_bytes = 0u;
        int status = pl_finite_future_workspace_measure(
            states, arms, &scratch_bytes);
        pl_u8 *scratch = status ? 0 : malloc(scratch_bytes);
        pl_finite_future_workspace workspace = {
            state_class, MAX_STATES, scratch, scratch_bytes,
        };
        pl_finite_future_projection projection = { 0 };
        if (!status && !scratch) status = PL_ERROR_FUTURE_RANGE;
        if (!status)
            status = pl_finite_future_project(
                &machine, &workspace, &projection);
        for (pl_u32 left = 0u; !status && left < states; ++left)
            for (pl_u32 right = 0u; right < states; ++right)
                if ((state_class[left] == state_class[right])
                        == !!different[left * states + right])
                    status = PL_ERROR_FUTURE;
        if (status) {
            fprintf(stderr,
                    "complete future oracle: RED "
                    "(status=%d trial=%u states=%u arms=%u observations=%u)\n",
                    status, trial, states, arms, observations);
            free(scratch);
            return PL_ERROR_FUTURE;
        }
        free(scratch);
    }
    printf("complete future oracle: green (%u finite machines)\n", CASES);
    return 0;
}

static int x86_successor_future(void)
{
    static const pl_u8 source[] = {
        /* Same local transfer, different static successor displacement. */
        0xb8u, 0x2au, 0x00u, 0x00u, 0x00u, 0xebu, 0x09u,
        0xb8u, 0x2au, 0x00u, 0x00u, 0x00u, 0xebu, 0x12u,
        /* Equivalent successor futures. */
        0x90u, 0x90u, 0xc3u,
        0x90u, 0x90u, 0x90u, 0x90u, 0x90u, 0x90u, 0x90u,
        0x90u, 0x90u, 0x90u, 0x90u, 0x90u, 0x90u, 0x90u, 0x90u,
        0xc3u,
    };
    static const pl_u64 start[] = { 0x1000u, 0x1007u, 0x1010u, 0x1020u };
    pl_x86_map map = {
        source, 0x1000u, sizeof source, sizeof source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_u8 *arenas = malloc(ARENA_BYTES * 4u);
    if (!arenas) return 2;
    pl_x86_block_workspace formation = {
        arenas, arenas + ARENA_BYTES, ARENA_BYTES, 16u,
    };
    pl_x86_block_workspace comparison = {
        arenas + ARENA_BYTES * 2u,
        arenas + ARENA_BYTES * 3u, ARENA_BYTES, 16u,
    };
    pl_x86_block_identity identities[4];
    pl_u32 slots[8];
    pl_x86_block_builder builder;
    int status = pl_x86_block_builder_open(
        &builder, &image, &formation, &comparison,
        identities, 4u, slots, 8u);
    pl_x86_block block[4];
    pl_u32 observation[5] = { 0u, 0u, 0u, 0u, 2u };
    for (pl_u32 index = 0u; !status && index < 4u; ++index) {
        status = pl_x86_block_lower(
            &builder.frontend, start[index], &builder.formation,
            &block[index]);
        if (!status)
            status = pl_x86_block_observation_intern(
                &builder, &block[index],
                block[index].successor_count
                    ? (1u << block[index].successor_count) - 1u : 0u,
                &observation[index]);
    }
    if (!status && (observation[0] != observation[1]
            || observation[2] != observation[3]
            || observation[0] == observation[2]
            || builder.identity_count != 2u))
        status = PL_ERROR_FUTURE;

    static const pl_u32 successor[] = { 2u, 3u, 4u, 4u, 4u };
    pl_finite_future_machine machine = {
        5u, 3u, 1u, observation, successor,
    };
    pl_u32 scratch_bytes = 0u;
    if (!status)
        status = pl_finite_future_workspace_measure(
            machine.states, machine.arms, &scratch_bytes);
    pl_u8 *scratch = status ? 0 : malloc(scratch_bytes);
    pl_u32 state_class[5] = {
        0xffffffffu, 0xffffffffu, 0xffffffffu,
        0xffffffffu, 0xffffffffu,
    };
    pl_finite_future_workspace workspace = {
        state_class, 5u, scratch, scratch_bytes,
    };
    pl_finite_future_projection projection = { 0 };
    if (!status && !scratch) status = PL_ERROR_FUTURE_RANGE;
    if (!status)
        status = pl_finite_future_project(
            &machine, &workspace, &projection);
    if (status || projection.classes != 3u
            || state_class[0] != state_class[1]
            || state_class[2] != state_class[3]
            || state_class[0] == state_class[2]
            || state_class[0] == state_class[4]) {
        fprintf(stderr,
                "x86 successor future: RED "
                "(status=%d observations=%u/%u/%u/%u "
                "classes=%u ranks=%u/%u/%u/%u/%u)\n",
                status, observation[0], observation[1],
                observation[2], observation[3], projection.classes,
                state_class[0], state_class[1], state_class[2],
                state_class[3], state_class[4]);
        free(scratch);
        free(arenas);
        return PL_ERROR_FUTURE;
    }
    printf("x86 successor future: green "
           "(raw successor coordinates -> complete-future rank)\n");
    free(scratch);
    free(arenas);
    return 0;
}

static int external_successor_observation(void)
{
    static const pl_u8 source[] = {
        /* Both encodings have successor-start == 128, but the linked
         * non-image destinations are 0x1080 and 0x1082.  A context that
         * observes RIP distinguishes them, so they cannot share an
         * immediate observation class. */
        0xebu, 0x7eu,
        0xebu, 0x7eu,
    };
    pl_x86_map map = {
        source, 0x1000u, sizeof source, sizeof source,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_u8 *arenas = malloc(ARENA_BYTES * 4u);
    if (!arenas) return 2;
    pl_x86_block_workspace formation = {
        arenas, arenas + ARENA_BYTES, ARENA_BYTES, 4u,
    };
    pl_x86_block_workspace comparison = {
        arenas + ARENA_BYTES * 2u,
        arenas + ARENA_BYTES * 3u, ARENA_BYTES, 4u,
    };
    pl_x86_block_identity identities[2];
    pl_u32 slots[4];
    pl_x86_block_builder builder;
    int status = pl_x86_block_builder_open(
        &builder, &image, &formation, &comparison,
        identities, 2u, slots, 4u);
    pl_u32 rank[2] = { 0xffffffffu, 0xffffffffu };
    for (pl_u32 index = 0u; !status && index < 2u; ++index) {
        pl_x86_block block;
        status = pl_x86_block_lower(
            &builder.frontend, 0x1000u + index * 2u,
            &builder.formation, &block);
        if (!status)
            status = pl_x86_block_observation_intern(
                &builder, &block, 0u, &rank[index]);
    }
    if (status || rank[0] == rank[1] || builder.identity_count != 2u) {
        fprintf(stderr,
                "external successor observation: RED "
                "(status=%d ranks=%u/%u classes=%u)\n",
                status, rank[0], rank[1], builder.identity_count);
        free(arenas);
        return PL_ERROR_FUTURE;
    }
    printf("external successor observation: green "
           "(absolute non-image targets remain observable)\n");
    free(arenas);
    return 0;
}

int main(void)
{
    int status = minimum_work_membership();
    if (!status) status = instruction_history();
    if (!status) status = complete_future();
    if (!status) status = complete_future_oracle();
    if (!status) status = x86_successor_future();
    if (!status) status = external_successor_observation();
    if (status) return 1;
    printf("complete build future: green "
           "(cyclic total machine -> exact minimum partition)\n");
    return 0;
}
