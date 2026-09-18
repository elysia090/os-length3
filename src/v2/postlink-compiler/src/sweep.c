/* The shared traversal.  See include/postlink/sweep.h. */

#include "internal/sweep.h"

#define PL_PROJECTION_SELECTOR_BITS 8u
#define PL_PROJECTION_SELECTOR_MASK ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u)

int pl_remap_open(pl_remap *remap, pl_u32 values, pl_arena *arena)
{
    remap->of = pl_arena_take(
        arena, (values + 1u) * (pl_u32)sizeof *remap->of);
    if (!remap->of) return PL_ERROR_ARENA;
    remap->count = values;
    /* Value zero is never a node, so it stands for "unmapped" and a rule
     * reading it is a bug rather than a silent identity. */
    for (pl_u32 index = 0; index <= values; ++index) {
        remap->of[index].kind = PL_OPERAND_CONST;
        remap->of[index].value = 0;
    }
    return 0;
}

pl_operand pl_resolve(const pl_remap *remap, pl_operand operand)
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

int pl_builder_open(pl_builder *builder, pl_plan *plan, pl_arena *arena,
                    pl_u32 nodes, pl_u32 arguments, pl_u32 stack,
                    pl_u32 locals)
{
    plan->nodes = pl_arena_take(
        arena, (nodes ? nodes : 1u) * (pl_u32)sizeof *plan->nodes);
    plan->arguments = pl_arena_take(
        arena, (arguments ? arguments : 1u) * (pl_u32)sizeof *plan->arguments);
    plan->stack = pl_arena_take(
        arena, (stack ? stack : 1u) * (pl_u32)sizeof *plan->stack);
    plan->locals = pl_arena_take(
        arena, (locals ? locals : 1u) * (pl_u32)sizeof *plan->locals);
    if (!plan->nodes || !plan->arguments || !plan->stack || !plan->locals)
        return PL_ERROR_ARENA;
    plan->node_count = 0;
    plan->argument_count = 0;
    plan->stack_count = stack;
    plan->local_count = locals;
    plan->wave_offsets = 0;
    plan->wave_values = 0;
    builder->plan = plan;
    builder->arena = arena;
    builder->node_capacity = nodes;
    builder->argument_capacity = arguments;
    return 0;
}

pl_u32 pl_emit(pl_builder *builder, pl_u32 opcode,
               const pl_operand *arguments, pl_u32 count)
{
    pl_plan *plan = builder->plan;
    if (plan->node_count >= builder->node_capacity) return 0;
    if (count > builder->argument_capacity - plan->argument_count) return 0;
    pl_u32 at = plan->argument_count;
    for (pl_u32 index = 0; index < count; ++index)
        plan->arguments[at + index] = arguments[index];
    plan->argument_count = at + count;
    plan->nodes[plan->node_count].opcode = opcode;
    plan->nodes[plan->node_count].argument_at = at;
    plan->nodes[plan->node_count].argument_count = count;
    plan->node_count += 1u;
    return plan->node_count;
}

static int same_operands(const pl_operand *left, const pl_operand *right,
                         pl_u32 count)
{
    for (pl_u32 index = 0; index < count; ++index)
        if (left[index].kind != right[index].kind
                || left[index].value != right[index].value)
            return 0;
    return 1;
}

pl_u32 pl_emit_shared(pl_builder *builder, pl_u32 opcode,
                      const pl_operand *arguments, pl_u32 count)
{
    pl_plan *plan = builder->plan;
    if (!pl_opcode_is_memory(opcode))
        for (pl_u32 index = 0; index < plan->node_count; ++index) {
            const pl_node *held = &plan->nodes[index];
            if (held->opcode != opcode || held->argument_count != count
                    || pl_opcode_is_memory(held->opcode))
                continue;
            if (same_operands(plan->arguments + held->argument_at,
                              arguments, count))
                return index + 1u;
        }
    return pl_emit(builder, opcode, arguments, count);
}
