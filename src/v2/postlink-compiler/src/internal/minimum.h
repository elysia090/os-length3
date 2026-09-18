/* Global physical order for one complete ordinary x86 ELF candidate. */

#ifndef POSTLINK_MINIMUM_H
#define POSTLINK_MINIMUM_H

#include <support/types.h>

#define PL_ERROR_MINIMUM (-52)

enum pl_x86_minimum_order {
    PL_X86_MINIMUM_LEFT = -1,
    PL_X86_MINIMUM_EQUAL = 0,
    PL_X86_MINIMUM_RIGHT = 1,
    PL_X86_MINIMUM_INCOMPARABLE = 2,
};

typedef struct {
    pl_u64 span;
    pl_u64 work;
    /* Exact bytes of the complete ordinary ET_EXEC/ET_DYN result. */
    pl_u64 elf_bytes;
    /* Payload of the one global construction code. Padding bits, if any, are
     * not part of the rank and must be zero when canonicality is checked. */
    const pl_u8 *program;
    pl_u64 program_bits;
} pl_x86_minimum_key;

typedef struct {
    /* Uniform proved maxima over every r, complete-future cut and admitted
     * event in this family, not measurements from an observed trace. */
    pl_u64 span;
    pl_u64 work;
    pl_u64 fixed_elf_bytes;
    pl_u64 family_count;
    pl_u64 framing_bytes;
} pl_x86_fixed_family;

typedef struct {
    pl_u64 span;
    pl_u64 work;
    pl_u64 elf_bytes;
} pl_x86_minimum_bound;

/* Constructive physical upper bound carried by the x86 output grammar.
 * `elf_bytes` counts the ordinary ELF bytes contributed by the construction,
 * including the explicit framing argument supplied to the combinator.  These
 * functions do not estimate a trace: they compose bounds over every admitted
 * event in the represented complete future. */
int pl_x86_grammar_serial(const pl_x86_minimum_bound *first,
                          const pl_x86_minimum_bound *second,
                          pl_u64 framing_bytes,
                          pl_x86_minimum_bound *out);
int pl_x86_grammar_parallel(const pl_x86_minimum_bound *left,
                            const pl_x86_minimum_bound *right,
                            pl_u64 framing_bytes,
                            pl_x86_minimum_bound *out);
int pl_x86_grammar_choice(const pl_x86_minimum_bound *control,
                          const pl_x86_minimum_bound *left,
                          const pl_x86_minimum_bound *right,
                          pl_u64 framing_bytes,
                          pl_x86_minimum_bound *out);

/* Work/span precede representation and use componentwise physical dominance.
 * A tradeoff is INCOMPARABLE, never silently resolved by field order.  Once
 * both physical coordinates are equal, compare ELF bytes and global program
 * rank. Program rank is 2^program_bits + value(program), but is compared
 * without materializing that integer. */
int pl_x86_minimum_compare(const pl_x86_minimum_key *left,
                           const pl_x86_minimum_key *right,
                           int *order);

/* Decide whether one sound frontier-cell lower bound can still beat the exact
 * incumbent. When the first three coordinates tie, `rank_may_precede` is the
 * independently checked statement that the cell contains a smaller global
 * construction rank. */
int pl_x86_minimum_bound_can_beat(const pl_x86_minimum_bound *lower,
                                  const pl_x86_minimum_key *incumbent,
                                  int rank_may_precede,
                                  int *can_beat);

/* Exact bit length of Pinf's complete scalar code E(n). */
int pl_global_integer_code_bits(pl_u64 value, pl_u64 *bits);

/* Exact minimax bits needed for one rank in [0,population).  A canonical
 * truncated-binary code is Kraft-complete and has maximum length
 * ceil(log2(population)); population one needs no parameter bit. */
int pl_global_bounded_rank_bits(pl_u64 population, pl_u64 *bits);

/* A fixed ordinary-x86 evaluator family contains only fixed ELF/native bytes
 * and the globally coded bounded parameter r.  This returns a constructive
 * worst-case file-size bound for 0 <= r < family_count.  `framing_bytes` is an
 * explicit already-derived maximum for standard-ELF alignment/framing; it is
 * never hidden in the logarithmic term. */
int pl_x86_fixed_family_bound(const pl_x86_fixed_family *family,
                              pl_x86_minimum_bound *bound);

#endif /* POSTLINK_MINIMUM_H */
