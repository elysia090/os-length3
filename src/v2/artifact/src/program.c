#include <artifact/program.h>
#include <support/checked.h>

static const pl_u8 instruction_domain[] =
    "x86-normal-instruction-v5";

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    if (*value > 0xffffffffffffffffull - addend) return 0;
    *value += addend;
    return 1;
}

static int open_uleb64(const pl_u8 *bytes, pl_u32 length,
                       pl_u32 *at, pl_u64 *out)
{
    if (!bytes || !at || !out || *at >= length) return 0;
    pl_u32 start = *at;
    pl_u64 value = 0u;
    for (pl_u32 group = 0u; group < 10u; ++group) {
        if (*at >= length) return 0;
        pl_u8 byte = bytes[(*at)++];
        if (group == 9u && (byte & 0xfeu)) return 0;
        value |= (pl_u64)(byte & 0x7fu) << (group * 7u);
        if (!(byte & 0x80u)) {
            if (*at - start > 1u && !(byte & 0x7fu)) return 0;
            *out = value;
            return 1;
        }
    }
    return 0;
}

static int open_normal_instruction(
    const artifact_cell *cell, pl_u32 arms,
    pl_u64 *work_lower_bound, pl_u64 *span_lower_bound)
{
    if (!cell || !cell->bytes || cell->length < 11u
            || arms > 0xffu)
        return 0;
    const pl_u8 *bytes = cell->bytes;
    if (bytes[0] != 'X' || bytes[1] != '8'
            || bytes[2] != '6' || bytes[3] != 'N'
            || bytes[4] != 5u || bytes[5] != (pl_u8)arms
            || bytes[6] != 7u)
        return 0;
    pl_u32 at = 7u;
    pl_u64 law_bytes64 = 0u, binding_bytes64 = 0u;
    if (!open_uleb64(bytes, cell->length, &at, work_lower_bound)
            || !open_uleb64(bytes, cell->length, &at, span_lower_bound)
            || !open_uleb64(bytes, cell->length, &at, &law_bytes64)
            || !open_uleb64(bytes, cell->length, &at, &binding_bytes64)
            || !law_bytes64 || !binding_bytes64
            || law_bytes64 > 0xffffffffu
            || binding_bytes64 > 0xffffffffu
            || (pl_u64)at + law_bytes64 + binding_bytes64
               != cell->length)
        return 0;
    return 1;
}

int artifact_program_project(
    const artifact_program_population *population,
    const artifact_program_workspace *workspace,
    artifact_program_projection *out)
{
    if (!population || !workspace || !out || !population->instruction
            || !population->successor || !population->states
            || !population->arms
            || population->states > 0xffffffffu / population->arms
            || !workspace->observation
            || workspace->state_capacity < population->states)
        return ARTIFACT_ERROR_PROGRAM_RANGE;

    artifact_program_projection result = { 0 };
    result.instruction_occurrences = population->states;
    for (pl_u32 state = 0u; state < population->states; ++state) {
        const artifact_cell *instruction = &population->instruction[state];
        pl_u64 work_lower_bound = 0u, span_lower_bound = 0u;
        if (!open_normal_instruction(
                instruction, population->arms,
                &work_lower_bound, &span_lower_bound))
            return ARTIFACT_ERROR_PROGRAM;
        if (!add_u64(&result.work_lower_bound_sum, work_lower_bound)
                || !add_u64(&result.span_lower_bound_sum, span_lower_bound))
            return ARTIFACT_ERROR_PROGRAM_RANGE;
        if (work_lower_bound > result.maximum_work_lower_bound)
            result.maximum_work_lower_bound = work_lower_bound;
        if (span_lower_bound > result.maximum_span_lower_bound)
            result.maximum_span_lower_bound = span_lower_bound;
        ++result.minimum_proof_occurrences;
        ++result.joint_witness_occurrences;
        if (!add_u64(
                &result.opened_instruction_bytes, instruction->length))
            return ARTIFACT_ERROR_PROGRAM_RANGE;
        for (pl_u32 arm = 0u; arm < population->arms; ++arm)
            if (population->successor[
                    (pl_u64)state * population->arms + arm]
                    >= population->states)
                return ARTIFACT_ERROR_PROGRAM;
            else if (!add_u64(
                    &result.checked_successor_coordinates, 1u))
                return ARTIFACT_ERROR_PROGRAM_RANGE;
        workspace->observation[state] =
            (artifact_complete_observation){
                ARTIFACT_OBSERVATION_BLOCK,
                instruction_domain,
                (pl_u32)(sizeof(instruction_domain) - 1u),
                instruction->bytes,
                instruction->length,
            };
    }

    artifact_future_population future_population = {
        workspace->observation, population->successor,
        population->states, population->arms,
    };
    int status = artifact_future_project(
        &future_population, &workspace->future, &result.future);
    if (status) return status;

    result.instruction_classes = result.future.immediate.classes;
    result.shared_instruction_occurrences =
        population->states - result.instruction_classes;
    for (pl_u32 rank = 0u; rank < result.instruction_classes; ++rank) {
        pl_u32 representative =
            workspace->future.immediate.representative[rank];
        if (representative >= population->states
                || !add_u64(
                    &result.retained_instruction_bytes,
                    population->instruction[representative].length))
            return ARTIFACT_ERROR_PROGRAM_RANGE;
    }
    if (!result.future.future.classes
            || result.future.future.classes > population->states
            || result.minimum_proof_occurrences != population->states
            || result.joint_witness_occurrences != population->states
            || result.checked_successor_coordinates
               != (pl_u64)population->states * population->arms
            || result.retained_residual_state_rows
            || result.retained_residual_edge_rows
            || result.retained_instruction_bytes
               > result.opened_instruction_bytes)
        return ARTIFACT_ERROR_PROGRAM;

    *out = result;
    return 0;
}
