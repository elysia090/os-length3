#include <postlink/compiler.h>
#include <support/checked.h>
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

int main(int argc, char **argv)
{
    pl_u8 *input = NULL;
    pl_u64 input_bytes = 0u;
    if (argc != 2 || !read_file(argv[1], &input, &input_bytes)) return 2;
    pl_elf_image elf;
    int status = pl_elf_open(input, input_bytes, &elf);
    pl_u64 table = 0u;
    for (pl_u32 index = 0u; !status && index < elf.program_count; ++index) {
        pl_elf_segment segment;
        status = pl_elf_program(&elf, index, &segment);
        if (!status && segment.type == PL_ELF_SEGMENT_GNU_EH_FRAME) {
            if (segment.file_bytes < 16u
                    || input[segment.file_offset] != 1u
                    || input[segment.file_offset + 1u] != 0x1bu
                    || input[segment.file_offset + 2u] != 0x03u
                    || input[segment.file_offset + 3u] != 0x3bu)
                status = 1;
            else
                table = segment.file_offset + 12u;
        }
    }
    if (status || !table || table > input_bytes || 4u > input_bytes - table) {
        free(input);
        return 2;
    }

    /* Move one sorted-table key off every admitted native boundary.  A
     * compiler that ignores linker-generated allocated metadata would still
     * publish this image; complete closure must reject it. */
    pl_write_u32(input + table, pl_read_u32(input + table) + 1u);
    postlink_measurement measurement;
    postlink_report report;
    status = postlink_measure(input, input_bytes, &measurement, &report);
    pl_u8 *output = status ? NULL
                  : malloc((size_t)measurement.output_capacity);
    pl_u8 *workspace = status ? NULL
                     : malloc((size_t)measurement.workspace_bytes);
    pl_u64 output_bytes = 0u;
    if (!status && output && workspace)
        status = postlink_compile(
            input, input_bytes, output, measurement.output_capacity,
            &output_bytes, workspace, measurement.workspace_bytes, &report);
    free(workspace);
    free(output);
    free(input);
    if (status == POSTLINK_OK) {
        fprintf(stderr, "metadata closure accepted an unbound unwind key\n");
        return 1;
    }
    printf("allocated metadata closure: green (unbound unwind key rejected at compile stage %d)\n",
           status);
    return 0;
}
