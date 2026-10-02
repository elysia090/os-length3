/* The one traversal every stage is an instance of.
 *
 * Reading qm/stepnormalize.py through, composition, compaction and each of the
 * rewriter's pre-passes turn out to be the same walk with different rules.
 * There are two shapes and the first is the second with an identity remap:
 *
 *   A  rewrite a node's arguments in place; values are preserved
 *      _rebase_overwritten_flags, _reopen_pre_store_chains
 *
 *   B  resolve each argument through a remap, re-emit the node, and record what
 *      the old value now stands for
 *      _reopen_load_regions, _reopen_consumed_x86_alu, the main sweep,
 *      and compose and compact here
 *
 * Writing the walk once removes both the duplication and the ordering hazard
 * the reference has: it runs six separate instances, so a fact computed in one
 * is stale by the next, which is exactly why reopen_consumed_x86_alu misses the
 * projections rebase_overwritten_flags creates.  A single walk gives every node
 * the fully rewritten prefix.
 *
 * One rule needs a fact about the future -- whether a later node consumes a
 * selector-16 projection -- so the shape is one backward scan for those, then
 * one forward sweep.
 *
 * Freestanding: no libc, no allocation.
 */

#ifndef POSTLINK_SWEEP_H
#define POSTLINK_SWEEP_H

#include "plan.h"

/* What an old node value now stands for.  A rule may map a node to another
 * node, to a projection of one, or to an operand that is not a node at all. */
typedef struct {
    pl_operand *of;      /* indexed by the old one-based value */
    pl_u32 count;
} pl_remap;

int pl_remap_open(pl_remap *remap, pl_u32 values, pl_arena *arena);

/* Substitute an operand through the remap.  A projection follows its source and
 * keeps its selector, unless the source resolved to something that is not a
 * node, in which case the rule that produced it owns the meaning and the
 * operand is returned untouched.  Defined here so the dense compaction and
 * rewrite loops inline it instead of paying a cross-TU call per operand. */
#define PL_PROJECTION_SELECTOR_BITS 8u
#define PL_PROJECTION_SELECTOR_MASK ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u)

static inline pl_operand pl_resolve(const pl_remap *remap, pl_operand operand)
{
    if (operand.kind == PL_OPERAND_NODE) {
        if (!operand.value || operand.value > remap->count) return operand;
        return remap->of[operand.value];
    }
    if (operand.kind != PL_OPERAND_PROJECTION) return operand;
    pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
    pl_u64 selector = operand.value & PL_PROJECTION_SELECTOR_MASK;
    if (!source || source > remap->count) return operand;
    pl_operand mapped = remap->of[source];
    /* A projection of something that is no longer a node is the producing
     * rule's business, not this one's. */
    if (mapped.kind != PL_OPERAND_NODE) return operand;
    pl_operand result;
    result.kind = PL_OPERAND_PROJECTION;
    result.value = (mapped.value << PL_PROJECTION_SELECTOR_BITS) | selector;
    return result;
}

/* Accumulates the plan a sweep is building. */
typedef struct {
    pl_plan *plan;
    pl_arena *arena;
    pl_u32 node_capacity;
    pl_u32 argument_capacity;
    /* Transient pure-node quotient index.  Zero means not allocated; a tight
     * caller arena can still use the exact linear comparison path. */
    pl_u32 *shared_slots;
    pl_u32 shared_capacity;
    pl_u8 shared_disabled;
} pl_builder;

int pl_builder_open(pl_builder *builder, pl_plan *plan, pl_arena *arena,
                    pl_u32 nodes, pl_u32 arguments, pl_u32 stack,
                    pl_u32 locals);

/* Append one node whose arguments are already resolved.  Returns its new
 * one-based value, or 0 when the builder is full. */
pl_u32 pl_emit(pl_builder *builder, pl_u32 opcode,
               const pl_operand *arguments, pl_u32 count);

/* Append a node only if an identical pure one is not already present, which is
 * the sharing rule: memory nodes are never shared, because two identical reads
 * at different points of the ordering chain are different events. */
pl_u32 pl_emit_shared(pl_builder *builder, pl_u32 opcode,
                      const pl_operand *arguments, pl_u32 count);

/* The widest argument list a node may carry.  Arguments are staged before being
 * emitted so a rule that materializes helper nodes does not split them. */
#define PL_STAGED_ARGUMENTS 64u

#endif /* POSTLINK_SWEEP_H */
