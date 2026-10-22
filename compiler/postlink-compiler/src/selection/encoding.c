/* encoding: native x86 selection. */
#include "encoding.h"
#include "limits.h"

static int add_displacement(pl_u64 value, pl_u32 bits, pl_u32 *width);

static int immediate_matches_signed8(pl_u64 value, pl_u32 bits);

static int immediate_matches_signed32(pl_u64 value, pl_u32 bits);

static int emit_narrow_alu_instruction(pl_u32 destination, pl_operand right,
                                       pl_u32 bits, pl_u32 mode,
                                       pl_u8 *output, pl_u32 *written);

pl_u32 pl_select_constant_move_bytes(pl_u32 local, pl_u64 value)
{
    if (value <= 0xffffffffu) return local < 8u ? 5u : 6u;
    if (value >= 0xffffffff80000000ull) return 7u;
    return 10u;
}

static int add_displacement(pl_u64 value, pl_u32 bits, pl_u32 *width)
{
    if (!width || (bits != 32u && bits != 64u)) return 0;
    if (bits == 64u && value > I32_MAX_VALUE
            && value < 0xffffffff80000000ull)
        return 0;
    pl_u32 low = (pl_u32)value;
    if (!low) *width = 0u;
    else if (low <= 0x7fu || low >= 0xffffff80u) *width = 1u;
    else *width = 4u;
    return 1;
}

/* Emit the canonical flag-preserving spelling of one lane add.  LEA is both
 * the native instruction and the physical node: it avoids reconstructing an
 * x86 flags producer whose result the normalized future does not observe. */
int pl_select_emit_add_lea(pl_u32 destination, pl_operand left,
                        pl_operand right, pl_u32 bits,
                        pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u32 base = 0u, index = 0u, displacement_bytes = 0u;
    pl_u32 has_index = 0u;
    pl_u64 displacement = 0u;
    if (left.kind == PL_OPERAND_LOCAL
            && right.kind == PL_OPERAND_CONST) {
        base = (pl_u32)left.value;
        displacement = right.value;
    } else if (right.kind == PL_OPERAND_LOCAL
            && left.kind == PL_OPERAND_CONST) {
        base = (pl_u32)right.value;
        displacement = left.value;
    } else if (left.kind == PL_OPERAND_LOCAL
            && right.kind == PL_OPERAND_LOCAL) {
        base = (pl_u32)left.value;
        index = (pl_u32)right.value;
        has_index = 1u;
        if ((index & 7u) == 4u) {
            pl_u32 swap = base;
            base = index;
            index = swap;
        }
        if ((index & 7u) == 4u) return 0;
    } else {
        return 0;
    }
    if (base >= PL_X86_GPR_COUNT
            || (has_index && index >= PL_X86_GPR_COUNT)
            || (!has_index
                && !add_displacement(
                    displacement, bits, &displacement_bytes)))
        return 0;

    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
        | (destination >= 8u ? 4u : 0u)
        | (has_index && index >= 8u ? 2u : 0u)
        | (base >= 8u ? 1u : 0u));
    pl_u32 at = 0u;
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x8du;
    ++at;
    pl_u32 base_low = base & 7u;
    pl_u32 mod;
    if (has_index)
        mod = base_low == 5u ? 1u : 0u;
    else if (!displacement_bytes && base_low != 5u)
        mod = 0u;
    else if (displacement_bytes <= 1u)
        mod = 1u;
    else
        mod = 2u;
    pl_u32 sib = has_index || base_low == 4u;
    if (output)
        output[at] = (pl_u8)((mod << 6u)
            | ((destination & 7u) << 3u) | (sib ? 4u : base_low));
    ++at;
    if (sib) {
        pl_u32 index_low = has_index ? index & 7u : 4u;
        if (output)
            output[at] = (pl_u8)((index_low << 3u) | base_low);
        ++at;
    }
    pl_u32 encoded_displacement = has_index
        ? (mod == 1u ? 1u : 0u) : displacement_bytes;
    if (encoded_displacement == 1u) {
        if (output) output[at] = (pl_u8)displacement;
        ++at;
    } else if (encoded_displacement == 4u) {
        if (output)
            for (pl_u32 byte = 0u; byte < 4u; ++byte)
                output[at + byte] =
                    (pl_u8)(displacement >> (byte * 8u));
        at += 4u;
    }
    *written = at;
    return 1;
}

