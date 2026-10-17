#include <x86/semantics.h>
int pl_x86_return_lower(const pl_x86_instruction *i,pl_x86_return *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_READS_MEMORY;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->operation!=PL_X86_OPERATION_RETURN
        ||i->flow!=PL_X86_FLOW_RETURN||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER))
        ||(i->operand_width!=16u&&i->operand_width!=32u&&i->operand_width!=64u))return 0;
    pl_u32 interrupt=i->machine_operation==PL_X86_MACHINE_INTERRUPT_RETURN,discard=0u;
    if(interrupt){if(i->opcode!=0xcfu||i->visible_operand_count||i->machine_argument!=i->operand_width)return 0;}
    else{
        if(i->machine_operation!=PL_X86_MACHINE_FAR_RETURN||(i->opcode!=0xcau&&i->opcode!=0xcbu)||i->machine_argument>65535u)return 0;
        if(i->opcode==0xcbu){if(i->visible_operand_count||i->machine_argument)return 0;}
        else{const pl_x86_operand *o=i->operands;
            if(i->visible_operand_count!=1u||o->kind!=PL_X86_OPERAND_IMMEDIATE||o->bits!=16u||o->value.immediate!=i->machine_argument)return 0;
            discard=(pl_u32)i->machine_argument;}
    }
    *out=(pl_x86_return){(pl_u8)(i->operand_width/8u),(pl_u8)interrupt,(pl_u16)discard};return 1;
}
