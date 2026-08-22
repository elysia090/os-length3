/* Produce two ordinary Wasm blocks through the standalone C emitter.
 *
 * This is a repository integration fixture, not a second compiler.  The
 * plans use the same public structures a linked-x86 frontend publishes: the
 * first block exercises fused arithmetic/state lanes and directly names the
 * second function rank.  That second block writes two adjacent words, reads
 * them with one physical region operation through vm.wasm's page barrier,
 * and adds its two projections before halting.  This ordering proves a page
 * retry resumes the second rank instead of replaying the completed first
 * block.  The browser/Node check installs
 * both functions in vm.wasm's shared table and proves that no X86B or STEP
 * record participates.
 */

#include <stdio.h>
#include <stdlib.h>

#include <postlink/wasm.h>
#include <postlink/instantiation.h>
#include <postlink/residual.h>

static void fill_digest(pl_u8 digest[PL_EXECUTABLE_DIGEST_BYTES], pl_u8 seed)
{
    for (pl_u32 index = 0u; index < PL_EXECUTABLE_DIGEST_BYTES; ++index)
        digest[index] = (pl_u8)(seed + index);
}

static int save(const char *path, const pl_u8 *bytes, pl_u32 count)
{
    FILE *file = fopen(path, "wb");
    if (!file) return 0;
    size_t saved = fwrite(bytes, 1u, count, file);
    int close_status = fclose(file);
    return saved == count && !close_status;
}

