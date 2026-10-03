/* Precise privileged transfers, compiled before execution. */
#include "cut-internal.h"
#include <x86/profile.h>
int cut_system_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_INTERRUPT_RETURN
            && instruction->machine_argument == 64u && instruction->operand_width == 64u
            && instruction->flow == PL_X86_FLOW_RETURN
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_INTERRUPT_RETURN;
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_CPUID
            && !instruction->visible_operand_count
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_CPUID;
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_WRITE_CONTROL
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->visible_operand_count == 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[0].value.reg.class_id == PL_X86_REGISTER_CONTROL
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER
            && cut_gpr(&instruction->operands[1].value.reg)
            && instruction->operands[1].value.reg.bits == 64u
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) {
        pl_u32 rank = instruction->operands[0].value.reg.index;
        if (rank == 0u || rank == 2u || rank == 3u || rank == 4u || rank == 8u)
            return CUT_SYSTEM_CONTROL_WRITE;
    }
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_READ_CONTROL
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->visible_operand_count == 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
            && cut_gpr(&instruction->operands[0].value.reg)
            && instruction->operands[0].value.reg.bits == 64u
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[1].value.reg.class_id == PL_X86_REGISTER_CONTROL
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) {
        pl_u32 rank = instruction->operands[1].value.reg.index;
        if (rank == 0u || rank == 2u || rank == 3u || rank == 4u || rank == 8u)
            return CUT_SYSTEM_CONTROL_READ;
    }
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_FAR_RETURN
            && instruction->flow == PL_X86_FLOW_RETURN && instruction->operand_width == 64u
            && instruction->machine_argument <= 65535u
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) return CUT_SYSTEM_FAR_RETURN;
    if (instruction->status == PL_X86_DECODE_VALID
            && instruction->machine_operation == PL_X86_MACHINE_DESCRIPTOR_TABLE
            && instruction->machine_argument <= 1u
            && (instruction->flow == PL_X86_FLOW_NEXT || instruction->flow == PL_X86_FLOW_SYSTEM)
            && instruction->visible_operand_count == 1u
            && instruction->operands[0].kind == PL_X86_OPERAND_MEMORY
            && (instruction->address_width == 32u || instruction->address_width == 64u)
            && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                       | PL_X86_INSTRUCTION_TRAP_AFTER))) {
        const pl_x86_memory *memory = &instruction->operands[0].value.memory;
        if ((memory->segment.class_id == PL_X86_REGISTER_NONE
                || (memory->segment.class_id == PL_X86_REGISTER_SEGMENT && memory->segment.index < 4u))
                && (memory->base.class_id == PL_X86_REGISTER_NONE
                    || memory->base.class_id == PL_X86_REGISTER_IP || cut_gpr(&memory->base))
                && (memory->index.class_id == PL_X86_REGISTER_NONE || cut_gpr(&memory->index))
                && (!memory->scale || memory->scale == 1u || memory->scale == 2u
                    || memory->scale == 4u || memory->scale == 8u)) return CUT_SYSTEM_TABLE;
    }
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
static void cpuid_result(cut_lowering *cut, pl_x86_cpuid_result result)
{
    const pl_u32 words[] = {result.eax,result.ecx,result.edx,result.ebx};
    for (pl_u32 reg = 0u; reg < 4u; ++reg) {
        cut_const(cut,words[reg]); cut_set(cut,reg + 1u);
    }
    cut->loaded |= 15u; cut->report.written_registers |= 15u;
}
static void lower_cpuid(cut_lowering *cut)
{
    static const pl_u32 leaves[] = {0u,1u,7u,0x80000000u,0x80000001u,0x80000008u};
    /* Snapshot EAX before any of the four architectural outputs overwrite
     * their parents. CPUID is a serializing one-instruction cut, not a host
     * capability callback. Profile rows become ordinary Wasm constants. */
    cut_load(cut,offsetof(machine_state,registers)); cut_mask(cut,32u); cut_set(cut,CUT_LEFT);
    cut->report.read_registers |= 1u;
    pl_u32 nesting = 0u;
    for (pl_u32 rank = 0u; rank < sizeof leaves / sizeof leaves[0]; ++rank) {
        pl_u32 leaf = leaves[rank];
        pl_x86_cpuid_result result = pl_x86_profile_cpuid(leaf,0u);
        if (!(result.eax | result.ebx | result.ecx | result.edx)) continue;
        cut_get(cut,CUT_LEFT); cut_const(cut,leaf); cut_op(cut,0x51u);
        if (leaf == 7u) {
            /* All current structured rows are zero and disappear. If the
             * contract changes, retain its subleaf dependency explicitly. */
            cut_load(cut,offsetof(machine_state,registers) + 8u); cut_mask(cut,32u);
            cut_op(cut,0x50u); cut_op(cut,0x71u); cut->report.read_registers |= 2u;
        }
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cpuid_result(cut,result); cut_op(cut,0x05u); ++nesting;
    }
    cpuid_result(cut,(pl_x86_cpuid_result){0});
    while (nesting--) cut_op(cut,0x0bu);
}
void cut_lower_system(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    if (cut->has_interrupt_return) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u); cut_access_status(cut);
        cut_load(cut,offsetof(machine_state,rip)); cut_set(cut,CUT_NEXT);
        cut_load(cut,offsetof(machine_state,rflags)); cut_set(cut,CUT_FLAGS);
        cut->report.flags_written = 1u;
        return;
    }
    if (instruction->machine_operation == PL_X86_MACHINE_CPUID) {
        lower_cpuid(cut); return;
    }
    if (cut->has_control_write) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->operands[0].value.reg.index);
        cut_read_operand(cut,&instruction->operands[1],64u);
        cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u); cut_access_status(cut);
        return;
    }
    if (instruction->machine_operation == PL_X86_MACHINE_READ_CONTROL) {
        cut_get(cut,CUT_FLAGS); cut_const(cut,0x20000u); cut_op(cut,0x83u);
        cut_op(cut,0x50u); cut_op(cut,0x45u);
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_const(cut,MACHINE_RESULT_ENTRY_MAP); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
        cut_load(cut,offsetof(machine_state,system) + MACHINE_SYSTEM_CS * 8u);
        cut_const(cut,3u); cut_op(cut,0x83u); cut_op(cut,0x50u); cut_op(cut,0x45u);
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_load(cut,offsetof(machine_state,rip)); port_store(cut,offsetof(machine_memory_port,fault_address),8u);
        cut_const(cut,13u); port_store(cut,offsetof(machine_memory_port,fault_vector),4u);
        cut_const(cut,0u); port_store(cut,offsetof(machine_memory_port,fault_error),4u);
        cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,13u)); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
        pl_u32 rank = instruction->operands[1].value.reg.index;
        pl_u32 offset = rank == 0u ? offsetof(machine_state,cr0)
            : rank == 3u ? offsetof(machine_state,cr3) : rank == 4u ? offsetof(machine_state,cr4)
            : offsetof(machine_state,system) + (rank == 2u ? MACHINE_SYSTEM_CR2 : MACHINE_SYSTEM_CR8) * 8u;
        cut_load(cut,offset); cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&instruction->operands[0].value.reg);
        /* Arithmetic flags are architecturally undefined: preserve their
         * prior values as the chosen representative, not an exact oracle. */
        return;
    }
    if (cut->has_far_return) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->machine_argument);
        cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u); cut_access_status(cut);
        cut_load(cut,offsetof(machine_state,rip)); cut_set(cut,CUT_NEXT);
        return;
    }
    if (cut->has_table) {
        const pl_x86_memory *memory = &instruction->operands[0].value.memory;
        cut_effective_address(cut,instruction,memory); cut_set(cut,CUT_ADDRESS);
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_get(cut,CUT_ADDRESS);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,instruction->machine_argument);
        cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,
            MACHINE_MEMORY_READ | (memory->segment.class_id == PL_X86_REGISTER_SEGMENT
                && memory->segment.index == 2u ? MACHINE_MEMORY_STACK : 0u));
        cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u);
        cut_access_status(cut);
        return;
    }
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
