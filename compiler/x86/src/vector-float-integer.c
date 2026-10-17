#include <x86/semantics.h>
int pl_x86_vector_float_integer_lower(const pl_x86_instruction *i,pl_x86_vector_float_integer *out)
{
    const pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY||i->flow!=PL_X86_FLOW_NEXT
        ||i->machine_operation!=PL_X86_MACHINE_VECTOR||i->visible_operand_count!=2u||(i->flags&required)!=required
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_TRAP_AFTER
            |PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u;
    const pl_x86_operand *d=i->operands,*s=d+1u;
    pl_u32 memory=s->kind==PL_X86_OPERAND_MEMORY,bytes,element,target_class,target_bytes,truncate=1u;
    pl_u64 argument=kind|((pl_u64)d->value.reg.index<<8u)|((pl_u64)(memory?0u:s->value.reg.index)<<16u)|((pl_u64)memory<<24u);
    if(kind==17u||kind==21u||kind==32u){bytes=kind==32u?16u:8u;element=kind==32u?8u:4u;
        target_class=PL_X86_REGISTER_MMX;target_bytes=4u;truncate=kind!=21u;
        if(d->bits!=64u||d->value.reg.bits!=64u||d->value.reg.index>=8u)return 0;
    }else if(kind==PL_X86_VECTOR_PACKED_CONVERT){
        bytes=16u;element=8u;target_class=PL_X86_REGISTER_VECTOR;target_bytes=4u;
        pl_u32 op=(pl_u32)(i->machine_argument>>32u)&255u;
        if(op<PL_X86_PACKED_CONVERT_FLOAT64_TO_SIGNED_DWORD_TRUNCATE||op>PL_X86_PACKED_CONVERT_FLOAT32_TO_SIGNED_DWORD_TRUNCATE)return 0;
        if(op>=PL_X86_PACKED_CONVERT_FLOAT32_TO_SIGNED_DWORD)element=4u;
        truncate=op==PL_X86_PACKED_CONVERT_FLOAT64_TO_SIGNED_DWORD_TRUNCATE||op==PL_X86_PACKED_CONVERT_FLOAT32_TO_SIGNED_DWORD_TRUNCATE;
        argument|=(pl_u64)op<<PL_X86_VECTOR_IMMEDIATE_SHIFT;
        if(d->bits!=128u||d->value.reg.bits!=128u||d->value.reg.index>=16u)return 0;
    }else if(kind==PL_X86_VECTOR_SCALAR_FLOAT){
        bytes=s->bits/8u;element=bytes;target_class=PL_X86_REGISTER_GPR;target_bytes=d->bits/8u;
        pl_u32 op=(pl_u32)(i->machine_argument>>32u)&255u;
        if(op!=PL_X86_SCALAR_FLOAT_TO_INTEGER_TRUNCATE&&op!=PL_X86_SCALAR_FLOAT_TO_INTEGER)return 0;
        truncate=op==PL_X86_SCALAR_FLOAT_TO_INTEGER_TRUNCATE;
        argument|=PL_X86_SCALAR_FLOAT_TARGET_GPR|((pl_u64)op<<PL_X86_SCALAR_FLOAT_OPERATION_SHIFT)
            |((pl_u64)target_bytes<<PL_X86_SCALAR_FLOAT_TARGET_BYTES_SHIFT)|((pl_u64)bytes<<PL_X86_SCALAR_FLOAT_SOURCE_BYTES_SHIFT);
        if((bytes!=4u&&bytes!=8u)||(target_bytes!=4u&&target_bytes!=8u)||d->value.reg.bits!=d->bits||d->value.reg.index>=16u)return 0;
    }else return 0;
    if(i->opcode!=(kind==PL_X86_VECTOR_PACKED_CONVERT?(element==4u?0x5bu:0xe6u):truncate?0x2cu:0x2du))return 0;
    if(d->kind!=PL_X86_OPERAND_REGISTER||d->value.reg.class_id!=target_class||d->value.reg.flags||s->bits!=bytes*8u
        ||(!memory&&(s->kind!=PL_X86_OPERAND_REGISTER||s->value.reg.class_id!=PL_X86_REGISTER_VECTOR
            ||s->value.reg.bits!=128u||s->value.reg.index>=16u||s->value.reg.flags))
        ||!!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory
        ||i->machine_argument!=argument)return 0;
    *out=(pl_x86_vector_float_integer){(pl_u8)memory,(pl_u8)bytes,(pl_u8)truncate,(pl_u8)(memory?0u:s->value.reg.index),(pl_u8)d->value.reg.index,
        (pl_u8)element,(pl_u8)target_class,(pl_u8)target_bytes};return 1;
}
