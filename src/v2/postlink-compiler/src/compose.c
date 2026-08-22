/* Raw composition: substitute one state step through another.
 *
 * Mirrors compose_plans_raw in qm/stepnormalize.py.  Three mechanisms make this
 * more than a concatenation, and each was read off that function rather than
 * assumed:
 *
 *   - the second plan's local and stack operands are replaced by whatever the
 *     first publishes at that coordinate, so no intermediate frame exists;
 *   - a memory node joins an ordering chain, taking the previous memory node as
 *     an extra argument when it does not already name it, which is why a
 *     composed plan can carry more operands than the two inputs together;
 *   - a projection whose source does not publish it becomes a materialized
 *     relative_result node, memoized so one node serves every use.
 *
 * The composed plan keeps the first plan's waves.  Recomputing them is
 * normalization's job, and normalization is a separate stage.
 */

#include <postlink/plan.h>

#define PL_PROJECTION_SELECTOR_BITS 8u
#define PL_PROJECTION_SELECTOR_MASK ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u)

/* The widest argument list a single node may carry.  Staging a node's arguments
 * is what keeps them contiguous while materializing a projection appends nodes
 * and arguments of its own. */
#define PL_STAGED_ARGUMENTS 64u

pl_u32 pl_compose_arena_bytes(const pl_plan *first, const pl_plan *second)
{
    pl_u64 nodes = (pl_u64)first->node_count + second->node_count
                 + second->argument_count;
    pl_u64 arguments = (pl_u64)first->argument_count + second->argument_count
                     + second->node_count + 2ull * second->argument_count;
    pl_u64 bytes = nodes * sizeof(pl_node)
                 + arguments * sizeof(pl_operand)
                 + ((pl_u64)second->stack_count + second->local_count)
                   * sizeof(pl_operand)
                 + (pl_u64)second->argument_count * 3ull * sizeof(pl_u32)
                 + (pl_u64)second->node_count * sizeof(pl_u32)
                 + 128ull;                      /* alignment slack */
    return bytes > 0xffffffffull ? 0xffffffffu : (pl_u32)bytes;
}

typedef struct {
    pl_plan *out;
    const pl_plan *first;
    pl_u32 *remap;              /* second node value to composed node value */
    pl_u32 *projection_source;
    pl_u32 *projection_selector;
    pl_u32 *projection_node;
    pl_u32 projections;
    pl_u32 last_memory;         /* composed node value, 0 for none */
    int failed;
} compose_state;

static int plan_traps(const pl_plan *plan)
{
    for (pl_u32 index = 0u; index < plan->node_count; ++index)
        if (pl_opcode_traps(plan->nodes[index].opcode)) return 1;
    return 0;
}

static pl_operand substitute_output(compose_state *state, pl_operand operand)
{
    const pl_plan *first = state->first;
    pl_operand mapped;
    if (operand.kind == PL_OPERAND_CONST) return operand;
    if (operand.kind == PL_OPERAND_LOCAL) {
        if (operand.value >= first->local_count) {
            state->failed = 1;
            return operand;
        }
        return first->locals[operand.value];
    }
    if (operand.kind == PL_OPERAND_STACK) {
        if (operand.value >= first->stack_count) {
            state->failed = 1;
            return operand;
        }
        return first->stack[operand.value];
    }
    if (operand.kind == PL_OPERAND_PROJECTION) {
        pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
        pl_u64 selector = operand.value & PL_PROJECTION_SELECTOR_MASK;
        if (!source || source > state->out->node_count) {
            state->failed = 1;
            return operand;
        }
        mapped.kind = PL_OPERAND_PROJECTION;
        mapped.value = ((pl_u64)state->remap[source - 1u]
                        << PL_PROJECTION_SELECTOR_BITS) | selector;
        return mapped;
    }
    if (!operand.value || operand.value > state->out->node_count) {
        state->failed = 1;
        return operand;
    }
    mapped.kind = PL_OPERAND_NODE;
    mapped.value = state->remap[operand.value - 1u];
    return mapped;
}

static pl_u32 append_node(pl_plan *out, pl_u32 opcode, pl_u32 at, pl_u32 count)
{
    out->nodes[out->node_count].opcode = opcode;
    out->nodes[out->node_count].argument_at = at;
    out->nodes[out->node_count].argument_count = count;
    out->node_count += 1u;
    return out->node_count;              /* node values are one-based */
}

static pl_operand substitute_argument(compose_state *state, pl_operand operand)
{
    pl_operand resolved = substitute_output(state, operand);
    pl_operand held;
    if (state->failed || resolved.kind != PL_OPERAND_PROJECTION)
        return resolved;

    pl_u32 source = (pl_u32)(resolved.value >> PL_PROJECTION_SELECTOR_BITS);
    pl_u32 selector = (pl_u32)(resolved.value & PL_PROJECTION_SELECTOR_MASK);
    if (!source || source > state->out->node_count) {
        state->failed = 1;
        return resolved;
    }
    if (pl_opcode_publishes_projection(state->out->nodes[source - 1u].opcode))
        return resolved;

    for (pl_u32 index = 0; index < state->projections; ++index)
        if (state->projection_source[index] == source
                && state->projection_selector[index] == selector) {
            held.kind = PL_OPERAND_NODE;
            held.value = state->projection_node[index];
            return held;
        }

    pl_u32 at = state->out->argument_count;
    state->out->arguments[at].kind = PL_OPERAND_NODE;
    state->out->arguments[at].value = source;
    state->out->arguments[at + 1u].kind = PL_OPERAND_CONST;
    state->out->arguments[at + 1u].value = selector;
    state->out->argument_count = at + 2u;
    pl_u32 value = append_node(state->out, PL_OPCODE_RELATIVE_RESULT, at, 2u);

    state->projection_source[state->projections] = source;
    state->projection_selector[state->projections] = selector;
    state->projection_node[state->projections] = value;
    state->projections += 1u;
    state->last_memory = value;

    held.kind = PL_OPERAND_NODE;
    held.value = value;
    return held;
}

