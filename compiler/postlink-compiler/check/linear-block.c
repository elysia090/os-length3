#include <x86/ssa-build.h>

#include <stdio.h>

#define TEST_NODES 4096u
#define HASH_ARENA_BYTES (1024u * 1024u)
#define LINEAR_ARENA_BYTES (192u * 1024u)

static pl_u8 hash_memory[HASH_ARENA_BYTES];
static pl_u8 linear_memory[LINEAR_ARENA_BYTES];
static pl_u8 compact_memory[HASH_ARENA_BYTES];

static int build_shared(pl_arena *arena, pl_plan *plan, int expect_index)
{
    pl_builder builder;
    if (pl_builder_open(&builder, plan, arena,
                        TEST_NODES + 1u, TEST_NODES * 2u + 2u, 0u, 0u))
        return 0;
    pl_operand arguments[2] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_CONST, 0u },
    };
    /* A pre-existing pure node must enter the same index as nodes emitted by
     * the quotient path.  Equal expressions always select its first value. */
    if (pl_emit(&builder, PL_OPCODE_ADD, arguments, 2u) != 1u)
        return 0;
    for (pl_u32 index = 0u; index < TEST_NODES; ++index) {
        arguments[1].value = index;
        pl_u32 expected = index ? index + 1u : 1u;
        if (pl_emit_shared(&builder, PL_OPCODE_ADD, arguments, 2u)
                != expected)
            return 0;
    }
    for (pl_u32 index = TEST_NODES; index-- > 0u;) {
        arguments[1].value = index;
        pl_u32 expected = index ? index + 1u : 1u;
        if (pl_emit_shared(&builder, PL_OPCODE_ADD, arguments, 2u)
                != expected)
            return 0;
    }
    return plan->node_count == TEST_NODES
        && !!builder.shared_slots == expect_index;
}

static int check_waves(void)
{
    pl_node nodes[TEST_NODES];
    pl_operand arguments[TEST_NODES * 2u];
    pl_operand stack[1] = { { PL_OPERAND_NODE, TEST_NODES } };
    for (pl_u32 index = 0u; index < TEST_NODES; ++index) {
        nodes[index] = (pl_node){ PL_OPCODE_ADD, index * 2u, 2u };
        arguments[index * 2u] = index
            ? (pl_operand){ PL_OPERAND_NODE, index }
            : (pl_operand){ PL_OPERAND_LOCAL, 0u };
        arguments[index * 2u + 1u] =
            (pl_operand){ PL_OPERAND_CONST, 1u };
    }
    pl_plan source = { 0 };
    source.nodes = nodes;
    source.node_count = TEST_NODES;
    source.arguments = arguments;
    source.argument_count = TEST_NODES * 2u;
    source.stack = stack;
    source.stack_count = 1u;
    pl_arena arena = { compact_memory, sizeof compact_memory, 0u };
    pl_plan compacted;
    if (pl_compact_once(&source, &arena, &compacted)
            || compacted.node_count != TEST_NODES
            || compacted.span != TEST_NODES)
        return 0;
    for (pl_u32 wave = 0u; wave <= TEST_NODES; ++wave)
        if (compacted.wave_offsets[wave] != wave
                || (wave && compacted.wave_values[wave - 1u] != wave))
            return 0;
    return 1;
}

int main(void)
{
    pl_arena hash_arena = { hash_memory, sizeof hash_memory, 0u };
    pl_arena linear_arena = { linear_memory, sizeof linear_memory, 0u };
    pl_plan hashed, linear;
    if (!build_shared(&hash_arena, &hashed, 1)
            || !build_shared(&linear_arena, &linear, 0)
            || hashed.node_count != linear.node_count
            || hashed.argument_count != linear.argument_count)
        return 1;
    for (pl_u32 index = 0u; index < hashed.node_count; ++index)
        if (hashed.nodes[index].opcode != linear.nodes[index].opcode
                || hashed.nodes[index].argument_at
                   != linear.nodes[index].argument_at
                || hashed.nodes[index].argument_count
                   != linear.nodes[index].argument_count)
            return 1;
    for (pl_u32 index = 0u; index < hashed.argument_count; ++index)
        if (hashed.arguments[index].kind != linear.arguments[index].kind
                || hashed.arguments[index].value
                   != linear.arguments[index].value)
            return 1;
    if (!check_waves()) return 1;
    puts("linear block: green (4096 pure-node quotient and dependency waves)");
    return 0;
}
