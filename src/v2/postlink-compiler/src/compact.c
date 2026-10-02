/* Compaction: drop, share, renumber, reschedule.
 *
 * _compact_once in qm/stepnormalize.py, expressed on the shared traversal in
 * sweep.h.  The four stages, in the order the reference runs them:
 *
 *   liveness   a node survives if something observes it.  Memory nodes and the
 *              trapping divides are observable in themselves; everything else
 *              lives only because the stack, the locals, or a live node names
 *              it.  A projection names its source.
 *   renumber   survivors take dense one-based values in their original order,
 *              which the traversal's remap does on its own.
 *   share      pl_emit_shared: two pure nodes with the same op and arguments
 *              become one.
 *   reschedule depth is one past the deepest argument, and the waves are those
 *              depths as offsets into a run of node values.
 *
 * The reference's algebraic rewriter is not here; it is src/rewrite.c, and the
 * caller is expected to have run it to its fixed point first.
 *
 * Freestanding: no libc, no allocation.
 */

#include "internal/sweep.h"

#define PL_PROJECTION_SELECTOR_BITS 8u

/* The node an operand depends on: itself for a node, its source for a
 * projection, nothing otherwise. */
static pl_u32 dependency_of(pl_operand operand)
{
    if (operand.kind == PL_OPERAND_NODE) return (pl_u32)operand.value;
    if (operand.kind == PL_OPERAND_PROJECTION)
        return (pl_u32)(operand.value >> PL_PROJECTION_SELECTOR_BITS);
    return 0;
}

static void mark(pl_u8 *live, pl_u32 *queue, pl_u32 *pending, pl_u32 count,
                 pl_u32 value)
{
    if (!value || value > count || live[value - 1u]) return;
    live[value - 1u] = 1;
    queue[(*pending)++] = value;
}

static int compact_once(const pl_plan *in, const pl_u8 *live_local,
                        pl_arena *arena, pl_plan *out)
{
    pl_u32 count = in->node_count;
    pl_u8 *live = pl_arena_take(arena, count ? count : 1u);
    pl_u32 *queue = pl_arena_take(
        arena, (count ? count : 1u) * (pl_u32)sizeof *queue);
    if (!live || !queue) return PL_ERROR_ARENA;
    for (pl_u32 index = 0; index < count; ++index) live[index] = 0;

    pl_u32 pending = 0;
    for (pl_u32 index = 0; index < count; ++index)
        if (pl_opcode_is_memory(in->nodes[index].opcode)
                || pl_opcode_traps(in->nodes[index].opcode))
            mark(live, queue, &pending, count, index + 1u);
    for (pl_u32 index = 0; index < in->stack_count; ++index)
        mark(live, queue, &pending, count, dependency_of(in->stack[index]));
    for (pl_u32 index = 0; index < in->local_count; ++index)
        if (!live_local || live_local[index])
            mark(live, queue, &pending, count,
                 dependency_of(in->locals[index]));
    while (pending) {
        const pl_node *node = &in->nodes[queue[--pending] - 1u];
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot)
            mark(live, queue, &pending, count,
                 dependency_of(in->arguments[node->argument_at + slot]));
    }

    pl_remap remap;
    pl_builder builder;
    if (pl_remap_open(&remap, count, arena)
            || pl_builder_open(&builder, out, arena, count,
                               in->argument_count, in->stack_count,
                               in->local_count))
        return PL_ERROR_ARENA;

    pl_operand staged[PL_STAGED_ARGUMENTS];
    for (pl_u32 index = 0; index < count; ++index) {
        if (!live[index]) continue;
        const pl_node *node = &in->nodes[index];
        if (node->argument_count > PL_STAGED_ARGUMENTS) return PL_ERROR_PLAN;
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot)
            staged[slot] = pl_resolve(
                &remap, in->arguments[node->argument_at + slot]);
        pl_u32 value = pl_emit_shared(&builder, node->opcode, staged,
                                      node->argument_count);
        if (!value) return PL_ERROR_ARENA;
        remap.of[index + 1u].kind = PL_OPERAND_NODE;
        remap.of[index + 1u].value = value;
    }

    for (pl_u32 index = 0; index < in->stack_count; ++index)
        out->stack[index] = pl_resolve(&remap, in->stack[index]);
    for (pl_u32 index = 0; index < in->local_count; ++index) {
        if (!live_local || live_local[index]) {
            out->locals[index] = pl_resolve(&remap, in->locals[index]);
        } else {
            /* A dead publication is not a retained value or a side table. It
             * is the identity coordinate required to keep the machine frame
             * total while complete-future liveness removes its producer. */
            out->locals[index].kind = PL_OPERAND_LOCAL;
            out->locals[index].value = index;
        }
    }

    /* Depth is one past the deepest argument; the waves are those depths as
     * offsets into a run of node values. */
    pl_u32 kept = out->node_count;
    pl_u32 *depth = pl_arena_take(arena, (kept + 1u) * (pl_u32)sizeof *depth);
    if (!depth) return PL_ERROR_ARENA;
    depth[0] = 0;
    pl_u32 span = 0;
    for (pl_u32 index = 0; index < kept; ++index) {
        const pl_node *node = &out->nodes[index];
        pl_u32 deepest = 0;
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot) {
            pl_u32 source = dependency_of(
                out->arguments[node->argument_at + slot]);
            if (source && depth[source] > deepest) deepest = depth[source];
        }
        depth[index + 1u] = deepest + 1u;
        if (deepest + 1u > span) span = deepest + 1u;
    }
    out->wave_offsets = pl_arena_take(
        arena, (span + 2u) * (pl_u32)sizeof *out->wave_offsets);
    out->wave_values = pl_arena_take(
        arena, (kept ? kept : 1u) * (pl_u32)sizeof *out->wave_values);
    if (!out->wave_offsets || !out->wave_values) return PL_ERROR_ARENA;
    /* Count, prefix, and scatter by depth.  Repeatedly scanning all nodes for
     * each wave costs O(kept * span), which is quadratic for a dependency
     * chain.  Increasing node order within a wave is preserved by the final
     * forward scatter.  The offsets serve as cursors, so no second table is
     * materialized. */
    for (pl_u32 wave = 0; wave <= span; ++wave)
        out->wave_offsets[wave] = 0;
    for (pl_u32 index = 0; index < kept; ++index)
        ++out->wave_offsets[depth[index + 1u]];
    for (pl_u32 wave = 1; wave <= span; ++wave)
        out->wave_offsets[wave] += out->wave_offsets[wave - 1u];
    for (pl_u32 wave = span; wave > 1u; --wave)
        out->wave_offsets[wave] = out->wave_offsets[wave - 1u];
    if (span) out->wave_offsets[1] = 0;
    for (pl_u32 index = 0; index < kept; ++index) {
        pl_u32 wave = depth[index + 1u];
        out->wave_values[out->wave_offsets[wave]++] = index + 1u;
    }

    out->function = in->function;
    out->start = in->start;
    out->end = in->end;
    out->instructions = in->instructions;
    out->stack_inputs = in->stack_inputs;
    out->span = span;
    return 0;
}

