#include <x86/semantics.h>
static int lane(const pl_x86_operand *o,pl_u32 bits)
{
    return o->kind==PL_X86_OPERAND_REGISTER&&o->value.reg.class_id==PL_X86_REGISTER_VECTOR&&o->value.reg.bits==128u
        &&o->value.reg.index<16u&&!o->value.reg.flags&&(o->bits==bits||o->bits==128u);
}
int pl_x86_scalar_vector_transfer_lower(const pl_x86_instruction *i,pl_x86_scalar_vector_transfer *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||(i->machine_argument&255u)!=39u||i->visible_operand_count!=2u
        ||(i->flags&required)!=required||!i->source_bytes||i->source_bytes>15u||i->source_bytes!=i->length||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *d=i->operands,*s=d+1u;pl_u32 read=s->kind==PL_X86_OPERAND_MEMORY,write=d->kind==PL_X86_OPERAND_MEMORY,op=(pl_u32)(i->machine_argument>>32u);
    if((op!=0u&&op!=1u&&op!=3u)||(read&&write)||(op==3u&&(read||write)))return 0;
    pl_u32 bits=op?64u:32u;
    if((read?s->bits!=bits:!lane(s,bits))||(write?d->bits!=bits:!lane(d,bits))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=read||!!(i->flags&PL_X86_INSTRUCTION_WRITES_MEMORY)!=write
        ||(op==3u?(i->opcode!=0x7eu&&i->opcode!=0xd6u):(i->opcode!=0x10u&&i->opcode!=0x11u))
        ||i->machine_argument!=(39u|((pl_u64)(write?0u:d->value.reg.index)<<8u)|((pl_u64)(read?0u:s->value.reg.index)<<16u)
            |((pl_u64)read<<24u)|((pl_u64)write<<25u)|((pl_u64)op<<32u)))return 0;
    *out=(pl_x86_scalar_vector_transfer){(pl_u8)(bits/8u),(pl_u8)read,(pl_u8)write,(pl_u8)(read?0u:s->value.reg.index),
        (pl_u8)(write?0u:d->value.reg.index),(pl_u8)(read||op==3u),(pl_u8)(!read&&!write&&s->value.reg.index==d->value.reg.index)};return 1;
}
