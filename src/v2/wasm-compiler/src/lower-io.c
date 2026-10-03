/* Compile scalar IN/OUT and RDTSC to typed device/clock boundaries. */
#include "cut-internal.h"
#include <machine/io.h>
int cut_io_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status != PL_X86_DECODE_VALID
            || (instruction->flow != PL_X86_FLOW_NEXT && instruction->flow != PL_X86_FLOW_SYSTEM)
            || (instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_REPEATED
                                     | PL_X86_INSTRUCTION_TRAP_AFTER))) return 0;
    if (instruction->machine_operation == PL_X86_MACHINE_TIME
            && !instruction->machine_argument && !instruction->visible_operand_count) return CUT_SYSTEM_TIME;
    if (instruction->machine_operation != PL_X86_MACHINE_PORT_IO
            || instruction->visible_operand_count != 2u || (instruction->machine_argument & ~0xffff03ffull)) return 0;
    pl_u32 write = (pl_u32)(instruction->machine_argument >> 8u) & 1u;
    pl_u32 dynamic = (pl_u32)(instruction->machine_argument >> 9u) & 1u;
    pl_u32 bytes = (pl_u32)instruction->machine_argument & 255u;
    const pl_x86_operand *value = &instruction->operands[write ? 1u : 0u];
    const pl_x86_operand *port = &instruction->operands[write ? 0u : 1u];
    if ((bytes != 1u && bytes != 2u && bytes != 4u) || value->kind != PL_X86_OPERAND_REGISTER
            || !cut_gpr(&value->value.reg) || value->value.reg.index || (value->value.reg.flags & PL_X86_REGISTER_HIGH8)
            || value->bits != bytes * 8u) return 0;
    if (dynamic) {
        if (port->kind != PL_X86_OPERAND_REGISTER || !cut_gpr(&port->value.reg)
                || port->value.reg.index != 2u || port->bits != 16u
                || instruction->machine_argument >> 16u) return 0;
    } else if (port->kind != PL_X86_OPERAND_IMMEDIATE || port->value.immediate > 255u) return 0;
    return CUT_SYSTEM_IO;
}
void cut_lower_io(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    if (instruction->machine_operation == PL_X86_MACHINE_TIME) {
        cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u); cut_access_status(cut);
        cut_access_value(cut); cut_set(cut,CUT_VALUE);
        cut_get(cut,CUT_VALUE); cut_mask(cut,32u); cut_set(cut,1u);
        cut_get(cut,CUT_VALUE); cut_const(cut,32u); cut_op(cut,0x88u); cut_set(cut,3u);
        cut->loaded |= 5u; cut->report.written_registers |= 5u;
        return;
    }
    pl_u32 write = (pl_u32)(instruction->machine_argument >> 8u) & 1u;
    pl_u32 bytes = (pl_u32)instruction->machine_argument & 255u;
    cut_read_operand(cut,&instruction->operands[write ? 0u : 1u],16u); cut_op(cut,0xa7u);
    cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,bytes | (write ? MACHINE_IO_WRITE : 0u));
    if (write) cut_read_operand(cut,&instruction->operands[1],bytes * 8u);
    else cut_const(cut,0u);
    cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u); cut_access_status(cut);
    if (!write) { cut_access_value(cut); cut_set(cut,CUT_VALUE); cut_write_register(cut,&instruction->operands[0].value.reg); }
}
