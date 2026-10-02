/* Isolate private cut planning on an ordinary ELF, not proof admission. */
#include "../src/cut-internal.h"
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 1;
    if (fseek(file, 0, SEEK_END)) { fclose(file); return 1; }
    long size = ftell(file);
    if (size <= 0 || fseek(file, 0, SEEK_SET)) { fclose(file); return 1; }
    pl_u8 *bytes = malloc((size_t)size);
    if (!bytes || fread(bytes, 1u, (size_t)size, file) != (size_t)size) {
        free(bytes); fclose(file); return 1;
    }
    fclose(file);
    pl_elf_image image = { 0 };
    int status = pl_elf_open(bytes, (pl_u64)size, &image);
    wasm_compiler compiler = { 0 };
    compiler.image.bytes = bytes; compiler.image.length = (pl_u64)size;
    wasm_cut_options options = { image.entry, 1024u, 65536u };
    cut_plan plan;
    if (status || (image.entry & 4095u) != 4094u
            || cut_prepare(&compiler, &options, &plan)
            || plan.report.source_instructions != 1u || plan.report.source_bytes != 1u
            || plan.report.continuation != image.entry + 1u) status = 1;
    if (!status) {
        options.entry = image.entry + 1u;
        if (cut_prepare(&compiler, &options, &plan)
                || plan.report.source_instructions != 1u || plan.report.source_bytes != 10u
                || plan.report.continuation != image.entry + 11u) status = 1;
    }
    if (!status) puts("Cross-page instruction fetch cut planning: green (not ELF/boot admission)");
    free(bytes); return status;
}
