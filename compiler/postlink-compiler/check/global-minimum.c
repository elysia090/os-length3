#include <stdio.h>

#include "../src/internal/minimum.h"

static int expect_order(const pl_x86_minimum_key *left,
                        const pl_x86_minimum_key *right, int expected)
{
    int order = 7;
    int status = pl_x86_minimum_compare(left, right, &order);
    return status || order != expected ? PL_ERROR_MINIMUM : 0;
}

int main(void)
{
    static const pl_u8 early[] = { 0x20u };
    static const pl_u8 late[] = { 0x40u };
    static const pl_u8 shorter[] = { 0x00u };
    static const pl_u8 padded[] = { 0x21u };
    pl_x86_minimum_key incumbent = { 6u, 8u, 100u, early, 3u };
    pl_x86_minimum_key candidate = incumbent;
    int status = 0;

    candidate.span = 5u;
    candidate.work = 999u;
    candidate.elf_bytes = 999u;
    candidate.program = late;
    if (!status)
        status = expect_order(
            &candidate, &incumbent, PL_X86_MINIMUM_INCOMPARABLE);

    candidate = incumbent;
    candidate.work = 7u;
    candidate.elf_bytes = 999u;
    if (!status) status = expect_order(&candidate, &incumbent, -1);

    candidate = incumbent;
    candidate.elf_bytes = 99u;
    candidate.program = late;
    if (!status) status = expect_order(&candidate, &incumbent, -1);

    candidate = incumbent;
    candidate.program = late;
    if (!status) status = expect_order(&candidate, &incumbent, 1);

    candidate = incumbent;
    candidate.program = shorter;
    candidate.program_bits = 2u;
    if (!status) status = expect_order(&candidate, &incumbent, -1);

    candidate = incumbent;
    candidate.program = padded;
    if (!status && !pl_x86_minimum_compare(
            &candidate, &incumbent, &(int){ 0 }))
        status = PL_ERROR_MINIMUM;

    pl_x86_fixed_family family = { 3u, 5u, 100u, 256u, 7u };
    pl_x86_minimum_bound bound = { 0 };
    if (!status)
        status = pl_x86_fixed_family_bound(&family, &bound);
    /* 256 distinguishable futures need and use exactly eight rank bits. */
    if (!status && (bound.span != 3u || bound.work != 5u
            || bound.elf_bytes != 108u))
        status = PL_ERROR_MINIMUM;
    pl_u64 rank_bits = 0u;
    if (!status) status = pl_global_bounded_rank_bits(257u, &rank_bits);
    if (!status && rank_bits != 9u) status = PL_ERROR_MINIMUM;
    if (!status) status = pl_global_bounded_rank_bits(1u, &rank_bits);
    if (!status && rank_bits != 0u) status = PL_ERROR_MINIMUM;
    family.fixed_elf_bytes = 0xffffffffffffffffull;
    family.family_count = 2u;
    family.framing_bytes = 0u;
    if (!status && !pl_x86_fixed_family_bound(&family, &bound))
        status = PL_ERROR_MINIMUM;

    /* The locally shorter spelling loses after whole-ELF veneers/layout are
     * charged; no sum of local block lengths may decide this comparison. */
    pl_x86_minimum_key locally_short = { 4u, 6u, 40u, early, 3u };
    pl_x86_minimum_key globally_short = { 4u, 6u, 20u, late, 3u };
    if (!status)
        status = expect_order(&globally_short, &locally_short, -1);

    pl_x86_minimum_bound lower = { 6u, 8u, 100u };
    int can_beat = 0;
    if (!status)
        status = pl_x86_minimum_bound_can_beat(
            &lower, &incumbent, 0, &can_beat);
    if (!status && can_beat) status = PL_ERROR_MINIMUM;
    if (!status)
        status = pl_x86_minimum_bound_can_beat(
            &lower, &incumbent, 1, &can_beat);
    if (!status && !can_beat) status = PL_ERROR_MINIMUM;
    lower.span = 5u;
    lower.work = 0xffffffffffffffffull;
    lower.elf_bytes = 0xffffffffffffffffull;
    if (!status)
        status = pl_x86_minimum_bound_can_beat(
            &lower, &incumbent, 0, &can_beat);
    if (!status && can_beat) status = PL_ERROR_MINIMUM;
    lower.work = 7u;
    if (!status)
        status = pl_x86_minimum_bound_can_beat(
            &lower, &incumbent, 0, &can_beat);
    if (!status && !can_beat) status = PL_ERROR_MINIMUM;

    /* Grammar costs are physical upper bounds over complete futures.  Serial
     * composition adds critical paths; a parallel wave adds work but takes
     * the longer path; a choice stores both arms but executes only the worse
     * arm after its control. */
    pl_x86_minimum_bound left = { 2u, 3u, 5u };
    pl_x86_minimum_bound right = { 4u, 7u, 11u };
    pl_x86_minimum_bound control = { 1u, 2u, 3u };
    pl_x86_minimum_bound composed = { 0u, 0u, 0u };
    if (!status)
        status = pl_x86_grammar_serial(&left, &right, 1u, &composed);
    if (!status && (composed.span != 6u || composed.work != 10u
            || composed.elf_bytes != 17u))
        status = PL_ERROR_MINIMUM;
    if (!status)
        status = pl_x86_grammar_parallel(&left, &right, 1u, &composed);
    if (!status && (composed.span != 4u || composed.work != 10u
            || composed.elf_bytes != 17u))
        status = PL_ERROR_MINIMUM;
    if (!status)
        status = pl_x86_grammar_choice(
            &control, &left, &right, 1u, &composed);
    if (!status && (composed.span != 5u || composed.work != 9u
            || composed.elf_bytes != 20u))
        status = PL_ERROR_MINIMUM;
    left.span = 0xffffffffffffffffull;
    if (!status && !pl_x86_grammar_serial(
            &left, &right, 0u, &composed))
        status = PL_ERROR_MINIMUM;

    if (status) {
        fprintf(stderr, "global x86 minimum: RED (status=%d)\n", status);
        return 1;
    }
    printf("global x86 minimum: green "
           "(grammar span/work upper bounds + whole-ELF Kraft order)\n");
    return 0;
}
