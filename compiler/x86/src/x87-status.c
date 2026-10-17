#include <x86/semantics.h>
int pl_x86_x87_status_compare_lower(const pl_x86_instruction *i,pl_x86_x87_status_compare *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||(i->machine_argument&255u)!=11u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_WRITES_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    pl_u32 fop=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    if(i->visible_operand_count==1u&&i->operands[0].kind==PL_X86_OPERAND_MEMORY){
        pl_u32 width=i->operands[0].bits/8u,options=(pl_u32)(i->machine_argument>>36u),integer=(options&4u)!=0u,pop=options&1u;
        if(!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)||(options!=0u&&options!=1u&&options!=4u&&options!=5u)
            ||(integer?(i->operands[0].bits!=16u&&i->operands[0].bits!=32u):(i->operands[0].bits!=32u&&i->operands[0].bits!=64u)))return 0;
        pl_u32 high=integer?(width==2u?6u:2u):(width==4u?0u:4u);
        if((fop>>8u)!=high||((fop>>3u)&7u)!=(pop?3u:2u)||(fop&0xc0u)==0xc0u
            ||i->machine_argument!=(11u|((pl_u64)width<<8u)|((pl_u64)fop<<16u)|((pl_u64)options<<36u)))return 0;
        *out=(pl_x86_x87_status_compare){1u,(pl_u8)integer,(pl_u8)width,0u,1u,(pl_u8)pop,0u,(pl_u16)fop};return 1;
    }
    if(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)return 0;
    if(!i->visible_operand_count){
        if(fop==0x1e4u&&i->machine_argument==(11u|((pl_u64)fop<<16u)|(1ull<<44u))){
            *out=(pl_x86_x87_status_compare){0u,0u,0u,0u,1u,0u,1u,(pl_u16)fop};return 1;}
        pl_u32 quiet=fop==0x2e9u;
        if((fop!=0x6d9u&&!quiet)||i->machine_argument!=(11u|((pl_u64)fop<<16u)|(1ull<<32u)|((pl_u64)(1u|(quiet<<1u))<<36u)|(1ull<<40u)))return 0;
        *out=(pl_x86_x87_status_compare){0u,0u,0u,1u,(pl_u8)!quiet,2u,0u,(pl_u16)fop};return 1;
    }
    const pl_x86_operand *other=i->operands;
    if(i->visible_operand_count==2u){const pl_x86_operand *a=i->operands;
        if(a->kind!=PL_X86_OPERAND_REGISTER||a->bits!=80u||a->value.reg.class_id!=PL_X86_REGISTER_X87
            ||a->value.reg.index||a->value.reg.flags)return 0;
        ++other;
    }else if(i->visible_operand_count!=1u)return 0;
    if(other->kind!=PL_X86_OPERAND_REGISTER||other->bits!=80u||other->value.reg.class_id!=PL_X86_REGISTER_X87
        ||other->value.reg.index>=8u||other->value.reg.flags)return 0;
    pl_u32 options=(pl_u32)(i->machine_argument>>36u),pop=options&1u,quiet=(options>>1u)&1u;
    pl_u32 base=quiet?0x5e0u:0xd0u;
    if(!quiet&&(fop>>8u)==4u)base=0x4d0u;
    else if(!quiet&&(fop>>8u)==6u&&pop)base=0x6d0u; // DE /2 has single-pop comparison semantics.
    pl_u32 expected=base|((base==0x6d0u)?0u:(pop?8u:0u))|other->value.reg.index;
    if(options>3u||fop!=expected||i->machine_argument!=(11u|((pl_u64)fop<<16u)|((pl_u64)other->value.reg.index<<32u)|((pl_u64)options<<36u)))return 0;
    *out=(pl_x86_x87_status_compare){0u,0u,0u,other->value.reg.index,(pl_u8)!quiet,(pl_u8)pop,0u,(pl_u16)fop};return 1;
}
