/* The shared traversal.  See include/postlink/sweep.h. */

#include "internal/sweep.h"

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
    builder->shared_slots = 0;
    builder->shared_capacity = 0;
    builder->shared_disabled = 0;
    return 0;
}

static pl_u32 shared_hash(pl_u32 opcode, const pl_operand *arguments,
                          pl_u32 count)
{
    pl_u32 hash = 2166136261u;
    hash = (hash ^ opcode) * 16777619u;
    hash = (hash ^ count) * 16777619u;
    for (pl_u32 index = 0; index < count; ++index) {
        hash = (hash ^ arguments[index].kind) * 16777619u;
        hash = (hash ^ (pl_u32)arguments[index].value) * 16777619u;
        hash = (hash ^ (pl_u32)(arguments[index].value >> 32u))
             * 16777619u;
    }
    return hash;
}

static void shared_insert(pl_builder *builder, pl_u32 value)
{
    pl_plan *plan = builder->plan;
    const pl_node *node = &plan->nodes[value - 1u];
    if (!builder->shared_slots || pl_opcode_is_memory(node->opcode)) return;
    pl_u32 mask = builder->shared_capacity - 1u;
    pl_u32 at = shared_hash(
        node->opcode, plan->arguments + node->argument_at,
        node->argument_count) & mask;
    while (builder->shared_slots[at]) at = (at + 1u) & mask;
    builder->shared_slots[at] = value;
}

static void shared_index_open(pl_builder *builder)
{
    if (builder->shared_slots || builder->shared_disabled) return;
    /* Tiny plans are cheaper to compare directly.  The larger native block
     * plans use an arena-local index, never a release-wide materialization. */
    if (builder->node_capacity < 32u
            || builder->node_capacity > 0x0fffffffu) {
        builder->shared_disabled = 1u;
        return;
    }
    pl_u32 capacity = 64u;
    while (capacity < builder->node_capacity * 2u) capacity <<= 1u;
    pl_u32 *slots = pl_arena_take(
        builder->arena, capacity * (pl_u32)sizeof *slots);
    if (!slots) {
        builder->shared_disabled = 1u;
        return;
    }
    builder->shared_slots = slots;
    builder->shared_capacity = capacity;
    for (pl_u32 at = 0; at < capacity; ++at) slots[at] = 0u;
    for (pl_u32 value = 1u; value <= builder->plan->node_count; ++value)
        shared_insert(builder, value);
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
    shared_insert(builder, plan->node_count);
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
    if (!pl_opcode_is_memory(opcode)) {
        shared_index_open(builder);
        if (builder->shared_slots) {
            pl_u32 mask = builder->shared_capacity - 1u;
            pl_u32 at = shared_hash(opcode, arguments, count) & mask;
            while (builder->shared_slots[at]) {
                pl_u32 value = builder->shared_slots[at];
                const pl_node *held = &plan->nodes[value - 1u];
                if (held->opcode == opcode && held->argument_count == count
                        && same_operands(
                            plan->arguments + held->argument_at,
                            arguments, count))
                    return value;
                at = (at + 1u) & mask;
            }
            return pl_emit(builder, opcode, arguments, count);
        }
        for (pl_u32 index = 0; index < plan->node_count; ++index) {
            const pl_node *held = &plan->nodes[index];
            if (held->opcode != opcode || held->argument_count != count
                    || pl_opcode_is_memory(held->opcode))
                continue;
            if (same_operands(plan->arguments + held->argument_at,
                              arguments, count))
                return index + 1u;
        }
    }
    return pl_emit(builder, opcode, arguments, count);
}
