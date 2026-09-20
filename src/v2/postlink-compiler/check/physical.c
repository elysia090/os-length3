/* Physical-region regressions which must close before native emission. */

#include <stdio.h>

#include "../src/internal/block.h"

#define ARENA_BYTES (64u * 1024u)

static int signed_projection_demand(void)
{
    for (pl_u32 width=8u;width<=32u;width*=2u)
        for (pl_u32 removed=0u;removed<2u;++removed) {
            pl_u32 opcode=width==8u ? PL_OPCODE_LANE64_EXTEND8_S
                : width==16u ? PL_OPCODE_LANE64_EXTEND16_S:PL_OPCODE_EXTEND32_S;
            pl_node nodes[2]={{PL_OPCODE_ALU_IMMEDIATE[0][0],0u,2u},{opcode,2u,1u}};
            pl_operand arguments[3]={{PL_OPERAND_LOCAL,0u},
                {PL_OPERAND_CONST,((1ull<<width)-1u)&~(pl_u64)removed},{PL_OPERAND_NODE,1u}};
            pl_operand local={PL_OPERAND_NODE,2u};
            pl_plan input={.nodes=nodes,.node_count=2u,.arguments=arguments,
                .argument_count=3u,.locals=&local,.local_count=1u};
            pl_u8 a[ARENA_BYTES],b[ARENA_BYTES];
            pl_arena first={a,sizeof a,0u},second={b,sizeof b,0u};
            pl_plan folded={0},compacted={0};
            int status=pl_fold_local_physical(&input,&first,&folded);
            if (!status) status=pl_compact_once(&folded,&second,&compacted);
            if (status || compacted.node_count!=1u+removed
                    || compacted.nodes[compacted.node_count-1u].opcode!=opcode) {
                fprintf(stderr,"signed projection demand: RED width=%u removed=%u status=%d nodes=%u\n",
                    width,removed,status,compacted.node_count);
                return 1;
            }
        }
    return 0;
}

static int overlay_bias(void)
{
    /* ((x | 32) & 255) - 97 = (x & 223) - 65, modulo 2^32.
     * Disjoint fixed bits are an additive constant, not another live node. */
    pl_node nodes[] = {
        {PL_OPCODE_ALU_IMMEDIATE[0][3],0u,2u},
        {PL_OPCODE_LANE64_INSERT,2u,3u},
        {PL_OPCODE_ALU_IMMEDIATE[0][1],5u,2u},
    };
    pl_operand arguments[] = {
        {PL_OPERAND_LOCAL,0u},{PL_OPERAND_CONST,32u},
        {PL_OPERAND_CONST,0u},{PL_OPERAND_NODE,1u},{PL_OPERAND_CONST,8u},
        {PL_OPERAND_NODE,2u},{PL_OPERAND_CONST,0xffffff9fu},
    };
    pl_operand local = {PL_OPERAND_NODE,3u};
    pl_plan input = {.nodes=nodes,.node_count=3u,.arguments=arguments,
        .argument_count=7u,.locals=&local,.local_count=1u};
    pl_u8 a[ARENA_BYTES],b[ARENA_BYTES];
    pl_arena first = {a,sizeof a,0u}, second = {b,sizeof b,0u};
    pl_plan folded = {0}, compacted = {0};
    int status = pl_fold_local_physical(&input,&first,&folded);
    if (!status) status = pl_compact_once(&folded,&second,&compacted);
    if (status || compacted.node_count != 2u
            || compacted.nodes[0].opcode != PL_OPCODE_ALU_IMMEDIATE[0][0]
            || compacted.arguments[1].value != 223u
            || compacted.nodes[1].opcode != PL_OPCODE_ALU_IMMEDIATE[0][1]
            || compacted.arguments[3].value != 0xffffffbfu) {
        fprintf(stderr,"overlay bias: RED status=%d nodes=%u\n",status,compacted.node_count);
        for (pl_u32 i=0u; !status && i<compacted.node_count; ++i) {
            const pl_node *node=&compacted.nodes[i];
            fprintf(stderr,"  opcode=%u",node->opcode);
            for (pl_u32 j=0u;j<node->argument_count;++j) {
                pl_operand value=compacted.arguments[node->argument_at+j];
                fprintf(stderr," %u:%llx",value.kind,(unsigned long long)value.value);
            }
            fputc('\n',stderr);
        }
        return 1;
    }
    return 0;
}

