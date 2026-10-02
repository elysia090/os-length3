#include "cut-internal.h"

int cut_memory_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status != PL_X86_DECODE_VALID || instruction->flow != PL_X86_FLOW_NEXT
            || instruction->machine_operation != PL_X86_MACHINE_NONE
            || instruction->visible_operand_count != 2u
            || instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_PRIVILEGED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)
            || (instruction->address_width != 32u && instruction->address_width != 64u)) return 0;
    const pl_x86_operand *operands = instruction->operands;
    int store = operands[0].kind == PL_X86_OPERAND_MEMORY;
    const pl_x86_operand *memory = &operands[store ? 0u : 1u];
    if (memory->kind != PL_X86_OPERAND_MEMORY || (memory->bits != 8u
            && memory->bits != 16u && memory->bits != 32u && memory->bits != 64u)) return 0;
    if (store) {
        if ((instruction->operation != PL_X86_OPERATION_MOVE
                && instruction->operation != PL_X86_OPERATION_ADD
                && instruction->operation != PL_X86_OPERATION_SUBTRACT
                && instruction->operation != PL_X86_OPERATION_AND
                && instruction->operation != PL_X86_OPERATION_OR
                && instruction->operation != PL_X86_OPERATION_XOR)
                || (operands[1].kind != PL_X86_OPERAND_IMMEDIATE
                    && (operands[1].kind != PL_X86_OPERAND_REGISTER
                        || !cut_gpr(&operands[1].value.reg)))) return 0;
    } else if ((instruction->operation != PL_X86_OPERATION_MOVE
                 && instruction->operation != PL_X86_OPERATION_MOVE_ZERO_EXTEND
                 && instruction->operation != PL_X86_OPERATION_MOVE_SIGN_EXTEND)
            || operands[0].kind != PL_X86_OPERAND_REGISTER
            || !cut_gpr(&operands[0].value.reg)) return 0;
    const pl_x86_memory *address = &memory->value.memory;
    return (address->segment.class_id == PL_X86_REGISTER_NONE
            || (address->segment.class_id == PL_X86_REGISTER_SEGMENT && address->segment.index < 4u))
        && (address->base.class_id == PL_X86_REGISTER_NONE
            || address->base.class_id == PL_X86_REGISTER_IP || cut_gpr(&address->base))
        && (address->index.class_id == PL_X86_REGISTER_NONE || cut_gpr(&address->index))
        && (address->scale == 0u || address->scale == 1u || address->scale == 2u
            || address->scale == 4u || address->scale == 8u)
        && ((instruction->rip >> 47u) == 0u || (instruction->rip >> 47u) == 0x1ffffu)
        && ((instruction->fallthrough >> 47u) == 0u || (instruction->fallthrough >> 47u) == 0x1ffffu);
}

void cut_lower_memory(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    int store = operands[0].kind == PL_X86_OPERAND_MEMORY;
    int rmw = store && instruction->operation != PL_X86_OPERATION_MOVE;
    const pl_x86_operand *memory = &operands[store ? 0u : 1u];
    cut_effective_address(cut, instruction, &memory->value.memory);
    cut_set(cut, CUT_ADDRESS);
    if (store) cut_read_operand(cut, &operands[1], memory->bits);
    else cut_const(cut, 0u);
    cut_set(cut, rmw ? CUT_RIGHT : CUT_VALUE);
    cut->report.memory_bytes = memory->bits / 8u;
    cut->report.memory_access = store ? MACHINE_MEMORY_WRITE : MACHINE_MEMORY_READ;
    if (rmw) cut->report.memory_access |= MACHINE_MEMORY_READ;
    if (memory->value.memory.segment.class_id == PL_X86_REGISTER_SEGMENT
            && memory->value.memory.segment.index == 2u)
        cut->report.memory_access |= MACHINE_MEMORY_STACK;
    if (rmw) {
        /* Only the translation/reservation lives in C. The arithmetic and
         * live flags remain ordinary compiled SSA, not an operation callback. */
        cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
        cut_get(cut, CUT_ADDRESS);
        cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_bytes);
        cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_access);
        cut_op(cut, 0x10u); wasm_writer_uleb(cut->writer, 0u);
        cut_access_status(cut);
        cut_access_value(cut); cut_set(cut, CUT_LEFT);
        cut_get(cut, CUT_LEFT); cut_get(cut, CUT_RIGHT);
        pl_u32 op = instruction->operation;
        cut_op(cut, op == PL_X86_OPERATION_ADD ? 0x7cu
            : op == PL_X86_OPERATION_SUBTRACT ? 0x7du
            : op == PL_X86_OPERATION_AND ? 0x83u
            : op == PL_X86_OPERATION_OR ? 0x84u : 0x85u);
        cut_mask(cut, memory->bits); cut_set(cut, CUT_VALUE);
        cut_arithmetic_flags(cut, memory->bits, op == PL_X86_OPERATION_SUBTRACT,
            op == PL_X86_OPERATION_AND || op == PL_X86_OPERATION_OR || op == PL_X86_OPERATION_XOR, 0);
        cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
        cut_get(cut, CUT_VALUE);
        cut_op(cut, 0x10u); wasm_writer_uleb(cut->writer, 1u);
        cut_access_status(cut);
    } else cut_access(cut);
    if (!store) {
        cut_access_value(cut);
        if (instruction->operation == PL_X86_OPERATION_MOVE_SIGN_EXTEND) {
            cut_const(cut, 64u - memory->bits); cut_op(cut, 0x86u);
            cut_const(cut, 64u - memory->bits); cut_op(cut, 0x87u);
        }
        cut_mask(cut, operands[0].value.reg.bits); cut_set(cut, CUT_VALUE);
        cut_write_register(cut, &operands[0].value.reg);
    }
}

void cut_access(cut_lowering *cut)
{
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u); /* private port parameter */
    cut_get(cut, CUT_ADDRESS);
    cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_bytes);
    cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, cut->report.memory_access);
    cut_get(cut, CUT_VALUE);
    cut_op(cut, 0x10u); wasm_writer_uleb(cut->writer, 0u); /* C RAM boundary */
    cut_access_status(cut);
}

void cut_access_status(cut_lowering *cut)
{
    cut_set(cut, CUT_STATUS);
    cut_get(cut, CUT_STATUS); cut_op(cut, 0x50u); cut_op(cut, 0x45u);
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    cut_get(cut, CUT_STATUS); cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
}

void cut_access_value(cut_lowering *cut)
{
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_op(cut, 0x29u); wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_port, value));
}
