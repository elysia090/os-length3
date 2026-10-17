#include <x86/semantics.h>
int pl_x86_far_transfer_lower(const pl_x86_instruction *i,pl_x86_far_transfer *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_READS_MEMORY;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->machine_operation!=PL_X86_MACHINE_FAR_TRANSFER
        ||i->visible_operand_count!=1u||i->operands[0].kind!=PL_X86_OPERAND_MEMORY||(i->flags&required)!=required||i->opcode!=0xffu
        ||(i->flow!=PL_X86_FLOW_CALL&&i->flow!=PL_X86_FLOW_JUMP)||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    pl_u32 bits=i->operands[0].bits,call=i->flow==PL_X86_FLOW_CALL;
    if((bits!=32u&&bits!=48u&&bits!=80u)||i->machine_argument!=(call|((pl_u64)bits<<8u)))return 0;
    *out=(pl_x86_far_transfer){(pl_u8)(bits/8u-2u),(pl_u8)call};return 1;
}
