/* Packed integer conversion is one exact lane/extent relation. */
#include <x86/semantics.h>
int pl_x86_vector_widen_lower(const pl_x86_instruction *i,pl_x86_vector_widen *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=PL_X86_VECTOR_INTEGER_WIDEN
        ||i->visible_operand_count!=2u||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u
        ||i->source_bytes!=i->length||i->fallthrough-i->rip!=i->length
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY;
    pl_u32 from=(pl_u32)(i->machine_argument>>32u)&255u,to=(pl_u32)(i->machine_argument>>40u)&255u,sign=(pl_u32)(i->machine_argument>>48u)&1u;
    if((from!=1u&&from!=2u&&from!=4u)||(to!=2u&&to!=4u&&to!=8u)||from>=to)return 0;
    pl_u32 extent=16u/to*from,shape=from==1u?(to==2u?0u:to==4u?1u:2u):from==2u?(to==4u?3u:4u):5u;
    if(i->opcode!=0x20u+shape+(sign?0u:16u)||d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=128u
        ||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.flags||d->value.reg.index>=16u
        ||s->bits!=extent*8u||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR
            ||s->value.reg.bits!=128u||s->value.reg.flags||s->value.reg.index>=16u))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u64 descriptor=PL_X86_VECTOR_INTEGER_WIDEN|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)
        |((pl_u64)memory<<24u)|((pl_u64)from<<32u)|((pl_u64)to<<40u)|((pl_u64)sign<<48u);
    if(i->machine_argument!=descriptor)return 0;
    *out=(pl_x86_vector_widen){(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index,
        (pl_u8)from,(pl_u8)to,(pl_u8)sign,(pl_u8)extent};return 1;
}
