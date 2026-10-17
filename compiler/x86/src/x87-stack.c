#include <x86/semantics.h>
#include "x87-expression.h"
int pl_x86_x87_stack_lower(const pl_x86_instruction *i,pl_x86_x87_stack *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||(i->flags&required)!=required
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)
        ||(i->flags&(PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_LOCKED
            |PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER))
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes)return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,op=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    if(kind==22u){
        if(i->visible_operand_count!=1u)return 0;
        const pl_x86_operand *o=i->operands;pl_u32 pop=(pl_u32)(i->machine_argument>>40u)&1u;
        if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||o->value.reg.class_id!=PL_X86_REGISTER_X87
            ||o->value.reg.bits!=80u||o->value.reg.index>=8u||o->value.reg.flags
            ||i->opcode!=(pop?0xdfu:0xddu)||op!=((pop?7u:5u)<<8u|0xc0u|o->value.reg.index)
            ||i->machine_argument!=(22u|((pl_u64)op<<16u)|((pl_u64)o->value.reg.index<<32u)|((pl_u64)pop<<40u)))return 0;
        *out=(pl_x86_x87_stack){1u,(pl_u8)o->value.reg.index,(pl_u8)pop};return 1;
    }
    if(kind==43u){pl_u32 inc=(pl_u32)(i->machine_argument>>32u)&1u;
        if(i->visible_operand_count||i->opcode!=0xd9u||op!=(inc?0x1f7u:0x1f6u)
            ||i->machine_argument!=(43u|((pl_u64)op<<16u)|((pl_u64)inc<<32u)))return 0;
        *out=(pl_x86_x87_stack){0u,0u,(pl_u8)(inc?1u:7u)};return 1;
    }
    return 0;
}
int pl_x86_x87_stack_plan(const pl_x86_x87_stack *law,pl_arena *arena,pl_plan *out)
{
    if(!law||!arena||!out||law->free_register>1u||law->source>=8u
        ||(law->free_register?law->step>1u:(law->source||!(law->step==1u||law->step==7u))))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,32u,96u,0u,5u))return PL_ERROR_ARENA;
    pl_operand sw={PL_OPERAND_LOCAL,0u},tag={PL_OPERAND_LOCAL,1u};
    if(law->free_register){
        /* 2*((TOP+i)&7) = ((SW>>10)+2*i)&14. C2 is the discarded low
         * bit; no numeric lane or separate TOP value is materialized. */
        pl_operand coordinate=shift(&e,sw,10u),index=coordinate;
        if(law->source)index=binary(&e,89u,index,constant(2u*law->source));
        index=bit_and(&e,index,constant(14u));
        pl_operand empty=binary(&e,PL_OPCODE_LANE64_SHL,constant(3u),index);tag=bit_or(&e,tag,empty);
        if(law->step){pl_operand shift_top=bit_and(&e,coordinate,constant(14u));
            empty=binary(&e,PL_OPCODE_LANE64_SHL,constant(3u),shift_top);tag=bit_or(&e,tag,empty);}
    }
    if(law->step){
        /* Advance only the packed TOP field. Masking the addition before
         * merging prevents a TOP wrap from changing C3. */
        pl_operand top=binary(&e,89u,sw,constant((pl_u64)law->step<<11u));top=bit_and(&e,top,constant(0x3800u));
        sw=bit_and(&e,sw,constant(0xc5ffu));sw=bit_or(&e,sw,top);
    }else sw=bit_and(&e,sw,constant(0xfdffu));
    raw.locals[0]=sw;raw.locals[1]=tag;
    for(pl_u32 i=2u;i<5u;++i)raw.locals[i]=(pl_operand){PL_OPERAND_LOCAL,i};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
