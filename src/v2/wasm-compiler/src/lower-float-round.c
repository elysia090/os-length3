#include "cut-internal.h"
void cut_lower_float_round(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_float_round law;if(!pl_x86_float_round_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_sse_guard(c);enum { B=30u,R=34u,ALL=38u,FIRST=40u };
    cut_capture_float_operands(c,i,law.bytes,law.lanes,law.source,law.target,law.source_memory,0u,B);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    cut_const(c,0u);cut_set(c,ALL);
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_float_round_plan(law.bytes*8u,law.control,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    for(pl_u32 lane=0u;lane<law.lanes;++lane){const pl_u32 inputs[]={B+lane,CUT_LEFT},outputs[]={R+lane,CUT_STATUS};
        cut_emit_scalar_projection(c,&pure,inputs,FIRST,outputs,2u);cut_get(c,ALL);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,ALL);}
    cut_sse_raise_wave(c,ALL);
    for(pl_u32 lane=0u;lane<law.lanes;++lane){cut_get(c,0u);cut_get(c,R+lane);cut_op(c,law.bytes==4u?0x3eu:0x37u);
        wasm_writer_uleb(c->writer,law.bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u+lane*law.bytes);}
}
