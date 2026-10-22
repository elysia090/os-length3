#include <x86/semantics.h>
int pl_x86_enter_lower(const pl_x86_instruction *i,pl_x86_enter *out)
{
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->operation!=PL_X86_OPERATION_ENTER||i->machine_operation!=PL_X86_MACHINE_NONE
        ||i->flow!=PL_X86_FLOW_NEXT||i->visible_operand_count!=2u||i->opcode!=0xc8u
        ||(i->operand_width!=16u&&i->operand_width!=64u)
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *a=i->operands,*n=a+1u;
    if(a->kind!=PL_X86_OPERAND_IMMEDIATE||n->kind!=PL_X86_OPERAND_IMMEDIATE||a->bits!=16u||n->bits!=8u
        ||a->value.immediate>65535u||n->value.immediate>255u
        ||a->flags!=(PL_X86_OPERAND_READ|PL_X86_OPERAND_EXPLICIT)||n->flags!=(PL_X86_OPERAND_READ|PL_X86_OPERAND_EXPLICIT))return 0;
    pl_u32 level=(pl_u32)n->value.immediate&31u;
    *out=(pl_x86_enter){(pl_u16)a->value.immediate,(pl_u8)(i->operand_width/8u),(pl_u8)level,
        (pl_u16)(level?2u*level+1u:2u)};return 1;
}
int pl_x86_enter_step(const pl_x86_enter *e,pl_u32 rank,pl_x86_enter_step_info *out)
{
    if(!e||!out||(e->bytes!=2u&&e->bytes!=8u)||e->level>31u||e->steps!=(e->level?2u*e->level+1u:2u)||rank>=e->steps)return 0;
    pl_x86_enter_step_info step={0};
    if(!rank)step=(pl_x86_enter_step_info){PL_X86_ENTER_OLD_BASE,e->bytes};
    else if(rank+1u==e->steps)step=(pl_x86_enter_step_info){PL_X86_ENTER_PROBE,
        (pl_u32)e->allocation+e->bytes*(e->level?e->level+1u:1u)};
    else if(rank==e->steps-2u)step=(pl_x86_enter_step_info){PL_X86_ENTER_FRAME,e->bytes*(e->level+1u)};
    else{pl_u32 k=(rank+1u)/2u;step=(pl_x86_enter_step_info){rank&1u?PL_X86_ENTER_READ:PL_X86_ENTER_COPY,e->bytes*(rank&1u?k:k+1u)};}
    *out=step;return 1;
}
