/* tree-write: native x86 selection. */
#include "tree-write.h"
#include "limits.h"
#include "lea.h"
#include "encoding.h"
#include "expressions.h"
#include "operands.h"
#include "select-rules.h"
#include "tree-measure.h"

static void write_u32(pl_u8 *output, pl_u32 at, pl_u32 value);

static void write_u64(pl_u8 *output, pl_u32 at, pl_u64 value);

static int address_fixup_at(const pl_x86_native_selection *selection,
                            pl_u32 output_at, pl_u64 target,
                            pl_u32 bits, pl_u32 destination);

static int write_entry_bit_overlay(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written);

static void write_u32(pl_u8 *output, pl_u32 at, pl_u32 value)
{
    for (pl_u32 byte = 0u; byte < 4u; ++byte)
        output[at + byte] = (pl_u8)(value >> (byte * 8u));
}

static void write_u64(pl_u8 *output, pl_u32 at, pl_u64 value)
{
    for (pl_u32 byte = 0u; byte < 8u; ++byte)
        output[at + byte] = (pl_u8)(value >> (byte * 8u));
}

static int address_fixup_at(const pl_x86_native_selection *selection,
                            pl_u32 output_at, pl_u64 target,
                            pl_u32 bits, pl_u32 destination)
{
    if (!selection || output_at > U32_MAX_VALUE - 7u) return 0;
    pl_u32 prefix = bits == 64u || destination >= 8u ? 1u : 0u;
    pl_u64 mask = bits == 32u ? U32_MAX_VALUE : U64_MAX_VALUE;
    for (pl_u32 index = 0u; index < selection->fixup_count; ++index) {
        const pl_x86_native_fixup *fixup = &selection->fixups[index];
        if (fixup->kind == PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                && fixup->bytes == 4u && fixup->at == output_at + prefix + 2u
                && fixup->next_ip_at == output_at + prefix + 6u
                && (fixup->target & mask) == (target & mask))
            return 1;
    }
    return 0;
}

int pl_select_absolute_fixup_at(const pl_x86_native_selection *selection,
                             pl_u32 output_at, pl_u64 target)
{
    if (!selection || output_at > U32_MAX_VALUE - 10u) return 0;
    for (pl_u32 index = 0u; index < selection->fixup_count; ++index) {
        const pl_x86_native_fixup *fixup = &selection->fixups[index];
        if (fixup->kind == PL_X86_NATIVE_FIXUP_ABSOLUTE
                && fixup->bytes == 8u && fixup->at == output_at + 2u
                && fixup->next_ip_at == output_at + 10u
                && fixup->target == target)
            return 1;
    }
    return 0;
}

int pl_select_write_frame_value(const pl_x86_native_selection *selection,
                             pl_u32 output_at, pl_u32 local,
                             pl_operand value, pl_u8 *output,
                             pl_u32 *written)
{
    if (!selection || !output || !written || local >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 at = 0u;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        pl_u32 source = (pl_u32)value.value;
        output[at++] = (pl_u8)(0x48u
            | (source >= 8u ? 4u : 0u)
            | (local >= 8u ? 1u : 0u));
        output[at++] = 0x89u;
        output[at++] = (pl_u8)(0xc0u
            | ((source & 7u) << 3u) | (local & 7u));
    } else if (value.kind != PL_OPERAND_CONST) {
        return 0;
    } else if (pl_select_absolute_fixup_at(selection, output_at, value.value)) {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 1u : 0u));
        output[at++] = (pl_u8)(0xb8u + (local & 7u));
        write_u64(output, at, 0u);
        at += 8u;
    } else if (address_fixup_at(selection, output_at, value.value, 64u, local)) {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 4u : 0u));
        output[at++] = 0x8du;
        output[at++] = (pl_u8)(0x05u | ((local & 7u) << 3u));
        write_u32(output, at, 0u);
        at += 4u;
    } else if (value.value <= 0xffffffffu) {
        if (local >= 8u) output[at++] = 0x41u;
        output[at++] = (pl_u8)(0xb8u + (local & 7u));
        write_u32(output, at, (pl_u32)value.value);
        at += 4u;
    } else if (value.value >= 0xffffffff80000000ull) {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 1u : 0u));
        output[at++] = 0xc7u;
        output[at++] = (pl_u8)(0xc0u | (local & 7u));
        write_u32(output, at, (pl_u32)value.value);
        at += 4u;
    } else {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 1u : 0u));
        output[at++] = (pl_u8)(0xb8u + (local & 7u));
        write_u64(output, at, value.value);
        at += 8u;
    }
    *written = at;
    return 1;
}

