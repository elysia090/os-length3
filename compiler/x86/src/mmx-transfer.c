#include <x86/semantics.h>
static int mmx(const pl_x86_operand *o)
{return o->kind==PL_X86_OPERAND_REGISTER&&o->value.reg.class_id==PL_X86_REGISTER_MMX&&o->value.reg.index<8u
    &&o->value.reg.bits==64u&&!o->value.reg.flags&&(o->bits==32u||o->bits==64u);}
static int general(const pl_x86_operand *o,pl_u32 bits)
{return o->kind==PL_X86_OPERAND_REGISTER&&o->value.reg.class_id==PL_X86_REGISTER_GPR&&o->value.reg.index<16u
    &&o->bits==bits&&o->value.reg.bits==bits&&!o->value.reg.flags;}
int pl_x86_mmx_transfer_lower(const pl_x86_instruction *i,pl_x86_mmx_transfer *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->machine_operation!=PL_X86_MACHINE_X87
        ||i->flow!=PL_X86_FLOW_NEXT||i->visible_operand_count!=2u||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *t=i->operands,*s=t+1u;pl_u32 kind=(pl_u32)i->machine_argument&255u,bits=kind==40u?32u:64u;
    pl_u32 from=(pl_u32)mmx(s),to=(pl_u32)mmx(t),read=s->kind==PL_X86_OPERAND_MEMORY,write=t->kind==PL_X86_OPERAND_MEMORY;
    if((!from&&!to)||(read&&write)||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=read||!!(i->flags&PL_X86_INSTRUCTION_WRITES_MEMORY)!=write)return 0;
    pl_u64 expected=kind|(i->machine_argument&(0x7ffull<<16u));
    if(kind==17u){
        if((!to||(!from&&!read))&&(!write||!from))return 0;
        if((read?s->bits!=64u:0)||(write?t->bits!=64u:0))return 0;
        expected|=((pl_u64)(read||write?8u:0u)<<8u)|((pl_u64)(from?s->value.reg.index:0u)<<32u)
            |((pl_u64)(to?t->value.reg.index:0u)<<36u)|((pl_u64)write<<40u);
    }else if(kind==40u||kind==45u){
        if(from==to||(from?(!write&&!general(t,bits)):(!read&&!general(s,bits))))return 0;
        if((read?s->bits!=bits:0)||(write?t->bits!=bits:0)||(kind==45u&&(read||write)))return 0;
        pl_u32 index=from?(write?0u:t->value.reg.index):(read?0u:s->value.reg.index);
        expected|=((pl_u64)(read||write?bits/8u:0u)<<8u)|((pl_u64)(from?s->value.reg.index:0u)<<32u)
            |((pl_u64)(to?t->value.reg.index:0u)<<36u)|((pl_u64)from<<40u)|((pl_u64)index<<44u);
    }else return 0;
    if(i->machine_argument!=expected)return 0;
    *out=(pl_x86_mmx_transfer){(pl_u8)(bits/8u),(pl_u8)read,(pl_u8)write,(pl_u8)from,(pl_u8)to,(pl_u8)(i->opcode==0xe7u)};return 1;
}
