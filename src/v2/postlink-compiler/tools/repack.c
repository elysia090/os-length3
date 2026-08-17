/* postlink-repack -- rewrite a schema 5 machine's continuations as schema 6.
 *
 *     postlink-repack MACHINE
 *
 * Schema 6 differs from schema 5 in one section: the continuation table gains
 * the resolved rank of each block's primary static successor.  Nothing else
 * changes -- block instances keep their RIP and their STEP and guard ranks, the
 * STEP instance and extent directories are copied, and the execution and
 * memory regions are not touched at all.  So a repack rewrites 0.6 MB of a
 * 32.8 MB artifact.
 *
 * This builds the new table and proves the transform: every block must decode
 * back to the same terminal projection it had, and its chain must resolve to
 * the successor the schema 5 row named.  Writing the container is mechanical
 * once that holds, and is deliberately a separate step.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/chain.h>

/* Interned continuation rows, in first-occurrence order so ranks follow the
 * artifact's own convention. */
#define TABLE_BITS 20u
#define TABLE_SLOTS (1u << TABLE_BITS)

typedef struct {
    pl_u32 *slot;            /* rank + 1, zero when empty */
    pl_u32 *offset;          /* rank -> arena offset */
    pl_u8 *arena;
    pl_u32 arena_used;
    pl_u32 arena_size;
    pl_u32 count;            /* distinct rows */
    pl_u32 capacity;
} row_table;

static int table_open(row_table *table, pl_u32 capacity, pl_u32 arena_size)
{
    table->slot = calloc(TABLE_SLOTS, sizeof *table->slot);
    table->offset = malloc((size_t)(capacity + 1u) * sizeof *table->offset);
    table->arena = malloc(arena_size);
    table->arena_used = 0;
    table->arena_size = arena_size;
    table->count = 0;
    table->capacity = capacity;
    return table->slot && table->offset && table->arena;
}

static void table_close(row_table *table)
{
    free(table->slot);
    free(table->offset);
    free(table->arena);
}

static pl_u32 row_length(const row_table *table, pl_u32 rank)
{
    return table->arena[table->offset[rank - 1u]];
}

static const pl_u8 *row_bytes(const row_table *table, pl_u32 rank)
{
    return table->arena + table->offset[rank - 1u] + 1u;
}

