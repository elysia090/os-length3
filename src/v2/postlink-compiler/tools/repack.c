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


/* ------------------------------------------------------- container writer */

/* Digit-splice edits into the header, applied left to right so one pass
 * rebuilds the document.  Regenerating the JSON is deliberately avoided: the
 * header carries a state object of hex words that must survive byte for byte,
 * and only integers change. */
#define MAX_EDITS 16u

typedef struct {
    pl_u32 offset;      /* into the original header */
    pl_u32 old_bytes;   /* digits being replaced */
    char text[24];
} header_edit;

static pl_u32 digits_at(const pl_u8 *header, pl_u32 bytes, pl_u32 offset)
{
    pl_u32 length = 0;
    while (offset + length < bytes
            && header[offset + length] >= '0'
            && header[offset + length] <= '9')
        length += 1;
    return length;
}

static void print_u64(char *target, pl_u64 value)
{
    char reversed[24];
    pl_u32 length = 0;
    do {
        reversed[length++] = (char)('0' + (value % 10u));
        value /= 10u;
    } while (value);
    for (pl_u32 i = 0; i < length; ++i) target[i] = reversed[length - 1u - i];
    target[length] = 0;
}

static pl_u32 text_length(const char *text)
{
    pl_u32 length = 0;
    while (text[length]) length += 1;
    return length;
}

/* Queue a replacement for the integer named by `path`. */
static int edit_field(const pl_u8 *header, pl_u32 bytes, header_edit *edits,
                      pl_u32 *count, const char *path, pl_u64 value)
{
    if (*count >= MAX_EDITS) return -1;
    pl_u32 offset;
    if (pl_machine_header_locate(header, bytes, path, &offset)) return -1;
    pl_u32 old = digits_at(header, bytes, offset);
    if (!old) return -1;
    edits[*count].offset = offset;
    edits[*count].old_bytes = old;
    print_u64(edits[*count].text, value);
    *count += 1u;
    return 0;
}

/* A region is a two-element array, so both members are spliced. */
static int edit_region(const pl_u8 *header, pl_u32 bytes, header_edit *edits,
                       pl_u32 *count, const char *path, pl_u64 offset_value,
                       pl_u64 length_value)
{
    pl_u32 at;
    if (pl_machine_header_locate(header, bytes, path, &at)) return -1;
    if (at >= bytes || header[at] != '[') return -1;
    pl_u32 first = at + 1u;
    pl_u32 first_digits = digits_at(header, bytes, first);
    pl_u32 comma = first + first_digits;
    if (!first_digits || comma >= bytes || header[comma] != ',') return -1;
    pl_u32 second = comma + 1u;
    pl_u32 second_digits = digits_at(header, bytes, second);
    if (!second_digits) return -1;
    if (*count + 2u > MAX_EDITS) return -1;

    edits[*count].offset = first;
    edits[*count].old_bytes = first_digits;
    print_u64(edits[*count].text, offset_value);
    *count += 1u;
    edits[*count].offset = second;
    edits[*count].old_bytes = second_digits;
    print_u64(edits[*count].text, length_value);
    *count += 1u;
    return 0;
}

/* Apply the queued edits, which must be in ascending offset order. */
static pl_u32 apply_edits(const pl_u8 *header, pl_u32 bytes,
                          const header_edit *edits, pl_u32 count,
                          pl_u8 *target, pl_u32 capacity)
{
    pl_u32 read = 0;
    pl_u32 written = 0;
    for (pl_u32 index = 0; index < count; ++index) {
        pl_u32 at = edits[index].offset;
        if (at < read) return 0;                       /* edits overlap */
        pl_u32 run = at - read;
        pl_u32 text = text_length(edits[index].text);
        if (capacity - written < run + text) return 0;
        memcpy(target + written, header + read, run);
        written += run;
        memcpy(target + written, edits[index].text, text);
        written += text;
        read = at + edits[index].old_bytes;
    }
    if (capacity - written < bytes - read) return 0;
    memcpy(target + written, header + read, bytes - read);
    return written + (bytes - read);
}

static pl_u64 align_region(pl_u64 value, pl_u64 page)
{
    return (value + page - 1u) / page * page;
}

