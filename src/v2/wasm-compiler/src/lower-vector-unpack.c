#include "cut-internal.h"

pl_u32 cut_vector_unpack_shape(const pl_x86_instruction *i)
{pl_x86_vector_unpack law;return pl_x86_vector_unpack_lower(i,&law)?law.lane_bits|(law.high?128u:0u):0u;}

static void spread(cut_lowering *cut,pl_u32 local,pl_u32 half,pl_u32 width)
{
    cut_get(cut,local);
    if(half) {cut_const(cut,32u);cut_op(cut,0x88u);}
    else cut_mask(cut,32u);
    /* x is a 32-bit fragment. Insert 16-bit gaps, then 8-bit gaps if
     * required. Disjoint fields make each OR an exact substitution.
     * This loop emits a fixed word network, never a guest lane loop. */
    for(pl_u32 shift=16u;shift>=width;shift>>=1u) {
        cut_set(cut,CUT_STATUS);cut_get(cut,CUT_STATUS);cut_get(cut,CUT_STATUS);
        cut_const(cut,shift);cut_op(cut,0x86u);cut_op(cut,0x84u);
        cut_const(cut,shift==16u?0x0000ffff0000ffffull:0x00ff00ff00ff00ffull);cut_op(cut,0x83u);
    }
}

void cut_lower_vector_unpack(cut_lowering *cut,const pl_x86_instruction *instruction,pl_u32 shape)
{
    pl_x86_vector_unpack law;
    if(pl_x86_vector_unpack_lower(instruction,&law)&&law.register_bytes==8u){
        cut_mmx_guard(cut);
        if(law.source_memory){const pl_x86_memory *m=&instruction->operands[1].value.memory;cut_effective_address(cut,instruction,m);cut_set(cut,CUT_ADDRESS);
            cut->report.memory_access=MACHINE_MEMORY_READ|cut_memory_role(m);cut_const(cut,0u);cut_set(cut,CUT_VALUE);cut_access(cut);cut_access_value(cut);}
        else cut_load(cut,offsetof(machine_state,x87_significand)+law.source*8u);
        if(law.high){cut_const(cut,32u);cut_op(cut,0x88u);}cut_set(cut,26u);
        if(law.alias)cut_get(cut,26u);else{cut_load(cut,offsetof(machine_state,x87_significand)+law.target*8u);if(law.high){cut_const(cut,32u);cut_op(cut,0x88u);}}
        cut_set(cut,27u);
        _Alignas(8) pl_u8 scratch[16384];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_vector_unpack_plan(law.lane_bits,law.alias,&arena,&plan)){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
        const pl_u32 inputs[]={27u,26u},outputs[]={28u};cut_emit_scalar_projection(cut,&plan,inputs,32u,outputs,1u);
        cut_store(cut,offsetof(machine_state,x87_significand)+law.target*8u,28u);cut_mmx_publish(cut,law.target);return;
    }
    pl_u32 width=shape&127u,selected=shape&128u?8u:0u;
    pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[0].value.reg.index*16u;
    int read=!!(instruction->machine_argument&(1ull<<24u));
    int equal=!read && instruction->operands[0].value.reg.index==instruction->operands[1].value.reg.index;
    /* The shared SSE guard and full aligned operand preflight have passed.
     * Only the selected old word is live. Capture before publishing either
     * result, including when both operands name the same XMM register. */
    if(read) {
        if(selected) {
            cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);cut_op(cut,0x29u);
            wasm_writer_uleb(cut->writer,3u);wasm_writer_uleb(cut->writer,offsetof(machine_memory_pair_port,high));
        } else cut_access_value(cut);
    } else cut_load(cut,(pl_u32)offsetof(machine_state,xmm)
        +instruction->operands[1].value.reg.index*16u+selected);
    cut_set(cut,CUT_LEFT);
    if(!equal) {cut_load(cut,offset+selected);cut_set(cut,CUT_RIGHT);}
    if(width==64u) {
        cut_store(cut,offset,equal?CUT_LEFT:CUT_RIGHT);cut_store(cut,offset+8u,CUT_LEFT);return;
    }
    if(equal) {
        /* The interleaved fields are disjoint: s | (s << width) equals
         * s * (1 + 2^width), modulo 2^64. Spread each fragment once. */
        for(pl_u32 half=0u;half<2u;++half) {
            spread(cut,CUT_LEFT,half,width);cut_const(cut,(1ull<<width)+1u);cut_op(cut,0x7eu);
            cut_set(cut,half?CUT_NEXT:CUT_VALUE);
        }
    } else if(width==32u) {
        cut_get(cut,CUT_RIGHT);cut_mask(cut,32u);
        cut_get(cut,CUT_LEFT);cut_const(cut,32u);cut_op(cut,0x86u);cut_op(cut,0x84u);cut_set(cut,CUT_VALUE);
        cut_get(cut,CUT_RIGHT);cut_const(cut,32u);cut_op(cut,0x88u);
        cut_get(cut,CUT_LEFT);cut_const(cut,0xffffffff00000000ull);cut_op(cut,0x83u);
        cut_op(cut,0x84u);cut_set(cut,CUT_NEXT);
    } else for(pl_u32 half=0u;half<2u;++half) {
        spread(cut,CUT_RIGHT,half,width);spread(cut,CUT_LEFT,half,width);
        cut_const(cut,width);cut_op(cut,0x86u);cut_op(cut,0x84u);
        cut_set(cut,half?CUT_NEXT:CUT_VALUE);
    }
    cut_store(cut,offset,CUT_VALUE);cut_store(cut,offset+8u,CUT_NEXT);
}
