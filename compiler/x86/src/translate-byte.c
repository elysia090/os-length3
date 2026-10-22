#include <x86/semantics.h>
const pl_x86_operand *pl_x86_translate_byte_memory(const pl_x86_instruction *i)
{
    if(!i||i->status!=PL_X86_DECODE_VALID||i->operation!=PL_X86_OPERATION_TRANSLATE_BYTE
        ||i->machine_operation!=PL_X86_MACHINE_NONE||i->machine_argument||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->flow!=PL_X86_FLOW_NEXT||i->opcode!=0xd7u||i->visible_operand_count||i->operand_count!=2u
        ||(i->address_width!=32u&&i->address_width!=64u)
        ||(i->flags&(PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_MAY_TRAP))
            !=(PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_MAY_TRAP)
        ||(i->flags&(PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *m=i->operands,*a=m+1u;const pl_x86_memory *address=&m->value.memory;
    if(m->kind!=PL_X86_OPERAND_MEMORY||m->bits!=8u||m->flags!=PL_X86_OPERAND_READ
        ||address->segment.class_id!=PL_X86_REGISTER_SEGMENT||address->segment.index>=6u
        ||address->base.class_id!=PL_X86_REGISTER_GPR||address->base.index!=3u||address->base.bits!=i->address_width||address->base.flags
        ||address->index.class_id!=PL_X86_REGISTER_NONE||address->scale||address->displacement
        ||a->kind!=PL_X86_OPERAND_REGISTER||a->bits!=8u||a->flags!=PL_X86_OPERAND_WRITE
        ||a->value.reg.class_id!=PL_X86_REGISTER_GPR||a->value.reg.index||a->value.reg.bits!=8u||a->value.reg.flags)return 0;
    return m;
}
