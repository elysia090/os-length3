#include "cut-internal.h"

int cut_paired_exchange_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status!=PL_X86_DECODE_VALID || instruction->flow!=PL_X86_FLOW_NEXT
            || instruction->machine_operation!=PL_X86_MACHINE_ATOMIC
            || instruction->visible_operand_count!=1u
            || instruction->operands[0].kind!=PL_X86_OPERAND_MEMORY
            || instruction->flags & (PL_X86_INSTRUCTION_PRIVILEGED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)
            || (instruction->address_width!=32u && instruction->address_width!=64u)) return 0;
    pl_u32 bits=instruction->operands[0].bits;
    return ((bits==64u && instruction->machine_argument==(13u|(8ull<<8u)))
            || (bits==128u && instruction->machine_argument==(3u|(16ull<<8u))))
        && cut_memory_address_supported(instruction,&instruction->operands[0].value.memory);
}

static pl_x86_operand reg(pl_u32 index,pl_u32 width)
{
    pl_x86_operand result={0}; result.kind=PL_X86_OPERAND_REGISTER; result.bits=(pl_u16)width;
    result.value.reg.class_id=PL_X86_REGISTER_GPR; result.value.reg.bits=(pl_u16)width;
    result.value.reg.index=(pl_u8)index; return result;
}

void cut_lower_paired_exchange(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    int wide=instruction->operands[0].bits==128u; pl_u32 width=wide ? 64u : 32u;
    pl_x86_operand ax=reg(0u,width),dx=reg(2u,width),bx=reg(3u,width),cx=reg(1u,width);
    const pl_x86_memory *address=&instruction->operands[0].value.memory;
    cut->report.memory_bytes=wide ? 16u : 8u;
    cut->report.memory_access=MACHINE_MEMORY_READ|MACHINE_MEMORY_WRITE;
    cut->report.memory_access|=cut_memory_role(address);
    cut_effective_address(cut,instruction,address); cut_set(cut,CUT_ADDRESS);
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u); cut_get(cut,CUT_ADDRESS);
    cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,cut->report.memory_bytes);
    cut_i32_const(cut,cut->report.memory_access);
    cut_call(cut,WASM_IMPORT_RESERVE_PAIR); cut_access_status(cut);
    cut_access_value(cut); cut_set(cut,CUT_LEFT);
    if (wide) {
        cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x29u); wasm_writer_uleb(cut->writer,3u);
        wasm_writer_uleb(cut->writer,offsetof(machine_memory_pair_port,high));
    } else { cut_get(cut,CUT_LEFT); cut_const(cut,32u); cut_op(cut,0x88u); }
    cut_set(cut,CUT_RIGHT);
    if (!wide) { cut_get(cut,CUT_LEFT); cut_mask(cut,32u); cut_set(cut,CUT_LEFT); }
    /* The complete reservation precedes compare SSA. No exception, residency
     * wait, host event or second vCPU may intervene before its single commit.
     * Both arms write; only the mismatch arm replaces the accumulator pair. */
    cut_read_operand(cut,&ax,width); cut_get(cut,CUT_LEFT); cut_op(cut,0x51u);
    cut_read_operand(cut,&dx,width); cut_get(cut,CUT_RIGHT); cut_op(cut,0x51u);
    cut_op(cut,0x71u); cut_op(cut,0xadu); cut_set(cut,CUT_ADDRESS);
    cut_get(cut,CUT_FLAGS); cut_const(cut,~0x40ull); cut_op(cut,0x83u);
    cut_get(cut,CUT_ADDRESS); cut_const(cut,6u); cut_op(cut,0x86u); cut_op(cut,0x84u);
    cut_set(cut,CUT_FLAGS); cut->report.flags_written=0x40u;
    cut_read_operand(cut,&bx,width); cut_get(cut,CUT_LEFT);
    cut_get(cut,CUT_ADDRESS); cut_op(cut,0xa7u); cut_op(cut,0x1bu); cut_set(cut,CUT_VALUE);
    cut_read_operand(cut,&cx,width); cut_get(cut,CUT_RIGHT);
    cut_get(cut,CUT_ADDRESS); cut_op(cut,0xa7u); cut_op(cut,0x1bu); cut_set(cut,CUT_NEXT);
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u); cut_get(cut,CUT_VALUE); cut_get(cut,CUT_NEXT);
    if (!wide) { cut_const(cut,32u); cut_op(cut,0x86u); cut_op(cut,0x84u); }
    cut_call(cut,WASM_IMPORT_COMMIT_PAIR); cut_access_status(cut);
    cut_get(cut,CUT_ADDRESS); cut_op(cut,0x50u); cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_get(cut,CUT_LEFT); cut_set(cut,CUT_VALUE); cut_write_register(cut,&ax.value.reg);
    cut_get(cut,CUT_RIGHT); cut_set(cut,CUT_VALUE); cut_write_register(cut,&dx.value.reg);
    cut_op(cut,0x0bu);
}
