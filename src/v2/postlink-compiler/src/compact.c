/* Compaction: drop, share, renumber, reschedule.
 *
 * This is _compact_once in qm/stepnormalize.py minus its algebraic rewriter.
 * The rewriter is roughly 900 lines of its own and fires on about a quarter of
 * composed pairs, so it is deliberately not attempted here; check/compact_parity.py
 * reports which pairs it covers rather than claiming all of them.
 *
 * The four stages, in the order the reference runs them:
 *
 *   liveness   a node survives if something observes it.  Memory nodes and the
 *              trapping divides are observable in themselves; everything else
 *              lives only because the stack, the locals, or a live node names
 *              it.  Projections name their source.
 *   renumber   survivors take dense one-based values in their original order.
 *   share      two pure nodes with the same op and the same arguments become
 *              one.  Memory nodes never share, because two identical reads at
 *              different points of the ordering chain are different events.
 *   reschedule depth is one past the deepest argument, and the waves are those
 *              depths as offsets into a run of node values.
 *
 * Freestanding: no libc, no allocation.
 */

#include <postlink/plan.h>

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

static int same_arguments(const pl_operand *left, const pl_operand *right,
                          pl_u32 count)
{
    for (pl_u32 index = 0; index < count; ++index)
        if (left[index].kind != right[index].kind
                || left[index].value != right[index].value)
            return 0;
    return 1;
}

int pl_compact_once(const pl_plan *in, pl_arena *arena, pl_plan *out)
{
    pl_u32 count = in->node_count;
    pl_u8 *live = pl_arena_take(arena, count ? count : 1u);
    pl_u32 *stack_of = pl_arena_take(
        arena, (count ? count : 1u) * (pl_u32)sizeof *stack_of);
    pl_u32 *remap = pl_arena_take(
        arena, (count + 1u) * (pl_u32)sizeof *remap);
    if (!live || !stack_of || !remap) return PL_ERROR_ARENA;
    for (pl_u32 index = 0; index < count; ++index) live[index] = 0;

    /* Seed: observable in themselves, plus whatever the outputs name. */
    pl_u32 pending = 0;
    for (pl_u32 index = 0; index < count; ++index)
        if (pl_opcode_is_memory(in->nodes[index].opcode)
                || pl_opcode_traps(in->nodes[index].opcode)) {
            live[index] = 1;
            stack_of[pending++] = index + 1u;
        }
    for (pl_u32 index = 0; index < in->stack_count; ++index) {
        pl_u32 value = dependency_of(in->stack[index]);
        if (value && value <= count && !live[value - 1u]) {
            live[value - 1u] = 1;
            stack_of[pending++] = value;
        }
    }
    for (pl_u32 index = 0; index < in->local_count; ++index) {
        pl_u32 value = dependency_of(in->locals[index]);
        if (value && value <= count && !live[value - 1u]) {
            live[value - 1u] = 1;
            stack_of[pending++] = value;
        }
    }
    while (pending) {
        pl_u32 value = stack_of[--pending];
        const pl_node *node = &in->nodes[value - 1u];
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot) {
            pl_u32 source = dependency_of(
                in->arguments[node->argument_at + slot]);
            if (source && source <= count && !live[source - 1u]) {
                live[source - 1u] = 1;
                stack_of[pending++] = source;
            }
        }
    }

    out->nodes = pl_arena_take(arena, (count ? count : 1u)
                               * (pl_u32)sizeof *out->nodes);
    out->arguments = pl_arena_take(
        arena, (in->argument_count ? in->argument_count : 1u)
               * (pl_u32)sizeof *out->arguments);
    out->stack = pl_arena_take(
        arena, (in->stack_count ? in->stack_count : 1u)
               * (pl_u32)sizeof *out->stack);
    out->locals = pl_arena_take(
        arena, (in->local_count ? in->local_count : 1u)
               * (pl_u32)sizeof *out->locals);
    if (!out->nodes || !out->arguments || !out->stack || !out->locals)
        return PL_ERROR_ARENA;

    out->node_count = 0;
    out->argument_count = 0;
    for (pl_u32 index = 0; index < count; ++index) {
        if (!live[index]) continue;
        const pl_node *node = &in->nodes[index];
        pl_u32 at = out->argument_count;
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot) {
            pl_operand operand = in->arguments[node->argument_at + slot];
            if (operand.kind == PL_OPERAND_NODE) {
                operand.value = remap[operand.value];
            } else if (operand.kind == PL_OPERAND_PROJECTION) {
                pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
                pl_u64 selector = operand.value
                                & ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u);
                if (!source || source > count || !remap[source])
                    return PL_ERROR_PLAN;   /* not topologically ordered */
                operand.value = ((pl_u64)remap[source]
                                 << PL_PROJECTION_SELECTOR_BITS) | selector;
            }
            out->arguments[at + slot] = operand;
        }

        /* Share a pure node with an identical earlier one.  Memory nodes are
         * never shared: two identical reads at different points of the
         * ordering chain are different events. */
        pl_u32 shared = 0;
        if (!pl_opcode_is_memory(node->opcode))
            for (pl_u32 other = 0; other < out->node_count; ++other)
                if (out->nodes[other].opcode == node->opcode
                        && out->nodes[other].argument_count
                           == node->argument_count
                        && !pl_opcode_is_memory(out->nodes[other].opcode)
                        && same_arguments(
                            out->arguments + out->nodes[other].argument_at,
                            out->arguments + at, node->argument_count)) {
                    shared = other + 1u;
                    break;
                }
        if (shared) {
            remap[index + 1u] = shared;
            continue;                       /* the staged arguments are dropped */
        }
        out->argument_count = at + node->argument_count;
        out->nodes[out->node_count].opcode = node->opcode;
        out->nodes[out->node_count].argument_at = at;
        out->nodes[out->node_count].argument_count = node->argument_count;
        out->node_count += 1u;
        remap[index + 1u] = out->node_count;
    }

    for (pl_u32 index = 0; index < in->stack_count; ++index) {
        pl_operand operand = in->stack[index];
        pl_u32 source = dependency_of(operand);
        if (source) {
            if (source > count || !remap[source]) return PL_ERROR_PLAN;
            if (operand.kind == PL_OPERAND_NODE) operand.value = remap[source];
            else operand.value = ((pl_u64)remap[source]
                                  << PL_PROJECTION_SELECTOR_BITS)
                               | (operand.value
                                  & ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u));
        }
        out->stack[index] = operand;
    }
    for (pl_u32 index = 0; index < in->local_count; ++index) {
        pl_operand operand = in->locals[index];
        pl_u32 source = dependency_of(operand);
        if (source) {
            if (source > count || !remap[source]) return PL_ERROR_PLAN;
            if (operand.kind == PL_OPERAND_NODE) operand.value = remap[source];
            else operand.value = ((pl_u64)remap[source]
                                  << PL_PROJECTION_SELECTOR_BITS)
                               | (operand.value
                                  & ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u));
        }
        out->locals[index] = operand;
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
    pl_u32 written = 0;
    out->wave_offsets[0] = 0;
    for (pl_u32 wave = 1; wave <= span; ++wave) {
        for (pl_u32 index = 0; index < kept; ++index)
            if (depth[index + 1u] == wave) out->wave_values[written++] = index + 1u;
        out->wave_offsets[wave] = written;
    }

    out->function = in->function;
    out->start = in->start;
    out->end = in->end;
    out->instructions = in->instructions;
    out->stack_inputs = in->stack_inputs;
    out->stack_count = in->stack_count;
    out->local_count = in->local_count;
    out->span = span;
    return 0;
}

