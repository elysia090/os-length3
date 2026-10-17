/* Packed arithmetic, logic and equality share one lane-parametric law. */
#include <x86/semantics.h>

static int xmm(const pl_x86_operand *operand)
{
    return operand->kind == PL_X86_OPERAND_REGISTER && operand->bits == 128u
        && operand->value.reg.class_id == PL_X86_REGISTER_VECTOR
        && operand->value.reg.bits == 128u && operand->value.reg.index < 16u
        && !operand->value.reg.flags;
}
static int mmx(const pl_x86_operand *o)
{return o->kind==PL_X86_OPERAND_REGISTER&&o->bits==64u&&o->value.reg.class_id==PL_X86_REGISTER_MMX
    &&o->value.reg.bits==64u&&o->value.reg.index<8u&&!o->value.reg.flags;}
static int packed(pl_u64 operation,pl_x86_vector_binary *law)
{
    switch(operation){
    case 12u:law->operation=PL_X86_VECTOR_BINARY_AND_NOT;break;
    case 15u:law->operation=PL_X86_VECTOR_BINARY_ADD;law->lane_bytes=8u;break;
    case 56u:law->operation=PL_X86_VECTOR_BINARY_ADD;law->lane_bytes=1u;break;
    case 57u:law->operation=PL_X86_VECTOR_BINARY_ADD;law->lane_bytes=2u;break;
    case 48u:law->operation=PL_X86_VECTOR_BINARY_EQUAL;law->lane_bytes=1u;break;
    case 51u:law->operation=PL_X86_VECTOR_BINARY_EQUAL;law->lane_bytes=2u;break;
    case 52u:law->operation=PL_X86_VECTOR_BINARY_EQUAL;law->lane_bytes=4u;break;
    case 10u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT;law->lane_bytes=1u;break;
    case 21u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT;law->lane_bytes=2u;break;
    case 53u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT;law->lane_bytes=4u;break;
    case 50u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT;law->lane_bytes=8u;break;
    case 24u:law->operation=PL_X86_VECTOR_BINARY_GREATER;law->lane_bytes=1u;law->signed_lanes=1u;break;
    case 11u:law->operation=PL_X86_VECTOR_BINARY_GREATER;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 58u:law->operation=PL_X86_VECTOR_BINARY_GREATER;law->lane_bytes=4u;law->signed_lanes=1u;break;
    case 41u:law->operation=PL_X86_VECTOR_BINARY_ADD_SAT;law->lane_bytes=1u;law->signed_lanes=1u;break;
    case 27u:law->operation=PL_X86_VECTOR_BINARY_ADD_SAT;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 32u:law->operation=PL_X86_VECTOR_BINARY_ADD_SAT;law->lane_bytes=1u;break;
    case 42u:law->operation=PL_X86_VECTOR_BINARY_ADD_SAT;law->lane_bytes=2u;break;
    case 55u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT_SAT;law->lane_bytes=1u;law->signed_lanes=1u;break;
    case 54u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT_SAT;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 31u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT_SAT;law->lane_bytes=1u;break;
    case 47u:law->operation=PL_X86_VECTOR_BINARY_SUBTRACT_SAT;law->lane_bytes=2u;break;
    case 17u:law->operation=PL_X86_VECTOR_BINARY_MINIMUM;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 43u:law->operation=PL_X86_VECTOR_BINARY_MINIMUM;law->lane_bytes=1u;break;
    case 30u:law->operation=PL_X86_VECTOR_BINARY_MAXIMUM;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 35u:law->operation=PL_X86_VECTOR_BINARY_MAXIMUM;law->lane_bytes=1u;break;
    case 33u:law->operation=PL_X86_VECTOR_BINARY_AVERAGE;law->lane_bytes=1u;break;
    case 34u:law->operation=PL_X86_VECTOR_BINARY_AVERAGE;law->lane_bytes=2u;break;
    case 49u:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY;law->lane_bytes=2u;break;
    case 14u:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY_ADD;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 16u:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY_HIGH;law->lane_bytes=2u;break;
    case 25u:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY_HIGH;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 23u:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY_EVEN;law->lane_bytes=4u;break;
    case PL_X86_PACKED_MULTIPLY_HIGH_ROUND_SCALE_WORD:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY_ROUND;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 26u:law->operation=PL_X86_VECTOR_BINARY_NARROW;law->lane_bytes=2u;break;
    case 40u:law->operation=PL_X86_VECTOR_BINARY_NARROW;law->lane_bytes=4u;law->signed_lanes=1u;break;
    case 46u:law->operation=PL_X86_VECTOR_BINARY_NARROW;law->lane_bytes=2u;law->signed_lanes=1u;break;
    case 9u:law->operation=PL_X86_VECTOR_BINARY_SUM_ABSOLUTE;law->lane_bytes=1u;break;
    case PL_X86_PACKED_MIN_SIGNED_BYTE:law->operation=PL_X86_VECTOR_BINARY_MINIMUM;law->lane_bytes=1u;law->signed_lanes=1u;break;
    case PL_X86_PACKED_MIN_SIGNED_DWORD:law->operation=PL_X86_VECTOR_BINARY_MINIMUM;law->lane_bytes=4u;law->signed_lanes=1u;break;
    case PL_X86_PACKED_MIN_UNSIGNED_WORD:law->operation=PL_X86_VECTOR_BINARY_MINIMUM;law->lane_bytes=2u;break;
    case PL_X86_PACKED_MIN_UNSIGNED_DWORD:law->operation=PL_X86_VECTOR_BINARY_MINIMUM;law->lane_bytes=4u;break;
    case PL_X86_PACKED_MAX_SIGNED_BYTE:law->operation=PL_X86_VECTOR_BINARY_MAXIMUM;law->lane_bytes=1u;law->signed_lanes=1u;break;
    case PL_X86_PACKED_MAX_SIGNED_DWORD:law->operation=PL_X86_VECTOR_BINARY_MAXIMUM;law->lane_bytes=4u;law->signed_lanes=1u;break;
    case PL_X86_PACKED_MAX_UNSIGNED_WORD:law->operation=PL_X86_VECTOR_BINARY_MAXIMUM;law->lane_bytes=2u;break;
    case PL_X86_PACKED_MAX_UNSIGNED_DWORD:law->operation=PL_X86_VECTOR_BINARY_MAXIMUM;law->lane_bytes=4u;break;
    case PL_X86_PACKED_EQUAL_QWORD:law->operation=PL_X86_VECTOR_BINARY_EQUAL;law->lane_bytes=8u;break;
    case PL_X86_PACKED_GREATER_QWORD:law->operation=PL_X86_VECTOR_BINARY_GREATER;law->lane_bytes=8u;law->signed_lanes=1u;break;
    case PL_X86_PACKED_MULTIPLY_DWORD:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY;law->lane_bytes=4u;break;
    case PL_X86_PACKED_MULTIPLY_SIGNED_EVEN_DWORD:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY_EVEN;law->lane_bytes=4u;law->signed_lanes=1u;break;
    case PL_X86_PACKED_NARROW_UNSIGNED_DWORD:law->operation=PL_X86_VECTOR_BINARY_NARROW;law->lane_bytes=4u;break;
    case PL_X86_PACKED_ABSOLUTE:case PL_X86_PACKED_ABSOLUTE+1u:case PL_X86_PACKED_ABSOLUTE+2u:
        law->operation=PL_X86_VECTOR_BINARY_ABSOLUTE;law->lane_bytes=(pl_u8)(1u<<(operation-PL_X86_PACKED_ABSOLUTE));break;
    case PL_X86_PACKED_HORIZONTAL_ADD_DWORD:case PL_X86_PACKED_HORIZONTAL_ADD_WORD:case PL_X86_PACKED_HORIZONTAL_ADD_SAT_WORD:
        law->operation=PL_X86_VECTOR_BINARY_HORIZONTAL_ADD;law->lane_bytes=(pl_u8)(operation==PL_X86_PACKED_HORIZONTAL_ADD_DWORD?4u:2u);
        law->signed_lanes=(pl_u8)(operation==PL_X86_PACKED_HORIZONTAL_ADD_SAT_WORD);break;
    case PL_X86_PACKED_HORIZONTAL_SUBTRACT_DWORD:case PL_X86_PACKED_HORIZONTAL_SUBTRACT_WORD:case PL_X86_PACKED_HORIZONTAL_SUBTRACT_SAT_WORD:
        law->operation=PL_X86_VECTOR_BINARY_HORIZONTAL_SUBTRACT;law->lane_bytes=(pl_u8)(operation==PL_X86_PACKED_HORIZONTAL_SUBTRACT_DWORD?4u:2u);
        law->signed_lanes=(pl_u8)(operation==PL_X86_PACKED_HORIZONTAL_SUBTRACT_SAT_WORD);break;
    case PL_X86_PACKED_SIGN_BYTE:case PL_X86_PACKED_SIGN_WORD:case PL_X86_PACKED_SIGN_DWORD:
        law->operation=PL_X86_VECTOR_BINARY_SIGN;law->lane_bytes=(pl_u8)(operation==PL_X86_PACKED_SIGN_BYTE?1u:operation==PL_X86_PACKED_SIGN_WORD?2u:4u);break;
    case PL_X86_PACKED_MULTIPLY_ADD_UNSIGNED_SIGNED_BYTE:law->operation=PL_X86_VECTOR_BINARY_MULTIPLY_ADD_BYTES;law->lane_bytes=1u;break;
    default:return 0;
    }
    return 1;
}

