#include "cut-internal.h"

static int binary_arithmetic(pl_u32 operation)
{
    return operation == PL_X86_OPERATION_ADD || operation == PL_X86_OPERATION_SUBTRACT
        || operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_OR
        || operation == PL_X86_OPERATION_XOR;
}

static void arithmetic(cut_lowering *cut, pl_u32 operation, pl_u32 width)
{
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT);
    cut_op(cut,operation == PL_X86_OPERATION_ADD ? 0x7cu
        : operation == PL_X86_OPERATION_SUBTRACT || operation == PL_X86_OPERATION_COMPARE ? 0x7du
        : operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_TEST ? 0x83u
        : operation == PL_X86_OPERATION_OR ? 0x84u : 0x85u);
    cut_mask(cut,width); cut_set(cut,CUT_VALUE);
    cut_arithmetic_flags(cut,width,
        operation == PL_X86_OPERATION_SUBTRACT || operation == PL_X86_OPERATION_COMPARE,
        operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_OR
            || operation == PL_X86_OPERATION_XOR || operation == PL_X86_OPERATION_TEST,0);
}

int cut_memory_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status != PL_X86_DECODE_VALID || instruction->flow != PL_X86_FLOW_NEXT
            || instruction->machine_operation != PL_X86_MACHINE_NONE
            || instruction->visible_operand_count != 2u
            || instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_PRIVILEGED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)
            || (instruction->address_width != 32u && instruction->address_width != 64u)) return 0;
    const pl_x86_operand *operands = instruction->operands;
    int first = operands[0].kind == PL_X86_OPERAND_MEMORY;
    int observe = instruction->operation == PL_X86_OPERATION_COMPARE
               || instruction->operation == PL_X86_OPERATION_TEST;
    const pl_x86_operand *memory = &operands[first ? 0u : 1u];
    if (memory->kind != PL_X86_OPERAND_MEMORY || (memory->bits != 8u
            && memory->bits != 16u && memory->bits != 32u && memory->bits != 64u)) return 0;
    if (observe) {
        const pl_x86_operand *other = &operands[first ? 1u : 0u];
        if ((other->kind != PL_X86_OPERAND_REGISTER || !cut_gpr(&other->value.reg))
                && !(first && other->kind == PL_X86_OPERAND_IMMEDIATE)) return 0;
    } else if (first) {
        if ((instruction->operation != PL_X86_OPERATION_MOVE && !binary_arithmetic(instruction->operation))
                || (operands[1].kind != PL_X86_OPERAND_IMMEDIATE
                    && (operands[1].kind != PL_X86_OPERAND_REGISTER
                        || !cut_gpr(&operands[1].value.reg)))) return 0;
    } else if ((instruction->operation != PL_X86_OPERATION_MOVE && !binary_arithmetic(instruction->operation)
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
    int first = operands[0].kind == PL_X86_OPERAND_MEMORY;
    int observe = instruction->operation == PL_X86_OPERATION_COMPARE
               || instruction->operation == PL_X86_OPERATION_TEST;
    int store = first && !observe;
    int rmw = store && instruction->operation != PL_X86_OPERATION_MOVE;
    int load_arithmetic = !first && binary_arithmetic(instruction->operation);
    const pl_x86_operand *memory = &operands[first ? 0u : 1u];
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
    if (load_arithmetic) {
        // Capture the destination before loading through its aliased address.
        // A failed C read leaves both the parent register and flags untouched.
        cut_read_operand(cut,&operands[0],memory->bits); cut_set(cut,CUT_LEFT);
    }
    if (observe) {
        cut_read_operand(cut,&operands[first ? 1u : 0u],memory->bits);
        cut_set(cut,first ? CUT_RIGHT : CUT_LEFT);
        cut_access(cut); /* READ only, even when the first operand is memory. */
        cut_access_value(cut); cut_set(cut,first ? CUT_LEFT : CUT_RIGHT);
        arithmetic(cut,instruction->operation,memory->bits);
        return; /* No GPR/payload store; a failed load never commits flags. */
    }
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
        arithmetic(cut,instruction->operation,memory->bits);
        cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
        cut_get(cut, CUT_VALUE);
        cut_op(cut, 0x10u); wasm_writer_uleb(cut->writer, 1u);
        cut_access_status(cut);
    } else cut_access(cut);
    if (!store) {
        cut_access_value(cut);
        if (load_arithmetic) {
            cut_set(cut,CUT_RIGHT); arithmetic(cut,instruction->operation,memory->bits);
        } else {
            if (instruction->operation == PL_X86_OPERATION_MOVE_SIGN_EXTEND) {
                cut_const(cut, 64u - memory->bits); cut_op(cut, 0x86u);
                cut_const(cut, 64u - memory->bits); cut_op(cut, 0x87u);
            }
            cut_mask(cut, operands[0].value.reg.bits); cut_set(cut, CUT_VALUE);
        }
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
    if (cut->has_repeat) {
        /* Architectural fault/residency wait starts the instruction. Entry
         * refusal or a stale port does not acquire that authority. */
        cut_get(cut,CUT_STATUS); cut_const(cut,6u); cut_op(cut,0x83u);
        cut_const(cut,2u); cut_op(cut,0x51u);
        cut_op(cut,0x04u); cut_op(cut,0x40u); cut_repeat_frontier(cut); cut_op(cut,0x0bu);
    }
    cut_get(cut, CUT_STATUS); cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
}

void cut_access_value(cut_lowering *cut)
{
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_op(cut, 0x29u); wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_port, value));
}