static void make_state_plan(
        pl_plan *plan, pl_node nodes[19], pl_operand arguments[60],
        pl_operand locals[PL_VM_X86_REGISTER_COUNT + 1u])
{
    nodes[0] = (pl_node){ PL_OPCODE_X86_ALU, 0u, 4u };
    arguments[0] = (pl_operand){
        PL_OPERAND_LOCAL, PL_VM_X86_REGISTER_COUNT,
    };
    arguments[1] = (pl_operand){ PL_OPERAND_LOCAL, 0u };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 40u };
    arguments[3] = (pl_operand){ PL_OPERAND_CONST, 64u | (1u << 8u) };

    nodes[1] = (pl_node){ PL_OPCODE_X86_BIT_FLAGS, 4u, 4u };
    arguments[4] = (pl_operand){ PL_OPERAND_CONST, 0x2d6u };
    arguments[5] = (pl_operand){ PL_OPERAND_CONST, 0x8000u };
    arguments[6] = (pl_operand){ PL_OPERAND_CONST, 15u };
    arguments[7] = (pl_operand){ PL_OPERAND_CONST, 16u };

    nodes[2] = (pl_node){ PL_OPCODE_LANE64_INSERT, 8u, 3u };
    arguments[8] = (pl_operand){
        PL_OPERAND_CONST, 0x1122334455667788ull,
    };
    arguments[9] = (pl_operand){ PL_OPERAND_CONST, 0xabu };
    arguments[10] = (pl_operand){ PL_OPERAND_CONST, 8u };

    nodes[3] = (pl_node){ PL_OPCODE_LANE32_INSERT, 11u, 3u };
    arguments[11] = arguments[8];
    arguments[12] = (pl_operand){ PL_OPERAND_CONST, 0xcdu };
    arguments[13] = (pl_operand){ PL_OPERAND_CONST, 8u | (8u << 8u) };

    nodes[4] = (pl_node){ PL_OPCODE_SELECT_U32, 14u, 3u };
    arguments[14] = (pl_operand){ PL_OPERAND_CONST, 0x100000002ull };
    arguments[15] = (pl_operand){ PL_OPERAND_CONST, 0x200000003ull };
    arguments[16] = (pl_operand){ PL_OPERAND_CONST, 1u };

    nodes[5] = (pl_node){ PL_OPCODE_MUL_HIGH, 17u, 3u };
    arguments[17] = (pl_operand){ PL_OPERAND_CONST, ~0ull };
    arguments[18] = (pl_operand){ PL_OPERAND_CONST, 2u };
    arguments[19] = (pl_operand){ PL_OPERAND_CONST, 64u };

    nodes[6] = (pl_node){ PL_OPCODE_MUL_HIGH, 20u, 3u };
    arguments[20] = (pl_operand){ PL_OPERAND_CONST, ~1ull };
    arguments[21] = (pl_operand){ PL_OPERAND_CONST, 3u };
    arguments[22] = (pl_operand){ PL_OPERAND_CONST, 64u | (1u << 8u) };

    nodes[7] = (pl_node){ PL_OPCODE_X86_MUL_FLAGS, 23u, 4u };
    arguments[23] = (pl_operand){ PL_OPERAND_CONST, 0x247u };
    arguments[24] = (pl_operand){ PL_OPERAND_CONST, ~5ull };
    arguments[25] = (pl_operand){ PL_OPERAND_NODE, 7u };
    arguments[26] = arguments[22];

    nodes[8] = (pl_node){ PL_OPCODE_BIT_ADDRESS, 27u, 3u };
    arguments[27] = (pl_operand){ PL_OPERAND_CONST, 0x1000u };
    arguments[28] = (pl_operand){ PL_OPERAND_CONST, ~64ull };
    arguments[29] = (pl_operand){ PL_OPERAND_CONST, 64u | (64u << 8u) };

    nodes[9] = (pl_node){ 84u, 30u, 1u }; /* lane64.BSWAP */
    arguments[30] = (pl_operand){
        PL_OPERAND_CONST, 0x0123456789abcdefull,
    };
    nodes[10] = (pl_node){ 14u, 31u, 1u }; /* lane32.BSWAP */
    arguments[31] = (pl_operand){ PL_OPERAND_CONST, 0x12345678u };
    nodes[11] = (pl_node){ 127u, 32u, 2u }; /* lane64.div_u */
    arguments[32] = (pl_operand){ PL_OPERAND_CONST, 84u };
    arguments[33] = (pl_operand){ PL_OPERAND_CONST, 2u };
    nodes[12] = (pl_node){ PL_OPCODE_X86_ROTATE_CARRY, 34u, 4u };
    arguments[34] = (pl_operand){ PL_OPERAND_CONST, 2u };
    arguments[35] = (pl_operand){ PL_OPERAND_CONST, 0x40000000u };
    arguments[36] = (pl_operand){ PL_OPERAND_CONST, 1u };
    arguments[37] = (pl_operand){ PL_OPERAND_CONST, 32u };
    nodes[13] = (pl_node){ PL_OPCODE_BIT_ADDRESS, 38u, 3u };
    arguments[38] = (pl_operand){ PL_OPERAND_CONST, 0x1000u };
    arguments[39] = (pl_operand){ PL_OPERAND_CONST, 0xffffu };
    arguments[40] = (pl_operand){
        PL_OPERAND_CONST, 16u | (16u << 8u),
    };
    nodes[14] = (pl_node){ PL_OPCODE_X86_BIT_SUMMARY, 41u, 3u };
    arguments[41] = (pl_operand){ PL_OPERAND_CONST, 0x2d7u };
    arguments[42] = (pl_operand){ PL_OPERAND_CONST, 0x1010u };
    arguments[43] = (pl_operand){
        PL_OPERAND_CONST, 64u | (4u << 8u),
    };
    nodes[15] = (pl_node){ PL_OPCODE_X86_DOUBLE_SHIFT, 44u, 5u };
    arguments[44] = (pl_operand){ PL_OPERAND_CONST, 0x246u };
    arguments[45] = (pl_operand){
        PL_OPERAND_CONST, 0x8000000000000001ull,
    };
    arguments[46] = (pl_operand){ PL_OPERAND_CONST, 3u };
    arguments[47] = (pl_operand){ PL_OPERAND_CONST, 1u };
    arguments[48] = (pl_operand){ PL_OPERAND_CONST, 64u };
    nodes[16] = (pl_node){ PL_OPCODE_X86_ALU, 49u, 4u };
    arguments[49] = (pl_operand){ PL_OPERAND_CONST, 0x246u };
    arguments[50] = (pl_operand){ PL_OPERAND_CONST, 0xf0u };
    arguments[51] = (pl_operand){ PL_OPERAND_CONST, 0x1ffu };
    arguments[52] = (pl_operand){
        PL_OPERAND_CONST, 64u | (7u << 8u),
    };
    nodes[17] = (pl_node){ PL_OPCODE_X86_CRC32, 53u, 3u };
    arguments[53] = (pl_operand){ PL_OPERAND_CONST, 0xffffffffu };
    arguments[54] = (pl_operand){ PL_OPERAND_CONST, 0x31323334u };
    arguments[55] = (pl_operand){ PL_OPERAND_CONST, 32u };
    nodes[18] = (pl_node){ PL_OPCODE_X86_BZHI, 56u, 4u };
    arguments[56] = (pl_operand){ PL_OPERAND_CONST, 0xad7u };
    arguments[57] = (pl_operand){ PL_OPERAND_CONST, 0x80000001u };
    arguments[58] = (pl_operand){ PL_OPERAND_CONST, 32u };
    arguments[59] = (pl_operand){ PL_OPERAND_CONST, 32u };
    for (pl_u32 index = 0u;
         index < PL_VM_X86_REGISTER_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    locals[0] = (pl_operand){
        PL_OPERAND_PROJECTION, (1u << 8u) | 16u,
    };
    for (pl_u32 index = 1u; index <= 6u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_NODE, index + 1u };
    locals[7] = (pl_operand){ PL_OPERAND_NODE, 9u };
    locals[8] = (pl_operand){ PL_OPERAND_NODE, 10u };
    locals[9] = (pl_operand){ PL_OPERAND_NODE, 11u };
    locals[10] = (pl_operand){ PL_OPERAND_NODE, 12u };
    locals[11] = (pl_operand){
        PL_OPERAND_PROJECTION, (13u << 8u) | 16u,
    };
    locals[12] = (pl_operand){ PL_OPERAND_NODE, 13u };
    locals[13] = (pl_operand){ PL_OPERAND_NODE, 14u };
    locals[14] = (pl_operand){
        PL_OPERAND_PROJECTION, (19u << 8u) | 16u,
    };
    locals[PL_VM_X86_REGISTER_COUNT] = (pl_operand){ PL_OPERAND_NODE, 8u };
    *plan = (pl_plan){
        .function = 0u,
        .start = 0u,
        .end = 1u,
        .instructions = 1u,
        .span = 2u,
        .nodes = nodes,
        .node_count = 19u,
        .arguments = arguments,
        .argument_count = 60u,
        .locals = locals,
        .local_count = PL_VM_X86_REGISTER_COUNT + 1u,
    };
}

static void make_fault_plan(
        pl_plan *plan, pl_node *node, pl_operand arguments[4],
        pl_operand locals[PL_VM_X86_REGISTER_COUNT + 1u])
{
    *node = (pl_node){ PL_OPCODE_X86_DIVIDE, 0u, 4u };
    arguments[0] = (pl_operand){ PL_OPERAND_CONST, 0u }; /* high */
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 1u }; /* low */
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 0u }; /* divisor */
    arguments[3] = (pl_operand){ PL_OPERAND_CONST, 64u };
    for (pl_u32 index = 0u;
         index < PL_VM_X86_REGISTER_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    *plan = (pl_plan){
        .instructions = 1u,
        .span = 1u,
        .nodes = node,
        .node_count = 1u,
        .arguments = arguments,
        .argument_count = 4u,
        .locals = locals,
        .local_count = PL_VM_X86_REGISTER_COUNT + 1u,
    };
}

