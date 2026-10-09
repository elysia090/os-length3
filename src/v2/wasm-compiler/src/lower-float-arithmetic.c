#include "cut-internal.h"
void cut_lower_float_arithmetic(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_float_arithmetic law;if(!pl_x86_float_arithmetic_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_sse_guard(c);
    enum { A=26u,B=30u,R=34u,ALL=38u,FIRST=40u };
    if(law.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        if(law.lanes==1u){cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);cut_mask(c,law.bytes*8u);cut_set(c,B);}
        else{cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);
            cut_i32_const(c,c->report.memory_access|MACHINE_MEMORY_ALIGNED16);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);
            cut_access_value(c);cut_set(c,B);cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
            wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));cut_set(c,B+1u);
            if(law.bytes==4u){cut_get(c,B+1u);cut_const(c,32u);cut_op(c,0x88u);cut_set(c,B+3u);cut_get(c,B+1u);cut_mask(c,32u);cut_set(c,B+2u);
                cut_get(c,B);cut_const(c,32u);cut_op(c,0x88u);cut_set(c,B+1u);cut_get(c,B);cut_mask(c,32u);cut_set(c,B);}
        }
    }
    for(pl_u32 lane=0u;lane<law.lanes;++lane){pl_u32 offset=lane*law.bytes;
        cut_get(c,0u);cut_op(c,law.bytes==4u?0x35u:0x29u);wasm_writer_uleb(c->writer,law.bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u+offset);cut_set(c,A+lane);
        if(!law.source_memory){cut_get(c,0u);cut_op(c,law.bytes==4u?0x35u:0x29u);wasm_writer_uleb(c->writer,law.bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.source*16u+offset);cut_set(c,B+lane);}
    }
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    cut_const(c,0u);cut_set(c,ALL);
    _Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_float_arithmetic_plan(law.bytes*8u,law.operation,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    for(pl_u32 lane=0u;lane<law.lanes;++lane){const pl_u32 inputs[]={A+lane,B+lane,CUT_LEFT},outputs[]={R+lane,CUT_STATUS};
        cut_emit_scalar_projection(c,&pure,inputs,FIRST,outputs,2u);cut_get(c,ALL);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,ALL);}
    // An unmasked precomputation exception in ANY lane prevents every lane
    // from reaching postcomputation exceptions. Collect the SIMD frontier
    // before publishing flags or any destination bytes.
    cut_get(c,ALL);cut_get(c,CUT_LEFT);cut_const(c,7u);cut_op(c,0x88u);cut_const(c,~0ull);cut_op(c,0x85u);cut_op(c,0x83u);
    cut_const(c,7u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,ALL);cut_const(c,7u);cut_op(c,0x83u);cut_set(c,ALL);cut_op(c,0x0bu);
    cut_get(c,ALL);cut_set(c,CUT_STATUS);cut_sse_raise(c,0u);
    for(pl_u32 lane=0u;lane<law.lanes;++lane){cut_get(c,0u);cut_get(c,R+lane);cut_op(c,law.bytes==4u?0x3eu:0x37u);
        wasm_writer_uleb(c->writer,law.bytes==4u?2u:3u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u+lane*law.bytes);}
}
