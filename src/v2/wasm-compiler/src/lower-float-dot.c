#include "cut-internal.h"
enum { A=26u,B=30u,R=34u,ALL=38u,FIRST=40u };
static void evaluate(cut_lowering *c,const pl_plan *pure,pl_u32 left,pl_u32 right,pl_u32 target)
{
    const pl_u32 inputs[]={left,right,CUT_LEFT},outputs[]={target,CUT_STATUS};
    cut_emit_scalar_projection(c,pure,inputs,FIRST,outputs,2u);cut_get(c,ALL);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,ALL);
}
void cut_lower_float_dot(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_float_dot p;if(!pl_x86_float_dot_lower(i,&p)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    pl_u32 lanes=16u/p.bytes;cut_sse_guard(c);
    cut_capture_float_operands(c,i,p.bytes,lanes,p.source,p.target,p.source_memory,A,B);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    _Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_float_arithmetic_plan(p.bytes*8u,1u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_const(c,0u);cut_set(c,ALL);
    for(pl_u32 lane=0u;lane<lanes;++lane){if(p.control&(16u<<lane))evaluate(c,&pure,A+lane,B+lane,R+lane);else{cut_const(c,0u);cut_set(c,R+lane);}}
    cut_sse_raise_wave(c,ALL);arena.used=0u;
    if(pl_x86_float_arithmetic_plan(p.bytes*8u,0u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_const(c,0u);cut_set(c,ALL);
    if(lanes==4u){
        // DPPS permits implementation-dependent horizontal NaN positioning.
        // Keep the fixed neighbor/self butterfly's operand order in every
        // lane; numeric commutativity does not license merging NaN payloads.
        for(pl_u32 lane=0u;lane<4u;++lane)evaluate(c,&pure,R+(lane^1u),R+lane,B+lane);
        cut_sse_raise_wave(c,ALL);cut_const(c,0u);cut_set(c,ALL);
        for(pl_u32 lane=0u;lane<4u;++lane)evaluate(c,&pure,B+lane,B+(lane^2u),R+lane);
    }else for(pl_u32 lane=0u;lane<2u;++lane)evaluate(c,&pure,R+lane,R+(lane^1u),B+lane);
    cut_sse_raise_wave(c,ALL);
    for(pl_u32 lane=0u;lane<lanes;++lane){cut_get(c,0u);if(p.control&(1u<<lane))cut_get(c,(lanes==4u?R:B)+lane);else cut_const(c,0u);
        cut_op(c,p.bytes==4u?0x3eu:0x37u);wasm_writer_uleb(c->writer,p.bytes==4u?2u:3u);
        wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p.target*16u+lane*p.bytes);}
}
