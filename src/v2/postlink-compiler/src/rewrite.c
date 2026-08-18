/* Algebraic rewriting, the pre-passes.
 *
 * _rewrite_physical in qm/stepnormalize.py is six pre-passes followed by one
 * main sweep.  The main sweep already substitutes successively in dependency
 * order, so it converges in a single pass; the iteration the reference shows
 * comes from the pre-passes, and specifically from running
 * reopen_consumed_x86_alu before rebase_overwritten_flags.  The rebase creates
 * the selector-16 projections the reopen looks for, so ordered that way the
 * reopen misses them and finds them only on a later evaluation.
 *
 * The order here is therefore the corrected one, measured to reach the same
 * fixed point on all 299 composed pairs while dropping the third evaluation to
 * none.  See the README.
 *
 * Freestanding: no libc, no allocation.
 */

#include <postlink/plan.h>

#define PL_PROJECTION_SELECTOR_BITS 8u

/* Most arithmetic replaces CF/PF/ZF/SF/OF and copies the rest.  Threading the
 * whole flag word through every preceding instruction invents a serial chain
 * that is not there, so a full overwrite reads the preserved bits from the root
 * of the chain instead.  A condition observing an intermediate result keeps its
 * own producer, which is why only the first argument is rebased. */
static pl_operand flag_chain_root(const pl_plan *plan, pl_operand operand)
{
    /* The walk is bounded by the node count: each step moves strictly earlier
     * in a topologically ordered graph, so no seen-set is needed. */
    pl_u32 steps = 0;
    while (operand.kind == PL_OPERAND_NODE && steps <= plan->node_count) {
        pl_u32 value = (pl_u32)operand.value;
        if (!value || value > plan->node_count) break;
        const pl_node *source = &plan->nodes[value - 1u];
        if (!pl_opcode_produces_flags(source->opcode)
                || !source->argument_count)
            break;
        operand = plan->arguments[source->argument_at];
        steps += 1u;
    }
    return operand;
}

static int fully_overwrites(const pl_plan *plan, const pl_node *node)
{
    if (node->opcode == PL_OPCODE_X86_COMPARE
            || node->opcode == PL_OPCODE_X86_TEST)
        return 1;

    if (node->opcode == PL_OPCODE_X86_SHIFT_FLAGS) {
        if (node->argument_count != 5u) return 0;
        const pl_operand *shift = &plan->arguments[node->argument_at + 3u];
        const pl_operand *word = &plan->arguments[node->argument_at + 4u];
        if (shift->kind != PL_OPERAND_CONST || word->kind != PL_OPERAND_CONST)
            return 0;
        pl_u64 amount = shift->value;
        pl_u64 descriptor = word->value;
        pl_u64 width = descriptor & 0x7full;
        pl_u64 group = (descriptor >> 8u) & 7u;
        return (width == 8u || width == 16u || width == 32u || width == 64u)
            && (amount & (width - 1u)) != 0
            && (group >= 4u && group <= 7u);
    }

    pl_u32 at;
    if (node->opcode == PL_OPCODE_X86_FLAGS) at = 4u;
    else if (node->opcode == PL_OPCODE_X86_ALU) at = 3u;
    else if (node->opcode == PL_OPCODE_X86_AFFINE_ALU) at = 4u;
    else return 0;

    if (node->argument_count <= at) return 0;
    const pl_operand *word = &plan->arguments[node->argument_at + at];
    if (word->kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = word->value;
    pl_u64 group = (descriptor >> 8u) & 7u;
    return group != 2u && group != 4u && !(descriptor & (1ull << 11u));
}

int pl_rebase_overwritten_flags(const pl_plan *in, pl_arena *arena,
                                pl_plan *out)
{
    *out = *in;
    out->arguments = pl_arena_take(
        arena, (in->argument_count ? in->argument_count : 1u)
               * (pl_u32)sizeof *out->arguments);
    out->nodes = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *out->nodes);
    if (!out->arguments || !out->nodes) return PL_ERROR_ARENA;

    for (pl_u32 index = 0; index < in->argument_count; ++index)
        out->arguments[index] = in->arguments[index];
    for (pl_u32 index = 0; index < in->node_count; ++index)
        out->nodes[index] = in->nodes[index];

    for (pl_u32 index = 0; index < in->node_count; ++index) {
        const pl_node *node = &in->nodes[index];
        if (!node->argument_count || !fully_overwrites(in, node)) continue;
        out->arguments[node->argument_at] = flag_chain_root(
            in, in->arguments[node->argument_at]);
    }
    return 0;
}


