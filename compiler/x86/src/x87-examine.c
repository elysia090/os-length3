#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_examine_supported(const pl_x86_instruction *i)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    return i&&i->status==PL_X86_DECODE_VALID&&i->encoding==PL_X86_ENCODING_LEGACY
        &&i->machine_operation==PL_X86_MACHINE_X87&&i->machine_argument==(56u|(0x1e5ull<<16u))&&i->opcode==0xd9u
        &&!i->visible_operand_count&&(i->flow==PL_X86_FLOW_NEXT||i->flow==PL_X86_FLOW_SYSTEM)
        &&(i->flags&required)==required&&!(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER))
        &&i->source_bytes&&i->source_bytes<=15u&&i->source_bytes==i->length&&i->fallthrough-i->rip==i->length;
}
int pl_x86_x87_examine_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,64u,192u,0u,4u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},sw={PL_OPERAND_LOCAL,2u},empty={PL_OPERAND_LOCAL,3u};
    pl_operand exponent=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,exponent,constant(0u)),full_exp=equal(&e,exponent,constant(32767u));
    pl_operand j=shift(&e,sig,63u),fraction=bit_and(&e,sig,constant(0x7fffffffffffffffull)),zero_fraction=equal(&e,fraction,constant(0u));
    pl_operand zero_sig=equal(&e,sig,constant(0u)),code=select(&e,constant(0x4000u),constant(0x4400u),zero_sig);
    pl_operand normal=select(&e,constant(0x0400u),constant(0u),j);
    pl_operand special=select(&e,constant(0x0500u),constant(0x0100u),zero_fraction);special=select(&e,special,constant(0u),j);
    normal=select(&e,special,normal,full_exp);code=select(&e,code,normal,zero_exp);code=select(&e,constant(0x4100u),code,empty);
    pl_operand sign=bit_and(&e,se,constant(32768u));sign=shift(&e,sign,6u);code=bit_or(&e,code,sign);
    sw=bit_and(&e,sw,constant(0xb8ffu));sw=bit_or(&e,sw,code);raw.locals[0]=sw;
    for(pl_u32 n=1u;n<4u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
