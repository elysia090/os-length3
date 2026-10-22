#include <x86/elf.h>

#include <stdio.h>
#include <stdlib.h>

static int read_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *file = fopen(path, "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 0;
    long end = ftell(file);
    if (end <= 0 || fseek(file, 0, SEEK_SET)) return 0;
    *bytes = malloc((size_t)end);
    if (!*bytes || fread(*bytes, 1u, (size_t)end, file) != (size_t)end
            || fclose(file))
        return 0;
    *length = (pl_u64)(unsigned long)end;
    return 1;
}

static int physical_entry(const pl_elf_image *image, pl_u64 canonical)
{
    if (image->entry == canonical) return 0;
    for (pl_u32 index = 0u; index < image->program_count; ++index) {
        pl_elf_segment segment;
        if (pl_elf_program(image, index, &segment)
                || segment.type != PL_ELF_SEGMENT_LOAD
                || image->entry < segment.physical_address)
            continue;
        pl_u64 relative = image->entry - segment.physical_address;
        if (relative < segment.memory_bytes
                && segment.virtual_address + relative == canonical)
            return 1;
    }
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    pl_u8 *source_bytes = NULL;
    pl_u8 *output_bytes = NULL;
    pl_u64 source_length = 0u;
    pl_u64 output_length = 0u;
    if (!read_file(argv[1], &source_bytes, &source_length)
            || !read_file(argv[2], &output_bytes, &output_length))
        return 2;
    pl_elf_image source, output;
    pl_u64 source_canonical = 0u;
    pl_u64 output_canonical = 0u;
    int source_present = 0;
    int output_present = 0;
    int status = pl_elf_open(source_bytes, source_length, &source);
    if (!status) status = pl_elf_open(output_bytes, output_length, &output);
    if (!status)
        status = pl_elf_process_entry(
            &source, &source_canonical, &source_present);
    if (!status)
        status = pl_elf_process_entry(
            &output, &output_canonical, &output_present);
    if (status || !source_present || !output_present
            || !physical_entry(&source, source_canonical)
            || !physical_entry(&output, output_canonical)) {
        fprintf(stderr,
                "physical entry: RED (status=%d source=0x%llx->0x%llx "
                "output=0x%llx->0x%llx)\n",
                status,
                (unsigned long long)source.entry,
                (unsigned long long)source_canonical,
                (unsigned long long)output.entry,
                (unsigned long long)output_canonical);
        return 1;
    }
    printf("physical entry: green (0x%llx->0x%llx, 0x%llx->0x%llx)\n",
           (unsigned long long)source.entry,
           (unsigned long long)source_canonical,
           (unsigned long long)output.entry,
           (unsigned long long)output_canonical);
    free(output_bytes);
    free(source_bytes);
    return 0;
}
