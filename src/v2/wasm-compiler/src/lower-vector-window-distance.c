#include "cut-internal.h"
static void simd(cut_lowering *c,pl_u32 op){cut_op(c,0xfdu);wasm_writer_uleb(c->writer,op);}
static void get(cut_lowering *c,pl_u32 n){cut_op(c,0x20u);wasm_writer_uleb(c->writer,n);}
static void set(cut_lowering *c,pl_u32 n){cut_op(c,0x21u);wasm_writer_uleb(c->writer,n);}
static void shuffled_source(cut_lowering *c,const pl_x86_vector_window_distance *p,pl_u32 right,pl_u32 term)
{
    if(right&&p->source_memory){cut_access_value(c);simd(c,0x12u);get(c,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
        wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));simd(c,0x1eu);cut_op(c,1u);}
    else{cut_get(c,0u);simd(c,0u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+(right?p->source:p->target)*16u);}
    set(c,c->vector_local);get(c,c->vector_local);get(c,c->vector_local);simd(c,0x0du);
    for(pl_u32 byte=0u;byte<16u;++byte)cut_op(c,(pl_u8)(right?(p->control&3u)*4u+term:((p->control&4u)?4u:0u)+(byte&7u)+term));
    simd(c,0x89u); // Eight unsigned bytes become eight independent word lanes.
}
static void difference(cut_lowering *c,const pl_x86_vector_window_distance *p,pl_u32 term)
{shuffled_source(c,p,0u,term);shuffled_source(c,p,1u,term);simd(c,0x91u);simd(c,0x80u);}
void cut_lower_vector_window_distance(cut_lowering *c,const pl_x86_instruction *i,const pl_x86_vector_window_distance *p)
{
    cut_sse_guard(c);
    if(p->source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);
        c->report.memory_bytes=16u;c->report.memory_access=MACHINE_MEMORY_READ|MACHINE_MEMORY_ALIGNED16|cut_memory_role(m);
        get(c,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);cut_i32_const(c,c->report.memory_access);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);}
    // Four independent byte differences reduce in a balanced two-wave tree;
    // no lane array or scalar pairwise grid is ever reconstructed.
    difference(c,p,0u);set(c,c->vector_aux);difference(c,p,1u);get(c,c->vector_aux);simd(c,0x8eu);set(c,c->vector_result);
    difference(c,p,2u);set(c,c->vector_aux);difference(c,p,3u);get(c,c->vector_aux);simd(c,0x8eu);get(c,c->vector_result);simd(c,0x8eu);set(c,c->vector_result);
    cut_get(c,0u);get(c,c->vector_result);simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p->target*16u);
}
