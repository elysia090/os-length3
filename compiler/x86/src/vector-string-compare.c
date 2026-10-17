#include <x86/semantics.h>
int pl_x86_vector_string_compare_lower(const pl_x86_instruction *i,pl_x86_vector_string_compare *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=PL_X86_VECTOR_STRING_COMPARE
        ||i->visible_operand_count!=3u||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u
        ||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->length
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED
            |PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u,*a=d+2u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY;
    if(i->opcode<0x60u||i->opcode>0x63u||d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=128u
        ||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags
        ||s->bits!=128u||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR
            ||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||a->kind!=PL_X86_OPERAND_IMMEDIATE||a->bits!=8u||a->value.immediate>255u
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u32 explicit_length=i->opcode<0x62u,index=i->opcode&1u,wide=(pl_u32)(i->machine_argument>>48u)&255u;
    if(wide>1u)return 0;
    pl_u64 expected=PL_X86_VECTOR_STRING_COMPARE|((pl_u64)d->value.reg.index<<8u)
        |((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u)
        |((a->value.immediate&127u)<<32u)|((pl_u64)explicit_length<<40u)|((pl_u64)index<<41u)|((pl_u64)wide<<48u);
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_vector_string_compare){(pl_u8)(a->value.immediate&127u),(pl_u8)explicit_length,(pl_u8)index,
        (pl_u8)(wide?8u:4u),(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index};return 1;
}
