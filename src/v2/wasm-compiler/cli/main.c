#include <stdio.h>
#include <stdlib.h>

#include <wasm-compiler/compiler.h>

static unsigned char *read_file(const char *path, size_t *bytes)
{
    FILE *file = fopen(path, "rb");
    unsigned char *data;
    long length;
    if (!file || fseek(file, 0, SEEK_END) || (length = ftell(file)) < 0
            || fseek(file, 0, SEEK_SET)) {
        if (file) fclose(file);
        return NULL;
    }
    data = malloc((size_t)length ? (size_t)length : 1u);
    if (!data || fread(data, 1u, (size_t)length, file) != (size_t)length) {
        free(data);
        fclose(file);
        return NULL;
    }
    fclose(file);
    *bytes = (size_t)length;
    return data;
}

int main(int argc, char **argv)
{
    unsigned char *input;
    size_t input_bytes;
    wasm_compiler compiler;
    wasm_compile_options options = { 256u, 1u << 20u };
    pl_u64 output_bytes = 0u;
    int status;
    if (argc != 3) {
        fprintf(stderr, "usage: wasm-compiler INPUT.elf OUTPUT.wasm\n");
        return 2;
    }
    input = read_file(argv[1], &input_bytes);
    if (!input) {
        fprintf(stderr, "wasm-compiler: cannot read %s\n", argv[1]);
        return 1;
    }
    status = wasm_compiler_open(&compiler, input, input_bytes);
    if (!status)
        status = wasm_compiler_measure(&compiler, &options,
                                       &output_bytes, NULL);
    free(input);
    if (status) {
        if (status == WASM_COMPILER_ERROR_INCOMPLETE)
            fprintf(stderr,
                    "wasm-compiler: executable lowering is not implemented; "
                    "no module was published\n");
        fprintf(stderr, "wasm-compiler: refused input (%d)\n", status);
        return 1;
    }
    (void)output_bytes;
    fprintf(stderr, "wasm-compiler: internal emission error\n");
    return 1;
}
