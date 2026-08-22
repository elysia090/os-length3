/* A decoded state step, and the substitution that joins two of them.
 *
 * A template plus its parameter row is a plan: nodes with operand arguments, a
 * stack, and a locals frame.  Composition is substitution rather than
 * concatenation -- the second plan's local and stack operands are replaced by
 * whatever the first plan publishes at that coordinate, and no intermediate
 * frame is materialized.  This mirrors compose_plans_raw in
 * qm/stepnormalize.py, and check/compose_parity.py holds the two to one answer.
 *
 * Normalization is a separate stage.  A raw composition is a correct graph but
 * not a canonical one, so it cannot be written into an artifact until
 * normalize_plan's counterpart exists.
 *
 * Freestanding: no libc, no allocation.  The caller supplies an arena.
 */

#ifndef POSTLINK_PLAN_H
#define POSTLINK_PLAN_H

#include <postlink/opcodes.h>
#include <postlink/template.h>

typedef struct {
    pl_u8 kind;      /* PL_OPERAND_* */
    pl_u64 value;
} pl_operand;

typedef struct {
    pl_u32 opcode;
    pl_u32 argument_at;     /* into the plan's argument run */
    pl_u32 argument_count;
} pl_node;

typedef struct {
    pl_u32 function, start, end, instructions, stack_inputs, span;
    pl_node *nodes;
    pl_u32 node_count;
    pl_operand *arguments;
    pl_u32 argument_count;
    pl_operand *stack;
    pl_u32 stack_count;
    pl_operand *locals;      /* indexed by frame slot, local_extent wide */
    pl_u32 local_count;
    /* Dependency waves, as the template stores them: span + 1 offsets into a
     * run of node values ordered by depth.  Only a compacted plan carries
     * them; decoding leaves them null because the template already holds the
     * originals and composition does not recompute them. */
    pl_u32 *wave_offsets;
    pl_u32 *wave_values;
} pl_plan;

/* A bump allocator, so the library allocates nothing itself. */
typedef struct {
    pl_u8 *base;
    pl_u32 size;
    pl_u32 used;
} pl_arena;

void *pl_arena_take(pl_arena *arena, pl_u32 bytes);

#define PL_ERROR_PLAN  (-17)
#define PL_ERROR_ARENA (-18)

/* Decode one plan.  Unchanged local slots hold the identity operand for their
 * own slot, which is what makes substitution through them a no-op. */
int pl_plan_decode(const pl_u8 *tmpl, const pl_template *parsed,
                   const pl_u8 *row, pl_arena *arena, pl_plan *out);

/* Arena bytes pl_compose_raw can need for a given pair. */
pl_u32 pl_compose_arena_bytes(const pl_plan *first, const pl_plan *second);

/* Substitute `second` through `first`.  Refuses a pair that crosses a function
 * boundary, whose second plan reads a stack slot the first never published, or
 * that would place more than one source instruction on either side of a
 * trapping node.  The last refusal preserves the architectural exception cut
 * that the older artifact composer erased around DIV/REM. */
int pl_compose_raw(const pl_plan *first, const pl_plan *second,
                   pl_arena *arena, pl_plan *out);

/* One compaction pass: drop what nothing observes, renumber densely, share
 * repeated pure nodes, and rebuild the waves.  This is _compact_once in
 * qm/stepnormalize.py minus its algebraic rewriter, which is a separate ~900
 * lines and fires on about a quarter of composed pairs.
 *
 * Liveness is seeded by the nodes whose effects are observable whatever reads
 * them -- memory nodes and the trapping divides -- together with everything the
 * stack and locals name, then closed backward through arguments. */
int pl_compact_once(const pl_plan *in, pl_arena *arena, pl_plan *out);

/* Read a full flag overwrite's preserved bits from the root of the chain
 * rather than from its immediate predecessor.  The dominant pre-pass of
 * _rewrite_physical: it changes 63 of the 78 composed pairs the rewriter
 * touches at all. */
int pl_rebase_overwritten_flags(const pl_plan *in, pl_arena *arena,
                                pl_plan *out);

/* Substitute local lane identities in dependency order.  This is the common
 * forward part of the physical rewriter: constants are evaluated, affine
 * add/mask chains are closed, and address constants move into the memory
 * access offset.  It never introduces a scalar instruction representation. */
int pl_fold_local_physical(const pl_plan *in, pl_arena *arena, pl_plan *out);

/* Let a later store in a pre_store chain take the earlier one as its base and
 * carry only the difference, restoring pointer flow across a composition. */
int pl_reopen_pre_store_chains(const pl_plan *in, pl_arena *arena,
                               pl_plan *out);

/* Expose a cached read region as the run of loads it stands for, plus the
 * pointer past its end.  The main sweep closes it again if it still holds. */
int pl_reopen_load_regions(const pl_plan *in, pl_arena *arena, pl_plan *out);

/* Restore the ordinary SSA spelling of an ALU whose value result something
 * else consumes: the arithmetic as its own node, the flags as their own.  The
 * one rule needing a fact about the future, so it scans backward first. */
int pl_reopen_consumed_x86_alu(const pl_plan *in, pl_arena *arena,
                               pl_plan *out);

/* Compact a rewrite-stable plan.  One sweep: the reference alternates rewriting
 * with compaction until nothing moves, but that alternation exists only because
 * it runs the rewriter at the head of every pass.  Measured over 299 composed
 * pairs, a plan at the rewriter fixed point never lets compaction enable more
 * rewriting, and never needs a second compaction sweep.
 *
 * A second sweep runs anyway and must change nothing, so a broken premise fails
 * loudly instead of emitting an under-compacted graph. */
int pl_compact(const pl_plan *in, pl_arena *arena, pl_plan *out);

#endif /* POSTLINK_PLAN_H */
