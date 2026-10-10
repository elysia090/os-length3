#include "cut-internal.h"
static void simd(cut_lowering *c,pl_u32 op){cut_op(c,0xfdu);wasm_writer_uleb(c->writer,op);}
static void get(cut_lowering *c,pl_u32 local){cut_op(c,0x20u);wasm_writer_uleb(c->writer,local);}
static void load(cut_lowering *c,pl_u32 reg){cut_get(c,0u);simd(c,0u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+reg*16u);}
static void source(cut_lowering *c,const pl_x86_vector_reduction *p){
    if(!p->source_memory){load(c,p->source);return;}
    cut_access_value(c);simd(c,0x12u);get(c,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
    wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));simd(c,0x1eu);cut_op(c,1u);
}
void cut_lower_vector_reduction(cut_lowering *c,const pl_x86_instruction *i,const pl_x86_vector_reduction *p)
{
    cut_sse_guard(c);if(p->source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_bytes=16u;c->report.memory_access=MACHINE_MEMORY_READ|MACHINE_MEMORY_ALIGNED16|cut_memory_role(m);
        get(c,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);cut_i32_const(c,c->report.memory_access);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);}
    if(!p->minimum_position){
        source(c,p);load(c,p->target);simd(c,0x4fu);simd(c,0x53u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,CUT_LEFT);
        load(c,p->target);source(c,p);simd(c,0x4eu);simd(c,0x53u);cut_op(c,0x45u);cut_op(c,0xadu);
        cut_const(c,6u);cut_op(c,0x86u);cut_get(c,CUT_LEFT);cut_op(c,0x84u);cut_set(c,CUT_LEFT);
        cut_get(c,CUT_FLAGS);cut_const(c,~0x8d5ull);cut_op(c,0x83u);cut_get(c,CUT_LEFT);cut_op(c,0x84u);cut_set(c,CUT_FLAGS);c->report.flags_written=1u;return;
    }
    source(c,p);cut_op(c,0x22u);wasm_writer_uleb(c->writer,c->vector_local);cut_op(c,0x21u);wasm_writer_uleb(c->writer,c->vector_aux);
    for(pl_u32 step=1u;step<=4u;step*=2u){get(c,c->vector_aux);get(c,c->vector_aux);get(c,c->vector_aux);simd(c,0x0du);
        for(pl_u32 b=0u;b<16u;++b)cut_op(c,(pl_u8)((b+step*2u)&15u));
        simd(c,0x97u);cut_op(c,0x21u);wasm_writer_uleb(c->writer,c->vector_aux);}
    get(c,c->vector_local);get(c,c->vector_aux);simd(c,0x2du);simd(c,0x84u);cut_op(c,0x68u);cut_op(c,0xadu);cut_const(c,16u);cut_op(c,0x86u);
    get(c,c->vector_aux);simd(c,0x19u);cut_op(c,0u);cut_op(c,0xadu);cut_op(c,0x84u);cut_set(c,CUT_VALUE);
    cut_get(c,0u);cut_get(c,CUT_VALUE);simd(c,0x12u);cut_const(c,0u);simd(c,0x1eu);cut_op(c,1u);simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);
    wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p->target*16u);
}