int pl_compose_raw(const pl_plan *first, const pl_plan *second,
                   pl_arena *arena, pl_plan *out)
{
    if (first->function != second->function) return PL_ERROR_PLAN;
    if (first->stack_count < second->stack_inputs) return PL_ERROR_PLAN;
    /* A trapping source instruction is an architectural publication cut.
     * Folding an earlier or later instruction into it loses the exact state
     * an exception observes.  Zero-instruction normalization fragments may
     * still join the same source instruction, but two source instructions may
     * never cross this boundary. */
    if ((pl_u64)first->instructions + second->instructions > 1u
            && (plan_traps(first) || plan_traps(second)))
        return PL_ERROR_PLAN;

    pl_u64 node_cap = (pl_u64)first->node_count + second->node_count
                    + second->argument_count;
    pl_u64 argument_cap = (pl_u64)first->argument_count
                        + second->argument_count + second->node_count
                        + 2ull * second->argument_count;
    if (node_cap > 0xffffffull || argument_cap > 0xffffffull)
        return PL_ERROR_PLAN;

    out->nodes = pl_arena_take(arena, (pl_u32)(node_cap * sizeof *out->nodes));
    out->arguments = pl_arena_take(
        arena, (pl_u32)(argument_cap * sizeof *out->arguments));
    out->stack = pl_arena_take(
        arena, second->stack_count * (pl_u32)sizeof *out->stack);
    out->locals = pl_arena_take(
        arena, second->local_count * (pl_u32)sizeof *out->locals);
    pl_u32 *remap = pl_arena_take(
        arena, second->node_count * (pl_u32)sizeof *remap);
    pl_u32 *psource = pl_arena_take(
        arena, second->argument_count * (pl_u32)sizeof *psource);
    pl_u32 *pselector = pl_arena_take(
        arena, second->argument_count * (pl_u32)sizeof *pselector);
    pl_u32 *pnode = pl_arena_take(
        arena, second->argument_count * (pl_u32)sizeof *pnode);
    if (!out->nodes || !out->arguments
            || (second->stack_count && !out->stack)
            || (second->local_count && !out->locals)
            || (second->node_count && !remap)
            || (second->argument_count && (!psource || !pselector || !pnode)))
        return PL_ERROR_ARENA;

    /* Start from the first plan whole: its node values are unchanged, which is
     * why only the second plan needs a remap. */
    for (pl_u32 index = 0; index < first->argument_count; ++index)
        out->arguments[index] = first->arguments[index];
    out->argument_count = first->argument_count;
    for (pl_u32 index = 0; index < first->node_count; ++index)
        out->nodes[index] = first->nodes[index];
    out->node_count = first->node_count;

    compose_state state;
    state.out = out;
    state.first = first;
    state.remap = remap;
    state.projection_source = psource;
    state.projection_selector = pselector;
    state.projection_node = pnode;
    state.projections = 0;
    state.failed = 0;
    state.last_memory = 0;
    for (pl_u32 index = first->node_count; index-- > 0;)
        if (pl_opcode_is_memory(first->nodes[index].opcode)) {
            state.last_memory = index + 1u;
            break;
        }

    for (pl_u32 index = 0; index < second->node_count; ++index) {
        const pl_node *node = &second->nodes[index];
        pl_operand staged[PL_STAGED_ARGUMENTS];
        pl_u32 written = 0;
        if (node->argument_count >= PL_STAGED_ARGUMENTS) return PL_ERROR_PLAN;
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot) {
            staged[written] = substitute_argument(
                &state, second->arguments[node->argument_at + slot]);
            if (state.failed) return PL_ERROR_PLAN;
            written += 1u;
        }
        int memory = pl_opcode_is_memory(node->opcode);
        if (memory && state.last_memory) {
            int present = 0;
            for (pl_u32 slot = 0; slot < written; ++slot)
                if (staged[slot].kind == PL_OPERAND_NODE
                        && staged[slot].value == state.last_memory)
                    present = 1;
            if (!present) {
                if (written >= PL_STAGED_ARGUMENTS) return PL_ERROR_PLAN;
                staged[written].kind = PL_OPERAND_NODE;
                staged[written].value = state.last_memory;
                written += 1u;
            }
        }
        pl_u32 at = out->argument_count;
        for (pl_u32 slot = 0; slot < written; ++slot)
            out->arguments[at + slot] = staged[slot];
        out->argument_count = at + written;
        remap[index] = append_node(out, node->opcode, at, written);
        if (memory) state.last_memory = remap[index];
    }

    for (pl_u32 index = 0; index < second->stack_count; ++index) {
        out->stack[index] = substitute_output(&state, second->stack[index]);
        if (state.failed) return PL_ERROR_PLAN;
    }
    for (pl_u32 index = 0; index < second->local_count; ++index) {
        out->locals[index] = substitute_output(&state, second->locals[index]);
        if (state.failed) return PL_ERROR_PLAN;
    }

    out->function = first->function;
    out->start = first->start;
    out->instructions = first->instructions + second->instructions;
    out->end = first->start + out->instructions;
    out->stack_inputs = first->stack_inputs;
    out->span = first->span;          /* the composed plan keeps first.waves */
    out->stack_count = second->stack_count;
    out->local_count = second->local_count;
    return 0;
}