static void make_divide_plan(
        pl_plan *plan, pl_node *node, pl_operand arguments[4],
        pl_operand locals[PL_VM_X86_REGISTER_COUNT + 1u])
{
    *node = (pl_node){ PL_OPCODE_X86_DIVIDE, 0u, 4u };
    arguments[0] = (pl_operand){ PL_OPERAND_CONST, ~0ull };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 0xffffffffffffffabull };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 0xfffffffffffffffcull };
    arguments[3] = (pl_operand){ PL_OPERAND_CONST, 64u | (1u << 8u) };
    for (pl_u32 index = 0u;
         index < PL_VM_X86_REGISTER_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    locals[0] = (pl_operand){
        PL_OPERAND_PROJECTION, (1u << 8u),
    };
    locals[2] = (pl_operand){
        PL_OPERAND_PROJECTION, (1u << 8u) | 1u,
    };
    *plan = (pl_plan){
        .instructions = 1u,
        .span = 1u,
        .nodes = node,
        .node_count = 1u,
        .arguments = arguments,
        .argument_count = 4u,
        .locals = locals,
        .local_count = PL_VM_X86_REGISTER_COUNT + 1u,
    };
}

static void make_memory_plan(
        pl_plan *plan, pl_node nodes[9], pl_operand arguments[37],
        pl_operand locals[PL_VM_X86_ARCH_LOCAL_COUNT + 1u])
{
    nodes[0] = (pl_node){
        PL_OPCODE_MEMORY_PRE_STORE, 0u, 4u,
    };
    arguments[0] = (pl_operand){ PL_OPERAND_CONST, 0x4000u };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 9u };
    arguments[2] = (pl_operand){ PL_OPERAND_CONST, 4u };
    arguments[3] = (pl_operand){
        PL_OPERAND_CONST, 4u | PL_MEMORY_SHAPE_VIRTUAL64,
    };
    nodes[1] = (pl_node){ PL_OPCODE_MEMORY_REPEAT, 4u, 4u };
    arguments[4] = (pl_operand){ PL_OPERAND_CONST, 0x3ffcu };
    arguments[5] = (pl_operand){ PL_OPERAND_CONST, 1u };
    arguments[6] = (pl_operand){ PL_OPERAND_CONST, 8u };
    arguments[7] = arguments[3];
    nodes[2] = (pl_node){ PL_OPCODE_MEMORY_COPY, 8u, 5u };
    arguments[8] = arguments[4];
    arguments[9] = (pl_operand){ PL_OPERAND_CONST, 0x5000u };
    arguments[10] = (pl_operand){ PL_OPERAND_CONST, 8u };
    arguments[11] = (pl_operand){
        PL_OPERAND_CONST, 1u | PL_MEMORY_SHAPE_VIRTUAL64,
    };
    arguments[12] = (pl_operand){ PL_OPERAND_NODE, 2u };
    nodes[3] = (pl_node){ PL_OPCODE_MEMORY_LOAD_REGION, 13u, 5u };
    arguments[13] = arguments[9];
    arguments[14] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[15] = (pl_operand){ PL_OPERAND_CONST, 2u };
    arguments[16] = arguments[3];
    arguments[17] = (pl_operand){ PL_OPERAND_NODE, 3u };
    nodes[4] = (pl_node){ PL_OPCODE_MEMORY_FIND2, 18u, 5u };
    arguments[18] = arguments[9];
    arguments[19] = (pl_operand){ PL_OPERAND_CONST, 1u };
    arguments[20] = (pl_operand){ PL_OPERAND_CONST, 0xffu };
    arguments[21] = arguments[11];
    arguments[22] = (pl_operand){ PL_OPERAND_NODE, 4u };
    nodes[5] = (pl_node){ PL_OPCODE_ADD, 23u, 2u };
    arguments[23] = (pl_operand){
        PL_OPERAND_PROJECTION, 4u << 8u,
    };
    arguments[24] = (pl_operand){
        PL_OPERAND_PROJECTION, (4u << 8u) | 1u,
    };
    nodes[6] = (pl_node){ PL_OPCODE_ADD, 25u, 2u };
    arguments[25] = (pl_operand){ PL_OPERAND_NODE, 6u };
    arguments[26] = (pl_operand){ PL_OPERAND_NODE, 5u };
    /* A zero-count shift has already performed its source read, but it must
     * not translate or dirty the destination.  Deliberately use an unmapped
     * address so this integration fixture proves the predicate is consumed
     * by vm.wasm before page translation rather than by a host-side shortcut. */
    nodes[7] = (pl_node){ PL_OPCODE_MEMORY_STORE_IF, 27u, 5u };
    arguments[27] = (pl_operand){
        PL_OPERAND_CONST, 0xfffffffffffff000ull,
    };
    arguments[28] = (pl_operand){ PL_OPERAND_CONST, 0xdeadu };
    arguments[29] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[30] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[31] = (pl_operand){
        PL_OPERAND_CONST, 8u | PL_MEMORY_SHAPE_VIRTUAL64,
    };
    nodes[8] = (pl_node){ PL_OPCODE_MEMORY_FRAME, 32u, 5u };
    arguments[32] = (pl_operand){ PL_OPERAND_CONST, 0x5020u };
    arguments[33] = (pl_operand){ PL_OPERAND_CONST, 0x5018u };
    arguments[34] = (pl_operand){ PL_OPERAND_CONST, 2u };
    arguments[35] = arguments[31];
    arguments[36] = (pl_operand){ PL_OPERAND_NODE, 8u };
    for (pl_u32 index = 0u;
         index < PL_VM_X86_ARCH_LOCAL_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    locals[0] = (pl_operand){ PL_OPERAND_NODE, 7u };
    locals[PL_VM_X86_ARCH_LOCAL_COUNT] =
        (pl_operand){ PL_OPERAND_CONST, 2u };
    *plan = (pl_plan){
        .function = 0u,
        .start = 0u,
        .end = 1u,
        .instructions = 0u,
        .span = 8u,
        .nodes = nodes,
        .node_count = 9u,
        .arguments = arguments,
        .argument_count = 37u,
        .locals = locals,
        .local_count = PL_VM_X86_ARCH_LOCAL_COUNT + 1u,
    };
}

