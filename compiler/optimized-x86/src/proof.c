#include <optimized-x86/proof.h>

int ox_proof_cost_nonregresses(const ox_proof *proof)
{
    if (!proof) return 0;
    if (proof->output_span > proof->input_span
            || proof->output_work > proof->input_work
            || proof->output_code_bytes > proof->input_code_bytes)
        return 0;
    if (proof->pareto_complete == 1u) {
        if (proof->output_span != proof->minimum_span
                || proof->output_work != proof->minimum_work)
            return 0;
    } else if (proof->pareto_complete == 2u) {
        if (proof->output_span < proof->minimum_span
                || proof->output_work < proof->minimum_work)
            return 0;
    } else {
        return 0;
    }
    return 1;
}

int ox_proof_validate(const ox_proof *proof)
{
    pl_u32 nonzero = 0u;
    pl_u32 index;
    if (!proof
            || proof->proof_version != OX_PROOF_VERSION
            || proof->machine_abi != OX_MACHINE_ABI_VERSION
            || proof->flags != OX_PROOF_REQUIRED_FLAGS
            || !proof->source_bytes
            || !proof->function_count
            || (proof->entry_function != OX_PROOF_NO_ENTRY_FUNCTION
                && proof->entry_function >= proof->function_count)
            || !proof->coordinate_count
            || proof->direct_count > proof->coordinate_count
            || proof->fault_count
                != proof->coordinate_count - proof->direct_count
            || !proof->input_span || !proof->output_span
            || !proof->input_work || !proof->output_work
            || !proof->minimum_span || !proof->minimum_work
            || !proof->input_code_bytes || !proof->output_code_bytes
            || proof->input_code_bytes > proof->source_bytes
            || !proof->build_id_bytes
            || proof->build_id_bytes > OX_BUILD_ID_MAX_BYTES
            || !ox_proof_cost_nonregresses(proof))
        return OX_ERROR_PROOF;
    for (index = 0u; index < 4u; ++index)
        nonzero |= proof->source_sha256[index] != 0u;
    if (!nonzero) return OX_ERROR_PROOF;
    nonzero = 0u;
    for (index = 0u; index < proof->build_id_bytes; ++index)
        nonzero |= proof->build_id[index];
    return nonzero ? 0 : OX_ERROR_BUILD_ID;
}
