/* Static vector permutations are one coordinate substitution. */
#include <x86/semantics.h>

static int xmm(const pl_x86_operand *operand)
{
    return operand->kind == PL_X86_OPERAND_REGISTER
        && operand->bits == 128u
        && operand->value.reg.class_id == PL_X86_REGISTER_VECTOR
        && operand->value.reg.bits == 128u
        && operand->value.reg.index < 16u && !operand->value.reg.flags;
}

int pl_x86_vector_project(const pl_x86_instruction *instruction,
                           pl_x86_vector_projection *out)
{
    if (!instruction || !out
            || instruction->status != PL_X86_DECODE_VALID
            || instruction->flow != PL_X86_FLOW_NEXT
            || instruction->machine_operation != PL_X86_MACHINE_VECTOR
            || (instruction->flags & (PL_X86_INSTRUCTION_LOCKED
                | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)))
        return 0;
    pl_u32 kind = (pl_u32)instruction->machine_argument & 255u;
    if (kind == 23u) {
        const pl_x86_operand *target=instruction->operands,*amount=target+1u;
        if(instruction->visible_operand_count!=2u || !xmm(target)
                || amount->kind!=PL_X86_OPERAND_IMMEDIATE || amount->bits!=8u
                || amount->value.immediate>255u)return 0;
        pl_u32 count=(pl_u32)(amount->value.immediate>15u?16u:amount->value.immediate);
        pl_u64 left=(instruction->machine_argument>>37u)&1u;
        pl_u64 descriptor=23u|((pl_u64)target->value.reg.index<<8u)
            |((pl_u64)target->value.reg.index<<16u)|((count|(left<<5u))<<32u);
        if(instruction->machine_argument!=descriptor)return 0;
        *out=(pl_x86_vector_projection){1u,(pl_u8)count,(pl_u8)left,
            (pl_u8)(count==16u?0u:count?2u:1u),target->value.reg.index,0u,0u,(pl_u8)!count};
        return 1;
    }
    int fixed = kind == PL_X86_VECTOR_FIXED_DWORD_SHUFFLE;
    if (kind != 7u && kind != 8u && kind != 27u
            && kind != PL_X86_VECTOR_SHUFFLE_LOW_WORDS && !fixed)
        return 0;
    if (instruction->visible_operand_count != (fixed ? 2u : 3u))
        return 0;
    const pl_x86_operand *target = instruction->operands;
    const pl_x86_operand *source = instruction->operands + 1u;
    int memory = source->kind == PL_X86_OPERAND_MEMORY;
    if (!xmm(target) || (memory ? source->bits != 128u : !xmm(source)))
        return 0;
    pl_u64 control = instruction->machine_argument >> 32u;
    if (control > 255u || (fixed && control != 0xa0u && control != 0xf5u))
        return 0;
    if (!fixed && (instruction->operands[2].kind != PL_X86_OPERAND_IMMEDIATE
            || instruction->operands[2].bits != 8u
            || instruction->operands[2].value.immediate != control))
        return 0;
    pl_u64 descriptor = kind
        | ((pl_u64)target->value.reg.index << 8u)
        | ((pl_u64)(memory ? 0u : source->value.reg.index) << 16u)
        | ((pl_u64)memory << 24u) | ((pl_u64)memory << 26u)
        | (control << 32u);
    if (instruction->machine_argument != descriptor) return 0;
    int paired = kind == 8u;
    int alias = !memory && source->value.reg.index == target->value.reg.index;
    *out = (pl_x86_vector_projection){
        (pl_u8)((kind == 27u || kind == PL_X86_VECTOR_SHUFFLE_LOW_WORDS) ? 2u : 4u),
        (pl_u8)(kind == 27u ? 8u : 0u), (pl_u8)control,
        (pl_u8)(paired && !alias ? 2u : 1u),
        (pl_u8)(paired ? target->value.reg.index : memory ? 0u : source->value.reg.index),
        (pl_u8)(memory ? 0u : source->value.reg.index),
        (pl_u8)memory, 0u
    };
    /* Substitution of equal input coordinates also removes the two-source
     * distinction. Identity is proved from the full selection, not a special
     * instruction mnemonic or a guessed immediate. */
    out->identity = (pl_u8)!memory;
    for (pl_u32 byte = 0u; byte < 16u; ++byte)
        if (pl_x86_vector_project_byte(out, byte) != byte) out->identity = 0u;
    out->identity = (pl_u8)(out->identity && alias);
    return 1;
}

pl_u32 pl_x86_vector_project_byte(const pl_x86_vector_projection *projection,
                                  pl_u32 byte)
{
    if(projection && projection->lane_bytes==1u && byte<16u
            && projection->start<=16u && projection->control<=1u) {
        pl_u32 count=projection->start;
        if(projection->inputs!=(count==16u?0u:count?2u:1u))return 32u;
        if(projection->control)return byte<count?16u:byte-count;
        return byte+count<16u?byte+count:16u;
    }
    if (!projection || byte >= 16u
            || (projection->lane_bytes != 2u && projection->lane_bytes != 4u)
            || (projection->inputs != 1u && projection->inputs != 2u)
            || (projection->lane_bytes == 4u ? projection->start != 0u
                : projection->start != 0u && projection->start != 8u)
            || (projection->inputs == 2u && projection->lane_bytes != 4u))
        return 32u;
    pl_u32 bytes = projection->lane_bytes, start = projection->start;
    if (bytes == 2u && (byte < start || byte >= start + 8u)) return byte;
    pl_u32 lane = (byte - start) / bytes;
    pl_u32 selected = (projection->control >> (lane * 2u)) & 3u;
    pl_u32 second = projection->inputs == 2u && lane >= 2u ? 16u : 0u;
    return second + start + bytes * selected + (byte - start) % bytes;
}
