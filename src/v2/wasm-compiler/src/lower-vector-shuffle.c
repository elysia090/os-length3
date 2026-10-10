#include "cut-internal.h"
void cut_lower_mmx_shuffle(cut_lowering *c,const pl_x86_instruction *i,const pl_x86_mmx_shuffle *law)
{
    cut_mmx_guard(c);
    if(law->source_memory){const pl_x86_memory *m=&i->operands[1].value.memory;cut_effective_address(c,i,m);cut_set(c,CUT_ADDRESS);
        c->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);cut_const(c,0u);cut_set(c,CUT_VALUE);cut_access(c);cut_access_value(c);
    }else cut_load(c,offsetof(machine_state,x87_significand)+law->source*8u);
    cut_set(c,26u);
    _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
    if(pl_x86_mmx_shuffle_plan(law->control,&arena,&plan)){c->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_u32 input[]={26u},output[]={27u};cut_emit_scalar_projection(c,&plan,input,32u,output,1u);
    cut_store(c,offsetof(machine_state,x87_significand)+law->target*8u,27u);cut_mmx_publish(c,law->target);
}

static void simd(cut_lowering *cut,pl_u32 opcode)
{
    cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,opcode);
}
static void load_xmm(cut_lowering *cut,pl_u32 index)
{
    cut_get(cut,0u);simd(cut,0x00u);
    wasm_writer_uleb(cut->writer,4u);
    wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+index*16u);
}
void cut_lower_vector_shuffle(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_x86_vector_swizzle law;if(!pl_x86_vector_swizzle_lower(instruction,&law)){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    pl_u32 target=law.target,narrow=law.register_bytes==8u;
    if(narrow)cut_mmx_guard(cut);else cut_sse_guard(cut);
    if(law.source_memory){const pl_x86_memory *m=&instruction->operands[1].value.memory;
        cut_effective_address(cut,instruction,m);cut_set(cut,CUT_ADDRESS);
        cut->report.memory_bytes=law.register_bytes;cut->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);
        if(narrow){cut_const(cut,0u);cut_set(cut,CUT_VALUE);cut_access(cut);}
        else{cut->report.memory_access|=MACHINE_MEMORY_ALIGNED16;cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);cut_get(cut,CUT_ADDRESS);
            cut_i32_const(cut,16u);cut_i32_const(cut,cut->report.memory_access);cut_call(cut,WASM_IMPORT_READ_PAIR);cut_access_status(cut);}
    }
    cut_get(cut,0u);
    if(narrow){cut_load(cut,offsetof(machine_state,x87_significand)+target*8u);simd(cut,0x12u);}else load_xmm(cut,target);
    if(law.alias){cut_op(cut,0x22u);wasm_writer_uleb(cut->writer,cut->vector_local);cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,cut->vector_local);}
    else if(law.source_memory){cut_access_value(cut);simd(cut,0x12u);
        if(!narrow){cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);cut_op(cut,0x29u);wasm_writer_uleb(cut->writer,3u);
            wasm_writer_uleb(cut->writer,offsetof(machine_memory_pair_port,high));simd(cut,0x1eu);cut_op(cut,1u);}
    }else if(narrow){cut_load(cut,offsetof(machine_state,x87_significand)+law.source*8u);simd(cut,0x12u);}else load_xmm(cut,law.source);
    /* The high bit requests zero; only log2(register bytes) select bits live. */
    simd(cut,0x0cu);for(pl_u32 i=0u;i<16u;++i)cut_op(cut,(pl_u8)(0x80u|(law.register_bytes-1u)));
    simd(cut,0x4eu);simd(cut,0x0eu); /* v128.and; i8x16.swizzle */
    if(narrow){simd(cut,0x1du);cut_op(cut,0u);cut_op(cut,0x37u);wasm_writer_uleb(cut->writer,3u);
        wasm_writer_uleb(cut->writer,offsetof(machine_state,x87_significand)+target*8u);cut_mmx_publish(cut,target);}
    else{simd(cut,0x0bu);wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+target*16u);}
}
