/* carry-frame: native x86 selection. */
#include "carry-frame.h"
#include "limits.h"
#include "encoding.h"

static int same_value(pl_operand value, pl_u32 kind, pl_u64 payload);

static int condition_carry_frame_shape(const pl_x86_block *block,
                                       condition_carry_frame *out);

static int emit_condition_carry_frame(const condition_carry_frame *shape,
                                      pl_u8 *output, pl_u32 *written);

static int mul_add_carry_frame_shape(const pl_x86_block *block,
                                     mul_add_carry_frame *out);

static int emit_mul_add_carry_frame(const mul_add_carry_frame *shape,
                                    pl_u8 *output, pl_u32 *written);

static int same_value(pl_operand value, pl_u32 kind, pl_u64 payload)
{
    return value.kind == kind && value.value == payload;
}

/* SETcc performs both the Boolean observation and the low-byte insert.  The
 * SSA spelling keeps those notions separate, but native work must not charge
 * two operations for one architectural instruction.  This production also
 * records that the independent ADD may share SETcc's wave before ADC joins
 * their two results. */
static int condition_carry_frame_shape(const pl_x86_block *block,
                                       condition_carry_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->plan.node_count != 4u)
        return 0;
    const pl_plan *plan = &block->plan;
    const pl_node *condition = &plan->nodes[0];
    const pl_node *insert = &plan->nodes[1];
    const pl_node *add = &plan->nodes[2];
    const pl_node *carry = &plan->nodes[3];
    if (condition->opcode != PL_OPCODE_X86_CONDITION
            || condition->argument_count != 2u
            || insert->opcode != PL_OPCODE_LANE64_INSERT
            || insert->argument_count != 3u
            || add->opcode != PL_OPCODE_X86_ALU
            || add->argument_count != 4u
            || carry->opcode != PL_OPCODE_X86_ALU
            || carry->argument_count != 4u)
        return 0;
    const pl_operand *condition_argument =
        plan->arguments + condition->argument_at;
    const pl_operand *insert_argument = plan->arguments + insert->argument_at;
    const pl_operand *add_argument = plan->arguments + add->argument_at;
    const pl_operand *carry_argument = plan->arguments + carry->argument_at;
    if (!same_value(condition_argument[0], PL_OPERAND_LOCAL,
                    PL_X86_RFLAGS_LOCAL)
            || condition_argument[1].kind != PL_OPERAND_CONST
            || condition_argument[1].value > 15u
            || insert_argument[0].kind != PL_OPERAND_LOCAL
            || insert_argument[0].value >= PL_X86_GPR_COUNT
            || !same_value(insert_argument[1], PL_OPERAND_NODE, 1u)
            || !same_value(insert_argument[2], PL_OPERAND_CONST, 8u)
            || !same_value(add_argument[0], PL_OPERAND_LOCAL,
                           PL_X86_RFLAGS_LOCAL)
            || add_argument[1].kind != PL_OPERAND_LOCAL
            || add_argument[1].value >= PL_X86_GPR_COUNT
            || (add_argument[2].kind != PL_OPERAND_LOCAL
                && add_argument[2].kind != PL_OPERAND_CONST)
            || (add_argument[2].kind == PL_OPERAND_LOCAL
                && add_argument[2].value >= PL_X86_GPR_COUNT)
            || add_argument[3].kind != PL_OPERAND_CONST
            || !same_value(carry_argument[0], PL_OPERAND_NODE, 3u)
            || !same_value(carry_argument[1], PL_OPERAND_NODE, 2u)
            || (carry_argument[2].kind != PL_OPERAND_LOCAL
                && carry_argument[2].kind != PL_OPERAND_CONST)
            || (carry_argument[2].kind == PL_OPERAND_LOCAL
                && carry_argument[2].value >= PL_X86_GPR_COUNT)
            || carry_argument[3].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 add_descriptor = add_argument[3].value;
    pl_u64 carry_descriptor = carry_argument[3].value;
    pl_u32 bits = (pl_u32)(add_descriptor & 0x7fu);
    if ((bits != 32u && bits != 64u)
            || add_descriptor != bits + (1u << 8u)
            || carry_descriptor != bits + (2u << 8u))
        return 0;
    pl_u32 condition_destination = (pl_u32)insert_argument[0].value;
    pl_u32 add_destination = (pl_u32)add_argument[1].value;
    if (condition_destination == add_destination
            || !same_value(
                plan->locals[condition_destination], PL_OPERAND_PROJECTION,
                (4u << 8u) | 16u)
            || !same_value(
                plan->locals[add_destination], PL_OPERAND_PROJECTION,
                (3u << 8u) | 16u)
            || !same_value(plan->locals[PL_X86_RFLAGS_LOCAL],
                           PL_OPERAND_NODE, 4u))
        return 0;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
        if (local == condition_destination || local == add_destination
                || local == PL_X86_RFLAGS_LOCAL)
            continue;
        if (!same_value(plan->locals[local], PL_OPERAND_LOCAL, local))
            return 0;
    }
    out->condition_destination = condition_destination;
    out->condition = (pl_u32)condition_argument[1].value;
    out->add_destination = add_destination;
    out->add_right = add_argument[2];
    out->carry_right = carry_argument[2];
    out->bits = bits;
    return 1;
}

