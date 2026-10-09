#include "cut-internal.h"
enum { SHIFT_COUNT=26 };
pl_u32 cut_vector_shift_shape(const pl_x86_instruction *i)
{pl_x86_vector_shift law;return pl_x86_vector_shift_lower(i,&law)?law.lane_bits:0u;}
static void simd(cut_lowering *c,pl_u32 opcode)
{cut_op(c,0xfdu);wasm_writer_uleb(c->writer,opcode);}
static void target(cut_lowering *c,const pl_x86_vector_shift *law)
{
    if(law->register_bytes==8u){cut_load(c,offsetof(machine_state,x87_significand)+law->target*8u);simd(c,0x12u);}
    else{cut_get(c,0u);simd(c,0u);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law->target*16u);}
}
static void shift(cut_lowering *c,const pl_x86_vector_shift *law)
{
    target(c,law);
    if(law->immediate)cut_i32_const(c,law->arithmetic&&law->count>=law->lane_bits?law->lane_bits-1u:law->count);
    else{
        cut_get(c,SHIFT_COUNT);
        if(law->arithmetic){cut_const(c,law->lane_bits-1u);cut_get(c,SHIFT_COUNT);cut_const(c,law->lane_bits);cut_op(c,0x54u);cut_op(c,0x1bu);}
        cut_op(c,0xa7u);
    }
    pl_u32 op=law->lane_bits==16u?0x8bu:law->lane_bits==32u?0xabu:0xcbu;
    simd(c,op+(law->left?0u:law->arithmetic?1u:2u));
}
void cut_lower_vector_shift(cut_lowering *c,const pl_x86_instruction *i,pl_u32 shape)
{
    (void)shape;pl_x86_vector_shift law;if(!pl_x86_vector_shift_lower(i,&law)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    if(law.register_bytes==8u)cut_mmx_guard(c);else cut_sse_guard(c);
    if(law.source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);
        c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        if(law.register_bytes==8u){cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);}
        else{c->report.memory_access|=MACHINE_MEMORY_ALIGNED16;cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);
            cut_i32_const(c,16u);cut_i32_const(c,c->report.memory_access);cut_call(c,WASM_IMPORT_READ_PAIR);cut_access_status(c);}
        cut_access_value(c);cut_set(c,SHIFT_COUNT);
    }else if(!law.immediate){cut_load(c,law.register_bytes==8u?offsetof(machine_state,x87_significand)+law.source*8u:offsetof(machine_state,xmm)+law.source*16u);cut_set(c,SHIFT_COUNT);}
    if(law.immediate&&!law.count){if(law.register_bytes==8u)cut_mmx_publish(c,law.target);return;}
    cut_get(c,0u);
    if(!law.arithmetic){
        if(law.immediate){if(law.count>=law.lane_bits){cut_const(c,0u);simd(c,0x12u);}else shift(c,&law);}
        else{cut_get(c,SHIFT_COUNT);cut_const(c,law.lane_bits);cut_op(c,0x5au);cut_op(c,0x04u);cut_op(c,0x7bu);
            cut_const(c,0u);simd(c,0x12u);cut_op(c,0x05u);shift(c,&law);cut_op(c,0x0bu);}
    }else shift(c,&law);
    if(law.register_bytes==8u){simd(c,0x1du);cut_op(c,0u);cut_op(c,0x37u);wasm_writer_uleb(c->writer,3u);
        wasm_writer_uleb(c->writer,offsetof(machine_state,x87_significand)+law.target*8u);cut_mmx_publish(c,law.target);}
    else{simd(c,0x0bu);wasm_writer_uleb(c->writer,4u);wasm_writer_uleb(c->writer,offsetof(machine_state,xmm)+law.target*16u);}
}