static int immediate_matches_signed8(pl_u64 value, pl_u32 bits)
{
    return bits == 64u
         ? value <= 0x7fu || value >= 0xffffffffffffff80ull
         : (pl_u32)value <= 0x7fu || (pl_u32)value >= 0xffffff80u;
}

static int immediate_matches_signed32(pl_u64 value, pl_u32 bits)
{
    return bits == 32u || value <= I32_MAX_VALUE
        || value >= 0xffffffff80000000ull;
}

int pl_select_emit_gpr_move(pl_u32 destination, pl_u32 source, pl_u32 bits,
                         pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || source >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (source >= 8u ? 4u : 0u)
                              | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x89u;
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((source & 7u) << 3u)
                                   | (destination & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_imul_register(pl_u32 destination, pl_u32 source, pl_u32 bits,
                              pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || source >= PL_X86_GPR_COUNT || (bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)((bits == 64u ? 0x48u : 0x40u)
                              | (destination >= 8u ? 4u : 0u)
                              | (source >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x0fu;
    ++at;
    if (output) output[at] = 0xafu;
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((destination & 7u) << 3u)
                                   | (source & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_imul_operand(pl_u32 destination, pl_u32 multiplicand,
                             pl_operand source, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written)
{
    if (source.kind == PL_OPERAND_LOCAL)
        return multiplicand == destination
            && pl_select_emit_imul_register(destination, (pl_u32)source.value, bits, output, written);
    if (source.kind != PL_OPERAND_CONST || destination >= PL_X86_GPR_COUNT
            || multiplicand >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u)) return 0;
    pl_u64 mask = bits == 32u ? U32_MAX_VALUE : U64_MAX_VALUE;
    pl_u64 immediate = source.value & mask;
    if (bits == 64u && immediate > I32_MAX_VALUE
            && immediate < 0xffffffff80000000ull) return 0;
    pl_u32 narrow = immediate <= 127u || immediate >= mask - 127u;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
        | (destination >= 8u ? 4u : 0u) | (multiplicand >= 8u ? 1u : 0u));
    if (rex != 0x40u) { if (output) output[at] = rex; ++at; }
    if (output) {
        output[at] = narrow ? 0x6bu : 0x69u;
        output[at + 1u] = (pl_u8)(0xc0u | ((destination & 7u) << 3u) | (multiplicand & 7u));
        for (pl_u32 i = 0u; i < (narrow ? 1u : 4u); ++i)
            output[at + 2u + i] = (pl_u8)(immediate >> (8u * i));
    }
    *written = at + 2u + (narrow ? 1u : 4u);
    return 1;
}

int pl_select_emit_unsigned_multiply(pl_u32 source, pl_u8 *output,
                                  pl_u32 *written)
{
    if (!written || source >= PL_X86_GPR_COUNT) return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x48u | (source >= 8u ? 1u : 0u));
    if (output) output[at] = rex;
    ++at;
    if (output) output[at] = 0xf7u;
    ++at;
    if (output) output[at] = (pl_u8)(0xe0u | (source & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_indirect_jump(pl_u32 source, pl_u8 *output,
                              pl_u32 *written)
{
    if (!written || source >= PL_X86_GPR_COUNT) return 0;
    pl_u32 at = 0u;
    if (source >= 8u) {
        if (output) output[at] = 0x41u;
        ++at;
    }
    if (output) output[at] = 0xffu;
    ++at;
    if (output) output[at] = (pl_u8)(0xe0u | (source & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_zero_extend_move(pl_u32 destination, pl_u32 source,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written)
{
    if (bits == 32u)
        return pl_select_emit_gpr_move(destination, source, bits, output, written);
    if (!written || destination >= PL_X86_GPR_COUNT
            || source >= PL_X86_GPR_COUNT
            || (bits != 8u && bits != 16u))
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (destination >= 8u ? 4u : 0u)
                              | (source >= 8u ? 1u : 0u));
    if (rex != 0x40u || (bits == 8u && (source & 7u) >= 4u)) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x0fu;
    ++at;
    if (output) output[at] = (pl_u8)(bits == 8u ? 0xb6u : 0xb7u);
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((destination & 7u) << 3u)
                                   | (source & 7u));
    ++at;
    *written = at;
    return 1;
}

/* Without a REX prefix, ModRM byte registers 4..7 are AH/CH/DH/BH.  They
 * are the direct physical spelling of zero_extend((word >> 8) & 0xff); a
 * separate shift node and temporary register would materialize a state which
 * the normalized value never requires. */
int pl_select_emit_zero_extend_high8(pl_u32 destination, pl_u32 source,
                                  pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= 8u || source >= 4u) return 0;
    if (output) {
        output[0] = 0x0fu;
        output[1] = 0xb6u;
        output[2] = (pl_u8)(0xc0u | (destination << 3u)
                                  | (source + 4u));
    }
    *written = 3u;
    return 1;
}

int pl_select_emit_sign_extend_move(pl_u32 destination, pl_u32 source,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || source >= PL_X86_GPR_COUNT
            || (bits != 8u && bits != 16u && bits != 32u))
        return 0;
    if (bits == 32u && !destination && !source) {
        if (output) { output[0] = 0x48u; output[1] = 0x98u; }
        *written = 2u; /* cdqe */
        return 1;
    }
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x48u | (destination >= 8u ? 4u : 0u)
                              | (source >= 8u ? 1u : 0u));
    if (output) output[at] = rex;
    ++at;
    if (bits != 32u) {
        if (output) output[at] = 0x0fu;
        ++at;
    }
    if (output)
        output[at] = bits == 8u ? 0xbeu
                   : bits == 16u ? 0xbfu : 0x63u;
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((destination & 7u) << 3u)
                                   | (source & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_sign_high(pl_u32 destination, pl_u32 source, pl_u32 bits,
                          pl_u8 *output, pl_u32 *written)
{
    if (!written || destination != 2u || source != 0u
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    if (bits == 64u) {
        if (output) output[at] = 0x48u;
        ++at;
    }
    if (output) output[at] = 0x99u;
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_low8_alu_flags(pl_u32 destination, pl_operand right,
                               pl_u32 mode, pl_u8 *output,
                               pl_u32 *written)
{
    static const pl_u8 accumulator_opcode[7] = {
        0x24u, 0x04u, 0x14u, 0x2cu, 0x1cu, 0x0cu, 0x34u,
    };
    static const pl_u8 immediate_group[7] = {
        4u, 0u, 2u, 5u, 3u, 1u, 6u,
    };
    if (!written || destination >= PL_X86_GPR_COUNT || mode > 6u
            || right.kind != PL_OPERAND_CONST || right.value > 0xffu)
        return 0;
    pl_u32 at = 0u;
    if (destination) {
        pl_u8 rex = (pl_u8)(0x40u | (destination >= 8u ? 1u : 0u));
        if (destination >= 8u || (destination & 7u) >= 4u) {
            if (output) output[at] = rex;
            ++at;
        }
        if (output) output[at] = 0x80u;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((pl_u32)immediate_group[mode] << 3u)
                | (destination & 7u));
        ++at;
    } else {
        if (output) output[at] = accumulator_opcode[mode];
        ++at;
    }
    if (output) output[at] = (pl_u8)right.value;
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_scaled_lea(pl_u32 destination, pl_u32 source,
                           pl_u32 bits, pl_u32 scale_log2,
                           pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || source >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u)
            || !scale_log2 || scale_log2 > 3u
            || (source & 7u) == 4u)
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 4u : 0u)
                              | (source >= 8u ? 2u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x8du;
    ++at;
    if (output)
        output[at] = (pl_u8)(((destination & 7u) << 3u) | 4u);
    ++at;
    if (output)
        output[at] = (pl_u8)((scale_log2 << 6u)
                           | ((source & 7u) << 3u) | 5u);
    ++at;
    if (output)
        for (pl_u32 byte = 0u; byte < 4u; ++byte)
            output[at + byte] = 0u;
    at += 4u;
    *written = at;
    return 1;
}

/* The low word of signed IMUL is multiplication modulo 2^bits, so for an
 * encodable positive power of two it is exactly a logical left shift.  The
 * three-operand spelling writes a different owner without first copying the
 * source: dst = src << count is one physical instruction rather than
 * MOV dst,src; SHL dst,count.  For 64-bit words the imm32 is sign-extended,
 * hence only powers through bit 30 are admitted; every 32-bit imm32 denotes
 * the required residue modulo 2^32. */
int pl_select_emit_shifted_copy(pl_u32 destination, pl_u32 source,
                             pl_u32 bits, pl_u32 count,
                             pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || source >= PL_X86_GPR_COUNT || destination == source
            || (bits != 32u && bits != 64u) || !count
            || count >= bits || (bits == 64u && count > 30u))
        return 0;
    pl_u32 factor = 1u << count;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 4u : 0u)
                              | (source >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x69u;
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((destination & 7u) << 3u)
                                   | (source & 7u));
    ++at;
    if (output)
        for (pl_u32 byte = 0u; byte < 4u; ++byte)
            output[at + byte] = (pl_u8)(factor >> (byte * 8u));
    at += 4u;
    *written = at;
    return 1;
}

int pl_select_emit_shift_instruction(pl_u32 destination, pl_operand amount,
                                  pl_u32 bits, pl_u32 group,
                                  pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u)
            || (group != 0u && group != 1u && group != 4u
                && group != 5u && group != 7u))
        return 0;
    int register_count = amount.kind == PL_OPERAND_LOCAL
                      && amount.value == 1u;
    if (!register_count && amount.kind != PL_OPERAND_CONST) return 0;
    /* CL is a subregister of the destination when that destination is RCX.
     * A synthesized seed such as MOV ECX,1 would replace the entry count
     * before SHL RCX,CL reads it. Keep that special physical instruction in
     * the exact source candidate until the selector can prove the seed itself
     * preserves the original low byte. */
    if (register_count && destination == 1u) return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    pl_u32 count_mask = bits == 64u ? 63u : 31u;
    pl_u32 count = register_count ? 0u : (pl_u32)amount.value & count_mask;
    if (output)
        output[at] = register_count ? 0xd3u
                   : count == 1u ? 0xd1u : 0xc1u;
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | (group << 3u)
                                   | (destination & 7u));
    ++at;
    if (!register_count && count != 1u) {
        if (output) output[at] = (pl_u8)count;
        ++at;
    }
    *written = at;
    return 1;
}

int pl_select_emit_bit_set_immediate(pl_u32 destination, pl_u32 bit,
                                  pl_u32 bits, pl_u8 *output,
                                  pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u) || bit >= bits)
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x0fu;
    ++at;
    if (output) output[at] = 0xbau;
    ++at;
    if (output)
        output[at] = (pl_u8)(0xe8u | (destination & 7u));
    ++at;
    if (output) output[at] = (pl_u8)bit;
    ++at;
    *written = at;
    return 1;
}