static int sort_edits(header_edit *edits, pl_u32 count)
{
    for (pl_u32 i = 1; i < count; ++i)
        for (pl_u32 j = i; j && edits[j - 1u].offset > edits[j].offset; --j) {
            header_edit swap = edits[j - 1u];
            edits[j - 1u] = edits[j];
            edits[j] = swap;
        }
    for (pl_u32 i = 1; i < count; ++i)
        if (edits[i].offset < edits[i - 1u].offset + edits[i - 1u].old_bytes)
            return -1;
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
    const char *output = 0;
    if (argc == 4 && !strcmp(argv[2], "--out")) output = argv[3];
    else if (argc != 2) {
        fprintf(stderr, "usage: postlink-repack MACHINE [--out FILE]\n");
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

    if (!output || failures) {
        table_close(&table);
        free(block_rank);
        free(payload);
        return failures ? 1 : 0;
    }

    /* Build the descriptor region.  Only the continuation section changes; the
     * block instances keep every field but their continuation rank, and the
     * three directories in between are copied byte for byte. */
    pl_u32 payload_bytes = table.arena_used - table.count;
    pl_u32 new_continuation = (table.count + 1u) * 4u + payload_bytes;
    pl_u64 new_descriptor_bytes = (pl_u64)directory.continuation_offset_base
                                + new_continuation;
    pl_u8 *descriptors = malloc(new_descriptor_bytes);
    if (!descriptors) {
        fprintf(stderr, "cannot allocate the descriptor region\n");
        return 1;
    }
    const pl_u8 *source = payload + machine.descriptors.offset;
    memcpy(descriptors, source, directory.continuation_offset_base);
    for (pl_u32 index = 0; index < counts.block_count; ++index)
        pl_write_u32(descriptors + (pl_u64)index * PL_BLOCK_INSTANCE_BYTES
                     + 12u, block_rank[index]);
    pl_u8 *offsets = descriptors + directory.continuation_offset_base;
    pl_u8 *rows = offsets + (table.count + 1u) * 4u;
    pl_u32 cursor = 0;
    for (pl_u32 rank = 1; rank <= table.count; ++rank) {
        pl_write_u32(offsets + (pl_u64)(rank - 1u) * 4u, cursor);
        pl_u32 length = row_length(&table, rank);
        memcpy(rows + cursor, row_bytes(&table, rank), length);
        cursor += length;
    }
    pl_write_u32(offsets + (pl_u64)table.count * 4u, cursor);
    if (cursor != payload_bytes) {
        fprintf(stderr, "continuation payload did not tile\n");
        return 1;
    }

    /* Region offsets depend on the header length, and the header carries those
     * offsets, so iterate to a fixed point exactly as the Python writer does. */
    pl_u32 magic_bytes = (pl_u32)sizeof PL_MACHINE_MAGIC_V6 - 1u;
    pl_u64 page = machine.page_bytes;
    pl_u64 memory_at = machine.memory.offset;
    pl_u64 descriptors_at = machine.descriptors.offset;
    pl_u64 execution_at = machine.execution.offset;
    pl_u32 header_capacity = machine.header_bytes + 256u;
    pl_u8 *new_header = malloc(header_capacity);
    pl_u32 new_header_bytes = 0;
    if (!new_header) { fprintf(stderr, "cannot allocate the header\n"); return 1; }

    for (unsigned round = 0; round < 8u; ++round) {
        header_edit edits[MAX_EDITS];
        pl_u32 count = 0;
        if (edit_field(header, machine.header_bytes, edits, &count,
                       "continuation_bytes", payload_bytes)
                || edit_field(header, machine.header_bytes, edits, &count,
                              "continuation_count", table.count)
                || edit_field(header, machine.header_bytes, edits, &count,
                              "descriptor_bytes", new_descriptor_bytes)
                || edit_region(header, machine.header_bytes, edits, &count,
                               "regions.memory", memory_at,
                               machine.memory.length)
                || edit_region(header, machine.header_bytes, edits, &count,
                               "regions.descriptors", descriptors_at,
                               new_descriptor_bytes)
                || edit_region(header, machine.header_bytes, edits, &count,
                               "regions.execution", execution_at,
                               machine.execution.length)
                || sort_edits(edits, count)) {
            fprintf(stderr, "cannot splice the header\n");
            return 1;
        }
        new_header_bytes = apply_edits(header, machine.header_bytes, edits,
                                       count, new_header, header_capacity);
        if (!new_header_bytes) {
            fprintf(stderr, "header splice overflowed\n");
            return 1;
        }
        pl_u64 next_memory = align_region(magic_bytes + 4u + new_header_bytes,
                                          page);
        pl_u64 next_descriptors = align_region(
            next_memory + machine.memory.length, page);
        pl_u64 next_execution = align_region(
            next_descriptors + new_descriptor_bytes, page);
        if (next_memory == memory_at && next_descriptors == descriptors_at
                && next_execution == execution_at)
            break;
        memory_at = next_memory;
        descriptors_at = next_descriptors;
        execution_at = next_execution;
    }

    pl_u64 total = execution_at + machine.execution.length;
    pl_u8 *out = calloc(1, total);
    if (!out) { fprintf(stderr, "cannot allocate the output\n"); return 1; }
    memcpy(out, PL_MACHINE_MAGIC_V6, magic_bytes);
    pl_write_u32(out + magic_bytes, new_header_bytes);
    memcpy(out + magic_bytes + 4u, new_header, new_header_bytes);
    memcpy(out + memory_at, payload + machine.memory.offset,
           machine.memory.length);
    memcpy(out + descriptors_at, descriptors, new_descriptor_bytes);
    memcpy(out + execution_at, payload + machine.execution.offset,
           machine.execution.length);

    FILE *sink = fopen(output, "wb");
    if (!sink || fwrite(out, 1, total, sink) != total) {
        fprintf(stderr, "cannot write %s\n", output);
        if (sink) fclose(sink);
        return 1;
    }
    fclose(sink);
    printf("\nwrote %s\n", output);
    printf("  schema 6 payload         %12llu bytes  (was %ld)\n",
           (unsigned long long)total, size);

    free(out);
    free(new_header);
    free(descriptors);
    table_close(&table);
    free(block_rank);
    free(payload);
    return 0;
}