int pl_x86_vector_binary_lower(const pl_x86_instruction *instruction,
                               pl_x86_vector_binary *out)
{
    if (!instruction || !out || instruction->status != PL_X86_DECODE_VALID
            || instruction->flow != PL_X86_FLOW_NEXT
            || (instruction->machine_operation != PL_X86_MACHINE_VECTOR&&instruction->machine_operation!=PL_X86_MACHINE_X87)
            || instruction->visible_operand_count != 2u
            || (instruction->flags & (PL_X86_INSTRUCTION_LOCKED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)))
        return 0;
    const pl_x86_operand *target = instruction->operands, *source = target + 1u;
    int memory = source->kind == PL_X86_OPERAND_MEMORY;
    int narrow=instruction->machine_operation==PL_X86_MACHINE_X87;
    if(instruction->flags&(PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED))return 0;
    if(narrow){pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
        if((instruction->flags&required)!=required||!!(instruction->flags&PL_X86_INSTRUCTION_READS_MEMORY)!=memory)return 0;}
    if(narrow?(!mmx(target)||(memory?source->bits!=64u:!mmx(source))):(!xmm(target)||(memory?source->bits!=128u:!xmm(source))))return 0;
    pl_u32 kind = (pl_u32)instruction->machine_argument & 255u;
    pl_u64 subtype = instruction->machine_argument >> 32u;
    pl_x86_vector_binary law = {.register_bytes=(pl_u8)(narrow?8u:16u)};
    if(narrow){
        pl_u64 operation=instruction->machine_argument>>40u;
        if(kind==23u&&operation<=2u)law.operation=(pl_u8)(operation==0u?PL_X86_VECTOR_BINARY_XOR:operation==1u?PL_X86_VECTOR_BINARY_AND:PL_X86_VECTOR_BINARY_OR);
        else if(kind==18u&&!operation){law.operation=PL_X86_VECTOR_BINARY_ADD;law.lane_bytes=4u;}
        else if(kind==24u&&!operation){law.operation=PL_X86_VECTOR_BINARY_EQUAL;law.lane_bytes=1u;}
        else if(kind==25u&&!operation){law.operation=PL_X86_VECTOR_BINARY_GREATER;law.lane_bytes=4u;law.signed_lanes=1u;}
        else if(kind==37u){if((operation>=PL_X86_PACKED_MIN_SIGNED_BYTE
                &&(operation<PL_X86_PACKED_HORIZONTAL_ADD_SAT_WORD||operation>PL_X86_PACKED_SIGN_WORD))||!packed(operation,&law))return 0;}
        else return 0;
        pl_u64 descriptor=kind|((pl_u64)(memory?8u:0u)<<8u)|(instruction->machine_argument&(0x7ffull<<16u))
            |((pl_u64)(memory?0u:source->value.reg.index)<<32u)|((pl_u64)target->value.reg.index<<36u)|(operation<<40u);
        if(instruction->machine_argument!=descriptor)return 0;
    }else if(kind==PL_X86_VECTOR_BYTE_BLEND||kind==PL_X86_VECTOR_VARIABLE_BLEND){
        if(kind==PL_X86_VECTOR_BYTE_BLEND?subtype!=0u:(subtype!=4u&&subtype!=8u))return 0;
        law.operation=PL_X86_VECTOR_BINARY_SELECT;law.lane_bytes=(pl_u8)(kind==PL_X86_VECTOR_BYTE_BLEND?1u:subtype);
    }else if (kind == 1u && !subtype) law.operation = PL_X86_VECTOR_BINARY_XOR;
    else if (kind == 2u && !subtype) law.operation = PL_X86_VECTOR_BINARY_AND;
    else if (kind == 3u && !subtype) law.operation = PL_X86_VECTOR_BINARY_OR;
    else if (kind == 24u && !subtype) law.operation = PL_X86_VECTOR_BINARY_AND_NOT;
    else if (kind == 4u && !subtype) {
        law.operation = PL_X86_VECTOR_BINARY_ADD; law.lane_bytes = 4u;
    } else if (kind == 10u) {
        if(!packed(subtype,&law))return 0;
    } else return 0;
    pl_u64 descriptor = kind | ((pl_u64)target->value.reg.index << 8u)
        | ((pl_u64)(memory ? 0u : source->value.reg.index) << 16u)
        | ((pl_u64)memory << 24u) | ((pl_u64)memory << 26u) | (subtype << 32u);
    if (!narrow&&instruction->machine_argument != descriptor) return 0;
    law.source_memory = (pl_u8)memory;
    law.alias = (pl_u8)(!memory && target->value.reg.index == source->value.reg.index);
    law.reverse = (pl_u8)(law.operation == PL_X86_VECTOR_BINARY_AND_NOT);
    if (law.alias) {
        if(law.operation==PL_X86_VECTOR_BINARY_SIGN)law.operation=PL_X86_VECTOR_BINARY_ABSOLUTE;
        if (law.operation == PL_X86_VECTOR_BINARY_EQUAL) law.result = PL_X86_VECTOR_BINARY_ONES;
        else if(law.operation==PL_X86_VECTOR_BINARY_GREATER||law.operation==PL_X86_VECTOR_BINARY_SUBTRACT||law.operation==PL_X86_VECTOR_BINARY_SUBTRACT_SAT
            ||law.operation==PL_X86_VECTOR_BINARY_SUM_ABSOLUTE)law.result=PL_X86_VECTOR_BINARY_ZERO;
        else if (law.operation == PL_X86_VECTOR_BINARY_XOR || law.reverse)
            law.result = PL_X86_VECTOR_BINARY_ZERO;
        else if (law.operation == PL_X86_VECTOR_BINARY_AND || law.operation == PL_X86_VECTOR_BINARY_OR
            ||law.operation==PL_X86_VECTOR_BINARY_MINIMUM||law.operation==PL_X86_VECTOR_BINARY_MAXIMUM||law.operation==PL_X86_VECTOR_BINARY_AVERAGE)
            law.result = PL_X86_VECTOR_BINARY_IDENTITY;
        else if(law.operation==PL_X86_VECTOR_BINARY_SELECT)law.result=PL_X86_VECTOR_BINARY_IDENTITY;
    }
    *out = law;
    return 1;
}
