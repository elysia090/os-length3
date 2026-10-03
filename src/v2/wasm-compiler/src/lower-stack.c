#include "cut-internal.h"

static int canonical(pl_u64 value)
{ return value >> 47u == 0u || value >> 47u == 0x1ffffu; }

int cut_stack_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status != PL_X86_DECODE_VALID
            || !canonical(instruction->rip) || !canonical(instruction->fallthrough)
            || instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_PRIVILEGED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)) return 0;
    pl_u32 count = instruction->visible_operand_count;
    const pl_x86_operand *operand = instruction->operands;
    if (instruction->operation == PL_X86_OPERATION_PUSH_FLAGS
            || instruction->operation == PL_X86_OPERATION_POP_FLAGS)
        return !count && (instruction->operand_width == 16u || instruction->operand_width == 64u)
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->machine_operation == (instruction->operation == PL_X86_OPERATION_POP_FLAGS
                ? PL_X86_MACHINE_POP_FLAGS : PL_X86_MACHINE_NONE);
    if (instruction->operand_width != 64u || instruction->machine_operation != PL_X86_MACHINE_NONE) return 0;
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

static void pop_flags(cut_lowering *cut, pl_u32 width)
{
    /* POPF never faults for insufficient I/O privilege: it preserves those
     * bits. CPL, not the requested stack image, controls IOPL; the incoming
     * IOPL controls IF. Reserved, VM, VIF and VIP bits remain unchanged.
     * RF is cleared. AC and ID belong only to the full-width transfer. */
    cut_const(cut, width == 64u ? 0x244dd5u : 0x4dd5u); cut_set(cut, CUT_RIGHT);
    cut_load(cut, offsetof(machine_state, system) + MACHINE_SYSTEM_CS * 8u);
    cut_const(cut, 3u); cut_op(cut, 0x83u); cut_op(cut, 0x50u);
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    cut_get(cut, CUT_RIGHT); cut_const(cut, 0x3200u); cut_op(cut, 0x84u); cut_set(cut, CUT_RIGHT);
    cut_op(cut, 0x05u);
    cut_load(cut, offsetof(machine_state, system) + MACHINE_SYSTEM_CS * 8u);
    cut_const(cut, 3u); cut_op(cut, 0x83u);
    cut_get(cut, CUT_FLAGS); cut_const(cut, 12u); cut_op(cut, 0x88u);
    cut_const(cut, 3u); cut_op(cut, 0x83u); cut_op(cut, 0x58u); /* CPL <= old IOPL */
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    cut_get(cut, CUT_RIGHT); cut_const(cut, 0x200u); cut_op(cut, 0x84u); cut_set(cut, CUT_RIGHT);
    cut_op(cut, 0x0bu); cut_op(cut, 0x0bu);
    cut_get(cut, CUT_FLAGS);
    cut_get(cut, CUT_RIGHT); cut_const(cut, 0x10000u); cut_op(cut, 0x84u);
    cut_const(cut, ~0ull); cut_op(cut, 0x85u); cut_op(cut, 0x83u);
    cut_get(cut, CUT_LEFT); cut_get(cut, CUT_RIGHT); cut_op(cut, 0x83u);
    cut_op(cut, 0x84u); cut_set(cut, CUT_FLAGS);
    cut->report.flags_written = 1u;
}

void cut_lower_stack(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand rsp = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
        .value.reg = {PL_X86_REGISTER_GPR, 4u, 64u, 0u} };
    int push = instruction->operation == PL_X86_OPERATION_PUSH
            || instruction->operation == PL_X86_OPERATION_PUSH_FLAGS
            || instruction->operation == PL_X86_OPERATION_CALL;
    pl_u32 bytes = instruction->operand_width / 8u;
    cut_read_operand(cut, &rsp, 64u);
    if (push) { cut_const(cut, bytes); cut_op(cut, 0x7du); }
    cut_set(cut, CUT_ADDRESS);
    if (instruction->operation == PL_X86_OPERATION_CALL) cut_const(cut, instruction->fallthrough);
    else if (instruction->operation == PL_X86_OPERATION_PUSH_FLAGS) {
        cut_get(cut, CUT_FLAGS); cut_const(cut, ~0x30000ull); cut_op(cut, 0x83u);
    }
    else if (push) cut_read_operand(cut, instruction->operands, 64u);
    else cut_const(cut, 0u);
    cut_set(cut, CUT_VALUE);
    cut->report.memory_bytes = bytes;
    cut->report.memory_access = MACHINE_MEMORY_STACK | (push ? MACHINE_MEMORY_WRITE : MACHINE_MEMORY_READ);
    cut_access(cut);
    if (!push) {
        cut_access_value(cut); cut_set(cut, CUT_LEFT);
        if (instruction->operation == PL_X86_OPERATION_RETURN) {
            cut_reject_target(cut);
            cut_get(cut, CUT_LEFT); cut_set(cut, CUT_NEXT);
        }
        if (instruction->operation == PL_X86_OPERATION_POP_FLAGS) pop_flags(cut, instruction->operand_width);
    }
    cut_get(cut, CUT_ADDRESS);
    if (!push) {
        pl_u64 increment = bytes;
        if (instruction->operation == PL_X86_OPERATION_RETURN && instruction->visible_operand_count)
            increment += instruction->operands[0].value.immediate;
        cut_const(cut, increment); cut_op(cut, 0x7cu);
    }
    cut_set(cut, CUT_VALUE); cut_write_register(cut, &rsp.value.reg);
    if (instruction->operation == PL_X86_OPERATION_POP) {
        cut_get(cut, CUT_LEFT); cut_set(cut, CUT_VALUE);
        cut_write_register(cut, &instruction->operands[0].value.reg);
    } else if (instruction->operation == PL_X86_OPERATION_CALL
            && instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET) {
        cut_const(cut, instruction->target); cut_set(cut, CUT_NEXT);
    }
}