static int scaled_linear_word(void)
{
    /* ((x + (x << a)) << b) = x * ((1 + 2^a) * 2^b) modulo 2^W.
     * Sign extension is an opaque shared input to this word identity. */
    for (pl_u32 variant=0u;variant<4u;++variant) {
        pl_u32 lane=variant&1u,subtract=variant>>1u;
        for (pl_u32 a=1u;a<=3u;++a)
            for (pl_u32 b=1u;b<=4u;++b) {
                pl_node nodes[]={
                    {lane ? PL_OPCODE_LANE64_SHL:PL_OPCODE_LANE32_SHL,0u,2u},
                    {PL_OPCODE_ALU_REGISTER[lane][1u+subtract],2u,2u},
                    {lane ? PL_OPCODE_LANE64_SHL:PL_OPCODE_LANE32_SHL,4u,2u},
                };
                pl_operand arguments[]={
                    {PL_OPERAND_LOCAL,0u},{PL_OPERAND_CONST,a},
                    {PL_OPERAND_LOCAL,0u},{PL_OPERAND_NODE,1u},
                    {PL_OPERAND_NODE,2u},{PL_OPERAND_CONST,b},
                };
                pl_operand local={PL_OPERAND_NODE,3u};
                pl_plan input={.nodes=nodes,.node_count=3u,.arguments=arguments,
                    .argument_count=6u,.locals=&local,.local_count=1u};
                pl_u8 first_bytes[ARENA_BYTES],second_bytes[ARENA_BYTES];
                pl_arena first={first_bytes,sizeof first_bytes,0u};
                pl_arena second={second_bytes,sizeof second_bytes,0u};
                pl_plan folded={0},compacted={0};
                int status=pl_fold_local_physical(&input,&first,&folded);
                if (!status) status=pl_compact_once(&folded,&second,&compacted);
                if (status || compacted.node_count!=1u
                        || compacted.nodes[0].opcode!=(lane ? PL_OPCODE_MULR:PL_OPCODE_LANE32_MULR)
                        || compacted.arguments[0].kind!=PL_OPERAND_LOCAL
                        || compacted.arguments[1].kind!=PL_OPERAND_CONST
                        || compacted.arguments[1].value!=(((subtract ? 1ull-(1ull<<a)
                            :1ull+(1ull<<a))<<b)&(lane ? ~0ull:0xffffffffull))) {
                    fprintf(stderr,"scaled linear word: RED lane/a/b=%u/%u/%u status=%d nodes=%u\n",
                        lane,a,b,status,compacted.node_count);
                    return 1;
                }
            }
    }
    return 0;
}

static int scaled_word_boundaries(void)
{
    for (pl_u32 lane=0u;lane<2u;++lane)
        for (pl_u32 cancel=0u;cancel<2u;++cancel) {
            pl_u32 mul=lane ? PL_OPCODE_MULR:PL_OPCODE_LANE32_MULR;
            pl_node nodes[]={{mul,0u,2u},{mul,2u,2u},{PL_OPCODE_ALU_REGISTER[lane][2],4u,2u}};
            pl_operand arguments[]={{PL_OPERAND_LOCAL,0u},{PL_OPERAND_CONST,3u},
                {PL_OPERAND_LOCAL,0u},{PL_OPERAND_CONST,2u+cancel},
                {PL_OPERAND_NODE,1u},{PL_OPERAND_NODE,2u}};
            pl_operand local={PL_OPERAND_NODE,3u};
            pl_plan input={.nodes=nodes,.node_count=3u,.arguments=arguments,
                .argument_count=6u,.locals=&local,.local_count=1u};
            pl_u8 a[ARENA_BYTES],b[ARENA_BYTES];
            pl_arena first={a,sizeof a,0u},second={b,sizeof b,0u};
            pl_plan folded={0},compacted={0};
            int status=pl_fold_local_physical(&input,&first,&folded);
            if (!status) status=pl_compact_once(&folded,&second,&compacted);
            pl_u32 expected=!cancel && !lane;
            if (status || compacted.node_count!=expected
                    || (cancel && (compacted.locals[0].kind!=PL_OPERAND_CONST || compacted.locals[0].value))
                    || (!cancel && lane && compacted.locals[0].kind!=PL_OPERAND_LOCAL)
                    || (expected && compacted.nodes[0].opcode!=PL_OPCODE_ALU_IMMEDIATE[0][0])) {
                fprintf(stderr,"scaled word identity: RED lane/cancel=%u/%u status=%d\n",lane,cancel,status);
                return 1;
            }
        }
    /* A narrow shift is not linear in the wider ring: its truncation remains
     * observable alongside the untruncated copy of the same entry value. */
    pl_node nodes[]={{PL_OPCODE_LANE32_SHL,0u,2u},
        {PL_OPCODE_ALU_REGISTER[1][1],2u,2u},{PL_OPCODE_LANE64_SHL,4u,2u}};
    pl_operand arguments[]={{PL_OPERAND_LOCAL,0u},{PL_OPERAND_CONST,2u},
        {PL_OPERAND_LOCAL,0u},{PL_OPERAND_NODE,1u},{PL_OPERAND_NODE,2u},{PL_OPERAND_CONST,4u}};
    pl_operand local={PL_OPERAND_NODE,3u};
    pl_plan input={.nodes=nodes,.node_count=3u,.arguments=arguments,
        .argument_count=6u,.locals=&local,.local_count=1u};
    pl_u8 a[ARENA_BYTES],b[ARENA_BYTES];
    pl_arena first={a,sizeof a,0u},second={b,sizeof b,0u};
    pl_plan folded={0},compacted={0};
    int status=pl_fold_local_physical(&input,&first,&folded);
    if (!status) status=pl_compact_once(&folded,&second,&compacted);
    if (status || compacted.node_count!=3u || compacted.nodes[0].opcode!=PL_OPCODE_LANE32_SHL) {
        fprintf(stderr,"scaled word width boundary: RED status=%d nodes=%u\n",status,compacted.node_count);
        return 1;
    }
    return 0;
}

int main(void)
{
    if (scaled_linear_word()) return 1;
    if (scaled_word_boundaries()) return 1;
    if (overlay_bias()) return 1;
    if (signed_projection_demand()) return 1;
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

    if (status) {
        fprintf(stderr, "physical region: RED (%d)\n", status);
        return 1;
    }
    printf("physical region: green "
           "(lane64 and constant-shift materializations removed; "
           "conditional masks detached; commutative work shared; "
           "affine chains collapsed; terminal-safe future work projected)\n");
    return 0;
}