/* Return the rank of `row`, interning it when new.  Zero on overflow. */
static pl_u32 table_intern(row_table *table, const pl_u8 *row, pl_u32 bytes)
{
    pl_u64 hash = 0xcbf29ce484222325ull;
    for (pl_u32 i = 0; i < bytes; ++i) {
        hash ^= row[i];
        hash *= 0x100000001b3ull;
    }
    for (pl_u32 probe = 0; probe < TABLE_SLOTS; ++probe) {
        pl_u32 at = (pl_u32)((hash >> (64u - TABLE_BITS)) + probe)
                  & (TABLE_SLOTS - 1u);
        pl_u32 held = table->slot[at];
        if (!held) {
            if (table->count >= table->capacity) return 0;
            if (table->arena_size - table->arena_used < bytes + 1u) return 0;
            table->offset[table->count] = table->arena_used;
            table->arena[table->arena_used] = (pl_u8)bytes;
            memcpy(table->arena + table->arena_used + 1u, row, bytes);
            table->arena_used += bytes + 1u;
            table->count += 1u;
            table->slot[at] = table->count;
            return table->count;
        }
        if (row_length(table, held) == bytes
                && !memcmp(row_bytes(table, held), row, bytes))
            return held;
    }
    return 0;
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
        fprintf(stderr, "usage: postlink-repack MACHINE\n");
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

    row_table table;
    pl_u32 *block_rank = malloc((size_t)counts.block_count
                                * sizeof *block_rank);
    /* One row per block is the worst case; the arena is bounded by the widest
     * row times the block count. */
    if (!block_rank
            || !table_open(&table, counts.block_count,
                           counts.block_count
                           * (PL_CONTINUATION_CHAINED_MAX_BYTES + 1u))) {
        fprintf(stderr, "cannot allocate the continuation table\n");
        free(block_rank);
        free(payload);
        return 1;
    }

    unsigned long long chained = 0;
    unsigned long long unfoldable = 0;
    unsigned long long failures = 0;

    for (pl_u32 index = 0; index < counts.block_count; ++index) {
        pl_admission admission;
        if (pl_directory_admit(&directory, index, &admission)) {
            failures += 1;
            block_rank[index] = 0;
            continue;
        }

        /* The schema 5 row, back in its stored residual form. */
        pl_continuation relative;
        pl_continuation_project(admission.rip, &admission.continuation,
                                &relative);

        /* Fold the dispatch where the successor is a single known block. */
        pl_successors successors;
        pl_static_successors(&admission, &successors);
        int chainable = 0;
        pl_i64 delta = 0;
        pl_u32 expected_target = 0;
        if (successors.count) {
            pl_chain_target target;
            if (!pl_chain_resolve(&directory, successors.rip[0], &target)
                    && target.variants == 1u) {
                chainable = 1;
                delta = (pl_i64)target.index - (pl_i64)index;
                expected_target = target.index;
            }
        }
        if (chainable) chained += 1; else unfoldable += 1;

        pl_u8 row[PL_CONTINUATION_CHAINED_MAX_BYTES];
        pl_u32 written = 0;
        if (pl_continuation_encode_chained(&relative, chainable, delta,
                                           row, sizeof row, &written)) {
            failures += 1;
            block_rank[index] = 0;
            continue;
        }
        pl_u32 rank = table_intern(&table, row, written);
        if (!rank) {
            fprintf(stderr, "continuation table overflowed at block %u\n",
                    index);
            failures += 1;
            break;
        }
        block_rank[index] = rank;

        /* Prove the row: decoding it must give back the same terminal
         * projection, and the chain must name the same successor row. */
        pl_continuation back;
        int back_chainable = 0;
        pl_i64 back_delta = 0;
        if (pl_continuation_decode_chained(row_bytes(&table, rank),
                                           row_length(&table, rank), &back,
                                           &back_chainable, &back_delta)) {
            failures += 1;
            continue;
        }
        if (back.control != relative.control) failures += 1;
        for (pl_u32 f = 0; f < PL_CONTINUATION_FIELDS; ++f)
            if (back.field[f] != relative.field[f]) failures += 1;
        if (back_chainable != chainable) failures += 1;
        if (chainable
                && (pl_u32)((pl_i64)index + back_delta) != expected_target)
            failures += 1;

        /* And the absolute form must come back too, since that is what the
         * runtime consumes. */
        pl_continuation absolute;
        pl_continuation_instantiate(admission.rip, &back, &absolute);
        for (pl_u32 f = 0; f < PL_CONTINUATION_FIELDS; ++f)
            if (absolute.field[f] != admission.continuation.field[f])
                failures += 1;
    }

    /* What the new descriptor region would measure.  Only the continuation
     * section changes size. */
    pl_u64 v5_continuation = (pl_u64)(counts.continuation_count + 1u) * 4u
                           + counts.continuation_bytes;
    pl_u64 v6_continuation = (pl_u64)(table.count + 1u) * 4u
                           + table.arena_used - table.count;
    pl_u64 v6_descriptors = machine.descriptors.length
                          - v5_continuation + v6_continuation;

    printf("blocks                     %12u\n", counts.block_count);
    printf("  dispatch folded          %12llu\n", chained);
    printf("  dispatch irreducible     %12llu\n", unfoldable);
    printf("  round-trip failures      %12llu\n", failures);
    printf("\ncontinuation table\n");
    printf("  schema 5 ranks           %12u\n", counts.continuation_count);
    printf("  schema 6 ranks           %12u\n", table.count);
    printf("  schema 5 payload         %12u bytes\n",
           counts.continuation_bytes);
    printf("  schema 6 payload         %12llu bytes\n",
           (unsigned long long)(table.arena_used - table.count));
    printf("\ndescriptor region\n");
    printf("  schema 5                 %12llu bytes\n",
           (unsigned long long)machine.descriptors.length);
    printf("  schema 6                 %12llu bytes\n",
           (unsigned long long)v6_descriptors);
    printf("  delta                    %+12lld bytes\n",
           (long long)v6_descriptors - (long long)machine.descriptors.length);
    printf("\nuntouched\n");
    printf("  memory region            %12llu bytes\n",
           (unsigned long long)machine.memory.length);
    printf("  execution region         %12llu bytes\n",
           (unsigned long long)machine.execution.length);

    table_close(&table);
    free(block_rank);
    free(payload);
    return failures ? 1 : 0;
}
