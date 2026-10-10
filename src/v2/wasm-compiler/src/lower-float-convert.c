#include "cut-internal.h"
void cut_lower_float_convert(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_float_convert law;if(!pl_x86_float_convert_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    enum { B=30u,R=34u,ALL=38u,FIRST=40u };cut_sse_guard(c);
    cut_capture_float_operands(c,i,law.source_bytes,law.lanes,law.source,law.target,law.source_memory,0u,B);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    _Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_float_convert_plan(law.source_bytes*8u,law.target_bytes*8u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_const(c,0u);cut_set(c,ALL);
    for(pl_u32 lane=0u;lane<law.lanes;++lane){const pl_u32 inputs[]={B+lane,CUT_LEFT,0u},outputs[]={R+lane,CUT_STATUS};
        cut_emit_scalar_projection(c,&pure,inputs,FIRST,outputs,2u);cut_get(c,ALL);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,ALL);}
    cut_sse_raise_wave(c,ALL);
    for(pl_u32 lane=0u;lane<law.lanes;++lane){cut_get(c,0u);cut_get(c,R+lane);cut_op(c,law.target_bytes==4u?0x3eu:0x37u);
        wasm_writer_uleb(c->writer,law.target_bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u+lane*law.target_bytes);}
    if(law.zero_high){cut_get(c,0u);cut_const(c,0u);cut_op(c,0x37u);wasm_writer_uleb(c->writer,3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u+8u);}
}
