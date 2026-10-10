#include "cut-internal.h"

int cut_masked_store_supported(const pl_x86_instruction *i)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=33u
        ||i->visible_operand_count!=2u||i->opcode!=0xf7u||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER))
        ||(i->address_width!=32u&&i->address_width!=64u))return 0;
    pl_u32 control=(pl_u32)(i->machine_argument>>32u),wide=(control>>4u)&1u;
    if((control&7u)>5u)return 0;
    pl_u32 cls=wide?PL_X86_REGISTER_VECTOR:PL_X86_REGISTER_MMX,bits=wide?128u:64u;
    for(pl_u32 n=0u;n<2u;++n){const pl_x86_operand *o=i->operands+n;
        if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=bits||o->value.reg.class_id!=cls||o->value.reg.bits!=bits
            ||o->value.reg.flags||o->value.reg.index>=(wide?16u:8u))return 0;}
    return i->machine_argument==(33u|((pl_u64)i->operands[0].value.reg.index<<8u)
        |((pl_u64)i->operands[1].value.reg.index<<16u)|((pl_u64)((control&7u)
            |((pl_u32)(i->address_width==64u)<<3u)|(wide<<4u))<<32u));
}

void cut_lower_masked_store(cut_lowering *c,const pl_x86_instruction *i)
{
    pl_u32 control=(pl_u32)(i->machine_argument>>32u),wide=(control>>4u)&1u,bytes=wide?16u:8u;
    if(wide)cut_sse_guard(c);else cut_mmx_guard(c);
    /* The implicit coordinate is live RDI, truncated before its segment base.
     * Capture both columns before any write or MMX-state publication. */
    cut_load(c,offsetof(machine_state,registers)+7u*8u);cut_mask(c,i->address_width);cut_set(c,CUT_ADDRESS);
    pl_u32 first=30u;
    for(pl_u32 n=0u;n<2u;++n)for(pl_u32 half=0u;half<(wide?2u:1u);++half){
        pl_u32 offset=wide?(pl_u32)offsetof(machine_state,xmm)+i->operands[n].value.reg.index*16u+half*8u
            :(pl_u32)offsetof(machine_state,x87_significand)+i->operands[n].value.reg.index*8u;
        cut_load(c,offset);cut_set(c,first+n*2u+half);
    }
    c->report.memory_bytes=bytes;c->report.memory_access=MACHINE_MEMORY_WRITE
        |((control&7u)==2u?MACHINE_MEMORY_STACK:(control&7u)==4u?MACHINE_MEMORY_FS:(control&7u)==5u?MACHINE_MEMORY_GS:0u);
    /* This CPU profile checks the complete extent, even for a zero mask.
     * Intel permits addressing/page faults in that case. No old payload is
     * read, and unselected bytes never acquire a store or dirty effect. */
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_get(c,CUT_ADDRESS);cut_i32_const(c,bytes);cut_i32_const(c,c->report.memory_access);
    cut_call(c,WASM_IMPORT_WRITE_BEGIN);cut_access_status(c);
    for(pl_u32 byte=0u;byte<bytes;++byte){
        cut_get(c,first+2u+byte/8u);cut_const(c,(byte%8u)*8u+7u);cut_op(c,0x88u);cut_const(c,1u);cut_op(c,0x83u);
        cut_op(c,0x50u);cut_op(c,0x45u);cut_op(c,0x04u);cut_op(c,0x40u);
        cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_i32_const(c,byte);cut_i32_const(c,1u);cut_get(c,first+byte/8u);
        cut_const(c,(byte%8u)*8u);cut_op(c,0x88u);cut_const(c,255u);cut_op(c,0x83u);
        cut_call(c,WASM_IMPORT_WRITE_WORD);cut_access_status(c);cut_op(c,0x0bu);
    }
    cut_op(c,0x20u);wasm_writer_uleb(c->writer,1u);cut_call(c,WASM_IMPORT_WRITE_END);cut_access_status(c);
    if(!wide)cut_mmx_publish(c,8u);
}