int pl_select_write_alu_seed(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand value,
                          pl_u32 bits, pl_u32 output_at,
                          pl_u32 remaining, pl_u8 *output,
                          pl_u32 *written)
{
    if (!block || !selection || !output || !written || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_select_physicalize_transient_operand(selection, &value);
    if (pl_select_emit_test_boolean(&block->plan, value, destination, output, written)) return 1;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        if (value.value == destination) {
            *written = 0u;
            return 1;
        }
        return pl_select_emit_gpr_move(destination, (pl_u32)value.value, bits,
                             output, written);
    }
    if (value.kind == PL_OPERAND_CONST && bits == 32u
            && address_fixup_at(selection, output_at, value.value, bits, destination)) {
        pl_u32 at = 0u;
        if (destination >= 8u) output[at++] = 0x44u;
        output[at++] = 0x8du;
        output[at++] = (pl_u8)(0x05u | ((destination & 7u) << 3u));
        write_u32(output, at, 0u);
        *written = at + 4u;
        return 1;
    }
    if (value.kind == PL_OPERAND_CONST && (bits == 8u || bits == 16u))
        return pl_select_emit_lane_constant_move(
            destination, value.value, bits, output, written);
    if (value.kind == PL_OPERAND_CONST)
        return pl_select_write_frame_value(
            selection, output_at, destination, value, output, written);
    pl_u32 extension_source = 0u, extension_bits = 0u;
    if (value.kind == PL_OPERAND_NODE
            && pl_select_zero_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits))
        return pl_select_emit_zero_extend_move(destination, extension_source, extension_bits,
                                     output, written);
    /* A sign extension whose operand is a 32-bit register is one `movslq`.
     * Without this branch the extension is materialized relative to the
     * incoming accumulator (`cltq`), which forces a spurious producer into the
     * same destination and costs an extra work. */
    if (value.kind == PL_OPERAND_NODE
            && pl_select_sign_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits)
            && extension_bits == 32u && bits == 32u)
        return pl_select_emit_sign_extend_move(
            destination, extension_source, extension_bits, output, written);
    pl_operand negation_source;
    pl_u32 negation_bits = 0u;
    if (pl_select_negation_node_details(
            &block->plan, value, &negation_source, &negation_bits)
            && negation_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 at = 0u, encoded = 0u;
        if (!pl_select_write_alu_seed(
                block, selection, destination, negation_source, bits,
                output_at, remaining - 1u, output + at, &encoded))
            return 0;
        at += encoded;
        if (!pl_select_emit_neg_register(
                destination, bits, output + at, &encoded)
                || at > U32_MAX_VALUE - encoded)
            return 0;
        *written = at + encoded;
        return 1;
    }
    pl_operand complement_source;
    pl_u32 complement_bits = 0u;
    if (pl_select_complement_node_details(
            &block->plan, value, &complement_source, &complement_bits)
            && (complement_bits == bits
                || (bits == 32u && complement_bits == 64u))) {
        if (remaining <= 1u) return 0;
        pl_u32 prefix = 0u;
        if (!pl_select_write_alu_seed(
                block, selection, destination, complement_source, bits,
                output_at, remaining - 1u, output, &prefix))
            return 0;
        pl_u32 operation = 0u;
        if (!pl_select_emit_not_register(
                destination, bits, output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation)
            return 0;
        *written = prefix + operation;
        return 1;
    }
    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (pl_select_shift_node_details(
            &block->plan, value, &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            && shift_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 published = 0u;
        if ((shift_source.kind == PL_OPERAND_NODE
                || shift_source.kind == PL_OPERAND_PROJECTION)
                && pl_select_published_operand_local(
                    &block->plan, shift_source, &published)
                && published != destination) {
            shift_source.kind = PL_OPERAND_LOCAL;
            shift_source.value = published;
        }
        if (shift_amount.kind == PL_OPERAND_LOCAL
                && shift_amount.value == destination
                && !(shift_source.kind == PL_OPERAND_LOCAL
                    && shift_source.value == destination))
            return 0;
        pl_u32 count_mask = bits == 64u ? 63u : 31u;
        if (shift_group == 4u
                && shift_source.kind == PL_OPERAND_LOCAL
                && shift_source.value != destination
                && shift_amount.kind == PL_OPERAND_CONST
                && !pl_select_final_flags_are_shift(&block->plan)
                && pl_select_emit_shifted_copy(
                    destination, (pl_u32)shift_source.value, bits,
                    (pl_u32)shift_amount.value & count_mask,
                    output, written))
            return 1;
        pl_u32 prefix = 0u;
        if (!pl_select_write_alu_seed(
                block, selection, destination, shift_source, bits,
                output_at, remaining - 1u, output, &prefix))
            return 0;
        pl_u32 operation = 0u;
        if (!pl_select_emit_shift_instruction(
                destination, shift_amount, bits, shift_group,
                output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation)
            return 0;
        *written = prefix + operation;
        return 1;
    }
    affine_lea form = { 0 };
    if (pl_select_collect_affine_lea_width(
            &block->plan, value, bits, remaining, &form)
            && pl_select_emit_affine_lea_width(
                destination, form, bits, output, written))
        return 1;
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            &block->plan, value, &left, &right, &node_bits, &mode))
        return 0;
    pl_select_physicalize_selected_operand(
        &block->plan, selection, destination, &left);
    pl_select_physicalize_selected_operand(
        &block->plan, selection, destination, &right);
    pl_select_orient_commutative_destination(
        &block->plan, destination, mode, &left, &right);
    if (mode == 1u && pl_select_emit_add_lea(
            destination, left, right, node_bits, output, written))
        return 1;
    if ((right.kind == PL_OPERAND_LOCAL
                && right.value == destination
                && !(left.kind == PL_OPERAND_LOCAL
                     && left.value == destination)))
        return 0;
    pl_u32 prefix = 0u;
    pl_u32 left_bits = pl_select_operand_expression_bits(
        &block->plan, left, node_bits);
    if (!pl_select_write_alu_seed(
            block, selection, destination, left, left_bits, output_at,
            remaining - 1u, output, &prefix))
        return 0;
    pl_u32 operation = 0u;
    if (!pl_select_emit_alu_instruction(destination, right, node_bits, mode, 0u,
                              output + prefix, &operation)
            || prefix > U32_MAX_VALUE - operation)
        return 0;
    *written = prefix + operation;
    return 1;
}