static void make_string_plan(
        pl_plan *plan, pl_node nodes[6], pl_operand arguments[17],
        pl_operand locals[PL_VM_X86_ARCH_LOCAL_COUNT + 1u])
{
    nodes[0] = (pl_node){ PL_OPCODE_REGION_LOAD[1][1][0], 0u, 3u };
    arguments[0] = (pl_operand){ PL_OPERAND_LOCAL, 6u };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, 0u };
    arguments[2] = (pl_operand){
        PL_OPERAND_CONST, 1u | PL_MEMORY_SHAPE_VIRTUAL64,
    };
    nodes[1] = (pl_node){ PL_OPCODE_MEMORY_STORE8, 3u, 5u };
    arguments[3] = (pl_operand){ PL_OPERAND_LOCAL, 7u };
    arguments[4] = (pl_operand){ PL_OPERAND_NODE, 1u };
    arguments[5] = arguments[1];
    arguments[6] = arguments[2];
    arguments[7] = (pl_operand){ PL_OPERAND_NODE, 1u };
    nodes[2] = (pl_node){ PL_OPCODE_BIT, 8u, 2u };
    arguments[8] = (pl_operand){
        PL_OPERAND_LOCAL, PL_VM_X86_RFLAGS_LOCAL,
    };
    arguments[9] = (pl_operand){ PL_OPERAND_CONST, 10u };
    nodes[3] = (pl_node){ PL_OPCODE_LANE64_SELECT, 10u, 3u };
    arguments[10] = (pl_operand){ PL_OPERAND_CONST, ~0ull };
    arguments[11] = (pl_operand){ PL_OPERAND_CONST, 1u };
    arguments[12] = (pl_operand){ PL_OPERAND_NODE, 3u };
    nodes[4] = (pl_node){ PL_OPCODE_ALU_REGISTER[1][1], 13u, 2u };
    arguments[13] = arguments[0];
    arguments[14] = (pl_operand){ PL_OPERAND_NODE, 4u };
    nodes[5] = (pl_node){ PL_OPCODE_ALU_REGISTER[1][1], 15u, 2u };
    arguments[15] = arguments[3];
    arguments[16] = arguments[14];
    for (pl_u32 index = 0u;
         index < PL_VM_X86_ARCH_LOCAL_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    locals[6] = (pl_operand){ PL_OPERAND_NODE, 5u };
    locals[7] = (pl_operand){ PL_OPERAND_NODE, 6u };
    *plan = (pl_plan){
        .instructions = 1u,
        .span = 3u,
        .nodes = nodes,
        .node_count = 6u,
        .arguments = arguments,
        .argument_count = 17u,
        .locals = locals,
        .local_count = PL_VM_X86_ARCH_LOCAL_COUNT + 1u,
    };
}