static int emit_condition_carry_frame(const condition_carry_frame *shape,
                                      pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, encoded = 0u;
#define APPEND_CONDITION_CARRY(call) do {                                  \
        if (!(call) || at > U32_MAX_VALUE - encoded) return 0;             \
        at += encoded;                                                      \
    } while (0)
    APPEND_CONDITION_CARRY(pl_select_emit_set_condition(
        shape->condition_destination, shape->condition,
        output ? output + at : 0, &encoded));
    APPEND_CONDITION_CARRY(pl_select_emit_alu_instruction(
        shape->add_destination, shape->add_right, shape->bits, 1u, 0u,
        output ? output + at : 0, &encoded));
    APPEND_CONDITION_CARRY(pl_select_emit_alu_instruction(
        shape->condition_destination, shape->carry_right,
        shape->bits, 2u, 0u, output ? output + at : 0, &encoded));
#undef APPEND_CONDITION_CARRY
    *written = at;
    return 1;
}

int pl_select_measure_direct_condition_carry_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    (void)frontend;
    condition_carry_frame shape;
    pl_u32 bytes = 0u;
    if (!selection || !condition_carry_frame_shape(block, &shape)
            || !emit_condition_carry_frame(&shape, 0, &bytes))
        return 0;
    selection->output_bytes = bytes;
    selection->output_instructions = 3u;
    selection->output_work = 3u;
    selection->output_span = 2u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_condition_carry_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* Normal form of high64((low * inverse) * modulus) followed by a three-term
 * sum with the Boolean carry-in (low != 0).  This topology is not tied to a
 * crypto function or source spelling; Montgomery cancellation is one common
 * producer of it.  Dead caller-saved coordinates permit NEG to carry the
 * Boolean directly into ADC, so no SETcc materialization survives. */