int pl_select_write_alu_tree(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand value,
                          pl_u32 bits, pl_u32 output_at,
                          pl_u32 remaining, pl_u32 scratch_mask,
                          pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !output || !written || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    /* A 32-bit sign extension of a register is one `movslq`.  Do it before
     * `pl_select_write_alu_seed`, whose transient-alias resolution would otherwise
     * rewrite the node to an incoming accumulator and force `cltq` plus a
     * spurious producer into the same destination. */
    if (value.kind == PL_OPERAND_NODE) {
        pl_u32 extension_source = 0u, extension_bits = 0u;
        if (pl_select_sign_extend_node(&block->plan, (pl_u32)value.value,
                              &extension_source, &extension_bits)
                && extension_bits == 32u
                && pl_select_emit_sign_extend_move(
                    destination, extension_source, extension_bits,
                    output, written))
            return 1;
        /* A 32-bit sign extension whose operand is a node another publication
         * already placed in a GPR is one `movslq` from that coordinate.
         * Rebuilding the node first would materialize it a second time; the
         * frame's source law already orders that publication first. */
        pl_operand extension_argument = { 0 };
        pl_u32 extension_owner = PL_X86_GPR_COUNT;
        if (pl_select_sign_extend_value(&block->plan, (pl_u32)value.value,
                              &extension_argument, &extension_bits)
                && extension_bits == 32u
                && extension_argument.kind == PL_OPERAND_NODE
                && pl_select_published_operand_local(
                    &block->plan, extension_argument, &extension_owner)
                && pl_select_emit_sign_extend_move(
                    destination, extension_owner, extension_bits,
                    output, written))
            return 1;
    }
    masked_entry_affine entry_affine;
    pl_u32 entry_affine_work = 0u;
    if (pl_select_masked_entry_affine_details(
            &block->plan, value, destination, &entry_affine)
            && (scratch_mask & (1u << entry_affine.source))
            && pl_select_emit_masked_entry_affine(
                &entry_affine, output, written, &entry_affine_work)) {
        (void)entry_affine_work;
        return 1;
    }
    if (pl_select_write_alu_seed(
            block, selection, destination, value, bits, output_at,
            remaining, output, written))
        return 1;
    if (remaining <= 1u) return 0;

    pl_operand insert_base, insert_inner;
    pl_u32 insert_width = 0u;
    if (pl_select_node_base_lane_insert(&block->plan, value, &insert_base,
                              &insert_inner, &insert_width)) {
        pl_x86_native_selection cleared = *selection;
        cleared.frame_alias_present = 0u;
        pl_u32 base_written = 0u;
        if (!pl_select_write_alu_tree(block, &cleared, destination, insert_base, bits,
                output_at, remaining - 1u, scratch_mask,
                output, &base_written))
            return 0;
        pl_x86_native_selection aliased = *selection;
        aliased.frame_alias_value = insert_base.value;
        aliased.frame_alias_kind = insert_base.kind;
        aliased.frame_alias_local = (pl_u8)destination;
        aliased.frame_alias_present = 1u;
        pl_u32 inner_written = 0u;
        if (!pl_select_write_alu_tree(block, &aliased, destination, insert_inner,
                insert_width, output_at + base_written, remaining - 1u,
                scratch_mask, output + base_written, &inner_written))
            return 0;
        *written = base_written + inner_written;
        return 1;
    }

    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_BSWAP
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_BSWAP)) {
        pl_u32 byte_swap_bits = block->plan.nodes[value.value - 1u].opcode
                              == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
        pl_operand byte_swap_source = block->plan.arguments[
            block->plan.nodes[value.value - 1u].argument_at];
        pl_u32 prefix = 0u;
        if (!pl_select_write_alu_tree(
                block, selection, destination, byte_swap_source,
                byte_swap_bits, output_at, remaining - 1u, scratch_mask,
                output, &prefix)
                || !pl_select_emit_bswap_register(
                    destination, byte_swap_bits, output + prefix, written))
            return 0;
        *written += prefix;
        return 1;
    }

    pl_operand tree_shift_source, tree_shift_amount;
    pl_u32 tree_shift_bits = 0u, tree_shift_group = 0u;
    if (pl_select_shift_node_details(&block->plan, value, &tree_shift_source,
            &tree_shift_amount, &tree_shift_bits, &tree_shift_group)) {
        pl_u32 shift_prefix = 0u, shift_operation = 0u;
        if (!pl_select_write_alu_tree(
                block, selection, destination, tree_shift_source,
                tree_shift_bits, output_at, remaining - 1u, scratch_mask,
                output, &shift_prefix)
                || !pl_select_emit_shift_instruction(
                    destination, tree_shift_amount, tree_shift_bits,
                    tree_shift_group, output + shift_prefix, &shift_operation))
            return 0;
        *written = shift_prefix + shift_operation;
        return 1;
    }

    /* Nested conditional select over an incoming condition; mirrors
     * pl_select_measure_alu_tree exactly so measured and written spellings match. */
    boolean_select tree_boolean;
    condition_value tree_condition;
    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_SELECT
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_SELECT)
            && pl_select_boolean_select_details(&block->plan, value, &tree_boolean)
            && pl_select_condition_value_details(
                &block->plan, tree_boolean.condition, &tree_condition)
            && tree_condition.flags.kind == PL_OPERAND_LOCAL
            && tree_condition.flags.value == PL_X86_RFLAGS_LOCAL) {
        pl_u32 false_local = 0u;
        int false_is_destination =
            (tree_boolean.when_false.kind == PL_OPERAND_LOCAL
                && tree_boolean.when_false.value == destination)
            || ((tree_boolean.when_false.kind == PL_OPERAND_NODE
                    || tree_boolean.when_false.kind == PL_OPERAND_PROJECTION)
                && pl_select_published_operand_local(
                    &block->plan, tree_boolean.when_false, &false_local)
                && false_local == destination);
        if (false_is_destination) {
            pl_u32 candidate_local = PL_X86_GPR_COUNT;
            if (tree_boolean.when_true.kind == PL_OPERAND_CONST) {
                for (pl_u32 scratch = 0u;
                        scratch < PL_X86_GPR_COUNT; ++scratch)
                    if (scratch != destination
                            && (scratch_mask & (1u << scratch))) {
                        candidate_local = scratch;
                        break;
                    }
                if (candidate_local >= PL_X86_GPR_COUNT) return 0;
                pl_u32 part = 0u;
                if (!pl_select_write_alu_tree(
                        block, selection, candidate_local,
                        tree_boolean.when_true, tree_boolean.value_bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~(1u << candidate_local),
                        output, &part))
                    return 0;
                pl_u32 move_bytes = 0u;
                if (!pl_select_emit_conditional_move(
                        destination, candidate_local,
                        tree_boolean.value_bits, tree_condition.condition,
                        output + part, &move_bytes))
                    return 0;
                *written = part + move_bytes;
                return 1;
            }
            if (tree_boolean.when_true.kind == PL_OPERAND_LOCAL
                    && tree_boolean.when_true.value < PL_X86_GPR_COUNT
                    && tree_boolean.when_true.value != destination) {
                return 0;
            }
            return 0;
        }
    }

    condition_value flag_condition;
    if (pl_select_condition_value_details(&block->plan, value, &flag_condition)
            && flag_condition.flags.kind == PL_OPERAND_NODE) {
        pl_operand compare_left, compare_right;
        pl_u32 compare_bits = 0u, compare_mode = 0u, compare_carry = 0u;
        if (pl_select_flag_operation_details(
                &block->plan, flag_condition.flags, &compare_left,
                &compare_right, &compare_bits, &compare_mode, &compare_carry)
                && !compare_carry
                && (compare_mode == 0u || compare_mode == 3u)) {
            pl_select_physicalize_published_operand(
                &block->plan, destination, &compare_left);
            pl_select_physicalize_published_operand(
                &block->plan, destination, &compare_right);
            if (compare_left.kind == PL_OPERAND_LOCAL
                    && compare_left.value < PL_X86_GPR_COUNT) {
                pl_operand physical_right = compare_right;
                pl_u32 at = 0u, part = 0u;
                if (physical_right.kind == PL_OPERAND_CONST) {
                    pl_u32 operand_local = destination;
                    if (operand_local == (pl_u32)compare_left.value) {
                        operand_local = PL_X86_GPR_COUNT;
                        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                                ++scratch)
                            if (scratch != destination
                                    && scratch != (pl_u32)compare_left.value
                                    && (scratch_mask & (1u << scratch))) {
                                operand_local = scratch;
                                break;
                            }
                    }
                    if (operand_local >= PL_X86_GPR_COUNT)
                        return 0;
                    if (!pl_select_write_alu_tree(
                            block, selection, operand_local, compare_right,
                            compare_bits, output_at, remaining - 1u,
                            operand_local == destination
                                ? scratch_mask
                                : scratch_mask & ~(1u << operand_local),
                            output, &part))
                        return 0;
                    at += part;
                    physical_right = (pl_operand){ PL_OPERAND_LOCAL,
                                                   operand_local };
                } else if (!(physical_right.kind == PL_OPERAND_LOCAL
                        && physical_right.value < PL_X86_GPR_COUNT)) {
                    return 0;
                }
                int zero_after_compare = destination == compare_left.value
                    || (physical_right.kind == PL_OPERAND_LOCAL
                        && destination == physical_right.value);
                pl_u32 zero_bytes = 0u;
                if (!zero_after_compare
                        && !pl_select_emit_boolean_zero(
                            destination, 0, output + at, &zero_bytes))
                    return 0;
                at += zero_bytes;
                if (!pl_select_emit_flag_coordinate(
                        (pl_u32)compare_left.value, physical_right,
                        compare_bits, compare_mode == 0u, 0u,
                        output + at, &part))
                    return 0;
                at += part;
                if (zero_after_compare) {
                    if (!pl_select_emit_boolean_zero(
                            destination, 1, output + at, &zero_bytes))
                        return 0;
                    at += zero_bytes;
                }
                if (!pl_select_emit_set_condition(
                        destination, flag_condition.condition,
                        output + at, &part))
                    return 0;
                at += part;
                *written = at;
                return 1;
            }
        }
    }

    pl_operand shared_seed, shared_amount;
    pl_u32 shared_group = 0u, shared_mode = 0u;
    if (pl_select_shared_shift_join(&block->plan, value, bits, &shared_seed,
                          &shared_amount, &shared_group, &shared_mode)) {
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            if (scratch == destination || !(scratch_mask & (1u << scratch)))
                continue;
            pl_u32 prefix = 0u, tail = 0u;
            if (pl_select_write_alu_tree(block, selection, destination, shared_seed,
                    bits, output_at, remaining - 1u, scratch_mask,
                    output, &prefix)
                    && pl_select_emit_shared_shift_join(destination, scratch,
                        shared_amount, bits, shared_group, shared_mode,
                        output + prefix, &tail)
                    && prefix <= U32_MAX_VALUE - tail) {
                *written = prefix + tail;
                return 1;
            }
        }
    }

    carry_adjustment adjustment;
    pl_u32 adjustment_work = 0u;
    if (pl_select_carry_adjustment_details(&block->plan, value, destination, bits, &adjustment)
            && pl_select_emit_carry_adjustment(&adjustment, destination, output, written,
                                     &adjustment_work)) return 1;
    pl_operand signed_source;
    pl_u32 signed_bits = 0u;
    if (bits == 64u && value.kind == PL_OPERAND_NODE
            && pl_select_sign_extend_value(&block->plan, (pl_u32)value.value,
                                 &signed_source, &signed_bits)) {
        pl_u32 prefix = 0u, operation = 0u;
        if (!pl_select_write_alu_tree(
                block, selection, destination, signed_source, 32u, output_at,
                remaining - 1u, scratch_mask, output, &prefix)
                || !pl_select_emit_sign_extend_move(destination, destination, signed_bits,
                                          output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation)
            return 0;
        *written = prefix + operation;
        return 1;
    }

    pl_operand multiply_left, multiply_right;
    pl_u32 multiply_bits = 0u;
    if (pl_select_multiply_word_operands(&block->plan, selection, value, destination,
                              &multiply_left, &multiply_right, &multiply_bits)) {
        pl_u32 prefix = 0u, operation = 0u;
        pl_u32 direct_source = 0u;
        if (pl_select_multiply_immediate_source(&block->plan, multiply_left, multiply_right,
                multiply_bits, &direct_source)
                && pl_select_emit_imul_operand(destination, direct_source, multiply_right,
                    multiply_bits, output, written)) return 1;
        if (multiply_right.kind == PL_OPERAND_LOCAL && multiply_right.value == destination
                && !(multiply_left.kind == PL_OPERAND_LOCAL
                     && multiply_left.value == destination)) return 0;
        if (!pl_select_write_alu_tree(
                block, selection, destination, multiply_left,
                pl_select_alu_input_expression_bits(&block->plan, multiply_left, multiply_bits),
                output_at, remaining - 1u, scratch_mask, output, &prefix)
                || !pl_select_emit_imul_operand(destination, destination, multiply_right,
                                       multiply_bits, output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation) return 0;
        *written = prefix + operation;
        return 1;
    }

    quotient_boundary_select boundary;
    if (pl_select_quotient_boundary_select_details(
            &block->plan, value, destination, &boundary))
        return pl_select_write_quotient_boundary_select(
            block, selection, destination, &boundary, output_at,
            remaining, scratch_mask, output, written);

    conditional_select select;
    if (pl_select_conditional_select_details(
            &block->plan, value, destination, &select)
            && (select.has_compare || select.current_flag_node
                || (!output_at
                    && select.current.kind == PL_OPERAND_LOCAL
                    && select.current.value == destination))
            && select.candidate_local != destination
            && pl_select_conditional_compare_survives_current(
                &select, destination)) {
        pl_u32 at = 0u, encoded = 0u;
        if (select.current_flag_node
                ? pl_select_write_selected_flag_value(block, selection, destination, &select,
                    output_at, remaining - 1u, scratch_mask, output, &encoded)
                : pl_select_write_alu_tree(
                block, selection, destination, select.current,
                select.value_bits, output_at, remaining - 1u,
                scratch_mask, output, &encoded)) {
            at += encoded;
            pl_u32 candidate_local = select.candidate_local;
            if (select.candidate_immediate) {
                candidate_local = PL_X86_GPR_COUNT;
                for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                        ++scratch)
                    if (scratch != destination
                            && (scratch_mask & (1u << scratch))) {
                        candidate_local = scratch;
                        break;
                    }
                if (candidate_local >= PL_X86_GPR_COUNT)
                    return PL_ERROR_X86_SELECT;
                if (!pl_select_write_alu_tree(
                        block, selection, candidate_local,
                        select.candidate_value, select.value_bits,
                        output_at + at, remaining - 1u,
                        scratch_mask & ~(1u << candidate_local),
                        output + at, &encoded))
                    return PL_ERROR_X86_SELECT;
                at += encoded;
            }
            int compared = !select.has_compare ? 1
                : pl_select_emit_select_compare(&select, output + at, &encoded);
            if (compared) {
                if (select.has_compare)
                    at += encoded;
                if (pl_select_emit_conditional_move(
                        destination, candidate_local,
                        select.value_bits, select.condition,
                        output + at, &encoded)
                        && at <= U32_MAX_VALUE - encoded) {
                    *written = at + encoded;
                    return 1;
                }
            }
        }
    }

    condition_value condition_value_shape;
    if (pl_select_condition_value_details(
            &block->plan, value, &condition_value_shape)) {
        pl_u32 at = 0u, encoded = 0u;
        int status = 1;
        if (!(condition_value_shape.flags.kind == PL_OPERAND_LOCAL
                && condition_value_shape.flags.value
                   == PL_X86_RFLAGS_LOCAL)) {
            pl_operand left, right;
            pl_u32 flag_bits = 0u, flag_mode = 0u, preserves_carry = 0u;
            if (!pl_select_flag_operation_details(
                    &block->plan, condition_value_shape.flags,
                    &left, &right, &flag_bits, &flag_mode,
                    &preserves_carry)) {
                status = 0;
            } else {
                status = pl_select_write_alu_pair(
                    block, selection, destination, left, right,
                    flag_bits, flag_mode, preserves_carry, output_at,
                    remaining - 1u, scratch_mask, output, &encoded);
                if (status) at += encoded;
            }
        }
        pl_operand zero = { PL_OPERAND_CONST, 0u };
        if (status && pl_select_write_alu_tree(
                block, selection, destination, zero, bits,
                output_at + at, remaining - 1u, scratch_mask,
                output + at, &encoded)) {
            at += encoded;
            if (pl_select_emit_set_condition(
                    destination, condition_value_shape.condition,
                    output + at, &encoded)
                    && at <= U32_MAX_VALUE - encoded) {
                *written = at + encoded;
                return 1;
            }
        }
    }

    boolean_select boolean;
    if (pl_select_boolean_select_details(&block->plan, value, &boolean)) {
        for (pl_u32 inverse = 0u; inverse < 2u; ++inverse) {
            pl_operand current = inverse
                               ? boolean.when_true : boolean.when_false;
            pl_operand candidate = inverse
                                 ? boolean.when_false : boolean.when_true;
            pl_u32 condition_code = inverse ? 4u : 5u;
            if (current.kind == PL_OPERAND_LOCAL
                    && current.value == destination)
                continue;
            pl_u32 candidate_first = 0u;
            pl_u32 candidate_limit = PL_X86_GPR_COUNT;
            int materialize_candidate = candidate.kind == PL_OPERAND_CONST;
            if (candidate.kind == PL_OPERAND_LOCAL) {
                if (candidate.value == destination) continue;
                candidate_first = (pl_u32)candidate.value;
                candidate_limit = candidate_first + 1u;
            }
            for (pl_u32 candidate_local = candidate_first;
                    candidate_local < candidate_limit; ++candidate_local) {
                pl_u32 candidate_bit = 1u << candidate_local;
                if (materialize_candidate
                        && !(scratch_mask & candidate_bit))
                    continue;
                pl_u32 at = 0u, encoded = 0u;
                int status = 1;
                condition_value direct_condition;
                if (pl_select_condition_value_details(
                        &block->plan, boolean.condition,
                        &direct_condition)) {
                    condition_code = direct_condition.condition ^ inverse;
                    if (!(direct_condition.flags.kind == PL_OPERAND_LOCAL
                            && direct_condition.flags.value
                               == PL_X86_RFLAGS_LOCAL)) {
                        pl_operand flag_left, flag_right;
                        pl_u32 flag_bits = 0u, flag_mode = 0u;
                        pl_u32 preserves_carry = 0u;
                        if (!pl_select_flag_operation_details(
                                &block->plan, direct_condition.flags,
                                &flag_left, &flag_right, &flag_bits,
                                &flag_mode, &preserves_carry)) {
                            status = 0;
                        } else {
                            status = pl_select_write_alu_pair(
                                block, selection, destination,
                                flag_left, flag_right, flag_bits, flag_mode,
                                preserves_carry, output_at,
                                remaining - 1u, scratch_mask,
                                output, &encoded);
                            if (status) at += encoded;
                        }
                    }
                } else {
                    pl_u32 condition_bits = pl_select_operand_expression_bits(
                        &block->plan, boolean.condition, 64u);
                    status = pl_select_write_alu_tree(
                        block, selection, destination, boolean.condition,
                        condition_bits, output_at, remaining - 1u,
                        scratch_mask, output, &encoded);
                    if (status) {
                        at += encoded;
                        status = pl_select_emit_test_registers(
                            destination, destination, condition_bits,
                            output + at, &encoded);
                        if (status) at += encoded;
                    }
                }
                if (!status) continue;
                if (!pl_select_write_alu_tree(
                        block, selection, destination, current,
                        boolean.value_bits, output_at + at,
                        remaining - 1u, scratch_mask & ~candidate_bit,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (materialize_candidate) {
                    if (!pl_select_write_alu_tree(
                            block, selection, candidate_local, candidate,
                            boolean.value_bits, output_at + at,
                            remaining - 1u,
                            scratch_mask & ~candidate_bit,
                            output + at, &encoded))
                        continue;
                    at += encoded;
                }
                if (!pl_select_emit_conditional_move(
                        destination, candidate_local, boolean.value_bits,
                        condition_code, output + at, &encoded)
                        || at > U32_MAX_VALUE - encoded)
                    continue;
                *written = at + encoded;
                return 1;
            }
        }
    }

    pl_operand original_left, original_right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            &block->plan, value, &original_left, &original_right,
            &node_bits, &mode)
            || node_bits != bits)
        return 0;

    low32_entry_overlay low32_overlay;
    if (pl_select_low32_entry_overlay_details(
            &block->plan, value, destination, &low32_overlay)
            && pl_select_write_low32_entry_overlay(
                block, selection, &low32_overlay, output_at,
                scratch_mask, output, written))
        return 1;

    split_entry_overlay split_overlay;
    if (pl_select_split_entry_overlay_details(
            &block->plan, value, destination, &split_overlay)
            && (scratch_mask & (1u << split_overlay.side))) {
        pl_u32 split_work = 0u;
        if (pl_select_emit_split_entry_overlay(
                &split_overlay, output, written, &split_work)) {
            (void)split_work;
            return 1;
        }
    }

    entry_bit_overlay overlay;
    if (pl_select_entry_bit_overlay_details(&block->plan, value, &overlay))
        return write_entry_bit_overlay(
            block, selection, destination, &overlay,
            output_at, remaining, scratch_mask, output, written);

    conditional_or_fold fold;
    pl_u32 condition_sources = 0u;
    if (pl_select_conditional_or_fold_details(
            &block->plan, original_left, original_right,
            bits, mode, &fold)
            && pl_select_operand_entry_gpr_sources(
                &block->plan, fold.flag_left,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && pl_select_operand_entry_gpr_sources(
                &block->plan, fold.flag_right,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && !(condition_sources & (1u << destination))) {
        for (pl_u32 candidate = 0u;
                candidate < PL_X86_GPR_COUNT; ++candidate) {
            pl_u32 candidate_bit = 1u << candidate;
            if (!(scratch_mask & candidate_bit)
                    || (condition_sources & candidate_bit))
                continue;
            for (pl_u32 flag_destination = 0u;
                    flag_destination < PL_X86_GPR_COUNT;
                    ++flag_destination) {
                pl_u32 flag_bit = 1u << flag_destination;
                if (flag_destination == candidate
                        || !(scratch_mask & flag_bit))
                    continue;
                pl_u32 at = 0u, encoded = 0u;
                if (!pl_select_write_alu_tree(
                        block, selection, destination, fold.base, bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~condition_sources,
                        output, &encoded))
                    continue;
                at += encoded;
                if (!pl_select_emit_gpr_move(
                        candidate, destination, bits,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (!pl_select_emit_alu_value_instruction(
                        candidate, fold.mask, bits, 5u, 0u,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (!pl_select_write_alu_pair(
                        block, selection, flag_destination,
                        fold.flag_left, fold.flag_right, fold.flag_bits,
                        fold.flag_mode, fold.preserves_carry,
                        output_at + at, remaining - 1u,
                        scratch_mask & ~candidate_bit & ~flag_bit,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (!pl_select_emit_conditional_move(
                        destination, candidate, bits, fold.condition,
                        output + at, &encoded)
                        || at > U32_MAX_VALUE - encoded)
                    continue;
                *written = at + encoded;
                return 1;
            }
        }
    }

    if (pl_select_associative_mode(mode)
            && (original_left.kind == PL_OPERAND_CONST
                || (original_left.kind == PL_OPERAND_LOCAL
                    && original_left.value < PL_X86_GPR_COUNT
                    && original_left.value != destination))
            && original_right.kind != PL_OPERAND_CONST
            && original_right.kind != PL_OPERAND_LOCAL) {
        pl_u32 at = 0u, operation = 0u;
        pl_u32 right_bits = pl_select_operand_expression_bits(
            &block->plan, original_right, bits);
        if (pl_select_write_alu_tree(
                block, selection, destination, original_right,
                right_bits, output_at, remaining - 1u, scratch_mask,
                output, &at)
                && pl_select_emit_alu_value_instruction(
                    destination, original_left, bits, mode, 0u,
                    output + at, &operation)
                && at <= U32_MAX_VALUE - operation) {
            *written = at + operation;
            return 1;
        }
    }

    pl_operand physical_left = original_left;
    pl_operand physical_right = original_right;
    pl_select_physicalize_published_operand(
        &block->plan, destination, &physical_left);

    if (physical_right.kind == PL_OPERAND_CONST
            || (physical_right.kind == PL_OPERAND_LOCAL
                && physical_right.value < PL_X86_GPR_COUNT
                && physical_right.value != destination)) {
        pl_u32 pinned = physical_right.kind == PL_OPERAND_LOCAL
                      ? 1u << (pl_u32)physical_right.value : 0u;
        pl_u32 at = 0u, operation = 0u;
        if (pl_select_write_alu_tree(
                block, selection, destination, physical_left, bits,
                output_at, remaining - 1u, scratch_mask & ~pinned,
                output, &at)
                && pl_select_emit_alu_value_instruction(
                    destination, physical_right, bits, mode, 0u,
                    output + at, &operation)
                && at <= U32_MAX_VALUE - operation) {
            *written = at + operation;
            return 1;
        }
    }

    pl_u32 owner = PL_X86_GPR_COUNT;
    if (pl_select_published_operand_local(
                &block->plan, physical_right, &owner)
            && owner != destination) {
        physical_right.kind = PL_OPERAND_LOCAL;
        physical_right.value = owner;
        pl_u32 at = 0u, operation = 0u;
        if (pl_select_write_alu_tree(
                block, selection, destination, physical_left, bits,
                output_at, remaining - 1u, scratch_mask, output, &at)
                && pl_select_emit_alu_instruction(
                    destination, physical_right, bits, mode, 0u,
                    output + at, &operation)
                && at <= U32_MAX_VALUE - operation) {
            *written = at + operation;
            return 1;
        }
    }

    if (pl_select_associative_mode(mode) && scratch_mask
            && (original_left.kind == PL_OPERAND_NODE
                || original_left.kind == PL_OPERAND_PROJECTION)
            && (original_right.kind == PL_OPERAND_NODE
                || original_right.kind == PL_OPERAND_PROJECTION)) {
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            pl_operand trunk = orientation
                             ? original_right : original_left;
            pl_operand side = orientation
                            ? original_left : original_right;
            pl_u32 trunk_sources = 0u, side_sources = 0u;
            if (!pl_select_operand_entry_gpr_sources(
                    &block->plan, trunk,
                    block->plan.node_count + 1u, remaining,
                    &trunk_sources)
                    || !pl_select_operand_entry_gpr_sources(
                        &block->plan, side,
                        block->plan.node_count + 1u, remaining,
                        &side_sources)
                    || (side_sources & (1u << destination)))
                continue;
            pl_u32 preferred = scratch_mask & side_sources;
            for (pl_u32 scratch = 0u;
                    scratch < PL_X86_GPR_COUNT; ++scratch) {
                pl_u32 scratch_bit = 1u << scratch;
                if (!(preferred & scratch_bit)) continue;
                pl_u32 trunk_bytes = 0u;
                if (!pl_select_write_alu_tree(
                        block, selection, destination, trunk, bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~side_sources,
                        output, &trunk_bytes))
                    continue;
                pl_u32 side_bytes = 0u;
                if (trunk_bytes > U32_MAX_VALUE - output_at
                        || !pl_select_write_alu_tree(
                            block, selection, scratch, side, bits,
                            output_at + trunk_bytes, remaining - 1u,
                            scratch_mask & ~scratch_bit,
                            output + trunk_bytes, &side_bytes))
                    continue;
                pl_operand side_value = {
                    PL_OPERAND_LOCAL, scratch,
                };
                pl_u32 operation = 0u;
                if (trunk_bytes <= U32_MAX_VALUE - side_bytes
                        && pl_select_emit_alu_instruction(
                            destination, side_value, bits, mode, 0u,
                            output + trunk_bytes + side_bytes, &operation)
                        && trunk_bytes + side_bytes
                           <= U32_MAX_VALUE - operation) {
                    *written = trunk_bytes + side_bytes + operation;
                    return 1;
                }
            }
        }
    }

    if (pl_select_associative_mode(mode) && scratch_mask) {
        pl_u32 capacity = block->plan.node_count + 1u;
        pl_operand leaves[capacity];
        pl_u32 leaf_count = 0u;
        if (pl_select_collect_associative_leaves(
                &block->plan, value, bits, mode, leaves, capacity,
                &leaf_count, block->plan.node_count + 1u)
                && leaf_count > 2u) {
            pl_select_promote_associative_destination_leaf(
                leaves, leaf_count, destination);
            pl_u32 leaf_sources[leaf_count];
            pl_u32 suffix_sources[leaf_count + 1u];
            suffix_sources[leaf_count] = 0u;
            int sources_valid = 1;
            for (pl_u32 at = leaf_count; at-- > 0u;) {
                leaf_sources[at] = 0u;
                if (!pl_select_operand_entry_gpr_sources(
                        &block->plan, leaves[at],
                        block->plan.node_count + 1u,
                        remaining, &leaf_sources[at])) {
                    sources_valid = 0;
                    break;
                }
                suffix_sources[at] = suffix_sources[at + 1u]
                                   | leaf_sources[at];
            }
            if (sources_valid
                    && !(suffix_sources[1u] & (1u << destination))) {
                pl_u32 total = 0u;
                pl_u32 leaf_bits = pl_select_operand_expression_bits(
                    &block->plan, leaves[0], bits);
                int status = pl_select_write_alu_tree(
                    block, selection, destination, leaves[0], leaf_bits,
                    output_at, remaining - 1u,
                    scratch_mask & ~suffix_sources[1u],
                    output, &total);
                for (pl_u32 at = 1u; status && at < leaf_count; ++at) {
                    pl_u32 available = scratch_mask
                                     & ~suffix_sources[at + 1u];
                    pl_u32 scratch = 0u;
                    pl_u32 final_owner = available & leaf_sources[at];
                    pl_u32 preferred = final_owner ? final_owner : available;
                    while (scratch < PL_X86_GPR_COUNT
                            && !(preferred & (1u << scratch)))
                        ++scratch;
                    if (scratch == PL_X86_GPR_COUNT
                            || total > U32_MAX_VALUE - output_at) {
                        status = 0;
                        break;
                    }
                    pl_u32 part = 0u;
                    leaf_bits = pl_select_operand_expression_bits(
                        &block->plan, leaves[at], bits);
                    status = pl_select_write_alu_tree(
                        block, selection, scratch, leaves[at], leaf_bits,
                        output_at + total, remaining - 1u,
                        available & ~(1u << scratch),
                        output + total, &part);
                    pl_operand scratch_value = {
                        PL_OPERAND_LOCAL, scratch,
                    };
                    pl_u32 operation = 0u;
                    if (!status || total > U32_MAX_VALUE - part
                            || !pl_select_emit_alu_instruction(
                                destination, scratch_value, bits, mode, 0u,
                                output + total + part, &operation)
                            || total + part > U32_MAX_VALUE - operation) {
                        status = 0;
                        break;
                    }
                    total += part + operation;
                }
                if (status) {
                    *written = total;
                    return 1;
                }
            }
        }
    }

    pl_u32 orientations = mode == 3u ? 1u : 2u;
    pl_u32 first_orientation = pl_select_entry_bit_chain_orientation(
        &block->plan, original_left, original_right, destination, mode);
    for (pl_u32 attempt = 0u; attempt < orientations; ++attempt) {
        pl_u32 orientation = attempt ^ first_orientation;
        pl_operand left = orientation ? original_right : original_left;
        pl_operand right = orientation ? original_left : original_right;
        pl_u32 left_sources = 0u;
        pl_u32 right_sources = 0u;
        if (!pl_select_operand_entry_gpr_sources(
                &block->plan, left, block->plan.node_count + 1u,
                remaining, &left_sources)
                || !pl_select_operand_entry_gpr_sources(
                    &block->plan, right,
                    block->plan.node_count + 1u,
                    remaining, &right_sources))
            continue;
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            pl_u32 scratch_bit = 1u << scratch;
            if (!(scratch_mask & scratch_bit)) continue;
            if (!(left_sources & scratch_bit)) {
                pl_u32 right_bytes = 0u;
                if (pl_select_write_alu_tree(
                        block, selection, scratch, right, bits, output_at,
                        remaining - 1u, scratch_mask & ~scratch_bit,
                        output, &right_bytes)) {
                    pl_u32 left_bytes = 0u;
                    if (right_bytes <= U32_MAX_VALUE - output_at
                            && pl_select_write_alu_tree(
                                block, selection, destination, left, bits,
                                output_at + right_bytes, remaining - 1u,
                                scratch_mask & ~scratch_bit,
                                output + right_bytes, &left_bytes)) {
                        pl_operand scratch_value = {
                            PL_OPERAND_LOCAL, scratch,
                        };
                        pl_u32 operation = 0u;
                        if (right_bytes <= U32_MAX_VALUE - left_bytes
                                && pl_select_emit_alu_instruction(
                                    destination, scratch_value, bits, mode,
                                    0u, output + right_bytes + left_bytes,
                                    &operation)
                                && right_bytes + left_bytes
                                   <= U32_MAX_VALUE - operation) {
                            *written = right_bytes + left_bytes + operation;
                            return 1;
                        }
                    }
                }
            }
            if (right_sources & (1u << destination)) continue;
            pl_u32 left_bytes = 0u;
            if (!pl_select_write_alu_tree(
                    block, selection, destination, left, bits, output_at,
                    remaining - 1u,
                    scratch_mask & ~right_sources,
                    output, &left_bytes))
                continue;
            pl_u32 right_bytes = 0u;
            if (left_bytes > U32_MAX_VALUE - output_at
                    || !pl_select_write_alu_tree(
                        block, selection, scratch, right, bits,
                        output_at + left_bytes, remaining - 1u,
                        scratch_mask & ~scratch_bit,
                        output + left_bytes, &right_bytes))
                continue;
            pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
            pl_u32 operation = 0u;
            if (left_bytes <= U32_MAX_VALUE - right_bytes
                    && pl_select_emit_alu_instruction(
                        destination, scratch_value, bits, mode, 0u,
                        output + left_bytes + right_bytes, &operation)
                    && left_bytes + right_bytes
                       <= U32_MAX_VALUE - operation) {
                *written = left_bytes + right_bytes + operation;
                return 1;
            }
        }
    }
    pl_select_physicalize_selected_operand(&block->plan, selection, destination, &physical_left);
    if (pl_select_associative_mode(mode) && physical_left.kind == PL_OPERAND_LOCAL
            && physical_left.value != destination) {
        pl_u32 prefix = 0u, operation = 0u;
        if (pl_select_write_alu_tree(
                block, selection, destination, original_right, bits, output_at,
                remaining - 1u, scratch_mask & ~(1u << physical_left.value),
                output, &prefix)
                && pl_select_emit_alu_instruction(destination, physical_left, bits, mode, 0u,
                                         output + prefix, &operation)
                && prefix <= U32_MAX_VALUE - operation) {
            *written = prefix + operation;
            return 1;
        }
    }
    return 0;
}

int pl_select_measure_quotient_boundary_select(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !shape || !bytes
            || !instructions || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 quotient_bytes = 0u, quotient_work = 0u;
    int measured = pl_select_measure_alu_tree(
        frontend, block, selection, destination, shape->quotient,
        shape->select.value_bits, output_at, remaining - 1u,
        scratch_mask, &quotient_bytes, &quotient_work);
    pl_u32 compare_bytes = 0u, suffix_bytes = 0u, move_bytes = 0u;
    pl_operand destination_value = {
        PL_OPERAND_LOCAL, destination,
    };
    if (measured <= 0
            || !pl_select_emit_compare_operand(
                destination, shape->projected_compare_right,
                shape->select.compare_bits, 0, &compare_bytes)
            || !pl_select_emit_add_lea(
                destination, destination_value, shape->offset,
                shape->select.value_bits, 0, &suffix_bytes)
            || !pl_select_emit_conditional_move(
                destination, shape->select.candidate_local,
                shape->select.value_bits, shape->select.condition,
                0, &move_bytes)
            || quotient_bytes > U32_MAX_VALUE - compare_bytes
            || quotient_bytes + compare_bytes
               > U32_MAX_VALUE - suffix_bytes
            || quotient_bytes + compare_bytes + suffix_bytes
               > U32_MAX_VALUE - move_bytes
            || quotient_work > U32_MAX_VALUE - 3u)
        return measured < 0 ? measured : 0;
    *bytes = quotient_bytes + compare_bytes + suffix_bytes + move_bytes;
    *instructions = quotient_work + 3u;
    selection->direct_nested_frame = 1u;
    return 1;
}

static int write_entry_bit_overlay(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !shape || !output || !written
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 at = 0u, part = 0u;
    if (!pl_select_write_alu_seed(
            block, selection, destination, shape->base,
            shape->bits, output_at, remaining - 1u,
            output, &part))
        return 0;
    at += part;
    pl_u32 overlay_work = 0u;
    if (!pl_select_emit_entry_bit_overlay(
            destination, shape, output + at, &part, &overlay_work)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    (void)overlay_work;
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (!(scratch_mask & scratch_bit) || scratch == destination)
            continue;
        pl_u32 side_bytes = 0u;
        if (at > U32_MAX_VALUE - output_at
                || !pl_select_write_alu_tree(
                    block, selection, scratch, shape->side,
                    shape->bits, output_at + at, remaining - 1u,
                    scratch_mask & ~scratch_bit,
                    output + at, &side_bytes))
            continue;
        pl_operand side = { PL_OPERAND_LOCAL, scratch };
        pl_u32 join_bytes = 0u;
        if (at > U32_MAX_VALUE - side_bytes
                || !pl_select_emit_alu_instruction(
                    destination, side, shape->bits, 5u, 0u,
                    output + at + side_bytes, &join_bytes)
                || at + side_bytes > U32_MAX_VALUE - join_bytes)
            continue;
        *written = at + side_bytes + join_bytes;
        return 1;
    }
    return 0;
}

int pl_select_write_quotient_boundary_select(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !shape || !output || !written
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 at = 0u, part = 0u;
    if (!pl_select_write_alu_tree(
            block, selection, destination, shape->quotient,
            shape->select.value_bits, output_at, remaining - 1u,
            scratch_mask, output, &part))
        return 0;
    at += part;
    if (!pl_select_emit_compare_operand(
            destination, shape->projected_compare_right,
            shape->select.compare_bits, output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    pl_operand destination_value = {
        PL_OPERAND_LOCAL, destination,
    };
    if (!pl_select_emit_add_lea(
            destination, destination_value, shape->offset,
            shape->select.value_bits, output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    if (!pl_select_emit_conditional_move(
            destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition,
            output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    *written = at + part;
    return 1;
}

int pl_select_write_alu_pair(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand left,
                          pl_operand right, pl_u32 bits, pl_u32 mode,
                          pl_u32 preserves_carry, pl_u32 output_at,
                          pl_u32 remaining, pl_u32 scratch_mask,
                          pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !output || !written || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    if (!preserves_carry && (mode == 3u || mode == 6u)
            && left.kind == right.kind && left.value == right.value) {
        pl_operand self = { PL_OPERAND_LOCAL, destination };
        return pl_select_emit_alu_instruction(
            destination, self, bits, mode, 0u, output, written);
    }
    if (!preserves_carry && mode == 3u
            && left.kind == PL_OPERAND_CONST && !left.value) {
        pl_u32 prefix = 0u, operation = 0u;
        if (!pl_select_write_alu_tree(block, selection, destination, right, bits, output_at,
                remaining - 1u, scratch_mask, output, &prefix)
                || !pl_select_emit_neg_register(destination, bits, output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation) return 0;
        *written = prefix + operation;
        return 1;
    }
    pl_u32 owner = PL_X86_GPR_COUNT;
    pl_select_physicalize_published_operand(&block->plan, destination, &left);
    if (pl_select_published_operand_local(&block->plan, right, &owner)
            && owner != destination) {
        right.kind = PL_OPERAND_LOCAL;
        right.value = owner;
    }
    pl_u32 left_bits = pl_select_alu_input_expression_bits(&block->plan, left, bits);
    pl_u32 right_bits = pl_select_alu_input_expression_bits(&block->plan, right, bits);
    if (right.kind == PL_OPERAND_CONST
            || (right.kind == PL_OPERAND_LOCAL
                && right.value < PL_X86_GPR_COUNT)) {
        pl_u32 prefix = 0u, operation = 0u;
        if (pl_select_write_alu_tree(
                block, selection, destination, left, left_bits, output_at,
                remaining - 1u, scratch_mask, output, &prefix)
                && !(prefix && right.kind == PL_OPERAND_LOCAL
                     && right.value == destination)
                && pl_select_emit_alu_instruction(
                    destination, right, bits, mode, preserves_carry,
                    output + prefix, &operation)
                && prefix <= U32_MAX_VALUE - operation) {
            *written = prefix + operation;
            return 1;
        }
        if (right.kind != PL_OPERAND_CONST
                && !(right.kind == PL_OPERAND_LOCAL && right.value == destination)) return 0;
        /* A constant the immediate form cannot encode falls through so the
         * scratch path materializes it into a register first. */
    }

    pl_u32 left_sources = 0u;
    if (!pl_select_operand_entry_gpr_sources(
            &block->plan, left, block->plan.node_count + 1u,
            remaining, &left_sources))
        return 0;
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (scratch == destination || !(scratch_mask & scratch_bit) || (left_sources & scratch_bit))
            continue;
        pl_u32 right_bytes = 0u;
        if (!pl_select_write_alu_tree(
                block, selection, scratch, right, right_bits, output_at,
                remaining - 1u, scratch_mask & ~scratch_bit,
                output, &right_bytes))
            continue;
        if (right_bytes > U32_MAX_VALUE - output_at) continue;
        pl_u32 left_bytes = 0u;
        if (!pl_select_write_alu_tree(
                block, selection, destination, left, left_bits,
                output_at + right_bytes, remaining - 1u,
                scratch_mask & ~scratch_bit,
                output + right_bytes, &left_bytes))
            continue;
        pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
        pl_u32 operation = 0u;
        if (right_bytes <= U32_MAX_VALUE - left_bytes
                && pl_select_emit_alu_instruction(
                    destination, scratch_value, bits, mode,
                    preserves_carry, output + right_bytes + left_bytes,
                    &operation)
                && right_bytes + left_bytes
                   <= U32_MAX_VALUE - operation) {
            *written = right_bytes + left_bytes + operation;
            return 1;
        }
    }
    return 0;
}
