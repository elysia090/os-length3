#include "cut-internal.h"
static void checkpoint(cut_lowering *c,pl_u32 operation)
{
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,operation);
    if(operation==MACHINE_CHECKPOINT_SET){cut_get(c,CUT_RIGHT);cut_const(c,1u);cut_op(c,0x7cu);}else cut_const(c,0u);
    cut_const(c,0u);cut_call(c,WASM_IMPORT_CHECKPOINT);cut_access_status(c);
}
void cut_lower_selector_query(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_selector_query law;if(!pl_x86_selector_query_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    if(law.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        // The only residual is selector+1 (zero means not yet read), bounded
        // to17 bits in one existing opaque execution word. Descriptor A/D
        // writes may alias the source; residency resume must not reread it.
        checkpoint(c,MACHINE_CHECKPOINT_GET);
        cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
        wasm_writer_uleb(c->writer,offsetof(machine_memory_checkpoint_port,cursor));cut_set(c,CUT_SELECTOR_CURSOR);
        cut_get(c,CUT_SELECTOR_CURSOR);cut_const(c,65536u);cut_op(c,0x56u);cut_op(c,0x04u);cut_op(c,0x40u);
        cut_const(c,MACHINE_RESULT_ENTRY_MAP);cut_op(c,0x0fu);cut_op(c,0x0bu);
        cut_get(c,CUT_SELECTOR_CURSOR);cut_const(c,1u);cut_op(c,0x7du);cut_set(c,CUT_RIGHT);
        cut_get(c,CUT_SELECTOR_CURSOR);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);
        cut_mask(c,16u);cut_set(c,CUT_RIGHT);checkpoint(c,MACHINE_CHECKPOINT_SET);cut_op(c,0x0bu);
    }else{cut_read_operand(c,&i->operands[1],16u);cut_mask(c,16u);cut_set(c,CUT_RIGHT);}
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_RIGHT);cut_op(c,0xa7u);cut_call(c,WASM_IMPORT_DESCRIPTOR);cut_access_status(c);
    if(law.source_memory)checkpoint(c,MACHINE_CHECKPOINT_CLEAR);
    cut_access_value(c);cut_set(c,CUT_VALUE);
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));cut_set(c,CUT_STATUS);
    cut_load(c,offsetof(machine_state,system)+MACHINE_SYSTEM_CS*8u);cut_set(c,CUT_LEFT);
    pl_x86_operand old_parent=i->operands[0];old_parent.bits=64u;old_parent.value.reg.bits=64u;
    cut_read_operand(c,&old_parent,64u);cut_set(c,CUT_SELECTOR_PARENT);
    _Alignas(8) pl_u8 scratch[24576];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_selector_query_plan(law.limit,law.bytes*8u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 inputs[]={CUT_VALUE,CUT_STATUS,CUT_LEFT,CUT_RIGHT,CUT_SELECTOR_PARENT},outputs[]={CUT_VALUE,CUT_STATUS};
    cut_emit_scalar_projection(c,&pure,inputs,32u,outputs,2u);
    pl_x86_register parent=i->operands[0].value.reg;parent.bits=64u;cut_write_register(c,&parent);
    cut_get(c,CUT_FLAGS);cut_const(c,~64ull);cut_op(c,0x83u);cut_get(c,CUT_STATUS);cut_const(c,6u);cut_op(c,0x86u);cut_op(c,0x84u);cut_set(c,CUT_FLAGS);c->report.flags_written=1u;
}