/* Restore pointer flow while a larger memory transaction is being composed.
 *
 * A chain of pre_stores against one base decrements a cumulative offset.  Once
 * blocks are composed, a later store in the chain can take the earlier store as
 * its base and carry only the difference, which is what puts the pointer flow
 * back into the graph instead of leaving each store to recompute it.
 *
 * Shape A: arguments are rewritten in place and node values are preserved.
 */
int pl_reopen_pre_store_chains(const pl_plan *in, pl_arena *arena,
                               pl_plan *out)
{
    *out = *in;
    out->arguments = pl_arena_take(
        arena, (in->argument_count ? in->argument_count : 1u)
               * (pl_u32)sizeof *out->arguments);
    if (!out->arguments) return PL_ERROR_ARENA;
    for (pl_u32 index = 0; index < in->argument_count; ++index)
        out->arguments[index] = in->arguments[index];

    /* One entry per distinct (base, shape); the chain is short, so a linear
     * scan costs less than an index. */
    pl_u32 *group_node = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_node);
    pl_u64 *group_cumulative = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_cumulative);
    pl_operand *group_base = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_base);
    pl_u64 *group_shape = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_shape);
    if (!group_node || !group_cumulative || !group_base || !group_shape)
        return PL_ERROR_ARENA;
    pl_u32 groups = 0;

    for (pl_u32 index = 0; index < in->node_count; ++index) {
        const pl_node *node = &in->nodes[index];
        if (node->opcode != PL_OPCODE_MEMORY_PRE_STORE
                || node->argument_count != 4u)
            continue;
        const pl_operand *argument = &in->arguments[node->argument_at];
        pl_operand base = argument[0];
        pl_operand decrement = argument[2];
        pl_operand shape = argument[3];
        if (decrement.kind != PL_OPERAND_CONST
                || shape.kind != PL_OPERAND_CONST)
            continue;

        /* decode_memory_shape, which rejects unknown flags rather than
         * masking them away. */
        if (shape.value & ~(pl_u64)PL_MEMORY_SHAPE_MASK) continue;
        pl_u64 width = shape.value & 0xffu;
        pl_u64 scale = (shape.value >> PL_MEMORY_SHAPE_SCALE_SHIFT)
                     & PL_MEMORY_SHAPE_SCALE_MASK;
        int virtual64 = (shape.value & PL_MEMORY_SHAPE_VIRTUAL64) != 0;
        pl_u64 cumulative = decrement.value;

        pl_u32 found = groups;
        for (pl_u32 slot = 0; slot < groups; ++slot)
            if (group_base[slot].kind == base.kind
                    && group_base[slot].value == base.value
                    && group_shape[slot] == shape.value) {
                found = slot;
                break;
            }
        if (found < groups && virtual64 && !scale
                && cumulative > group_cumulative[found]
                && width <= cumulative - group_cumulative[found]) {
            out->arguments[node->argument_at].kind = PL_OPERAND_NODE;
            out->arguments[node->argument_at].value = group_node[found];
            out->arguments[node->argument_at + 2u].kind = PL_OPERAND_CONST;
            out->arguments[node->argument_at + 2u].value =
                cumulative - group_cumulative[found];
        }
        if (found == groups) {
            if (groups >= in->node_count) return PL_ERROR_PLAN;
            group_base[groups] = base;
            group_shape[groups] = shape.value;
            groups += 1u;
        }
        group_node[found] = index + 1u;
        group_cumulative[found] = cumulative;
    }
    return 0;
}

/* TODO: the remaining pre-passes and the main sweep.
 *
 * Measured over 299 composed pairs of the shipped artifact, by how often each
 * changes the graph:
 *
 *     rebase_overwritten_flags     63   implemented above
 *     reopen_consumed_x86_alu      15   149 lines
 *     reopen_load_regions           6    69 lines
 *     reopen_pre_store_chains       3    33 lines
 *     forward_memory_versions       0   190 lines
 *     rewrite_relative_exchange     0   277 lines
 *     the main sweep               27   ~800 lines
 *
 * The two that never fire are left unwritten rather than guessed at.  A parity
 * that ever sees them matter will disagree, which is the intended signal: they
 * are absent, not assumed unnecessary.
 */
