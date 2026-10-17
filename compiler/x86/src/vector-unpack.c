#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_vector_unpack_candidate(const pl_x86_instruction *i)
{
    if(!i)return 0;
    pl_u32 narrow=i->machine_operation==PL_X86_MACHINE_X87;
    if(narrow?((i->machine_argument&255u)!=37u):(i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=10u))return 0;
    switch((pl_u32)(i->machine_argument>>(narrow?40u:32u))&255u){
    case 39u:case 29u:case 18u:case 22u:case 13u:case 20u:case 37u:case 38u:case 19u:return 1;
    default:return 0;}
}
int pl_x86_vector_unpack_lower(const pl_x86_instruction *i,pl_x86_vector_unpack *out)
{
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->visible_operand_count!=2u||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY)))return 0;
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if((i->flags&required)!=required)return 0;
    pl_u32 narrow=i->machine_operation==PL_X86_MACHINE_X87;
    if(narrow?((i->machine_argument&255u)!=37u):(i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=10u))return 0;
    pl_u32 operation=(pl_u32)(i->machine_argument>>(narrow?40u:32u)),bits,high=0u,opcode;
    switch(operation){case 39u:bits=8u;opcode=0x60u;break;case 29u:bits=16u;opcode=0x61u;break;case 18u:bits=32u;opcode=0x62u;break;
    case 22u:bits=64u;opcode=0x6cu;break;case 13u:bits=8u;high=1u;opcode=0x68u;break;case 20u:bits=16u;high=1u;opcode=0x69u;break;
    case 37u:bits=32u;high=1u;opcode=0x15u;break;case 38u:bits=32u;high=1u;opcode=0x6au;break;
    case 19u:bits=64u;high=1u;opcode=0x6du;break;default:return 0;}
    if(!narrow&&bits>=32u&&(i->opcode==0x14u||i->opcode==0x15u)){opcode=i->opcode;}
    if(narrow&&(bits==64u||operation==37u))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY,cls=narrow?PL_X86_REGISTER_MMX:PL_X86_REGISTER_VECTOR,width=narrow?64u:128u;
    pl_u32 source_bytes=narrow&&!high?4u:narrow?8u:16u;
    if(d->kind!=PL_X86_OPERAND_REGISTER||d->bits!=width||d->value.reg.class_id!=cls||d->value.reg.bits!=width||d->value.reg.flags||d->value.reg.index>=(narrow?8u:16u)
        ||(memory?s->bits!=source_bytes*8u:s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=cls||s->value.reg.bits!=width||s->value.reg.flags
            ||s->value.reg.index>=(narrow?8u:16u)||(s->bits!=width&&s->bits!=(narrow?32u:64u)))
        ||i->opcode!=opcode||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;
    pl_u64 expected;
    if(narrow)expected=37u|((pl_u64)(memory?source_bytes:0u)<<8u)|(i->machine_argument&(0x7ffull<<16u))
        |((pl_u64)(memory?0u:s->value.reg.index)<<32u)|((pl_u64)d->value.reg.index<<36u)|((pl_u64)operation<<40u);
    else expected=10u|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u)|((pl_u64)memory<<26u)|((pl_u64)operation<<32u);
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_vector_unpack){(pl_u8)(width/8u),(pl_u8)bits,(pl_u8)high,(pl_u8)memory,(pl_u8)source_bytes,
        (pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index,(pl_u8)(!memory&&d->value.reg.index==s->value.reg.index)};return 1;
}
static pl_operand spread_word(expression *e,pl_operand word,pl_u32 bits)
{
    word=bit_and(e,word,constant(0xffffffffu));
    for(pl_u32 n=16u;n>=bits;n>>=1u){pl_operand moved=binary(e,PL_OPCODE_LANE64_SHL,word,constant(n));word=bit_or(e,word,moved);
        word=bit_and(e,word,constant(n==16u?0x0000ffff0000ffffull:0x00ff00ff00ff00ffull));}
    return word;
}
int pl_x86_vector_unpack_plan(pl_u32 bits,pl_u32 alias,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits!=8u&&bits!=16u&&bits!=32u)||alias>1u)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,32u,96u,0u,2u))return PL_ERROR_ARENA;
    pl_operand a=spread_word(&e,(pl_operand){PL_OPERAND_LOCAL,0u},bits),b=alias?a:spread_word(&e,(pl_operand){PL_OPERAND_LOCAL,1u},bits);
    pl_operand value;
    if(alias)value=binary(&e,PL_OPCODE_MULR,a,constant((1ull<<bits)+1u));
    else{b=binary(&e,PL_OPCODE_LANE64_SHL,b,constant(bits));value=bit_or(&e,a,b);}
    raw.locals[0]=value;raw.locals[1]=(pl_operand){PL_OPERAND_LOCAL,1u};if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,0u};return pl_compact_projected(&raw,live,arena,out);
}