static void make_branch_plan(
        pl_plan *plan,
        pl_operand locals[PL_VM_X86_ARCH_LOCAL_COUNT + 1u])
{
    for (pl_u32 index = 0u;
         index < PL_VM_X86_ARCH_LOCAL_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    *plan = (pl_plan){
        .instructions = 1u,
        .locals = locals,
        .local_count = PL_VM_X86_ARCH_LOCAL_COUNT + 1u,
    };
}

static void make_parameter_plan(
        pl_plan *plan, pl_node *node, pl_operand arguments[2],
        pl_operand locals[PL_VM_X86_ARCH_LOCAL_COUNT + 1u],
        pl_u64 addend)
{
    *node = (pl_node){ PL_OPCODE_ADD, 0u, 2u };
    arguments[0] = (pl_operand){ PL_OPERAND_LOCAL, 0u };
    arguments[1] = (pl_operand){ PL_OPERAND_CONST, addend };
    for (pl_u32 index = 0u;
         index < PL_VM_X86_ARCH_LOCAL_COUNT + 1u; ++index)
        locals[index] = (pl_operand){ PL_OPERAND_LOCAL, index };
    locals[0] = (pl_operand){ PL_OPERAND_NODE, 1u };
    *plan = (pl_plan){
        .instructions = 1u,
        .span = 1u,
        .nodes = node,
        .node_count = 1u,
        .arguments = arguments,
        .argument_count = 2u,
        .locals = locals,
        .local_count = PL_VM_X86_ARCH_LOCAL_COUNT + 1u,
    };
}

int main(int argc, char **argv)
{
    if (argc != 15) {
        fprintf(stderr, "usage: emitter-fixture OUTPUT.wasm OUTPUT.root "
                        "BINDING.node MODULE.node RESOURCE.node "
                        "RESOURCE.page ENTRY-PAGE.rows ENTRY-TAIL.row "
                        "RESIDUAL.root RESIDUAL-STATE.page "
                        "RESIDUAL-EDGE.page INSTANTIATION.page "
                        "PARAMETER.page COLD.wasm\n");
        return 2;
    }

    pl_plan plans[6];
    pl_node nodes[36];
    pl_operand arguments[6][60];
    pl_operand locals[6][PL_VM_X86_ARCH_LOCAL_COUNT + 1u];
    make_memory_plan(&plans[0], &nodes[0], arguments[0], locals[0]);
    make_state_plan(&plans[1], &nodes[9], arguments[1], locals[1]);
    make_fault_plan(&plans[2], &nodes[28], arguments[2], locals[2]);
    make_divide_plan(&plans[3], &nodes[29], arguments[3], locals[3]);
    make_string_plan(&plans[4], &nodes[30], arguments[4], locals[4]);
    make_branch_plan(&plans[5], locals[5]);
    const pl_wasm_block blocks[20] = {
        {
            .plan = &plans[1], .next_rip = 0x2000u,
            .result_kind = PL_VM_DIRECT, .result_payload = 1u,
        },
        {
            .plan = &plans[0], .next_rip = 0x2001u,
            .result_kind = PL_VM_HALT,
            .recurrence_local = PL_VM_X86_ARCH_LOCAL_COUNT,
            .recurrence_bits = 64u,
            .recurrence_source_instructions = 5u,
        },
        {
            .plan = &plans[2], .next_rip = 0x3001u,
            .result_kind = PL_VM_HALT,
            .fault_predicate = { PL_OPERAND_NODE, 1u },
            .has_fault_predicate = 1u,
            .fault_vector = 0u,
        },
        {
            .plan = &plans[3], .next_rip = 0x4001u,
            .result_kind = PL_VM_HALT,
            .fault_predicate = { PL_OPERAND_NODE, 1u },
            .has_fault_predicate = 1u,
            .fault_vector = 0u,
        },
        {
            .plan = &plans[4], .next_rip = 0x5001u,
            .result_kind = PL_VM_HALT,
        },
        {
            .plan = &plans[5], .next_rip = 0x6100u,
            .result_kind = PL_VM_DIRECT, .result_payload = 1u,
            .branch_predicate = { PL_OPERAND_LOCAL, 0u },
            .alternate_rip = 0x6200u,
            .alternate_result_kind = PL_VM_RESOLVE_RIP,
            .alternate_result_payload = 0u,
            .has_branch_predicate = 1u,
        },
        {
            .plan = &plans[5], .next_rip = 0x6100u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_WRITE_MSR,
        },
        {
            .plan = &plans[5], .next_rip = 0u,
            .result_kind = PL_VM_RESOLVE_RIP,
            .machine_operation = PL_X86_MACHINE_FAR_RETURN,
            .machine_argument = 0u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7100u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_WRITE_CONTROL,
            .machine_argument = 3u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7200u,
            .result_kind = PL_VM_HALT,
            .machine_value = { PL_OPERAND_CONST, 0x5020u },
            .machine_operation = PL_X86_MACHINE_DESCRIPTOR_TABLE,
            .machine_argument = 0u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7300u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_WRITE_SEGMENT,
            .machine_argument = 3u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7400u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_READ_CONTROL,
            .machine_argument = 4u | (1u << 8u),
        },
        {
            .plan = &plans[5], .next_rip = 0x7500u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_POP_FLAGS,
            .machine_argument = 64u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7600u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_READ_MSR,
        },
        {
            .plan = &plans[5], .next_rip = 0x7700u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_CPUID,
        },
        {
            .plan = &plans[5], .next_rip = 0x7800u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_INTERRUPT_FLAG,
        },
        {
            .plan = &plans[5], .next_rip = 0x7900u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_TIME,
            .machine_argument = 2u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7a00u,
            .result_kind = PL_VM_HALT,
            .machine_value = { PL_OPERAND_CONST, 0x50f0u },
            .machine_operation = PL_X86_MACHINE_CR0_STATUS,
            .machine_argument = 1u << 8u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7b00u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_CR0_STATUS,
            .machine_argument = 1u,
        },
        {
            .plan = &plans[5], .next_rip = 0x7c00u,
            .result_kind = PL_VM_HALT,
            .machine_operation = PL_X86_MACHINE_SEGMENT_STACK,
            .machine_argument = (5u << 8u) | (64u << 16u),
        },
    };
    const pl_wasm_page_dispatch dispatchers[1] = {
        { .virtual_page = 0x6000u, .generation = 0u, .page_rank = 0u },
    };
    const pl_wasm_module_spec spec = {
        blocks, 20u, dispatchers, 1u,
    };

    pl_u32 measured = 0u;
    int status = pl_wasm_module_measure(&spec, &measured);
    if (status || !measured) {
        fprintf(stderr, "cannot measure emitted module (%d)\n", status);
        return 1;
    }
    pl_u8 *output = malloc(measured);
    if (!output) {
        fprintf(stderr, "cannot allocate emitted module\n");
        return 1;
    }
    pl_u32 written = 0u;
    status = pl_wasm_module_write(&spec, output, measured, &written);
    if (status || written != measured) {
        fprintf(stderr, "cannot write emitted module (%d, %u/%u)\n",
                status, written, measured);
        free(output);
        return 1;
    }

    if (!save(argv[1], output, written)) {
        fprintf(stderr, "cannot save emitted module\n");
        free(output);
        return 1;
    }
    pl_plan residual_plans[3];
    pl_node residual_nodes[2];
    pl_operand residual_arguments[2][2];
    pl_operand residual_locals[3][PL_VM_X86_ARCH_LOCAL_COUNT + 1u];
    make_parameter_plan(
        &residual_plans[0], &residual_nodes[0], residual_arguments[0],
        residual_locals[0], 2u);
    make_parameter_plan(
        &residual_plans[1], &residual_nodes[1], residual_arguments[1],
        residual_locals[1], 5u);
    make_branch_plan(&residual_plans[2], residual_locals[2]);
    const pl_wasm_block residual_blocks[3] = {
        {
            .plan = &residual_plans[0],
            .result_kind = PL_VM_TRANSITION,
        },
        {
            .plan = &residual_plans[1],
            .result_kind = PL_VM_TRANSITION,
        },
        {
            .plan = &residual_plans[2], .next_rip = 0x3001u,
            .result_kind = PL_VM_HALT,
        },
    };
    pl_u32 body_bytes[3] = { 0u, 0u, 0u };
    pl_u32 parameter_counts[3] = { 0u, 0u, 0u };
    for (pl_u32 rank = 0u; rank < 3u; ++rank) {
        pl_u32 body_rank = rank == 2u ? 1u : 0u;
        status = pl_wasm_block_parameterized_measure(
            &residual_blocks[rank], body_rank,
            &body_bytes[rank], &parameter_counts[rank]);
        if (status) break;
    }
    pl_u8 *body[3] = {
        status ? NULL : malloc(body_bytes[0]),
        status ? NULL : malloc(body_bytes[1]),
        status ? NULL : malloc(body_bytes[2]),
    };
    pl_u64 parameter_values[2] = { 0u, 0u };
    pl_u32 body_written[3] = { 0u, 0u, 0u };
    for (pl_u32 rank = 0u; !status && rank < 3u; ++rank) {
        pl_u32 body_rank = rank == 2u ? 1u : 0u;
        pl_u64 *values = rank < 2u ? &parameter_values[rank] : NULL;
        status = !body[rank] ? PL_ERROR_WASM
            : pl_wasm_block_parameterized_write(
                &residual_blocks[rank], body_rank,
                body[rank], body_bytes[rank], &body_written[rank],
                values, rank < 2u ? 1u : 0u, &parameter_counts[rank]);
    }
    if (!status && (body_written[0] != body_written[1]
            || body_written[0] != body_bytes[0]
            || body_written[2] != body_bytes[2]
            || parameter_counts[0] != 1u || parameter_counts[1] != 1u
            || parameter_counts[2] != 0u
            || parameter_values[0] != 2u || parameter_values[1] != 5u))
        status = PL_ERROR_WASM;
    if (!status) {
        for (pl_u32 index = 0u; index < body_written[0]; ++index)
            if (body[0][index] != body[1][index]) status = PL_ERROR_WASM;
    }
    pl_wasm_function_body topology_bodies[2] = {
        { body[0], body_written[0] },
        { body[2], body_written[2] },
    };
    pl_u32 cold_measured = 0u;
    if (!status)
        status = pl_wasm_body_module_measure(
            topology_bodies, 2u, &cold_measured);
    pl_u8 *cold_output = status || !cold_measured
        ? NULL : malloc(cold_measured);
    pl_u32 cold_written = 0u;
    if (!cold_output || pl_wasm_body_module_write(
            topology_bodies, 2u, cold_output, cold_measured, &cold_written)
            || cold_written != cold_measured
            || !save(argv[14], cold_output, cold_written)) {
        fprintf(stderr, "cannot write topology module (%d)\n", status);
        for (pl_u32 rank = 0u; rank < 3u; ++rank) free(body[rank]);
        free(cold_output);
        free(output);
        return 1;
    }
    for (pl_u32 rank = 0u; rank < 3u; ++rank) free(body[rank]);

    pl_u8 source_digest[PL_EXECUTABLE_DIGEST_BYTES];
    fill_digest(source_digest, 0x10u);
    pl_executable_binding bindings[2] = {
        {
            .virtual_page = 0x1000u,
            .generation = 0u,
            .source_offset = 0u,
            .source_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .dispatch_function = 0u,
            .dispatch_argument = 0u,
        },
        {
            .virtual_page = 0x6000u,
            .generation = 0u,
            .source_offset = PL_EXECUTABLE_SOURCE_DERIVED,
            .source_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .dispatch_function = 20u,
            .dispatch_argument = 0u,
        },
    };
    fill_digest(bindings[0].digest, 0x30u);
    fill_digest(bindings[1].digest, 0x50u);
    pl_executable_module modules[2] = {
        {
            .first_function = 0u,
            .payload_bytes = written,
            .function_count = spec.block_count + spec.dispatcher_count,
            .flags = PL_EXECUTABLE_MODULE_WASM32,
        },
        {
            .first_function = spec.block_count + spec.dispatcher_count,
            .payload_bytes = cold_written,
            .function_count = 2u,
            .flags = PL_EXECUTABLE_MODULE_WASM32,
        },
    };
    pl_sha256_digest(output, written, modules[0].digest);
    pl_sha256_digest(cold_output, cold_written, modules[1].digest);
    pl_u8 resource_page[PL_EXECUTABLE_PAGE_BYTES];
    for (pl_u32 index = 0u; index < sizeof resource_page; ++index)
        resource_page[index] = (pl_u8)(index * 17u + 3u);
    pl_u8 entry_page_rows[PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES] = { 0u };
    pl_u8 entry_tail_row[PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES] = { 0u };
    pl_write_u32(entry_tail_row, 3u);
    pl_u32 residual_kernels[3] = { 0u, 1u, 2u };
    pl_u64 residual_zero[1] = { 4u };
    pl_u64 residual_two[1] = { 0u };
    pl_u32 residual_zero_prefix[2] = { 0u, 1u };
    pl_u32 residual_two_prefix[2] = { 0u, 0u };
    pl_u32 residual_next[2] = { 1u, 2u };
    pl_i32 residual_delta[2] = { 0x1000, 0x1000 };
    pl_residual_graph residual_graph = {
        .kernels = residual_kernels,
        .zero_bits = residual_zero,
        .two_bits = residual_two,
        .zero_prefix = residual_zero_prefix,
        .two_prefix = residual_two_prefix,
        .edge_next = residual_next,
        .edge_rip_delta = residual_delta,
        .state_count = 3u,
        .edge_count = 2u,
        .kernel_count = 3u,
        .word_count = 1u,
    };
    pl_u8 residual_state_page[PL_RESIDUAL_PAGE_BYTES];
    pl_u8 residual_edge_page[PL_RESIDUAL_PAGE_BYTES];
    pl_u32 instantiation_topologies[3] = { 21u, 21u, 22u };
    pl_u32 instantiation_offsets[3] = { 0u, 1u, 2u };
    pl_u8 instantiation_counts[3] = { 1u, 1u, 0u };
    pl_instantiation_table instantiations = {
        .topologies = instantiation_topologies,
        .parameter_offsets = instantiation_offsets,
        .parameter_counts = instantiation_counts,
        .parameters = parameter_values,
        .instantiation_count = 3u,
        .topology_count = 23u,
        .parameter_word_count = 2u,
    };
    pl_u8 instantiation_page[PL_INSTANTIATION_PAGE_BYTES];
    pl_u8 parameter_page[PL_PARAMETER_PAGE_BYTES];
    if (pl_residual_state_page_write(
            &residual_graph, 0u, residual_state_page)
            || pl_residual_edge_page_write(
                &residual_graph, 0u, residual_edge_page)
            || pl_instantiation_page_write(
                &instantiations, 0u, instantiation_page)
            || pl_parameter_page_write(
                &instantiations, 0u, parameter_page)) {
        fprintf(stderr, "cannot construct graph delivery pages\n");
        free(cold_output);
        free(output);
        return 1;
    }
    pl_executable_resource resources[8] = {
        {
            .physical_address = 0u,
            .object_bytes = 0x10000u,
            .mapped_bytes = 0x10000u,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_MEMORY_BASE,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY
                   | PL_EXECUTABLE_RESOURCE_SPARSE,
        },
        {
            .physical_address = 0x4000u,
            .object_bytes = sizeof resource_page,
            .mapped_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_MEMORY_EXTENT,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address = PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_BASE,
            .object_bytes = sizeof entry_page_rows,
            .mapped_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_ENTRY_PAGE_ROWS,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address = PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_BASE,
            .object_bytes = sizeof entry_tail_row,
            .mapped_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .page_bytes = PL_EXECUTABLE_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_ENTRY_TAIL_ROW,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address =
                PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_BASE,
            .object_bytes = PL_RESIDUAL_STATE_PAGE_USED,
            .mapped_bytes = PL_RESIDUAL_PAGE_BYTES,
            .page_bytes = PL_RESIDUAL_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_RESIDUAL_STATE_PAGE,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address =
                PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_BASE,
            .object_bytes = PL_RESIDUAL_EDGE_PAGE_USED,
            .mapped_bytes = PL_RESIDUAL_PAGE_BYTES,
            .page_bytes = PL_RESIDUAL_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_RESIDUAL_EDGE_PAGE,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address =
                PL_EXECUTABLE_RESOURCE_INSTANTIATION_BASE,
            .object_bytes = PL_INSTANTIATION_PAGE_USED,
            .mapped_bytes = PL_INSTANTIATION_PAGE_BYTES,
            .page_bytes = PL_INSTANTIATION_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_INSTANTIATION_PAGE,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
        {
            .physical_address = PL_EXECUTABLE_RESOURCE_PARAMETER_BASE,
            .object_bytes = PL_PARAMETER_PAGE_HEADER + 2u * 8u,
            .mapped_bytes = PL_PARAMETER_PAGE_BYTES,
            .page_bytes = PL_PARAMETER_PAGE_BYTES,
            .kind = PL_EXECUTABLE_RESOURCE_PARAMETER_PAGE,
            .flags = PL_EXECUTABLE_RESOURCE_READ_ONLY,
        },
    };
    fill_digest(resources[0].digest, 0x70u);
    pl_sha256_digest(
        resource_page, sizeof resource_page, resources[1].digest);
    pl_sha256_digest(
        entry_page_rows, sizeof entry_page_rows, resources[2].digest);
    pl_sha256_digest(
        entry_tail_row, sizeof entry_tail_row, resources[3].digest);
    pl_sha256_digest(
        residual_state_page, PL_RESIDUAL_STATE_PAGE_USED,
        resources[4].digest);
    pl_sha256_digest(
        residual_edge_page, PL_RESIDUAL_EDGE_PAGE_USED,
        resources[5].digest);
    pl_sha256_digest(
        instantiation_page, PL_INSTANTIATION_PAGE_USED,
        resources[6].digest);
    pl_sha256_digest(
        parameter_page, (pl_u32)resources[7].object_bytes,
        resources[7].digest);
    pl_u8 binding_rows[2][PL_EXECUTABLE_BINDING_BYTES];
    pl_u8 module_rows[2][PL_EXECUTABLE_MODULE_BYTES];
    pl_u8 resource_rows[8][PL_EXECUTABLE_RESOURCE_BYTES];
    pl_u8 binding_node[PL_INDEX_NODE_BYTES];
    pl_u8 module_node[PL_INDEX_NODE_BYTES];
    pl_u8 resource_node[PL_INDEX_NODE_BYTES];
    pl_u32 binding_node_bytes = 0u;
    pl_u32 module_node_bytes = 0u;
    pl_u32 resource_node_bytes = 0u;
    pl_index_ref binding_index, module_index, resource_index;
    status = pl_executable_binding_write(&bindings[0], binding_rows[0])
           || pl_executable_binding_write(&bindings[1], binding_rows[1])
           || pl_executable_module_write(&modules[0], module_rows[0])
           || pl_executable_module_write(&modules[1], module_rows[1])
           || pl_executable_resource_write(&resources[0], resource_rows[0])
           || pl_executable_resource_write(&resources[1], resource_rows[1])
           || pl_executable_resource_write(&resources[7], resource_rows[2])
           || pl_executable_resource_write(&resources[4], resource_rows[3])
           || pl_executable_resource_write(&resources[5], resource_rows[4])
           || pl_executable_resource_write(&resources[2], resource_rows[5])
           || pl_executable_resource_write(&resources[6], resource_rows[6])
           || pl_executable_resource_write(&resources[3], resource_rows[7])
           || pl_index_leaf_write(
                binding_rows[0], PL_EXECUTABLE_BINDING_BYTES, 2u,
                binding_node, sizeof binding_node, &binding_node_bytes)
           || pl_index_ref_from_node(
                binding_node, binding_node_bytes, &binding_index)
           || pl_index_leaf_write(
                module_rows[0], PL_EXECUTABLE_MODULE_BYTES, 2u,
                module_node, sizeof module_node, &module_node_bytes)
           || pl_index_ref_from_node(
                module_node, module_node_bytes, &module_index)
           || pl_index_leaf_write(
                resource_rows[0], PL_EXECUTABLE_RESOURCE_BYTES, 8u,
                resource_node, sizeof resource_node,
                &resource_node_bytes)
           || pl_index_ref_from_node(
                resource_node, resource_node_bytes, &resource_index);
    if (status) {
        fprintf(stderr, "cannot construct executable indexes (%d)\n", status);
        free(cold_output);
        free(output);
        return 1;
    }
    pl_executable_state initial_state = {
        .rip = 0x1000u,
        .rflags = 2u,
        .cr4 = 1u << 9u,
        .efer = 1u << 10u,
        .mxcsr = 0x1f80u,
        .x87_control = 0x037fu,
        .x87_tag = 0xffffu,
    };
    pl_executable_spec root_spec = {
        .entry_rip = 0x1000u,
        .entry_generation = 0u,
        .entry_function = 0u,
        .function_count = 23u,
        .source_bytes = PL_EXECUTABLE_PAGE_BYTES,
        .source_digest = source_digest,
        .memory_bytes = 0x10000u,
        .external_bytes = written + cold_written + sizeof resource_page
                        + sizeof entry_page_rows + sizeof entry_tail_row
                        + PL_RESIDUAL_STATE_PAGE_USED
                        + PL_RESIDUAL_EDGE_PAGE_USED
                        + PL_INSTANTIATION_PAGE_USED
                        + resources[7].object_bytes,
        .entry_page_count = 1u,
        .entry_tail_row_count = 1u,
        .state = &initial_state,
        .bindings = &binding_index,
        .modules = &module_index,
        .resources = &resource_index,
    };
    pl_u64 root_bytes = 0u;
    status = pl_executable_measure(&root_spec, &root_bytes);
    if (status || root_bytes > 0xffffffffu) {
        fprintf(stderr, "cannot measure executable root (%d)\n", status);
        free(cold_output);
        free(output);
        return 1;
    }
    pl_u8 *root = malloc((pl_u32)root_bytes);
    pl_u64 root_written = 0u;
    if (!root || pl_executable_write(
            &root_spec, root, root_bytes, &root_written)
            || root_written != root_bytes
            || !save(argv[2], root, (pl_u32)root_written)
            || !save(argv[3], binding_node, binding_node_bytes)
            || !save(argv[4], module_node, module_node_bytes)
            || !save(argv[5], resource_node, resource_node_bytes)
            || !save(argv[6], resource_page, sizeof resource_page)
            || !save(argv[7], entry_page_rows, sizeof entry_page_rows)
            || !save(argv[8], entry_tail_row, sizeof entry_tail_row)
            || !save(argv[10], residual_state_page,
                     PL_RESIDUAL_STATE_PAGE_USED)
            || !save(argv[11], residual_edge_page,
                     PL_RESIDUAL_EDGE_PAGE_USED)
            || !save(argv[12], instantiation_page,
                     PL_INSTANTIATION_PAGE_USED)
            || !save(argv[13], parameter_page,
                     (pl_u32)resources[7].object_bytes)) {
        fprintf(stderr, "cannot save executable root\n");
        free(root);
        free(cold_output);
        free(output);
        return 1;
    }
    pl_executable_spec residual_root_spec = root_spec;
    /* The root entry remains the page dispatcher.  Residual state zero then
     * selects topology 21 through its instantiation row, proving the cold
     * topology module is admitted on demand rather than preloaded. */
    residual_root_spec.entry_function = 20u;
    residual_root_spec.residual_count = residual_graph.state_count;
    residual_root_spec.residual_edge_count = residual_graph.edge_count;
    residual_root_spec.entry_residual = 0u;
    residual_root_spec.residual_flags = PL_EXECUTABLE_RESIDUAL_GRAPH;
    residual_root_spec.instantiation_count =
        instantiations.instantiation_count;
    residual_root_spec.parameter_word_count =
        instantiations.parameter_word_count;
    pl_u64 residual_root_bytes = 0u;
    status = pl_executable_measure(
        &residual_root_spec, &residual_root_bytes);
    pl_u8 *residual_root = status || residual_root_bytes > 0xffffffffu
        ? NULL : malloc((pl_u32)residual_root_bytes);
    pl_u64 residual_root_written = 0u;
    if (!residual_root || pl_executable_write(
            &residual_root_spec, residual_root, residual_root_bytes,
            &residual_root_written)
            || residual_root_written != residual_root_bytes
            || !save(argv[9], residual_root,
                     (pl_u32)residual_root_written)) {
        fprintf(stderr, "cannot save residual executable root (%d)\n",
                status);
        free(residual_root);
        free(root);
        free(cold_output);
        free(output);
        return 1;
    }
    free(residual_root);
    free(root);
    free(cold_output);
    free(output);
    printf("C emitter wrote %u-byte direct module and %llu-byte root\n",
           written, (unsigned long long)root_written);
    return 0;
}
