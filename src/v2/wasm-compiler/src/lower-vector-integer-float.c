#include "cut-internal.h"
static void simd(cut_lowering *c,pl_u32 op){cut_op(c,0xfdu);wasm_writer_uleb(c->writer,op);}
static void vg(cut_lowering *c,pl_u32 n){cut_op(c,0x20u);wasm_writer_uleb(c->writer,n);}
static void vs(cut_lowering *c,pl_u32 n){cut_op(c,0x21u);wasm_writer_uleb(c->writer,n);}
static void mask32(cut_lowering *c,pl_u32 n)
{
    const pl_u8 select[]={0,1,2,3,8,9,10,11,0,1,2,3,8,9,10,11};
    vg(c,n);vg(c,n);simd(c,0x0du);for(pl_u32 i=0u;i<16u;++i)cut_op(c,select[i]);
}
static void fault(cut_lowering *c,pl_u32 vector)
{
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_load(c,offsetof(machine_state,rip));cut_op(c,0x37u);
    wasm_writer_uleb(c->writer,3u);wasm_writer_uleb(c->writer,offsetof(machine_memory_port,fault_address));
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,vector);cut_op(c,0x36u);
    wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_memory_port,fault_vector));
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,0u);cut_op(c,0x36u);
    wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_memory_port,fault_error));
    cut_const(c,machine_result_make(MACHINE_RESULT_FAULT,vector));cut_op(c,0x0fu);
}
void cut_lower_vector_integer_float(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_x86_vector_integer_float law;if(!pl_x86_vector_integer_float_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    cut_sse_guard(c);cut_x87_pending_guard(c,CUT_LEFT,CUT_RIGHT);
    if(law.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;
        cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);
    }else cut_load(c,offsetof(machine_state,x87_significand)+law.source*8u);
    simd(c,0x12u);simd(c,0xfeu);vs(c,c->vector_local); // Both int32 lanes are exact in binary64.
    vg(c,c->vector_local);simd(c,0x5eu);vs(c,c->vector_aux); // nearest-even binary32 reference.
    vg(c,c->vector_aux);simd(c,0x5fu);vs(c,c->vector_result);
    vg(c,c->vector_result);vg(c,c->vector_local);simd(c,0x4au);vs(c,c->vector_result+1u); // rounded > exact
    vg(c,c->vector_result);vg(c,c->vector_local);simd(c,0x47u);simd(c,0xc4u);cut_op(c,0xadu);
    cut_const(c,3u);cut_op(c,0x85u);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0xadu);cut_set(c,CUT_STATUS);
    // One pair of comparison masks chooses the adjacent IEEE encoding; no
    // scalar lane rebuild, integer saturation or host rounding mode is used.
    vg(c,c->vector_result);vg(c,c->vector_local);simd(c,0x49u);vs(c,c->vector_result+2u); // rounded < exact
    cut_get(c,0u);cut_op(c,0x35u);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));cut_set(c,CUT_LEFT);
    cut_get(c,CUT_LEFT);cut_const(c,13u);cut_op(c,0x88u);cut_const(c,3u);cut_op(c,0x83u);cut_set(c,CUT_VALUE);
    cut_get(c,CUT_VALUE);cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
    // sign = 0/-1 in the final binary32 lane geometry.
    vg(c,c->vector_aux);cut_i32_const(c,31u);simd(c,0xacu);vs(c,c->vector_local);
    cut_get(c,CUT_VALUE);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    mask32(c,c->vector_result+2u);mask32(c,c->vector_result+1u);vg(c,c->vector_local);simd(c,0x52u);
    cut_op(c,0x05u);
    cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    mask32(c,c->vector_result+1u);cut_op(c,0x05u);mask32(c,c->vector_result+2u);cut_op(c,0x0bu);cut_op(c,0x0bu);
    vs(c,c->vector_result+1u);
    cut_get(c,CUT_VALUE);cut_const(c,3u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    cut_i32_const(c,0xffffffffu);simd(c,0x11u);cut_op(c,0x05u);
    vg(c,c->vector_local);cut_i32_const(c,1u);simd(c,0x11u);simd(c,0x50u); // positive:+1, negative:-1
    vs(c,c->vector_result+2u);
    cut_get(c,CUT_VALUE);cut_const(c,1u);cut_op(c,0x51u);cut_op(c,0x04u);cut_op(c,0x7bu);
    vg(c,c->vector_result+2u);simd(c,0xa1u);cut_op(c,0x05u);vg(c,c->vector_result+2u);cut_op(c,0x0bu);cut_op(c,0x0bu);
    vg(c,c->vector_result+1u);simd(c,0x4eu);vg(c,c->vector_aux);simd(c,0xaeu);vs(c,c->vector_aux);cut_op(c,0x0bu);
    cut_get(c,CUT_STATUS);cut_const(c,5u);cut_op(c,0x86u);cut_get(c,CUT_LEFT);cut_op(c,0x84u);cut_set(c,CUT_LEFT);
    cut_get(c,0u);cut_get(c,CUT_LEFT);cut_op(c,0x3eu);wasm_writer_uleb(c->writer,2u);wasm_writer_uleb(c->writer,offsetof(machine_state,mxcsr));
    cut_get(c,CUT_STATUS);cut_set(c,CUT_VALUE);
    // MMX register admission precedes even an unmasked SIMD precision fault;
    // a memory source does not cause that x87->MMX transition.
    if(!law.source_memory)cut_mmx_publish(c,8u);
    cut_get(c,CUT_VALUE);cut_op(c,0x50u);cut_op(c,0x45u);cut_get(c,CUT_LEFT);cut_const(c,4096u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x71u);
    cut_op(c,0x04u);cut_op(c,0x40u);
    cut_load(c,offsetof(machine_state,cr4));cut_const(c,1024u);cut_op(c,0x83u);cut_op(c,0x50u);cut_op(c,0x04u);cut_op(c,0x40u);fault(c,6u);cut_op(c,0x0bu);fault(c,19u);cut_op(c,0x0bu);
    cut_get(c,0u);vg(c,c->vector_aux);simd(c,0x1du);cut_op(c,0u);cut_op(c,0x37u);wasm_writer_uleb(c->writer,3u);
    wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u);
}
