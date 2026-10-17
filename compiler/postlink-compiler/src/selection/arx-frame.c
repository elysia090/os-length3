/* arx-frame: native x86 selection. */
#include "arx-frame.h"
#include "limits.h"
#include "encoding.h"
#include "expressions.h"
#include "flags.h"
#include "operands.h"
#include "state-frame.h"
#include "tree-measure.h"
#include "tree-write.h"

static int nonzero_word_shift(pl_operand amount);

static int arx_shared_dag_frame_details(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    arx_shared_dag_frame *out);

static int emit_arx_shared_dag_frame(
    const arx_shared_dag_frame *shape,
    pl_u8 *output, pl_u32 *written);

static int mutable_xor_frame_details(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    mutable_xor_frame *out);

static int nonzero_word_shift(pl_operand amount)
{
    return amount.kind == PL_OPERAND_CONST
        && (amount.value & 63u) != 0u;
}

/* Normalize the common four-leaf ARX DAG without retaining an expression
 * tree or rebuilding either shared value.  In algebraic form the root is
 *
 *   rot(P, a) ^ rot(T, b) ^ P
 *       ^ rot(B ^ rot(S, c), d)
 *   where P = B + T and T = D ^ A.
 *
 * T and P each have two futures.  Their entry-backed coordinates are the
 * complete residual state: materialize each once, rotate the T coordinate
 * only after P has consumed it, and reassociate the four XOR leaves.  This
 * is an instruction-topology production, not a kernel-symbol special case. */
