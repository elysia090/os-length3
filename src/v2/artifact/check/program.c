#include <artifact/program.h>

#include <stdio.h>
#include <stdlib.h>

#define NORMAL_CELL(law, work, span) { \
    'X','8','6','N', 5u,2u,7u, work,span,1u,1u, law,'B' \
}

int main(void)
{
    static const pl_u8 add[] = NORMAL_CELL('A', 1u, 1u);
    static const pl_u8 ret[] = NORMAL_CELL('R', 1u, 1u);
    artifact_cell instruction[] = {
        { add, sizeof(add) }, { add, sizeof(add) },
        { ret, sizeof(ret) }, { ret, sizeof(ret) },
        { add, sizeof(add) },
    };
    pl_u32 successor[] = {
        2u, 2u,
        3u, 3u,
        2u, 2u,
        3u, 3u,
        4u, 4u,
    };
    artifact_program_population population = {
        instruction, successor, 5u, 2u,
    };

    pl_u32 share_digest_bytes = 0u, share_indices = 0u;
    int status = artifact_share_measure(
        population.states, &share_digest_bytes, &share_indices);
    pl_u8 *share_digest = status ? 0 : malloc(share_digest_bytes);
    pl_u32 *share_index = status ? 0 : malloc(
        (size_t)share_indices * 4u * sizeof(*share_index));
    pl_u32 future_bytes = 0u;
    if (!status)
        status = pl_finite_future_workspace_measure(
            population.states, population.arms, &future_bytes);
    pl_u32 *future_class = status ? 0 : malloc(
        (size_t)population.states * sizeof(*future_class));
    pl_u8 *future_scratch = status ? 0 : malloc(future_bytes);
    artifact_complete_observation *observation = status ? 0 : malloc(
        (size_t)population.states * sizeof(*observation));
    if (!status && (!share_digest || !share_index || !future_class
            || !future_scratch || !observation))
        status = ARTIFACT_ERROR_PROGRAM_RANGE;

    artifact_program_workspace workspace = {
        .observation = observation,
        .state_capacity = population.states,
        .future = {
            .immediate = {
                share_digest, share_digest_bytes,
                share_index,
                share_index ? share_index + share_indices : 0,
                share_index ? share_index + share_indices * 2u : 0,
                share_index ? share_index + share_indices * 3u : 0,
                share_indices,
            },
            .future = {
                future_class, population.states,
                future_scratch, future_bytes,
            },
        },
    };
    artifact_program_projection projection = { 0 };
    if (!status)
        status = artifact_program_project(
            &population, &workspace, &projection);

    pl_u64 expected_opened = 0u;
    for (pl_u32 state = 0u; state < population.states; ++state)
        expected_opened += instruction[state].length;
    pl_u64 expected_retained = instruction[0].length
                             + instruction[2].length;
    if (!status && (projection.instruction_occurrences != 5u
            || projection.instruction_classes != 2u
            || projection.shared_instruction_occurrences != 3u
            || projection.future.future.classes != 3u
            || projection.future.shared_state_occurrences != 2u
            || projection.minimum_proof_occurrences != 5u
            || projection.joint_witness_occurrences != 5u
            || projection.work_lower_bound_sum != 5u
            || projection.span_lower_bound_sum != 5u
            || projection.maximum_work_lower_bound != 1u
            || projection.maximum_span_lower_bound != 1u
            || projection.checked_successor_coordinates != 10u
            || projection.retained_residual_state_rows
            || projection.retained_residual_edge_rows
            || projection.opened_instruction_bytes != expected_opened
            || projection.retained_instruction_bytes != expected_retained
            || future_class[0] != future_class[1]
            || future_class[2] != future_class[3]
            || future_class[0] == future_class[2]
            || future_class[0] == future_class[4]))
        status = ARTIFACT_ERROR_PROGRAM;

    pl_u32 saved = successor[0];
    successor[0] = population.states;
    if (!status && artifact_program_project(
            &population, &workspace, &projection)
            != ARTIFACT_ERROR_PROGRAM)
        status = ARTIFACT_ERROR_PROGRAM;
    successor[0] = saved;

    pl_u8 invalid[sizeof(add)];
    for (pl_u32 index = 0u; index < sizeof(add); ++index)
        invalid[index] = add[index];
    invalid[6] = 3u; /* no joint witness */
    artifact_cell saved_instruction = instruction[0];
    instruction[0] = (artifact_cell){ invalid, sizeof(invalid) };
    if (!status && artifact_program_project(
            &population, &workspace, &projection)
            != ARTIFACT_ERROR_PROGRAM)
        status = ARTIFACT_ERROR_PROGRAM;
    instruction[0] = saved_instruction;

    pl_u8 overlong[sizeof(add) + 1u];
    for (pl_u32 index = 0u; index < 7u; ++index)
        overlong[index] = add[index];
    overlong[7] = 0x81u;
    overlong[8] = 0u; /* non-minimal ULEB spelling of work=1 */
    for (pl_u32 index = 8u; index < sizeof(add); ++index)
        overlong[index + 1u] = add[index];
    instruction[0] = (artifact_cell){ overlong, sizeof(overlong) };
    if (!status && artifact_program_project(
            &population, &workspace, &projection)
            != ARTIFACT_ERROR_PROGRAM)
        status = ARTIFACT_ERROR_PROGRAM;
    instruction[0] = saved_instruction;

    if (status)
        fprintf(stderr, "canonical residual program: RED (%d)\n", status);
    else
        printf("canonical residual program: green "
               "(5 proved minima/joint witnesses -> 2 instruction laws "
               "-> 3 futures; "
               "no component storage modes)\n");

    free(observation);
    free(future_scratch);
    free(future_class);
    free(share_index);
    free(share_digest);
    return status ? 1 : 0;
}
