#include "internal/select-x86.h"

static int equal_operand(pl_operand left, pl_operand right);

#define U32_MAX_VALUE 0xffffffffu
#define U64_MAX_VALUE 0xffffffffffffffffull
#define I32_MAX_VALUE 0x7fffffffu

static int append_fixup(pl_x86_native_selection *selection, pl_u8 kind,
                        pl_u8 bytes, pl_u32 at, pl_u32 next_ip_at,
                        pl_u64 target);
static int final_instruction(const pl_x86_frontend *frontend,
                             const pl_x86_block *block,
                             pl_x86_instruction *out);
static int append_control_fixup(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u8 bytes,
    pl_u32 at, pl_u32 next_ip_at, pl_u64 target);
static pl_u32 publication_owner(const pl_plan *plan, pl_operand operand);
static int publication_emits_selected_flag(const pl_plan *plan,
    pl_operand value, pl_u32 destination, pl_u32 flag_node);
static int published_operand_local(const pl_plan *plan, pl_operand value,
                                   pl_u32 *local);
static int zero_result_operand(const pl_plan *plan, pl_operand value);
static int complement_node_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *source, pl_u32 *bits);
static int operand_contains_value(const pl_plan *plan, pl_operand root,
                                  pl_operand value, pl_u32 remaining);
static int arithmetic_tree_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *left, pl_operand *right,
                                   pl_u32 *bits, pl_u32 *mode);
static int shift_node_details(const pl_plan *plan, pl_operand value,
                              pl_operand *source, pl_operand *amount,
                              pl_u32 *bits, pl_u32 *group);
static int measure_alu_pair(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand left,
                            pl_operand right, pl_u32 bits, pl_u32 mode,
                            pl_u32 preserves_carry, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 scratch_mask,
                            pl_u32 *bytes, pl_u32 *instructions);
static int write_alu_pair(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand left,
                          pl_operand right, pl_u32 bits, pl_u32 mode,
                          pl_u32 preserves_carry, pl_u32 output_at,
                          pl_u32 remaining, pl_u32 scratch_mask,
                          pl_u8 *output, pl_u32 *written);
static int write_alu_seed(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand value,
                          pl_u32 bits, pl_u32 output_at,
                          pl_u32 remaining, pl_u8 *output,
                          pl_u32 *written);
static int emit_set_condition(pl_u32 destination, pl_u32 condition,
                              pl_u8 *output, pl_u32 *written);

static int plan_identity(const pl_plan *plan)
{
    if (!plan || plan->node_count || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    for (pl_u32 index = 0u; index < plan->local_count; ++index)
        if (plan->locals[index].kind != PL_OPERAND_LOCAL
                || plan->locals[index].value != index)
            return 0;
    return 1;
}

static int plan_has_memory(const pl_plan *plan)
{
    if (!plan) return 1;
    for (pl_u32 node = 0u; node < plan->node_count; ++node)
        if (pl_opcode_is_memory(plan->nodes[node].opcode)) return 1;
    return 0;
}

static pl_u32 constant_move_bytes(pl_u32 local, pl_u64 value)
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
static int emit_add_lea(pl_u32 destination, pl_operand left,
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

static int emit_gpr_move(pl_u32 destination, pl_u32 source, pl_u32 bits,
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

static int emit_imul_register(pl_u32 destination, pl_u32 source, pl_u32 bits,
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

static int emit_imul_operand(pl_u32 destination, pl_u32 multiplicand,
                             pl_operand source, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written)
{
    if (source.kind == PL_OPERAND_LOCAL)
        return multiplicand == destination
            && emit_imul_register(destination, (pl_u32)source.value, bits, output, written);
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

static int emit_unsigned_multiply(pl_u32 source, pl_u8 *output,
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

static int emit_indirect_jump(pl_u32 source, pl_u8 *output,
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

static int emit_zero_extend_move(pl_u32 destination, pl_u32 source,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written)
{
    if (bits == 32u)
        return emit_gpr_move(destination, source, bits, output, written);
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
static int emit_zero_extend_high8(pl_u32 destination, pl_u32 source,
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

static int emit_sign_extend_move(pl_u32 destination, pl_u32 source,
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

static int emit_sign_high(pl_u32 destination, pl_u32 source, pl_u32 bits,
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

static int emit_low8_alu_flags(pl_u32 destination, pl_operand right,
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

static int emit_scaled_lea(pl_u32 destination, pl_u32 source,
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
static int emit_shifted_copy(pl_u32 destination, pl_u32 source,
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

static int emit_shift_instruction(pl_u32 destination, pl_operand amount,
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

static int emit_bit_set_immediate(pl_u32 destination, pl_u32 bit,
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

static int emit_alu_instruction(pl_u32 destination, pl_operand right,
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
    if (right.kind == PL_OPERAND_CONST && bits == 64u && mode == 5u
            && right.value) {
        pl_u32 byte_register = destination;
        pl_u8 immediate = 0u;
        int byte_form = 0;
        if (!(right.value & ~0xffull)) {
            immediate = (pl_u8)right.value;
            byte_form = 1;
        } else if (destination < 4u
                && !(right.value & ~0xff00ull)) {
            byte_register = destination + 4u;
            immediate = (pl_u8)(right.value >> 8u);
            byte_form = 1;
        }
        if (byte_form) {
            pl_u8 rex = destination >= 8u ? 0x41u
                      : destination >= 4u ? 0x40u : 0u;
            if (rex) {
                if (output) output[at] = rex;
                ++at;
            }
            if (output) output[at] = 0x80u;
            ++at;
            if (output)
                output[at] = (pl_u8)(0xc8u | (byte_register & 7u));
            ++at;
            if (output) output[at] = immediate;
            ++at;
            *written = at;
            return 1;
        }
    }
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

static int emit_bswap_register(pl_u32 destination, pl_u32 bits,
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

static int emit_neg_register(pl_u32 destination, pl_u32 bits,
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

static int emit_not_register(pl_u32 destination, pl_u32 bits,
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

static int emit_compare_same(pl_u32 local, pl_u32 bits,
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

static int emit_compare_registers(pl_u32 left, pl_u32 right, pl_u32 bits,
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

static int emit_compare_operand(pl_u32 left, pl_operand right, pl_u32 bits,
                                pl_u8 *output, pl_u32 *written)
{
    if (right.kind == PL_OPERAND_LOCAL)
        return emit_compare_registers(
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

static int emit_conditional_move(pl_u32 destination, pl_u32 source,
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

static int emit_test_registers(pl_u32 left, pl_u32 right, pl_u32 bits,
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

static int emit_test_operand(pl_u32 left, pl_operand right, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written)
{
    if (right.kind == PL_OPERAND_LOCAL)
        return emit_test_registers(
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
static int emit_high8_test(pl_u32 owner, pl_operand right,
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

static int emit_zero_register(pl_u32 local, pl_u8 *output, pl_u32 *written)
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
static int emit_lane_constant_move(pl_u32 destination, pl_u64 constant,
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

/* A node-free frame is already the complete normal form.  Constants and an
 * acyclic parallel-copy graph need one MOV per changed coordinate.  A copy is
 * emitted only after its destination's old value has no pending reader; this
 * is the shortest flag-preserving schedule without a temporary register.
 * Source operations that disappeared between live copies emit no bytes. */
static int instruction_writes_gpr(const pl_x86_instruction *instruction,
                                  pl_u32 local)
{
    if (!instruction || local >= PL_X86_GPR_COUNT) return 0;
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index) {
        const pl_x86_operand *operand = &instruction->operands[index];
        if (operand->kind == PL_X86_OPERAND_REGISTER
                && operand->value.reg.class_id == PL_X86_REGISTER_GPR
                && operand->value.reg.index == local
                && (operand->flags & (PL_X86_OPERAND_WRITE
                                      | PL_X86_OPERAND_CONDITIONAL_WRITE)))
            return 1;
    }
    return 0;
}

/* Address identity is a build binding, not a scalar constant and not source
 * spelling.  Recover the last defining RIP-relative LEA for a surviving GPR
 * value and carry its linked target as a native fixup rank.  Any intervening
 * write kills the binding.  The emitted frame can then move independently of
 * its source bytes without baking the old instruction coordinate into ELF. */
static int source_address_binding(const pl_x86_frontend *frontend,
                                  const pl_x86_block *block,
                                  pl_u32 local, pl_u64 value,
                                  pl_u64 *target,
                                  pl_u32 *source_at,
                                  pl_u8 *source_bytes)
{
    if (!frontend || !block || !target || !source_at || !source_bytes
            || local >= PL_X86_GPR_COUNT)
        return PL_ERROR_X86_SELECT;
    int found = 0;
    pl_u64 selected = 0u;
    pl_u32 selected_source_at = 0u;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (instruction_writes_gpr(&instruction, local)) {
            found = 0;
            if (instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                    && instruction.visible_operand_count >= 2u
                    && instruction.operands[0].kind
                       == PL_X86_OPERAND_REGISTER
                    && instruction.operands[0].bits == 64u
                    && instruction.operands[0].value.reg.class_id
                       == PL_X86_REGISTER_GPR
                    && instruction.operands[0].value.reg.index == local
                    && instruction.operands[1].kind
                       == PL_X86_OPERAND_MEMORY
                    && instruction.operands[1].value.memory.base.class_id
                       == PL_X86_REGISTER_IP
                    && instruction.displacement_bytes == 4u
                    && instruction.displacement_offset + 4u
                       <= instruction.source_bytes
                    && rip >= block->start
                    && rip - block->start
                       <= U32_MAX_VALUE
                          - instruction.displacement_offset) {
                selected = instruction.fallthrough
                         + (pl_u64)instruction.operands[1]
                                      .value.memory.displacement;
                selected_source_at = (pl_u32)(rip - block->start)
                                   + instruction.displacement_offset;
                found = selected == value;
            }
        }
        rip = instruction.fallthrough;
    }
    if (rip != block->end) return PL_ERROR_X86_SELECT;
    if (found) {
        *target = selected;
        *source_at = selected_source_at;
        *source_bytes = 4u;
    }
    return found;
}

/* Recover an address-valued intermediate even when later arithmetic replaces
 * the destination's final publication.  The relocation field is still the
 * unique authority for that constant; subsequent SSA nodes consume the
 * address value but do not turn it into an untyped integer literal. */
static int source_address_definition_uncached(
    const pl_x86_frontend *frontend,
    const pl_x86_block *block,
    pl_u32 local, pl_u64 value,
    pl_u32 bits, pl_u64 *address,
    pl_u32 *source_at)
{
    if (!frontend || !block || !address || !source_at)
        return PL_ERROR_X86_SELECT;
    /* Address materialisation is a 32/64-bit projection.  A narrower probe is
     * simply not an address definition, not a malformed request; returning the
     * "not found" answer keeps the frame productions total instead of aborting
     * the whole selection (e.g. a byte `sbb al,imm8` value tree). */
    if ((bits != 32u && bits != 64u) || local >= PL_X86_GPR_COUNT)
        return 0;
    pl_u64 mask = bits == 32u ? U32_MAX_VALUE : U64_MAX_VALUE;
    int found = 0;
    int generic_found = 0;
    pl_u64 generic_address = 0u;
    pl_u32 generic_source_at = 0u;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                && instruction.visible_operand_count >= 2u
                && instruction.operands[0].kind == PL_X86_OPERAND_REGISTER
                && instruction.operands[0].bits == 64u
                && instruction.operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && instruction.operands[1].kind == PL_X86_OPERAND_MEMORY
                && instruction.operands[1].value.memory.base.class_id
                   == PL_X86_REGISTER_IP
                && instruction.displacement_bytes == 4u
                && instruction.displacement_offset + 4u
                   <= instruction.source_bytes
                && rip >= block->start
                && rip - block->start
                   <= U32_MAX_VALUE - instruction.displacement_offset) {
            pl_u64 target = instruction.fallthrough
                + (pl_u64)instruction.operands[1].value.memory.displacement;
            if ((target & mask) == (value & mask)) {
                pl_u32 at = (pl_u32)(rip - block->start)
                          + instruction.displacement_offset;
                if (instruction.operands[0].value.reg.index == local) {
                    if (found) return 0;
                    *address = target;
                    *source_at = at;
                    found = 1;
                } else {
                    /* The LEA destination may have been renamed by the
                     * normalizer; a unique target still binds the field. */
                    if (generic_found) return 0;
                    generic_address = target;
                    generic_source_at = at;
                    generic_found = 1;
                }
            }
        }
        rip = instruction.fallthrough;
    }
    if (!found && generic_found) {
        *address = generic_address;
        *source_at = generic_source_at;
        found = 1;
    }
    return rip == block->end ? found : PL_ERROR_X86_SELECT;
}

/* Locating the LEA that defines an address constant re-decodes every
 * instruction of the block.  Frame measurement tries a const materialisation
 * at every level of the operand recursion, so the same (block, local, value)
 * probe runs thousands of times per block.  Memoise it with a generation stamp
 * bumped once per candidate enumeration, so no O(cache) reset is needed. */
#define PL_SOURCE_ADDR_MEMO 4096u

typedef struct {
    pl_u32 generation;
    pl_u64 start, end, value;
    pl_u32 local, bits;
    pl_u64 address;
    pl_u32 source_at;
    pl_u8 found;
} source_addr_memo_entry;

static source_addr_memo_entry source_addr_memo[PL_SOURCE_ADDR_MEMO];
static pl_u32 source_addr_generation = 1u;

static int source_address_definition(const pl_x86_frontend *frontend,
                                     const pl_x86_block *block,
                                     pl_u32 local, pl_u64 value,
                                     pl_u32 bits, pl_u64 *address,
                                     pl_u32 *source_at)
{
    if (!frontend || !block || !address || !source_at)
        return PL_ERROR_X86_SELECT;
    /* Address materialisation is a 32/64-bit projection.  A narrower probe is
     * simply not an address definition, not a malformed request; returning the
     * "not found" answer keeps the frame productions total instead of aborting
     * the whole selection (e.g. a byte `sbb al,imm8` value tree). */
    if ((bits != 32u && bits != 64u) || local >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 key = (pl_u32)(block->start * 2654435761u)
               ^ (pl_u32)(block->end * 2246822519u)
               ^ ((pl_u32)local * 3266489917u)
               ^ (pl_u32)(value * 668265263u) ^ bits;
    source_addr_memo_entry *memo =
        &source_addr_memo[key & (PL_SOURCE_ADDR_MEMO - 1u)];
    if (memo->generation == source_addr_generation
            && memo->start == block->start && memo->end == block->end
            && memo->local == local && memo->value == value
            && memo->bits == bits) {
        if (!memo->found) return 0;
        *address = memo->address;
        *source_at = memo->source_at;
        return 1;
    }
    int status = source_address_definition_uncached(
        frontend, block, local, value, bits, address, source_at);
    if (status == 0 || status == 1) {
        memo->generation = source_addr_generation;
        memo->start = block->start;
        memo->end = block->end;
        memo->local = local;
        memo->value = value;
        memo->bits = bits;
        memo->found = (pl_u8)status;
        if (status == 1) {
            memo->address = *address;
            memo->source_at = *source_at;
        }
    }
    return status;
}

/* Every removed source relocation field must retain one exact owner in the
 * normalized spelling.  Multiple LEAs of the same linked address are binding
 * aliases, not distinct runtime work: attach all source fields to the one
 * surviving RIP fixup.  If any target has no owner, this candidate is not a
 * closed native representation and source spelling remains the diagnostic. */
static int alias_source_address_fields(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return PL_ERROR_X86_SELECT;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                && instruction.visible_operand_count >= 2u
                && instruction.operands[1].kind == PL_X86_OPERAND_MEMORY
                && instruction.operands[1].value.memory.base.class_id
                   == PL_X86_REGISTER_IP
                && instruction.displacement_bytes == 4u
                && instruction.displacement_offset + 4u
                   <= instruction.source_bytes
                && rip >= block->start
                && rip - block->start
                   <= U32_MAX_VALUE - instruction.displacement_offset) {
            pl_u32 source_at = (pl_u32)(rip - block->start)
                             + instruction.displacement_offset;
            int owned = 0;
            for (pl_u32 fixup = 0u; fixup < selection->fixup_count; ++fixup)
                if (selection->fixups[fixup].source_bytes == 4u
                        && selection->fixups[fixup].source_at == source_at) {
                    owned = 1;
                    break;
                }
            if (!owned) {
                pl_u64 target = instruction.fallthrough
                    + (pl_u64)instruction.operands[1]
                                      .value.memory.displacement;
                pl_u32 owner = selection->fixup_count;
                for (pl_u32 fixup = 0u;
                        fixup < selection->fixup_count; ++fixup)
                    if (selection->fixups[fixup].kind
                           == PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                            && selection->fixups[fixup].target == target) {
                        owner = fixup;
                        break;
                    }
                if (owner == selection->fixup_count) return 0;
                pl_x86_native_fixup canonical = selection->fixups[owner];
                status = append_fixup(
                    selection, canonical.kind, canonical.bytes,
                    canonical.at, canonical.next_ip_at, canonical.target);
                if (status) return status;
                selection->fixups[selection->fixup_count - 1u].source_at =
                    source_at;
                selection->fixups[selection->fixup_count - 1u].source_bytes =
                    4u;
            }
        }
        rip = instruction.fallthrough;
    }
    return rip == block->end ? 1 : PL_ERROR_X86_SELECT;
}

/* An absolute construction expression may disappear under constant
 * substitution even though its final address remains live.  All eight-byte
 * source immediate fields can share one canonical MOVABS field; the output
 * fixup carries the final linked target, while source offsets remain separate
 * binding ranks for relocation closure. */
static int append_absolute_source_fields(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    pl_u32 output_at, pl_u64 target)
{
    if (!frontend || !block || !selection) return PL_ERROR_X86_SELECT;
    if (!block->construction_fields) return 0;
    if (output_at > U32_MAX_VALUE - 10u) return PL_ERROR_X86_SELECT;
    pl_u32 fields = 0u;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        for (pl_u32 immediate = 0u; immediate < 2u; ++immediate) {
            if (instruction.immediate_bytes[immediate] != 8u
                    || instruction.immediate_offset[immediate] + 8u
                       > instruction.source_bytes
                    || rip < block->start
                    || rip - block->start
                       > U32_MAX_VALUE
                          - instruction.immediate_offset[immediate])
                continue;
            status = append_fixup(
                selection, PL_X86_NATIVE_FIXUP_ABSOLUTE, 8u,
                output_at + 2u, output_at + 10u, target);
            if (status) return status;
            selection->fixups[selection->fixup_count - 1u].source_at =
                (pl_u32)(rip - block->start)
                + instruction.immediate_offset[immediate];
            selection->fixups[selection->fixup_count - 1u].source_bytes =
                8u;
            ++fields;
        }
        rip = instruction.fallthrough;
    }
    return rip == block->end ? (int)fields : PL_ERROR_X86_SELECT;
}

static int measure_frame_value(const pl_x86_frontend *frontend,
                               const pl_x86_block *block,
                               pl_x86_native_selection *selection,
                               pl_u32 local, pl_operand value,
                               pl_u32 output_at, pl_u32 *bytes)
{
    if (!frontend || !block || !selection || !bytes
            || local >= PL_X86_GPR_COUNT)
        return PL_ERROR_X86_SELECT;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        *bytes = 3u;
        return 1;
    }
    if (value.kind != PL_OPERAND_CONST) return 0;
    pl_u64 target = 0u;
    pl_u32 source_at = 0u;
    pl_u8 source_bytes = 0u;
    int address = source_address_binding(
        frontend, block, local, value.value,
        &target, &source_at, &source_bytes);
    if (address < 0) return address;
    if (!address) {
        *bytes = constant_move_bytes(local, value.value);
        return 1;
    }
    if (output_at > U32_MAX_VALUE - 7u) return PL_ERROR_X86_SELECT;
    int status = append_fixup(
        selection, PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT, 4u,
        output_at + 3u, output_at + 7u, target);
    if (status) return status;
    selection->fixups[selection->fixup_count - 1u].source_at = source_at;
    selection->fixups[selection->fixup_count - 1u].source_bytes =
        source_bytes;
    *bytes = 7u;
    return 1;
}

static int measure_direct_frame(const pl_x86_frontend *frontend,
                                const pl_x86_block *block,
                                pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && ((!block->dynamic_target
                     && block->successor_count != 1u)
                    || (block->dynamic_target
                        && block->successor_count != 0u)))
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (plan->node_count || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_u32 changed = 0u;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT
                || (value.kind != PL_OPERAND_CONST
                    && value.kind != PL_OPERAND_LOCAL)
                || (value.kind == PL_OPERAND_LOCAL
                    && value.value >= PL_X86_GPR_COUNT))
            return 0;
        changed |= 1u << local;
    }
    pl_u32 bytes = 0u;
    pl_u32 instructions = 0u;
    pl_u32 pending = changed;
    while (pending) {
        pl_u32 needed = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local))) continue;
            pl_operand value = plan->locals[local];
            if (value.kind == PL_OPERAND_LOCAL)
                needed |= 1u << (pl_u32)value.value;
        }
        pl_u32 local = 0u;
        while (local < PL_X86_GPR_COUNT
                && (!(pending & (1u << local))
                    || (needed & (1u << local))))
            ++local;
        if (local == PL_X86_GPR_COUNT) return 0;
        pl_operand value = plan->locals[local];
        pl_u32 encoded = 0u;
        int measured = measure_frame_value(
            frontend, block, selection, local, value, bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (!instructions) return 0;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = 0u;
        pl_u32 target_owner = PL_X86_GPR_COUNT;
        if (block->dynamic_target) {
            if (!published_operand_local(
                    plan, block->target, &target_owner)
                    || !emit_indirect_jump(
                        target_owner, 0, &branch_bytes))
                return 0;
        } else {
            branch_bytes = block->relax_short_control ? 5u : 2u;
        }
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        if (!block->dynamic_target) {
            int status = append_control_fixup(
                frontend, block, selection,
                (pl_u8)(block->relax_short_control ? 4u : 1u),
                bytes + 1u, bytes + branch_bytes, block->successor[0]);
            if (status) return status;
        }
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int equal_compare_frame_shape(const pl_plan *plan,
                                     pl_u32 *changed,
                                     pl_u32 *anchor,
                                     pl_u32 *bits,
                                     pl_u64 *value)
{
    if (!plan || !changed || !anchor || !bits || !value
            || plan->node_count != 1u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->opcode != PL_OPCODE_X86_COMPARE
            || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[1].kind != PL_OPERAND_CONST
            || argument[2].kind != PL_OPERAND_CONST
            || argument[1].value != argument[2].value
            || argument[3].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[3].value;
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 mode = ((pl_u32)descriptor >> 8u) & 7u;
    if ((width != 32u && width != 64u)
            || mode != 3u || (descriptor >> 11u))
        return 0;
    pl_u32 mask = 0u;
    pl_u32 first = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand publication = plan->locals[local];
        if (local == PL_X86_RFLAGS_LOCAL) {
            if (publication.kind != PL_OPERAND_NODE
                    || publication.value != 1u)
                return 0;
            continue;
        }
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT
                || publication.kind != PL_OPERAND_CONST)
            return 0;
        mask |= 1u << local;
        if (publication.value == argument[1].value
                && first == PL_X86_GPR_COUNT)
            first = local;
    }
    if (!mask || first == PL_X86_GPR_COUNT) return 0;
    *changed = mask;
    *anchor = first;
    *bits = width;
    *value = argument[1].value;
    return 1;
}

static int common_constant_frame_shape(const pl_plan *plan,
                                       pl_u32 *changed,
                                       pl_u32 *anchor,
                                       pl_u64 *value)
{
    if (!plan || !changed || !anchor || !value || plan->node_count
            || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_u32 mask = 0u;
    pl_u32 first = PL_X86_GPR_COUNT;
    pl_u64 common = 0u;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand publication = plan->locals[local];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT
                || publication.kind != PL_OPERAND_CONST)
            return 0;
        if (first == PL_X86_GPR_COUNT) {
            first = local;
            common = publication.value;
        } else if (publication.value != common) {
            return 0;
        }
        mask |= 1u << local;
    }
    if (first == PL_X86_GPR_COUNT || !(mask & (mask - 1u))) return 0;
    *changed = mask;
    *anchor = first;
    *value = common;
    return 1;
}

/* After complete-future projection, an x-x compare may disappear while its
 * equal address publications remain. Their necessary-and-sufficient native
 * form is one address materialization plus register fanout; independently
 * materializing each equal constant would increase both bytes and work just
 * because the dead flag node was removed. */
static int measure_direct_common_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 1u)
        return 0;
    pl_u32 changed = 0u, anchor = 0u;
    pl_u64 common = 0u;
    if (!common_constant_frame_shape(
            &block->plan, &changed, &anchor, &common))
        return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_u64 target = 0u;
        pl_u32 source_at = 0u;
        pl_u8 source_bytes = 0u;
        int address = source_address_binding(
            frontend, block, local, common,
            &target, &source_at, &source_bytes);
        if (address < 0) return address;
        if (address) {
            anchor = local;
            break;
        }
    }
    pl_operand common_value = { PL_OPERAND_CONST, common };
    pl_u32 bytes = 0u, encoded = 0u;
    int measured = measure_frame_value(
        frontend, block, selection, anchor,
        common_value, bytes, &encoded);
    if (measured <= 0) return measured;
    bytes += encoded;
    pl_u32 primary_fixup = selection->fixup_count;
    if (primary_fixup) --primary_fixup;
    int absolute_bound = 0;
    pl_u32 instructions = 1u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        int absolute = !absolute_bound
            ? append_absolute_source_fields(
                frontend, block, selection, bytes, common)
            : 0;
        if (absolute < 0) return absolute;
        pl_u32 publication_bytes = absolute ? 10u : 3u;
        if (bytes > U32_MAX_VALUE - publication_bytes)
            return PL_ERROR_X86_SELECT;
        bytes += publication_bytes;
        absolute_bound |= absolute != 0;
        pl_u64 target = 0u;
        pl_u32 source_at = 0u;
        pl_u8 source_bytes = 0u;
        int address = source_address_binding(
            frontend, block, local, common,
            &target, &source_at, &source_bytes);
        if (address < 0) return address;
        if (address) {
            if (!selection->fixup_count
                    || selection->fixups[primary_fixup].kind
                       != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                    || selection->fixups[primary_fixup].target != target)
                return 0;
            pl_x86_native_fixup owner = selection->fixups[primary_fixup];
            int status = append_fixup(
                selection, owner.kind, owner.bytes,
                owner.at, owner.next_ip_at, owner.target);
            if (status) return status;
            selection->fixups[selection->fixup_count - 1u].source_at =
                source_at;
            selection->fixups[selection->fixup_count - 1u].source_bytes =
                source_bytes;
        }
        ++instructions;
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_common_frame = 1u;
    selection->frame_anchor = (pl_u8)anchor;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* An equal compare publishes independent GPR bindings and exact x-x flags.
 * Materialize the compared value once, fan out only equal bindings, emit
 * unrelated constants independently, then compare the owner with itself.
 * Source LEA fields alias their surviving target field, never the topology. */
static int measure_direct_equal_compare_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 1u)
        return 0;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    pl_u64 common = 0u;
    if (!equal_compare_frame_shape(
            &block->plan, &changed, &anchor, &bits, &common))
        return 0;
    /* Prefer a surviving linked-address owner for the common value.  This is
     * a binding choice only; the compare topology remains one class. */
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))
                || block->plan.locals[local].value != common)
            continue;
        pl_u64 target = 0u;
        pl_u32 source_at = 0u;
        pl_u8 source_bytes = 0u;
        int address = source_address_binding(
            frontend, block, local, common,
            &target, &source_at, &source_bytes);
        if (address < 0) return address;
        if (address) {
            anchor = local;
            break;
        }
    }
    pl_u32 bytes = 0u;
    pl_u32 encoded = 0u;
    pl_operand common_value = { PL_OPERAND_CONST, common };
    int measured = measure_frame_value(
        frontend, block, selection, anchor,
        common_value, bytes, &encoded);
    if (measured <= 0) return measured;
    bytes += encoded;
    pl_u32 primary_fixup = selection->fixup_count;
    if (primary_fixup) --primary_fixup;
    pl_u32 publications = 1u;
    int absolute_bound = 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        pl_operand publication = block->plan.locals[local];
        if (publication.value == common) {
            int absolute = !absolute_bound
                ? append_absolute_source_fields(
                    frontend, block, selection, bytes, common)
                : 0;
            if (absolute < 0) return absolute;
            pl_u32 publication_bytes = absolute ? 10u : 3u;
            if (bytes > U32_MAX_VALUE - publication_bytes)
                return PL_ERROR_X86_SELECT;
            bytes += publication_bytes;
            absolute_bound |= absolute != 0;
            pl_u64 target = 0u;
            pl_u32 source_at = 0u;
            pl_u8 source_bytes = 0u;
            int address = source_address_binding(
                frontend, block, local, common,
                &target, &source_at, &source_bytes);
            if (address < 0) return address;
            if (address) {
                if (!selection->fixup_count
                        || selection->fixups[primary_fixup].kind
                           != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                        || selection->fixups[primary_fixup].target != target)
                    return 0;
                pl_x86_native_fixup owner = selection->fixups[primary_fixup];
                int status = append_fixup(
                    selection, owner.kind, owner.bytes,
                    owner.at, owner.next_ip_at, owner.target);
                if (status) return status;
                selection->fixups[selection->fixup_count - 1u].source_at =
                    source_at;
                selection->fixups[selection->fixup_count - 1u].source_bytes =
                    source_bytes;
            }
        } else {
            encoded = 0u;
            int other = measure_frame_value(
                frontend, block, selection, local,
                publication, bytes, &encoded);
            if (other <= 0) return other;
            if (bytes > U32_MAX_VALUE - encoded)
                return PL_ERROR_X86_SELECT;
            bytes += encoded;
        }
        ++publications;
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 compare_bytes = 0u;
    if (!emit_compare_same(anchor, bits, 0, &compare_bytes)
            || bytes > U32_MAX_VALUE - compare_bytes)
        return 0;
    bytes += compare_bytes;
    pl_u32 instructions = publications + 1u;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (bytes > U32_MAX_VALUE - 5u) return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection, 4u,
            bytes + 1u, bytes + 5u, block->successor[0]);
        if (status) return status;
        bytes += 5u;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_compare_frame = 1u;
    selection->frame_anchor = (pl_u8)anchor;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int constant_sar_zero_frame_shape(const pl_plan *plan,
                                         pl_u32 *changed,
                                         pl_u32 *anchor,
                                         pl_u32 *bits)
{
    if (!plan || !changed || !anchor || !bits
            || plan->node_count != 1u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->opcode != PL_OPCODE_X86_SHIFT_FLAGS
            || node->argument_count != 5u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != PL_OPERAND_CONST || argument[1].value
            || argument[2].kind != PL_OPERAND_CONST || argument[2].value
            || argument[3].kind != PL_OPERAND_CONST
            || argument[3].value != 1u
            || argument[4].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 group = ((pl_u32)descriptor >> 8u) & 7u;
    if ((width != 32u && width != 64u)
            || group != 7u || descriptor != (pl_u64)(width | (7u << 8u)))
        return 0;
    pl_u32 mask = 0u;
    pl_u32 zero = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand publication = plan->locals[local];
        if (local == PL_X86_RFLAGS_LOCAL) {
            if (publication.kind != PL_OPERAND_NODE
                    || publication.value != 1u)
                return 0;
            continue;
        }
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT
                || publication.kind != PL_OPERAND_CONST)
            return 0;
        mask |= 1u << local;
        if (!publication.value && zero == PL_X86_GPR_COUNT) zero = local;
    }
    if (!mask || zero == PL_X86_GPR_COUNT) return 0;
    *changed = mask;
    *anchor = zero;
    *bits = width;
    return 1;
}

/* `sar 0,1` publishes exactly the same modeled flag word as `cmp z,z` for a
 * zero GPR: CF/PF/ZF/SF/OF are identical and all other architectural bits are
 * preserved.  Constants and addresses remain independent rank bindings, and
 * the already-decided control arm is emitted once. */
static int measure_direct_constant_shift_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 1u)
        return 0;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    if (!constant_sar_zero_frame_shape(
            &block->plan, &changed, &anchor, &bits))
        return 0;
    pl_u32 bytes = 0u, instructions = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_operand value = block->plan.locals[local];
        pl_u32 encoded = 0u;
        int measured;
        if (!value.value) {
            measured = emit_zero_register(local, 0, &encoded);
        } else {
            measured = measure_frame_value(
                frontend, block, selection,
                local, value, bytes, &encoded);
        }
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 compare_bytes = 0u;
    if (!emit_compare_same(anchor, bits, 0, &compare_bytes)
            || bytes > U32_MAX_VALUE - compare_bytes)
        return 0;
    bytes += compare_bytes;
    ++instructions;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (bytes > U32_MAX_VALUE - 5u) return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection, 4u,
            bytes + 1u, bytes + 5u, block->successor[0]);
        if (status) return status;
        bytes += 5u;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shift_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int add_frame_shape(const pl_plan *plan, pl_u32 *node_destination,
                           pl_u32 *bits, pl_u32 *changed)
{
    if (!plan || !node_destination || !bits || !changed
            || plan->node_count != 1u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->opcode == PL_OPCODE_ADD) *bits = 64u;
    else if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[0][1]) *bits = 32u;
    else return 0;
    for (pl_u32 argument = 0u; argument < 2u; ++argument) {
        pl_operand value = plan->arguments[node->argument_at + argument];
        if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT))
            return 0;
    }
    *node_destination = PL_X86_GPR_COUNT;
    *changed = 0u;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (value.kind == PL_OPERAND_NODE) {
            if (value.value != 1u
                    || *node_destination != PL_X86_GPR_COUNT)
                return 0;
            *node_destination = local;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        *changed |= 1u << local;
    }
    return *node_destination < PL_X86_GPR_COUNT;
}

static int add_frame_sources(const pl_plan *plan, pl_u32 local,
                             pl_u32 node_destination, pl_u32 *sources)
{
    if (!plan || !sources || local >= PL_X86_GPR_COUNT) return 0;
    *sources = 0u;
    if (local == node_destination) {
        const pl_node *node = &plan->nodes[0];
        for (pl_u32 argument = 0u; argument < 2u; ++argument) {
            pl_operand value = plan->arguments[
                node->argument_at + argument];
            if (value.kind == PL_OPERAND_LOCAL)
                *sources |= 1u << (pl_u32)value.value;
        }
        return 1;
    }
    pl_operand value = plan->locals[local];
    if (value.kind == PL_OPERAND_LOCAL)
        *sources = 1u << (pl_u32)value.value;
    return 1;
}

static int next_add_frame_assignment(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 node_destination,
                                     pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_u32 used_by_others = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            pl_u32 sources = 0u;
            if (!add_frame_sources(
                    plan, other, node_destination, &sources))
                return 0;
            used_by_others |= sources;
        }
        if (!(used_by_others & (1u << local))) {
            *selected = local;
            return 1;
        }
    }
    return 0;
}

static int measure_direct_add_frame(const pl_x86_frontend *frontend,
                                    const pl_x86_block *block,
                                    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 node_destination, bits, changed;
    if (!add_frame_shape(
            &block->plan, &node_destination, &bits, &changed))
        return 0;
    pl_u32 pending = changed;
    pl_u32 bytes = 0u;
    pl_u32 instructions = 0u;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_add_frame_assignment(
                &block->plan, pending, node_destination, &local))
            return 0;
        pl_u32 encoded = 0u;
        if (local == node_destination) {
            const pl_node *node = &block->plan.nodes[0];
            if (!emit_add_lea(
                    local,
                    block->plan.arguments[node->argument_at],
                    block->plan.arguments[node->argument_at + 1u],
                    bits, (pl_u8 *)0, &encoded))
                return 0;
        } else {
            pl_operand value = block->plan.locals[local];
            int measured = measure_frame_value(
                frontend, block, selection, local, value, bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_add_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int alu_node_semantics(const pl_plan *plan, pl_u32 node_number,
                              pl_operand *source, pl_operand *right,
                              pl_u32 *bits, pl_u32 *mode,
                              pl_u32 *preserves_carry)
{
    if (!plan || !node_number || node_number > plan->node_count
            || !source || !right || !bits || !mode
            || !preserves_carry)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_X86_ALU || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value != PL_X86_RFLAGS_LOCAL
            || (arguments[1].kind != PL_OPERAND_CONST
                && (arguments[1].kind != PL_OPERAND_LOCAL
                    || arguments[1].value >= PL_X86_GPR_COUNT)
                && (arguments[1].kind != PL_OPERAND_NODE
                    || !arguments[1].value
                    || arguments[1].value >= node_number))
            || (arguments[2].kind != PL_OPERAND_CONST
                && (arguments[2].kind != PL_OPERAND_LOCAL
                    || arguments[2].value >= PL_X86_GPR_COUNT)
                && (arguments[2].kind != PL_OPERAND_NODE
                    || !arguments[2].value
                    || arguments[2].value >= node_number)
                && (arguments[2].kind != PL_OPERAND_PROJECTION
                    || !(arguments[2].value >> 8u)
                    || (arguments[2].value >> 8u) >= node_number))
            || arguments[3].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = arguments[3].value;
    *bits = (pl_u32)(descriptor & 0x7fu);
    *mode = (pl_u32)((descriptor >> 8u) & 7u);
    *preserves_carry = (pl_u32)((descriptor >> 11u) & 1u);
    if ((*bits != 32u && *bits != 64u) || *mode > 6u
            || descriptor
               != ((pl_u64)*bits | ((pl_u64)*mode << 8u)
                   | ((pl_u64)*preserves_carry << 11u)))
        return 0;
    *source = arguments[1];
    *right = arguments[2];
    return 1;
}

static int alu_node_details(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *destination, pl_operand *source,
                            pl_operand *right,
                            pl_u32 *bits, pl_u32 *mode,
                            pl_u32 *preserves_carry)
{
    if (!destination || !alu_node_semantics(
            plan, node_number, source, right,
            bits, mode, preserves_carry))
        return 0;
    pl_operand result = {
        PL_OPERAND_PROJECTION, ((pl_u64)node_number << 8u) | 16u,
    };
    *destination = publication_owner(plan, result);
    return *destination < PL_X86_GPR_COUNT;
}

static int zero_extend_node(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_LANE64_INSERT
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_CONST || arguments[0].value
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    if (arguments[1].kind == PL_OPERAND_LOCAL
            && arguments[1].value < PL_X86_GPR_COUNT) {
        *source = (pl_u32)arguments[1].value;
    } else if ((arguments[1].kind == PL_OPERAND_NODE
                || arguments[1].kind == PL_OPERAND_PROJECTION)
            && published_operand_local(plan, arguments[1], source)) {
        /* The inner node already has one architectural owner.  Reading that
         * owner is the exact physical projection; rebuilding the subtree
         * would add both work and a false dependency wave. */
    } else {
        return 0;
    }
    *bits = (pl_u32)arguments[2].value;
    return 1;
}

/* `insert(0, inner, width)` is a pure lane extension: the result is the low
 * `width` bits of `inner`, zero-extended.  Unlike zero_extend_node this
 * returns the inserted operand whatever its kind, so a caller can materialize
 * an inner value that has no publication yet. */
static int zero_extend_operand(const pl_plan *plan, pl_u32 node_number,
                               pl_operand *inner, pl_u32 *width)
{
    if (!plan || !inner || !width || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if ((node->opcode != PL_OPCODE_LANE64_INSERT
                && node->opcode != PL_OPCODE_LANE32_INSERT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_CONST || arguments[0].value
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    *inner = arguments[1];
    *width = (pl_u32)arguments[2].value;
    return 1;
}

static int sign_extend_value(const pl_plan *plan, pl_u32 node_number,
                             pl_operand *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    *bits = node->opcode == PL_OPCODE_LANE64_EXTEND8_S ? 8u
          : node->opcode == PL_OPCODE_LANE64_EXTEND16_S ? 16u
          : node->opcode == PL_OPCODE_EXTEND32_S ? 32u : 0u;
    if (!*bits || node->argument_count != 1u
            || node->argument_at >= plan->argument_count)
        return 0;
    *source = plan->arguments[node->argument_at];
    return 1;
}

/* lane{32,64}.and(x, all_ones) is the identity on that lane: the low word is
 * unchanged and the lane's own width already zero-extends.  A 32-bit mask over
 * an arbitrary 64-bit base is only redundant when the publication is emitted
 * at the same 32-bit width (an ordinary 32-bit register move zero-extends);
 * the frame therefore drops the mask only for a lane-width publication whose
 * destination move already performs the narrowing. */
static int lane_identity_mask_details(const pl_plan *plan, pl_operand value,
                                      pl_operand *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    pl_u64 mask = 0u;
    if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[0][0]) {
        mask = 0xffffffffull;
        *bits = 32u;
    } else if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[1][0]
            || node->opcode == PL_OPCODE_ALU_REGISTER[1][0]) {
        /* A lane64 register AND whose second operand is a full-mask constant
         * is the same lane identity as the immediate spelling. */
        mask = U64_MAX_VALUE;
        *bits = 64u;
    } else {
        return 0;
    }
    if (node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[1].kind != PL_OPERAND_CONST || arguments[1].value != mask)
        return 0;
    /* Keep the rewrite total: only a register-resident base is guaranteed to
     * materialize at the lane width without another production's help. */
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value >= PL_X86_GPR_COUNT) {
        return 0;
    }
    *source = arguments[0];
    return 1;
}

static int sign_extend_node(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *source, pl_u32 *bits)
{
    pl_operand argument;
    if (!source || !sign_extend_value(plan, node_number, &argument, bits))
        return 0;
    if (argument.kind != PL_OPERAND_LOCAL
            || argument.value >= PL_X86_GPR_COUNT)
        return 0;
    *source = (pl_u32)argument.value;
    return 1;
}

/* One dense arithmetic frame may publish several mutually independent SSA
 * nodes.  Pure nodes whose x86 flags are dead use the same publication
 * grammar as architectural ALU nodes; requiring an RFLAGS result here would
 * reopen the exact source spelling at every memory/control cut.
 * Their logical inputs are versioned entry locals, so textual x86 order is
 * only a register-allocation constraint.  Every live result must have one
 * architectural GPR projection; the final flag node is recorded separately
 * so dead intermediate flags never impose a false dependency wave. */
static int alu_frame_shape(const pl_plan *plan, pl_u32 *changed,
                           pl_u32 *final_flag_node)
{
    if (!plan || !changed || !final_flag_node || !plan->node_count
            || plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    *changed = 0u;
    *final_flag_node = 0u;
    pl_u32 alu_nodes = 0u;
    pl_u32 derived_publications = 0u;
    for (pl_u32 node = 1u; node <= plan->node_count; ++node) {
        if (plan->nodes[node - 1u].opcode != PL_OPCODE_X86_ALU)
            continue;
        pl_u32 bits, mode, preserves_carry;
        pl_operand source;
        pl_operand right;
        if (!alu_node_semantics(
                plan, node, &source, &right,
                &bits, &mode, &preserves_carry))
            return 0;
        pl_operand result = {
            PL_OPERAND_PROJECTION, ((pl_u64)node << 8u) | 16u,
        };
        pl_u32 destination = publication_owner(plan, result);
        if (destination < PL_X86_GPR_COUNT) {
            if (*changed & (1u << destination)) return 0;
            *changed |= 1u << destination;
        }
        (void)source;
        ++alu_nodes;
    }
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (local == PL_X86_RFLAGS_LOCAL) {
            if (value.kind == PL_OPERAND_LOCAL
                    && value.value == PL_X86_RFLAGS_LOCAL)
                continue;
            if (value.kind != PL_OPERAND_NODE || !value.value
                    || value.value > plan->node_count)
                return 0;
            *final_flag_node = (pl_u32)value.value;
            continue;
        }
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (value.kind == PL_OPERAND_PROJECTION) {
            if (!(value.value >> 8u)
                    || (value.value >> 8u) > plan->node_count
                    || (value.value & 0xffu) != 16u)
                return 0;
            ++derived_publications;
        } else if (value.kind == PL_OPERAND_NODE) {
            if (!value.value || value.value > plan->node_count)
                return 0;
            ++derived_publications;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        *changed |= 1u << local;
    }
    /* A flag-only X86_ALU (its value dead because the coordinate is rewritten
     * by a constant copy) is a legal frame when the flags reach a conditional
     * select: the select's compare path emits the tested operation itself.
     * Requiring a GPR value publication here rejected those blocks. */
    (void)alu_nodes;
    /* Flags are a publication even when no GPR changes. Their entry operands
     * use the same scheduling law as a frame containing value publications. */
    return (*changed && derived_publications) || *final_flag_node;
}

typedef struct {
    pl_u32 node_sources;
    pl_u32 node_depth;
    pl_u32 projection_sources;
    pl_u32 projection_depth;
} gpr_source_row;

/* Source ownership is a projection of the topologically numbered SSA DAG.
 * Expanding it recursively treats every shared node as a fresh tree once per
 * candidate and is exponential on precisely the large affine/ALU blocks the
 * product compiler must close.  A row is the complete law for one node and
 * its physical ALU-result projection; depth preserves the old recursion
 * budget exactly, with zero denoting an invalid spelling. */
static int gpr_source_operand_law(
    const pl_plan *plan, pl_operand operand, pl_u32 available_nodes,
    const gpr_source_row *row, pl_u32 *sources, pl_u32 *depth)
{
    if (!plan || !sources || !depth) return 0;
    if (operand.kind == PL_OPERAND_CONST) {
        *sources = 0u;
        *depth = 1u;
        return 1;
    }
    if (operand.kind == PL_OPERAND_LOCAL) {
        if (operand.value >= PL_X86_GPR_COUNT) return 0;
        *sources = 1u << (pl_u32)operand.value;
        *depth = 1u;
        return 1;
    }
    pl_u32 node = operand.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(operand.value >> 8u)
                : operand.kind == PL_OPERAND_NODE
                ? (pl_u32)operand.value : 0u;
    if (!node || node > available_nodes || !row) return 0;
    const gpr_source_row *source = &row[node - 1u];
    if (operand.kind == PL_OPERAND_PROJECTION) {
        if ((operand.value & 0xffu) != 16u
                || !source->projection_depth)
            return 0;
        *sources = source->projection_sources;
        *depth = source->projection_depth;
        return 1;
    }
    if (operand.kind != PL_OPERAND_NODE || !source->node_depth) return 0;
    *sources = source->node_sources;
    *depth = source->node_depth;
    return 1;
}

static int operand_gpr_sources(const pl_plan *plan, pl_operand operand,
                               pl_u32 before_node, pl_u32 remaining,
                               pl_u32 *sources)
{
    if (!plan || !sources || !remaining || !before_node) return 0;
    pl_u32 available = before_node - 1u;
    if (available > plan->node_count) available = plan->node_count;
    gpr_source_row row[available ? available : 1u];
    for (pl_u32 node_number = 1u; node_number <= available; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        gpr_source_row *current = &row[node_number - 1u];
        *current = (gpr_source_row){ 0u, 0u, 0u, 0u };
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            continue;
        pl_u32 node_sources = 0u;
        pl_u32 node_depth = 1u;
        int node_valid = 1;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u, part_depth = 0u;
            if (!gpr_source_operand_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_number - 1u, row, &part, &part_depth)) {
                node_valid = 0;
                break;
            }
            node_sources |= part;
            if (part_depth >= node_depth) {
                if (part_depth == 0xffffffffu) {
                    node_valid = 0;
                    break;
                }
                node_depth = part_depth + 1u;
            }
        }
        if (node_valid) {
            current->node_sources = node_sources;
            current->node_depth = node_depth;
        }
        if (node->opcode != PL_OPCODE_X86_ALU
                || node->argument_count != 4u)
            continue;
        pl_u32 projection_sources = 0u;
        pl_u32 projection_depth = 1u;
        int projection_valid = 1;
        for (pl_u32 argument = 1u; argument < 3u; ++argument) {
            pl_u32 part = 0u, part_depth = 0u;
            if (!gpr_source_operand_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_number - 1u, row, &part, &part_depth)) {
                projection_valid = 0;
                break;
            }
            projection_sources |= part;
            if (part_depth >= projection_depth) {
                if (part_depth == 0xffffffffu) {
                    projection_valid = 0;
                    break;
                }
                projection_depth = part_depth + 1u;
            }
        }
        if (projection_valid) {
            current->projection_sources = projection_sources;
            current->projection_depth = projection_depth;
        }
    }
    pl_u32 law = 0u, depth = 0u;
    if (!gpr_source_operand_law(
            plan, operand, available, row, &law, &depth)
            || depth > remaining)
        return 0;
    *sources |= law;
    return 1;
}

static pl_u32 publication_owner(const pl_plan *plan, pl_operand operand)
{
    pl_u32 owner = PL_X86_GPR_COUNT;
    if (!plan) return owner;
    /* A destructive x86 ALU already has a physical accumulator coordinate.
     * If that entry local is also one of the result publications, retaining
     * it as owner avoids seed-copy + copy-back.  Register number is only a
     * tie-breaker when the normalized meaning has no such coordinate. */
    if (operand.kind == PL_OPERAND_PROJECTION
            && (operand.value & 0xffu) == 16u) {
        pl_u32 node_number = (pl_u32)(operand.value >> 8u);
        if (node_number && node_number <= plan->node_count) {
            const pl_node *node = &plan->nodes[node_number - 1u];
            if (node->opcode == PL_OPCODE_X86_ALU
                    && node->argument_count == 4u
                    && node->argument_at <= plan->argument_count
                    && node->argument_count
                       <= plan->argument_count - node->argument_at) {
                pl_operand source = plan->arguments[node->argument_at + 1u];
                if (source.kind == PL_OPERAND_LOCAL
                        && source.value < PL_X86_GPR_COUNT) {
                    pl_u32 candidate = (pl_u32)source.value;
                    pl_operand publication = plan->locals[candidate];
                    if (publication.kind == operand.kind
                            && publication.value == operand.value)
                        return candidate;
                }
            }
        }
    }
    if (operand.kind == PL_OPERAND_NODE && operand.value
            && operand.value <= plan->node_count) {
        const pl_node *node = &plan->nodes[operand.value - 1u];
        if ((node->opcode == PL_OPCODE_LANE32_SELECT
                || node->opcode == PL_OPCODE_LANE64_SELECT)
                && node->argument_count == 3u
                && node->argument_at <= plan->argument_count
                && node->argument_count
                   <= plan->argument_count - node->argument_at) {
            pl_operand current = plan->arguments[node->argument_at + 1u];
            if (current.kind == PL_OPERAND_LOCAL
                    && current.value < PL_X86_GPR_COUNT) {
                pl_u32 candidate = (pl_u32)current.value;
                pl_operand publication = plan->locals[candidate];
                if (publication.kind == operand.kind
                        && publication.value == operand.value)
                    return candidate;
            }
        }
    }
    /* For a normalized arithmetic root, only a top-level operand can be the
     * destructive accumulator.  A transitive source may also be an equal
     * final publication, but choosing it adds save + restore work around the
     * actual root (for example `(RSI xor n6)` published to both RSI and
     * RDX). */
    if (operand.kind == PL_OPERAND_NODE && operand.value
            && operand.value <= plan->node_count) {
        pl_operand left, right;
        pl_u32 bits = 0u, mode = 0u;
        if (arithmetic_tree_details(
                plan, operand, &left, &right, &bits, &mode)) {
            pl_operand root[2] = { left, right };
            pl_u32 count = mode == 3u ? 1u : 2u;
            for (pl_u32 root_at = 0u; root_at < count; ++root_at) {
                if (root[root_at].kind != PL_OPERAND_LOCAL
                        || root[root_at].value >= PL_X86_GPR_COUNT)
                    continue;
                pl_u32 candidate = (pl_u32)root[root_at].value;
                pl_operand publication = plan->locals[candidate];
                if (publication.kind == operand.kind
                        && publication.value == operand.value)
                    return candidate;
            }
            (void)bits;
        }
    }
    /* Equal architectural outputs are interchangeable owners.  Prefer one
     * which is also an entry source of the value, so x86 can evaluate the
     * destructive chain in place and fan the result out once.  Falling back
     * to register rank here would create save/copy-back/restore work around
     * the actual accumulator. */
    pl_u32 entry_sources = 0u;
    if (operand_gpr_sources(
            plan, operand, plan->node_count + 1u,
            plan->node_count + 1u, &entry_sources)) {
        for (pl_u32 candidate = 0u;
                candidate < PL_X86_GPR_COUNT; ++candidate) {
            if (!(entry_sources & (1u << candidate))) continue;
            pl_operand publication = plan->locals[candidate];
            if (publication.kind == operand.kind
                    && publication.value == operand.value)
                return candidate;
        }
    }
    /* Constant folding must not split the one semantic zero class merely
     * because a live flag producer still exposes its zero result as a node
     * projection.  Prefer that unavoidable destructive producer as owner;
     * every CONST 0 / folded-zero publication is then only a register rank.
     * This is the native image of the normalized future quotient, not a
     * peephole tied to either source spelling. */
    if (zero_result_operand(plan, operand)) {
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand published = plan->locals[local];
            if (published.kind != PL_OPERAND_PROJECTION
                    || (published.value & 0xffu) != 16u
                    || !zero_result_operand(plan, published))
                continue;
            pl_u32 node_number = (pl_u32)(published.value >> 8u);
            if (node_number && node_number <= plan->node_count) {
                const pl_node *node = &plan->nodes[node_number - 1u];
                if (node->opcode == PL_OPCODE_X86_ALU
                        && node->argument_count == 4u
                        && node->argument_at <= plan->argument_count
                        && node->argument_count
                           <= plan->argument_count - node->argument_at) {
                    pl_operand source =
                        plan->arguments[node->argument_at + 1u];
                    if (source.kind == PL_OPERAND_LOCAL
                            && source.value < PL_X86_GPR_COUNT) {
                        pl_u32 candidate = (pl_u32)source.value;
                        pl_operand candidate_value = plan->locals[candidate];
                        if (candidate_value.kind == published.kind
                                && candidate_value.value == published.value)
                            return candidate;
                    }
                }
            }
            return local;
        }
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand published = plan->locals[local];
        if (published.kind == operand.kind
                && published.value == operand.value) {
            owner = local;
            break;
        }
    }
    return owner;
}

/* Low 16 bits are entry-register sources; high 16 bits are coordinates whose
 * new value must already have been published.  A coordinate may occur in
 * both halves: that is a real old-generation/new-generation lifetime split,
 * not a bit to cancel.  The plan is topologically
 * numbered, so one forward pass computes the complete source law for every
 * shared node.  This replaces the old recursive DAG expansion, which revisited
 * the same suffix once per root, pending local, and parent path. */

/* The final flag producer's value can be a zero-producing self operation
 * (`xor r,r` / `sub r,r`).  `publication_owner` prefers that publication as the
 * owner of constant zero, which makes every zero operand depend on a
 * coordinate the flags-last rule schedules last.  Callers use this to keep a
 * constant zero as an immediate instead. */
static int zero_self_flag_publication(const pl_plan *plan, pl_u32 owner)
{
    if (!plan || owner >= PL_X86_GPR_COUNT) return 0;
    pl_operand value = plan->locals[owner];
    if (value.kind != PL_OPERAND_PROJECTION || (value.value & 0xffu) != 16u)
        return 0;
    pl_u32 node = (pl_u32)(value.value >> 8u);
    if (!node || node > plan->node_count) return 0;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!alu_node_semantics(plan, node, &left, &right,
            &bits, &mode, &preserves_carry))
        return 0;
    return !preserves_carry && (mode == 3u || mode == 6u)
        && equal_operand(left, right);
}

static int operand_source_law(const pl_plan *plan, pl_operand operand,
                              const pl_u32 *node_law,
                              pl_u32 available_nodes,
                              int substitute_publication,
                              pl_u32 *law)
{
    if (!plan || !law) return 0;
    if (operand.kind == PL_OPERAND_CONST) {
        if (substitute_publication) {
            pl_u32 owner = publication_owner(plan, operand);
            if (owner < PL_X86_GPR_COUNT
                    && !zero_self_flag_publication(plan, owner)) {
                pl_u32 bit = 1u << owner;
                *law = bit << 16u;
                return 1;
            }
        }
        *law = 0u;
        return 1;
    }
    if (operand.kind == PL_OPERAND_LOCAL) {
        if (substitute_publication && operand.value < PL_X86_GPR_COUNT) {
            pl_u32 entry = (pl_u32)operand.value;
            pl_u32 owner = publication_owner(plan, operand);
            if (owner < PL_X86_GPR_COUNT && owner != entry) {
                pl_u32 bit = 1u << owner;
                *law = bit << 16u;
                return 1;
            }
        }
        *law = operand.value < PL_X86_GPR_COUNT
             ? 1u << (pl_u32)operand.value : 0u;
        return 1;
    }
    pl_u32 node = operand.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(operand.value >> 8u)
                : operand.kind == PL_OPERAND_NODE
                ? (pl_u32)operand.value : 0u;
    if (!node || node > available_nodes || !node_law) return 0;
    if (substitute_publication) {
        pl_u32 owner = publication_owner(plan, operand);
        if (owner < PL_X86_GPR_COUNT) {
            pl_u32 bit = 1u << owner;
            *law = bit << 16u;
            return 1;
        }
        /* An X86_FLAGS node's flags are set by the single instruction that
         * publishes its result.  A consumer of those flags therefore depends
         * on the result's publication owner; it must not inherit the entry
         * registers that the producing instruction itself reads (notably an
         * in-place compare whose entry is the coordinate it overwrites). */
        const pl_node *flags = &plan->nodes[node - 1u];
        if (flags->opcode == PL_OPCODE_X86_FLAGS
                && flags->argument_count == 5u
                && flags->argument_at <= plan->argument_count
                && 5u <= plan->argument_count - flags->argument_at) {
            pl_operand result = plan->arguments[flags->argument_at + 3u];
            pl_u32 result_owner = publication_owner(plan, result);
            if (result_owner < PL_X86_GPR_COUNT) {
                *law = (1u << result_owner) << 16u;
                return 1;
            }
        }
    }
    *law = node_law[node - 1u];
    return 1;
}

/* Widths, condition codes and operation descriptors are instruction literals,
 * not runtime values. Equal bits in a published register cannot turn such a
 * literal into a producer edge (CMOVE's condition 4 is not the value RDX=4).
 * Value operands still use the canonical publication owner. */
static int native_argument_uses_publication(
    const pl_plan *plan, const pl_node *node, pl_u32 argument)
{
    /* An immediate field consumes its literal bits, not a future GPR whose
     * value happens to match. In particular SUB32(x,0) must not wait for an
     * unrelated final XOR-zero publication and form a false flag cycle. */
    if (argument == 1u)
        for (pl_u32 lane = 0u; lane < 2u; ++lane)
            for (pl_u32 semantic = 0u; semantic < 5u; ++semantic)
                if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[lane][semantic]) return 0;
    pl_u32 descriptor;
    switch (node->opcode) {
    case PL_OPCODE_LANE32_INSERT:
    case PL_OPCODE_LANE64_INSERT:
        /* The zero fill in a zero extension is not read from a GPR. */
        if (!argument) {
            pl_operand base = plan->arguments[node->argument_at];
            if (base.kind == PL_OPERAND_CONST && !base.value) return 0;
        }
        descriptor = 2u; break;
    case PL_OPCODE_X86_CONDITION: descriptor = 1u; break;
    case PL_OPCODE_X86_TEST_CONDITION:
    case PL_OPCODE_MUL_HIGH:
    case PL_OPCODE_BIT_ADDRESS: descriptor = 2u; break;
    case PL_OPCODE_X86_ALU:
    case PL_OPCODE_X86_COMPARE:
    case PL_OPCODE_X86_TEST:
    case PL_OPCODE_X86_BIT_FLAGS:
    case PL_OPCODE_X86_MUL_FLAGS: descriptor = 3u; break;
    case PL_OPCODE_X86_FLAGS:
    case PL_OPCODE_X86_AFFINE_ALU:
    case PL_OPCODE_X86_SHIFT_FLAGS:
    case PL_OPCODE_X86_DOUBLE_SHIFT: descriptor = 4u; break;
    default: return 1;
    }
    return argument != descriptor;
}

static int alu_frame_source_laws(const pl_plan *plan,
                                 pl_u32 sources[PL_X86_GPR_COUNT],
                                 pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !sources || !dependencies) return 0;
    pl_u32 node_law[plan->node_count ? plan->node_count : 1u];
    for (pl_u32 node_number = 1u;
            node_number <= plan->node_count; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            return 0;
        pl_u32 law = 0u;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u;
            if (!operand_source_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_law, node_number - 1u,
                    native_argument_uses_publication(plan, node, argument), &part))
                return 0;
            law |= part;
        }
        node_law[node_number - 1u] = law;
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        pl_u32 owner = publication_owner(plan, value);
        pl_u32 law = 0u;
        if (owner < PL_X86_GPR_COUNT && owner != local) {
            pl_u32 bit = 1u << owner;
            law = bit << 16u;
        } else if (!operand_source_law(
                       plan, value, node_law, plan->node_count,
                       0, &law)) {
            return 0;
        }
        sources[local] = law & 0xffffu;
        dependencies[local] = law >> 16u;
    }
    /* An ADD3 whose two operands are exactly the value another local publishes
     * shares that publication: the frame emits `ADD(pair_local, remaining)`, so
     * this publication must run after the pair.  Recording the dependency here
     * is what orders them; naming a *published local* (never a later node) is
     * the invariant that keeps the operand meaningful. */
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind != PL_OPERAND_NODE || !value.value
                || value.value > plan->node_count)
            continue;
        const pl_node *node = &plan->nodes[value.value - 1u];
        if ((node->opcode != PL_OPCODE_ADD3[0]
                && node->opcode != PL_OPCODE_ADD3[1])
                || node->argument_count != 3u
                || node->argument_at > plan->argument_count
                || 3u > plan->argument_count - node->argument_at)
            continue;
        const pl_operand *argument = plan->arguments + node->argument_at;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local) continue;
            pl_operand published = plan->locals[other];
            if (published.kind != PL_OPERAND_NODE || !published.value
                    || published.value > plan->node_count)
                continue;
            pl_operand left, right;
            pl_u32 other_bits = 0u, other_mode = 0u;
            if (!arithmetic_tree_details(plan, published, &left, &right,
                                         &other_bits, &other_mode)
                    || other_mode != 1u)
                continue;
            for (pl_u32 i = 0u; i < 3u; ++i)
                for (pl_u32 j = i + 1u; j < 3u; ++j)
                    if ((equal_operand(argument[i], left)
                                && equal_operand(argument[j], right))
                            || (equal_operand(argument[i], right)
                                && equal_operand(argument[j], left)))
                        dependencies[local] |= 1u << other;
        }
    }
    return 1;
}

static int operand_frame_source_law(const pl_plan *plan,
                                    pl_operand operand,
                                    pl_u32 *sources,
                                    pl_u32 *dependencies)
{
    if (!plan || !sources || !dependencies) return 0;
    pl_u32 node_law[plan->node_count ? plan->node_count : 1u];
    for (pl_u32 node_number = 1u;
            node_number <= plan->node_count; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            return 0;
        pl_u32 law = 0u;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u;
            if (!operand_source_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_law, node_number - 1u,
                    native_argument_uses_publication(plan, node, argument), &part))
                return 0;
            law |= part;
        }
        node_law[node_number - 1u] = law;
    }
    pl_u32 law = 0u;
    if (!operand_source_law(
            plan, operand, node_law, plan->node_count, 1, &law))
        return 0;
    *sources = law & 0xffffu;
    *dependencies = law >> 16u;
    return 1;
}

static int flag_result_operand(const pl_plan *plan, pl_u32 node_number,
                               pl_operand *result, pl_operand *prior)
{
    if (!plan || !result || !prior || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (!node->argument_count || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    *prior = argument[0];
    if (node->opcode == PL_OPCODE_X86_SHIFT_FLAGS) {
        if (node->argument_count != 5u) return 0;
        *result = argument[2];
        return 1;
    }
    if (node->opcode == PL_OPCODE_X86_FLAGS) {
        if (node->argument_count != 5u) return 0;
        *result = argument[3];
        return 1;
    }
    if (node->opcode == PL_OPCODE_X86_ALU
            || node->opcode == PL_OPCODE_X86_AFFINE_ALU
            || node->opcode == PL_OPCODE_X86_BIT_SUMMARY) {
        result->kind = PL_OPERAND_PROJECTION;
        result->value = ((pl_u64)node_number << 8u) | 16u;
        return 1;
    }
    return 0;
}

/* Value SSA alone intentionally drops dead intermediate flags.  A surviving
 * variable-shift chain is different: count==0 makes each producer retain its
 * prior flags, so the chain order is observable even when its value results
 * are otherwise independent.  Project that residual flag order onto the
 * physical result owners before register scheduling. */
static void add_flag_chain_dependencies(
    const pl_plan *plan, pl_u32 final_flag_node,
    pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !dependencies) return;
    pl_u32 later_owner = PL_X86_GPR_COUNT;
    pl_u32 node_number = final_flag_node;
    for (pl_u32 step = 0u; node_number && step < plan->node_count; ++step) {
        pl_operand result, prior;
        if (!flag_result_operand(plan, node_number, &result, &prior)) break;
        pl_u32 owner = publication_owner(plan, result);
        if (later_owner < PL_X86_GPR_COUNT
                && owner < PL_X86_GPR_COUNT && owner != later_owner)
            dependencies[later_owner] |= 1u << owner;
        if (owner < PL_X86_GPR_COUNT) later_owner = owner;
        if (prior.kind != PL_OPERAND_NODE || !prior.value
                || prior.value >= node_number
                || prior.value > plan->node_count)
            break;
        node_number = (pl_u32)prior.value;
    }
    /* A conditional select that tests the final flag word skips its own
     * compare when that word has a value publication, so it must be ordered
     * after the publication that produces those flags.  SSA alone carries no
     * such edge: the tested flag node is reached through the condition and the
     * value publication is a separate projection. */
    if (final_flag_node) {
        pl_operand flag_result = { 0 }, flag_prior = { 0 };
        if (flag_result_operand(
                plan, final_flag_node, &flag_result, &flag_prior)) {
            pl_u32 flag_owner = publication_owner(plan, flag_result);
            if (flag_owner < PL_X86_GPR_COUNT) {
                for (pl_u32 local = 0u;
                        local < PL_X86_GPR_COUNT; ++local) {
                    if (local == flag_owner) continue;
                    pl_operand value = plan->locals[local];
                    if (value.kind != PL_OPERAND_NODE || !value.value
                            || value.value > plan->node_count)
                        continue;
                    const pl_node *select = &plan->nodes[value.value - 1u];
                    if ((select->opcode != PL_OPCODE_LANE32_SELECT
                                && select->opcode != PL_OPCODE_LANE64_SELECT)
                            || select->argument_count != 3u
                            || select->argument_at > plan->argument_count
                            || select->argument_count
                               > plan->argument_count - select->argument_at)
                        continue;
                    pl_operand condition = plan->arguments[
                        select->argument_at + 2u];
                    if (condition.kind != PL_OPERAND_NODE
                            || !condition.value
                            || condition.value > plan->node_count)
                        continue;
                    const pl_node *condition_node =
                        &plan->nodes[condition.value - 1u];
                    if (condition_node->opcode != PL_OPCODE_X86_CONDITION
                            || condition_node->argument_count != 2u
                            || condition_node->argument_at
                               > plan->argument_count
                            || condition_node->argument_count
                               > plan->argument_count
                                 - condition_node->argument_at)
                        continue;
                    pl_operand tested = plan->arguments[
                        condition_node->argument_at];
                    if (tested.kind == PL_OPERAND_NODE
                            && tested.value == final_flag_node)
                        dependencies[local] |= 1u << flag_owner;
                }
            }
        }
    }
}

typedef struct {
    pl_operand left, right;
    pl_u32 bits, condition;
} test_boolean;

static int test_boolean_details(const pl_plan *plan, pl_operand value, test_boolean *out)
{
    if (!plan || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode != PL_OPCODE_X86_TEST_CONDITION || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at) return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[2].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[2].value;
    out->bits = (pl_u32)(descriptor & 0xffu);
    out->condition = (pl_u32)(descriptor >> 8u);
    if ((out->bits != 8u && out->bits != 16u && out->bits != 32u && out->bits != 64u)
            || descriptor >> 12u) return 0;
    out->left = argument[0]; out->right = argument[1];
    return 1;
}

static int test_boolean_publishes_flags(const pl_plan *plan, pl_operand value, pl_u32 flags)
{
    test_boolean shape;
    if (!plan || !flags || flags > plan->node_count
            || !test_boolean_details(plan, value, &shape)) return 0;
    const pl_node *node = &plan->nodes[flags - 1u];
    if (node->opcode != PL_OPCODE_X86_TEST || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || 4u > plan->argument_count - node->argument_at) return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    return argument[3].kind == PL_OPERAND_CONST && argument[3].value == shape.bits
        && argument[1].kind == shape.left.kind && argument[1].value == shape.left.value
        && argument[2].kind == shape.right.kind && argument[2].value == shape.right.value;
}

/* One IMUL publishes both its low result and its conditions.  The normalized
 * plan keeps the low result and the X86_MUL_FLAGS node separate, so relate
 * them through the shared multiplicands: the flags node names the 64-bit low
 * product, and the value publication is a MULR/LANE32_MULR over the same
 * operands (the narrow constant is the low 32 bits of the wide one). */
static int mul_flags_value_publication(const pl_plan *plan,
                                       pl_operand value, pl_u32 flag_node)
{
    if (!plan || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count
            || !flag_node || flag_node > plan->node_count)
        return 0;
    const pl_node *flags = &plan->nodes[flag_node - 1u];
    const pl_node *result = &plan->nodes[value.value - 1u];
    if (flags->opcode != PL_OPCODE_X86_MUL_FLAGS
            || flags->argument_count != 4u
            || flags->argument_at > plan->argument_count
            || 4u > plan->argument_count - flags->argument_at
            || (result->opcode != PL_OPCODE_MULR
                && result->opcode != PL_OPCODE_LANE32_MULR)
            || result->argument_count != 2u
            || result->argument_at > plan->argument_count
            || 2u > plan->argument_count - result->argument_at)
        return 0;
    const pl_operand *flag_argument = plan->arguments + flags->argument_at;
    if (flag_argument[1].kind != PL_OPERAND_NODE
            || !flag_argument[1].value
            || flag_argument[1].value > plan->node_count)
        return 0;
    const pl_node *low = &plan->nodes[flag_argument[1].value - 1u];
    if (low->opcode != PL_OPCODE_MULR || low->argument_count != 2u
            || low->argument_at > plan->argument_count
            || 2u > plan->argument_count - low->argument_at)
        return 0;
    const pl_operand *wide = plan->arguments + low->argument_at;
    const pl_operand *narrow = plan->arguments + result->argument_at;
    for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
        pl_operand wide_left = wide[orientation];
        pl_operand wide_right = wide[1u - orientation];
        if (wide_left.kind != narrow[0].kind
                || wide_left.value != narrow[0].value)
            continue;
        if (wide_right.kind == PL_OPERAND_CONST
                && narrow[1].kind == PL_OPERAND_CONST
                && (wide_right.value & 0xffffffffull)
                   == (narrow[1].value & 0xffffffffull))
            return 1;
        if (wide_right.kind == narrow[1].kind
                && wide_right.value == narrow[1].value)
            return 1;
    }
    return 0;
}

static int publication_is_flag_result(const pl_plan *plan,
                                      pl_operand publication,
                                      pl_u32 flag_node)
{
    if (test_boolean_publishes_flags(plan, publication, flag_node)) return 1;
    if (mul_flags_value_publication(plan, publication, flag_node)) return 1;
    /* An X86_ALU value is published as its projection, but compaction may
     * name the producing node directly at the result coordinate. */
    if (publication.kind == PL_OPERAND_NODE
            && publication.value == flag_node
            && flag_node && flag_node <= plan->node_count) {
        pl_u32 opcode = plan->nodes[flag_node - 1u].opcode;
        if (opcode == PL_OPCODE_X86_ALU
                || opcode == PL_OPCODE_X86_AFFINE_ALU
                || opcode == PL_OPCODE_X86_BIT_SUMMARY)
            return 1;
    }
    pl_operand result, prior;
    if (!flag_result_operand(plan, flag_node, &result, &prior)) return 0;
    for (pl_u32 remaining = plan->node_count + 1u; remaining; --remaining) {
        if (publication.kind == result.kind
                && publication.value == result.value)
            return 1;
        /* Measured physical vocabulary: lane32.and = 6, lane64.and = 76.  A
         * low-lane AND of the flag result is the rewriter's value-widening
         * artifact for a partial-width publication (`insert(base, value, w)`
         * folded when the base's masked-out bits are known zero).  The AND has
         * no flag effect in this plan (the block's RFLAGS names the original
         * producer), so only the flag provenance passes through; the emitter
         * still materializes the mask itself, which keeps the rule sound even
         * when the AND is a genuine `and reg, mask`. */
        if (publication.kind == PL_OPERAND_NODE && publication.value
                && publication.value <= plan->node_count) {
            const pl_node *mask = &plan->nodes[publication.value - 1u];
            if ((mask->opcode == 6u || mask->opcode == 76u)
                    && mask->argument_count == 2u
                    && mask->argument_at <= plan->argument_count
                    && 2u <= plan->argument_count - mask->argument_at
                    && plan->arguments[mask->argument_at + 1u].kind
                       == PL_OPERAND_CONST) {
                publication = plan->arguments[mask->argument_at];
                continue;
            }
            /* Physical lane insert (lane64.insert = 198, lane32.insert = 201)
             * writes the low `width` bits of a base from its second operand and
             * has no flag effect, so the block's final flags belong to the
             * inserted value's producer.  Only the flag provenance passes
             * through; the emitter materializes the base separately. */
            if ((mask->opcode == 198u || mask->opcode == 201u)
                    && mask->argument_count == 3u
                    && mask->argument_at <= plan->argument_count
                    && 3u <= plan->argument_count - mask->argument_at) {
                publication = plan->arguments[mask->argument_at + 1u];
                continue;
            }
        }
        pl_operand source;
        pl_u32 bits = 0u;
        if (!complement_node_details(plan, publication, &source, &bits))
            return 0;
        (void)bits;
        publication = source;
    }
    return 0;
}

static int frame_publication_clobbers_flags(const pl_plan *plan,
                                            pl_operand publication)
{
    if (!plan || publication.kind == PL_OPERAND_PROJECTION) return 1;
    if (publication.kind == PL_OPERAND_CONST
            || publication.kind == PL_OPERAND_LOCAL)
        return 0;
    if (publication.kind != PL_OPERAND_NODE || !publication.value
            || publication.value > plan->node_count)
        return 1;
    pl_operand complement_source;
    pl_u32 complement_bits = 0u;
    if (complement_node_details(
            plan, publication, &complement_source, &complement_bits)) {
        (void)complement_bits;
        return frame_publication_clobbers_flags(plan, complement_source);
    }
    pl_operand extended;
    pl_u32 extend_bits = 0u;
    if (sign_extend_value(plan, (pl_u32)publication.value, &extended, &extend_bits))
        return frame_publication_clobbers_flags(plan, extended);
    pl_u32 opcode = plan->nodes[publication.value - 1u].opcode;
    if (opcode == PL_OPCODE_LANE32_INSERT
            || opcode == PL_OPCODE_LANE64_INSERT
            || opcode == PL_OPCODE_LANE32_EXTEND8_S
            || opcode == PL_OPCODE_LANE32_EXTEND16_S
            || opcode == PL_OPCODE_LANE64_EXTEND8_S
            || opcode == PL_OPCODE_LANE64_EXTEND16_S
            || opcode == PL_OPCODE_EXTEND32_S
            || opcode == PL_OPCODE_ADD
            || opcode == PL_OPCODE_ADD3[0]
            || opcode == PL_OPCODE_ADD3[1]
            || opcode == PL_OPCODE_ALU_IMMEDIATE[0][1]
            || opcode == PL_OPCODE_ALU_IMMEDIATE[1][1]
            || opcode == PL_OPCODE_ALU_REGISTER[0][1]
            || opcode == PL_OPCODE_ALU_REGISTER[1][1])
        return 0;
    return 1;
}

/* The flag-preservation answer above is the top-level spelling.  When a value
 * publication is scheduled after the final flag producer, its whole operand
 * tree must be flag-preserving, not just its root: an addition is spelled with
 * LEA only when every operand is itself a register, constant or flag-safe
 * value.  An addition over a product, a shift or a subtract is materialized
 * with an ordinary add/adc, so it must be emitted before the flag producer. */
static int publication_tree_clobbers_flags(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 destination)
{
    if (!plan || value.kind == PL_OPERAND_PROJECTION) return 1;
    if (value.kind == PL_OPERAND_CONST || value.kind == PL_OPERAND_LOCAL)
        return 0;
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 1;
    /* A node already published in another local is a register read here; its
     * production is a separate publication that the scheduler orders on its
     * own.  Only a node materialized as part of this publication (its owner is
     * the destination, or it has no owner yet) contributes its instruction to
     * this emission. */
    pl_u32 owner = publication_owner(plan, value);
    if (owner < PL_X86_GPR_COUNT && owner != destination)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode == PL_OPCODE_LANE32_INSERT
            || node->opcode == PL_OPCODE_LANE64_INSERT
            || node->opcode == PL_OPCODE_LANE32_EXTEND8_S
            || node->opcode == PL_OPCODE_LANE32_EXTEND16_S
            || node->opcode == PL_OPCODE_LANE64_EXTEND8_S
            || node->opcode == PL_OPCODE_LANE64_EXTEND16_S
            || node->opcode == PL_OPCODE_EXTEND32_S)
        return 0;
    if (node->opcode != PL_OPCODE_ADD
            && node->opcode != PL_OPCODE_ADD3[0]
            && node->opcode != PL_OPCODE_ADD3[1]
            && node->opcode != PL_OPCODE_ALU_IMMEDIATE[0][1]
            && node->opcode != PL_OPCODE_ALU_IMMEDIATE[1][1]
            && node->opcode != PL_OPCODE_ALU_REGISTER[0][1]
            && node->opcode != PL_OPCODE_ALU_REGISTER[1][1])
        return 1;
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 1;
    /* A three-input add is one flag-preserving LEA only when one input is a
     * constant displacement.  Three non-constant inputs (including a carry-in
     * that is a live flag) need a second, flag-clobbering add/adc, so they
     * cannot be scheduled after the final flag producer. */
    if (node->opcode == PL_OPCODE_ADD3[0]
            || node->opcode == PL_OPCODE_ADD3[1]) {
        int displacement = 0;
        for (pl_u32 argument = 0u; argument < node->argument_count; ++argument)
            if (plan->arguments[node->argument_at + argument].kind
                    == PL_OPERAND_CONST) {
                displacement = 1;
                break;
            }
        if (!displacement) return 1;
    }
    for (pl_u32 argument = 0u; argument < node->argument_count; ++argument)
        if (publication_tree_clobbers_flags(
                plan, plan->arguments[node->argument_at + argument],
                destination))
            return 1;
    return 0;
}

/* Scheduling variant of frame_local_publication_clobbers_flags: it answers
 * whether emitting this local now can change the flags the terminal reads. */
static int frame_local_emission_clobbers_flags(const pl_plan *plan,
                                               pl_u32 local)
{
    if (!plan || local >= PL_X86_GPR_COUNT) return 1;
    pl_operand publication = plan->locals[local];
    pl_u32 owner = publication_owner(plan, publication);
    if (owner < PL_X86_GPR_COUNT && owner != local) {
        if (publication.kind == PL_OPERAND_CONST && !publication.value) {
            pl_u32 move_bytes = 0u, zero_bytes = 0u;
            if (emit_gpr_move(
                    local, owner, 32u, (pl_u8 *)0, &move_bytes)
                    && emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes)
                    && zero_bytes < move_bytes)
                return 1;
        }
        return 0;
    }
    return publication_tree_clobbers_flags(plan, publication, local);
}

/* Equal zero values share one semantic owner, but the shortest native
 * spelling is coordinate-dependent.  A low-register self-XOR can be shorter
 * than a MOV from a high owner and therefore really does clobber flags; feed
 * that physical choice back into scheduling so the final flag producer stays
 * last. */
static int frame_local_publication_clobbers_flags(
    const pl_plan *plan, pl_u32 local)
{
    if (!plan || local >= PL_X86_GPR_COUNT) return 1;
    pl_operand publication = plan->locals[local];
    pl_u32 owner = publication_owner(plan, publication);
    if (owner < PL_X86_GPR_COUNT && owner != local) {
        if (publication.kind == PL_OPERAND_CONST && !publication.value) {
            pl_u32 move_bytes = 0u, zero_bytes = 0u;
            if (emit_gpr_move(
                    local, owner, 32u, (pl_u8 *)0, &move_bytes)
                    && emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes)
                    && zero_bytes < move_bytes)
                return 1;
        }
        return 0;
    }
    return frame_publication_clobbers_flags(plan, publication);
}

static int next_alu_frame_assignment(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 final_flag_node,
                                     const pl_u32 *sources,
                                     const pl_u32 *dependencies,
                                     pl_u32 protected_entries,
                                     pl_u32 *selected)
{
    if (!plan || !pending || !sources || !dependencies || !selected)
        return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        if (protected_entries & (1u << local)) continue;
        pl_operand published = plan->locals[local];
        /* The final flags producer must be textually last.  Other dense
         * publications may consume an earlier flags version (CMOV/SETcc)
         * even when they are not themselves ALU projections. */
        if ((publication_is_flag_result(plan, published, final_flag_node)
                || publication_emits_selected_flag(plan, published, local, final_flag_node))
                && publication_owner(plan, published) == local) {
            pl_u32 blockers = pending & ~(1u << local);
            for (pl_u32 fanout = 0u;
                    fanout < PL_X86_GPR_COUNT; ++fanout)
                if ((blockers & (1u << fanout))
                        && publication_owner(
                            plan, plan->locals[fanout]) == local
                        && !frame_local_emission_clobbers_flags(
                            plan, fanout))
                    blockers &= ~(1u << fanout);
            for (pl_u32 blocker = 0u;
                    blocker < PL_X86_GPR_COUNT; ++blocker)
                if ((blockers & (1u << blocker))
                        && !frame_local_emission_clobbers_flags(
                            plan, blocker))
                    blockers &= ~(1u << blocker);
            if (blockers) continue;
        }
        pl_u32 effective_dependencies = dependencies[local];
        pl_u32 physical_owner = publication_owner(plan, published);
        if (published.kind == PL_OPERAND_CONST && !published.value
                && physical_owner < PL_X86_GPR_COUNT
                && physical_owner != local
                && frame_local_publication_clobbers_flags(plan, local))
            effective_dependencies &= ~(1u << physical_owner);
        if (protected_entries & effective_dependencies) {
            pl_u32 semantic_sources = 0u;
            if (!operand_gpr_sources(
                    plan, published, plan->node_count + 1u,
                    plan->node_count + 1u, &semantic_sources))
                continue;
            effective_dependencies &=
                ~(protected_entries & semantic_sources);
        }
        if (effective_dependencies & pending) continue;
        pl_u32 used_by_others = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            /* A dependency source is the new value published by another
             * pending local, not that register's entry value.  It imposes a
             * producer-before-consumer edge, never an anti-dependency. */
            used_by_others |= sources[other];
        }
        if (!(used_by_others & (1u << local))) {
            *selected = local;
            return 1;
        }
    }
    return 0;
}

/* Decode the semantic binary word law without imposing a physical spelling.
 * A right operand which is itself an SSA node is still one binary law; it
 * merely needs a transient owner before x86's destructive two-address form
 * can consume it.  Keeping that distinction here prevents instruction
 * selection from confusing "not yet allocated" with "not representable". */
static int shared_dag_add3_pair(const pl_plan *plan, pl_u32 node_number,
                                pl_u32 *pair_node, pl_operand *remaining,
                                pl_u32 *bits);
static int shared_dag_add3_published_pair(
    const pl_plan *plan, pl_u32 node_number, pl_u32 *pair_local,
    pl_operand *remaining, pl_u32 *bits);
static int equal_operand(pl_operand left, pl_operand right);

static int arithmetic_tree_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *left, pl_operand *right,
                                   pl_u32 *bits, pl_u32 *mode)
{
    if (!plan || !left || !right || !bits || !mode
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->argument_count == 3u
            && (node->opcode == PL_OPCODE_ADD3[0]
                || node->opcode == PL_OPCODE_ADD3[1])) {
        pl_u32 width = node->opcode == PL_OPCODE_ADD3[0] ? 32u : 64u;
        const pl_operand *argument = plan->arguments + node->argument_at;
        /* Substitution may spell (a+b)+shift(a+b,k) as ADD3(a,b,shift).
         * The shift already names the shared sum; recover that edge through
         * its definition, without searching nodes or creating a new tree. */
        for (pl_u32 i = 0u; i < 3u; ++i) {
            pl_operand parent, amount, a, b;
            pl_u32 shift_bits = 0u, group = 0u, parent_bits = 0u, parent_mode = 0u;
            if (!shift_node_details(plan, argument[i], &parent, &amount,
                    &shift_bits, &group) || shift_bits != width
                    || parent.kind != PL_OPERAND_NODE || parent.value >= value.value
                    || !arithmetic_tree_details(plan, parent, &a, &b,
                        &parent_bits, &parent_mode)
                    || parent_bits != width || parent_mode != 1u) continue;
            pl_operand x = argument[(i + 1u) % 3u], y = argument[(i + 2u) % 3u];
            if ((a.kind == x.kind && a.value == x.value
                    && b.kind == y.kind && b.value == y.value)
                    || (a.kind == y.kind && a.value == y.value
                        && b.kind == x.kind && b.value == x.value)) {
                *left = parent; *right = argument[i]; *bits = width; *mode = 1u;
                return 1;
            }
        }
        /* Two word sums over the same two variables but different constants
         * share their base sum.  Reuse the earlier ADD3 and add the constant
         * delta instead of rebuilding a second three-term tree. */
        for (pl_u32 candidate = 1u; candidate < value.value; ++candidate) {
            const pl_node *earlier = &plan->nodes[candidate - 1u];
            if (earlier->opcode != node->opcode
                    || earlier->argument_count != 3u
                    || earlier->argument_at > plan->argument_count
                    || 3u > plan->argument_count - earlier->argument_at)
                continue;
            const pl_operand *other = plan->arguments + earlier->argument_at;
            int used[3] = { 0, 0, 0 };
            int pairs = 0, constants = 0, valid = 1;
            pl_operand node_constant = { 0 }, base_constant = { 0 };
            for (pl_u32 i = 0u; i < 3u && valid; ++i) {
                int found = 0;
                for (pl_u32 j = 0u; j < 3u; ++j) {
                    if (used[j]) continue;
                    if (argument[i].kind == other[j].kind
                            && argument[i].value == other[j].value) {
                        used[j] = 1;
                        ++pairs;
                        found = 1;
                        break;
                    }
                }
                if (found) continue;
                if (argument[i].kind != PL_OPERAND_CONST
                        || node_constant.kind == PL_OPERAND_CONST) {
                    valid = 0;
                    break;
                }
                pl_u32 unmatched = 3u;
                for (pl_u32 j = 0u; j < 3u; ++j)
                    if (!used[j]) { unmatched = j; break; }
                if (unmatched == 3u
                        || other[unmatched].kind != PL_OPERAND_CONST) {
                    valid = 0;
                    break;
                }
                used[unmatched] = 1;
                node_constant = argument[i];
                base_constant = other[unmatched];
                ++constants;
            }
            if (!valid || pairs != 2u || constants != 1u) continue;
            *left = (pl_operand){ PL_OPERAND_NODE, candidate };
            *right = (pl_operand){ PL_OPERAND_CONST,
                node_constant.value - base_constant.value };
            *bits = width;
            *mode = 1u;
            return 1;
        }
        /* General re-association: an ADD3 whose two operands are already an
         * earlier binary ADD (in either order) shares that sum, so it becomes
         * ADD(remaining, earlier).  The shared-DAG allocator uses the same
         * relation; exposing it here lets the ordinary frames emit it too. */
        pl_u32 pair_node = 0u, pair_bits = 0u;
        pl_operand pair_remaining;
        if (shared_dag_add3_pair(plan, (pl_u32)value.value, &pair_node,
                                 &pair_remaining, &pair_bits)) {
            *left = pair_remaining;
            *right = (pl_operand){ PL_OPERAND_NODE, pair_node };
            *bits = pair_bits;
            *mode = 1u;
            return 1;
        }
        return 0;
    }
    if (node->argument_count != 2u) return 0;
    static const pl_u8 x86_mode[5] = { 0u, 1u, 3u, 5u, 6u };
    if (node->opcode == PL_OPCODE_ADD) {
        *left = plan->arguments[node->argument_at];
        *right = plan->arguments[node->argument_at + 1u];
        *bits = 64u;
        *mode = 1u;
        return 1;
    }
    for (pl_u32 lane = 0u; lane < 2u; ++lane)
        for (pl_u32 semantic = 0u; semantic < 5u; ++semantic)
            if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[lane][semantic]
                    || node->opcode
                       == PL_OPCODE_ALU_REGISTER[lane][semantic]) {
                *left = plan->arguments[node->argument_at];
                *right = plan->arguments[node->argument_at + 1u];
                *bits = lane ? 64u : 32u;
                *mode = x86_mode[semantic];
                return 1;
            }
    return 0;
}

static int single_bit_or_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *source, pl_u32 *bits,
                                 pl_u32 *bit)
{
    if (!source || !bits || !bit) return 0;
    pl_operand left, right;
    pl_u32 mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &left, &right, bits, &mode)
            || mode != 5u)
        return 0;
    pl_u64 mask = 0u;
    if (left.kind == PL_OPERAND_CONST) {
        mask = left.value;
        *source = right;
    } else if (right.kind == PL_OPERAND_CONST) {
        mask = right.value;
        *source = left;
    } else {
        return 0;
    }
    pl_u64 width_mask = *bits == 32u ? 0xffffffffull : U64_MAX_VALUE;
    if (!mask || (mask & ~width_mask) || (mask & (mask - 1u))) return 0;
    pl_u32 rank = 0u;
    while (mask > 1u) {
        mask >>= 1u;
        ++rank;
    }
    *bit = rank;
    return 1;
}

static int arithmetic_node_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *left, pl_operand *right,
                                   pl_u32 *bits, pl_u32 *mode)
{
    return arithmetic_tree_details(
               plan, value, left, right, bits, mode)
        && (right->kind == PL_OPERAND_CONST
            || (right->kind == PL_OPERAND_LOCAL
                && right->value < PL_X86_GPR_COUNT));
}

static int negation_node_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *source, pl_u32 *bits)
{
    if (!source || !bits) return 0;
    pl_operand left, right;
    pl_u32 mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &left, &right, bits, &mode)
            || mode != 3u || left.kind != PL_OPERAND_CONST
            || left.value)
        return 0;
    *source = right;
    return 1;
}

static int complement_node_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *source, pl_u32 *bits)
{
    pl_operand right;
    pl_u32 mode = 0u;
    if (!source || !bits
            || !arithmetic_node_details(
                plan, value, source, &right, bits, &mode)
            || mode != 6u || right.kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 mask = *bits == 32u ? 0xffffffffu : U64_MAX_VALUE;
    return right.value == mask;
}

static pl_u32 node_wave_depth(const pl_plan *plan, pl_operand value)
{
    if (!plan) return 0u;
    pl_u32 node = value.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(value.value >> 8u)
                : value.kind == PL_OPERAND_NODE
                ? (pl_u32)value.value : 0u;
    if (!node || node > plan->node_count) return 0u;
    for (pl_u32 wave = 0u; wave < plan->span; ++wave)
        for (pl_u32 at = plan->wave_offsets[wave];
                at < plan->wave_offsets[wave + 1u]; ++at)
            if (plan->wave_values[at] == node) return wave + 1u;
    return 0u;
}

static int operand_fits_u32(const pl_plan *plan, pl_operand value,
                            pl_u32 remaining)
{
    if (!plan || !remaining) return 0;
    if (value.kind == PL_OPERAND_CONST) return value.value <= 0xffffffffu;
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    pl_u32 source = 0u, bits = 0u;
    if (zero_extend_node(
            plan, (pl_u32)value.value, &source, &bits))
        return bits <= 32u;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode == PL_OPCODE_LANE32_SELECT) return 1;
    if (node->opcode == PL_OPCODE_LANE64_SELECT && node->argument_count == 3u
            && node->argument_at <= plan->argument_count
            && 3u <= plan->argument_count - node->argument_at)
        return operand_fits_u32(plan, plan->arguments[node->argument_at], remaining - 1u)
            && operand_fits_u32(plan, plan->arguments[node->argument_at + 1u], remaining - 1u);
    pl_operand left, right;
    pl_u32 mode = 0u;
    return arithmetic_tree_details(
               plan, value, &left, &right, &bits, &mode)
        && bits == 32u;
}

static pl_u32 publication_copy_bits(const pl_plan *plan,
                                    const pl_x86_native_selection *selection,
                                    pl_operand value, pl_u32 output_at)
{
    /* A linked address below 4 GiB is not a runtime 32-bit range proof.
     * Once its owner has been emitted as a RIP-relative definition, aliases
     * must copy the full rebased pointer. The same bounded fixup record is
     * available in measurement and emission; no address table is published. */
    if (value.kind == PL_OPERAND_CONST)
        for (pl_u32 i = 0u; i < selection->fixup_count; ++i) {
            const pl_x86_native_fixup *fixup = &selection->fixups[i];
            if (fixup->kind == PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                    && fixup->target == value.value
                    && fixup->next_ip_at <= output_at)
                return 64u;
        }
    return operand_fits_u32(plan, value, plan->node_count + 1u) ? 32u : 64u;
}

static int shift_node_details(const pl_plan *plan, pl_operand value,
                              pl_operand *source, pl_operand *amount,
                              pl_u32 *bits, pl_u32 *group)
{
    if (!plan || !source || !amount || !bits || !group
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    static const struct {
        pl_u32 opcode;
        pl_u8 bits;
        pl_u8 group;
    } spelling[] = {
        { PL_OPCODE_LANE32_ROTL, 32u, 0u },
        { PL_OPCODE_LANE64_ROTL, 64u, 0u },
        { PL_OPCODE_LANE32_ROTR, 32u, 1u },
        { PL_OPCODE_LANE64_ROTR, 64u, 1u },
        { PL_OPCODE_LANE32_SHL,  32u, 4u },
        { PL_OPCODE_LANE64_SHL,  64u, 4u },
        { PL_OPCODE_LANE32_SHLR, 32u, 4u },
        { PL_OPCODE_LANE64_SHLR, 64u, 4u },
        { PL_OPCODE_LANE32_SHR,  32u, 5u },
        { PL_OPCODE_LANE64_SHR,  64u, 5u },
        { PL_OPCODE_LANE32_SHRR, 32u, 5u },
        { PL_OPCODE_LANE64_SHRR, 64u, 5u },
        { PL_OPCODE_LANE32_SAR,  32u, 7u },
        { PL_OPCODE_LANE64_SAR,  64u, 7u },
        { PL_OPCODE_LANE32_SARR, 32u, 7u },
        { PL_OPCODE_LANE64_SARR, 64u, 7u },
    };
    pl_u32 form = 0u;
    for (; form < sizeof spelling / sizeof spelling[0]; ++form)
        if (node->opcode == spelling[form].opcode) break;
    if (form == sizeof spelling / sizeof spelling[0]
            || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    *source = plan->arguments[node->argument_at];
    *amount = plan->arguments[node->argument_at + 1u];
    *bits = spelling[form].bits;
    *group = spelling[form].group;
    if (amount->kind == PL_OPERAND_CONST) return 1;
    if (amount->kind == PL_OPERAND_LOCAL && amount->value == 1u) return 1;
    if (amount->kind != PL_OPERAND_NODE || !amount->value
            || amount->value > plan->node_count)
        return 0;

    /* x86 masks a register shift count in hardware.  The semantic graph
     * makes that bound explicit; selecting D3 /group must consume it instead
     * of materializing a redundant AND before every variable shift. */
    const pl_node *bound = &plan->nodes[amount->value - 1u];
    if (bound->opcode != PL_OPCODE_ALU_IMMEDIATE[1][0]
            || bound->argument_count != 2u
            || bound->argument_at > plan->argument_count
            || bound->argument_count
               > plan->argument_count - bound->argument_at)
        return 0;
    pl_operand first = plan->arguments[bound->argument_at];
    pl_operand second = plan->arguments[bound->argument_at + 1u];
    pl_u64 mask = *bits == 64u ? 63u : 31u;
    if (first.kind == PL_OPERAND_CONST && first.value == mask) {
        pl_operand swap = first;
        first = second;
        second = swap;
    }
    if (second.kind != PL_OPERAND_CONST || second.value != mask)
        return 0;
    /* x86 already masks a register count to 5/6 bits, so the explicit AND is
     * redundant.  CL can carry the count whenever the unwrapped chain is the
     * value published at RCX (the producer edge is already recorded by the
     * source law) or a bare entry RCX. */
    if (first.kind == PL_OPERAND_LOCAL && first.value == 1u) {
        *amount = first;
        return 1;
    }
    if (publication_owner(plan, first) == 1u) {
        *amount = (pl_operand){ PL_OPERAND_LOCAL, 1u };
        return 1;
    }
    return 0;
}

/* `lane{32,64}.insert(base, value, width)` with a node/projection base and
 * width < 64 is a partial-width write into an independently computed value:
 * materialize `base` into the destination, then apply `value` at `width`.
 * Base zero (zero-extension) has its own seed production. */
static int node_base_lane_insert(const pl_plan *plan, pl_operand value,
                                 pl_operand *base, pl_operand *inner,
                                 pl_u32 *width)
{
    if (!plan || !base || !inner || !width
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != 198u && node->opcode != 201u)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if ((arguments[0].kind != PL_OPERAND_NODE
                && arguments[0].kind != PL_OPERAND_PROJECTION)
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    *base = arguments[0];
    *inner = arguments[1];
    *width = (pl_u32)arguments[2].value;
    return 1;
}

/* A variable shift count the plan spells as `and(chain, hw_mask)` is exactly
 * what x86's register shift already does in hardware (CL mod 32/64), so the
 * mask is redundant even when `chain` is not a bare entry local.  This peels it
 * off and leaves the chain to be emitted into CL. */
static int masked_shift_count_details(const pl_plan *plan, pl_operand value,
                                      pl_operand *source, pl_operand *count,
                                      pl_u32 *bits, pl_u32 *group)
{
    if (!plan || !source || !count || !bits || !group
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    static const struct {
        pl_u32 opcode;
        pl_u8 bits;
        pl_u8 group;
    } spelling[] = {
        { PL_OPCODE_LANE32_ROTL, 32u, 0u },
        { PL_OPCODE_LANE64_ROTL, 64u, 0u },
        { PL_OPCODE_LANE32_ROTR, 32u, 1u },
        { PL_OPCODE_LANE64_ROTR, 64u, 1u },
        { PL_OPCODE_LANE32_SHL,  32u, 4u },
        { PL_OPCODE_LANE64_SHL,  64u, 4u },
        { PL_OPCODE_LANE32_SHLR, 32u, 4u },
        { PL_OPCODE_LANE64_SHLR, 64u, 4u },
        { PL_OPCODE_LANE32_SHR,  32u, 5u },
        { PL_OPCODE_LANE64_SHR,  64u, 5u },
        { PL_OPCODE_LANE32_SHRR, 32u, 5u },
        { PL_OPCODE_LANE64_SHRR, 64u, 5u },
        { PL_OPCODE_LANE32_SAR,  32u, 7u },
        { PL_OPCODE_LANE64_SAR,  64u, 7u },
        { PL_OPCODE_LANE32_SARR, 32u, 7u },
        { PL_OPCODE_LANE64_SARR, 64u, 7u },
    };
    pl_u32 form = 0u;
    for (; form < sizeof spelling / sizeof spelling[0]; ++form)
        if (node->opcode == spelling[form].opcode) break;
    if (form == sizeof spelling / sizeof spelling[0]
            || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    pl_operand amount = plan->arguments[node->argument_at + 1u];
    if (amount.kind != PL_OPERAND_NODE || !amount.value
            || amount.value > plan->node_count)
        return 0;
    const pl_node *bound = &plan->nodes[amount.value - 1u];
    if ((bound->opcode != 6u && bound->opcode != 76u)
            || bound->argument_count != 2u
            || bound->argument_at > plan->argument_count
            || 2u > plan->argument_count - bound->argument_at)
        return 0;
    pl_operand first = plan->arguments[bound->argument_at];
    pl_operand second = plan->arguments[bound->argument_at + 1u];
    pl_u64 mask = spelling[form].bits == 64u ? 63u : 31u;
    if (first.kind == PL_OPERAND_CONST && first.value == mask) {
        pl_operand swap = first;
        first = second;
        second = swap;
    }
    if (second.kind != PL_OPERAND_CONST || second.value != mask)
        return 0;
    if (first.kind == PL_OPERAND_CONST) return 0;
    *source = plan->arguments[node->argument_at];
    *count = first;
    *bits = spelling[form].bits;
    *group = spelling[form].group;
    return 1;
}

static int bit_summary_details(const pl_plan *plan, pl_operand value,
                                pl_operand *source, pl_u32 *bits, pl_u32 *mode)
{
    if (value.kind != PL_OPERAND_PROJECTION || (value.value & 0xffu) != 16u)
        return 0;
    pl_u32 number = (pl_u32)(value.value >> 8u);
    if (!number || number > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[number - 1u];
    if (node->opcode != PL_OPCODE_X86_BIT_SUMMARY || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at) return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[2].kind != PL_OPERAND_CONST) return 0;
    *bits = (pl_u32)(argument[2].value & 0xffu);
    *mode = (pl_u32)(argument[2].value >> 8u);
    if ((*bits != 32u && *bits != 64u) || *mode > 4u
            || argument[2].value != (*bits | ((pl_u64)*mode << 8u))) return 0;
    *source = argument[1];
    return 1;
}

static int emit_bit_summary(pl_u32 destination, pl_u32 source, pl_u32 bits,
                             pl_u32 mode, pl_u8 *output, pl_u32 *written)
{
    if (destination >= PL_X86_GPR_COUNT || source >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u) || mode > 4u) return 0;
    pl_u32 at = 0u;
    if (mode >= 2u) { if (output) output[at] = 0xf3u; ++at; }
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
        | (destination >= 8u ? 4u : 0u) | (source >= 8u ? 1u : 0u));
    if (rex != 0x40u) { if (output) output[at] = rex; ++at; }
    if (output) {
        output[at] = 0x0fu;
        output[at + 1u] = mode == 4u ? 0xb8u
                       : (mode == 1u || mode == 2u) ? 0xbcu : 0xbdu;
        output[at + 2u] = (pl_u8)(0xc0u | ((destination & 7u) << 3u) | (source & 7u));
    }
    *written = at + 3u;
    return 1;
}

static int zero_extend_high8_node(const pl_plan *plan, pl_u32 node_number,
                                  pl_u32 *source)
{
    if (!plan || !source || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_LANE64_INSERT
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[0].kind != PL_OPERAND_CONST || argument[0].value
            || argument[2].kind != PL_OPERAND_CONST
            || argument[2].value != 8u)
        return 0;
    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (!shift_node_details(
            plan, argument[1], &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            || shift_bits != 64u || shift_group != 5u
            || shift_source.kind != PL_OPERAND_LOCAL
            || shift_source.value >= 4u
            || shift_amount.kind != PL_OPERAND_CONST
            || shift_amount.value != 8u)
        return 0;
    *source = (pl_u32)shift_source.value;
    return 1;
}

/* Modular arithmetic and bitwise operations can compute the consumer's low
 * bits directly, but a narrow producer must wrap before zero extension into
 * a wider consumer. Shifts and rotates cannot truncate early: high bits and the count mask
 * depend on the producer's width before the consumer truncates its input. */
static pl_u32 alu_input_expression_bits(const pl_plan *plan,
                                        pl_operand value,
                                        pl_u32 consumer_bits)
{
    pl_operand source, amount;
    pl_u32 bits = 0u, group = 0u;
    if (shift_node_details(plan, value, &source, &amount, &bits, &group)) return bits;
    if (arithmetic_tree_details(plan, value, &source, &amount, &bits, &group)
            && bits < consumer_bits) return bits;
    return consumer_bits;
}

static pl_u32 operand_expression_bits(const pl_plan *plan,
                                      pl_operand value,
                                      pl_u32 fallback)
{
    if (value.kind == PL_OPERAND_NODE && value.value && value.value <= plan->node_count) {
        pl_u32 opcode = plan->nodes[value.value - 1u].opcode;
        if (opcode == PL_OPCODE_X86_TEST_CONDITION || opcode == PL_OPCODE_X86_CONDITION
                || opcode == PL_OPCODE_LANE64_EXTEND8_S
                || opcode == PL_OPCODE_LANE64_EXTEND16_S || opcode == PL_OPCODE_EXTEND32_S)
            return 64u;
        if (opcode == PL_OPCODE_ADD3[0] || opcode == PL_OPCODE_LANE32_MULR) return 32u;
        if (opcode == PL_OPCODE_ADD3[1] || opcode == PL_OPCODE_MULR) return 64u;
        if (opcode == PL_OPCODE_LANE32_BSWAP) return 32u;
        if (opcode == PL_OPCODE_LANE64_BSWAP) return 64u;
    }
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (arithmetic_tree_details(
            plan, value, &left, &right, &bits, &mode)) {
        (void)left;
        (void)right;
        (void)mode;
        return bits;
    }
    pl_operand source, amount;
    pl_u32 group = 0u;
    if (shift_node_details(
            plan, value, &source, &amount, &bits, &group)) {
        (void)source;
        (void)amount;
        (void)group;
        return bits;
    }
    if (value.kind == PL_OPERAND_PROJECTION
            && (value.value & 0xffu) == 16u) {
        pl_operand alu_source, alu_right;
        pl_u32 alu_mode = 0u, preserves_carry = 0u;
        if (alu_node_semantics(
                plan, (pl_u32)(value.value >> 8u),
                &alu_source, &alu_right, &bits,
                &alu_mode, &preserves_carry)) {
            (void)alu_source;
            (void)alu_right;
            (void)alu_mode;
            (void)preserves_carry;
            return bits;
        }
    }
    return fallback;
}

static int published_operand_local(const pl_plan *plan, pl_operand value,
                                   pl_u32 *local)
{
    if (!plan || !local) return 0;
    /* When an entry local remains unchanged it is the canonical physical
     * owner of that value.  A lower-numbered copy is semantically equal but
     * would add a false copy -> consumer edge (for example MOV rdi,rax;
     * TEST rdi,rdi).  Prefer the identity coordinate before scanning other
     * publications so register naming preserves the minimum SSA span. */
    if (value.kind == PL_OPERAND_LOCAL
            && value.value < PL_X86_GPR_COUNT) {
        pl_u32 identity = (pl_u32)value.value;
        pl_operand publication = plan->locals[identity];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == identity) {
            *local = identity;
            return 1;
        }
    }
    /* Dependency construction and instruction emission must name the same
     * physical owner.  publication_owner includes the destructive in-place
     * preference; bypassing it here could let a consumer read an equal but
     * not-yet-published register even though the canonical producer is ready. */
    pl_u32 canonical = publication_owner(plan, value);
    if (canonical < PL_X86_GPR_COUNT) {
        *local = canonical;
        return 1;
    }
    for (pl_u32 candidate = 0u;
            candidate < PL_X86_GPR_COUNT; ++candidate) {
        pl_operand publication = plan->locals[candidate];
        if (publication.kind == value.kind
                && publication.value == value.value) {
            *local = candidate;
            return 1;
        }
    }
    return 0;
}

/* Convert a semantic value to the GPR which owns its final publication.
 * Entry locals need this distinction when their architectural coordinate is
 * overwritten and an exact saved copy survives elsewhere.  The SSA operand
 * remains semantic; only the native schedule receives the physical owner.
 * alu_frame_source_laws records the matching publication dependency, so an
 * emitted consumer can never run before that owner has been established. */
static void physicalize_published_operand(const pl_plan *plan,
                                          pl_u32 destination,
                                          pl_operand *value)
{
    if (!plan || !value) return;
    if (value->kind == PL_OPERAND_LOCAL
            && value->value == destination)
        return;
    pl_u32 owner = PL_X86_GPR_COUNT;
    if (published_operand_local(plan, *value, &owner)
            && owner != destination
            && !(value->kind == PL_OPERAND_LOCAL
                 && value->value == owner)
            /* Keep a constant zero an immediate rather than reading the
             * zero-class flag producer's coordinate (matching
             * operand_source_law). */
            && !(value->kind == PL_OPERAND_CONST
                 && zero_self_flag_publication(plan, owner))) {
        value->kind = PL_OPERAND_LOCAL;
        value->value = owner;
    }
}

static int physicalize_transient_operand(
    const pl_x86_native_selection *selection, pl_operand *value)
{
    if (!value) return 0;
    if (selection) {
        for (pl_u32 alias = 0u; alias < selection->value_alias_count; ++alias)
            if (selection->value_alias_kind[alias] == value->kind
                    && selection->value_alias_value[alias] == value->value
                    && selection->value_alias_local[alias] < PL_X86_GPR_COUNT) {
                value->kind = PL_OPERAND_LOCAL;
                value->value = selection->value_alias_local[alias];
                return 1;
            }
    }
    if (selection && selection->frame_alias_present
            && value->kind == selection->frame_alias_kind
            && value->value == selection->frame_alias_value
            && selection->frame_alias_local < PL_X86_GPR_COUNT) {
        value->kind = PL_OPERAND_LOCAL;
        value->value = selection->frame_alias_local;
        return 1;
    }
    return 0;
}

static void physicalize_selected_operand(
    const pl_plan *plan, const pl_x86_native_selection *selection,
    pl_u32 destination, pl_operand *value)
{
    if (!value || physicalize_transient_operand(selection, value)) return;
    physicalize_published_operand(plan, destination, value);
}

/* Record that a computed SSA node now lives in one GPR.  A frame that
 * materializes a shared subtree (a conditional arm, a preloaded tree) into a
 * destination must resolve later references to that same node through the
 * destination instead of rebuilding it from an entry local the materializing
 * publication may already have overwritten. */
static void push_frame_value_alias(pl_x86_native_selection *selection,
                                   pl_u8 kind, pl_u64 value, pl_u8 local)
{
    if (!selection || local >= PL_X86_GPR_COUNT
            || selection->value_alias_count >= PL_X86_VALUE_ALIAS_COUNT)
        return;
    pl_u32 at = selection->value_alias_count++;
    selection->value_alias_kind[at] = kind;
    selection->value_alias_value[at] = value;
    selection->value_alias_local[at] = local;
}

/* ADD/AND/OR/XOR have no semantic left/right order.  Prefer the arm whose
 * entry generation already occupies the destructive destination, including a
 * nested shift or arithmetic subtree.  Restricting this to a literal local
 * forces a scratch tree and two moves after quotient substitution exposes a
 * deeper destination-owned arm. */
static void orient_commutative_destination(
    const pl_plan *plan, pl_u32 destination,
    pl_u32 mode, pl_operand *left, pl_operand *right)
{
    if (!plan || !left || !right || mode == 3u
            || destination >= PL_X86_GPR_COUNT)
        return;
    pl_u32 left_sources = 0u, right_sources = 0u;
    if (!operand_gpr_sources(
            plan, *left, plan->node_count + 1u,
            plan->node_count + 1u, &left_sources)
            || !operand_gpr_sources(
                plan, *right, plan->node_count + 1u,
                plan->node_count + 1u, &right_sources))
        return;
    pl_u32 destination_bit = 1u << destination;
    if ((right_sources & destination_bit)
            && !(left_sources & destination_bit)) {
        pl_operand swap = *left;
        *left = *right;
        *right = swap;
    }
}

static int sign_high_node_details(const pl_plan *plan, pl_operand value,
                                  pl_u32 *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count)
        return 0;
    const pl_node *outer = &plan->nodes[value.value - 1u];
    pl_operand shifted = value;
    *bits = 64u;
    if (outer->opcode == PL_OPCODE_LANE64_INSERT
            && outer->argument_count == 3u
            && outer->argument_at <= plan->argument_count
            && outer->argument_count
               <= plan->argument_count - outer->argument_at) {
        const pl_operand *argument = plan->arguments + outer->argument_at;
        if (argument[0].kind != PL_OPERAND_CONST || argument[0].value
                || argument[2].kind != PL_OPERAND_CONST
                || argument[2].value != 32u)
            return 0;
        shifted = argument[1];
        *bits = 32u;
    }
    if (shifted.kind != PL_OPERAND_NODE || !shifted.value
            || shifted.value > plan->node_count)
        return 0;
    const pl_node *shift = &plan->nodes[shifted.value - 1u];
    if ((shift->opcode != PL_OPCODE_LANE64_SAR
            && shift->opcode != PL_OPCODE_LANE64_SARR)
            || shift->argument_count != 2u
            || shift->argument_at > plan->argument_count
            || shift->argument_count
               > plan->argument_count - shift->argument_at)
        return 0;
    const pl_operand *shift_argument =
        plan->arguments + shift->argument_at;
    if (shift_argument[1].kind != PL_OPERAND_CONST
            || shift_argument[1].value != (*bits == 64u ? 63u : 31u))
        return 0;
    pl_operand low = shift_argument[0];
    if (*bits == 32u) {
        if (low.kind != PL_OPERAND_NODE || !low.value
                || low.value > plan->node_count)
            return 0;
        const pl_node *extend = &plan->nodes[low.value - 1u];
        if (extend->opcode != PL_OPCODE_EXTEND32_S
                || extend->argument_count != 1u
                || extend->argument_at >= plan->argument_count)
            return 0;
        low = plan->arguments[extend->argument_at];
    }
    pl_u32 local = PL_X86_GPR_COUNT;
    if (low.kind == PL_OPERAND_LOCAL && low.value < PL_X86_GPR_COUNT)
        local = (pl_u32)low.value;
    else if (!published_operand_local(plan, low, &local))
        return 0;
    if (local != 0u) return 0;
    *source = local;
    return 1;
}

static int scaled_lea_node_details(const pl_plan *plan, pl_operand value,
                                   pl_u32 *source, pl_u32 *bits,
                                   pl_u32 *scale_log2)
{
    if (!plan || !source || !bits || !scale_log2
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    *bits = node->opcode == PL_OPCODE_LANE32_SHL ? 32u
          : node->opcode == PL_OPCODE_LANE64_SHL ? 64u : 0u;
    if (!*bits || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value >= PL_X86_GPR_COUNT
            || argument[1].kind != PL_OPERAND_CONST
            || !argument[1].value || argument[1].value > 3u)
        return 0;
    *source = (pl_u32)argument[0].value;
    *scale_log2 = (pl_u32)argument[1].value;
    return 1;
}

typedef struct {
    pl_u32 destination;
    pl_u32 value_source;
    pl_u32 value_bits;
    pl_u32 scale_log2;
    pl_u32 mode;
    pl_operand right;
} independent_flag_overwrite;

typedef struct {
    pl_u32 destination;
    pl_u32 source;
    pl_u32 mode;
    pl_operand right;
    pl_operand source_publication;
} narrow_flag_transfer;

/* A partial-width ALU instruction may consume the low byte of an entry word
 * after that word has been copied with a 32-bit move, while the entry owner is
 * independently overwritten.  Keeping the normalized value and exact flag
 * producer separate otherwise materializes a 64-bit mask in that owner:
 *
 *   zext32(source); low8-op immediate; source = constant.
 *
 * The first move feeds both the byte operation and the anti-dependency on the
 * source overwrite.  Consequently the byte operation and the overwrite share
 * the second wave. */
static int narrow_flag_transfer_shape(
    const pl_x86_block *block, narrow_flag_transfer *out)
{
    static const pl_u8 semantic_for_mode[7] = {
        0u, 255u, 255u, 255u, 255u, 3u, 4u,
    };
    if (!block || !out || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    if (!alu_frame_shape(plan, &changed, &final_flag_node)) return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count
            || flags.value != final_flag_node)
        return 0;
    const pl_node *flag_node = &plan->nodes[flags.value - 1u];
    if (flag_node->opcode != PL_OPCODE_X86_FLAGS
            || flag_node->argument_count != 5u
            || flag_node->argument_at > plan->argument_count
            || flag_node->argument_count
               > plan->argument_count - flag_node->argument_at)
        return 0;
    const pl_operand *argument =
        plan->arguments + flag_node->argument_at;
    if (argument[1].kind != PL_OPERAND_NODE
            || argument[2].kind != PL_OPERAND_CONST
            || argument[3].kind != PL_OPERAND_NODE
            || !argument[3].value || argument[3].value > plan->node_count
            || argument[4].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 bits = (pl_u32)(descriptor & 0x7fu);
    pl_u32 mode = (pl_u32)((descriptor >> 8u) & 7u);
    if (bits != 8u || mode > 6u || semantic_for_mode[mode] == 255u
            || descriptor != (pl_u64)(bits | (mode << 8u)))
        return 0;
    pl_u32 source = 0u, source_bits = 0u;
    if (!zero_extend_node(
            plan, (pl_u32)argument[1].value, &source, &source_bits)
            || source_bits != 32u)
        return 0;

    const pl_node *result = &plan->nodes[argument[3].value - 1u];
    if (result->opcode
            != PL_OPCODE_ALU_IMMEDIATE[0][semantic_for_mode[mode]]
            || result->argument_count != 2u
            || result->argument_at > plan->argument_count
            || result->argument_count
               > plan->argument_count - result->argument_at)
        return 0;
    const pl_operand *result_argument =
        plan->arguments + result->argument_at;
    int exact_base = result_argument[0].kind == argument[1].kind
                  && result_argument[0].value == argument[1].value;
    int physical_base = result_argument[0].kind == PL_OPERAND_LOCAL
                     && result_argument[0].value == source;
    if ((!exact_base && !physical_base)
            || result_argument[1].kind != PL_OPERAND_CONST
            || (pl_u32)result_argument[1].value
               != (pl_u32)argument[2].value)
        return 0;

    pl_u64 low_mask = 0xffu;
    pl_u64 immediate = argument[2].value & low_mask;
    pl_u64 expected = mode == 0u
        ? ((0xffffffffu & ~low_mask) | immediate) : immediate;
    pl_u32 destination = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        if (local == source) {
            if (value.kind != PL_OPERAND_CONST) return 0;
            continue;
        }
        pl_operand left, right;
        pl_u32 value_bits = 0u, value_mode = 0u;
        if (!arithmetic_tree_details(
                plan, value, &left, &right,
                &value_bits, &value_mode)) {
            if (value.kind != PL_OPERAND_LOCAL || value.value != local)
                return 0;
            continue;
        }
        if (destination < PL_X86_GPR_COUNT || value_mode != mode
                || (value_bits != 32u && value_bits != 64u))
            return 0;
        if (left.kind == PL_OPERAND_CONST) {
            pl_operand swap = left; left = right; right = swap;
        }
        int base_is_source = left.kind == PL_OPERAND_LOCAL
                          && left.value == source;
        int base_is_extended = left.kind == argument[1].kind
                            && left.value == argument[1].value;
        if (right.kind != PL_OPERAND_CONST || right.value != expected
                || (!base_is_extended
                    && !(base_is_source
                         && (value_bits == 32u || mode == 0u))))
            return 0;
        destination = local;
    }
    if (destination >= PL_X86_GPR_COUNT || destination == source)
        return 0;
    out->destination = destination;
    out->source = source;
    out->mode = mode;
    out->right = (pl_operand){ PL_OPERAND_CONST, immediate };
    out->source_publication = plan->locals[source];
    return 1;
}

static int measure_narrow_flag_transfer(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    const narrow_flag_transfer *shape)
{
    if (!frontend || !block || !selection || !shape) return 0;
    pl_u32 bytes = 0u, part = 0u;
    if (!emit_zero_extend_move(
            shape->destination, shape->source, 32u,
            (pl_u8 *)0, &part))
        return 0;
    bytes += part;
    if (!emit_low8_alu_flags(
            shape->destination, shape->right, shape->mode,
            (pl_u8 *)0, &part)
            || bytes > U32_MAX_VALUE - part)
        return 0;
    bytes += part;
    int measured = measure_frame_value(
        frontend, block, selection, shape->source,
        shape->source_publication, bytes, &part);
    if (measured <= 0 || bytes > U32_MAX_VALUE - part)
        return measured < 0 ? measured : 0;
    selection->output_bytes = bytes + part;
    selection->output_instructions = 3u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_nested_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int independent_flag_overwrite_shape(
    const pl_plan *plan, independent_flag_overwrite *out)
{
    static const pl_u8 semantic_for_mode[7] = {
        0u, 1u, 255u, 2u, 255u, 3u, 4u,
    };
    if (!plan || !out || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count)
        return 0;
    const pl_node *flag_node = &plan->nodes[flags.value - 1u];
    if (flag_node->opcode != PL_OPCODE_X86_FLAGS
            || flag_node->argument_count != 5u
            || flag_node->argument_at > plan->argument_count
            || flag_node->argument_count
               > plan->argument_count - flag_node->argument_at)
        return 0;
    const pl_operand *argument =
        plan->arguments + flag_node->argument_at;
    if (argument[1].kind != PL_OPERAND_LOCAL
            || argument[1].value >= PL_X86_GPR_COUNT
            || argument[2].kind != PL_OPERAND_CONST
            || argument[3].kind != PL_OPERAND_NODE
            || !argument[3].value || argument[3].value > plan->node_count
            || argument[4].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 bits = (pl_u32)(descriptor & 0x7fu);
    pl_u32 mode = (pl_u32)((descriptor >> 8u) & 7u);
    if (bits != 8u || mode > 6u || semantic_for_mode[mode] == 255u
            || descriptor != (pl_u64)(bits | (mode << 8u)))
        return 0;
    const pl_node *result = &plan->nodes[argument[3].value - 1u];
    if (result->opcode
            != PL_OPCODE_ALU_IMMEDIATE[0][semantic_for_mode[mode]]
            || result->argument_count != 2u
            || result->argument_at > plan->argument_count
            || result->argument_count
               > plan->argument_count - result->argument_at)
        return 0;
    const pl_operand *result_argument =
        plan->arguments + result->argument_at;
    if (result_argument[0].kind != argument[1].kind
            || result_argument[0].value != argument[1].value
            || result_argument[1].kind != PL_OPERAND_CONST
            || (pl_u8)result_argument[1].value != (pl_u8)argument[2].value)
        return 0;
    pl_u32 destination = (pl_u32)argument[1].value;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (local == destination) {
            if (value.kind == PL_OPERAND_LOCAL && value.value == local)
                return 0;
        } else if (value.kind != PL_OPERAND_LOCAL || value.value != local) {
            return 0;
        }
    }
    if (!scaled_lea_node_details(
            plan, plan->locals[destination], &out->value_source,
            &out->value_bits, &out->scale_log2)
            || out->value_source == destination)
        return 0;
    out->destination = destination;
    out->mode = mode;
    out->right = argument[2];
    out->right.value &= 0xffu;
    return 1;
}

typedef struct {
    pl_operand current;
    pl_operand compare_right;
    pl_operand compare_left_value;
    pl_operand compare_right_value;
    pl_operand candidate_value;
    pl_u32 candidate_local;
    pl_u32 candidate_is_entry;
    pl_u32 candidate_immediate;
    pl_u32 compare_left_local;
    pl_u32 value_bits;
    pl_u32 compare_bits;
    pl_u32 condition;
    pl_u32 has_compare;
    pl_u32 current_flag_node;
    pl_u32 compare_test;
    pl_u32 compare_offset;
    pl_u32 compare_node;
    pl_u32 compare_left_is_current;
    pl_u32 compare_right_is_current;
    pl_u32 compare_left_seed;
    pl_u32 compare_right_seed;
} conditional_select;

typedef struct {
    pl_operand when_true;
    pl_operand when_false;
    pl_operand condition;
    pl_u32 value_bits;
} boolean_select;

typedef struct {
    pl_operand flags;
    pl_u32 condition;
} condition_value;

static int condition_value_details(const pl_plan *plan, pl_operand value,
                                   condition_value *out)
{
    if (!plan || !out || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode != PL_OPCODE_X86_CONDITION
            || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[1].kind != PL_OPERAND_CONST || argument[1].value > 15u)
        return 0;
    out->flags = argument[0];
    out->condition = (pl_u32)argument[1].value;
    return 1;
}

static int flag_operation_details(const pl_plan *plan, pl_operand flags,
                                  pl_operand *left, pl_operand *right,
                                  pl_u32 *bits, pl_u32 *mode,
                                  pl_u32 *preserves_carry)
{
    if (!plan || !left || !right || !bits || !mode || !preserves_carry
            || flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[flags.value - 1u];
    if ((node->opcode != PL_OPCODE_X86_TEST
            && node->opcode != PL_OPCODE_X86_COMPARE
            && node->opcode != PL_OPCODE_X86_ALU
            && node->opcode != PL_OPCODE_X86_FLAGS)
            || node->argument_count
               != (node->opcode == PL_OPCODE_X86_FLAGS ? 5u : 4u)
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    pl_u32 descriptor_at = node->opcode == PL_OPCODE_X86_FLAGS ? 4u : 3u;
    if (argument[descriptor_at].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[descriptor_at].value;
    *bits = (pl_u32)(descriptor & 0x7fu);
    *mode = (pl_u32)((descriptor >> 8u) & 7u);
    *preserves_carry = (pl_u32)((descriptor >> 11u) & 1u);
    if ((*bits != 8u && *bits != 16u
            && *bits != 32u && *bits != 64u)
            || descriptor != ((pl_u64)*bits | ((pl_u64)*mode << 8u)
                | ((pl_u64)*preserves_carry << 11u))
            || (node->opcode == PL_OPCODE_X86_TEST && *mode != 0u)
            || (node->opcode == PL_OPCODE_X86_COMPARE && *mode != 3u)
            || (node->opcode != PL_OPCODE_X86_ALU && *preserves_carry))
        return 0;
    *left = argument[1];
    *right = argument[2];
    return 1;
}

/* X86_FLAGS keeps the exact pre-normalization operands beside the normalized
 * result.  When that result is also a GPR publication, its one destructive
 * ALU instruction is the unique physical producer of both publications.
 * Re-emitting the value as LEA would preserve the numeric result but silently
 * drop RFLAGS; emitting a separate flag instruction would add avoidable work.
 */
static int flag_value_operation_details(
    const pl_plan *plan, pl_u32 flag_node, pl_operand value,
    pl_operand *left, pl_operand *right, pl_u32 *bits,
    pl_u32 *mode, pl_u32 *preserves_carry)
{
    if (!plan || !flag_node || flag_node > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[flag_node - 1u];
    if (node->opcode != PL_OPCODE_X86_FLAGS
            || node->argument_count != 5u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[3].kind != value.kind
            || argument[3].value != value.value)
        return 0;
    pl_operand flags = { PL_OPERAND_NODE, flag_node };
    return flag_operation_details(
        plan, flags, left, right, bits, mode, preserves_carry);
}

/* An in-place lane insert `insert(base, value, width)` whose inserted value is
 * the final flag result is a partial-width publication of that result: the
 * emitted byte/word ALU writes only the low lane and reads the base tree.
 * Rewriting the publication to the inserted value lets the ordinary flag
 * branch emit it (base included), while `publication_is_flag_result` already
 * carries the flag provenance.  Returns `value` unchanged otherwise. */
static pl_operand publication_for_emission(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 flag_node)
{
    if (!plan || !flag_node || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count)
        return value;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != 198u && node->opcode != 201u)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return value;
    pl_operand inserted = plan->arguments[node->argument_at + 1u];
    pl_operand base = plan->arguments[node->argument_at];
    pl_operand width_operand = plan->arguments[node->argument_at + 2u];
    if (width_operand.kind != PL_OPERAND_CONST)
        return value;
    pl_u32 inserted_owner = PL_X86_GPR_COUNT;
    /* A zero-based lane extension narrower than a register word is a real
     * truncation (`insert(0, N, 16)`), and if N already has its own
     * publication this node is its zero-extended image.  Dropping it because
     * the flags also name N would publish N's full 32-bit word. */
    if (base.kind == PL_OPERAND_CONST && !base.value
            && (pl_u32)width_operand.value < 32u
            && published_operand_local(plan, inserted, &inserted_owner))
        return value;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (flag_value_operation_details(
            plan, flag_node, inserted, &left, &right, &bits, &mode,
            &preserves_carry))
        return inserted;
    return value;
}

/* A `lane{32,64}.insert(base, value, width)` whose base is the published local
 * itself is an in-place low-lane write: it preserves the base's upper bits and
 * replaces the low `width` bits from `value`.  The inserted node carries a
 * full-width lane op, so the emitter must apply it at the insert's width, not
 * the node's own expression width. */
static int in_place_lane_insert(const pl_plan *plan, pl_operand value,
                                pl_u32 local, pl_operand *inner,
                                pl_u32 *width)
{
    if (!plan || !inner || !width || local >= PL_X86_GPR_COUNT
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != 198u && node->opcode != 201u)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value != local
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    /* Measured physical vocabulary: lane {and,or,xor,add} are 6,7,8,9 and
     * their lane64 forms 76,77,78,79.  Only a lane ALU op can be applied at an
     * arbitrary width; any other inserted node needs its own production, and
     * falling through keeps selection total instead of aborting it. */
    if (arguments[1].kind != PL_OPERAND_NODE || !arguments[1].value
            || arguments[1].value > plan->node_count)
        return 0;
    pl_u32 opcode = plan->nodes[arguments[1].value - 1u].opcode;
    if (opcode != 6u && opcode != 7u && opcode != 8u && opcode != 9u
            && opcode != 76u && opcode != 77u && opcode != 78u
            && opcode != 79u)
        return 0;
    *inner = arguments[1];
    *width = (pl_u32)arguments[2].value;
    return 1;
}

/* `insert(local, constant, 8|16)` replaces the low lane of the published local
 * with a constant; with base == destination it is one lane-width constant
 * move.  A 32-bit insert would also have to preserve the base's upper word,
 * which a 32-bit move does not, so it stays out of this production. */
static int lane_constant_insert(const pl_plan *plan, pl_operand value,
                                pl_u32 local, pl_u64 *constant,
                                pl_u32 *width)
{
    if (!plan || !constant || !width || local >= PL_X86_GPR_COUNT
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != PL_OPCODE_LANE64_INSERT
                && node->opcode != PL_OPCODE_LANE32_INSERT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value != local
            || arguments[1].kind != PL_OPERAND_CONST
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u))
        return 0;
    *constant = arguments[1].value;
    *width = (pl_u32)arguments[2].value;
    return 1;
}

typedef struct {
    pl_u32 left;
    pl_operand right;
    pl_u32 bits;
    pl_u32 test;
    pl_u32 offset;
    pl_u32 bit_test;
    pl_u32 entry_sources;
    pl_u32 owner_dependencies;
} standalone_flag_publication;

/* TEST observes one byte and its own byte-sized SF/PF/ZF. Replacing it with
 * a wider shifted mask would change parity. Keep the observation width and
 * substitute the byte's physical coordinate instead of computing a shift. */
static pl_u32 test_byte_coordinate(const pl_plan *plan, pl_operand *left,
                                   pl_operand right, pl_u32 bits, pl_u32 test)
{
    pl_operand source, amount;
    pl_u32 width = 0u, group = 0u;
    if (!test || bits != 8u || right.kind != PL_OPERAND_CONST || right.value > 255u
            || !shift_node_details(plan, *left, &source, &amount, &width, &group)
            || (width != 32u && width != 64u) || group != 5u
            || amount.kind != PL_OPERAND_CONST || amount.value != 8u) return 0u;
    *left = source;
    return 8u;
}

static int emit_flag_coordinate(pl_u32 left, pl_operand right, pl_u32 bits,
                                 pl_u32 test, pl_u32 offset,
                                 pl_u8 *output, pl_u32 *written)
{
    if (offset) return offset == 8u && bits == 8u && test
        && emit_high8_test(left, right, output, written);
    return test ? emit_test_operand(left, right, bits, output, written)
                : emit_compare_operand(left, right, bits, output, written);
}

/* TEST and CMP can be the sole final RFLAGS publication without publishing a
 * GPR result.  Keep that instruction explicit: all earlier flag-clobbering
 * work must finish first, while its entry operands must remain live until it
 * is emitted.  Exact saved owners may replace those entry coordinates. */
static int standalone_flag_publication_details(
    const pl_plan *plan, pl_u32 node_number,
    standalone_flag_publication *out)
{
    if (!plan || !out || !node_number || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode == PL_OPCODE_X86_BIT_FLAGS) {
        if (node->argument_count != 4u
                || node->argument_at > plan->argument_count
                || 4u > plan->argument_count - node->argument_at)
            return 0;
        const pl_operand *argument = plan->arguments + node->argument_at;
        if (argument[3].kind != PL_OPERAND_CONST
                || (argument[3].value != 32u && argument[3].value != 64u))
            return 0;
        /* The normalized argument order for `bt` is (prior, offset, base,
         * bits), but the physical rewriter can hand over (prior, base, offset,
         * bits) when the offset is an immediate.  Resolve the base to whichever
         * slot holds a register. */
        pl_u32 base_at = 2u, offset_at = 1u;
        if (argument[2].kind == PL_OPERAND_CONST
                && argument[1].kind == PL_OPERAND_LOCAL) {
            base_at = 1u;
            offset_at = 2u;
        }
        pl_operand base = argument[base_at];
        pl_operand offset = argument[offset_at];
        physicalize_published_operand(plan, PL_X86_GPR_COUNT, &base);
        physicalize_published_operand(plan, PL_X86_GPR_COUNT, &offset);
        if (base.kind != PL_OPERAND_LOCAL || base.value >= PL_X86_GPR_COUNT
                || (offset.kind != PL_OPERAND_LOCAL
                    && offset.kind != PL_OPERAND_CONST))
            return 0;
        out->bit_test = 1u;
        out->test = 0u;
        out->offset = 0u;
        out->bits = (pl_u32)argument[3].value;
        out->left = (pl_u32)base.value;
        out->right = offset;
        out->entry_sources = 0u;
        out->owner_dependencies = 0u;
        if (argument[base_at].kind == PL_OPERAND_LOCAL
                && argument[base_at].value == base.value)
            out->entry_sources |= 1u << out->left;
        else
            out->owner_dependencies |= 1u << out->left;
        if (offset.kind == PL_OPERAND_LOCAL) {
            if (argument[offset_at].kind == PL_OPERAND_LOCAL
                    && argument[offset_at].value == offset.value)
                out->entry_sources |= 1u << (pl_u32)offset.value;
            else
                out->owner_dependencies |= 1u << (pl_u32)offset.value;
        }
        return 1;
    }
    if (node->opcode != PL_OPCODE_X86_TEST
            && node->opcode != PL_OPCODE_X86_COMPARE)
        return 0;
    out->bit_test = 0u;
    pl_operand flags = { PL_OPERAND_NODE, node_number };
    pl_operand left, right;
    pl_u32 mode = 0u, preserves_carry = 0u;
    if (!flag_operation_details(
            plan, flags, &left, &right, &out->bits,
            &mode, &preserves_carry))
        return 0;
    out->test = (pl_u32)(node->opcode == PL_OPCODE_X86_TEST);
    out->offset = test_byte_coordinate(plan, &left, right, out->bits, out->test);
    pl_operand *input[2] = { &left, &right };
    for (pl_u32 i = 0u; i < 2u; ++i) {
        pl_operand value = *input[i];
        pl_u32 source = 0u, width = 0u;
        if (value.kind == PL_OPERAND_NODE
                && zero_extend_node(plan, (pl_u32)value.value, &source, &width)
                && width >= out->bits) {
            const pl_node *extend = &plan->nodes[value.value - 1u];
            pl_operand original = plan->arguments[extend->argument_at + 1u];
            if (original.kind == PL_OPERAND_LOCAL) *input[i] = original;
        }
    }
    pl_operand physical_left = left;
    pl_operand physical_right = right;
    physicalize_published_operand(
        plan, PL_X86_GPR_COUNT, &physical_left);
    physicalize_published_operand(
        plan, PL_X86_GPR_COUNT, &physical_right);
    if (out->offset && (physical_left.kind != PL_OPERAND_LOCAL || physical_left.value >= 4u)) {
        /* A shared value may have a preferred owner without a high-byte
         * encoding, yet also be published in RAX..RBX. Read that exact alias
         * after its copy-out instead of rebuilding the shifted byte. */
        for (pl_u32 local = 0u; local < 4u; ++local)
            if (plan->locals[local].kind == left.kind && plan->locals[local].value == left.value) {
                physical_left = (pl_operand){ PL_OPERAND_LOCAL, local };
                break;
            }
    }
    if (physical_left.kind != PL_OPERAND_LOCAL
            || physical_left.value >= PL_X86_GPR_COUNT
            || (physical_right.kind != PL_OPERAND_CONST
                && (physical_right.kind != PL_OPERAND_LOCAL
                    || physical_right.value >= PL_X86_GPR_COUNT)))
        return 0;
    out->left = (pl_u32)physical_left.value;
    if (out->offset && out->left >= 4u) return 0;
    out->right = physical_right;
    out->entry_sources = 0u;
    out->owner_dependencies = 0u;
    /* The final instruction reads physical operands, not every entry value
     * inside their SSA definitions.  A direct architectural local must stay
     * live until TEST/CMP; a node/projection (or a saved copy of an entry)
     * instead creates a producer edge from its final published owner. */
    if (left.kind == PL_OPERAND_LOCAL
            && left.value == physical_left.value)
        out->entry_sources |= 1u << out->left;
    else
        out->owner_dependencies |= 1u << out->left;
    if (physical_right.kind == PL_OPERAND_LOCAL) {
        pl_u32 right_local = (pl_u32)physical_right.value;
        if (right.kind == PL_OPERAND_LOCAL
                && right.value == physical_right.value)
            out->entry_sources |= 1u << right_local;
        else
            out->owner_dependencies |= 1u << right_local;
    }
    (void)mode;
    (void)preserves_carry;
    return 1;
}

/* BT tests one bit of the base named by a register offset (`0F A3 /r`) or an
 * imm8 offset (`0F BA /4 ib`).  The flag producer has no GPR result, so this
 * is a standalone final-flag publication like TEST/CMP. */
static int emit_bit_test_register(pl_u32 base, pl_operand offset, pl_u32 bits,
                                  pl_u8 *output, pl_u32 *written)
{
    if (!written || base >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    if (offset.kind == PL_OPERAND_LOCAL) {
        if (offset.value >= PL_X86_GPR_COUNT) return 0;
        pl_u32 at = 0u;
        pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
            | ((pl_u32)offset.value >= 8u ? 4u : 0u)
            | (base >= 8u ? 1u : 0u));
        if (rex != 0x40u) {
            if (output) output[at] = rex;
            ++at;
        }
        if (output) output[at] = 0x0fu;
        ++at;
        if (output) output[at] = 0xa3u;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | (((pl_u32)offset.value & 7u) << 3u) | (base & 7u));
        ++at;
        *written = at;
        return 1;
    }
    if (offset.kind == PL_OPERAND_CONST && offset.value <= 0xffu) {
        pl_u32 at = 0u;
        pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
            | (base >= 8u ? 1u : 0u));
        if (rex != 0x40u) {
            if (output) output[at] = rex;
            ++at;
        }
        if (output) output[at] = 0x0fu;
        ++at;
        if (output) output[at] = 0xbau;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u | (4u << 3u) | (base & 7u));
        ++at;
        if (output) output[at] = (pl_u8)offset.value;
        ++at;
        *written = at;
        return 1;
    }
    return 0;
}

static int emit_standalone_flag_publication(
    const standalone_flag_publication *publication,
    pl_u8 *output, pl_u32 *written)
{
    if (!publication) return 0;
    if (publication->bit_test)
        return emit_bit_test_register(
            publication->left, publication->right,
            publication->bits, output, written);
    return emit_flag_coordinate(publication->left, publication->right,
        publication->bits, publication->test, publication->offset, output, written);
}

typedef struct {
    standalone_flag_publication compare;
    pl_u32 source, bits, mode, zero_mask;
    pl_operand immediate;
} carry_adjustment;

static int carry_adjustment_details(const pl_plan *plan, pl_operand value,
                                     pl_u32 destination, pl_u32 bits, carry_adjustment *out)
{
    if (value.kind == PL_OPERAND_NODE && value.value && value.value <= plan->node_count) {
        const pl_node *select = &plan->nodes[value.value - 1u];
        if ((select->opcode == PL_OPCODE_LANE32_SELECT
                || select->opcode == PL_OPCODE_LANE64_SELECT)
                && select->argument_count == 3u && select->argument_at <= plan->argument_count
                && 3u <= plan->argument_count - select->argument_at) {
            const pl_operand *argument = plan->arguments + select->argument_at;
            condition_value condition;
            if (condition_value_details(plan, argument[2], &condition)
                    && (condition.condition == 4u || condition.condition == 5u)
                    && condition.flags.kind == PL_OPERAND_NODE
                    && standalone_flag_publication_details(plan,
                        (pl_u32)condition.flags.value, &out->compare)
                    && out->compare.test && out->compare.bits == bits
                    && out->compare.right.kind == PL_OPERAND_LOCAL
                    && out->compare.right.value == out->compare.left) {
                pl_operand unit = argument[condition.condition == 4u ? 0u : 1u];
                pl_operand current = argument[condition.condition == 4u ? 1u : 0u];
                pl_u32 source = PL_X86_GPR_COUNT, width = 0u;
                if (current.kind == PL_OPERAND_LOCAL && current.value < PL_X86_GPR_COUNT)
                    source = (pl_u32)current.value;
                else if (current.kind == PL_OPERAND_NODE
                        && zero_extend_node(plan, (pl_u32)current.value, &source, &width)
                        && width != bits) source = PL_X86_GPR_COUNT;
                if (unit.kind == PL_OPERAND_CONST && unit.value == 1u
                        && source < PL_X86_GPR_COUNT) {
                    pl_operand physical = { PL_OPERAND_LOCAL, source };
                    physicalize_published_operand(plan, destination, &physical);
                    if (physical.kind == PL_OPERAND_LOCAL
                            && physical.value == out->compare.left) {
                        /* max_unsigned(x,1) = x + [x < 1]. The condition
                         * remains in CF; no constant-arm register is needed. */
                        out->compare.test = 0u;
                        out->compare.right = (pl_operand){ PL_OPERAND_CONST, 1u };
                        out->source = (pl_u32)physical.value;
                        out->bits = bits; out->mode = 2u; out->zero_mask = 0u;
                        out->immediate = (pl_operand){ PL_OPERAND_CONST, 0u };
                        return 1;
                    }
                }
            }
        }
    }
    pl_operand current, predicate;
    pl_u32 mode = 0u;
    pl_u64 offset = 0u;
    pl_operand complement, negated;
    pl_u32 complement_bits = 0u, negated_bits = 0u;
    int complemented_mask = complement_node_details(plan, value, &complement, &complement_bits)
        && negation_node_details(plan, complement, &negated, &negated_bits)
        && complement_bits == negated_bits;
    if (complemented_mask) value = complement;
    if (!arithmetic_tree_details(plan, value, &current, &predicate, &out->bits, &mode)) {
        if (value.kind != PL_OPERAND_NODE || !value.value || value.value > plan->node_count)
            return 0;
        const pl_node *sum = &plan->nodes[value.value - 1u];
        if ((sum->opcode != PL_OPCODE_ADD3[0] && sum->opcode != PL_OPCODE_ADD3[1])
                || sum->argument_count != 3u || sum->argument_at > plan->argument_count
                || 3u > plan->argument_count - sum->argument_at) return 0;
        const pl_operand *argument = plan->arguments + sum->argument_at;
        pl_u32 constant = 0u;
        while (constant < 3u && argument[constant].kind != PL_OPERAND_CONST) ++constant;
        if (constant == 3u) return 0;
        offset = argument[constant].value;
        current = argument[(constant + 1u) % 3u];
        predicate = argument[(constant + 2u) % 3u];
        out->bits = sum->opcode == PL_OPCODE_ADD3[0] ? 32u : 64u;
        mode = 1u;
    }
    if (mode != 1u && mode != 3u) return 0;
    condition_value condition;
    if (!condition_value_details(plan, predicate, &condition)) {
        if (mode != 1u || !condition_value_details(plan, current, &condition)) return 0;
        current = predicate;
    }
    if (complemented_mask) {
        if (current.kind != PL_OPERAND_CONST || current.value || offset || mode != 3u)
            return 0;
        /* ~(0-p) = 0-(1-p) for a Boolean p. */
        condition.condition ^= 1u;
    }
    if ((condition.condition != 2u && condition.condition != 3u)
            || condition.flags.kind != PL_OPERAND_NODE
            || !standalone_flag_publication_details(
                plan, (pl_u32)condition.flags.value, &out->compare)
            || out->compare.test) return 0;
    pl_operand base, addend;
    pl_u32 current_bits = 0u, current_mode = 0u;
    if (arithmetic_tree_details(plan, current, &base, &addend, &current_bits, &current_mode)
            && current_bits == out->bits && (current_mode == 1u || current_mode == 3u)
            && addend.kind == PL_OPERAND_CONST) {
        offset += current_mode == 1u ? addend.value : 0ull - addend.value;
        current = base;
    }
    physicalize_published_operand(plan, destination, &current);
    out->zero_mask = current.kind == PL_OPERAND_CONST && !current.value
        && !offset && mode == 3u;
    if (!out->zero_mask
            && (current.kind != PL_OPERAND_LOCAL || current.value >= PL_X86_GPR_COUNT))
        return 0;
    out->source = out->zero_mask ? destination : (pl_u32)current.value;
    /* a+k + CF = ADC(a,k); a+k - CF = SBB(a,-k).
     * Substituting !CF = 1-CF changes the sign and adds +/-1 to k.
     * Keep the Boolean in the carry flag instead of materializing SETcc. */
    out->mode = (mode == 1u) == (condition.condition == 2u) ? 2u : 4u;
    if (condition.condition == 3u) offset += mode == 1u ? 1u : U64_MAX_VALUE;
    out->immediate.kind = PL_OPERAND_CONST;
    out->immediate.value = out->mode == 2u ? offset : 0ull - offset;
    /* Only the arithmetic word is truncated. The condition still observes
     * the original comparison width, so low32(a +/- CF) commutes with this
     * projection even when CF came from a 64-bit comparison. */
    if (bits != out->bits && !(bits == 32u && out->bits == 64u)) return 0;
    out->bits = bits;
    if (out->bits == 32u) out->immediate.value &= U32_MAX_VALUE;
    return 1;
}

static int emit_carry_adjustment(const carry_adjustment *shape, pl_u32 destination,
                                 pl_u8 *output, pl_u32 *written, pl_u32 *work)
{
    pl_u32 at = 0u, encoded = 0u;
    if (!emit_standalone_flag_publication(&shape->compare, output, &at)) return 0;
    *work = 1u;
    if (shape->zero_mask) {
        /* 0-CF = SBB(r,r), independently of r's old bits. Complementing
         * that word gives 0-!CF; no scalar Boolean or zero seed is needed. */
        pl_operand self = { PL_OPERAND_LOCAL, destination };
        if (!emit_alu_instruction(destination, self, shape->bits, 4u, 0u,
                                  output ? output + at : 0, &encoded)) return 0;
        at += encoded;
        ++*work;
        if (shape->mode == 2u) {
            if (!emit_not_register(destination, shape->bits,
                                   output ? output + at : 0, &encoded)) return 0;
            at += encoded;
            ++*work;
        }
        *written = at;
        return 1;
    }
    /* CMP precedes the seed so even a comparison reading the old destination
     * is valid. MOV preserves CF; it can share the comparison's dependency wave. */
    if (destination != shape->source) {
        if (!emit_gpr_move(destination, shape->source, shape->bits,
                           output ? output + at : 0, &encoded)) return 0;
        at += encoded;
        ++*work;
    }
    if (!emit_alu_instruction(destination, shape->immediate, shape->bits,
                              shape->mode, 0u, output ? output + at : 0, &encoded))
        return 0;
    *written = at + encoded;
    ++*work;
    return 1;
}

static int boolean_select_details(const pl_plan *plan, pl_operand value,
                                  boolean_select *out)
{
    if (!plan || !out || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != PL_OPCODE_LANE32_SELECT
            && node->opcode != PL_OPCODE_LANE64_SELECT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if ((argument[0].kind != PL_OPERAND_CONST
            && (argument[0].kind != PL_OPERAND_LOCAL
                || argument[0].value >= PL_X86_GPR_COUNT))
            || (argument[1].kind != PL_OPERAND_CONST
                && (argument[1].kind != PL_OPERAND_LOCAL
                    || argument[1].value >= PL_X86_GPR_COUNT)))
        return 0;
    out->when_true = argument[0];
    out->when_false = argument[1];
    out->condition = argument[2];
    out->value_bits = node->opcode == PL_OPCODE_LANE32_SELECT ? 32u : 64u;
    return 1;
}

/* A 32-bit CMOV reads the low word directly and zeroes the destination high
 * word even when the condition is false. Its source's explicit zero extension
 * therefore needs neither an instruction nor a published temporary. */
static int conditional_entry_local(const pl_plan *plan, pl_operand value,
                                    pl_u32 bits, pl_u32 *local)
{
    if (value.kind == PL_OPERAND_NODE && bits == 32u) {
        pl_u32 source = 0u, width = 0u;
        if (zero_extend_node(plan, (pl_u32)value.value, &source, &width)
                && width == 32u) {
            const pl_node *node = &plan->nodes[value.value - 1u];
            value = plan->arguments[node->argument_at + 1u];
        }
    }
    if (value.kind != PL_OPERAND_LOCAL || value.value >= PL_X86_GPR_COUNT)
        return 0;
    *local = (pl_u32)value.value;
    return 1;
}

static int conditional_published_local(const pl_plan *plan, pl_operand value,
    pl_u32 bits, pl_u32 *local)
{
    if (published_operand_local(plan, value, local)) return 1;
    /* CMOV r32 reads the candidate's low word without changing that register.
     * A full-width constant publication can own this projected arm too. */
    if (bits != 32u || value.kind != PL_OPERAND_CONST) return 0;
    for (pl_u32 candidate = 0u; candidate < PL_X86_GPR_COUNT; ++candidate)
        if (plan->locals[candidate].kind == PL_OPERAND_CONST
                && (pl_u32)plan->locals[candidate].value == (pl_u32)value.value) {
            *local = candidate;
            return 1;
        }
    return 0;
}

static int conditional_select_details_inner(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       int allow_seed,
                                       conditional_select *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    out->compare_left_seed = 0u;
    out->compare_right_seed = 0u;
    out->compare_left_value = (pl_operand){ 0 };
    out->compare_right_value = (pl_operand){ 0 };
    const pl_node *select = &plan->nodes[value.value - 1u];
    if ((select->opcode != PL_OPCODE_LANE32_SELECT
            && select->opcode != PL_OPCODE_LANE64_SELECT)
            || select->argument_count != 3u
            || select->argument_at > plan->argument_count
            || select->argument_count
               > plan->argument_count - select->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + select->argument_at;
    if (argument[2].kind != PL_OPERAND_NODE || !argument[2].value
            || argument[2].value > plan->node_count)
        return 0;
    const pl_node *condition = &plan->nodes[argument[2].value - 1u];
    if (condition->opcode != PL_OPCODE_X86_CONDITION
            || condition->argument_count != 2u
            || condition->argument_at > plan->argument_count
            || condition->argument_count
               > plan->argument_count - condition->argument_at)
        return 0;
    const pl_operand *condition_argument =
        plan->arguments + condition->argument_at;
    if (condition_argument[1].kind != PL_OPERAND_CONST
            || condition_argument[1].value > 15u)
        return 0;
    pl_u32 candidate_local = 0u;
    pl_u32 candidate_immediate = 0u;
    pl_u32 inverted = 0u;
    out->value_bits = select->opcode == PL_OPCODE_LANE32_SELECT
                   || (operand_fits_u32(
                           plan, argument[0], plan->node_count + 1u)
                       && operand_fits_u32(
                           plan, argument[1], plan->node_count + 1u))
                    ? 32u : 64u;
    int first_entry = conditional_entry_local(
        plan, argument[0], out->value_bits, &candidate_local);
    int first_physical = first_entry;
    if (!first_physical) first_physical = conditional_published_local(
        plan, argument[0], out->value_bits, &candidate_local);
    pl_u32 second_local = 0u;
    int second_entry = conditional_entry_local(
        plan, argument[1], out->value_bits, &second_local);
    int second_physical = second_entry;
    if (!second_physical)
        second_physical = conditional_published_local(
            plan, argument[1], out->value_bits, &second_local);
    int first_is_entry_destination = first_entry && candidate_local == destination;
    int second_is_entry_source = second_entry && second_local != destination;
    if (first_is_entry_destination && second_is_entry_source) {
        /* SELECT(dst,src,cc) already has its true arm in the destructive
         * destination.  Selecting the false arm with the complementary
         * condition is one CMOV and preserves both entry values until that
         * instruction: `cmov(!cc) dst,src`. */
        out->current = argument[0];
        candidate_local = second_local;
        inverted = 1u;
    } else if (first_physical) {
        out->current = argument[1];
    } else if (second_physical) {
        /* SELECT(a,b,cc) is `current=b; cmovcc current,a`.  When only b has
         * a physical owner, place a in the destination and select b with the
         * exact complementary x86 condition.  Adjacent condition codes are
         * complements by ISA definition, hence cc^1 for all 16 encodings. */
        out->current = argument[0];
        candidate_local = second_local;
        inverted = 1u;
    } else {
        /* Neither arm names a physical owner (for example two address
         * constants): the destructive `current` is materialised into the
         * destination and the other arm into a scratch the frame chooses. */
        out->current = argument[1];
        out->candidate_value = argument[0];
        candidate_immediate = 1u;
        candidate_local = PL_X86_GPR_COUNT;
    }
    out->candidate_local = candidate_local;
    out->candidate_immediate = candidate_immediate;
    out->candidate_is_entry = (pl_u32)(inverted ? second_entry : first_entry);
    pl_u32 current_entry = 0u;
    if (conditional_entry_local(plan, out->current, out->value_bits, &current_entry))
        out->current = (pl_operand){ PL_OPERAND_LOCAL, current_entry };
    out->condition = (pl_u32)condition_argument[1].value ^ inverted;
    out->has_compare = 0u;
    out->current_flag_node = 0u;
    out->compare_test = 0u;
    out->compare_offset = 0u;
    out->compare_node = 0u;
    out->compare_left_is_current = 0u;
    out->compare_right_is_current = 0u;
    out->compare_left_local = 0u;
    out->compare_right = (pl_operand){ PL_OPERAND_CONST, 0u };
    out->compare_bits = 0u;
    if (condition_argument[0].kind == PL_OPERAND_LOCAL
            && condition_argument[0].value == PL_X86_RFLAGS_LOCAL)
        return 1;
    if (condition_argument[0].kind != PL_OPERAND_NODE
            || !condition_argument[0].value
            || condition_argument[0].value > plan->node_count)
        return 0;
    pl_operand flag_left, flag_right;
    pl_u32 flag_bits = 0u, flag_mode = 0u, carry = 0u;
    if (flag_value_operation_details(plan, (pl_u32)condition_argument[0].value,
            out->current, &flag_left, &flag_right, &flag_bits, &flag_mode, &carry)
            && !carry && flag_bits == out->value_bits) {
        /* The current arm is the exact result that also produces the tested
         * flags. Its destructive ALU instruction serves both observations;
         * CMOV preserves those flags without a second CMP/TEST. */
        out->current_flag_node = (pl_u32)condition_argument[0].value;
        out->compare_node = out->current_flag_node;
        return 1;
    }
    const pl_node *compare =
        &plan->nodes[condition_argument[0].value - 1u];
    pl_u32 compare_descriptor_at =
        compare->opcode == PL_OPCODE_X86_FLAGS ? 4u : 3u;
    pl_u32 compare_argument_count =
        compare->opcode == PL_OPCODE_X86_FLAGS ? 5u : 4u;
    if ((compare->opcode != PL_OPCODE_X86_COMPARE
            && compare->opcode != PL_OPCODE_X86_TEST
            && compare->opcode != PL_OPCODE_X86_ALU
            && compare->opcode != PL_OPCODE_X86_FLAGS)
            || compare->argument_count != compare_argument_count
            || compare->argument_at > plan->argument_count
            || compare->argument_count
               > plan->argument_count - compare->argument_at)
        return 0;
    const pl_operand *compare_argument =
        plan->arguments + compare->argument_at;
    if (compare_argument[compare_descriptor_at].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = compare_argument[compare_descriptor_at].value;
    pl_u32 compare_bits = (pl_u32)(descriptor & 0x7fu);
    int compare_test = compare->opcode == PL_OPCODE_X86_TEST
                    || ((compare->opcode == PL_OPCODE_X86_ALU
                            || compare->opcode == PL_OPCODE_X86_FLAGS)
                        && ((descriptor >> 8u) & 7u) == 0u);
    int compare_subtract = compare->opcode == PL_OPCODE_X86_COMPARE
                        || ((compare->opcode == PL_OPCODE_X86_ALU
                                || compare->opcode == PL_OPCODE_X86_FLAGS)
                            && ((descriptor >> 8u) & 7u) == 3u);
    if ((compare_bits != 8u && compare_bits != 16u
            && compare_bits != 32u && compare_bits != 64u)
            || (!compare_test && !compare_subtract)
            || (descriptor >> 11u))
        return 0;
    pl_operand compare_input = compare_argument[1];
    out->compare_offset = test_byte_coordinate(plan, &compare_input,
        compare_argument[2], compare_bits, (pl_u32)compare_test);
    pl_u32 compare_left = 0u;
    if (compare_input.kind == out->current.kind
            && compare_input.value == out->current.value) {
        out->compare_left_is_current = 1u;
        pl_u32 current_local = out->current.kind == PL_OPERAND_LOCAL
                             && out->current.value < PL_X86_GPR_COUNT
                             ? (pl_u32)out->current.value
                             : PL_X86_GPR_COUNT;
        compare_left = current_local < PL_X86_GPR_COUNT
                    && plan->locals[current_local].kind == PL_OPERAND_LOCAL
                    && plan->locals[current_local].value == current_local
                     ? current_local : destination;
    } else if (compare_input.kind == PL_OPERAND_LOCAL
            && compare_input.value < PL_X86_GPR_COUNT) {
        compare_left = (pl_u32)compare_input.value;
    } else if (!published_operand_local(
                   plan, compare_input, &compare_left)) {
        if (allow_seed
                && (compare_input.kind == PL_OPERAND_NODE
                    || compare_input.kind == PL_OPERAND_PROJECTION)
                && operand_expression_bits(plan, compare_input, 0u)) {
            out->compare_left_value = compare_input;
            out->compare_left_seed = 1u;
            compare_left = PL_X86_GPR_COUNT;
        } else {
            return 0;
        }
    }
    if (out->compare_offset && compare_left >= 4u) return 0;
    pl_operand compare_right = compare_argument[2];
    if (compare_right.kind == out->current.kind
            && compare_right.value == out->current.value) {
        out->compare_right_is_current = 1u;
        pl_u32 current_local = out->current.kind == PL_OPERAND_LOCAL
                             && out->current.value < PL_X86_GPR_COUNT
                             ? (pl_u32)out->current.value
                             : PL_X86_GPR_COUNT;
        compare_right.kind = PL_OPERAND_LOCAL;
        compare_right.value = current_local < PL_X86_GPR_COUNT
                    && plan->locals[current_local].kind == PL_OPERAND_LOCAL
                    && plan->locals[current_local].value == current_local
                     ? current_local : destination;
    } else if (compare_right.kind != PL_OPERAND_CONST) {
        pl_u32 right_local = 0u;
        if (compare_right.kind == PL_OPERAND_LOCAL
                && compare_right.value < PL_X86_GPR_COUNT) {
            right_local = (pl_u32)compare_right.value;
        } else if (!published_operand_local(
                       plan, compare_right, &right_local)) {
            if (allow_seed
                    && (compare_right.kind == PL_OPERAND_NODE
                        || compare_right.kind == PL_OPERAND_PROJECTION)
                    && operand_expression_bits(plan, compare_right, 0u)) {
                out->compare_right_value = compare_right;
                out->compare_right_seed = 1u;
                right_local = PL_X86_GPR_COUNT;
            } else {
                return 0;
            }
        }
        compare_right.kind = PL_OPERAND_LOCAL;
        compare_right.value = right_local;
    }
    out->compare_left_local = compare_left;
    out->compare_right = compare_right;
    out->compare_bits = compare_bits;
    out->has_compare = 1u;
    out->compare_test = (pl_u32)compare_test;
    out->compare_node = (pl_u32)condition_argument[0].value;
    return 1;
}

static int conditional_select_details(const pl_plan *plan, pl_operand value,
                                       pl_u32 destination,
                                       conditional_select *out)
{
    return conditional_select_details_inner(
        plan, value, destination, 0, out);
}

/* A still-pending publication that consumes `pair_node` as its destructive
 * `current` arm.  When an ADD3 trades on a shared pair, building that pair in
 * the consumer's coordinate lets one materialization serve both publications
 * instead of rebuilding the pair twice. */
static pl_u32 alu_add3_pair_consumer(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 pair_node, pl_u32 skip)
{
    if (!plan || !pair_node) return PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == skip || !(pending & (1u << local))) continue;
        conditional_select select;
        if (conditional_select_details_inner(
                plan, plan->locals[local], local, 1, &select)
                && select.current.kind == PL_OPERAND_NODE
                && select.current.value == pair_node)
            return local;
    }
    return PL_X86_GPR_COUNT;
}

static int emit_select_compare(const conditional_select *select,
                                pl_u8 *output, pl_u32 *written)
{
    return emit_flag_coordinate(select->compare_left_local, select->compare_right,
        select->compare_bits, select->compare_test, select->compare_offset, output, written);
}

static int measure_selected_flag_value(const pl_x86_frontend *frontend,
    const pl_x86_block *block, pl_x86_native_selection *selection, pl_u32 destination,
    const conditional_select *shape, pl_u32 output_at, pl_u32 remaining,
    pl_u32 scratch_mask, pl_u32 *bytes, pl_u32 *work)
{
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, carry = 0u;
    if (!flag_value_operation_details(&block->plan, shape->current_flag_node,
            shape->current, &left, &right, &bits, &mode, &carry)) return 0;
    return measure_alu_pair(frontend, block, selection, destination, left, right,
        bits, mode, carry, output_at, remaining, scratch_mask, bytes, work);
}

static int write_selected_flag_value(const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const conditional_select *shape, pl_u32 output_at, pl_u32 remaining,
    pl_u32 scratch_mask, pl_u8 *output, pl_u32 *written)
{
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, carry = 0u;
    if (!flag_value_operation_details(&block->plan, shape->current_flag_node,
            shape->current, &left, &right, &bits, &mode, &carry)) return 0;
    return write_alu_pair(block, selection, destination, left, right,
        bits, mode, carry, output_at, remaining, scratch_mask, output, written);
}

typedef struct {
    conditional_select select;
    pl_operand quotient;
    pl_operand offset;
    pl_operand projected_compare_right;
} quotient_boundary_select;

/* Project an unsigned threshold through a right-shift quotient when the one
 * partially covered boundary class is observationally indistinguishable.
 *
 *   select(k, (x >> s) + d, x <= t)
 *
 * depends on x only through q=x>>s exactly when the false arm at q=t>>s is
 * also k.  Under that necessary and sufficient boundary condition the test
 * becomes q<=t>>s.  The suffix add is then a flag-preserving LEA, so compare
 * and value construction share a wave instead of retaining x or rebuilding
 * q. */
static int quotient_boundary_select_details(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    quotient_boundary_select *out)
{
    if (!plan || !out) return 0;
    conditional_select select;
    if (!conditional_select_details(plan, value, destination, &select)
            || !select.has_compare || select.compare_test
            || select.condition != 6u
            || select.compare_left_is_current
            || select.compare_left_local != destination
            || select.compare_right.kind != PL_OPERAND_CONST
            || select.candidate_local >= PL_X86_GPR_COUNT)
        return 0;
    pl_operand candidate = plan->locals[select.candidate_local];
    if (candidate.kind != PL_OPERAND_CONST) return 0;

    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            plan, select.current, &left, &right, &bits, &mode)
            || mode != 1u || bits != select.value_bits
            || bits != select.compare_bits)
        return 0;
    pl_operand quotient = left;
    pl_operand offset = right;
    if (quotient.kind == PL_OPERAND_CONST) {
        quotient = right;
        offset = left;
    }
    if (offset.kind != PL_OPERAND_CONST) return 0;

    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (!shift_node_details(
            plan, quotient, &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            || shift_bits != bits || shift_group != 5u
            || shift_source.kind != PL_OPERAND_LOCAL
            || shift_source.value != select.compare_left_local
            || shift_amount.kind != PL_OPERAND_CONST)
        return 0;
    pl_u32 count_mask = bits == 64u ? 63u : 31u;
    pl_u32 count = (pl_u32)shift_amount.value & count_mask;
    if (!count) return 0;
    pl_u64 mask = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 threshold = select.compare_right.value & mask;
    pl_u64 projected_threshold = threshold >> count;
    pl_u64 boundary_value =
        (projected_threshold + (offset.value & mask)) & mask;
    if (boundary_value != (candidate.value & mask)) return 0;

    out->select = select;
    out->quotient = quotient;
    out->offset = offset;
    out->projected_compare_right = (pl_operand){
        PL_OPERAND_CONST, projected_threshold,
    };
    return 1;
}

static int conditional_compare_survives_current(
    const conditional_select *select, pl_u32 destination)
{
    if (!select || !select->has_compare) return 1;
    if (select->compare_left_local == destination
            && !select->compare_left_is_current)
        return 0;
    return !(select->compare_right.kind == PL_OPERAND_LOCAL
          && select->compare_right.value == destination
          && !select->compare_right_is_current);
}

static int measure_quotient_boundary_select(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions);
static int write_quotient_boundary_select(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written);

static int publication_emits_selected_flag(const pl_plan *plan,
    pl_operand value, pl_u32 destination, pl_u32 flag_node)
{
    if (!plan || !flag_node) return 0;
    /* MOVSX/CDQE and NOT preserve the comparison produced inside a selected
     * value. Their enclosing publication owns that same flag result; no
     * second standalone CMP is needed, and the scheduler must keep it last. */
    for (pl_u32 remaining = plan->node_count + 1u; remaining; --remaining) {
        conditional_select select;
        if (conditional_select_details(plan, value, destination, &select))
            return (select.has_compare || select.current_flag_node)
                && select.compare_node == flag_node;
        pl_operand source;
        pl_u32 bits = 0u;
        if (value.kind == PL_OPERAND_NODE
                && sign_extend_value(plan, (pl_u32)value.value, &source, &bits))
            value = source;
        else if (complement_node_details(plan, value, &source, &bits))
            value = source;
        else return 0;
    }
    return 0;
}

static int publication_emits_flag_node(const pl_plan *plan,
                                       pl_u32 changed,
                                       pl_u32 flag_node)
{
    if (!plan || !flag_node) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        if (publication_emits_selected_flag(plan, plan->locals[local], local, flag_node))
            return 1;
    }
    return 0;
}

/* Unlike publication_emits_flag_node(), this asks whether the native
 * instruction which publishes a GPR value is itself the final flag producer.
 * A CMOV may consume a standalone CMP node with no such value publication. */
static int flag_node_has_value_publication(const pl_plan *plan,
                                           pl_u32 changed,
                                           pl_u32 flag_node)
{
    if (!plan || !flag_node) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((changed & (1u << local))
                && publication_is_flag_result(
                    plan, plan->locals[local], flag_node))
            return 1;
    return 0;
}

typedef struct {
    conditional_select select;
    pl_u32 destination;
    pl_u32 side_destination;
    pl_u32 side_bits;
    pl_u32 side_bit;
    pl_operand test_right;
} entry_select_bit_test_frame;

/* Two publications consume the same entry register: CMOV replaces that
 * register under entry RFLAGS, while a second register receives the entry
 * word with one forced bit.  Capture the shared entry generation first, then
 * run CMOV and the forced-bit suffix in the same wave.  A final TEST of the
 * selected word's high byte is emitted directly as AH/CH/DH/BH, so neither a
 * shifted scalar nor an invented flag producer survives. */
static int entry_select_bit_test_frame_shape(
    const pl_x86_block *block, pl_u32 changed, pl_u32 final_flag_node,
    entry_select_bit_test_frame *out)
{
    if (!block || !out || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || !final_flag_node
            || final_flag_node > block->plan.node_count)
        return 0;
    const pl_plan *plan = &block->plan;
    const pl_node *test = &plan->nodes[final_flag_node - 1u];
    if (test->opcode != PL_OPCODE_X86_TEST
            || test->argument_count != 4u
            || test->argument_at > plan->argument_count
            || test->argument_count
               > plan->argument_count - test->argument_at)
        return 0;
    const pl_operand *test_argument =
        plan->arguments + test->argument_at;
    if (test_argument[1].kind != PL_OPERAND_NODE
            || test_argument[2].kind != PL_OPERAND_CONST
            || test_argument[2].value > 0xffu
            || test_argument[3].kind != PL_OPERAND_CONST
            || test_argument[3].value != 8u)
        return 0;
    pl_operand shifted_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (!shift_node_details(
            plan, test_argument[1], &shifted_source, &shift_amount,
            &shift_bits, &shift_group)
            || shift_bits != 64u || shift_group != 5u
            || shift_amount.kind != PL_OPERAND_CONST
            || shift_amount.value != 8u)
        return 0;

    for (pl_u32 destination = 0u; destination < 4u; ++destination) {
        if (!(changed & (1u << destination))) continue;
        conditional_select select;
        if (!conditional_select_details(
                plan, plan->locals[destination], destination, &select)
                || select.has_compare || select.current_flag_node
                || select.current.kind != PL_OPERAND_LOCAL
                || select.current.value != destination
                || shifted_source.kind != plan->locals[destination].kind
                || shifted_source.value != plan->locals[destination].value)
            continue;
        for (pl_u32 side = 0u; side < PL_X86_GPR_COUNT; ++side) {
            if (side == destination || !(changed & (1u << side)))
                continue;
            pl_operand side_source;
            pl_u32 side_bits = 0u, side_bit = 0u;
            if (!single_bit_or_details(
                    plan, plan->locals[side], &side_source,
                    &side_bits, &side_bit)
                    || side_source.kind != PL_OPERAND_LOCAL
                    || side_source.value != destination
                    || (side_bits != 32u && side_bits != 64u)
                    || side_bit >= side_bits)
                continue;
            pl_u32 exact = (1u << destination) | (1u << side);
            if ((changed & ((1u << PL_X86_GPR_COUNT) - 1u)) != exact)
                continue;
            *out = (entry_select_bit_test_frame){
                select, destination, side, side_bits, side_bit,
                test_argument[2],
            };
            return 1;
        }
    }
    return 0;
}

static int emit_entry_select_bit_test_frame(
    const entry_select_bit_test_frame *shape,
    pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, part = 0u;
    if (!emit_gpr_move(
            shape->side_destination, shape->destination,
            shape->side_bits, output, &part))
        return 0;
    at += part;
    if (!emit_conditional_move(
            shape->destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    pl_operand bit = {
        PL_OPERAND_CONST, 1ull << shape->side_bit,
    };
    if (!emit_alu_instruction(
            shape->side_destination, bit, shape->side_bits, 5u, 0u,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    if (!emit_high8_test(
            shape->destination, shape->test_right,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    *written = at + part;
    return 1;
}

/* A conditional publication owns two independent dependency domains.  The
 * selected value depends on ordinary entry GPRs; its condition is either the
 * entry flag word or a compare/test which is rematerialized immediately
 * before CMOV.  Walking the generic node arguments confuses the latter with a
 * GPR dependency because RFLAGS is deliberately outside the GPR population.
 * Project the exact destructive-register realization instead.  This helper
 * returns entry-GPR sources only; final publication owners are a separate
 * topological relation below.  Mixing the two reverses the required order for
 * `constant owner -> CMOV consumer`. */
static int conditional_select_gpr_sources(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    pl_u32 *sources)
{
    conditional_select select;
    if (!plan || !sources
            || !conditional_select_details(
                plan, value, destination, &select))
        return 0;
    if (!operand_gpr_sources(
            plan, select.current, plan->node_count + 1u,
            plan->node_count + 1u, sources))
        return 0;
    if (select.candidate_is_entry)
        *sources |= 1u << select.candidate_local;
    return 1;
}

static int conditional_select_publication_dependencies(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    pl_u32 *dependencies)
{
    conditional_select select;
    if (!plan || !dependencies
            || !conditional_select_details(
                plan, value, destination, &select))
        return 0;
    /* Entry operands must be consumed before their coordinate is replaced;
     * published operands must be produced before this consumer. These are
     * opposite edges even when both generations use the same register. */
    *dependencies = select.candidate_is_entry
                  ? 0u : 1u << select.candidate_local;
    if (select.has_compare
            && select.compare_left_local != destination)
        *dependencies |= 1u << select.compare_left_local;
    if (select.has_compare
            && select.compare_right.kind == PL_OPERAND_LOCAL
            && select.compare_right.value != destination)
        *dependencies |= 1u << (pl_u32)select.compare_right.value;
    return 1;
}

/* When the compare observed by CMOV is also the block's final architectural
 * flag producer, its value publication and flag publication are one native
 * instruction.  Replace old-entry compare sources with that producer edge;
 * the final-flag scheduler already keeps every other flag clobber before it.
 * CMOV can then consume the live flags without rematerializing TEST/CMP. */
static int apply_shared_flag_producer_laws(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    pl_u32 sources[PL_X86_GPR_COUNT],
    pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !sources || !dependencies) return 0;
    if (!final_flag_node
            || !flag_node_has_value_publication(
                plan, changed, final_flag_node))
        return 1;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        conditional_select select;
        if (!conditional_select_details(
                plan, plan->locals[local], local, &select)
                || !select.has_compare
                || select.compare_node != final_flag_node)
            continue;
        pl_u32 value_sources = 0u, owner_dependencies = 0u;
        if (!conditional_select_gpr_sources(
                plan, plan->locals[local], local, &value_sources)
                || !conditional_select_publication_dependencies(
                    plan, plan->locals[local], local,
                    &owner_dependencies))
            return 0;
        sources[local] = value_sources;
        dependencies[local] |= owner_dependencies;
    }
    return 1;
}

int pl_x86_select_alu_schedule_diagnostic(
    const pl_x86_block *block, pl_x86_alu_schedule_diagnostic *out)
{
    if (!block || !out) return PL_ERROR_X86_SELECT;
    *out = (pl_x86_alu_schedule_diagnostic){ 0 };
    if (!alu_frame_shape(
            &block->plan, &out->changed, &out->final_flag_node)
            || !alu_frame_source_laws(
                &block->plan, out->sources, out->dependencies))
        return PL_ERROR_X86_SELECT;
    add_flag_chain_dependencies(
        &block->plan, out->final_flag_node, out->dependencies);
    if (!apply_shared_flag_producer_laws(
            &block->plan, out->changed, out->final_flag_node,
            out->sources, out->dependencies))
        return PL_ERROR_X86_SELECT;
    pl_operand result, prior;
    out->final_flag_owner = flag_result_operand(
            &block->plan, out->final_flag_node, &result, &prior)
        ? publication_owner(&block->plan, result)
        : PL_X86_GPR_COUNT;
    (void)prior;
    standalone_flag_publication standalone;
    if (!publication_emits_flag_node(
            &block->plan, out->changed, out->final_flag_node)
            && !flag_node_has_value_publication(
                &block->plan, out->changed, out->final_flag_node)
            && standalone_flag_publication_details(
                &block->plan, out->final_flag_node, &standalone))
        out->standalone_flag_dependencies = standalone.entry_sources;
    return 0;
}

typedef struct {
    pl_u32 destination;
    pl_u32 candidate;
    pl_u32 flag_owner;
    pl_u32 bits;
    pl_u32 flag_bits;
    pl_u32 flag_mode;
    pl_u32 candidate_first;
    conditional_select select;
    pl_operand flag_left;
    pl_operand flag_right;
} shared_flag_select_handoff;

/* A conditional result and its final flag-producing value form one physical
 * cut, but CMOV needs that producer textually after both value arms.  Split
 * the normalized select into
 *
 *   current arm || candidate arm; final value+flags; CMOV
 *
 * when neither arm destroys an entry coordinate needed by the other or by
 * the flag producer.  This is a topology law: it applies to any exact ALU
 * producer and any independently materializable select arms, not to one
 * source instruction spelling. */
static int shared_flag_select_handoff_shape(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    shared_flag_select_handoff *out)
{
    if (!plan || !final_flag_node || !out) return 0;
    for (pl_u32 destination = 0u;
            destination < PL_X86_GPR_COUNT; ++destination) {
        if (!(changed & (1u << destination))) continue;
        conditional_select select;
        if (!conditional_select_details(
                plan, plan->locals[destination], destination, &select)
                || !select.has_compare
                || select.compare_node != final_flag_node
                || select.candidate_local >= PL_X86_GPR_COUNT
                || select.candidate_local == destination
                || !(changed & (1u << select.candidate_local)))
            continue;
        pl_u32 flag_owner = PL_X86_GPR_COUNT;
        pl_operand flag_left = { 0 }, flag_right = { 0 };
        pl_u32 flag_bits = 0u, flag_mode = 0u, preserves_carry = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(changed & (1u << local)) || local == destination
                    || local == select.candidate_local
                    || !publication_is_flag_result(
                        plan, plan->locals[local], final_flag_node))
                continue;
            pl_u32 operation_destination = PL_X86_GPR_COUNT;
            int operation = alu_node_details(
                plan, final_flag_node, &operation_destination,
                &flag_left, &flag_right, &flag_bits,
                &flag_mode, &preserves_carry);
            if ((!operation || operation_destination != local)
                    && !flag_value_operation_details(
                        plan, final_flag_node, plan->locals[local],
                        &flag_left, &flag_right, &flag_bits,
                        &flag_mode, &preserves_carry))
                continue;
            if (preserves_carry)
                continue;
            flag_owner = local;
            break;
        }
        if (flag_owner >= PL_X86_GPR_COUNT) continue;

        pl_u32 candidate_sources = 0u, current_sources = 0u;
        pl_u32 flag_sources = 0u;
        if (!operand_gpr_sources(
                plan, plan->locals[select.candidate_local],
                plan->node_count + 1u, plan->node_count + 1u,
                &candidate_sources)
                || !operand_gpr_sources(
                    plan, select.current,
                    plan->node_count + 1u, plan->node_count + 1u,
                    &current_sources)
                || !operand_gpr_sources(
                    plan, flag_left,
                    plan->node_count + 1u, plan->node_count + 1u,
                    &flag_sources)
                || !operand_gpr_sources(
                    plan, flag_right,
                    plan->node_count + 1u, plan->node_count + 1u,
                    &flag_sources))
            continue;
        const pl_u32 destination_bit = 1u << destination;
        const pl_u32 candidate_bit = 1u << select.candidate_local;
        if (flag_sources & (destination_bit | candidate_bit)) continue;
        const int candidate_first = !(current_sources & candidate_bit);
        const int current_first = !(candidate_sources & destination_bit);
        if (!candidate_first && !current_first) continue;

        out->destination = destination;
        out->candidate = select.candidate_local;
        out->flag_owner = flag_owner;
        out->bits = select.value_bits;
        out->flag_bits = flag_bits;
        out->flag_mode = flag_mode;
        out->candidate_first = candidate_first
            && (!current_first || (candidate_sources & destination_bit));
        out->select = select;
        out->flag_left = flag_left;
        out->flag_right = flag_right;
        return 1;
    }
    return 0;
}

/* XOR-zero is the shortest exact constant publication when every remaining
 * consumer redefines flags with its own CMP/TEST before observing them.  The
 * pending-set condition makes this a lifetime proof, not a generic
 * assumption that flags are dead. */
static int zero_internal_compare_consumers(const pl_plan *plan,
                                           pl_u32 zero_local,
                                           pl_u32 pending)
{
    if (!plan || zero_local >= PL_X86_GPR_COUNT
            || !(pending & (1u << zero_local)))
        return 0;
    pl_u32 consumers = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == zero_local || !(pending & (1u << local))) continue;
        conditional_select select;
        if (!conditional_select_details(
                plan, plan->locals[local], local, &select)
                || !select.has_compare
                || select.candidate_local != zero_local)
            return 0;
        consumers |= 1u << local;
    }
    return consumers != 0u;
}

typedef struct {
    pl_u32 local[2];
    pl_u32 count;
    pl_u64 displacement;
    pl_u8 scale_log2[2];
} affine_lea;

static int append_affine_local(affine_lea *out, pl_u32 local,
                               pl_u32 scale_log2)
{
    if (!out || local >= PL_X86_GPR_COUNT || out->count >= 2u
            || scale_log2 > 3u)
        return 0;
    out->local[out->count] = local;
    out->scale_log2[out->count] = (pl_u8)scale_log2;
    ++out->count;
    return 1;
}

static int collect_affine_lea_width(const pl_plan *plan, pl_operand value,
                                    pl_u32 bits, pl_u32 remaining,
                                    affine_lea *out)
{
    if (!plan || !out || !remaining) return 0;
    if (value.kind == PL_OPERAND_CONST) {
        out->displacement += value.value;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        return append_affine_local(out, (pl_u32)value.value, 0u);
    }
    /* Physical normalization closes (a + b) + k into one ADD3 node.  Native
     * selection must consume that normal form directly; otherwise the
     * stronger quotient perversely falls back to the original LEA spelling.
     * ADD3 is the associative/commutative word-sum law, so its three leaves
     * are exactly one x86 addressing coordinate when they contain at most two
     * registers and one encodable displacement. */
    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= plan->node_count) {
        const pl_node *node = &plan->nodes[value.value - 1u];
        /* A 32-bit LEA result is the low word of the 64-bit address sum, so a
         * 64-bit ADD3 is a valid 32-bit address coordinate as well. */
        if ((node->opcode == PL_OPCODE_ADD3[bits == 64u ? 1u : 0u]
                || (bits == 32u && node->opcode == PL_OPCODE_ADD3[1]))
                && node->argument_count == 3u
                && node->argument_at <= plan->argument_count
                && node->argument_count
                   <= plan->argument_count - node->argument_at) {
            for (pl_u32 argument = 0u; argument < 3u; ++argument)
                if (!collect_affine_lea_width(
                        plan, plan->arguments[node->argument_at + argument],
                        bits, remaining - 1u, out))
                    return 0;
            return 1;
        }
        /* A scaled word is an x86 addressing coordinate, not a materialized
         * SHIFT result.  Resolve an already-published normalized subvalue to
         * its physical GPR and retain the scale in the affine form so
         * `(x << k) + c` remains one LEA after SSA substitution. */
        pl_operand source, amount;
        pl_u32 shift_bits = 0u, group = 0u;
        if (shift_node_details(
                plan, value, &source, &amount, &shift_bits, &group)
                /* A 32-bit LEA result is the low word of the 64-bit address
                 * sum, so low32(x<<k) and low32(x)<<k are identical.  Keep
                 * the architectural 64-bit index coordinate instead of
                 * materializing SHL64 + ADD32 + MOV32. */
                && (shift_bits == bits
                    || (bits == 32u && shift_bits == 64u))
                && group == 4u
                && amount.kind == PL_OPERAND_CONST
                && amount.value && amount.value <= 3u) {
            pl_u32 local = PL_X86_GPR_COUNT;
            if (source.kind == PL_OPERAND_LOCAL
                    && source.value < PL_X86_GPR_COUNT) {
                local = (pl_u32)source.value;
            } else if (!published_operand_local(plan, source, &local)) {
                return 0;
            }
            return append_affine_local(
                out, local, (pl_u32)amount.value);
        }
    }
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &left, &right, &node_bits, &mode)
            || mode != 1u
            || (node_bits != bits && !(bits == 32u && node_bits == 64u)))
        return 0;
    return collect_affine_lea_width(
               plan, left, bits, remaining - 1u, out)
        && collect_affine_lea_width(
               plan, right, bits, remaining - 1u, out);
}

static int collect_affine_lea(const pl_plan *plan, pl_operand value,
                              pl_u32 remaining, affine_lea *out)
{
    return collect_affine_lea_width(plan, value, 64u, remaining, out);
}

/* A normalized x86 word expression retains its architectural width.  Try
 * both lane vocabularies before falling back to a destructive ALU tree;
 * otherwise a 32-bit affine publication is needlessly evaluated in its old
 * source register and copied back to the actual destination. */
static int collect_native_affine_lea(
    const pl_plan *plan, pl_operand value, pl_u32 remaining,
    affine_lea *out, pl_u32 *bits)
{
    if (!out || !bits) return 0;
    *out = (affine_lea){ 0 };
    if (collect_affine_lea_width(plan, value, 64u, remaining, out)) {
        *bits = 64u;
        return 1;
    }
    *out = (affine_lea){ 0 };
    if (collect_affine_lea_width(plan, value, 32u, remaining, out)) {
        *bits = 32u;
        return 1;
    }
    return 0;
}

static int emit_affine_lea_width(pl_u32 destination, affine_lea form,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u)
            || !form.count || form.count > 2u
            || (bits == 64u && form.displacement > I32_MAX_VALUE
                && form.displacement < 0xffffffff80000000ull))
        return 0;
    pl_u32 scaled = 0u;
    for (pl_u32 at = 0u; at < form.count; ++at)
        if (form.scale_log2[at]) {
            if (form.scale_log2[scaled] && scaled != at) return 0;
            scaled = at;
        }
    int no_base = form.count == 1u && form.scale_log2[0];
    pl_u32 base = no_base ? 5u : form.local[0];
    pl_u32 index = 0u, scale_log2 = 0u;
    if (no_base) {
        index = form.local[0];
        scale_log2 = form.scale_log2[0];
    } else if (form.count == 2u) {
        pl_u32 index_at = form.scale_log2[1] ? 1u
                        : form.scale_log2[0] ? 0u
                        : 1u;
        pl_u32 base_at = index_at ^ 1u;
        base = form.local[base_at];
        index = form.local[index_at];
        scale_log2 = form.scale_log2[index_at];
        if (!scale_log2 && (index & 7u) == 4u) {
            pl_u32 swap = base; base = index; index = swap;
        }
    }
    if ((!no_base && base >= PL_X86_GPR_COUNT)
            || ((no_base || form.count == 2u)
                && (index >= PL_X86_GPR_COUNT || (index & 7u) == 4u)))
        return 0;
    pl_u32 low = (pl_u32)form.displacement;
    pl_u32 displacement_bytes = no_base ? 4u : !low ? 0u
        : (low <= 0x7fu || low >= 0xffffff80u) ? 1u : 4u;
    pl_u32 base_low = base & 7u;
    pl_u32 mod = no_base ? 0u
               : !displacement_bytes && base_low != 5u ? 0u
               : displacement_bytes <= 1u ? 1u : 2u;
    pl_u32 sib = no_base || form.count == 2u || base_low == 4u;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 4u : 0u)
                              | ((no_base || form.count == 2u)
                                 && index >= 8u ? 2u : 0u)
                              | (!no_base && base >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x8du;
    ++at;
    if (output)
        output[at] = (pl_u8)((mod << 6u) | ((destination & 7u) << 3u)
                            | (sib ? 4u : base_low));
    ++at;
    if (sib) {
        pl_u32 index_low = no_base || form.count == 2u ? index & 7u : 4u;
        if (output)
            output[at] = (pl_u8)((scale_log2 << 6u)
                               | (index_low << 3u) | base_low);
        ++at;
    }
    if (no_base || mod == 2u) {
        if (output)
            for (pl_u32 byte = 0u; byte < 4u; ++byte)
                output[at + byte] = (pl_u8)(low >> (byte * 8u));
        at += 4u;
    } else if (mod == 1u) {
        if (output) output[at] = (pl_u8)low;
        ++at;
    }
    *written = at;
    return 1;
}


static int emit_affine_lea(pl_u32 destination, affine_lea form,
                           pl_u8 *output, pl_u32 *written)
{
    return emit_affine_lea_width(
        destination, form, 64u, output, written);
}

static int final_flags_are_shift(const pl_plan *plan)
{
    if (!plan || plan->local_count <= PL_X86_RFLAGS_LOCAL) return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    pl_u32 node = flags.kind == PL_OPERAND_NODE
                ? (pl_u32)flags.value
                : flags.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(flags.value >> 8u) : 0u;
    return node && node <= plan->node_count
        && plan->nodes[node - 1u].opcode == PL_OPCODE_X86_SHIFT_FLAGS;
}

static int emit_boolean_zero(pl_u32 destination, int preserve_flags,
                              pl_u8 *output, pl_u32 *written)
{
    if (!preserve_flags) return emit_zero_register(destination, output, written);
    if (!written || destination >= PL_X86_GPR_COUNT) return 0;
    pl_u32 at = 0u;
    if (destination >= 8u) {
        if (output) output[at] = 0x41u;
        ++at;
    }
    if (output) output[at] = (pl_u8)(0xb8u + (destination & 7u));
    ++at;
    for (pl_u32 byte = 0u; byte < 4u; ++byte) {
        if (output) output[at] = 0u;
        ++at;
    }
    *written = at;
    return 1;
}

/* TEST and its Boolean observation share one flags production. The zero
 * seed goes before TEST unless it would destroy a comparison input; in that
 * case a flag-preserving MOV follows TEST before SETcc. */
static int emit_test_boolean(const pl_plan *plan, pl_operand value, pl_u32 destination,
                             pl_u8 *output, pl_u32 *written)
{
    test_boolean shape;
    if (!test_boolean_details(plan, value, &shape)) return 0;
    physicalize_published_operand(plan, destination, &shape.left);
    physicalize_published_operand(plan, destination, &shape.right);
    if (shape.left.kind != PL_OPERAND_LOCAL || shape.left.value >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 aliases = shape.left.value == destination
        || (shape.right.kind == PL_OPERAND_LOCAL && shape.right.value == destination);
    pl_u32 at = 0u, encoded = 0u;
    if (!aliases) {
        if (!emit_zero_register(destination, output, &encoded)) return 0;
        at += encoded;
    }
    if (!emit_test_operand((pl_u32)shape.left.value, shape.right, shape.bits,
                            output ? output + at : 0, &encoded)) return 0;
    at += encoded;
    if (aliases) {
        if (!emit_boolean_zero(destination, 1, output ? output + at : 0, &encoded)) return 0;
        at += encoded;
    }
    if (!emit_set_condition(destination, shape.condition, output ? output + at : 0, &encoded))
        return 0;
    *written = at + encoded;
    return 1;
}

static int measure_alu_seed(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand value,
                            pl_u32 bits, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 *bytes,
                            pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !bytes || !instructions
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    *bytes = 0u;
    *instructions = 0u;
    physicalize_transient_operand(selection, &value);
    if (emit_test_boolean(&block->plan, value, destination, 0, bytes)) {
        *instructions = 3u;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        if (value.value == destination) return 1;
        if (!emit_gpr_move(destination, (pl_u32)value.value, bits,
                           (pl_u8 *)0, bytes))
            return 0;
        *instructions = 1u;
        return 1;
    }
    if (value.kind == PL_OPERAND_CONST) {
        pl_u32 source_at = 0u;
        pl_u64 target = 0u;
        int address = source_address_definition(
            frontend, block, destination, value.value, bits, &target, &source_at);
        if (address < 0) return address;
        if (address) {
            /* Relocation acts on the full address before the lane projection.
             * LEA r32,[RIP+d32] performs that projection without an absolute
             * low-word literal or a second zero-extension instruction. */
            pl_u32 prefix = bits == 64u || destination >= 8u ? 1u : 0u;
            int status = append_fixup(
                selection, PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT, 4u,
                output_at + prefix + 2u, output_at + prefix + 6u, target);
            if (status) return status;
            selection->fixups[selection->fixup_count - 1u].source_at =
                source_at;
            selection->fixups[selection->fixup_count - 1u].source_bytes = 4u;
            *bytes = prefix + 6u;
        } else {
            *bytes = constant_move_bytes(destination, value.value);
        }
        *instructions = 1u;
        return 1;
    }
    /* Zero extension has the same one-instruction spelling inside an
     * expression as at a frame root. Its high zero fill is not a value to
     * materialize before the consuming arithmetic instruction. */
    pl_u32 extension_source = 0u, extension_bits = 0u;
    if (value.kind == PL_OPERAND_NODE
            && zero_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits)) {
        if (!emit_zero_extend_move(destination, extension_source, extension_bits,
                                    0, bytes)) return 0;
        *instructions = 1u;
        return 1;
    }
    if (value.kind == PL_OPERAND_NODE
            && sign_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits)
            && extension_bits == 32u && bits == 32u) {
        if (!emit_sign_extend_move(
                destination, extension_source, extension_bits, 0, bytes))
            return 0;
        *instructions = 1u;
        return 1;
    }
    pl_operand negation_source;
    pl_u32 negation_bits = 0u;
    if (negation_node_details(
            &block->plan, value, &negation_source, &negation_bits)
            && negation_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 prefix = 0u, prefix_work = 0u;
        int status = measure_alu_seed(
            frontend, block, selection, destination, negation_source,
            bits, output_at, remaining - 1u, &prefix, &prefix_work);
        pl_u32 operation = 0u;
        if (status <= 0
                || !emit_neg_register(destination, bits, 0, &operation)
                || prefix > U32_MAX_VALUE - operation
                || prefix_work == U32_MAX_VALUE)
            return status < 0 ? status : 0;
        *bytes = prefix + operation;
        *instructions = prefix_work + 1u;
        return 1;
    }
    pl_operand complement_source;
    pl_u32 complement_bits = 0u;
    if (complement_node_details(
            &block->plan, value, &complement_source, &complement_bits)
            && (complement_bits == bits
                || (bits == 32u && complement_bits == 64u))) {
        if (remaining <= 1u) return 0;
        pl_u32 prefix = 0u, prefix_instructions = 0u;
        int status = measure_alu_seed(
            frontend, block, selection, destination, complement_source,
            bits, output_at, remaining - 1u,
            &prefix, &prefix_instructions);
        pl_u32 operation = 0u;
        if (status <= 0
                || !emit_not_register(
                    destination, bits, (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation
                || prefix_instructions == U32_MAX_VALUE)
            return status < 0 ? status : 0;
        *bytes = prefix + operation;
        *instructions = prefix_instructions + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }
    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (shift_node_details(
            &block->plan, value, &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            && shift_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 published = 0u;
        if ((shift_source.kind == PL_OPERAND_NODE
                || shift_source.kind == PL_OPERAND_PROJECTION)
                && published_operand_local(
                    &block->plan, shift_source, &published)
                && published != destination) {
            shift_source.kind = PL_OPERAND_LOCAL;
            shift_source.value = published;
        }
        if (shift_amount.kind == PL_OPERAND_LOCAL
                && shift_amount.value == destination
                && !(shift_source.kind == PL_OPERAND_LOCAL
                    && shift_source.value == destination))
            return 0;
        pl_u32 count_mask = bits == 64u ? 63u : 31u;
        pl_u32 shifted_copy_bytes = 0u;
        if (shift_group == 4u
                && shift_source.kind == PL_OPERAND_LOCAL
                && shift_source.value != destination
                && shift_amount.kind == PL_OPERAND_CONST
                && !final_flags_are_shift(&block->plan)
                && emit_shifted_copy(
                    destination, (pl_u32)shift_source.value, bits,
                    (pl_u32)shift_amount.value & count_mask,
                    (pl_u8 *)0, &shifted_copy_bytes)) {
            *bytes = shifted_copy_bytes;
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        pl_u32 prefix = 0u, prefix_instructions = 0u;
        int status = measure_alu_seed(
            frontend, block, selection, destination, shift_source, bits,
            output_at, remaining - 1u, &prefix, &prefix_instructions);
        pl_u32 operation = 0u;
        if (status <= 0
                || !emit_shift_instruction(
                    destination, shift_amount, bits, shift_group,
                    (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation
                || prefix_instructions == U32_MAX_VALUE)
            return status < 0 ? status : 0;
        *bytes = prefix + operation;
        *instructions = prefix_instructions + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }
    affine_lea form = { 0 };
    if (collect_affine_lea_width(
            &block->plan, value, bits, remaining, &form)
            && emit_affine_lea_width(
                destination, form, bits, (pl_u8 *)0, bytes)) {
        *instructions = 1u;
        return 1;
    }
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    /* Decode the semantic pair before requiring a native right operand.
     * Either child may already have one final published owner; resolving it
     * below turns the whole expression into one flag-preserving LEA instead
     * of rebuilding the child and clobbering a later observed RFLAGS value. */
    if (!arithmetic_tree_details(
            &block->plan, value, &left, &right, &node_bits, &mode))
        return 0;
    physicalize_selected_operand(
        &block->plan, selection, destination, &left);
    physicalize_selected_operand(
        &block->plan, selection, destination, &right);
    orient_commutative_destination(
        &block->plan, destination, mode, &left, &right);
    if (mode == 1u && emit_add_lea(
            destination, left, right, node_bits, 0, bytes)) {
        *instructions = 1u;
        return 1;
    }
    if ((right.kind == PL_OPERAND_LOCAL
                && right.value == destination
                && !(left.kind == PL_OPERAND_LOCAL
                     && left.value == destination)))
        return 0;
    pl_u32 prefix = 0u, prefix_instructions = 0u;
    pl_u32 left_bits = operand_expression_bits(
        &block->plan, left, node_bits);
    int status = measure_alu_seed(
        frontend, block, selection, destination, left, left_bits, output_at,
        remaining - 1u, &prefix, &prefix_instructions);
    if (status <= 0) return status;
    pl_u32 operation = 0u;
    if (!emit_alu_instruction(destination, right, node_bits, mode, 0u,
                              (pl_u8 *)0, &operation)
            || prefix > U32_MAX_VALUE - operation)
        return 0;
    *bytes = prefix + operation;
    *instructions = prefix_instructions + 1u;
    return 1;
}

/* Return only entry-GPR dependencies.  RFLAGS and the other machine locals
 * are observable inputs too, but they cannot be borrowed as x86 scratch
 * registers and therefore do not belong in this ownership mask. */
typedef struct {
    pl_u32 sources;
    pl_u32 depth;
} entry_source_row;

static int entry_source_operand_law(
    const pl_plan *plan, pl_operand value, pl_u32 available_nodes,
    const entry_source_row *row, pl_u32 *sources, pl_u32 *depth)
{
    if (!plan || !sources || !depth) return 0;
    if (value.kind == PL_OPERAND_CONST) {
        *sources = 0u;
        *depth = 1u;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= plan->local_count) return 0;
        *sources = value.value < PL_X86_GPR_COUNT
                 ? 1u << (pl_u32)value.value : 0u;
        *depth = 1u;
        return 1;
    }
    pl_u32 node = value.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(value.value >> 8u)
                : value.kind == PL_OPERAND_NODE
                ? (pl_u32)value.value : 0u;
    if (!node || node > available_nodes || !row || !row[node - 1u].depth)
        return 0;
    *sources = row[node - 1u].sources;
    *depth = row[node - 1u].depth;
    return 1;
}

static int operand_entry_gpr_sources(const pl_plan *plan, pl_operand value,
                                     pl_u32 before_node, pl_u32 remaining,
                                     pl_u32 *sources)
{
    if (!plan || !sources || !remaining || !before_node) return 0;
    pl_u32 available = before_node - 1u;
    if (available > plan->node_count) available = plan->node_count;
    entry_source_row row[available ? available : 1u];
    for (pl_u32 node_number = 1u; node_number <= available; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        entry_source_row *current = &row[node_number - 1u];
        *current = (entry_source_row){ 0u, 0u };
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            continue;
        pl_u32 law = 0u;
        pl_u32 depth = 1u;
        int valid = 1;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u, part_depth = 0u;
            if (!entry_source_operand_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_number - 1u, row, &part, &part_depth)) {
                valid = 0;
                break;
            }
            law |= part;
            if (part_depth >= depth) {
                if (part_depth == 0xffffffffu) {
                    valid = 0;
                    break;
                }
                depth = part_depth + 1u;
            }
        }
        if (valid) *current = (entry_source_row){ law, depth };
    }
    pl_u32 law = 0u, depth = 0u;
    if (!entry_source_operand_law(
            plan, value, available, row, &law, &depth)
            || depth > remaining)
        return 0;
    *sources |= law;
    return 1;
}

static int operand_entry_sources_without(
    const pl_plan *plan, pl_operand value, pl_operand excluded,
    pl_u32 before_node, pl_u32 remaining, int expand_root,
    pl_u32 *sources)
{
    if (!plan || !sources || !remaining) return 0;
    if (value.kind == excluded.kind && value.value == excluded.value)
        return 1;
    if (value.kind == PL_OPERAND_CONST) return 1;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value < PL_X86_GPR_COUNT)
            *sources |= 1u << (pl_u32)value.value;
        return value.value < plan->local_count;
    }
    pl_u32 node_number = value.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(value.value >> 8u)
                       : value.kind == PL_OPERAND_NODE
                       ? (pl_u32)value.value : 0u;
    if (!node_number || node_number >= before_node
            || node_number > plan->node_count)
        return 0;
    if (!expand_root
            && publication_owner(plan, value) < PL_X86_GPR_COUNT)
        return 1;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (node->argument_count == 3u
            && arithmetic_tree_details(plan, value, &left, &right, &bits, &mode))
        return operand_entry_sources_without(plan, left, excluded, node_number,
                   remaining - 1u, 0, sources)
            && operand_entry_sources_without(plan, right, excluded, node_number,
                   remaining - 1u, 0, sources);
    for (pl_u32 argument = 0u;
            argument < node->argument_count; ++argument)
        if (!operand_entry_sources_without(
                plan, plan->arguments[node->argument_at + argument],
                excluded, node_number, remaining - 1u, 0, sources))
            return 0;
    return 1;
}

static int operand_contains_unpublished_value(
    const pl_plan *plan, pl_operand root, pl_operand value,
    pl_u32 remaining, int expand_root)
{
    if (!plan || !remaining) return 0;
    if (root.kind == value.kind && root.value == value.value) return 1;
    pl_u32 node_number = root.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(root.value >> 8u)
                       : root.kind == PL_OPERAND_NODE
                       ? (pl_u32)root.value : 0u;
    if (!node_number || node_number > plan->node_count) return 0;
    if (!expand_root
            && publication_owner(plan, root) < PL_X86_GPR_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (node->argument_count == 3u
            && arithmetic_tree_details(plan, root, &left, &right, &bits, &mode))
        return operand_contains_unpublished_value(plan, left, value, remaining - 1u, 0)
            || operand_contains_unpublished_value(plan, right, value, remaining - 1u, 0);
    for (pl_u32 argument = 0u;
            argument < node->argument_count; ++argument)
        if (operand_contains_unpublished_value(
                plan, plan->arguments[node->argument_at + argument],
                value, remaining - 1u, 0))
            return 1;
    return 0;
}

static void record_tree_rejection(pl_x86_native_selection *selection,
                                  pl_operand value, pl_u32 reason)
{
    if (!selection || selection->blocking_opcode != U32_MAX_VALUE) return;
    pl_u32 node = value.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(value.value >> 8u)
                : value.kind == PL_OPERAND_NODE
                ? (pl_u32)value.value : 0u;
    selection->blocking_opcode = (reason << 24u) | (node & 0x00ffffffu);
}

static int associative_mode(pl_u32 mode)
{
    return mode == 0u || mode == 1u || mode == 5u || mode == 6u;
}

typedef struct {
    pl_operand base;
    pl_operand mask;
    pl_operand flag_left;
    pl_operand flag_right;
    pl_u32 bits;
    pl_u32 condition;
    pl_u32 flag_bits;
    pl_u32 flag_mode;
    pl_u32 preserves_carry;
} conditional_or_fold;

/* Keep the condition as flags instead of materializing its 0/1 value.
 *
 *     x | select(mask, 0, condition)
 *
 * has one physical accumulator and one conditional accumulator.  Building
 * the selected mask first would create a value which is dead immediately
 * after the OR.  The equivalent spelling copies x, ORs the mask into that
 * copy, produces the condition flags last, and conditionally publishes the
 * copy.  This removes the transient boolean for every such SSA topology. */
static int conditional_or_fold_details(
    const pl_plan *plan, pl_operand left, pl_operand right,
    pl_u32 bits, pl_u32 mode, conditional_or_fold *out)
{
    if (!plan || !out || mode != 5u) return 0;
    for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
        pl_operand base = orientation ? right : left;
        pl_operand selected = orientation ? left : right;
        boolean_select select;
        if (!boolean_select_details(plan, selected, &select)
                || select.value_bits != bits)
            continue;
        pl_operand mask;
        pl_u32 inverse = 0u;
        if (select.when_true.kind == PL_OPERAND_CONST
                && select.when_true.value
                && select.when_false.kind == PL_OPERAND_CONST
                && !select.when_false.value) {
            mask = select.when_true;
        } else if (select.when_true.kind == PL_OPERAND_CONST
                && !select.when_true.value
                && select.when_false.kind == PL_OPERAND_CONST
                && select.when_false.value) {
            mask = select.when_false;
            inverse = 1u;
        } else {
            continue;
        }
        condition_value condition;
        if (!condition_value_details(plan, select.condition, &condition)
                || !flag_operation_details(
                    plan, condition.flags, &out->flag_left,
                    &out->flag_right, &out->flag_bits, &out->flag_mode,
                    &out->preserves_carry))
            continue;
        out->base = base;
        out->mask = mask;
        out->bits = bits;
        out->condition = condition.condition ^ inverse;
        return 1;
    }
    return 0;
}

static int collect_associative_leaves(const pl_plan *plan,
                                      pl_operand value,
                                      pl_u32 bits, pl_u32 mode,
                                      pl_operand *leaves,
                                      pl_u32 capacity, pl_u32 *count,
                                      pl_u32 remaining)
{
    if (!plan || !leaves || !count || !remaining) return 0;
    pl_operand left, right;
    pl_u32 node_bits = 0u, node_mode = 0u;
    if (arithmetic_tree_details(
            plan, value, &left, &right, &node_bits, &node_mode)
            && node_bits == bits && node_mode == mode) {
        return collect_associative_leaves(
                   plan, left, bits, mode, leaves, capacity, count,
                   remaining - 1u)
            && collect_associative_leaves(
                   plan, right, bits, mode, leaves, capacity, count,
                   remaining - 1u);
    }
    if (*count >= capacity) return 0;
    leaves[(*count)++] = value;
    return 1;
}

/* A commutative reduction rooted at an architectural destination starts from
 * that entry coordinate.  Keeping a source-tree leaf ahead of it forces a
 * transient copy and may add one dependency wave before the first join. */
static void promote_associative_destination_leaf(
    pl_operand *leaves, pl_u32 count, pl_u32 destination)
{
    if (!leaves || destination >= PL_X86_GPR_COUNT) return;
    for (pl_u32 at = 0u; at < count; ++at) {
        if (leaves[at].kind != PL_OPERAND_LOCAL
                || leaves[at].value != destination)
            continue;
        pl_operand swap = leaves[0];
        leaves[0] = leaves[at];
        leaves[at] = swap;
        return;
    }
}

typedef struct {
    pl_operand base;
    pl_operand side;
    pl_u64 variable_mask;
    pl_u64 constant;
    pl_u32 bits;
} entry_bit_overlay;

typedef struct {
    pl_u32 destination;
    pl_u32 source;
    pl_u64 mask;
    pl_u64 constant;
    pl_u32 bits;
} masked_entry_affine;

/* (entry & mask) | constant equals (entry & mask) + constant exactly when
 * their bit supports are disjoint.  This lets a disposable entry owner carry
 * the mask while LEA publishes the final coordinate without another flag
 * producer or scalar materialization. */
static int masked_entry_affine_details(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    masked_entry_affine *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST) return 0;
    pl_operand source, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!arithmetic_tree_details(
            plan, masked, &source, &mask, &mask_bits, &mask_mode)
            || mask_bits != bits || mask_mode != 0u)
        return 0;
    if (source.kind == PL_OPERAND_CONST) {
        pl_operand swap = source; source = mask; mask = swap;
    }
    if (source.kind != PL_OPERAND_LOCAL
            || source.value >= PL_X86_GPR_COUNT
            || source.value == destination
            || mask.kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 bounded_mask = mask.value & word;
    pl_u64 bounded_constant = constant.value & word;
    if (bounded_mask & bounded_constant) return 0;
    out->destination = destination;
    out->source = (pl_u32)source.value;
    out->mask = bounded_mask;
    out->constant = bounded_constant;
    out->bits = bits;
    return 1;
}

static int emit_masked_entry_affine(
    const masked_entry_affine *shape, pl_u8 *output,
    pl_u32 *written, pl_u32 *instructions)
{
    if (!shape || !written || !instructions) return 0;
    pl_operand mask = { PL_OPERAND_CONST, shape->mask };
    pl_u32 first = 0u;
    if (!emit_alu_instruction(
            shape->source, mask, shape->bits, 0u, 0u,
            output, &first))
        return 0;
    pl_operand source = { PL_OPERAND_LOCAL, shape->source };
    pl_operand constant = { PL_OPERAND_CONST, shape->constant };
    pl_u32 second = 0u;
    if (!emit_add_lea(
            shape->destination, source, constant, shape->bits,
            output ? output + first : (pl_u8 *)0, &second)
            || first > U32_MAX_VALUE - second)
        return 0;
    *written = first + second;
    *instructions = 2u;
    return 1;
}

static int native_operand_confined_to_mask(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 outer_bits,
                                           pl_u64 mask)
{
    if (!plan || (outer_bits != 32u && outer_bits != 64u)) return 0;
    pl_u64 word = outer_bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    if (value.kind == PL_OPERAND_CONST)
        return !((value.value & word) & ~mask);
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &left, &right, &bits, &mode)
            || mode != 0u || (bits != outer_bits
                && !(outer_bits == 64u && bits == 32u)))
        return 0;
    pl_operand bound = left.kind == PL_OPERAND_CONST ? left : right;
    if (bound.kind != PL_OPERAND_CONST) return 0;
    pl_u64 support = bound.value
                   & (bits == 64u ? U64_MAX_VALUE : 0xffffffffu);
    return !(support & ~mask);
}

/* Recognize the exact overlay law
 *
 *   ((base | side) & mask) | constant
 *     = ((base & mask) | constant) | side
 *
 * when `side` has no possible one outside mask.  Restricting base to an
 * entry GPR gives native selection a real destructive accumulator without
 * inventing a transient value. */
static int entry_bit_overlay_details(const pl_plan *plan,
                                     pl_operand value,
                                     entry_bit_overlay *out)
{
    if (!plan || !out) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST) return 0;

    pl_operand joined, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!arithmetic_tree_details(
            plan, masked, &joined, &mask, &mask_bits, &mask_mode)
            || mask_bits != bits || mask_mode != 0u)
        return 0;
    if (joined.kind == PL_OPERAND_CONST) {
        pl_operand swap = joined; joined = mask; mask = swap;
    }
    if (mask.kind != PL_OPERAND_CONST) return 0;

    pl_operand first, second;
    pl_u32 join_bits = 0u, join_mode = 0u;
    if (!arithmetic_tree_details(
            plan, joined, &first, &second, &join_bits, &join_mode)
            || join_bits != bits || join_mode != 5u)
        return 0;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 variable_mask = mask.value & word;
    pl_u32 side = native_operand_confined_to_mask(
                      plan, second, bits, variable_mask)
                ? 1u
                : native_operand_confined_to_mask(
                      plan, first, bits, variable_mask)
                ? 0u : 2u;
    if (side > 1u) return 0;
    pl_operand base = side ? first : second;
    if (base.kind != PL_OPERAND_LOCAL
            || base.value >= PL_X86_GPR_COUNT)
        return 0;
    *out = (entry_bit_overlay){
        base, side ? second : first,
        variable_mask, constant.value & word, bits,
    };
    return 1;
}

typedef struct {
    pl_u32 base;
    pl_u32 side;
    pl_u32 bits;
    pl_u64 base_constant;
    pl_u64 side_constant;
    pl_u64 final_mask;
} split_entry_overlay;

static int emit_one_force_coordinate(pl_u32 destination, pl_u64 constant,
                                     pl_u32 bits, pl_u8 *output,
                                     pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    constant &= word;
    if (!constant) {
        *written = 0u;
        return 1;
    }
    pl_operand immediate = { PL_OPERAND_CONST, constant };
    if (emit_alu_instruction(
            destination, immediate, bits, 5u, 0u, output, written))
        return 1;
    if (constant & (constant - 1u)) return 0;
    pl_u32 bit = 0u;
    while (bit < bits && !(constant & (1ull << bit))) ++bit;
    return bit < bits && emit_bit_set_immediate(
        destination, bit, bits, output, written);
}

/* Partition the forced constant across two disposable entry owners:
 *
 *   ((a | b) & m) | c
 *     = ((a | ca) | (b | cb)) & (m | c),  ca | cb = c.
 *
 * If each non-empty partition is one native coordinate and m|c is an
 * immediate AND, four work coordinates attain three waves: both forces,
 * join, final mask. */
static int split_entry_overlay_details(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       split_entry_overlay *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST || !constant.value) return 0;
    pl_operand joined, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!arithmetic_tree_details(
            plan, masked, &joined, &mask, &mask_bits, &mask_mode)
            || mask_bits != bits || mask_mode != 0u)
        return 0;
    if (joined.kind == PL_OPERAND_CONST) {
        pl_operand swap = joined; joined = mask; mask = swap;
    }
    if (mask.kind != PL_OPERAND_CONST) return 0;
    pl_operand first, second;
    pl_u32 join_bits = 0u, join_mode = 0u;
    if (!arithmetic_tree_details(
            plan, joined, &first, &second, &join_bits, &join_mode)
            || join_bits != bits || join_mode != 5u
            || first.kind != PL_OPERAND_LOCAL
            || second.kind != PL_OPERAND_LOCAL
            || first.value >= PL_X86_GPR_COUNT
            || second.value >= PL_X86_GPR_COUNT
            || first.value == second.value)
        return 0;
    pl_u32 base = first.value == destination ? (pl_u32)first.value
                : second.value == destination ? (pl_u32)second.value
                : PL_X86_GPR_COUNT;
    if (base >= PL_X86_GPR_COUNT) return 0;
    pl_u32 side = base == first.value
                ? (pl_u32)second.value : (pl_u32)first.value;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 forced = constant.value & word;
    pl_u64 final_mask = ((mask.value & word) | forced) & word;
    pl_operand final_immediate = { PL_OPERAND_CONST, final_mask };
    pl_u32 final_bytes = 0u;
    if (final_mask != word
            && !emit_alu_instruction(
                destination, final_immediate, bits, 0u, 0u,
                (pl_u8 *)0, &final_bytes))
        return 0;

    pl_u32 best_bytes = U32_MAX_VALUE;
    pl_u64 best_side = 0u;
    for (pl_u32 choice = 0u; choice <= bits + 1u; ++choice) {
        pl_u64 side_constant = choice == 0u ? 0u
                             : choice == bits + 1u ? forced
                             : forced & (1ull << (choice - 1u));
        if (choice > 0u && choice <= bits && !side_constant) continue;
        pl_u64 base_constant = forced & ~side_constant;
        pl_u32 base_bytes = 0u, side_bytes = 0u;
        if (!emit_one_force_coordinate(
                base, base_constant, bits, (pl_u8 *)0, &base_bytes)
                || !emit_one_force_coordinate(
                    side, side_constant, bits, (pl_u8 *)0, &side_bytes)
                || base_bytes > U32_MAX_VALUE - side_bytes)
            continue;
        pl_u32 candidate_bytes = base_bytes + side_bytes;
        if (candidate_bytes < best_bytes) {
            best_bytes = candidate_bytes;
            best_side = side_constant;
        }
    }
    if (best_bytes == U32_MAX_VALUE) return 0;
    *out = (split_entry_overlay){
        base, side, bits, forced & ~best_side, best_side, final_mask,
    };
    return 1;
}

static int emit_split_entry_overlay(const split_entry_overlay *shape,
                                    pl_u8 *output, pl_u32 *written,
                                    pl_u32 *instructions)
{
    if (!shape || !written || !instructions) return 0;
    pl_u32 at = 0u, part = 0u, work = 0u;
    if (!emit_one_force_coordinate(
            shape->base, shape->base_constant, shape->bits,
            output, &part))
        return 0;
    at += part;
    work += shape->base_constant != 0u;
    if (!emit_one_force_coordinate(
            shape->side, shape->side_constant, shape->bits,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    work += shape->side_constant != 0u;
    pl_operand side = { PL_OPERAND_LOCAL, shape->side };
    if (!emit_alu_instruction(
            shape->base, side, shape->bits, 5u, 0u,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    ++work;
    pl_u64 word = shape->bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    if (shape->final_mask != word) {
        pl_operand mask = { PL_OPERAND_CONST, shape->final_mask };
        if (!emit_alu_instruction(
                shape->base, mask, shape->bits, 0u, 0u,
                output ? output + at : (pl_u8 *)0, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
        ++work;
    }
    *written = at;
    *instructions = work;
    return 1;
}

typedef struct {
    pl_u32 base;
    pl_u32 side;
    pl_u64 low_mask;
    pl_u64 constant;
} low32_entry_overlay;

/* A 32-bit join is already zero-extended before a later 64-bit overlay.
 * Consequently only the low word of the outer mask is observable:
 *
 *   (zext32(a|b) & m64) | c64
 *     = (zext32(a|b) & low32(m64)) | c64.
 */
static int low32_entry_overlay_details(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       low32_entry_overlay *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || bits != 64u || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST || !constant.value) return 0;
    pl_operand joined, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!arithmetic_tree_details(
            plan, masked, &joined, &mask, &mask_bits, &mask_mode)
            || mask_bits != 64u || mask_mode != 0u)
        return 0;
    if (joined.kind == PL_OPERAND_CONST) {
        pl_operand swap = joined; joined = mask; mask = swap;
    }
    if (mask.kind != PL_OPERAND_CONST) return 0;
    pl_operand first, second;
    pl_u32 join_bits = 0u, join_mode = 0u;
    if (!arithmetic_tree_details(
            plan, joined, &first, &second, &join_bits, &join_mode)
            || join_bits != 32u || join_mode != 5u
            || first.kind != PL_OPERAND_LOCAL
            || second.kind != PL_OPERAND_LOCAL
            || first.value >= PL_X86_GPR_COUNT
            || second.value >= PL_X86_GPR_COUNT
            || first.value == second.value)
        return 0;
    pl_u32 base = first.value == destination ? (pl_u32)first.value
                : second.value == destination ? (pl_u32)second.value
                : PL_X86_GPR_COUNT;
    if (base >= PL_X86_GPR_COUNT) return 0;
    *out = (low32_entry_overlay){
        base,
        base == first.value ? (pl_u32)second.value : (pl_u32)first.value,
        mask.value & 0xffffffffu,
        constant.value,
    };
    return 1;
}

static int measure_low32_entry_overlay(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    const low32_entry_overlay *shape, pl_u32 output_at,
    pl_u32 scratch_mask, pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !shape || !bytes
            || !instructions
            || !(scratch_mask & (1u << shape->side)))
        return 0;
    pl_operand side = { PL_OPERAND_LOCAL, shape->side };
    pl_u32 at = 0u, part = 0u, work = 0u;
    if (!emit_alu_instruction(
            shape->base, side, 32u, 5u, 0u,
            (pl_u8 *)0, &part))
        return 0;
    at += part;
    ++work;
    if (shape->low_mask != 0xffffffffu) {
        pl_operand mask = { PL_OPERAND_CONST, shape->low_mask };
        if (!emit_alu_instruction(
                shape->base, mask, 32u, 0u, 0u,
                (pl_u8 *)0, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
        ++work;
    }
    pl_operand constant = { PL_OPERAND_CONST, shape->constant };
    if (emit_alu_instruction(
            shape->base, constant, 64u, 5u, 0u,
            (pl_u8 *)0, &part)) {
        if (at > U32_MAX_VALUE - part) return 0;
        *bytes = at + part;
        *instructions = work + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }
    if (at > U32_MAX_VALUE - output_at) return 0;
    pl_u32 constant_bytes = 0u, constant_work = 0u;
    int status = measure_alu_seed(
        frontend, block, selection, shape->side, constant, 64u,
        output_at + at, block->plan.node_count + 1u,
        &constant_bytes, &constant_work);
    pl_u32 join = 0u;
    if (status <= 0
            || !emit_alu_instruction(
                shape->base, side, 64u, 5u, 0u,
                (pl_u8 *)0, &join)
            || at > U32_MAX_VALUE - constant_bytes
            || at + constant_bytes > U32_MAX_VALUE - join
            || work > U32_MAX_VALUE - constant_work
            || work + constant_work == U32_MAX_VALUE)
        return status < 0 ? status : 0;
    *bytes = at + constant_bytes + join;
    *instructions = work + constant_work + 1u;
    selection->direct_nested_frame = 1u;
    return 1;
}

static int write_low32_entry_overlay(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection,
    const low32_entry_overlay *shape, pl_u32 output_at,
    pl_u32 scratch_mask, pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !shape || !output || !written
            || !(scratch_mask & (1u << shape->side)))
        return 0;
    pl_operand side = { PL_OPERAND_LOCAL, shape->side };
    pl_u32 at = 0u, part = 0u;
    if (!emit_alu_instruction(
            shape->base, side, 32u, 5u, 0u, output, &part))
        return 0;
    at += part;
    if (shape->low_mask != 0xffffffffu) {
        pl_operand mask = { PL_OPERAND_CONST, shape->low_mask };
        if (!emit_alu_instruction(
                shape->base, mask, 32u, 0u, 0u,
                output + at, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
    }
    pl_operand constant = { PL_OPERAND_CONST, shape->constant };
    if (emit_alu_instruction(
            shape->base, constant, 64u, 5u, 0u,
            output + at, &part)) {
        if (at > U32_MAX_VALUE - part) return 0;
        *written = at + part;
        return 1;
    }
    if (at > U32_MAX_VALUE - output_at
            || !write_alu_seed(
                block, selection, shape->side, constant, 64u,
                output_at + at, block->plan.node_count + 1u,
                output + at, &part))
        return 0;
    at += part;
    if (!emit_alu_instruction(
            shape->base, side, 64u, 5u, 0u,
            output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    *written = at + part;
    return 1;
}

/* Emit the shortest bounded x86 realization of `(x & mask) | constant`
 * used before a final OR join.  OR-immediate is preferred; otherwise at most
 * two high constant bits become BTS coordinates and the low positive imm32
 * remains one OR.  AND uses mask|constant because forced bits need not be
 * cleared first. */
static int emit_entry_bit_overlay(pl_u32 destination,
                                  const entry_bit_overlay *shape,
                                  pl_u8 *output, pl_u32 *written,
                                  pl_u32 *instructions)
{
    if (!shape || !written || !instructions
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u64 word = shape->bits == 64u
                ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 constant = shape->constant & word;
    pl_u32 at = 0u, part = 0u, work = 0u;
    if (constant) {
        pl_operand immediate = { PL_OPERAND_CONST, constant };
        if (emit_alu_instruction(
                destination, immediate, shape->bits, 5u, 0u,
                output, &part)) {
            at += part;
            ++work;
        } else {
            pl_u64 low = constant & I32_MAX_VALUE;
            pl_u64 high = constant & ~((pl_u64)I32_MAX_VALUE);
            pl_u32 high_count = 0u;
            for (pl_u32 bit = 0u; bit < shape->bits; ++bit)
                high_count += (pl_u32)((high >> bit) & 1u);
            if (!high_count || high_count > 2u) return 0;
            for (pl_u32 bit = 0u; bit < shape->bits; ++bit) {
                if (!(high & (1ull << bit))) continue;
                if (!emit_bit_set_immediate(
                        destination, bit, shape->bits,
                        output ? output + at : (pl_u8 *)0, &part)
                        || at > U32_MAX_VALUE - part)
                    return 0;
                at += part;
                ++work;
            }
            if (low) {
                immediate.value = low;
                if (!emit_alu_instruction(
                        destination, immediate, shape->bits, 5u, 0u,
                        output ? output + at : (pl_u8 *)0, &part)
                        || at > U32_MAX_VALUE - part)
                    return 0;
                at += part;
                ++work;
            }
        }
    }
    pl_u64 expanded = (shape->variable_mask | constant) & word;
    if (expanded != word) {
        pl_operand immediate = { PL_OPERAND_CONST, expanded };
        if (!emit_alu_instruction(
                destination, immediate, shape->bits, 0u, 0u,
                output ? output + at : (pl_u8 *)0, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
        ++work;
    }
    *written = at;
    *instructions = work;
    return work != 0u;
}

static int measure_entry_bit_overlay(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions);
static int write_entry_bit_overlay(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written);

/* Signed and unsigned multiplication have the same low word modulo 2^w.
 * This production only consumes that pure word; live multiply flags/high
 * words retain their distinct architectural producers. */
static int multiply_word_operands(
    const pl_plan *plan, const pl_x86_native_selection *selection,
    pl_operand value, pl_u32 destination, pl_operand *left,
    pl_operand *right, pl_u32 *bits)
{
    if (!plan || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    *bits = node->opcode == PL_OPCODE_MULR ? 64u
          : node->opcode == PL_OPCODE_LANE32_MULR ? 32u : 0u;
    if (!*bits || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || 2u > plan->argument_count - node->argument_at) return 0;
    *left = plan->arguments[node->argument_at];
    *right = plan->arguments[node->argument_at + 1u];
    if (left->kind == PL_OPERAND_CONST && right->kind != PL_OPERAND_CONST) {
        pl_operand swap = *left; *left = *right; *right = swap;
    }
    pl_u32 immediate_bytes = 0u;
    if (right->kind == PL_OPERAND_CONST
            && emit_imul_operand(destination, destination, *right, *bits, 0, &immediate_bytes)) {
        physicalize_selected_operand(plan, selection, destination, left);
        return 1;
    }
    physicalize_selected_operand(plan, selection, destination, left);
    physicalize_selected_operand(plan, selection, destination, right);
    if ((right->kind == PL_OPERAND_LOCAL && right->value == destination)
            || (right->kind != PL_OPERAND_LOCAL && left->kind == PL_OPERAND_LOCAL)) {
        pl_operand swap = *left; *left = *right; *right = swap;
    }
    return right->kind == PL_OPERAND_LOCAL && right->value < PL_X86_GPR_COUNT;
}

static int multiply_immediate_source(const pl_plan *plan, pl_operand left,
                                      pl_operand right, pl_u32 bits, pl_u32 *source)
{
    if (right.kind != PL_OPERAND_CONST) return 0;
    if (left.kind == PL_OPERAND_LOCAL && left.value < PL_X86_GPR_COUNT) {
        *source = (pl_u32)left.value;
        return 1;
    }
    pl_u32 width = 0u;
    return left.kind == PL_OPERAND_NODE
        && zero_extend_node(plan, (pl_u32)left.value, source, &width)
        && width >= bits;
}

static pl_u32 entry_bit_chain_depth(const pl_plan *plan, pl_operand value, pl_u32 entry)
{
    pl_u32 depth = 0u;
    for (pl_u32 remaining = plan->node_count + 1u; remaining; --remaining) {
        if (value.kind == PL_OPERAND_LOCAL) return value.value == entry ? depth : 0u;
        pl_operand source, right;
        pl_u32 bits = 0u, mode = 0u, bytes = 0u;
        if (arithmetic_tree_details(plan, value, &source, &right, &bits, &mode)
                && (mode == 0u || mode == 5u || mode == 6u)
                && right.kind == PL_OPERAND_CONST
                && emit_alu_instruction(entry, right, bits, mode, 0u, 0, &bytes)) {
            value = source;
        } else if (shift_node_details(plan, value, &source, &right, &bits, &mode)
                && right.kind == PL_OPERAND_CONST && (right.value & (bits - 1u))
                && emit_shift_instruction(entry, right, bits, mode, 0, &bytes)) {
            value = source;
        } else return 0u;
        ++depth;
    }
    return 0u;
}

/* Both bit chains start at the same entry coordinate. A clone adds one
 * publication wave to exactly one arm: min(max(a+1,b),max(a,b+1)) clones
 * the shorter arm. Keep the longer chain on the original owner, with no
 * extra work. Measurement and emission use the same bounded chain walk. */
static pl_u32 entry_bit_chain_orientation(const pl_plan *plan, pl_operand left,
                                           pl_operand right, pl_u32 destination,
                                           pl_u32 mode)
{
    if (mode != 0u && mode != 5u && mode != 6u) return 0u;
    pl_u32 a = entry_bit_chain_depth(plan, left, destination);
    pl_u32 b = entry_bit_chain_depth(plan, right, destination);
    return a && b && a < b;
}

/* A diamond q OP shift(q,k) has one producer, not two expression trees.
 * After producing q, its entry operands are dead inside this expression.
 * The caller's scratch mask must separately prove their external lifetime. */
static int shared_shift_join(const pl_plan *plan, pl_operand value, pl_u32 bits,
                             pl_operand *seed, pl_operand *amount,
                             pl_u32 *group, pl_u32 *mode)
{
    pl_operand left, right;
    pl_u32 width = 0u;
    if (!arithmetic_tree_details(plan, value, &left, &right, &width, mode)
            || width != bits) return 0;
    for (pl_u32 reverse = 0u; reverse < 2u; ++reverse) {
        if (reverse && !associative_mode(*mode)) continue;
        pl_operand parent = reverse ? right : left;
        pl_operand shifted = reverse ? left : right;
        if (shift_node_details(plan, shifted, seed, amount, &width, group)
                && width == bits && amount->kind == PL_OPERAND_CONST
                && seed->kind == parent.kind && seed->value == parent.value)
            return 1;
    }
    return 0;
}

static int emit_shared_shift_join(pl_u32 destination, pl_u32 scratch,
                                  pl_operand amount, pl_u32 bits,
                                  pl_u32 group, pl_u32 mode,
                                  pl_u8 *output, pl_u32 *written)
{
    pl_u32 copy = 0u, shift = 0u, join = 0u;
    pl_operand temporary = { PL_OPERAND_LOCAL, scratch };
    if (!emit_gpr_move(scratch, destination, bits, output, &copy)
            || !emit_shift_instruction(scratch, amount, bits, group,
                output ? output + copy : 0, &shift)
            || !emit_alu_instruction(destination, temporary, bits, mode, 0u,
                output ? output + copy + shift : 0, &join)) return 0;
    *written = copy + shift + join;
    return 1;
}

static int measure_alu_tree(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand value,
                            pl_u32 bits, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 scratch_mask,
                            pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !bytes || !instructions
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 fixup_checkpoint = selection->fixup_count;
    /* Mirror the write path: a 32-bit sign extension of a register is one
     * `movslq`, decided before the transient-alias resolution in the seed. */
    if (value.kind == PL_OPERAND_NODE) {
        pl_u32 extension_source = 0u, extension_bits = 0u;
        if (sign_extend_node(&block->plan, (pl_u32)value.value,
                              &extension_source, &extension_bits)
                && extension_bits == 32u
                && emit_sign_extend_move(
                    destination, extension_source, extension_bits,
                    (pl_u8 *)0, bytes)) {
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        pl_operand extension_argument = { 0 };
        pl_u32 extension_owner = PL_X86_GPR_COUNT;
        if (sign_extend_value(&block->plan, (pl_u32)value.value,
                              &extension_argument, &extension_bits)
                && extension_bits == 32u
                && extension_argument.kind == PL_OPERAND_NODE
                && published_operand_local(
                    &block->plan, extension_argument, &extension_owner)
                && emit_sign_extend_move(
                    destination, extension_owner, extension_bits,
                    (pl_u8 *)0, bytes)) {
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
    }
    masked_entry_affine entry_affine;
    if (masked_entry_affine_details(
            &block->plan, value, destination, &entry_affine)
            && (scratch_mask & (1u << entry_affine.source))
            && emit_masked_entry_affine(
                &entry_affine, (pl_u8 *)0, bytes, instructions)) {
        selection->direct_nested_frame = 1u;
        return 1;
    }
    int seeded = measure_alu_seed(
        frontend, block, selection, destination, value, bits, output_at,
        remaining, bytes, instructions);
    if (seeded) return seeded;
    selection->fixup_count = fixup_checkpoint;
    if (remaining <= 1u) {
        record_tree_rejection(selection, value, 1u);
        return 0;
    }

    pl_operand insert_base, insert_inner;
    pl_u32 insert_width = 0u;
    if (node_base_lane_insert(&block->plan, value, &insert_base,
                              &insert_inner, &insert_width)) {
        pl_u32 base_bytes = 0u, base_work = 0u;
        int status = measure_alu_tree(
            frontend, block, selection, destination, insert_base, bits,
            output_at, remaining - 1u, scratch_mask, &base_bytes, &base_work);
        pl_u8 alias_present = selection->frame_alias_present;
        pl_u64 alias_value = selection->frame_alias_value;
        pl_u8 alias_kind = selection->frame_alias_kind;
        pl_u8 alias_local = selection->frame_alias_local;
        if (status > 0) {
            selection->frame_alias_value = insert_base.value;
            selection->frame_alias_kind = insert_base.kind;
            selection->frame_alias_local = (pl_u8)destination;
            selection->frame_alias_present = 1u;
            pl_u32 inner_bytes = 0u, inner_work = 0u;
            status = measure_alu_tree(
                frontend, block, selection, destination, insert_inner,
                insert_width, output_at + base_bytes, remaining - 1u,
                scratch_mask, &inner_bytes, &inner_work);
            if (status > 0 && base_bytes <= U32_MAX_VALUE - inner_bytes
                    && base_work <= U32_MAX_VALUE - inner_work) {
                *bytes = base_bytes + inner_bytes;
                *instructions = base_work + inner_work;
                selection->direct_nested_frame = 1u;
                return 1;
            }
        }
        selection->frame_alias_present = alias_present;
        selection->frame_alias_value = alias_value;
        selection->frame_alias_kind = alias_kind;
        selection->frame_alias_local = alias_local;
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }

    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_BSWAP
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_BSWAP)) {
        pl_u32 byte_swap_bits = block->plan.nodes[value.value - 1u].opcode
                              == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
        pl_operand byte_swap_source = block->plan.arguments[
            block->plan.nodes[value.value - 1u].argument_at];
        pl_u32 prefix = 0u, prefix_work = 0u, operation = 0u;
        int status = measure_alu_tree(
            frontend, block, selection, destination, byte_swap_source,
            byte_swap_bits, output_at, remaining - 1u, scratch_mask,
            &prefix, &prefix_work);
        if (status > 0
                && emit_bswap_register(
                    destination, byte_swap_bits, (pl_u8 *)0, &operation)
                && prefix <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = prefix_work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }

    pl_operand tree_shift_source, tree_shift_amount;
    pl_u32 tree_shift_bits = 0u, tree_shift_group = 0u;
    if (shift_node_details(&block->plan, value, &tree_shift_source,
            &tree_shift_amount, &tree_shift_bits, &tree_shift_group)) {
        pl_u32 shift_prefix = 0u, shift_prefix_work = 0u, shift_operation = 0u;
        int shift_status = measure_alu_tree(
            frontend, block, selection, destination, tree_shift_source,
            tree_shift_bits, output_at, remaining - 1u, scratch_mask,
            &shift_prefix, &shift_prefix_work);
        if (shift_status > 0
                && emit_shift_instruction(
                    destination, tree_shift_amount, tree_shift_bits,
                    tree_shift_group, (pl_u8 *)0, &shift_operation)
                && shift_prefix <= U32_MAX_VALUE - shift_operation
                && shift_prefix_work != U32_MAX_VALUE) {
            *bytes = shift_prefix + shift_operation;
            *instructions = shift_prefix_work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        return shift_status < 0 ? shift_status : 0;
    }

    /* Nested conditional select over an incoming condition.  The plan's
     * physical rewriter leaves the false arm exactly in the destructive
     * destination (`SELECT(a, dst_entry, cc)`), so the one-instruction
     * spelling is `cmovcc dst,a`; `a` is materialised first and must be a
     * flag-preserving constant or an already-live register. */
    boolean_select tree_boolean;
    condition_value tree_condition;
    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_SELECT
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_SELECT)
            && boolean_select_details(&block->plan, value, &tree_boolean)
            && condition_value_details(
                &block->plan, tree_boolean.condition, &tree_condition)
            && tree_condition.flags.kind == PL_OPERAND_LOCAL
            && tree_condition.flags.value == PL_X86_RFLAGS_LOCAL) {
        pl_u32 false_local = 0u;
        int false_is_destination =
            (tree_boolean.when_false.kind == PL_OPERAND_LOCAL
                && tree_boolean.when_false.value == destination)
            || ((tree_boolean.when_false.kind == PL_OPERAND_NODE
                    || tree_boolean.when_false.kind == PL_OPERAND_PROJECTION)
                && published_operand_local(
                    &block->plan, tree_boolean.when_false, &false_local)
                && false_local == destination);
        if (false_is_destination) {
            pl_u32 candidate_local = PL_X86_GPR_COUNT;
            pl_u32 candidate_bytes = 0u, candidate_work = 0u;
            int status = 1;
            if (tree_boolean.when_true.kind == PL_OPERAND_CONST) {
                for (pl_u32 scratch = 0u;
                        scratch < PL_X86_GPR_COUNT; ++scratch)
                    if (scratch != destination
                            && (scratch_mask & (1u << scratch))) {
                        candidate_local = scratch;
                        break;
                    }
                status = candidate_local < PL_X86_GPR_COUNT
                    ? measure_alu_tree(
                        frontend, block, selection, candidate_local,
                        tree_boolean.when_true, tree_boolean.value_bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~(1u << candidate_local),
                        &candidate_bytes, &candidate_work)
                    : 0;
            } else {
                /* Only a constant true arm is materialised here.  A register
                 * arm is left to the publication-level select handoff so the
                 * entry-select-overlay canonical schedule is preserved. */
                status = 0;
            }
            pl_u32 move_bytes = 0u;
            if (status > 0
                    && emit_conditional_move(
                        destination, candidate_local,
                        tree_boolean.value_bits, tree_condition.condition,
                        (pl_u8 *)0, &move_bytes)
                    && candidate_bytes <= U32_MAX_VALUE - move_bytes
                    && candidate_work != U32_MAX_VALUE) {
                *bytes = candidate_bytes + move_bytes;
                *instructions = candidate_work + 1u;
                selection->direct_nested_frame = 1u;
                return 1;
            }
            selection->fixup_count = fixup_checkpoint;
            return status < 0 ? status : 0;
        }
    }

    condition_value flag_condition;
    if (condition_value_details(&block->plan, value, &flag_condition)
            && flag_condition.flags.kind == PL_OPERAND_NODE) {
        pl_operand compare_left, compare_right;
        pl_u32 compare_bits = 0u, compare_mode = 0u, compare_carry = 0u;
        if (flag_operation_details(
                &block->plan, flag_condition.flags, &compare_left,
                &compare_right, &compare_bits, &compare_mode, &compare_carry)
                && !compare_carry
                && (compare_mode == 0u || compare_mode == 3u)) {
            physicalize_published_operand(
                &block->plan, destination, &compare_left);
            physicalize_published_operand(
                &block->plan, destination, &compare_right);
            if (compare_left.kind == PL_OPERAND_LOCAL
                    && compare_left.value < PL_X86_GPR_COUNT) {
                pl_operand physical_right = compare_right;
                pl_u32 operand_bytes = 0u, operand_work = 0u;
                if (physical_right.kind == PL_OPERAND_CONST) {
                    /* Materialise through the fixup-producing seed path.  The
                     * source LEA writes one register, and source_address_definition
                     * only binds the field when the destination matches it, so
                     * prefer the CONDITION destination and fall back to a
                     * scratch.  An address constant then becomes a RIP-relative
                     * LEA that alias_source_address_fields can attach. */
                    pl_u32 operand_local = destination;
                    if (operand_local == (pl_u32)compare_left.value) {
                        operand_local = PL_X86_GPR_COUNT;
                        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                                ++scratch)
                            if (scratch != destination
                                    && scratch != (pl_u32)compare_left.value
                                    && (scratch_mask & (1u << scratch))) {
                                operand_local = scratch;
                                break;
                            }
                    }
                    if (operand_local >= PL_X86_GPR_COUNT) {
                        selection->fixup_count = fixup_checkpoint;
                        return 0;
                    }
                    int operand_status = measure_alu_tree(
                        frontend, block, selection, operand_local,
                        compare_right, compare_bits, output_at,
                        remaining - 1u,
                        operand_local == destination
                            ? scratch_mask
                            : scratch_mask & ~(1u << operand_local),
                        &operand_bytes, &operand_work);
                    if (operand_status <= 0) {
                        selection->fixup_count = fixup_checkpoint;
                        return operand_status < 0 ? operand_status : 0;
                    }
                    physical_right = (pl_operand){ PL_OPERAND_LOCAL,
                                                   operand_local };
                } else if (!(physical_right.kind == PL_OPERAND_LOCAL
                        && physical_right.value < PL_X86_GPR_COUNT)) {
                    selection->fixup_count = fixup_checkpoint;
                    return 0;
                }
                pl_u32 compare_bytes = 0u, set_bytes = 0u;
                if (emit_flag_coordinate(
                        (pl_u32)compare_left.value, physical_right,
                        compare_bits, compare_mode == 0u, 0u,
                        (pl_u8 *)0, &compare_bytes)
                        && emit_set_condition(
                            destination, flag_condition.condition,
                            (pl_u8 *)0, &set_bytes)
                        && operand_bytes <= U32_MAX_VALUE - compare_bytes
                        && operand_bytes + compare_bytes
                           <= U32_MAX_VALUE - set_bytes
                        && operand_work <= U32_MAX_VALUE - 2u) {
                    *bytes = operand_bytes + compare_bytes + set_bytes;
                    *instructions = operand_work + 2u;
                    return 1;
                }
            }
        }
    }

    pl_operand shared_seed, shared_amount;
    pl_u32 shared_group = 0u, shared_mode = 0u;
    if (shared_shift_join(&block->plan, value, bits, &shared_seed,
                          &shared_amount, &shared_group, &shared_mode)) {
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            if (scratch == destination || !(scratch_mask & (1u << scratch)))
                continue;
            pl_u32 prefix = 0u, work = 0u, tail = 0u;
            int status = measure_alu_tree(frontend, block, selection,
                destination, shared_seed, bits, output_at, remaining - 1u,
                scratch_mask, &prefix, &work);
            if (status > 0 && emit_shared_shift_join(destination, scratch,
                    shared_amount, bits, shared_group, shared_mode, 0, &tail)
                    && prefix <= U32_MAX_VALUE - tail
                    && work <= U32_MAX_VALUE - 3u) {
                *bytes = prefix + tail;
                *instructions = work + 3u;
                selection->direct_nested_frame = 1u;
                return 1;
            }
            selection->fixup_count = fixup_checkpoint;
            if (status < 0) return status;
        }
    }

    carry_adjustment adjustment;
    if (carry_adjustment_details(&block->plan, value, destination, bits, &adjustment)
            && emit_carry_adjustment(&adjustment, destination, 0, bytes, instructions)) {
        selection->direct_nested_frame = 1u;
        return 1;
    }
    pl_operand signed_source;
    pl_u32 signed_bits = 0u;
    if (bits == 64u && value.kind == PL_OPERAND_NODE
            && sign_extend_value(&block->plan, (pl_u32)value.value,
                                 &signed_source, &signed_bits)) {
        /* Widen the normalized value, not only an entry register. The low
         * subtree is evaluated once in its destination before MOVSX/CDQE. */
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        int measured = measure_alu_tree(
            frontend, block, selection, destination, signed_source, 32u,
            output_at, remaining - 1u, scratch_mask, &prefix, &work);
        if (measured <= 0 || !emit_sign_extend_move(
                destination, destination, signed_bits, (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation || work == U32_MAX_VALUE)
            return measured < 0 ? measured : 0;
        *bytes = prefix + operation;
        *instructions = work + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }

    pl_operand multiply_left, multiply_right;
    pl_u32 multiply_bits = 0u;
    if (multiply_word_operands(&block->plan, selection, value, destination,
                              &multiply_left, &multiply_right, &multiply_bits)) {
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        pl_u32 direct_source = 0u;
        if (multiply_immediate_source(&block->plan, multiply_left, multiply_right,
                multiply_bits, &direct_source)
                && emit_imul_operand(destination, direct_source, multiply_right,
                    multiply_bits, 0, bytes)) {
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        if (multiply_right.kind == PL_OPERAND_LOCAL && multiply_right.value == destination
                && !(multiply_left.kind == PL_OPERAND_LOCAL
                     && multiply_left.value == destination)) return 0;
        int measured = measure_alu_tree(
            frontend, block, selection, destination, multiply_left,
            alu_input_expression_bits(&block->plan, multiply_left, multiply_bits),
            output_at, remaining - 1u, scratch_mask, &prefix, &work);
        if (measured <= 0 || !emit_imul_operand(
                destination, destination, multiply_right, multiply_bits,
                (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation || work == U32_MAX_VALUE)
            return measured < 0 ? measured : 0;
        *bytes = prefix + operation;
        *instructions = work + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }

    quotient_boundary_select boundary;
    if (quotient_boundary_select_details(
            &block->plan, value, destination, &boundary))
        return measure_quotient_boundary_select(
            frontend, block, selection, destination, &boundary,
            output_at, remaining, scratch_mask, bytes, instructions);

    conditional_select select;
    if (conditional_select_details(
            &block->plan, value, destination, &select)
            && (select.has_compare || select.current_flag_node
                || (!output_at
                    && select.current.kind == PL_OPERAND_LOCAL
                    && select.current.value == destination))
            && select.candidate_local != destination
            && conditional_compare_survives_current(
                &select, destination)) {
        pl_u32 at = 0u;
        pl_u32 seed_bytes = 0u, seed_work = 0u;
        int status = select.current_flag_node
            ? measure_selected_flag_value(frontend, block, selection, destination, &select,
                output_at, remaining - 1u, scratch_mask, &seed_bytes, &seed_work)
            : measure_alu_tree(
            frontend, block, selection, destination, select.current,
            select.value_bits, output_at, remaining - 1u, scratch_mask,
            &seed_bytes, &seed_work);
        at += seed_bytes;
        pl_u32 candidate_local = select.candidate_local;
        pl_u32 cand_bytes = 0u, cand_work = 0u;
        if (status > 0 && select.candidate_immediate) {
            candidate_local = PL_X86_GPR_COUNT;
            for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch)
                if (scratch != destination
                        && (scratch_mask & (1u << scratch))) {
                    candidate_local = scratch;
                    break;
                }
            if (candidate_local >= PL_X86_GPR_COUNT) return 0;
            status = measure_alu_tree(
                frontend, block, selection, candidate_local,
                select.candidate_value, select.value_bits, output_at + at,
                remaining - 1u, scratch_mask & ~(1u << candidate_local),
                &cand_bytes, &cand_work);
            at += cand_bytes;
        }
        pl_u32 compare_bytes = 0u, move_bytes = 0u;
        int compared = status <= 0 ? 0 : !select.has_compare ? 1
            : emit_select_compare(&select, 0, &compare_bytes);
        if (status > 0 && compared
                && emit_conditional_move(
                    destination, candidate_local,
                    select.value_bits, select.condition,
                    (pl_u8 *)0, &move_bytes)
                && at <= U32_MAX_VALUE - compare_bytes
                && at + compare_bytes <= U32_MAX_VALUE - move_bytes
                && seed_work <= U32_MAX_VALUE - cand_work
                && seed_work + cand_work <= U32_MAX_VALUE - 1u
                                            - select.has_compare) {
            *bytes = at + compare_bytes + move_bytes;
            *instructions = seed_work + cand_work + 1u + select.has_compare;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    condition_value condition_value_shape;
    if (condition_value_details(
            &block->plan, value, &condition_value_shape)) {
        pl_u32 flag_bytes = 0u, flag_work = 0u;
        int status = 1;
        if (!(condition_value_shape.flags.kind == PL_OPERAND_LOCAL
                && condition_value_shape.flags.value
                   == PL_X86_RFLAGS_LOCAL)) {
            pl_operand left, right;
            pl_u32 flag_bits = 0u, flag_mode = 0u, preserves_carry = 0u;
            if (!flag_operation_details(
                    &block->plan, condition_value_shape.flags,
                    &left, &right, &flag_bits, &flag_mode,
                    &preserves_carry)) {
                status = 0;
            } else {
                status = measure_alu_pair(
                    frontend, block, selection, destination, left, right,
                    flag_bits, flag_mode, preserves_carry, output_at,
                    remaining - 1u, scratch_mask,
                    &flag_bytes, &flag_work);
            }
        }
        pl_operand zero = { PL_OPERAND_CONST, 0u };
        pl_u32 zero_bytes = 0u, zero_work = 0u;
        if (status > 0 && flag_bytes <= U32_MAX_VALUE - output_at)
            status = measure_alu_tree(
                frontend, block, selection, destination, zero, bits,
                output_at + flag_bytes, remaining - 1u, scratch_mask,
                &zero_bytes, &zero_work);
        pl_u32 set_bytes = 0u;
        if (status > 0
                && emit_set_condition(
                    destination, condition_value_shape.condition,
                    (pl_u8 *)0, &set_bytes)
                && flag_bytes <= U32_MAX_VALUE - zero_bytes
                && flag_bytes + zero_bytes <= U32_MAX_VALUE - set_bytes
                && flag_work <= U32_MAX_VALUE - zero_work
                && flag_work + zero_work != U32_MAX_VALUE) {
            *bytes = flag_bytes + zero_bytes + set_bytes;
            *instructions = flag_work + zero_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    boolean_select boolean;
    if (boolean_select_details(&block->plan, value, &boolean)) {
        for (pl_u32 inverse = 0u; inverse < 2u; ++inverse) {
            pl_operand current = inverse
                               ? boolean.when_true : boolean.when_false;
            pl_operand candidate = inverse
                                 ? boolean.when_false : boolean.when_true;
            pl_u32 condition_code = inverse ? 4u : 5u;
            if (current.kind == PL_OPERAND_LOCAL
                    && current.value == destination)
                continue;
            pl_u32 candidate_first = 0u;
            pl_u32 candidate_limit = PL_X86_GPR_COUNT;
            int materialize_candidate = candidate.kind == PL_OPERAND_CONST;
            if (candidate.kind == PL_OPERAND_LOCAL) {
                if (candidate.value == destination) continue;
                candidate_first = (pl_u32)candidate.value;
                candidate_limit = candidate_first + 1u;
            }
            for (pl_u32 candidate_local = candidate_first;
                    candidate_local < candidate_limit; ++candidate_local) {
                pl_u32 candidate_bit = 1u << candidate_local;
                if (materialize_candidate
                        && !(scratch_mask & candidate_bit))
                    continue;
                selection->fixup_count = fixup_checkpoint;
                pl_u32 condition_bytes = 0u, condition_work = 0u;
                pl_u32 condition_overhead = 0u;
                int status = 1;
                condition_value direct_condition;
                if (condition_value_details(
                        &block->plan, boolean.condition,
                        &direct_condition)) {
                    condition_code = direct_condition.condition ^ inverse;
                    if (!(direct_condition.flags.kind == PL_OPERAND_LOCAL
                            && direct_condition.flags.value
                               == PL_X86_RFLAGS_LOCAL)) {
                        pl_operand flag_left, flag_right;
                        pl_u32 flag_bits = 0u, flag_mode = 0u;
                        pl_u32 preserves_carry = 0u;
                        if (!flag_operation_details(
                                &block->plan, direct_condition.flags,
                                &flag_left, &flag_right, &flag_bits,
                                &flag_mode, &preserves_carry)) {
                            status = 0;
                        } else {
                            status = measure_alu_pair(
                                frontend, block, selection, destination,
                                flag_left, flag_right, flag_bits, flag_mode,
                                preserves_carry, output_at,
                                remaining - 1u, scratch_mask,
                                &condition_bytes, &condition_work);
                        }
                    }
                } else {
                    pl_u32 condition_bits = operand_expression_bits(
                        &block->plan, boolean.condition, 64u);
                    status = measure_alu_tree(
                        frontend, block, selection, destination,
                        boolean.condition, condition_bits, output_at,
                        remaining - 1u, scratch_mask,
                        &condition_bytes, &condition_work);
                    pl_u32 test_bytes = 0u;
                    if (status > 0
                            && emit_test_registers(
                                destination, destination, condition_bits,
                                (pl_u8 *)0, &test_bytes)
                            && condition_bytes
                               <= U32_MAX_VALUE - test_bytes) {
                        condition_bytes += test_bytes;
                        condition_overhead = 1u;
                    } else if (status > 0) {
                        status = 0;
                    }
                }
                if (status <= 0) {
                    selection->fixup_count = fixup_checkpoint;
                    if (status < 0) return status;
                    continue;
                }
                pl_u32 at = condition_bytes;
                if (at > U32_MAX_VALUE - output_at) {
                    selection->fixup_count = fixup_checkpoint;
                    continue;
                }
                pl_u32 current_bytes = 0u, current_work = 0u;
                status = measure_alu_tree(
                    frontend, block, selection, destination, current,
                    boolean.value_bits, output_at + at,
                    remaining - 1u, scratch_mask & ~candidate_bit,
                    &current_bytes, &current_work);
                if (status <= 0 || at > U32_MAX_VALUE - current_bytes) {
                    selection->fixup_count = fixup_checkpoint;
                    if (status < 0) return status;
                    continue;
                }
                at += current_bytes;
                pl_u32 candidate_bytes = 0u, candidate_work = 0u;
                if (materialize_candidate) {
                    status = measure_alu_tree(
                        frontend, block, selection, candidate_local,
                        candidate, boolean.value_bits, output_at + at,
                        remaining - 1u, scratch_mask & ~candidate_bit,
                        &candidate_bytes, &candidate_work);
                    if (status <= 0 || at > U32_MAX_VALUE - candidate_bytes) {
                        selection->fixup_count = fixup_checkpoint;
                        if (status < 0) return status;
                        continue;
                    }
                    at += candidate_bytes;
                }
                pl_u32 move_bytes = 0u;
                if (!emit_conditional_move(
                        destination, candidate_local, boolean.value_bits,
                        condition_code, (pl_u8 *)0, &move_bytes)
                        || at > U32_MAX_VALUE - move_bytes
                        || condition_work > U32_MAX_VALUE - current_work
                        || condition_work + current_work
                           > U32_MAX_VALUE - candidate_work
                        || condition_work + current_work + candidate_work
                           > U32_MAX_VALUE - (1u + condition_overhead)) {
                    selection->fixup_count = fixup_checkpoint;
                    continue;
                }
                *bytes = at + move_bytes;
                *instructions = condition_work + current_work
                              + candidate_work + 1u + condition_overhead;
                selection->direct_nested_frame = 1u;
                return 1;
            }
        }
        selection->fixup_count = fixup_checkpoint;
    }

    pl_operand original_left, original_right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            &block->plan, value, &original_left, &original_right,
            &node_bits, &mode)
            || node_bits != bits) {
        record_tree_rejection(selection, value, 2u);
        return 0;
    }

    low32_entry_overlay low32_overlay;
    if (low32_entry_overlay_details(
            &block->plan, value, destination, &low32_overlay)) {
        int measured = measure_low32_entry_overlay(
            frontend, block, selection, &low32_overlay, output_at,
            scratch_mask, bytes, instructions);
        if (measured) return measured;
        selection->fixup_count = fixup_checkpoint;
    }

    split_entry_overlay split_overlay;
    if (split_entry_overlay_details(
            &block->plan, value, destination, &split_overlay)
            && (scratch_mask & (1u << split_overlay.side))) {
        if (emit_split_entry_overlay(
                &split_overlay, (pl_u8 *)0, bytes, instructions)) {
            selection->direct_nested_frame = 1u;
            return 1;
        }
    }

    entry_bit_overlay overlay;
    if (entry_bit_overlay_details(&block->plan, value, &overlay))
        return measure_entry_bit_overlay(
            frontend, block, selection, destination, &overlay,
            output_at, remaining, scratch_mask, bytes, instructions);

    conditional_or_fold fold;
    pl_u32 condition_sources = 0u;
    if (conditional_or_fold_details(
            &block->plan, original_left, original_right,
            bits, mode, &fold)
            && operand_entry_gpr_sources(
                &block->plan, fold.flag_left,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && operand_entry_gpr_sources(
                &block->plan, fold.flag_right,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && !(condition_sources & (1u << destination))) {
        for (pl_u32 candidate = 0u;
                candidate < PL_X86_GPR_COUNT; ++candidate) {
            pl_u32 candidate_bit = 1u << candidate;
            if (!(scratch_mask & candidate_bit)
                    || (condition_sources & candidate_bit))
                continue;
            for (pl_u32 flag_destination = 0u;
                    flag_destination < PL_X86_GPR_COUNT;
                    ++flag_destination) {
                pl_u32 flag_bit = 1u << flag_destination;
                if (flag_destination == candidate
                        || !(scratch_mask & flag_bit))
                    continue;
                selection->fixup_count = fixup_checkpoint;
                pl_u32 base_bytes = 0u, base_work = 0u;
                int status = measure_alu_tree(
                    frontend, block, selection, destination, fold.base,
                    bits, output_at, remaining - 1u,
                    scratch_mask & ~condition_sources,
                    &base_bytes, &base_work);
                pl_u32 copy_bytes = 0u, mask_bytes = 0u;
                if (status <= 0
                        || !emit_gpr_move(
                            candidate, destination, bits,
                            (pl_u8 *)0, &copy_bytes)
                        || !emit_alu_instruction(
                            candidate, fold.mask, bits, 5u, 0u,
                            (pl_u8 *)0, &mask_bytes)
                        || base_bytes > U32_MAX_VALUE - copy_bytes
                        || base_bytes + copy_bytes
                           > U32_MAX_VALUE - mask_bytes) {
                    selection->fixup_count = fixup_checkpoint;
                    if (status < 0) return status;
                    continue;
                }
                pl_u32 prefix = base_bytes + copy_bytes + mask_bytes;
                if (prefix > U32_MAX_VALUE - output_at) {
                    selection->fixup_count = fixup_checkpoint;
                    continue;
                }
                pl_u32 flag_bytes = 0u, flag_work = 0u;
                status = measure_alu_pair(
                    frontend, block, selection, flag_destination,
                    fold.flag_left, fold.flag_right, fold.flag_bits,
                    fold.flag_mode, fold.preserves_carry,
                    output_at + prefix, remaining - 1u,
                    scratch_mask & ~candidate_bit & ~flag_bit,
                    &flag_bytes, &flag_work);
                pl_u32 move_bytes = 0u;
                if (status > 0
                        && emit_conditional_move(
                            destination, candidate, bits, fold.condition,
                            (pl_u8 *)0, &move_bytes)
                        && prefix <= U32_MAX_VALUE - flag_bytes
                        && prefix + flag_bytes
                           <= U32_MAX_VALUE - move_bytes
                        && base_work <= U32_MAX_VALUE - flag_work
                        && base_work + flag_work
                           <= U32_MAX_VALUE - 3u) {
                    *bytes = prefix + flag_bytes + move_bytes;
                    *instructions = base_work + flag_work + 3u;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }
        }
        selection->fixup_count = fixup_checkpoint;
    }

    if (associative_mode(mode)
            && (original_left.kind == PL_OPERAND_CONST
                || (original_left.kind == PL_OPERAND_LOCAL
                    && original_left.value < PL_X86_GPR_COUNT
                    && original_left.value != destination))
            && original_right.kind != PL_OPERAND_CONST
            && original_right.kind != PL_OPERAND_LOCAL) {
        pl_u32 prefix_bytes = 0u, prefix_work = 0u;
        pl_u32 right_bits = operand_expression_bits(
            &block->plan, original_right, bits);
        int status = measure_alu_tree(
            frontend, block, selection, destination, original_right,
            right_bits, output_at, remaining - 1u, scratch_mask,
            &prefix_bytes, &prefix_work);
        pl_u32 operation = 0u;
        if (status > 0
                && emit_alu_instruction(
                    destination, original_left, bits, mode, 0u,
                    (pl_u8 *)0, &operation)
                && prefix_bytes <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix_bytes + operation;
            *instructions = prefix_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    /* A shared subvalue which already owns a final GPR is a register operand,
     * not a reason to allocate a second transient copy.  Resolve both sides:
     * resolving only the right operand still recursively rebuilt a published
     * left subtree for every consumer. */
    pl_operand physical_left = original_left;
    pl_operand physical_right = original_right;
    physicalize_published_operand(
        &block->plan, destination, &physical_left);

    /* A native right operand is already materialized.  Keep its entry
     * coordinate pinned while recursively producing the left tree, then
     * consume it directly.  Materializing that operand into a scratch first
     * adds one unit of work and can lengthen the dependency chain; it is
     * necessary only when the right expression has no exact native spelling.
     * This rule is especially important after an earlier publication makes a
     * destination such as RBX available as the left tree's transient owner. */
    if (physical_right.kind == PL_OPERAND_CONST
            || (physical_right.kind == PL_OPERAND_LOCAL
                && physical_right.value < PL_X86_GPR_COUNT
                && physical_right.value != destination)) {
        pl_u32 pinned = physical_right.kind == PL_OPERAND_LOCAL
                      ? 1u << (pl_u32)physical_right.value : 0u;
        pl_u32 prefix_bytes = 0u, prefix_work = 0u;
        int status = measure_alu_tree(
            frontend, block, selection, destination, physical_left,
            bits, output_at, remaining - 1u, scratch_mask & ~pinned,
            &prefix_bytes, &prefix_work);
        pl_u32 operation = 0u;
        if (status > 0
                && emit_alu_instruction(
                    destination, physical_right, bits, mode, 0u,
                    (pl_u8 *)0, &operation)
                && prefix_bytes <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix_bytes + operation;
            *instructions = prefix_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    pl_u32 owner = PL_X86_GPR_COUNT;
    if (published_operand_local(
                &block->plan, physical_right, &owner)
            && owner != destination) {
        physical_right.kind = PL_OPERAND_LOCAL;
        physical_right.value = owner;
        pl_u32 prefix_bytes = 0u, prefix_work = 0u;
        int status = measure_alu_tree(
            frontend, block, selection, destination, physical_left,
            bits, output_at, remaining - 1u, scratch_mask,
            &prefix_bytes, &prefix_work);
        pl_u32 operation = 0u;
        if (status > 0
                && emit_alu_instruction(
                    destination, physical_right, bits, mode, 0u,
                    (pl_u8 *)0, &operation)
                && prefix_bytes <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix_bytes + operation;
            *instructions = prefix_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    /* Do not flatten two independent arithmetic subtrees onto one serial
     * accumulator.  When the side subtree can start on one of its own entry
     * owners, both arms retain their dependency depth and require no extra
     * copy; a single final associative join then realizes the original DAG.
     * This is the physical parallel form of a balanced reduction, not an
     * instruction-order heuristic. */
    if (associative_mode(mode) && scratch_mask
            && (original_left.kind == PL_OPERAND_NODE
                || original_left.kind == PL_OPERAND_PROJECTION)
            && (original_right.kind == PL_OPERAND_NODE
                || original_right.kind == PL_OPERAND_PROJECTION)) {
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            pl_operand trunk = orientation
                             ? original_right : original_left;
            pl_operand side = orientation
                            ? original_left : original_right;
            pl_u32 trunk_sources = 0u, side_sources = 0u;
            if (!operand_entry_gpr_sources(
                    &block->plan, trunk,
                    block->plan.node_count + 1u, remaining,
                    &trunk_sources)
                    || !operand_entry_gpr_sources(
                        &block->plan, side,
                        block->plan.node_count + 1u, remaining,
                        &side_sources)
                    || (side_sources & (1u << destination)))
                continue;
            pl_u32 preferred = scratch_mask & side_sources;
            for (pl_u32 scratch = 0u;
                    scratch < PL_X86_GPR_COUNT; ++scratch) {
                pl_u32 scratch_bit = 1u << scratch;
                if (!(preferred & scratch_bit)) continue;
                selection->fixup_count = fixup_checkpoint;
                pl_u32 trunk_bytes = 0u, trunk_work = 0u;
                int status = measure_alu_tree(
                    frontend, block, selection, destination, trunk, bits,
                    output_at, remaining - 1u,
                    scratch_mask & ~side_sources,
                    &trunk_bytes, &trunk_work);
                pl_u32 side_bytes = 0u, side_work = 0u;
                if (status > 0
                        && trunk_bytes <= U32_MAX_VALUE - output_at)
                    status = measure_alu_tree(
                        frontend, block, selection, scratch, side, bits,
                        output_at + trunk_bytes, remaining - 1u,
                        scratch_mask & ~scratch_bit,
                        &side_bytes, &side_work);
                pl_operand side_value = {
                    PL_OPERAND_LOCAL, scratch,
                };
                pl_u32 operation = 0u;
                if (status > 0
                        && emit_alu_instruction(
                            destination, side_value, bits, mode, 0u,
                            (pl_u8 *)0, &operation)
                        && trunk_bytes <= U32_MAX_VALUE - side_bytes
                        && trunk_bytes + side_bytes
                           <= U32_MAX_VALUE - operation
                        && trunk_work <= U32_MAX_VALUE - side_work
                        && trunk_work + side_work != U32_MAX_VALUE) {
                    *bytes = trunk_bytes + side_bytes + operation;
                    *instructions = trunk_work + side_work + 1u;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }
        }
    }

    if (associative_mode(mode) && scratch_mask) {
        pl_u32 capacity = block->plan.node_count + 1u;
        pl_operand leaves[capacity];
        pl_u32 leaf_count = 0u;
        if (collect_associative_leaves(
                &block->plan, value, bits, mode, leaves, capacity,
                &leaf_count, block->plan.node_count + 1u)
                && leaf_count > 2u) {
            promote_associative_destination_leaf(
                leaves, leaf_count, destination);
            pl_u32 leaf_sources[leaf_count];
            pl_u32 suffix_sources[leaf_count + 1u];
            suffix_sources[leaf_count] = 0u;
            int sources_valid = 1;
            for (pl_u32 at = leaf_count; at-- > 0u;) {
                leaf_sources[at] = 0u;
                if (!operand_entry_gpr_sources(
                        &block->plan, leaves[at],
                        block->plan.node_count + 1u,
                        remaining, &leaf_sources[at])) {
                    sources_valid = 0;
                    break;
                }
                suffix_sources[at] = suffix_sources[at + 1u]
                                   | leaf_sources[at];
            }
            if (sources_valid
                    && !(suffix_sources[1u] & (1u << destination))) {
                selection->fixup_count = fixup_checkpoint;
                pl_u32 total_bytes = 0u, total_work = 0u;
                pl_u32 leaf_bits = operand_expression_bits(
                    &block->plan, leaves[0], bits);
                int status = measure_alu_tree(
                    frontend, block, selection, destination, leaves[0],
                    leaf_bits, output_at, remaining - 1u,
                    scratch_mask & ~suffix_sources[1u],
                    &total_bytes, &total_work);
                for (pl_u32 at = 1u; status > 0 && at < leaf_count; ++at) {
                    pl_u32 available = scratch_mask
                                     & ~suffix_sources[at + 1u];
                    pl_u32 scratch = 0u;
                    pl_u32 final_owner = available & leaf_sources[at];
                    pl_u32 preferred = final_owner ? final_owner : available;
                    while (scratch < PL_X86_GPR_COUNT
                            && !(preferred & (1u << scratch)))
                        ++scratch;
                    if (scratch == PL_X86_GPR_COUNT
                            || total_bytes > U32_MAX_VALUE - output_at) {
                        status = 0;
                        break;
                    }
                    pl_u32 scratch_bit = 1u << scratch;
                    pl_u32 part_bytes = 0u, part_work = 0u;
                    leaf_bits = operand_expression_bits(
                        &block->plan, leaves[at], bits);
                    status = measure_alu_tree(
                        frontend, block, selection, scratch, leaves[at],
                        leaf_bits, output_at + total_bytes,
                        remaining - 1u,
                        available & ~scratch_bit,
                        &part_bytes, &part_work);
                    pl_operand scratch_value = {
                        PL_OPERAND_LOCAL, scratch,
                    };
                    pl_u32 operation = 0u;
                    if (status <= 0
                            || !emit_alu_instruction(
                                destination, scratch_value, bits, mode, 0u,
                                (pl_u8 *)0, &operation)
                            || total_bytes > U32_MAX_VALUE - part_bytes
                            || total_bytes + part_bytes
                               > U32_MAX_VALUE - operation
                            || total_work > U32_MAX_VALUE - part_work
                            || total_work + part_work == U32_MAX_VALUE) {
                        status = status < 0 ? status : 0;
                        break;
                    }
                    total_bytes += part_bytes + operation;
                    total_work += part_work + 1u;
                }
                if (status > 0) {
                    *bytes = total_bytes;
                    *instructions = total_work;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }
        }
    }

    pl_u32 orientations = mode == 3u ? 1u : 2u;
    pl_u32 first_orientation = entry_bit_chain_orientation(
        &block->plan, original_left, original_right, destination, mode);
    for (pl_u32 attempt = 0u; attempt < orientations; ++attempt) {
        pl_u32 orientation = attempt ^ first_orientation;
        pl_operand left = orientation ? original_right : original_left;
        pl_operand right = orientation ? original_left : original_right;
        pl_u32 left_sources = 0u;
        pl_u32 right_sources = 0u;
        if (!operand_entry_gpr_sources(
                &block->plan, left, block->plan.node_count + 1u,
                remaining, &left_sources)
                || !operand_entry_gpr_sources(
                    &block->plan, right,
                    block->plan.node_count + 1u,
                    remaining, &right_sources))
            continue;
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            pl_u32 scratch_bit = 1u << scratch;
            if (!(scratch_mask & scratch_bit)) continue;

            /* Right first: its owner may consume its own entry value, but
             * the later left subtree must not need that old value. */
            if (!(left_sources & scratch_bit)) {
                selection->fixup_count = fixup_checkpoint;
                pl_u32 right_bytes = 0u, right_work = 0u;
                int status = measure_alu_tree(
                    frontend, block, selection, scratch, right, bits,
                    output_at, remaining - 1u,
                    scratch_mask & ~scratch_bit,
                    &right_bytes, &right_work);
                pl_u32 left_bytes = 0u, left_work = 0u;
                if (status > 0 && right_bytes <= U32_MAX_VALUE - output_at)
                    status = measure_alu_tree(
                        frontend, block, selection, destination, left, bits,
                        output_at + right_bytes, remaining - 1u,
                        scratch_mask & ~scratch_bit,
                        &left_bytes, &left_work);
                pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
                pl_u32 operation = 0u;
                if (status > 0
                        && emit_alu_instruction(
                            destination, scratch_value, bits, mode, 0u,
                            (pl_u8 *)0, &operation)
                        && right_bytes <= U32_MAX_VALUE - left_bytes
                        && right_bytes + left_bytes
                           <= U32_MAX_VALUE - operation
                        && right_work <= U32_MAX_VALUE - left_work
                        && right_work + left_work != U32_MAX_VALUE) {
                    *bytes = right_bytes + left_bytes + operation;
                    *instructions = right_work + left_work + 1u;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }

            /* Left first: destination's entry value must not be needed by
             * the right subtree.  Registers still live in the right subtree
             * cannot be borrowed while producing left; once left completes,
             * its last-use-only entries become available to right. */
            if (right_sources & (1u << destination)) continue;
            selection->fixup_count = fixup_checkpoint;
            pl_u32 left_bytes = 0u, left_work = 0u;
            int status = measure_alu_tree(
                frontend, block, selection, destination, left, bits,
                output_at, remaining - 1u,
                scratch_mask & ~right_sources,
                &left_bytes, &left_work);
            pl_u32 right_bytes = 0u, right_work = 0u;
            if (status > 0 && left_bytes <= U32_MAX_VALUE - output_at)
                status = measure_alu_tree(
                    frontend, block, selection, scratch, right, bits,
                    output_at + left_bytes, remaining - 1u,
                    scratch_mask & ~scratch_bit,
                    &right_bytes, &right_work);
            pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
            pl_u32 operation = 0u;
            if (status > 0
                    && emit_alu_instruction(
                        destination, scratch_value, bits, mode, 0u,
                        (pl_u8 *)0, &operation)
                    && left_bytes <= U32_MAX_VALUE - right_bytes
                    && left_bytes + right_bytes <= U32_MAX_VALUE - operation
                    && left_work <= U32_MAX_VALUE - right_work
                    && left_work + right_work != U32_MAX_VALUE) {
                *bytes = left_bytes + right_bytes + operation;
                *instructions = left_work + right_work + 1u;
                selection->direct_nested_frame = 1u;
                return 1;
            }
            selection->fixup_count = fixup_checkpoint;
            if (status < 0) return status;
        }
    }
    /* A published left subtree may be the right register of a commutative
     * instruction. Finish the entry-dependent right subtree in place before
     * the join; copying the published left over it would destroy that entry. */
    physicalize_selected_operand(&block->plan, selection, destination, &physical_left);
    if (associative_mode(mode) && physical_left.kind == PL_OPERAND_LOCAL
            && physical_left.value != destination) {
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        int measured = measure_alu_tree(
            frontend, block, selection, destination, original_right, bits,
            output_at, remaining - 1u, scratch_mask & ~(1u << physical_left.value),
            &prefix, &work);
        if (measured > 0 && emit_alu_instruction(
                destination, physical_left, bits, mode, 0u, 0, &operation)
                && prefix <= U32_MAX_VALUE - operation && work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (measured < 0) return measured;
    }
    record_tree_rejection(selection, value, 3u);
    return 0;
}

static int measure_entry_bit_overlay(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !shape || !bytes
            || !instructions || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 side_sources = 0u;
    if (!operand_entry_gpr_sources(
            &block->plan, shape->side,
            block->plan.node_count + 1u, remaining, &side_sources)
            || (side_sources & (1u << destination)))
        return 0;
    pl_u32 fixup_checkpoint = selection->fixup_count;
    pl_u32 base_bytes = 0u, base_work = 0u;
    int status = measure_alu_seed(
        frontend, block, selection, destination, shape->base,
        shape->bits, output_at, remaining - 1u,
        &base_bytes, &base_work);
    pl_u32 overlay_bytes = 0u, overlay_work = 0u;
    if (status <= 0
            || !emit_entry_bit_overlay(
                destination, shape, (pl_u8 *)0,
                &overlay_bytes, &overlay_work)
            || base_bytes > U32_MAX_VALUE - overlay_bytes) {
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }
    pl_u32 prefix = base_bytes + overlay_bytes;
    if (prefix > U32_MAX_VALUE - output_at) {
        selection->fixup_count = fixup_checkpoint;
        return 0;
    }
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (!(scratch_mask & scratch_bit) || scratch == destination)
            continue;
        selection->fixup_count = fixup_checkpoint;
        pl_u32 side_bytes = 0u, side_work = 0u;
        status = measure_alu_tree(
            frontend, block, selection, scratch, shape->side,
            shape->bits, output_at + prefix, remaining - 1u,
            scratch_mask & ~scratch_bit, &side_bytes, &side_work);
        pl_operand side = { PL_OPERAND_LOCAL, scratch };
        pl_u32 join_bytes = 0u;
        if (status > 0
                && emit_alu_instruction(
                    destination, side, shape->bits, 5u, 0u,
                    (pl_u8 *)0, &join_bytes)
                && prefix <= U32_MAX_VALUE - side_bytes
                && prefix + side_bytes <= U32_MAX_VALUE - join_bytes
                && base_work <= U32_MAX_VALUE - overlay_work
                && base_work + overlay_work <= U32_MAX_VALUE - side_work
                && base_work + overlay_work + side_work != U32_MAX_VALUE) {
            *bytes = prefix + side_bytes + join_bytes;
            *instructions = base_work + overlay_work + side_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        if (status < 0) return status;
    }
    selection->fixup_count = fixup_checkpoint;
    return 0;
}

/* Pending destinations are the only reversible scratch coordinates: their
 * final values have not been published yet.  Entry values needed by another
 * root remain pinned.  Entry values used only by the selected root stay in
 * the pool: its recursive scheduler may borrow them immediately after their
 * last child use instead of extending every entry lifetime to the block cut. */
static pl_u32 alu_frame_scratch_mask(
    pl_u32 pending, pl_u32 destination,
    const pl_u32 sources[PL_X86_GPR_COUNT])
{
    pl_u32 live_entries = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (local != destination && (pending & (1u << local)))
            live_entries |= sources[local];
    return pending & ~(1u << destination) & ~live_entries;
}

typedef struct {
    pl_u32 flag_destination;
    pl_u32 sibling_destination;
    pl_u32 scratch;
    pl_u32 source;
    pl_u32 bits;
    pl_u32 flag_group;
    pl_u32 sibling_group;
    pl_operand flag_amount;
    pl_operand sibling_amount;
    pl_operand flag_value;
    pl_operand sibling_value;
} shift_sibling_handoff;

static int shift_sibling_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    shift_sibling_handoff *out)
{
    if (!plan || !pending || !final_flag_node || !sources
            || !out)
        return 0;
    pl_u32 live_entries = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (pending & (1u << local))
            live_entries |= sources[local];
    for (pl_u32 flag_destination = 0u;
            flag_destination < PL_X86_GPR_COUNT; ++flag_destination) {
        if (!(pending & (1u << flag_destination))) continue;
        pl_operand flag_value = plan->locals[flag_destination];
        if (!publication_is_flag_result(
                plan, flag_value, final_flag_node))
            continue;
        pl_operand flag_source, flag_amount;
        pl_u32 flag_bits = 0u, flag_group = 0u;
        if (!shift_node_details(
                plan, flag_value, &flag_source, &flag_amount,
                &flag_bits, &flag_group)
                || flag_source.kind != PL_OPERAND_LOCAL
                || flag_source.value >= PL_X86_GPR_COUNT
                || flag_amount.kind != PL_OPERAND_CONST
                || !(flag_amount.value
                    & (flag_bits == 64u ? 63u : 31u)))
            continue;
        for (pl_u32 sibling = 0u; sibling < PL_X86_GPR_COUNT; ++sibling) {
            if (sibling == flag_destination
                    || !(pending & (1u << sibling)))
                continue;
            pl_operand sibling_value = plan->locals[sibling];
            pl_operand sibling_source, sibling_amount;
            pl_u32 sibling_bits = 0u, sibling_group = 0u;
            if (!shift_node_details(
                    plan, sibling_value, &sibling_source, &sibling_amount,
                    &sibling_bits, &sibling_group)
                    || sibling_bits != flag_bits
                    || sibling_source.kind != flag_source.kind
                    || sibling_source.value != flag_source.value)
                continue;
            if (sibling == flag_source.value
                    && flag_destination != flag_source.value) {
                pl_u32 pair = (1u << flag_destination)
                            | (1u << sibling);
                if (pending & ~pair) continue;
                out->flag_destination = flag_destination;
                out->sibling_destination = sibling;
                out->scratch = PL_X86_GPR_COUNT;
                out->source = (pl_u32)flag_source.value;
                out->bits = flag_bits;
                out->flag_group = flag_group;
                out->sibling_group = sibling_group;
                out->flag_amount = flag_amount;
                out->sibling_amount = sibling_amount;
                out->flag_value = flag_value;
                out->sibling_value = sibling_value;
                return 1;
            }
            for (pl_u32 scratch = 0u;
                    scratch < PL_X86_GPR_COUNT; ++scratch) {
                if (scratch == flag_destination || scratch == sibling
                        || !(pending & (1u << scratch))
                        || (live_entries & (1u << scratch)))
                    continue;
                pl_operand publication = plan->locals[scratch];
                if ((publication.kind != PL_OPERAND_CONST
                        && (publication.kind != PL_OPERAND_LOCAL
                            || publication.value >= PL_X86_GPR_COUNT))
                        || frame_local_publication_clobbers_flags(
                            plan, scratch))
                    continue;
                pl_u32 group = (1u << flag_destination)
                             | (1u << sibling) | (1u << scratch);
                if (pending & ~group) continue;
                out->flag_destination = flag_destination;
                out->sibling_destination = sibling;
                out->scratch = scratch;
                out->source = (pl_u32)flag_source.value;
                out->bits = flag_bits;
                out->flag_group = flag_group;
                out->sibling_group = sibling_group;
                out->flag_amount = flag_amount;
                out->sibling_amount = sibling_amount;
                out->flag_value = flag_value;
                out->sibling_value = sibling_value;
                return 1;
            }
        }
    }
    return 0;
}

typedef struct {
    pl_u32 parent_destination;
    pl_u32 wide_destination;
    pl_u32 narrow_destination;
    pl_u32 mode;
    pl_operand parent;
    pl_operand right;
} arithmetic_width_handoff;

/* A 32-bit word operation is the low-word quotient of the same 64-bit
 * AND/ADD/SUB/OR/XOR operation.  When both results and their shared parent
 * survive, keep the parent in the wide destination, publish it once, update
 * that accumulator to the wide child, and obtain the narrow child with one
 * 32-bit move.  No second expression tree is materialized. */
static int arithmetic_width_handoff_shape(
    const pl_plan *plan, pl_u32 pending,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    const pl_u32 dependencies[PL_X86_GPR_COUNT],
    arithmetic_width_handoff *out)
{
    if (!plan || !pending || !sources || !dependencies || !out)
        return 0;
    for (pl_u32 parent_destination = 0u;
            parent_destination < PL_X86_GPR_COUNT;
            ++parent_destination) {
        pl_u32 parent_bit = 1u << parent_destination;
        if (!(pending & parent_bit)) continue;
        pl_operand parent = plan->locals[parent_destination];
        if (publication_owner(plan, parent) != parent_destination)
            continue;
        for (pl_u32 wide = 0u; wide < PL_X86_GPR_COUNT; ++wide) {
            pl_u32 wide_bit = 1u << wide;
            if (wide == parent_destination || !(pending & wide_bit))
                continue;
            pl_operand wide_left, wide_right;
            pl_u32 wide_bits = 0u, wide_mode = 0u;
            if (!arithmetic_tree_details(
                    plan, plan->locals[wide], &wide_left, &wide_right,
                    &wide_bits, &wide_mode)
                    || wide_bits != 64u
                    || (wide_mode != 0u && wide_mode != 1u
                        && wide_mode != 3u && wide_mode != 5u
                        && wide_mode != 6u)
                    || wide_left.kind != parent.kind
                    || wide_left.value != parent.value)
                continue;
            pl_u32 parent_sources = 0u;
            if (!operand_entry_gpr_sources(
                    plan, parent, plan->node_count + 1u,
                    plan->node_count + 1u, &parent_sources)
                    || !(parent_sources & wide_bit))
                continue;
            pl_operand physical_right = wide_right;
            physicalize_published_operand(plan, wide, &physical_right);
            if (physical_right.kind != PL_OPERAND_CONST
                    && (physical_right.kind != PL_OPERAND_LOCAL
                        || physical_right.value >= PL_X86_GPR_COUNT))
                continue;
            if (physical_right.kind == PL_OPERAND_LOCAL
                    && (physical_right.value == parent_destination
                        || physical_right.value == wide))
                continue;
            for (pl_u32 narrow = 0u;
                    narrow < PL_X86_GPR_COUNT; ++narrow) {
                pl_u32 narrow_bit = 1u << narrow;
                if (narrow == parent_destination || narrow == wide
                        || !(pending & narrow_bit))
                    continue;
                pl_operand narrow_left, narrow_right;
                pl_u32 narrow_bits = 0u, narrow_mode = 0u;
                if (!arithmetic_tree_details(
                        plan, plan->locals[narrow],
                        &narrow_left, &narrow_right,
                        &narrow_bits, &narrow_mode)
                        || narrow_bits != 32u
                        || narrow_mode != wide_mode
                        || narrow_left.kind != wide_left.kind
                        || narrow_left.value != wide_left.value
                        || narrow_right.kind != wide_right.kind
                        || narrow_right.value != wide_right.value)
                    continue;
                pl_u32 group = parent_bit | wide_bit | narrow_bit;
                if (dependencies[parent_destination] & pending)
                    continue;
                if ((dependencies[wide] & pending & ~group)
                        || (dependencies[narrow] & pending & ~group))
                    continue;
                int clobbers_live_entry = 0;
                for (pl_u32 other = 0u;
                        other < PL_X86_GPR_COUNT; ++other) {
                    pl_u32 other_bit = 1u << other;
                    if (!(pending & other_bit) || (group & other_bit))
                        continue;
                    if (sources[other] & group) {
                        clobbers_live_entry = 1;
                        break;
                    }
                }
                if (clobbers_live_entry) continue;
                out->parent_destination = parent_destination;
                out->wide_destination = wide;
                out->narrow_destination = narrow;
                out->mode = wide_mode;
                out->parent = parent;
                out->right = physical_right;
                return 1;
            }
        }
    }
    return 0;
}

typedef struct {
    pl_u32 root;
    pl_u32 parent_owner;
    pl_u32 side_owner;
    pl_u32 bits;
    pl_u32 side_mode;
    pl_u32 shift_group;
    pl_u32 root_mode;
    pl_operand parent;
    pl_operand shift_amount;
} shared_diamond_handoff;

static int equal_operand(pl_operand left, pl_operand right)
{
    return left.kind == right.kind && left.value == right.value;
}

typedef struct {
    pl_u32 destination;
    pl_u32 seed_owner;
    pl_u32 parent_owner;
    pl_u32 side_owner;
    pl_u32 seed_bits;
    pl_u32 seed_shift_group;
    pl_u32 parent_shift_group;
    pl_u32 side_inner_shift_group;
    pl_u32 side_outer_shift_group;
    pl_u32 zero_mask;
    pl_u32 flag_owner;
    pl_operand seed_shift_amount;
    pl_operand parent_shift_amount;
    pl_operand side_inner_shift_amount;
    pl_operand side_outer_shift_amount;
} arx_shared_dag_frame;

static int nonzero_word_shift(pl_operand amount)
{
    return amount.kind == PL_OPERAND_CONST
        && (amount.value & 63u) != 0u;
}

/* Normalize the common four-leaf ARX DAG without retaining an expression
 * tree or rebuilding either shared value.  In algebraic form the root is
 *
 *   rot(P, a) ^ rot(T, b) ^ P
 *       ^ rot(B ^ rot(S, c), d)
 *   where P = B + T and T = D ^ A.
 *
 * T and P each have two futures.  Their entry-backed coordinates are the
 * complete residual state: materialize each once, rotate the T coordinate
 * only after P has consumed it, and reassociate the four XOR leaves.  This
 * is an instruction-topology production, not a kernel-symbol special case. */
static int arx_shared_dag_frame_details(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    arx_shared_dag_frame *out)
{
    if (!plan || !changed || !final_flag_node || !out) return 0;
    const pl_u32 gpr_mask = (1u << PL_X86_GPR_COUNT) - 1u;
    pl_u32 destination = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        if (zero_result_operand(plan, plan->locals[local])) continue;
        if (destination != PL_X86_GPR_COUNT) return 0;
        destination = local;
    }
    if (destination >= PL_X86_GPR_COUNT) return 0;

    pl_operand root = plan->locals[destination];
    pl_operand root_left, root_right;
    pl_u32 root_bits = 0u, root_mode = 0u;
    if (!arithmetic_tree_details(
            plan, root, &root_left, &root_right,
            &root_bits, &root_mode)
            || root_bits != 64u || root_mode != 6u
            || publication_owner(plan, root) != destination)
        return 0;

    pl_u32 capacity = plan->node_count + 1u;
    pl_operand leaves[capacity];
    pl_u32 leaf_count = 0u;
    if (!collect_associative_leaves(
            plan, root, 64u, 6u, leaves, capacity, &leaf_count,
            plan->node_count + 1u)
            || leaf_count != 4u)
        return 0;

    for (pl_u32 parent_at = 0u; parent_at < leaf_count; ++parent_at) {
        pl_operand parent = leaves[parent_at];
        pl_operand parent_left, parent_right;
        pl_u32 parent_bits = 0u, parent_mode = 0u;
        if (!arithmetic_tree_details(
                plan, parent, &parent_left, &parent_right,
                &parent_bits, &parent_mode)
                || parent_bits != 64u || parent_mode != 1u)
            continue;
        for (pl_u32 parent_orientation = 0u;
                parent_orientation < 2u; ++parent_orientation) {
            pl_operand parent_entry = parent_orientation
                ? parent_right : parent_left;
            pl_operand seed = parent_orientation
                ? parent_left : parent_right;
            if (parent_entry.kind != PL_OPERAND_LOCAL
                    || parent_entry.value >= PL_X86_GPR_COUNT)
                continue;
            pl_u32 parent_owner = (pl_u32)parent_entry.value;

            pl_operand seed_left, seed_right;
            pl_u32 seed_bits = 0u, seed_mode = 0u;
            if (!arithmetic_tree_details(
                    plan, seed, &seed_left, &seed_right,
                    &seed_bits, &seed_mode)
                    || (seed_bits != 32u && seed_bits != 64u)
                    || seed_mode != 6u)
                continue;
            pl_u32 seed_owner = PL_X86_GPR_COUNT;
            if (seed_left.kind == PL_OPERAND_LOCAL
                    && seed_right.kind == PL_OPERAND_LOCAL) {
                if (seed_left.value == destination
                        && seed_right.value < PL_X86_GPR_COUNT)
                    seed_owner = (pl_u32)seed_right.value;
                else if (seed_right.value == destination
                        && seed_left.value < PL_X86_GPR_COUNT)
                    seed_owner = (pl_u32)seed_left.value;
            }
            if (seed_owner >= PL_X86_GPR_COUNT
                    || seed_owner == parent_owner)
                continue;

            for (pl_u32 parent_shift_at = 0u;
                    parent_shift_at < leaf_count; ++parent_shift_at) {
                if (parent_shift_at == parent_at) continue;
                pl_operand parent_shift_source, parent_shift_amount;
                pl_u32 parent_shift_bits = 0u;
                pl_u32 parent_shift_group = 0u;
                if (!shift_node_details(
                        plan, leaves[parent_shift_at],
                        &parent_shift_source, &parent_shift_amount,
                        &parent_shift_bits, &parent_shift_group)
                        || parent_shift_bits != 64u
                        || !equal_operand(parent_shift_source, parent)
                        || !nonzero_word_shift(parent_shift_amount))
                    continue;

                for (pl_u32 seed_shift_at = 0u;
                        seed_shift_at < leaf_count; ++seed_shift_at) {
                    if (seed_shift_at == parent_at
                            || seed_shift_at == parent_shift_at)
                        continue;
                    pl_operand seed_shift_source, seed_shift_amount;
                    pl_u32 seed_shift_bits = 0u;
                    pl_u32 seed_shift_group = 0u;
                    if (!shift_node_details(
                            plan, leaves[seed_shift_at],
                            &seed_shift_source, &seed_shift_amount,
                            &seed_shift_bits, &seed_shift_group)
                            || seed_shift_bits != 64u
                            || !equal_operand(seed_shift_source, seed)
                            || !nonzero_word_shift(seed_shift_amount))
                        continue;

                    pl_u32 side_at = 0u;
                    while (side_at == parent_at
                            || side_at == parent_shift_at
                            || side_at == seed_shift_at)
                        ++side_at;
                    if (side_at >= leaf_count) continue;
                    pl_operand side_inner, side_outer_amount;
                    pl_u32 side_outer_bits = 0u;
                    pl_u32 side_outer_group = 0u;
                    if (!shift_node_details(
                            plan, leaves[side_at], &side_inner,
                            &side_outer_amount, &side_outer_bits,
                            &side_outer_group)
                            || side_outer_bits != 64u
                            || !nonzero_word_shift(side_outer_amount))
                        continue;
                    pl_operand side_left, side_right;
                    pl_u32 side_bits = 0u, side_mode = 0u;
                    if (!arithmetic_tree_details(
                            plan, side_inner, &side_left, &side_right,
                            &side_bits, &side_mode)
                            || side_bits != 64u || side_mode != 6u)
                        continue;
                    pl_operand side_shift = side_left;
                    if (side_right.kind == PL_OPERAND_LOCAL
                            && side_right.value == parent_owner)
                        side_shift = side_left;
                    else if (side_left.kind == PL_OPERAND_LOCAL
                            && side_left.value == parent_owner)
                        side_shift = side_right;
                    else
                        continue;
                    pl_operand side_source, side_inner_amount;
                    pl_u32 side_inner_bits = 0u;
                    pl_u32 side_inner_group = 0u;
                    if (!shift_node_details(
                            plan, side_shift, &side_source,
                            &side_inner_amount, &side_inner_bits,
                            &side_inner_group)
                            || side_inner_bits != 64u
                            || side_source.kind != PL_OPERAND_LOCAL
                            || side_source.value >= PL_X86_GPR_COUNT
                            || !nonzero_word_shift(side_inner_amount))
                        continue;
                    pl_u32 side_owner = (pl_u32)side_source.value;
                    if (side_owner == destination
                            || side_owner == seed_owner
                            || side_owner == parent_owner)
                        continue;

                    pl_u32 zero_mask = changed & gpr_mask
                                     & ~(1u << destination);
                    int exact_zero_tail = 1;
                    pl_u32 flag_owner = PL_X86_GPR_COUNT;
                    for (pl_u32 local = 0u;
                            local < PL_X86_GPR_COUNT; ++local) {
                        if (!(zero_mask & (1u << local))) continue;
                        if (!zero_result_operand(plan, plan->locals[local])) {
                            exact_zero_tail = 0;
                            break;
                        }
                        if (publication_is_flag_result(
                                plan, plan->locals[local],
                                final_flag_node))
                            flag_owner = local;
                    }
                    if (!exact_zero_tail
                            || flag_owner >= PL_X86_GPR_COUNT
                            || !(zero_mask & (1u << seed_owner))
                            || !(zero_mask & (1u << parent_owner))
                            || !(zero_mask & (1u << side_owner)))
                        continue;

                    *out = (arx_shared_dag_frame){
                        destination, seed_owner, parent_owner, side_owner,
                        seed_bits,
                        seed_shift_group, parent_shift_group,
                        side_inner_group, side_outer_group,
                        zero_mask, flag_owner,
                        seed_shift_amount, parent_shift_amount,
                        side_inner_amount, side_outer_amount,
                    };
                    return 1;
                }
            }
        }
    }
    return 0;
}

static int emit_arx_shared_dag_frame(
    const arx_shared_dag_frame *shape,
    pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, part = 0u;
    pl_operand parent = { PL_OPERAND_LOCAL, shape->parent_owner };
    pl_operand seed = { PL_OPERAND_LOCAL, shape->seed_owner };
    pl_operand side = { PL_OPERAND_LOCAL, shape->side_owner };
    pl_operand destination = { PL_OPERAND_LOCAL, shape->destination };

#define APPEND_ARX(operation) do { \
        part = 0u; \
        if (!(operation) || at > U32_MAX_VALUE - part) return 0; \
        at += part; \
    } while (0)
    APPEND_ARX(emit_shift_instruction(
        shape->side_owner, shape->side_inner_shift_amount, 64u,
        shape->side_inner_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(emit_alu_instruction(
        shape->side_owner, parent, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(emit_shift_instruction(
        shape->side_owner, shape->side_outer_shift_amount, 64u,
        shape->side_outer_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(emit_alu_instruction(
        shape->seed_owner, destination, shape->seed_bits, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(emit_alu_instruction(
        shape->parent_owner, seed, 64u, 1u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(emit_gpr_move(
        shape->destination, shape->parent_owner, 64u,
        output ? output + at : 0, &part));
    APPEND_ARX(emit_shift_instruction(
        shape->destination, shape->parent_shift_amount, 64u,
        shape->parent_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(emit_shift_instruction(
        shape->seed_owner, shape->seed_shift_amount, 64u,
        shape->seed_shift_group, output ? output + at : 0, &part));
    APPEND_ARX(emit_alu_instruction(
        shape->seed_owner, parent, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(emit_alu_instruction(
        shape->side_owner, seed, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    APPEND_ARX(emit_alu_instruction(
        shape->destination, side, 64u, 6u, 0u,
        output ? output + at : 0, &part));
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape->zero_mask & (1u << local))
                || local == shape->flag_owner)
            continue;
        APPEND_ARX(emit_zero_register(
            local, output ? output + at : 0, &part));
    }
    APPEND_ARX(emit_zero_register(
        shape->flag_owner, output ? output + at : 0, &part));
#undef APPEND_ARX
    *written = at;
    return 1;
}

static int measure_direct_arx_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    (void)frontend;
    if (!block || !selection || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    arx_shared_dag_frame shape;
    if (!alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !arx_shared_dag_frame_details(
                &block->plan, changed, final_flag_node, &shape)
            || !emit_arx_shared_dag_frame(
                &shape, (pl_u8 *)0, &selection->output_bytes))
        return 0;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_arx_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int write_direct_arx_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !output) return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, final_flag_node = 0u, written = 0u;
    arx_shared_dag_frame shape;
    if (!alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !arx_shared_dag_frame_details(
                &block->plan, changed, final_flag_node, &shape)
            || !emit_arx_shared_dag_frame(&shape, output, &written)
            || written != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}

typedef struct {
    pl_u32 destination;
    pl_u32 mutable_owner;
    pl_u32 independent_owner;
    pl_u32 mutable_shift_group;
    pl_u32 zero_mask;
    pl_u32 flag_owner;
    pl_u32 accumulator_bits;
    pl_u32 independent_bits;
    pl_operand accumulator;
    pl_operand independent;
    pl_operand mutable_shift_amount;
} mutable_xor_frame;

/* If both S and shift(S) are leaves of one XOR future, S has two generations
 * but only one coordinate.  Consume entry S into the final accumulator,
 * overwrite S with its shifted generation, fold an independent leaf into S,
 * and join it once.  Register renaming removes the textual WAR edge; the
 * emitted RAW graph therefore reaches the associative lower span without a
 * copy or a residual-state row. */
static int mutable_xor_frame_details(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    mutable_xor_frame *out)
{
    if (!plan || !changed || !final_flag_node || !out) return 0;
    const pl_u32 gpr_mask = (1u << PL_X86_GPR_COUNT) - 1u;
    pl_u32 destination = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        if (zero_result_operand(plan, plan->locals[local])) continue;
        if (destination != PL_X86_GPR_COUNT) return 0;
        destination = local;
    }
    if (destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand root = plan->locals[destination];
    pl_operand root_left, root_right;
    pl_u32 root_bits = 0u, root_mode = 0u;
    if (!arithmetic_tree_details(
            plan, root, &root_left, &root_right,
            &root_bits, &root_mode)
            || root_bits != 64u || root_mode != 6u
            || publication_owner(plan, root) != destination)
        return 0;
    pl_u32 capacity = plan->node_count + 1u;
    pl_operand leaves[capacity];
    pl_u32 leaf_count = 0u;
    if (!collect_associative_leaves(
            plan, root, 64u, 6u, leaves, capacity, &leaf_count,
            plan->node_count + 1u)
            || leaf_count != 4u)
        return 0;

    for (pl_u32 mutable_at = 0u; mutable_at < leaf_count; ++mutable_at) {
        if (leaves[mutable_at].kind != PL_OPERAND_LOCAL
                || leaves[mutable_at].value >= PL_X86_GPR_COUNT)
            continue;
        pl_u32 mutable_owner = (pl_u32)leaves[mutable_at].value;
        if (mutable_owner == destination) continue;
        for (pl_u32 shift_at = 0u; shift_at < leaf_count; ++shift_at) {
            if (shift_at == mutable_at) continue;
            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            if (!shift_node_details(
                    plan, leaves[shift_at], &shift_source, &shift_amount,
                    &shift_bits, &shift_group)
                    || shift_bits != 64u
                    || shift_source.kind != PL_OPERAND_LOCAL
                    || shift_source.value != mutable_owner
                    || !nonzero_word_shift(shift_amount))
                continue;
            pl_u32 remaining[2u];
            pl_u32 count = 0u;
            for (pl_u32 at = 0u; at < leaf_count; ++at)
                if (at != mutable_at && at != shift_at)
                    remaining[count++] = at;
            if (count != 2u) continue;
            for (pl_u32 orientation = 0u; orientation < 2u;
                    ++orientation) {
                pl_operand accumulator = leaves[remaining[orientation]];
                pl_operand independent = leaves[remaining[orientation ^ 1u]];
                pl_u32 accumulator_sources = 0u;
                pl_u32 independent_sources = 0u;
                if (!operand_entry_gpr_sources(
                        plan, accumulator, plan->node_count + 1u,
                        plan->node_count + 1u, &accumulator_sources)
                        || !operand_entry_gpr_sources(
                            plan, independent, plan->node_count + 1u,
                            plan->node_count + 1u,
                            &independent_sources))
                    continue;
                pl_u32 destination_bit = 1u << destination;
                pl_u32 mutable_bit = 1u << mutable_owner;
                if (!(accumulator_sources & destination_bit)
                        || (accumulator_sources & mutable_bit)
                        || (independent_sources
                            & (destination_bit | mutable_bit)))
                    continue;
                pl_u32 zero_mask = changed & gpr_mask & ~destination_bit;
                pl_u32 flag_owner = PL_X86_GPR_COUNT;
                int exact_zero_tail = 1;
                for (pl_u32 local = 0u;
                        local < PL_X86_GPR_COUNT; ++local) {
                    if (!(zero_mask & (1u << local))) continue;
                    if (!zero_result_operand(plan, plan->locals[local])) {
                        exact_zero_tail = 0;
                        break;
                    }
                    if (publication_is_flag_result(
                            plan, plan->locals[local], final_flag_node))
                        flag_owner = local;
                }
                if (!exact_zero_tail
                        || flag_owner >= PL_X86_GPR_COUNT
                        || !(zero_mask & mutable_bit))
                    continue;
                for (pl_u32 owner = 0u;
                        owner < PL_X86_GPR_COUNT; ++owner) {
                    pl_u32 owner_bit = 1u << owner;
                    if (!(independent_sources & owner_bit)
                            || !(zero_mask & owner_bit)
                            || (accumulator_sources & owner_bit))
                        continue;
                    *out = (mutable_xor_frame){
                        destination, mutable_owner, owner, shift_group,
                        zero_mask, flag_owner,
                        operand_expression_bits(plan, accumulator, 64u),
                        operand_expression_bits(plan, independent, 64u),
                        accumulator, independent, shift_amount,
                    };
                    return 1;
                }
            }
        }
    }
    return 0;
}

static int measure_direct_mutable_xor_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    mutable_xor_frame shape;
    if (!alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !mutable_xor_frame_details(
                &block->plan, changed, final_flag_node, &shape))
        return 0;
    pl_u32 bytes = 0u, work = 0u, part = 0u, part_work = 0u;
    int status = measure_alu_tree(
        frontend, block, selection, shape.independent_owner,
        shape.independent, shape.independent_bits, bytes,
        block->plan.node_count + 1u, 0u, &part, &part_work);
    if (status <= 0) return status;
    bytes += part;
    work += part_work;
    status = measure_alu_tree(
        frontend, block, selection, shape.destination,
        shape.accumulator, shape.accumulator_bits, bytes,
        block->plan.node_count + 1u, 0u, &part, &part_work);
    if (status <= 0 || bytes > U32_MAX_VALUE - part
            || work > U32_MAX_VALUE - part_work)
        return status < 0 ? status : 0;
    bytes += part;
    work += part_work;
    pl_operand mutable_value = {
        PL_OPERAND_LOCAL, shape.mutable_owner,
    };
    pl_operand independent_value = {
        PL_OPERAND_LOCAL, shape.independent_owner,
    };
#define MEASURE_MUTABLE(operation) do { \
        part = 0u; \
        if (!(operation) || bytes > U32_MAX_VALUE - part) return 0; \
        bytes += part; \
        if (work == U32_MAX_VALUE) return 0; \
        ++work; \
    } while (0)
    MEASURE_MUTABLE(emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        (pl_u8 *)0, &part));
    MEASURE_MUTABLE(emit_shift_instruction(
        shape.mutable_owner, shape.mutable_shift_amount, 64u,
        shape.mutable_shift_group, (pl_u8 *)0, &part));
    MEASURE_MUTABLE(emit_alu_instruction(
        shape.mutable_owner, independent_value, 64u, 6u, 0u,
        (pl_u8 *)0, &part));
    MEASURE_MUTABLE(emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        (pl_u8 *)0, &part));
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.zero_mask & (1u << local))
                || local == shape.flag_owner)
            continue;
        MEASURE_MUTABLE(emit_zero_register(
            local, (pl_u8 *)0, &part));
    }
    MEASURE_MUTABLE(emit_zero_register(
        shape.flag_owner, (pl_u8 *)0, &part));
#undef MEASURE_MUTABLE
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_mutable_xor_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* Materialize a shared internal SSA node exactly once.  One child updates a
 * dying entry coordinate with a binary operation while the other updates the
 * parent's dying coordinate with a shift; the two children then join in the
 * binary root.  The scratch coordinates must have source-free final values,
 * so the root may be published before their ordinary frame assignments. */
static int shared_diamond_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    const pl_u32 dependencies[PL_X86_GPR_COUNT],
    pl_u32 protected_entries, shared_diamond_handoff *out)
{
    if (!plan || !pending || !sources || !dependencies || !out)
        return 0;
    for (pl_u32 root = 0u; root < PL_X86_GPR_COUNT; ++root) {
        pl_u32 root_bit = 1u << root;
        if (!(pending & root_bit)) continue;
        pl_operand root_value = plan->locals[root];
        if (publication_owner(plan, root_value) != root
                || publication_is_flag_result(
                    plan, root_value, final_flag_node))
            continue;
        pl_operand root_left, root_right;
        pl_u32 bits = 0u, root_mode = 0u;
        if (!arithmetic_tree_details(
                plan, root_value, &root_left, &root_right,
                &bits, &root_mode))
            continue;
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            if (orientation && root_mode == 3u) continue;
            pl_operand side = orientation ? root_right : root_left;
            pl_operand shifted = orientation ? root_left : root_right;
            pl_operand parent, amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            if (!shift_node_details(
                    plan, shifted, &parent, &amount,
                    &shift_bits, &shift_group)
                    || shift_bits != bits
                    || (parent.kind != PL_OPERAND_NODE
                        && parent.kind != PL_OPERAND_PROJECTION))
                continue;
            pl_operand side_left, side_right;
            pl_u32 side_bits = 0u, side_mode = 0u;
            if (!arithmetic_tree_details(
                    plan, side, &side_left, &side_right,
                    &side_bits, &side_mode)
                    || side_bits != bits)
                continue;
            pl_operand side_entry;
            if (equal_operand(side_right, parent)
                    && side_left.kind == PL_OPERAND_LOCAL) {
                side_entry = side_left;
            } else if (side_mode != 3u
                    && equal_operand(side_left, parent)
                    && side_right.kind == PL_OPERAND_LOCAL) {
                side_entry = side_right;
            } else {
                continue;
            }
            if (side_entry.value >= PL_X86_GPR_COUNT) continue;
            pl_u32 side_owner = (pl_u32)side_entry.value;
            pl_u32 side_bit = 1u << side_owner;
            if (side_owner == root || !(pending & side_bit)
                    || sources[side_owner])
                continue;
            pl_u32 parent_sources = 0u;
            if (!operand_entry_gpr_sources(
                    plan, parent, plan->node_count + 1u,
                    plan->node_count + 1u, &parent_sources))
                continue;
            for (pl_u32 parent_owner = 0u;
                    parent_owner < PL_X86_GPR_COUNT; ++parent_owner) {
                pl_u32 parent_bit = 1u << parent_owner;
                if (parent_owner == root || parent_owner == side_owner
                        || !(pending & parent_bit)
                        || !(parent_sources & parent_bit)
                        || sources[parent_owner]
                        || (protected_entries & (parent_bit | side_bit)))
                    continue;
                pl_u32 scratch = parent_bit | side_bit;
                int old_value_escapes = 0;
                for (pl_u32 other = 0u;
                        other < PL_X86_GPR_COUNT; ++other) {
                    pl_u32 other_bit = 1u << other;
                    if (!(pending & other_bit)
                            || other == root || other == parent_owner
                            || other == side_owner)
                        continue;
                    if (sources[other] & scratch) {
                        old_value_escapes = 1;
                        break;
                    }
                }
                if (old_value_escapes) continue;
                out->root = root;
                out->parent_owner = parent_owner;
                out->side_owner = side_owner;
                out->bits = bits;
                out->side_mode = side_mode;
                out->shift_group = shift_group;
                out->root_mode = root_mode;
                out->parent = parent;
                out->shift_amount = amount;
                return 1;
            }
        }
    }
    return 0;
}

static int measure_alu_pair(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand left,
                            pl_operand right, pl_u32 bits, pl_u32 mode,
                            pl_u32 preserves_carry, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 scratch_mask,
                            pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !bytes || !instructions
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 fixup_checkpoint = selection->fixup_count;
    /* XOR(x,x) and SUB(x,x) have a constant result and fixed architectural
     * flags.  The input coordinate is therefore outside their complete
     * future.  Select the exact self operation at the destination before
     * publication-owner substitution can manufacture a copy dependency. */
    if (!preserves_carry && (mode == 3u || mode == 6u)
            && left.kind == right.kind && left.value == right.value) {
        pl_u32 operation = 0u;
        pl_operand self = { PL_OPERAND_LOCAL, destination };
        if (!emit_alu_instruction(
                destination, self, bits, mode, 0u,
                (pl_u8 *)0, &operation))
            return 0;
        *bytes = operation;
        *instructions = 1u;
        return 1;
    }
    if (!preserves_carry && mode == 3u
            && left.kind == PL_OPERAND_CONST && !left.value) {
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        int status = measure_alu_tree(frontend, block, selection, destination,
            right, bits, output_at, remaining - 1u, scratch_mask, &prefix, &work);
        if (status > 0 && emit_neg_register(destination, bits, 0, &operation)
                && prefix <= U32_MAX_VALUE - operation && work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }
    pl_u32 owner = PL_X86_GPR_COUNT;
    physicalize_published_operand(&block->plan, destination, &left);
    if (published_operand_local(&block->plan, right, &owner)
            && owner != destination) {
        right.kind = PL_OPERAND_LOCAL;
        right.value = owner;
    }
    /* A consumer's width truncates its inputs only after their expressions
     * have been evaluated.  In particular, truncating before a wide right
     * shift changes both the selected bits and the shift-count mask. */
    pl_u32 left_bits = alu_input_expression_bits(&block->plan, left, bits);
    pl_u32 right_bits = alu_input_expression_bits(&block->plan, right, bits);
    if (right.kind == PL_OPERAND_CONST
            || (right.kind == PL_OPERAND_LOCAL
                && right.value < PL_X86_GPR_COUNT)) {
        pl_u32 prefix = 0u, prefix_work = 0u, operation = 0u;
        int status = measure_alu_tree(
            frontend, block, selection, destination, left, left_bits,
            output_at, remaining - 1u, scratch_mask,
            &prefix, &prefix_work);
        if (status > 0
                && emit_alu_instruction(
                    destination, right, bits, mode, preserves_carry,
                    (pl_u8 *)0, &operation)
                && prefix <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = prefix_work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }

    pl_u32 left_sources = 0u;
    if (!operand_entry_gpr_sources(
            &block->plan, left, block->plan.node_count + 1u,
            remaining, &left_sources))
        return 0;
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (!(scratch_mask & scratch_bit) || (left_sources & scratch_bit))
            continue;
        selection->fixup_count = fixup_checkpoint;
        pl_u32 right_bytes = 0u, right_work = 0u;
        int status = measure_alu_tree(
            frontend, block, selection, scratch, right, right_bits, output_at,
            remaining - 1u, scratch_mask & ~scratch_bit,
            &right_bytes, &right_work);
        if (status <= 0) {
            selection->fixup_count = fixup_checkpoint;
            if (status < 0) return status;
            continue;
        }
        if (right_bytes > U32_MAX_VALUE - output_at) {
            selection->fixup_count = fixup_checkpoint;
            continue;
        }
        pl_u32 left_bytes = 0u, left_work = 0u;
        status = measure_alu_tree(
            frontend, block, selection, destination, left, left_bits,
            output_at + right_bytes, remaining - 1u,
            scratch_mask & ~scratch_bit, &left_bytes, &left_work);
        pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
        pl_u32 operation = 0u;
        if (status > 0
                && emit_alu_instruction(
                    destination, scratch_value, bits, mode,
                    preserves_carry, (pl_u8 *)0, &operation)
                && right_bytes <= U32_MAX_VALUE - left_bytes
                && right_bytes + left_bytes <= U32_MAX_VALUE - operation
                && right_work <= U32_MAX_VALUE - left_work
                && right_work + left_work != U32_MAX_VALUE) {
            *bytes = right_bytes + left_bytes + operation;
            *instructions = right_work + left_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }
    return 0;
}

typedef struct {
    pl_u32 inverse;
    pl_u32 low;
    pl_u32 modulus;
    pl_u32 high;
} mul_add_carry_frame;

static int same_value(pl_operand value, pl_u32 kind, pl_u64 payload)
{
    return value.kind == kind && value.value == payload;
}

typedef struct {
    pl_u32 condition_destination;
    pl_u32 condition;
    pl_u32 add_destination;
    pl_operand add_right;
    pl_operand carry_right;
    pl_u32 bits;
} condition_carry_frame;

/* SETcc performs both the Boolean observation and the low-byte insert.  The
 * SSA spelling keeps those notions separate, but native work must not charge
 * two operations for one architectural instruction.  This production also
 * records that the independent ADD may share SETcc's wave before ADC joins
 * their two results. */
static int condition_carry_frame_shape(const pl_x86_block *block,
                                       condition_carry_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->plan.node_count != 4u)
        return 0;
    const pl_plan *plan = &block->plan;
    const pl_node *condition = &plan->nodes[0];
    const pl_node *insert = &plan->nodes[1];
    const pl_node *add = &plan->nodes[2];
    const pl_node *carry = &plan->nodes[3];
    if (condition->opcode != PL_OPCODE_X86_CONDITION
            || condition->argument_count != 2u
            || insert->opcode != PL_OPCODE_LANE64_INSERT
            || insert->argument_count != 3u
            || add->opcode != PL_OPCODE_X86_ALU
            || add->argument_count != 4u
            || carry->opcode != PL_OPCODE_X86_ALU
            || carry->argument_count != 4u)
        return 0;
    const pl_operand *condition_argument =
        plan->arguments + condition->argument_at;
    const pl_operand *insert_argument = plan->arguments + insert->argument_at;
    const pl_operand *add_argument = plan->arguments + add->argument_at;
    const pl_operand *carry_argument = plan->arguments + carry->argument_at;
    if (!same_value(condition_argument[0], PL_OPERAND_LOCAL,
                    PL_X86_RFLAGS_LOCAL)
            || condition_argument[1].kind != PL_OPERAND_CONST
            || condition_argument[1].value > 15u
            || insert_argument[0].kind != PL_OPERAND_LOCAL
            || insert_argument[0].value >= PL_X86_GPR_COUNT
            || !same_value(insert_argument[1], PL_OPERAND_NODE, 1u)
            || !same_value(insert_argument[2], PL_OPERAND_CONST, 8u)
            || !same_value(add_argument[0], PL_OPERAND_LOCAL,
                           PL_X86_RFLAGS_LOCAL)
            || add_argument[1].kind != PL_OPERAND_LOCAL
            || add_argument[1].value >= PL_X86_GPR_COUNT
            || (add_argument[2].kind != PL_OPERAND_LOCAL
                && add_argument[2].kind != PL_OPERAND_CONST)
            || (add_argument[2].kind == PL_OPERAND_LOCAL
                && add_argument[2].value >= PL_X86_GPR_COUNT)
            || add_argument[3].kind != PL_OPERAND_CONST
            || !same_value(carry_argument[0], PL_OPERAND_NODE, 3u)
            || !same_value(carry_argument[1], PL_OPERAND_NODE, 2u)
            || (carry_argument[2].kind != PL_OPERAND_LOCAL
                && carry_argument[2].kind != PL_OPERAND_CONST)
            || (carry_argument[2].kind == PL_OPERAND_LOCAL
                && carry_argument[2].value >= PL_X86_GPR_COUNT)
            || carry_argument[3].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 add_descriptor = add_argument[3].value;
    pl_u64 carry_descriptor = carry_argument[3].value;
    pl_u32 bits = (pl_u32)(add_descriptor & 0x7fu);
    if ((bits != 32u && bits != 64u)
            || add_descriptor != bits + (1u << 8u)
            || carry_descriptor != bits + (2u << 8u))
        return 0;
    pl_u32 condition_destination = (pl_u32)insert_argument[0].value;
    pl_u32 add_destination = (pl_u32)add_argument[1].value;
    if (condition_destination == add_destination
            || !same_value(
                plan->locals[condition_destination], PL_OPERAND_PROJECTION,
                (4u << 8u) | 16u)
            || !same_value(
                plan->locals[add_destination], PL_OPERAND_PROJECTION,
                (3u << 8u) | 16u)
            || !same_value(plan->locals[PL_X86_RFLAGS_LOCAL],
                           PL_OPERAND_NODE, 4u))
        return 0;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
        if (local == condition_destination || local == add_destination
                || local == PL_X86_RFLAGS_LOCAL)
            continue;
        if (!same_value(plan->locals[local], PL_OPERAND_LOCAL, local))
            return 0;
    }
    out->condition_destination = condition_destination;
    out->condition = (pl_u32)condition_argument[1].value;
    out->add_destination = add_destination;
    out->add_right = add_argument[2];
    out->carry_right = carry_argument[2];
    out->bits = bits;
    return 1;
}

static int emit_set_condition(pl_u32 destination, pl_u32 condition,
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

static int emit_condition_carry_frame(const condition_carry_frame *shape,
                                      pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, encoded = 0u;
#define APPEND_CONDITION_CARRY(call) do {                                  \
        if (!(call) || at > U32_MAX_VALUE - encoded) return 0;             \
        at += encoded;                                                      \
    } while (0)
    APPEND_CONDITION_CARRY(emit_set_condition(
        shape->condition_destination, shape->condition,
        output ? output + at : 0, &encoded));
    APPEND_CONDITION_CARRY(emit_alu_instruction(
        shape->add_destination, shape->add_right, shape->bits, 1u, 0u,
        output ? output + at : 0, &encoded));
    APPEND_CONDITION_CARRY(emit_alu_instruction(
        shape->condition_destination, shape->carry_right,
        shape->bits, 2u, 0u, output ? output + at : 0, &encoded));
#undef APPEND_CONDITION_CARRY
    *written = at;
    return 1;
}

static int measure_direct_condition_carry_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    (void)frontend;
    condition_carry_frame shape;
    pl_u32 bytes = 0u;
    if (!selection || !condition_carry_frame_shape(block, &shape)
            || !emit_condition_carry_frame(&shape, 0, &bytes))
        return 0;
    selection->output_bytes = bytes;
    selection->output_instructions = 3u;
    selection->output_work = 3u;
    selection->output_span = 2u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_condition_carry_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* Normal form of high64((low * inverse) * modulus) followed by a three-term
 * sum with the Boolean carry-in (low != 0).  This topology is not tied to a
 * crypto function or source spelling; Montgomery cancellation is one common
 * producer of it.  Dead caller-saved coordinates permit NEG to carry the
 * Boolean directly into ADC, so no SETcc materialization survives. */
static int mul_add_carry_frame_shape(const pl_x86_block *block,
                                     mul_add_carry_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->plan.node_count != 9u
            || !(block->live_output_mask & 1u)
            || !(block->live_output_mask & (1u << 2u))
            || (block->live_output_mask & (1u << PL_X86_RFLAGS_LOCAL)))
        return 0;
    const pl_plan *plan = &block->plan;
    const pl_node *multiply = &plan->nodes[0];
    const pl_node *multiply_high = &plan->nodes[1];
    const pl_node *nonzero = &plan->nodes[2];
    const pl_node *first_sum = &plan->nodes[3];
    const pl_node *first_flags = &plan->nodes[4];
    const pl_node *first_carry = &plan->nodes[5];
    const pl_node *second_sum = &plan->nodes[6];
    const pl_node *second_carry = &plan->nodes[7];
    const pl_node *carry_sum = &plan->nodes[8];
    if (multiply->opcode != PL_OPCODE_MULR
            || multiply->argument_count != 2u
            || multiply_high->opcode != PL_OPCODE_MUL_HIGH
            || multiply_high->argument_count != 3u
            || nonzero->opcode != PL_OPCODE_X86_TEST_CONDITION
            || nonzero->argument_count != 3u
            || first_sum->opcode != PL_OPCODE_ALU_REGISTER[1][1]
            || first_sum->argument_count != 2u
            || first_flags->opcode != PL_OPCODE_X86_FLAGS
            || first_flags->argument_count != 5u
            || first_carry->opcode != PL_OPCODE_X86_CONDITION
            || first_carry->argument_count != 2u
            || second_sum->opcode != PL_OPCODE_X86_ALU
            || second_sum->argument_count != 4u
            || second_carry->opcode != PL_OPCODE_X86_CONDITION
            || second_carry->argument_count != 2u
            || carry_sum->opcode != PL_OPCODE_ALU_REGISTER[1][1]
            || carry_sum->argument_count != 2u)
        return 0;
    const pl_operand *mul = plan->arguments + multiply->argument_at;
    const pl_operand *wide = plan->arguments + multiply_high->argument_at;
    const pl_operand *test = plan->arguments + nonzero->argument_at;
    const pl_operand *sum1 = plan->arguments + first_sum->argument_at;
    const pl_operand *flags1 = plan->arguments + first_flags->argument_at;
    const pl_operand *carry1 = plan->arguments + first_carry->argument_at;
    const pl_operand *sum2 = plan->arguments + second_sum->argument_at;
    const pl_operand *carry2 = plan->arguments + second_carry->argument_at;
    const pl_operand *result_high = plan->arguments + carry_sum->argument_at;
    if (mul[0].kind != PL_OPERAND_LOCAL
            || mul[1].kind != PL_OPERAND_LOCAL
            || mul[0].value >= PL_X86_GPR_COUNT
            || mul[1].value >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 low = same_value(test[0], PL_OPERAND_LOCAL, mul[0].value)
              && same_value(test[1], PL_OPERAND_LOCAL, mul[0].value)
               ? (pl_u32)mul[0].value
               : same_value(test[0], PL_OPERAND_LOCAL, mul[1].value)
              && same_value(test[1], PL_OPERAND_LOCAL, mul[1].value)
               ? (pl_u32)mul[1].value : PL_X86_GPR_COUNT;
    if (low >= PL_X86_GPR_COUNT
            || !same_value(test[2], PL_OPERAND_CONST, 64u | (5u << 8u)))
        return 0;
    pl_u32 inverse = (pl_u32)(mul[0].value == low
                            ? mul[1].value : mul[0].value);
    if (!same_value(wide[0], PL_OPERAND_NODE, 1u)
            || wide[1].kind != PL_OPERAND_LOCAL
            || wide[1].value >= PL_X86_GPR_COUNT
            || !same_value(wide[2], PL_OPERAND_CONST, 64u))
        return 0;
    pl_u32 modulus = (pl_u32)wide[1].value;
    pl_u32 high_input = same_value(sum1[0], PL_OPERAND_NODE, 3u)
                     && sum1[1].kind == PL_OPERAND_LOCAL
                     && sum1[1].value < PL_X86_GPR_COUNT
                      ? (pl_u32)sum1[1].value
                      : same_value(sum1[1], PL_OPERAND_NODE, 3u)
                     && sum1[0].kind == PL_OPERAND_LOCAL
                     && sum1[0].value < PL_X86_GPR_COUNT
                      ? (pl_u32)sum1[0].value : PL_X86_GPR_COUNT;
    if (high_input >= PL_X86_GPR_COUNT
            || !same_value(flags1[1], PL_OPERAND_NODE, 3u)
            || !same_value(flags1[2], PL_OPERAND_LOCAL, high_input)
            || !same_value(flags1[3], PL_OPERAND_NODE, 4u)
            || !same_value(flags1[4], PL_OPERAND_CONST,
                           64u | (1u << 8u))
            || !same_value(carry1[0], PL_OPERAND_NODE, 5u)
            || !same_value(carry1[1], PL_OPERAND_CONST, 2u)
            || !same_value(sum2[1], PL_OPERAND_NODE, 4u)
            || !same_value(sum2[2], PL_OPERAND_NODE, 2u)
            || !same_value(sum2[3], PL_OPERAND_CONST,
                           64u | (1u << 8u))
            || !same_value(carry2[0], PL_OPERAND_NODE, 7u)
            || !same_value(carry2[1], PL_OPERAND_CONST, 2u)
            || !same_value(result_high[0], PL_OPERAND_NODE, 6u)
            || !same_value(result_high[1], PL_OPERAND_NODE, 8u)
            || !same_value(plan->locals[0], PL_OPERAND_PROJECTION,
                           (7u << 8u) | 16u)
            || !same_value(plan->locals[2], PL_OPERAND_NODE, 9u))
        return 0;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
        if (local == 0u || local == 2u
                || !(block->live_output_mask & (1u << local)))
            continue;
        if (!same_value(plan->locals[local], PL_OPERAND_LOCAL, local))
            return 0;
    }
    if (low == 0u || low == 2u || high_input == 0u
            || high_input == 2u || high_input == low
            || modulus == 0u || (block->live_output_mask & (1u << low)))
        return 0;
    out->inverse = inverse;
    out->low = low;
    out->modulus = modulus;
    out->high = high_input;
    return 1;
}

static int emit_mul_add_carry_frame(const mul_add_carry_frame *shape,
                                    pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, part = 0u;
#define APPEND_MUL_ADD(call_) do {                                          \
        if (!(call_)) return 0;                                             \
        at += part;                                                         \
    } while (0)
    if (shape->inverse != 0u)
        APPEND_MUL_ADD(emit_gpr_move(
            0u, shape->inverse, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(emit_imul_register(
        0u, shape->low, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(emit_unsigned_multiply(
        shape->modulus, output ? output + at : 0, &part));
    APPEND_MUL_ADD(emit_gpr_move(
        0u, 2u, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(emit_zero_register(
        2u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(emit_neg_register(
        shape->low, 64u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(emit_alu_instruction(
        0u, (pl_operand){ PL_OPERAND_LOCAL, shape->high },
        64u, 2u, 0u, output ? output + at : 0, &part));
    APPEND_MUL_ADD(emit_alu_instruction(
        2u, (pl_operand){ PL_OPERAND_CONST, 0u },
        64u, 2u, 0u, output ? output + at : 0, &part));
#undef APPEND_MUL_ADD
    *written = at;
    return 1;
}

static int measure_direct_mul_add_carry_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    (void)frontend;
    mul_add_carry_frame shape;
    pl_u32 bytes = 0u;
    if (!selection || !mul_add_carry_frame_shape(block, &shape)
            || !emit_mul_add_carry_frame(&shape, 0, &bytes))
        return 0;
    selection->output_bytes = bytes;
    selection->output_instructions = shape.inverse == 0u ? 7u : 8u;
    selection->output_work = selection->output_instructions;
    selection->output_span = 5u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_mul_add_carry_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    pl_u32 destination;
    pl_u32 dependency_owner;
    pl_u32 bits;
    pl_u32 mode;
    pl_u32 preserves_carry;
    pl_operand seed;
    pl_operand deferred;
    pl_u32 preload_mask;
    pl_u32 scratch_mask;
    pl_u32 tail_present;
    pl_u32 tail_mode;
    pl_operand tail;
} generation_join_handoff;

/* A normalized root may join one entry-only subtree with a later published
 * subtree.  Treating the whole root as one atomic assignment either extends
 * every entry lifetime or recomputes the first subtree for each consumer.
 * Seed that subtree into the final destination, expose the coordinate as its
 * transient owner, and overwrite it only after all alias consumers finish. */
static int generation_join_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    generation_join_handoff *out)
{
    if (!plan || !pending || !final_flag_node || !sources || !out)
        return 0;
    pl_u32 best_score = 0u;
    for (pl_u32 destination = 0u;
            destination < PL_X86_GPR_COUNT; ++destination) {
        pl_u32 destination_bit = 1u << destination;
        if (!(pending & destination_bit)) continue;
        pl_operand value = plan->locals[destination];
        pl_operand left, right;
        pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
        if (value.kind == PL_OPERAND_PROJECTION
                && (value.value & 0xffu) == 16u) {
            pl_u32 node_number = (pl_u32)(value.value >> 8u);
            if (node_number != final_flag_node
                    || !alu_node_semantics(
                        plan, node_number, &left, &right,
                        &bits, &mode, &preserves_carry)
                    || preserves_carry)
                continue;
        } else if (value.kind == PL_OPERAND_NODE
                && publication_owner(plan, value) == destination) {
            if (!arithmetic_tree_details(
                    plan, value, &left, &right, &bits, &mode))
                continue;
        } else {
            continue;
        }
        pl_u32 tail_present = 0u, tail_mode = mode;
        pl_operand tail = { PL_OPERAND_CONST, 0u };
        /* A constant final operation does not consume another entry
         * generation. Expose the inner shared join and leave that exact
         * operation last, so its architectural flags remain the output. */
        if (publication_is_flag_result(plan, value, final_flag_node)) {
            pl_operand inner = left, constant = right;
            if (left.kind == PL_OPERAND_CONST && associative_mode(mode)) {
                inner = right;
                constant = left;
            }
            pl_operand inner_left, inner_right;
            pl_u32 inner_bits = 0u, inner_mode = 0u;
            if (constant.kind == PL_OPERAND_CONST
                    && arithmetic_tree_details(plan, inner,
                        &inner_left, &inner_right, &inner_bits, &inner_mode)
                    && inner_bits == bits) {
                pl_u32 first_owner = PL_X86_GPR_COUNT;
                pl_u32 second_owner = PL_X86_GPR_COUNT;
                if ((published_operand_local(plan, inner_right, &first_owner)
                        && first_owner != destination
                        && (pending & (1u << first_owner)))
                        || (associative_mode(inner_mode)
                            && published_operand_local(plan, inner_left, &second_owner)
                            && second_owner != destination
                            && (pending & (1u << second_owner)))) {
                    tail_present = 1u;
                    tail = constant;
                    left = inner_left;
                    right = inner_right;
                    mode = inner_mode;
                }
            }
        }
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            if (orientation && mode == 3u) continue;
            pl_operand seed = orientation ? right : left;
            pl_operand deferred = orientation ? left : right;
            if (seed.kind == PL_OPERAND_CONST) continue;
            /* The constant-deferred form exists to preserve a root which is
             * itself the final flag producer.  Applying it to an unrelated
             * value root can lengthen a separately live CMP/TEST lifetime
             * and is not a valid scheduling improvement. */
            if (deferred.kind == PL_OPERAND_CONST
                    && !publication_is_flag_result(
                        plan, value, final_flag_node))
                continue;
            if (deferred.kind == PL_OPERAND_CONST) {
                pl_u32 seed_source = 0u, seed_bits = 0u;
                if (seed.kind != PL_OPERAND_NODE
                        || !zero_extend_node(
                            plan, (pl_u32)seed.value,
                            &seed_source, &seed_bits)
                        || seed_bits != bits
                        || seed_source == destination
                        || !(pending & (1u << seed_source)))
                    continue;
            }
            /* An unchanged entry value already lives in its destination
             * coordinate.  Source-law scheduling preserves that lifetime;
             * spending the one transient alias on this no-op seed only hides
             * a nontrivial shared subtree that actually needs an owner. */
            if (seed.kind == PL_OPERAND_LOCAL
                    && seed.value == destination)
                continue;
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (deferred.kind != PL_OPERAND_CONST
                    && (!published_operand_local(plan, deferred, &owner)
                        || owner == destination
                        || !(pending & (1u << owner))))
                continue;
            pl_u32 seed_sources = 0u, seed_dependencies = 0u;
            if (!operand_frame_source_law(
                    plan, seed, &seed_sources, &seed_dependencies))
                continue;
            pl_u32 preload = seed_dependencies & pending;
            pl_u32 entry_reads = seed_sources;
            for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other)
                if (pending & (1u << other)) entry_reads |= sources[other];
            if (entry_reads & preload) continue;
            int preload_valid = 1;
            for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
                if (!(preload & (1u << other))) continue;
                pl_operand publication = plan->locals[other];
                if (publication.kind != PL_OPERAND_LOCAL
                        && publication.kind != PL_OPERAND_CONST)
                    preload_valid = 0;
            }
            if (!preload_valid) continue;
            if (frame_publication_clobbers_flags(plan, seed)) {
                int entry_flags_escape = 0;
                for (pl_u32 other = 0u;
                        other < PL_X86_GPR_COUNT; ++other) {
                    conditional_select select;
                    if ((pending & (1u << other))
                            && conditional_select_details(
                                plan, plan->locals[other], other, &select)
                            && !select.has_compare && !select.current_flag_node) {
                        entry_flags_escape = 1;
                        break;
                    }
                }
                if (entry_flags_escape) continue;
            }
            int destination_entry_escapes = 0;
            for (pl_u32 other = 0u;
                    other < PL_X86_GPR_COUNT; ++other) {
                if (other != destination
                        && (pending & (1u << other))
                        && (sources[other] & destination_bit)
                        && !operand_contains_unpublished_value(
                            plan, plan->locals[other], seed,
                            plan->node_count + 1u, 1)) {
                    destination_entry_escapes = 1;
                    break;
                }
            }
            if (destination_entry_escapes) continue;
            pl_u32 score = owner < PL_X86_GPR_COUNT
                         && (seed_sources & (1u << owner)) ? 4u : 0u;
            /* A constant join has no deferred producer.  It still requires
             * a transient owner when its seed consumes an entry coordinate
             * which another pending publication overwrites.  Capturing that
             * generation once is the exact anti-dependency cut. */
            if (owner == PL_X86_GPR_COUNT
                    && (seed_sources & (pending & ~destination_bit)))
                score += 4u;
            for (pl_u32 other = 0u;
                    other < PL_X86_GPR_COUNT; ++other) {
                /* Another coordinate that publishes the same final root is
                 * a copy-out, not an independent consumer of the entry
                 * generation hidden inside that root.  Counting it as seed
                 * fanout creates a false alias cycle: the copy-out must wait
                 * for the final join, whereas a real alias consumer runs
                 * before it. */
                if (other != destination
                        && (pending & (1u << other))
                        && publication_owner(
                            plan, plan->locals[other]) == destination)
                    continue;
                if (other != destination
                        && (pending & (1u << other))
                        && operand_contains_unpublished_value(
                            plan, plan->locals[other], seed,
                            plan->node_count + 1u, 1)) {
                    score += 2u;
                    break;
                }
            }
            if (seed.kind == PL_OPERAND_LOCAL) ++score;
            if (score <= best_score) continue;
            pl_u32 external_sources = 0u;
            for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
                if (!(pending & ~preload & (1u << other))) continue;
                if (!operand_entry_sources_without(plan, plan->locals[other],
                        seed, plan->node_count + 1u, plan->node_count + 1u,
                        1, &external_sources)) return 0;
            }
            best_score = score;
            out->destination = destination;
            out->dependency_owner = owner;
            out->bits = bits;
            out->mode = mode;
            out->preserves_carry = preserves_carry;
            out->seed = seed;
            out->deferred = deferred;
            out->preload_mask = preload;
            out->scratch_mask = pending & ~preload & ~destination_bit & ~external_sources;
            out->tail_present = tail_present;
            out->tail_mode = tail_mode;
            out->tail = tail;
        }
    }
    return best_score >= 2u;
}

static int apply_generation_join_laws(
    const pl_plan *plan, pl_u32 pending,
    const generation_join_handoff *handoff,
    pl_u32 sources[PL_X86_GPR_COUNT],
    pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !handoff || !sources || !dependencies
            || handoff->destination >= PL_X86_GPR_COUNT
            || handoff->dependency_owner > PL_X86_GPR_COUNT)
        return 0;
    pl_u32 alias_bit = 1u << handoff->destination;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == handoff->destination || !(pending & (1u << local)))
            continue;
        /* Equal-result publications consume the completed root.  Rewriting
         * them to the transient seed would publish the old generation. */
        if (publication_owner(plan, plan->locals[local])
                == handoff->destination)
            continue;
        if (!operand_contains_unpublished_value(
                plan, plan->locals[local], handoff->seed,
                plan->node_count + 1u, 1))
            continue;
        pl_u32 remaining_sources = 0u;
        if (!operand_entry_sources_without(
                plan, plan->locals[local], handoff->seed,
                plan->node_count + 1u, plan->node_count + 1u,
                1, &remaining_sources))
            return 0;
        sources[local] = remaining_sources | alias_bit;
    }
    /* The seed now lives in the destination coordinate until the join.  That
     * coordinate is live, so it must stay out of every other publication's
     * scratch pool and must not be overwritten before the join; naming it as
     * its own entry source expresses exactly that anti-dependency (no other
     * pending publication writes it, so no producer edge is created). */
    sources[handoff->destination] = alias_bit;
    dependencies[handoff->destination] =
        handoff->dependency_owner < PL_X86_GPR_COUNT
        ? 1u << handoff->dependency_owner : 0u;
    return 1;
}

static pl_operand generation_join_right(
    const generation_join_handoff *handoff)
{
    if (handoff && handoff->dependency_owner < PL_X86_GPR_COUNT)
        return (pl_operand){
            PL_OPERAND_LOCAL, handoff->dependency_owner,
        };
    return handoff ? handoff->deferred
                   : (pl_operand){ PL_OPERAND_CONST, 0u };
}

static int emit_generation_join(const generation_join_handoff *handoff,
                                 pl_u8 *output, pl_u32 *written)
{
    pl_u32 join = 0u, tail = 0u;
    if (!emit_alu_instruction(handoff->destination,
            generation_join_right(handoff), handoff->bits, handoff->mode,
            handoff->preserves_carry, output, &join)) return 0;
    if (handoff->tail_present
            && !emit_alu_instruction(handoff->destination, handoff->tail,
                handoff->bits, handoff->tail_mode, 0u,
                output ? output + join : 0, &tail)) return 0;
    *written = join + tail;
    return 1;
}

typedef struct {
    pl_u32 destination;
    pl_u32 mutable_owner;
    pl_u32 sibling_owner;
    pl_u32 bits;
    pl_u32 parent_shift_group;
    pl_u32 mutable_mode;
    pl_u32 sibling_mode;
    pl_u32 root_mode;
    pl_operand accumulator;
    pl_operand parent_shift_amount;
    pl_operand mutable_right;
    pl_operand sibling_right;
} shared_parent_frame;

static int peel_associative_arm(const pl_plan *plan, pl_operand left,
                                pl_operand right, pl_operand target,
                                pl_u32 bits, pl_u32 mode,
                                pl_operand *remainder)
{
    if (!plan || !remainder) return 0;
    if (equal_operand(left, target)) {
        *remainder = right;
        return 1;
    }
    if (equal_operand(right, target)) {
        *remainder = left;
        return 1;
    }
    (void)bits;
    (void)mode;
    return 0;
}

/* One entry word can have two masked futures after the same shift while a
 * third future must consume the unshifted generation.  Compute the latter in
 * its final accumulator, advance the entry coordinate to the shared shifted
 * generation, copy that generation once, then form both publications.  The
 * final two bitwise joins remain last and therefore publish the exact flags.
 *
 * This is the register image of one shared SSA parent.  No transient row or
 * source instruction sequence survives in the optimized ELF. */
static int shared_parent_frame_shape(const pl_x86_block *block,
                                     pl_u32 changed,
                                     pl_u32 final_flag_node,
                                     shared_parent_frame *out)
{
    if (!block || !out || !changed || !final_flag_node) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 destination = PL_X86_GPR_COUNT;
    pl_operand root_left, root_right;
    pl_u32 bits = 0u, root_mode = 0u, preserves_carry = 0u;
    if (!alu_node_details(
            plan, final_flag_node, &destination, &root_left, &root_right,
            &bits, &root_mode, &preserves_carry)
            || destination >= PL_X86_GPR_COUNT || preserves_carry
            || (root_mode != 0u && root_mode != 5u && root_mode != 6u)
            || !publication_is_flag_result(
                plan, plan->locals[destination], final_flag_node))
        return 0;

    for (pl_u32 first = 0u; first < PL_X86_GPR_COUNT; ++first) {
        if (first == destination || !(changed & (1u << first))) continue;
        pl_operand first_left, first_right;
        pl_u32 first_bits = 0u, first_mode = 0u;
        if (!arithmetic_tree_details(
                plan, plan->locals[first], &first_left, &first_right,
                &first_bits, &first_mode)
                || first_bits != bits || first_right.kind != PL_OPERAND_CONST)
            continue;
        for (pl_u32 second = first + 1u;
                second < PL_X86_GPR_COUNT; ++second) {
            if (second == destination || !(changed & (1u << second)))
                continue;
            pl_operand second_left, second_right;
            pl_u32 second_bits = 0u, second_mode = 0u;
            if (!arithmetic_tree_details(
                    plan, plan->locals[second],
                    &second_left, &second_right,
                    &second_bits, &second_mode)
                    || second_bits != bits
                    || second_right.kind != PL_OPERAND_CONST
                    || !equal_operand(first_left, second_left))
                continue;

            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            if (!shift_node_details(
                    plan, first_left, &shift_source, &shift_amount,
                    &shift_bits, &shift_group)
                    || shift_bits != bits
                    || shift_source.kind != PL_OPERAND_LOCAL
                    || shift_source.value >= PL_X86_GPR_COUNT
                    || shift_amount.kind != PL_OPERAND_CONST)
                continue;
            pl_u32 mutable_owner = (pl_u32)shift_source.value;
            if (mutable_owner != first && mutable_owner != second)
                continue;
            pl_u32 sibling_owner = mutable_owner == first ? second : first;
            pl_operand mutable_value = plan->locals[mutable_owner];
            pl_operand sibling_value = plan->locals[sibling_owner];
            pl_operand accumulator;
            int peeled = peel_associative_arm(
                plan, root_left, root_right, mutable_value,
                bits, root_mode, &accumulator);
            if (peeled) {
                pl_operand left, right;
                pl_u32 inner_bits = 0u, inner_mode = 0u;
                if (!arithmetic_tree_details(
                        plan, accumulator, &left, &right,
                        &inner_bits, &inner_mode)
                        || inner_bits != bits || inner_mode != root_mode
                        || !peel_associative_arm(
                            plan, left, right, sibling_value,
                            bits, root_mode, &accumulator))
                    peeled = 0;
            }
            if (!peeled) {
                if (!peel_associative_arm(
                        plan, root_left, root_right, sibling_value,
                        bits, root_mode, &accumulator))
                    continue;
                pl_operand left, right;
                pl_u32 inner_bits = 0u, inner_mode = 0u;
                if (!arithmetic_tree_details(
                        plan, accumulator, &left, &right,
                        &inner_bits, &inner_mode)
                        || inner_bits != bits || inner_mode != root_mode
                        || !peel_associative_arm(
                            plan, left, right, mutable_value,
                            bits, root_mode, &accumulator))
                    continue;
            }

            pl_u32 exact = (1u << destination)
                         | (1u << mutable_owner)
                         | (1u << sibling_owner);
            if ((changed & ((1u << PL_X86_GPR_COUNT) - 1u)) != exact)
                continue;
            *out = (shared_parent_frame){
                destination, mutable_owner, sibling_owner, bits,
                shift_group,
                mutable_owner == first ? first_mode : second_mode,
                sibling_owner == first ? first_mode : second_mode,
                root_mode, accumulator, shift_amount,
                mutable_owner == first ? first_right : second_right,
                sibling_owner == first ? first_right : second_right,
            };
            return 1;
        }
    }
    return 0;
}

static int measure_shared_parent_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, const shared_parent_frame *shape)
{
    if (!frontend || !block || !selection || !shape) return 0;
    pl_u32 bytes = 0u, work = 0u, part = 0u;
    int measured = measure_alu_tree(
        frontend, block, selection, shape->destination,
        shape->accumulator, shape->bits, 0u,
        block->plan.node_count + 1u, 0u, &bytes, &work);
    if (measured <= 0) return measured;
#define MEASURE_SHARED_PARENT(operation_) do {                              \
        part = 0u;                                                          \
        if (!(operation_) || bytes > U32_MAX_VALUE - part                  \
                || work == U32_MAX_VALUE)                                  \
            return 0;                                                       \
        bytes += part;                                                      \
        ++work;                                                             \
    } while (0)
    MEASURE_SHARED_PARENT(emit_shift_instruction(
        shape->mutable_owner, shape->parent_shift_amount,
        shape->bits, shape->parent_shift_group, 0, &part));
    MEASURE_SHARED_PARENT(emit_gpr_move(
        shape->sibling_owner, shape->mutable_owner,
        shape->bits, 0, &part));
    MEASURE_SHARED_PARENT(emit_alu_instruction(
        shape->mutable_owner, shape->mutable_right,
        shape->bits, shape->mutable_mode, 0u, 0, &part));
    MEASURE_SHARED_PARENT(emit_alu_instruction(
        shape->sibling_owner, shape->sibling_right,
        shape->bits, shape->sibling_mode, 0u, 0, &part));
    pl_operand sibling = { PL_OPERAND_LOCAL, shape->sibling_owner };
    pl_operand mutable = { PL_OPERAND_LOCAL, shape->mutable_owner };
    MEASURE_SHARED_PARENT(emit_alu_instruction(
        shape->destination, sibling, shape->bits,
        shape->root_mode, 0u, 0, &part));
    MEASURE_SHARED_PARENT(emit_alu_instruction(
        shape->destination, mutable, shape->bits,
        shape->root_mode, 0u, 0, &part));
#undef MEASURE_SHARED_PARENT
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status || bytes > U32_MAX_VALUE - branch_bytes) return status;
        bytes += branch_bytes;
        ++work;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_shared_parent_frame = 1u;
    selection->direct_nested_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    conditional_select select;
    standalone_flag_publication compare;
    pl_u32 destination, members, first;
} select_generation_group;

/* Old GPR -> flags and new GPR -> CMOV are distinct edges. When a comparison
 * reads a coordinate later occupied by a selected arm, emit the comparison
 * first, then flag-preserving arm publications, then CMOV. No old GPR copy or
 * Boolean materialization is needed. Both arms must have an acyclic copy
 * order, and every other old-generation reader must already have run. */
static int select_generation_group_shape(const pl_plan *plan, pl_u32 pending,
    pl_u32 protected_sources, select_generation_group *out)
{
    if (!plan || !out) return 0;
    for (pl_u32 destination = 0u; destination < PL_X86_GPR_COUNT; ++destination) {
        if (!(pending & (1u << destination))) continue;
        conditional_select select;
        standalone_flag_publication compare;
        if (!conditional_select_details(plan, plan->locals[destination], destination, &select)
                || !select.has_compare || select.candidate_is_entry
                || select.candidate_local == destination
                || !(pending & (1u << select.candidate_local))
                || !standalone_flag_publication_details(plan, select.compare_node, &compare)
                || (compare.owner_dependencies & pending)) continue;
        pl_u32 candidate = select.candidate_local;
        pl_u32 members = (1u << destination) | (1u << candidate);
        if (!(compare.entry_sources & members) || (protected_sources & members)) continue;
        pl_operand current = select.current, value = plan->locals[candidate];
        if ((current.kind != PL_OPERAND_CONST && current.kind != PL_OPERAND_LOCAL)
                || (value.kind != PL_OPERAND_CONST && value.kind != PL_OPERAND_LOCAL)) continue;
        if ((current.kind == PL_OPERAND_LOCAL && current.value >= PL_X86_GPR_COUNT)
                || (value.kind == PL_OPERAND_LOCAL && value.value >= PL_X86_GPR_COUNT)) continue;
        pl_u32 current_sources = current.kind == PL_OPERAND_LOCAL ? 1u << current.value : 0u;
        pl_u32 candidate_sources = value.kind == PL_OPERAND_LOCAL ? 1u << value.value : 0u;
        int first_candidate = !(current_sources & (1u << candidate));
        if (!first_candidate && (candidate_sources & (1u << destination))) continue;
        int blocked = 0;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local)) || (members & (1u << local))) continue;
            pl_operand other = plan->locals[local];
            if (equal_operand(other, plan->locals[destination])) continue;
            /* A pending non-leaf may observe entry flags or either old GPR.
             * Let its ordinary scheduler discharge those obligations first. */
            if (other.kind != PL_OPERAND_CONST
                    && (other.kind != PL_OPERAND_LOCAL || (members & (1u << other.value))))
                blocked = 1;
        }
        if (blocked) continue;
        *out = (select_generation_group){ select, compare, destination, members,
            first_candidate ? candidate : destination };
        return 1;
    }
    return 0;
}

/* Measurement and emission replay the same three phases. Fixup ownership
 * stays in the ordinary seed generator, including projected RIP addresses. */
static int measure_select_generation_group(const pl_x86_frontend *frontend,
    const pl_x86_block *block, pl_x86_native_selection *selection,
    const select_generation_group *shape, pl_u32 output_at, pl_u32 *bytes, pl_u32 *work)
{
    pl_u32 at = 0u, count = 1u, part = 0u;
    if (!emit_standalone_flag_publication(&shape->compare, 0, &at)) return 0;
    for (pl_u32 index = 0u; index < 2u; ++index) {
        pl_u32 local = index ? (shape->first == shape->destination
            ? shape->select.candidate_local : shape->destination) : shape->first;
        pl_operand value = local == shape->destination
            ? shape->select.current : block->plan.locals[local];
        pl_u32 instructions = 0u;
        pl_u32 bits = local == shape->destination ? shape->select.value_bits : 64u;
        if (output_at > U32_MAX_VALUE - at) return PL_ERROR_X86_SELECT;
        int status = measure_alu_seed(frontend, block, selection, local, value, bits,
            output_at + at, block->plan.node_count + 1u, &part, &instructions);
        if (status <= 0 || at > U32_MAX_VALUE - part || count > U32_MAX_VALUE - instructions)
            return status < 0 ? status : 0;
        at += part; count += instructions;
    }
    if (!emit_conditional_move(shape->destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition, 0, &part)
            || at > U32_MAX_VALUE - part || count == U32_MAX_VALUE) return 0;
    *bytes = at + part; *work = count + 1u;
    return 1;
}

static int write_select_generation_group(const pl_x86_block *block,
    const pl_x86_native_selection *selection, const select_generation_group *shape,
    pl_u32 output_at, pl_u8 *output, pl_u32 *written)
{
    pl_u32 at = 0u, part = 0u;
    if (!emit_standalone_flag_publication(&shape->compare, output, &at)) return 0;
    for (pl_u32 index = 0u; index < 2u; ++index) {
        pl_u32 local = index ? (shape->first == shape->destination
            ? shape->select.candidate_local : shape->destination) : shape->first;
        pl_operand value = local == shape->destination
            ? shape->select.current : block->plan.locals[local];
        pl_u32 bits = local == shape->destination ? shape->select.value_bits : 64u;
        if (!write_alu_seed(block, selection, local, value, bits, output_at + at,
                block->plan.node_count + 1u, output + at, &part)) return 0;
        at += part;
    }
    if (!emit_conditional_move(shape->destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition, output + at, &part)) return 0;
    *written = at + part;
    return 1;
}

/* A branch observing the published flag word adds one control edge, not a
 * different value grammar. Compile the same complete frame, then attach Jcc.
 * The source extent remains intact for address-field relocation. */
static int conditional_alu_body(const pl_x86_block *block,
                                 pl_x86_block *body, pl_u32 *condition)
{
    if (!block || !body || !condition || block->flow != PL_X86_FLOW_CONDITIONAL
            || !block->has_predicate || block->successor_count != 2u
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->predicate.kind != PL_OPERAND_PROJECTION
            || (block->predicate.value & 0xffu) >= 16u) return 0;
    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > block->plan.node_count
            || (block->predicate.value >> 8u) != flags.value) return 0;
    *condition = (pl_u32)block->predicate.value & 0xffu;
    *body = *block;
    body->flow = PL_X86_FLOW_NEXT;
    body->has_predicate = 0u;
    body->predicate = (pl_operand){ PL_OPERAND_CONST, 0u };
    body->successor_count = 1u;
    body->successor[0] = block->successor[1];
    return 1;
}

/* A CMP/TEST replaces every arithmetic condition flag and preserves DF/IF and
 * the other system lanes.  An intermediate flag word that only perturbs the
 * overwritten arithmetic lanes may therefore be dropped without emitting it.
 * This is exact only when the intermediate's own operation leaves every
 * preserved lane alone, so the walk accepts lane AND/OR/XOR immediates whose
 * mask cannot change a non-arithmetic bit and terminates at entry RFLAGS. */
static int flags_root_only_arithmetic(const pl_plan *plan, pl_u32 node_number)
{
    if (!plan) return 0;
    const pl_u64 arithmetic = (1ull << 0u) | (1ull << 2u) | (1ull << 4u)
                            | (1ull << 6u) | (1ull << 7u) | (1ull << 11u);
    for (pl_u32 step = 0u;
            node_number && node_number <= plan->node_count
                && step <= plan->node_count;
            ++step) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        if (node->argument_count != 2u
                || node->argument_at > plan->argument_count
                || 2u > plan->argument_count - node->argument_at)
            return 0;
        pl_u32 lane = 2u, semantic = 5u;
        for (pl_u32 candidate = 0u; candidate < 2u; ++candidate)
            for (pl_u32 meaning = 0u; meaning < 5u; ++meaning)
                if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[candidate][meaning]) {
                    lane = candidate;
                    semantic = meaning;
                }
        if (lane == 2u) return 0;
        const pl_operand *argument = plan->arguments + node->argument_at;
        if (argument[1].kind != PL_OPERAND_CONST) return 0;
        const pl_u64 word = lane == 1u ? ~0ull : 0xffffffffull;
        pl_u64 mask = argument[1].value & word;
        pl_u64 harmed = 0u;
        if (semantic == 0u)
            harmed = (~mask) & ~arithmetic & word;
        else if (semantic == 3u || semantic == 4u)
            harmed = mask & ~arithmetic & word;
        else
            return 0;
        if (harmed) return 0;
        pl_operand left = argument[0];
        if (left.kind == PL_OPERAND_LOCAL && left.value == PL_X86_RFLAGS_LOCAL)
            return 1;
        if (left.kind != PL_OPERAND_NODE || !left.value
                || left.value >= node_number)
            return 0;
        node_number = (pl_u32)left.value;
    }
    return 0;
}

/* The final flag producer's value tree may read an entry register that another
 * pending publication overwrites.  Its value must then be evaluated before
 * that publication while the flag-setting instruction stays last.  This shape
 * names the destination, the value tree, its scratch and the remaining
 * operand dependency so the measure and write paths can preload the tree with
 * the identical schedule.  Pure; the caller emits and updates the arrays. */
typedef struct {
    pl_u32 destination;
    pl_operand tree;
    pl_u32 tree_bits;
    pl_u32 scratch;
    pl_u32 other_source;
} flag_value_preload;

static int flag_value_preload_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 frame_sources[PL_X86_GPR_COUNT],
    const pl_u32 frame_dependencies[PL_X86_GPR_COUNT],
    flag_value_preload *out)
{
    if (!plan || !out || !final_flag_node) return 0;
    pl_operand result, prior, left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!flag_result_operand(plan, final_flag_node, &result, &prior)
            || !flag_operation_details(
                plan, (pl_operand){ PL_OPERAND_NODE, final_flag_node },
                &left, &right, &bits, &mode, &preserves_carry))
        return 0;
    pl_u32 destination = publication_owner(plan, result);
    pl_operand tree = left, other = right;
    if (tree.kind == PL_OPERAND_LOCAL && other.kind == PL_OPERAND_CONST) {
        /* The flag operation combines an entry register with an immediate and
         * another pending publication overwrites that register: preload it with
         * a copy before the clobber, then apply the immediate last. */
    } else if (tree.kind == PL_OPERAND_LOCAL
            || tree.kind == PL_OPERAND_CONST) {
        pl_operand swap = tree;
        tree = other;
        other = swap;
    }
    if ((tree.kind != PL_OPERAND_NODE && tree.kind != PL_OPERAND_PROJECTION
                && tree.kind != PL_OPERAND_LOCAL)
            || destination >= PL_X86_GPR_COUNT
            || !(pending & (1u << destination))
            || (frame_dependencies[destination] & pending))
        return 0;
    pl_u32 others_read = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (local != destination && (pending & (1u << local)))
            others_read |= frame_sources[local];
    if (others_read & (1u << destination)) return 0;
    if (other.kind == PL_OPERAND_LOCAL
            && frame_local_publication_clobbers_flags(
                plan, (pl_u32)other.value))
        return 0;
    pl_u32 tree_sources = 0u;
    if (!operand_entry_gpr_sources(plan, tree, plan->node_count + 1u,
            plan->node_count + 1u, &tree_sources)
            || !(tree_sources & pending))
        return 0;
    if (tree_sources & (other.kind == PL_OPERAND_LOCAL
            ? (1u << (pl_u32)other.value) : 0u))
        return 0;
    pl_u32 tree_bits = operand_expression_bits(plan, tree, 64u);
    if (!tree_bits) return 0;
    pl_u32 scratch = alu_frame_scratch_mask(pending, destination, frame_sources);
    if (other.kind == PL_OPERAND_LOCAL)
        scratch &= ~(1u << (pl_u32)other.value);
    *out = (flag_value_preload){
        destination, tree, tree_bits, scratch,
        other.kind == PL_OPERAND_LOCAL ? (1u << (pl_u32)other.value) : 0u,
    };
    return 1;
}

typedef struct {
    pl_u32 local;
    int is_alu;
    pl_operand seed;
    pl_u32 bits;
    pl_operand amount;
    pl_u32 group;
    pl_operand right;
    pl_u32 mode;
    pl_u32 preserves_carry;
    int is_flag;
} shared_root_consumer;

typedef struct {
    pl_operand seed;
    pl_u32 seed_bits;
    pl_u32 seed_dest;
    pl_u32 copy_dest;
    pl_u32 bits;
    shared_root_consumer dest_consumer;
    shared_root_consumer copy_consumer;
} shared_root_unary_handoff;

/* Classify a pending publication as a unary consumer of an unpublished node:
 * a lane shift, or an architectural ALU pair over a constant whose flags may
 * be the final observable ones. */
static int shared_root_consumer_of(const pl_plan *plan, pl_u32 local,
                                   pl_u32 final_flag_node,
                                   shared_root_consumer *out)
{
    if (!plan || !out || local >= PL_X86_GPR_COUNT) return 0;
    pl_operand value = plan->locals[local];
    pl_operand source, amount;
    pl_u32 bits = 0u, group = 0u;
    if (shift_node_details(plan, value, &source, &amount, &bits, &group)
            && source.kind == PL_OPERAND_NODE && source.value
            && source.value <= plan->node_count) {
        *out = (shared_root_consumer){ local, 0, source, bits,
                                       amount, group, { 0 }, 0u, 0u, 0 };
        return 1;
    }
    if (value.kind == PL_OPERAND_PROJECTION && (value.value & 0xffu) == 16u) {
        pl_u32 node_number = (pl_u32)(value.value >> 8u);
        pl_operand left, right;
        pl_u32 alu_bits = 0u, mode = 0u, preserves_carry = 0u;
        if (!node_number || node_number > plan->node_count
                || !alu_node_semantics(plan, node_number, &left, &right,
                       &alu_bits, &mode, &preserves_carry))
            return 0;
        if (left.kind == PL_OPERAND_CONST && associative_mode(mode)) {
            pl_operand swap = left; left = right; right = swap;
        }
        if (left.kind != PL_OPERAND_NODE || !left.value
                || left.value > plan->node_count
                || right.kind != PL_OPERAND_CONST)
            return 0;
        *out = (shared_root_consumer){ local, 1, left, alu_bits,
                                       { 0 }, 0u, right, mode, preserves_carry,
                                       node_number == final_flag_node };
        return 1;
    }
    return 0;
}

/* Two pending publications that apply a unary operation to the same
 * unpublished root whose operand tree reads the entry values of both
 * destinations:
 *
 *   D1 = op1(seed)   D2 = op2(seed)   seed reads entry D1 and entry D2
 *
 * The ordinary scheduler deadlocks (each destination overwrites a coordinate
 * the root reads), yet the source evaluates the root once, copies it, and
 * applies each operation.  The flag-producing consumer, when present, is
 * applied last. */
static int shared_root_unary_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                           pl_u32 final_flag_node,
                                           shared_root_unary_handoff *out)
{
    if (!plan || !pending || !out) return 0;
    for (pl_u32 a = 0u; a < PL_X86_GPR_COUNT; ++a) {
        if (!(pending & (1u << a))) continue;
        shared_root_consumer first;
        if (!shared_root_consumer_of(plan, a, final_flag_node, &first))
            continue;
        for (pl_u32 b = a + 1u; b < PL_X86_GPR_COUNT; ++b) {
            if (!(pending & (1u << b))) continue;
            shared_root_consumer second;
            if (!shared_root_consumer_of(plan, b, final_flag_node, &second))
                continue;
            if (first.seed.kind != second.seed.kind
                    || first.seed.value != second.seed.value
                    || first.bits != second.bits)
                continue;
            if (publication_owner(plan, first.seed) < PL_X86_GPR_COUNT)
                continue;
            pl_u32 seed_sources = 0u;
            if (!operand_gpr_sources(plan, first.seed, plan->node_count + 1u,
                    plan->node_count + 1u, &seed_sources)
                    || !(seed_sources & (1u << a))
                    || !(seed_sources & (1u << b)))
                continue;
            if (first.is_flag && second.is_flag) continue;
            pl_u32 seed_dest = a, copy_dest = b;
            if (first.is_flag) { seed_dest = b; copy_dest = a; }
            out->seed = first.seed;
            out->seed_bits = first.bits;
            out->seed_dest = seed_dest;
            out->copy_dest = copy_dest;
            out->bits = first.bits;
            out->dest_consumer = seed_dest == a ? first : second;
            out->copy_consumer = seed_dest == a ? second : first;
            return 1;
        }
    }
    return 0;
}

static int emit_shared_root_consumer(const shared_root_consumer *consumer,
                                     pl_u8 *output, pl_u32 *written)
{
    if (!consumer || !written) return 0;
    if (consumer->is_alu)
        return emit_alu_instruction(consumer->local, consumer->right,
            consumer->bits, consumer->mode, consumer->preserves_carry,
            output, written);
    return emit_shift_instruction(consumer->local, consumer->amount,
        consumer->bits, consumer->group, output, written);
}

static int measure_direct_alu_frame(const pl_x86_frontend *frontend,
                                    const pl_x86_block *block,
                                    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    /* The dense ALU frame enumerates operand trees without a cost
     * memo; a very large straight-line plan makes that search
     * super-exponential.  Decline it so the polynomial live-range and
     * shared-DAG frames, or an exact source projection, own the block. */
    if (block->plan.node_count > 96u) return 0;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u;
        if (!conditional_alu_body(block, &body, &condition)) return 0;
        int measured = measure_direct_alu_frame(frontend, &body, selection);
        if (measured <= 0) return measured;
        pl_u32 bytes = selection->output_bytes;
        pl_u32 tail = block->relax_short_control ? 6u : 2u;
        if (bytes > U32_MAX_VALUE - tail || selection->output_instructions == U32_MAX_VALUE)
            return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + (block->relax_short_control ? 2u : 1u),
            bytes + tail, block->successor[0]);
        if (status) return status;
        selection->output_bytes += tail;
        ++selection->output_instructions;
        return 1;
    }
    if (block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE) {
        selection->blocking_work = 0xf001u;
        return 0;
    }
    pl_u32 changed, final_flag_node;
    if (!alu_frame_shape(&block->plan, &changed, &final_flag_node)) {
        selection->blocking_work = 0xf002u;
        return 0;
    }
    if (final_flag_node) {
        const pl_node *flags = &block->plan.nodes[final_flag_node - 1u];
        if (flags->opcode == PL_OPCODE_X86_COMPARE || flags->opcode == PL_OPCODE_X86_TEST) {
            /* CMP/TEST replaces arithmetic flags, not DF/IF. A non-entry
             * preserved root needs its own emitted flag-prefix production. */
            if (!flags->argument_count || flags->argument_at >= block->plan.argument_count)
                return 0;
            pl_operand prior = block->plan.arguments[flags->argument_at];
            if (prior.kind == PL_OPERAND_LOCAL
                    && prior.value == PL_X86_RFLAGS_LOCAL) {
                /* Entry flags flow into CMP/TEST directly. */
            } else if (prior.kind == PL_OPERAND_NODE
                    && flags_root_only_arithmetic(
                        &block->plan, (pl_u32)prior.value)) {
                /* The intermediate only perturbs flags CMP/TEST overwrite. */
            } else {
                return 0;
            }
        }
    }
    /* Preserve the responsible grammar on a red candidate so a preceding
     * broad frame probe cannot hide the exact dense-ALU rejection. */
    selection->direct_alu_frame = 1u;
    selection->value_alias_frame_count = selection->value_alias_count;
    entry_select_bit_test_frame entry_select_test;
    if (entry_select_bit_test_frame_shape(
            block, changed, final_flag_node, &entry_select_test)) {
        pl_u32 frame_bytes = 0u;
        if (!emit_entry_select_bit_test_frame(
                &entry_select_test, (pl_u8 *)0, &frame_bytes))
            return 0;
        selection->output_bytes = frame_bytes;
        selection->output_instructions = 4u;
        selection->supported = 1u;
        selection->direct_frame = 1u;
        selection->direct_alu_frame = 1u;
        selection->direct_nested_frame = 1u;
        selection->reason = PL_X86_NATIVE_SELECT_READY;
        return 1;
    }
    shared_parent_frame shared_parent;
    if (shared_parent_frame_shape(
            block, changed, final_flag_node, &shared_parent))
        return measure_shared_parent_frame(
            frontend, block, selection, &shared_parent);
    narrow_flag_transfer narrow_transfer;
    if (narrow_flag_transfer_shape(block, &narrow_transfer))
        return measure_narrow_flag_transfer(
            frontend, block, selection, &narrow_transfer);
    independent_flag_overwrite overwrite;
    if (independent_flag_overwrite_shape(&block->plan, &overwrite)) {
        pl_u32 flag_bytes = 0u, value_bytes = 0u;
        if (!emit_low8_alu_flags(
                overwrite.destination, overwrite.right, overwrite.mode,
                (pl_u8 *)0, &flag_bytes)
                || !emit_scaled_lea(
                    overwrite.destination, overwrite.value_source,
                    overwrite.value_bits, overwrite.scale_log2,
                    (pl_u8 *)0, &value_bytes)
                || flag_bytes > U32_MAX_VALUE - value_bytes)
            return 0;
        selection->output_bytes = flag_bytes + value_bytes;
        selection->output_instructions = 2u;
        selection->supported = 1u;
        selection->direct_frame = 1u;
        selection->direct_alu_frame = 1u;
        selection->reason = PL_X86_NATIVE_SELECT_READY;
        return 1;
    }
    standalone_flag_publication exact_flags;
    if (final_flag_node
            && !publication_emits_flag_node(
                &block->plan, changed, final_flag_node)
            && !flag_node_has_value_publication(
                &block->plan, changed, final_flag_node)
            && !standalone_flag_publication_details(
                &block->plan, final_flag_node, &exact_flags)) {
        selection->blocking_work = 0xf003u;
        return 0;
    }
    pl_u32 bytes = 0u;
    pl_u32 instructions = 0u;
    pl_u32 span = 0u;
    pl_u32 frame_sources[PL_X86_GPR_COUNT];
    pl_u32 frame_dependencies[PL_X86_GPR_COUNT];
    if (!alu_frame_source_laws(
            &block->plan, frame_sources, frame_dependencies)) {
        selection->blocking_work = 1u;
        return 0;
    }
    add_flag_chain_dependencies(
        &block->plan, final_flag_node, frame_dependencies);
    if (!apply_shared_flag_producer_laws(
            &block->plan, changed, final_flag_node,
            frame_sources, frame_dependencies))
        return 0;
    shared_flag_select_handoff flag_select = { 0 };
    int has_flag_select = shared_flag_select_handoff_shape(
        &block->plan, changed, final_flag_node, &flag_select);
    generation_join_handoff generation_join = { 0 };
    int has_generation_join = generation_join_handoff_shape(
        &block->plan, changed, final_flag_node,
        frame_sources, &generation_join);
    if (has_flag_select && has_generation_join) return 0;
    if (has_generation_join) {
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(generation_join.preload_mask & (1u << local))) continue;
            pl_u32 part = 0u;
            int measured = measure_frame_value(frontend, block, selection,
                local, block->plan.locals[local], bytes, &part);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            ++instructions;
        }
        pl_u32 seed_bytes = 0u, seed_work = 0u;
        pl_u32 seed_source = 0u, seed_bits = 0u;
        int measured = generation_join.seed.kind == PL_OPERAND_NODE
                    && zero_extend_node(
                        &block->plan,
                        (pl_u32)generation_join.seed.value,
                        &seed_source, &seed_bits)
                    && seed_bits == generation_join.bits
            ? emit_zero_extend_move(
                generation_join.destination, seed_source, seed_bits,
                (pl_u8 *)0, &seed_bytes)
            : measure_alu_tree(
                frontend, block, selection, generation_join.destination,
                generation_join.seed, generation_join.bits, bytes,
                block->plan.node_count + 1u, generation_join.scratch_mask,
                &seed_bytes, &seed_work);
        if (measured && !seed_work) seed_work = 1u;
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - seed_bytes
                || instructions > U32_MAX_VALUE - seed_work) return 0;
        bytes += seed_bytes;
        instructions += seed_work;
        span = seed_work;
        if (!apply_generation_join_laws(
                &block->plan, changed, &generation_join,
                frame_sources, frame_dependencies))
            return 0;
        selection->direct_nested_frame = 1u;
        selection->frame_alias_value = generation_join.seed.value;
        selection->frame_alias_kind = generation_join.seed.kind;
        selection->frame_alias_local =
            (pl_u8)generation_join.destination;
        selection->frame_alias_present = 1u;
    }
    standalone_flag_publication standalone_flags;
    int standalone_flags_pending = !publication_emits_flag_node(
            &block->plan, changed, final_flag_node)
        && !flag_node_has_value_publication(
            &block->plan, changed, final_flag_node)
        && standalone_flag_publication_details(
            &block->plan, final_flag_node, &standalone_flags);
    pl_u32 pending = changed & ~generation_join.preload_mask;
    if (has_flag_select) {
        const pl_u32 arm[2] = {
            flag_select.candidate_first
                ? flag_select.candidate : flag_select.destination,
            flag_select.candidate_first
                ? flag_select.destination : flag_select.candidate,
        };
        for (pl_u32 index = 0u; index < 2u; ++index) {
            const pl_u32 local = arm[index];
            const pl_operand value = local == flag_select.destination
                ? flag_select.select.current : block->plan.locals[local];
            pl_u32 part = 0u, part_work = 0u;
            int measured = measure_alu_tree(
                frontend, block, selection, local, value,
                flag_select.bits, bytes,
                block->plan.node_count + 1u, 0u,
                &part, &part_work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part
                    || instructions > U32_MAX_VALUE - part_work)
                return measured < 0 ? measured : 0;
            bytes += part;
            instructions += part_work;
        }
        pl_u32 part = 0u, part_work = 0u;
        int measured = measure_alu_pair(
            frontend, block, selection, flag_select.flag_owner,
            flag_select.flag_left, flag_select.flag_right,
            flag_select.flag_bits, flag_select.flag_mode, 0u,
            bytes, block->plan.node_count + 1u, 0u,
            &part, &part_work);
        if (measured <= 0 || bytes > U32_MAX_VALUE - part
                || instructions > U32_MAX_VALUE - part_work)
            return measured < 0 ? measured : 0;
        bytes += part;
        instructions += part_work;
        if (!emit_conditional_move(
                flag_select.destination, flag_select.candidate,
                flag_select.bits, flag_select.select.condition,
                (pl_u8 *)0, &part)
                || bytes > U32_MAX_VALUE - part
                || instructions == U32_MAX_VALUE)
            return 0;
        bytes += part;
        ++instructions;
        pending &= ~((1u << flag_select.destination)
                   | (1u << flag_select.candidate)
                   | (1u << flag_select.flag_owner));
        selection->direct_nested_frame = 1u;
    }
    if (!selection->frame_alias_present && !has_flag_select
            && !has_generation_join) {
        flag_value_preload preload;
        if (flag_value_preload_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies, &preload)) {
            pl_u32 part = 0u, work = 0u;
            /* The preload's tree is measured before the alias that records its
             * destination is installed.  Install the same empty alias state
             * for the measurement so the write path below reproduces these
             * bytes exactly; the emitted preload subsequence is self-contained
             * and does not read the earlier alias. */
            pl_x86_native_selection preload_measure = *selection;
            preload_measure.frame_alias_present = 0u;
            int measured = measure_alu_tree(
                frontend, block, &preload_measure, preload.destination,
                preload.tree, preload.tree_bits, bytes,
                block->plan.node_count + 1u, preload.scratch,
                &part, &work);
            if (measured > 0 && bytes <= U32_MAX_VALUE - part
                    && instructions <= U32_MAX_VALUE - work) {
                *selection = preload_measure;
                bytes += part;
                instructions += work;
                selection->frame_alias_value = preload.tree.value;
                selection->frame_alias_kind = preload.tree.kind;
                selection->frame_alias_local = (pl_u8)preload.destination;
                selection->frame_alias_present = 1u;
                /* The write path recomputes the preload shape from the same
                 * frame laws before it emits the tree; leaving the destination
                 * dependency relaxed here would make the write-path shape test
                 * fail and fall back to a different spelling. */
                frame_sources[preload.destination] =
                    preload.other_source | (1u << preload.destination);
                selection->direct_nested_frame = 1u;
            }
        }
    }
    selection->frame_alias_frame_kind = selection->frame_alias_kind;
    selection->frame_alias_frame_local = selection->frame_alias_local;
    selection->frame_alias_frame_present = selection->frame_alias_present;
    while (pending || standalone_flags_pending) {
        select_generation_group select_group;
        if (select_generation_group_shape(&block->plan, pending,
                standalone_flags_pending ? standalone_flags.entry_sources : 0u, &select_group)
                && (standalone_flags_pending || select_group.select.compare_node == final_flag_node)) {
            pl_u32 part = 0u, work = 0u;
            int measured = measure_select_generation_group(frontend, block, selection,
                &select_group, bytes, &part, &work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part
                    || instructions > U32_MAX_VALUE - work) return measured < 0 ? measured : 0;
            bytes += part; instructions += work;
            pending &= ~select_group.members;
            selection->direct_nested_frame = 1u;
            continue;
        }
        if (standalone_flags_pending) {
            pl_u32 clobberers = 0u;
            for (pl_u32 local = 0u;
                    local < PL_X86_GPR_COUNT; ++local)
                if ((pending & (1u << local))
                        && frame_local_emission_clobbers_flags(
                            &block->plan, local))
                    clobberers |= 1u << local;
            if (!clobberers
                    && !(standalone_flags.owner_dependencies & pending)) {
                pl_u32 flag_bytes = 0u;
                if (!emit_standalone_flag_publication(
                        &standalone_flags, (pl_u8 *)0, &flag_bytes)
                        || bytes > U32_MAX_VALUE - flag_bytes
                        || instructions == U32_MAX_VALUE)
                    return 0;
                bytes += flag_bytes;
                ++instructions;
                standalone_flags_pending = 0;
                if (!pending) continue;
            }
        }
        shared_diamond_handoff diamond;
        if (shared_diamond_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &diamond)) {
            pl_u32 parent_bytes = 0u, parent_work = 0u;
            int measured = measure_alu_tree(
                frontend, block, selection, diamond.parent_owner,
                diamond.parent, diamond.bits, bytes,
                block->plan.node_count + 1u, 0u,
                &parent_bytes, &parent_work);
            pl_operand parent = {
                PL_OPERAND_LOCAL, diamond.parent_owner,
            };
            pl_u32 side_bytes = 0u, publish_bytes = 0u;
            pl_u32 shift_bytes = 0u, root_bytes = 0u;
            if (measured <= 0
                    || !emit_alu_instruction(
                        diamond.side_owner, parent, diamond.bits,
                        diamond.side_mode, 0u,
                        (pl_u8 *)0, &side_bytes)
                    || !emit_gpr_move(
                        diamond.root, diamond.side_owner, diamond.bits,
                        (pl_u8 *)0, &publish_bytes)
                    || !emit_shift_instruction(
                        diamond.parent_owner, diamond.shift_amount,
                        diamond.bits, diamond.shift_group,
                        (pl_u8 *)0, &shift_bytes)
                    || !emit_alu_instruction(
                        diamond.root, parent, diamond.bits,
                        diamond.root_mode, 0u,
                        (pl_u8 *)0, &root_bytes)
                    || parent_bytes > U32_MAX_VALUE - side_bytes
                    || parent_bytes + side_bytes
                       > U32_MAX_VALUE - publish_bytes
                    || parent_bytes + side_bytes + publish_bytes
                       > U32_MAX_VALUE - shift_bytes
                    || parent_bytes + side_bytes + publish_bytes
                       + shift_bytes > U32_MAX_VALUE - root_bytes
                    || parent_work > U32_MAX_VALUE - 4u)
                return measured < 0 ? measured : 0;
            pl_u32 group_bytes = parent_bytes + side_bytes + publish_bytes
                               + shift_bytes + root_bytes;
            if (bytes > U32_MAX_VALUE - group_bytes
                    || instructions > U32_MAX_VALUE - (parent_work + 4u))
                return PL_ERROR_X86_SELECT;
            bytes += group_bytes;
            instructions += parent_work + 4u;
            pl_u32 group_span = node_wave_depth(
                &block->plan, block->plan.locals[diamond.root]);
            if (group_span == U32_MAX_VALUE)
                return PL_ERROR_X86_SELECT;
            ++group_span;
            if (group_span > span) span = group_span;
            pending &= ~(1u << diamond.root);
            selection->direct_nested_frame = 1u;
            continue;
        }
        arithmetic_width_handoff width_handoff;
        if (arithmetic_width_handoff_shape(
                &block->plan, pending, frame_sources,
                frame_dependencies, &width_handoff)) {
            pl_u32 scratch_mask = alu_frame_scratch_mask(
                pending, width_handoff.parent_destination,
                frame_sources);
            scratch_mask &= ~((1u << width_handoff.parent_destination)
                            | (1u << width_handoff.wide_destination)
                            | (1u << width_handoff.narrow_destination));
            pl_u32 parent_bytes = 0u, parent_work = 0u;
            int measured = measure_alu_tree(
                frontend, block, selection,
                width_handoff.wide_destination, width_handoff.parent,
                64u, bytes, block->plan.node_count + 1u, scratch_mask,
                &parent_bytes, &parent_work);
            pl_u32 publish_bytes = 0u, operation_bytes = 0u;
            pl_u32 narrow_bytes = 0u;
            if (measured <= 0
                    || !emit_gpr_move(
                        width_handoff.parent_destination,
                        width_handoff.wide_destination, 64u,
                        (pl_u8 *)0, &publish_bytes)
                    || !emit_alu_instruction(
                        width_handoff.wide_destination,
                        width_handoff.right, 64u, width_handoff.mode, 0u,
                        (pl_u8 *)0, &operation_bytes)
                    || !emit_gpr_move(
                        width_handoff.narrow_destination,
                        width_handoff.wide_destination, 32u,
                        (pl_u8 *)0, &narrow_bytes)
                    || parent_bytes > U32_MAX_VALUE - publish_bytes
                    || parent_bytes + publish_bytes
                       > U32_MAX_VALUE - operation_bytes
                    || parent_bytes + publish_bytes + operation_bytes
                       > U32_MAX_VALUE - narrow_bytes
                    || parent_work > U32_MAX_VALUE - 3u)
                return measured < 0 ? measured : 0;
            pl_u32 group_bytes = parent_bytes + publish_bytes
                               + operation_bytes + narrow_bytes;
            if (bytes > U32_MAX_VALUE - group_bytes
                    || instructions > U32_MAX_VALUE - (parent_work + 3u))
                return PL_ERROR_X86_SELECT;
            bytes += group_bytes;
            instructions += parent_work + 3u;
            pl_u32 group_span = node_wave_depth(
                &block->plan, width_handoff.parent);
            if (parent_work > group_span) group_span = parent_work;
            if (group_span > U32_MAX_VALUE - 3u)
                return PL_ERROR_X86_SELECT;
            group_span += 3u;
            if (group_span > span) span = group_span;
            pending &= ~((1u << width_handoff.parent_destination)
                       | (1u << width_handoff.wide_destination)
                       | (1u << width_handoff.narrow_destination));
            selection->direct_nested_frame = 1u;
            continue;
        }
        shift_sibling_handoff handoff;
        if (shift_sibling_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, &handoff)) {
            pl_u32 part = 0u, part_work = 0u;
            if (handoff.scratch == PL_X86_GPR_COUNT) {
                if (!emit_gpr_move(
                        handoff.flag_destination, handoff.source,
                        handoff.bits, (pl_u8 *)0, &part)
                        || bytes > U32_MAX_VALUE - part)
                    return 0;
                bytes += part;
                ++instructions;
                if (!emit_shift_instruction(
                        handoff.sibling_destination,
                        handoff.sibling_amount, handoff.bits,
                        handoff.sibling_group, (pl_u8 *)0, &part)
                        || bytes > U32_MAX_VALUE - part)
                    return 0;
                bytes += part;
                ++instructions;
                if (!emit_shift_instruction(
                        handoff.flag_destination, handoff.flag_amount,
                        handoff.bits, handoff.flag_group,
                        (pl_u8 *)0, &part)
                        || bytes > U32_MAX_VALUE - part)
                    return 0;
                bytes += part;
                ++instructions;
                pending &= ~((1u << handoff.flag_destination)
                           | (1u << handoff.sibling_destination));
                selection->direct_nested_frame = 1u;
                continue;
            }
            int measured = measure_alu_tree(
                frontend, block, selection, handoff.scratch,
                handoff.sibling_value, handoff.bits, bytes,
                block->plan.node_count + 1u, 0u, &part, &part_work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            if (instructions > U32_MAX_VALUE - part_work)
                return PL_ERROR_X86_SELECT;
            instructions += part_work;
            measured = measure_alu_tree(
                frontend, block, selection, handoff.flag_destination,
                handoff.flag_value, handoff.bits, bytes,
                block->plan.node_count + 1u, 0u, &part, &part_work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            if (instructions > U32_MAX_VALUE - part_work)
                return PL_ERROR_X86_SELECT;
            instructions += part_work;
            if (!emit_gpr_move(
                    handoff.sibling_destination, handoff.scratch,
                    handoff.bits, (pl_u8 *)0, &part)
                    || bytes > U32_MAX_VALUE - part)
                return 0;
            bytes += part;
            ++instructions;
            measured = measure_frame_value(
                frontend, block, selection, handoff.scratch,
                block->plan.locals[handoff.scratch], bytes, &part);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part)
                return measured < 0 ? measured : 0;
            bytes += part;
            ++instructions;
            pending &= ~((1u << handoff.flag_destination)
                       | (1u << handoff.sibling_destination)
                       | (1u << handoff.scratch));
            selection->direct_nested_frame = 1u;
            continue;
        }
        pl_u32 local = 0u;
        if (!next_alu_frame_assignment(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &local)) {
            shared_root_unary_handoff root_handoff;
            if (shared_root_unary_handoff_shape(
                    &block->plan, pending, final_flag_node, &root_handoff)) {
                pl_u32 seed_bytes = 0u, seed_work = 0u, copy_bytes = 0u;
                pl_u32 op_a = 0u, op_b = 0u;
                int measured = measure_alu_tree(
                    frontend, block, selection, root_handoff.seed_dest,
                    root_handoff.seed, root_handoff.seed_bits, bytes,
                    block->plan.node_count + 1u, 0u, &seed_bytes, &seed_work);
                if (measured > 0
                        && emit_gpr_move(root_handoff.copy_dest,
                            root_handoff.seed_dest, root_handoff.bits,
                            0, &copy_bytes)
                        && emit_shared_root_consumer(
                            &root_handoff.dest_consumer, 0, &op_a)
                        && emit_shared_root_consumer(
                            &root_handoff.copy_consumer, 0, &op_b)
                        && seed_bytes <= U32_MAX_VALUE - copy_bytes
                        && seed_bytes + copy_bytes
                           <= U32_MAX_VALUE - op_a
                        && seed_bytes + copy_bytes + op_a
                           <= U32_MAX_VALUE - op_b
                        && seed_work <= U32_MAX_VALUE - 3u
                        && instructions
                           <= U32_MAX_VALUE - seed_work - 3u) {
                    bytes += seed_bytes + copy_bytes + op_a + op_b;
                    instructions += seed_work + 3u;
                    pending &= ~((1u << root_handoff.seed_dest)
                               | (1u << root_handoff.copy_dest));
                    selection->direct_nested_frame = 1u;
                    continue;
                }
                if (measured < 0) return measured;
            }
            pl_u32 first = 0u;
            while (first < PL_X86_GPR_COUNT
                    && !(pending & (1u << first)))
                ++first;
            selection->blocking_work = 0x200u | first;
            selection->blocking_opcode = first < PL_X86_GPR_COUNT
                ? frame_sources[first]
                  | (frame_dependencies[first] << 16u)
                : U32_MAX_VALUE;
            selection->projected_instruction_mask = pending;
            return 0;
        }
        pl_u32 scratch_mask = alu_frame_scratch_mask(
            pending, local, frame_sources);
        pl_u32 encoded = 0u;
        pl_u32 publication_work = 1u;
        pl_u32 publication_span = 1u;
        pl_operand value = block->plan.locals[local];
        masked_entry_affine entry_affine;
        pl_u32 publication = publication_owner(&block->plan, value);
        if (has_generation_join
                && local == generation_join.destination) {
            if (!emit_generation_join(&generation_join, 0, &encoded))
                return 0;
            publication_work = 1u + generation_join.tail_present;
            publication_span = publication_work;
        } else if (publication < PL_X86_GPR_COUNT
                && publication != local) {
            pl_u32 bits = publication_copy_bits(
                &block->plan, selection, value, bytes);
            pl_u32 move_bytes = 0u;
            if (!emit_gpr_move(
                    local, publication, bits,
                    (pl_u8 *)0, &move_bytes))
                return 0;
            encoded = move_bytes;
            if (value.kind == PL_OPERAND_CONST && !value.value) {
                pl_u32 zero_bytes = 0u;
                if (!emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes))
                    return 0;
                if (zero_bytes < encoded) encoded = zero_bytes;
            }
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            {
                pl_u32 destination, bits, mode, preserves_carry;
                pl_operand source;
                pl_operand right;
                if (bit_summary_details(&block->plan, value, &source, &bits, &mode)) {
                    physicalize_selected_operand(&block->plan, selection, local, &source);
                    pl_u32 source_local = local, prefix = 0u, work = 0u, operation = 0u;
                    if (source.kind == PL_OPERAND_LOCAL
                            && source.value < PL_X86_GPR_COUNT)
                        source_local = (pl_u32)source.value;
                    else if (measure_alu_tree(frontend, block, selection, local,
                            source, bits, bytes, block->plan.node_count + 1u,
                            scratch_mask, &prefix, &work) <= 0) return 0;
                    if (!emit_bit_summary(local, source_local, bits, mode, 0, &operation)
                            || prefix > U32_MAX_VALUE - operation
                            || work == U32_MAX_VALUE) return 0;
                    encoded = prefix + operation;
                    publication_work = work + 1u;
                } else {
                if (!alu_node_details(
                        &block->plan, (pl_u32)(value.value >> 8u),
                        &destination, &source, &right,
                        &bits, &mode, &preserves_carry)
                        || destination != local) {
                    selection->blocking_work = 0x100u | local;
                    return 0;
                }
                if (!preserves_carry && mode == 3u
                        && source.kind == PL_OPERAND_CONST && !source.value
                        && right.kind == PL_OPERAND_LOCAL
                        && right.value == local) {
                    if (!emit_neg_register(
                            local, bits, 0, &encoded))
                        return 0;
                    publication_work = 1u;
                } else {
                    int measured = measure_alu_pair(
                        frontend, block, selection, local, source, right,
                        bits, mode, preserves_carry, bytes,
                        block->plan.node_count + 1u, scratch_mask,
                        &encoded, &publication_work);
                    if (measured <= 0) {
                        selection->blocking_work = 0x200u | local;
                        return measured;
                    }
                }
                }
            }
        } else if (value.kind == PL_OPERAND_NODE) {
            value = publication_for_emission(
                &block->plan, value, final_flag_node);
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u;
            pl_operand identity_source = { 0 };
            pl_u32 add3_pair_node = 0u, add3_pair_local = 0u, add3_pair_bits = 0u;
            pl_operand add3_pair_remaining = { 0 };
            pl_operand shift_source, shift_amount;
            pl_u32 shift_group = 0u;
            conditional_select select;
            quotient_boundary_select boundary;
            carry_adjustment adjustment;
            pl_operand bit_source;
            pl_u32 bit = 0u;
            pl_operand flag_left, flag_right;
            pl_operand lane_inner;
            pl_u32 lane_width = 0u;
            pl_u64 lane_constant = 0u;
            pl_u32 flag_mode = 0u, preserves_carry = 0u;
            if (final_flag_node && value.value == final_flag_node
                    && alu_node_semantics(
                        &block->plan, final_flag_node, &flag_left,
                        &flag_right, &bits, &flag_mode,
                        &preserves_carry)) {
                int measured = measure_alu_pair(
                    frontend, block, selection, local,
                    flag_left, flag_right, bits, flag_mode,
                    preserves_carry, bytes,
                    block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x260u | local;
                    return measured;
                }
            } else if (final_flag_node && flag_value_operation_details(
                    &block->plan, final_flag_node, value,
                    &flag_left, &flag_right, &bits,
                    &flag_mode, &preserves_carry)) {
                int measured = measure_alu_pair(
                    frontend, block, selection, local,
                    flag_left, flag_right, bits, flag_mode,
                    preserves_carry, bytes,
                    block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x260u | local;
                    return measured;
                }
            } else if (final_flag_node
                    && !publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && masked_entry_affine_details(
                        &block->plan, value, local, &entry_affine)
                    && (scratch_mask & (1u << entry_affine.source))) {
                if (!emit_masked_entry_affine(
                        &entry_affine, (pl_u8 *)0,
                        &encoded, &publication_work))
                    return 0;
                selection->direct_nested_frame = 1u;
            } else if (final_flag_node
                    && !publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && single_bit_or_details(
                        &block->plan, value, &bit_source, &bits, &bit)) {
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = measure_alu_tree(
                    frontend, block, selection, local, bit_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                pl_u32 operation = 0u;
                if (measured <= 0
                        || !emit_bit_set_immediate(
                            local, bit, bits, (pl_u8 *)0, &operation)
                        || seed_bytes > U32_MAX_VALUE - operation
                        || seed_work == U32_MAX_VALUE) {
                    selection->blocking_work = 0x280u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + operation;
                publication_work = seed_work + 1u;
            } else if (final_flag_node
                    && !publication_is_flag_result(&block->plan, value, final_flag_node)
                    && !publication_emits_selected_flag(&block->plan, value, local, final_flag_node)
                    && carry_adjustment_details(&block->plan, value, local,
                        operand_fits_u32(&block->plan, value, block->plan.node_count + 1u)
                            ? 32u : 64u, &adjustment)) {
                if (!emit_carry_adjustment(&adjustment, local, 0,
                        &encoded, &publication_work)) return 0;
                selection->direct_nested_frame = 1u;
            } else if (quotient_boundary_select_details(
                    &block->plan, value, local, &boundary)) {
                int measured = measure_quotient_boundary_select(
                    frontend, block, selection, local, &boundary,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x2c0u | local;
                    return measured;
                }
            } else if (conditional_select_details_inner(
                    &block->plan, value, local, 1, &select)) {
                if (select.candidate_local == local
                        || !conditional_compare_survives_current(
                            &select, local))
                    return 0;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = select.current_flag_node
                    ? measure_selected_flag_value(frontend, block, selection, local, &select,
                        bytes, block->plan.node_count + 1u, scratch_mask, &seed_bytes, &seed_work)
                    : measure_alu_tree(
                    frontend, block, selection, local, current,
                    select.value_bits, bytes,
                    block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                /* Seed the compare operand(s) before the true-arm candidate,
                 * mirroring the write path exactly: the seed resolves the
                 * `current` value through `local` and the candidate then reuses
                 * the coordinate the seed finishes with. */
                pl_x86_native_selection seed_state = *selection;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && current.value)
                    push_frame_value_alias(
                        &seed_state, (pl_u8)current.kind, current.value,
                        (pl_u8)local);
                pl_u32 used = scratch_mask & ~(1u << local);
                pl_u32 cand_local = select.candidate_local;
                if (!select.candidate_immediate
                        && cand_local < PL_X86_GPR_COUNT)
                    used &= ~(1u << cand_local);
                pl_u32 cand_bytes = 0u, cand_work = 0u;
                pl_u32 compare_bytes = 0u, move_bytes = 0u;
                pl_u32 compare_seed_bytes = 0u, compare_seed_work = 0u;
                if (measured > 0
                        && (select.compare_left_seed
                            || select.compare_right_seed)) {
                    if (select.compare_left_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        pl_u32 part = 0u, work = 0u;
                        if (scratch >= PL_X86_GPR_COUNT
                                || measure_alu_tree(
                                    frontend, block, &seed_state, scratch,
                                    select.compare_left_value,
                                    select.compare_bits,
                                    bytes + seed_bytes,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    &part, &work) <= 0)
                            measured = 0;
                        else {
                            used &= ~(1u << scratch);
                            select.compare_left_local = scratch;
                            compare_seed_bytes += part;
                            compare_seed_work += work;
                        }
                    }
                    if (measured > 0 && select.compare_right_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        pl_u32 part = 0u, work = 0u;
                        if (scratch >= PL_X86_GPR_COUNT
                                || measure_alu_tree(
                                    frontend, block, &seed_state, scratch,
                                    select.compare_right_value,
                                    select.compare_bits,
                                    bytes + seed_bytes + compare_seed_bytes,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    &part, &work) <= 0)
                            measured = 0;
                        else {
                            used &= ~(1u << scratch);
                            select.compare_right.kind = PL_OPERAND_LOCAL;
                            select.compare_right.value = scratch;
                            compare_seed_bytes += part;
                            compare_seed_work += work;
                        }
                    }
                }
                if (measured > 0 && select.candidate_immediate) {
                    cand_local = PL_X86_GPR_COUNT;
                    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                            ++scratch)
                        if (scratch != local
                                && (used & (1u << scratch))) {
                            cand_local = scratch;
                            break;
                        }
                    if (cand_local >= PL_X86_GPR_COUNT) {
                        selection->blocking_work = 0x300u | local;
                        return 0;
                    }
                    measured = measure_alu_tree(
                        frontend, block, selection, cand_local,
                        select.candidate_value, select.value_bits,
                        bytes + seed_bytes + compare_seed_bytes,
                        block->plan.node_count + 1u,
                        used & ~(1u << cand_local),
                        &cand_bytes, &cand_work);
                }
                pl_u32 emit_compare = select.has_compare
                    && (select.compare_node != final_flag_node
                        || !flag_node_has_value_publication(
                            &block->plan, changed, final_flag_node));
                int compared = !emit_compare
                    || emit_select_compare(&select, 0, &compare_bytes);
                if (measured <= 0 || !compared
                        || !emit_conditional_move(
                            local, cand_local,
                            select.value_bits, select.condition,
                            (pl_u8 *)0, &move_bytes)
                        || seed_bytes > U32_MAX_VALUE - cand_bytes
                        || seed_bytes + cand_bytes
                           > U32_MAX_VALUE - compare_seed_bytes
                        || seed_bytes + cand_bytes + compare_seed_bytes
                           > U32_MAX_VALUE - compare_bytes
                        || seed_bytes + cand_bytes + compare_seed_bytes
                           + compare_bytes > U32_MAX_VALUE - move_bytes
                        || cand_work > U32_MAX_VALUE - seed_work
                        || cand_work + seed_work
                           > U32_MAX_VALUE - compare_seed_work) {
                    selection->blocking_work = 0x300u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + cand_bytes + compare_seed_bytes
                        + compare_bytes + move_bytes;
                publication_work = seed_work + cand_work + compare_seed_work
                                 + 1u + emit_compare;
            } else if (sign_high_node_details(
                    &block->plan, value, &source, &bits)) {
                if (!emit_sign_high(
                        local, source, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (masked_shift_count_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group) && local != 1u) {
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = measure_alu_tree(
                    frontend, block, selection, local, shift_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                pl_u32 count_bytes = 0u, count_work = 0u;
                if (measured > 0)
                    measured = measure_alu_tree(
                        frontend, block, selection, 1u, shift_amount, 32u,
                        bytes + seed_bytes, block->plan.node_count + 1u,
                        scratch_mask & ~(1u << 1u),
                        &count_bytes, &count_work);
                pl_u32 shift_bytes = 0u;
                if (measured <= 0
                        || !emit_shift_instruction(
                            local, (pl_operand){ PL_OPERAND_LOCAL, 1u },
                            bits, shift_group, (pl_u8 *)0, &shift_bytes)
                        || bytes > U32_MAX_VALUE - seed_bytes
                        || seed_bytes > U32_MAX_VALUE - count_bytes
                        || seed_bytes + count_bytes
                           > U32_MAX_VALUE - shift_bytes
                        || seed_work > U32_MAX_VALUE - count_work
                        || seed_work + count_work == U32_MAX_VALUE) {
                    selection->blocking_work = 0x400u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + count_bytes + shift_bytes;
                publication_work = seed_work + count_work + 1u;
            } else if (shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                int measured = measure_alu_tree(
                    frontend, block, selection, local, shift_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &seed_bytes, &seed_work);
                pl_u32 shift_bytes = 0u;
                if (measured <= 0
                        || !emit_shift_instruction(
                            local, shift_amount, bits, shift_group,
                            (pl_u8 *)0, &shift_bytes)
                        || seed_bytes > U32_MAX_VALUE - shift_bytes) {
                    selection->blocking_work = 0x400u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + shift_bytes;
                publication_work = seed_work + 1u;
            } else if (shared_dag_add3_published_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_local, &add3_pair_remaining, &add3_pair_bits)) {
                pl_operand pair = { PL_OPERAND_LOCAL, add3_pair_local };
                int measured = measure_alu_pair(
                    frontend, block, selection, local, pair,
                    add3_pair_remaining, add3_pair_bits, 1u, 0u,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
            } else if (shared_dag_add3_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_node, &add3_pair_remaining, &add3_pair_bits)) {
                /* An ADD3 whose two operands are already an earlier binary ADD
                 * shares that sum.  Take it before the affine LEA, which would
                 * otherwise rebuild the shared pair inside this tree and cost
                 * the shared producer twice.  When another pending publication
                 * needs the same pair as its destructive arm, build the pair in
                 * that consumer's coordinate so both publications share one
                 * materialization. */
                pl_operand pair = { PL_OPERAND_NODE, add3_pair_node };
                pl_u32 consumer = alu_add3_pair_consumer(
                    &block->plan, pending, add3_pair_node, local);
                int share_pair = consumer < PL_X86_GPR_COUNT
                    && (scratch_mask & (1u << consumer))
                    && add3_pair_remaining.kind == PL_OPERAND_LOCAL
                    && add3_pair_remaining.value < PL_X86_GPR_COUNT;
                pl_operand pair_left = share_pair
                    ? add3_pair_remaining : pair;
                pl_operand pair_right = share_pair
                    ? pair : add3_pair_remaining;
                int measured = measure_alu_pair(
                    frontend, block, selection, local, pair_left,
                    pair_right, add3_pair_bits, 1u, 0u,
                    bytes, block->plan.node_count + 1u,
                    share_pair ? (1u << consumer) : scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
                if (share_pair)
                    push_frame_value_alias(
                        selection, PL_OPERAND_NODE, add3_pair_node,
                        (pl_u8)consumer);
            } else if (collect_native_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form, &bits)) {
                if (!emit_affine_lea_width(
                        local, form, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (sign_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!emit_sign_extend_move(
                        local, source, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (zero_extend_high8_node(
                    &block->plan, (pl_u32)value.value, &source)) {
                if (!emit_zero_extend_high8(
                        local, source, (pl_u8 *)0, &encoded))
                    return 0;
                selection->direct_nested_frame = 1u;
            } else if (zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!emit_zero_extend_move(
                        local, source, bits, (pl_u8 *)0, &encoded))
                    return 0;
            } else if (zero_extend_operand(
                    &block->plan, (pl_u32)value.value, &lane_inner, &lane_width)
                    && lane_width == 32u) {
                /* A 32-bit zero extension of an inner value with no
                 * publication of its own: the inner is materialised at 32-bit
                 * width, and that register write is the zero extension. */
                int measured = measure_alu_tree(
                    frontend, block, selection, local, lane_inner, 32u,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
            } else if (in_place_lane_insert(
                    &block->plan, value, local, &lane_inner, &lane_width)) {
                int measured = measure_alu_tree(
                    frontend, block, selection, local, lane_inner, lane_width,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
            } else if (lane_constant_insert(
                    &block->plan, value, local, &lane_constant, &lane_width)) {
                if (!emit_lane_constant_move(
                        local, lane_constant, lane_width, (pl_u8 *)0, &encoded))
                    return 0;
                publication_work = 1u;
            } else if (value.kind == PL_OPERAND_NODE && value.value
                    && value.value <= block->plan.node_count
                    && (block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE32_BSWAP
                        || block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE64_BSWAP)) {
                pl_u32 bswap_bits = block->plan.nodes[value.value - 1u].opcode
                                  == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
                pl_operand source_operand = block->plan.arguments[
                    block->plan.nodes[value.value - 1u].argument_at];
                pl_u32 seed_bytes = 0u, seed_work = 0u, bswap_bytes = 0u;
                int measured = measure_alu_tree(
                    frontend, block, selection, local, source_operand,
                    bswap_bits, bytes, block->plan.node_count + 1u,
                    scratch_mask, &seed_bytes, &seed_work);
                if (measured <= 0
                        || !emit_bswap_register(
                            local, bswap_bits, (pl_u8 *)0, &bswap_bytes)
                        || bytes > U32_MAX_VALUE - seed_bytes
                        || seed_bytes > U32_MAX_VALUE - bswap_bytes
                        || seed_work == U32_MAX_VALUE) {
                    selection->blocking_work = 0x600u | local;
                    return measured < 0 ? measured : 0;
                }
                encoded = seed_bytes + bswap_bytes;
                publication_work = seed_work + 1u;
            } else if ((pl_u32)value.value != final_flag_node
                    && lane_identity_mask_details(
                        &block->plan, value, &identity_source, &bits)) {
                int measured = measure_alu_tree(
                    frontend, block, selection, local, identity_source, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &encoded, &publication_work);
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    return measured;
                }
            } else {
                bits = operand_expression_bits(&block->plan, value, 0u);
                if (!bits) {
                    selection->blocking_work = 0x500u | local;
                    return 0;
                }
                pl_u32 root_sources = 0u;
                pl_x86_native_selection checkpoint = *selection;
                pl_x86_native_selection owner_choice = checkpoint;
                pl_u32 owner_bytes = 0u, owner_work = 0u;
                int owner_measured = 0;
                if (operand_entry_gpr_sources(
                        &block->plan, value,
                        block->plan.node_count + 1u,
                        block->plan.node_count + 1u, &root_sources)
                        && !(root_sources & (1u << local))) {
                    for (pl_u32 owner = 0u;
                            owner < PL_X86_GPR_COUNT; ++owner) {
                        pl_u32 owner_bit = 1u << owner;
                        if (!(scratch_mask & owner_bit)
                                || !(root_sources & owner_bit))
                            continue;
                        pl_x86_native_selection trial = checkpoint;
                        pl_u32 tree_bytes = 0u, tree_work = 0u;
                        int trial_measured = measure_alu_tree(
                            frontend, block, &trial, owner, value, bits,
                            bytes, block->plan.node_count + 1u,
                            scratch_mask & ~owner_bit,
                            &tree_bytes, &tree_work);
                        pl_u32 move_bytes = 0u;
                        if (trial_measured > 0
                                && emit_gpr_move(
                                    local, owner, bits,
                                    (pl_u8 *)0, &move_bytes)
                                && tree_bytes
                                   <= U32_MAX_VALUE - move_bytes
                                && tree_work != U32_MAX_VALUE) {
                            owner_bytes = tree_bytes + move_bytes;
                            owner_work = tree_work + 1u;
                            trial.direct_nested_frame = 1u;
                            owner_choice = trial;
                            owner_measured = 1;
                            break;
                        }
                        if (trial_measured < 0) return trial_measured;
                    }
                }
                pl_x86_native_selection direct_choice = checkpoint;
                pl_u32 direct_bytes = 0u, direct_work = 0u;
                int direct_measured = measure_alu_tree(
                    frontend, block, &direct_choice, local, value, bits,
                    bytes, block->plan.node_count + 1u, scratch_mask,
                    &direct_bytes, &direct_work);
                if (direct_measured < 0) return direct_measured;
                int measured = owner_measured || direct_measured > 0;
                if (direct_measured > 0
                        && (!owner_measured || direct_work < owner_work)) {
                    direct_choice.frame_direct_destination_mask |=
                        1u << local;
                    direct_choice.direct_nested_frame = 1u;
                    *selection = direct_choice;
                    encoded = direct_bytes;
                    publication_work = direct_work;
                } else if (owner_measured) {
                    *selection = owner_choice;
                    encoded = owner_bytes;
                    publication_work = owner_work;
                }
                if (measured <= 0) {
                    selection->blocking_work = 0x600u | local;
                    selection->projected_instruction_mask = scratch_mask;
                    return measured;
                }
            }
        } else {
            int measured = measure_frame_value(
                frontend, block, selection, local, value, bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        if (instructions > U32_MAX_VALUE - publication_work)
            return PL_ERROR_X86_SELECT;
        instructions += publication_work;
        pl_u32 wave_depth = node_wave_depth(&block->plan, value);
        if (wave_depth > publication_span) publication_span = wave_depth;
        if (publication_work > publication_span)
            publication_span = publication_work;
        if (publication_span > span) span = publication_span;
        pending &= ~(1u << local);
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    pl_u32 changed;
    pl_u32 left;
    pl_operand right;
    pl_u32 bits;
    pl_u32 condition;
    pl_u32 test;
} compare_branch_operands;

static int compare_branch_operand_shape(
    const pl_x86_block *block, compare_branch_operands *out)
{
    if (!block || !out
            || block->flow != PL_X86_FLOW_CONDITIONAL
            || !block->has_predicate || block->dynamic_target
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 2u
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > block->plan.node_count
            || block->predicate.kind != PL_OPERAND_PROJECTION
            || (block->predicate.value >> 8u) != flags.value
            || (block->predicate.value & 0xffu) > 15u)
        return 0;
    const pl_node *compare = &block->plan.nodes[flags.value - 1u];
    if ((compare->opcode != PL_OPCODE_X86_COMPARE
            && compare->opcode != PL_OPCODE_X86_TEST)
            || compare->argument_count != 4u
            || compare->argument_at > block->plan.argument_count
            || compare->argument_count
               > block->plan.argument_count - compare->argument_at)
        return 0;
    const pl_operand *arguments =
        block->plan.arguments + compare->argument_at;
    if (arguments[3].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = arguments[3].value;
    out->bits = (pl_u32)(descriptor & 0x7fu);
    out->test = compare->opcode == PL_OPCODE_X86_TEST;
    if ((out->bits != 8u && out->bits != 16u
            && out->bits != 32u && out->bits != 64u)
            || (!out->test && ((descriptor >> 8u) & 7u) != 3u)
            || (descriptor >> 11u))
        return 0;
    out->left = PL_X86_GPR_COUNT;
    out->right = arguments[2];
    if (arguments[1].kind == PL_OPERAND_LOCAL
            && arguments[1].value < PL_X86_GPR_COUNT) {
        pl_u32 identity = (pl_u32)arguments[1].value;
        pl_operand publication = block->plan.locals[identity];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == identity)
            out->left = identity;
    }
    if (out->right.kind == PL_OPERAND_LOCAL
            && arguments[2].value < PL_X86_GPR_COUNT) {
        pl_u32 identity = (pl_u32)arguments[2].value;
        pl_operand publication = block->plan.locals[identity];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == identity)
            out->right.value = identity;
        else
            out->right.value = PL_X86_GPR_COUNT;
    } else if (out->right.kind != PL_OPERAND_CONST) {
        out->right.kind = PL_OPERAND_LOCAL;
        out->right.value = PL_X86_GPR_COUNT;
    }
    out->changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand publication = block->plan.locals[local];
        if (!(publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)) {
            if (publication.kind != PL_OPERAND_CONST
                    && publication.kind != PL_OPERAND_NODE
                    && publication.kind != PL_OPERAND_PROJECTION
                    && (publication.kind != PL_OPERAND_LOCAL
                        || publication.value >= PL_X86_GPR_COUNT))
                return 0;
            out->changed |= 1u << local;
        }
        if (out->left == PL_X86_GPR_COUNT
                && publication.kind == arguments[1].kind
                && publication.value == arguments[1].value)
            out->left = local;
        if (out->right.kind == PL_OPERAND_LOCAL
                && out->right.value == PL_X86_GPR_COUNT
                && publication.kind == arguments[2].kind
                && publication.value == arguments[2].value)
            out->right.value = local;
    }
    out->condition = (pl_u32)(block->predicate.value & 0xffu);
    /* A constant already published in a GPR is also an exact operand.
     * Select its shorter encoding here, inside the one comparison grammar;
     * zero in RAX, for example, can beat a sign-extended CMP immediate. */
    if (out->left < PL_X86_GPR_COUNT && out->right.kind == PL_OPERAND_CONST) {
        pl_u32 shortest = U32_MAX_VALUE, encoded = 0u;
        if (out->test
                ? emit_test_operand(out->left, out->right, out->bits, 0, &encoded)
                : emit_compare_operand(out->left, out->right, out->bits, 0, &encoded))
            shortest = encoded;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand publication = block->plan.locals[local];
            if (publication.kind != arguments[2].kind
                    || publication.value != arguments[2].value) continue;
            pl_operand candidate = { PL_OPERAND_LOCAL, local };
            int emitted = out->test
                ? emit_test_operand(out->left, candidate, out->bits, 0, &encoded)
                : emit_compare_operand(out->left, candidate, out->bits, 0, &encoded);
            if (emitted && encoded < shortest) {
                out->right = candidate;
                shortest = encoded;
            }
        }
    }
    return out->left < PL_X86_GPR_COUNT
        && (out->right.kind == PL_OPERAND_CONST
            || (out->right.kind == PL_OPERAND_LOCAL
                && out->right.value < PL_X86_GPR_COUNT));
}

static int compare_branch_shape(const pl_x86_block *block, pl_u32 *changed,
                                pl_u32 *left, pl_u32 *right,
                                pl_u32 *bits, pl_u32 *condition,
                                pl_u32 *test)
{
    compare_branch_operands shape;
    if (!changed || !left || !right || !bits || !condition || !test
            || !compare_branch_operand_shape(block, &shape)
            || shape.right.kind != PL_OPERAND_LOCAL) return 0;
    *changed = shape.changed;
    *left = shape.left;
    *right = (pl_u32)shape.right.value;
    *bits = shape.bits;
    *condition = shape.condition;
    *test = shape.test;
    return 1;
}

static int compare_flag_prefix(const pl_plan *plan, pl_u8 *byte)
{
    if (!plan || !byte || plan->local_count <= PL_X86_RFLAGS_LOCAL)
        return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count)
        return 0;
    const pl_node *compare = &plan->nodes[flags.value - 1u];
    if ((compare->opcode != PL_OPCODE_X86_COMPARE
            && compare->opcode != PL_OPCODE_X86_TEST)
            || compare->argument_count != 4u
            || compare->argument_at > plan->argument_count
            || compare->argument_count
               > plan->argument_count - compare->argument_at)
        return 0;
    pl_operand root = plan->arguments[compare->argument_at];
    *byte = 0u;
    if (root.kind == PL_OPERAND_LOCAL
            && root.value == PL_X86_RFLAGS_LOCAL)
        return 1;
    if (root.kind != PL_OPERAND_NODE || !root.value
            || root.value > plan->node_count)
        return 0;
    const pl_node *prefix = &plan->nodes[root.value - 1u];
    if (prefix->argument_count != 2u
            || prefix->argument_at > plan->argument_count
            || prefix->argument_count
               > plan->argument_count - prefix->argument_at)
        return 0;
    pl_u32 semantic = prefix->opcode == PL_OPCODE_ALU_IMMEDIATE[1][0]
                    ? 0u
                    : prefix->opcode == PL_OPCODE_ALU_IMMEDIATE[1][3]
                    ? 3u : U32_MAX_VALUE;
    if (semantic == U32_MAX_VALUE) return 0;
    const pl_operand *argument =
        plan->arguments + prefix->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != PL_OPERAND_CONST)
        return 0;
    if (semantic == 0u
            && argument[1].value == ~(1ull << 10u)) {
        *byte = 0xfcu;
        return 1;
    }
    if (semantic == 3u && argument[1].value == (1ull << 10u)) {
        *byte = 0xfdu;
        return 1;
    }
    return 0;
}

static int operand_contains_value(const pl_plan *plan, pl_operand root,
                                  pl_operand value, pl_u32 remaining)
{
    if (!plan || !remaining) return 0;
    if (root.kind == value.kind && root.value == value.value) return 1;
    pl_u32 node_number = root.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(root.value >> 8u)
                       : root.kind == PL_OPERAND_NODE
                       ? (pl_u32)root.value : 0u;
    if (!node_number || node_number > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    for (pl_u32 at = 0u; at < node->argument_count; ++at)
        if (operand_contains_value(
                plan, plan->arguments[node->argument_at + at], value,
                remaining - 1u))
            return 1;
    return 0;
}

static int subtract_tree_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *left, pl_operand *right,
                                 pl_u32 *bits)
{
    if (!plan || !left || !right || !bits
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[0][2]
            || node->opcode == PL_OPCODE_ALU_REGISTER[0][2]) {
        *bits = 32u;
    } else if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[1][2]
            || node->opcode == PL_OPCODE_ALU_REGISTER[1][2]) {
        *bits = 64u;
    } else {
        return 0;
    }
    *left = plan->arguments[node->argument_at];
    *right = plan->arguments[node->argument_at + 1u];
    return 1;
}

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 scratch;
    pl_u32 producers;
    pl_u32 bits;
    pl_operand right;
} subtract_handoff;

/* If `owner - rhs` is published both to owner and to another GPR, the other
 * output is the exact lifetime hole needed by x86's destructive form.  Build
 * rhs in that output, apply it once to owner, then copy the result back.  A
 * normalized subvalue of rhs which is itself published is scheduled first;
 * this is the physical cut which turns scaled SSA into one LEA without
 * retaining either a second rhs materialization or the source register
 * allocation. */
static int subtract_handoff_shape(const pl_plan *plan, pl_u32 changed,
                                  subtract_handoff *out)
{
    if (!plan || !out) return 0;
    for (pl_u32 owner = 0u; owner < PL_X86_GPR_COUNT; ++owner) {
        if (!(changed & (1u << owner))) continue;
        pl_operand result = plan->locals[owner];
        pl_operand left, right;
        pl_u32 bits = 0u;
        if (!subtract_tree_details(plan, result, &left, &right, &bits)
                || left.kind != PL_OPERAND_LOCAL
                || left.value != owner)
            continue;
        pl_u32 outputs = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand publication = plan->locals[local];
            if (publication.kind == result.kind
                    && publication.value == result.value)
                outputs |= 1u << local;
        }
        if (!(outputs & (1u << owner))
                || !(outputs & ~(1u << owner)))
            continue;
        pl_u32 plain = changed & ~outputs;
        /* Prefer a changed register whose entry value is the root of rhs and
         * whose final value is published only after the subtraction.  It is
         * a strictly better lifetime hole than an output register whenever
         * rhs can update it in place (for example `RAX &= mask`). */
        pl_u32 scratch = PL_X86_GPR_COUNT;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand entry = { PL_OPERAND_LOCAL, local };
            if (!(plain & (1u << local))
                    || !operand_contains_value(
                        plan, right, entry, plan->node_count + 1u))
                continue;
            pl_u32 final_sources = 0u;
            int found = conditional_select_gpr_sources(
                plan, plan->locals[local], local, &final_sources);
            if ((!found && !operand_gpr_sources(
                    plan, plan->locals[local], plan->node_count + 1u,
                    plan->node_count + 1u, &final_sources))
                    || (final_sources & (1u << local)))
                continue;
            scratch = local;
            break;
        }
        if (scratch == PL_X86_GPR_COUNT) {
            scratch = 0u;
            while (scratch < PL_X86_GPR_COUNT
                    && (!(outputs & (1u << scratch)) || scratch == owner))
                ++scratch;
        }
        if (scratch == PL_X86_GPR_COUNT) continue;
        int safe = 1;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(plain & (1u << local))) continue;
            pl_u32 sources = 0u;
            int found = conditional_select_gpr_sources(
                plan, plan->locals[local], local, &sources);
            if ((!found && !operand_gpr_sources(
                    plan, plan->locals[local], plan->node_count + 1u,
                    plan->node_count + 1u, &sources))
                    || (sources & outputs)
                    || (!(outputs & (1u << scratch))
                        && local != scratch
                        && (sources & (1u << scratch)))) {
                safe = 0;
                break;
            }
        }
        if (!safe) continue;
        pl_u32 producers = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(plain & (1u << local)) || local == scratch) continue;
            pl_operand publication = plan->locals[local];
            if ((publication.kind == PL_OPERAND_NODE
                    || publication.kind == PL_OPERAND_PROJECTION)
                    && operand_contains_value(
                        plan, right, publication,
                        plan->node_count + 1u))
                producers |= 1u << local;
        }
        out->owner = owner;
        out->outputs = outputs;
        out->scratch = scratch;
        out->producers = producers;
        out->bits = bits;
        out->right = right;
        return 1;
    }
    return 0;
}

static int next_compare_branch_assignment_excluding(const pl_plan *plan,
                                          pl_u32 pending,
                                          pl_u32 preferred,
                                          pl_u32 deferred,
                                          pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    pl_u32 frame_sources[PL_X86_GPR_COUNT];
    pl_u32 frame_dependencies[PL_X86_GPR_COUNT];
    if (!alu_frame_source_laws(
            plan, frame_sources, frame_dependencies))
        return 0;
    for (pl_u32 pass = 0u; pass < 2u; ++pass)
      for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        if (deferred & (1u << local)) continue;
        int is_preferred = !!(preferred & (1u << local));
        if ((!pass && !is_preferred) || (pass && is_preferred)) continue;
        pl_u32 effective_dependencies = frame_dependencies[local];
        pl_operand local_value = plan->locals[local];
        pl_u32 physical_owner = publication_owner(plan, local_value);
        if (local_value.kind == PL_OPERAND_CONST && !local_value.value
                && physical_owner < PL_X86_GPR_COUNT
                && physical_owner != local
                && frame_local_publication_clobbers_flags(plan, local))
            effective_dependencies &= ~(1u << physical_owner);
        if (effective_dependencies & pending) continue;
        pl_u32 used = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            used |= frame_sources[other];
        }
        pl_u32 dependencies = 0u;
        int conditional = conditional_select_publication_dependencies(
            plan, plan->locals[local], local, &dependencies);
        if (!(used & (1u << local))
                && (!conditional
                    || !(dependencies & pending & ~(1u << local)))) {
            *selected = local;
            return 1;
        }
      }
    return 0;
}

typedef struct {
    pl_u32 owner;
    pl_u32 consumer;
    pl_u32 plain;
    pl_u32 consumer_bits;
    conditional_select select;
    pl_operand consumer_right;
} transient_owner_frame;

static int next_compare_branch_assignment(const pl_plan *plan, pl_u32 pending,
                                          pl_u32 preferred, pl_u32 *selected)
{
    return next_compare_branch_assignment_excluding(plan, pending, preferred, 0u, selected);
}

typedef struct {
    pl_operand seed;
    pl_u32 seed_bits;
    pl_u32 seed_dest;
    pl_u32 copy_dest;
    pl_u32 bits;
    pl_operand amount[2];
    pl_u32 group[2];
} shared_root_shift_handoff;

/* Two pending publications that shift the same unpublished root, where the
 * root reads the entry values of exactly those two destinations:
 *
 *   seed = op(D2, D1)   D1 = seed >> k1   D2 = seed >> k2
 *
 * Neither destination may be published first under the ordinary anti-
 * dependency check (each reads the coordinate the other overwrites), yet the
 * source evaluates the seed once in one coordinate, copies it to the other,
 * and shifts each once.  Detect that pair so the caller can emit it. */
static int shared_root_shift_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                           shared_root_shift_handoff *out)
{
    if (!plan || !pending || !out) return 0;
    for (pl_u32 first = 0u; first < PL_X86_GPR_COUNT; ++first) {
        if (!(pending & (1u << first))) continue;
        pl_operand first_source, first_amount;
        pl_u32 first_bits = 0u, first_group = 0u;
        if (!shift_node_details(plan, plan->locals[first],
                &first_source, &first_amount, &first_bits, &first_group)
                || first_source.kind != PL_OPERAND_NODE
                || !first_source.value
                || first_source.value > plan->node_count)
            continue;
        for (pl_u32 second = first + 1u;
                second < PL_X86_GPR_COUNT; ++second) {
            if (!(pending & (1u << second))) continue;
            pl_operand second_source, second_amount;
            pl_u32 second_bits = 0u, second_group = 0u;
            if (!shift_node_details(plan, plan->locals[second],
                    &second_source, &second_amount, &second_bits, &second_group)
                    || second_source.kind != PL_OPERAND_NODE
                    || second_source.value != first_source.value
                    || second_bits != first_bits)
                continue;
            if (publication_owner(plan, first_source) < PL_X86_GPR_COUNT)
                continue;
            pl_operand left, right;
            pl_u32 seed_bits = 0u, seed_mode = 0u;
            if (!arithmetic_tree_details(plan, first_source, &left, &right,
                    &seed_bits, &seed_mode)
                    || seed_bits != first_bits)
                continue;
            pl_u32 seed_dest = PL_X86_GPR_COUNT;
            if (left.kind == PL_OPERAND_LOCAL && left.value == second
                    && right.kind == PL_OPERAND_LOCAL
                    && right.value == first) {
                seed_dest = second;
            } else if (associative_mode(seed_mode)
                    && left.kind == PL_OPERAND_LOCAL && left.value == first
                    && right.kind == PL_OPERAND_LOCAL
                    && right.value == second) {
                seed_dest = first;
            } else {
                continue;
            }
            out->seed = first_source;
            out->seed_bits = seed_bits;
            out->seed_dest = seed_dest;
            out->copy_dest = seed_dest == first ? second : first;
            out->bits = first_bits;
            if (seed_dest == first) {
                out->amount[0] = first_amount;
                out->group[0] = first_group;
                out->amount[1] = second_amount;
                out->group[1] = second_group;
            } else {
                out->amount[0] = second_amount;
                out->group[0] = second_group;
                out->amount[1] = first_amount;
                out->group[1] = first_group;
            }
            return 1;
        }
    }
    return 0;
}

static int next_transient_plain_assignment(const pl_plan *plan,
                                           pl_u32 pending,
                                           pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    pl_u32 needed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL) {
            if (value.value >= PL_X86_GPR_COUNT) return 0;
            needed |= 1u << (pl_u32)value.value;
        } else if (value.kind != PL_OPERAND_CONST) {
            return 0;
        }
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((pending & (1u << local)) && !(needed & (1u << local))) {
            *selected = local;
            return 1;
        }
    return 0;
}

/* A conditional publication may retain a pure intermediate while another
 * architectural result consumes that same value.  The normalized register
 * topology gives the intermediate to the conditional destination first,
 * derives the consumer from that one owner, then performs compare/CMOV last.
 * This is the exact destructive-register realization of the shared SSA DAG:
 * neither recomputing the intermediate nor preserving the source instruction
 * order is part of the accepted future. */
static int transient_owner_frame_shape(const pl_x86_block *block,
                                       transient_owner_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    if (!alu_frame_shape(&block->plan, &changed, &final_flag_node))
        return 0;
    for (pl_u32 owner = 0u; owner < PL_X86_GPR_COUNT; ++owner) {
        if (!(changed & (1u << owner))) continue;
        conditional_select select;
        if (!conditional_select_details(
                &block->plan, block->plan.locals[owner], owner, &select)
                || !select.has_compare
                || select.compare_test
                || select.compare_node != final_flag_node
                || (select.current.kind != PL_OPERAND_NODE
                    && select.current.kind != PL_OPERAND_PROJECTION)
                || select.candidate_local >= PL_X86_GPR_COUNT
                || (changed & (1u << select.candidate_local)))
            continue;
        pl_u32 consumer = select.compare_left_local;
        if (consumer >= PL_X86_GPR_COUNT || consumer == owner
                || !(changed & (1u << consumer)))
            continue;
        pl_operand left, right;
        pl_u32 bits = 0u, mode = 0u;
        if (!arithmetic_node_details(
                &block->plan, block->plan.locals[consumer],
                &left, &right, &bits, &mode)
                || mode != 1u || bits != select.value_bits
                || left.kind != select.current.kind
                || left.value != select.current.value)
            continue;
        pl_u32 plain = changed & ~(1u << owner) & ~(1u << consumer);
        pl_u32 current_sources = 0u;
        if (!operand_gpr_sources(
                &block->plan, select.current,
                block->plan.node_count + 1u,
                block->plan.node_count + 1u, &current_sources)
                || (current_sources & plain))
            continue;
        if (right.kind == PL_OPERAND_LOCAL
                && (right.value >= PL_X86_GPR_COUNT
                    || right.value == owner
                    || (plain & (1u << (pl_u32)right.value))))
            continue;
        if (right.kind != PL_OPERAND_LOCAL
                && right.kind != PL_OPERAND_CONST)
            continue;
        if (select.compare_right.kind == PL_OPERAND_LOCAL
                && (select.compare_right.value >= PL_X86_GPR_COUNT
                    || (select.compare_right.value != consumer
                        && (changed
                            & (1u << (pl_u32)select.compare_right.value)))))
            continue;
        pl_u32 pending = plain;
        while (pending) {
            pl_u32 local = 0u;
            if (!next_transient_plain_assignment(
                    &block->plan, pending, &local))
                break;
            pending &= ~(1u << local);
        }
        if (pending) continue;
        out->owner = owner;
        out->consumer = consumer;
        out->plain = plain;
        out->consumer_bits = bits;
        out->select = select;
        out->consumer_right = right;
        return 1;
    }
    return 0;
}

static int measure_direct_transient_owner_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    transient_owner_frame shape = { 0 };
    if (!transient_owner_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u;
    pl_u32 pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local))
            return 0;
        int measured = measure_frame_value(
            frontend, block, selection, local,
            block->plan.locals[local], bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    pl_u32 encoded = 0u, work = 0u;
    int measured = measure_alu_seed(
        frontend, block, selection, shape.owner, shape.select.current,
        shape.select.value_bits, bytes, block->plan.node_count + 1u,
        &encoded, &work);
    if (measured <= 0 || bytes > U32_MAX_VALUE - encoded)
        return measured < 0 ? measured : 0;
    bytes += encoded;
    instructions += work;
    pl_operand owner_value = { PL_OPERAND_LOCAL, shape.owner };
    if (!emit_add_lea(
            shape.consumer, owner_value, shape.consumer_right,
            shape.consumer_bits, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    if (!emit_compare_operand(
            shape.select.compare_left_local, shape.select.compare_right,
            shape.select.compare_bits, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    if (!emit_conditional_move(
            shape.owner, shape.select.candidate_local,
            shape.select.value_bits, shape.select.condition, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_transient_owner_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    pl_u32 zero;
    pl_u32 plain;
    pl_u32 anchor;
    pl_u32 flag_bits;
    /* At most one value publication may be the normalized single-bit
     * projection `((x >> p) & 1) << q` (optionally inverted).  It is emitted
     * as a self-zero, a bit test and a conditional move so its dependency
     * span is the two flag edges instead of the destructive shift tree's
     * copy/shift/mask/xor chain.  PL_X86_GPR_COUNT means absent. */
    pl_u32 projection;
    pl_operand projection_source;
    pl_u32 projection_from;
    pl_u32 projection_to;
    pl_u32 projection_inverse;
    pl_u32 projection_bits;
    pl_u32 projection_source_local;
    pl_u32 projection_input_local;
    pl_u32 projection_mask_local;
} zero_flag_frame;

static int zero_result_operand(const pl_plan *plan, pl_operand value)
{
    if (!plan) return 0;
    if (value.kind == PL_OPERAND_CONST) return value.value == 0u;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (value.kind == PL_OPERAND_NODE)
        return arithmetic_node_details(
                   plan, value, &left, &right, &bits, &mode)
            && mode == 6u && left.kind == right.kind
            && left.value == right.value;
    if (value.kind != PL_OPERAND_PROJECTION
            || (value.value & 0xffu) != 16u)
        return 0;
    pl_u32 node_number = (pl_u32)(value.value >> 8u);
    if (!node_number || node_number > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_X86_ALU
            || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[3].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[3].value;
    bits = (pl_u32)(descriptor & 0x7fu);
    mode = (pl_u32)((descriptor >> 8u) & 7u);
    return (bits == 32u || bits == 64u) && mode == 6u
        && descriptor == (pl_u64)(bits | (mode << 8u))
        && argument[1].kind == argument[2].kind
        && argument[1].value == argument[2].value;
}

/* Return the width of a flag producer whose complete defined flag word is
 * exactly the zero-result logical flag word.  The value topology may already
 * have folded away: flags are an independent architectural publication, not
 * a reason to retain a dead value node. */
static int zero_flag_node_details(const pl_plan *plan, pl_u32 node_number,
                                  pl_u32 *bits)
{
    if (!plan || !bits || !node_number || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    pl_u32 destination = 0u, mode = 0u, preserves_carry = 0u;
    pl_operand left, right;
    if (alu_node_details(
            plan, node_number, &destination, &left, &right,
            bits, &mode, &preserves_carry)) {
        if (preserves_carry || mode != 6u
                || left.kind != right.kind || left.value != right.value)
            return 0;
        *bits = 32u;
        return 1;
    }
    if (node->opcode == PL_OPCODE_X86_FLAGS) {
        if (node->argument_count != 5u
                || argument[4].kind != PL_OPERAND_CONST)
            return 0;
        pl_u64 descriptor = argument[4].value;
        pl_u32 width = (pl_u32)(descriptor & 0x7fu);
        pl_u32 flag_mode = (pl_u32)((descriptor >> 8u) & 7u);
        if ((width != 8u && width != 16u
                && width != 32u && width != 64u)
                || flag_mode != 6u || (descriptor >> 11u)
                || argument[1].kind != argument[2].kind
                || argument[1].value != argument[2].value
                || !zero_result_operand(plan, argument[3]))
            return 0;
        *bits = 32u;
        return 1;
    }
    if (node->opcode != PL_OPCODE_X86_SHIFT_FLAGS
            || node->argument_count != 5u
            || argument[3].kind != PL_OPERAND_CONST
            || argument[4].kind != PL_OPERAND_CONST
            || !zero_result_operand(plan, argument[1])
            || !zero_result_operand(plan, argument[2]))
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 width = (pl_u32)(descriptor & 0x7fu);
    pl_u32 group = (pl_u32)((descriptor >> 8u) & 7u);
    if ((width != 32u && width != 64u)
            || (group != 4u && group != 5u && group != 7u)
            || descriptor != (pl_u64)(width | (group << 8u))
            || !(argument[3].value & (width == 64u ? 63u : 31u)))
        return 0;
    *bits = 32u;
    return 1;
}

static int zero_plain_copy(const pl_plan *plan, pl_u32 local,
                           pl_u32 *source, pl_u32 *bits,
                           int *entry_source)
{
    if (!plan || !source || !bits || !entry_source
            || local >= PL_X86_GPR_COUNT)
        return 0;
    pl_operand value = plan->locals[local];
    if (value.kind == PL_OPERAND_LOCAL
            && value.value < PL_X86_GPR_COUNT
            && value.value != local) {
        *source = (pl_u32)value.value;
        *bits = 64u;
        *entry_source = 1;
        return 1;
    }
    if (value.kind == PL_OPERAND_NODE && zero_extend_node(
            plan, (pl_u32)value.value, source, bits)) {
        *entry_source = 1;
        return 1;
    }
    pl_u32 owner = publication_owner(plan, value);
    if (owner >= PL_X86_GPR_COUNT || owner == local) return 0;
    *source = owner;
    *bits = value.kind == PL_OPERAND_CONST
         && value.value <= 0xffffffffu ? 32u : 64u;
    *entry_source = 0;
    return 1;
}

static int next_zero_plain_assignment(const pl_plan *plan,
                                      pl_u32 pending,
                                      pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    pl_u32 old_sources = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL) {
            if (value.value >= PL_X86_GPR_COUNT) return 0;
            old_sources |= 1u << (pl_u32)value.value;
        } else if (value.kind == PL_OPERAND_NODE) {
            pl_u32 source = 0u, bits = 0u;
            if (!zero_extend_node(
                    plan, (pl_u32)value.value, &source, &bits))
                return 0;
            old_sources |= 1u << source;
        } else if (value.kind != PL_OPERAND_CONST) {
            return 0;
        }
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))
                || (old_sources & (1u << local)))
            continue;
        pl_u32 source = 0u, bits = 0u;
        int entry_source = 0;
        if (zero_plain_copy(
                plan, local, &source, &bits, &entry_source)
                && !entry_source && (pending & (1u << source)))
            continue;
        *selected = local;
        return 1;
    }
    return 0;
}

/* The normalized image of `select(1<<q, 0, (x & (1<<p)) != 0)` is
 * `((x >> p) & 1) << q`, spelled as SHL/SHR by |p-q|, AND with the single-bit
 * mask and, for the complemented zero test, XOR with the same mask.  Decode
 * that exact chain so it can be emitted as a bit test plus a conditional move.
 * The arithmetic spelling cannot reach the source span because a destructive
 * shift needs an entry copy first. */
static int bit_projection_value_details(
    const pl_plan *plan, pl_operand value, pl_operand *source,
    pl_u32 *from, pl_u32 *to, pl_u32 *inverse, pl_u32 *bits)
{
    if (!plan || !source || !from || !to || !inverse || !bits)
        return 0;
    pl_operand left, right, inner = value;
    pl_u32 width = 0u, mode = 0u;
    pl_u64 xor_mask = 0u;
    *inverse = 0u;
    if (!arithmetic_tree_details(
            plan, value, &left, &right, &width, &mode))
        return 0;
    if (mode == 6u) {
        if (right.kind != PL_OPERAND_CONST) return 0;
        xor_mask = right.value;
        inner = left;
        *inverse = 1u;
        if (!arithmetic_tree_details(
                plan, inner, &left, &right, &width, &mode))
            return 0;
    }
    if (mode != 0u || right.kind != PL_OPERAND_CONST) return 0;
    pl_u64 word = width == 64u ? ~0ull : 0xffffffffull;
    pl_u64 mask = right.value & word;
    if (!mask || (mask & (mask - 1u))) return 0;
    if (*inverse && (xor_mask & word) != mask) return 0;
    pl_operand shift_source, amount;
    pl_u32 shift_bits = 0u, group = 0u;
    if (!shift_node_details(
            plan, left, &shift_source, &amount, &shift_bits, &group)
            || shift_bits != width
            || amount.kind != PL_OPERAND_CONST
            || (group != 4u && group != 5u))
        return 0;
    pl_u32 q = 0u;
    while ((mask >> q) != 1u) ++q;
    pl_u32 k = (pl_u32)amount.value
             & (shift_bits == 64u ? 63u : 31u);
    if (!k) return 0;
    pl_u32 p = 0u;
    if (group == 4u) {
        if (q < k) return 0;
        p = q - k;
    } else {
        p = q + k;
        if (p >= shift_bits) return 0;
    }
    *source = shift_source;
    *from = p;
    *to = q;
    *bits = shift_bits;
    return 1;
}

/* XOR x,x has one observable flags result and the constant value zero.  Once
 * normalized, neither the source register nor the original destination is an
 * owner requirement.  Choose the shortest surviving zero publication as the
 * one flags-producing instruction and make every equal result a rank-only
 * copy.  This removes both old-value preservation and duplicate zero work. */
static int zero_flag_frame_shape(const pl_x86_block *block,
                                 zero_flag_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (!plan->node_count || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand flag_publication = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_publication.kind != PL_OPERAND_NODE
            || !flag_publication.value
            || flag_publication.value > plan->node_count)
        return 0;
    pl_u32 final_flag_node = (pl_u32)flag_publication.value;
    pl_u32 bits = 0u;
    if (!zero_flag_node_details(&block->plan, final_flag_node, &bits))
        return 0;
    pl_u32 zero = 0u, plain = 0u, anchor = PL_X86_GPR_COUNT;
    out->projection = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        pl_u32 plain_source = 0u, plain_bits = 0u;
        int zero_extend_plain = value.kind == PL_OPERAND_NODE
            && zero_extend_node(
                plan, (pl_u32)value.value,
                &plain_source, &plain_bits);
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (zero_result_operand(&block->plan, value)) {
            zero |= 1u << local;
            if (anchor >= PL_X86_GPR_COUNT
                    || (anchor >= 8u && local < 8u))
                anchor = local;
        } else if (value.kind == PL_OPERAND_CONST
                || (value.kind == PL_OPERAND_LOCAL
                    && value.value < PL_X86_GPR_COUNT)
                || zero_extend_plain) {
            plain |= 1u << local;
        } else {
            pl_operand source;
            pl_u32 from = 0u, to = 0u, inverse = 0u, projection_width = 0u;
            if (out->projection < PL_X86_GPR_COUNT
                    || !bit_projection_value_details(
                        plan, value, &source, &from, &to, &inverse,
                        &projection_width))
                return 0;
            out->projection = local;
            out->projection_source = source;
            out->projection_from = from;
            out->projection_to = to;
            out->projection_inverse = inverse;
            out->projection_bits = projection_width;
        }
    }
    for (pl_u32 local = PL_X86_GPR_COUNT;
            local < plan->local_count; ++local) {
        if (local == PL_X86_RFLAGS_LOCAL) continue;
        pl_operand value = plan->locals[local];
        if (value.kind != PL_OPERAND_LOCAL || value.value != local)
            return 0;
    }
    if (anchor >= PL_X86_GPR_COUNT) return 0;
    pl_u32 pending = plain;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_zero_plain_assignment(&block->plan, pending, &local))
            return 0;
        pending &= ~(1u << local);
    }
    if (out->projection < PL_X86_GPR_COUNT) {
        pl_operand mask_value = {
            PL_OPERAND_CONST, 1ull << out->projection_to };
        pl_operand input_value = {
            PL_OPERAND_CONST, 1ull << out->projection_from };
        if (!published_operand_local(
                plan, mask_value, &out->projection_mask_local)
                || !published_operand_local(
                    plan, input_value, &out->projection_input_local)
                || !(plain & (1u << out->projection_mask_local))
                || !(plain & (1u << out->projection_input_local))
                || out->projection_mask_local == out->projection
                || out->projection_input_local == out->projection)
            return 0;
        if (out->projection_source.kind == PL_OPERAND_LOCAL
                && out->projection_source.value < PL_X86_GPR_COUNT) {
            out->projection_source_local =
                (pl_u32)out->projection_source.value;
        } else if (!published_operand_local(
                       plan, out->projection_source,
                       &out->projection_source_local)) {
            return 0;
        }
        pl_u32 source = out->projection_source_local;
        pl_operand publication = plan->locals[source];
        int identity = publication.kind == PL_OPERAND_LOCAL
                    && publication.value == source;
        if (source == out->projection || (zero & (1u << source))
                || (!identity && !(plain & (1u << source))))
            return 0;
    }
    out->zero = zero;
    out->plain = plain;
    out->anchor = anchor;
    out->flag_bits = bits;
    return 1;
}

static int measure_direct_zero_flag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    zero_flag_frame shape = { 0 };
    if (!zero_flag_frame_shape(block, &shape)) return 0;
    pl_u32 bytes = 0u, instructions = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u, source = 0u, bits = 0u;
        int entry_source = 0;
        if (!next_zero_plain_assignment(&block->plan, pending, &local))
            return 0;
        int measured = zero_plain_copy(
                           &block->plan, local, &source, &bits,
                           &entry_source)
                     ? entry_source && bits < 64u
                       ? emit_zero_extend_move(
                           local, source, bits, 0, &encoded)
                       : emit_gpr_move(local, source, bits, 0, &encoded)
                     : measure_frame_value(
                           frontend, block, selection, local,
                           block->plan.locals[local], bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    if (shape.projection < PL_X86_GPR_COUNT) {
        pl_u32 projection_encoded = 0u;
        if (!emit_zero_register(shape.projection, 0, &projection_encoded)
                || bytes > U32_MAX_VALUE - projection_encoded)
            return 0;
        bytes += projection_encoded;
        ++instructions;
        if (!emit_test_registers(
                shape.projection_source_local, shape.projection_input_local,
                shape.projection_bits, 0, &projection_encoded)
                || bytes > U32_MAX_VALUE - projection_encoded)
            return 0;
        bytes += projection_encoded;
        ++instructions;
        if (!emit_conditional_move(
                shape.projection, shape.projection_mask_local, 64u,
                shape.projection_inverse ? 4u : 5u, 0, &projection_encoded)
                || bytes > U32_MAX_VALUE - projection_encoded)
            return 0;
        bytes += projection_encoded;
        ++instructions;
    }
    pl_u32 encoded = 0u;
    pl_operand self = { PL_OPERAND_LOCAL, shape.anchor };
    if (!emit_alu_instruction(
            shape.anchor, self, shape.flag_bits, 6u, 0u, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.anchor || !(shape.zero & (1u << local))) continue;
        if (!emit_gpr_move(local, shape.anchor, 32u, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_zero_flag_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.anchor;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 plain;
    pl_u32 bits;
    pl_u32 group;
    pl_operand amount;
} shift_handoff_frame;

/* A destructive shift may leave its original register with an unrelated
 * final value while publishing the shift result elsewhere.  Moving the entry
 * value to the final register first introduces an artificial wave.  Instead,
 * execute the shift in its entry coordinate, hand the result to every final
 * rank, then publish the overwrite.  For a nonzero constant count the shift
 * also rebases flags, so this order is both exact and span-minimal. */
static int shift_handoff_frame_shape(const pl_x86_block *block,
                                     shift_handoff_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (plan->node_count != 2u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand result = { PL_OPERAND_NODE, 1u };
    pl_operand source, amount;
    pl_u32 bits = 0u, group = 0u;
    if (!shift_node_details(
            plan, result, &source, &amount, &bits, &group)
            || source.kind != PL_OPERAND_LOCAL
            || source.value >= PL_X86_GPR_COUNT
            || amount.kind != PL_OPERAND_CONST
            || !(amount.value & (bits == 64u ? 63u : 31u))
            || (group != 4u && group != 5u && group != 7u))
        return 0;
    pl_u32 owner = (pl_u32)source.value;
    const pl_node *flags = &plan->nodes[1];
    if (flags->opcode != PL_OPCODE_X86_SHIFT_FLAGS
            || flags->argument_count != 5u
            || flags->argument_at > plan->argument_count
            || flags->argument_count
               > plan->argument_count - flags->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + flags->argument_at;
    pl_u64 descriptor = (pl_u64)bits | ((pl_u64)group << 8u);
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != source.kind
            || argument[1].value != source.value
            || argument[2].kind != result.kind
            || argument[2].value != result.value
            || argument[3].kind != amount.kind
            || argument[3].value != amount.value
            || argument[4].kind != PL_OPERAND_CONST
            || argument[4].value != descriptor)
        return 0;
    pl_operand flag_publication = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_publication.kind != PL_OPERAND_NODE
            || flag_publication.value != 2u)
        return 0;

    pl_u32 outputs = 0u, plain = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand publication = plan->locals[local];
        if (local == owner) {
            if (publication.kind != PL_OPERAND_CONST) return 0;
            continue;
        }
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (publication.kind == result.kind
                && publication.value == result.value) {
            outputs |= 1u << local;
        } else if (publication.kind == PL_OPERAND_CONST
                || (publication.kind == PL_OPERAND_LOCAL
                    && publication.value < PL_X86_GPR_COUNT)) {
            plain |= 1u << local;
        } else {
            return 0;
        }
    }
    if (!outputs) return 0;
    for (pl_u32 local = PL_X86_GPR_COUNT;
            local < plan->local_count; ++local) {
        if (local == PL_X86_RFLAGS_LOCAL) continue;
        pl_operand publication = plan->locals[local];
        if (publication.kind != PL_OPERAND_LOCAL
                || publication.value != local)
            return 0;
    }
    pl_u32 pending = plain;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_transient_plain_assignment(plan, pending, &local))
            return 0;
        pending &= ~(1u << local);
    }
    out->owner = owner;
    out->outputs = outputs;
    out->plain = plain;
    out->bits = bits;
    out->group = group;
    out->amount = amount;
    return 1;
}

static int measure_direct_shift_handoff_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    shift_handoff_frame shape = { 0 };
    if (!shift_handoff_frame_shape(block, &shape)) return 0;
    pl_u32 bytes = 0u, instructions = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local))
            return 0;
        int measured = measure_frame_value(
            frontend, block, selection, local,
            block->plan.locals[local], bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    pl_u32 encoded = 0u;
    if (!emit_shift_instruction(
            shape.owner, shape.amount, shape.bits, shape.group,
            0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (!emit_gpr_move(local, shape.owner, shape.bits, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    int measured = measure_frame_value(
        frontend, block, selection, shape.owner,
        block->plan.locals[shape.owner], bytes, &encoded);
    if (measured <= 0 || bytes > U32_MAX_VALUE - encoded)
        return measured < 0 ? measured : 0;
    bytes += encoded;
    ++instructions;
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shift_handoff_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.owner;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    pl_u32 owner;
    pl_u32 shared;
    pl_u32 shared_bits;
    pl_u32 owner_bits;
    pl_u32 owner_mode;
    pl_u32 owner_preserves_carry;
    pl_u32 compare_left;
    pl_u32 compare_right;
    pl_u32 compare_bits;
    pl_u32 condition;
    pl_u32 test;
    pl_u32 has_branch;
    pl_operand shared_value;
    pl_operand owner_right;
} shared_owner_frame;

/* A published intermediate need not be computed in its final register.
 * When a second publication consumes it and its leaf is that consumer's
 * entry register, let the consumer own the destructive chain first.  The
 * intermediate and the suffix then fan out in one wave instead of either
 * recomputing the prefix or serializing both publications. */
static int shared_owner_frame_shape(const pl_x86_block *block,
                                    shared_owner_frame *out)
{
    if (!block || !out) return 0;
    pl_u32 changed = 0u;
    pl_u32 final_flag_node = 0u;
    out->has_branch = (pl_u32)compare_branch_shape(
        block, &changed, &out->compare_left, &out->compare_right,
        &out->compare_bits, &out->condition, &out->test);
    pl_u8 flag_prefix = 0u;
    if (out->has_branch
            && (!compare_flag_prefix(&block->plan, &flag_prefix)
                || flag_prefix))
        return 0;
    if (!out->has_branch) {
        if (block->kind != PL_X86_BLOCK_DIRECT
                || block->flow != PL_X86_FLOW_NEXT
                || block->dynamic_target || block->has_predicate
                || block->has_fault_predicate
                || block->machine_operation != PL_X86_MACHINE_NONE
                || !alu_frame_shape(
                    &block->plan, &changed, &final_flag_node))
            return 0;
    }
    for (pl_u32 owner = 0u; owner < PL_X86_GPR_COUNT; ++owner) {
        if (!(changed & (1u << owner))) continue;
        pl_operand owner_value = block->plan.locals[owner];
        pl_operand owner_left;
        pl_u32 owner_node = owner_value.kind == PL_OPERAND_PROJECTION
                          ? (pl_u32)(owner_value.value >> 8u) : 0u;
        if (owner_node) {
            pl_u32 destination = 0u;
            if (!alu_node_details(
                    &block->plan, owner_node, &destination, &owner_left,
                    &out->owner_right, &out->owner_bits,
                    &out->owner_mode, &out->owner_preserves_carry)
                    || destination != owner
                    || (!out->has_branch && final_flag_node
                        && owner_node != final_flag_node))
                continue;
        } else {
            out->owner_preserves_carry = 0u;
            if (!arithmetic_node_details(
                    &block->plan, owner_value, &owner_left,
                    &out->owner_right, &out->owner_bits,
                    &out->owner_mode))
                continue;
        }
        if (owner_left.kind != PL_OPERAND_NODE) continue;
        for (pl_u32 shared = 0u; shared < PL_X86_GPR_COUNT; ++shared) {
            if (shared == owner || !(changed & (1u << shared))) continue;
            pl_operand shared_value = block->plan.locals[shared];
            if (shared_value.kind != owner_left.kind
                    || shared_value.value != owner_left.value)
                continue;
            if (changed != ((1u << owner) | (1u << shared)))
                continue;
            /* The suffix is evaluated after the shared register is
             * published and after the owner entry value is destroyed.  It
             * therefore may not name either entry coordinate directly. */
            if (out->owner_right.kind == PL_OPERAND_LOCAL
                    && (out->owner_right.value == owner
                        || out->owner_right.value == shared))
                continue;
            out->owner = owner;
            out->shared = shared;
            out->shared_bits = out->owner_bits;
            out->shared_value = shared_value;
            return 1;
        }
    }
    return 0;
}

static int measure_direct_shared_owner_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    shared_owner_frame shape = { 0 };
    if (!shared_owner_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u;
    pl_u32 encoded = 0u, work = 0u;
    int measured = measure_alu_seed(
        frontend, block, selection, shape.owner, shape.shared_value,
        shape.shared_bits, bytes, block->plan.node_count + 1u,
        &encoded, &work);
    if (measured <= 0) return measured;
    bytes += encoded;
    instructions += work;
    if (!emit_gpr_move(
            shape.shared, shape.owner, shape.shared_bits, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    if (!emit_alu_instruction(
            shape.owner, shape.owner_right, shape.owner_bits,
            shape.owner_mode, shape.owner_preserves_carry, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;

    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (shape.has_branch) {
        int flags_emitted = shape.test
            ? emit_test_registers(
                shape.compare_left, shape.compare_right,
                shape.compare_bits, 0, &encoded)
            : emit_compare_registers(
                shape.compare_left, shape.compare_right,
                shape.compare_bits, 0, &encoded);
        if (!flags_emitted || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
        pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + (block->relax_short_control ? 2u : 1u),
            bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shared_owner_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 bits;
    pl_u32 mode;
    pl_u32 preserves_carry;
    pl_u32 condition;
    pl_operand value;
    pl_operand left;
    pl_operand right;
} value_predicate_frame;

/* AND/OR/XOR define exactly the flags observed by TEST(result, result): SF,
 * ZF and PF come from the same result, CF and OF are zero, and AF is
 * undefined in both cases.  Once normalization has substituted the logical
 * result into the TEST, keeping a second flag producer is therefore not an
 * exact-future requirement.  Compute the shared value once, publish every
 * equal register result with flag-preserving MOVs, and consume the original
 * logical flags directly at the conditional cut. */
static int value_predicate_frame_shape(const pl_x86_block *block,
                                       value_predicate_frame *out)
{
    if (!block || !out) return 0;
    pl_u32 changed = 0u, compare_left = 0u, compare_right = 0u;
    pl_u32 compare_bits = 0u, condition = 0u, test = 0u;
    pl_u8 flag_prefix = 0u;
    if (!compare_branch_shape(
            block, &changed, &compare_left, &compare_right,
            &compare_bits, &condition, &test)
            || !test
            || !compare_flag_prefix(&block->plan, &flag_prefix)
            || flag_prefix)
        return 0;

    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    const pl_node *predicate = &block->plan.nodes[flags.value - 1u];
    const pl_operand *argument =
        block->plan.arguments + predicate->argument_at;
    pl_operand value = argument[1];
    if (value.kind != argument[2].kind || value.value != argument[2].value)
        return 0;

    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (value.kind == PL_OPERAND_NODE) {
        if (!arithmetic_node_details(
                &block->plan, value, &left, &right, &bits, &mode))
            return 0;
    } else if (value.kind == PL_OPERAND_PROJECTION
            && (value.value & 0xffu) == 16u) {
        pl_u32 destination = 0u;
        if (!alu_node_details(
                &block->plan, (pl_u32)(value.value >> 8u),
                &destination, &left, &right, &bits, &mode,
                &preserves_carry))
            return 0;
    } else {
        return 0;
    }
    if (preserves_carry || (mode != 0u && mode != 5u && mode != 6u))
        return 0;
    /* A 32-bit logical result is zero-extended when published to a 64-bit
     * GPR.  Its 64-bit TEST flags equal the producer's 32-bit flags only when
     * bit 31 is proved zero: ZF/PF are then unchanged and SF is zero at both
     * widths.  An AND with either constant mask clearing that bit is the exact
     * general certificate; do not infer it merely from this block's branch
     * condition because RFLAGS itself remains an architectural publication. */
    int same_flags = bits == compare_bits;
    if (!same_flags && bits == 32u && compare_bits == 64u && mode == 0u)
        same_flags = (left.kind == PL_OPERAND_CONST
                         && !(left.value & 0x80000000u))
                  || (right.kind == PL_OPERAND_CONST
                         && !(right.value & 0x80000000u));
    if (!same_flags) return 0;

    pl_u32 outputs = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand publication = block->plan.locals[local];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (publication.kind != value.kind || publication.value != value.value)
            return 0;
        outputs |= 1u << local;
    }
    for (pl_u32 local = PL_X86_GPR_COUNT;
            local < block->plan.local_count; ++local) {
        if (local == PL_X86_RFLAGS_LOCAL) continue;
        pl_operand publication = block->plan.locals[local];
        if (publication.kind != PL_OPERAND_LOCAL
                || publication.value != local)
            return 0;
    }
    pl_u32 owner = publication_owner(&block->plan, value);
    if (!outputs || outputs != changed || owner >= PL_X86_GPR_COUNT
            || !(outputs & (1u << owner))
            || (right.kind == PL_OPERAND_LOCAL && right.value == owner
                && !(left.kind == PL_OPERAND_LOCAL && left.value == owner)))
        return 0;

    out->owner = owner;
    out->outputs = outputs;
    out->bits = bits;
    out->mode = mode;
    out->preserves_carry = preserves_carry;
    out->condition = condition;
    out->value = value;
    out->left = left;
    out->right = right;
    return 1;
}

static int measure_direct_value_predicate_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    value_predicate_frame shape = { 0 };
    if (!value_predicate_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u, encoded = 0u, work = 0u;
    int measured = measure_alu_seed(
        frontend, block, selection, shape.owner, shape.left, shape.bits,
        bytes, block->plan.node_count + 1u, &encoded, &work);
    if (measured <= 0) return measured;
    bytes += encoded;
    instructions += work;
    if (!emit_alu_instruction(
            shape.owner, shape.right, shape.bits, shape.mode,
            shape.preserves_carry, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.owner || !(shape.outputs & (1u << local)))
            continue;
        if (!emit_gpr_move(local, shape.owner, shape.bits, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
    int status = append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        bytes + (block->relax_short_control ? 2u : 1u),
        bytes + branch_bytes, block->successor[0]);
    if (status) return status;
    bytes += branch_bytes;
    ++instructions;

    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_value_predicate_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

typedef struct {
    pl_u32 owner;
    pl_u32 outputs;
    pl_u32 bits;
    pl_u32 mode;
    pl_u32 condition;
    pl_u32 compare_left;
    pl_u32 compare_right;
    pl_u32 test;
    pl_operand transient;
    pl_operand replacement;
    pl_operand right;
} compare_handoff_frame;

/* A destructive ALU result can be published away from its entry register
 * while that entry register receives an independent final value.  Seeding the
 * final register first serializes the ALU behind an unnecessary MOV.  Execute
 * in the entry owner, hand the result to every equal publication with MOV,
 * then overwrite the owner from the independent SSA branch.  The final
 * CMP/TEST joins those parallel branches at their real dependency cut. */
static int compare_handoff_frame_shape(const pl_x86_block *block,
                                       compare_handoff_frame *out)
{
    if (!block || !out) return 0;
    pl_u32 changed = 0u, compare_left = 0u, compare_right = 0u;
    pl_u32 bits = 0u, condition = 0u, test = 0u;
    pl_u8 flag_prefix = 0u;
    if (!compare_branch_shape(
            block, &changed, &compare_left, &compare_right,
            &bits, &condition, &test)
            || !compare_flag_prefix(&block->plan, &flag_prefix)
            || flag_prefix)
        return 0;

    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    const pl_node *compare = &block->plan.nodes[flags.value - 1u];
    const pl_operand *argument = block->plan.arguments + compare->argument_at;
    for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
        pl_operand transient = argument[1u + orientation];
        pl_operand replacement = argument[2u - orientation];
        pl_operand left, right;
        pl_u32 transient_bits = 0u, mode = 0u;
        if (!arithmetic_node_details(
                &block->plan, transient, &left, &right,
                &transient_bits, &mode)
                || transient_bits != bits
                || left.kind != PL_OPERAND_LOCAL
                || left.value >= PL_X86_GPR_COUNT)
            continue;
        pl_u32 owner = (pl_u32)left.value;
        pl_operand owner_publication = block->plan.locals[owner];
        if (owner_publication.kind != replacement.kind
                || owner_publication.value != replacement.value)
            continue;
        if (bits == 32u
                && !operand_fits_u32(
                    &block->plan, replacement,
                    block->plan.node_count + 1u))
            continue;

        pl_u32 outputs = 0u;
        int valid = 1;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand publication = block->plan.locals[local];
            if (local == owner) continue;
            if (publication.kind == PL_OPERAND_LOCAL
                    && publication.value == local)
                continue;
            if (publication.kind == transient.kind
                    && publication.value == transient.value) {
                outputs |= 1u << local;
            } else {
                valid = 0;
                break;
            }
        }
        if (!valid || !outputs
                || changed != (outputs | (1u << owner)))
            continue;
        for (pl_u32 local = PL_X86_GPR_COUNT;
                valid && local < block->plan.local_count; ++local) {
            if (local == PL_X86_RFLAGS_LOCAL) continue;
            pl_operand publication = block->plan.locals[local];
            if (publication.kind != PL_OPERAND_LOCAL
                    || publication.value != local)
                valid = 0;
        }
        pl_u32 replacement_sources = 0u;
        if (!valid || !operand_gpr_sources(
                &block->plan, replacement,
                block->plan.node_count + 1u,
                block->plan.node_count + 1u, &replacement_sources)
                || (replacement_sources & (outputs | (1u << owner))))
            continue;

        out->owner = owner;
        out->outputs = outputs;
        out->bits = bits;
        out->mode = mode;
        out->condition = condition;
        out->compare_left = compare_left;
        out->compare_right = compare_right;
        out->test = test;
        out->transient = transient;
        out->replacement = replacement;
        out->right = right;
        return 1;
    }
    return 0;
}

static int measure_direct_compare_handoff_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    compare_handoff_frame shape = { 0 };
    if (!compare_handoff_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u, encoded = 0u;
    if (!emit_alu_instruction(
            shape.owner, shape.right, shape.bits, shape.mode, 0u,
            0, &encoded))
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (!emit_gpr_move(local, shape.owner, shape.bits, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    pl_u32 work = 0u;
    int measured = measure_alu_seed(
        frontend, block, selection, shape.owner, shape.replacement,
        shape.bits, bytes, block->plan.node_count + 1u,
        &encoded, &work);
    if (measured <= 0 || bytes > U32_MAX_VALUE - encoded
            || instructions > U32_MAX_VALUE - work)
        return measured < 0 ? measured : 0;
    bytes += encoded;
    instructions += work;
    int flags_emitted = shape.test
        ? emit_test_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, 0, &encoded)
        : emit_compare_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, 0, &encoded);
    if (!flags_emitted || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
    int status = append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        bytes + (block->relax_short_control ? 2u : 1u),
        bytes + branch_bytes, block->successor[0]);
    if (status) return status;
    bytes += branch_bytes;
    ++instructions;

    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_compare_handoff_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}


static int entry_flag_branch_shape(const pl_x86_block *block,
                                   pl_u32 *changed, pl_u32 *condition)
{
    if (!block || !changed || !condition
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_CONDITIONAL
            || !block->has_predicate || block->dynamic_target
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 2u
            || block->plan.node_count != 1u
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->predicate.kind != PL_OPERAND_NODE
            || block->predicate.value != 1u)
        return 0;
    const pl_node *predicate = &block->plan.nodes[0];
    if (predicate->opcode != PL_OPCODE_X86_CONDITION
            || predicate->argument_count != 2u
            || predicate->argument_at > block->plan.argument_count
            || predicate->argument_count
               > block->plan.argument_count - predicate->argument_at)
        return 0;
    const pl_operand *argument =
        block->plan.arguments + predicate->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != PL_OPERAND_CONST
            || argument[1].value > 15u)
        return 0;
    pl_u32 mask = 0u;
    for (pl_u32 local = 0u; local < block->plan.local_count; ++local) {
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (local >= PL_X86_GPR_COUNT
                || (value.kind != PL_OPERAND_CONST
                    && (value.kind != PL_OPERAND_LOCAL
                        || value.value >= PL_X86_GPR_COUNT)))
            return 0;
        mask |= 1u << local;
    }
    if (!mask) return 0;
    *changed = mask;
    *condition = (pl_u32)argument[1].value;
    return 1;
}

static int measure_direct_entry_flag_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    pl_u32 changed = 0u, condition = 0u;
    if (!entry_flag_branch_shape(block, &changed, &condition)) return 0;
    pl_u32 pending = changed;
    pl_u32 bytes = 0u, instructions = 0u;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!next_compare_branch_assignment(
                &block->plan, pending, 0u, &local))
            return 0;
        int measured = measure_frame_value(
            frontend, block, selection, local, block->plan.locals[local],
            bytes, &encoded);
        if (measured <= 0 || bytes > U32_MAX_VALUE - encoded
                || instructions == U32_MAX_VALUE)
            return measured < 0 ? measured : 0;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (bytes > U32_MAX_VALUE - branch_bytes
            || instructions == U32_MAX_VALUE)
        return PL_ERROR_X86_SELECT;
    int status = append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        bytes + (block->relax_short_control ? 2u : 1u),
        bytes + branch_bytes, block->successor[0]);
    if (status) return status;
    selection->output_bytes = bytes + branch_bytes;
    selection->output_instructions = instructions + 1u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_entry_branch_frame = 1u;
    selection->frame_anchor = (pl_u8)condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}


typedef struct {
    pl_u32 narrow, wide;
    pl_operand word;
} signed_word_handoff;

typedef struct {
    pl_u32 owner, booleans, zero_before, members, bits, mode;
    pl_operand left, right;
} flag_result_group;

/* One arithmetic instruction publishes both its word and its conditions.
 * Keep those observations adjacent while allocating their actual GPRs.
 * Other pending readers of an overwritten entry must run before the group;
 * pending consumers of its new outputs keep their producer dependencies. */
static int flag_result_group_shape(const pl_plan *plan, pl_u32 pending,
                                   flag_result_group *out, pl_u32 *deferred)
{
    *deferred = 0u;
    pl_u32 sources[PL_X86_GPR_COUNT], dependencies[PL_X86_GPR_COUNT];
    if (!alu_frame_source_laws(plan, sources, dependencies)) return 0;
    for (pl_u32 node = 1u; node <= plan->node_count; ++node) {
        pl_operand result = { PL_OPERAND_PROJECTION, ((pl_u64)node << 8u) | 16u };
        pl_u32 owner = publication_owner(plan, result), booleans = 0u;
        if (owner >= PL_X86_GPR_COUNT || !(pending & (1u << owner))) continue;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand value = plan->locals[local];
            if ((pending & (1u << local)) && value.kind == PL_OPERAND_PROJECTION
                    && (value.value >> 8u) == node && (value.value & 0xffu) < 16u)
                booleans |= 1u << local;
        }
        if (!booleans) continue;
        flag_result_group shape = { .owner = owner, .booleans = booleans };
        pl_u32 preserves = 0u;
        if (!alu_node_semantics(plan, node, &shape.left, &shape.right,
                &shape.bits, &shape.mode, &preserves) || preserves
                || shape.mode == 2u || shape.mode == 4u) continue;
        shape.members = booleans | (1u << owner);
        *deferred |= shape.members;
        if (dependencies[owner] & pending & ~shape.members) continue;
        pl_u32 blocked = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
            if ((pending & (1u << local)) && !(shape.members & (1u << local))
                    && (sources[local] & shape.members)) blocked = 1u;
        if (blocked) continue;
        shape.zero_before = booleans & ~(sources[owner] | dependencies[owner]);
        *out = shape;
        return 1;
    }
    return 0;
}

static int emit_group_booleans(const pl_plan *plan, const flag_result_group *shape,
                               int before, pl_u8 *output, pl_u32 *written, pl_u32 *work)
{
    pl_u32 at = 0u, count = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_u32 bit = 1u << local, part = 0u;
        if (!(shape->booleans & bit)) continue;
        if (before ? !!(shape->zero_before & bit) : !(shape->zero_before & bit)) {
            if (!emit_boolean_zero(local, !before, output ? output + at : 0, &part)) return 0;
            at += part;
            ++count;
        }
        if (!before) {
            if (!emit_set_condition(local, (pl_u32)(plan->locals[local].value & 0xffu),
                    output ? output + at : 0, &part)) return 0;
            at += part;
            ++count;
        }
    }
    *written = at; *work = count;
    return 1;
}

/* Two publications observe one word: zext32(q) and sext32(q). When q uses
 * the wide destination's entry value, it can own q destructively, publish
 * the narrow alias, then sign-extend in place. This removes both a rebuild
 * of q and the entry copy's extra wave; q's expression grammar is unchanged. */
static int signed_word_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                     signed_word_handoff *out)
{
    pl_u32 entries[PL_X86_GPR_COUNT], dependencies[PL_X86_GPR_COUNT];
    if (!alu_frame_source_laws(plan, entries, dependencies)) return 0;
    for (pl_u32 wide = 0u; wide < PL_X86_GPR_COUNT; ++wide) {
        if (!(pending & (1u << wide))) continue;
        pl_operand value = plan->locals[wide], word;
        pl_u32 bits = 0u;
        if (value.kind != PL_OPERAND_NODE
                || !sign_extend_value(plan, (pl_u32)value.value, &word, &bits)
                || bits != 32u || word.kind != PL_OPERAND_NODE
                || operand_expression_bits(plan, word, 0u) != 32u) continue;
        pl_u32 narrow = publication_owner(plan, word);
        if (narrow >= PL_X86_GPR_COUNT || narrow == wide
                || !(pending & (1u << narrow))) continue;
        pl_u32 sources = 0u;
        if (!operand_entry_gpr_sources(plan, word, plan->node_count + 1u,
                plan->node_count + 1u, &sources)
                || !(sources & (1u << wide)) || (sources & (1u << narrow))) continue;
        pl_u32 pair = (1u << wide) | (1u << narrow), blocked = 0u;
        if (dependencies[narrow] & pending & ~pair) continue;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local)) || (pair & (1u << local))) continue;
            if (!operand_entry_gpr_sources(plan, plan->locals[local], plan->node_count + 1u,
                    plan->node_count + 1u, &sources) || (sources & pair)) {
                blocked = 1u;
                break;
            }
        }
        if (blocked) continue;
        *out = (signed_word_handoff){ narrow, wide, word };
        return 1;
    }
    return 0;
}

static int emit_signed_word_publications(const signed_word_handoff *shape,
                                         pl_u8 *output, pl_u32 *written)
{
    pl_u32 copy = 0u, extension = 0u;
    if (!emit_gpr_move(shape->narrow, shape->wide, 32u, output, &copy)
            || !emit_sign_extend_move(shape->wide, shape->wide, 32u,
                output ? output + copy : 0, &extension)) return 0;
    *written = copy + extension;
    return 1;
}

static int measure_direct_compare_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    compare_branch_operands shape;
    pl_u32 changed, left, bits, condition, test;
    pl_u8 flag_prefix = 0u;
    if (!compare_branch_operand_shape(block, &shape)
            || !compare_flag_prefix(&block->plan, &flag_prefix))
        return 0;
    selection->direct_branch_frame = 1u;
    selection->blocking_work = 0xf100u;
    changed = shape.changed;
    left = shape.left;
    bits = shape.bits;
    condition = shape.condition;
    test = shape.test;
    const pl_u32 compare_reads = (1u << left)
        | (shape.right.kind == PL_OPERAND_LOCAL ? 1u << shape.right.value : 0u);
    subtract_handoff handoff = { 0 };
    int has_handoff = subtract_handoff_shape(
        &block->plan, changed, &handoff);
    pl_u32 stage_pending[2] = { changed, 0u };
    pl_u32 stage_count = 1u;
    if (has_handoff) {
        stage_pending[0] = handoff.producers;
        stage_pending[1] = changed
                         & ~handoff.outputs & ~handoff.producers;
        stage_count = 2u;
    }
    pl_u32 bytes = 0u, instructions = 0u, span = 0u;
    for (pl_u32 stage = 0u; stage < stage_count; ++stage) {
      pl_u32 pending = stage_pending[stage];
      while (pending) {
        select_generation_group select_group;
        if (!has_handoff && select_generation_group_shape(&block->plan, pending, 0u, &select_group)) {
            pl_u32 part = 0u, work = 0u;
            int measured = measure_select_generation_group(frontend, block, selection,
                &select_group, bytes, &part, &work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part
                    || instructions > U32_MAX_VALUE - work) return measured < 0 ? measured : 0;
            bytes += part; instructions += work;
            pending &= ~select_group.members;
            continue;
        }
        flag_result_group group;
        pl_u32 deferred = 0u;
        if (!has_handoff && flag_result_group_shape(&block->plan, pending, &group, &deferred)) {
            pl_u32 pre = 0u, pre_work = 0u, operation = 0u, work = 0u, post = 0u, post_work = 0u;
            if (!emit_group_booleans(&block->plan, &group, 1, 0, &pre, &pre_work)
                    || bytes > U32_MAX_VALUE - pre) return 0;
            int measured = measure_alu_pair(frontend, block, selection, group.owner,
                group.left, group.right, group.bits, group.mode, 0u, bytes + pre,
                block->plan.node_count + 1u, 0u, &operation, &work);
            if (measured <= 0 || !emit_group_booleans(&block->plan, &group, 0, 0, &post, &post_work)
                    || operation > U32_MAX_VALUE - pre || post > U32_MAX_VALUE - pre - operation
                    || bytes > U32_MAX_VALUE - pre - operation - post
                    || work > U32_MAX_VALUE - pre_work - post_work
                    || instructions > U32_MAX_VALUE - pre_work - work - post_work)
                return measured < 0 ? measured : 0;
            bytes += pre + operation + post;
            instructions += pre_work + work + post_work;
            pending &= ~group.members;
            continue;
        }
        signed_word_handoff word;
        if (!has_handoff && signed_word_handoff_shape(&block->plan, pending, &word)) {
            pl_u32 prefix = 0u, work = 0u, publication = 0u;
            int measured = measure_alu_tree(frontend, block, selection,
                word.wide, word.word, 32u, bytes, block->plan.node_count + 1u,
                0u, &prefix, &work);
            if (measured <= 0 || !emit_signed_word_publications(&word, 0, &publication)
                    || prefix > U32_MAX_VALUE - publication
                    || bytes > U32_MAX_VALUE - prefix - publication
                    || work > U32_MAX_VALUE - 2u
                    || instructions > U32_MAX_VALUE - work - 2u)
                return measured < 0 ? measured : 0;
            bytes += prefix + publication;
            instructions += work + 2u;
            pending &= ~((1u << word.narrow) | (1u << word.wide));
            continue;
        }
        shared_root_shift_handoff root_shift;
        if (!has_handoff
                && shared_root_shift_handoff_shape(
                    &block->plan, pending, &root_shift)) {
            pl_u32 seed_bytes = 0u, seed_work = 0u, move_bytes = 0u;
            pl_u32 shift0 = 0u, shift1 = 0u;
            int measured = measure_alu_tree(
                frontend, block, selection, root_shift.seed_dest,
                root_shift.seed, root_shift.seed_bits, bytes,
                block->plan.node_count + 1u, 0u, &seed_bytes, &seed_work);
            if (measured <= 0
                    || !emit_gpr_move(root_shift.copy_dest,
                        root_shift.seed_dest, root_shift.bits, 0, &move_bytes)
                    || !emit_shift_instruction(
                        root_shift.seed_dest, root_shift.amount[0],
                        root_shift.bits, root_shift.group[0], 0, &shift0)
                    || !emit_shift_instruction(
                        root_shift.copy_dest, root_shift.amount[1],
                        root_shift.bits, root_shift.group[1], 0, &shift1)
                    || seed_bytes > U32_MAX_VALUE - move_bytes
                    || seed_bytes + move_bytes > U32_MAX_VALUE - shift0
                    || seed_bytes + move_bytes + shift0
                       > U32_MAX_VALUE - shift1
                    || seed_work > U32_MAX_VALUE - 3u)
                return measured < 0 ? measured : 0;
            bytes += seed_bytes + move_bytes + shift0 + shift1;
            instructions += seed_work + 3u;
            pending &= ~((1u << root_shift.seed_dest)
                       | (1u << root_shift.copy_dest));
            continue;
        }
        pl_u32 local = 0u, encoded = 0u, work = 1u;
        if (!next_compare_branch_assignment_excluding(
                &block->plan, pending,
                compare_reads, deferred, &local)) {
            selection->blocking_work = 0x700u;
            selection->blocking_opcode = pending;
            return 0;
        }
        pl_operand value = block->plan.locals[local];
        int measured;
        pl_u32 owner = publication_owner(&block->plan, value);
        if (value.kind == PL_OPERAND_NODE && owner < PL_X86_GPR_COUNT && owner != local) {
            /* The scheduler has already published the exact shared root.
             * Its other outputs read that owner rather than rebuilding it. */
            pl_u32 value_bits = operand_fits_u32(
                &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
            measured = emit_gpr_move(local, owner, value_bits, 0, &encoded);
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local)
                return 0;
            pl_u32 prefix_work = 0u, operation = 0u;
            measured = measure_alu_seed(
                frontend, block, selection, local, source, node_bits, bytes,
                block->plan.node_count + 1u, &encoded, &prefix_work);
            if (measured <= 0
                    || !emit_alu_instruction(
                        local, right_operand, node_bits, mode,
                        preserves_carry, 0, &operation)
                    || encoded > U32_MAX_VALUE - operation)
                return measured < 0 ? measured : 0;
            encoded += operation;
            work = prefix_work + 1u;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, extend_bits = 0u;
            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            conditional_select select;
            if (conditional_select_details(
                    &block->plan, value, local, &select)) {
                if (select.candidate_local == local) return 0;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                measured = select.current_flag_node
                    ? measure_selected_flag_value(frontend, block, selection, local, &select,
                        bytes, block->plan.node_count + 1u, 0u, &seed_bytes, &seed_work)
                    : measure_alu_seed(
                    frontend, block, selection, local, current,
                    select.value_bits, bytes,
                    block->plan.node_count + 1u,
                    &seed_bytes, &seed_work);
                pl_u32 compare_bytes = 0u, move_bytes = 0u;
                int compared = !select.has_compare
                    || emit_select_compare(&select, 0, &compare_bytes);
                if (measured <= 0 || !compared
                        || !emit_conditional_move(
                            local, select.candidate_local,
                            select.value_bits, select.condition,
                            0, &move_bytes)
                        || seed_bytes > U32_MAX_VALUE - compare_bytes
                        || seed_bytes + compare_bytes
                           > U32_MAX_VALUE - move_bytes)
                    return measured < 0 ? measured : 0;
                encoded = seed_bytes + compare_bytes + move_bytes;
                work = seed_work + 1u + select.has_compare;
            } else if (collect_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form)) {
                measured = emit_affine_lea(local, form, 0, &encoded);
                work = 1u;
            } else if (zero_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                measured = emit_zero_extend_move(
                    local, source, extend_bits, 0, &encoded);
                work = 1u;
            } else if (sign_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                measured = emit_sign_extend_move(
                    local, source, extend_bits, 0, &encoded);
                work = 1u;
            } else if (shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &shift_bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                measured = measure_alu_seed(
                    frontend, block, selection, local, shift_source,
                    shift_bits, bytes, block->plan.node_count + 1u,
                    &seed_bytes, &seed_work);
                pl_u32 shift_bytes = 0u;
                if (measured <= 0
                        || !emit_shift_instruction(
                            local, shift_amount, shift_bits, shift_group,
                            0, &shift_bytes)
                        || seed_bytes > U32_MAX_VALUE - shift_bytes)
                    return measured < 0 ? measured : 0;
                encoded = seed_bytes + shift_bytes;
                work = seed_work + 1u;
            } else {
                pl_u32 node_bits = operand_fits_u32(
                    &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
                measured = measure_alu_tree(
                    frontend, block, selection, local, value, node_bits,
                    bytes, block->plan.node_count + 1u, 0u, &encoded, &work);
            }
        } else {
            measured = value.kind == PL_OPERAND_CONST && !value.value
                    && zero_internal_compare_consumers(
                        &block->plan, local, pending)
                ? emit_zero_register(local, 0, &encoded)
                : measure_frame_value(
                    frontend, block, selection, local, value,
                    bytes, &encoded);
        }
        if (measured <= 0 || bytes > U32_MAX_VALUE - encoded
                || instructions > U32_MAX_VALUE - work) {
            selection->blocking_work = 0x800u | local;
            return measured < 0 ? measured : 0;
        }
        bytes += encoded;
        instructions += work;
        if (work > span) span = work;
        pending &= ~(1u << local);
      }
      if (has_handoff && !stage) {
        pl_u32 encoded = 0u, work = 0u;
        int measured = measure_alu_seed(
            frontend, block, selection, handoff.scratch, handoff.right,
            handoff.bits, bytes, block->plan.node_count + 1u,
            &encoded, &work);
        pl_operand scratch = { PL_OPERAND_LOCAL, handoff.scratch };
        pl_u32 operation = 0u;
        if (measured <= 0
                || !emit_alu_instruction(
                    handoff.owner, scratch, handoff.bits, 3u, 0u,
                    0, &operation)
                || encoded > U32_MAX_VALUE - operation
                || bytes > U32_MAX_VALUE - encoded - operation
                || instructions > U32_MAX_VALUE - work - 1u)
            return measured < 0 ? measured : 0;
        bytes += encoded + operation;
        instructions += work + 1u;
        if (work + 1u > span) span = work + 1u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (local == handoff.owner
                    || !(handoff.outputs & (1u << local)))
                continue;
            if (!emit_gpr_move(
                    local, handoff.owner, handoff.bits, 0, &encoded)
                    || bytes > U32_MAX_VALUE - encoded
                    || instructions == U32_MAX_VALUE)
                return 0;
            bytes += encoded;
            ++instructions;
        }
      }
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (flag_prefix) {
        if (bytes == U32_MAX_VALUE || instructions == U32_MAX_VALUE)
            return PL_ERROR_X86_SELECT;
        ++bytes;
        ++instructions;
        if (!span) span = 1u;
    }
    pl_u32 encoded = 0u;
    int flags_emitted = test
        ? emit_test_operand(left, shape.right, bits, 0, &encoded)
        : emit_compare_operand(left, shape.right, bits, 0, &encoded);
    if (!flags_emitted
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    ++span;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
    int status = append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        bytes + (block->relax_short_control ? 2u : 1u),
        bytes + branch_bytes, block->successor[0]);
    if (status) return status;
    bytes += branch_bytes;
    ++instructions;
    ++span;
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_branch_frame = 1u;
    selection->frame_anchor = (pl_u8)condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int measure_direct_affine_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection || !block->plan.node_count
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->plan.locals[PL_X86_RFLAGS_LOCAL].kind
               != PL_OPERAND_LOCAL
            || block->plan.locals[PL_X86_RFLAGS_LOCAL].value
               != PL_X86_RFLAGS_LOCAL)
        return 0;
    pl_u32 changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local)
                return 0;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u;
            if (!collect_native_affine_lea(
                    &block->plan, value, block->plan.node_count + 1u,
                    &form, &bits)
                    && !zero_extend_node(
                        &block->plan, (pl_u32)value.value, &source, &bits)
                    && !sign_extend_node(
                        &block->plan, (pl_u32)value.value, &source, &bits))
                return 0;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        changed |= 1u << local;
    }
    if (!changed) return 0;
    pl_u32 pending = changed, bytes = 0u, instructions = 0u, span = 0u;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u, work = 1u;
        if (!next_compare_branch_assignment(
                &block->plan, pending, 0u, &local))
            return 0;
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local)
                return 0;
            pl_u32 prefix_work = 0u, operation = 0u;
            int measured = measure_alu_seed(
                frontend, block, selection, local, source, node_bits, bytes,
                block->plan.node_count + 1u, &encoded, &prefix_work);
            if (measured <= 0
                    || !emit_alu_instruction(
                        local, right_operand, node_bits, mode,
                        preserves_carry, 0, &operation)
                    || encoded > U32_MAX_VALUE - operation)
                return measured < 0 ? measured : 0;
            encoded += operation;
            work = prefix_work + 1u;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u;
            if (collect_native_affine_lea(
                    &block->plan, value, block->plan.node_count + 1u,
                    &form, &bits)) {
                if (!emit_affine_lea_width(
                        local, form, bits, 0, &encoded))
                    return 0;
            } else if (!zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)
                    || !emit_zero_extend_move(
                        local, source, bits, 0, &encoded)) {
                if (!sign_extend_node(
                        &block->plan, (pl_u32)value.value, &source, &bits)
                        || !emit_sign_extend_move(
                            local, source, bits, 0, &encoded))
                    return 0;
            }
        } else {
            int measured = measure_frame_value(
                frontend, block, selection, local, value, bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded
                || instructions > U32_MAX_VALUE - work)
            return PL_ERROR_X86_SELECT;
        bytes += encoded;
        instructions += work;
        if (work > span) span = work;
        pending &= ~(1u << local);
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_affine_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* A 32-bit GPR publication is a full 64-bit architectural write because x86
 * clears the upper half.  The physical spelling is therefore exactly one
 * lane insertion into zero, and its shortest native spelling is MOV r32,r32.
 * Keeping this as a direct rule avoids retaining a decoder spelling merely to
 * express the already-normalized publication. */
static int insert32_frame_shape(const pl_plan *plan, pl_u32 *destination,
                                pl_u32 *source, pl_u32 *changed)
{
    if (!plan || !destination || !source || !changed
            || plan->node_count != 1u
            || plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->opcode != PL_OPCODE_LANE64_INSERT
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_CONST || arguments[0].value
            || arguments[1].kind != PL_OPERAND_LOCAL
            || arguments[1].value >= PL_X86_GPR_COUNT
            || arguments[2].kind != PL_OPERAND_CONST
            || arguments[2].value != 32u)
        return 0;
    *destination = PL_X86_GPR_COUNT;
    *changed = 0u;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (value.kind == PL_OPERAND_NODE) {
            if (value.value != 1u
                    || *destination != PL_X86_GPR_COUNT)
                return 0;
            *destination = local;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        *changed |= 1u << local;
    }
    if (*destination >= PL_X86_GPR_COUNT) return 0;
    *source = (pl_u32)arguments[1].value;
    return 1;
}

static int insert_frame_sources(const pl_plan *plan, pl_u32 local,
                                pl_u32 destination, pl_u32 source,
                                pl_u32 *sources)
{
    if (!plan || !sources || local >= PL_X86_GPR_COUNT) return 0;
    *sources = 0u;
    if (local == destination) {
        *sources = 1u << source;
        return 1;
    }
    pl_operand value = plan->locals[local];
    if (value.kind == PL_OPERAND_LOCAL)
        *sources = 1u << (pl_u32)value.value;
    return 1;
}

static int next_insert_frame_assignment(
    const pl_plan *plan, pl_u32 pending,
    pl_u32 destination, pl_u32 source, pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_u32 used = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            pl_u32 sources = 0u;
            if (!insert_frame_sources(
                    plan, other, destination, source, &sources))
                return 0;
            used |= sources;
        }
        if (!(used & (1u << local))) {
            *selected = local;
            return 1;
        }
    }
    return 0;
}

static int emit_insert32_move(pl_u32 destination, pl_u32 source,
                              pl_u8 *output, pl_u32 *written)
{
    return emit_gpr_move(destination, source, 32u, output, written);
}

static int measure_direct_insert_frame(const pl_x86_frontend *frontend,
                                       const pl_x86_block *block,
                                       pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 destination, source, changed;
    if (!insert32_frame_shape(
            &block->plan, &destination, &source, &changed))
        return 0;
    pl_u32 pending = changed, bytes = 0u, instructions = 0u;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!next_insert_frame_assignment(
                &block->plan, pending,
                destination, source, &local))
            return 0;
        if (local == destination) {
            if (!emit_insert32_move(
                    destination, source, (pl_u8 *)0, &encoded))
                return 0;
        } else {
            int measured = measure_frame_value(
                frontend, block, selection, local,
                block->plan.locals[local], bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded)
            return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_insert_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static void write_u32(pl_u8 *output, pl_u32 at, pl_u32 value)
{
    for (pl_u32 byte = 0u; byte < 4u; ++byte)
        output[at + byte] = (pl_u8)(value >> (byte * 8u));
}

static void write_u64(pl_u8 *output, pl_u32 at, pl_u64 value)
{
    for (pl_u32 byte = 0u; byte < 8u; ++byte)
        output[at + byte] = (pl_u8)(value >> (byte * 8u));
}

static int address_fixup_at(const pl_x86_native_selection *selection,
                            pl_u32 output_at, pl_u64 target,
                            pl_u32 bits, pl_u32 destination)
{
    if (!selection || output_at > U32_MAX_VALUE - 7u) return 0;
    pl_u32 prefix = bits == 64u || destination >= 8u ? 1u : 0u;
    pl_u64 mask = bits == 32u ? U32_MAX_VALUE : U64_MAX_VALUE;
    for (pl_u32 index = 0u; index < selection->fixup_count; ++index) {
        const pl_x86_native_fixup *fixup = &selection->fixups[index];
        if (fixup->kind == PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                && fixup->bytes == 4u && fixup->at == output_at + prefix + 2u
                && fixup->next_ip_at == output_at + prefix + 6u
                && (fixup->target & mask) == (target & mask))
            return 1;
    }
    return 0;
}

static int absolute_fixup_at(const pl_x86_native_selection *selection,
                             pl_u32 output_at, pl_u64 target)
{
    if (!selection || output_at > U32_MAX_VALUE - 10u) return 0;
    for (pl_u32 index = 0u; index < selection->fixup_count; ++index) {
        const pl_x86_native_fixup *fixup = &selection->fixups[index];
        if (fixup->kind == PL_X86_NATIVE_FIXUP_ABSOLUTE
                && fixup->bytes == 8u && fixup->at == output_at + 2u
                && fixup->next_ip_at == output_at + 10u
                && fixup->target == target)
            return 1;
    }
    return 0;
}

static int write_frame_value(const pl_x86_native_selection *selection,
                             pl_u32 output_at, pl_u32 local,
                             pl_operand value, pl_u8 *output,
                             pl_u32 *written)
{
    if (!selection || !output || !written || local >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 at = 0u;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        pl_u32 source = (pl_u32)value.value;
        output[at++] = (pl_u8)(0x48u
            | (source >= 8u ? 4u : 0u)
            | (local >= 8u ? 1u : 0u));
        output[at++] = 0x89u;
        output[at++] = (pl_u8)(0xc0u
            | ((source & 7u) << 3u) | (local & 7u));
    } else if (value.kind != PL_OPERAND_CONST) {
        return 0;
    } else if (absolute_fixup_at(selection, output_at, value.value)) {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 1u : 0u));
        output[at++] = (pl_u8)(0xb8u + (local & 7u));
        write_u64(output, at, 0u);
        at += 8u;
    } else if (address_fixup_at(selection, output_at, value.value, 64u, local)) {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 4u : 0u));
        output[at++] = 0x8du;
        output[at++] = (pl_u8)(0x05u | ((local & 7u) << 3u));
        write_u32(output, at, 0u);
        at += 4u;
    } else if (value.value <= 0xffffffffu) {
        if (local >= 8u) output[at++] = 0x41u;
        output[at++] = (pl_u8)(0xb8u + (local & 7u));
        write_u32(output, at, (pl_u32)value.value);
        at += 4u;
    } else if (value.value >= 0xffffffff80000000ull) {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 1u : 0u));
        output[at++] = 0xc7u;
        output[at++] = (pl_u8)(0xc0u | (local & 7u));
        write_u32(output, at, (pl_u32)value.value);
        at += 4u;
    } else {
        output[at++] = (pl_u8)(0x48u | (local >= 8u ? 1u : 0u));
        output[at++] = (pl_u8)(0xb8u + (local & 7u));
        write_u64(output, at, value.value);
        at += 8u;
    }
    *written = at;
    return 1;
}

static int write_alu_seed(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand value,
                          pl_u32 bits, pl_u32 output_at,
                          pl_u32 remaining, pl_u8 *output,
                          pl_u32 *written)
{
    if (!block || !selection || !output || !written || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    physicalize_transient_operand(selection, &value);
    if (emit_test_boolean(&block->plan, value, destination, output, written)) return 1;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        if (value.value == destination) {
            *written = 0u;
            return 1;
        }
        return emit_gpr_move(destination, (pl_u32)value.value, bits,
                             output, written);
    }
    if (value.kind == PL_OPERAND_CONST && bits == 32u
            && address_fixup_at(selection, output_at, value.value, bits, destination)) {
        pl_u32 at = 0u;
        if (destination >= 8u) output[at++] = 0x44u;
        output[at++] = 0x8du;
        output[at++] = (pl_u8)(0x05u | ((destination & 7u) << 3u));
        write_u32(output, at, 0u);
        *written = at + 4u;
        return 1;
    }
    if (value.kind == PL_OPERAND_CONST)
        return write_frame_value(
            selection, output_at, destination, value, output, written);
    pl_u32 extension_source = 0u, extension_bits = 0u;
    if (value.kind == PL_OPERAND_NODE
            && zero_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits))
        return emit_zero_extend_move(destination, extension_source, extension_bits,
                                     output, written);
    /* A sign extension whose operand is a 32-bit register is one `movslq`.
     * Without this branch the extension is materialized relative to the
     * incoming accumulator (`cltq`), which forces a spurious producer into the
     * same destination and costs an extra work. */
    if (value.kind == PL_OPERAND_NODE
            && sign_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits)
            && extension_bits == 32u && bits == 32u)
        return emit_sign_extend_move(
            destination, extension_source, extension_bits, output, written);
    pl_operand negation_source;
    pl_u32 negation_bits = 0u;
    if (negation_node_details(
            &block->plan, value, &negation_source, &negation_bits)
            && negation_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 at = 0u, encoded = 0u;
        if (!write_alu_seed(
                block, selection, destination, negation_source, bits,
                output_at, remaining - 1u, output + at, &encoded))
            return 0;
        at += encoded;
        if (!emit_neg_register(
                destination, bits, output + at, &encoded)
                || at > U32_MAX_VALUE - encoded)
            return 0;
        *written = at + encoded;
        return 1;
    }
    pl_operand complement_source;
    pl_u32 complement_bits = 0u;
    if (complement_node_details(
            &block->plan, value, &complement_source, &complement_bits)
            && (complement_bits == bits
                || (bits == 32u && complement_bits == 64u))) {
        if (remaining <= 1u) return 0;
        pl_u32 prefix = 0u;
        if (!write_alu_seed(
                block, selection, destination, complement_source, bits,
                output_at, remaining - 1u, output, &prefix))
            return 0;
        pl_u32 operation = 0u;
        if (!emit_not_register(
                destination, bits, output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation)
            return 0;
        *written = prefix + operation;
        return 1;
    }
    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (shift_node_details(
            &block->plan, value, &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            && shift_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 published = 0u;
        if ((shift_source.kind == PL_OPERAND_NODE
                || shift_source.kind == PL_OPERAND_PROJECTION)
                && published_operand_local(
                    &block->plan, shift_source, &published)
                && published != destination) {
            shift_source.kind = PL_OPERAND_LOCAL;
            shift_source.value = published;
        }
        if (shift_amount.kind == PL_OPERAND_LOCAL
                && shift_amount.value == destination
                && !(shift_source.kind == PL_OPERAND_LOCAL
                    && shift_source.value == destination))
            return 0;
        pl_u32 count_mask = bits == 64u ? 63u : 31u;
        if (shift_group == 4u
                && shift_source.kind == PL_OPERAND_LOCAL
                && shift_source.value != destination
                && shift_amount.kind == PL_OPERAND_CONST
                && !final_flags_are_shift(&block->plan)
                && emit_shifted_copy(
                    destination, (pl_u32)shift_source.value, bits,
                    (pl_u32)shift_amount.value & count_mask,
                    output, written))
            return 1;
        pl_u32 prefix = 0u;
        if (!write_alu_seed(
                block, selection, destination, shift_source, bits,
                output_at, remaining - 1u, output, &prefix))
            return 0;
        pl_u32 operation = 0u;
        if (!emit_shift_instruction(
                destination, shift_amount, bits, shift_group,
                output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation)
            return 0;
        *written = prefix + operation;
        return 1;
    }
    affine_lea form = { 0 };
    if (collect_affine_lea_width(
            &block->plan, value, bits, remaining, &form)
            && emit_affine_lea_width(
                destination, form, bits, output, written))
        return 1;
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            &block->plan, value, &left, &right, &node_bits, &mode))
        return 0;
    physicalize_selected_operand(
        &block->plan, selection, destination, &left);
    physicalize_selected_operand(
        &block->plan, selection, destination, &right);
    orient_commutative_destination(
        &block->plan, destination, mode, &left, &right);
    if (mode == 1u && emit_add_lea(
            destination, left, right, node_bits, output, written))
        return 1;
    if ((right.kind == PL_OPERAND_LOCAL
                && right.value == destination
                && !(left.kind == PL_OPERAND_LOCAL
                     && left.value == destination)))
        return 0;
    pl_u32 prefix = 0u;
    pl_u32 left_bits = operand_expression_bits(
        &block->plan, left, node_bits);
    if (!write_alu_seed(
            block, selection, destination, left, left_bits, output_at,
            remaining - 1u, output, &prefix))
        return 0;
    pl_u32 operation = 0u;
    if (!emit_alu_instruction(destination, right, node_bits, mode, 0u,
                              output + prefix, &operation)
            || prefix > U32_MAX_VALUE - operation)
        return 0;
    *written = prefix + operation;
    return 1;
}

static int write_alu_tree(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand value,
                          pl_u32 bits, pl_u32 output_at,
                          pl_u32 remaining, pl_u32 scratch_mask,
                          pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !output || !written || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    /* A 32-bit sign extension of a register is one `movslq`.  Do it before
     * `write_alu_seed`, whose transient-alias resolution would otherwise
     * rewrite the node to an incoming accumulator and force `cltq` plus a
     * spurious producer into the same destination. */
    if (value.kind == PL_OPERAND_NODE) {
        pl_u32 extension_source = 0u, extension_bits = 0u;
        if (sign_extend_node(&block->plan, (pl_u32)value.value,
                              &extension_source, &extension_bits)
                && extension_bits == 32u
                && emit_sign_extend_move(
                    destination, extension_source, extension_bits,
                    output, written))
            return 1;
        /* A 32-bit sign extension whose operand is a node another publication
         * already placed in a GPR is one `movslq` from that coordinate.
         * Rebuilding the node first would materialize it a second time; the
         * frame's source law already orders that publication first. */
        pl_operand extension_argument = { 0 };
        pl_u32 extension_owner = PL_X86_GPR_COUNT;
        if (sign_extend_value(&block->plan, (pl_u32)value.value,
                              &extension_argument, &extension_bits)
                && extension_bits == 32u
                && extension_argument.kind == PL_OPERAND_NODE
                && published_operand_local(
                    &block->plan, extension_argument, &extension_owner)
                && emit_sign_extend_move(
                    destination, extension_owner, extension_bits,
                    output, written))
            return 1;
    }
    masked_entry_affine entry_affine;
    pl_u32 entry_affine_work = 0u;
    if (masked_entry_affine_details(
            &block->plan, value, destination, &entry_affine)
            && (scratch_mask & (1u << entry_affine.source))
            && emit_masked_entry_affine(
                &entry_affine, output, written, &entry_affine_work)) {
        (void)entry_affine_work;
        return 1;
    }
    if (write_alu_seed(
            block, selection, destination, value, bits, output_at,
            remaining, output, written))
        return 1;
    if (remaining <= 1u) return 0;

    pl_operand insert_base, insert_inner;
    pl_u32 insert_width = 0u;
    if (node_base_lane_insert(&block->plan, value, &insert_base,
                              &insert_inner, &insert_width)) {
        pl_x86_native_selection cleared = *selection;
        cleared.frame_alias_present = 0u;
        pl_u32 base_written = 0u;
        if (!write_alu_tree(block, &cleared, destination, insert_base, bits,
                output_at, remaining - 1u, scratch_mask,
                output, &base_written))
            return 0;
        pl_x86_native_selection aliased = *selection;
        aliased.frame_alias_value = insert_base.value;
        aliased.frame_alias_kind = insert_base.kind;
        aliased.frame_alias_local = (pl_u8)destination;
        aliased.frame_alias_present = 1u;
        pl_u32 inner_written = 0u;
        if (!write_alu_tree(block, &aliased, destination, insert_inner,
                insert_width, output_at + base_written, remaining - 1u,
                scratch_mask, output + base_written, &inner_written))
            return 0;
        *written = base_written + inner_written;
        return 1;
    }

    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_BSWAP
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_BSWAP)) {
        pl_u32 byte_swap_bits = block->plan.nodes[value.value - 1u].opcode
                              == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
        pl_operand byte_swap_source = block->plan.arguments[
            block->plan.nodes[value.value - 1u].argument_at];
        pl_u32 prefix = 0u;
        if (!write_alu_tree(
                block, selection, destination, byte_swap_source,
                byte_swap_bits, output_at, remaining - 1u, scratch_mask,
                output, &prefix)
                || !emit_bswap_register(
                    destination, byte_swap_bits, output + prefix, written))
            return 0;
        *written += prefix;
        return 1;
    }

    pl_operand tree_shift_source, tree_shift_amount;
    pl_u32 tree_shift_bits = 0u, tree_shift_group = 0u;
    if (shift_node_details(&block->plan, value, &tree_shift_source,
            &tree_shift_amount, &tree_shift_bits, &tree_shift_group)) {
        pl_u32 shift_prefix = 0u, shift_operation = 0u;
        if (!write_alu_tree(
                block, selection, destination, tree_shift_source,
                tree_shift_bits, output_at, remaining - 1u, scratch_mask,
                output, &shift_prefix)
                || !emit_shift_instruction(
                    destination, tree_shift_amount, tree_shift_bits,
                    tree_shift_group, output + shift_prefix, &shift_operation))
            return 0;
        *written = shift_prefix + shift_operation;
        return 1;
    }

    /* Nested conditional select over an incoming condition; mirrors
     * measure_alu_tree exactly so measured and written spellings match. */
    boolean_select tree_boolean;
    condition_value tree_condition;
    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_SELECT
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_SELECT)
            && boolean_select_details(&block->plan, value, &tree_boolean)
            && condition_value_details(
                &block->plan, tree_boolean.condition, &tree_condition)
            && tree_condition.flags.kind == PL_OPERAND_LOCAL
            && tree_condition.flags.value == PL_X86_RFLAGS_LOCAL) {
        pl_u32 false_local = 0u;
        int false_is_destination =
            (tree_boolean.when_false.kind == PL_OPERAND_LOCAL
                && tree_boolean.when_false.value == destination)
            || ((tree_boolean.when_false.kind == PL_OPERAND_NODE
                    || tree_boolean.when_false.kind == PL_OPERAND_PROJECTION)
                && published_operand_local(
                    &block->plan, tree_boolean.when_false, &false_local)
                && false_local == destination);
        if (false_is_destination) {
            pl_u32 candidate_local = PL_X86_GPR_COUNT;
            if (tree_boolean.when_true.kind == PL_OPERAND_CONST) {
                for (pl_u32 scratch = 0u;
                        scratch < PL_X86_GPR_COUNT; ++scratch)
                    if (scratch != destination
                            && (scratch_mask & (1u << scratch))) {
                        candidate_local = scratch;
                        break;
                    }
                if (candidate_local >= PL_X86_GPR_COUNT) return 0;
                pl_u32 part = 0u;
                if (!write_alu_tree(
                        block, selection, candidate_local,
                        tree_boolean.when_true, tree_boolean.value_bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~(1u << candidate_local),
                        output, &part))
                    return 0;
                pl_u32 move_bytes = 0u;
                if (!emit_conditional_move(
                        destination, candidate_local,
                        tree_boolean.value_bits, tree_condition.condition,
                        output + part, &move_bytes))
                    return 0;
                *written = part + move_bytes;
                return 1;
            }
            if (tree_boolean.when_true.kind == PL_OPERAND_LOCAL
                    && tree_boolean.when_true.value < PL_X86_GPR_COUNT
                    && tree_boolean.when_true.value != destination) {
                return 0;
            }
            return 0;
        }
    }

    condition_value flag_condition;
    if (condition_value_details(&block->plan, value, &flag_condition)
            && flag_condition.flags.kind == PL_OPERAND_NODE) {
        pl_operand compare_left, compare_right;
        pl_u32 compare_bits = 0u, compare_mode = 0u, compare_carry = 0u;
        if (flag_operation_details(
                &block->plan, flag_condition.flags, &compare_left,
                &compare_right, &compare_bits, &compare_mode, &compare_carry)
                && !compare_carry
                && (compare_mode == 0u || compare_mode == 3u)) {
            physicalize_published_operand(
                &block->plan, destination, &compare_left);
            physicalize_published_operand(
                &block->plan, destination, &compare_right);
            if (compare_left.kind == PL_OPERAND_LOCAL
                    && compare_left.value < PL_X86_GPR_COUNT) {
                pl_operand physical_right = compare_right;
                pl_u32 at = 0u, part = 0u;
                if (physical_right.kind == PL_OPERAND_CONST) {
                    pl_u32 operand_local = destination;
                    if (operand_local == (pl_u32)compare_left.value) {
                        operand_local = PL_X86_GPR_COUNT;
                        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                                ++scratch)
                            if (scratch != destination
                                    && scratch != (pl_u32)compare_left.value
                                    && (scratch_mask & (1u << scratch))) {
                                operand_local = scratch;
                                break;
                            }
                    }
                    if (operand_local >= PL_X86_GPR_COUNT)
                        return 0;
                    if (!write_alu_tree(
                            block, selection, operand_local, compare_right,
                            compare_bits, output_at, remaining - 1u,
                            operand_local == destination
                                ? scratch_mask
                                : scratch_mask & ~(1u << operand_local),
                            output, &part))
                        return 0;
                    at += part;
                    physical_right = (pl_operand){ PL_OPERAND_LOCAL,
                                                   operand_local };
                } else if (!(physical_right.kind == PL_OPERAND_LOCAL
                        && physical_right.value < PL_X86_GPR_COUNT)) {
                    return 0;
                }
                if (!emit_flag_coordinate(
                        (pl_u32)compare_left.value, physical_right,
                        compare_bits, compare_mode == 0u, 0u,
                        output + at, &part))
                    return 0;
                at += part;
                if (!emit_set_condition(
                        destination, flag_condition.condition,
                        output + at, &part))
                    return 0;
                at += part;
                *written = at;
                return 1;
            }
        }
    }

    pl_operand shared_seed, shared_amount;
    pl_u32 shared_group = 0u, shared_mode = 0u;
    if (shared_shift_join(&block->plan, value, bits, &shared_seed,
                          &shared_amount, &shared_group, &shared_mode)) {
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            if (scratch == destination || !(scratch_mask & (1u << scratch)))
                continue;
            pl_u32 prefix = 0u, tail = 0u;
            if (write_alu_tree(block, selection, destination, shared_seed,
                    bits, output_at, remaining - 1u, scratch_mask,
                    output, &prefix)
                    && emit_shared_shift_join(destination, scratch,
                        shared_amount, bits, shared_group, shared_mode,
                        output + prefix, &tail)
                    && prefix <= U32_MAX_VALUE - tail) {
                *written = prefix + tail;
                return 1;
            }
        }
    }

    carry_adjustment adjustment;
    pl_u32 adjustment_work = 0u;
    if (carry_adjustment_details(&block->plan, value, destination, bits, &adjustment)
            && emit_carry_adjustment(&adjustment, destination, output, written,
                                     &adjustment_work)) return 1;
    pl_operand signed_source;
    pl_u32 signed_bits = 0u;
    if (bits == 64u && value.kind == PL_OPERAND_NODE
            && sign_extend_value(&block->plan, (pl_u32)value.value,
                                 &signed_source, &signed_bits)) {
        pl_u32 prefix = 0u, operation = 0u;
        if (!write_alu_tree(
                block, selection, destination, signed_source, 32u, output_at,
                remaining - 1u, scratch_mask, output, &prefix)
                || !emit_sign_extend_move(destination, destination, signed_bits,
                                          output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation)
            return 0;
        *written = prefix + operation;
        return 1;
    }

    pl_operand multiply_left, multiply_right;
    pl_u32 multiply_bits = 0u;
    if (multiply_word_operands(&block->plan, selection, value, destination,
                              &multiply_left, &multiply_right, &multiply_bits)) {
        pl_u32 prefix = 0u, operation = 0u;
        pl_u32 direct_source = 0u;
        if (multiply_immediate_source(&block->plan, multiply_left, multiply_right,
                multiply_bits, &direct_source)
                && emit_imul_operand(destination, direct_source, multiply_right,
                    multiply_bits, output, written)) return 1;
        if (multiply_right.kind == PL_OPERAND_LOCAL && multiply_right.value == destination
                && !(multiply_left.kind == PL_OPERAND_LOCAL
                     && multiply_left.value == destination)) return 0;
        if (!write_alu_tree(
                block, selection, destination, multiply_left,
                alu_input_expression_bits(&block->plan, multiply_left, multiply_bits),
                output_at, remaining - 1u, scratch_mask, output, &prefix)
                || !emit_imul_operand(destination, destination, multiply_right,
                                       multiply_bits, output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation) return 0;
        *written = prefix + operation;
        return 1;
    }

    quotient_boundary_select boundary;
    if (quotient_boundary_select_details(
            &block->plan, value, destination, &boundary))
        return write_quotient_boundary_select(
            block, selection, destination, &boundary, output_at,
            remaining, scratch_mask, output, written);

    conditional_select select;
    if (conditional_select_details(
            &block->plan, value, destination, &select)
            && (select.has_compare || select.current_flag_node
                || (!output_at
                    && select.current.kind == PL_OPERAND_LOCAL
                    && select.current.value == destination))
            && select.candidate_local != destination
            && conditional_compare_survives_current(
                &select, destination)) {
        pl_u32 at = 0u, encoded = 0u;
        if (select.current_flag_node
                ? write_selected_flag_value(block, selection, destination, &select,
                    output_at, remaining - 1u, scratch_mask, output, &encoded)
                : write_alu_tree(
                block, selection, destination, select.current,
                select.value_bits, output_at, remaining - 1u,
                scratch_mask, output, &encoded)) {
            at += encoded;
            pl_u32 candidate_local = select.candidate_local;
            if (select.candidate_immediate) {
                candidate_local = PL_X86_GPR_COUNT;
                for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                        ++scratch)
                    if (scratch != destination
                            && (scratch_mask & (1u << scratch))) {
                        candidate_local = scratch;
                        break;
                    }
                if (candidate_local >= PL_X86_GPR_COUNT)
                    return PL_ERROR_X86_SELECT;
                if (!write_alu_tree(
                        block, selection, candidate_local,
                        select.candidate_value, select.value_bits,
                        output_at + at, remaining - 1u,
                        scratch_mask & ~(1u << candidate_local),
                        output + at, &encoded))
                    return PL_ERROR_X86_SELECT;
                at += encoded;
            }
            int compared = !select.has_compare ? 1
                : emit_select_compare(&select, output + at, &encoded);
            if (compared) {
                if (select.has_compare)
                    at += encoded;
                if (emit_conditional_move(
                        destination, candidate_local,
                        select.value_bits, select.condition,
                        output + at, &encoded)
                        && at <= U32_MAX_VALUE - encoded) {
                    *written = at + encoded;
                    return 1;
                }
            }
        }
    }

    condition_value condition_value_shape;
    if (condition_value_details(
            &block->plan, value, &condition_value_shape)) {
        pl_u32 at = 0u, encoded = 0u;
        int status = 1;
        if (!(condition_value_shape.flags.kind == PL_OPERAND_LOCAL
                && condition_value_shape.flags.value
                   == PL_X86_RFLAGS_LOCAL)) {
            pl_operand left, right;
            pl_u32 flag_bits = 0u, flag_mode = 0u, preserves_carry = 0u;
            if (!flag_operation_details(
                    &block->plan, condition_value_shape.flags,
                    &left, &right, &flag_bits, &flag_mode,
                    &preserves_carry)) {
                status = 0;
            } else {
                status = write_alu_pair(
                    block, selection, destination, left, right,
                    flag_bits, flag_mode, preserves_carry, output_at,
                    remaining - 1u, scratch_mask, output, &encoded);
                if (status) at += encoded;
            }
        }
        pl_operand zero = { PL_OPERAND_CONST, 0u };
        if (status && write_alu_tree(
                block, selection, destination, zero, bits,
                output_at + at, remaining - 1u, scratch_mask,
                output + at, &encoded)) {
            at += encoded;
            if (emit_set_condition(
                    destination, condition_value_shape.condition,
                    output + at, &encoded)
                    && at <= U32_MAX_VALUE - encoded) {
                *written = at + encoded;
                return 1;
            }
        }
    }

    boolean_select boolean;
    if (boolean_select_details(&block->plan, value, &boolean)) {
        for (pl_u32 inverse = 0u; inverse < 2u; ++inverse) {
            pl_operand current = inverse
                               ? boolean.when_true : boolean.when_false;
            pl_operand candidate = inverse
                                 ? boolean.when_false : boolean.when_true;
            pl_u32 condition_code = inverse ? 4u : 5u;
            if (current.kind == PL_OPERAND_LOCAL
                    && current.value == destination)
                continue;
            pl_u32 candidate_first = 0u;
            pl_u32 candidate_limit = PL_X86_GPR_COUNT;
            int materialize_candidate = candidate.kind == PL_OPERAND_CONST;
            if (candidate.kind == PL_OPERAND_LOCAL) {
                if (candidate.value == destination) continue;
                candidate_first = (pl_u32)candidate.value;
                candidate_limit = candidate_first + 1u;
            }
            for (pl_u32 candidate_local = candidate_first;
                    candidate_local < candidate_limit; ++candidate_local) {
                pl_u32 candidate_bit = 1u << candidate_local;
                if (materialize_candidate
                        && !(scratch_mask & candidate_bit))
                    continue;
                pl_u32 at = 0u, encoded = 0u;
                int status = 1;
                condition_value direct_condition;
                if (condition_value_details(
                        &block->plan, boolean.condition,
                        &direct_condition)) {
                    condition_code = direct_condition.condition ^ inverse;
                    if (!(direct_condition.flags.kind == PL_OPERAND_LOCAL
                            && direct_condition.flags.value
                               == PL_X86_RFLAGS_LOCAL)) {
                        pl_operand flag_left, flag_right;
                        pl_u32 flag_bits = 0u, flag_mode = 0u;
                        pl_u32 preserves_carry = 0u;
                        if (!flag_operation_details(
                                &block->plan, direct_condition.flags,
                                &flag_left, &flag_right, &flag_bits,
                                &flag_mode, &preserves_carry)) {
                            status = 0;
                        } else {
                            status = write_alu_pair(
                                block, selection, destination,
                                flag_left, flag_right, flag_bits, flag_mode,
                                preserves_carry, output_at,
                                remaining - 1u, scratch_mask,
                                output, &encoded);
                            if (status) at += encoded;
                        }
                    }
                } else {
                    pl_u32 condition_bits = operand_expression_bits(
                        &block->plan, boolean.condition, 64u);
                    status = write_alu_tree(
                        block, selection, destination, boolean.condition,
                        condition_bits, output_at, remaining - 1u,
                        scratch_mask, output, &encoded);
                    if (status) {
                        at += encoded;
                        status = emit_test_registers(
                            destination, destination, condition_bits,
                            output + at, &encoded);
                        if (status) at += encoded;
                    }
                }
                if (!status) continue;
                if (!write_alu_tree(
                        block, selection, destination, current,
                        boolean.value_bits, output_at + at,
                        remaining - 1u, scratch_mask & ~candidate_bit,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (materialize_candidate) {
                    if (!write_alu_tree(
                            block, selection, candidate_local, candidate,
                            boolean.value_bits, output_at + at,
                            remaining - 1u,
                            scratch_mask & ~candidate_bit,
                            output + at, &encoded))
                        continue;
                    at += encoded;
                }
                if (!emit_conditional_move(
                        destination, candidate_local, boolean.value_bits,
                        condition_code, output + at, &encoded)
                        || at > U32_MAX_VALUE - encoded)
                    continue;
                *written = at + encoded;
                return 1;
            }
        }
    }

    pl_operand original_left, original_right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!arithmetic_tree_details(
            &block->plan, value, &original_left, &original_right,
            &node_bits, &mode)
            || node_bits != bits)
        return 0;

    low32_entry_overlay low32_overlay;
    if (low32_entry_overlay_details(
            &block->plan, value, destination, &low32_overlay)
            && write_low32_entry_overlay(
                block, selection, &low32_overlay, output_at,
                scratch_mask, output, written))
        return 1;

    split_entry_overlay split_overlay;
    if (split_entry_overlay_details(
            &block->plan, value, destination, &split_overlay)
            && (scratch_mask & (1u << split_overlay.side))) {
        pl_u32 split_work = 0u;
        if (emit_split_entry_overlay(
                &split_overlay, output, written, &split_work)) {
            (void)split_work;
            return 1;
        }
    }

    entry_bit_overlay overlay;
    if (entry_bit_overlay_details(&block->plan, value, &overlay))
        return write_entry_bit_overlay(
            block, selection, destination, &overlay,
            output_at, remaining, scratch_mask, output, written);

    conditional_or_fold fold;
    pl_u32 condition_sources = 0u;
    if (conditional_or_fold_details(
            &block->plan, original_left, original_right,
            bits, mode, &fold)
            && operand_entry_gpr_sources(
                &block->plan, fold.flag_left,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && operand_entry_gpr_sources(
                &block->plan, fold.flag_right,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && !(condition_sources & (1u << destination))) {
        for (pl_u32 candidate = 0u;
                candidate < PL_X86_GPR_COUNT; ++candidate) {
            pl_u32 candidate_bit = 1u << candidate;
            if (!(scratch_mask & candidate_bit)
                    || (condition_sources & candidate_bit))
                continue;
            for (pl_u32 flag_destination = 0u;
                    flag_destination < PL_X86_GPR_COUNT;
                    ++flag_destination) {
                pl_u32 flag_bit = 1u << flag_destination;
                if (flag_destination == candidate
                        || !(scratch_mask & flag_bit))
                    continue;
                pl_u32 at = 0u, encoded = 0u;
                if (!write_alu_tree(
                        block, selection, destination, fold.base, bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~condition_sources,
                        output, &encoded))
                    continue;
                at += encoded;
                if (!emit_gpr_move(
                        candidate, destination, bits,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (!emit_alu_instruction(
                        candidate, fold.mask, bits, 5u, 0u,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (!write_alu_pair(
                        block, selection, flag_destination,
                        fold.flag_left, fold.flag_right, fold.flag_bits,
                        fold.flag_mode, fold.preserves_carry,
                        output_at + at, remaining - 1u,
                        scratch_mask & ~candidate_bit & ~flag_bit,
                        output + at, &encoded))
                    continue;
                at += encoded;
                if (!emit_conditional_move(
                        destination, candidate, bits, fold.condition,
                        output + at, &encoded)
                        || at > U32_MAX_VALUE - encoded)
                    continue;
                *written = at + encoded;
                return 1;
            }
        }
    }

    if (associative_mode(mode)
            && (original_left.kind == PL_OPERAND_CONST
                || (original_left.kind == PL_OPERAND_LOCAL
                    && original_left.value < PL_X86_GPR_COUNT
                    && original_left.value != destination))
            && original_right.kind != PL_OPERAND_CONST
            && original_right.kind != PL_OPERAND_LOCAL) {
        pl_u32 at = 0u, operation = 0u;
        pl_u32 right_bits = operand_expression_bits(
            &block->plan, original_right, bits);
        if (write_alu_tree(
                block, selection, destination, original_right,
                right_bits, output_at, remaining - 1u, scratch_mask,
                output, &at)
                && emit_alu_instruction(
                    destination, original_left, bits, mode, 0u,
                    output + at, &operation)
                && at <= U32_MAX_VALUE - operation) {
            *written = at + operation;
            return 1;
        }
    }

    pl_operand physical_left = original_left;
    pl_operand physical_right = original_right;
    physicalize_published_operand(
        &block->plan, destination, &physical_left);

    if (physical_right.kind == PL_OPERAND_CONST
            || (physical_right.kind == PL_OPERAND_LOCAL
                && physical_right.value < PL_X86_GPR_COUNT
                && physical_right.value != destination)) {
        pl_u32 pinned = physical_right.kind == PL_OPERAND_LOCAL
                      ? 1u << (pl_u32)physical_right.value : 0u;
        pl_u32 at = 0u, operation = 0u;
        if (write_alu_tree(
                block, selection, destination, physical_left, bits,
                output_at, remaining - 1u, scratch_mask & ~pinned,
                output, &at)
                && emit_alu_instruction(
                    destination, physical_right, bits, mode, 0u,
                    output + at, &operation)
                && at <= U32_MAX_VALUE - operation) {
            *written = at + operation;
            return 1;
        }
    }

    pl_u32 owner = PL_X86_GPR_COUNT;
    if (published_operand_local(
                &block->plan, physical_right, &owner)
            && owner != destination) {
        physical_right.kind = PL_OPERAND_LOCAL;
        physical_right.value = owner;
        pl_u32 at = 0u, operation = 0u;
        if (write_alu_tree(
                block, selection, destination, physical_left, bits,
                output_at, remaining - 1u, scratch_mask, output, &at)
                && emit_alu_instruction(
                    destination, physical_right, bits, mode, 0u,
                    output + at, &operation)
                && at <= U32_MAX_VALUE - operation) {
            *written = at + operation;
            return 1;
        }
    }

    if (associative_mode(mode) && scratch_mask
            && (original_left.kind == PL_OPERAND_NODE
                || original_left.kind == PL_OPERAND_PROJECTION)
            && (original_right.kind == PL_OPERAND_NODE
                || original_right.kind == PL_OPERAND_PROJECTION)) {
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            pl_operand trunk = orientation
                             ? original_right : original_left;
            pl_operand side = orientation
                            ? original_left : original_right;
            pl_u32 trunk_sources = 0u, side_sources = 0u;
            if (!operand_entry_gpr_sources(
                    &block->plan, trunk,
                    block->plan.node_count + 1u, remaining,
                    &trunk_sources)
                    || !operand_entry_gpr_sources(
                        &block->plan, side,
                        block->plan.node_count + 1u, remaining,
                        &side_sources)
                    || (side_sources & (1u << destination)))
                continue;
            pl_u32 preferred = scratch_mask & side_sources;
            for (pl_u32 scratch = 0u;
                    scratch < PL_X86_GPR_COUNT; ++scratch) {
                pl_u32 scratch_bit = 1u << scratch;
                if (!(preferred & scratch_bit)) continue;
                pl_u32 trunk_bytes = 0u;
                if (!write_alu_tree(
                        block, selection, destination, trunk, bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~side_sources,
                        output, &trunk_bytes))
                    continue;
                pl_u32 side_bytes = 0u;
                if (trunk_bytes > U32_MAX_VALUE - output_at
                        || !write_alu_tree(
                            block, selection, scratch, side, bits,
                            output_at + trunk_bytes, remaining - 1u,
                            scratch_mask & ~scratch_bit,
                            output + trunk_bytes, &side_bytes))
                    continue;
                pl_operand side_value = {
                    PL_OPERAND_LOCAL, scratch,
                };
                pl_u32 operation = 0u;
                if (trunk_bytes <= U32_MAX_VALUE - side_bytes
                        && emit_alu_instruction(
                            destination, side_value, bits, mode, 0u,
                            output + trunk_bytes + side_bytes, &operation)
                        && trunk_bytes + side_bytes
                           <= U32_MAX_VALUE - operation) {
                    *written = trunk_bytes + side_bytes + operation;
                    return 1;
                }
            }
        }
    }

    if (associative_mode(mode) && scratch_mask) {
        pl_u32 capacity = block->plan.node_count + 1u;
        pl_operand leaves[capacity];
        pl_u32 leaf_count = 0u;
        if (collect_associative_leaves(
                &block->plan, value, bits, mode, leaves, capacity,
                &leaf_count, block->plan.node_count + 1u)
                && leaf_count > 2u) {
            promote_associative_destination_leaf(
                leaves, leaf_count, destination);
            pl_u32 leaf_sources[leaf_count];
            pl_u32 suffix_sources[leaf_count + 1u];
            suffix_sources[leaf_count] = 0u;
            int sources_valid = 1;
            for (pl_u32 at = leaf_count; at-- > 0u;) {
                leaf_sources[at] = 0u;
                if (!operand_entry_gpr_sources(
                        &block->plan, leaves[at],
                        block->plan.node_count + 1u,
                        remaining, &leaf_sources[at])) {
                    sources_valid = 0;
                    break;
                }
                suffix_sources[at] = suffix_sources[at + 1u]
                                   | leaf_sources[at];
            }
            if (sources_valid
                    && !(suffix_sources[1u] & (1u << destination))) {
                pl_u32 total = 0u;
                pl_u32 leaf_bits = operand_expression_bits(
                    &block->plan, leaves[0], bits);
                int status = write_alu_tree(
                    block, selection, destination, leaves[0], leaf_bits,
                    output_at, remaining - 1u,
                    scratch_mask & ~suffix_sources[1u],
                    output, &total);
                for (pl_u32 at = 1u; status && at < leaf_count; ++at) {
                    pl_u32 available = scratch_mask
                                     & ~suffix_sources[at + 1u];
                    pl_u32 scratch = 0u;
                    pl_u32 final_owner = available & leaf_sources[at];
                    pl_u32 preferred = final_owner ? final_owner : available;
                    while (scratch < PL_X86_GPR_COUNT
                            && !(preferred & (1u << scratch)))
                        ++scratch;
                    if (scratch == PL_X86_GPR_COUNT
                            || total > U32_MAX_VALUE - output_at) {
                        status = 0;
                        break;
                    }
                    pl_u32 part = 0u;
                    leaf_bits = operand_expression_bits(
                        &block->plan, leaves[at], bits);
                    status = write_alu_tree(
                        block, selection, scratch, leaves[at], leaf_bits,
                        output_at + total, remaining - 1u,
                        available & ~(1u << scratch),
                        output + total, &part);
                    pl_operand scratch_value = {
                        PL_OPERAND_LOCAL, scratch,
                    };
                    pl_u32 operation = 0u;
                    if (!status || total > U32_MAX_VALUE - part
                            || !emit_alu_instruction(
                                destination, scratch_value, bits, mode, 0u,
                                output + total + part, &operation)
                            || total + part > U32_MAX_VALUE - operation) {
                        status = 0;
                        break;
                    }
                    total += part + operation;
                }
                if (status) {
                    *written = total;
                    return 1;
                }
            }
        }
    }

    pl_u32 orientations = mode == 3u ? 1u : 2u;
    pl_u32 first_orientation = entry_bit_chain_orientation(
        &block->plan, original_left, original_right, destination, mode);
    for (pl_u32 attempt = 0u; attempt < orientations; ++attempt) {
        pl_u32 orientation = attempt ^ first_orientation;
        pl_operand left = orientation ? original_right : original_left;
        pl_operand right = orientation ? original_left : original_right;
        pl_u32 left_sources = 0u;
        pl_u32 right_sources = 0u;
        if (!operand_entry_gpr_sources(
                &block->plan, left, block->plan.node_count + 1u,
                remaining, &left_sources)
                || !operand_entry_gpr_sources(
                    &block->plan, right,
                    block->plan.node_count + 1u,
                    remaining, &right_sources))
            continue;
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            pl_u32 scratch_bit = 1u << scratch;
            if (!(scratch_mask & scratch_bit)) continue;
            if (!(left_sources & scratch_bit)) {
                pl_u32 right_bytes = 0u;
                if (write_alu_tree(
                        block, selection, scratch, right, bits, output_at,
                        remaining - 1u, scratch_mask & ~scratch_bit,
                        output, &right_bytes)) {
                    pl_u32 left_bytes = 0u;
                    if (right_bytes <= U32_MAX_VALUE - output_at
                            && write_alu_tree(
                                block, selection, destination, left, bits,
                                output_at + right_bytes, remaining - 1u,
                                scratch_mask & ~scratch_bit,
                                output + right_bytes, &left_bytes)) {
                        pl_operand scratch_value = {
                            PL_OPERAND_LOCAL, scratch,
                        };
                        pl_u32 operation = 0u;
                        if (right_bytes <= U32_MAX_VALUE - left_bytes
                                && emit_alu_instruction(
                                    destination, scratch_value, bits, mode,
                                    0u, output + right_bytes + left_bytes,
                                    &operation)
                                && right_bytes + left_bytes
                                   <= U32_MAX_VALUE - operation) {
                            *written = right_bytes + left_bytes + operation;
                            return 1;
                        }
                    }
                }
            }
            if (right_sources & (1u << destination)) continue;
            pl_u32 left_bytes = 0u;
            if (!write_alu_tree(
                    block, selection, destination, left, bits, output_at,
                    remaining - 1u,
                    scratch_mask & ~right_sources,
                    output, &left_bytes))
                continue;
            pl_u32 right_bytes = 0u;
            if (left_bytes > U32_MAX_VALUE - output_at
                    || !write_alu_tree(
                        block, selection, scratch, right, bits,
                        output_at + left_bytes, remaining - 1u,
                        scratch_mask & ~scratch_bit,
                        output + left_bytes, &right_bytes))
                continue;
            pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
            pl_u32 operation = 0u;
            if (left_bytes <= U32_MAX_VALUE - right_bytes
                    && emit_alu_instruction(
                        destination, scratch_value, bits, mode, 0u,
                        output + left_bytes + right_bytes, &operation)
                    && left_bytes + right_bytes
                       <= U32_MAX_VALUE - operation) {
                *written = left_bytes + right_bytes + operation;
                return 1;
            }
        }
    }
    physicalize_selected_operand(&block->plan, selection, destination, &physical_left);
    if (associative_mode(mode) && physical_left.kind == PL_OPERAND_LOCAL
            && physical_left.value != destination) {
        pl_u32 prefix = 0u, operation = 0u;
        if (write_alu_tree(
                block, selection, destination, original_right, bits, output_at,
                remaining - 1u, scratch_mask & ~(1u << physical_left.value),
                output, &prefix)
                && emit_alu_instruction(destination, physical_left, bits, mode, 0u,
                                         output + prefix, &operation)
                && prefix <= U32_MAX_VALUE - operation) {
            *written = prefix + operation;
            return 1;
        }
    }
    return 0;
}

static int measure_quotient_boundary_select(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !shape || !bytes
            || !instructions || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 quotient_bytes = 0u, quotient_work = 0u;
    int measured = measure_alu_tree(
        frontend, block, selection, destination, shape->quotient,
        shape->select.value_bits, output_at, remaining - 1u,
        scratch_mask, &quotient_bytes, &quotient_work);
    pl_u32 compare_bytes = 0u, suffix_bytes = 0u, move_bytes = 0u;
    pl_operand destination_value = {
        PL_OPERAND_LOCAL, destination,
    };
    if (measured <= 0
            || !emit_compare_operand(
                destination, shape->projected_compare_right,
                shape->select.compare_bits, 0, &compare_bytes)
            || !emit_add_lea(
                destination, destination_value, shape->offset,
                shape->select.value_bits, 0, &suffix_bytes)
            || !emit_conditional_move(
                destination, shape->select.candidate_local,
                shape->select.value_bits, shape->select.condition,
                0, &move_bytes)
            || quotient_bytes > U32_MAX_VALUE - compare_bytes
            || quotient_bytes + compare_bytes
               > U32_MAX_VALUE - suffix_bytes
            || quotient_bytes + compare_bytes + suffix_bytes
               > U32_MAX_VALUE - move_bytes
            || quotient_work > U32_MAX_VALUE - 3u)
        return measured < 0 ? measured : 0;
    *bytes = quotient_bytes + compare_bytes + suffix_bytes + move_bytes;
    *instructions = quotient_work + 3u;
    selection->direct_nested_frame = 1u;
    return 1;
}

static int write_entry_bit_overlay(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !shape || !output || !written
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 at = 0u, part = 0u;
    if (!write_alu_seed(
            block, selection, destination, shape->base,
            shape->bits, output_at, remaining - 1u,
            output, &part))
        return 0;
    at += part;
    pl_u32 overlay_work = 0u;
    if (!emit_entry_bit_overlay(
            destination, shape, output + at, &part, &overlay_work)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    (void)overlay_work;
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (!(scratch_mask & scratch_bit) || scratch == destination)
            continue;
        pl_u32 side_bytes = 0u;
        if (at > U32_MAX_VALUE - output_at
                || !write_alu_tree(
                    block, selection, scratch, shape->side,
                    shape->bits, output_at + at, remaining - 1u,
                    scratch_mask & ~scratch_bit,
                    output + at, &side_bytes))
            continue;
        pl_operand side = { PL_OPERAND_LOCAL, scratch };
        pl_u32 join_bytes = 0u;
        if (at > U32_MAX_VALUE - side_bytes
                || !emit_alu_instruction(
                    destination, side, shape->bits, 5u, 0u,
                    output + at + side_bytes, &join_bytes)
                || at + side_bytes > U32_MAX_VALUE - join_bytes)
            continue;
        *written = at + side_bytes + join_bytes;
        return 1;
    }
    return 0;
}

static int write_quotient_boundary_select(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !shape || !output || !written
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 at = 0u, part = 0u;
    if (!write_alu_tree(
            block, selection, destination, shape->quotient,
            shape->select.value_bits, output_at, remaining - 1u,
            scratch_mask, output, &part))
        return 0;
    at += part;
    if (!emit_compare_operand(
            destination, shape->projected_compare_right,
            shape->select.compare_bits, output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    pl_operand destination_value = {
        PL_OPERAND_LOCAL, destination,
    };
    if (!emit_add_lea(
            destination, destination_value, shape->offset,
            shape->select.value_bits, output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    if (!emit_conditional_move(
            destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition,
            output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    *written = at + part;
    return 1;
}

static int write_alu_pair(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand left,
                          pl_operand right, pl_u32 bits, pl_u32 mode,
                          pl_u32 preserves_carry, pl_u32 output_at,
                          pl_u32 remaining, pl_u32 scratch_mask,
                          pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !output || !written || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    if (!preserves_carry && (mode == 3u || mode == 6u)
            && left.kind == right.kind && left.value == right.value) {
        pl_operand self = { PL_OPERAND_LOCAL, destination };
        return emit_alu_instruction(
            destination, self, bits, mode, 0u, output, written);
    }
    if (!preserves_carry && mode == 3u
            && left.kind == PL_OPERAND_CONST && !left.value) {
        pl_u32 prefix = 0u, operation = 0u;
        if (!write_alu_tree(block, selection, destination, right, bits, output_at,
                remaining - 1u, scratch_mask, output, &prefix)
                || !emit_neg_register(destination, bits, output + prefix, &operation)
                || prefix > U32_MAX_VALUE - operation) return 0;
        *written = prefix + operation;
        return 1;
    }
    pl_u32 owner = PL_X86_GPR_COUNT;
    physicalize_published_operand(&block->plan, destination, &left);
    if (published_operand_local(&block->plan, right, &owner)
            && owner != destination) {
        right.kind = PL_OPERAND_LOCAL;
        right.value = owner;
    }
    pl_u32 left_bits = alu_input_expression_bits(&block->plan, left, bits);
    pl_u32 right_bits = alu_input_expression_bits(&block->plan, right, bits);
    if (right.kind == PL_OPERAND_CONST
            || (right.kind == PL_OPERAND_LOCAL
                && right.value < PL_X86_GPR_COUNT)) {
        pl_u32 prefix = 0u, operation = 0u;
        if (write_alu_tree(
                block, selection, destination, left, left_bits, output_at,
                remaining - 1u, scratch_mask, output, &prefix)
                && emit_alu_instruction(
                    destination, right, bits, mode, preserves_carry,
                    output + prefix, &operation)
                && prefix <= U32_MAX_VALUE - operation) {
            *written = prefix + operation;
            return 1;
        }
        return 0;
    }

    pl_u32 left_sources = 0u;
    if (!operand_entry_gpr_sources(
            &block->plan, left, block->plan.node_count + 1u,
            remaining, &left_sources))
        return 0;
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (!(scratch_mask & scratch_bit) || (left_sources & scratch_bit))
            continue;
        pl_u32 right_bytes = 0u;
        if (!write_alu_tree(
                block, selection, scratch, right, right_bits, output_at,
                remaining - 1u, scratch_mask & ~scratch_bit,
                output, &right_bytes))
            continue;
        if (right_bytes > U32_MAX_VALUE - output_at) continue;
        pl_u32 left_bytes = 0u;
        if (!write_alu_tree(
                block, selection, destination, left, left_bits,
                output_at + right_bytes, remaining - 1u,
                scratch_mask & ~scratch_bit,
                output + right_bytes, &left_bytes))
            continue;
        pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
        pl_u32 operation = 0u;
        if (right_bytes <= U32_MAX_VALUE - left_bytes
                && emit_alu_instruction(
                    destination, scratch_value, bits, mode,
                    preserves_carry, output + right_bytes + left_bytes,
                    &operation)
                && right_bytes + left_bytes
                   <= U32_MAX_VALUE - operation) {
            *written = right_bytes + left_bytes + operation;
            return 1;
        }
    }
    return 0;
}

static int write_direct_frame(const pl_x86_block *block,
                              const pl_x86_native_selection *selection,
                              pl_u8 *output)
{
    if (!block || !selection || !selection->direct_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u;
    pl_u32 pending = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        if (value.kind != PL_OPERAND_LOCAL || value.value != local)
            pending |= 1u << local;
    }
    while (pending) {
        pl_u32 needed = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local))) continue;
            pl_operand value = block->plan.locals[local];
            if (value.kind == PL_OPERAND_LOCAL) {
                if (value.value >= PL_X86_GPR_COUNT)
                    return PL_ERROR_X86_SELECT;
                needed |= 1u << (pl_u32)value.value;
            }
        }
        pl_u32 local = 0u;
        while (local < PL_X86_GPR_COUNT
                && (!(pending & (1u << local))
                    || (needed & (1u << local))))
            ++local;
        if (local == PL_X86_GPR_COUNT) return PL_ERROR_X86_SELECT;
        pl_operand value = block->plan.locals[local];
        pl_u32 encoded = 0u;
        if (!write_frame_value(
                selection, at, local, value, output + at, &encoded))
            return PL_ERROR_X86_SELECT;
        at += encoded;
        pending &= ~(1u << local);
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = 0u;
        pl_u32 target_owner = PL_X86_GPR_COUNT;
        if (block->dynamic_target) {
            if (!published_operand_local(
                    &block->plan, block->target, &target_owner)
                    || !emit_indirect_jump(
                        target_owner, 0, &branch_bytes))
                return PL_ERROR_X86_SELECT;
        } else {
            branch_bytes = block->relax_short_control ? 5u : 2u;
        }
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        if (block->dynamic_target) {
            if (!emit_indirect_jump(
                    target_owner, output + at, &branch_bytes))
                return PL_ERROR_X86_SELECT;
            at += branch_bytes;
        } else {
            output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
            for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
                output[at++] = 0u;
        }
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_add_frame(const pl_x86_block *block,
                                  const pl_x86_native_selection *selection,
                                  pl_u8 *output)
{
    if (!block || !selection || !selection->direct_add_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 node_destination, bits, changed;
    if (!add_frame_shape(
            &block->plan, &node_destination, &bits, &changed))
        return PL_ERROR_X86_SELECT;
    pl_u32 pending = changed;
    pl_u32 at = 0u;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_add_frame_assignment(
                &block->plan, pending, node_destination, &local))
            return PL_ERROR_X86_SELECT;
        if (local == node_destination) {
            const pl_node *node = &block->plan.nodes[0];
            pl_u32 encoded = 0u;
            if (!emit_add_lea(
                    local,
                    block->plan.arguments[node->argument_at],
                    block->plan.arguments[node->argument_at + 1u],
                    bits, output + at, &encoded))
                return PL_ERROR_X86_SELECT;
            at += encoded;
        } else {
            pl_operand value = block->plan.locals[local];
            pl_u32 encoded = 0u;
            if (!write_frame_value(
                    selection, at, local, value, output + at, &encoded))
                return PL_ERROR_X86_SELECT;
            at += encoded;
        }
        pending &= ~(1u << local);
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_mul_add_carry_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    pl_u8 *output)
{
    mul_add_carry_frame shape;
    pl_u32 written = 0u;
    if (!block || !selection || !selection->direct_mul_add_carry_frame
            || !output || !mul_add_carry_frame_shape(block, &shape)
            || !emit_mul_add_carry_frame(&shape, output, &written)
            || written != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}

static int write_direct_condition_carry_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    pl_u8 *output)
{
    condition_carry_frame shape;
    pl_u32 written = 0u;
    if (!block || !selection || !selection->direct_condition_carry_frame
            || !output || !condition_carry_frame_shape(block, &shape)
            || !emit_condition_carry_frame(&shape, output, &written)
            || written != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}

static int write_direct_mutable_xor_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !output) return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, final_flag_node = 0u;
    mutable_xor_frame shape;
    if (!alu_frame_shape(&block->plan, &changed, &final_flag_node)
            || !mutable_xor_frame_details(
                &block->plan, changed, final_flag_node, &shape))
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, part = 0u;
    if (!write_alu_tree(
            block, selection, shape.independent_owner,
            shape.independent, shape.independent_bits, at,
            block->plan.node_count + 1u, 0u,
            output + at, &part))
        return PL_ERROR_X86_SELECT;
    at += part;
    if (!write_alu_tree(
            block, selection, shape.destination,
            shape.accumulator, shape.accumulator_bits, at,
            block->plan.node_count + 1u, 0u,
            output + at, &part))
        return PL_ERROR_X86_SELECT;
    at += part;
    pl_operand mutable_value = {
        PL_OPERAND_LOCAL, shape.mutable_owner,
    };
    pl_operand independent_value = {
        PL_OPERAND_LOCAL, shape.independent_owner,
    };
#define WRITE_MUTABLE(operation) do { \
        part = 0u; \
        if (!(operation) || at > U32_MAX_VALUE - part) \
            return PL_ERROR_X86_SELECT; \
        at += part; \
    } while (0)
    WRITE_MUTABLE(emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        output + at, &part));
    WRITE_MUTABLE(emit_shift_instruction(
        shape.mutable_owner, shape.mutable_shift_amount, 64u,
        shape.mutable_shift_group, output + at, &part));
    WRITE_MUTABLE(emit_alu_instruction(
        shape.mutable_owner, independent_value, 64u, 6u, 0u,
        output + at, &part));
    WRITE_MUTABLE(emit_alu_instruction(
        shape.destination, mutable_value, 64u, 6u, 0u,
        output + at, &part));
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.zero_mask & (1u << local))
                || local == shape.flag_owner)
            continue;
        WRITE_MUTABLE(emit_zero_register(
            local, output + at, &part));
    }
    WRITE_MUTABLE(emit_zero_register(
        shape.flag_owner, output + at, &part));
#undef WRITE_MUTABLE
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_shared_parent_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    const shared_parent_frame *shape, pl_u8 *output)
{
    if (!block || !selection || !shape || !output) return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, part = 0u;
    if (!write_alu_tree(
            block, selection, shape->destination, shape->accumulator,
            shape->bits, at, block->plan.node_count + 1u, 0u,
            output + at, &part))
        return PL_ERROR_X86_SELECT;
    at += part;
#define WRITE_SHARED_PARENT(operation_) do {                               \
        part = 0u;                                                          \
        if (!(operation_) || at > U32_MAX_VALUE - part)                    \
            return PL_ERROR_X86_SELECT;                                    \
        at += part;                                                         \
    } while (0)
    WRITE_SHARED_PARENT(emit_shift_instruction(
        shape->mutable_owner, shape->parent_shift_amount,
        shape->bits, shape->parent_shift_group, output + at, &part));
    WRITE_SHARED_PARENT(emit_gpr_move(
        shape->sibling_owner, shape->mutable_owner,
        shape->bits, output + at, &part));
    WRITE_SHARED_PARENT(emit_alu_instruction(
        shape->mutable_owner, shape->mutable_right,
        shape->bits, shape->mutable_mode, 0u, output + at, &part));
    WRITE_SHARED_PARENT(emit_alu_instruction(
        shape->sibling_owner, shape->sibling_right,
        shape->bits, shape->sibling_mode, 0u, output + at, &part));
    pl_operand sibling = { PL_OPERAND_LOCAL, shape->sibling_owner };
    pl_operand mutable = { PL_OPERAND_LOCAL, shape->mutable_owner };
    WRITE_SHARED_PARENT(emit_alu_instruction(
        shape->destination, sibling, shape->bits,
        shape->root_mode, 0u, output + at, &part));
    WRITE_SHARED_PARENT(emit_alu_instruction(
        shape->destination, mutable, shape->bits,
        shape->root_mode, 0u, output + at, &part));
#undef WRITE_SHARED_PARENT
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_alu_frame(const pl_x86_block *block,
                                  const pl_x86_native_selection *selection,
                                  pl_u8 *output)
{
    if (!block || !selection || !selection->direct_alu_frame || !output)
        return PL_ERROR_X86_SELECT;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u, tail = block->relax_short_control ? 6u : 2u;
        if (!conditional_alu_body(block, &body, &condition)
                || selection->output_bytes < tail) return PL_ERROR_X86_SELECT;
        pl_x86_native_selection body_selection = *selection;
        body_selection.output_bytes -= tail;
        int status = write_direct_alu_frame(&body, &body_selection, output);
        if (status) return status;
        pl_u32 at = body_selection.output_bytes;
        if (block->relax_short_control) output[at++] = 0x0fu;
        output[at++] = (pl_u8)((block->relax_short_control ? 0x80u : 0x70u) | condition);
        while (at < selection->output_bytes) output[at++] = 0u;
        return 0;
    }
    pl_u32 changed, final_flag_node;
    if (!alu_frame_shape(&block->plan, &changed, &final_flag_node))
        return PL_ERROR_X86_SELECT;
    entry_select_bit_test_frame entry_select_test;
    if (entry_select_bit_test_frame_shape(
            block, changed, final_flag_node, &entry_select_test)) {
        pl_u32 written = 0u;
        if (!emit_entry_select_bit_test_frame(
                &entry_select_test, output, &written)
                || written != selection->output_bytes)
            return PL_ERROR_X86_SELECT;
        return 0;
    }
    if (selection->direct_shared_parent_frame) {
        shared_parent_frame shared_parent;
        if (!shared_parent_frame_shape(
                block, changed, final_flag_node, &shared_parent))
            return PL_ERROR_X86_SELECT;
        return write_shared_parent_frame(
            block, selection, &shared_parent, output);
    }
    narrow_flag_transfer narrow_transfer;
    if (narrow_flag_transfer_shape(block, &narrow_transfer)) {
        pl_u32 at = 0u, written = 0u;
        if (!emit_zero_extend_move(
                narrow_transfer.destination, narrow_transfer.source,
                32u, output, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!emit_low8_alu_flags(
                narrow_transfer.destination, narrow_transfer.right,
                narrow_transfer.mode, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!write_frame_value(
                selection, at, narrow_transfer.source,
                narrow_transfer.source_publication,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        return at == selection->output_bytes
             ? 0 : PL_ERROR_X86_SELECT;
    }
    independent_flag_overwrite overwrite;
    if (independent_flag_overwrite_shape(&block->plan, &overwrite)) {
        pl_u32 at = 0u, written = 0u;
        if (!emit_low8_alu_flags(
                overwrite.destination, overwrite.right, overwrite.mode,
                output, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!emit_scaled_lea(
                overwrite.destination, overwrite.value_source,
                overwrite.value_bits, overwrite.scale_log2,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        return at == selection->output_bytes
             ? 0 : PL_ERROR_X86_SELECT;
    }
    standalone_flag_publication exact_flags;
    if (final_flag_node
            && !publication_emits_flag_node(
                &block->plan, changed, final_flag_node)
            && !flag_node_has_value_publication(
                &block->plan, changed, final_flag_node)
            && !standalone_flag_publication_details(
                &block->plan, final_flag_node, &exact_flags))
        return PL_ERROR_X86_SELECT;
    pl_u32 frame_sources[PL_X86_GPR_COUNT];
    pl_u32 frame_dependencies[PL_X86_GPR_COUNT];
    if (!alu_frame_source_laws(
            &block->plan, frame_sources, frame_dependencies))
        return PL_ERROR_X86_SELECT;
    add_flag_chain_dependencies(
        &block->plan, final_flag_node, frame_dependencies);
    if (!apply_shared_flag_producer_laws(
            &block->plan, changed, final_flag_node,
            frame_sources, frame_dependencies))
        return PL_ERROR_X86_SELECT;
    shared_flag_select_handoff flag_select = { 0 };
    int has_flag_select = shared_flag_select_handoff_shape(
        &block->plan, changed, final_flag_node, &flag_select);
    generation_join_handoff generation_join = { 0 };
    int has_generation_join = generation_join_handoff_shape(
        &block->plan, changed, final_flag_node,
        frame_sources, &generation_join);
    if (has_flag_select && has_generation_join)
        return PL_ERROR_X86_SELECT;
    standalone_flag_publication standalone_flags;
    int standalone_flags_pending = !publication_emits_flag_node(
            &block->plan, changed, final_flag_node)
        && !flag_node_has_value_publication(
            &block->plan, changed, final_flag_node)
        && standalone_flag_publication_details(
            &block->plan, final_flag_node, &standalone_flags);
    pl_u32 pending = changed;
    pl_u32 at = 0u;
    if (has_generation_join) {
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(generation_join.preload_mask & (1u << local))) continue;
            pl_u32 part = 0u;
            if (!write_frame_value(selection, at, local,
                    block->plan.locals[local], output + at, &part))
                return PL_ERROR_X86_SELECT;
            at += part;
            pending &= ~(1u << local);
        }
        pl_u32 written = 0u;
        pl_x86_native_selection seed_selection = *selection;
        seed_selection.frame_alias_present = 0u;
        pl_u32 seed_source = 0u, seed_bits = 0u;
        if (generation_join.seed.kind == PL_OPERAND_NODE
                && zero_extend_node(
                    &block->plan,
                    (pl_u32)generation_join.seed.value,
                    &seed_source, &seed_bits)
                && seed_bits == generation_join.bits) {
            if (!emit_zero_extend_move(
                    generation_join.destination, seed_source, seed_bits,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
        } else if (!write_alu_tree(
                       block, &seed_selection,
                       generation_join.destination,
                       generation_join.seed, generation_join.bits, at,
                       block->plan.node_count + 1u, generation_join.scratch_mask,
                       output + at, &written)) {
            return PL_ERROR_X86_SELECT;
        }
        at += written;
        if (!apply_generation_join_laws(
                &block->plan, changed, &generation_join,
                frame_sources, frame_dependencies))
            return PL_ERROR_X86_SELECT;
    }
    if (has_flag_select) {
        const pl_u32 arm[2] = {
            flag_select.candidate_first
                ? flag_select.candidate : flag_select.destination,
            flag_select.candidate_first
                ? flag_select.destination : flag_select.candidate,
        };
        for (pl_u32 index = 0u; index < 2u; ++index) {
            const pl_u32 local = arm[index];
            const pl_operand value = local == flag_select.destination
                ? flag_select.select.current : block->plan.locals[local];
            pl_u32 written = 0u;
            if (!write_alu_tree(
                    block, selection, local, value,
                    flag_select.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
        }
        pl_u32 written = 0u;
        if (!write_alu_pair(
                block, selection, flag_select.flag_owner,
                flag_select.flag_left, flag_select.flag_right,
                flag_select.flag_bits, flag_select.flag_mode, 0u, at,
                block->plan.node_count + 1u, 0u,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        if (!emit_conditional_move(
                flag_select.destination, flag_select.candidate,
                flag_select.bits, flag_select.select.condition,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~((1u << flag_select.destination)
                   | (1u << flag_select.candidate)
                   | (1u << flag_select.flag_owner));
    }
    if (!has_flag_select && !has_generation_join) {
        flag_value_preload preload;
        if (flag_value_preload_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies, &preload)) {
            pl_x86_native_selection pre = *selection;
            pre.frame_alias_present = 0u;
            pre.value_alias_count = selection->value_alias_frame_count;
            pl_u32 written = 0u;
            if (write_alu_tree(
                    block, &pre, preload.destination,
                    preload.tree, preload.tree_bits, at,
                    block->plan.node_count + 1u, preload.scratch,
                    output + at, &written)) {
                at += written;
                frame_sources[preload.destination] =
                    preload.other_source | (1u << preload.destination);
            }
        }
    }
    pl_x86_native_selection frame_write = *selection;
    frame_write.frame_alias_kind = selection->frame_alias_frame_kind;
    frame_write.frame_alias_local = selection->frame_alias_frame_local;
    frame_write.frame_alias_present = selection->frame_alias_frame_present;
    frame_write.value_alias_count = selection->value_alias_frame_count;
    selection = &frame_write;
    while (pending || standalone_flags_pending) {
        select_generation_group select_group;
        if (select_generation_group_shape(&block->plan, pending,
                standalone_flags_pending ? standalone_flags.entry_sources : 0u, &select_group)
                && (standalone_flags_pending || select_group.select.compare_node == final_flag_node)) {
            pl_u32 part = 0u;
            if (!write_select_generation_group(block, selection, &select_group,
                    at, output + at, &part) || at > selection->output_bytes
                    || part > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += part;
            pending &= ~select_group.members;
            continue;
        }
        if (standalone_flags_pending) {
            pl_u32 clobberers = 0u;
            for (pl_u32 local = 0u;
                    local < PL_X86_GPR_COUNT; ++local)
                if ((pending & (1u << local))
                        && frame_local_emission_clobbers_flags(
                            &block->plan, local))
                    clobberers |= 1u << local;
            if (!clobberers
                    && !(standalone_flags.owner_dependencies & pending)) {
                pl_u32 written = 0u;
                if (!emit_standalone_flag_publication(
                        &standalone_flags, output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                standalone_flags_pending = 0;
                if (!pending) continue;
            }
        }
        shared_diamond_handoff diamond;
        if (shared_diamond_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &diamond)) {
            pl_u32 written = 0u;
            if (!write_alu_tree(
                    block, selection, diamond.parent_owner,
                    diamond.parent, diamond.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pl_operand parent = {
                PL_OPERAND_LOCAL, diamond.parent_owner,
            };
            if (!emit_alu_instruction(
                    diamond.side_owner, parent, diamond.bits,
                    diamond.side_mode, 0u, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!emit_gpr_move(
                    diamond.root, diamond.side_owner, diamond.bits,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!emit_shift_instruction(
                    diamond.parent_owner, diamond.shift_amount,
                    diamond.bits, diamond.shift_group,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!emit_alu_instruction(
                    diamond.root, parent, diamond.bits,
                    diamond.root_mode, 0u, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pending &= ~(1u << diamond.root);
            continue;
        }
        arithmetic_width_handoff width_handoff;
        if (arithmetic_width_handoff_shape(
                &block->plan, pending, frame_sources,
                frame_dependencies, &width_handoff)) {
            pl_u32 scratch_mask = alu_frame_scratch_mask(
                pending, width_handoff.parent_destination,
                frame_sources);
            scratch_mask &= ~((1u << width_handoff.parent_destination)
                            | (1u << width_handoff.wide_destination)
                            | (1u << width_handoff.narrow_destination));
            pl_u32 written = 0u;
            if (!write_alu_tree(
                    block, selection, width_handoff.wide_destination,
                    width_handoff.parent, 64u, at,
                    block->plan.node_count + 1u, scratch_mask,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!emit_gpr_move(
                    width_handoff.parent_destination,
                    width_handoff.wide_destination, 64u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!emit_alu_instruction(
                    width_handoff.wide_destination,
                    width_handoff.right, 64u, width_handoff.mode, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!emit_gpr_move(
                    width_handoff.narrow_destination,
                    width_handoff.wide_destination, 32u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pending &= ~((1u << width_handoff.parent_destination)
                       | (1u << width_handoff.wide_destination)
                       | (1u << width_handoff.narrow_destination));
            continue;
        }
        shift_sibling_handoff handoff;
        if (shift_sibling_handoff_shape(
                &block->plan, pending, final_flag_node,
                frame_sources, &handoff)) {
            pl_u32 written = 0u;
            if (handoff.scratch == PL_X86_GPR_COUNT) {
                if (!emit_gpr_move(
                        handoff.flag_destination, handoff.source,
                        handoff.bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!emit_shift_instruction(
                        handoff.sibling_destination,
                        handoff.sibling_amount, handoff.bits,
                        handoff.sibling_group, output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!emit_shift_instruction(
                        handoff.flag_destination, handoff.flag_amount,
                        handoff.bits, handoff.flag_group,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                pending &= ~((1u << handoff.flag_destination)
                           | (1u << handoff.sibling_destination));
                continue;
            }
            if (!write_alu_tree(
                    block, selection, handoff.scratch,
                    handoff.sibling_value, handoff.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!write_alu_tree(
                    block, selection, handoff.flag_destination,
                    handoff.flag_value, handoff.bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!emit_gpr_move(
                    handoff.sibling_destination, handoff.scratch,
                    handoff.bits, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (!write_frame_value(
                    selection, at, handoff.scratch,
                    block->plan.locals[handoff.scratch],
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            pending &= ~((1u << handoff.flag_destination)
                       | (1u << handoff.sibling_destination)
                       | (1u << handoff.scratch));
            continue;
        }
        pl_u32 local = 0u;
        if (!next_alu_frame_assignment(
                &block->plan, pending, final_flag_node,
                frame_sources, frame_dependencies,
                standalone_flags_pending
                    ? standalone_flags.entry_sources : 0u,
                &local)) {
            shared_root_unary_handoff root_handoff;
            if (shared_root_unary_handoff_shape(
                    &block->plan, pending, final_flag_node, &root_handoff)) {
                pl_u32 seed_bytes = 0u, copy_bytes = 0u;
                pl_u32 op_a = 0u, op_b = 0u;
                if (!write_alu_tree(block, selection, root_handoff.seed_dest,
                        root_handoff.seed, root_handoff.seed_bits, at,
                        block->plan.node_count + 1u, 0u,
                        output + at, &seed_bytes)
                        || at > selection->output_bytes
                        || seed_bytes > selection->output_bytes - at
                        || !emit_gpr_move(root_handoff.copy_dest,
                            root_handoff.seed_dest, root_handoff.bits,
                            output + at + seed_bytes, &copy_bytes)
                        || copy_bytes > selection->output_bytes - at
                                        - seed_bytes
                        || !emit_shared_root_consumer(
                            &root_handoff.dest_consumer,
                            output + at + seed_bytes + copy_bytes, &op_a)
                        || op_a > selection->output_bytes - at - seed_bytes
                                - copy_bytes
                        || !emit_shared_root_consumer(
                            &root_handoff.copy_consumer,
                            output + at + seed_bytes + copy_bytes + op_a,
                            &op_b)
                        || op_b > selection->output_bytes - at - seed_bytes
                                - copy_bytes - op_a)
                    return PL_ERROR_X86_SELECT;
                at += seed_bytes + copy_bytes + op_a + op_b;
                pending &= ~((1u << root_handoff.seed_dest)
                           | (1u << root_handoff.copy_dest));
                continue;
            }
            return PL_ERROR_X86_SELECT;
        }
        pl_u32 scratch_mask = alu_frame_scratch_mask(
            pending, local, frame_sources);
        pl_operand value = block->plan.locals[local];
        masked_entry_affine entry_affine;
        pl_u32 publication = publication_owner(&block->plan, value);
        if (has_generation_join
                && local == generation_join.destination) {
            pl_u32 written = 0u;
            if (!emit_generation_join(&generation_join, output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
        } else if (publication < PL_X86_GPR_COUNT
                && publication != local) {
            pl_u32 bits = publication_copy_bits(
                &block->plan, selection, value, at);
            pl_u32 written = 0u;
            pl_u32 move_bytes = 0u, zero_bytes = U32_MAX_VALUE;
            if (!emit_gpr_move(
                    local, publication, bits,
                    (pl_u8 *)0, &move_bytes))
                return PL_ERROR_X86_SELECT;
            if (value.kind == PL_OPERAND_CONST && !value.value
                    && !emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes))
                return PL_ERROR_X86_SELECT;
            int emitted = zero_bytes < move_bytes
                ? emit_zero_register(local, output + at, &written)
                : emit_gpr_move(
                    local, publication, bits, output + at, &written);
            if (!emitted) return PL_ERROR_X86_SELECT;
            at += written;
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 written = 0u;
            {
                pl_u32 destination, bits, mode, preserves_carry;
                pl_operand source;
                pl_operand right;
                if (bit_summary_details(&block->plan, value, &source, &bits, &mode)) {
                    physicalize_selected_operand(&block->plan, selection, local, &source);
                    pl_u32 source_local = local, prefix = 0u, operation = 0u;
                    if (source.kind == PL_OPERAND_LOCAL
                            && source.value < PL_X86_GPR_COUNT)
                        source_local = (pl_u32)source.value;
                    else if (!write_alu_tree(block, selection, local, source,
                            bits, at, block->plan.node_count + 1u, scratch_mask,
                            output + at, &prefix)) return PL_ERROR_X86_SELECT;
                    if (!emit_bit_summary(local, source_local, bits, mode,
                            output + at + prefix, &operation)) return PL_ERROR_X86_SELECT;
                    written = prefix + operation;
                } else {
                if (!alu_node_details(
                        &block->plan, (pl_u32)(value.value >> 8u),
                        &destination, &source, &right,
                        &bits, &mode, &preserves_carry)
                        || destination != local)
                    return PL_ERROR_X86_SELECT;
                if (!preserves_carry && mode == 3u
                        && source.kind == PL_OPERAND_CONST && !source.value
                        && right.kind == PL_OPERAND_LOCAL
                        && right.value == local) {
                    if (!emit_neg_register(
                            local, bits, output + at, &written))
                        return PL_ERROR_X86_SELECT;
                } else {
                    if (!write_alu_pair(
                            block, selection, local, source, right,
                            bits, mode, preserves_carry, at,
                            block->plan.node_count + 1u, scratch_mask,
                            output + at, &written))
                        return PL_ERROR_X86_SELECT;
                }
                }
            }
            at += written;
        } else if (value.kind == PL_OPERAND_NODE) {
            value = publication_for_emission(
                &block->plan, value, final_flag_node);
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u, written = 0u;
            pl_operand identity_source = { 0 };
            pl_u32 add3_pair_node = 0u, add3_pair_local = 0u, add3_pair_bits = 0u;
            pl_operand add3_pair_remaining = { 0 };
            pl_operand shift_source, shift_amount;
            pl_u32 shift_group = 0u;
            conditional_select select;
            quotient_boundary_select boundary;
            carry_adjustment adjustment;
            pl_operand bit_source;
            pl_u32 bit = 0u;
            pl_operand flag_left, flag_right;
            pl_operand lane_inner;
            pl_u32 lane_width = 0u;
            pl_u64 lane_constant = 0u;
            pl_u32 flag_mode = 0u, preserves_carry = 0u;
            if (final_flag_node && value.value == final_flag_node
                    && alu_node_semantics(
                        &block->plan, final_flag_node, &flag_left,
                        &flag_right, &bits, &flag_mode,
                        &preserves_carry)) {
                if (!write_alu_pair(
                        block, selection, local,
                        flag_left, flag_right, bits, flag_mode,
                        preserves_carry, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (final_flag_node && flag_value_operation_details(
                    &block->plan, final_flag_node, value,
                    &flag_left, &flag_right, &bits,
                    &flag_mode, &preserves_carry)) {
                if (!write_alu_pair(
                        block, selection, local,
                        flag_left, flag_right, bits, flag_mode,
                        preserves_carry, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (final_flag_node
                    && !publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && masked_entry_affine_details(
                        &block->plan, value, local, &entry_affine)
                    && (scratch_mask & (1u << entry_affine.source))) {
                pl_u32 entry_affine_work = 0u;
                if (!emit_masked_entry_affine(
                        &entry_affine, output + at,
                        &written, &entry_affine_work))
                    return PL_ERROR_X86_SELECT;
                (void)entry_affine_work;
            } else if (final_flag_node
                    && !publication_is_flag_result(
                        &block->plan, value, final_flag_node)
                    && single_bit_or_details(
                        &block->plan, value, &bit_source, &bits, &bit)) {
                if (!write_alu_tree(
                        block, selection, local, bit_source, bits, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!emit_bit_set_immediate(
                        local, bit, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (final_flag_node
                    && !publication_is_flag_result(&block->plan, value, final_flag_node)
                    && !publication_emits_selected_flag(&block->plan, value, local, final_flag_node)
                    && carry_adjustment_details(&block->plan, value, local,
                        operand_fits_u32(&block->plan, value, block->plan.node_count + 1u)
                            ? 32u : 64u, &adjustment)) {
                pl_u32 work = 0u;
                if (!emit_carry_adjustment(&adjustment, local, output + at,
                        &written, &work)) return PL_ERROR_X86_SELECT;
            } else if (quotient_boundary_select_details(
                    &block->plan, value, local, &boundary)) {
                if (!write_quotient_boundary_select(
                        block, selection, local, &boundary, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (conditional_select_details_inner(
                    &block->plan, value, local, 1, &select)) {
                if (select.candidate_local == local
                        || !conditional_compare_survives_current(
                            &select, local))
                    return PL_ERROR_X86_SELECT;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                if (!(select.current_flag_node
                        ? write_selected_flag_value(block, selection, local, &select,
                            at, block->plan.node_count + 1u, scratch_mask, output + at, &written)
                        : write_alu_tree(
                        block, selection, local, current,
                        select.value_bits, at,
                        block->plan.node_count + 1u,
                        scratch_mask,
                        output + at, &written)))
                    return PL_ERROR_X86_SELECT;
                at += written;
                /* Seed the compare operand(s) before the true-arm candidate.
                 * The compare operand's tree can reference the `current` value
                 * just published into `local`, and the candidate can then reuse
                 * the coordinate the seed finishes with -- the order the source
                 * uses.  Publishing the candidate first would rebuild `current`
                 * from an entry local the publication has already overwritten
                 * and leave no coordinate for the seed. */
                pl_x86_native_selection seed_state = *selection;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && current.value)
                    push_frame_value_alias(
                        &seed_state, (pl_u8)current.kind, current.value,
                        (pl_u8)local);
                pl_u32 used = scratch_mask & ~(1u << local);
                pl_u32 cand_local = select.candidate_local;
                if (!select.candidate_immediate
                        && cand_local < PL_X86_GPR_COUNT)
                    used &= ~(1u << cand_local);
                if (select.compare_left_seed
                        || select.compare_right_seed) {
                    if (select.compare_left_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        if (scratch >= PL_X86_GPR_COUNT
                                || !write_alu_tree(
                                    block, &seed_state, scratch,
                                    select.compare_left_value,
                                    select.compare_bits, at,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    output + at, &written))
                            return PL_ERROR_X86_SELECT;
                        used &= ~(1u << scratch);
                        select.compare_left_local = scratch;
                        at += written;
                    }
                    if (select.compare_right_seed) {
                        pl_u32 scratch = PL_X86_GPR_COUNT;
                        for (pl_u32 s = 0u; s < PL_X86_GPR_COUNT; ++s)
                            if (s != local && (used & (1u << s))) {
                                scratch = s;
                                break;
                            }
                        if (scratch >= PL_X86_GPR_COUNT
                                || !write_alu_tree(
                                    block, &seed_state, scratch,
                                    select.compare_right_value,
                                    select.compare_bits, at,
                                    block->plan.node_count + 1u,
                                    used & ~(1u << scratch),
                                    output + at, &written))
                            return PL_ERROR_X86_SELECT;
                        used &= ~(1u << scratch);
                        select.compare_right.kind = PL_OPERAND_LOCAL;
                        select.compare_right.value = scratch;
                        at += written;
                    }
                }
                if (select.candidate_immediate) {
                    cand_local = PL_X86_GPR_COUNT;
                    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                            ++scratch)
                        if (scratch != local
                                && (used & (1u << scratch))) {
                            cand_local = scratch;
                            break;
                        }
                    if (cand_local >= PL_X86_GPR_COUNT)
                        return PL_ERROR_X86_SELECT;
                    if (!write_alu_tree(
                            block, selection, cand_local,
                            select.candidate_value, select.value_bits, at,
                            block->plan.node_count + 1u,
                            used & ~(1u << cand_local),
                            output + at, &written))
                        return PL_ERROR_X86_SELECT;
                    at += written;
                }
                if (select.has_compare
                        && (select.compare_node != final_flag_node
                            || !flag_node_has_value_publication(
                                &block->plan, changed,
                                final_flag_node))) {
                    int compared = emit_select_compare(&select, output + at, &written);
                    if (!compared)
                        return PL_ERROR_X86_SELECT;
                    at += written;
                }
                if (!emit_conditional_move(
                        local, cand_local,
                        select.value_bits, select.condition,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (sign_high_node_details(
                    &block->plan, value, &source, &bits)) {
                if (!emit_sign_high(
                        local, source, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (masked_shift_count_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group) && local != 1u) {
                if (!write_alu_tree(
                        block, selection, local, shift_source, bits, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!write_alu_tree(
                        block, selection, 1u, shift_amount, 32u, at,
                        block->plan.node_count + 1u,
                        scratch_mask & ~(1u << 1u),
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!emit_shift_instruction(
                        local, (pl_operand){ PL_OPERAND_LOCAL, 1u },
                        bits, shift_group, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                if (!write_alu_tree(
                        block, selection, local, shift_source, bits, at,
                        block->plan.node_count + 1u,
                        scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (!emit_shift_instruction(
                        local, shift_amount, bits, shift_group,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (shared_dag_add3_published_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_local, &add3_pair_remaining, &add3_pair_bits)) {
                pl_operand pair = { PL_OPERAND_LOCAL, add3_pair_local };
                if (!write_alu_pair(
                        block, selection, local, pair, add3_pair_remaining,
                        add3_pair_bits, 1u, 0u, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (shared_dag_add3_pair(
                    &block->plan, (pl_u32)value.value,
                    &add3_pair_node, &add3_pair_remaining, &add3_pair_bits)) {
                /* Prefer the shared pair over the affine LEA so the earlier
                 * sum is built once, not rebuilt inside this tree.  When
                 * another pending publication needs the same pair as its
                 * destructive arm, build the pair in that consumer's coordinate
                 * so both publications share one materialization. */
                pl_operand pair = { PL_OPERAND_NODE, add3_pair_node };
                pl_u32 consumer = alu_add3_pair_consumer(
                    &block->plan, pending, add3_pair_node, local);
                int share_pair = consumer < PL_X86_GPR_COUNT
                    && (scratch_mask & (1u << consumer))
                    && add3_pair_remaining.kind == PL_OPERAND_LOCAL
                    && add3_pair_remaining.value < PL_X86_GPR_COUNT;
                pl_operand pair_left = share_pair
                    ? add3_pair_remaining : pair;
                pl_operand pair_right = share_pair
                    ? pair : add3_pair_remaining;
                if (!write_alu_pair(
                        block, selection, local, pair_left, pair_right,
                        add3_pair_bits, 1u, 0u, at,
                        block->plan.node_count + 1u,
                        share_pair ? (1u << consumer) : scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                if (share_pair)
                    push_frame_value_alias(
                        (pl_x86_native_selection *)selection,
                        PL_OPERAND_NODE, add3_pair_node, (pl_u8)consumer);
            } else if (collect_native_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form, &bits)) {
                if (!emit_affine_lea_width(
                        local, form, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (sign_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!emit_sign_extend_move(
                        local, source, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (zero_extend_high8_node(
                    &block->plan, (pl_u32)value.value, &source)) {
                if (!emit_zero_extend_high8(
                        local, source, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)) {
                if (!emit_zero_extend_move(
                        local, source, bits, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (zero_extend_operand(
                    &block->plan, (pl_u32)value.value, &lane_inner, &lane_width)
                    && lane_width == 32u) {
                if (!write_alu_tree(
                        block, selection, local, lane_inner, 32u,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (in_place_lane_insert(
                    &block->plan, value, local, &lane_inner, &lane_width)) {
                pl_u32 insert_bytes = 0u;
                if (!write_alu_tree(
                        block, selection, local, lane_inner, lane_width,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &insert_bytes))
                    return PL_ERROR_X86_SELECT;
                written = insert_bytes;
            } else if (lane_constant_insert(
                    &block->plan, value, local, &lane_constant, &lane_width)) {
                if (!emit_lane_constant_move(
                        local, lane_constant, lane_width, output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else if (value.kind == PL_OPERAND_NODE && value.value
                    && value.value <= block->plan.node_count
                    && (block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE32_BSWAP
                        || block->plan.nodes[value.value - 1u].opcode
                            == PL_OPCODE_LANE64_BSWAP)) {
                pl_u32 bswap_bits = block->plan.nodes[value.value - 1u].opcode
                                  == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
                pl_operand source_operand = block->plan.arguments[
                    block->plan.nodes[value.value - 1u].argument_at];
                pl_u32 seed_bytes = 0u;
                if (!write_alu_tree(
                        block, selection, local, source_operand, bswap_bits,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &seed_bytes)
                        || !emit_bswap_register(
                            local, bswap_bits, output + at + seed_bytes,
                            &written))
                    return PL_ERROR_X86_SELECT;
                written += seed_bytes;
            } else if ((pl_u32)value.value != final_flag_node
                    && lane_identity_mask_details(
                        &block->plan, value, &identity_source, &bits)) {
                /* The lane mask is dropped, so the publication is just the
                 * lane-width move of a register that already holds the base.
                 * The base must be read as itself: resolving it through a
                 * transient alias would name a register whose definition is a
                 * different publication. */
                pl_x86_native_selection identity_free = *selection;
                identity_free.frame_alias_present = 0u;
                if (!write_alu_tree(
                        block, &identity_free, local, identity_source, bits,
                        at, block->plan.node_count + 1u, scratch_mask,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
            } else {
                bits = operand_expression_bits(&block->plan, value, 0u);
                if (!bits)
                    return PL_ERROR_X86_SELECT;
                pl_u32 root_sources = 0u;
                int direct_destination =
                    (selection->frame_direct_destination_mask
                     & (1u << local)) != 0u;
                int emitted = direct_destination && write_alu_tree(
                    block, selection, local, value, bits, at,
                    block->plan.node_count + 1u, scratch_mask,
                    output + at, &written);
                if (!direct_destination && operand_entry_gpr_sources(
                        &block->plan, value,
                        block->plan.node_count + 1u,
                        block->plan.node_count + 1u, &root_sources)
                        && !(root_sources & (1u << local))) {
                    for (pl_u32 owner = 0u;
                            owner < PL_X86_GPR_COUNT; ++owner) {
                        pl_u32 owner_bit = 1u << owner;
                        if (!(scratch_mask & owner_bit)
                                || !(root_sources & owner_bit))
                            continue;
                        pl_u32 tree_bytes = 0u, move_bytes = 0u;
                        if (!write_alu_tree(
                                block, selection, owner, value, bits, at,
                                block->plan.node_count + 1u,
                                scratch_mask & ~owner_bit,
                                output + at, &tree_bytes)
                                || !emit_gpr_move(
                                    local, owner, bits,
                                    output + at + tree_bytes,
                                    &move_bytes)
                                || tree_bytes
                                   > U32_MAX_VALUE - move_bytes)
                            continue;
                        written = tree_bytes + move_bytes;
                        emitted = 1;
                        break;
                    }
                }
                if (!direct_destination && !emitted)
                    emitted = write_alu_tree(
                        block, selection, local, value, bits, at,
                        block->plan.node_count + 1u, scratch_mask,
                        output + at, &written);
                if (!emitted)
                    return PL_ERROR_X86_SELECT;
            }
            at += written;
        } else {
            pl_u32 encoded = 0u;
            if (!write_frame_value(
                    selection, at, local, value, output + at, &encoded))
                return PL_ERROR_X86_SELECT;
            at += encoded;
        }
        pending &= ~(1u << local);
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_transient_owner_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection
            || !selection->direct_transient_owner_frame || !output)
        return PL_ERROR_X86_SELECT;
    transient_owner_frame shape = { 0 };
    if (!transient_owner_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u;
    pl_u32 pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local)
                || !write_frame_value(
                    selection, at, local, block->plan.locals[local],
                    output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    pl_u32 written = 0u;
    if (!write_alu_seed(
            block, selection, shape.owner, shape.select.current,
            shape.select.value_bits, at,
            block->plan.node_count + 1u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    pl_operand owner_value = { PL_OPERAND_LOCAL, shape.owner };
    if (!emit_add_lea(
            shape.consumer, owner_value, shape.consumer_right,
            shape.consumer_bits, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!emit_compare_operand(
            shape.select.compare_left_local, shape.select.compare_right,
            shape.select.compare_bits, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!emit_conditional_move(
            shape.owner, shape.select.candidate_local,
            shape.select.value_bits, shape.select.condition,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_zero_flag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_zero_flag_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    zero_flag_frame shape = { 0 };
    if (!zero_flag_frame_shape(block, &shape)
            || shape.anchor != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, written = 0u, source = 0u, bits = 0u;
        int entry_source = 0;
        if (!next_zero_plain_assignment(&block->plan, pending, &local))
            return PL_ERROR_X86_SELECT;
        int emitted = zero_plain_copy(
                          &block->plan, local, &source, &bits,
                          &entry_source)
                    ? entry_source && bits < 64u
                      ? emit_zero_extend_move(
                          local, source, bits, output + at, &written)
                      : emit_gpr_move(
                          local, source, bits, output + at, &written)
                    : write_frame_value(
                          selection, at, local, block->plan.locals[local],
                          output + at, &written);
        if (!emitted) return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    if (shape.projection < PL_X86_GPR_COUNT) {
        pl_u32 projection_written = 0u;
        if (!emit_zero_register(
                shape.projection, output + at, &projection_written))
            return PL_ERROR_X86_SELECT;
        at += projection_written;
        if (!emit_test_registers(
                shape.projection_source_local, shape.projection_input_local,
                shape.projection_bits, output + at, &projection_written))
            return PL_ERROR_X86_SELECT;
        at += projection_written;
        if (!emit_conditional_move(
                shape.projection, shape.projection_mask_local, 64u,
                shape.projection_inverse ? 4u : 5u,
                output + at, &projection_written))
            return PL_ERROR_X86_SELECT;
        at += projection_written;
    }
    pl_u32 written = 0u;
    pl_operand self = { PL_OPERAND_LOCAL, shape.anchor };
    if (!emit_alu_instruction(
            shape.anchor, self, shape.flag_bits, 6u, 0u,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.anchor || !(shape.zero & (1u << local))) continue;
        if (!emit_gpr_move(
                local, shape.anchor, 32u, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_shift_handoff_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shift_handoff_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    shift_handoff_frame shape = { 0 };
    if (!shift_handoff_frame_shape(block, &shape)
            || shape.owner != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local)
                || !write_frame_value(
                    selection, at, local, block->plan.locals[local],
                    output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    pl_u32 written = 0u;
    if (!emit_shift_instruction(
            shape.owner, shape.amount, shape.bits, shape.group,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (!emit_gpr_move(
                local, shape.owner, shape.bits,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (!write_frame_value(
            selection, at, shape.owner,
            block->plan.locals[shape.owner], output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_shared_owner_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shared_owner_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    shared_owner_frame shape = { 0 };
    if (!shared_owner_frame_shape(block, &shape)
            || (shape.has_branch
                && shape.condition != selection->frame_anchor))
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u, written = 0u;
    if (!write_alu_seed(
            block, selection, shape.owner, shape.shared_value,
            shape.shared_bits, at, block->plan.node_count + 1u,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !emit_gpr_move(
                shape.shared, shape.owner, shape.shared_bits,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !emit_alu_instruction(
                shape.owner, shape.owner_right, shape.owner_bits,
                shape.owner_mode, shape.owner_preserves_carry,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!shape.has_branch)
        return at == selection->output_bytes
             ? 0 : PL_ERROR_X86_SELECT;
    int flags_emitted = shape.test
        ? emit_test_registers(
            shape.compare_left, shape.compare_right,
            shape.compare_bits, output + at, &written)
        : emit_compare_registers(
            shape.compare_left, shape.compare_right,
            shape.compare_bits, output + at, &written);
    if (!flags_emitted) return PL_ERROR_X86_SELECT;
    at += written;
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + shape.condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + shape.condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}


static int write_direct_entry_flag_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_entry_branch_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, condition = 0u;
    if (!entry_flag_branch_shape(block, &changed, &condition)
            || condition != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;
    pl_u32 pending = changed;
    pl_u32 at = 0u;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_compare_branch_assignment(
                &block->plan, pending, 0u, &local)
                || !write_frame_value(
                    selection, at, local, block->plan.locals[local],
                    output + at, &written)
                || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    if (block->relax_short_control) {
        if (selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_compare_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_branch_frame || !output)
        return PL_ERROR_X86_SELECT;
    compare_branch_operands shape;
    pl_u32 changed, left, bits, condition, test;
    pl_u8 flag_prefix = 0u;
    if (!compare_branch_operand_shape(block, &shape)
            || shape.condition != selection->frame_anchor
            || !compare_flag_prefix(&block->plan, &flag_prefix))
        return PL_ERROR_X86_SELECT;
    changed = shape.changed;
    left = shape.left;
    bits = shape.bits;
    condition = shape.condition;
    test = shape.test;
    const pl_u32 compare_reads = (1u << left)
        | (shape.right.kind == PL_OPERAND_LOCAL ? 1u << shape.right.value : 0u);
    subtract_handoff handoff = { 0 };
    int has_handoff = subtract_handoff_shape(
        &block->plan, changed, &handoff);
    pl_u32 stage_pending[2] = { changed, 0u };
    pl_u32 stage_count = 1u;
    if (has_handoff) {
        stage_pending[0] = handoff.producers;
        stage_pending[1] = changed
                         & ~handoff.outputs & ~handoff.producers;
        stage_count = 2u;
    }
    pl_u32 at = 0u;
    for (pl_u32 stage = 0u; stage < stage_count; ++stage) {
      pl_u32 pending = stage_pending[stage];
      while (pending) {
        select_generation_group select_group;
        if (!has_handoff && select_generation_group_shape(&block->plan, pending, 0u, &select_group)) {
            pl_u32 part = 0u;
            if (!write_select_generation_group(block, selection, &select_group,
                    at, output + at, &part) || at > selection->output_bytes
                    || part > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += part;
            pending &= ~select_group.members;
            continue;
        }
        flag_result_group group;
        pl_u32 deferred = 0u;
        if (!has_handoff && flag_result_group_shape(&block->plan, pending, &group, &deferred)) {
            pl_u32 pre = 0u, operation = 0u, post = 0u, work = 0u;
            if (!emit_group_booleans(&block->plan, &group, 1, output + at, &pre, &work)
                    || at > selection->output_bytes || pre > selection->output_bytes - at)
                return PL_ERROR_X86_SELECT;
            at += pre;
            if (!write_alu_pair(block, selection, group.owner, group.left, group.right,
                    group.bits, group.mode, 0u, at, block->plan.node_count + 1u,
                    0u, output + at, &operation)
                    || operation > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += operation;
            if (!emit_group_booleans(&block->plan, &group, 0, output + at, &post, &work)
                    || post > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += post;
            pending &= ~group.members;
            continue;
        }
        signed_word_handoff word;
        if (!has_handoff && signed_word_handoff_shape(&block->plan, pending, &word)) {
            pl_u32 prefix = 0u, publication = 0u;
            if (!write_alu_tree(block, selection, word.wide, word.word, 32u,
                    at, block->plan.node_count + 1u, 0u, output + at, &prefix)
                    || at > selection->output_bytes || prefix > selection->output_bytes - at
                    || !emit_signed_word_publications(&word, output + at + prefix, &publication)
                    || publication > selection->output_bytes - at - prefix)
                return PL_ERROR_X86_SELECT;
            at += prefix + publication;
            pending &= ~((1u << word.narrow) | (1u << word.wide));
            continue;
        }
        shared_root_shift_handoff root_shift;
        if (!has_handoff
                && shared_root_shift_handoff_shape(
                    &block->plan, pending, &root_shift)) {
            pl_u32 seed_bytes = 0u, move_bytes = 0u, shift0 = 0u, shift1 = 0u;
            if (!write_alu_tree(block, selection, root_shift.seed_dest,
                    root_shift.seed, root_shift.seed_bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &seed_bytes)
                    || at > selection->output_bytes
                    || seed_bytes > selection->output_bytes - at
                    || !emit_gpr_move(root_shift.copy_dest,
                        root_shift.seed_dest, root_shift.bits,
                        output + at + seed_bytes, &move_bytes)
                    || move_bytes > selection->output_bytes - at - seed_bytes
                    || !emit_shift_instruction(
                        root_shift.seed_dest, root_shift.amount[0],
                        root_shift.bits, root_shift.group[0],
                        output + at + seed_bytes + move_bytes, &shift0)
                    || shift0 > selection->output_bytes - at - seed_bytes
                                - move_bytes
                    || !emit_shift_instruction(
                        root_shift.copy_dest, root_shift.amount[1],
                        root_shift.bits, root_shift.group[1],
                        output + at + seed_bytes + move_bytes + shift0,
                        &shift1)
                    || shift1 > selection->output_bytes - at - seed_bytes
                                - move_bytes - shift0)
                return PL_ERROR_X86_SELECT;
            at += seed_bytes + move_bytes + shift0 + shift1;
            pending &= ~((1u << root_shift.seed_dest)
                       | (1u << root_shift.copy_dest));
            continue;
        }
        pl_u32 local = 0u, written = 0u;
        if (!next_compare_branch_assignment_excluding(
                &block->plan, pending,
                compare_reads, deferred, &local))
            return PL_ERROR_X86_SELECT;
        pl_operand value = block->plan.locals[local];
        int emitted;
        pl_u32 owner = publication_owner(&block->plan, value);
        if (value.kind == PL_OPERAND_NODE && owner < PL_X86_GPR_COUNT && owner != local) {
            pl_u32 value_bits = operand_fits_u32(
                &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
            emitted = emit_gpr_move(local, owner, value_bits, output + at, &written);
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local
                    || !write_alu_seed(
                        block, selection, local, source, node_bits, at,
                        block->plan.node_count + 1u,
                        output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (at > selection->output_bytes
                    || !emit_alu_instruction(
                    local, right_operand, node_bits, mode, preserves_carry,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            emitted = 1;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, extend_bits = 0u;
            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            conditional_select select;
            if (conditional_select_details(
                    &block->plan, value, local, &select)) {
                if (select.candidate_local == local)
                    return PL_ERROR_X86_SELECT;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                if (!(select.current_flag_node
                        ? write_selected_flag_value(block, selection, local, &select,
                            at, block->plan.node_count + 1u, 0u, output + at, &written)
                        : write_alu_seed(
                        block, selection, local, current,
                        select.value_bits, at,
                        block->plan.node_count + 1u,
                        output + at, &written)))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (select.has_compare) {
                    int compared = emit_select_compare(&select, output + at, &written);
                    if (!compared) return PL_ERROR_X86_SELECT;
                    at += written;
                }
                if (!emit_conditional_move(
                        local, select.candidate_local,
                        select.value_bits, select.condition,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                emitted = 1;
            } else if (collect_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form)) {
                emitted = emit_affine_lea(
                    local, form, output + at, &written);
            } else if (zero_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                emitted = emit_zero_extend_move(
                    local, source, extend_bits, output + at, &written);
            } else if (sign_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                emitted = emit_sign_extend_move(
                    local, source, extend_bits, output + at, &written);
            } else if (shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &shift_bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                if (!write_alu_seed(
                        block, selection, local, shift_source, shift_bits,
                        at, block->plan.node_count + 1u,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                emitted = emit_shift_instruction(
                    local, shift_amount, shift_bits, shift_group,
                    output + at, &written);
            } else {
                pl_u32 node_bits = operand_fits_u32(
                    &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
                emitted = write_alu_tree(
                    block, selection, local, value, node_bits, at,
                    block->plan.node_count + 1u, 0u, output + at, &written);
            }
        } else {
            emitted = value.kind == PL_OPERAND_CONST && !value.value
                    && zero_internal_compare_consumers(
                        &block->plan, local, pending)
                ? emit_zero_register(local, output + at, &written)
                : write_frame_value(
                    selection, at, local, value, output + at, &written);
        }
        if (!emitted || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
      }
      if (has_handoff && !stage) {
        pl_u32 written = 0u;
        if (!write_alu_seed(
                block, selection, handoff.scratch, handoff.right,
                handoff.bits, at, block->plan.node_count + 1u,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pl_operand scratch = { PL_OPERAND_LOCAL, handoff.scratch };
        if (at > selection->output_bytes
                || !emit_alu_instruction(
                    handoff.owner, scratch, handoff.bits, 3u, 0u,
                    output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (local == handoff.owner
                    || !(handoff.outputs & (1u << local)))
                continue;
            if (at > selection->output_bytes
                    || !emit_gpr_move(
                        local, handoff.owner, handoff.bits,
                        output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
        }
      }
    }
    if (flag_prefix) {
        if (at >= selection->output_bytes) return PL_ERROR_X86_SELECT;
        output[at++] = flag_prefix;
    }
    pl_u32 written = 0u;
    int flags_emitted = test
        ? emit_test_operand(left, shape.right, bits, output + at, &written)
        : emit_compare_operand(left, shape.right, bits, output + at, &written);
    if (!flags_emitted)
        return PL_ERROR_X86_SELECT;
    at += written;
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_value_predicate_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_value_predicate_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    value_predicate_frame shape = { 0 };
    if (!value_predicate_frame_shape(block, &shape)
            || shape.condition != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u, written = 0u;
    if (!write_alu_seed(
            block, selection, shape.owner, shape.left, shape.bits, at,
            block->plan.node_count + 1u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !emit_alu_instruction(
                shape.owner, shape.right, shape.bits, shape.mode,
                shape.preserves_carry, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.owner || !(shape.outputs & (1u << local)))
            continue;
        if (at > selection->output_bytes
                || !emit_gpr_move(
                    local, shape.owner, shape.bits, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + shape.condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + shape.condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_compare_handoff_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_compare_handoff_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    compare_handoff_frame shape = { 0 };
    if (!compare_handoff_frame_shape(block, &shape)
            || shape.condition != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u, written = 0u;
    if (!emit_alu_instruction(
            shape.owner, shape.right, shape.bits, shape.mode, 0u,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (at > selection->output_bytes
                || !emit_gpr_move(
                    local, shape.owner, shape.bits, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (at > selection->output_bytes
            || !write_alu_seed(
                block, selection, shape.owner, shape.replacement,
                shape.bits, at, block->plan.node_count + 1u,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    int flags_emitted = shape.test
        ? emit_test_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, output + at, &written)
        : emit_compare_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, output + at, &written);
    if (!flags_emitted) return PL_ERROR_X86_SELECT;
    at += written;
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + shape.condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + shape.condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_affine_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_affine_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        if (!(value.kind == PL_OPERAND_LOCAL && value.value == local))
            changed |= 1u << local;
    }
    pl_u32 pending = changed, at = 0u;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_compare_branch_assignment(
                &block->plan, pending, 0u, &local))
            return PL_ERROR_X86_SELECT;
        pl_operand value = block->plan.locals[local];
        int emitted;
        if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local
                    || !write_alu_seed(
                        block, selection, local, source, node_bits, at,
                        block->plan.node_count + 1u,
                        output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (at > selection->output_bytes
                    || !emit_alu_instruction(
                        local, right_operand, node_bits, mode,
                        preserves_carry, output + at, &written))
                return PL_ERROR_X86_SELECT;
            emitted = 1;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u;
            emitted = collect_native_affine_lea(
                &block->plan, value, block->plan.node_count + 1u,
                &form, &bits)
                ? emit_affine_lea_width(
                    local, form, bits, output + at, &written)
                : zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)
                  && emit_zero_extend_move(
                    local, source, bits, output + at, &written);
            if (!emitted && sign_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits))
                emitted = emit_sign_extend_move(
                    local, source, bits, output + at, &written);
        } else {
            emitted = write_frame_value(
                selection, at, local, value, output + at, &written);
        }
        if (!emitted || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_common_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_common_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, anchor = 0u;
    pl_u64 common = 0u;
    if (!common_constant_frame_shape(
            &block->plan, &changed, &anchor, &common))
        return PL_ERROR_X86_SELECT;
    anchor = selection->frame_anchor;
    if (anchor >= PL_X86_GPR_COUNT
            || !(changed & (1u << anchor))
            || block->plan.locals[anchor].kind != PL_OPERAND_CONST
            || block->plan.locals[anchor].value != common)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, encoded = 0u;
    pl_operand value = { PL_OPERAND_CONST, common };
    if (!write_frame_value(
            selection, at, anchor, value, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    value.kind = PL_OPERAND_LOCAL;
    value.value = anchor;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        pl_operand emitted = !absolute_fixup_at(selection, at, common)
                           ? value : block->plan.locals[local];
        encoded = 0u;
        if (!write_frame_value(
                selection, at, local, emitted, output + at, &encoded))
            return PL_ERROR_X86_SELECT;
        at += encoded;
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_equal_compare_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_compare_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    pl_u64 common = 0u;
    if (!equal_compare_frame_shape(
            &block->plan, &changed, &anchor, &bits, &common))
        return PL_ERROR_X86_SELECT;
    anchor = selection->frame_anchor;
    if (anchor >= PL_X86_GPR_COUNT
            || !(changed & (1u << anchor))
            || block->plan.locals[anchor].kind != PL_OPERAND_CONST
            || block->plan.locals[anchor].value != common)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, encoded = 0u;
    pl_operand value = { PL_OPERAND_CONST, common };
    if (!write_frame_value(
            selection, at, anchor, value, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    value.kind = PL_OPERAND_LOCAL;
    value.value = anchor;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        pl_operand publication = block->plan.locals[local];
        pl_operand emitted = publication.value == common
                           && !absolute_fixup_at(selection, at, common)
                           ? value : publication;
        encoded = 0u;
        if (!write_frame_value(
                selection, at, local, emitted, output + at, &encoded))
            return PL_ERROR_X86_SELECT;
        at += encoded;
    }
    if (!emit_compare_same(anchor, bits, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 5u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0xe9u;
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_constant_shift_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shift_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    if (!constant_sar_zero_frame_shape(
            &block->plan, &changed, &anchor, &bits))
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_operand value = block->plan.locals[local];
        pl_u32 encoded = 0u;
        int emitted = !value.value
                    ? emit_zero_register(local, output + at, &encoded)
                    : write_frame_value(
                        selection, at, local, value,
                        output + at, &encoded);
        if (!emitted) return PL_ERROR_X86_SELECT;
        at += encoded;
    }
    pl_u32 encoded = 0u;
    if (!emit_compare_same(anchor, bits, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 5u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0xe9u;
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int write_direct_insert_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_insert_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 destination, source, changed;
    if (!insert32_frame_shape(
            &block->plan, &destination, &source, &changed))
        return PL_ERROR_X86_SELECT;
    pl_u32 pending = changed, at = 0u;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_insert_frame_assignment(
                &block->plan, pending,
                destination, source, &local))
            return PL_ERROR_X86_SELECT;
        int emitted = local == destination
            ? emit_insert32_move(
                destination, source, output + at, &written)
            : write_frame_value(
                selection, at, local, block->plan.locals[local],
                output + at, &written);
        if (!emitted || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int source_terminal(const pl_x86_instruction *instruction)
{
    return instruction->flow != PL_X86_FLOW_NEXT
        || !!(instruction->flags & (PL_X86_INSTRUCTION_MAY_TRAP
                                    | PL_X86_INSTRUCTION_PRECISE_CUT
                                    | PL_X86_INSTRUCTION_BARRIER));
}

static int final_instruction(const pl_x86_frontend *frontend,
                             const pl_x86_block *block,
                             pl_x86_instruction *out)
{
    if (!frontend || !block || !out || !block->instruction_count)
        return PL_ERROR_X86_SELECT;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        int status = pl_x86_frontend_decode(frontend, rip, out);
        if (status) return status;
        rip = out->fallthrough;
    }
    return 0;
}

static int append_fixup(pl_x86_native_selection *selection, pl_u8 kind,
                        pl_u8 bytes, pl_u32 at, pl_u32 next_ip_at,
                        pl_u64 target)
{
    if (!bytes || at > next_ip_at
            || selection->fixup_count >= PL_X86_NATIVE_MAX_FIXUPS)
        return PL_ERROR_X86_SELECT;
    pl_x86_native_fixup *fixup =
        &selection->fixups[selection->fixup_count++];
    *fixup = (pl_x86_native_fixup){
        at, next_ip_at, target, 0u, kind, bytes, 0u, { 0u }
    };
    return 0;
}

/* A normalized control field and its linked construction expression are one
 * address binding.  Output width may change during rel8 relaxation, but the
 * source coordinate remains the unique relocation owner. */
static int append_control_fixup(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u8 bytes,
    pl_u32 at, pl_u32 next_ip_at, pl_u64 target)
{
    pl_x86_instruction terminal;
    int status = final_instruction(frontend, block, &terminal);
    if (status) return status;
    pl_u8 source_bytes = terminal.immediate_bytes[0];
    if (!(terminal.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            || terminal.target != target
            || (source_bytes != 1u && source_bytes != 4u)
            || terminal.immediate_offset[0] > terminal.source_bytes
            || source_bytes
               > terminal.source_bytes - terminal.immediate_offset[0]
            || block->end < block->start
            || block->end - block->start < terminal.source_bytes
            || block->end - block->start - terminal.source_bytes
               > U32_MAX_VALUE - terminal.immediate_offset[0])
        return PL_ERROR_X86_SELECT;
    pl_u32 source_at = (pl_u32)(block->end - block->start
                       - terminal.source_bytes)
                     + terminal.immediate_offset[0];
    status = append_fixup(
        selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE,
        bytes, at, next_ip_at, target);
    if (status) return status;
    pl_x86_native_fixup *fixup =
        &selection->fixups[selection->fixup_count - 1u];
    fixup->source_at = source_at;
    fixup->source_bytes = source_bytes;
    return 0;
}

static int direct_control(const pl_x86_instruction *instruction,
                          pl_u32 output_at, int relax_short_control,
                          pl_x86_native_selection *selection)
{
    if (!(instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)) return 0;
    pl_u32 bytes = instruction->source_bytes;
    pl_u32 field = instruction->immediate_offset[0];
    pl_u8 field_bytes = instruction->immediate_bytes[0];
    if ((instruction->flow == PL_X86_FLOW_JUMP
                && instruction->operation == PL_X86_OPERATION_BRANCH)
            || (instruction->flow == PL_X86_FLOW_CALL
                && instruction->operation == PL_X86_OPERATION_CALL)) {
    } else if (instruction->flow == PL_X86_FLOW_CONDITIONAL
            && ((instruction->operation == PL_X86_OPERATION_BRANCH
                 && instruction->condition <= 15u)
                || instruction->operation == PL_X86_OPERATION_LOOP
                || instruction->operation
                   == PL_X86_OPERATION_COUNT_ZERO_BRANCH)) {
    } else {
        return 0;
    }
    if ((field_bytes != 1u && field_bytes != 4u)
            || field > bytes || field_bytes > bytes - field)
        return 0;
    /* A source rel8 is valid only for the linked layout.  Independent block
     * ownership can insert other admitted entries between two nearby source
     * coordinates, so retaining that width would make emission depend on a
     * lucky placement.  Non-identity cells use a total canonical spelling:
     * JMP/Jcc become their rel32 forms; LOOP/JCXZ keep their exact instruction
     * and branch to one of two adjacent rel32 exits.  Source-identity extents
     * retain their fixed bytes and are laid out by their affine cell rule. */
    if (field_bytes == 1u && relax_short_control) {
        if (!field || field + 1u != bytes) return 0;
        pl_u32 prefix = field - 1u;
        if (instruction->flow == PL_X86_FLOW_JUMP
                && instruction->operation == PL_X86_OPERATION_BRANCH) {
            if (output_at > U32_MAX_VALUE - prefix - 5u)
                return PL_ERROR_X86_SELECT;
            int status = append_fixup(
                selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                output_at + prefix + 1u, output_at + prefix + 5u,
                instruction->target);
            if (status) return status;
            selection->output_bytes = output_at + prefix + 5u;
        } else if (instruction->flow == PL_X86_FLOW_CONDITIONAL
                && instruction->operation == PL_X86_OPERATION_BRANCH
                && instruction->condition <= 15u) {
            if (output_at > U32_MAX_VALUE - prefix - 6u)
                return PL_ERROR_X86_SELECT;
            int status = append_fixup(
                selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                output_at + prefix + 2u, output_at + prefix + 6u,
                instruction->target);
            if (status) return status;
            selection->output_bytes = output_at + prefix + 6u;
        } else if (instruction->flow == PL_X86_FLOW_CONDITIONAL
                && (instruction->operation == PL_X86_OPERATION_LOOP
                    || instruction->operation
                       == PL_X86_OPERATION_COUNT_ZERO_BRANCH)) {
            if (output_at > U32_MAX_VALUE - bytes - 10u)
                return PL_ERROR_X86_SELECT;
            int status = append_fixup(
                selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                output_at + bytes + 1u, output_at + bytes + 5u,
                instruction->fallthrough);
            if (!status)
                status = append_fixup(
                    selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                    output_at + bytes + 6u, output_at + bytes + 10u,
                    instruction->target);
            if (status) return status;
            selection->output_bytes = output_at + bytes + 10u;
        } else {
            return 0;
        }
        selection->copied_source = 1u;
        return 1;
    }
    int status = append_fixup(
        selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, field_bytes,
        output_at + field, output_at + bytes, instruction->target);
    if (status) return status;
    selection->output_bytes = output_at + bytes;
    selection->copied_source = 1u;
    return 1;
}

static int inspect_copied_instruction(
    const pl_x86_instruction *instruction, pl_u32 output_at,
    pl_x86_native_selection *selection)
{
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index) {
        const pl_x86_operand *operand = &instruction->operands[index];
        if (operand->flags & PL_X86_OPERAND_RELATIVE) {
            selection->reason = PL_X86_NATIVE_SELECT_CONTROL;
            return 0;
        }
        if (operand->kind != PL_X86_OPERAND_MEMORY
                || operand->value.memory.base.class_id
                   != PL_X86_REGISTER_IP)
            continue;
        if (instruction->displacement_bytes != 4u
                || instruction->displacement_offset + 4u
                   > instruction->source_bytes) {
            selection->reason = PL_X86_NATIVE_SELECT_POSITION;
            return 0;
        }
        pl_u64 target = instruction->fallthrough
                      + (pl_u64)operand->value.memory.displacement;
        int status = append_fixup(
            selection, PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT, 4u,
            output_at + instruction->displacement_offset,
            output_at + instruction->source_bytes, target);
        if (status) return status;
    }
    return 1;
}

static int measure_source_run(const pl_x86_frontend *frontend,
                               pl_u64 start, pl_u32 instructions,
                               pl_u32 omitted_prefix_bytes,
                               int relax_short_control,
                               pl_x86_native_selection *selection)
{
    pl_u64 rip = start;
    pl_u32 output_at = 0u;
    pl_u64 copied_from = start + omitted_prefix_bytes;
    for (pl_u32 index = 0u; index < instructions; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        int final = index + 1u == instructions;
        if (final && source_terminal(&instruction)
                && (instruction.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)) {
            int selected = direct_control(
                &instruction, output_at, relax_short_control, selection);
            if (selected < 0) return selected;
            if (!selected) {
                selection->reason = PL_X86_NATIVE_SELECT_CONTROL;
                return 0;
            }
            selection->copied_source |= output_at != 0u;
            ++selection->output_instructions;
            return 1;
        }
        if (rip >= copied_from) {
            int relocatable = inspect_copied_instruction(
                &instruction, output_at, selection);
            if (relocatable < 0) return relocatable;
            if (!relocatable) return 0;
            if (output_at > U32_MAX_VALUE - instruction.source_bytes)
                return PL_ERROR_X86_SELECT;
            output_at += instruction.source_bytes;
            selection->copied_source = 1u;
            ++selection->output_instructions;
        }
        rip = instruction.fallthrough;
    }
    selection->output_bytes = output_at;
    return 1;
}

static int same_operand(pl_operand left, pl_operand right)
{
    return left.kind == right.kind && left.value == right.value;
}

/* Normalization has already made the physical SSA dense and deterministic.
 * Source instruction count, dependency depth and wave storage describe how a
 * spelling was obtained; they are not part of its architectural future. */
static int same_semantic_plan(const pl_plan *left, const pl_plan *right)
{
    if (!left || !right
            || left->node_count != right->node_count
            || left->argument_count != right->argument_count
            || left->stack_count != right->stack_count
            || left->local_count != right->local_count)
        return 0;
    for (pl_u32 index = 0u; index < left->node_count; ++index)
        if (left->nodes[index].opcode != right->nodes[index].opcode
                || left->nodes[index].argument_at
                   != right->nodes[index].argument_at
                || left->nodes[index].argument_count
                   != right->nodes[index].argument_count)
            return 0;
    for (pl_u32 index = 0u; index < left->argument_count; ++index)
        if (!same_operand(left->arguments[index], right->arguments[index]))
            return 0;
    for (pl_u32 index = 0u; index < left->stack_count; ++index)
        if (!same_operand(left->stack[index], right->stack[index]))
            return 0;
    for (pl_u32 index = 0u; index < left->local_count; ++index)
        if (!same_operand(left->locals[index], right->locals[index]))
            return 0;
    return 1;
}

static int same_semantic_block(const pl_x86_block *left,
                               const pl_x86_block *right)
{
    if (!left || !right || left->end != right->end
            || left->kind != right->kind || left->flow != right->flow
            || left->dynamic_target != right->dynamic_target
            || left->has_predicate != right->has_predicate
            || left->has_fault_predicate != right->has_fault_predicate
            || left->trap_vector != right->trap_vector
            || left->machine_operation != right->machine_operation
            || left->machine_argument != right->machine_argument
            || left->successor_count != right->successor_count
            || !same_semantic_plan(&left->plan, &right->plan)
            || (left->dynamic_target
                && !same_operand(left->target, right->target))
            || (left->has_predicate
                && !same_operand(left->predicate, right->predicate))
            || (left->has_fault_predicate
                && !same_operand(left->fault_predicate,
                                 right->fault_predicate))
            || (left->machine_operation != PL_X86_MACHINE_NONE
                && !same_operand(left->machine_value,
                                 right->machine_value)))
        return 0;
    for (pl_u32 index = 0u; index < left->successor_count; ++index)
        if (left->successor[index] != right->successor[index]) return 0;
    return 1;
}

static void reset_normalized_candidate(
    pl_x86_native_selection *selection, pl_u32 source_bytes)
{
    *selection = (pl_x86_native_selection){ 0 };
    selection->blocking_opcode = U32_MAX_VALUE;
    selection->source_bytes = source_bytes;
}

static void source_operand_local_mask(pl_operand operand, pl_u32 *mask)
{
    if (operand.kind == PL_OPERAND_LOCAL
            && operand.value < PL_X86_LOCAL_COUNT)
        *mask |= 1u << (pl_u32)operand.value;
}

static int source_node_rebases_flag_root(
    const pl_plan *plan, const pl_node *node);

/* Derive the dependency cut from the same one-instruction semantic law which
 * is later emitted.  This is deliberately independent of the whole-block
 * grammar production which happened to find the spelling: a production may
 * choose bytes, but it may not invent a separate work/span certificate. */
static int instruction_masks(const pl_x86_semantic *semantic,
                             int rebase_complete_flag_write,
                             pl_u32 *reads, pl_u32 *writes)
{
    if (!semantic || !reads || !writes) return PL_ERROR_X86_SELECT;
    *reads = 0u;
    *writes = 0u;
    for (pl_u32 node = 0u; node < semantic->plan.node_count; ++node) {
        const pl_node *operation = &semantic->plan.nodes[node];
        int rebase_flags =
            source_node_rebases_flag_root(&semantic->plan, operation);
        for (pl_u32 slot = 0u; slot < operation->argument_count; ++slot) {
            /* A complete flag overwrite reads its preserved lanes from the
             * persistent cut, not from an overwritten intermediate flag
             * producer.  This is the same substitution used by the SSA
             * normalizer and prevents a false serial edge. */
            if (!slot && rebase_complete_flag_write && rebase_flags)
                continue;
            source_operand_local_mask(
                semantic->plan.arguments[operation->argument_at + slot],
                reads);
        }
    }
    for (pl_u32 local = 0u; local < semantic->plan.local_count; ++local) {
        pl_operand value = semantic->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        *writes |= 1u << local;
        source_operand_local_mask(value, reads);
    }
    source_operand_local_mask(semantic->target, reads);
    source_operand_local_mask(semantic->predicate, reads);
    source_operand_local_mask(semantic->fault_predicate, reads);
    source_operand_local_mask(semantic->machine_value, reads);
    return 0;
}

static int instruction_dependency_masks(
    const pl_x86_semantic *semantic, pl_u32 *reads, pl_u32 *writes)
{
    return instruction_masks(semantic, 1, reads, writes);
}

/* Backward DCE needs exact architectural liveness, including flag lanes
 * preserved by an otherwise complete arithmetic update.  Dependency-depth
 * accounting may rebase those lanes to the persistent cut, but doing that
 * here would incorrectly erase producers such as CLD before CMP. */
static int instruction_liveness_masks(
    const pl_x86_semantic *semantic, pl_u32 *reads, pl_u32 *writes)
{
    return instruction_masks(semantic, 0, reads, writes);
}

static pl_u32 instruction_dependency_depth(
    pl_u32 reads, pl_u32 writes, int terminal, int register_copy,
    pl_u32 producer[PL_X86_LOCAL_COUNT])
{
    pl_u32 depth = register_copy ? 0u : 1u;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
        if (!(reads & (1u << local))) continue;
        pl_u32 candidate = producer[local]
                         + (register_copy ? 0u : 1u);
        if (candidate > depth) depth = candidate;
    }
    /* A copy of an entry coordinate is still one publication wave even
     * though it introduces no new data-dependency edge. */
    if (!depth) depth = 1u;
    /* A terminal transfer publishes the complete architectural frame before
     * its successor may begin.  Direct control has no data operand naming
     * those publications, so make that real cut explicit rather than letting
     * an unconditional branch appear parallel with the writes it commits. */
    if (terminal)
        for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
            if (producer[local] >= depth) depth = producer[local] + 1u;
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
        if (writes & (1u << local)) producer[local] = depth;
    return depth;
}

static int instruction_is_register_copy(
    const pl_x86_instruction *instruction)
{
    if (!instruction || instruction->operation != PL_X86_OPERATION_MOVE
            || instruction->flow != PL_X86_FLOW_NEXT
            || instruction->visible_operand_count < 2u)
        return 0;
    const pl_x86_operand *destination = &instruction->operands[0];
    const pl_x86_operand *source = &instruction->operands[1];
    return destination->kind == PL_X86_OPERAND_REGISTER
        && source->kind == PL_X86_OPERAND_REGISTER
        && destination->value.reg.class_id == PL_X86_REGISTER_GPR
        && source->value.reg.class_id == PL_X86_REGISTER_GPR;
}

static int source_node_rebases_flag_root(
    const pl_plan *plan, const pl_node *node)
{
    if (!plan || !node) return 0;
    if (node->opcode == PL_OPCODE_X86_COMPARE
            || node->opcode == PL_OPCODE_X86_TEST)
        return 1;
    if (node->opcode == PL_OPCODE_X86_SHIFT_FLAGS) {
        if (node->argument_count != 5u) return 0;
        const pl_operand *amount =
            &plan->arguments[node->argument_at + 3u];
        const pl_operand *word =
            &plan->arguments[node->argument_at + 4u];
        if (amount->kind != PL_OPERAND_CONST
                || word->kind != PL_OPERAND_CONST)
            return 0;
        pl_u64 width = word->value & 0x7full;
        pl_u64 group = (word->value >> 8u) & 7u;
        return (width == 8u || width == 16u
                || width == 32u || width == 64u)
            && (amount->value & (width - 1u)) != 0u
            && group >= 4u && group <= 7u;
    }
    pl_u32 descriptor_at;
    if (node->opcode == PL_OPCODE_X86_FLAGS) descriptor_at = 4u;
    else if (node->opcode == PL_OPCODE_X86_ALU) descriptor_at = 3u;
    else if (node->opcode == PL_OPCODE_X86_AFFINE_ALU)
        descriptor_at = 4u;
    else return 0;
    if (node->argument_count <= descriptor_at) return 0;
    const pl_operand *word =
        &plan->arguments[node->argument_at + descriptor_at];
    if (word->kind != PL_OPERAND_CONST) return 0;
    pl_u64 group = (word->value >> 8u) & 7u;
    return group != 2u && group != 4u
        && !(word->value & (1ull << 11u));
}

static int semantic_rebases_flag_root(const pl_x86_semantic *semantic)
{
    if (!semantic) return 0;
    for (pl_u32 node = 0u; node < semantic->plan.node_count; ++node)
        if (source_node_rebases_flag_root(
                &semantic->plan, &semantic->plan.nodes[node]))
            return 1;
    return 0;
}

/* RFLAGS is one architectural local, but dead-code elimination may not treat
 * it as one indivisible value.  Arithmetic replaces CF/PF/AF/ZF/SF/OF while
 * preserving direction, interrupt and system flags; CLC/STC/CMC replace only
 * CF, and CLD/STD replace only DF.  Keep the few independently observable
 * lanes separate so an overwritten carry producer can disappear without
 * erasing a still-live direction producer. */
#define FLAG_LIVE_CARRY        (1u << 0u)
#define FLAG_LIVE_ARITHMETIC   (1u << 1u)
#define FLAG_LIVE_DIRECTION    (1u << 2u)
#define FLAG_LIVE_INTERRUPT    (1u << 3u)
#define FLAG_LIVE_SYSTEM       (1u << 4u)
#define FLAG_LIVE_ARITHMETIC_ALL \
    (FLAG_LIVE_CARRY | FLAG_LIVE_ARITHMETIC)
#define FLAG_LIVE_ALL \
    (FLAG_LIVE_ARITHMETIC_ALL | FLAG_LIVE_DIRECTION \
     | FLAG_LIVE_INTERRUPT | FLAG_LIVE_SYSTEM)

static void instruction_flag_liveness_masks(
    const pl_x86_instruction *instruction,
    const pl_x86_semantic *semantic,
    pl_u32 architectural_reads, pl_u32 architectural_writes,
    pl_u8 *reads, pl_u8 *writes)
{
    const pl_u32 flag_bit = 1u << PL_X86_RFLAGS_LOCAL;
    *reads = (architectural_reads & flag_bit)
           ? (pl_u8)FLAG_LIVE_ALL : 0u;
    *writes = (architectural_writes & flag_bit)
            ? (pl_u8)FLAG_LIVE_ALL : 0u;

    if (instruction->operation == PL_X86_OPERATION_FLAG_CONTROL) {
        switch (instruction->condition) {
        case 0u: /* CLC */
        case 1u: /* STC */
            *reads = 0u;
            *writes = (pl_u8)FLAG_LIVE_CARRY;
            return;
        case 2u: /* CMC */
            *reads = (pl_u8)FLAG_LIVE_CARRY;
            *writes = (pl_u8)FLAG_LIVE_CARRY;
            return;
        case 3u: /* CLD */
        case 4u: /* STD */
            *reads = 0u;
            *writes = (pl_u8)FLAG_LIVE_DIRECTION;
            return;
        case 5u: /* CLI */
        case 6u: /* STI */
            *reads = 0u;
            *writes = (pl_u8)FLAG_LIVE_INTERRUPT;
            return;
        default:
            return;
        }
    }

    /* A complete arithmetic producer has no carry input.  The old RFLAGS
     * operand in its semantic law supplies only lanes which x86 preserves;
     * those lanes flow through because they are absent from writes. */
    if (*writes && semantic_rebases_flag_root(semantic)) {
        *reads = 0u;
        *writes = (pl_u8)FLAG_LIVE_ARITHMETIC_ALL;
    }
}

/* Reopen the bytes selected for one candidate and derive the physical pair
 * from those exact ordinary x86 instructions.  This closes the former dual
 * route in which a whole-block recognizer selected bytes while separately
 * assigning an estimated work/span.  Relative fields are zero here, but their
 * width and instruction law are already final; layout binding cannot change
 * either count or dependency topology. */
#define NATIVE_COST_OUTPUT_BYTES 2048u
#define NATIVE_COST_ARENA_BYTES  8192u

static int derive_emitted_candidate_cost(
    const pl_x86_frontend *source_frontend,
    const pl_x86_block *source_block,
    pl_x86_native_selection *selection)
{
    if (!source_frontend || !source_block || !selection
            || !selection->supported
            || selection->output_bytes > NATIVE_COST_OUTPUT_BYTES)
        return PL_ERROR_X86_SELECT;
    if (!selection->output_bytes) {
        selection->output_instructions = 0u;
        selection->output_work = 0u;
        selection->output_span = 0u;
        return 0;
    }

    pl_u8 bytes[NATIVE_COST_OUTPUT_BYTES];
    pl_u32 written = 0u;
    int status = pl_x86_select_write_measured(
        source_frontend, source_block, selection,
        bytes, sizeof bytes, &written);
    if (status || written != selection->output_bytes)
        return status ? status : PL_ERROR_X86_SELECT;

    const pl_u64 base = 0x100000000ull;
    pl_x86_map map = {
        bytes, base, written, written,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, base };
    pl_x86_frontend frontend;
    status = pl_x86_frontend_open(&image, &frontend);
    if (status) return status;

    pl_u32 reads[NATIVE_COST_OUTPUT_BYTES];
    pl_u32 writes[NATIVE_COST_OUTPUT_BYTES];
    pl_u8 terminal[NATIVE_COST_OUTPUT_BYTES];
    pl_u8 register_copy[NATIVE_COST_OUTPUT_BYTES];
    pl_u8 complete_flags[NATIVE_COST_OUTPUT_BYTES];
    pl_u32 instruction_count = 0u;
    pl_u64 rip = base;
    while (rip < base + written) {
        if (instruction_count >= NATIVE_COST_OUTPUT_BYTES)
            return PL_ERROR_X86_SELECT;
        pl_x86_instruction instruction;
        status = pl_x86_frontend_decode(&frontend, rip, &instruction);
        if (status || !instruction.source_bytes
                || instruction.fallthrough <= rip
                || instruction.fallthrough > base + written)
            return status ? status : PL_ERROR_X86_SELECT;
        pl_u8 arena_bytes[NATIVE_COST_ARENA_BYTES];
        pl_arena arena = { arena_bytes, sizeof arena_bytes, 0u };
        pl_x86_semantic semantic;
        status = pl_x86_lower(&instruction, &arena, &semantic);
        if (status) return status;
        status = instruction_dependency_masks(
            &semantic, &reads[instruction_count],
            &writes[instruction_count]);
        if (status) return status;
        terminal[instruction_count] =
            (pl_u8)(instruction.flow != PL_X86_FLOW_NEXT);
        register_copy[instruction_count] =
            (pl_u8)instruction_is_register_copy(&instruction);
        complete_flags[instruction_count] =
            (pl_u8)semantic_rebases_flag_root(&semantic);
        ++instruction_count;
        rip = instruction.fallthrough;
    }
    if (rip != base + written || !instruction_count)
        return PL_ERROR_X86_SELECT;

    /* A partial flag update reads the lanes it preserves, but those lanes are
     * not a dependency when this instruction's complete RFLAGS publication
     * is dead before the accepted future.  Perform the same backward cut as
     * whole-block SSA before calculating physical instruction depth. */
    const pl_u32 flag_bit = 1u << PL_X86_RFLAGS_LOCAL;
    int flags_live = (source_block->live_output_mask & flag_bit) != 0u;
    for (pl_u32 index = instruction_count; index-- > 0u;) {
        if (writes[index] & flag_bit) {
            if (!flags_live) {
                reads[index] &= ~flag_bit;
                writes[index] &= ~flag_bit;
            } else if (complete_flags[index]) {
                flags_live = 0;
            }
        }
        if (reads[index] & flag_bit) flags_live = 1;
    }

    pl_u32 producer[PL_X86_LOCAL_COUNT] = { 0u };
    pl_u32 maximum = 0u;
    for (pl_u32 index = 0u; index < instruction_count; ++index) {
        pl_u32 depth = instruction_dependency_depth(
            reads[index], writes[index], terminal[index],
            register_copy[index], producer);
        if (depth > maximum) maximum = depth;
    }
    if (!maximum) return PL_ERROR_X86_SELECT;
    selection->output_instructions = instruction_count;
    selection->output_work = instruction_count;
    selection->output_span = maximum;
    return 0;
}

typedef int (*measure_normalized_candidate)(
    const pl_x86_frontend *, const pl_x86_block *,
    pl_x86_native_selection *);

static int append_normalized_candidate(
    pl_x86_native_candidates *candidates,
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 source_bytes, measure_normalized_candidate measure)
{
    if (!candidates || !frontend || !block || !measure)
        return PL_ERROR_X86_SELECT;
    pl_x86_native_selection selection;
    reset_normalized_candidate(&selection, source_bytes);
    int selected = measure(frontend, block, &selection);
    if (selected < 0) return selected;
    if (!selected) {
        if (selection.blocking_work
                && (!candidates->diagnostic.blocking_work
                    || selection.direct_alu_frame || selection.direct_branch_frame))
            candidates->diagnostic = selection;
        return 0;
    }
    if (!selection.supported
            || candidates->count >= PL_X86_NATIVE_MAX_CANDIDATES)
        return PL_ERROR_X86_SELECT;
    selection.normalized_family_present = 1u;
    candidates->candidate[candidates->count++] = selection;
    return 0;
}

/* Work backward once from the accepted residual state.  The old probe formed
 * every source suffix independently; an m-instruction block therefore paid
 * m + (m - 1) + ... lowerings before selection.  Per-instruction source laws
 * already provide the exact architectural read/write cut.  Reverse liveness
 * finds the only prefix whose publications have no path to the accepted
 * future in O(m), then one normalized re-formation proves that the proposed
 * suffix has the complete same future.  The proof, rather than this cheap
 * candidate discovery, remains authoritative. */
static int equivalent_suffix_bytes(
    const pl_x86_frontend *frontend,
    const pl_x86_block_workspace *scratch,
    const pl_x86_block *block, pl_u32 *bytes)
{
    pl_u64 starts[PL_X86_NATIVE_MAX_FIXUPS];
    pl_u32 reads[PL_X86_NATIVE_MAX_FIXUPS];
    pl_u32 writes[PL_X86_NATIVE_MAX_FIXUPS];
    pl_u8 mandatory[PL_X86_NATIVE_MAX_FIXUPS];
    if (!frontend || !scratch || !block || !bytes
            || !block->instruction_count)
        return PL_ERROR_X86_SELECT;
    *bytes = 0u;
    /* Suffix discovery is a byte-size optimization, not part of semantic
     * closure.  Fixup capacity bounds the retained relocation bindings of a
     * selected spelling; it must never become an unrelated limit on source
     * block length.  The small backward probe currently uses that bounded
     * transient array, so a larger block keeps its complete exact source
     * representative.  Normalized grammar productions remain available and
     * the selector therefore stays total while this optional probe remains
     * allocation-free. */
    if (block->instruction_count > PL_X86_NATIVE_MAX_FIXUPS)
        return 0;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        starts[index] = rip;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        pl_arena arena = {
            scratch->first, scratch->bytes_each, 0u,
        };
        pl_x86_semantic semantic;
        status = pl_x86_lower(&instruction, &arena, &semantic);
        if (status) return status;
        status = instruction_dependency_masks(
            &semantic, &reads[index], &writes[index]);
        if (status) return status;
        mandatory[index] = (pl_u8)(
            instruction.flow != PL_X86_FLOW_NEXT
            || (instruction.flags & (PL_X86_INSTRUCTION_BARRIER
                                   | PL_X86_INSTRUCTION_MAY_TRAP))
            || semantic.has_fault_predicate
            || semantic.machine_operation != PL_X86_MACHINE_NONE
            || plan_has_memory(&semantic.plan));
        rip = instruction.fallthrough;
    }
    if (rip != block->end) return PL_ERROR_X86_SELECT;

    pl_u32 live = block->live_output_mask;
    pl_u32 first = block->instruction_count;
    for (pl_u32 index = block->instruction_count; index-- > 0u;) {
        if (!mandatory[index] && !(writes[index] & live)) continue;
        first = index;
        live = (live & ~writes[index]) | reads[index];
    }
    if (!first || first == block->instruction_count) return 0;

    pl_u64 start = starts[first];
    pl_x86_block candidate;
    int status = pl_x86_block_lower_projected_suffix_until(
        frontend, start, block->end, block->live_output_mask,
        scratch, &candidate);
    if (status) return status;
    if (!same_semantic_block(block, &candidate)) return 0;
    if (start - block->start > U32_MAX_VALUE)
        return PL_ERROR_X86_SELECT;
    *bytes = (pl_u32)(start - block->start);
    return 0;
}

/* Project the complete future through the source instruction laws once and
 * emit only the instructions whose publications reach that future.  Unlike
 * the old suffix-only probe, this removes dead work between live operations.
 * The retained bytes are ordinary x86 selected by their already-normalized C
 * semantics; the mask is compiler workspace and never becomes an output
 * format or runtime route.  Memory, faults, machine operations and control
 * are mandatory cuts and therefore cannot disappear through this production.
 */
static int measure_direct_live_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->source_identity || block->construction_fields
            || block->instruction_count < 2u
            || block->instruction_count > 64u)
        return 0;

    pl_u32 reads[64u];
    pl_u32 writes[64u];
    pl_u8 flag_reads[64u];
    pl_u8 flag_writes[64u];
    pl_u8 mandatory[64u];
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        pl_u8 arena_bytes[NATIVE_COST_ARENA_BYTES];
        pl_arena arena = { arena_bytes, sizeof arena_bytes, 0u };
        pl_x86_semantic semantic;
        status = pl_x86_lower(&instruction, &arena, &semantic);
        if (status) return status;
        status = instruction_liveness_masks(
            &semantic, &reads[index], &writes[index]);
        if (status) return status;
        instruction_flag_liveness_masks(
            &instruction, &semantic, reads[index], writes[index],
            &flag_reads[index], &flag_writes[index]);
        reads[index] &= ~(1u << PL_X86_RFLAGS_LOCAL);
        writes[index] &= ~(1u << PL_X86_RFLAGS_LOCAL);
        mandatory[index] = (pl_u8)(
            instruction.flow != PL_X86_FLOW_NEXT
            || (instruction.flags & (PL_X86_INSTRUCTION_BARRIER
                                   | PL_X86_INSTRUCTION_MAY_TRAP))
            || semantic.has_fault_predicate
            || semantic.machine_operation != PL_X86_MACHINE_NONE
            || plan_has_memory(&semantic.plan));
        rip = instruction.fallthrough;
    }
    if (rip != block->end) return PL_ERROR_X86_SELECT;

    const pl_u32 flag_bit = 1u << PL_X86_RFLAGS_LOCAL;
    pl_u32 live = block->live_output_mask & ~flag_bit;
    pl_u8 live_flags = (block->live_output_mask & flag_bit)
                     ? (pl_u8)FLAG_LIVE_ALL : 0u;
    pl_u64 retained = 0u;
    for (pl_u32 index = block->instruction_count; index-- > 0u;) {
        int observed = (writes[index] & live) != 0u
                    || (flag_writes[index] & live_flags) != 0u;
        if (!mandatory[index] && !observed) continue;
        retained |= 1ull << index;
        live = (live & ~writes[index]) | reads[index];
        live_flags = (pl_u8)(
            (live_flags & (pl_u8)~flag_writes[index])
            | flag_reads[index]);
    }
    pl_u64 complete = block->instruction_count == 64u
                    ? U64_MAX_VALUE
                    : (1ull << block->instruction_count) - 1ull;
    if (!retained || retained == complete) return 0;

    pl_u32 output_at = 0u;
    rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (retained & (1ull << index)) {
            int final = index + 1u == block->instruction_count;
            if (final && source_terminal(&instruction)
                    && (instruction.flags
                        & PL_X86_INSTRUCTION_DIRECT_TARGET)) {
                int selected = direct_control(
                    &instruction, output_at,
                    block->relax_short_control, selection);
                if (selected <= 0) return selected;
                output_at = selection->output_bytes;
            } else {
                int relocatable = inspect_copied_instruction(
                    &instruction, output_at, selection);
                if (relocatable <= 0) return relocatable;
                if (output_at > U32_MAX_VALUE - instruction.source_bytes)
                    return PL_ERROR_X86_SELECT;
                output_at += instruction.source_bytes;
            }
        }
        rip = instruction.fallthrough;
    }
    if (!output_at) return 0;
    selection->source_bytes = (pl_u32)(block->end - block->start);
    selection->output_bytes = output_at;
    selection->projected_instruction_mask = retained;
    selection->supported = 1u;
    selection->copied_source = 0u;
    selection->direct_frame = 1u;
    selection->direct_live_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* ---- Shared-DAG frame ----
 *
 * A direct frame whose only GPR publications are node values may share every
 * intermediate once.  The schedule is built in three steps:
 *
 * 1. Re-associate every ADD3 whose two operands are already named by an
 *    earlier binary ADD, so a shared sum is read instead of recomputed:
 *    ADD3(a,b,c) with d = ADD(x,y), {x,y} subset {a,b,c}, becomes
 *    ADD(remaining,d).  This is transitive and drops each entry's last use to
 *    the single node that first consumes it.
 * 2. Allocate every node once into one of the overwritten output registers.
 *    A node overwrites an operand register whose value dies here; otherwise a
 *    free coordinate is used; otherwise the live value with the farthest next
 *    use is copied aside.  Registers that stay identity publications are never
 *    written, because the complete-future mask observes them.
 * 3. Replay the same choices through measure_alu_tree / write_alu_tree with
 *    transient value aliases, so an operand reads the register the schedule
 *    actually produced.  The emitted bytes are ordinary x86; no row, table or
 *    runtime descriptor survives. */

#define PL_X86_SHARED_DAG_MAX_NODES 96u
#define PL_X86_SHARED_DAG_MAX_ACTIONS 512u
#define PL_X86_SHARED_DAG_NONE 0xffu

#define PL_X86_SHARED_DAG_NODE_ACTION  0u
#define PL_X86_SHARED_DAG_SPILL_ACTION 1u
#define PL_X86_SHARED_DAG_FINAL_ACTION 2u
#define PL_X86_SHARED_DAG_FLAG_ACTION  3u

typedef struct {
    pl_u32 kind;
    pl_u32 node;
    pl_u32 destination;
    pl_u32 source;
    pl_u32 bits;
    pl_u32 pair_node;
    pl_operand remaining;
} shared_dag_action;

typedef struct {
    pl_u32 count;
    shared_dag_action action[PL_X86_SHARED_DAG_MAX_ACTIONS];
} shared_dag_list;

typedef struct {
    pl_u32 node_count;
    pl_u32 flag_node;
    pl_u32 out_mask;
    pl_u32 final_of_node[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 node_last[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 entry_last[PL_X86_GPR_COUNT];
    pl_u32 operand_count[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 bits[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 pair_node[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_operand operand[PL_X86_SHARED_DAG_MAX_NODES + 1u][4u];
} shared_dag_shape;

/* The pair an ADD3 already has as an earlier binary sum, if any. */
static int shared_dag_add3_pair(const pl_plan *plan, pl_u32 node_number,
                                pl_u32 *pair_node, pl_operand *remaining,
                                pl_u32 *bits)
{
    if (!plan || !pair_node || !remaining || !bits
            || node_number < 2u || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    pl_u32 lane = node->opcode == PL_OPCODE_ADD3[0] ? 0u
                : node->opcode == PL_OPCODE_ADD3[1] ? 1u : 2u;
    if (lane == 2u || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    pl_u32 width = lane == 0u ? 32u : 64u;
    const pl_operand *argument = plan->arguments + node->argument_at;
    for (pl_u32 candidate = 1u; candidate < node_number; ++candidate) {
        pl_operand left, right;
        pl_u32 candidate_bits = 0u, candidate_mode = 0u;
        /* A 32-bit ADD3 may consume a 64-bit binary sum: the low 32 bits of a
         * 64-bit add are exactly the 32-bit add, so the same shared pair is a
         * valid producer for the narrower node. */
        int narrow_pair = lane == 0u;
        if (!arithmetic_tree_details(
                plan, (pl_operand){ PL_OPERAND_NODE, candidate },
                &left, &right, &candidate_bits, &candidate_mode)
                || candidate_mode != 1u
                || (candidate_bits != width
                    && !(narrow_pair && candidate_bits == 64u)))
            continue;
        for (pl_u32 i = 0u; i < 3u; ++i)
            for (pl_u32 j = i + 1u; j < 3u; ++j) {
                int match = (equal_operand(argument[i], left)
                             && equal_operand(argument[j], right))
                         || (equal_operand(argument[i], right)
                             && equal_operand(argument[j], left));
                if (!match) continue;
                *pair_node = candidate;
                *remaining = argument[3u - i - j];
                *bits = width;
                return 1;
            }
    }
    return 0;
}

/* The pair an ADD3 has as a value that another local already publishes.  This
 * is the same relation as `shared_dag_add3_pair`, but expressed through the
 * local plane so the pair is a register the frame has ordered, not a later
 * node.  `pair_local` must be a local whose publication the caller schedules;
 * the matching dependency is recorded in `alu_frame_source_laws`. */
static int shared_dag_add3_published_pair(
    const pl_plan *plan, pl_u32 node_number, pl_u32 *pair_local,
    pl_operand *remaining, pl_u32 *bits)
{
    if (!plan || !pair_local || !remaining || !bits
            || node_number < 2u || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    pl_u32 lane = node->opcode == PL_OPCODE_ADD3[0] ? 0u
                : node->opcode == PL_OPCODE_ADD3[1] ? 1u : 2u;
    if (lane == 2u || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    pl_u32 width = lane == 0u ? 32u : 64u;
    const pl_operand *argument = plan->arguments + node->argument_at;
    for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
        pl_operand published = plan->locals[other];
        if (published.kind != PL_OPERAND_NODE || !published.value
                || published.value > plan->node_count)
            continue;
        pl_operand left, right;
        pl_u32 other_bits = 0u, other_mode = 0u;
        int narrow_pair = lane == 0u;
        if (!arithmetic_tree_details(plan, published, &left, &right,
                                     &other_bits, &other_mode)
                || other_mode != 1u
                || (other_bits != width
                    && !(narrow_pair && other_bits == 64u)))
            continue;
        for (pl_u32 i = 0u; i < 3u; ++i)
            for (pl_u32 j = i + 1u; j < 3u; ++j) {
                int match = (equal_operand(argument[i], left)
                             && equal_operand(argument[j], right))
                         || (equal_operand(argument[i], right)
                             && equal_operand(argument[j], left));
                if (!match) continue;
                *pair_local = other;
                *remaining = argument[3u - i - j];
                *bits = width;
                return 1;
            }
    }
    return 0;
}

static int shared_dag_shape_build(const pl_x86_block *block,
                                  shared_dag_shape *shape)
{
    if (!block || !shape) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 count = plan->node_count;
    if (!count || count > PL_X86_SHARED_DAG_MAX_NODES
            || plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    *shape = (shared_dag_shape){ 0 };
    shape->node_count = count;
    for (pl_u32 node = 0u; node <= count; ++node)
        shape->final_of_node[node] = PL_X86_SHARED_DAG_NONE;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (value.kind != PL_OPERAND_NODE || !value.value || value.value > count)
            return 0;
        if (shape->final_of_node[value.value] != PL_X86_SHARED_DAG_NONE)
            return 0;
        shape->final_of_node[value.value] = local;
        shape->out_mask |= 1u << local;
    }
    for (pl_u32 local = PL_X86_GPR_COUNT; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (local != PL_X86_RFLAGS_LOCAL
                || value.kind != PL_OPERAND_NODE || !value.value
                || value.value > count)
            return 0;
        shape->flag_node = (pl_u32)value.value;
    }
    if (!shape->out_mask) return 0;
    for (pl_u32 node = 1u; node <= count; ++node) {
        shape->pair_node[node] = 0u;
        if (node == shape->flag_node) {
            const pl_node *value = &plan->nodes[node - 1u];
            if (value->argument_at > plan->argument_count
                    || value->argument_count
                       > plan->argument_count - value->argument_at
                    || value->argument_count > 4u)
                return 0;
            shape->operand_count[node] = value->argument_count;
            for (pl_u32 at = 0u; at < value->argument_count; ++at)
                shape->operand[node][at] =
                    plan->arguments[value->argument_at + at];
            continue;
        }
        pl_u32 pair = 0u, pair_bits = 0u;
        pl_operand remaining = { 0 };
        if (shared_dag_add3_pair(
                plan, node, &pair, &remaining, &pair_bits)) {
            shape->pair_node[node] = pair;
            shape->operand_count[node] = 2u;
            shape->operand[node][0] = remaining;
            shape->operand[node][1] =
                (pl_operand){ PL_OPERAND_NODE, pair };
            shape->bits[node] = pair_bits;
            continue;
        }
        const pl_node *value = &plan->nodes[node - 1u];
        if (!value->argument_count
                || value->argument_at > plan->argument_count
                || value->argument_count
                   > plan->argument_count - value->argument_at
                || value->argument_count > 4u)
            return 0;
        shape->operand_count[node] = value->argument_count;
        for (pl_u32 at = 0u; at < value->argument_count; ++at)
            shape->operand[node][at] =
                plan->arguments[value->argument_at + at];
        pl_u32 node_bits = operand_expression_bits(
            plan, (pl_operand){ PL_OPERAND_NODE, node }, 0u);
        if (!node_bits) return 0;
        shape->bits[node] = node_bits;
    }
    for (pl_u32 node = 1u; node <= count; ++node)
        for (pl_u32 at = 0u; at < shape->operand_count[node]; ++at) {
            pl_operand operand = shape->operand[node][at];
            if (operand.kind == PL_OPERAND_NODE
                    && operand.value && operand.value <= count) {
                if (node > shape->node_last[operand.value])
                    shape->node_last[operand.value] = node;
            } else if (operand.kind == PL_OPERAND_LOCAL
                    && operand.value < PL_X86_GPR_COUNT) {
                if (node > shape->entry_last[operand.value])
                    shape->entry_last[operand.value] = node;
            }
        }
    for (pl_u32 node = 1u; node <= count; ++node)
        if (shape->final_of_node[node] != PL_X86_SHARED_DAG_NONE)
            shape->node_last[node] = 0x7fffffffu;
    return 1;
}

static pl_u32 shared_dag_holder(pl_operand operand,
                                const pl_u32 *entry_home,
                                const pl_u32 *node_home)
{
    if (operand.kind == PL_OPERAND_LOCAL
            && operand.value < PL_X86_GPR_COUNT)
        return entry_home[operand.value];
    if (operand.kind == PL_OPERAND_NODE
            && operand.value <= PL_X86_SHARED_DAG_MAX_NODES)
        return node_home[operand.value];
    return PL_X86_SHARED_DAG_NONE;
}

static pl_u32 shared_dag_last(pl_operand operand, pl_u32 at,
                              const shared_dag_shape *shape)
{
    if (operand.kind == PL_OPERAND_LOCAL
            && operand.value < PL_X86_GPR_COUNT)
        return shape->entry_last[operand.value];
    if (operand.kind == PL_OPERAND_NODE
            && operand.value <= PL_X86_SHARED_DAG_MAX_NODES)
        return shape->node_last[operand.value];
    return at;
}

static int shared_dag_available(pl_u32 local, pl_u32 at,
                                const shared_dag_shape *shape,
                                const pl_u32 *occ_kind,
                                const pl_u32 *occ_value)
{
    if (local >= PL_X86_GPR_COUNT
            || !(shape->out_mask & (1u << local)))
        return 0;
    if (occ_kind[local] == 0u) return 1;
    if (occ_kind[local] == 2u)
        return shape->node_last[occ_value[local]] <= at;
    return shape->entry_last[occ_value[local]] <= at;
}

static pl_u32 shared_dag_pick_destination(
    pl_u32 node, pl_u32 at, const shared_dag_shape *shape,
    const pl_u32 *occ_kind, const pl_u32 *occ_value,
    const pl_u32 *entry_home, const pl_u32 *node_home)
{
    pl_u32 final = shape->final_of_node[node];
    if (final != PL_X86_SHARED_DAG_NONE
            && shared_dag_available(final, at, shape, occ_kind, occ_value))
        return final;
    /* Prefer a destroying in-place operand that is not reserved for a later
     * final publication, then one that is, then a free coordinate. */
    for (pl_u32 pass = 0u; pass < 3u; ++pass)
        for (pl_u32 at_arg = 0u; at_arg < shape->operand_count[node]; ++at_arg) {
            pl_operand operand = shape->operand[node][at_arg];
            pl_u32 holder = shared_dag_holder(operand, entry_home, node_home);
            if (holder >= PL_X86_GPR_COUNT) continue;
            if (shared_dag_last(operand, at, shape) > at) continue;
            if (!shared_dag_available(holder, at, shape, occ_kind, occ_value))
                continue;
            pl_u32 reserved = 0u;
            for (pl_u32 later = at + 1u; later <= shape->node_count; ++later)
                if (shape->final_of_node[later] == holder
                        && node_home[later] == PL_X86_SHARED_DAG_NONE) {
                    reserved = 1u;
                    break;
                }
            if (pass == 0u && reserved) continue;
            if (pass == 1u && !reserved) continue;
            return holder;
        }
    for (pl_u32 pass = 0u; pass < 2u; ++pass)
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!shared_dag_available(local, at, shape, occ_kind, occ_value))
                continue;
            pl_u32 reserved = 0u;
            for (pl_u32 later = at + 1u; later <= shape->node_count; ++later)
                if (shape->final_of_node[later] == local
                        && node_home[later] == PL_X86_SHARED_DAG_NONE) {
                    reserved = 1u;
                    break;
                }
            if (pass == 0u && reserved) continue;
            if (pass == 1u && !reserved) continue;
            return local;
        }
    return PL_X86_SHARED_DAG_NONE;
}

static int shared_dag_allocate_greedy(const shared_dag_shape *shape,
                                      shared_dag_list *list, pl_u32 *stage)
{
    if (stage) *stage = 0u;
    if (!shape || !list) return 0;
    pl_u32 count = shape->node_count;
    pl_u32 occ_kind[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 occ_value[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 entry_home[PL_X86_GPR_COUNT];
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        entry_home[local] = local;
        occ_kind[local] = 1u;
        occ_value[local] = local;
    }
    for (pl_u32 node = 0u; node <= count; ++node)
        node_home[node] = PL_X86_SHARED_DAG_NONE;
    list->count = 0u;
#define SHD_PUSH(action_) do { \
        if (list->count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return 0; \
        list->action[list->count++] = (action_); \
    } while (0)
    for (pl_u32 node = 1u; node <= count; ++node) {
        if (node == shape->flag_node) continue;
        pl_u32 at = node;
        pl_u32 destination = shared_dag_pick_destination(
            node, at, shape, occ_kind, occ_value, entry_home, node_home);
        if (destination == PL_X86_SHARED_DAG_NONE) {
            if (stage) *stage = 0x10u;
            /* Copy the live value with the farthest next use aside, then use
             * its coordinate.  This is the source-level register shuffle. */
            pl_u32 victim = PL_X86_SHARED_DAG_NONE, victim_last = 0u;
            for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
                if (!(shape->out_mask & (1u << local))
                        || occ_kind[local] == 0u)
                    continue;
                pl_u32 last = occ_kind[local] == 2u
                    ? shape->node_last[occ_value[local]]
                    : shape->entry_last[occ_value[local]];
                if (last <= at) continue;
                if (victim == PL_X86_SHARED_DAG_NONE || last > victim_last) {
                    victim = local;
                    victim_last = last;
                }
            }
            pl_u32 spare = PL_X86_SHARED_DAG_NONE;
            for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
                if (local != victim
                        && shared_dag_available(
                            local, at, shape, occ_kind, occ_value)) {
                    spare = local;
                    break;
                }
            if (victim == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x11u;
                return 0;
            }
            if (spare == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x12u;
                return 0;
            }
            shared_dag_action spill = { 0 };
            spill.kind = PL_X86_SHARED_DAG_SPILL_ACTION;
            spill.source = victim;
            spill.destination = spare;
            SHD_PUSH(spill);
            occ_kind[spare] = occ_kind[victim];
            occ_value[spare] = occ_value[victim];
            if (occ_kind[victim] == 2u)
                node_home[occ_value[victim]] = spare;
            else
                entry_home[occ_value[victim]] = spare;
            occ_kind[victim] = 0u;
            destination = shared_dag_pick_destination(
                node, at, shape, occ_kind, occ_value, entry_home, node_home);
            if (destination == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x13u;
                return 0;
            }
        }
        shared_dag_action action = { 0 };
        action.kind = PL_X86_SHARED_DAG_NODE_ACTION;
        action.node = node;
        action.destination = destination;
        action.bits = shape->bits[node];
        action.pair_node = shape->pair_node[node];
        if (action.pair_node)
            action.remaining = shape->operand[node][0];
        SHD_PUSH(action);
        if (occ_kind[destination] == 2u)
            node_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
        else if (occ_kind[destination] == 1u)
            entry_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
        occ_kind[destination] = 2u;
        occ_value[destination] = node;
        node_home[node] = destination;
    }
    pl_u8 placed[PL_X86_SHARED_DAG_MAX_NODES + 1u] = { 0 };
    int progress = 1;
    while (progress) {
        progress = 0;
        for (pl_u32 node = 1u; node <= count; ++node) {
            pl_u32 final = shape->final_of_node[node];
            if (final == PL_X86_SHARED_DAG_NONE || placed[node]) continue;
            pl_u32 home = node_home[node];
            if (home == final) { placed[node] = 1u; progress = 1; continue; }
            if (home == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x2100u + node;
                return 0;
            }
            if (!shared_dag_available(
                    final, count + 1u, shape, occ_kind, occ_value))
                continue;
            shared_dag_action move = { 0 };
            move.kind = PL_X86_SHARED_DAG_FINAL_ACTION;
            move.node = node;
            move.destination = final;
            move.source = home;
            move.bits = shape->bits[node];
            SHD_PUSH(move);
            if (occ_kind[home] == 2u)
                node_home[occ_value[home]] = PL_X86_SHARED_DAG_NONE;
            occ_kind[final] = 2u;
            occ_value[final] = node;
            node_home[node] = final;
            if (home != final) occ_kind[home] = 0u;
            placed[node] = 1u;
            progress = 1;
        }
    }
    for (pl_u32 node = 1u; node <= count; ++node)
        if (shape->final_of_node[node] != PL_X86_SHARED_DAG_NONE
                && !placed[node]) {
            if (stage) *stage = 0x2300u + node;
            return 0;
        }
    if (shape->flag_node) {
        shared_dag_action flags = { 0 };
        flags.kind = PL_X86_SHARED_DAG_FLAG_ACTION;
        flags.node = shape->flag_node;
        SHD_PUSH(flags);
    }
#undef SHD_PUSH
    return 1;
}

static int shared_dag_place_finals(
    const shared_dag_shape *shape,
    pl_u32 occ_kind[PL_X86_GPR_COUNT], pl_u32 occ_value[PL_X86_GPR_COUNT],
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u],
    shared_dag_list *list)
{
    pl_u32 count = shape->node_count;
    /* Every generation that is not an observable final is dead at the
     * complete-future cut, so its coordinate is a free temporary for placing
     * the finals.  This is a lifetime fact, not a spill. */
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape->out_mask & (1u << local)) || occ_kind[local] == 0u)
            continue;
        if (occ_kind[local] == 2u
                && shape->node_last[occ_value[local]] > count + 1u)
            continue;
        if (occ_kind[local] == 2u)
            node_home[occ_value[local]] = PL_X86_SHARED_DAG_NONE;
        occ_kind[local] = 0u;
    }
    pl_u8 placed[PL_X86_SHARED_DAG_MAX_NODES + 1u] = { 0 };
    int progress = 1;
    while (progress) {
        progress = 0;
        for (pl_u32 node = 1u; node <= count; ++node) {
            pl_u32 final = shape->final_of_node[node];
            if (final == PL_X86_SHARED_DAG_NONE || placed[node]) continue;
            pl_u32 home = node_home[node];
            if (home == final) { placed[node] = 1u; progress = 1; continue; }
            if (home == PL_X86_SHARED_DAG_NONE) return 0;
            if (!shared_dag_available(
                    final, count + 1u, shape, occ_kind, occ_value))
                continue;
            if (list->count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return 0;
            shared_dag_action move = { 0 };
            move.kind = PL_X86_SHARED_DAG_FINAL_ACTION;
            move.node = node;
            move.destination = final;
            move.source = home;
            move.bits = shape->bits[node];
            list->action[list->count++] = move;
            if (occ_kind[home] == 2u)
                node_home[occ_value[home]] = PL_X86_SHARED_DAG_NONE;
            occ_kind[final] = 2u;
            occ_value[final] = node;
            node_home[node] = final;
            if (home != final) occ_kind[home] = 0u;
            placed[node] = 1u;
            progress = 1;
        }
    }
    for (pl_u32 node = 1u; node <= count; ++node)
        if (shape->final_of_node[node] != PL_X86_SHARED_DAG_NONE
                && !placed[node])
            return 0;
    return 1;
}

static pl_u32 shared_dag_step_cost(const shared_dag_shape *shape, pl_u32 node,
    pl_u32 destination, const pl_u32 *entry_home, const pl_u32 *node_home)
{
    if (shape->pair_node[node])
        return destination == shared_dag_holder(
            shape->operand[node][0], entry_home, node_home) ? 1u : 2u;
    for (pl_u32 at = 0u; at < shape->operand_count[node]; ++at) {
        pl_operand operand = shape->operand[node][at];
        if (shared_dag_last(operand, node, shape) > node) continue;
        if (shared_dag_holder(operand, entry_home, node_home) == destination)
            return 1u;
    }
    return 2u;
}

static int shared_dag_dest_seen(const pl_u32 *out, pl_u32 count, pl_u32 value)
{
    for (pl_u32 at = 0u; at < count; ++at)
        if (out[at] == value) return 1;
    return 0;
}

static pl_u32 shared_dag_collect_dests(
    const shared_dag_shape *shape, pl_u32 node,
    const pl_u32 *occ_kind, const pl_u32 *occ_value,
    const pl_u32 *entry_home, const pl_u32 *node_home,
    pl_u32 *out, pl_u32 capacity)
{
    pl_u32 count = 0u;
    pl_u32 final = shape->final_of_node[node];
    if (final != PL_X86_SHARED_DAG_NONE
            && shared_dag_available(final, node, shape, occ_kind, occ_value)
            && count < capacity)
        out[count++] = final;
    for (pl_u32 at = 0u; at < shape->operand_count[node]; ++at) {
        pl_operand operand = shape->operand[node][at];
        if (shared_dag_last(operand, node, shape) > node) continue;
        pl_u32 holder = shared_dag_holder(operand, entry_home, node_home);
        if (holder >= PL_X86_GPR_COUNT
                || shared_dag_dest_seen(out, count, holder)
                || !shared_dag_available(holder, node, shape, occ_kind, occ_value)
                || count >= capacity)
            continue;
        out[count++] = holder;
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (shared_dag_dest_seen(out, count, local)
                || !shared_dag_available(local, node, shape, occ_kind, occ_value)
                || count >= capacity)
            continue;
        out[count++] = local;
    }
    return count;
}

typedef struct {
    const shared_dag_shape *shape;
    shared_dag_list best;
    shared_dag_list current;
    pl_u32 best_cost;
    pl_u64 expansions;
    pl_u64 budget;
    pl_u64 leaves;
    pl_u64 finals_ok;
} shared_dag_search;

static void shared_dag_apply_node(
    pl_u32 node, pl_u32 destination,
    pl_u32 *occ_kind, pl_u32 *occ_value, pl_u32 *entry_home, pl_u32 *node_home)
{
    if (occ_kind[destination] == 2u)
        node_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
    else if (occ_kind[destination] == 1u)
        entry_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
    occ_kind[destination] = 2u;
    occ_value[destination] = node;
    node_home[node] = destination;
}

static void shared_dag_dfs(shared_dag_search *search,
    pl_u32 *occ_kind, pl_u32 *occ_value,
    pl_u32 *entry_home, pl_u32 *node_home,
    pl_u32 node, pl_u32 cost)
{
    const shared_dag_shape *shape = search->shape;
    pl_u32 count = shape->node_count;
    if (++search->expansions > search->budget) return;
    if (cost + (count - node + 1u) >= search->best_cost) return;
    if (node > count) {
        ++search->leaves;
        pl_u32 final_kind[PL_X86_GPR_COUNT], final_value[PL_X86_GPR_COUNT];
        pl_u32 final_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
        for (pl_u32 at = 0u; at < PL_X86_GPR_COUNT; ++at) {
            final_kind[at] = occ_kind[at];
            final_value[at] = occ_value[at];
        }
        for (pl_u32 at = 0u; at <= count; ++at) final_home[at] = node_home[at];
        shared_dag_list candidate = search->current;
        if (!shared_dag_place_finals(
                shape, final_kind, final_value, final_home, &candidate))
            return;
        ++search->finals_ok;
        pl_u32 total = cost + (candidate.count - search->current.count)
                     + (shape->flag_node ? 1u : 0u);
        if (total >= search->best_cost) return;
        if (shape->flag_node) {
            if (candidate.count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return;
            shared_dag_action flags = { 0 };
            flags.kind = PL_X86_SHARED_DAG_FLAG_ACTION;
            flags.node = shape->flag_node;
            candidate.action[candidate.count++] = flags;
        }
        search->best = candidate;
        search->best_cost = total;
        return;
    }
    if (node == shape->flag_node) {
        shared_dag_dfs(search, occ_kind, occ_value,
            entry_home, node_home, node + 1u, cost);
        return;
    }
    pl_u32 dests[8];
    pl_u32 dest_count = shared_dag_collect_dests(shape, node,
        occ_kind, occ_value, entry_home, node_home, dests, 8u);
    if (!dest_count) {
        pl_u32 victim = PL_X86_SHARED_DAG_NONE, victim_last = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(shape->out_mask & (1u << local)) || occ_kind[local] == 0u)
                continue;
            pl_u32 last = occ_kind[local] == 2u
                ? shape->node_last[occ_value[local]]
                : shape->entry_last[occ_value[local]];
            if (last <= node) continue;
            if (victim == PL_X86_SHARED_DAG_NONE || last > victim_last) {
                victim = local;
                victim_last = last;
            }
        }
        if (victim == PL_X86_SHARED_DAG_NONE) return;
        for (pl_u32 spare = 0u; spare < PL_X86_GPR_COUNT; ++spare) {
            if (spare == victim
                    || !shared_dag_available(
                        spare, node, shape, occ_kind, occ_value))
                continue;
            pl_u32 spare_kind[PL_X86_GPR_COUNT], spare_value[PL_X86_GPR_COUNT];
            pl_u32 spare_entry_home[PL_X86_GPR_COUNT];
            pl_u32 spare_node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
            for (pl_u32 at = 0u; at < PL_X86_GPR_COUNT; ++at) {
                spare_kind[at] = occ_kind[at];
                spare_value[at] = occ_value[at];
                spare_entry_home[at] = entry_home[at];
            }
            for (pl_u32 at = 0u; at <= count; ++at)
                spare_node_home[at] = node_home[at];
            if (search->current.count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return;
            shared_dag_action spill = { 0 };
            spill.kind = PL_X86_SHARED_DAG_SPILL_ACTION;
            spill.source = victim;
            spill.destination = spare;
            search->current.action[search->current.count++] = spill;
            spare_kind[spare] = spare_kind[victim];
            spare_value[spare] = spare_value[victim];
            if (spare_kind[victim] == 2u)
                spare_node_home[spare_value[victim]] = spare;
            else
                spare_entry_home[spare_value[victim]] = spare;
            spare_kind[victim] = 0u;
            shared_dag_dfs(search, spare_kind, spare_value,
                spare_entry_home, spare_node_home, node, cost + 1u);
            --search->current.count;
            return;
        }
        return;
    }
    for (pl_u32 at = 0u; at < dest_count; ++at) {
        pl_u32 destination = dests[at];
        pl_u32 step = shared_dag_step_cost(shape, node, destination,
            entry_home, node_home);
        pl_u32 next_kind[PL_X86_GPR_COUNT], next_value[PL_X86_GPR_COUNT];
        pl_u32 next_entry_home[PL_X86_GPR_COUNT];
        pl_u32 next_node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
        for (pl_u32 copy = 0u; copy < PL_X86_GPR_COUNT; ++copy) {
            next_kind[copy] = occ_kind[copy];
            next_value[copy] = occ_value[copy];
            next_entry_home[copy] = entry_home[copy];
        }
        for (pl_u32 copy = 0u; copy <= count; ++copy)
            next_node_home[copy] = node_home[copy];
        if (search->current.count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return;
        shared_dag_action action = { 0 };
        action.kind = PL_X86_SHARED_DAG_NODE_ACTION;
        action.node = node;
        action.destination = destination;
        action.bits = shape->bits[node];
        action.pair_node = shape->pair_node[node];
        if (action.pair_node)
            action.remaining = shape->operand[node][0];
        search->current.action[search->current.count++] = action;
        shared_dag_apply_node(node, destination,
            next_kind, next_value, next_entry_home, next_node_home);
        shared_dag_dfs(search, next_kind, next_value,
            next_entry_home, next_node_home, node + 1u, cost + step);
        --search->current.count;
    }
}

static int shared_dag_allocate(const shared_dag_shape *shape,
                               shared_dag_list *list, pl_u32 *stage)
{
    if (!shape || !list) return 0;
    if (shared_dag_allocate_greedy(shape, list, stage)) {
        if (stage) *stage = 0u;
        return 1;
    }
    pl_u32 count = shape->node_count;
    pl_u32 occ_kind[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 occ_value[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 entry_home[PL_X86_GPR_COUNT];
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        entry_home[local] = local;
        occ_kind[local] = 1u;
        occ_value[local] = local;
    }
    for (pl_u32 node = 0u; node <= count; ++node)
        node_home[node] = PL_X86_SHARED_DAG_NONE;
    shared_dag_search search;
    search.shape = shape;
    search.best_cost = 0xffffffffu;
    search.current.count = 0u;
    search.expansions = 0u;
    search.budget = 50000000u;
    search.leaves = 0u;
    search.finals_ok = 0u;
    shared_dag_dfs(&search, occ_kind, occ_value, entry_home, node_home, 1u, 0u);
    if (search.best_cost == 0xffffffffu) {
        if (stage) *stage = 0x40u;
        return 0;
    }
    *list = search.best;
    if (stage) *stage = 0u;
    return 1;
}

static void shared_dag_set_aliases(pl_x86_native_selection *selection,
                                   pl_u32 count, const pl_u32 *entry_home,
                                   const pl_u32 *node_home)
{
    selection->value_alias_count = 0u;
    for (pl_u32 node = 1u; node <= count
            && selection->value_alias_count < PL_X86_VALUE_ALIAS_COUNT;
            ++node) {
        if (node_home[node] == PL_X86_SHARED_DAG_NONE) continue;
        pl_u32 at = selection->value_alias_count++;
        selection->value_alias_kind[at] = PL_OPERAND_NODE;
        selection->value_alias_value[at] = node;
        selection->value_alias_local[at] = (pl_u8)node_home[node];
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT
            && selection->value_alias_count < PL_X86_VALUE_ALIAS_COUNT;
            ++local) {
        if (entry_home[local] == PL_X86_SHARED_DAG_NONE
                || entry_home[local] == local)
            continue;
        pl_u32 at = selection->value_alias_count++;
        selection->value_alias_kind[at] = PL_OPERAND_LOCAL;
        selection->value_alias_value[at] = local;
        selection->value_alias_local[at] = (pl_u8)entry_home[local];
    }
}

static int shared_dag_replay(const pl_x86_block *block,
                             pl_x86_native_selection *selection,
                             const shared_dag_shape *shape,
                             const shared_dag_list *list,
                             const pl_x86_frontend *frontend,
                             pl_u8 *output, pl_u32 *bytes, pl_u32 *work)
{
    pl_u32 count = shape->node_count;
    pl_u32 occ_kind[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 occ_value[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 entry_home[PL_X86_GPR_COUNT];
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        entry_home[local] = local;
        occ_kind[local] = 1u;
        occ_value[local] = local;
    }
    for (pl_u32 node = 0u; node <= count; ++node)
        node_home[node] = PL_X86_SHARED_DAG_NONE;
    pl_u32 at = 0u, total_work = 0u;
    for (pl_u32 index = 0u; index < list->count; ++index) {
        const shared_dag_action *action = &list->action[index];
        shared_dag_set_aliases(selection, count, entry_home, node_home);
        pl_u32 written = 0u, pieces = 0u, step_work = 0u;
        if (action->kind == PL_X86_SHARED_DAG_NODE_ACTION) {
            if (action->pair_node) {
                if (action->remaining.kind == PL_OPERAND_CONST)
                    return 0;
                pl_u32 remaining_home = shared_dag_holder(
                    action->remaining, entry_home, node_home);
                pl_u32 pair_home = node_home[action->pair_node];
                if (remaining_home >= PL_X86_GPR_COUNT
                        || pair_home >= PL_X86_GPR_COUNT)
                    return 0;
                pieces = 0u;
                if (action->destination != remaining_home
                        && !emit_gpr_move(
                            action->destination, remaining_home,
                            action->bits, output ? output + at : 0, &pieces))
                    return 0;
                pl_u32 add_bytes = 0u;
                if (!emit_alu_instruction(
                        action->destination,
                        (pl_operand){ PL_OPERAND_LOCAL, pair_home },
                        action->bits, 1u, 0u,
                        output ? output + at + pieces : 0, &add_bytes))
                    return 0;
                written = pieces + add_bytes;
                step_work = action->destination == remaining_home ? 1u : 2u;
            } else {
                pl_operand value = { PL_OPERAND_NODE, action->node };
                if (frontend) {
                    int measured = measure_alu_tree(
                        frontend, block, selection, action->destination,
                        value, action->bits, at, count + 1u, 0u,
                        &written, &step_work);
                    if (measured <= 0) return 0;
                } else {
                    if (!write_alu_tree(
                            block, selection, action->destination, value,
                            action->bits, at, count + 1u, 0u,
                            output + at, &written))
                        return 0;
                    step_work = 1u;
                }
            }
            if (occ_kind[action->destination] == 2u)
                node_home[occ_value[action->destination]]
                    = PL_X86_SHARED_DAG_NONE;
            else if (occ_kind[action->destination] == 1u)
                entry_home[occ_value[action->destination]]
                    = PL_X86_SHARED_DAG_NONE;
            occ_kind[action->destination] = 2u;
            occ_value[action->destination] = action->node;
            node_home[action->node] = action->destination;
        } else if (action->kind == PL_X86_SHARED_DAG_SPILL_ACTION) {
            if (!emit_gpr_move(
                    action->destination, action->source, 64u,
                    output ? output + at : 0, &written))
                return 0;
            step_work = 1u;
            occ_kind[action->destination] = occ_kind[action->source];
            occ_value[action->destination] = occ_value[action->source];
            if (occ_kind[action->source] == 2u)
                node_home[occ_value[action->source]] = action->destination;
            else
                entry_home[occ_value[action->source]] = action->destination;
            occ_kind[action->source] = 0u;
        } else if (action->kind == PL_X86_SHARED_DAG_FINAL_ACTION) {
            if (!emit_gpr_move(
                    action->destination, action->source, action->bits,
                    output ? output + at : 0, &written))
                return 0;
            step_work = 1u;
            if (occ_kind[action->source] == 2u)
                node_home[occ_value[action->source]] = PL_X86_SHARED_DAG_NONE;
            occ_kind[action->destination] = 2u;
            occ_value[action->destination] = action->node;
            node_home[action->node] = action->destination;
            if (action->source != action->destination)
                occ_kind[action->source] = 0u;
        } else {
            standalone_flag_publication publication;
            if (!standalone_flag_publication_details(
                    &block->plan, action->node, &publication)
                    || !emit_standalone_flag_publication(
                        &publication, output ? output + at : 0, &written))
                return 0;
            step_work = 1u;
        }
        if (written > U32_MAX_VALUE - at
                || step_work > U32_MAX_VALUE - total_work)
            return PL_ERROR_X86_SELECT;
        at += written;
        total_work += step_work;
    }
    *bytes = at;
    *work = total_work;
    return 1;
}

static int consumed_flag_depends(const pl_plan *plan, pl_operand value,
                                 pl_u32 result_node, pl_u32 depth);
static pl_u32 consumed_flag_node_rank(const pl_plan *plan, pl_u32 local);

/* ---- Transient seed before a flag producer ----
 *
 * A final `X86_ALU` publication can have one operand that is an intermediate
 * reading an entry register which another pending publication overwrites.
 * Emitting the flag producer first would lose the flags; emitting the
 * clobbering publication first would lose the entry.  Capture the intermediate
 * once in a transient output coordinate whose final value is independent, then
 * run the other publications, then the flag producer, then close the transient
 * with a flag-preserving (const/copy/insert) publication of its own. */

typedef struct {
    pl_u32 flag_node;
    pl_u32 destination;
    pl_u32 transient;
    pl_u32 seed_bits;
    pl_u32 bits, mode, preserves_carry;
    pl_operand seed;
    pl_u32 others;
} transient_seed_frame;

static int transient_seed_frame_shape(const pl_x86_block *block,
                                      transient_seed_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_plan *plan = &block->plan;
    pl_operand flag_value = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_value.kind != PL_OPERAND_NODE || !flag_value.value
            || flag_value.value > plan->node_count)
        return 0;
    pl_u32 destination = 0u, bits = 0u, mode = 0u, preserves_carry = 0u;
    pl_operand left, right;
    if (!alu_node_details(
            plan, (pl_u32)flag_value.value, &destination, &left, &right,
            &bits, &mode, &preserves_carry)
            || destination >= PL_X86_GPR_COUNT || preserves_carry)
        return 0;
    if (!publication_is_flag_result(
            plan, plan->locals[destination], (pl_u32)flag_value.value))
        return 0;
    pl_u32 changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        changed |= 1u << local;
    }
    if (!(changed & (1u << destination))) return 0;
    pl_operand seed;
    if (left.kind == PL_OPERAND_LOCAL && left.value == destination
            && right.kind == PL_OPERAND_NODE) {
        seed = right;
    } else if (right.kind == PL_OPERAND_LOCAL && right.value == destination
            && left.kind == PL_OPERAND_NODE) {
        seed = left;
    } else {
        return 0;
    }
    if (!seed.value || seed.value > plan->node_count) return 0;
    pl_u32 commutative = (mode == 0u || mode == 1u || mode == 5u || mode == 6u);
    if (!commutative
            && !(left.kind == PL_OPERAND_LOCAL
                 && left.value == destination))
        return 0;
    pl_u32 seed_sources = 0u, seed_dependencies = 0u;
    if (!operand_frame_source_law(
            plan, seed, &seed_sources, &seed_dependencies)
            || (seed_dependencies & changed))
        return 0;
    /* The intermediate must not already be an architectural publication. */
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((changed & (1u << local))
                && plan->locals[local].kind == PL_OPERAND_NODE
                && plan->locals[local].value == seed.value)
            return 0;
    pl_u32 transient = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local)) || local == destination) continue;
        pl_operand value = plan->locals[local];
        if (consumed_flag_depends(plan, value, (pl_u32)seed.value,
                plan->node_count + 1u))
            continue;
        if (frame_local_publication_clobbers_flags(plan, local)) continue;
        if (transient == PL_X86_GPR_COUNT
                || consumed_flag_node_rank(plan, local)
                   > consumed_flag_node_rank(plan, transient))
            transient = local;
    }
    if (transient >= PL_X86_GPR_COUNT) return 0;
    pl_u32 others = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local)) || local == destination
                || local == transient)
            continue;
        if (consumed_flag_depends(plan, plan->locals[local],
                (pl_u32)seed.value, plan->node_count + 1u))
            return 0;
        if (consumed_flag_depends(plan, plan->locals[local],
                (pl_u32)flag_value.value, plan->node_count + 1u))
            return 0;
        others |= 1u << local;
    }
    pl_u32 seed_bits = operand_expression_bits(plan, seed, 0u);
    if (!seed_bits) return 0;
    *out = (transient_seed_frame){ 0 };
    out->flag_node = (pl_u32)flag_value.value;
    out->destination = destination;
    out->transient = transient;
    out->seed_bits = seed_bits;
    out->bits = bits;
    out->mode = mode;
    out->preserves_carry = preserves_carry;
    out->seed = seed;
    out->others = others;
    return 1;
}

static int measure_direct_transient_seed_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    transient_seed_frame shape;
    if (!transient_seed_frame_shape(block, &shape)) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 bytes = 0u, work = 0u;
    pl_u32 part = 0u, part_work = 0u;
    selection->frame_alias_present = 0u;
    if (measure_alu_tree(
            frontend, block, selection, shape.transient, shape.seed,
            shape.seed_bits, bytes, plan->node_count + 1u, 0u,
            &part, &part_work) <= 0)
        return 0;
    bytes += part;
    work += part_work;
    selection->frame_alias_value = shape.seed.value;
    selection->frame_alias_kind = shape.seed.kind;
    selection->frame_alias_local = (pl_u8)shape.transient;
    selection->frame_alias_present = 1u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.others & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = operand_expression_bits(plan, value, 64u);
        if (measure_alu_tree(
                frontend, block, selection, local, value, value_bits,
                bytes, plan->node_count + 1u, 0u,
                &part, &part_work) <= 0)
            return 0;
        bytes += part;
        work += part_work;
    }
    part = 0u;
    if (!emit_alu_instruction(
            shape.destination,
            (pl_operand){ PL_OPERAND_LOCAL, shape.transient },
            shape.bits, shape.mode, shape.preserves_carry, 0, &part)
            || bytes > U32_MAX_VALUE - part)
        return 0;
    bytes += part;
    ++work;
    if (measure_alu_tree(
            frontend, block, selection, shape.transient,
            plan->locals[shape.transient],
            operand_expression_bits(plan, plan->locals[shape.transient], 64u),
            bytes, plan->node_count + 1u, 0u, &part, &part_work) <= 0)
        return 0;
    bytes += part;
    work += part_work;
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++work;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_transient_seed_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int write_direct_transient_seed_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_transient_seed_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    transient_seed_frame shape;
    if (!transient_seed_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;
    const pl_plan *plan = &block->plan;
    pl_x86_native_selection mutable = *selection;
    pl_u32 at = 0u, written = 0u;
    mutable.frame_alias_present = 0u;
    if (!write_alu_tree(
            block, &mutable, shape.transient, shape.seed, shape.seed_bits,
            at, plan->node_count + 1u, 0u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    mutable.frame_alias_value = shape.seed.value;
    mutable.frame_alias_kind = shape.seed.kind;
    mutable.frame_alias_local = (pl_u8)shape.transient;
    mutable.frame_alias_present = 1u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.others & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = operand_expression_bits(plan, value, 64u);
        if (!write_alu_tree(
                block, &mutable, local, value, value_bits, at,
                plan->node_count + 1u, 0u, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    written = 0u;
    if (!emit_alu_instruction(
            shape.destination,
            (pl_operand){ PL_OPERAND_LOCAL, shape.transient },
            shape.bits, shape.mode, shape.preserves_carry,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!write_alu_tree(
            block, &mutable, shape.transient, plan->locals[shape.transient],
            operand_expression_bits(plan, plan->locals[shape.transient], 64u),
            at, plan->node_count + 1u, 0u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

/* ---- Consumed flag-result frame ----
 *
 * The final observable conditions can belong to an ALU result that is not
 * itself an architectural output: the result feeds later publications.  Emit
 * the independent publications first, then the ALU that produces the observed
 * flags, then only affine or copy publications over that result.  LEA and MOV
 * preserve the arithmetic flags, so the emitted flag word is the ALU's own.
 * This covers the common `sub`/`add` result whose value is consumed by a
 * following address computation while the flags remain live. */

typedef struct {
    pl_u32 flag_node;
    pl_u32 result_node;
    pl_u32 result_register;
    pl_operand left, right;
    pl_u32 bits, mode, preserves_carry;
    pl_u32 before_mask;
    pl_u32 after_mask;
} consumed_flag_frame;

static int consumed_flag_depends(const pl_plan *plan, pl_operand value,
                                 pl_u32 result_node, pl_u32 depth)
{
    if (!depth) return 0;
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    if (value.value == result_node) return 1;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    for (pl_u32 at = 0u; at < node->argument_count; ++at)
        if (consumed_flag_depends(
                plan, plan->arguments[node->argument_at + at],
                result_node, depth - 1u))
            return 1;
    return 0;
}

static int collect_consumed_affine(
    const pl_plan *plan, pl_operand value, pl_u32 bits, pl_u32 remaining,
    pl_u32 result_node, pl_u32 result_register, affine_lea *out)
{
    if (!plan || !out || !remaining) return 0;
    if (value.kind == PL_OPERAND_CONST) {
        out->displacement += value.value;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        return append_affine_local(out, (pl_u32)value.value, 0u);
    }
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    if (value.value == result_node)
        return append_affine_local(out, result_register, 0u);
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->argument_count == 3u
            && (node->opcode == PL_OPCODE_ADD3[0]
                || node->opcode == PL_OPCODE_ADD3[1])) {
        if ((node->opcode == PL_OPCODE_ADD3[0] ? 32u : 64u) != bits)
            return 0;
        for (pl_u32 at = 0u; at < 3u; ++at)
            if (!collect_consumed_affine(
                    plan, plan->arguments[node->argument_at + at],
                    bits, remaining - 1u, result_node, result_register, out))
                return 0;
        return 1;
    }
    pl_operand source, amount;
    pl_u32 shift_bits = 0u, group = 0u;
    if (shift_node_details(
            plan, value, &source, &amount, &shift_bits, &group)
            && shift_bits == bits && group == 4u
            && amount.kind == PL_OPERAND_CONST && amount.value <= 3u) {
        pl_operand leaf = source;
        if (leaf.kind == PL_OPERAND_NODE && leaf.value == result_node) {
            leaf = (pl_operand){ PL_OPERAND_LOCAL, result_register };
        } else if (leaf.kind == PL_OPERAND_NODE) {
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (!published_operand_local(plan, leaf, &owner))
                return 0;
            leaf = (pl_operand){ PL_OPERAND_LOCAL, owner };
        }
        if (leaf.kind != PL_OPERAND_LOCAL) return 0;
        return append_affine_local(
            out, (pl_u32)leaf.value, (pl_u32)amount.value);
    }
    /* An equal published owner already names the register. */
    {
        pl_u32 owner = PL_X86_GPR_COUNT;
        if (published_operand_local(plan, value, &owner))
            return append_affine_local(out, owner, 0u);
    }
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (arithmetic_tree_details(
            plan, value, &left, &right, &node_bits, &mode)
            && mode == 1u && node_bits == bits)
        return collect_consumed_affine(
                   plan, left, bits, remaining - 1u, result_node,
                   result_register, out)
            && collect_consumed_affine(
                   plan, right, bits, remaining - 1u, result_node,
                   result_register, out);
    return 0;
}

static int consumed_flag_frame_shape(const pl_x86_block *block,
                                     consumed_flag_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_plan *plan = &block->plan;
    pl_operand flag_value = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_value.kind != PL_OPERAND_NODE || !flag_value.value
            || flag_value.value > plan->node_count)
        return 0;
    pl_operand result, prior;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!flag_result_operand(
            plan, (pl_u32)flag_value.value, &result, &prior)
            || result.kind != PL_OPERAND_NODE || !result.value
            || result.value > plan->node_count
            || !flag_operation_details(
                plan, flag_value, &left, &right, &bits, &mode,
                &preserves_carry)
            || preserves_carry
            || left.kind != PL_OPERAND_LOCAL
            || left.value >= PL_X86_GPR_COUNT
            || (right.kind != PL_OPERAND_LOCAL
                && right.kind != PL_OPERAND_CONST)
            || (right.kind == PL_OPERAND_LOCAL
                && right.value >= PL_X86_GPR_COUNT))
        return 0;
    pl_u32 result_node = (pl_u32)result.value;
    pl_u32 before = 0u, after = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (value.kind == PL_OPERAND_NODE && value.value == result_node)
            return 0;   /* an ordinary publication already owns it */
        if (consumed_flag_depends(
                plan, value, result_node, plan->node_count + 1u))
            after |= 1u << local;
        else
            before |= 1u << local;
    }
    if (!after) return 0;
    if (before & (1u << (pl_u32)left.value)) return 0;
    if (right.kind == PL_OPERAND_LOCAL
            && (before & (1u << (pl_u32)right.value)))
        return 0;
    *out = (consumed_flag_frame){ 0 };
    out->flag_node = (pl_u32)flag_value.value;
    out->result_node = result_node;
    out->result_register = (pl_u32)left.value;
    out->left = left;
    out->right = right;
    out->bits = bits;
    out->mode = mode;
    out->preserves_carry = preserves_carry;
    out->before_mask = before;
    out->after_mask = after;
    return 1;
}

static pl_u32 consumed_flag_node_rank(const pl_plan *plan, pl_u32 local)
{
    pl_operand value = plan->locals[local];
    return value.kind == PL_OPERAND_NODE ? (pl_u32)value.value : 0u;
}

static int measure_direct_consumed_flag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    consumed_flag_frame shape;
    if (!consumed_flag_frame_shape(block, &shape)) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 bytes = 0u, work = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.before_mask & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = operand_expression_bits(plan, value, 64u);
        pl_u32 part = 0u, part_work = 0u;
        int measured = measure_alu_tree(
            frontend, block, selection, local, value, value_bits,
            bytes, plan->node_count + 1u, 0u, &part, &part_work);
        if (measured <= 0 || bytes > U32_MAX_VALUE - part)
            return measured < 0 ? measured : 0;
        bytes += part;
        work += part_work;
    }
    pl_u32 producer_bytes = 0u;
    if (!emit_alu_instruction(
            shape.result_register, shape.right, shape.bits, shape.mode,
            shape.preserves_carry, 0, &producer_bytes)
            || bytes > U32_MAX_VALUE - producer_bytes)
        return 0;
    bytes += producer_bytes;
    ++work;
    pl_u32 order[PL_X86_GPR_COUNT];
    pl_u32 order_count = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (shape.after_mask & (1u << local)) order[order_count++] = local;
    for (pl_u32 at = 1u; at < order_count; ++at) {
        pl_u32 key = order[at];
        pl_u32 rank = consumed_flag_node_rank(plan, key);
        pl_u32 slot = at;
        while (slot && consumed_flag_node_rank(plan, order[slot - 1u]) > rank) {
            order[slot] = order[slot - 1u];
            --slot;
        }
        order[slot] = key;
    }
    for (pl_u32 at = 0u; at < order_count; ++at) {
        pl_u32 local = order[at];
        pl_operand value = plan->locals[local];
        pl_u32 part = 0u;
        int is_copy = 0;
        pl_u32 source = PL_X86_GPR_COUNT;
        if (value.kind == PL_OPERAND_LOCAL && value.value < PL_X86_GPR_COUNT
                && value.value != local) {
            is_copy = 1;
            source = (pl_u32)value.value;
        } else if (value.kind == PL_OPERAND_NODE
                && value.value == shape.result_node) {
            is_copy = 1;
            source = shape.result_register;
        } else if (value.kind == PL_OPERAND_NODE) {
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (published_operand_local(plan, value, &owner)
                    && owner != local) {
                is_copy = 1;
                source = owner;
            }
        }
        int emitted = 0;
        if (is_copy) {
            pl_u32 value_bits = operand_expression_bits(plan, value, 64u);
            emitted = emit_gpr_move(
                local, source, value_bits, 0, &part);
        } else {
            affine_lea form = { 0 };
            pl_u32 value_bits = operand_expression_bits(plan, value, 0u);
            if (value_bits
                    && collect_consumed_affine(
                        plan, value, value_bits,
                        plan->node_count + 1u, shape.result_node,
                        shape.result_register, &form)) {
                if (form.count == 1u && !form.scale_log2[0]
                        && form.local[0] == local && !form.displacement)
                    emitted = 1, part = 0u;
                else
                    emitted = emit_affine_lea_width(
                        local, form, value_bits, 0, &part);
            }
        }
        if (!emitted || bytes > U32_MAX_VALUE - part
                || work == U32_MAX_VALUE)
            return 0;
        bytes += part;
        ++work;
    }
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++work;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_consumed_flag_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int write_direct_consumed_flag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_consumed_flag_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    consumed_flag_frame shape;
    pl_u32 bytes = 0u, work = 0u;
    pl_x86_native_selection mutable = *selection;
    if (!consumed_flag_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;
    /* Re-emit with byte output.  The measure path above is the schedule of
     * record; repeat the same decisions here. */
    const pl_plan *plan = &block->plan;
    pl_u32 at = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.before_mask & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        pl_u32 value_bits = operand_expression_bits(plan, value, 64u);
        pl_u32 written = 0u;
        if (!write_alu_tree(
                block, &mutable, local, value, value_bits, at,
                plan->node_count + 1u, 0u, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    pl_u32 written = 0u;
    if (!emit_alu_instruction(
            shape.result_register, shape.right, shape.bits, shape.mode,
            shape.preserves_carry, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    pl_u32 order[PL_X86_GPR_COUNT];
    pl_u32 order_count = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (shape.after_mask & (1u << local)) order[order_count++] = local;
    for (pl_u32 index = 1u; index < order_count; ++index) {
        pl_u32 key = order[index];
        pl_u32 rank = consumed_flag_node_rank(plan, key);
        pl_u32 slot = index;
        while (slot && consumed_flag_node_rank(plan, order[slot - 1u]) > rank) {
            order[slot] = order[slot - 1u];
            --slot;
        }
        order[slot] = key;
    }
    for (pl_u32 index = 0u; index < order_count; ++index) {
        pl_u32 local = order[index];
        pl_operand value = plan->locals[local];
        int is_copy = 0;
        pl_u32 source = PL_X86_GPR_COUNT;
        if (value.kind == PL_OPERAND_LOCAL && value.value < PL_X86_GPR_COUNT
                && value.value != local) {
            is_copy = 1;
            source = (pl_u32)value.value;
        } else if (value.kind == PL_OPERAND_NODE
                && value.value == shape.result_node) {
            is_copy = 1;
            source = shape.result_register;
        } else if (value.kind == PL_OPERAND_NODE) {
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (published_operand_local(plan, value, &owner)
                    && owner != local) {
                is_copy = 1;
                source = owner;
            }
        }
        written = 0u;
        int emitted = 0;
        if (is_copy) {
            pl_u32 value_bits = operand_expression_bits(plan, value, 64u);
            emitted = emit_gpr_move(
                local, source, value_bits, output + at, &written);
        } else {
            affine_lea form = { 0 };
            pl_u32 value_bits = operand_expression_bits(plan, value, 0u);
            if (value_bits
                    && collect_consumed_affine(
                        plan, value, value_bits,
                        plan->node_count + 1u, shape.result_node,
                        shape.result_register, &form)) {
                if (form.count == 1u && !form.scale_log2[0]
                        && form.local[0] == local && !form.displacement)
                    emitted = 1, written = 0u;
                else
                    emitted = emit_affine_lea_width(
                        local, form, value_bits, output + at, &written);
            }
        }
        if (!emitted) return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    (void)bytes;
    (void)work;
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

static int measure_direct_shared_dag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u;
        if (!conditional_alu_body(block, &body, &condition)) return 0;
        int measured = measure_direct_shared_dag_frame(
            frontend, &body, selection);
        if (measured <= 0) return measured;
        pl_u32 tail = block->relax_short_control ? 6u : 2u;
        pl_u32 bytes = selection->output_bytes;
        if (bytes > U32_MAX_VALUE - tail
                || selection->output_instructions == U32_MAX_VALUE)
            return PL_ERROR_X86_SELECT;
        int status = append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + (block->relax_short_control ? 2u : 1u),
            bytes + tail, block->successor[0]);
        if (status) return status;
        selection->output_bytes = bytes + tail;
        ++selection->output_instructions;
        selection->direct_frame = 1u;
        selection->direct_shared_dag_frame = 1u;
        selection->reason = PL_X86_NATIVE_SELECT_READY;
        return 1;
    }
    if (block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->source_identity)
        return 0;
    shared_dag_shape shape;
    shared_dag_list list;
    if (!shared_dag_shape_build(block, &shape)
            || !shared_dag_allocate(&shape, &list, 0))
        return 0;
    pl_u32 bytes = 0u, work = 0u;
    if (!shared_dag_replay(
            block, selection, &shape, &list, frontend, 0, &bytes, &work)
            || !bytes || !work)
        return 0;
    int aliases = alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shared_dag_frame = 1u;
    selection->direct_nested_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int write_direct_shared_dag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shared_dag_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u;
        pl_u32 tail = block->relax_short_control ? 6u : 2u;
        if (!conditional_alu_body(block, &body, &condition)
                || selection->output_bytes < tail)
            return PL_ERROR_X86_SELECT;
        pl_x86_native_selection body_selection = *selection;
        body_selection.output_bytes -= tail;
        int status = write_direct_shared_dag_frame(
            &body, &body_selection, output);
        if (status) return status;
        pl_u32 at = body_selection.output_bytes;
        if (block->relax_short_control) output[at++] = 0x0fu;
        output[at++] = (pl_u8)((block->relax_short_control ? 0x80u : 0x70u)
                               | condition);
        while (at < selection->output_bytes) output[at++] = 0u;
        return 0;
    }
    if (block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->source_identity)
        return PL_ERROR_X86_SELECT;
    shared_dag_shape shape;
    shared_dag_list list;
    if (!shared_dag_shape_build(block, &shape)
            || !shared_dag_allocate(&shape, &list, 0))
        return PL_ERROR_X86_SELECT;
    pl_u32 bytes = 0u, work = 0u;
    pl_x86_native_selection mutable = *selection;
    if (!shared_dag_replay(
            block, &mutable, &shape, &list, 0, output, &bytes, &work)
            || bytes != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}

int pl_x86_select_candidates(const pl_x86_frontend *frontend,
                             const pl_x86_block_workspace *workspace,
                             const pl_x86_block *block,
                             pl_x86_native_candidates *out)
{
    if (!frontend || !workspace || !block || !out
            || block->end < block->start
            || block->end - block->start > U32_MAX_VALUE)
        return PL_ERROR_X86_SELECT;
    /* A new block owns a new plan; invalidate the address-definition memo. */
    if (++source_addr_generation == 0u) ++source_addr_generation;
    pl_u32 source_bytes = (pl_u32)(block->end - block->start);
    *out = (pl_x86_native_candidates){ 0 };
    out->diagnostic.blocking_opcode = U32_MAX_VALUE;
    out->diagnostic.source_bytes = source_bytes;

    pl_x86_instruction terminal;
    int status = final_instruction(frontend, block, &terminal);
    if (status) return status;
    /* An invalid or fetch-fault coordinate is already one exact native fault
     * spelling.  Its decoder fallthrough is intentionally not a successor,
     * so suffix discovery must not demand that it reach block->end.  Keeping
     * these bytes is the ordinary-x86 representation of the precise #UD/#PF
     * cut and closes arbitrary byte entry coordinates without an interpreter
     * or runtime missing-block route. */
    if (block->kind == PL_X86_BLOCK_FAULT) {
        if (!source_bytes || terminal.source_bytes != source_bytes)
            return PL_ERROR_X86_SELECT;
        pl_x86_native_selection *fault = &out->candidate[out->count++];
        fault->blocking_opcode = U32_MAX_VALUE;
        fault->source_bytes = source_bytes;
        fault->output_bytes = source_bytes;
        fault->output_instructions = 1u;
        fault->output_work = 1u;
        fault->output_span = 1u;
        fault->supported = 1u;
        fault->copied_source = 1u;
        fault->reason = PL_X86_NATIVE_SELECT_READY;
        return 0;
    }
    if (!block->source_identity
            && block->kind == PL_X86_BLOCK_DIRECT
            && block->flow == PL_X86_FLOW_NEXT
            && block->successor_count == 1u
            && !block->dynamic_target
            && !block->has_predicate && !block->has_fault_predicate
            && block->machine_operation == PL_X86_MACHINE_NONE
            && plan_identity(&block->plan)) {
        /* Erasure is decided by the normalized semantic shell, not by the
         * source decoder's reason for ending the block. A precise source cut
         * whose target/predicate/fault/machine roots all normalized away is
         * the identity transfer. Retaining its bytes would make a source
         * scheduling annotation observable and block complete-future DCE. */
        pl_x86_native_selection *identity = &out->candidate[out->count++];
        identity->blocking_opcode = U32_MAX_VALUE;
        identity->source_bytes = source_bytes;
        identity->supported = 1u;
        identity->eliminated_bytes = source_bytes;
        return 0;
    }

    /* Every direct frame below emits only register/control topology.  A load
     * or store is an observable barrier even when no final GPR names its
     * value (notably the PLT resolver's push [GOT]).  Until a candidate emits
     * that memory topology explicitly, copied linked x86 is its sole exact
     * spelling. */
    if (!block->source_identity && !plan_has_memory(&block->plan)) {
        static const measure_normalized_candidate grammar[] = {
            measure_direct_frame,
            measure_direct_common_frame,
            measure_direct_add_frame,
            measure_direct_insert_frame,
            measure_direct_equal_compare_frame,
            measure_direct_constant_shift_frame,
            measure_direct_mul_add_carry_frame,
            measure_direct_condition_carry_frame,
            measure_direct_arx_frame,
            measure_direct_mutable_xor_frame,
            measure_direct_alu_frame,
            measure_direct_transient_owner_frame,
            measure_direct_zero_flag_frame,
            measure_direct_shift_handoff_frame,
            measure_direct_shared_owner_frame,
            measure_direct_value_predicate_frame,
            measure_direct_compare_handoff_frame,
            measure_direct_entry_flag_branch,
            measure_direct_compare_branch,
            measure_direct_affine_frame,
            measure_direct_transient_seed_frame,
            measure_direct_consumed_flag_frame,
            measure_direct_live_frame,
        };
        for (pl_u32 production = 0u;
                production < sizeof grammar / sizeof grammar[0];
                ++production) {
            status = append_normalized_candidate(
                out, frontend, block, source_bytes, grammar[production]);
            if (status) {
                out->diagnostic_stage = 0x100u + production;
                return status;
            }
        }
        /* The shared-DAG schedule is a last resort: it changes register
         * allocation across the whole frame, so it must not compete with a
         * frame production that already has a fixed local spelling. */
        if (!out->count) {
            status = append_normalized_candidate(
                out, frontend, block, source_bytes,
                measure_direct_shared_dag_frame);
            if (status) {
                out->diagnostic_stage = 0x180u;
                return status;
            }
        }
    }
    /* A memory effect is a precise one-instruction barrier.  If formation
     * ever admits a surrounding pure instruction into the same plan, copied
     * source would become an accidental normalization escape. */
    if (plan_has_memory(&block->plan) && block->instruction_count != 1u)
        return PL_ERROR_X86_SELECT;

    pl_x86_native_selection source = { 0 };
    source.blocking_opcode = U32_MAX_VALUE;
    source.source_bytes = source_bytes;
    status = block->source_identity ? 0 : equivalent_suffix_bytes(
        frontend, workspace, block, &source.omitted_prefix_bytes);
    if (status) {
        out->diagnostic_stage = 0x200u;
        return status;
    }

    int selected = measure_source_run(
        frontend, block->start, block->instruction_count,
        source.omitted_prefix_bytes, block->relax_short_control, &source);
    if (selected < 0) {
        out->diagnostic_stage = 0x300u;
        return selected;
    }
    if (selected) {
        source.supported = 1u;
        source.reason = PL_X86_NATIVE_SELECT_READY;
    }
    if (selected) {
        const pl_u32 all_outputs =
            (1u << PL_X86_LOCAL_COUNT) - 1u;
        /* Exact source x86 is itself a proved representative of a projected
         * future: the full lowering has identical mandatory effects and
         * identical publications on every live coordinate. Differences on
         * the omitted coordinates are unobservable by definition, so this is
         * a normalized projection production, not a fallback interpreter or
         * a second semantic route. */
        source.normalized_family_present = out->count != 0u
            || block->live_output_mask != all_outputs;
    }
    if (selected) {
        if (out->count >= PL_X86_NATIVE_MAX_CANDIDATES)
            return PL_ERROR_X86_SELECT;
        out->candidate[out->count++] = source;
    }
    if (!out->diagnostic.blocking_work) out->diagnostic = source;
    for (pl_u32 index = 0u; index < out->count; ++index) {
        pl_x86_native_selection *candidate = &out->candidate[index];
        status = derive_emitted_candidate_cost(
            frontend, block, candidate);
        if (status) {
            out->diagnostic_stage = 0x400u + index;
            return status;
        }
        if (candidate->source_bytes > candidate->output_bytes)
            candidate->eliminated_bytes =
                candidate->source_bytes - candidate->output_bytes;
    }
    return 0;
}

static int selection_precedes(const pl_x86_native_selection *left,
                              const pl_x86_native_selection *right)
{
    if (left->output_span != right->output_span)
        return left->output_span < right->output_span;
    if (left->output_work != right->output_work)
        return left->output_work < right->output_work;
    if (left->output_bytes != right->output_bytes)
        return left->output_bytes < right->output_bytes;
    return left->output_instructions < right->output_instructions;
}

int pl_x86_candidates_minimum_span(
    const pl_x86_native_candidates *candidates, pl_u32 serial_span,
    pl_u32 *out)
{
    if (!candidates || !candidates->count || !out) return PL_ERROR_X86_SELECT;
    pl_u32 minimum = U32_MAX_VALUE;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate =
            &candidates->candidate[index];
        if (!candidate->supported
                || candidate->output_span > U32_MAX_VALUE - serial_span)
            return PL_ERROR_X86_SELECT;
        pl_u32 span = candidate->output_span + serial_span;
        if (span < minimum) minimum = span;
    }
    *out = minimum;
    return 0;
}

int pl_x86_candidates_minimum_work(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work, pl_u32 span_ceiling,
    pl_u32 *out)
{
    if (!candidates || !candidates->count || !out) return PL_ERROR_X86_SELECT;
    pl_u32 minimum = U32_MAX_VALUE;
    int found = 0;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate =
            &candidates->candidate[index];
        if (!candidate->supported
                || candidate->output_span > U32_MAX_VALUE - serial_span
                || candidate->output_work > U32_MAX_VALUE - serial_work)
            return PL_ERROR_X86_SELECT;
        if (candidate->output_span + serial_span > span_ceiling) continue;
        pl_u32 work = candidate->output_work + serial_work;
        if (!found || work < minimum) minimum = work;
        found = 1;
    }
    if (!found) return PL_ERROR_X86_SELECT;
    *out = minimum;
    return 0;
}

int pl_x86_candidates_select_under(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_u32 span_ceiling, pl_u32 work_ceiling,
    pl_x86_native_selection *out)
{
    if (!candidates || !candidates->count || !out) return PL_ERROR_X86_SELECT;
    int found = 0;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        const pl_x86_native_selection *candidate =
            &candidates->candidate[index];
        if (!candidate->supported
                || candidate->output_span > U32_MAX_VALUE - serial_span
                || candidate->output_work > U32_MAX_VALUE - serial_work)
            return PL_ERROR_X86_SELECT;
        if (candidate->output_span + serial_span > span_ceiling
                || candidate->output_work + serial_work > work_ceiling)
            continue;
        if (!found || candidate->output_bytes < out->output_bytes
                || (candidate->output_bytes == out->output_bytes
                    && selection_precedes(candidate, out))) {
            *out = *candidate;
            found = 1;
        }
    }
    return found ? 0 : PL_ERROR_X86_SELECT;
}

int pl_x86_candidates_select_joint_minimum(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_x86_native_selection *out,
    pl_u32 *minimum_span, pl_u32 *minimum_work)
{
    if (!out || !minimum_span || !minimum_work)
        return PL_ERROR_X86_SELECT;
    int status = pl_x86_candidates_minimum_span(
        candidates, serial_span, minimum_span);
    if (!status)
        status = pl_x86_candidates_minimum_work(
            candidates, serial_span, serial_work,
            U32_MAX_VALUE, minimum_work);
    if (!status) {
        status = pl_x86_candidates_select_under(
            candidates, serial_span, serial_work,
            *minimum_span, *minimum_work, out);
        if (status == PL_ERROR_X86_SELECT)
            status = PL_ERROR_X86_PARETO;
    }
    return status;
}

static int same_physical_cost(const pl_x86_native_selection *left,
                              const pl_x86_native_selection *right)
{
    return left->output_span == right->output_span
        && left->output_work == right->output_work;
}

static int strictly_dominates(const pl_x86_native_selection *left,
                              const pl_x86_native_selection *right)
{
    return left->output_span <= right->output_span
        && left->output_work <= right->output_work
        && (left->output_span < right->output_span
            || left->output_work < right->output_work);
}

int pl_x86_candidates_pareto_frontier(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_x86_native_selection *out, pl_u32 capacity, pl_u32 *count)
{
    if (!candidates || !candidates->count || !out || !capacity || !count)
        return PL_ERROR_X86_SELECT;
    *count = 0u;
    for (pl_u32 index = 0u; index < candidates->count; ++index) {
        pl_x86_native_selection candidate = candidates->candidate[index];
        if (!candidate.supported
                || candidate.output_span > U32_MAX_VALUE - serial_span
                || candidate.output_work > U32_MAX_VALUE - serial_work)
            return PL_ERROR_X86_SELECT;
        candidate.output_span += serial_span;
        candidate.output_work += serial_work;
        int dominated = 0;
        for (pl_u32 other = 0u; other < candidates->count; ++other) {
            if (other == index) continue;
            pl_x86_native_selection witness = candidates->candidate[other];
            if (!witness.supported
                    || witness.output_span > U32_MAX_VALUE - serial_span
                    || witness.output_work > U32_MAX_VALUE - serial_work)
                return PL_ERROR_X86_SELECT;
            witness.output_span += serial_span;
            witness.output_work += serial_work;
            if (strictly_dominates(&witness, &candidate)
                    || (same_physical_cost(&witness, &candidate)
                        && selection_precedes(&witness, &candidate))) {
                dominated = 1;
                break;
            }
        }
        if (dominated) continue;
        if (*count >= capacity) return PL_ERROR_X86_SELECT;
        pl_u32 at = *count;
        while (at && selection_precedes(&candidate, &out[at - 1u])) {
            out[at] = out[at - 1u];
            --at;
        }
        out[at] = candidate;
        ++*count;
    }
    return *count ? 0 : PL_ERROR_X86_SELECT;
}

int pl_x86_select_measure(const pl_x86_frontend *frontend,
                          const pl_x86_block_workspace *workspace,
                          const pl_x86_block *block,
                          pl_x86_native_selection *out)
{
    if (!out) return PL_ERROR_X86_SELECT;
    pl_x86_native_candidates candidates;
    int status = pl_x86_select_candidates(
        frontend, workspace, block, &candidates);
    if (status) return status;
    if (!candidates.count) {
        *out = candidates.diagnostic;
        return 0;
    }
    pl_u32 span = 0u, work = 0u;
    status = pl_x86_candidates_select_joint_minimum(
        &candidates, 0u, 0u, out, &span, &work);
    return status;
}

static int write_source_run(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            const pl_x86_native_selection *selection,
                            pl_u8 *output)
{
    pl_u64 rip = block->start;
    pl_u32 output_at = 0u;
    pl_x86_instruction terminal;
    int status = final_instruction(frontend, block, &terminal);
    if (status) return status;
    pl_u64 copied_from = block->start + selection->omitted_prefix_bytes;

    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        int final = index + 1u == block->instruction_count;
        int retained = selection->direct_live_frame
                     ? !!(selection->projected_instruction_mask
                           & (1ull << index))
                     : rip >= copied_from;
        if (retained) {
            if (final && source_terminal(&instruction)
                    && (instruction.flags
                        & PL_X86_INSTRUCTION_DIRECT_TARGET)) {
                pl_u32 instruction_at = output_at;
                int widened = instruction.immediate_bytes[0] == 1u
                    && selection->output_bytes
                       > output_at + instruction.source_bytes;
                if (widened && instruction.flow == PL_X86_FLOW_JUMP
                        && instruction.operation
                           == PL_X86_OPERATION_BRANCH) {
                    pl_u32 prefix = instruction.immediate_offset[0] - 1u;
                    for (pl_u32 byte = 0u; byte < prefix; ++byte)
                        output[output_at++] = instruction.source[byte];
                    output[output_at++] = 0xe9u;
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                } else if (widened
                        && instruction.flow == PL_X86_FLOW_CONDITIONAL
                        && instruction.operation
                           == PL_X86_OPERATION_BRANCH
                        && instruction.condition <= 15u) {
                    pl_u32 prefix = instruction.immediate_offset[0] - 1u;
                    for (pl_u32 byte = 0u; byte < prefix; ++byte)
                        output[output_at++] = instruction.source[byte];
                    output[output_at++] = 0x0fu;
                    output[output_at++] =
                        (pl_u8)(0x80u + instruction.condition);
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                } else if (widened
                        && instruction.flow == PL_X86_FLOW_CONDITIONAL
                        && (instruction.operation == PL_X86_OPERATION_LOOP
                            || instruction.operation
                               == PL_X86_OPERATION_COUNT_ZERO_BRANCH)) {
                    for (pl_u32 byte = 0u;
                            byte < instruction.source_bytes; ++byte)
                        output[output_at++] = instruction.source[byte];
                    output[instruction_at + instruction.immediate_offset[0]] =
                        5u;
                    output[output_at++] = 0xe9u;
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                    output[output_at++] = 0xe9u;
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                } else {
                    for (pl_u32 byte = 0u;
                            byte < instruction.source_bytes; ++byte)
                        output[output_at++] = instruction.source[byte];
                }
                for (pl_u32 fixup = 0u;
                        fixup < selection->fixup_count; ++fixup) {
                    const pl_x86_native_fixup *field =
                        &selection->fixups[fixup];
                    if (field->kind != PL_X86_NATIVE_FIXUP_PC_RELATIVE
                            || field->at < instruction_at
                            || field->at + field->bytes > output_at)
                        continue;
                    for (pl_u32 byte = 0u; byte < field->bytes; ++byte)
                        output[field->at + byte] = 0u;
                }
            } else {
                for (pl_u32 byte = 0u; byte < instruction.source_bytes;
                        ++byte)
                    output[output_at++] = instruction.source[byte];
            }
        }
        rip = instruction.fallthrough;
    }
    return output_at == selection->output_bytes
         ? 0 : PL_ERROR_X86_SELECT;
}

int pl_x86_select_write(const pl_x86_frontend *frontend,
                        const pl_x86_block_workspace *workspace,
                        const pl_x86_block *block,
                        pl_u8 *output, pl_u32 output_capacity,
                        pl_u32 *output_bytes,
                        pl_x86_native_selection *selection)
{
    if (!output_bytes || !selection) return PL_ERROR_X86_SELECT;
    *output_bytes = 0u;
    int status = pl_x86_select_measure(
        frontend, workspace, block, selection);
    if (status || !selection->supported) return status;
    return pl_x86_select_write_measured(
        frontend, block, selection,
        output, output_capacity, output_bytes);
}

int pl_x86_select_write_measured(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    const pl_x86_native_selection *selection,
    pl_u8 *output, pl_u32 output_capacity, pl_u32 *output_bytes)
{
    if (!frontend || !block || !selection || !output_bytes
            || !selection->supported)
        return PL_ERROR_X86_SELECT;
    *output_bytes = 0u;
    if (selection->output_bytes > output_capacity
            || (selection->output_bytes && !output))
        return PL_ERROR_X86_SELECT;
    int status = 0;
    if (selection->output_bytes) {
        status = selection->direct_transient_seed_frame
               ? write_direct_transient_seed_frame(block, selection, output)
               : selection->direct_consumed_flag_frame
               ? write_direct_consumed_flag_frame(block, selection, output)
               : selection->direct_shared_dag_frame
               ? write_direct_shared_dag_frame(block, selection, output)
               : selection->direct_condition_carry_frame
               ? write_direct_condition_carry_frame(
                    block, selection, output)
               : selection->direct_mul_add_carry_frame
               ? write_direct_mul_add_carry_frame(
                    block, selection, output)
               : selection->direct_live_frame
               ? write_source_run(frontend, block, selection, output)
               : selection->direct_affine_frame
               ? write_direct_affine_frame(block, selection, output)
               : selection->direct_shift_handoff_frame
               ? write_direct_shift_handoff_frame(
                    block, selection, output)
               : selection->direct_zero_flag_frame
               ? write_direct_zero_flag_frame(block, selection, output)
               : selection->direct_transient_owner_frame
               ? write_direct_transient_owner_frame(
                    block, selection, output)
               : selection->direct_shared_owner_frame
                ? write_direct_shared_owner_frame(block, selection, output)
               : selection->direct_value_predicate_frame
               ? write_direct_value_predicate_frame(
                    block, selection, output)
               : selection->direct_compare_handoff_frame
               ? write_direct_compare_handoff_frame(
                    block, selection, output)
               : selection->direct_entry_branch_frame
               ? write_direct_entry_flag_branch(block, selection, output)
               : selection->direct_branch_frame
               ? write_direct_compare_branch(block, selection, output)
               : selection->direct_common_frame
               ? write_direct_common_frame(block, selection, output)
               : selection->direct_insert_frame
               ? write_direct_insert_frame(block, selection, output)
               : selection->direct_shift_frame
               ? write_direct_constant_shift_frame(block, selection, output)
               : selection->direct_compare_frame
               ? write_direct_equal_compare_frame(block, selection, output)
               : selection->direct_arx_frame
               ? write_direct_arx_frame(block, selection, output)
               : selection->direct_mutable_xor_frame
               ? write_direct_mutable_xor_frame(
                    block, selection, output)
               : selection->direct_alu_frame
               ? write_direct_alu_frame(block, selection, output)
               : selection->direct_add_frame
                 ? write_direct_add_frame(block, selection, output)
               : selection->direct_frame
                 ? write_direct_frame(block, selection, output)
                 : write_source_run(frontend, block, selection, output);
        if (status) return status;
    }
    *output_bytes = selection->output_bytes;
    return 0;
}

int pl_x86_select_bind_fixup(pl_u8 *output, pl_u32 output_bytes,
                            const pl_x86_native_selection *selection,
                            pl_u32 fixup_index, pl_u64 output_address,
                            pl_u64 target_address)
{
    if (!output || !selection || fixup_index >= selection->fixup_count)
        return PL_ERROR_X86_SELECT;
    const pl_x86_native_fixup *fixup = &selection->fixups[fixup_index];
    if ((fixup->bytes != 1u && fixup->bytes != 4u
                && fixup->bytes != 8u)
            || fixup->at > output_bytes
            || output_bytes - fixup->at < fixup->bytes
            || fixup->next_ip_at > output_bytes)
        return PL_ERROR_X86_SELECT;
    if (fixup->kind == PL_X86_NATIVE_FIXUP_ABSOLUTE) {
        if (fixup->bytes != 8u) return PL_ERROR_X86_SELECT;
        for (pl_u32 byte = 0u; byte < 8u; ++byte)
            output[fixup->at + byte] =
                (pl_u8)(target_address >> (byte * 8u));
        return 0;
    }
    if ((fixup->kind != PL_X86_NATIVE_FIXUP_PC_RELATIVE
            && fixup->kind != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT)
            || fixup->bytes == 8u
            || output_address > U64_MAX_VALUE - fixup->next_ip_at)
        return PL_ERROR_X86_SELECT;
    pl_u64 next = output_address + fixup->next_ip_at;
    pl_i64 displacement;
    if (target_address >= next) {
        pl_u64 delta = target_address - next;
        pl_u64 maximum = fixup->bytes == 1u ? 0x7fu : I32_MAX_VALUE;
        if (delta > maximum) return PL_ERROR_X86_SELECT;
        displacement = (pl_i64)delta;
    } else {
        pl_u64 delta = next - target_address;
        pl_u64 maximum = fixup->bytes == 1u
                       ? 0x80u : (pl_u64)I32_MAX_VALUE + 1u;
        if (delta > maximum)
            return PL_ERROR_X86_SELECT;
        displacement = -(pl_i64)delta;
    }
    pl_u32 encoded = (pl_u32)(pl_i32)displacement;
    for (pl_u32 byte = 0u; byte < fixup->bytes; ++byte)
        output[fixup->at + byte] = (pl_u8)(encoded >> (byte * 8u));
    return 0;
}