/* Narrow (8/16-bit) ALU register/immediate encodings.  The 32/64-bit path
 * below keeps its own spelling; this shares the exact opcode/REX rules the
 * compare and flag emitters already use, including the mandatory REX for the
 * 8-bit registers SPL/BPL/SIL/DIL and the 0x66 operand-size prefix.  A partial
 * width operation on a GPR writes only those low bits, which is exactly the
 * physical lane publication the plan records. */
static int emit_narrow_alu_instruction(pl_u32 destination, pl_operand right,
                                       pl_u32 bits, pl_u32 mode,
                                       pl_u8 *output, pl_u32 *written)
{
    static const pl_u8 register_opcode8[7] = {
        0x20u, 0x00u, 0x10u, 0x28u, 0x18u, 0x08u, 0x30u,
    };
    static const pl_u8 register_opcode[7] = {
        0x21u, 0x01u, 0x11u, 0x29u, 0x19u, 0x09u, 0x31u,
    };
    static const pl_u8 accumulator_opcode[7] = {
        0x25u, 0x05u, 0x15u, 0x2du, 0x1du, 0x0du, 0x35u,
    };
    static const pl_u8 accumulator_opcode8[7] = {
        0x24u, 0x04u, 0x14u, 0x2cu, 0x1cu, 0x0cu, 0x34u,
    };
    static const pl_u8 immediate_group[7] = {
        4u, 0u, 2u, 5u, 3u, 1u, 6u,
    };
    if (!written || destination >= PL_X86_GPR_COUNT || mode > 6u
            || (bits != 8u && bits != 16u))
        return 0;
    pl_u32 source = PL_X86_GPR_COUNT;
    if (right.kind == PL_OPERAND_LOCAL) {
        if (right.value >= PL_X86_GPR_COUNT) return 0;
        source = (pl_u32)right.value;
    } else if (right.kind != PL_OPERAND_CONST) {
        return 0;
    }
    pl_u32 at = 0u;
    if (bits == 16u) {
        if (output) output[at] = 0x66u;
        ++at;
    }
    pl_u8 rex = (pl_u8)(0x40u | (destination >= 8u ? 1u : 0u)
        | (source < PL_X86_GPR_COUNT && source >= 8u ? 4u : 0u));
    int force_rex = bits == 8u
        && ((destination & 7u) >= 4u
            || (source < PL_X86_GPR_COUNT && (source & 7u) >= 4u));
    if (rex != 0x40u || force_rex) {
        if (output) output[at] = rex;
        ++at;
    }
    if (right.kind == PL_OPERAND_LOCAL) {
        if (output) output[at] = (pl_u8)(bits == 8u
            ? register_opcode8[mode] : register_opcode[mode]);
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((source & 7u) << 3u) | (destination & 7u));
        ++at;
        *written = at;
        return 1;
    }
    pl_u64 value = right.value;
    if (bits == 8u) {
        if ((value & ~0xffull) != 0 && value < 0xffffffffffffff80ull) return 0;
        if (!destination) {
            if (output) output[at] = accumulator_opcode8[mode];
            ++at;
        } else {
            if (output) output[at] = 0x80u;
            ++at;
            if (output)
                output[at] = (pl_u8)(0xc0u
                    | ((pl_u32)immediate_group[mode] << 3u)
                    | (destination & 7u));
            ++at;
        }
        if (output) output[at] = (pl_u8)value;
        ++at;
        *written = at;
        return 1;
    }
    if ((value & ~0xffffull) != 0 && value < 0xffffffffffff8000ull) return 0;
    int signed8 = (value & ~0xffull) == 0
               || value >= 0xffffffffffffff80ull;
    if (signed8) {
        if (output) output[at] = 0x83u;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((pl_u32)immediate_group[mode] << 3u)
                | (destination & 7u));
        ++at;
        if (output) output[at] = (pl_u8)value;
        ++at;
    } else if (!destination) {
        if (output) output[at] = accumulator_opcode[mode];
        ++at;
        if (output) output[at] = (pl_u8)value;
        ++at;
        if (output) output[at] = (pl_u8)(value >> 8u);
        ++at;
    } else {
        if (output) output[at] = 0x81u;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((pl_u32)immediate_group[mode] << 3u)
                | (destination & 7u));
        ++at;
        if (output) output[at] = (pl_u8)value;
        ++at;
        if (output) output[at] = (pl_u8)(value >> 8u);
        ++at;
    }
    *written = at;
    return 1;
}

