#include <x86/semantics.h>
int pl_x86_vector_integer_float_lower(const pl_x86_instruction *i,pl_x86_vector_integer_float *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||i->visible_operand_count!=2u||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER
            |PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY;
    if(d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=64u||d->value.reg.class_id!=PL_X86_REGISTER_VECTOR
        ||d->value.reg.bits!=128u||d->value.reg.index>=16u||d->value.reg.flags||s->bits!=64u
        ||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_MMX
            ||s->value.reg.bits!=64u||s->value.reg.index>=8u||s->value.reg.flags))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory
        ||i->machine_argument!=(30u|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u)))return 0;
    *out=(pl_x86_vector_integer_float){(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),(pl_u8)d->value.reg.index};return 1;
}
