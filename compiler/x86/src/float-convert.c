#include <x86/semantics.h>
int pl_x86_float_convert_lower(const pl_x86_instruction *i,pl_x86_float_convert *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||i->visible_operand_count!=2u||i->opcode!=0x5au
        ||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes
        ||i->fallthrough-i->rip!=i->length||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,scalar=kind==PL_X86_VECTOR_SCALAR_FLOAT;
    if(!scalar&&kind!=31u&&kind!=PL_X86_VECTOR_FLOAT_NARROW)return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;
    pl_u32 source_bytes=scalar?s->bits/8u:kind==31u?4u:8u,target_bytes=12u-source_bytes,memory=s->kind==PL_X86_OPERAND_MEMORY;
    if((source_bytes!=4u&&source_bytes!=8u)||d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=(scalar?target_bytes*8u:128u)
        ||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags
        ||s->bits!=source_bytes*8u*(scalar?1u:2u)||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER
            ||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u64 expected=kind|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u);
    if(scalar)expected|=((pl_u64)(source_bytes==4u?PL_X86_SCALAR_FLOAT_WIDEN:PL_X86_SCALAR_FLOAT_NARROW)<<32u)
        |((pl_u64)target_bytes<<40u)|((pl_u64)source_bytes<<48u);
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_float_convert){(pl_u8)source_bytes,(pl_u8)target_bytes,(pl_u8)(scalar?1u:2u),(pl_u8)(!scalar&&target_bytes==4u),
        (pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index};return 1;
}
