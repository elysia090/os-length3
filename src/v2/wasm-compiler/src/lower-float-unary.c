#include "cut-internal.h"
void cut_lower_float_unary(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_float_unary law;if(!pl_x86_float_unary_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_sse_guard(c);enum { B=30u,R=34u,ALL=38u,FIRST=40u };
    cut_capture_float_operands(c,i,law.bytes,law.lanes,law.source,law.target,law.source_memory,0u,B);
    if(law.operation)cut_const(c,0x9fc0u);
    else{cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));}
    cut_set(c,CUT_LEFT);
    _Alignas(8) pl_u8 scratch[196608];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    cut_const(c,0u);cut_set(c,ALL);
    if(law.operation!=1u){
        if(pl_x86_float_sqrt_plan(law.bytes*8u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        for(pl_u32 lane=0u;lane<law.lanes;++lane){const pl_u32 inputs[]={B+lane,CUT_LEFT},outputs[]={R+lane,CUT_STATUS};
            cut_emit_scalar_projection(c,&pure,inputs,FIRST,outputs,2u);cut_get(c,ALL);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,ALL);}
    }
    if(law.operation){
        // Two RN binary32 roundings have relative error <= 2u/(1-u),
        // u=2^-24, strictly inside 1.5*2^-12. DAZ/FTZ and no FP exception
        // are properties of these approximate instructions, not guest MXCSR.
        arena.used=0u;if(pl_x86_float_arithmetic_plan(32u,3u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        cut_const(c,0x3f800000u);cut_set(c,26u);
        for(pl_u32 lane=0u;lane<law.lanes;++lane){const pl_u32 inputs[]={26u,(law.operation==1u?B:R)+lane,CUT_LEFT},outputs[]={R+lane,CUT_STATUS};
            cut_emit_scalar_projection(c,&pure,inputs,FIRST,outputs,2u);}
    }else cut_sse_raise_wave(c,ALL);
    for(pl_u32 lane=0u;lane<law.lanes;++lane){cut_get(c,0u);cut_get(c,R+lane);cut_op(c,law.bytes==4u?0x3eu:0x37u);
        wasm_writer_uleb(c->writer,law.bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u+lane*law.bytes);}
}