static int mul_add_carry_frame_shape(const pl_x86_block *block,
                                     mul_add_carry_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->plan.node_count != 9u
            || !(block->live_output_mask & 1u)
            || !(block->live_output_mask & (1u << 2u))
            || (block->live_output_mask & (1u << PL_X86_RFLAGS_LOCAL)))
        return 0;
    const pl_plan *plan = &block->plan;
    const pl_node *multiply = &plan->nodes[0];
    const pl_node *multiply_high = &plan->nodes[1];
    const pl_node *nonzero = &plan->nodes[2];
    const pl_node *first_sum = &plan->nodes[3];
    const pl_node *first_flags = &plan->nodes[4];
    const pl_node *first_carry = &plan->nodes[5];
    const pl_node *second_sum = &plan->nodes[6];
    const pl_node *second_carry = &plan->nodes[7];
    const pl_node *carry_sum = &plan->nodes[8];
    if (multiply->opcode != PL_OPCODE_MULR
            || multiply->argument_count != 2u
            || multiply_high->opcode != PL_OPCODE_MUL_HIGH
            || multiply_high->argument_count != 3u
            || nonzero->opcode != PL_OPCODE_X86_TEST_CONDITION
            || nonzero->argument_count != 3u
            || first_sum->opcode != PL_OPCODE_ALU_REGISTER[1][1]
            || first_sum->argument_count != 2u
            || first_flags->opcode != PL_OPCODE_X86_FLAGS
            || first_flags->argument_count != 5u
            || first_carry->opcode != PL_OPCODE_X86_CONDITION
            || first_carry->argument_count != 2u
            || second_sum->opcode != PL_OPCODE_X86_ALU
            || second_sum->argument_count != 4u
            || second_carry->opcode != PL_OPCODE_X86_CONDITION
            || second_carry->argument_count != 2u
            || carry_sum->opcode != PL_OPCODE_ALU_REGISTER[1][1]
            || carry_sum->argument_count != 2u)
        return 0;
    const pl_operand *mul = plan->arguments + multiply->argument_at;
    const pl_operand *wide = plan->arguments + multiply_high->argument_at;
    const pl_operand *test = plan->arguments + nonzero->argument_at;
    const pl_operand *sum1 = plan->arguments + first_sum->argument_at;
    const pl_operand *flags1 = plan->arguments + first_flags->argument_at;
    const pl_operand *carry1 = plan->arguments + first_carry->argument_at;
    const pl_operand *sum2 = plan->arguments + second_sum->argument_at;
    const pl_operand *carry2 = plan->arguments + second_carry->argument_at;
    const pl_operand *result_high = plan->arguments + carry_sum->argument_at;
    if (mul[0].kind != PL_OPERAND_LOCAL
            || mul[1].kind != PL_OPERAND_LOCAL
            || mul[0].value >= PL_X86_GPR_COUNT
            || mul[1].value >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 low = same_value(test[0], PL_OPERAND_LOCAL, mul[0].value)
              && same_value(test[1], PL_OPERAND_LOCAL, mul[0].value)
               ? (pl_u32)mul[0].value
               : same_value(test[0], PL_OPERAND_LOCAL, mul[1].value)
              && same_value(test[1], PL_OPERAND_LOCAL, mul[1].value)
               ? (pl_u32)mul[1].value : PL_X86_GPR_COUNT;
    if (low >= PL_X86_GPR_COUNT
            || !same_value(test[2], PL_OPERAND_CONST, 64u | (5u << 8u)))
        return 0;
    pl_u32 inverse = (pl_u32)(mul[0].value == low
                            ? mul[1].value : mul[0].value);
    if (!same_value(wide[0], PL_OPERAND_NODE, 1u)
            || wide[1].kind != PL_OPERAND_LOCAL
            || wide[1].value >= PL_X86_GPR_COUNT
            || !same_value(wide[2], PL_OPERAND_CONST, 64u))
        return 0;
    pl_u32 modulus = (pl_u32)wide[1].value;
    pl_u32 high_input = same_value(sum1[0], PL_OPERAND_NODE, 3u)
                     && sum1[1].kind == PL_OPERAND_LOCAL
                     && sum1[1].value < PL_X86_GPR_COUNT
                      ? (pl_u32)sum1[1].value
                      : same_value(sum1[1], PL_OPERAND_NODE, 3u)
                     && sum1[0].kind == PL_OPERAND_LOCAL
                     && sum1[0].value < PL_X86_GPR_COUNT
                      ? (pl_u32)sum1[0].value : PL_X86_GPR_COUNT;
    if (high_input >= PL_X86_GPR_COUNT
            || !same_value(flags1[1], PL_OPERAND_NODE, 3u)
            || !same_value(flags1[2], PL_OPERAND_LOCAL, high_input)
            || !same_value(flags1[3], PL_OPERAND_NODE, 4u)
            || !same_value(flags1[4], PL_OPERAND_CONST,
                           64u | (1u << 8u))
            || !same_value(carry1[0], PL_OPERAND_NODE, 5u)
            || !same_value(carry1[1], PL_OPERAND_CONST, 2u)
            || !same_value(sum2[1], PL_OPERAND_NODE, 4u)
            || !same_value(sum2[2], PL_OPERAND_NODE, 2u)
            || !same_value(sum2[3], PL_OPERAND_CONST,
                           64u | (1u << 8u))
            || !same_value(carry2[0], PL_OPERAND_NODE, 7u)
            || !same_value(carry2[1], PL_OPERAND_CONST, 2u)
            || !same_value(result_high[0], PL_OPERAND_NODE, 6u)
            || !same_value(result_high[1], PL_OPERAND_NODE, 8u)
            || !same_value(plan->locals[0], PL_OPERAND_PROJECTION,
                           (7u << 8u) | 16u)
            || !same_value(plan->locals[2], PL_OPERAND_NODE, 9u))
        return 0;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
        if (local == 0u || local == 2u
                || !(block->live_output_mask & (1u << local)))
            continue;
        if (!same_value(plan->locals[local], PL_OPERAND_LOCAL, local))
            return 0;
    }
    if (low == 0u || low == 2u || high_input == 0u
            || high_input == 2u || high_input == low
            || modulus == 0u || (block->live_output_mask & (1u << low)))
        return 0;
    out->inverse = inverse;
    out->low = low;
    out->modulus = modulus;
    out->high = high_input;
    return 1;
}

