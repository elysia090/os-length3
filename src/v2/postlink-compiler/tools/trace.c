/* postlink-trace -- how much of the block graph fuses.
 *
 *     postlink-trace MACHINE
 *
 * Reports the maximal runs of blocks that always execute together, which is
 * what the recurrence closure needs before it can look at a loop body wider
 * than one block.  Structural legality only: this does not claim any run is
 * profitable to fuse, nor that a loop's iteration is affine in its counter.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/template.h>
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

int main(int argc, char **argv)
{
    long emit_pairs = 0;
    if (argc == 4 && !strcmp(argv[2], "--pairs")) emit_pairs = atol(argv[3]);
    else if (argc != 2) {
        fprintf(stderr, "usage: postlink-trace MACHINE [--pairs N]\n");
        return 2;
    }
    FILE *handle = fopen(argv[1], "rb");
    if (!handle) { fprintf(stderr, "cannot open %s\n", argv[1]); return 1; }
    fseek(handle, 0, SEEK_END);
    long size = ftell(handle);
    rewind(handle);
    pl_u8 *payload = size > 0 ? malloc((size_t)size) : 0;
    if (!payload || fread(payload, 1, (size_t)size, handle) != (size_t)size) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        free(payload);
        fclose(handle);
        return 1;
    }
    fclose(handle);

    pl_machine machine;
    if (pl_machine_parse(payload, (pl_u64)size, &machine)) {
        fprintf(stderr, "%s is not an x86 native machine\n", argv[1]);
        free(payload);
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
    pl_u8 *visited = calloc(count, 1);
    if (!successor || !predecessor || !visited) {
        fprintf(stderr, "cannot allocate the block graph\n");
        return 1;
    }
    if (pl_trace_edges(&directory, successor, predecessor)) {
        fprintf(stderr, "cannot read the block graph\n");
        return 1;
    }

    unsigned long long single_successor = 0;
    unsigned long long fusible_edges = 0;
    unsigned long long joins = 0;
    unsigned long long unreached = 0;
    for (pl_u32 index = 0; index < count; ++index) {
        if (successor[index] != PL_NO_BLOCK) single_successor += 1;
        if (pl_trace_fusible(successor, predecessor, index)) fusible_edges += 1;
        if (predecessor[index] == PL_PRED_MANY) joins += 1;
        if (predecessor[index] == PL_PRED_NONE) unreached += 1;
    }

    /* Enumerate maximal runs, longest-first bookkeeping only. */
    unsigned long long runs = 0;
    unsigned long long fused_blocks = 0;
    unsigned long long retired = 0;
    pl_u32 longest = 0;
    unsigned long long histogram[9];
    memset(histogram, 0, sizeof histogram);
    /* Two passes.  A run's head is a row nothing can fuse into, which is
     * exactly predecessor != ONE -- no scan needed, since ONE is itself the
     * fusible condition seen from the successor's side.  A cycle has no head,
     * so the second pass picks up whatever the first did not reach. */
    for (unsigned pass = 0; pass < 2u; ++pass)
    for (pl_u32 index = 0; index < count; ++index) {
        if (visited[index]) continue;
        if (!pass && predecessor[index] == PL_PRED_ONE) continue;
        pl_u32 last = index;
        pl_u32 length = pl_trace_run(successor, predecessor, count, index,
                                     visited, &last);
        runs += 1;
        if (length > 1) {
            fused_blocks += length;
            retired += length - 1u;
            if (length > longest) longest = length;
        }
        pl_u32 bucket = length >= 8u ? 8u
                      : length >= 4u ? 7u
                      : length >= 3u ? 6u : length;
        histogram[bucket] += 1;
    }

    /* Is composition well posed for the edges that may fuse?  Parse both
     * templates and look at the interface: the successor consumes stack_inputs
     * words, and only the predecessor can supply them.  Where it cannot, the
     * pair is fusible in control but not composable as one graph, and the
     * composer would have to keep a boundary the trace says is absent. */
    const pl_u8 *execution = payload + machine.execution.offset;
    unsigned long long pairs = 0, unparsed = 0, interface_ok = 0;
    unsigned long long starved = 0, wider_node_space = 0, crossing = 0;
    unsigned long long work_before = 0, span_before = 0, operands_before = 0;
    unsigned long long bytes_before = 0;
    for (pl_u32 index = 0; index < count; ++index) {
        if (!pl_trace_fusible(successor, predecessor, index)) continue;
        pl_admission head, tail;
        if (pl_directory_admit(&directory, index, &head)
                || pl_directory_admit(&directory, successor[index], &tail))
            continue;
        pl_template a, b;
        if (pl_template_parse(execution + head.tmpl.offset,
                              (pl_u32)head.tmpl.length, &a)
                || pl_template_parse(execution + tail.tmpl.offset,
                                     (pl_u32)tail.tmpl.length, &b)) {
            unparsed += 1;
            continue;
        }
        pairs += 1;
        /* The composed graph's node numbering is the sum, so the one-byte node
         * width established over single templates has to be re-checked for the
         * pair. */
        if ((pl_u64)a.work + b.work > 255u) wider_node_space += 1;
        /* An upper bound, not a decision.  A plan may reach for a stack
         * operand it never declared as an input, and the operand value lives in
         * the parameter row rather than the template, so the deciding test
         * needs both and belongs with the composer. */
        if (b.stack_inputs > a.stack_count) starved += 1; else interface_ok += 1;
        /* compose_plans_raw refuses a pair whose plans belong to different
         * functions, so a fusible edge that crosses one is not composable. */
        if (a.function != b.function) crossing += 1;
        if (emit_pairs > 0 && (long)pairs <= emit_pairs)
            printf("%u %u\n", index, successor[index]);
        work_before += (pl_u64)a.work + b.work;
        span_before += (pl_u64)a.span + b.span;
        operands_before += (pl_u64)a.operands + b.operands;
        bytes_before += head.tmpl.length + tail.tmpl.length;
    }

    if (emit_pairs > 0) { free(payload); return 0; }
    printf("composability of fusible edges\n");
    printf("  pairs with both parsed   %12llu\n", pairs);
    printf("  a template would not parse %10llu\n", unparsed);
    printf("  inputs not ruled out     %12llu\n", interface_ok);
    printf("  successor wants more stack %10llu\n", starved);
    printf("  composed work > 255 nodes %11llu\n", wider_node_space);
    printf("  pair crosses a function  %12llu\n", crossing);
    printf("  work of the two graphs   %12llu\n", work_before);
    printf("  span of the two graphs   %12llu\n", span_before);
    printf("  operands of the two      %12llu\n", operands_before);
    printf("  template bytes of the two %11llu\n", bytes_before);
    printf("\n");

    printf("blocks                     %12u\n", count);
    printf("  one resolvable successor %12llu\n", single_successor);
    printf("  successor is a join      %12llu\n", joins);
    printf("  no static predecessor    %12llu\n", unreached);
    printf("  fusible edges            %12llu  (%5.1f%%)\n", fusible_edges,
           100.0 * (double)fusible_edges / (double)count);
    printf("\nmaximal runs               %12llu\n", runs);
    printf("  blocks inside a run > 1  %12llu\n", fused_blocks);
    printf("  boundaries composed away %12llu  (%5.1f%% of blocks)\n", retired,
           100.0 * (double)retired / (double)count);
    printf("  longest run              %12u blocks\n", longest);
    printf("\nrun length distribution\n");
    /* Buckets 1 and 2 are exact lengths; 6, 7 and 8 collect 3, 4-7 and 8+.
     * Buckets 0, 3, 4 and 5 are never assigned. */
    static const struct { unsigned bucket; const char *name; } BUCKETS[] = {
        { 1u, "1 (nothing fuses)" },
        { 2u, "2" },
        { 6u, "3" },
        { 7u, "4-7" },
        { 8u, "8+" },
    };
    for (unsigned i = 0; i < sizeof BUCKETS / sizeof BUCKETS[0]; ++i)
        printf("  %-24s %12llu\n", BUCKETS[i].name,
               histogram[BUCKETS[i].bucket]);

    free(visited);
    free(predecessor);
    free(successor);
    free(payload);
    return 0;
}
