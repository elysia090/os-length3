#include "cut-internal.h"
#include <machine/control.h>
enum { FT_TARGET=26,FT_SELECTOR,FT_ORDINAL };
static void checkpoint(cut_lowering *c,pl_u32 action)
{
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,action);
    if(action==MACHINE_CHECKPOINT_SET){cut_get(c,FT_TARGET);cut_get(c,FT_SELECTOR);cut_const(c,1u);cut_op(c,0x7cu);}
    else{cut_const(c,0u);cut_const(c,0u);}
    cut_call(c,WASM_IMPORT_CHECKPOINT);cut_access_status(c);
}
static void port_word(cut_lowering *c,pl_u32 offset)
{cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);wasm_writer_uleb(c->writer,offset);}
void cut_lower_far_transfer(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_far_transfer law;if(!pl_x86_far_transfer_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    checkpoint(c,MACHINE_CHECKPOINT_GET);port_word(c,offsetof(machine_memory_checkpoint_port,cursor));cut_set(c,FT_TARGET);
    port_word(c,offsetof(machine_memory_checkpoint_port,frontier));cut_set(c,FT_ORDINAL);
    cut_get(c,FT_ORDINAL);cut_const(c,65536u);cut_op(c,0x56u);cut_op(c,0x04u);cut_op(c,0x40u);cut_const(c,MACHINE_RESULT_ENTRY_MAP);cut_op(c,0x0fu);cut_op(c,0x0bu);
    cut_get(c,FT_ORDINAL);cut_const(c,1u);cut_op(c,0x7du);cut_set(c,FT_SELECTOR);
    cut_get(c,FT_ORDINAL);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
    const pl_x86_memory *m=&i->operands[0].value.memory;cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);
    c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,law.bytes+2u);cut_i32_const(c,c->report.memory_access);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);
    cut_access_value(c);cut_mask(c,law.bytes*8u);cut_set(c,FT_TARGET);
    if(law.bytes==8u)port_word(c,offsetof(machine_memory_pair_port,high));
    else{cut_access_value(c);cut_const(c,law.bytes*8u);cut_op(c,0x88u);}cut_mask(c,16u);cut_set(c,FT_SELECTOR);
    checkpoint(c,MACHINE_CHECKPOINT_SET);cut_op(c,0x0bu);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,machine_transfer_word(law.bytes,law.call));cut_get(c,FT_TARGET);cut_get(c,FT_SELECTOR);cut_op(c,0xa7u);
    cut_coordinate(c,i->fallthrough);cut_call(c,WASM_IMPORT_FAR_TRANSFER);cut_access_status(c);checkpoint(c,MACHINE_CHECKPOINT_CLEAR);
    cut_load(c,offsetof(machine_state,rip));cut_set(c,CUT_NEXT);
}
