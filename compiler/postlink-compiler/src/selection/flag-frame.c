/* flag-frame: native x86 selection. */
#include "flag-frame.h"
#include "limits.h"
#include "lea.h"
#include "encoding.h"
#include "expressions.h"
#include "flags.h"
#include "operands.h"
#include "select-rules.h"
#include "source.h"
#include "tree-measure.h"
#include "tree-write.h"

static int transient_seed_frame_shape(const pl_x86_block *block,
                                      transient_seed_frame *out);

static int consumed_flag_depends(const pl_plan *plan, pl_operand value,
                                 pl_u32 result_node, pl_u32 depth);

static int collect_consumed_affine(
    const pl_plan *plan, pl_operand value, pl_u32 bits, pl_u32 remaining,
    pl_u32 result_node, pl_u32 result_register, pl_u32 available,
    affine_lea *out);

static int consumed_flag_frame_shape(const pl_x86_block *block,
                                     consumed_flag_frame *out);

static pl_u32 consumed_flag_node_rank(const pl_plan *plan, pl_u32 local);

static int transient_seed_frame_shape(const pl_x86_block *block,
                                      transient_seed_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_plan *plan = &block->plan;
    pl_operand flag_value = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_value.kind != PL_OPERAND_NODE || !flag_value.value
            || flag_value.value > plan->node_count)
        return 0;
    pl_u32 destination = 0u, bits = 0u, mode = 0u, preserves_carry = 0u;
    pl_operand left, right;
    if (!pl_select_alu_node_details(
            plan, (pl_u32)flag_value.value, &destination, &left, &right,
            &bits, &mode, &preserves_carry)
            || destination >= PL_X86_GPR_COUNT || preserves_carry)
        return 0;
    if (!pl_select_publication_is_flag_result(
            plan, plan->locals[destination], (pl_u32)flag_value.value))
        return 0;
    pl_u32 changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        changed |= 1u << local;
    }
    if (!(changed & (1u << destination))) return 0;
    pl_operand seed;
    if (left.kind == PL_OPERAND_LOCAL && left.value == destination
            && right.kind == PL_OPERAND_NODE) {
        seed = right;
    } else if (right.kind == PL_OPERAND_LOCAL && right.value == destination
            && left.kind == PL_OPERAND_NODE) {
        seed = left;
    } else {
        return 0;
    }
    if (!seed.value || seed.value > plan->node_count) return 0;
    pl_u32 commutative = (mode == 0u || mode == 1u || mode == 5u || mode == 6u);
    if (!commutative
            && !(left.kind == PL_OPERAND_LOCAL
                 && left.value == destination))
        return 0;
    pl_u32 seed_sources = 0u, seed_dependencies = 0u;
    if (!pl_select_operand_frame_source_law(
            plan, seed, &seed_sources, &seed_dependencies)
            || (seed_dependencies & changed))
        return 0;
    /* The intermediate must not already be an architectural publication. */
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((changed & (1u << local))
                && plan->locals[local].kind == PL_OPERAND_NODE
                && plan->locals[local].value == seed.value)
            return 0;
    pl_u32 transient = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local)) || local == destination) continue;
        pl_operand value = plan->locals[local];
        if (consumed_flag_depends(plan, value, (pl_u32)seed.value,
                plan->node_count + 1u))
            continue;
        if (pl_select_frame_local_publication_clobbers_flags(plan, local)) continue;
        /* This output is restored after all other outputs and the flag
         * accumulator have been overwritten. A semantic LOCAL still names
         * its entry generation, not the value now in that register. Ignore
         * the captured seed, but require every remaining entry source of
         * the closing spelling to survive the complete schedule. */
        pl_u32 closing_sources = 0u;
        if (!pl_select_operand_entry_sources_without(
                plan, value, seed, plan->node_count + 1u,
                plan->node_count + 1u, 1, &closing_sources)
                || (closing_sources & changed))
            continue;
        /* Capturing the seed destroys this register's entry generation.
         * Its own final publication, or any sibling publication, must not
         * still read that entry after the capture. */
        int entry_escapes = 0;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (!(changed & (1u << other)) || other == destination) continue;
            pl_u32 entry_sources = 0u;
            if (!pl_select_operand_entry_gpr_sources(
                    plan, plan->locals[other], plan->node_count + 1u,
                    plan->node_count + 1u, &entry_sources)
                    || (entry_sources & (1u << local))) {
                entry_escapes = 1;
                break;
            }
        }
        if (entry_escapes) continue;
        if (transient == PL_X86_GPR_COUNT
                || consumed_flag_node_rank(plan, local)
                   > consumed_flag_node_rank(plan, transient))
            transient = local;
    }
    if (transient >= PL_X86_GPR_COUNT) return 0;
    pl_u32 others = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local)) || local == destination
                || local == transient)
            continue;
        if (consumed_flag_depends(plan, plan->locals[local],
                (pl_u32)seed.value, plan->node_count + 1u))
            return 0;
        if (consumed_flag_depends(plan, plan->locals[local],
                (pl_u32)flag_value.value, plan->node_count + 1u))
            return 0;
        others |= 1u << local;
    }
    pl_u32 seed_bits = pl_select_operand_expression_bits(plan, seed, 0u);
    if (!seed_bits) return 0;
    *out = (transient_seed_frame){ 0 };
    out->flag_node = (pl_u32)flag_value.value;
    out->destination = destination;
    out->transient = transient;
    out->seed_bits = seed_bits;
    out->bits = bits;
    out->mode = mode;
    out->preserves_carry = preserves_carry;
    out->seed = seed;
    out->others = others;
    return 1;
}