static int arx_shared_dag_frame_details(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    arx_shared_dag_frame *out)
{
    if (!plan || !changed || !final_flag_node || !out) return 0;
    const pl_u32 gpr_mask = (1u << PL_X86_GPR_COUNT) - 1u;
    pl_u32 destination = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        if (pl_select_zero_result_operand(plan, plan->locals[local])) continue;
        if (destination != PL_X86_GPR_COUNT) return 0;
        destination = local;
    }
    if (destination >= PL_X86_GPR_COUNT) return 0;

    pl_operand root = plan->locals[destination];
    pl_operand root_left, root_right;
    pl_u32 root_bits = 0u, root_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, root, &root_left, &root_right,
            &root_bits, &root_mode)
            || root_bits != 64u || root_mode != 6u
            || pl_select_publication_owner(plan, root) != destination)
        return 0;

    pl_u32 capacity = plan->node_count + 1u;
    pl_operand leaves[capacity];
    pl_u32 leaf_count = 0u;
    if (!pl_select_collect_associative_leaves(
            plan, root, 64u, 6u, leaves, capacity, &leaf_count,
            plan->node_count + 1u)
            || leaf_count != 4u)
        return 0;

    for (pl_u32 parent_at = 0u; parent_at < leaf_count; ++parent_at) {
        pl_operand parent = leaves[parent_at];
        pl_operand parent_left, parent_right;
        pl_u32 parent_bits = 0u, parent_mode = 0u;
        if (!pl_select_arithmetic_tree_details(
                plan, parent, &parent_left, &parent_right,
                &parent_bits, &parent_mode)
                || parent_bits != 64u || parent_mode != 1u)
            continue;
        for (pl_u32 parent_orientation = 0u;
                parent_orientation < 2u; ++parent_orientation) {
            pl_operand parent_entry = parent_orientation
                ? parent_right : parent_left;
            pl_operand seed = parent_orientation
                ? parent_left : parent_right;
            if (parent_entry.kind != PL_OPERAND_LOCAL
                    || parent_entry.value >= PL_X86_GPR_COUNT)
                continue;
            pl_u32 parent_owner = (pl_u32)parent_entry.value;

            pl_operand seed_left, seed_right;
            pl_u32 seed_bits = 0u, seed_mode = 0u;
            if (!pl_select_arithmetic_tree_details(
                    plan, seed, &seed_left, &seed_right,
                    &seed_bits, &seed_mode)
                    || (seed_bits != 32u && seed_bits != 64u)
                    || seed_mode != 6u)
                continue;
            pl_u32 seed_owner = PL_X86_GPR_COUNT;
            if (seed_left.kind == PL_OPERAND_LOCAL
                    && seed_right.kind == PL_OPERAND_LOCAL) {
                if (seed_left.value == destination
                        && seed_right.value < PL_X86_GPR_COUNT)
                    seed_owner = (pl_u32)seed_right.value;
                else if (seed_right.value == destination
                        && seed_left.value < PL_X86_GPR_COUNT)
                    seed_owner = (pl_u32)seed_left.value;
            }
            if (seed_owner >= PL_X86_GPR_COUNT
                    || seed_owner == parent_owner)
                continue;

            for (pl_u32 parent_shift_at = 0u;
                    parent_shift_at < leaf_count; ++parent_shift_at) {
                if (parent_shift_at == parent_at) continue;
                pl_operand parent_shift_source, parent_shift_amount;
                pl_u32 parent_shift_bits = 0u;
                pl_u32 parent_shift_group = 0u;
                if (!pl_select_shift_node_details(
                        plan, leaves[parent_shift_at],
                        &parent_shift_source, &parent_shift_amount,
                        &parent_shift_bits, &parent_shift_group)
                        || parent_shift_bits != 64u
                        || !pl_select_equal_operand(parent_shift_source, parent)
                        || !nonzero_word_shift(parent_shift_amount))
                    continue;

                for (pl_u32 seed_shift_at = 0u;
                        seed_shift_at < leaf_count; ++seed_shift_at) {
                    if (seed_shift_at == parent_at
                            || seed_shift_at == parent_shift_at)
                        continue;
                    pl_operand seed_shift_source, seed_shift_amount;
                    pl_u32 seed_shift_bits = 0u;
                    pl_u32 seed_shift_group = 0u;
                    if (!pl_select_shift_node_details(
                            plan, leaves[seed_shift_at],
                            &seed_shift_source, &seed_shift_amount,
                            &seed_shift_bits, &seed_shift_group)
                            || seed_shift_bits != 64u
                            || !pl_select_equal_operand(seed_shift_source, seed)
                            || !nonzero_word_shift(seed_shift_amount))
                        continue;

                    pl_u32 side_at = 0u;
                    while (side_at == parent_at
                            || side_at == parent_shift_at
                            || side_at == seed_shift_at)
                        ++side_at;
                    if (side_at >= leaf_count) continue;
                    pl_operand side_inner, side_outer_amount;
                    pl_u32 side_outer_bits = 0u;
                    pl_u32 side_outer_group = 0u;
                    if (!pl_select_shift_node_details(
                            plan, leaves[side_at], &side_inner,
                            &side_outer_amount, &side_outer_bits,
                            &side_outer_group)
                            || side_outer_bits != 64u
                            || !nonzero_word_shift(side_outer_amount))
                        continue;
                    pl_operand side_left, side_right;
                    pl_u32 side_bits = 0u, side_mode = 0u;
                    if (!pl_select_arithmetic_tree_details(
                            plan, side_inner, &side_left, &side_right,
                            &side_bits, &side_mode)
                            || side_bits != 64u || side_mode != 6u)
                        continue;
                    pl_operand side_shift = side_left;
                    if (side_right.kind == PL_OPERAND_LOCAL
                            && side_right.value == parent_owner)
                        side_shift = side_left;
                    else if (side_left.kind == PL_OPERAND_LOCAL
                            && side_left.value == parent_owner)
                        side_shift = side_right;
                    else
                        continue;
                    pl_operand side_source, side_inner_amount;
                    pl_u32 side_inner_bits = 0u;
                    pl_u32 side_inner_group = 0u;
                    if (!pl_select_shift_node_details(
                            plan, side_shift, &side_source,
                            &side_inner_amount, &side_inner_bits,
                            &side_inner_group)
                            || side_inner_bits != 64u
                            || side_source.kind != PL_OPERAND_LOCAL
                            || side_source.value >= PL_X86_GPR_COUNT
                            || !nonzero_word_shift(side_inner_amount))
                        continue;
                    pl_u32 side_owner = (pl_u32)side_source.value;
                    if (side_owner == destination
                            || side_owner == seed_owner
                            || side_owner == parent_owner)
                        continue;

                    pl_u32 zero_mask = changed & gpr_mask
                                     & ~(1u << destination);
                    int exact_zero_tail = 1;
                    pl_u32 flag_owner = PL_X86_GPR_COUNT;
                    for (pl_u32 local = 0u;
                            local < PL_X86_GPR_COUNT; ++local) {
                        if (!(zero_mask & (1u << local))) continue;
                        if (!pl_select_zero_result_operand(plan, plan->locals[local])) {
                            exact_zero_tail = 0;
                            break;
                        }
                        if (pl_select_publication_is_flag_result(
                                plan, plan->locals[local],
                                final_flag_node))
                            flag_owner = local;
                    }
                    if (!exact_zero_tail
                            || flag_owner >= PL_X86_GPR_COUNT
                            || !(zero_mask & (1u << seed_owner))
                            || !(zero_mask & (1u << parent_owner))
                            || !(zero_mask & (1u << side_owner)))
                        continue;

                    *out = (arx_shared_dag_frame){
                        destination, seed_owner, parent_owner, side_owner,
                        seed_bits,
                        seed_shift_group, parent_shift_group,
                        side_inner_group, side_outer_group,
                        zero_mask, flag_owner,
                        seed_shift_amount, parent_shift_amount,
                        side_inner_amount, side_outer_amount,
                    };
                    return 1;
                }
            }
        }
    }
    return 0;
}

