#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_exchange_lower(const pl_x86_instruction *i,pl_x86_x87_exchange *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->machine_operation!=PL_X86_MACHINE_X87
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_LOCKED
            |PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER))
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes)return 0;
    const pl_x86_operand *o=i->operands;
    if(i->visible_operand_count==2u){
        if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||o->value.reg.class_id!=PL_X86_REGISTER_X87
            ||o->value.reg.index||o->value.reg.bits!=80u||o->value.reg.flags)return 0;
        ++o;
    }else if(i->visible_operand_count!=1u)return 0;
    if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||o->value.reg.class_id!=PL_X86_REGISTER_X87
        ||o->value.reg.bits!=80u||o->value.reg.index>=8u||o->value.reg.flags)return 0;
    pl_u32 op=(pl_u32)(i->machine_argument>>16u)&0x7ffu,primary=op>>8u;
    if((primary!=1u&&primary!=5u&&primary!=7u)||i->opcode!=0xd8u+primary||(op&255u)!=(0xc8u|o->value.reg.index)
        ||i->machine_argument!=(21u|((pl_u64)op<<16u)|((pl_u64)o->value.reg.index<<32u)))return 0;
    *out=(pl_x86_x87_exchange){(pl_u8)o->value.reg.index,(pl_u16)op};return 1;
}
int pl_x86_x87_exchange_plan(pl_u32 alias,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||alias>1u)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,32u,96u,0u,6u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},sa={PL_OPERAND_LOCAL,1u},b=alias?a:(pl_operand){PL_OPERAND_LOCAL,2u},
        sb=alias?sa:(pl_operand){PL_OPERAND_LOCAL,3u},cw={PL_OPERAND_LOCAL,4u},empty={PL_OPERAND_LOCAL,5u};
    pl_operand ea=bit_and(&e,empty,constant(1u)),eb=alias?ea:shift(&e,empty,1u),zero=equal(&e,empty,constant(0u)),fault=not(&e,zero);
    pl_operand sig_a=select(&e,constant(0xc000000000000000ull),b,eb),se_a=select(&e,constant(0xffffu),sb,eb),
        sig_b=select(&e,constant(0xc000000000000000ull),a,ea),se_b=select(&e,constant(0xffffu),sa,ea);
    pl_operand raised=select(&e,constant(0x41u),constant(0u),fault),im=bit_and(&e,cw,constant(1u)),unmask=not(&e,im),suppress=bit_and(&e,fault,unmask);
    raw.locals[0]=raised;raw.locals[1]=suppress;raw.locals[2]=sig_a;raw.locals[3]=se_a;raw.locals[4]=sig_b;raw.locals[5]=se_b;
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,1u,(pl_u8)!alias,(pl_u8)!alias};return pl_compact_projected(&raw,live,arena,out);
}
