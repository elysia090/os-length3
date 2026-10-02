/* Enumerate grammar matches and replay the selected native spelling. */
#include "select.h"
#include "limits.h"
#include "alu-frame.h"
#include "arx-frame.h"
#include "branch-frame.h"
#include "carry-frame.h"
#include "expressions.h"
#include "flag-frame.h"
#include "handoff.h"
#include "projection.h"
#include "shared-dag.h"
#include "simple-frame.h"
#include "source.h"
#include "state-frame.h"

typedef int (*measure_normalized_candidate)(
    const pl_x86_frontend *, const pl_x86_block *,
    pl_x86_native_selection *);

static int plan_identity(const pl_plan *plan);

static void reset_normalized_candidate(
    pl_x86_native_selection *selection, pl_u32 source_bytes);

static int append_normalized_candidate(
    pl_x86_native_candidates *candidates,
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 source_bytes, measure_normalized_candidate measure);

static int plan_identity(const pl_plan *plan)
{
    if (!plan || plan->node_count || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    for (pl_u32 index = 0u; index < plan->local_count; ++index)
        if (plan->locals[index].kind != PL_OPERAND_LOCAL
                || plan->locals[index].value != index)
            return 0;
    return 1;
}

int pl_select_plan_has_memory(const pl_plan *plan)
{
    if (!plan) return 1;
    for (pl_u32 node = 0u; node < plan->node_count; ++node)
        if (pl_opcode_is_memory(plan->nodes[node].opcode)) return 1;
    return 0;
}

static void reset_normalized_candidate(
    pl_x86_native_selection *selection, pl_u32 source_bytes)
{
    *selection = (pl_x86_native_selection){ 0 };
    selection->blocking_opcode = U32_MAX_VALUE;
    selection->source_bytes = source_bytes;
}

static int append_normalized_candidate(
    pl_x86_native_candidates *candidates,
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 source_bytes, measure_normalized_candidate measure)
{
    if (!candidates || !frontend || !block || !measure)
        return PL_ERROR_X86_SELECT;
    pl_x86_native_selection selection;
    reset_normalized_candidate(&selection, source_bytes);
    pl_x86_address_memo_entry memo[PL_X86_ADDRESS_MEMO_COUNT] = { 0 };
    selection.address_memo = memo;
    int selected = measure(frontend, block, &selection);
    selection.address_memo = 0;
    if (selected < 0) return selected;
    if (!selected) {
        if (selection.blocking_work
                && (!candidates->diagnostic.blocking_work
                    || selection.direct_alu_frame || selection.direct_branch_frame))
            candidates->diagnostic = selection;
        return 0;
    }
    if (!selection.supported
            || candidates->count >= PL_X86_NATIVE_MAX_CANDIDATES)
        return PL_ERROR_X86_SELECT;
    selection.normalized_family_present = 1u;
    candidates->candidate[candidates->count++] = selection;
    return 0;
}

int pl_x86_select_candidates(const pl_x86_frontend *frontend,
                             const pl_x86_block_workspace *workspace,
                             const pl_x86_block *block,
                             pl_x86_native_candidates *out)
{
    if (!frontend || !workspace || !block || !out
            || block->end < block->start
            || block->end - block->start > U32_MAX_VALUE)
        return PL_ERROR_X86_SELECT;
    pl_u32 source_bytes = (pl_u32)(block->end - block->start);
    *out = (pl_x86_native_candidates){ 0 };
    out->diagnostic.blocking_opcode = U32_MAX_VALUE;
    out->diagnostic.source_bytes = source_bytes;

    pl_x86_instruction terminal;
    int status = pl_select_final_instruction(frontend, block, &terminal);
    if (status) return status;
    /* An invalid or fetch-fault coordinate is already one exact native fault
     * spelling.  Its decoder fallthrough is intentionally not a successor,
     * so suffix discovery must not demand that it reach block->end.  Keeping
     * these bytes is the ordinary-x86 representation of the precise #UD/#PF
     * cut and closes arbitrary byte entry coordinates without an interpreter
     * or runtime missing-block route. */
    if (block->kind == PL_X86_BLOCK_FAULT) {
        if (!source_bytes || terminal.source_bytes != source_bytes)
            return PL_ERROR_X86_SELECT;
        pl_x86_native_selection *fault = &out->candidate[out->count++];
        fault->blocking_opcode = U32_MAX_VALUE;
        fault->source_bytes = source_bytes;
        fault->output_bytes = source_bytes;
        fault->output_instructions = 1u;
        fault->output_work = 1u;
        fault->output_span = 1u;
        fault->supported = 1u;
        fault->copied_source = 1u;
        fault->reason = PL_X86_NATIVE_SELECT_READY;
        return 0;
    }
    if (!block->source_identity
            && block->kind == PL_X86_BLOCK_DIRECT
            && block->flow == PL_X86_FLOW_NEXT
            && block->successor_count == 1u
            && !block->dynamic_target
            && !block->has_predicate && !block->has_fault_predicate
            && block->machine_operation == PL_X86_MACHINE_NONE
            && plan_identity(&block->plan)) {
        /* Erasure is decided by the normalized semantic shell, not by the
         * source decoder's reason for ending the block. A precise source cut
         * whose target/predicate/fault/machine roots all normalized away is
         * the identity transfer. Retaining its bytes would make a source
         * scheduling annotation observable and block complete-future DCE. */
        pl_x86_native_selection *identity = &out->candidate[out->count++];
        identity->blocking_opcode = U32_MAX_VALUE;
        identity->source_bytes = source_bytes;
        identity->supported = 1u;
        identity->eliminated_bytes = source_bytes;
        return 0;
    }

    /* Every direct frame below emits only register/control topology.  A load
     * or store is an observable barrier even when no final GPR names its
     * value (notably the PLT resolver's push [GOT]).  Until a candidate emits
     * that memory topology explicitly, copied linked x86 is its sole exact
     * spelling. */
    int derived_address = pl_select_derived_rip_address_requires_source(frontend, block);
    if (derived_address < 0) return derived_address;
    if (!block->source_identity && !pl_select_plan_has_memory(&block->plan)
            && !derived_address) {
        static const measure_normalized_candidate grammar[] = {
            pl_select_measure_direct_frame,
            pl_select_measure_direct_common_frame,
            pl_select_measure_direct_add_frame,
            pl_select_measure_direct_insert_frame,
            pl_select_measure_direct_equal_compare_frame,
            pl_select_measure_direct_constant_shift_frame,
            pl_select_measure_direct_mul_add_carry_frame,
            pl_select_measure_direct_condition_carry_frame,
            pl_select_measure_direct_arx_frame,
            pl_select_measure_direct_mutable_xor_frame,
            pl_select_measure_direct_shared_sub_frame,
            pl_select_measure_direct_alu_frame,
            pl_select_measure_direct_transient_owner_frame,
            pl_select_measure_direct_zero_flag_frame,
            pl_select_measure_direct_shift_handoff_frame,
            pl_select_measure_direct_shared_owner_frame,
            pl_select_measure_direct_value_predicate_frame,
            pl_select_measure_direct_compare_handoff_frame,
            pl_select_measure_direct_compare_tree_select_frame,
            pl_select_measure_direct_entry_flag_branch,
            pl_select_measure_direct_mask_flag_branch,
            pl_select_measure_direct_compare_branch,
            pl_select_measure_direct_affine_frame,
            pl_select_measure_direct_transient_seed_frame,
            pl_select_measure_direct_consumed_flag_frame,
            pl_select_measure_direct_live_frame,
        };
        for (pl_u32 production = 0u;
                production < sizeof grammar / sizeof grammar[0];
                ++production) {
            status = append_normalized_candidate(
                out, frontend, block, source_bytes, grammar[production]);
            if (status) {
                out->diagnostic_stage = 0x100u + production;
                return status;
            }
        }
        /* The shared-DAG schedule is a last resort: it changes register
         * allocation across the whole frame, so it must not compete with a
         * frame production that already has a fixed local spelling. */
        if (!out->count) {
            status = append_normalized_candidate(
                out, frontend, block, source_bytes,
                pl_select_measure_direct_shared_dag_frame);
            if (status) {
                out->diagnostic_stage = 0x180u;
                return status;
            }
        }
    }
    /* A memory effect is a precise one-instruction barrier.  If formation
     * ever admits a surrounding pure instruction into the same plan, copied
     * source would become an accidental normalization escape. */
    if (pl_select_plan_has_memory(&block->plan) && block->instruction_count != 1u)
        return PL_ERROR_X86_SELECT;

    pl_x86_native_selection source = { 0 };
    source.blocking_opcode = U32_MAX_VALUE;
    source.source_bytes = source_bytes;
    status = block->source_identity ? 0 : pl_select_equivalent_suffix_bytes(
        frontend, workspace, block, &source.omitted_prefix_bytes);
    if (status) {
        out->diagnostic_stage = 0x200u;
        return status;
    }

    int selected = pl_select_measure_source_run(
        frontend, block->start, block->instruction_count,
        source.omitted_prefix_bytes, block->relax_short_control, &source);
    if (selected < 0) {
        out->diagnostic_stage = 0x300u;
        return selected;
    }
    if (selected) {
        source.supported = 1u;
        source.reason = PL_X86_NATIVE_SELECT_READY;
    }
    if (selected) {
        const pl_u32 all_outputs =
            (1u << PL_X86_LOCAL_COUNT) - 1u;
        /* Exact source x86 is itself a proved representative of a projected
         * future: the full lowering has identical mandatory effects and
         * identical publications on every live coordinate. Differences on
         * the omitted coordinates are unobservable by definition, so this is
         * a normalized projection production, not a fallback interpreter or
         * a second semantic route. */
        source.normalized_family_present = out->count != 0u
            || block->live_output_mask != all_outputs;
    }
    if (selected) {
        if (out->count >= PL_X86_NATIVE_MAX_CANDIDATES)
            return PL_ERROR_X86_SELECT;
        out->candidate[out->count++] = source;
    }
    if (!out->diagnostic.blocking_work) out->diagnostic = source;
    pl_u32 valid_count = 0u;
    for (pl_u32 index = 0u; index < out->count; ++index) {
        pl_x86_native_selection *candidate = &out->candidate[index];
        status = pl_select_derive_emitted_candidate_cost(
            frontend, block, candidate);
        if (status) {
            /* A grammar match is only a proposal.  If its measured spelling
             * cannot be emitted and reopened as x86, it has no physical cost
             * and must not enter the Pareto set.  The exact linked-source
             * spelling is mandatory; failure to validate that one still
             * rejects the block. */
            if (candidate->copied_source) {
                out->diagnostic_stage = 0x400u + index;
                return status;
            }
            continue;
        }
        if (candidate->source_bytes > candidate->output_bytes)
            candidate->eliminated_bytes =
                candidate->source_bytes - candidate->output_bytes;
        if (valid_count != index)
            out->candidate[valid_count] = *candidate;
        ++valid_count;
    }
    out->count = valid_count;
    if (!valid_count) return PL_ERROR_X86_SELECT;
    return 0;
}

int pl_x86_select_measure(const pl_x86_frontend *frontend,
                          const pl_x86_block_workspace *workspace,
                          const pl_x86_block *block,
                          pl_x86_native_selection *out)
{
    if (!out) return PL_ERROR_X86_SELECT;
    pl_x86_native_candidates candidates;
    int status = pl_x86_select_candidates(
        frontend, workspace, block, &candidates);
    if (status) return status;
    if (!candidates.count) {
        *out = candidates.diagnostic;
        return 0;
    }
    pl_u32 span = 0u, work = 0u;
    status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, out, &span, &work);
    return status;
}

