/* Physical-region regressions which must close before native emission. */

#include <stdio.h>

#include "../src/internal/form-block.h"

#define ARENA_BYTES (64u * 1024u)

int main(void)
{
    pl_node nodes[8] = {
        { PL_OPCODE_ALU_IMMEDIATE[1][1], 0u, 2u },
        { PL_OPCODE_LANE64_INSERT,        2u, 3u },
        { PL_OPCODE_MULR,                 5u, 2u },
        { PL_OPCODE_LANE64_INSERT,        7u, 3u },
        { PL_OPCODE_LANE64_SHL,          10u, 2u },
        { PL_OPCODE_LANE64_INSERT,       12u, 3u },
        { PL_OPCODE_EXTEND32_S,          15u, 1u },
        { PL_OPCODE_LANE64_INSERT,       16u, 3u },
    };
    pl_operand arguments[19] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_CONST, 1u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_NODE, 1u },
        { PL_OPERAND_CONST, 32u },
        { PL_OPERAND_LOCAL, 1u }, { PL_OPERAND_LOCAL, 2u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_NODE, 3u },
        { PL_OPERAND_CONST, 32u },
        { PL_OPERAND_LOCAL, 3u }, { PL_OPERAND_CONST, 5u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_NODE, 5u },
        { PL_OPERAND_CONST, 32u },
        { PL_OPERAND_LOCAL, 4u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_NODE, 7u },
        { PL_OPERAND_CONST, 32u },
    };
    pl_operand locals[5] = {
        { PL_OPERAND_NODE, 2u }, { PL_OPERAND_NODE, 4u },
        { PL_OPERAND_NODE, 6u }, { PL_OPERAND_NODE, 8u },
        { PL_OPERAND_LOCAL, 4u },
    };
    pl_plan input = {
        .nodes = nodes,
        .node_count = 8u,
        .arguments = arguments,
        .argument_count = 19u,
        .locals = locals,
        .local_count = 5u,
    };
    pl_u8 first_storage[ARENA_BYTES];
    pl_u8 second_storage[ARENA_BYTES];
    pl_arena first = { first_storage, sizeof first_storage, 0u };
    pl_arena second = { second_storage, sizeof second_storage, 0u };
    pl_plan folded = { 0 }, compacted = { 0 };
    int status = pl_fold_local_physical(&input, &first, &folded);
    if (!status) status = pl_compact_once(&folded, &second, &compacted);
    const pl_u32 expected[4] = {
        PL_OPCODE_ALU_IMMEDIATE[0][1],
        PL_OPCODE_LANE32_MULR,
        PL_OPCODE_LANE32_SHL,
        PL_OPCODE_LANE32_WRAP_I64,
    };
    if (!status && (compacted.node_count != 4u || compacted.span != 1u))
        status = PL_ERROR_PLAN;
    for (pl_u32 index = 0u; !status && index < 4u; ++index) {
        if (compacted.nodes[index].opcode != expected[index]
                || compacted.locals[index].kind != PL_OPERAND_NODE
                || compacted.locals[index].value != index + 1u)
            status = PL_ERROR_PLAN;
    }

    pl_node select_nodes[4] = {
        { PL_OPCODE_LANE64_INSERT, 0u, 3u },
        { PL_OPCODE_LANE64_INSERT, 3u, 3u },
        { PL_OPCODE_LANE64_SELECT, 6u, 3u },
        { PL_OPCODE_LANE64_INSERT, 9u, 3u },
    };
    pl_operand select_arguments[12] = {
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_LOCAL, 0u },
        { PL_OPERAND_CONST, 32u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_CONST, 32u },
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_NODE, 2u },
        { PL_OPERAND_LOCAL, 2u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_NODE, 3u },
        { PL_OPERAND_CONST, 32u },
    };
    pl_operand select_locals[3] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_NODE, 4u },
    };
    pl_plan select_input = {
        .nodes = select_nodes,
        .node_count = 4u,
        .arguments = select_arguments,
        .argument_count = 12u,
        .locals = select_locals,
        .local_count = 3u,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(
            &select_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 3u
            || compacted.locals[2].kind != PL_OPERAND_NODE
            || compacted.nodes[2].opcode != PL_OPCODE_LANE64_SELECT))
        status = PL_ERROR_PLAN;

    /* Conditional mask accumulation is an OR monoid, not a serial CMOV
     * recurrence.  Both masks must be selected independently before the two
     * OR levels; extending the chain adds one OR wave, not two mask+CMOV
     * waves. */
    pl_node mask_nodes[4] = {
        { PL_OPCODE_ALU_IMMEDIATE[0][3], 0u, 2u },
        { PL_OPCODE_LANE64_SELECT,       2u, 3u },
        { PL_OPCODE_ALU_IMMEDIATE[0][3], 5u, 2u },
        { PL_OPCODE_LANE64_SELECT,       7u, 3u },
    };
    pl_operand mask_arguments[10] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_CONST, 0x10u },
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_LOCAL, 0u },
        { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_NODE, 2u }, { PL_OPERAND_CONST, 0x20u },
        { PL_OPERAND_NODE, 3u }, { PL_OPERAND_NODE, 2u },
        { PL_OPERAND_LOCAL, 2u },
    };
    pl_operand mask_locals[3] = {
        { PL_OPERAND_NODE, 4u }, { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_LOCAL, 2u },
    };
    pl_plan mask_input = {
        .nodes = mask_nodes,
        .node_count = 4u,
        .arguments = mask_arguments,
        .argument_count = 10u,
        .locals = mask_locals,
        .local_count = 3u,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&mask_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 4u || compacted.span != 3u
            || compacted.locals[0].kind != PL_OPERAND_NODE))
        status = PL_ERROR_PLAN;

    /* This is the arithmetic core emitted by GCC's empty tm-clone table
     * count.  Once the two address ranks subtract to zero, successive
     * substitution must erase every value node rather than retain four
     * scalar operations which all compute zero. */
    pl_node shift_nodes[4] = {
        { PL_OPCODE_LANE64_SHR, 0u, 2u },
        { PL_OPCODE_LANE64_SAR, 2u, 2u },
        { PL_OPCODE_ALU_REGISTER[1][1], 4u, 2u },
        { PL_OPCODE_LANE64_SAR, 6u, 2u },
    };
    pl_operand shift_arguments[8] = {
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_CONST, 63u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_CONST, 3u },
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_NODE, 2u },
        { PL_OPERAND_NODE, 3u }, { PL_OPERAND_CONST, 1u },
    };
    pl_operand shift_locals[1] = {
        { PL_OPERAND_NODE, 4u },
    };
    pl_plan shift_input = {
        .nodes = shift_nodes,
        .node_count = 4u,
        .arguments = shift_arguments,
        .argument_count = 8u,
        .locals = shift_locals,
        .local_count = 1u,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&shift_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count
            || compacted.locals[0].kind != PL_OPERAND_CONST
            || compacted.locals[0].value))
        status = PL_ERROR_PLAN;

    /* Commutative source order is not an observable instruction fact. Two
     * reversed additions must therefore become one physical node, reducing
     * real work rather than merely compressing two spellings. */
    pl_node commutative_nodes[2] = {
        { PL_OPCODE_ALU_REGISTER[1][1], 0u, 2u },
        { PL_OPCODE_ALU_REGISTER[1][1], 2u, 2u },
    };
    pl_operand commutative_arguments[4] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_LOCAL, 1u }, { PL_OPERAND_LOCAL, 0u },
    };
    pl_operand commutative_locals[2] = {
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_NODE, 2u },
    };
    pl_plan commutative_input = {
        .nodes = commutative_nodes,
        .node_count = 2u,
        .arguments = commutative_arguments,
        .argument_count = 4u,
        .locals = commutative_locals,
        .local_count = 2u,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(
            &commutative_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 1u || compacted.span != 1u
            || compacted.locals[0].kind != PL_OPERAND_NODE
            || compacted.locals[1].kind != PL_OPERAND_NODE
            || compacted.locals[0].value != compacted.locals[1].value))
        status = PL_ERROR_PLAN;

    /* Successive substitution may expose the constant on the inner side of
     * an associative add.  This is one LEA coordinate, so the physical graph
     * must contain one ADD3 node rather than a serial two-node chain. */
    pl_node affine_nodes[2] = {
        { PL_OPCODE_ALU_IMMEDIATE[1][1], 0u, 2u },
        { PL_OPCODE_ALU_REGISTER[1][1],  2u, 2u },
    };
    pl_operand affine_arguments[4] = {
        { PL_OPERAND_LOCAL, 3u }, { PL_OPERAND_CONST, 4u },
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_NODE, 1u },
    };
    pl_operand affine_locals[1] = {
        { PL_OPERAND_NODE, 2u },
    };
    pl_plan affine_input = {
        .nodes = affine_nodes,
        .node_count = 2u,
        .arguments = affine_arguments,
        .argument_count = 4u,
        .locals = affine_locals,
        .local_count = 1u,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&affine_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 1u || compacted.span != 1u
            || compacted.nodes[0].opcode != PL_OPCODE_ADD3[1]
            || compacted.nodes[0].argument_count != 3u
            || compacted.locals[0].kind != PL_OPERAND_NODE
            || compacted.locals[0].value != 1u))
        status = PL_ERROR_PLAN;

    /* An ADD3 that names no constant cannot absorb an outer addend.  The
     * physical form of `ADD3(a,b,c) + k` must stay a two-input node over the
     * ADD3; rewriting the operands without a constant slot to fold into would
     * truncate it to a node over (a,b), dropping both c and k. */
    pl_node add3_add_nodes[2] = {
        { PL_OPCODE_ADD3[1],             0u, 3u },
        { PL_OPCODE_ALU_IMMEDIATE[1][1], 3u, 2u },
    };
    pl_operand add3_add_arguments[5] = {
        { PL_OPERAND_LOCAL, 0u }, { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_LOCAL, 2u },
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_CONST, 9u },
    };
    pl_operand add3_add_locals[1] = {
        { PL_OPERAND_NODE, 2u },
    };
    pl_plan add3_add_input = {
        .nodes = add3_add_nodes,
        .node_count = 2u,
        .arguments = add3_add_arguments,
        .argument_count = 5u,
        .locals = add3_add_locals,
        .local_count = 1u,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&add3_add_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 2u
            || compacted.nodes[1].opcode != PL_OPCODE_ALU_IMMEDIATE[1][1]
            || compacted.nodes[1].argument_count != 2u
            || compacted.arguments[compacted.nodes[1].argument_at].kind
                != PL_OPERAND_NODE
            || compacted.arguments[compacted.nodes[1].argument_at].value != 1u
            || compacted.arguments[compacted.nodes[1].argument_at + 1u].kind
                != PL_OPERAND_CONST
            || compacted.arguments[compacted.nodes[1].argument_at + 1u].value
                != 9u))
        status = PL_ERROR_PLAN;

    /* A block-local exact observation retains the final flag producer even
     * when the successor can never read it. Complete-future projection makes
     * that distinction explicit: the RSP publication is live, RFLAGS is not.
     * Once (rsp-8)+8 has already substituted to rsp, the projected compacted
     * form must contain no work at all. */
    pl_node cancel_nodes[3] = {
        { PL_OPCODE_ALU_IMMEDIATE[1][2], 0u, 2u },
        { PL_OPCODE_ALU_IMMEDIATE[1][1], 2u, 2u },
        { PL_OPCODE_X86_COMPARE,         4u, 4u },
    };
    pl_operand cancel_arguments[8] = {
        { PL_OPERAND_LOCAL, 4u }, { PL_OPERAND_CONST, 8u },
        { PL_OPERAND_NODE, 1u }, { PL_OPERAND_CONST, 8u },
        { PL_OPERAND_LOCAL, 16u }, { PL_OPERAND_NODE, 2u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_CONST, 0x340u },
    };
    pl_operand cancel_locals[PL_X86_LOCAL_COUNT];
    pl_u8 cancel_live[PL_X86_LOCAL_COUNT] = { 0 };
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
        cancel_locals[local].kind = PL_OPERAND_LOCAL;
        cancel_locals[local].value = local;
    }
    cancel_locals[4].kind = PL_OPERAND_NODE;
    cancel_locals[4].value = 2u;
    cancel_locals[16].kind = PL_OPERAND_NODE;
    cancel_locals[16].value = 3u;
    cancel_live[4] = 1u;
    pl_plan cancel_input = {
        .nodes = cancel_nodes,
        .node_count = 3u,
        .arguments = cancel_arguments,
        .argument_count = 8u,
        .locals = cancel_locals,
        .local_count = PL_X86_LOCAL_COUNT,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&cancel_input, &first, &folded);
    if (!status)
        status = pl_compact_projected_once(
            &folded, cancel_live, &second, &compacted);
    if (!status && (compacted.node_count || compacted.span
            || compacted.locals[4].kind != PL_OPERAND_LOCAL
            || compacted.locals[4].value != 4u
            || compacted.locals[16].kind != PL_OPERAND_LOCAL
            || compacted.locals[16].value != 16u))
        status = PL_ERROR_PLAN;

    /* Backward projection is a semantic preimage, not a guess that flags are
     * usually dead. With every architectural output except RFLAGS observed,
     * the cancelling RSP chain has no flag dependency. A terminal predicate
     * naming RFLAGS immediately makes that input live again. */
    pl_x86_block cancel_block = { 0 };
    cancel_block.plan = folded;
    cancel_block.kind = PL_X86_BLOCK_DIRECT;
    cancel_block.flow = PL_X86_FLOW_RETURN;
    cancel_block.machine_operation = PL_X86_MACHINE_NONE;
    pl_u32 live_without_flags = (1u << PL_X86_LOCAL_COUNT) - 1u;
    live_without_flags &= ~(1u << PL_X86_RFLAGS_LOCAL);
    pl_u32 required_inputs = 0u;
    second.used = 0u;
    if (!status)
        status = pl_x86_block_live_inputs(
            &cancel_block, live_without_flags,
            &second, &required_inputs);
    if (!status && ((required_inputs & (1u << PL_X86_RFLAGS_LOCAL))
            || !(required_inputs & (1u << 4u))))
        status = PL_ERROR_PLAN;
    cancel_block.has_predicate = 1u;
    cancel_block.predicate.kind = PL_OPERAND_LOCAL;
    cancel_block.predicate.value = PL_X86_RFLAGS_LOCAL;
    second.used = 0u;
    if (!status)
        status = pl_x86_block_live_inputs(
            &cancel_block, live_without_flags,
            &second, &required_inputs);
    if (!status
            && !(required_inputs & (1u << PL_X86_RFLAGS_LOCAL)))
        status = PL_ERROR_PLAN;

    /* REP MOVSQ reads its address, count, and direction inputs even when
     * none of its output registers are used by the following block.  This
     * is a terminal effect, not a reason to project the preceding producer
     * away. */
    pl_operand string_locals[PL_X86_LOCAL_COUNT];
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
        string_locals[local] = (pl_operand){ PL_OPERAND_LOCAL, local };
    pl_x86_block string_block = { 0 };
    string_block.plan.locals = string_locals;
    string_block.plan.local_count = PL_X86_LOCAL_COUNT;
    string_block.machine_operation = PL_X86_MACHINE_STRING;
    string_block.machine_argument = 8u | (64ull << 8u) | (3ull << 16u);
    string_block.machine_inputs = (1u << 1u) | (1u << 6u) | (1u << 7u)
                                | (1u << PL_X86_RFLAGS_LOCAL);
    second.used = 0u;
    if (!status)
        status = pl_x86_block_live_inputs(
            &string_block, 0u, &second, &required_inputs);
    pl_u32 string_reads = (1u << 1u) | (1u << 6u) | (1u << 7u)
                        | (1u << PL_X86_RFLAGS_LOCAL);
    if (!status && required_inputs != string_reads)
        status = PL_ERROR_PLAN;

    /* MOVQ XMM1,RSI crosses the vector machine cut, but its scalar source
     * is still an observable input.  A caller's MOV RSI,R15 must not become
     * identity merely because no GPR output of MOVQ is live. */
    pl_x86_block vector_block = { 0 };
    vector_block.plan.locals = string_locals;
    vector_block.plan.local_count = PL_X86_LOCAL_COUNT;
    vector_block.machine_operation = PL_X86_MACHINE_VECTOR;
    vector_block.machine_argument = 13u | (1ull << 8u)
                                  | (12ull << 32u);
    vector_block.machine_inputs = 1u << 6u;
    second.used = 0u;
    if (!status)
        status = pl_x86_block_live_inputs(
            &vector_block, 0u, &second, &required_inputs);
    if (!status && required_inputs != (1u << 6u))
        status = PL_ERROR_PLAN;

    /* CPUID always observes both leaf and subleaf, even if every result is
     * dead. Its implicit inputs must survive backward future projection. */
    pl_x86_block cpuid_block = { 0 };
    cpuid_block.plan.locals = string_locals;
    cpuid_block.plan.local_count = PL_X86_LOCAL_COUNT;
    cpuid_block.machine_operation = PL_X86_MACHINE_CPUID;
    cpuid_block.machine_inputs = (1u << 0u) | (1u << 1u);
    second.used = 0u;
    if (!status)
        status = pl_x86_block_live_inputs(
            &cpuid_block, 0u, &second, &required_inputs);
    if (!status && required_inputs != ((1u << 0u) | (1u << 1u)))
        status = PL_ERROR_PLAN;

    /* TEST(x,x) may still publish flags, but its zero guard cannot change
     * x & mask: both arms are zero when x is zero.  A test of a different
     * input must retain the selection. */
    pl_node guard_nodes[4] = {
        { PL_OPCODE_ALU_IMMEDIATE[1][0], 0u, 2u },
        { PL_OPCODE_X86_TEST, 2u, 4u },
        { PL_OPCODE_X86_CONDITION, 6u, 2u },
        { PL_OPCODE_LANE64_SELECT, 8u, 3u },
    };
    pl_operand guard_arguments[11] = {
        { PL_OPERAND_LOCAL, 2u }, { PL_OPERAND_CONST, ~1ull },
        { PL_OPERAND_LOCAL, PL_X86_RFLAGS_LOCAL },
        { PL_OPERAND_LOCAL, 2u }, { PL_OPERAND_LOCAL, 2u },
        { PL_OPERAND_CONST, 64u },
        { PL_OPERAND_NODE, 2u }, { PL_OPERAND_CONST, 4u },
        { PL_OPERAND_CONST, 0u }, { PL_OPERAND_NODE, 1u },
        { PL_OPERAND_NODE, 3u },
    };
    pl_operand guard_locals[PL_X86_LOCAL_COUNT];
    for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local)
        guard_locals[local] = (pl_operand){ PL_OPERAND_LOCAL, local };
    guard_locals[0] = (pl_operand){ PL_OPERAND_NODE, 4u };
    guard_locals[PL_X86_RFLAGS_LOCAL] =
        (pl_operand){ PL_OPERAND_NODE, 2u };
    pl_plan guard_input = {
        .nodes = guard_nodes,
        .node_count = 4u,
        .arguments = guard_arguments,
        .argument_count = 11u,
        .locals = guard_locals,
        .local_count = PL_X86_LOCAL_COUNT,
    };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&guard_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 2u
            || compacted.locals[0].kind != PL_OPERAND_NODE
            || compacted.locals[0].value != 1u
            || compacted.locals[PL_X86_RFLAGS_LOCAL].kind != PL_OPERAND_NODE
            || compacted.locals[PL_X86_RFLAGS_LOCAL].value != 2u))
        status = PL_ERROR_PLAN;
    guard_arguments[4] = (pl_operand){ PL_OPERAND_LOCAL, 3u };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&guard_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 4u
            || compacted.nodes[3].opcode != PL_OPCODE_LANE64_SELECT))
        status = PL_ERROR_PLAN;
    guard_arguments[4] = (pl_operand){ PL_OPERAND_LOCAL, 2u };
    guard_arguments[9] = (pl_operand){ PL_OPERAND_LOCAL, 2u };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&guard_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 1u
            || compacted.locals[0].kind != PL_OPERAND_LOCAL
            || compacted.locals[0].value != 2u))
        status = PL_ERROR_PLAN;
    guard_arguments[8] = (pl_operand){ PL_OPERAND_NODE, 1u };
    guard_arguments[9] = (pl_operand){ PL_OPERAND_CONST, 0u };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&guard_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 1u
            || compacted.locals[0].kind != PL_OPERAND_CONST
            || compacted.locals[0].value != 0u))
        status = PL_ERROR_PLAN;
    guard_arguments[8] = (pl_operand){ PL_OPERAND_CONST, 0u };
    guard_arguments[9] = (pl_operand){ PL_OPERAND_NODE, 1u };
    guard_arguments[5] = (pl_operand){ PL_OPERAND_CONST, 32u };
    first.used = 0u;
    second.used = 0u;
    if (!status)
        status = pl_fold_local_physical(&guard_input, &first, &folded);
    if (!status)
        status = pl_compact_once(&folded, &second, &compacted);
    if (!status && (compacted.node_count != 4u
            || compacted.nodes[3].opcode != PL_OPCODE_LANE64_SELECT))
        status = PL_ERROR_PLAN;

    /* Machine effects observe decoded scalar inputs independently of which
     * architectural outputs their successors keep. Include implicit and
     * conditional reads, not just a visible address or one hand-written ISA
     * family. No privileged instruction is executed by this check. */
    static const struct {
        pl_u8 code[7];
        pl_u32 bytes;
        pl_u32 inputs;
    } machine_cases[] = {
        { { 0x0fu, 0xa2u }, 2u, 0x03u },
        { { 0x48u, 0x0fu, 0xc7u, 0x0fu }, 4u, 0x8fu },
        { { 0x0fu, 0x32u }, 2u, 0x02u },
        { { 0x0fu, 0x30u }, 2u, 0x07u },
        { { 0x0fu, 0x22u, 0xd8u }, 3u, 0x01u },
        { { 0x66u, 0x48u, 0x0fu, 0x6eu, 0xceu }, 5u, 1u << 6u },
        { { 0xf3u, 0x48u, 0xa5u }, 3u, 0x100c2u },
        { { 0xf3u, 0x48u, 0xabu }, 3u, 0x10083u },
        { { 0x48u, 0x0fu, 0xb1u, 0x17u }, 4u, 0x85u },
        { { 0xf0u, 0x48u, 0x0fu, 0xc1u, 0x37u }, 5u, 0xc0u },
        { { 0x48u, 0x87u, 0x37u }, 3u, 0xc0u },
        { { 0x64u, 0xf0u, 0x48u, 0x0fu, 0xc1u, 0x37u }, 6u, 0x200c0u },
        { { 0x65u, 0x48u, 0x0fu, 0xc7u, 0x0fu }, 5u, 0x4008fu },
        { { 0x0fu, 0xaeu, 0xf0u }, 3u, 0u },
    };
    for (pl_u32 index = 0u; !status
            && index < sizeof machine_cases / sizeof machine_cases[0]; ++index) {
        const pl_u8 *code = machine_cases[index].code;
        pl_u32 bytes = machine_cases[index].bytes;
        pl_u32 expected_inputs = machine_cases[index].inputs;
        pl_x86_map map = { code, 0x1000u, bytes, bytes,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u };
        pl_x86_image image = { &map, 1u, 0u, map.address };
        pl_x86_frontend frontend;
        pl_x86_block_workspace workspace = {
            first_storage, second_storage, sizeof first_storage, 16u };
        pl_x86_block machine;
        pl_u8 live_storage[4096];
        pl_arena live_arena = { live_storage, sizeof live_storage, 0u };
        status = pl_x86_frontend_open(&image, &frontend);
        if (!status) status = pl_x86_block_lower_until(
            &frontend, map.address, map.address + bytes, &workspace, &machine);
        if (!status) status = pl_x86_block_live_inputs(
            &machine, 0u, &live_arena, &required_inputs);
        if (!status && required_inputs != expected_inputs) status = PL_ERROR_PLAN;
        if (status) fprintf(stderr, "machine inputs: RED (%u status=%d mask=%x want=%x)\n",
            index, status, required_inputs, expected_inputs);
    }

    if (status) {
        fprintf(stderr, "physical region: RED (%d)\n", status);
        return 1;
    }
    printf("physical region: green "
           "(lane64 and constant-shift materializations removed; "
           "conditional masks detached; commutative work shared; "
           "affine chains collapsed; zero-guarded values selected directly; "
           "terminal-safe future work projected)\n");
    return 0;
}