static int emit_mul_add_carry_frame(const mul_add_carry_frame *shape,
                                    pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, part = 0u;
#define APPEND_MUL_ADD(call_) do {                                          \
        if (!(call_)) return 0;                                             \
        at += part;                                                         \
    } while (0)
    if (shape->inverse != 0u)
        APPEND_MUL_ADD(pl_select_emit_gpr_move(
            0u, shape->inverse, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(pl_select_emit_imul_register(
        0u, shape->low, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(pl_select_emit_unsigned_multiply(
        shape->modulus, output ? output + at : 0, &part));
    APPEND_MUL_ADD(pl_select_emit_gpr_move(
        0u, 2u, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(pl_select_emit_zero_register(
        2u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(pl_select_emit_neg_register(
        shape->low, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(pl_select_emit_alu_instruction(
        0u, (pl_operand){ PL_OPERAND_LOCAL, shape->high },
        64u, 2u, 0u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(pl_select_emit_alu_instruction(
        2u, (pl_operand){ PL_OPERAND_CONST, 0u },
        64u, 2u, 0u, output ? output + at : 0, &part));
#undef APPEND_MUL_ADD
    *written = at;
    return 1;
}

int pl_select_measure_direct_mul_add_carry_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    (void)frontend;
    mul_add_carry_frame shape;
    pl_u32 bytes = 0u;
    if (!selection || !mul_add_carry_frame_shape(block, &shape)
            || !emit_mul_add_carry_frame(&shape, 0, &bytes))
        return 0;
    selection->output_bytes = bytes;
    selection->output_instructions = shape.inverse == 0u ? 7u : 8u;
    selection->output_work = selection->output_instructions;
    selection->output_span = 5u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_mul_add_carry_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_mul_add_carry_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    pl_u8 *output)
{
    mul_add_carry_frame shape;
    pl_u32 written = 0u;
    if (!block || !selection || !selection->direct_mul_add_carry_frame
            || !output || !mul_add_carry_frame_shape(block, &shape)
            || !emit_mul_add_carry_frame(&shape, output, &written)
            || written != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}

int pl_select_write_direct_condition_carry_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    pl_u8 *output)
{
    condition_carry_frame shape;
    pl_u32 written = 0u;
    if (!block || !selection || !selection->direct_condition_carry_frame
            || !output || !condition_carry_frame_shape(block, &shape)
            || !emit_condition_carry_frame(&shape, output, &written)
            || written != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}
