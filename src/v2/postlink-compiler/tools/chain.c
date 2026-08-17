/* postlink-chain -- what folding the dispatch into the block would buy.
 *
 *     postlink-chain MACHINE
 *
 * A dispatch is a RIP lookup.  For a block whose successors are compile-time
 * constants the lookup is a constant too, so the artifact could carry the
 * resolved block rank and the runtime could follow it directly.  This measures
 * whether that is available and what it would cost, from the shipped artifact,
 * before any format changes it.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/chain.h>

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
    if (argc != 2) {
        fprintf(stderr, "usage: postlink-chain MACHINE\n");
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
            free(payload);
            return 1;
        }
    counts.execution_bytes = (pl_u32)machine.execution.length;

    pl_directory directory;
    if (pl_directory_open(payload + machine.descriptors.offset,
                          machine.descriptors.length, &counts, &directory)) {
        fprintf(stderr, "descriptor region does not tile\n");
        free(payload);
        return 1;
    }

    unsigned long long static_blocks = 0;    /* dispatch is a constant */
    unsigned long long dynamic_blocks = 0;   /* dispatch is irreducible */
    unsigned long long edges = 0;
    unsigned long long resolved = 0;
    unsigned long long absent = 0;
    unsigned long long ambiguous = 0;        /* target has several variants */
    unsigned long long single_target = 0;    /* exactly one static successor */
    /* Rank residual width, to price carrying the resolved rank.  The delta is
     * signed against the current block's own row, because the artifact ranks
     * by first sorted RIP and so neighbours in control are near in rank. */
    unsigned long long width[4] = { 0, 0, 0, 0 };
    unsigned long long fallthrough = 0;      /* successor is the next row */

    for (pl_u32 index = 0; index < counts.block_count; ++index) {
        pl_admission admission;
        if (pl_directory_admit(&directory, index, &admission)) continue;

        pl_successors successors;
        pl_static_successors(&admission, &successors);
        if (!pl_control_is_static_dispatch(admission.continuation.control)) {
            dynamic_blocks += 1;
            continue;
        }
        static_blocks += 1;
        if (successors.count == 1) single_target += 1;

        for (pl_u32 slot = 0; slot < successors.count; ++slot) {
            edges += 1;
            pl_chain_target target;
            if (pl_chain_resolve(&directory, successors.rip[slot], &target)) {
                absent += 1;
                continue;
            }
            resolved += 1;
            if (target.variants > 1) ambiguous += 1;
            if (target.index == index + 1u) fallthrough += 1;
            long long delta = (long long)target.index - (long long)index;
            pl_u32 tag = pl_signed_tag(delta);
            width[tag - PL_TAG_SIGNED_8] += 1;
        }
    }

    printf("blocks                     %12u\n", counts.block_count);
    printf("  static dispatch          %12llu  (%5.1f%%)\n", static_blocks,
           100.0 * (double)static_blocks / (double)counts.block_count);
    printf("  irreducible dispatch     %12llu  (%5.1f%%)\n", dynamic_blocks,
           100.0 * (double)dynamic_blocks / (double)counts.block_count);
    printf("  exactly one successor    %12llu\n", single_target);
    printf("\n");
    printf("static control edges       %12llu\n", edges);
    printf("  resolve to a block       %12llu  (%5.1f%%)\n", resolved,
           edges ? 100.0 * (double)resolved / (double)edges : 0.0);
    printf("  no block at coordinate   %12llu\n", absent);
    printf("  target has variants      %12llu\n", ambiguous);
    printf("  target is the next row   %12llu\n", fallthrough);
    printf("\n");
    printf("rank delta residual width\n");
    static const char *const NAMES[4] = { "1 byte", "2 bytes", "4 bytes",
                                          "8 bytes" };
    unsigned long long bytes = 0;
    for (unsigned i = 0; i < 4; ++i) {
        printf("  %-8s                 %12llu\n", NAMES[i], width[i]);
        bytes += width[i] * (1ull << i);
    }
    printf("  encoded                  %12llu bytes\n", bytes);

    free(payload);
    return 0;
}
