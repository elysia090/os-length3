#include "internal/minimum.h"

#include <support/checked.h>

static pl_u8 program_bit(const pl_u8 *bytes, pl_u64 bit)
{
    return (pl_u8)(((pl_u32)bytes[bit >> 3u] >> (7u - (bit & 7u))) & 1u);
}

static int canonical_program(const pl_x86_minimum_key *key)
{
    if (!key || (key->program_bits && !key->program)) return 0;
    if (!key->program_bits || !(key->program_bits & 7u)) return 1;
    pl_u32 used = (pl_u32)(key->program_bits & 7u);
    pl_u8 padding = (pl_u8)((1u << (8u - used)) - 1u);
    return !(key->program[key->program_bits >> 3u] & padding);
}

static int grammar_bytes(pl_u64 first, pl_u64 second, pl_u64 third,
                         pl_u64 framing, pl_u64 *out)
{
    pl_u64 total = 0u;
    return out
        && pl_checked_add_u64(first, second, &total)
        && pl_checked_add_u64(total, third, &total)
        && pl_checked_add_u64(total, framing, out);
}

int pl_x86_grammar_serial(const pl_x86_minimum_bound *first,
                          const pl_x86_minimum_bound *second,
                          pl_u64 framing_bytes,
                          pl_x86_minimum_bound *out)
{
    pl_u64 span = 0u, work = 0u, bytes = 0u;
    if (!first || !second || !out
            || !pl_checked_add_u64(first->span, second->span, &span)
            || !pl_checked_add_u64(first->work, second->work, &work)
            || !grammar_bytes(first->elf_bytes, second->elf_bytes, 0u,
                              framing_bytes, &bytes))
        return PL_ERROR_MINIMUM;
    *out = (pl_x86_minimum_bound){ span, work, bytes };
    return 0;
}

int pl_x86_grammar_parallel(const pl_x86_minimum_bound *left,
                            const pl_x86_minimum_bound *right,
                            pl_u64 framing_bytes,
                            pl_x86_minimum_bound *out)
{
    pl_u64 work = 0u, bytes = 0u;
    if (!left || !right || !out
            || !pl_checked_add_u64(left->work, right->work, &work)
            || !grammar_bytes(left->elf_bytes, right->elf_bytes, 0u,
                              framing_bytes, &bytes))
        return PL_ERROR_MINIMUM;
    *out = (pl_x86_minimum_bound){
        left->span > right->span ? left->span : right->span,
        work, bytes
    };
    return 0;
}

int pl_x86_grammar_choice(const pl_x86_minimum_bound *control,
                          const pl_x86_minimum_bound *left,
                          const pl_x86_minimum_bound *right,
                          pl_u64 framing_bytes,
                          pl_x86_minimum_bound *out)
{
    pl_u64 arm_span = 0u, arm_work = 0u;
    pl_u64 span = 0u, work = 0u, bytes = 0u;
    if (!control || !left || !right || !out) return PL_ERROR_MINIMUM;
    arm_span = left->span > right->span ? left->span : right->span;
    arm_work = left->work > right->work ? left->work : right->work;
    if (!pl_checked_add_u64(control->span, arm_span, &span)
            || !pl_checked_add_u64(control->work, arm_work, &work)
            || !grammar_bytes(control->elf_bytes, left->elf_bytes,
                              right->elf_bytes, framing_bytes, &bytes))
        return PL_ERROR_MINIMUM;
    *out = (pl_x86_minimum_bound){ span, work, bytes };
    return 0;
}

int pl_x86_minimum_compare(const pl_x86_minimum_key *left,
                           const pl_x86_minimum_key *right,
                           int *order)
{
    if (!order || !canonical_program(left) || !canonical_program(right))
        return PL_ERROR_MINIMUM;
    int left_physical = left->span <= right->span
                     && left->work <= right->work;
    int right_physical = right->span <= left->span
                      && right->work <= left->work;
    if (left->span != right->span || left->work != right->work) {
        *order = left_physical ? PL_X86_MINIMUM_LEFT
               : right_physical ? PL_X86_MINIMUM_RIGHT
               : PL_X86_MINIMUM_INCOMPARABLE;
        return 0;
    }
    if (left->elf_bytes != right->elf_bytes) {
        *order = left->elf_bytes < right->elf_bytes ? -1 : 1;
        return 0;
    }
    /* rank(z)=2^|z|+value(z): length precedes lexicographic payload bits. */
    if (left->program_bits != right->program_bits) {
        *order = left->program_bits < right->program_bits ? -1 : 1;
        return 0;
    }
    for (pl_u64 bit = 0u; bit < left->program_bits; ++bit) {
        pl_u8 l = program_bit(left->program, bit);
        pl_u8 r = program_bit(right->program, bit);
        if (l == r) continue;
        *order = l < r ? -1 : 1;
        return 0;
    }
    *order = 0;
    return 0;
}

int pl_x86_minimum_bound_can_beat(const pl_x86_minimum_bound *lower,
                                  const pl_x86_minimum_key *incumbent,
                                  int rank_may_precede,
                                  int *can_beat)
{
    if (!lower || !can_beat || !canonical_program(incumbent)
            || (rank_may_precede != 0 && rank_may_precede != 1))
        return PL_ERROR_MINIMUM;
    if (lower->span > incumbent->span
            || lower->work > incumbent->work) {
        *can_beat = 0;
        return 0;
    }
    if (lower->span < incumbent->span
            || lower->work < incumbent->work) {
        *can_beat = 1;
        return 0;
    }
    if (lower->elf_bytes != incumbent->elf_bytes) {
        *can_beat = lower->elf_bytes < incumbent->elf_bytes;
        return 0;
    }
    *can_beat = rank_may_precede;
    return 0;
}

int pl_global_integer_code_bits(pl_u64 value, pl_u64 *bits)
{
    if (!bits) return PL_ERROR_MINIMUM;
    if (!value) {
        *bits = 1u;
        return 0;
    }
    pl_u64 logarithm = 0u;
    for (pl_u64 remaining = value; remaining > 1u; remaining >>= 1u)
        ++logarithm;
    *bits = logarithm * 2u + 2u;
    return 0;
}

int pl_global_bounded_rank_bits(pl_u64 population, pl_u64 *bits)
{
    if (!population || !bits) return PL_ERROR_MINIMUM;
    pl_u64 maximum = population - 1u;
    pl_u64 width = 0u;
    while (maximum) {
        ++width;
        maximum >>= 1u;
    }
    *bits = width;
    return 0;
}

int pl_x86_fixed_family_bound(const pl_x86_fixed_family *family,
                              pl_x86_minimum_bound *bound)
{
    if (!family || !bound || !family->family_count
            || !family->span || !family->work)
        return PL_ERROR_MINIMUM;
    pl_u64 parameter_bits = 0u;
    int status = pl_global_bounded_rank_bits(
        family->family_count, &parameter_bits);
    if (status) return status;
    pl_u64 parameter_bytes = (parameter_bits + 7u) >> 3u;
    pl_u64 total = 0u;
    if (!pl_checked_add_u64(
            family->fixed_elf_bytes, parameter_bytes, &total)
            || !pl_checked_add_u64(
                total, family->framing_bytes, &total))
        return PL_ERROR_MINIMUM;
    bound->span = family->span;
    bound->work = family->work;
    bound->elf_bytes = total;
    return 0;
}
