/* postlink-inspect -- report the framing of a post-link machine payload.
 *
 *     postlink-inspect MACHINE
 *
 * MACHINE is a raw x86-native-machine payload, not a page-fabric delivery.
 * This is the first driver that reads a real artifact with no Python and no
 * JavaScript in the path; it exists to keep that claim tested while the rest
 * of the compiler is ported.
 */

#include <stdio.h>
#include <stdlib.h>

#include <postlink/machine.h>

static const char *region_error(int status)
{
    switch (status) {
    case PL_ERROR_MAGIC:     return "payload is not an x86 native machine";
    case PL_ERROR_CONTAINER: return "container header is malformed";
    case PL_ERROR_REGION:    return "region directory is malformed";
    default:                 return pl_error_name(status);
    }
}

static void report_region(const char *name, const pl_region *region,
                          pl_u64 bytes)
{
    double share = bytes ? (double)region->length * 100.0 / (double)bytes : 0.0;
    printf("  %-12s offset %12llu  length %12llu  (%5.1f%%)\n", name,
           (unsigned long long)region->offset,
           (unsigned long long)region->length, share);
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: postlink-inspect MACHINE\n");
        return 2;
    }

    FILE *handle = fopen(argv[1], "rb");
    if (!handle) {
        fprintf(stderr, "cannot open %s\n", argv[1]);
        return 1;
    }
    if (fseek(handle, 0, SEEK_END)) {
        fprintf(stderr, "cannot size %s\n", argv[1]);
        fclose(handle);
        return 1;
    }
    long size = ftell(handle);
    rewind(handle);
    if (size <= 0) {
        fprintf(stderr, "%s is empty\n", argv[1]);
        fclose(handle);
        return 1;
    }

    pl_u8 *payload = malloc((size_t)size);
    if (!payload || fread(payload, 1, (size_t)size, handle) != (size_t)size) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        free(payload);
        fclose(handle);
        return 1;
    }
    fclose(handle);

    pl_machine machine;
    int status = pl_machine_parse(payload, (pl_u64)size, &machine);
    if (status) {
        fprintf(stderr, "%s: %s\n", argv[1], region_error(status));
        free(payload);
        return 1;
    }

    const pl_u8 *header = payload + machine.header_offset;
    printf("%s\n", argv[1]);
    printf("  schema       x86-native-machine-v%u\n", machine.schema);
    printf("  payload      %lld bytes\n", (long long)size);
    printf("  header       %u bytes at %u\n", machine.header_bytes,
           machine.header_offset);
    printf("  region page  %u bytes\n", machine.page_bytes);
    report_region("memory", &machine.memory, (pl_u64)size);
    report_region("descriptors", &machine.descriptors, (pl_u64)size);
    report_region("execution", &machine.execution, (pl_u64)size);

    /* Fields the framing does not need but that make a payload identifiable
     * at a glance.  A missing field is not an error: older schemas and
     * pruned payloads legitimately omit them. */
    static const char *const FIELDS[] = {
        "memory.bytes", "memory.length", "memory.prefix_bytes",
    };
    for (unsigned index = 0; index < sizeof FIELDS / sizeof FIELDS[0];
         ++index) {
        pl_u64 value;
        if (!pl_machine_header_u64(header, machine.header_bytes,
                                   FIELDS[index], &value))
            printf("  %-12s %llu\n", FIELDS[index],
                   (unsigned long long)value);
    }

    free(payload);
    return 0;
}