int pl_select_emit_alu_instruction(pl_u32 destination, pl_operand right,
                                pl_u32 bits, pl_u32 mode,
                                pl_u32 preserves_carry,
                                pl_u8 *output, pl_u32 *written)
{
    static const pl_u8 register_opcode[7] = {
        0x21u, 0x01u, 0x11u, 0x29u, 0x19u, 0x09u, 0x31u,
    };
    static const pl_u8 accumulator_opcode[7] = {
        0x25u, 0x05u, 0x15u, 0x2du, 0x1du, 0x0du, 0x35u,
    };
    static const pl_u8 immediate_group[7] = {
        4u, 0u, 2u, 5u, 3u, 1u, 6u,
    };
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 8u && bits != 16u
                && bits != 32u && bits != 64u) || mode > 6u)
        return 0;
    if (bits == 8u || bits == 16u) {
        if (preserves_carry) return 0;
        return emit_narrow_alu_instruction(
            destination, right, bits, mode, output, written);
    }
    pl_u32 at = 0u;
    if (preserves_carry) {
        if ((mode != 1u && mode != 3u)
                || right.kind != PL_OPERAND_CONST || right.value != 1u)
            return 0;
        pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
            | (destination >= 8u ? 1u : 0u));
        if (rex != 0x40u) {
            if (output) output[at] = rex;
            ++at;
        }
        if (output) output[at] = 0xffu;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((mode == 3u ? 1u : 0u) << 3u)
                | (destination & 7u));
        ++at;
        *written = at;
        return 1;
    }
    if (right.kind == PL_OPERAND_LOCAL) {
        if (right.value >= PL_X86_GPR_COUNT) return 0;
        pl_u32 source = (pl_u32)right.value;
        pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
            | (source >= 8u ? 4u : 0u)
            | (destination >= 8u ? 1u : 0u));
        if (rex != 0x40u) {
            if (output) output[at] = rex;
            ++at;
        }
        if (output) output[at] = register_opcode[mode];
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((source & 7u) << 3u) | (destination & 7u));
        ++at;
        *written = at;
        return 1;
    }
    /* The ALU production includes its defined flags. A byte OR can preserve
     * the 64-bit value but changes SF/ZF, and a high-byte OR also changes PF.
     * A value-only byte overlay belongs to a separate dead-flag production;
     * it cannot replace this width-specific architectural instruction. */
    if (right.kind != PL_OPERAND_CONST
            || !immediate_matches_signed32(right.value, bits))
        return 0;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
        | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (immediate_matches_signed8(right.value, bits)) {
        if (output) output[at] = 0x83u;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((pl_u32)immediate_group[mode] << 3u)
                | (destination & 7u));
        ++at;
        if (output) output[at] = (pl_u8)right.value;
        ++at;
    } else if (!destination) {
        if (output) output[at] = accumulator_opcode[mode];
        ++at;
        if (output)
            for (pl_u32 byte = 0u; byte < 4u; ++byte)
                output[at + byte] =
                    (pl_u8)(right.value >> (byte * 8u));
        at += 4u;
    } else {
        if (output) output[at] = 0x81u;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | ((pl_u32)immediate_group[mode] << 3u)
                | (destination & 7u));
        ++at;
        if (output)
            for (pl_u32 byte = 0u; byte < 4u; ++byte)
                output[at + byte] =
                    (pl_u8)(right.value >> (byte * 8u));
        at += 4u;
    }
    *written = at;
    return 1;
}

