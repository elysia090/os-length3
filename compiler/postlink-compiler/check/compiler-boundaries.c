#include <postlink/compiler.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 2;
    if (fseek(file, 0, SEEK_END)) return 2;
    long length = ftell(file);
    if (length <= 0 || fseek(file, 0, SEEK_SET)) return 2;
    pl_u8 *input = malloc((size_t)length);
    if (!input) return 2;
    if (fread(input, 1u, (size_t)length, file) != (size_t)length) return 2;
    if (fclose(file)) return 2;
    postlink_report report;
    postlink_measurement measurement;
    if (postlink_measure(input, (pl_u64)length, &measurement, &report)) return 1;
    pl_u8 *workspace = malloc((size_t)measurement.workspace_bytes + 16u);
    pl_u8 *output = malloc((size_t)measurement.output_capacity);
    if (!workspace || !output || measurement.workspace_alignment != 16u) return 2;
    pl_u64 output_bytes;
    for (unsigned bias = 1; bias < 16u; ++bias) {
        output_bytes = 123u;
        int status = postlink_compile(input, (pl_u64)length, output,
            measurement.output_capacity, &output_bytes, workspace + bias,
            measurement.workspace_bytes, &report);
        if (status != POSTLINK_ERROR_ARGUMENT || output_bytes) {
            fprintf(stderr, "unaligned compiler workspace %u: status=%d bytes=%llu\n",
                    bias, status, output_bytes);
            return 1;
        }
    }
    output_bytes = 123u;
    if (postlink_compile(input, (pl_u64)length, output,
            measurement.output_capacity, &output_bytes, workspace,
            measurement.workspace_bytes - 1u, &report) != POSTLINK_ERROR_WORKSPACE
            || output_bytes) return 1;
    free(output);
    free(workspace);
    free(input);
    puts("compiler boundary: 15 unaligned workspaces and exact capacity shortfall rejected before access");
    return 0;
}
