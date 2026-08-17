/* postlink-template -- parse every SSA template and price its word widths.
 *
 *     postlink-template MACHINE
 *
 * Walks the template extent table, so each of the distinct classes is read
 * exactly once rather than once per block.  Reports what the node and
 * projection words -- the operator graph itself, which correctly stays in the
 * template -- actually need, against the eight bytes each occupies today.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/directory.h>
#include <postlink/template.h>

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
        fprintf(stderr, "usage: postlink-template MACHINE\n");
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

    const pl_u8 *execution = payload + machine.execution.offset;
    const pl_u8 *extents = directory.descriptors + directory.template_base;

    unsigned long long parsed = 0, rejected = 0, template_bytes = 0;
    unsigned long long graph_words = 0, structural = 0;
    unsigned long long width[9];
    memset(width, 0, sizeof width);
    unsigned long long by_kind[PL_OPERAND_KINDS];
    memset(by_kind, 0, sizeof by_kind);
    pl_u32 widest = 0;

    for (pl_u32 rank = 1; rank <= counts.template_count; ++rank) {
        pl_u32 offset = pl_read_u32(extents + (pl_u64)(rank - 1u) * 8u);
        pl_u32 length = pl_read_u32(extents + (pl_u64)(rank - 1u) * 8u + 4u);
        if (!length || offset > counts.template_execution_bytes
                || length > counts.template_execution_bytes - offset) {
            rejected += 1;
            continue;
        }
        const pl_u8 *bytes = execution + offset;
        pl_template tmpl;
        if (pl_template_parse(bytes, length, &tmpl)) {
            rejected += 1;
            continue;
        }
        parsed += 1;
        template_bytes += length;
        structural += PL_TEMPLATE_HEADER_BYTES
                    + ((pl_u64)tmpl.span + 1u) * 4u
                    + (pl_u64)tmpl.work * 5u
                    + ((pl_u64)tmpl.work + 1u) * 4u
                    + tmpl.operand.count + tmpl.stack.count + tmpl.local.count;

        const pl_tag_group *groups[3] = {
            &tmpl.operand, &tmpl.stack, &tmpl.local };
        for (unsigned g = 0; g < 3u; ++g) {
            const pl_tag_group *group = groups[g];
            pl_u32 slot = 0;
            for (pl_u32 index = 0; index < group->count; ++index) {
                pl_u32 tag = bytes[group->tags + index];
                if (!PL_OPERAND_STAYS(tag)) continue;
                pl_u64 word = pl_read_u64(bytes + group->words
                                          + (pl_u64)slot * 8u);
                slot += 1u;
                pl_u32 need = pl_unsigned_width(word);
                width[need] += 1;
                by_kind[tag] += 1;
                graph_words += 1;
                if (need > widest) widest = need;
            }
        }
    }

    printf("templates                  %12u\n", counts.template_count);
    printf("  parsed                   %12llu\n", parsed);
    printf("  rejected                 %12llu\n", rejected);
    printf("  template bytes           %12llu\n", template_bytes);
    printf("  header says              %12u\n",
           counts.template_execution_bytes);
    printf("\ngraph words held in 8 bytes %12llu\n", graph_words);
    printf("  node                     %12llu\n", by_kind[PL_OPERAND_NODE]);
    printf("  projection               %12llu\n",
           by_kind[PL_OPERAND_PROJECTION]);
    printf("\nwidth each word needs\n");
    unsigned long long recoverable = 0;
    for (unsigned need = 1; need <= 8u; need <<= 1) {
        printf("  %u byte%-18s %12llu\n", need, need == 1u ? "" : "s",
               width[need]);
        recoverable += width[need] * (8u - need);
    }
    printf("  widest                   %12u byte(s)\n", widest);
    printf("\nrecoverable                %12llu bytes\n", recoverable);
    if (template_bytes)
        printf("  of template bytes        %12.1f%%\n",
               100.0 * (double)recoverable / (double)template_bytes);
    printf("  structural remainder     %12llu bytes\n", structural);

    free(payload);
    return rejected ? 1 : 0;
}
