#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_selector_query_lower(const pl_x86_instruction *i,pl_x86_selector_query *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)
        ||i->machine_operation!=PL_X86_MACHINE_SYSTEM_SELECTOR||i->visible_operand_count!=2u||(i->flags&required)!=required
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_WRITES_MEMORY)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY,limit=(pl_u32)i->machine_argument&255u;
    if(limit>1u||i->opcode!=(limit?3u:2u)||d->kind!=PL_X86_OPERAND_REGISTER
        ||(d->bits!=16u&&d->bits!=32u&&d->bits!=64u)||d->value.reg.class_id!=PL_X86_REGISTER_GPR||d->value.reg.bits!=d->bits
        ||d->value.reg.index>=16u||d->value.reg.flags||(memory?s->bits!=16u:
        s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_GPR||s->value.reg.index>=16u||s->value.reg.flags
            ||s->value.reg.bits!=s->bits||(s->bits!=16u&&s->bits!=32u&&s->bits!=64u))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory
        ||i->machine_argument!=(limit|((pl_u64)memory<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)
            |((pl_u64)d->value.reg.index<<24u)|((pl_u64)d->bits<<32u)))return 0;
    *out=(pl_x86_selector_query){(pl_u8)limit,(pl_u8)(d->bits/8u),(pl_u8)memory,(pl_u8)(memory?0u:s->value.reg.index),d->value.reg.index};return 1;
}
int pl_x86_selector_query_plan(pl_u32 limit,pl_u32 bits,pl_arena *arena,pl_plan *out)
{
    if(limit>1u||(bits!=16u&&bits!=32u&&bits!=64u)||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,80u,320u,0u,5u))return PL_ERROR_ARENA;
    pl_operand d={PL_OPERAND_LOCAL,0u},available={PL_OPERAND_LOCAL,1u},cpl={PL_OPERAND_LOCAL,2u},selector={PL_OPERAND_LOCAL,3u};
    pl_operand access=shift(&e,d,40u);access=bit_and(&e,access,constant(255u));
    pl_operand type=bit_and(&e,access,constant(15u)),segment=shift(&e,access,4u);segment=bit_and(&e,segment,constant(1u));
    pl_operand system=binary(&e,PL_OPCODE_LANE64_SHR,constant(limit?0x0a04u:0x1a04u),type);system=bit_and(&e,system,constant(1u));
    pl_operand type_ok=bit_or(&e,segment,system),conforming=bit_and(&e,type,constant(12u));conforming=equal(&e,conforming,constant(12u));conforming=bit_and(&e,conforming,segment);
    pl_operand dpl=shift(&e,access,5u);dpl=bit_and(&e,dpl,constant(3u));cpl=bit_and(&e,cpl,constant(3u));
    pl_operand rpl=bit_and(&e,selector,constant(3u)),cpl_bad=compare(&e,dpl,cpl,2u),rpl_bad=compare(&e,dpl,rpl,2u);
    pl_operand invisible=bit_or(&e,cpl_bad,rpl_bad),visible=not(&e,invisible);visible=bit_or(&e,visible,conforming);
    pl_operand valid=bit_and(&e,type_ok,visible);valid=bit_and(&e,valid,available);
    pl_operand result;
    if(limit){pl_operand high=shift(&e,d,32u);high=bit_and(&e,high,constant(0xf0000u));result=bit_and(&e,d,constant(65535u));result=bit_or(&e,result,high);
        pl_operand g=shift(&e,d,55u);g=bit_and(&e,g,constant(1u));pl_operand distance=select(&e,constant(12u),constant(0u),g);
        result=binary(&e,PL_OPCODE_LANE64_SHL,result,distance);pl_operand tail=select(&e,constant(4095u),constant(0u),g);result=bit_or(&e,result,tail);
    }else{result=shift(&e,d,32u);result=bit_and(&e,result,constant(0x00f0ff00u));}
    pl_operand parent={PL_OPERAND_LOCAL,4u};
    if(bits==16u){pl_operand high=bit_and(&e,parent,constant(~65535ull));result=bit_and(&e,result,constant(65535u));result=bit_or(&e,high,result);}
    // Failed32-bit writes preserve all64 old bits. Select after narrowing,
    // not before it; this removes the control branch without zeroing failure.
    result=select(&e,result,parent,valid);
    raw.locals[0]=result;raw.locals[1]=valid;for(pl_u32 n=2u;n<5u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,0u,0u,0u};int status=pl_compact_projected(&raw,live,arena,out);
    return status?status:out->node_count>PL_X86_SELECTOR_QUERY_MAX_NODES?PL_ERROR_PLAN:0;
}