int pl_select_measure_direct_transient_seed_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    transient_seed_frame shape;
    if (!transient_seed_frame_shape(block, &shape)) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 bytes = 0u, work = 0u;
    pl_u32 part = 0u, part_work = 0u;
    selection->frame_alias_present = 0u;
    if (pl_select_measure_alu_tree(
            frontend, block, selection, shape.transient, shape.seed,
            shape.seed_bits, bytes, plan->node_count + 1u, 0u,
            &part, &part_work) <= 0)
        return 0;
    bytes += part;
    work += part_work;
    selection->frame_alias_value = shape.seed.value;
    selection->frame_alias_kind = shape.seed.kind;
    selection->frame_alias_local = (pl_u8)shape.transient;
    selection->frame_alias_present = 1u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.others & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 64u);
        if (pl_select_measure_alu_tree(
                frontend, block, selection, local, value, value_bits,
                bytes, plan->node_count + 1u, 0u,
                &part, &part_work) <= 0)
            return 0;
        bytes += part;
        work += part_work;
    }
    part = 0u;
    if (!pl_select_emit_alu_instruction(
            shape.destination,
            (pl_operand){ PL_OPERAND_LOCAL, shape.transient },
            shape.bits, shape.mode, shape.preserves_carry, 0, &part)
            || bytes > U32_MAX_VALUE - part)
        return 0;
    bytes += part;
    ++work;
    if (pl_select_measure_alu_tree(
            frontend, block, selection, shape.transient,
            plan->locals[shape.transient],
            pl_select_operand_expression_bits(plan, plan->locals[shape.transient], 64u),
            bytes, plan->node_count + 1u, 0u, &part, &part_work) <= 0)
        return 0;
    bytes += part;
    work += part_work;
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        int status = pl_select_append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++work;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_transient_seed_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_transient_seed_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_transient_seed_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    transient_seed_frame shape;
    if (!transient_seed_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;
    const pl_plan *plan = &block->plan;
    pl_x86_native_selection mutable = *selection;
    pl_u32 at = 0u, written = 0u;
    mutable.frame_alias_present = 0u;
    if (!pl_select_write_alu_tree(
            block, &mutable, shape.transient, shape.seed, shape.seed_bits,
            at, plan->node_count + 1u, 0u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    mutable.frame_alias_value = shape.seed.value;
    mutable.frame_alias_kind = shape.seed.kind;
    mutable.frame_alias_local = (pl_u8)shape.transient;
    mutable.frame_alias_present = 1u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.others & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 64u);
        if (!pl_select_write_alu_tree(
                block, &mutable, local, value, value_bits, at,
                plan->node_count + 1u, 0u, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    written = 0u;
    if (!pl_select_emit_alu_instruction(
            shape.destination,
            (pl_operand){ PL_OPERAND_LOCAL, shape.transient },
            shape.bits, shape.mode, shape.preserves_carry,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!pl_select_write_alu_tree(
            block, &mutable, shape.transient, plan->locals[shape.transient],
            pl_select_operand_expression_bits(plan, plan->locals[shape.transient], 64u),
            at, plan->node_count + 1u, 0u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int consumed_flag_depends(const pl_plan *plan, pl_operand value,
                                 pl_u32 result_node, pl_u32 depth)
{
    if (!depth) return 0;
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    if (value.value == result_node) return 1;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    for (pl_u32 at = 0u; at < node->argument_count; ++at)
        if (consumed_flag_depends(
                plan, plan->arguments[node->argument_at + at],
                result_node, depth - 1u))
            return 1;
    return 0;
}

static int collect_consumed_affine(
    const pl_plan *plan, pl_operand value, pl_u32 bits, pl_u32 remaining,
    pl_u32 result_node, pl_u32 result_register, pl_u32 available,
    affine_lea *out)
{
    if (!plan || !out || !remaining) return 0;
    if (value.kind == PL_OPERAND_CONST) {
        out->displacement += value.value;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        return pl_select_append_affine_local(out, (pl_u32)value.value, 0u);
    }
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    if (value.value == result_node)
        return pl_select_append_affine_local(out, result_register, 0u);
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->argument_count == 3u
            && (node->opcode == PL_OPCODE_ADD3[0]
                || node->opcode == PL_OPCODE_ADD3[1])) {
        if ((node->opcode == PL_OPCODE_ADD3[0] ? 32u : 64u) != bits)
            return 0;
        for (pl_u32 at = 0u; at < 3u; ++at)
            if (!collect_consumed_affine(
                    plan, plan->arguments[node->argument_at + at],
                    bits, remaining - 1u, result_node, result_register,
                    available, out))
                return 0;
        return 1;
    }
    pl_operand source, amount;
    pl_u32 shift_bits = 0u, group = 0u;
    if (pl_select_shift_node_details(
            plan, value, &source, &amount, &shift_bits, &group)
            && shift_bits == bits && group == 4u
            && amount.kind == PL_OPERAND_CONST && amount.value <= 3u) {
        pl_operand leaf = source;
        if (leaf.kind == PL_OPERAND_NODE && leaf.value == result_node) {
            leaf = (pl_operand){ PL_OPERAND_LOCAL, result_register };
        } else if (leaf.kind == PL_OPERAND_NODE) {
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (!pl_select_published_operand_local(plan, leaf, &owner)
                    || !(available & (1u << owner)))
                return 0;
            leaf = (pl_operand){ PL_OPERAND_LOCAL, owner };
        }
        if (leaf.kind != PL_OPERAND_LOCAL) return 0;
        return pl_select_append_affine_local(
            out, (pl_u32)leaf.value, (pl_u32)amount.value);
    }
    /* An equal published owner already names the register. */
    {
        pl_u32 owner = PL_X86_GPR_COUNT;
        if (pl_select_published_operand_local(plan, value, &owner)
                && (available & (1u << owner)))
            return pl_select_append_affine_local(out, owner, 0u);
    }
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (pl_select_arithmetic_tree_details(
            plan, value, &left, &right, &node_bits, &mode)
            && mode == 1u && node_bits == bits)
        return collect_consumed_affine(
                   plan, left, bits, remaining - 1u, result_node,
                   result_register, available, out)
            && collect_consumed_affine(
                   plan, right, bits, remaining - 1u, result_node,
                   result_register, available, out);
    return 0;
}

static int consumed_flag_frame_shape(const pl_x86_block *block,
                                     consumed_flag_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_plan *plan = &block->plan;
    pl_operand flag_value = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_value.kind != PL_OPERAND_NODE || !flag_value.value
            || flag_value.value > plan->node_count)
        return 0;
    pl_operand result, prior;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!pl_select_flag_result_operand(
            plan, (pl_u32)flag_value.value, &result, &prior)
            || result.kind != PL_OPERAND_NODE || !result.value
            || result.value > plan->node_count
            || !pl_select_flag_operation_details(
                plan, flag_value, &left, &right, &bits, &mode,
                &preserves_carry)
            || preserves_carry
            || left.kind != PL_OPERAND_LOCAL
            || left.value >= PL_X86_GPR_COUNT
            || (right.kind != PL_OPERAND_LOCAL
                && right.kind != PL_OPERAND_CONST)
            || (right.kind == PL_OPERAND_LOCAL
                && right.value >= PL_X86_GPR_COUNT))
        return 0;
    pl_u32 result_node = (pl_u32)result.value;
    /* The producer executes in the left entry register.  A still-live
     * identity publication of that register cannot be sacrificed merely
     * because the flag result itself is consumed by another output. */
    if ((block->live_output_mask & (1u << (pl_u32)left.value))
            && plan->locals[left.value].kind == PL_OPERAND_LOCAL
            && plan->locals[left.value].value == left.value)
        return 0;
    pl_u32 before = 0u, after = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (value.kind == PL_OPERAND_NODE && value.value == result_node)
            return 0;   /* an ordinary publication already owns it */
        if (consumed_flag_depends(
                plan, value, result_node, plan->node_count + 1u))
            after |= 1u << local;
        else
            before |= 1u << local;
    }
    if (!after) return 0;
    if (before & (1u << (pl_u32)left.value)) return 0;
    if (right.kind == PL_OPERAND_LOCAL
            && (before & (1u << (pl_u32)right.value)))
        return 0;
    *out = (consumed_flag_frame){ 0 };
    out->flag_node = (pl_u32)flag_value.value;
    out->result_node = result_node;
    out->result_register = (pl_u32)left.value;
    out->left = left;
    out->right = right;
    out->bits = bits;
    out->mode = mode;
    out->preserves_carry = preserves_carry;
    out->before_mask = before;
    out->after_mask = after;
    return 1;
}

static pl_u32 consumed_flag_node_rank(const pl_plan *plan, pl_u32 local)
{
    pl_operand value = plan->locals[local];
    return value.kind == PL_OPERAND_NODE ? (pl_u32)value.value : 0u;
}

int pl_select_measure_direct_consumed_flag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    consumed_flag_frame shape;
    if (!consumed_flag_frame_shape(block, &shape)) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 bytes = 0u, work = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.before_mask & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 64u);
        pl_u32 part = 0u, part_work = 0u;
        int measured = pl_select_measure_alu_tree(
            frontend, block, selection, local, value, value_bits,
            bytes, plan->node_count + 1u, 0u, &part, &part_work);
        if (measured <= 0 || bytes > U32_MAX_VALUE - part)
            return measured < 0 ? measured : 0;
        bytes += part;
        work += part_work;
    }
    pl_u32 producer_bytes = 0u;
    if (!pl_select_emit_alu_instruction(
            shape.result_register, shape.right, shape.bits, shape.mode,
            shape.preserves_carry, 0, &producer_bytes)
            || bytes > U32_MAX_VALUE - producer_bytes)
        return 0;
    bytes += producer_bytes;
    ++work;
    /* The producer has placed result_node in result_register, but not an
     * arbitrary final publication assigned to that same register.  Only
     * result_node itself may use the special case in collect_consumed_affine;
     * other published owners become available after their step is emitted. */
    pl_u32 available = shape.before_mask;
    pl_u32 order[PL_X86_GPR_COUNT];
    pl_u32 order_count = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (shape.after_mask & (1u << local)) order[order_count++] = local;
    for (pl_u32 at = 1u; at < order_count; ++at) {
        pl_u32 key = order[at];
        pl_u32 rank = consumed_flag_node_rank(plan, key);
        pl_u32 slot = at;
        while (slot && consumed_flag_node_rank(plan, order[slot - 1u]) > rank) {
            order[slot] = order[slot - 1u];
            --slot;
        }
        order[slot] = key;
    }
    for (pl_u32 at = 0u; at < order_count; ++at) {
        pl_u32 local = order[at];
        pl_operand value = plan->locals[local];
        pl_u32 part = 0u;
        int is_copy = 0;
        pl_u32 source = PL_X86_GPR_COUNT;
        if (value.kind == PL_OPERAND_LOCAL && value.value < PL_X86_GPR_COUNT
                && value.value != local) {
            is_copy = 1;
            source = (pl_u32)value.value;
        } else if (value.kind == PL_OPERAND_NODE
                && value.value == shape.result_node) {
            is_copy = 1;
            source = shape.result_register;
        } else if (value.kind == PL_OPERAND_NODE) {
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (pl_select_published_operand_local(plan, value, &owner)
                    && owner != local
                    && (available & (1u << owner))) {
                is_copy = 1;
                source = owner;
            }
        }
        int emitted = 0;
        if (is_copy) {
            pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 64u);
            emitted = pl_select_emit_gpr_move(
                local, source, value_bits, 0, &part);
        } else {
            affine_lea form = { 0 };
            pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 0u);
            if (value_bits
                    && collect_consumed_affine(
                        plan, value, value_bits,
                        plan->node_count + 1u, shape.result_node,
                        shape.result_register, available, &form)) {
                if (form.count == 1u && !form.scale_log2[0]
                        && form.local[0] == local && !form.displacement)
                    emitted = 1, part = 0u;
                else
                    emitted = pl_select_emit_affine_lea_width(
                        local, form, value_bits, 0, &part);
            }
        }
        if (!emitted || bytes > U32_MAX_VALUE - part
                || work == U32_MAX_VALUE)
            return 0;
        bytes += part;
        ++work;
        available |= 1u << local;
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++work;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_consumed_flag_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_consumed_flag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_consumed_flag_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    consumed_flag_frame shape;
    pl_u32 bytes = 0u, work = 0u;
    pl_x86_native_selection mutable = *selection;
    if (!consumed_flag_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;
    /* Re-emit with byte output.  The measure path above is the schedule of
     * record; repeat the same decisions here. */
    const pl_plan *plan = &block->plan;
    pl_u32 at = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.before_mask & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 64u);
        pl_u32 written = 0u;
        if (!pl_select_write_alu_tree(
                block, &mutable, local, value, value_bits, at,
                plan->node_count + 1u, 0u, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    pl_u32 written = 0u;
    if (!pl_select_emit_alu_instruction(
            shape.result_register, shape.right, shape.bits, shape.mode,
            shape.preserves_carry, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    pl_u32 available = shape.before_mask;
    pl_u32 order[PL_X86_GPR_COUNT];
    pl_u32 order_count = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (shape.after_mask & (1u << local)) order[order_count++] = local;
    for (pl_u32 index = 1u; index < order_count; ++index) {
        pl_u32 key = order[index];
        pl_u32 rank = consumed_flag_node_rank(plan, key);
        pl_u32 slot = index;
        while (slot && consumed_flag_node_rank(plan, order[slot - 1u]) > rank) {
            order[slot] = order[slot - 1u];
            --slot;
        }
        order[slot] = key;
    }
    for (pl_u32 index = 0u; index < order_count; ++index) {
        pl_u32 local = order[index];
        pl_operand value = plan->locals[local];
        int is_copy = 0;
        pl_u32 source = PL_X86_GPR_COUNT;
        if (value.kind == PL_OPERAND_LOCAL && value.value < PL_X86_GPR_COUNT
                && value.value != local) {
            is_copy = 1;
            source = (pl_u32)value.value;
        } else if (value.kind == PL_OPERAND_NODE
                && value.value == shape.result_node) {
            is_copy = 1;
            source = shape.result_register;
        } else if (value.kind == PL_OPERAND_NODE) {
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (pl_select_published_operand_local(plan, value, &owner)
                    && owner != local
                    && (available & (1u << owner))) {
                is_copy = 1;
                source = owner;
            }
        }
        written = 0u;
        int emitted = 0;
        if (is_copy) {
            pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 64u);
            emitted = pl_select_emit_gpr_move(
                local, source, value_bits, output + at, &written);
        } else {
            affine_lea form = { 0 };
            pl_u32 value_bits = pl_select_operand_expression_bits(plan, value, 0u);
            if (value_bits
                    && collect_consumed_affine(
                        plan, value, value_bits,
                        plan->node_count + 1u, shape.result_node,
                        shape.result_register, available, &form)) {
                if (form.count == 1u && !form.scale_log2[0]
                        && form.local[0] == local && !form.displacement)
                    emitted = 1, written = 0u;
                else
                    emitted = pl_select_emit_affine_lea_width(
                        local, form, value_bits, output + at, &written);
            }
        }
        if (!emitted) return PL_ERROR_X86_SELECT;
        at += written;
        available |= 1u << local;
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    (void)bytes;
    (void)work;
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}