int pl_x86_select_write(const pl_x86_frontend *frontend,
                        const pl_x86_block_workspace *workspace,
                        const pl_x86_block *block,
                        pl_u8 *output, pl_u32 output_capacity,
                        pl_u32 *output_bytes,
                        pl_x86_native_selection *selection)
{
    if (!output_bytes || !selection) return PL_ERROR_X86_SELECT;
    *output_bytes = 0u;
    int status = pl_x86_select_measure(
        frontend, workspace, block, selection);
    if (status || !selection->supported) return status;
    return pl_x86_select_write_measured(
        frontend, block, selection,
        output, output_capacity, output_bytes);
}

int pl_x86_select_write_measured(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    const pl_x86_native_selection *selection,
    pl_u8 *output, pl_u32 output_capacity, pl_u32 *output_bytes)
{
    if (!frontend || !block || !selection || !output_bytes
            || !selection->supported)
        return PL_ERROR_X86_SELECT;
    *output_bytes = 0u;
    if (selection->output_bytes > output_capacity
            || (selection->output_bytes && !output))
        return PL_ERROR_X86_SELECT;
    int status = 0;
    if (selection->output_bytes) {
        status = selection->direct_shared_sub_frame
               ? pl_select_write_direct_shared_sub_frame(block, selection, output)
               : selection->direct_transient_seed_frame
               ? pl_select_write_direct_transient_seed_frame(block, selection, output)
               : selection->direct_consumed_flag_frame
               ? pl_select_write_direct_consumed_flag_frame(block, selection, output)
               : selection->direct_shared_dag_frame
               ? pl_select_write_direct_shared_dag_frame(block, selection, output)
               : selection->direct_condition_carry_frame
               ? pl_select_write_direct_condition_carry_frame(
                    block, selection, output)
               : selection->direct_mul_add_carry_frame
               ? pl_select_write_direct_mul_add_carry_frame(
                    block, selection, output)
               : selection->direct_live_frame
               ? pl_select_write_source_run(frontend, block, selection, output)
               : selection->direct_affine_frame
               ? pl_select_write_direct_affine_frame(block, selection, output)
               : selection->direct_shift_handoff_frame
               ? pl_select_write_direct_shift_handoff_frame(
                    block, selection, output)
               : selection->direct_zero_flag_frame
               ? pl_select_write_direct_zero_flag_frame(block, selection, output)
               : selection->direct_transient_owner_frame
               ? pl_select_write_direct_transient_owner_frame(
                    block, selection, output)
               : selection->direct_shared_owner_frame
                ? pl_select_write_direct_shared_owner_frame(block, selection, output)
               : selection->direct_value_predicate_frame
               ? pl_select_write_direct_value_predicate_frame(
                    block, selection, output)
               : selection->direct_compare_handoff_frame
               ? pl_select_write_direct_compare_handoff_frame(
                    block, selection, output)
               : selection->direct_compare_tree_select_frame
               ? pl_select_write_direct_compare_tree_select_frame(
                    block, selection, output)
               : selection->direct_entry_branch_frame
               ? pl_select_write_direct_entry_flag_branch(block, selection, output)
               : selection->direct_mask_flag_branch_frame
               ? pl_select_write_direct_mask_flag_branch(block, selection, output)
               : selection->direct_branch_frame
               ? pl_select_write_direct_compare_branch(block, selection, output)
               : selection->direct_common_frame
               ? pl_select_write_direct_common_frame(block, selection, output)
               : selection->direct_insert_frame
               ? pl_select_write_direct_insert_frame(block, selection, output)
               : selection->direct_shift_frame
               ? pl_select_write_direct_constant_shift_frame(block, selection, output)
               : selection->direct_compare_frame
               ? pl_select_write_direct_equal_compare_frame(block, selection, output)
               : selection->direct_arx_frame
               ? pl_select_write_direct_arx_frame(block, selection, output)
               : selection->direct_mutable_xor_frame
               ? pl_select_write_direct_mutable_xor_frame(
                    block, selection, output)
               : selection->direct_alu_frame
               ? pl_select_write_direct_alu_frame(block, selection, output)
               : selection->direct_add_frame
                 ? pl_select_write_direct_add_frame(block, selection, output)
               : selection->direct_frame
                 ? pl_select_write_direct_frame(block, selection, output)
                 : pl_select_write_source_run(frontend, block, selection, output);
        if (status) return status;
    }
    *output_bytes = selection->output_bytes;
    return 0;
}
