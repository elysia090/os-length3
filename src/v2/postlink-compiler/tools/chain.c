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


/* Distinct encoded rows, by exact bytes.  Open addressing over a hash of the
 * row, with the rows kept in an arena so a collision is settled by comparison
 * rather than trusted to the hash. */
#define ROW_TABLE_BITS 19u
#define ROW_TABLE_SLOTS (1u << ROW_TABLE_BITS)

typedef struct {
    pl_u32 *slot_offset;     /* arena offset + 1, zero when empty */
    pl_u8 *arena;
    pl_u32 arena_used;
    pl_u32 arena_size;
    unsigned long long distinct;
    unsigned long long total_bytes;
} row_set;

static int row_set_open(row_set *set, pl_u32 arena_size)
{
    set->slot_offset = calloc(ROW_TABLE_SLOTS, sizeof *set->slot_offset);
    set->arena = malloc(arena_size);
    set->arena_used = 0;
    set->arena_size = arena_size;
    set->distinct = 0;
    set->total_bytes = 0;
    return set->slot_offset && set->arena;
}

static void row_set_close(row_set *set)
{
    free(set->slot_offset);
    free(set->arena);
}

/* Returns 1 when the row is new. */
static int row_set_add(row_set *set, const pl_u8 *row, pl_u32 bytes)
{
    pl_u64 hash = 0xcbf29ce484222325ull;
    for (pl_u32 i = 0; i < bytes; ++i) {
        hash ^= row[i];
        hash *= 0x100000001b3ull;
    }
    pl_u32 slot = (pl_u32)(hash >> (64u - ROW_TABLE_BITS));
    for (pl_u32 probe = 0; probe < ROW_TABLE_SLOTS; ++probe) {
        pl_u32 at = (slot + probe) & (ROW_TABLE_SLOTS - 1u);
        pl_u32 stored = set->slot_offset[at];
        if (!stored) {
            if (set->arena_size - set->arena_used < bytes + 1u) return -1;
            set->arena[set->arena_used] = (pl_u8)bytes;
            memcpy(set->arena + set->arena_used + 1u, row, bytes);
            set->slot_offset[at] = set->arena_used + 1u;
            set->arena_used += bytes + 1u;
            set->distinct += 1;
            set->total_bytes += bytes;
            return 1;
        }
        const pl_u8 *held = set->arena + (stored - 1u);
        if (held[0] == (pl_u8)bytes && !memcmp(held + 1u, row, bytes))
            return 0;
    }
    return -1;
}

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
    counts.schema = machine.schema;

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

    row_set v5_rows, v6_rows;
    if (!row_set_open(&v5_rows, 1u << 22) || !row_set_open(&v6_rows, 1u << 22)) {
        fprintf(stderr, "cannot allocate the row tables\n");
        return 1;
    }
    unsigned long long overflow = 0;

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

        /* Both spellings of this block's continuation, to see whether the
         * chain field costs sharing.  The delta is relative to the block's own
         * row, so two blocks that both fall through keep the same row. */
        pl_continuation relative;
        pl_continuation_project(admission.rip, &admission.continuation,
                                &relative);
        pl_u8 row[PL_CONTINUATION_CHAINED_MAX_BYTES];
        pl_u32 written = 0;
        if (!pl_continuation_encode(&relative, row, sizeof row, &written))
            if (row_set_add(&v5_rows, row, written) < 0) overflow += 1;

        int chainable = 0;
        pl_i64 chain_delta = 0;
        if (successors.count) {
            pl_chain_target target;
            if (!pl_chain_resolve(&directory, successors.rip[0], &target)
                    && target.variants == 1u) {
                chainable = 1;
                chain_delta = (pl_i64)target.index - (pl_i64)index;
            }
        }
        written = 0;
        if (!pl_continuation_encode_chained(&relative, chainable, chain_delta,
                                            row, sizeof row, &written))
            if (row_set_add(&v6_rows, row, written) < 0) overflow += 1;
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

    printf("\ncontinuation table\n");
    printf("  schema 5 distinct rows   %12llu  %10llu bytes\n",
           v5_rows.distinct, v5_rows.total_bytes);
    printf("  schema 6 distinct rows   %12llu  %10llu bytes\n",
           v6_rows.distinct, v6_rows.total_bytes);
    if (v5_rows.distinct)
        printf("  rows                     %12.2fx\n",
               (double)v6_rows.distinct / (double)v5_rows.distinct);
    if (v5_rows.total_bytes)
        printf("  bytes                    %12.2fx\n",
               (double)v6_rows.total_bytes / (double)v5_rows.total_bytes);
    if (overflow) printf("  table overflow           %12llu\n", overflow);

    row_set_close(&v5_rows);
    row_set_close(&v6_rows);
    free(payload);
    return 0;
}
