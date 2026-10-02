/* alu-frame: native x86 selection. */
#include "alu-frame.h"
#include "limits.h"
#include "lea.h"
#include "branch-frame.h"
#include "encoding.h"
#include "expressions.h"
#include "flags.h"
#include "handoff.h"
#include "operands.h"
#include "select-rules.h"
#include "shared-dag.h"
#include "simple-frame.h"
#include "source.h"
#include "tree-measure.h"
#include "tree-write.h"

int pl_select_measure_direct_alu_frame(const pl_x86_frontend *frontend,
                                    const pl_x86_block *block,
                                    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    /* The dense ALU frame enumerates operand trees without a cost
     * memo; a very large straight-line plan makes that search
     * super-exponential.  Decline it so the polynomial live-range and
     * shared-DAG frames, or an exact source projection, own the block. */
    if (block->plan.node_count > 96u) return 0;
    /* A 64-bit address cannot be narrowed merely because its linked offset
     * fits in 32 bits.  Until this shape carries address provenance through
     * its CMOV width choice, retain the exact source spelling. */
    int address_select = pl_select_narrow_address_select_requires_source(
        frontend, block);
    if (address_select) return address_select < 0 ? address_select : 0;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u;
        if (!pl_select_conditional_alu_body(block, &body, &condition)) return 0;
        int measured = pl_select_measure_direct_alu_frame(frontend, &body, selection);
        if (measured <= 0) return measured;
        pl_u32 bytes = selection->output_bytes;
        pl_u32 tail = block->relax_short_control ? 6u : 2u;
        if (bytes > U32_MAX_VALUE - tail || selection->output_instructions == U32_MAX_VALUE)
            return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + (block->relax_short_control ? 2u : 1u),
            bytes + tail, block->successor[0]);
        if (status) return status;
        selection->output_bytes += tail;
        ++selection->output_instructions;
        return 1;
    }
    if (block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && ((block->dynamic_target
                     && (block->successor_count != 0u
                         || block->construction_fields))
                    || (!block->dynamic_target
                        && block->successor_count != 1u)))
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE) {
        selection->blocking_work = 0xf001u;
        return 0;
    }
    pl_u32 changed, final_flag_node;
    if (!pl_select_alu_frame_shape(&block->plan, &changed, &final_flag_node)) {
        selection->blocking_work = 0xf002u;
        return 0;
    }
    /* Entry FLAGS must be consumed before a later predicate overwrites them.
     * The dense scheduler does not carry that entry generation across its
     * produced-flag schedule, so retain the linked instruction order. */
    if (pl_select_mixed_entry_and_produced_select_flags(&block->plan)) return 0;
    /* A result copied to multiple registers must not claim an input
     * register as scratch before its entry generation has been consumed. */
    if (pl_select_shared_alu_result_overwrites_entry(
            &block->plan, final_flag_node)) return 0;
    /* A late TEST can read an entry register after a subtraction result
     * has been published elsewhere. The dense frame must not borrow that
     * entry register as scratch and change the later predicate. */
    if (pl_select_independent_entry_flags_subtract_conflict(
            &block->plan, final_flag_node)) return 0;
    if (final_flag_node) {
        const pl_node *flags = &block->plan.nodes[final_flag_node - 1u];
        if (flags->opcode == PL_OPCODE_X86_FLAGS
                && flags->argument_count == 5u
                && flags->argument_at <= block->plan.argument_count
                && flags->argument_count
                   <= block->plan.argument_count - flags->argument_at) {
            const pl_operand *arguments =
                block->plan.arguments + flags->argument_at;
            pl_u32 mode = arguments[4].kind == PL_OPERAND_CONST
                        ? (pl_u32)(arguments[4].value >> 8u) & 7u : 0u;
            /* The dense value/flag frame emits its final ADC/SBB through
             * pl_select_measure_alu_pair.  That pair can build the word's operand tree,
             * but it has no cut between the tree and ADC in which to publish
             * an intermediate carry producer.  In particular SHL; CMP; ADC
             * cannot become SHL; ADC: the latter consumes SHL's CF. */
            if ((mode == 2u || mode == 4u)
                    && (arguments[0].kind != PL_OPERAND_LOCAL
                        || arguments[0].value != PL_X86_RFLAGS_LOCAL))
                return 0;
        }
    }
    /* The affine spelling may use an entry register as a scaled index.  If
     * that register has already published the shift result, applying the
     * same scale again reads a different generation.  Leave the exact
     * linked spelling available until the affine frame tracks publication
     * generations explicitly. */
    if (pl_select_published_shift_generation_conflict(&block->plan)) return 0;
    /* The dense scheduler keeps a final RCX publication after a pending
     * variable shift to protect entry CL.  If that shift instead consumes
     * the new RCX generation, reversing the order reads stale CL.  Leave
     * this topology to the exact instruction projection until the scheduler
     * can represent both physical generations explicitly. */
    if (pl_select_shift_count_requires_published_rcx(&block->plan)) return 0;
    if (final_flag_node) {
        const pl_node *flags = &block->plan.nodes[final_flag_node - 1u];
        if (flags->opcode == PL_OPCODE_X86_COMPARE || flags->opcode == PL_OPCODE_X86_TEST) {
            /* CMP/TEST replaces arithmetic flags, not DF/IF. A non-entry
             * preserved root needs its own emitted flag-prefix production. */
            if (!flags->argument_count || flags->argument_at >= block->plan.argument_count)
                return 0;
            pl_operand prior = block->plan.arguments[flags->argument_at];
            if (prior.kind == PL_OPERAND_LOCAL
                    && prior.value == PL_X86_RFLAGS_LOCAL) {
                /* Entry flags flow into CMP/TEST directly. */
            } else if (prior.kind == PL_OPERAND_NODE
                    && pl_select_flags_root_only_arithmetic(
                        &block->plan, (pl_u32)prior.value)) {
                /* The intermediate only perturbs flags CMP/TEST overwrite. */
            } else {
                return 0;
            }
        }
    }
    /* Preserve the responsible grammar on a red candidate so a preceding
     * broad frame probe cannot hide the exact dense-ALU rejection. */
    selection->direct_alu_frame = 1u;
    selection->value_alias_frame_count = selection->value_alias_count;
    entry_select_bit_test_frame entry_select_test;
    if (pl_select_entry_select_bit_test_frame_shape(
            block, changed, final_flag_node, &entry_select_test)) {
        pl_u32 frame_bytes = 0u;
        if (!pl_select_emit_entry_select_bit_test_frame(
                &entry_select_test, (pl_u8 *)0, &frame_bytes))
            return 0;
        selection->output_bytes = frame_bytes;
        selection->output_instructions = 4u;
        selection->supported = 1u;
        selection->direct_frame = 1u;
        selection->direct_alu_frame = 1u;
        selection->direct_nested_frame = 1u;
        selection->reason = PL_X86_NATIVE_SELECT_READY;
        return 1;
    }
    shared_parent_frame shared_parent;
    if (pl_select_shared_parent_frame_shape(
            block, changed, final_flag_node, &shared_parent))
        return pl_select_measure_shared_parent_frame(
            frontend, block, selection, &shared_parent);
    narrow_flag_transfer narrow_transfer;
    if (pl_select_narrow_flag_transfer_shape(block, &narrow_transfer))
        return pl_select_measure_narrow_flag_transfer(
            frontend, block, selection, &narrow_transfer);
    independent_flag_overwrite overwrite;
    if (pl_select_independent_flag_overwrite_shape(&block->plan, &overwrite)) {
        pl_u32 flag_bytes = 0u, value_bytes = 0u;
        if (!pl_select_emit_low8_alu_flags(
                overwrite.destination, overwrite.right, overwrite.mode,
                (pl_u8 *)0, &flag_bytes)
                || !pl_select_emit_scaled_lea(
                    overwrite.destination, overwrite.value_source,
                    overwrite.value_bits, overwrite.scale_log2,
                    (pl_u8 *)0, &value_bytes)
                || flag_bytes > U32_MAX_VALUE - value_bytes)
            return 0;
        selection->output_bytes = flag_bytes + value_bytes;
        selection->output_instructions = 2u;
        selection->supported = 1u;
        selection->direct_frame = 1u;
        selection->direct_alu_frame = 1u;
        selection->reason = PL_X86_NATIVE_SELECT_READY;
        return 1;
    }
    standalone_flag_publication exact_flags;
    compare_tree_flag tree_flag = { 0 };
    int has_compare_tree = final_flag_node
        && !pl_select_publication_emits_flag_node(
            &block->plan, changed, final_flag_node)
        && !pl_select_flag_node_has_value_publication(
            &block->plan, changed, final_flag_node)
        && pl_select_compare_tree_flag_shape(
            &block->plan, changed, final_flag_node, &tree_flag);
    if (final_flag_node
            && !pl_select_publication_emits_flag_node(
                &block->plan, changed, final_flag_node)
            && !pl_select_flag_node_has_value_publication(
                &block->plan, changed, final_flag_node)
            && !pl_select_standalone_flag_publication_details(
                &block->plan, final_flag_node, &exact_flags)
            && !has_compare_tree) {
        selection->blocking_work = 0xf003u;
        return 0;
    }
    pl_u32 bytes = 0u;
    pl_u32 instructions = 0u;
    pl_u32 span = 0u;
    pl_u32 frame_sources[PL_X86_GPR_COUNT];
    pl_u32 frame_dependencies[PL_X86_GPR_COUNT];
    if (!pl_select_alu_frame_source_laws(
            &block->plan, frame_sources, frame_dependencies)) {
        selection->blocking_work = 1u;
        return 0;
    }
    pl_select_add_flag_chain_dependencies(
        &block->plan, final_flag_node, frame_dependencies);
    if (!pl_select_apply_shared_flag_producer_laws(
            &block->plan, changed, final_flag_node,
            frame_sources, frame_dependencies))
        return 0;
    if (!pl_select_apply_select_candidate_laws(
            &block->plan, changed, frame_dependencies))
        return 0;
    shared_flag_select_handoff flag_select = { 0 };
    int has_flag_select = pl_select_shared_flag_select_handoff_shape(
        &block->plan, changed, final_flag_node, &flag_select);
    generation_join_handoff generation_join = { 0 };
    int has_generation_join = pl_select_generation_join_handoff_shape(
        &block->plan, changed, final_flag_node,
        frame_sources, &generation_join);
    if (has_flag_select && has_generation_join) return 0;
    if (has_generation_join) {
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(generation_join.preload_mask & (1u << local))) continue;
            pl_u32 part = 0u;
            int measured = pl_select_measure_frame_value(frontend, block, selection,
                local, block->plan.locals[local], bytes, &part);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            ++instructions;
        }
        pl_u32 seed_bytes = 0u, seed_work = 0u;
        pl_u32 seed_source = 0u, seed_bits = 0u;
        int measured = generation_join.seed.kind == PL_OPERAND_NODE
                    && pl_select_zero_extend_node(
                        &block->plan,
                        (pl_u32)generation_join.seed.value,
                        &seed_source, &seed_bits)
                    && seed_bits == generation_join.bits
            ? pl_select_emit_zero_extend_move(
                generation_join.destination, seed_source, seed_bits,
                (pl_u8 *)0, &seed_bytes)
            : pl_select_measure_alu_tree(
                frontend, block, selection, generation_join.destination,
                generation_join.seed, generation_join.bits, bytes,
                block->plan.node_count + 1u, generation_join.scratch_mask,
                &seed_bytes, &seed_work);
        if (measured && !seed_work) seed_work = 1u;
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - seed_bytes
                || instructions > U32_MAX_VALUE - seed_work) return 0;
        bytes += seed_bytes;
        instructions += seed_work;
        span = seed_work;
        if (!pl_select_apply_generation_join_laws(
                &block->plan, changed, &generation_join,
                frame_sources, frame_dependencies))
            return 0;
        selection->direct_nested_frame = 1u;
        selection->frame_alias_value = generation_join.seed.value;
        selection->frame_alias_kind = generation_join.seed.kind;
        selection->frame_alias_local =
            (pl_u8)generation_join.destination;
        selection->frame_alias_present = 1u;
    }
    standalone_flag_publication standalone_flags;
    int standalone_flags_pending = !pl_select_publication_emits_flag_node(
            &block->plan, changed, final_flag_node)
        && !pl_select_flag_node_has_value_publication(
            &block->plan, changed, final_flag_node)
        && pl_select_standalone_flag_publication_details(
            &block->plan, final_flag_node, &standalone_flags);
    pl_u32 pending = changed & ~generation_join.preload_mask;
    if (has_flag_select) {
        const pl_u32 arm[2] = {
            flag_select.candidate_first
                ? flag_select.candidate : flag_select.destination,
            flag_select.candidate_first
                ? flag_select.destination : flag_select.candidate,
        };
        for (pl_u32 index = 0u; index < 2u; ++index) {
            const pl_u32 local = arm[index];
            const pl_operand value = local == flag_select.destination
                ? flag_select.select.current : block->plan.locals[local];
            pl_u32 part = 0u, part_work = 0u;
            int measured = pl_select_measure_alu_tree(
                frontend, block, selection, local, value,
                flag_select.bits, bytes,
                block->plan.node_count + 1u, 0u,
                &part, &part_work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part
                    || instructions > U32_MAX_VALUE - part_work)
                return measured < 0 ? measured : 0;
            bytes += part;
            instructions += part_work;
        }
        pl_u32 part = 0u, part_work = 0u;
        int measured = pl_select_measure_alu_pair(
            frontend, block, selection, flag_select.flag_owner,
            flag_select.flag_left, flag_select.flag_right,
            flag_select.flag_bits, flag_select.flag_mode, 0u,
            bytes, block->plan.node_count + 1u, 0u,
            &part, &part_work);
        if (measured <= 0 || bytes > U32_MAX_VALUE - part
                || instructions > U32_MAX_VALUE - part_work)
            return measured < 0 ? measured : 0;
        bytes += part;
        instructions += part_work;
        if (!pl_select_emit_conditional_move(
                flag_select.destination, flag_select.candidate,
                flag_select.bits, flag_select.select.condition,
                (pl_u8 *)0, &part)
                || bytes > U32_MAX_VALUE - part
                || instructions == U32_MAX_VALUE)
            return 0;
        bytes += part;
        ++instructions;
        pending &= ~((1u << flag_select.destination)
                   | (1u << flag_select.candidate)
                   | (1u << flag_select.flag_owner));
        selection->direct_nested_frame = 1u;
    }
    if (!selection->frame_alias_present && !has_flag_select
            && !has_generation_join) {
        flag_value_preload preload;
        if (pl_select_flag_value_preload_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies, &preload)) {
            pl_u32 part = 0u, work = 0u;
            /* The preload's tree is measured before the alias that records its
             * destination is installed.  Install the same empty alias state
             * for the measurement so the write path below reproduces these
             * bytes exactly; the emitted preload subsequence is self-contained
             * and does not read the earlier alias. */
            pl_x86_native_selection preload_measure = *selection;
            preload_measure.frame_alias_present = 0u;
            int measured = pl_select_measure_alu_tree(
                frontend, block, &preload_measure, preload.destination,
                preload.tree, preload.tree_bits, bytes,
                block->plan.node_count + 1u, preload.scratch,
                &part, &work);
            if (measured > 0 && bytes <= U32_MAX_VALUE - part
                    && instructions <= U32_MAX_VALUE - work) {
                *selection = preload_measure;
                bytes += part;
                instructions += work;
                selection->frame_alias_value = preload.tree.value;
                selection->frame_alias_kind = preload.tree.kind;
                selection->frame_alias_local = (pl_u8)preload.destination;
                selection->frame_alias_present = 1u;
                /* The write path recomputes the preload shape from the same
                 * frame laws before it emits the tree; leaving the destination
                 * dependency relaxed here would make the write-path shape test
                 * fail and fall back to a different spelling. */
                frame_sources[preload.destination] =
                    preload.other_source | (1u << preload.destination);
                selection->direct_nested_frame = 1u;
            }
        }
    }
    selection->frame_alias_frame_kind = selection->frame_alias_kind;
    selection->frame_alias_frame_local = selection->frame_alias_local;
    selection->frame_alias_frame_present = selection->frame_alias_present;
    while (pending || standalone_flags_pending) {
        select_generation_group select_group;
        if (pl_select_select_generation_group_shape(&block->plan, pending,
                standalone_flags_pending ? standalone_flags.entry_sources : 0u, &select_group)
                && (standalone_flags_pending || select_group.select.compare_node == final_flag_node)) {
            pl_u32 part = 0u, work = 0u;
            int measured = pl_select_measure_select_generation_group(frontend, block, selection,
                &select_group, bytes, &part, &work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part
                    || instructions > U32_MAX_VALUE - work) return measured < 0 ? measured : 0;
            bytes += part; instructions += work;
            pending &= ~select_group.members;
            selection->direct_nested_frame = 1u;
            continue;
        }
        flag_result_group compare_bool;
        if (pl_select_compare_boolean_group_shape(
                &block->plan, pending, final_flag_node, &compare_bool)) {
            pl_u32 pre = 0u, pre_work = 0u, operation = 0u, post = 0u, post_work = 0u;
            pl_operand left = compare_bool.left, right = compare_bool.right;
            pl_select_physicalize_published_operand(&block->plan, PL_X86_GPR_COUNT, &left);
            pl_select_physicalize_published_operand(&block->plan, PL_X86_GPR_COUNT, &right);
            if (!pl_select_emit_group_booleans(&block->plan, &compare_bool, 1, 0, &pre, &pre_work)
                    || left.kind != PL_OPERAND_LOCAL
                    || left.value >= PL_X86_GPR_COUNT
                    || !pl_select_emit_flag_coordinate(
                        (pl_u32)left.value, right, compare_bool.bits,
                        compare_bool.test, 0u, (pl_u8 *)0, &operation)
                    || !pl_select_emit_group_booleans(&block->plan, &compare_bool, 0, 0, &post, &post_work)
                    || bytes > U32_MAX_VALUE - pre - operation - post
                    || instructions > U32_MAX_VALUE - pre_work - 1u - post_work)
                return 0;
            bytes += pre + operation + post;
            instructions += pre_work + 1u + post_work;
            pending &= ~compare_bool.members;
            standalone_flags_pending = 0;
            selection->direct_nested_frame = 1u;
            continue;
        }
        carry_alu_group carry_group;
        if (pl_select_carry_alu_group_shape(
                &block->plan, pending, final_flag_node, &carry_group)) {
            pl_u32 compare_bytes = 0u, operation_bytes = 0u;
            pl_u32 operation_work = 0u;
            if (!pl_select_emit_flag_coordinate(
                    (pl_u32)carry_group.compare_left.value,
                    carry_group.compare_right, carry_group.compare_bits,
                    carry_group.compare_test, 0u, (pl_u8 *)0, &compare_bytes))
                return 0;
            int measured = pl_select_measure_alu_pair(
                frontend, block, selection, carry_group.destination,
                carry_group.left, carry_group.right, carry_group.bits,
                carry_group.mode, 0u, bytes + compare_bytes,
                block->plan.node_count + 1u, 0u,
                &operation_bytes, &operation_work);
            if (measured <= 0) return measured < 0 ? measured : 0;
            if (bytes > U32_MAX_VALUE - compare_bytes - operation_bytes
                    || instructions > U32_MAX_VALUE - 1u - operation_work)
                return 0;
            bytes += compare_bytes + operation_bytes;
            instructions += 1u + operation_work;
            pending &= ~(1u << carry_group.destination);
            standalone_flags_pending = 0;
            selection->direct_nested_frame = 1u;
            continue;
        }
        flag_result_group alu_bool_group;
        pl_u32 alu_bool_deferred = 0u;
        if (pl_select_flag_result_group_shape(
                &block->plan, pending, &alu_bool_group, &alu_bool_deferred)) {
            pl_u32 pre = 0u, pre_work = 0u, operation = 0u;
            pl_u32 work = 0u, post = 0u, post_work = 0u;
            if (!pl_select_emit_group_booleans(
                    &block->plan, &alu_bool_group, 1, 0, &pre, &pre_work)
                    || bytes > U32_MAX_VALUE - pre)
                return 0;
            int measured = pl_select_measure_alu_pair(
                frontend, block, selection, alu_bool_group.owner,
                alu_bool_group.left, alu_bool_group.right,
                alu_bool_group.bits, alu_bool_group.mode, 0u,
                bytes + pre, block->plan.node_count + 1u, 0u,
                &operation, &work);
            if (measured <= 0
                    || !pl_select_emit_group_booleans(
                        &block->plan, &alu_bool_group, 0, 0, &post, &post_work)
                    || operation > U32_MAX_VALUE - pre
                    || post > U32_MAX_VALUE - pre - operation
                    || bytes > U32_MAX_VALUE - pre - operation - post
                    || work > U32_MAX_VALUE - pre_work - post_work
                    || instructions
                       > U32_MAX_VALUE - pre_work - work - post_work)
                return measured < 0 ? measured : 0;
            bytes += pre + operation + post;
            instructions += pre_work + work + post_work;
            pending &= ~alu_bool_group.members;
            selection->direct_nested_frame = 1u;
            continue;
        }
        if (standalone_flags_pending) {
            pl_u32 clobberers = 0u;
            for (pl_u32 local = 0u;
                    local < PL_X86_GPR_COUNT; ++local)
                if ((pending & (1u << local))
                        && pl_select_frame_local_emission_clobbers_flags(
                            &block->plan, local))
                    clobberers |= 1u << local;
            if (!clobberers
                    && !(standalone_flags.owner_dependencies & pending)) {
                pl_u32 flag_bytes = 0u;
                if (!pl_select_emit_standalone_flag_publication(
                        &standalone_flags, (pl_u8 *)0, &flag_bytes)
                        || bytes > U32_MAX_VALUE - flag_bytes
                        || instructions == U32_MAX_VALUE)
                    return 0;
                bytes += flag_bytes;
                ++instructions;
                standalone_flags_pending = 0;
                if (!pending) continue;
            }
        }
        if (has_compare_tree) {
            pl_u32 clobberers = 0u;
            for (pl_u32 local = 0u;
                    local < PL_X86_GPR_COUNT; ++local)
                if ((pending & (1u << local))
                        && pl_select_frame_local_emission_clobbers_flags(
                            &block->plan, local))
                    clobberers |= 1u << local;
            if (!clobberers
                    && !(tree_flag.owner_dependencies & pending)) {
                /* Only a register the frame is going to republish anyway may
                 * host the tree; an unchanged live-out entry register must not
                 * be clobbered.  pl_select_alu_frame_scratch_mask excludes the entry
                 * values other pending publications still read. */
                pl_u32 scratch_mask = pl_select_alu_frame_scratch_mask(
                    pending, PL_X86_GPR_COUNT, frame_sources);
                scratch_mask &= ~tree_flag.owner_dependencies;
                if (tree_flag.right.kind == PL_OPERAND_LOCAL)
                    scratch_mask &= ~(1u << (pl_u32)tree_flag.right.value);
                pl_u32 scratch = PL_X86_GPR_COUNT;
                for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
                    if (scratch_mask & (1u << local)) {
                        scratch = local;
                        break;
                    }
                if (scratch < PL_X86_GPR_COUNT) {
                    pl_u32 tree_bytes = 0u, tree_work = 0u, compare_bytes = 0u;
                    int measured = pl_select_measure_alu_tree(
                        frontend, block, selection, scratch, tree_flag.tree,
                        tree_flag.tree_bits, bytes,
                        block->plan.node_count + 1u, 0u,
                        &tree_bytes, &tree_work);
                    if (measured < 0) return measured;
                    if (measured > 0) {
                        if (!pl_select_emit_flag_coordinate(
                                scratch, tree_flag.right, tree_flag.bits,
                                tree_flag.test, 0u, (pl_u8 *)0, &compare_bytes)
                                || bytes > U32_MAX_VALUE - tree_bytes
                                           - compare_bytes
                                || instructions
                                   > U32_MAX_VALUE - tree_work - 1u)
                            return 0;
                        bytes += tree_bytes + compare_bytes;
                        instructions += tree_work + 1u;
                        has_compare_tree = 0;
                        continue;
                    }
                }
            }
        }
        shared_diamond_handoff diamond;
        if (pl_select_shared_diamond_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &diamond)) {
            pl_u32 parent_bytes = 0u, parent_work = 0u;
            int measured = pl_select_measure_alu_tree(
                frontend, block, selection, diamond.parent_owner,
                diamond.parent, diamond.bits, bytes,
                block->plan.node_count + 1u, 0u,
                &parent_bytes, &parent_work);
            pl_operand parent = {
                PL_OPERAND_LOCAL, diamond.parent_owner,
            };
            pl_u32 side_bytes = 0u, publish_bytes = 0u;
            pl_u32 shift_bytes = 0u, root_bytes = 0u;
            if (measured <= 0
                    || !pl_select_emit_alu_instruction(
                        diamond.side_owner, parent, diamond.bits,
                        diamond.side_mode, 0u,
                        (pl_u8 *)0, &side_bytes)
                    || !pl_select_emit_gpr_move(
                        diamond.root, diamond.side_owner, diamond.bits,
                        (pl_u8 *)0, &publish_bytes)
                    || !pl_select_emit_shift_instruction(
                        diamond.parent_owner, diamond.shift_amount,
                        diamond.bits, diamond.shift_group,
                        (pl_u8 *)0, &shift_bytes)
                    || !pl_select_emit_alu_instruction(
                        diamond.root, parent, diamond.bits,
                        diamond.root_mode, 0u,
                        (pl_u8 *)0, &root_bytes)
                    || parent_bytes > U32_MAX_VALUE - side_bytes
                    || parent_bytes + side_bytes
                       > U32_MAX_VALUE - publish_bytes
                    || parent_bytes + side_bytes + publish_bytes
                       > U32_MAX_VALUE - shift_bytes
                    || parent_bytes + side_bytes + publish_bytes
                       + shift_bytes > U32_MAX_VALUE - root_bytes
                    || parent_work > U32_MAX_VALUE - 4u)
                return measured < 0 ? measured : 0;
            pl_u32 group_bytes = parent_bytes + side_bytes + publish_bytes
                               + shift_bytes + root_bytes;
            if (bytes > U32_MAX_VALUE - group_bytes
                    || instructions > U32_MAX_VALUE - (parent_work + 4u))
                return PL_ERROR_X86_SELECT;
            bytes += group_bytes;
            instructions += parent_work + 4u;
            pl_u32 group_span = pl_select_node_wave_depth(
                &block->plan, block->plan.locals[diamond.root]);
            if (group_span == U32_MAX_VALUE)
                return PL_ERROR_X86_SELECT;
            ++group_span;
            if (group_span > span) span = group_span;
            pending &= ~(1u << diamond.root);
            selection->direct_nested_frame = 1u;
            continue;
        }
        arithmetic_width_handoff width_handoff;
        if (pl_select_arithmetic_width_handoff_shape(
                &block->plan, pending, frame_sources,
                frame_dependencies, &width_handoff)) {
            pl_u32 scratch_mask = pl_select_alu_frame_scratch_mask(
                pending, width_handoff.parent_destination,
                frame_sources);
            scratch_mask &= ~((1u << width_handoff.parent_destination)
                            | (1u << width_handoff.wide_destination)
                            | (1u << width_handoff.narrow_destination));
            pl_u32 parent_bytes = 0u, parent_work = 0u;
            int measured = pl_select_measure_alu_tree(
                frontend, block, selection,
                width_handoff.wide_destination, width_handoff.parent,
                64u, bytes, block->plan.node_count + 1u, scratch_mask,
                &parent_bytes, &parent_work);
            pl_u32 publish_bytes = 0u, operation_bytes = 0u;
            pl_u32 narrow_bytes = 0u;
            if (measured <= 0
                    || !pl_select_emit_gpr_move(
                        width_handoff.parent_destination,
                        width_handoff.wide_destination, 64u,
                        (pl_u8 *)0, &publish_bytes)
                    || !pl_select_emit_alu_instruction(
                        width_handoff.wide_destination,
                        width_handoff.right, 64u, width_handoff.mode, 0u,
                        (pl_u8 *)0, &operation_bytes)
                    || !pl_select_emit_gpr_move(
                        width_handoff.narrow_destination,
                        width_handoff.wide_destination, 32u,
                        (pl_u8 *)0, &narrow_bytes)
                    || parent_bytes > U32_MAX_VALUE - publish_bytes
                    || parent_bytes + publish_bytes
                       > U32_MAX_VALUE - operation_bytes
                    || parent_bytes + publish_bytes + operation_bytes
                       > U32_MAX_VALUE - narrow_bytes
                    || parent_work > U32_MAX_VALUE - 3u)
                return measured < 0 ? measured : 0;
            pl_u32 group_bytes = parent_bytes + publish_bytes
                               + operation_bytes + narrow_bytes;
            if (bytes > U32_MAX_VALUE - group_bytes
                    || instructions > U32_MAX_VALUE - (parent_work + 3u))
                return PL_ERROR_X86_SELECT;
            bytes += group_bytes;
            instructions += parent_work + 3u;
            pl_u32 group_span = pl_select_node_wave_depth(
                &block->plan, width_handoff.parent);
            if (parent_work > group_span) group_span = parent_work;
            if (group_span > U32_MAX_VALUE - 3u)
                return PL_ERROR_X86_SELECT;
            group_span += 3u;
            if (group_span > span) span = group_span;
            pending &= ~((1u << width_handoff.parent_destination)
                       | (1u << width_handoff.wide_destination)
                       | (1u << width_handoff.narrow_destination));
            selection->direct_nested_frame = 1u;
            continue;
        }
        shift_sibling_handoff handoff;
        if (pl_select_shift_sibling_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, &handoff)) {
            pl_u32 part = 0u, part_work = 0u;
            if (handoff.scratch == PL_X86_GPR_COUNT) {
                if (!pl_select_emit_gpr_move(
                        handoff.flag_destination, handoff.source,
                        handoff.bits, (pl_u8 *)0, &part)
                        || bytes > U32_MAX_VALUE - part)
                    return 0;
                bytes += part;
                ++instructions;
                if (!pl_select_emit_shift_instruction(
                        handoff.sibling_destination,
                        handoff.sibling_amount, handoff.bits,
                        handoff.sibling_group, (pl_u8 *)0, &part)
                        || bytes > U32_MAX_VALUE - part)
                    return 0;
                bytes += part;
                ++instructions;
                if (!pl_select_emit_shift_instruction(
                        handoff.flag_destination, handoff.flag_amount,
                        handoff.bits, handoff.flag_group,
                        (pl_u8 *)0, &part)
                        || bytes > U32_MAX_VALUE - part)
                    return 0;
                bytes += part;
                ++instructions;
                pending &= ~((1u << handoff.flag_destination)
                           | (1u << handoff.sibling_destination));
                selection->direct_nested_frame = 1u;
                continue;
            }
            int measured = pl_select_measure_alu_tree(
                frontend, block, selection, handoff.scratch,
                handoff.sibling_value, handoff.bits, bytes,
                block->plan.node_count + 1u, 0u, &part, &part_work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            if (instructions > U32_MAX_VALUE - part_work)
                return PL_ERROR_X86_SELECT;
            instructions += part_work;
            measured = pl_select_measure_alu_tree(
                frontend, block, selection, handoff.flag_destination,
                handoff.flag_value, handoff.bits, bytes,
                block->plan.node_count + 1u, 0u, &part, &part_work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            if (instructions > U32_MAX_VALUE - part_work)
                return PL_ERROR_X86_SELECT;
            instructions += part_work;
            if (!pl_select_emit_gpr_move(
                    handoff.sibling_destination, handoff.scratch,
                    handoff.bits, (pl_u8 *)0, &part)
                    || bytes > U32_MAX_VALUE - part)
                return 0;
            bytes += part;
            ++instructions;
            measured = pl_select_measure_frame_value(
                frontend, block, selection, handoff.scratch,
                block->plan.locals[handoff.scratch], bytes, &part);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            ++instructions;
            pending &= ~((1u << handoff.flag_destination)
                       | (1u << handoff.sibling_destination)
                       | (1u << handoff.scratch));
            selection->direct_nested_frame = 1u;
            continue;
        }
        pl_u32 local = 0u;
        if (!pl_select_next_alu_frame_assignment(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &local)) {
            shared_root_unary_handoff root_handoff;
            if (pl_select_shared_root_unary_handoff_shape(
                    &block->plan, pending, final_flag_node, &root_handoff)) {
                pl_u32 seed_bytes = 0u, seed_work = 0u, copy_bytes = 0u;
                pl_u32 op_a = 0u, op_b = 0u;
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, root_handoff.seed_dest,
                    root_handoff.seed, root_handoff.seed_bits, bytes,
                    block->plan.node_count + 1u, 0u, &seed_bytes, &seed_work);
                if (measured > 0
                        && pl_select_emit_gpr_move(root_handoff.copy_dest,
                            root_handoff.seed_dest, root_handoff.bits,
                            0, &copy_bytes)
                        && pl_select_emit_shared_root_consumer(
                            &root_handoff.dest_consumer, 0, &op_a)
                        && pl_select_emit_shared_root_consumer(
                            &root_handoff.copy_consumer, 0, &op_b)
                        && seed_bytes <= U32_MAX_VALUE - copy_bytes
                        && seed_bytes + copy_bytes
                           <= U32_MAX_VALUE - op_a
                        && seed_bytes + copy_bytes + op_a
                           <= U32_MAX_VALUE - op_b
                        && seed_work <= U32_MAX_VALUE - 3u
                        && instructions
                           <= U32_MAX_VALUE - seed_work - 3u) {
                    bytes += seed_bytes + copy_bytes + op_a + op_b;
                    instructions += seed_work + 3u;
                    pending &= ~((1u << root_handoff.seed_dest)
                               | (1u << root_handoff.copy_dest));
                    selection->direct_nested_frame = 1u;
                    continue;
                }
                if (measured < 0) return measured;
            }
            pl_u32 first = 0u;
            while (first < PL_X86_GPR_COUNT
                    && !(pending & (1u << first)))
                ++first;
            selection->blocking_work = 0x200u | first;
            selection->blocking_opcode = first < PL_X86_GPR_COUNT
                ? frame_sources[first]
                  | (frame_dependencies[first] << 16u)
                : U32_MAX_VALUE;
            selection->projected_instruction_mask = pending;
            return 0;
        }
        pl_u32 scratch_mask = pl_select_alu_frame_scratch_mask(
            pending, local, frame_sources);
        pl_u32 encoded = 0u;
        pl_u32 publication_work = 1u;
        pl_u32 publication_span = 1u;
        pl_operand value = block->plan.locals[local];
        masked_entry_affine entry_affine;
        pl_u32 publication = pl_select_publication_owner(&block->plan, value);
        if (has_generation_join
                && local == generation_join.destination) {
            if (!pl_select_emit_generation_join(&generation_join, 0, &encoded))
                return 0;
            publication_work = 1u + generation_join.tail_present;
            publication_span = publication_work;
        } else if (publication < PL_X86_GPR_COUNT
                && publication != local) {
            pl_u32 bits = pl_select_publication_copy_bits(
                &block->plan, selection, value, bytes);
            pl_u32 move_bytes = 0u;
            if (!pl_select_emit_gpr_move(
                    local, publication, bits,
                    (pl_u8 *)0, &move_bytes))
                return 0;
            encoded = move_bytes;
            if (value.kind == PL_OPERAND_CONST && !value.value) {
                pl_u32 zero_bytes = 0u;
                if (!pl_select_emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes))
                    return 0;
                if (zero_bytes < encoded) encoded = zero_bytes;
            }
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            {
                pl_u32 destination, bits, mode, preserves_carry;
                pl_operand source;
                pl_operand right;
                pl_operand scan_seed;
                pl_u32 seed_bits = 0u, source_local = 0u;
                if (pl_select_bit_summary_frame(&block->plan, selection, value, local,
                        &scan_seed, &seed_bits, &source_local, &bits, &mode)) {
                    pl_u32 prefix = 0u, work = 0u, operation = 0u;
                    pl_u32 seed_scratch = scratch_mask & ~(1u << source_local);
                    if (pl_select_measure_alu_tree(frontend, block, selection, local,
                            scan_seed, seed_bits, bytes, block->plan.node_count + 1u,
                            seed_scratch, &prefix, &work) <= 0) return 0;
                    if (!pl_select_emit_bit_summary(local, source_local, bits, mode, 0, &operation)
                            || prefix > U32_MAX_VALUE - operation
                            || work == U32_MAX_VALUE) return 0;
                    encoded = prefix + operation;
                    publication_work = work + 1u;
                } else {
                if (!pl_select_alu_node_details(
                        &block->plan, (pl_u32)(value.value >> 8u),
                        &destination, &source, &right,
                        &bits, &mode, &preserves_carry)
                        || destination != local) {
                    selection->blocking_work = 0x100u | local;
                    return 0;
                }
                if (!preserves_carry && mode == 3u
                        && source.kind == PL_OPERAND_CONST && !source.value
                        && right.kind == PL_OPERAND_LOCAL
                        && right.value == local) {
                    if (!pl_select_emit_neg_register(
                            local, bits, 0, &encoded))
                        return 0;
                    publication_work = 1u;
                } else {
                    int measured = pl_select_measure_alu_pair(
                        frontend, block, selection, local, source, right,
                        bits, mode, preserves_carry, bytes,
                        block->plan.node_count + 1u, scratch_mask,
                        &encoded, &publication_work);
                    if (measured <= 0) {
                        selection->blocking_work = 0x200u | local;
                        return measured;
                    }
                }
                }
            }
        } else if (value.kind == PL_OPERAND_NODE) {
            value = pl_select_publication_for_emission(
                &block->plan, value, final_flag_node);
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u;
            pl_operand identity_source = { 0 };
            pl_u32 add3_pair_node = 0u, add3_pair_local = 0u, add3_pair_bits = 0u;
            pl_operand add3_pair_remaining = { 0 };
            pl_operand shift_source, shift_amount;
            pl_u32 shift_group = 0u;
            conditional_select select;
            quotient_boundary_select boundary;
            carry_adjustment adjustment;
            pl_operand bit_source;
            pl_u32 bit = 0u;
            pl_operand flag_left, flag_right;
            pl_operand lane_inner;
            pl_operand lane_base;
            pl_u32 lane_width = 0u;
            pl_u64 lane_constant = 0u;
            pl_u32 insert_condition = 0u;
            pl_u32 flag_mode = 0u, preserves_carry = 0u;
            if (final_flag_node && value.value == final_flag_node
                    && pl_select_alu_node_semantics(
                        &block->plan, final_flag_node, &flag_left,
                        &flag_right, &bits, &flag_mode,
                        &preserves_carry)) {
                int measured = pl_select_measure_alu_pair(
                    frontend, block, selection, local,
                    flag_left, flag_right, bits, flag_mode,
                    preserves_carry, bytes,
                    block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x260u | local;
                    return measured;
                }
            } else if (final_flag_node && pl_select_flag_value_operation_details(
                    &block->plan, final_flag_node, value,
                    &flag_left, &flag_right, &bits,
                    &flag_mode, &preserves_carry)) {
                pl_u32 prefix = 0u, prefix_work = 0u;
                if (!pl_select_prepare_partial_flag_publication(
                        &block->plan, block->plan.locals[local], local,
                        bits, &flag_left, &flag_right, 0,
                        &prefix, &prefix_work)
                        || bytes > U32_MAX_VALUE - prefix)
                    return 0;
                int measured = pl_select_measure_alu_pair(
                    frontend, block, selection, local,
                    flag_left, flag_right, bits, flag_mode,
                    preserves_carry, bytes + prefix,
                    block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x260u | local;
                    return measured;
                }
                if (encoded > U32_MAX_VALUE - prefix
                        || publication_work > U32_MAX_VALUE - prefix_work)
                    return PL_ERROR_X86_SELECT;
                encoded += prefix;
                publication_work += prefix_work;
            } else if (final_flag_node
                    && !pl_select_publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && pl_select_masked_entry_affine_details(
                        &block->plan, value, local, &entry_affine)
                    && (scratch_mask & (1u << entry_affine.source))) {
                if (!pl_select_emit_masked_entry_affine(
                        &entry_affine, (pl_u8 *)0,
                        &encoded, &publication_work))
                    return 0;
                selection->direct_nested_frame = 1u;
            } else if (final_flag_node
                    && !pl_select_publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && pl_select_single_bit_or_details(
                        &block->plan, value, &bit_source, &bits, &bit)) {
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, bit_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                pl_u32 operation = 0u;
                if (measured <= 0
                        || !pl_select_emit_bit_set_immediate(
                            local, bit, bits, (pl_u8 *)0, &operation)
                        || seed_bytes > U32_MAX_VALUE - operation
                        || seed_work == U32_MAX_VALUE) {
                    selection->blocking_work = 0x280u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + operation;
                publication_work = seed_work + 1u;
            } else if (final_flag_node
                    && !pl_select_publication_is_flag_result(&block->plan, value, final_flag_node)
                    && !pl_select_publication_emits_selected_flag(&block->plan, value, local, final_flag_node)
                    && pl_select_carry_adjustment_details(&block->plan, value, local,
                        pl_select_operand_fits_u32(&block->plan, value, block->plan.node_count + 1u)
                            ? 32u : 64u, &adjustment)) {
                if (!pl_select_emit_carry_adjustment(&adjustment, local, 0,
                        &encoded, &publication_work)) return 0;
                selection->direct_nested_frame = 1u;
            } else if (pl_select_quotient_boundary_select_details(
                    &block->plan, value, local, &boundary)) {
                int measured = pl_select_measure_quotient_boundary_select(
                    frontend, block, selection, local, &boundary,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x2c0u | local;
                    return measured;
                }
            } else if (pl_select_conditional_select_details_inner(
                    &block->plan, value, local, 1, &select)) {
                if (select.candidate_local == local
                        || !pl_select_conditional_compare_survives_current(
                            &select, local))
                    return 0;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = select.current_flag_node
                    ? pl_select_measure_selected_flag_value(frontend, block, selection, local, &select,
                        bytes, block->plan.node_count + 1u, scratch_mask, &seed_bytes, &seed_work)
                    : pl_select_measure_alu_tree(
                    frontend, block, selection, local, current,
                    select.value_bits, bytes,
                    block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                /* Seed the compare operand(s) before the true-arm candidate,
                 * mirroring the write path exactly: the seed resolves the
                 * `current` value through `local` and the candidate then reuses
                 * the coordinate the seed finishes with. */
                pl_x86_native_selection seed_state = *selection;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && current.value)
                    pl_select_push_frame_value_alias(
                        &seed_state, (pl_u8)current.kind, current.value,
                        (pl_u8)local);
                pl_u32 used = scratch_mask & ~(1u << local);
                pl_u32 cand_local = select.candidate_local;
                if (!select.candidate_immediate
                        && cand_local < PL_X86_GPR_COUNT)
                    used &= ~(1u << cand_local);
                pl_u32 cand_bytes = 0u, cand_work = 0u;
                pl_u32 compare_bytes = 0u, move_bytes = 0u;
                pl_u32 compare_seed_bytes = 0u, compare_seed_work = 0u;
                if (measured > 0
                        && (select.compare_left_seed
                            || select.compare_right_seed)) {
                    if (select.compare_left_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        pl_u32 part = 0u, work = 0u;
                        if (scratch >= PL_X86_GPR_COUNT
                                || pl_select_measure_alu_tree(
                                    frontend, block, &seed_state, scratch,
                                    select.compare_left_value,
                                    select.compare_bits,
                                    bytes + seed_bytes,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    &part, &work) <= 0)
                            measured = 0;
                        else {
                            used &= ~(1u << scratch);
                            select.compare_left_local = scratch;
                            compare_seed_bytes += part;
                            compare_seed_work += work;
                        }
                    }
                    if (measured > 0 && select.compare_right_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        pl_u32 part = 0u, work = 0u;
                        if (scratch >= PL_X86_GPR_COUNT
                                || pl_select_measure_alu_tree(
                                    frontend, block, &seed_state, scratch,
                                    select.compare_right_value,
                                    select.compare_bits,
                                    bytes + seed_bytes + compare_seed_bytes,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    &part, &work) <= 0)
                            measured = 0;
                        else {
                            used &= ~(1u << scratch);
                            select.compare_right.kind = PL_OPERAND_LOCAL;
                            select.compare_right.value = scratch;
                            compare_seed_bytes += part;
                            compare_seed_work += work;
                        }
                    }
                }
                if (measured > 0 && select.candidate_immediate) {
                    cand_local = PL_X86_GPR_COUNT;
                    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                            ++scratch)
                        if (scratch != local
                                && (used & (1u << scratch))) {
                            cand_local = scratch;
                            break;
                        }
                    if (cand_local >= PL_X86_GPR_COUNT) {
                        selection->blocking_work = 0x300u | local;
                        return 0;
                    }
                    measured = pl_select_measure_alu_tree(
                        frontend, block, selection, cand_local,
                        select.candidate_value, select.value_bits,
                        bytes + seed_bytes + compare_seed_bytes,
                        block->plan.node_count + 1u,
                        used & ~(1u << cand_local),
                        &cand_bytes, &cand_work);
                }
                pl_u32 emit_compare = select.has_compare
                    && (select.compare_node != final_flag_node
                        || !pl_select_flag_node_has_value_publication(
                            &block->plan, changed, final_flag_node));
                int compared = !emit_compare
                    || pl_select_emit_select_compare(&select, 0, &compare_bytes);
                if (measured <= 0 || !compared
                        || !pl_select_emit_conditional_move(
                            local, cand_local,
                            select.value_bits, select.condition,
                            (pl_u8 *)0, &move_bytes)
                        || seed_bytes > U32_MAX_VALUE - cand_bytes
                        || seed_bytes + cand_bytes
                           > U32_MAX_VALUE - compare_seed_bytes
                        || seed_bytes + cand_bytes + compare_seed_bytes
                           > U32_MAX_VALUE - compare_bytes
                        || seed_bytes + cand_bytes + compare_seed_bytes
                           + compare_bytes > U32_MAX_VALUE - move_bytes
                        || cand_work > U32_MAX_VALUE - seed_work
                        || cand_work + seed_work
                           > U32_MAX_VALUE - compare_seed_work) {
                    selection->blocking_work = 0x300u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + cand_bytes + compare_seed_bytes
                        + compare_bytes + move_bytes;
                publication_work = seed_work + cand_work + compare_seed_work
                                 + 1u + emit_compare;
            } else if (pl_select_sign_high_node_details(
                    &block->plan, value, &source, &bits)) {
                if (!pl_select_emit_sign_high(
                        local, source, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (pl_select_masked_shift_count_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group) && local != 1u) {
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, shift_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                pl_u32 count_bytes = 0u, count_work = 0u;
                if (measured > 0)
                    measured = pl_select_measure_alu_tree(
                        frontend, block, selection, 1u, shift_amount, 32u,
                        bytes + seed_bytes, block->plan.node_count + 1u,
                        scratch_mask & ~(1u << 1u),
                        &count_bytes, &count_work);
                pl_u32 shift_bytes = 0u;
                if (measured <= 0
                        || !pl_select_emit_shift_instruction(
                            local, (pl_operand){ PL_OPERAND_LOCAL, 1u },
                            bits, shift_group, (pl_u8 *)0, &shift_bytes)
                        || bytes > U32_MAX_VALUE - seed_bytes
                        || seed_bytes > U32_MAX_VALUE - count_bytes
                        || seed_bytes + count_bytes
                           > U32_MAX_VALUE - shift_bytes
                        || seed_work > U32_MAX_VALUE - count_work
                        || seed_work + count_work == U32_MAX_VALUE) {
                    selection->blocking_work = 0x400u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + count_bytes + shift_bytes;
                publication_work = seed_work + count_work + 1u;
            } else if (pl_select_shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, shift_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                pl_u32 shift_bytes = 0u;
                if (measured <= 0
                        || !pl_select_emit_shift_instruction(
                            local, shift_amount, bits, shift_group,
                            (pl_u8 *)0, &shift_bytes)
                        || seed_bytes > U32_MAX_VALUE - shift_bytes) {
                    selection->blocking_work = 0x400u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + shift_bytes;
                publication_work = seed_work + 1u;
            } else if (pl_select_shared_dag_add3_published_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_local, &add3_pair_remaining, &add3_pair_bits)) {
                pl_operand pair = { PL_OPERAND_LOCAL, add3_pair_local };
                int measured = pl_select_measure_alu_pair(
                    frontend, block, selection, local, pair,
                    add3_pair_remaining, add3_pair_bits, 1u, 0u,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
            } else if (pl_select_shared_dag_add3_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_node, &add3_pair_remaining, &add3_pair_bits)) {
                /* An ADD3 whose two operands are already an earlier binary ADD
                 * shares that sum.  Take it before the affine LEA, which would
                 * otherwise rebuild the shared pair inside this tree and cost
                 * the shared producer twice.  When another pending publication
                 * needs the same pair as its destructive arm, build the pair in
                 * that consumer's coordinate so both publications share one
                 * materialization. */
                pl_operand pair = { PL_OPERAND_NODE, add3_pair_node };
                pl_u32 consumer = pl_select_alu_add3_pair_consumer(
                    &block->plan, pending, add3_pair_node, local);
                int share_pair = consumer < PL_X86_GPR_COUNT
                    && (scratch_mask & (1u << consumer))
                    && add3_pair_remaining.kind == PL_OPERAND_LOCAL
                    && add3_pair_remaining.value < PL_X86_GPR_COUNT;
                pl_operand pair_left = share_pair
                    ? add3_pair_remaining : pair;
                pl_operand pair_right = share_pair
                    ? pair : add3_pair_remaining;
                int measured = pl_select_measure_alu_pair(
                    frontend, block, selection, local, pair_left,
                    pair_right, add3_pair_bits, 1u, 0u,
                    bytes, block->plan.node_count + 1u,
                    share_pair ? (1u << consumer) : scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
                if (share_pair)
                    pl_select_push_frame_value_alias(
                        selection, PL_OPERAND_NODE, add3_pair_node,
                        (pl_u8)consumer);
            } else if (pl_select_collect_native_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form, &bits)) {
                if (!pl_select_emit_affine_lea_width(
                        local, form, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (pl_select_sign_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!pl_select_emit_sign_extend_move(
                        local, source, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (pl_select_zero_extend_high8_node(
                    &block->plan, (pl_u32)value.value, &source)) {
                if (!pl_select_emit_zero_extend_high8(
                        local, source, (pl_u8 *)0, &encoded))
                    return 0;
                selection->direct_nested_frame = 1u;
            } else if (pl_select_zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!pl_select_emit_zero_extend_move(
                        local, source, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (pl_select_zero_extend_operand(
                    &block->plan, (pl_u32)value.value, &lane_inner, &lane_width)
                    && lane_width == 32u) {
                /* A 64-bit inner operation can retain nonzero high bits even
                 * when the caller requests a 32-bit result.  A final 32-bit
                 * self move publishes the exact zero-extended lane. */
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, lane_inner, 32u,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
                if (pl_select_lane32_shift_inner_needs_truncation(
                        &block->plan, lane_inner)) {
                    pl_u32 extend = 0u;
                    if (!pl_select_emit_zero_extend_move(
                            local, local, 32u, (pl_u8 *)0, &extend)
                            || encoded > U32_MAX_VALUE - extend
                            || publication_work == U32_MAX_VALUE)
                        return 0;
                    encoded += extend;
                    ++publication_work;
                }
            } else if (pl_select_zero_extend_operand(
                    &block->plan, (pl_u32)value.value, &lane_inner, &lane_width)
                    && (lane_width == 8u || lane_width == 16u)) {
                /* A narrow zero extension of an inner value with no
                 * publication: materialize the inner at its own width, then
                 * MOVZX the requested lane.  MOVZX preserves the shift's
                 * flags, so the final flag node stays the shift. */
                pl_u32 inner_bits = pl_select_operand_expression_bits(
                    &block->plan, lane_inner, 64u);
                if (!inner_bits) inner_bits = 64u;
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, lane_inner, inner_bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
                pl_u32 extend = 0u;
                if (!pl_select_emit_zero_extend_move(
                        local, local, lane_width, (pl_u8 *)0, &extend)
                        || encoded > U32_MAX_VALUE - extend
                        || publication_work == U32_MAX_VALUE)
                    return 0;
                encoded += extend;
                ++publication_work;
            } else if (pl_select_in_place_condition_insert(
                    &block->plan, value, local, &insert_condition)) {
                if (!pl_select_emit_set_condition(
                        local, insert_condition, (pl_u8 *)0, &encoded))
                    return 0;
                publication_work = 1u;
            } else if (pl_select_in_place_lane_insert(
                    &block->plan, value, local, &lane_inner, &lane_width)) {
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, lane_inner, lane_width,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
            } else if (pl_select_lane_constant_insert(
                    &block->plan, value, local, &lane_base,
                    &lane_constant, &lane_width)) {
                pl_u32 prefix = 0u, prefix_work = 0u, move = 0u;
                int measured = 1;
                if (!(lane_base.kind == PL_OPERAND_LOCAL
                        && lane_base.value == local)) {
                    measured = pl_select_measure_alu_tree(
                        frontend, block, selection, local, lane_base,
                        pl_select_operand_expression_bits(
                            &block->plan, lane_base, 64u),
                        bytes, block->plan.node_count + 1u, scratch_mask,
                        &prefix, &prefix_work);
                }
                if (measured <= 0
                        || !pl_select_emit_lane_constant_move(
                            local, lane_constant, lane_width,
                            (pl_u8 *)0, &move)
                        || prefix > U32_MAX_VALUE - move
                        || prefix_work == U32_MAX_VALUE) {
                    selection->blocking_work = 0x600u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = prefix + move;
                publication_work = prefix_work + 1u;
            } else if (value.kind == PL_OPERAND_NODE && value.value
                    && value.value <= block->plan.node_count
                    && (block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE32_BSWAP
                        || block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE64_BSWAP)) {
                pl_u32 bswap_bits = block->plan.nodes[value.value - 1u].opcode
                                  == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
                pl_operand source_operand = block->plan.arguments[
                    block->plan.nodes[value.value - 1u].argument_at];
                pl_u32 seed_bytes = 0u, seed_work = 0u, bswap_bytes = 0u;
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, source_operand,
                    bswap_bits, bytes, block->plan.node_count + 1u,
                    scratch_mask, &seed_bytes, &seed_work);
                if (measured <= 0
                        || !pl_select_emit_bswap_register(
                            local, bswap_bits, (pl_u8 *)0, &bswap_bytes)
                        || bytes > U32_MAX_VALUE - seed_bytes
                        || seed_bytes > U32_MAX_VALUE - bswap_bytes
                        || seed_work == U32_MAX_VALUE) {
                    selection->blocking_work = 0x600u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + bswap_bytes;
                publication_work = seed_work + 1u;
            } else if ((pl_u32)value.value != final_flag_node
                    && pl_select_lane_identity_mask_details(
                        &block->plan, value, &identity_source, &bits)) {
                int measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, identity_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
            } else {
                bits = pl_select_operand_expression_bits(&block->plan, value, 0u);
                if (!bits) {
                    selection->blocking_work = 0x500u | local;
                    return 0;
                }
                pl_u32 root_sources = 0u;
                pl_x86_native_selection checkpoint = *selection;
                pl_x86_native_selection owner_choice = checkpoint;
                pl_u32 owner_bytes = 0u, owner_work = 0u;
                int owner_measured = 0;
                if (pl_select_operand_entry_gpr_sources(
                        &block->plan, value,
                        block->plan.node_count + 1u,
                        block->plan.node_count + 1u, &root_sources)
                        && !(root_sources & (1u << local))) {
                    for (pl_u32 owner = 0u;
                            owner < PL_X86_GPR_COUNT; ++owner) {
                        pl_u32 owner_bit = 1u << owner;
                        if (!(scratch_mask & owner_bit)
                                || !(root_sources & owner_bit))
                            continue;
                        pl_x86_native_selection trial = checkpoint;
                        pl_u32 tree_bytes = 0u, tree_work = 0u;
                        int trial_measured = pl_select_measure_alu_tree(
                            frontend, block, &trial, owner, value, bits,
                            bytes, block->plan.node_count + 1u,
                            scratch_mask & ~owner_bit,
                            &tree_bytes, &tree_work);
                        pl_u32 move_bytes = 0u;
                        if (trial_measured > 0
                                && pl_select_emit_gpr_move(
                                    local, owner, bits,
                                    (pl_u8 *)0, &move_bytes)
                                && tree_bytes
                                   <= U32_MAX_VALUE - move_bytes
                                && tree_work != U32_MAX_VALUE) {
                            owner_bytes = tree_bytes + move_bytes;
                            owner_work = tree_work + 1u;
                            trial.direct_nested_frame = 1u;
                            owner_choice = trial;
                            owner_measured = 1;
                            break;
                        }
                        if (trial_measured < 0) return trial_measured;
                    }
                }
                pl_x86_native_selection direct_choice = checkpoint;
                pl_u32 direct_bytes = 0u, direct_work = 0u;
                int direct_measured = pl_select_measure_alu_tree(
                    frontend, block, &direct_choice, local, value, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &direct_bytes, &direct_work);
                if (direct_measured < 0) return direct_measured;
                int measured = owner_measured || direct_measured > 0;
                if (direct_measured > 0
                        && (!owner_measured || direct_work < owner_work)) {
                    direct_choice.frame_direct_destination_mask |=
                        1u << local;
                    direct_choice.direct_nested_frame = 1u;
                    *selection = direct_choice;
                    encoded = direct_bytes;
                    publication_work = direct_work;
                } else if (owner_measured) {
                    *selection = owner_choice;
                    encoded = owner_bytes;
                    publication_work = owner_work;
                }
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    selection->projected_instruction_mask = scratch_mask;
                    return measured;
                }
            }
        } else {
            int measured = pl_select_measure_frame_value(
                frontend, block, selection, local, value, bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        if (instructions > U32_MAX_VALUE - publication_work)
            return PL_ERROR_X86_SELECT;
        instructions += publication_work;
        pl_u32 wave_depth = pl_select_node_wave_depth(&block->plan, value);
        if (wave_depth > publication_span) publication_span = wave_depth;
        if (publication_work > publication_span)
            publication_span = publication_work;
        if (publication_span > span) span = publication_span;
        pending &= ~(1u << local);
    }
    /* The compare-over-tree shape was accepted by the guard but its tree could
     * not be materialized, so the final flags were never produced.  Declining
     * keeps the block an escape instead of emitting a stale-flag candidate. */
    if (has_compare_tree) return 0;
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = 0u;
        if (block->dynamic_target) {
            pl_u32 target_owner = PL_X86_GPR_COUNT;
            if (!pl_select_published_operand_local(
                    &block->plan, block->target, &target_owner)
                    || !pl_select_emit_indirect_jump(
                        target_owner, (pl_u8 *)0, &branch_bytes))
                return 0;
        } else {
            branch_bytes = block->relax_short_control ? 5u : 2u;
            if (bytes > U32_MAX_VALUE - branch_bytes)
                return PL_ERROR_X86_SELECT;
            int status = pl_select_append_control_fixup(
                frontend, block, selection,
                (pl_u8)(block->relax_short_control ? 4u : 1u),
                bytes + 1u, bytes + branch_bytes, block->successor[0]);
            if (status) return status;
        }
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_alu_frame(const pl_x86_block *block,
                                  const pl_x86_native_selection *selection,
                                  pl_u8 *output)
{
    if (!block || !selection || !selection->direct_alu_frame || !output)
        return PL_ERROR_X86_SELECT;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u, tail = block->relax_short_control ? 6u : 2u;
        if (!pl_select_conditional_alu_body(block, &body, &condition)
                || selection->output_bytes < tail) return PL_ERROR_X86_SELECT;
        pl_x86_native_selection body_selection = *selection;
        body_selection.output_bytes -= tail;
        int status = pl_select_write_direct_alu_frame(&body, &body_selection, output);
        if (status) return status;
        pl_u32 at = body_selection.output_bytes;
        if (block->relax_short_control) output[at++] = 0x0fu;
        output[at++] = (pl_u8)((block->relax_short_control ? 0x80u : 0x70u) | condition);
        while (at < selection->output_bytes) output[at++] = 0u;
        return 0;
    }
    pl_u32 changed, final_flag_node;
    if (!pl_select_alu_frame_shape(&block->plan, &changed, &final_flag_node))
        return PL_ERROR_X86_SELECT;
    entry_select_bit_test_frame entry_select_test;
    if (pl_select_entry_select_bit_test_frame_shape(
            block, changed, final_flag_node, &entry_select_test)) {
        pl_u32 written = 0u;
        if (!pl_select_emit_entry_select_bit_test_frame(
                &entry_select_test, output, &written)
                || written != selection->output_bytes)
            return PL_ERROR_X86_SELECT;
        return 0;
    }
    if (selection->direct_shared_parent_frame) {
        shared_parent_frame shared_parent;
        if (!pl_select_shared_parent_frame_shape(
                block, changed, final_flag_node, &shared_parent))
            return PL_ERROR_X86_SELECT;
        return pl_select_write_shared_parent_frame(
            block, selection, &shared_parent, output);
    }
    narrow_flag_transfer narrow_transfer;
    if (pl_select_narrow_flag_transfer_shape(block, &narrow_transfer)) {
        pl_u32 at = 0u, written = 0u;
        if (!pl_select_emit_zero_extend_move(
                narrow_transfer.destination, narrow_transfer.source,
                32u, output, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!pl_select_emit_low8_alu_flags(
                narrow_transfer.destination, narrow_transfer.right,
                narrow_transfer.mode, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!pl_select_write_frame_value(
                selection, at, narrow_transfer.source,
                narrow_transfer.source_publication,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        return at == selection->output_bytes
             ? 0 : PL_ERROR_X86_SELECT;
    }
    independent_flag_overwrite overwrite;
    if (pl_select_independent_flag_overwrite_shape(&block->plan, &overwrite)) {
        pl_u32 at = 0u, written = 0u;
        if (!pl_select_emit_low8_alu_flags(
                overwrite.destination, overwrite.right, overwrite.mode,
                output, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!pl_select_emit_scaled_lea(
                overwrite.destination, overwrite.value_source,
                overwrite.value_bits, overwrite.scale_log2,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        return at == selection->output_bytes
             ? 0 : PL_ERROR_X86_SELECT;
    }
    standalone_flag_publication exact_flags;
    compare_tree_flag tree_flag = { 0 };
    int has_compare_tree = final_flag_node
        && !pl_select_publication_emits_flag_node(
            &block->plan, changed, final_flag_node)
        && !pl_select_flag_node_has_value_publication(
            &block->plan, changed, final_flag_node)
        && pl_select_compare_tree_flag_shape(
            &block->plan, changed, final_flag_node, &tree_flag);
    if (final_flag_node
            && !pl_select_publication_emits_flag_node(
                &block->plan, changed, final_flag_node)
            && !pl_select_flag_node_has_value_publication(
                &block->plan, changed, final_flag_node)
            && !pl_select_standalone_flag_publication_details(
                &block->plan, final_flag_node, &exact_flags)
            && !has_compare_tree)
        return PL_ERROR_X86_SELECT;
    pl_u32 frame_sources[PL_X86_GPR_COUNT];
    pl_u32 frame_dependencies[PL_X86_GPR_COUNT];
    if (!pl_select_alu_frame_source_laws(
            &block->plan, frame_sources, frame_dependencies))
        return PL_ERROR_X86_SELECT;
    pl_select_add_flag_chain_dependencies(
        &block->plan, final_flag_node, frame_dependencies);
    if (!pl_select_apply_shared_flag_producer_laws(
            &block->plan, changed, final_flag_node,
            frame_sources, frame_dependencies))
        return PL_ERROR_X86_SELECT;
    if (!pl_select_apply_select_candidate_laws(
            &block->plan, changed, frame_dependencies))
        return PL_ERROR_X86_SELECT;
    shared_flag_select_handoff flag_select = { 0 };
    int has_flag_select = pl_select_shared_flag_select_handoff_shape(
        &block->plan, changed, final_flag_node, &flag_select);
    generation_join_handoff generation_join = { 0 };
    int has_generation_join = pl_select_generation_join_handoff_shape(
        &block->plan, changed, final_flag_node,
        frame_sources, &generation_join);
    if (has_flag_select && has_generation_join)
        return PL_ERROR_X86_SELECT;
    standalone_flag_publication standalone_flags;
    int standalone_flags_pending = !pl_select_publication_emits_flag_node(
            &block->plan, changed, final_flag_node)
        && !pl_select_flag_node_has_value_publication(
            &block->plan, changed, final_flag_node)
        && pl_select_standalone_flag_publication_details(
            &block->plan, final_flag_node, &standalone_flags);
    pl_u32 pending = changed;
    pl_u32 at = 0u;
    if (has_generation_join) {
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(generation_join.preload_mask & (1u << local))) continue;
            pl_u32 part = 0u;
            if (!pl_select_write_frame_value(selection, at, local,
                    block->plan.locals[local], output + at, &part))
                return PL_ERROR_X86_SELECT;
            at += part;
            pending &= ~(1u << local);
        }
        pl_u32 written = 0u;
        pl_x86_native_selection seed_selection = *selection;
        seed_selection.frame_alias_present = 0u;
        pl_u32 seed_source = 0u, seed_bits = 0u;
        if (generation_join.seed.kind == PL_OPERAND_NODE
                && pl_select_zero_extend_node(
                    &block->plan,
                    (pl_u32)generation_join.seed.value,
                    &seed_source, &seed_bits)
                && seed_bits == generation_join.bits) {
            if (!pl_select_emit_zero_extend_move(
                    generation_join.destination, seed_source, seed_bits,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
        } else if (!pl_select_write_alu_tree(
                       block, &seed_selection,
                       generation_join.destination,
                       generation_join.seed, generation_join.bits, at,
                       block->plan.node_count + 1u, generation_join.scratch_mask,
                       output + at, &written)) {
            return PL_ERROR_X86_SELECT;
        }
        at += written;
        if (!pl_select_apply_generation_join_laws(
                &block->plan, changed, &generation_join,
                frame_sources, frame_dependencies))
            return PL_ERROR_X86_SELECT;
    }
    if (has_flag_select) {
        const pl_u32 arm[2] = {
            flag_select.candidate_first
                ? flag_select.candidate : flag_select.destination,
            flag_select.candidate_first
                ? flag_select.destination : flag_select.candidate,
        };
        for (pl_u32 index = 0u; index < 2u; ++index) {
            const pl_u32 local = arm[index];
            const pl_operand value = local == flag_select.destination
                ? flag_select.select.current : block->plan.locals[local];
            pl_u32 written = 0u;
            if (!pl_select_write_alu_tree(
                    block, selection, local, value,
                    flag_select.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
        }
        pl_u32 written = 0u;
        if (!pl_select_write_alu_pair(
                block, selection, flag_select.flag_owner,
                flag_select.flag_left, flag_select.flag_right,
                flag_select.flag_bits, flag_select.flag_mode, 0u, at,
                block->plan.node_count + 1u, 0u,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!pl_select_emit_conditional_move(
                flag_select.destination, flag_select.candidate,
                flag_select.bits, flag_select.select.condition,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~((1u << flag_select.destination)
                   | (1u << flag_select.candidate)
                   | (1u << flag_select.flag_owner));
    }
    if (!has_flag_select && !has_generation_join) {
        flag_value_preload preload;
        if (pl_select_flag_value_preload_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies, &preload)) {
            pl_x86_native_selection pre = *selection;
            pre.frame_alias_present = 0u;
            pre.value_alias_count = selection->value_alias_frame_count;
            pl_u32 written = 0u;
            if (pl_select_write_alu_tree(
                    block, &pre, preload.destination,
                    preload.tree, preload.tree_bits, at,
                    block->plan.node_count + 1u, preload.scratch,
                    output + at, &written)) {
                at += written;
                frame_sources[preload.destination] =
                    preload.other_source | (1u << preload.destination);
            }
        }
    }
    pl_x86_native_selection frame_write = *selection;
    frame_write.frame_alias_kind = selection->frame_alias_frame_kind;
    frame_write.frame_alias_local = selection->frame_alias_frame_local;
    frame_write.frame_alias_present = selection->frame_alias_frame_present;
    frame_write.value_alias_count = selection->value_alias_frame_count;
    selection = &frame_write;
    while (pending || standalone_flags_pending) {
        select_generation_group select_group;
        if (pl_select_select_generation_group_shape(&block->plan, pending,
                standalone_flags_pending ? standalone_flags.entry_sources : 0u, &select_group)
                && (standalone_flags_pending || select_group.select.compare_node == final_flag_node)) {
            pl_u32 part = 0u;
            if (!pl_select_write_select_generation_group(block, selection, &select_group,
                    at, output + at, &part) || at > selection->output_bytes
                    || part > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += part;
            pending &= ~select_group.members;
            continue;
        }
        flag_result_group compare_bool;
        if (pl_select_compare_boolean_group_shape(
                &block->plan, pending, final_flag_node, &compare_bool)) {
            pl_u32 pre = 0u, operation = 0u, post = 0u, work = 0u;
            pl_operand left = compare_bool.left, right = compare_bool.right;
            pl_select_physicalize_published_operand(&block->plan, PL_X86_GPR_COUNT, &left);
            pl_select_physicalize_published_operand(&block->plan, PL_X86_GPR_COUNT, &right);
            if (!pl_select_emit_group_booleans(&block->plan, &compare_bool, 1, output + at, &pre, &work)
                    || at > selection->output_bytes
                    || pre > selection->output_bytes - at
                    || left.kind != PL_OPERAND_LOCAL
                    || left.value >= PL_X86_GPR_COUNT
                    || !pl_select_emit_flag_coordinate(
                        (pl_u32)left.value, right, compare_bool.bits,
                        compare_bool.test, 0u, output + at + pre, &operation)
                    || operation > selection->output_bytes - at - pre)
                return PL_ERROR_X86_SELECT;
            at += pre + operation;
            if (!pl_select_emit_group_booleans(&block->plan, &compare_bool, 0, output + at, &post, &work)
                    || post > selection->output_bytes - at)
                return PL_ERROR_X86_SELECT;
            at += post;
            pending &= ~compare_bool.members;
            standalone_flags_pending = 0;
            continue;
        }
        carry_alu_group carry_group;
        if (pl_select_carry_alu_group_shape(
                &block->plan, pending, final_flag_node, &carry_group)) {
            pl_u32 compare_bytes = 0u, operation_bytes = 0u;
            if (!pl_select_emit_flag_coordinate(
                    (pl_u32)carry_group.compare_left.value,
                    carry_group.compare_right, carry_group.compare_bits,
                    carry_group.compare_test, 0u, output + at, &compare_bytes)
                    || at > selection->output_bytes
                    || compare_bytes > selection->output_bytes - at
                    || !pl_select_write_alu_pair(
                        block, selection, carry_group.destination,
                        carry_group.left, carry_group.right,
                        carry_group.bits, carry_group.mode, 0u,
                        at + compare_bytes, block->plan.node_count + 1u, 0u,
                        output + at + compare_bytes, &operation_bytes)
                    || operation_bytes
                       > selection->output_bytes - at - compare_bytes)
                return PL_ERROR_X86_SELECT;
            at += compare_bytes + operation_bytes;
            pending &= ~(1u << carry_group.destination);
            standalone_flags_pending = 0;
            continue;
        }
        flag_result_group alu_bool_group;
        pl_u32 alu_bool_deferred = 0u;
        if (pl_select_flag_result_group_shape(
                &block->plan, pending, &alu_bool_group, &alu_bool_deferred)) {
            pl_u32 pre = 0u, operation = 0u, post = 0u, work = 0u;
            if (!pl_select_emit_group_booleans(
                    &block->plan, &alu_bool_group, 1, output + at, &pre, &work)
                    || at > selection->output_bytes
                    || pre > selection->output_bytes - at)
                return PL_ERROR_X86_SELECT;
            at += pre;
            if (!pl_select_write_alu_pair(
                    block, selection, alu_bool_group.owner,
                    alu_bool_group.left, alu_bool_group.right,
                    alu_bool_group.bits, alu_bool_group.mode, 0u,
                    at, block->plan.node_count + 1u, 0u,
                    output + at, &operation)
                    || operation > selection->output_bytes - at)
                return PL_ERROR_X86_SELECT;
            at += operation;
            if (!pl_select_emit_group_booleans(
                    &block->plan, &alu_bool_group, 0, output + at, &post, &work)
                    || post > selection->output_bytes - at)
                return PL_ERROR_X86_SELECT;
            at += post;
            pending &= ~alu_bool_group.members;
            continue;
        }
        if (standalone_flags_pending) {
            pl_u32 clobberers = 0u;
            for (pl_u32 local = 0u;
                    local < PL_X86_GPR_COUNT; ++local)
                if ((pending & (1u << local))
                        && pl_select_frame_local_emission_clobbers_flags(
                            &block->plan, local))
                    clobberers |= 1u << local;
            if (!clobberers
                    && !(standalone_flags.owner_dependencies & pending)) {
                pl_u32 written = 0u;
                if (!pl_select_emit_standalone_flag_publication(
                        &standalone_flags, output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                standalone_flags_pending = 0;
                if (!pending) continue;
            }
        }
        if (has_compare_tree) {
            pl_u32 clobberers = 0u;
            for (pl_u32 local = 0u;
                    local < PL_X86_GPR_COUNT; ++local)
                if ((pending & (1u << local))
                        && pl_select_frame_local_emission_clobbers_flags(
                            &block->plan, local))
                    clobberers |= 1u << local;
            if (!clobberers
                    && !(tree_flag.owner_dependencies & pending)) {
                pl_u32 scratch_mask = pl_select_alu_frame_scratch_mask(
                    pending, PL_X86_GPR_COUNT, frame_sources);
                scratch_mask &= ~tree_flag.owner_dependencies;
                if (tree_flag.right.kind == PL_OPERAND_LOCAL)
                    scratch_mask &= ~(1u << (pl_u32)tree_flag.right.value);
                pl_u32 scratch = PL_X86_GPR_COUNT;
                for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
                    if (scratch_mask & (1u << local)) {
                        scratch = local;
                        break;
                    }
                if (scratch < PL_X86_GPR_COUNT) {
                    pl_u32 tree_bytes = 0u, compare_bytes = 0u;
                    if (!pl_select_write_alu_tree(
                            block, selection, scratch, tree_flag.tree,
                            tree_flag.tree_bits, at,
                            block->plan.node_count + 1u, 0u,
                            output + at, &tree_bytes)
                            || at > selection->output_bytes
                            || tree_bytes > selection->output_bytes - at
                            || !pl_select_emit_flag_coordinate(
                                scratch, tree_flag.right, tree_flag.bits,
                                tree_flag.test, 0u,
                                output + at + tree_bytes, &compare_bytes)
                            || compare_bytes
                               > selection->output_bytes - at - tree_bytes)
                        return PL_ERROR_X86_SELECT;
                    at += tree_bytes + compare_bytes;
                    has_compare_tree = 0;
                    continue;
                }
            }
        }
        shared_diamond_handoff diamond;
        if (pl_select_shared_diamond_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &diamond)) {
            pl_u32 written = 0u;
            if (!pl_select_write_alu_tree(
                    block, selection, diamond.parent_owner,
                    diamond.parent, diamond.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pl_operand parent = {
                PL_OPERAND_LOCAL, diamond.parent_owner,
            };
            if (!pl_select_emit_alu_instruction(
                    diamond.side_owner, parent, diamond.bits,
                    diamond.side_mode, 0u, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_emit_gpr_move(
                    diamond.root, diamond.side_owner, diamond.bits,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_emit_shift_instruction(
                    diamond.parent_owner, diamond.shift_amount,
                    diamond.bits, diamond.shift_group,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_emit_alu_instruction(
                    diamond.root, parent, diamond.bits,
                    diamond.root_mode, 0u, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pending &= ~(1u << diamond.root);
            continue;
        }
        arithmetic_width_handoff width_handoff;
        if (pl_select_arithmetic_width_handoff_shape(
                &block->plan, pending, frame_sources,
                frame_dependencies, &width_handoff)) {
            pl_u32 scratch_mask = pl_select_alu_frame_scratch_mask(
                pending, width_handoff.parent_destination,
                frame_sources);
            scratch_mask &= ~((1u << width_handoff.parent_destination)
                            | (1u << width_handoff.wide_destination)
                            | (1u << width_handoff.narrow_destination));
            pl_u32 written = 0u;
            if (!pl_select_write_alu_tree(
                    block, selection, width_handoff.wide_destination,
                    width_handoff.parent, 64u, at,
                    block->plan.node_count + 1u, scratch_mask,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_emit_gpr_move(
                    width_handoff.parent_destination,
                    width_handoff.wide_destination, 64u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_emit_alu_instruction(
                    width_handoff.wide_destination,
                    width_handoff.right, 64u, width_handoff.mode, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_emit_gpr_move(
                    width_handoff.narrow_destination,
                    width_handoff.wide_destination, 32u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pending &= ~((1u << width_handoff.parent_destination)
                       | (1u << width_handoff.wide_destination)
                       | (1u << width_handoff.narrow_destination));
            continue;
        }
        shift_sibling_handoff handoff;
        if (pl_select_shift_sibling_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, &handoff)) {
            pl_u32 written = 0u;
            if (handoff.scratch == PL_X86_GPR_COUNT) {
                if (!pl_select_emit_gpr_move(
                        handoff.flag_destination, handoff.source,
                        handoff.bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!pl_select_emit_shift_instruction(
                        handoff.sibling_destination,
                        handoff.sibling_amount, handoff.bits,
                        handoff.sibling_group, output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!pl_select_emit_shift_instruction(
                        handoff.flag_destination, handoff.flag_amount,
                        handoff.bits, handoff.flag_group,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                pending &= ~((1u << handoff.flag_destination)
                           | (1u << handoff.sibling_destination));
                continue;
            }
            if (!pl_select_write_alu_tree(
                    block, selection, handoff.scratch,
                    handoff.sibling_value, handoff.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_write_alu_tree(
                    block, selection, handoff.flag_destination,
                    handoff.flag_value, handoff.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_emit_gpr_move(
                    handoff.sibling_destination, handoff.scratch,
                    handoff.bits, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!pl_select_write_frame_value(
                    selection, at, handoff.scratch,
                    block->plan.locals[handoff.scratch],
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pending &= ~((1u << handoff.flag_destination)
                       | (1u << handoff.sibling_destination)
                       | (1u << handoff.scratch));
            continue;
        }
        pl_u32 local = 0u;
        if (!pl_select_next_alu_frame_assignment(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &local)) {
            shared_root_unary_handoff root_handoff;
            if (pl_select_shared_root_unary_handoff_shape(
                    &block->plan, pending, final_flag_node, &root_handoff)) {
                pl_u32 seed_bytes = 0u, copy_bytes = 0u;
                pl_u32 op_a = 0u, op_b = 0u;
                if (!pl_select_write_alu_tree(block, selection, root_handoff.seed_dest,
                        root_handoff.seed, root_handoff.seed_bits, at,
                        block->plan.node_count + 1u, 0u,
                        output + at, &seed_bytes)
                        || at > selection->output_bytes
                        || seed_bytes > selection->output_bytes - at
                        || !pl_select_emit_gpr_move(root_handoff.copy_dest,
                            root_handoff.seed_dest, root_handoff.bits,
                            output + at + seed_bytes, &copy_bytes)
                        || copy_bytes > selection->output_bytes - at
                                        - seed_bytes
                        || !pl_select_emit_shared_root_consumer(
                            &root_handoff.dest_consumer,
                            output + at + seed_bytes + copy_bytes, &op_a)
                        || op_a > selection->output_bytes - at - seed_bytes
                                - copy_bytes
                        || !pl_select_emit_shared_root_consumer(
                            &root_handoff.copy_consumer,
                            output + at + seed_bytes + copy_bytes + op_a,
                            &op_b)
                        || op_b > selection->output_bytes - at - seed_bytes
                                - copy_bytes - op_a)
                    return PL_ERROR_X86_SELECT;
                at += seed_bytes + copy_bytes + op_a + op_b;
                pending &= ~((1u << root_handoff.seed_dest)
                           | (1u << root_handoff.copy_dest));
                continue;
            }
            return PL_ERROR_X86_SELECT;
        }
        pl_u32 scratch_mask = pl_select_alu_frame_scratch_mask(
            pending, local, frame_sources);
        pl_operand value = block->plan.locals[local];
        masked_entry_affine entry_affine;
        pl_u32 publication = pl_select_publication_owner(&block->plan, value);
        if (has_generation_join
                && local == generation_join.destination) {
            pl_u32 written = 0u;
            if (!pl_select_emit_generation_join(&generation_join, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
        } else if (publication < PL_X86_GPR_COUNT
                && publication != local) {
            pl_u32 bits = pl_select_publication_copy_bits(
                &block->plan, selection, value, at);
            pl_u32 written = 0u;
            pl_u32 move_bytes = 0u, zero_bytes = U32_MAX_VALUE;
            if (!pl_select_emit_gpr_move(
                    local, publication, bits,
                    (pl_u8 *)0, &move_bytes))
                return PL_ERROR_X86_SELECT;
            if (value.kind == PL_OPERAND_CONST && !value.value
                    && !pl_select_emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes))
                return PL_ERROR_X86_SELECT;
            int emitted = zero_bytes < move_bytes
                ? pl_select_emit_zero_register(local, output + at, &written)
                : pl_select_emit_gpr_move(
                    local, publication, bits, output + at, &written);
            if (!emitted) return PL_ERROR_X86_SELECT;
            at += written;
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 written = 0u;
            {
                pl_u32 destination, bits, mode, preserves_carry;
                pl_operand source;
                pl_operand right;
                pl_operand scan_seed;
                pl_u32 seed_bits = 0u, source_local = 0u;
                if (pl_select_bit_summary_frame(&block->plan, selection, value, local,
                        &scan_seed, &seed_bits, &source_local, &bits, &mode)) {
                    pl_u32 prefix = 0u, operation = 0u;
                    pl_u32 seed_scratch = scratch_mask & ~(1u << source_local);
                    if (!pl_select_write_alu_tree(block, selection, local, scan_seed,
                            seed_bits, at, block->plan.node_count + 1u, seed_scratch,
                            output + at, &prefix)) return PL_ERROR_X86_SELECT;
                    if (!pl_select_emit_bit_summary(local, source_local, bits, mode,
                            output + at + prefix, &operation)) return PL_ERROR_X86_SELECT;
                    written = prefix + operation;
                } else {
                if (!pl_select_alu_node_details(
                        &block->plan, (pl_u32)(value.value >> 8u),
                        &destination, &source, &right,
                        &bits, &mode, &preserves_carry)
                        || destination != local)
                    return PL_ERROR_X86_SELECT;
                if (!preserves_carry && mode == 3u
                        && source.kind == PL_OPERAND_CONST && !source.value
                        && right.kind == PL_OPERAND_LOCAL
                        && right.value == local) {
                    if (!pl_select_emit_neg_register(
                            local, bits, output + at, &written))
                        return PL_ERROR_X86_SELECT;
                } else {
                    if (!pl_select_write_alu_pair(
                            block, selection, local, source, right,
                            bits, mode, preserves_carry, at,
                            block->plan.node_count + 1u, scratch_mask,
                            output + at, &written))
                        return PL_ERROR_X86_SELECT;
                }
                }
            }
            at += written;
        } else if (value.kind == PL_OPERAND_NODE) {
            value = pl_select_publication_for_emission(
                &block->plan, value, final_flag_node);
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u, written = 0u;
            pl_operand identity_source = { 0 };
            pl_u32 add3_pair_node = 0u, add3_pair_local = 0u, add3_pair_bits = 0u;
            pl_operand add3_pair_remaining = { 0 };
            pl_operand shift_source, shift_amount;
            pl_u32 shift_group = 0u;
            conditional_select select;
            quotient_boundary_select boundary;
            carry_adjustment adjustment;
            pl_operand bit_source;
            pl_u32 bit = 0u;
            pl_operand flag_left, flag_right;
            pl_operand lane_inner;
            pl_operand lane_base;
            pl_u32 lane_width = 0u;
            pl_u64 lane_constant = 0u;
            pl_u32 insert_condition = 0u;
            pl_u32 flag_mode = 0u, preserves_carry = 0u;
            if (final_flag_node && value.value == final_flag_node
                    && pl_select_alu_node_semantics(
                        &block->plan, final_flag_node, &flag_left,
                        &flag_right, &bits, &flag_mode,
                        &preserves_carry)) {
                if (!pl_select_write_alu_pair(
                        block, selection, local,
                        flag_left, flag_right, bits, flag_mode,
                        preserves_carry, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (final_flag_node && pl_select_flag_value_operation_details(
                    &block->plan, final_flag_node, value,
                    &flag_left, &flag_right, &bits,
                    &flag_mode, &preserves_carry)) {
                pl_u32 prefix = 0u, prefix_work = 0u;
                if (!pl_select_prepare_partial_flag_publication(
                        &block->plan, block->plan.locals[local], local,
                        bits, &flag_left, &flag_right, output + at,
                        &prefix, &prefix_work))
                    return PL_ERROR_X86_SELECT;
                if (!pl_select_write_alu_pair(
                        block, selection, local,
                        flag_left, flag_right, bits, flag_mode,
                        preserves_carry, at + prefix,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at + prefix, &written))
                    return PL_ERROR_X86_SELECT;
                written += prefix;
            } else if (final_flag_node
                    && !pl_select_publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && pl_select_masked_entry_affine_details(
                        &block->plan, value, local, &entry_affine)
                    && (scratch_mask & (1u << entry_affine.source))) {
                pl_u32 entry_affine_work = 0u;
                if (!pl_select_emit_masked_entry_affine(
                        &entry_affine, output + at,
                        &written, &entry_affine_work))
                    return PL_ERROR_X86_SELECT;
                (void)entry_affine_work;
            } else if (final_flag_node
                    && !pl_select_publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && pl_select_single_bit_or_details(
                        &block->plan, value, &bit_source, &bits, &bit)) {
                if (!pl_select_write_alu_tree(
                        block, selection, local, bit_source, bits, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!pl_select_emit_bit_set_immediate(
                        local, bit, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (final_flag_node
                    && !pl_select_publication_is_flag_result(&block->plan, value, final_flag_node)
                    && !pl_select_publication_emits_selected_flag(&block->plan, value, local, final_flag_node)
                    && pl_select_carry_adjustment_details(&block->plan, value, local,
                        pl_select_operand_fits_u32(&block->plan, value, block->plan.node_count + 1u)
                            ? 32u : 64u, &adjustment)) {
                pl_u32 work = 0u;
                if (!pl_select_emit_carry_adjustment(&adjustment, local, output + at,
                        &written, &work)) return PL_ERROR_X86_SELECT;
            } else if (pl_select_quotient_boundary_select_details(
                    &block->plan, value, local, &boundary)) {
                if (!pl_select_write_quotient_boundary_select(
                        block, selection, local, &boundary, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_conditional_select_details_inner(
                    &block->plan, value, local, 1, &select)) {
                if (select.candidate_local == local
                        || !pl_select_conditional_compare_survives_current(
                            &select, local))
                    return PL_ERROR_X86_SELECT;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                if (!(select.current_flag_node
                        ? pl_select_write_selected_flag_value(block, selection, local, &select,
                            at, block->plan.node_count + 1u, scratch_mask, output + at, &written)
                        : pl_select_write_alu_tree(
                        block, selection, local, current,
                        select.value_bits, at,
                        block->plan.node_count + 1u,
                        scratch_mask,
                        output + at, &written)))
                    return PL_ERROR_X86_SELECT;
                at += written;
                /* Seed the compare operand(s) before the true-arm candidate.
                 * The compare operand's tree can reference the `current` value
                 * just published into `local`, and the candidate can then reuse
                 * the coordinate the seed finishes with -- the order the source
                 * uses.  Publishing the candidate first would rebuild `current`
                 * from an entry local the publication has already overwritten
                 * and leave no coordinate for the seed. */
                pl_x86_native_selection seed_state = *selection;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && current.value)
                    pl_select_push_frame_value_alias(
                        &seed_state, (pl_u8)current.kind, current.value,
                        (pl_u8)local);
                pl_u32 used = scratch_mask & ~(1u << local);
                pl_u32 cand_local = select.candidate_local;
                if (!select.candidate_immediate
                        && cand_local < PL_X86_GPR_COUNT)
                    used &= ~(1u << cand_local);
                if (select.compare_left_seed
                        || select.compare_right_seed) {
                    if (select.compare_left_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        if (scratch >= PL_X86_GPR_COUNT
                                || !pl_select_write_alu_tree(
                                    block, &seed_state, scratch,
                                    select.compare_left_value,
                                    select.compare_bits, at,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    output + at, &written))
                            return PL_ERROR_X86_SELECT;
                        used &= ~(1u << scratch);
                        select.compare_left_local = scratch;
                        at += written;
                    }
                    if (select.compare_right_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        if (scratch >= PL_X86_GPR_COUNT
                                || !pl_select_write_alu_tree(
                                    block, &seed_state, scratch,
                                    select.compare_right_value,
                                    select.compare_bits, at,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    output + at, &written))
                            return PL_ERROR_X86_SELECT;
                        used &= ~(1u << scratch);
                        select.compare_right.kind = PL_OPERAND_LOCAL;
                        select.compare_right.value = scratch;
                        at += written;
                    }
                }
                if (select.candidate_immediate) {
                    cand_local = PL_X86_GPR_COUNT;
                    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                            ++scratch)
                        if (scratch != local
                                && (used & (1u << scratch))) {
                            cand_local = scratch;
                            break;
                        }
                    if (cand_local >= PL_X86_GPR_COUNT)
                        return PL_ERROR_X86_SELECT;
                    if (!pl_select_write_alu_tree(
                            block, selection, cand_local,
                            select.candidate_value, select.value_bits, at,
                            block->plan.node_count + 1u,
                            used & ~(1u << cand_local),
                            output + at, &written))
                        return PL_ERROR_X86_SELECT;
                    at += written;
                }
                if (select.has_compare
                        && (select.compare_node != final_flag_node
                            || !pl_select_flag_node_has_value_publication(
                                &block->plan, changed,
                                final_flag_node))) {
                    int compared = pl_select_emit_select_compare(&select, output + at, &written);
                    if (!compared)
                        return PL_ERROR_X86_SELECT;
                    at += written;
                }
                if (!pl_select_emit_conditional_move(
                        local, cand_local,
                        select.value_bits, select.condition,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_sign_high_node_details(
                    &block->plan, value, &source, &bits)) {
                if (!pl_select_emit_sign_high(
                        local, source, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_masked_shift_count_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group) && local != 1u) {
                if (!pl_select_write_alu_tree(
                        block, selection, local, shift_source, bits, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!pl_select_write_alu_tree(
                        block, selection, 1u, shift_amount, 32u, at,
                        block->plan.node_count + 1u,
                        scratch_mask & ~(1u << 1u),
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!pl_select_emit_shift_instruction(
                        local, (pl_operand){ PL_OPERAND_LOCAL, 1u },
                        bits, shift_group, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                if (!pl_select_write_alu_tree(
                        block, selection, local, shift_source, bits, at,
                        block->plan.node_count + 1u,
                        scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!pl_select_emit_shift_instruction(
                        local, shift_amount, bits, shift_group,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_shared_dag_add3_published_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_local, &add3_pair_remaining, &add3_pair_bits)) {
                pl_operand pair = { PL_OPERAND_LOCAL, add3_pair_local };
                if (!pl_select_write_alu_pair(
                        block, selection, local, pair, add3_pair_remaining,
                        add3_pair_bits, 1u, 0u, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_shared_dag_add3_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_node, &add3_pair_remaining, &add3_pair_bits)) {
                /* Prefer the shared pair over the affine LEA so the earlier
                 * sum is built once, not rebuilt inside this tree.  When
                 * another pending publication needs the same pair as its
                 * destructive arm, build the pair in that consumer's coordinate
                 * so both publications share one materialization. */
                pl_operand pair = { PL_OPERAND_NODE, add3_pair_node };
                pl_u32 consumer = pl_select_alu_add3_pair_consumer(
                    &block->plan, pending, add3_pair_node, local);
                int share_pair = consumer < PL_X86_GPR_COUNT
                    && (scratch_mask & (1u << consumer))
                    && add3_pair_remaining.kind == PL_OPERAND_LOCAL
                    && add3_pair_remaining.value < PL_X86_GPR_COUNT;
                pl_operand pair_left = share_pair
                    ? add3_pair_remaining : pair;
                pl_operand pair_right = share_pair
                    ? pair : add3_pair_remaining;
                if (!pl_select_write_alu_pair(
                        block, selection, local, pair_left, pair_right,
                        add3_pair_bits, 1u, 0u, at,
                        block->plan.node_count + 1u,
                        share_pair ? (1u << consumer) : scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                if (share_pair)
                    pl_select_push_frame_value_alias(
                        (pl_x86_native_selection *)selection,
                        PL_OPERAND_NODE, add3_pair_node, (pl_u8)consumer);
            } else if (pl_select_collect_native_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form, &bits)) {
                if (!pl_select_emit_affine_lea_width(
                        local, form, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_sign_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!pl_select_emit_sign_extend_move(
                        local, source, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_zero_extend_high8_node(
                    &block->plan, (pl_u32)value.value, &source)) {
                if (!pl_select_emit_zero_extend_high8(
                        local, source, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!pl_select_emit_zero_extend_move(
                        local, source, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_zero_extend_operand(
                    &block->plan, (pl_u32)value.value, &lane_inner, &lane_width)
                    && lane_width == 32u) {
                pl_u32 inner_bytes = 0u;
                if (!pl_select_write_alu_tree(
                        block, selection, local, lane_inner, 32u,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &inner_bytes))
                    return PL_ERROR_X86_SELECT;
                written = inner_bytes;
                if (pl_select_lane32_shift_inner_needs_truncation(
                        &block->plan, lane_inner)) {
                    pl_u32 extend = 0u;
                    if (!pl_select_emit_zero_extend_move(
                            local, local, 32u,
                            output + at + inner_bytes, &extend))
                        return PL_ERROR_X86_SELECT;
                    written += extend;
                }
            } else if (pl_select_zero_extend_operand(
                    &block->plan, (pl_u32)value.value, &lane_inner, &lane_width)
                    && (lane_width == 8u || lane_width == 16u)) {
                pl_u32 inner_bits = pl_select_operand_expression_bits(
                    &block->plan, lane_inner, 64u);
                if (!inner_bits) inner_bits = 64u;
                pl_u32 inner_bytes = 0u;
                if (!pl_select_write_alu_tree(
                        block, selection, local, lane_inner, inner_bits,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &inner_bytes)
                        || !pl_select_emit_zero_extend_move(
                            local, local, lane_width,
                            output + at + inner_bytes, &written))
                    return PL_ERROR_X86_SELECT;
                written += inner_bytes;
            } else if (pl_select_in_place_condition_insert(
                    &block->plan, value, local, &insert_condition)) {
                if (!pl_select_emit_set_condition(
                        local, insert_condition, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (pl_select_in_place_lane_insert(
                    &block->plan, value, local, &lane_inner, &lane_width)) {
                pl_u32 insert_bytes = 0u;
                if (!pl_select_write_alu_tree(
                        block, selection, local, lane_inner, lane_width,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &insert_bytes))
                    return PL_ERROR_X86_SELECT;
                written = insert_bytes;
            } else if (pl_select_lane_constant_insert(
                    &block->plan, value, local, &lane_base,
                    &lane_constant, &lane_width)) {
                pl_u32 prefix = 0u, move = 0u;
                if (!(lane_base.kind == PL_OPERAND_LOCAL
                        && lane_base.value == local)
                        && !pl_select_write_alu_tree(
                            block, selection, local, lane_base,
                            pl_select_operand_expression_bits(
                                &block->plan, lane_base, 64u),
                            at, block->plan.node_count + 1u, scratch_mask,
                            output + at, &prefix))
                    return PL_ERROR_X86_SELECT;
                if (!pl_select_emit_lane_constant_move(
                        local, lane_constant, lane_width,
                        output + at + prefix, &move))
                    return PL_ERROR_X86_SELECT;
                written = prefix + move;
            } else if (value.kind == PL_OPERAND_NODE && value.value
                    && value.value <= block->plan.node_count
                    && (block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE32_BSWAP
                        || block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE64_BSWAP)) {
                pl_u32 bswap_bits = block->plan.nodes[value.value - 1u].opcode
                                  == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
                pl_operand source_operand = block->plan.arguments[
                    block->plan.nodes[value.value - 1u].argument_at];
                pl_u32 seed_bytes = 0u;
                if (!pl_select_write_alu_tree(
                        block, selection, local, source_operand, bswap_bits,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &seed_bytes)
                        || !pl_select_emit_bswap_register(
                            local, bswap_bits, output + at + seed_bytes,
                            &written))
                    return PL_ERROR_X86_SELECT;
                written += seed_bytes;
            } else if ((pl_u32)value.value != final_flag_node
                    && pl_select_lane_identity_mask_details(
                        &block->plan, value, &identity_source, &bits)) {
                /* The lane mask is dropped, so the publication is just the
                 * lane-width move of a register that already holds the base.
                 * The base must be read as itself: resolving it through a
                 * transient alias would name a register whose definition is a
                 * different publication. */
                pl_x86_native_selection identity_free = *selection;
                identity_free.frame_alias_present = 0u;
                if (!pl_select_write_alu_tree(
                        block, &identity_free, local, identity_source, bits,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else {
                bits = pl_select_operand_expression_bits(&block->plan, value, 0u);
                if (!bits)
                    return PL_ERROR_X86_SELECT;
                pl_u32 root_sources = 0u;
                int direct_destination =
                    (selection->frame_direct_destination_mask
                     & (1u << local)) != 0u;
                int emitted = direct_destination && pl_select_write_alu_tree(
                    block, selection, local, value, bits, at,
                    block->plan.node_count + 1u, scratch_mask,
                    output + at, &written);
                if (!direct_destination && pl_select_operand_entry_gpr_sources(
                        &block->plan, value,
                        block->plan.node_count + 1u,
                        block->plan.node_count + 1u, &root_sources)
                        && !(root_sources & (1u << local))) {
                    for (pl_u32 owner = 0u;
                            owner < PL_X86_GPR_COUNT; ++owner) {
                        pl_u32 owner_bit = 1u << owner;
                        if (!(scratch_mask & owner_bit)
                                || !(root_sources & owner_bit))
                            continue;
                        pl_u32 tree_bytes = 0u, move_bytes = 0u;
                        if (!pl_select_write_alu_tree(
                                block, selection, owner, value, bits, at,
                                block->plan.node_count + 1u,
                                scratch_mask & ~owner_bit,
                                output + at, &tree_bytes)
                                || !pl_select_emit_gpr_move(
                                    local, owner, bits,
                                    output + at + tree_bytes,
                                    &move_bytes)
                                || tree_bytes
                                   > U32_MAX_VALUE - move_bytes)
                            continue;
                        written = tree_bytes + move_bytes;
                        emitted = 1;
                        break;
                    }
                }
                if (!direct_destination && !emitted)
                    emitted = pl_select_write_alu_tree(
                        block, selection, local, value, bits, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written);
                if (!emitted)
                    return PL_ERROR_X86_SELECT;
            }
            at += written;
        } else {
            pl_u32 encoded = 0u;
            if (!pl_select_write_frame_value(
                    selection, at, local, value, output + at, &encoded))
                return PL_ERROR_X86_SELECT;
            at += encoded;
        }
        pending &= ~(1u << local);
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (block->dynamic_target) {
            pl_u32 target_owner = PL_X86_GPR_COUNT;
            if (!pl_select_published_operand_local(
                    &block->plan, block->target, &target_owner)
                    || !pl_select_emit_indirect_jump(
                        target_owner, output + at, &branch_bytes)
                    || at > selection->output_bytes
                    || branch_bytes > selection->output_bytes - at)
                return PL_ERROR_X86_SELECT;
            at += branch_bytes;
        } else {
            if (at > selection->output_bytes
                    || selection->output_bytes - at != branch_bytes)
                return PL_ERROR_X86_SELECT;
            output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
            for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
                output[at++] = 0u;
        }
    }
    /* The measure accepted the compare-over-tree shape but the tree could not
     * be materialized here; the final flags were never produced. */
    if (has_compare_tree) return PL_ERROR_X86_SELECT;
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}
