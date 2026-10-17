#include <x86/semantics.h>
const pl_x86_operand *pl_x86_string_io_memory(const pl_x86_instruction *i)
{
    if(!i||i->operand_count>PL_X86_MAX_OPERANDS)return 0;
    const pl_x86_operand *found=0;
    for(pl_u32 n=0u;n<i->operand_count;++n)if(i->operands[n].kind==PL_X86_OPERAND_MEMORY){if(found)return 0;found=i->operands+n;}
    return found;
}
int pl_x86_string_io_lower(const pl_x86_instruction *i,pl_x86_string_io *out)
{
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_PORT_IO||!(i->machine_argument&(1ull<<10u))
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_TRAP_AFTER))
        ||(i->address_width!=32u&&i->address_width!=64u)||i->opcode<0x6cu||i->opcode>0x6fu)return 0;
    pl_u32 bytes=(pl_u32)i->machine_argument&255u,write=(pl_u32)(i->machine_argument>>8u)&1u;
    pl_u32 repeated=(pl_u32)(i->machine_argument>>11u)&1u,segment=(pl_u32)(i->machine_argument>>24u)&255u;
    if((bytes!=1u&&bytes!=2u&&bytes!=4u)||write!=((i->opcode>>1u)&1u)||((i->opcode&1u)?bytes==1u:bytes!=1u)
        ||segment>5u||(!write&&segment)||repeated!=!!(i->flags&PL_X86_INSTRUCTION_REPEATED)
        ||i->machine_argument!=(bytes|((pl_u64)write<<8u)|(1ull<<9u)|(1ull<<10u)|((pl_u64)repeated<<11u)
            |((pl_u64)i->address_width<<16u)|((pl_u64)segment<<24u)))return 0;
    const pl_x86_operand *m=pl_x86_string_io_memory(i);if(!m||m->bits!=bytes*8u)return 0;
    const pl_x86_memory *address=&m->value.memory;
    if(address->base.class_id!=PL_X86_REGISTER_GPR||address->base.index!=(write?6u:7u)||address->base.bits!=i->address_width
        ||address->base.flags||address->index.class_id!=PL_X86_REGISTER_NONE||address->displacement
        ||address->segment.class_id!=PL_X86_REGISTER_SEGMENT||address->segment.index!=segment)return 0;
    *out=(pl_x86_string_io){(pl_u8)bytes,(pl_u8)write,(pl_u8)repeated,(pl_u8)i->address_width,(pl_u8)segment,(pl_u8)(write?6u:7u)};return 1;
}
