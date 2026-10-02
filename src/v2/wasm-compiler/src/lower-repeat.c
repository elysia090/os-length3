#include "cut-internal.h"

int cut_repeat_supported(const pl_x86_instruction *instruction)
{
    return instruction->status == PL_X86_DECODE_VALID
        && instruction->operation == PL_X86_OPERATION_STRING && instruction->condition == 0u
        && instruction->machine_operation == PL_X86_MACHINE_STRING
        && (instruction->flags & PL_X86_INSTRUCTION_REPEATED)
        && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_PRIVILEGED
                                   | PL_X86_INSTRUCTION_TRAP_AFTER))
        && (instruction->operand_width == 8u || instruction->operand_width == 16u
            || instruction->operand_width == 32u || instruction->operand_width == 64u)
        && (instruction->address_width == 32u || instruction->address_width == 64u)
        && ((instruction->machine_argument >> 16u) & 255u) < 4u;
}

void cut_repeat_frontier(cut_lowering *cut)
{
    const pl_u32 registers[] = {1u,6u,7u};
    for (pl_u32 rank = 0u; rank < 3u; ++rank)
        cut_store(cut,offsetof(machine_state,registers) + registers[rank] * 8u,registers[rank] + 1u);
}

void cut_lower_repeat(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_u32 registers[] = {1u,6u,7u};
    for (pl_u32 rank = 0u; rank < 3u; ++rank) {
        pl_x86_operand operand = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
            .value.reg = {PL_X86_REGISTER_GPR, (pl_u8)registers[rank], 64u, 0u} };
        cut_read_operand(cut,&operand,64u); cut_op(cut,0x1au);
        if (instruction->address_width == 32u) {
            cut_get(cut,registers[rank] + 1u); cut_mask(cut,32u); cut_set(cut,registers[rank] + 1u);
        }
    }
    pl_u32 bytes = instruction->operand_width / 8u, width = instruction->address_width;
    cut_const(cut,0u - (pl_u64)bytes); cut_const(cut,bytes);
    cut_get(cut,CUT_FLAGS); cut_const(cut,0x400u); cut_op(cut,0x83u); cut_op(cut,0xa7u);
    cut_op(cut,0x1bu); cut_set(cut,CUT_RIGHT); /* DF ? -bytes : bytes */
    cut_const(cut,MACHINE_REPEAT_MAX_ELEMENTS); cut_set(cut,CUT_REPEAT_BUDGET);
    cut_op(cut,0x02u); cut_op(cut,0x40u); /* block */
    cut_op(cut,0x03u); cut_op(cut,0x40u); /* loop */
    cut_get(cut,2u); cut_mask(cut,width); cut_op(cut,0x50u);
    cut_op(cut,0x0du); wasm_writer_uleb(cut->writer,1u);
    cut_get(cut,CUT_REPEAT_BUDGET); cut_op(cut,0x50u);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_repeat_frontier(cut);
    cut_const(cut,machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_QUANTUM));
    cut_op(cut,0x0fu); cut_op(cut,0x0bu);
    cut_get(cut,7u); cut_mask(cut,width); cut_set(cut,CUT_ADDRESS);
    cut_const(cut,0u); cut_set(cut,CUT_VALUE);
    cut->report.memory_access = MACHINE_MEMORY_READ; cut_access(cut);
    cut_access_value(cut); cut_set(cut,CUT_VALUE);
    cut_get(cut,8u); cut_mask(cut,width); cut_set(cut,CUT_ADDRESS);
    cut->report.memory_access = MACHINE_MEMORY_WRITE; cut_access(cut);
    /* A fault/miss commits no part of this element. Completed elements stay
     * in locals; only a return publishes RCX/RSI/RDI, never a CPU frame. */
    cut_get(cut,2u); cut_const(cut,1u); cut_op(cut,0x7du); cut_mask(cut,width); cut_set(cut,2u);
    for (pl_u32 local = 7u; local <= 8u; ++local) {
        cut_get(cut,local); cut_get(cut,CUT_RIGHT); cut_op(cut,0x7cu);
        cut_mask(cut,width); cut_set(cut,local);
    }
    cut_get(cut,CUT_REPEAT_BUDGET); cut_const(cut,1u); cut_op(cut,0x7du); cut_set(cut,CUT_REPEAT_BUDGET);
    cut_op(cut,0x0cu); wasm_writer_uleb(cut->writer,0u);
    cut_op(cut,0x0bu); cut_op(cut,0x0bu);
    cut->report.written_registers |= 0xc2u;
    cut->report.memory_access = MACHINE_MEMORY_READ | MACHINE_MEMORY_WRITE;
}
