/* Is one iteration's effect affine in the induction variable?
 *
 * The recurrence closure collapses N dispatches into one transaction with the
 * iteration count as a physical local.  Doing that to a loop whose body is not
 * affine in its counter is not a slower answer, it is a wrong one: in a
 * page-freeing loop it would mark pages freed that never were.  So the
 * collapse needs an argument, not a pattern match, and this is that argument.
 *
 * Full architectural state need not be materialized at every internal
 * backedge.  The residual cut is the least fixed point containing memory and
 * trap effects, the terminal predicate, and the next-iteration outputs of
 * every input those observations need.  Locals outside that cut are computed
 * once by the final ordinary iteration.  This is strictly smaller than asking
 * every architectural local to have a closed recurrence, without weakening
 * the observable result.
 *
 * A cut qualifies for this first affine class when each carried slot is
 * unchanged or `slot + k` for a constant k, and every address touched is
 * affine.  Anything else is reported as the reason it is not, so a refusal is
 * legible rather than a bare no.
 *
 * This is deliberately a checker and not an inference.  It answers whether a
 * given fused body may be collapsed; choosing which bodies to offer it is the
 * closure's business.
 *
 * Freestanding: no libc, no allocation.
 */

#ifndef POSTLINK_AFFINE_H
#define POSTLINK_AFFINE_H

#include <x86/ssa.h>

/* How one local slot evolves across one iteration. */
typedef enum {
    PL_AFFINE_FIXED = 0,   /* the slot is unchanged */
    PL_AFFINE_STEP,        /* slot := slot + step */
    PL_AFFINE_OPAQUE,      /* something else */
} pl_affine_kind;

typedef struct {
    pl_affine_kind kind;
    pl_i64 step;           /* meaningful when kind is PL_AFFINE_STEP */
} pl_affine_slot;

/* Why a body was refused, so the refusal can be acted on. */
typedef enum {
    PL_AFFINE_OK = 0,
    PL_AFFINE_NO_INDUCTION,      /* nothing advances, so there is no count */
    PL_AFFINE_MANY_INDUCTIONS,   /* more than one slot advances */
    PL_AFFINE_OPAQUE_SLOT,       /* a slot changes in some other way */
    PL_AFFINE_OPAQUE_ADDRESS,    /* an address is not affine in the counter */
    PL_AFFINE_UNSUPPORTED,       /* the body carries something unmodelled */
} pl_affine_verdict;

typedef struct {
    pl_affine_verdict verdict;
    pl_u32 induction;            /* the advancing slot, when there is one */
    pl_i64 step;                 /* its per-iteration increment */
    pl_u32 opaque_slot;          /* which slot refused, when one did */
    pl_affine_slot *slots;       /* one per local, from the arena */
    pl_u32 slot_count;
    pl_u32 memory_nodes;         /* how many the body performs */
    pl_u32 affine_addresses;     /* how many of those are affine */
    pl_u8 *cut_slots;            /* inputs carried across internal backedges */
    pl_u8 *cut_nodes;            /* hot backward slice, one byte per node */
    pl_u32 cut_slot_count;
    pl_u32 cut_node_count;
} pl_affine;

/* Analyse one composed loop body. */
int pl_affine_analyse(const pl_plan *body, pl_arena *arena, pl_affine *out);

/* Analyse only the residual needed between iterations.  `predicate_local` is
 * the post-body local consumed by the terminal branch (RFLAGS for x86). */
int pl_affine_analyse_cut(const pl_plan *body, pl_u32 predicate_local,
                          pl_arena *arena, pl_affine *out);

const char *pl_affine_reason(pl_affine_verdict verdict);

#endif /* POSTLINK_AFFINE_H */
