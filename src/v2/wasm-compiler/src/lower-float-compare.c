#include "cut-internal.h"
void cut_lower_float_compare(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_float_compare law;if(!pl_x86_float_compare_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_sse_guard(c);cut_load(c,offsetof(machine_state,xmm)+law.target*16u);cut_mask(c,law.bytes*8u);cut_set(c,CUT_RIGHT);
    if(law.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);
    }else if(law.alias)cut_get(c,CUT_RIGHT);
    else cut_load(c,offsetof(machine_state,xmm)+law.source*16u);
    cut_mask(c,law.bytes*8u);cut_set(c,CUT_VALUE);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    _Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_float_compare_plan(law.bytes*8u,law.ordered,law.alias,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 inputs[]={CUT_RIGHT,CUT_VALUE,CUT_LEFT,CUT_NEXT,CUT_FLAGS},outputs[]={CUT_VALUE,CUT_STATUS};
    cut_emit_scalar_projection(c,&pure,inputs,32u,outputs,2u);cut_sse_raise(c,0u);
    cut_get(c,CUT_FLAGS);cut_const(c,~0x8d5ull);cut_op(c,0x83u);cut_get(c,CUT_VALUE);cut_op(c,0x84u);cut_set(c,CUT_FLAGS);c->report.flags_written=1u;
}
