#include "cut-internal.h"

static int canonical(pl_u64 value)
{ return value >> 47u == 0u || value >> 47u == 0x1ffffu; }

int cut_indirect_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status != PL_X86_DECODE_VALID || instruction->operation != PL_X86_OPERATION_BRANCH
            || instruction->flow != PL_X86_FLOW_JUMP || instruction->machine_operation != PL_X86_MACHINE_NONE
            || !(instruction->flags & PL_X86_INSTRUCTION_INDIRECT)
            || instruction->flags & (PL_X86_INSTRUCTION_DIRECT_TARGET | PL_X86_INSTRUCTION_LOCKED
                | PL_X86_INSTRUCTION_PRIVILEGED | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)
            || instruction->visible_operand_count != 1u || instruction->operand_width != 64u
            || !canonical(instruction->rip) || !canonical(instruction->fallthrough)) return 0;
    const pl_x86_operand *operand = instruction->operands;
    if (operand->kind == PL_X86_OPERAND_REGISTER)
        return cut_gpr(&operand->value.reg) && operand->value.reg.bits == 64u;
    if (operand->kind != PL_X86_OPERAND_MEMORY || operand->bits != 64u
            || (instruction->address_width != 32u && instruction->address_width != 64u)) return 0;
    const pl_x86_memory *address = &operand->value.memory;
    return (address->segment.class_id == PL_X86_REGISTER_NONE
            || (address->segment.class_id == PL_X86_REGISTER_SEGMENT && address->segment.index < 4u))
        && (address->base.class_id == PL_X86_REGISTER_NONE || address->base.class_id == PL_X86_REGISTER_IP
            || cut_gpr(&address->base))
        && (address->index.class_id == PL_X86_REGISTER_NONE || cut_gpr(&address->index))
        && (!address->scale || address->scale == 1u || address->scale == 2u
            || address->scale == 4u || address->scale == 8u);
}

/* Target is in LEFT. A pending #GP is not exception delivery or CR2.
 * Port/state reservations have already been checked. No CPU publication
 * precedes this check; memory-target faults therefore win over target #GP. */
void cut_reject_target(cut_lowering *cut)
{
    cut_get(cut,CUT_LEFT); cut_const(cut,47u); cut_op(cut,0x88u); cut_op(cut,0x50u);
    cut_get(cut,CUT_LEFT); cut_const(cut,47u); cut_op(cut,0x88u);
    cut_const(cut,0x1ffffu); cut_op(cut,0x51u); cut_op(cut,0x72u); cut_op(cut,0x45u);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_get(cut,CUT_LEFT); cut_op(cut,0x37u); wasm_writer_uleb(cut->writer,3u);
    wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_address));
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_const(cut,13u); cut_op(cut,0x37u); wasm_writer_uleb(cut->writer,3u);
    wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_vector));
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,13u)); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
}
void cut_lower_indirect(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operand = instruction->operands;
    if (operand->kind == PL_X86_OPERAND_MEMORY) {
        cut_effective_address(cut,instruction,&operand->value.memory); cut_set(cut,CUT_ADDRESS);
        cut_const(cut,0u); cut_set(cut,CUT_VALUE);
        cut->report.memory_bytes = 8u; cut->report.memory_access = MACHINE_MEMORY_READ;
        if (operand->value.memory.segment.class_id == PL_X86_REGISTER_SEGMENT
                && operand->value.memory.segment.index == 2u) cut->report.memory_access |= MACHINE_MEMORY_STACK;
        cut_access(cut); cut_access_value(cut);
    } else cut_read_operand(cut,operand,64u);
    cut_set(cut,CUT_LEFT); cut_reject_target(cut);
    cut_get(cut,CUT_LEFT); cut_set(cut,CUT_NEXT);
}
