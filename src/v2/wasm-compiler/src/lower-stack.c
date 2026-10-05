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
    if (instruction->operation == PL_X86_OPERATION_LEAVE)
        return !count && instruction->flow == PL_X86_FLOW_NEXT
            && instruction->machine_operation == PL_X86_MACHINE_NONE
            && (instruction->operand_width == 16u || instruction->operand_width == 64u);
    if (instruction->operation == PL_X86_OPERATION_PUSH_FLAGS
            || instruction->operation == PL_X86_OPERATION_POP_FLAGS)
        return !count && (instruction->operand_width == 16u || instruction->operand_width == 64u)
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->machine_operation == (instruction->operation == PL_X86_OPERATION_POP_FLAGS
                ? PL_X86_MACHINE_POP_FLAGS : PL_X86_MACHINE_NONE);
    if ((instruction->operation == PL_X86_OPERATION_POP || instruction->operation == PL_X86_OPERATION_PUSH) && count == 1u
            && operand->kind == PL_X86_OPERAND_MEMORY) {
        const pl_x86_memory *memory = &operand->value.memory;
        return instruction->flow == PL_X86_FLOW_NEXT
            && instruction->machine_operation == PL_X86_MACHINE_NONE
            && (instruction->operand_width == 16u || instruction->operand_width == 64u)
            && operand->bits == instruction->operand_width
            && (instruction->address_width == 32u || instruction->address_width == 64u)
            && cut_memory_address_supported(instruction,memory);
    }
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
    const pl_x86_operand rbp = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
        .value.reg = {PL_X86_REGISTER_GPR, 5u, 64u, 0u} };
    int leave = instruction->operation == PL_X86_OPERATION_LEAVE;
    int push = instruction->operation == PL_X86_OPERATION_PUSH
            || instruction->operation == PL_X86_OPERATION_PUSH_FLAGS
            || instruction->operation == PL_X86_OPERATION_CALL;
    int memory_push=instruction->operation == PL_X86_OPERATION_PUSH
        && instruction->operands[0].kind == PL_X86_OPERAND_MEMORY;
    pl_u32 bytes = instruction->operand_width / 8u;
    /* Stack-address size is always 64 in long mode, including 67 LEAVE and
     * 66 LEAVE. Only the popped BP operand narrows. Do not publish the
     * temporary RSP=RBP before a successful SS read: faults restart at the
     * original CPU state, as independently observed in native execution. */
    cut_read_operand(cut, leave ? &rbp : &rsp, 64u);
    if (push) { cut_const(cut, bytes); cut_op(cut, 0x7du); }
    cut_set(cut, CUT_ADDRESS);
    if (memory_push) {
        /* The source uses old RSP, even when it aliases the new stack word.
         * Keep the destination coordinate local; read faults/waits precede
         * any stack store, RSP publication or retirement. Address truncation
         * applies only to the explicit source, never to the implicit stack. */
        const pl_x86_memory *memory=&instruction->operands[0].value.memory;
        cut_get(cut,CUT_ADDRESS); cut_set(cut,CUT_LEFT);
        cut_effective_address(cut,instruction,memory); cut_set(cut,CUT_ADDRESS);
        cut_const(cut,0u); cut_set(cut,CUT_VALUE);
        cut->report.memory_bytes=bytes; cut->report.memory_access=MACHINE_MEMORY_READ;
        cut->report.memory_access|=cut_memory_role(memory);
        cut_access(cut); cut_access_value(cut);
        cut_get(cut,CUT_LEFT); cut_set(cut,CUT_ADDRESS);
    }
    else if (instruction->operation == PL_X86_OPERATION_CALL) cut_coordinate(cut, instruction->fallthrough);
    else if (instruction->operation == PL_X86_OPERATION_PUSH_FLAGS) {
        cut_get(cut, CUT_FLAGS); cut_const(cut, ~0x30000ull); cut_op(cut, 0x83u);
    }
    else if (push) cut_read_operand(cut, instruction->operands, 64u);
    else cut_const(cut, 0u);
    cut_set(cut, CUT_VALUE);
    cut->report.memory_bytes = bytes;
    cut->report.memory_access = MACHINE_MEMORY_STACK | (push ? MACHINE_MEMORY_WRITE : MACHINE_MEMORY_READ);
    cut_access(cut);
    if (memory_push) cut->report.memory_access|=MACHINE_MEMORY_READ
        | cut_memory_role(&instruction->operands[0].value.memory);
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
    if (leave) {
        pl_x86_register destination = rbp.value.reg;
        destination.bits = (pl_u16)instruction->operand_width;
        cut_get(cut,CUT_LEFT); cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&destination);
    } else if (instruction->operation == PL_X86_OPERATION_POP) {
        cut_get(cut, CUT_LEFT); cut_set(cut, CUT_VALUE);
        if (instruction->operands[0].kind == PL_X86_OPERAND_MEMORY) {
            /* The stack read precedes destination translation. RSP's new
             * value is a local SSA binding: a store fault or residency wait
             * publishes neither it nor retirement. Address-size truncation
             * applies to the destination, never to the implicit stack read. */
            const pl_x86_memory *memory = &instruction->operands[0].value.memory;
            cut_effective_address(cut, instruction, memory); cut_set(cut, CUT_ADDRESS);
            cut->report.memory_access = MACHINE_MEMORY_WRITE;
            cut->report.memory_access |= cut_memory_role(memory);
            cut_access(cut);
            cut->report.memory_access |= MACHINE_MEMORY_READ | MACHINE_MEMORY_STACK;
        } else cut_write_register(cut, &instruction->operands[0].value.reg);
    } else if (instruction->operation == PL_X86_OPERATION_CALL
            && instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET) {
        if(cut->operand_binding_kind==CUT_BIND_CONTROL_DISPLACEMENT) {
            cut_coordinate(cut,instruction->fallthrough);
            cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,3u);
            cut_op(cut,0xacu);cut_op(cut,0x7cu);
        }else cut_coordinate(cut,instruction->target);
        cut_set(cut,CUT_NEXT);
    }
}