static int emit_arx_shared_dag_frame(
    const arx_shared_dag_frame *shape,
    pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, part = 0u;
    pl_operand parent = { PL_OPERAND_LOCAL, shape->parent_owner };
    pl_operand seed = { PL_OPERAND_LOCAL, shape->seed_owner };
    pl_operand side = { PL_OPERAND_LOCAL, shape->side_owner };
    pl_operand destination = { PL_OPERAND_LOCAL, shape->destination };

#define APPEND_ARX(operation) do { \
        part = 0u; \
        if (!(operation) || at > U32_MAX_VALUE - part) return 0; \
        at += part; \
    } while (0)
    APPEND_ARX(pl_select_emit_shift_instruction(
        shape->side_owner, shape->side_inner_shift_amount, 64u,
        shape->side_inner_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_alu_instruction(
        shape->side_owner, parent, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_shift_instruction(
        shape->side_owner, shape->side_outer_shift_amount, 64u,
        shape->side_outer_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_alu_instruction(
        shape->seed_owner, destination, shape->seed_bits, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_alu_instruction(
        shape->parent_owner, seed, 64u, 1u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_gpr_move(
        shape->destination, shape->parent_owner, 64u,
        output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_shift_instruction(
        shape->destination, shape->parent_shift_amount, 64u,
        shape->parent_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_shift_instruction(
        shape->seed_owner, shape->seed_shift_amount, 64u,
        shape->seed_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_alu_instruction(
        shape->seed_owner, parent, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_alu_instruction(
        shape->side_owner, seed, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(pl_select_emit_alu_instruction(
        shape->destination, side, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape->zero_mask & (1u << local))
                || local == shape->flag_owner)
            continue;
        APPEND_ARX(pl_select_emit_zero_register(
            local, output ? output + at : 0, &part));
    }
    APPEND_ARX(pl_select_emit_zero_register(
        shape->flag_owner, output ? output + at : 0, &part));
#undef APPEND_ARX
    *written = at;
    return 1;
}

int pl_select_measure_direct_arx_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    (void)frontend;
    if (!block || !selection || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    arx_shared_dag_frame shape;
    if (!pl_select_alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !arx_shared_dag_frame_details(
                &block->plan, changed, final_flag_node, &shape)
            || !emit_arx_shared_dag_frame(
                &shape, (pl_u8 *)0, &selection->output_bytes))
        return 0;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_arx_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_arx_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !output) return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, final_flag_node = 0u, written = 0u;
    arx_shared_dag_frame shape;
    if (!pl_select_alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !arx_shared_dag_frame_details(
                &block->plan, changed, final_flag_node, &shape)
            || !emit_arx_shared_dag_frame(&shape, output, &written)
            || written != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}

/* If both S and shift(S) are leaves of one XOR future, S has two generations
 * but only one coordinate.  Consume entry S into the final accumulator,
 * overwrite S with its shifted generation, fold an independent leaf into S,
 * and join it once.  Register renaming removes the textual WAR edge; the
 * emitted RAW graph therefore reaches the associative lower span without a
 * copy or a residual-state row. */
static int mutable_xor_frame_details(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    mutable_xor_frame *out)
{
    if (!plan || !changed || !final_flag_node || !out) return 0;
    const pl_u32 gpr_mask = (1u << PL_X86_GPR_COUNT) - 1u;
    pl_u32 destination = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        if (pl_select_zero_result_operand(plan, plan->locals[local])) continue;
        if (destination != PL_X86_GPR_COUNT) return 0;
        destination = local;
    }
    if (destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand root = plan->locals[destination];
    pl_operand root_left, root_right;
    pl_u32 root_bits = 0u, root_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, root, &root_left, &root_right,
            &root_bits, &root_mode)
            || root_bits != 64u || root_mode != 6u
            || pl_select_publication_owner(plan, root) != destination)
        return 0;
    pl_u32 capacity = plan->node_count + 1u;
    pl_operand leaves[capacity];
    pl_u32 leaf_count = 0u;
    if (!pl_select_collect_associative_leaves(
            plan, root, 64u, 6u, leaves, capacity, &leaf_count,
            plan->node_count + 1u)
            || leaf_count != 4u)
        return 0;

    for (pl_u32 mutable_at = 0u; mutable_at < leaf_count; ++mutable_at) {
        if (leaves[mutable_at].kind != PL_OPERAND_LOCAL
                || leaves[mutable_at].value >= PL_X86_GPR_COUNT)
            continue;
        pl_u32 mutable_owner = (pl_u32)leaves[mutable_at].value;
        if (mutable_owner == destination) continue;
        for (pl_u32 shift_at = 0u; shift_at < leaf_count; ++shift_at) {
            if (shift_at == mutable_at) continue;
            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            if (!pl_select_shift_node_details(
                    plan, leaves[shift_at], &shift_source, &shift_amount,
                    &shift_bits, &shift_group)
                    || shift_bits != 64u
                    || shift_source.kind != PL_OPERAND_LOCAL
                    || shift_source.value != mutable_owner
                    || !nonzero_word_shift(shift_amount))
                continue;
            pl_u32 remaining[2u];
            pl_u32 count = 0u;
            for (pl_u32 at = 0u; at < leaf_count; ++at)
                if (at != mutable_at && at != shift_at)
                    remaining[count++] = at;
            if (count != 2u) continue;
            for (pl_u32 orientation = 0u; orientation < 2u;
                    ++orientation) {
                pl_operand accumulator = leaves[remaining[orientation]];
                pl_operand independent = leaves[remaining[orientation ^ 1u]];
                pl_u32 accumulator_sources = 0u;
                pl_u32 independent_sources = 0u;
                if (!pl_select_operand_entry_gpr_sources(
                        plan, accumulator, plan->node_count + 1u,
                        plan->node_count + 1u, &accumulator_sources)
                        || !pl_select_operand_entry_gpr_sources(
                            plan, independent, plan->node_count + 1u,
                            plan->node_count + 1u,
                            &independent_sources))
                    continue;
                pl_u32 destination_bit = 1u << destination;
                pl_u32 mutable_bit = 1u << mutable_owner;
                if (!(accumulator_sources & destination_bit)
                        || (accumulator_sources & mutable_bit)
                        || (independent_sources
                            & (destination_bit | mutable_bit)))
                    continue;
                pl_u32 zero_mask = changed & gpr_mask & ~destination_bit;
                pl_u32 flag_owner = PL_X86_GPR_COUNT;
                int exact_zero_tail = 1;
                for (pl_u32 local = 0u;
                        local < PL_X86_GPR_COUNT; ++local) {
                    if (!(zero_mask & (1u << local))) continue;
                    if (!pl_select_zero_result_operand(plan, plan->locals[local])) {
                        exact_zero_tail = 0;
                        break;
                    }
                    if (pl_select_publication_is_flag_result(
                            plan, plan->locals[local], final_flag_node))
                        flag_owner = local;
                }
                if (!exact_zero_tail
                        || flag_owner >= PL_X86_GPR_COUNT
                        || !(zero_mask & mutable_bit))
                    continue;
                for (pl_u32 owner = 0u;
                        owner < PL_X86_GPR_COUNT; ++owner) {
                    pl_u32 owner_bit = 1u << owner;
                    if (!(independent_sources & owner_bit)
                            || !(zero_mask & owner_bit)
                            || (accumulator_sources & owner_bit))
                        continue;
                    *out = (mutable_xor_frame){
                        destination, mutable_owner, owner, shift_group,
                        zero_mask, flag_owner,
                        pl_select_operand_expression_bits(plan, accumulator, 64u),
                        pl_select_operand_expression_bits(plan, independent, 64u),
                        accumulator, independent, shift_amount,
                    };
                    return 1;
                }
            }
        }
    }
    return 0;
}

int pl_select_measure_direct_mutable_xor_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    mutable_xor_frame shape;
    if (!pl_select_alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !mutable_xor_frame_details(
                &block->plan, changed, final_flag_node, &shape))
        return 0;
    pl_u32 bytes = 0u, work = 0u, part = 0u, part_work = 0u;
    int status = pl_select_measure_alu_tree(
        frontend, block, selection, shape.independent_owner,
        shape.independent, shape.independent_bits, bytes,
        block->plan.node_count + 1u, 0u, &part, &part_work);
    if (status <= 0) return status;
    bytes += part;
    work += part_work;
    status = pl_select_measure_alu_tree(
        frontend, block, selection, shape.destination,
        shape.accumulator, shape.accumulator_bits, bytes,
        block->plan.node_count + 1u, 0u, &part, &part_work);
    if (status <= 0 || bytes > U32_MAX_VALUE - part
            || work > U32_MAX_VALUE - part_work)
        return status < 0 ? status : 0;
    bytes += part;
    work += part_work;
    pl_operand mutable_value = {
        PL_OPERAND_LOCAL, shape.mutable_owner,
    };
    pl_operand independent_value = {
        PL_OPERAND_LOCAL, shape.independent_owner,
    };
#define MEASURE_MUTABLE(operation) do { \
        part = 0u; \
        if (!(operation) || bytes > U32_MAX_VALUE - part) return 0; \
        bytes += part; \
        if (work == U32_MAX_VALUE) return 0; \
        ++work; \
    } while (0)
    MEASURE_MUTABLE(pl_select_emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        (pl_u8 *)0, &part));
    MEASURE_MUTABLE(pl_select_emit_shift_instruction(
        shape.mutable_owner, shape.mutable_shift_amount, 64u,
        shape.mutable_shift_group, (pl_u8 *)0, &part));
    MEASURE_MUTABLE(pl_select_emit_alu_instruction(
        shape.mutable_owner, independent_value, 64u, 6u, 0u,
        (pl_u8 *)0, &part));
    MEASURE_MUTABLE(pl_select_emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        (pl_u8 *)0, &part));
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.zero_mask & (1u << local))
                || local == shape.flag_owner)
            continue;
        MEASURE_MUTABLE(pl_select_emit_zero_register(
            local, (pl_u8 *)0, &part));
    }
    MEASURE_MUTABLE(pl_select_emit_zero_register(
        shape.flag_owner, (pl_u8 *)0, &part));
#undef MEASURE_MUTABLE
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_mutable_xor_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_mutable_xor_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !output) return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, final_flag_node = 0u;
    mutable_xor_frame shape;
    if (!pl_select_alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !mutable_xor_frame_details(
                &block->plan, changed, final_flag_node, &shape))
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, part = 0u;
    if (!pl_select_write_alu_tree(
            block, selection, shape.independent_owner,
            shape.independent, shape.independent_bits, at,
            block->plan.node_count + 1u, 0u,
            output + at, &part))
        return PL_ERROR_X86_SELECT;
    at += part;
    if (!pl_select_write_alu_tree(
            block, selection, shape.destination,
            shape.accumulator, shape.accumulator_bits, at,
            block->plan.node_count + 1u, 0u,
            output + at, &part))
        return PL_ERROR_X86_SELECT;
    at += part;
    pl_operand mutable_value = {
        PL_OPERAND_LOCAL, shape.mutable_owner,
    };
    pl_operand independent_value = {
        PL_OPERAND_LOCAL, shape.independent_owner,
    };
#define WRITE_MUTABLE(operation) do { \
        part = 0u; \
        if (!(operation) || at > U32_MAX_VALUE - part) \
            return PL_ERROR_X86_SELECT; \
        at += part; \
    } while (0)
    WRITE_MUTABLE(pl_select_emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        output + at, &part));
    WRITE_MUTABLE(pl_select_emit_shift_instruction(
        shape.mutable_owner, shape.mutable_shift_amount, 64u,
        shape.mutable_shift_group, output + at, &part));
    WRITE_MUTABLE(pl_select_emit_alu_instruction(
        shape.mutable_owner, independent_value, 64u, 6u, 0u,
        output + at, &part));
    WRITE_MUTABLE(pl_select_emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        output + at, &part));
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.zero_mask & (1u << local))
                || local == shape.flag_owner)
            continue;
        WRITE_MUTABLE(pl_select_emit_zero_register(
            local, output + at, &part));
    }
    WRITE_MUTABLE(pl_select_emit_zero_register(
        shape.flag_owner, output + at, &part));
#undef WRITE_MUTABLE
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}
