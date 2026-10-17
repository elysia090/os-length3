#include <x86/semantics.h>
int pl_x86_float_dot_lower(const pl_x86_instruction *i,pl_x86_float_dot *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=PL_X86_VECTOR_FLOAT_DOT
        ||i->visible_operand_count!=3u||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u
        ||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->length||(i->flags&(PL_X86_INSTRUCTION_LOCKED
            |PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u,*a=d+2u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY;
    pl_u32 bytes=(pl_u32)(i->machine_argument>>40u)&255u;
    if((bytes!=4u&&bytes!=8u)||i->opcode!=(bytes==4u?0x40u:0x41u)||d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=128u
        ||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags
        ||s->bits!=128u||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR
            ||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||a->kind!=PL_X86_OPERAND_IMMEDIATE||a->bits!=8u||a->value.immediate>255u
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u32 control=(pl_u32)a->value.immediate&(bytes==8u?0x33u:255u);
    if(i->machine_argument!=(PL_X86_VECTOR_FLOAT_DOT|((pl_u64)d->value.reg.index<<8u)
        |((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u)|((pl_u64)control<<32u)|((pl_u64)bytes<<40u)))return 0;
    *out=(pl_x86_float_dot){(pl_u8)bytes,(pl_u8)control,(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index};return 1;
}
int pl_x86_float_arithmetic_candidate(const pl_x86_instruction *i)
{
    if(!i||i->machine_operation!=PL_X86_MACHINE_VECTOR)return 0;
    pl_u32 k=(pl_u32)i->machine_argument&255u;
    return k==20u||k==34u||k==35u||k==36u||k==26u||k==PL_X86_VECTOR_PACKED_FLOAT64||k==PL_X86_VECTOR_FLOAT_PAIRWISE
        ||(k==PL_X86_VECTOR_SCALAR_FLOAT&&((i->machine_argument>>32u)&255u)<=PL_X86_SCALAR_FLOAT_MAXIMUM);
}
int pl_x86_float_arithmetic_lower(const pl_x86_instruction *i,pl_x86_float_arithmetic *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!out||!pl_x86_float_arithmetic_candidate(i)||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->flow!=PL_X86_FLOW_NEXT||i->visible_operand_count!=2u||(i->flags&required)!=required
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->length
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    pl_u32 k=(pl_u32)i->machine_argument&255u,scalar=k==PL_X86_VECTOR_SCALAR_FLOAT,pairwise=k==PL_X86_VECTOR_FLOAT_PAIRWISE;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY;
    pl_u32 bytes=pairwise?(pl_u32)(i->machine_argument>>40u)&255u:scalar?d->bits/8u:k==PL_X86_VECTOR_PACKED_FLOAT64||(k==26u&&(i->machine_argument&(2ull<<32u)))?8u:4u;
    pl_u32 operation=scalar||pairwise||k==PL_X86_VECTOR_PACKED_FLOAT64?(pl_u32)(i->machine_argument>>32u)&255u:k==26u?4u+((pl_u32)(i->machine_argument>>32u)&1u):k==20u?0u:k==34u?1u:k==35u?2u:3u;
    pl_u32 width=scalar?bytes*8u:128u;
    if((bytes!=4u&&bytes!=8u)||(pairwise?(operation<6u||operation>8u):operation>5u)||d->bits!=width||s->bits!=width
        ||d->kind!=PL_X86_OPERAND_REGISTER||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags
        ||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory||i->opcode!=(operation==6u?0x7cu:operation==7u?0x7du:operation==8u?0xd0u:operation==0u?0x58u:operation==1u?0x59u:operation==2u?0x5cu:operation==3u?0x5eu:operation==4u?0x5du:0x5fu))return 0;
    pl_u64 expected=k|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u);
    if(scalar)expected|=((pl_u64)operation<<32u)|((pl_u64)bytes<<40u)|((pl_u64)bytes<<48u);
    else if(pairwise)expected|=((pl_u64)operation<<32u)|((pl_u64)bytes<<40u);
    else if(k==PL_X86_VECTOR_PACKED_FLOAT64)expected|=(pl_u64)operation<<32u;
    else if(k==26u)expected|=(pl_u64)((operation-4u)|(bytes==8u?2u:0u))<<32u;
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_float_arithmetic){(pl_u8)bytes,(pl_u8)(scalar?1u:16u/bytes),(pl_u8)operation,(pl_u8)memory,
        (pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index};return 1;
}
