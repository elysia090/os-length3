#include "cut-internal.h"
static void simd(cut_lowering *c,pl_u32 op){cut_op(c,0xfdu);wasm_writer_uleb(c->writer,op);}
static void vg(cut_lowering *c,pl_u32 n){cut_op(c,0x20u);wasm_writer_uleb(c->writer,n);}
static void vs(cut_lowering *c,pl_u32 n){cut_op(c,0x21u);wasm_writer_uleb(c->writer,n);}
static void mask32(cut_lowering *c,pl_u32 n)
{
    const pl_u8 select[]={0,1,2,3,8,9,10,11,0,1,2,3,8,9,10,11};
    vg(c,n);vg(c,n);simd(c,0x0du);for(pl_u32 i=0u;i<16u;++i)cut_op(c,select[i]);
}
static void double_constant(cut_lowering *c,pl_u64 bits){cut_const(c,bits);simd(c,0x12u);}
void cut_lower_vector_float_integer(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_vector_float_integer law;if(!pl_x86_vector_float_integer_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_sse_guard(c);
    if(law.target_class==PL_X86_REGISTER_MMX)cut_x87_pending_guard(c,CUT_LEFT,CUT_RIGHT);
    if(law.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        if(law.source_bytes==16u){cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,16u);cut_i32_const(c,c->report.memory_access|MACHINE_MEMORY_ALIGNED16);
            cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);
        }else{cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);}
        cut_access_value(c);
        if(law.source_bytes==4u){cut_op(c,0xa7u);simd(c,0x11u);}else simd(c,0x12u);
        if(law.source_bytes==16u){cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_op(c,0x29u);wasm_writer_uleb(c->writer,3u);
            wasm_writer_uleb(c->writer,offsetof(machine_memory_pair_port,high));simd(c,0x1eu);cut_op(c,1u);}
    }else if(law.target_class==PL_X86_REGISTER_GPR){
        cut_load(c,offsetof(machine_state,xmm)+law.source*16u);
        if(law.source_bytes==4u){cut_op(c,0xa7u);simd(c,0x11u);}else simd(c,0x12u);
    }else{cut_get(c,0u);simd(c,0x00u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.source*16u);}
    vs(c,c->vector_local);
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    // DAZ changes only exponent-zero operands to signed zero. Numeric
    // conversion itself never creates DE; FTZ is irrelevant to an integer.
    cut_get(c,CUT_LEFT);cut_const(c,64u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
    vg(c,c->vector_local);
    if(law.element_bytes==8u){cut_const(c,0x8000000000000000ull);simd(c,0x12u);simd(c,0x4eu);vg(c,c->vector_local);vg(c,c->vector_local);cut_const(c,0x7ff0000000000000ull);simd(c,0x12u);simd(c,0x4eu);
        cut_const(c,0u);simd(c,0x12u);simd(c,0xd6u);
    }else{cut_i32_const(c,0x80000000u);simd(c,0x11u);simd(c,0x4eu);vg(c,c->vector_local);vg(c,c->vector_local);cut_i32_const(c,0x7f800000u);simd(c,0x11u);simd(c,0x4eu);
        cut_i32_const(c,0u);simd(c,0x11u);simd(c,0x37u);}
    simd(c,0x52u);vs(c,c->vector_local);cut_op(c,0x0bu);
    vg(c,c->vector_local);if(law.element_bytes==4u)simd(c,0x5fu);vs(c,c->vector_local);
    vg(c,c->vector_local);
    if(law.truncate)simd(c,0x7au);
    else{
        cut_get(c,CUT_LEFT);cut_const(c,13u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,CUT_VALUE);
        // Each branch reads its vector inside the structured block.
        vs(c,c->vector_aux);cut_get(c,CUT_VALUE);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x7bu);
        vg(c,c->vector_aux);simd(c,0x94u);cut_op(c,0x05u);
        cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
        vg(c,c->vector_aux);simd(c,0x75u);cut_op(c,0x05u);
        cut_get(c,CUT_VALUE);cut_const(c,2u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
        vg(c,c->vector_aux);simd(c,0x74u);cut_op(c,0x05u);vg(c,c->vector_aux);simd(c,0x7au);cut_op(c,0x0bu);cut_op(c,0x0bu);cut_op(c,0x0bu);
    }
    vs(c,c->vector_aux);
    vg(c,c->vector_aux);double_constant(c,law.target_bytes==8u?0xc3e0000000000000ull:0xc1e0000000000000ull);simd(c,0x49u);
    vg(c,c->vector_aux);double_constant(c,law.target_bytes==8u?0x43e0000000000000ull:0x41e0000000000000ull);simd(c,0x4cu);simd(c,0x50u);
    vg(c,c->vector_aux);vg(c,c->vector_aux);simd(c,0x47u);simd(c,0x4du);simd(c,0x50u);vs(c,c->vector_result);
    vg(c,c->vector_result);simd(c,0xc4u);cut_op(c,0xadu);cut_set(c,CUT_STATUS);
    vg(c,c->vector_local);vg(c,c->vector_aux);simd(c,0x47u);simd(c,0x4du);vg(c,c->vector_result);simd(c,0x4fu);simd(c,0xc4u);cut_op(c,0xadu);cut_set(c,CUT_VALUE);
    cut_get(c,CUT_STATUS);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,CUT_STATUS);
    cut_get(c,CUT_VALUE);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_const(c,5u);cut_op(c,0x86u);cut_get(c,CUT_STATUS);cut_op(c,0x84u);cut_set(c,CUT_VALUE);
    // An unmasked invalid lane wins before precision from another lane;
    // already-sticky MXCSR flags remain independent of this instruction.
    cut_get(c,CUT_STATUS);cut_op(c,0x50u);cut_op(c,0x45u);
    cut_get(c,CUT_LEFT);cut_const(c,128u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x71u);cut_op(c,0x04u);cut_op(c,0x40u);
    cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x83u);cut_set(c,CUT_VALUE);cut_op(c,0x0bu);
    cut_get(c,CUT_VALUE);cut_set(c,CUT_STATUS);cut_sse_raise(c,law.target_class==PL_X86_REGISTER_MMX?1u:0u);
    if(law.target_bytes==8u){
        cut_const(c,0x8000000000000000ull);vg(c,c->vector_aux);simd(c,0x21u);cut_op(c,0u);cut_op(c,0xfcu);wasm_writer_uleb(c->writer,6u);
        vg(c,c->vector_result);simd(c,0xc4u);cut_op(c,0x1bu);cut_set(c,CUT_VALUE);
    }else{
        cut_i32_const(c,0x80000000u);simd(c,0x11u);vg(c,c->vector_aux);simd(c,0xfcu);mask32(c,c->vector_result);simd(c,0x52u);
        if(law.target_class==PL_X86_REGISTER_VECTOR){simd(c,0x1du);cut_op(c,0u);simd(c,0x12u);cut_const(c,0u);simd(c,0x1eu);cut_op(c,1u);vs(c,c->vector_aux);}
        else{simd(c,0x1du);cut_op(c,0u);if(law.target_class==PL_X86_REGISTER_GPR)cut_mask(c,32u);cut_set(c,CUT_VALUE);}
    }
    if(law.target_class==PL_X86_REGISTER_GPR)cut_write_register(c,&i->operands[0].value.reg);
    else if(law.target_class==PL_X86_REGISTER_VECTOR){cut_get(c,0u);vg(c,c->vector_aux);simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u);}
    else{cut_store(c,offsetof(machine_state,x87_significand)+law.target*8u,CUT_VALUE);cut_mmx_publish(c,law.target);}
}
