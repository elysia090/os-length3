/* postlink-admit -- resolve every block to coordinates, copying nothing.
 *
 *     postlink-admit MACHINE [--vectors N]
 *
 * Walks the whole directory and reports what admission costs when no record
 * is assembled: the bytes actually named, against the bytes a per-block X86B
 * record would have contained.  --vectors prints the first N admissions for
 * check/admit_parity.py to compare against the Python reader.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/directory.h>

static int header_u32(const pl_u8 *header, pl_u32 bytes, const char *path,
                      pl_u32 *value)
{
    pl_u64 wide;
    int status = pl_machine_header_u64(header, bytes, path, &wide);
    if (status) return status;
    if (wide > 0xffffffffull) return PL_ERROR_CONTAINER;
    *value = (pl_u32)wide;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: postlink-admit MACHINE [--vectors N]\n");
        return 2;
    }
    long vectors = 0;
    if (argc >= 4 && !strcmp(argv[2], "--vectors")) vectors = atol(argv[3]);

    FILE *handle = fopen(argv[1], "rb");
    if (!handle) { fprintf(stderr, "cannot open %s\n", argv[1]); return 1; }
    fseek(handle, 0, SEEK_END);
    long size = ftell(handle);
    rewind(handle);
    pl_u8 *payload = malloc((size_t)size);
    if (!payload || size <= 0
            || fread(payload, 1, (size_t)size, handle) != (size_t)size) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        free(payload);
        fclose(handle);
        return 1;
    }
    fclose(handle);

    pl_machine machine;
    int status = pl_machine_parse(payload, (pl_u64)size, &machine);
    if (status) {
        fprintf(stderr, "%s: %s\n", argv[1], pl_error_name(status));
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
    for (unsigned index = 0; index < sizeof fields / sizeof fields[0];
         ++index) {
        if (header_u32(header, machine.header_bytes, fields[index].path,
                       fields[index].slot)) {
            fprintf(stderr, "header lacks %s\n", fields[index].path);
            free(payload);
            return 1;
        }
    }
    counts.execution_bytes = (pl_u32)machine.execution.length;
    counts.schema = machine.schema;

    pl_directory directory;
    status = pl_directory_open(payload + machine.descriptors.offset,
                               machine.descriptors.length, &counts,
                               &directory);
    if (status) {
        fprintf(stderr, "descriptor region does not tile: %d\n", status);
        free(payload);
        return 1;
    }

    /* Bytes an assembled record would have held, against the bytes admission
     * actually names once shared templates stay shared. */
    unsigned long long record_bytes = 0;
    unsigned long long named_bytes = 0;
    unsigned long long guard_bytes = 0;
    unsigned long long parameter_bytes = 0;
    pl_u8 *template_seen = calloc(counts.template_count + 1u, 1);
    unsigned long long distinct_template_bytes = 0;
    unsigned long long failures = 0;

    for (pl_u32 index = 0; index < counts.block_count; ++index) {
        pl_admission admission;
        if (pl_directory_admit(&directory, index, &admission)) {
            failures += 1;
            continue;
        }
        record_bytes += PL_BLOCK_HEADER_BYTES + admission.guard.length
                      + admission.parameters.length + admission.tmpl.length;
        named_bytes += admission.guard.length + admission.parameters.length;
        guard_bytes += admission.guard.length;
        parameter_bytes += admission.parameters.length;
        if (template_seen && !template_seen[admission.template_rank]) {
            template_seen[admission.template_rank] = 1;
            distinct_template_bytes += admission.tmpl.length;
        }
        if (vectors > 0 && index < (pl_u32)vectors) {
            printf("%llu %u %llu %llu %llu %llu %llu %llu %u %u\n",
                   (unsigned long long)admission.rip,
                   admission.continuation.control,
                   (unsigned long long)admission.continuation.field[0],
                   (unsigned long long)admission.continuation.field[1],
                   (unsigned long long)admission.continuation.field[2],
                   (unsigned long long)admission.continuation.field[3],
                   (unsigned long long)admission.guard.offset,
                   (unsigned long long)admission.guard.length,
                   admission.template_rank, admission.step_bytes);
        }
    }
    free(template_seen);

    if (!vectors) {
        printf("blocks admitted      %12u\n",
               counts.block_count - (pl_u32)failures);
        printf("admission failures   %12llu\n", failures);
        printf("distinct templates   %12u\n", counts.template_count);
        printf("\n");
        printf("assembled records    %12llu bytes\n", record_bytes);
        printf("  of which template  %12llu bytes (duplicated per block)\n",
               record_bytes - named_bytes
                   - (unsigned long long)PL_BLOCK_HEADER_BYTES
                     * counts.block_count);
        printf("named without copies %12llu bytes\n",
               named_bytes + distinct_template_bytes);
        printf("  guards             %12llu\n", guard_bytes);
        printf("  parameters         %12llu\n", parameter_bytes);
        printf("  shared templates   %12llu\n", distinct_template_bytes);
        if (named_bytes + distinct_template_bytes)
            printf("\nrecord assembly costs %.2fx\n",
                   (double)record_bytes
                       / (double)(named_bytes + distinct_template_bytes));
    }

    free(payload);
    return failures ? 1 : 0;
}