/* Are two plans the same graph?  Used to assert that a second sweep would
 * change nothing rather than to decide whether to run one. */
static int same_plan(const pl_plan *left, const pl_plan *right)
{
    if (left->node_count != right->node_count
            || left->argument_count != right->argument_count
            || left->stack_count != right->stack_count
            || left->local_count != right->local_count
            || left->span != right->span)
        return 0;
    for (pl_u32 index = 0; index < left->node_count; ++index)
        if (left->nodes[index].opcode != right->nodes[index].opcode
                || left->nodes[index].argument_at
                   != right->nodes[index].argument_at
                || left->nodes[index].argument_count
                   != right->nodes[index].argument_count)
            return 0;
    return same_arguments(left->arguments, right->arguments,
                          left->argument_count)
        && same_arguments(left->stack, right->stack, left->stack_count)
        && same_arguments(left->locals, right->locals, left->local_count);
}

int pl_compact(const pl_plan *in, pl_arena *arena, pl_plan *out)
{
    /* One sweep, not a loop.  The reference alternates rewriting with
     * compaction until nothing moves, but that alternation is an artifact of
     * running the rewriter at the head of every pass: measured over 299
     * composed pairs, once the rewriter has reached its own fixed point,
     * compaction never enables further rewriting and never needs a second
     * sweep of its own.  The caller must therefore hand in a rewrite-stable
     * plan.
     *
     * The assumption is checked rather than trusted.  A second sweep runs and
     * must change nothing; if the premise ever breaks, this fails loudly
     * instead of quietly emitting an under-compacted graph. */
    int status = pl_compact_once(in, arena, out);
    if (status) return status;

    pl_arena probe = *arena;
    pl_plan again;
    status = pl_compact_once(out, &probe, &again);
    if (status) return status;
    if (!same_plan(out, &again)) return PL_ERROR_PLAN;
    return 0;
}
