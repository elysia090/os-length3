/* postlink-compose -- compose fusible pairs and print the result.
 *
 *     postlink-compose MACHINE [--vectors N]
 *
 * Without --vectors, composes every fusible pair and reports what happened.
 * With it, prints the composed graph of the first N pairs in a form
 * check/compose_parity.py can hold against qm.stepnormalize.compose_plans_raw:
 *
 *     PAIR head tail function start end instructions stack_inputs nodes args
 *     N value opcode arg_kind:arg_value ...
 *     S index kind:value
 *     L index kind:value
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/affine.h>
#include <postlink/executable.h>
#include <postlink/plan.h>
#include <postlink/trace.h>

static int header_u32(const pl_u8 *header, pl_u32 bytes, const char *path,
                      pl_u32 *value)
{
    pl_u64 wide;
    if (pl_machine_header_u64(header, bytes, path, &wide)
            || wide > 0xffffffffull)
        return PL_ERROR_CONTAINER;
    *value = (pl_u32)wide;
    return 0;
}

static int decode(const pl_u8 *execution, const pl_admission *admission,
                  pl_arena *arena, pl_plan *plan, pl_template *parsed)
{
    const pl_u8 *tmpl = execution + admission->tmpl.offset;
    if (pl_template_parse(tmpl, (pl_u32)admission->tmpl.length, parsed))
        return PL_ERROR_TEMPLATE;
    return pl_plan_decode(tmpl, parsed,
                          execution + admission->parameters.offset,
                          arena, plan);
}

static void print_operand(pl_operand operand)
{
    printf(" %u:%llu", operand.kind, (unsigned long long)operand.value);
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: postlink-compose MACHINE [--vectors N]\n");
        return 2;
    }
    long vectors = 0;
    int compacted = 0;
    if (argc >= 4 && !strcmp(argv[2], "--vectors")) vectors = atol(argv[3]);
    if (argc >= 4 && !strcmp(argv[2], "--compact")) {
        vectors = atol(argv[3]);
        compacted = 1;
    }
    int rebased = 0;
    if (argc >= 4 && !strcmp(argv[2], "--rebase")) {
        vectors = atol(argv[3]);
        rebased = 1;
    }
    int prestore = 0;
    if (argc >= 4 && !strcmp(argv[2], "--prestore")) {
        vectors = atol(argv[3]);
        prestore = 1;
    }
    int regions = 0;
    if (argc >= 4 && !strcmp(argv[2], "--regions")) {
        vectors = atol(argv[3]);
        regions = 1;
    }
    int alu = 0;
    if (argc >= 4 && !strcmp(argv[2], "--alu")) {
        vectors = atol(argv[3]);
        alu = 1;
    }
    int affine = argc >= 3 && !strcmp(argv[2], "--affine");
    int loops = argc >= 3 && !strcmp(argv[2], "--loops");
    long loop_vectors = loops && argc >= 4 ? atol(argv[3]) : 0;

    FILE *handle = fopen(argv[1], "rb");
    if (!handle) { fprintf(stderr, "cannot open %s\n", argv[1]); return 1; }
    fseek(handle, 0, SEEK_END);
    long size = ftell(handle);
    rewind(handle);
    pl_u8 *payload = size > 0 ? malloc((size_t)size) : 0;
    if (!payload || fread(payload, 1, (size_t)size, handle) != (size_t)size) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 1;
    }
    fclose(handle);

    pl_machine machine;
    if (pl_machine_parse(payload, (pl_u64)size, &machine)) {
        fprintf(stderr, "%s is not an x86 native machine\n", argv[1]);
        return 1;
    }
    const pl_u8 *header = payload + machine.header_offset;
    pl_directory_counts counts;
    memset(&counts, 0, sizeof counts);
    struct { const char *path; pl_u32 *slot; } fields[] = {
        { "block_count", &counts.block_count },
        { "step_count", &counts.step_count },
        { "template_count", &counts.template_count },
        { "guard_count", &counts.guard_count },
        { "continuation_count", &counts.continuation_count },
        { "continuation_bytes", &counts.continuation_bytes },
        { "template_execution_bytes", &counts.template_execution_bytes },
        { "parameter_execution_bytes", &counts.parameter_execution_bytes },
    };
    for (unsigned i = 0; i < sizeof fields / sizeof fields[0]; ++i)
        if (header_u32(header, machine.header_bytes, fields[i].path,
                       fields[i].slot)) {
            fprintf(stderr, "header lacks %s\n", fields[i].path);
            return 1;
        }
    counts.execution_bytes = (pl_u32)machine.execution.length;
    counts.schema = machine.schema;

    pl_directory directory;
    if (pl_directory_open(payload + machine.descriptors.offset,
                          machine.descriptors.length, &counts, &directory)) {
        fprintf(stderr, "descriptor region does not tile\n");
        return 1;
    }

    pl_u32 count = counts.block_count;
    pl_u32 *successor = malloc((size_t)count * sizeof *successor);
    pl_u8 *predecessor = malloc(count);
    if (!successor || !predecessor
            || pl_trace_edges(&directory, successor, predecessor)) {
        fprintf(stderr, "cannot read the block graph\n");
        return 1;
    }

    const pl_u8 *execution = payload + machine.execution.offset;
    pl_u32 arena_bytes = 1u << 22;
    pl_u8 *arena_bytes_base = malloc(arena_bytes);
    if (!arena_bytes_base) { fprintf(stderr, "no arena\n"); return 1; }

    unsigned long long verdicts[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
    unsigned long long composed = 0, refused = 0, undecodable = 0;
    unsigned long long nodes_in = 0, nodes_out = 0;
    unsigned long long args_in = 0, args_out = 0, materialized = 0;

    /* A loop body is a fusible run whose last block returns to its head.  That
     * is the population the recurrence closure cares about; every other fusible
     * pair is straight-line and has no iteration to collapse. */
    if (loops) {
        pl_u8 *visited = calloc(count, 1);
        pl_u32 *heads = malloc((size_t)count * sizeof *heads);
        pl_u32 *backedge = malloc((size_t)count * sizeof *backedge);
        if (!visited || !heads || !backedge
                || pl_trace_backedges(
                    &directory, successor, predecessor, heads, backedge)) {
            fprintf(stderr, "cannot close conditional backedges\n");
            return 1;
        }
        unsigned long long bodies = 0, single = 0;
        unsigned long long lengths = 0;
        for (pl_u32 index = 0; index < count; ++index) {
            if (visited[index] || heads[index] != index) continue;
            pl_u32 last = index;
            pl_u32 length = pl_trace_run(successor, predecessor, count,
                                         index, visited, &last);
            if (successor[last] != index && backedge[last] != index) continue;
            bodies += 1;
            lengths += length;
            if (length == 1u) single += 1;

            pl_arena arena = { arena_bytes_base, arena_bytes, 0 };
            pl_plan body;
            pl_template shape;
            pl_admission head;
            if (pl_directory_admit(&directory, index, &head)
                    || decode(execution, &head, &arena, &body, &shape))
                continue;
            pl_u32 cursor = index;
            int ok = 1;
            for (pl_u32 step = 1; step < length && ok; ++step) {
                cursor = successor[cursor];
                pl_admission next;
                pl_plan tail, merged;
                pl_template tail_shape;
                if (pl_directory_admit(&directory, cursor, &next)
                        || decode(execution, &next, &arena, &tail,
                                  &tail_shape)
                        || pl_compose_raw(&body, &tail, &arena, &merged))
                    ok = 0;
                else
                    body = merged;
            }
            if (!ok) { verdicts[PL_AFFINE_UNSUPPORTED] += 1; continue; }
            pl_affine report;
            if (!pl_affine_analyse_cut(
                    &body, PL_VM_X86_REGISTER_COUNT, &arena, &report)) {
                verdicts[report.verdict] += 1;
                if (loop_vectors > 0 && (long)bodies <= loop_vectors) {
                    printf("LOOP %u %u %u %u %u %u\n", index, last,
                           length, body.node_count, body.local_count,
                           (unsigned)report.verdict);
                    pl_admission terminal;
                    if (!pl_directory_admit(&directory, last, &terminal))
                        printf("K %u %llu %llu %llu\n",
                               terminal.continuation.control,
                               (unsigned long long)
                                   terminal.continuation.field[1],
                               (unsigned long long)
                                   terminal.continuation.field[2],
                               (unsigned long long)
                                   terminal.continuation.field[3]);
                    for (pl_u32 value = 0; value < body.node_count; ++value) {
                        const pl_node *node = &body.nodes[value];
                        printf("N %u %u", value + 1u, node->opcode);
                        for (pl_u32 slot = 0; slot < node->argument_count;
                             ++slot)
                            print_operand(body.arguments[
                                node->argument_at + slot]);
                        printf("\n");
                    }
                    for (pl_u32 slot = 0; slot < body.local_count; ++slot) {
                        if (body.locals[slot].kind == PL_OPERAND_LOCAL
                                && body.locals[slot].value == slot)
                            continue;
                        printf("L %u", slot);
                        print_operand(body.locals[slot]);
                        printf(" A %u %lld\n", report.slots[slot].kind,
                               (long long)report.slots[slot].step);
                    }
                    printf("M %u %u O %u C %u %u\n", report.memory_nodes,
                           report.affine_addresses, report.opaque_slot,
                           report.cut_slot_count, report.cut_node_count);
                }
            } else
                verdicts[PL_AFFINE_UNSUPPORTED] += 1;
        }
        printf("loop bodies found          %12llu\n", bodies);
        printf("  single-block bodies      %12llu\n", single);
        if (bodies)
            printf("  mean blocks per body     %12.2f\n",
                   (double)lengths / (double)bodies);
        printf("\n");
        for (unsigned index = 0; index < 6u; ++index)
            printf("  %-38s %10llu\n",
                   pl_affine_reason((pl_affine_verdict)index),
                   verdicts[index]);
        free(backedge);
        free(heads);
        free(visited);
        free(payload);
        return 0;
    }

    for (pl_u32 index = 0; index < count; ++index) {
        if (!pl_trace_fusible(successor, predecessor, index)) continue;
        pl_admission head, tail;
        if (pl_directory_admit(&directory, index, &head)
                || pl_directory_admit(&directory, successor[index], &tail))
            continue;

        pl_arena arena = { arena_bytes_base, arena_bytes, 0 };
        pl_plan first, second, joined;
        pl_template a, b;
        if (decode(execution, &head, &arena, &first, &a)
                || decode(execution, &tail, &arena, &second, &b)) {
            undecodable += 1;
            continue;
        }
        if (pl_compose_raw(&first, &second, &arena, &joined)) {
            refused += 1;
            continue;
        }
        if (alu) {
            pl_plan opened;
            if (pl_reopen_consumed_x86_alu(&joined, &arena, &opened)) {
                refused += 1;
                continue;
            }
            joined = opened;
        }
        if (regions) {
            pl_plan opened;
            if (pl_reopen_load_regions(&joined, &arena, &opened)) {
                refused += 1;
                continue;
            }
            joined = opened;
        }
        if (prestore) {
            pl_plan chained;
            if (pl_reopen_pre_store_chains(&joined, &arena, &chained)) {
                refused += 1;
                continue;
            }
            joined = chained;
        }
        if (rebased) {
            pl_plan flagged;
            if (pl_rebase_overwritten_flags(&joined, &arena, &flagged)) {
                refused += 1;
                continue;
            }
            joined = flagged;
        }
        if (compacted) {
            pl_plan settled;
            /* The caller is expected to hand pl_compact a rewrite-stable plan;
             * here the parity restricts itself to pairs the reference rewriter
             * leaves alone, which is what makes the comparison meaningful. */
            if (pl_compact(&joined, &arena, &settled)) {
                refused += 1;
                continue;
            }
            joined = settled;
        }
        if (affine) {
            pl_affine report;
            if (!pl_affine_analyse(&joined, &arena, &report))
                verdicts[report.verdict] += 1;
            else
                verdicts[PL_AFFINE_UNSUPPORTED] += 1;
        }
        composed += 1;
        nodes_in += (pl_u64)first.node_count + second.node_count;
        nodes_out += joined.node_count;
        args_in += (pl_u64)first.argument_count + second.argument_count;
        args_out += joined.argument_count;
        materialized += joined.node_count
                      - first.node_count - second.node_count;

        if (vectors > 0 && (long)composed <= vectors) {
            printf("PAIR %u %u %u %u %u %u %u %u %u\n", index,
                   successor[index], joined.function, joined.start,
                   joined.end, joined.instructions, joined.stack_inputs,
                   joined.node_count, joined.argument_count);
            for (pl_u32 value = 0; value < joined.node_count; ++value) {
                const pl_node *node = &joined.nodes[value];
                printf("N %u %u", value + 1u, node->opcode);
                for (pl_u32 slot = 0; slot < node->argument_count; ++slot)
                    print_operand(joined.arguments[node->argument_at + slot]);
                printf("\n");
            }
            for (pl_u32 slot = 0; slot < joined.stack_count; ++slot) {
                printf("S %u", slot);
                print_operand(joined.stack[slot]);
                printf("\n");
            }
            for (pl_u32 slot = 0; slot < joined.local_count; ++slot) {
                printf("L %u", slot);
                print_operand(joined.locals[slot]);
                printf("\n");
            }
        }
    }

    if (affine) {
        printf("bodies analysed            %12llu\n", composed);
        for (unsigned index = 0; index < 6u; ++index)
            printf("  %-38s %10llu\n",
                   pl_affine_reason((pl_affine_verdict)index),
                   verdicts[index]);
        free(payload);
        return 0;
    }

    if (!vectors) {
        printf("fusible pairs composed     %12llu\n", composed);
        printf("  refused by composition   %12llu\n", refused);
        printf("  a plan would not decode  %12llu\n", undecodable);
        printf("\n");
        printf("nodes  in %llu, out %llu\n", nodes_in, nodes_out);
        printf("  materialized projections %12llu\n", materialized);
        printf("arguments in %llu, out %llu\n", args_in, args_out);
        if (args_in)
            printf("  ordering edges added     %12lld\n",
                   (long long)args_out - (long long)args_in
                       - (long long)materialized * 2);
    }

    free(arena_bytes_base);
    free(predecessor);
    free(successor);
    free(payload);
    return 0;
}
