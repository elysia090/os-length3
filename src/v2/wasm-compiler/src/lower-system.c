/* Precise privileged transfers, compiled before execution. */
#include "cut-internal.h"
int cut_system_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status == PL_X86_DECODE_VALID && instruction->operation == PL_X86_OPERATION_MOVE
            && instruction->machine_operation == PL_X86_MACHINE_WRITE_SEGMENT
            && instruction->flow == PL_X86_FLOW_NEXT && instruction->visible_operand_count == 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[0].value.reg.class_id == PL_X86_REGISTER_SEGMENT
            && instruction->operands[0].value.reg.index < 6u
            && instruction->operands[0].value.reg.index != 1u
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER
            && cut_gpr(&instruction->operands[1].value.reg)
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_SEGMENT;
    return instruction->status == PL_X86_DECODE_VALID
        && instruction->operation == PL_X86_OPERATION_FLAG_CONTROL
        && instruction->condition == 5u && !instruction->visible_operand_count
        && instruction->machine_operation == PL_X86_MACHINE_INTERRUPT_FLAG
        && instruction->flow == PL_X86_FLOW_NEXT
        && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                   | PL_X86_INSTRUCTION_TRAP_AFTER));
}
static void port_store(cut_lowering *cut, pl_u32 offset, pl_u32 bytes)
{
    /* Value remains on the stack; retain it before pushing the port base. */
    cut_set(cut, CUT_VALUE);
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_get(cut, CUT_VALUE);
    if (bytes == 4u) cut_op(cut, 0xa7u);
    cut_op(cut, bytes == 8u ? 0x37u : 0x36u);
    wasm_writer_uleb(cut->writer, bytes == 8u ? 3u : 2u);
    wasm_writer_uleb(cut->writer, offset);
}
void cut_lower_system(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    if (cut->has_segment) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->operands[0].value.reg.index);
        cut_read_operand(cut,&instruction->operands[1],16u); cut_op(cut,0xa7u);
        cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u);
        cut_set(cut,CUT_STATUS); cut_get(cut,CUT_STATUS); cut_op(cut,0x50u); cut_op(cut,0x45u);
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_get(cut,CUT_STATUS); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
        return;
    }
    /* Virtualized protected-mode flags are outside this admitted baseline. */
    cut_load(cut, offsetof(machine_state, cr4)); cut_const(cut, 2u); cut_op(cut, 0x83u);
    cut_get(cut, CUT_FLAGS); cut_const(cut, 0x20000u); cut_op(cut, 0x83u);
    cut_op(cut, 0x84u); cut_op(cut, 0x50u); cut_op(cut, 0x45u);
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    cut_const(cut, machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u)); cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
    cut_load(cut, offsetof(machine_state, system) + MACHINE_SYSTEM_CS * 8u);
    cut_const(cut, 3u); cut_op(cut, 0x83u);
    cut_get(cut, CUT_FLAGS); cut_const(cut, 12u); cut_op(cut, 0x88u);
    cut_const(cut, 3u); cut_op(cut, 0x83u); cut_op(cut, 0x56u); /* CPL > IOPL */
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    cut_load(cut, offsetof(machine_state, rip)); port_store(cut, offsetof(machine_memory_port, fault_address), 8u);
    cut_const(cut, 13u); port_store(cut, offsetof(machine_memory_port, fault_vector), 4u);
    cut_const(cut, 0u); port_store(cut, offsetof(machine_memory_port, fault_error), 4u);
    cut_const(cut, machine_result_make(MACHINE_RESULT_FAULT, 13u)); cut_op(cut, 0x0fu); cut_op(cut, 0x0bu);
    cut_get(cut, CUT_FLAGS); cut_const(cut, ~0x200ull); cut_op(cut, 0x83u); cut_set(cut, CUT_FLAGS);
    cut->report.flags_written = 1u;
}
