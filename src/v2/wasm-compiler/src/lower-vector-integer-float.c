#include "cut-internal.h"
static void simd(cut_lowering *c,pl_u32 op){cut_op(c,0xfdu);wasm_writer_uleb(c->writer,op);}
static void vg(cut_lowering *c,pl_u32 n){cut_op(c,0x20u);wasm_writer_uleb(c->writer,n);}
static void vs(cut_lowering *c,pl_u32 n){cut_op(c,0x21u);wasm_writer_uleb(c->writer,n);}
static void scalar(cut_lowering *c,const pl_x86_instruction *i,const pl_x86_vector_integer_float *law)
{
    cut_sse_guard(c);
    if(law->source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);
    }else cut_read_operand(c,&i->operands[1],law->source_bytes*8u);
    cut_set(c,CUT_VALUE);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    cut_get(c,CUT_LEFT);cut_const(c,13u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,CUT_RIGHT);
    _Alignas(8) pl_u8 scratch[24576];pl_arena arena={scratch,sizeof scratch,0u};pl_plan pure;
    if(pl_x86_signed_float_plan(law->source_bytes*8u,law->target_bytes*8u,&arena,&pure)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 inputs[]={CUT_VALUE,CUT_RIGHT,CUT_NEXT,CUT_ADDRESS,CUT_FLAGS},outputs[]={CUT_VALUE,CUT_STATUS};
    cut_emit_scalar_projection(c,&pure,inputs,32u,outputs,2u);
    cut_get(c,CUT_STATUS);cut_const(c,5u);cut_op(c,0x86u);cut_set(c,CUT_STATUS);cut_sse_raise(c,0u);
    cut_get(c,0u);cut_get(c,CUT_VALUE);cut_op(c,law->target_bytes==4u?0x3eu:0x37u);wasm_writer_uleb(c->writer,law->target_bytes==4u?2u:3u);
    wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law->target*16u);
}
void cut_lower_vector_integer_float(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_vector_integer_float law;if(!pl_x86_vector_integer_float_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    if(law.source_class==PL_X86_REGISTER_GPR){scalar(c,i,&law);return;}
    cut_sse_guard(c);pl_u32 mmx=law.source_class==PL_X86_REGISTER_MMX;
    if(mmx)cut_x87_pending_guard(c,CUT_LEFT,CUT_RIGHT);
    if(law.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        if(law.source_bytes==16u){c->report.memory_access|=MACHINE_MEMORY_ALIGNED16;
            cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);cut_i32_const(c,c->report.memory_access);
            cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);}
        else{cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);}
        cut_access_value(c);simd(c,0x12u);
        if(law.source_bytes==16u){cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
            wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));simd(c,0x1eu);cut_op(c,1u);}
    }else if(mmx){cut_load(c,offsetof(machine_state,x87_significand)+law.source*8u);simd(c,0x12u);}
    else if(law.source_bytes==8u){cut_load(c,offsetof(machine_state,xmm)+law.source*16u);simd(c,0x12u);}
    else{cut_get(c,0u);simd(c,0u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.source*16u);}
    if(law.target_bytes==8u){
        simd(c,0xfeu);vs(c,c->vector_local);cut_get(c,0u);vg(c,c->vector_local);simd(c,0x0bu);
        wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u);return;}
    pl_u32 source=c->vector_local,result=c->vector_aux,back=c->vector_result,greater=back+1u,less=back+2u;
    vs(c,source);vg(c,source);simd(c,0xfau);vs(c,result);vg(c,result);simd(c,0xf8u);vs(c,back);
    // The round-trip witness is exact except positive saturation at 2^31.
    // That one encoding is an explicit greater-than witness, including INT_MAX.
    vg(c,back);vg(c,source);simd(c,0x3bu);vg(c,result);cut_i32_const(c,0x4f000000u);simd(c,0x11u);simd(c,0x37u);simd(c,0x50u);vs(c,greater);
    vg(c,source);vg(c,back);simd(c,0x3bu);vs(c,less);
    vg(c,greater);vg(c,less);simd(c,0x50u);simd(c,0x53u);cut_op(c,0xadu);cut_const(c,5u);cut_op(c,0x86u);cut_set(c,CUT_STATUS);
    vg(c,source);cut_i32_const(c,31u);simd(c,0xacu);vs(c,source);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    cut_get(c,CUT_LEFT);cut_const(c,13u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,CUT_VALUE);
    cut_get(c,CUT_VALUE);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,CUT_VALUE);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    vg(c,less);vg(c,greater);vg(c,source);simd(c,0x52u);cut_op(c,0x05u);
    cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    vg(c,greater);cut_op(c,0x05u);vg(c,less);cut_op(c,0x0bu);cut_op(c,0x0bu);vs(c,greater);
    cut_get(c,CUT_VALUE);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    cut_i32_const(c,0xffffffffu);simd(c,0x11u);cut_op(c,0x05u);
    vg(c,source);cut_i32_const(c,1u);simd(c,0x11u);simd(c,0x50u);vs(c,less);
    cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    vg(c,less);simd(c,0xa1u);cut_op(c,0x05u);vg(c,less);cut_op(c,0x0bu);cut_op(c,0x0bu);
    vg(c,greater);simd(c,0x4eu);vg(c,result);simd(c,0xaeu);vs(c,result);cut_op(c,0x0bu);
    cut_sse_raise(c,mmx&&!law.source_memory?2u:0u);
    cut_get(c,0u);vg(c,result);
    if(mmx){simd(c,0x1du);cut_op(c,0u);cut_op(c,0x37u);wasm_writer_uleb(c->writer,3u);}
    else{simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);}
    wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u);
}
