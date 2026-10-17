#include <x86/semantics.h>
int pl_x86_vector_lane_lower(const pl_x86_instruction *i,pl_x86_vector_lane *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||i->visible_operand_count!=3u||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,insert=kind==PL_X86_VECTOR_INSERT_LANE,bytes=(pl_u32)(i->machine_argument>>40u)&255u;
    if((!insert&&kind!=PL_X86_VECTOR_EXTRACT_LANE)||(bytes!=1u&&bytes!=2u&&bytes!=4u&&bytes!=8u))return 0;
    const pl_x86_operand *v=i->operands+(insert?0u:1u),*g=i->operands+(insert?1u:0u),*a=i->operands+2u;
    pl_u32 memory=g->kind==PL_X86_OPERAND_MEMORY;
    if(v->kind!=PL_X86_OPERAND_REGISTER||v->bits!=128u||v->value.reg.class_id!=PL_X86_REGISTER_VECTOR
        ||v->value.reg.bits!=128u||v->value.reg.index>=16u||v->value.reg.flags
        ||(memory?g->bits!=bytes*8u:g->kind!=PL_X86_OPERAND_REGISTER||g->value.reg.class_id!=PL_X86_REGISTER_GPR
            ||(g->bits!=(bytes==8u?64u:32u)&&g->bits!=64u)||g->value.reg.bits!=g->bits||g->value.reg.index>=16u||g->value.reg.flags)
        ||a->kind!=PL_X86_OPERAND_IMMEDIATE||a->bits!=8u||a->value.immediate>255u
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=(memory&&insert)
        ||!!(i->flags&PL_X86_INSTRUCTION_WRITES_MEMORY)!=(memory&&!insert))return 0;
    pl_u32 selected=(pl_u32)a->value.immediate&(16u/bytes-1u);
    pl_u64 expected=kind|((pl_u64)(insert?v->value.reg.index:memory?0u:g->value.reg.index)<<8u)
        |((pl_u64)(insert?(memory?0u:g->value.reg.index):v->value.reg.index)<<16u)
        |((pl_u64)(memory&&insert)<<24u)|((pl_u64)(memory&&!insert)<<25u)|((pl_u64)selected<<32u)|((pl_u64)bytes<<40u);
    if(i->machine_argument!=expected)return 0;
    pl_u32 opcode=insert?bytes==1u?0x20u:bytes==2u?0xc4u:0x22u:bytes==1u?0x14u:bytes==2u?0x15u:0x16u;
    if(i->opcode!=opcode&&!(bytes==4u&&!insert&&i->opcode==0x17u))return 0;
    *out=(pl_x86_vector_lane){(pl_u8)insert,(pl_u8)memory,(pl_u8)bytes,(pl_u8)selected,v->value.reg.index,(pl_u8)(memory?0u:g->value.reg.index)};return 1;
}
static int lane(const pl_x86_operand *o,pl_u32 bits)
{
    return o->kind==PL_X86_OPERAND_REGISTER&&o->value.reg.class_id==PL_X86_REGISTER_VECTOR&&o->value.reg.bits==128u
        &&o->value.reg.index<16u&&!o->value.reg.flags&&(o->bits==bits||o->bits==128u);
}
int pl_x86_vector_signmask_lower(const pl_x86_instruction *i,pl_x86_vector_signmask *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->visible_operand_count!=2u||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u
        ||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->length
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,mmx=i->machine_operation==PL_X86_MACHINE_X87;
    pl_u32 width=mmx?64u:128u,cls=mmx?PL_X86_REGISTER_MMX:PL_X86_REGISTER_VECTOR;
    if((mmx?kind!=55u:i->machine_operation!=PL_X86_MACHINE_VECTOR||(kind!=PL_X86_VECTOR_BYTE_SIGN_MASK&&kind!=41u))
        ||d->kind!=PL_X86_OPERAND_REGISTER||(d->bits!=32u&&d->bits!=64u)||d->value.reg.class_id!=PL_X86_REGISTER_GPR||d->value.reg.bits!=d->bits||d->value.reg.index>=16u||d->value.reg.flags
        ||s->kind!=PL_X86_OPERAND_REGISTER||s->bits!=width||s->value.reg.bits!=width||s->value.reg.class_id!=cls||s->value.reg.index>=(mmx?8u:16u)||s->value.reg.flags)return 0;
    pl_u32 bytes=mmx||kind==PL_X86_VECTOR_BYTE_SIGN_MASK?1u:(i->machine_argument>>32u)&1u?8u:4u;
    pl_u64 expected=mmx?55u|((pl_u64)s->value.reg.index<<32u)|((pl_u64)d->value.reg.index<<44u)
        :kind|((pl_u64)d->value.reg.index<<8u)|((pl_u64)s->value.reg.index<<16u)|(kind==41u?(pl_u64)(bytes==8u)<<32u:0u);
    if(i->machine_argument!=expected||i->opcode!=(bytes==1u?0xd7u:0x50u))return 0;
    *out=(pl_x86_vector_signmask){(pl_u8)bytes,(pl_u8)mmx,s->value.reg.index,d->value.reg.index};return 1;
}
int pl_x86_vector_extract_lower(const pl_x86_instruction *i,pl_x86_vector_extract *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=22u||i->opcode!=0xc5u||i->visible_operand_count!=3u
        ||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u||i->source_bytes!=i->length||i->fallthrough-i->rip!=i->length
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u,*c=d+2u;pl_u32 mmx=s->value.reg.class_id==PL_X86_REGISTER_MMX,width=mmx?64u:128u;
    if(d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=32u||d->value.reg.class_id!=PL_X86_REGISTER_GPR||d->value.reg.bits!=32u||d->value.reg.index>=16u||d->value.reg.flags
        ||s->kind!=PL_X86_OPERAND_REGISTER||s->bits!=width||s->value.reg.bits!=width||s->value.reg.flags||s->value.reg.index>=(mmx?8u:16u)
        ||(!mmx&&s->value.reg.class_id!=PL_X86_REGISTER_VECTOR)||c->kind!=PL_X86_OPERAND_IMMEDIATE||c->bits!=8u||c->value.immediate>255u)return 0;
    pl_u32 word=(pl_u32)c->value.immediate&(mmx?3u:7u);
    if(i->machine_argument!=(22u|((pl_u64)d->value.reg.index<<8u)|((pl_u64)s->value.reg.index<<16u)|((pl_u64)(word|(mmx<<3u))<<32u)))return 0;
    *out=(pl_x86_vector_extract){s->value.reg.index,d->value.reg.index,(pl_u8)word,(pl_u8)mmx};return 1;
}
int pl_x86_scalar_vector_transfer_lower(const pl_x86_instruction *i,pl_x86_scalar_vector_transfer *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||((i->machine_argument&255u)!=39u&&(i->machine_argument&255u)!=PL_X86_VECTOR_MOVE_LANE)||i->visible_operand_count!=2u
        ||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u||i->source_bytes!=i->length||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 read=s->kind==PL_X86_OPERAND_MEMORY,write=d->kind==PL_X86_OPERAND_MEMORY,op=(pl_u32)(i->machine_argument>>32u);
    if((i->machine_argument&255u)==PL_X86_VECTOR_MOVE_LANE){
        if(op>1u||read||write||!lane(d,64u)||!lane(s,64u)||i->opcode!=(op?0x16u:0x12u)
            ||(i->flags&(PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY))
            ||i->machine_argument!=(PL_X86_VECTOR_MOVE_LANE|((pl_u64)d->value.reg.index<<8u)|((pl_u64)s->value.reg.index<<16u)|((pl_u64)op<<32u)))return 0;
        *out=(pl_x86_scalar_vector_transfer){8u,0u,0u,s->value.reg.index,d->value.reg.index,0u,0u,(pl_u8)(op?0u:8u),(pl_u8)(op?8u:0u)};return 1;
    }
    if((op!=0u&&op!=1u&&op!=3u)||(read&&write)||(op==3u&&(read||write)))return 0;
    pl_u32 bits=op?64u:32u;
    if((read?s->bits!=bits:!lane(s,bits))||(write?d->bits!=bits:!lane(d,bits))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=read||!!(i->flags&PL_X86_INSTRUCTION_WRITES_MEMORY)!=write
        ||(op==3u?(i->opcode!=0x7eu&&i->opcode!=0xd6u):(i->opcode!=0x10u&&i->opcode!=0x11u))
        ||i->machine_argument!=(39u|((pl_u64)(write?0u:d->value.reg.index)<<8u)|((pl_u64)(read?0u:s->value.reg.index)<<16u)
            |((pl_u64)read<<24u)|((pl_u64)write<<25u)|((pl_u64)op<<32u)))return 0;
    *out=(pl_x86_scalar_vector_transfer){(pl_u8)(bits/8u),(pl_u8)read,(pl_u8)write,(pl_u8)(read?0u:s->value.reg.index),
        (pl_u8)(write?0u:d->value.reg.index),(pl_u8)(read||op==3u),(pl_u8)(!read&&!write&&s->value.reg.index==d->value.reg.index),0u,0u};return 1;
}
