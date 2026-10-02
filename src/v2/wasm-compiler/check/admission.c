#include <stdio.h>
#include <stdlib.h>
#include <wasm-compiler/compiler.h>

static pl_u8 *read_input(const char *path, size_t *bytes)
{
    FILE *file = fopen(path, "rb");
    pl_u8 *input;
    long length;
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END) || (length = ftell(file)) <= 0
            || (unsigned long)length > (size_t)-1
            || fseek(file, 0, SEEK_SET)) {
        fclose(file);
        return NULL;
    }
    input = malloc((size_t)length);
    if (!input || fread(input, 1u, (size_t)length, file) != (size_t)length) {
        free(input);
        fclose(file);
        return NULL;
    }
    fclose(file);
    *bytes = (size_t)length;
    return input;
}

int main(int argc, char **argv)
{
    pl_u8 invalid[64] = { 0u };
    wasm_compiler compiler = { 0 };
    wasm_compile_options options = { 256u, 1048576u };
    pl_u64 written = 99u;
    int failed = 0;

    if (argc > 2) {
        fprintf(stderr, "usage: admission-check [OPTIMIZED-ELF]\n");
        return 2;
    }

#define EXPECT(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "admission: line %u\n", (unsigned)__LINE__); \
        ++failed; \
    } \
} while (0)

    EXPECT(wasm_compiler_open(NULL, invalid, sizeof invalid)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_open(&compiler, invalid, sizeof invalid)
           == WASM_COMPILER_ERROR_PROOF);
    compiler.image.bytes = invalid;
    compiler.image.length = sizeof invalid;
    compiler.function_count = 1u;
    compiler.coordinate_count = 1u;
    EXPECT(wasm_compiler_open(&compiler, invalid, sizeof invalid)
           == WASM_COMPILER_ERROR_PROOF);
    EXPECT(compiler.image.bytes == NULL);
    EXPECT(compiler.image.length == 0u);
    EXPECT(compiler.function_count == 0u);
    EXPECT(compiler.coordinate_count == 0u);
    EXPECT(wasm_compiler_measure(NULL, &options, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_measure(&compiler, NULL, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_measure(&compiler, &options, NULL, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_measure(&compiler, &options, &written, NULL)
           == WASM_COMPILER_ERROR_PROOF);
    EXPECT(written == 99u);
    EXPECT(wasm_compiler_emit(&compiler, &options, NULL, 0u, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    options.maximum_functions_per_module = 0u;
    EXPECT(wasm_compiler_measure(&compiler, &options, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    options.maximum_functions_per_module = 256u;
    options.maximum_module_bytes = 0u;
    EXPECT(wasm_compiler_measure(&compiler, &options, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);

    if (argc == 2) {
        size_t input_bytes = 0u;
        pl_u8 *input = read_input(argv[1], &input_bytes);
        if (!input) {
            fprintf(stderr, "cannot read optimized input: %s\n", argv[1]);
            return 1;
        }
        EXPECT(wasm_compiler_open(&compiler, input, input_bytes)
               == WASM_COMPILER_OK);
        EXPECT(compiler.image.bytes == input);
        EXPECT(compiler.image.length == input_bytes);
        EXPECT(compiler.function_count > 0u);
        EXPECT(compiler.coordinate_count > 0u);
        EXPECT(wasm_compiler_open(&compiler, invalid, sizeof invalid)
               == WASM_COMPILER_ERROR_PROOF);
        EXPECT(compiler.image.bytes == NULL);
        EXPECT(compiler.image.length == 0u);
        EXPECT(compiler.image.entry == 0u);
        EXPECT(compiler.image.proof.proof_version == 0u);
        EXPECT(compiler.image.proof.build_id_bytes == 0u);
        EXPECT(compiler.function_count == 0u);
        EXPECT(compiler.coordinate_count == 0u);
        EXPECT(wasm_compiler_open(&compiler, input, input_bytes)
               == WASM_COMPILER_OK);
        EXPECT(wasm_compiler_open(&compiler, NULL, 0u)
               == WASM_COMPILER_ERROR_PROOF);
        EXPECT(compiler.image.bytes == NULL);
        EXPECT(compiler.image.length == 0u);
        EXPECT(compiler.function_count == 0u);
        EXPECT(compiler.coordinate_count == 0u);
        free(input);
        if (!failed) puts("Accepted ELF -> rejected reopen: green");
    }
    if (failed) return 1;
    puts("Wasm compiler admission: green (not executable projection)");
    return 0;
}
