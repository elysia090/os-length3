#include "cut-internal.h"

static int canonical(pl_u64 value)
{ return value >> 47u == 0u || value >> 47u == 0x1ffffu; }

int cut_stack_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status != PL_X86_DECODE_VALID || instruction->operand_width != 64u
            || instruction->machine_operation != PL_X86_MACHINE_NONE
            || !canonical(instruction->rip) || !canonical(instruction->fallthrough)
            || instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_PRIVILEGED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)) return 0;
    pl_u32 count = instruction->visible_operand_count;
    const pl_x86_operand *operand = instruction->operands;
    if (instruction->operation == PL_X86_OPERATION_CALL)
        return instruction->flow == PL_X86_FLOW_CALL && count == 1u
            && (instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            && canonical(instruction->target) && operand->kind == PL_X86_OPERAND_IMMEDIATE;
    if (instruction->operation == PL_X86_OPERATION_RETURN)
        return instruction->flow == PL_X86_FLOW_RETURN
            && (instruction->opcode == 0xc2u || instruction->opcode == 0xc3u)
            && (!count || (count == 1u && operand->kind == PL_X86_OPERAND_IMMEDIATE
                          && operand->value.immediate <= 65535u));
    if (instruction->flow != PL_X86_FLOW_NEXT || count != 1u) return 0;
    if (operand->kind == PL_X86_OPERAND_REGISTER)
        return cut_gpr(&operand->value.reg) && operand->value.reg.bits == 64u
            && (instruction->operation == PL_X86_OPERATION_PUSH
                || instruction->operation == PL_X86_OPERATION_POP);
    return instruction->operation == PL_X86_OPERATION_PUSH && operand->kind == PL_X86_OPERAND_IMMEDIATE;
}

static void reject_return_target(cut_lowering *cut)
{
    cut_get(cut, CUT_LEFT); cut_const(cut, 47u); cut_op(cut, 0x88u);
    cut_op(cut, 0x50u);
    cut_get(cut, CUT_LEFT); cut_const(cut, 47u); cut_op(cut, 0x88u);
    cut_const(cut, 0x1ffffu); cut_op(cut, 0x51u);
    cut_op(cut, 0x72u); cut_op(cut, 0x45u); /* neither canonical half */
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_get(cut, CUT_LEFT); cut_op(cut, 0x37u); wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_port, fault_address));
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_const(cut, 13u); cut_op(cut, 0x37u); wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_port, fault_vector));
    cut_const(cut, machine_result_make(MACHINE_RESULT_FAULT, 13u));
    cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
}

void cut_lower_stack(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand rsp = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
        .value.reg = {PL_X86_REGISTER_GPR, 4u, 64u, 0u} };
    int push = instruction->operation == PL_X86_OPERATION_PUSH
            || instruction->operation == PL_X86_OPERATION_CALL;
    cut_read_operand(cut, &rsp, 64u);
    if (push) { cut_const(cut, 8u); cut_op(cut, 0x7du); }
    cut_set(cut, CUT_ADDRESS);
    if (instruction->operation == PL_X86_OPERATION_CALL) cut_const(cut, instruction->fallthrough);
    else if (push) cut_read_operand(cut, instruction->operands, 64u);
    else cut_const(cut, 0u);
    cut_set(cut, CUT_VALUE);
    cut->report.memory_bytes = 8u;
    cut->report.memory_access = MACHINE_MEMORY_STACK | (push ? MACHINE_MEMORY_WRITE : MACHINE_MEMORY_READ);
    cut_access(cut);
    if (!push) {
        cut_access_value(cut); cut_set(cut, CUT_LEFT);
        if (instruction->operation == PL_X86_OPERATION_RETURN) {
            reject_return_target(cut);
            cut_get(cut, CUT_LEFT); cut_set(cut, CUT_NEXT);
        }
    }
    cut_get(cut, CUT_ADDRESS);
    if (!push) {
        pl_u64 increment = 8u;
        if (instruction->operation == PL_X86_OPERATION_RETURN && instruction->visible_operand_count)
            increment += instruction->operands[0].value.immediate;
        cut_const(cut, increment); cut_op(cut, 0x7cu);
    }
    cut_set(cut, CUT_VALUE); cut_write_register(cut, &rsp.value.reg);
    if (instruction->operation == PL_X86_OPERATION_POP) {
        cut_get(cut, CUT_LEFT); cut_set(cut, CUT_VALUE);
        cut_write_register(cut, &instruction->operands[0].value.reg);
    } else if (instruction->operation == PL_X86_OPERATION_CALL) {
        cut_const(cut, instruction->target); cut_set(cut, CUT_NEXT);
    }
}
