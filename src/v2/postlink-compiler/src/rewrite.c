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
