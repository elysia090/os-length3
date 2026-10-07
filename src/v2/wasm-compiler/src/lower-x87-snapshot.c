#include "cut-internal.h"
static void port_store(cut_lowering *cut,pl_u32 offset,pl_u32 bytes)
{
    cut_set(cut,CUT_VALUE);cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);cut_get(cut,CUT_VALUE);
    if(bytes==4u)cut_op(cut,0xa7u);
    cut_op(cut,bytes==4u?0x36u:0x37u);wasm_writer_uleb(cut->writer,bytes==4u?2u:3u);
    wasm_writer_uleb(cut->writer,offset);
}
void cut_lower_x87_snapshot(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_x86_x87_snapshot law;
    if(!pl_x86_x87_snapshot_lower(instruction,&law)){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    /* No-wait stores do not consume pending x87 exceptions or update FIP/FOP.
     * #NM precedes address generation/access even for an unmapped destination. */
    cut_load(cut,offsetof(machine_state,cr0));cut_const(cut,12u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x45u);cut_op(cut,0x04u);cut_op(cut,0x40u);
    cut_load(cut,offsetof(machine_state,rip));port_store(cut,offsetof(machine_memory_port,fault_address),8u);
    cut_const(cut,7u);port_store(cut,offsetof(machine_memory_port,fault_vector),4u);
    cut_const(cut,0u);port_store(cut,offsetof(machine_memory_port,fault_error),4u);
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,7u));cut_op(cut,0x0fu);cut_op(cut,0x0bu);
    cut_get(cut,0u);cut_op(cut,0x33u);wasm_writer_uleb(cut->writer,1u);
    wasm_writer_uleb(cut->writer,law.status?offsetof(machine_state,x87_status):offsetof(machine_state,x87_control));
    cut_set(cut,CUT_VALUE);
    if(!law.memory){cut_write_register(cut,&instruction->operands[0].value.reg);return;}
    const pl_x86_memory *address=&instruction->operands[0].value.memory;
    cut_effective_address(cut,instruction,address);cut_set(cut,CUT_ADDRESS);
    cut->report.memory_access=MACHINE_MEMORY_WRITE|cut_memory_role(address);cut_access(cut);
}
