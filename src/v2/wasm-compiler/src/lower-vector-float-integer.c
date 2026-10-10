#include "cut-internal.h"
static void simd(cut_lowering *c,pl_u32 op){cut_op(c,0xfdu);wasm_writer_uleb(c->writer,op);}
static void get(cut_lowering *c,pl_u32 n){cut_op(c,0x20u);wasm_writer_uleb(c->writer,n);}
static void set(cut_lowering *c,pl_u32 n){cut_op(c,0x21u);wasm_writer_uleb(c->writer,n);}
static void floating_constant(cut_lowering *c,pl_u64 value,pl_u32 bytes)
{if(bytes==4u){cut_i32_const(c,(pl_u32)value);simd(c,0x11u);}else{cut_const(c,value);simd(c,0x12u);}}
static void integer_mask(cut_lowering *c,pl_u32 n,pl_u32 bytes)
{
    get(c,n);if(bytes==8u){get(c,n);simd(c,0x0du);const pl_u8 order[]={0,1,2,3,8,9,10,11,0,1,2,3,8,9,10,11};
        for(pl_u32 b=0u;b<16u;++b)cut_op(c,order[b]);}
}
void cut_lower_vector_float_integer(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_vector_float_integer p;if(!pl_x86_vector_float_integer_lower(i,&p)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    pl_u32 bytes=p.element_bytes,raw=c->vector_local,rounded=c->vector_aux,invalid=c->vector_result;
    cut_sse_guard(c);if(p.target_class==PL_X86_REGISTER_MMX)cut_x87_pending_guard(c,CUT_LEFT,CUT_RIGHT);
    if(p.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);
        c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        if(p.source_bytes==16u){cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);
            cut_i32_const(c,c->report.memory_access|MACHINE_MEMORY_ALIGNED16);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);}
        else{cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);}
        cut_access_value(c);if(p.source_bytes==4u){cut_op(c,0xa7u);simd(c,0x11u);}else simd(c,0x12u);
        if(p.source_bytes==16u){cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
            wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));simd(c,0x1eu);cut_op(c,1u);}
    }else{cut_get(c,0u);if(p.source_bytes==16u){simd(c,0u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p.source*16u);}
        else{cut_op(c,p.source_bytes==4u?0x35u:0x29u);wasm_writer_uleb(c->writer,p.source_bytes==4u?2u:3u);
            wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p.source*16u);if(p.source_bytes==4u){cut_op(c,0xa7u);simd(c,0x11u);}else simd(c,0x12u);}}
    set(c,raw);cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    cut_get(c,CUT_LEFT);cut_const(c,64u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
    get(c,raw);floating_constant(c,bytes==4u?0x80000000u:0x8000000000000000ull,bytes);simd(c,0x4eu);
    get(c,raw);get(c,raw);floating_constant(c,bytes==4u?0x7fffffffu:0x7fffffffffffffffull,bytes);simd(c,0x4eu);
    floating_constant(c,bytes==4u?0x00800000u:0x0010000000000000ull,bytes);simd(c,bytes==4u?0x3au:0xd8u);simd(c,0x52u);set(c,raw);cut_op(c,0x0bu);
    get(c,raw);
    if(p.truncate)simd(c,bytes==4u?0x69u:0x7au);
    else{cut_get(c,CUT_LEFT);cut_const(c,13u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,CUT_VALUE);set(c,rounded);
        cut_get(c,CUT_VALUE);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x7bu);get(c,rounded);simd(c,bytes==4u?0x6au:0x94u);cut_op(c,0x05u);
        cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);get(c,rounded);simd(c,bytes==4u?0x68u:0x75u);cut_op(c,0x05u);
        cut_get(c,CUT_VALUE);cut_const(c,2u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);get(c,rounded);simd(c,bytes==4u?0x67u:0x74u);cut_op(c,0x05u);
        get(c,rounded);simd(c,bytes==4u?0x69u:0x7au);cut_op(c,0x0bu);cut_op(c,0x0bu);cut_op(c,0x0bu);}
    set(c,rounded);
    pl_u64 minimum=p.target_bytes==8u?(bytes==4u?0xdf000000u:0xc3e0000000000000ull):(bytes==4u?0xcf000000u:0xc1e0000000000000ull);
    pl_u64 maximum=p.target_bytes==8u?(bytes==4u?0x5f000000u:0x43e0000000000000ull):(bytes==4u?0x4f000000u:0x41e0000000000000ull);
    get(c,rounded);floating_constant(c,minimum,bytes);simd(c,bytes==4u?0x43u:0x49u);
    get(c,rounded);floating_constant(c,maximum,bytes);simd(c,bytes==4u?0x46u:0x4cu);simd(c,0x50u);
    get(c,rounded);get(c,rounded);simd(c,bytes==4u?0x42u:0x48u);simd(c,0x50u);set(c,invalid);
    get(c,invalid);simd(c,0x53u);cut_op(c,0xadu);cut_set(c,CUT_STATUS);
    get(c,raw);get(c,rounded);simd(c,bytes==4u?0x42u:0x48u);get(c,invalid);simd(c,0x4fu);simd(c,0x53u);cut_op(c,0xadu);
    cut_const(c,5u);cut_op(c,0x86u);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,CUT_VALUE);
    cut_get(c,CUT_STATUS);cut_get(c,CUT_LEFT);cut_const(c,128u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0xadu);cut_op(c,0x83u);
    cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x83u);cut_set(c,CUT_VALUE);cut_op(c,0x0bu);
    cut_get(c,CUT_VALUE);cut_set(c,CUT_STATUS);cut_sse_raise(c,p.target_class==PL_X86_REGISTER_MMX?1u:0u);
    if(p.target_bytes==8u){cut_const(c,0x8000000000000000ull);get(c,rounded);simd(c,bytes==4u?0x1fu:0x21u);cut_op(c,0u);
        cut_op(c,0xfcu);wasm_writer_uleb(c->writer,bytes==4u?4u:6u);get(c,invalid);simd(c,0x53u);cut_op(c,0x1bu);cut_set(c,CUT_VALUE);}
    else{cut_i32_const(c,0x80000000u);simd(c,0x11u);get(c,rounded);simd(c,bytes==4u?0xf8u:0xfcu);integer_mask(c,invalid,bytes);simd(c,0x52u);set(c,rounded);
        if(p.target_class==PL_X86_REGISTER_GPR){get(c,rounded);simd(c,0x1bu);cut_op(c,0u);cut_op(c,0xadu);cut_set(c,CUT_VALUE);}
        else if(p.target_class==PL_X86_REGISTER_MMX){get(c,rounded);simd(c,0x1du);cut_op(c,0u);cut_set(c,CUT_VALUE);}
        else if(bytes==8u){get(c,rounded);simd(c,0x1du);cut_op(c,0u);simd(c,0x12u);cut_const(c,0u);simd(c,0x1eu);cut_op(c,1u);set(c,rounded);}}
    if(p.target_class==PL_X86_REGISTER_GPR)cut_write_register(c,&i->operands[0].value.reg);
    else if(p.target_class==PL_X86_REGISTER_VECTOR){cut_get(c,0u);get(c,rounded);simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+p.target*16u);}
    else{cut_store(c,offsetof(machine_state,x87_significand)+p.target*8u,CUT_VALUE);cut_mmx_publish(c,p.target);}
}
