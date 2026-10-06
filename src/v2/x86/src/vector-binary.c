/* Packed arithmetic, logic and equality share one lane-parametric law. */
#include <x86/semantics.h>

static int xmm(const pl_x86_operand *operand)
{
    return operand->kind == PL_X86_OPERAND_REGISTER && operand->bits == 128u
        && operand->value.reg.class_id == PL_X86_REGISTER_VECTOR
        && operand->value.reg.bits == 128u && operand->value.reg.index < 16u
        && !operand->value.reg.flags;
}

int pl_x86_vector_binary_lower(const pl_x86_instruction *instruction,
                               pl_x86_vector_binary *out)
{
    if (!instruction || !out || instruction->status != PL_X86_DECODE_VALID
            || instruction->flow != PL_X86_FLOW_NEXT
            || instruction->machine_operation != PL_X86_MACHINE_VECTOR
            || instruction->visible_operand_count != 2u
            || (instruction->flags & (PL_X86_INSTRUCTION_LOCKED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)))
        return 0;
    const pl_x86_operand *target = instruction->operands, *source = target + 1u;
    int memory = source->kind == PL_X86_OPERAND_MEMORY;
    if (!xmm(target) || (memory ? source->bits != 128u : !xmm(source))) return 0;
    pl_u32 kind = (pl_u32)instruction->machine_argument & 255u;
    pl_u64 subtype = instruction->machine_argument >> 32u;
    pl_x86_vector_binary law = {0};
    if (kind == 1u && !subtype) law.operation = PL_X86_VECTOR_BINARY_XOR;
    else if (kind == 2u && !subtype) law.operation = PL_X86_VECTOR_BINARY_AND;
    else if (kind == 3u && !subtype) law.operation = PL_X86_VECTOR_BINARY_OR;
    else if (kind == 24u && !subtype) law.operation = PL_X86_VECTOR_BINARY_AND_NOT;
    else if (kind == 4u && !subtype) {
        law.operation = PL_X86_VECTOR_BINARY_ADD; law.lane_bytes = 4u;
    } else if (kind == 10u) {
        switch (subtype) {
        case 12u: law.operation = PL_X86_VECTOR_BINARY_AND_NOT; break;
        case 15u: law.operation = PL_X86_VECTOR_BINARY_ADD; law.lane_bytes = 8u; break;
        case 56u: law.operation = PL_X86_VECTOR_BINARY_ADD; law.lane_bytes = 1u; break;
        case 57u: law.operation = PL_X86_VECTOR_BINARY_ADD; law.lane_bytes = 2u; break;
        case 48u: law.operation = PL_X86_VECTOR_BINARY_EQUAL; law.lane_bytes = 1u; break;
        case 51u: law.operation = PL_X86_VECTOR_BINARY_EQUAL; law.lane_bytes = 2u; break;
        case 52u: law.operation = PL_X86_VECTOR_BINARY_EQUAL; law.lane_bytes = 4u; break;
        default: return 0;
        }
    } else return 0;
    pl_u64 descriptor = kind | ((pl_u64)target->value.reg.index << 8u)
        | ((pl_u64)(memory ? 0u : source->value.reg.index) << 16u)
        | ((pl_u64)memory << 24u) | ((pl_u64)memory << 26u) | (subtype << 32u);
    if (instruction->machine_argument != descriptor) return 0;
    law.source_memory = (pl_u8)memory;
    law.alias = (pl_u8)(!memory && target->value.reg.index == source->value.reg.index);
    law.reverse = (pl_u8)(law.operation == PL_X86_VECTOR_BINARY_AND_NOT);
    if (law.alias) {
        if (law.operation == PL_X86_VECTOR_BINARY_EQUAL) law.result = PL_X86_VECTOR_BINARY_ONES;
        else if (law.operation == PL_X86_VECTOR_BINARY_XOR || law.reverse)
            law.result = PL_X86_VECTOR_BINARY_ZERO;
        else if (law.operation == PL_X86_VECTOR_BINARY_AND || law.operation == PL_X86_VECTOR_BINARY_OR)
            law.result = PL_X86_VECTOR_BINARY_IDENTITY;
    }
    *out = law;
    return 1;
}