int pl_compact_once(const pl_plan *in, pl_arena *arena, pl_plan *out)
{
    return compact_once(in, 0, arena, out);
}

int pl_compact_projected_once(const pl_plan *in,
                              const pl_u8 *live_local,
                              pl_arena *arena, pl_plan *out)
{
    if (!in || !live_local) return PL_ERROR_PLAN;
    return compact_once(in, live_local, arena, out);
}

static int same_plan(const pl_plan *left, const pl_plan *right)
{
    if (left->node_count != right->node_count
            || left->argument_count != right->argument_count
            || left->span != right->span)
        return 0;
    for (pl_u32 index = 0; index < left->node_count; ++index)
        if (left->nodes[index].opcode != right->nodes[index].opcode
                || left->nodes[index].argument_at
                   != right->nodes[index].argument_at
                || left->nodes[index].argument_count
                   != right->nodes[index].argument_count)
            return 0;
    for (pl_u32 index = 0; index < left->argument_count; ++index)
        if (left->arguments[index].kind != right->arguments[index].kind
                || left->arguments[index].value
                   != right->arguments[index].value)
            return 0;
    return 1;
}

int pl_compact(const pl_plan *in, pl_arena *arena, pl_plan *out)
{
    /* One sweep, not a loop.  The reference alternates rewriting with
     * compaction until nothing moves, but that alternation is an artifact of
     * running the rewriter at the head of every pass: measured over 299
     * composed pairs, once the rewriter has reached its own fixed point,
     * compaction never enables further rewriting and never needs a second
     * sweep of its own.  The caller must hand in a rewrite-stable plan.
     *
     * The premise is checked rather than trusted.  A second sweep runs and must
     * change nothing; if it ever does, this fails instead of quietly emitting
     * an under-compacted graph. */
    int status = pl_compact_once(in, arena, out);
    if (status) return status;

    pl_arena probe = *arena;
    pl_plan again;
    status = pl_compact_once(out, &probe, &again);
    if (status) return status;
    if (!same_plan(out, &again)) return PL_ERROR_PLAN;
    return 0;
}

int pl_compact_projected(const pl_plan *in,
                         const pl_u8 *live_local,
                         pl_arena *arena, pl_plan *out)
{
    if (!in || !live_local || !arena || !out) return PL_ERROR_PLAN;
    int status = pl_compact_projected_once(in, live_local, arena, out);
    if (status) return status;

    pl_arena probe = *arena;
    pl_plan again;
    status = pl_compact_projected_once(out, live_local, &probe, &again);
    if (status) return status;
    if (!same_plan(out, &again)) return PL_ERROR_PLAN;
    return 0;
}