/* Only callers that overwrite these flags before any observation may use a
 * smaller value-only spelling. OR's unchanged upper bits need no work, but
 * the replacement does not promise the original width's SF/ZF/PF. */
int pl_select_emit_alu_value_instruction(pl_u32 destination, pl_operand right,
                                      pl_u32 bits, pl_u32 mode,
                                      pl_u32 preserves_carry,
                                      pl_u8 *output, pl_u32 *written)
{
    if (written && destination < PL_X86_GPR_COUNT && !preserves_carry
            && right.kind == PL_OPERAND_CONST && bits == 64u && mode == 5u
            && right.value) {
        if (!(right.value & ~0xffull))
            return pl_select_emit_low8_alu_flags(destination, right, mode, output, written);
        if (destination < 4u && !(right.value & ~0xff00ull)) {
            if (output) {
                output[0] = 0x80u;
                output[1] = (pl_u8)(0xccu | destination);
                output[2] = (pl_u8)(right.value >> 8u);
            }
            *written = 3u;
            return 1;
        }
    }
    return pl_select_emit_alu_instruction(
        destination, right, bits, mode, preserves_carry, output, written);
}

int pl_select_emit_bswap_register(pl_u32 destination, pl_u32 bits,
                               pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x0fu;
    ++at;
    if (output) output[at] = (pl_u8)(0xc8u | (destination & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_neg_register(pl_u32 destination, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0xf7u;
    ++at;
    if (output) output[at] = (pl_u8)(0xd8u | (destination & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_not_register(pl_u32 destination, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0xf7u;
    ++at;
    if (output) output[at] = (pl_u8)(0xd0u | (destination & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_compare_same(pl_u32 local, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written)
{
    if (!written || local >= PL_X86_GPR_COUNT
            || (bits != 8u && bits != 16u
                && bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    if (bits == 16u) {
        if (output) output[at] = 0x66u;
        ++at;
    }
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
        | (local >= 8u ? 5u : 0u));
    int force_byte_rex = bits == 8u && (local & 7u) >= 4u;
    if (rex != 0x40u || force_byte_rex) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = (pl_u8)(bits == 8u ? 0x38u : 0x39u);
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u
            | ((local & 7u) << 3u) | (local & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_compare_registers(pl_u32 left, pl_u32 right, pl_u32 bits,
                                  pl_u8 *output, pl_u32 *written)
{
    if (!written || left >= PL_X86_GPR_COUNT || right >= PL_X86_GPR_COUNT
            || (bits != 8u && bits != 16u
                && bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    if (bits == 16u) {
        if (output) output[at] = 0x66u;
        ++at;
    }
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (right >= 8u ? 4u : 0u)
                              | (left >= 8u ? 1u : 0u));
    int force_byte_rex = bits == 8u
                      && (((left & 7u) >= 4u) || ((right & 7u) >= 4u));
    if (rex != 0x40u || force_byte_rex) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = (pl_u8)(bits == 8u ? 0x38u : 0x39u);
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((right & 7u) << 3u) | (left & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_compare_operand(pl_u32 left, pl_operand right, pl_u32 bits,
                                pl_u8 *output, pl_u32 *written)
{
    if (right.kind == PL_OPERAND_LOCAL)
        return pl_select_emit_compare_registers(
            left, (pl_u32)right.value, bits, output, written);
    if (!written || left >= PL_X86_GPR_COUNT
            || right.kind != PL_OPERAND_CONST
            || (bits != 8u && bits != 16u
                && bits != 32u && bits != 64u)
            || (bits == 8u && right.value > 0xffu)
            || (bits == 16u && right.value > 0xffffu)
            || (bits == 32u && right.value > 0xffffffffu)
            || (bits == 64u
                && !immediate_matches_signed32(right.value, bits)))
        return 0;
    int narrow = bits != 8u
              && immediate_matches_signed8(right.value, bits);
    pl_u32 at = 0u;
    if (bits == 16u) {
        if (output) output[at] = 0x66u;
        ++at;
    }
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (left >= 8u ? 1u : 0u));
    int force_byte_rex = bits == 8u && (left & 7u) >= 4u;
    if (rex != 0x40u || force_byte_rex) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output)
        output[at] = (pl_u8)(bits == 8u ? 0x80u
                            : narrow ? 0x83u : 0x81u);
    ++at;
    if (output) output[at] = (pl_u8)(0xf8u | (left & 7u));
    ++at;
    if (bits == 8u || narrow) {
        if (output) output[at] = (pl_u8)right.value;
        ++at;
    } else {
        pl_u32 immediate_bytes = bits == 16u ? 2u : 4u;
        if (output)
            for (pl_u32 byte = 0u; byte < immediate_bytes; ++byte)
                output[at + byte] =
                    (pl_u8)(right.value >> (byte * 8u));
        at += immediate_bytes;
    }
    *written = at;
    return 1;
}

int pl_select_emit_conditional_move(pl_u32 destination, pl_u32 source,
                                 pl_u32 bits, pl_u32 condition,
                                 pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || source >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u) || condition > 15u)
        return 0;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 4u : 0u)
                              | (source >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x0fu;
    ++at;
    if (output) output[at] = (pl_u8)(0x40u + condition);
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((destination & 7u) << 3u)
                                   | (source & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_test_registers(pl_u32 left, pl_u32 right, pl_u32 bits,
                               pl_u8 *output, pl_u32 *written)
{
    if (!written || left >= PL_X86_GPR_COUNT || right >= PL_X86_GPR_COUNT
            || (bits != 8u && bits != 16u
                && bits != 32u && bits != 64u))
        return 0;
    pl_u32 at = 0u;
    if (bits == 16u) { if (output) output[at] = 0x66u; ++at; }
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (right >= 8u ? 4u : 0u)
                              | (left >= 8u ? 1u : 0u));
    int force_byte_rex = bits == 8u
                      && (((left & 7u) >= 4u) || ((right & 7u) >= 4u));
    if (rex != 0x40u || force_byte_rex) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = (pl_u8)(bits == 8u ? 0x84u : 0x85u);
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u | ((right & 7u) << 3u) | (left & 7u));
    ++at;
    *written = at;
    return 1;
}

int pl_select_emit_test_operand(pl_u32 left, pl_operand right, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written)
{
    if (right.kind == PL_OPERAND_LOCAL)
        return pl_select_emit_test_registers(
            left, (pl_u32)right.value, bits, output, written);
    if (!written || left >= PL_X86_GPR_COUNT
            || right.kind != PL_OPERAND_CONST
            || (bits != 8u && bits != 16u
                && bits != 32u && bits != 64u)
            || (bits == 8u && right.value > 0xffu)
            || (bits == 16u && right.value > 0xffffu)
            || (bits == 64u && !immediate_matches_signed32(right.value, bits))
            || (bits == 32u && right.value > 0xffffffffu))
        return 0;
    pl_u32 at = 0u;
    if (bits == 16u) { if (output) output[at] = 0x66u; ++at; }
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (left >= 8u ? 1u : 0u));
    int force_byte_rex = bits == 8u && (left & 7u) >= 4u;
    if (rex != 0x40u || force_byte_rex) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = (pl_u8)(bits == 8u ? 0xf6u : 0xf7u);
    ++at;
    if (output) output[at] = (pl_u8)(0xc0u | (left & 7u));
    ++at;
    pl_u32 immediate_bytes = bits == 8u ? 1u
                           : bits == 16u ? 2u : 4u;
    if (output)
        for (pl_u32 byte = 0u; byte < immediate_bytes; ++byte)
            output[at + byte] = (pl_u8)(right.value >> (byte * 8u));
    at += immediate_bytes;
    *written = at;
    return 1;
}

/* AH/CH/DH/BH are the exact physical coordinates of bits 8..15 for the four
 * legacy low registers.  A normalized right-shift node need not become a
 * separate register or a wider TEST when this byte is the final observation. */
int pl_select_emit_high8_test(pl_u32 owner, pl_operand right,
                           pl_u8 *output, pl_u32 *written)
{
    if (!written || owner >= 4u || right.kind != PL_OPERAND_CONST
            || right.value > 0xffu)
        return 0;
    if (output) {
        output[0] = 0xf6u;
        output[1] = (pl_u8)(0xc0u | (owner + 4u));
        output[2] = (pl_u8)right.value;
    }
    *written = 3u;
    return 1;
}

int pl_select_emit_zero_register(pl_u32 local, pl_u8 *output, pl_u32 *written)
{
    if (!written || local >= PL_X86_GPR_COUNT) return 0;
    pl_u32 at = 0u;
    if (local >= 8u) {
        if (output) output[at] = 0x45u;
        ++at;
    }
    if (output) output[at] = 0x31u;
    ++at;
    if (output)
        output[at] = (pl_u8)(0xc0u
            | ((local & 7u) << 3u) | (local & 7u));
    ++at;
    *written = at;
    return 1;
}

/* Write a constant into the low byte or word of a register, preserving the
 * rest.  `insert(base == destination, constant, width)` is exactly this. */
int pl_select_emit_lane_constant_move(pl_u32 destination, pl_u64 constant,
                                   pl_u32 width, pl_u8 *output,
                                   pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (width != 8u && width != 16u))
        return 0;
    pl_u32 at = 0u;
    if (width == 16u) {
        if (output) output[at] = 0x66u;
        ++at;
    }
    pl_u8 rex = (pl_u8)(0x40u | (destination >= 8u ? 1u : 0u));
    if (rex != 0x40u || (width == 8u && destination >= 4u)) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output)
        output[at] = (pl_u8)((width == 8u ? 0xb0u : 0xb8u)
                           | (destination & 7u));
    ++at;
    if (output) output[at] = (pl_u8)constant;
    ++at;
    if (width == 16u) {
        if (output) output[at] = (pl_u8)(constant >> 8u);
        ++at;
    }
    *written = at;
    return 1;
}

int pl_select_emit_set_condition(pl_u32 destination, pl_u32 condition,
                              pl_u8 *output, pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT || condition > 15u)
        return 0;
    pl_u32 at = 0u;
    if (destination >= 8u || (destination & 7u) >= 4u) {
        if (output)
            output[at] = (pl_u8)(0x40u | (destination >= 8u ? 1u : 0u));
        ++at;
    }
    if (output) output[at] = 0x0fu;
    ++at;
    if (output) output[at] = (pl_u8)(0x90u + condition);
    ++at;
    if (output) output[at] = (pl_u8)(0xc0u | (destination & 7u));
    ++at;
    *written = at;
    return 1;
}
