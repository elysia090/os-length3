#include "cut-internal.h"
void cut_lower_float_arithmetic(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_float_arithmetic law;if(!pl_x86_float_arithmetic_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_sse_guard(c);
    enum { A=26u,B=30u,R=34u,ALL=38u,FIRST=40u };
    cut_capture_float_operands(c,i,law.bytes,law.lanes,law.source,law.target,law.source_memory,A,B);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    cut_const(c,0u);cut_set(c,ALL);
    _Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    pl_u32 operation=law.operation==6u?0u:law.operation>=7u?2u:law.operation;
    if(pl_x86_float_arithmetic_plan(law.bytes*8u,operation,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    for(pl_u32 lane=0u;lane<law.lanes;++lane){pl_u32 left=A+lane,right=B+lane;
        if(law.operation==6u||law.operation==7u){pl_u32 owner=lane<law.lanes/2u?A:B,pair=(lane%(law.lanes/2u))*2u;left=owner+pair;right=left+1u;}
        if(law.operation==8u&&(lane&1u)){arena.used=0u;if(pl_x86_float_arithmetic_plan(law.bytes*8u,0u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}}
        else if(law.operation==8u&&lane){arena.used=0u;if(pl_x86_float_arithmetic_plan(law.bytes*8u,2u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}}
        const pl_u32 inputs[]={left,right,CUT_LEFT},outputs[]={R+lane,CUT_STATUS};
        cut_emit_scalar_projection(c,&pure,inputs,FIRST,outputs,2u);cut_get(c,ALL);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,ALL);}
    cut_sse_raise_wave(c,ALL);
    for(pl_u32 lane=0u;lane<law.lanes;++lane){cut_get(c,0u);cut_get(c,R+lane);cut_op(c,law.bytes==4u?0x3eu:0x37u);
        wasm_writer_uleb(c->writer,law.bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u+lane*law.bytes);}
}
