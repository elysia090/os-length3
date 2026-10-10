#include "cut-internal.h"
static void simd(cut_lowering *c,pl_u32 operation)
{cut_op(c,0xfdu);wasm_writer_uleb(c->writer,operation);}
void cut_lower_vector_widen(cut_lowering *c,const pl_x86_instruction *i,const pl_x86_vector_widen *law)
{
    cut_sse_guard(c);
    if(law->source_memory){
        const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);cut_const(c,0u);cut_set(c,CUT_VALUE);
        c->report.memory_bytes=law->source_bytes;c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        cut_access(c);
    }
    cut_get(c,0u);
    if(law->source_memory)cut_access_value(c);
    else{
        cut_get(c,0u);cut_op(c,law->source_bytes==2u?0x33u:law->source_bytes==4u?0x35u:0x29u);
        wasm_writer_uleb(c->writer,law->source_bytes==2u?1u:law->source_bytes==4u?2u:3u);
        wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law->source*16u);
    }
    simd(c,0x12u);
    for(pl_u32 bytes=law->source_lane_bytes;bytes<law->target_lane_bytes;bytes*=2u)
        simd(c,(bytes==1u?0x87u:bytes==2u?0xa7u:0xc7u)+(law->signed_lanes?0u:2u));
    simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law->target*16u);
}
