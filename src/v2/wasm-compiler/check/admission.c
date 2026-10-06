#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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
    wasm_coverage_report coverage,saved_coverage;
    memset(&coverage,0xa5,sizeof coverage);saved_coverage=coverage;
    EXPECT(wasm_compiler_coverage(NULL,&coverage)==WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_coverage(&compiler,NULL)==WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_coverage(&compiler,&coverage)==WASM_COMPILER_ERROR_PROOF);
    EXPECT(!memcmp(&coverage,&saved_coverage,sizeof coverage));
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
        EXPECT(!wasm_compiler_coverage(&compiler,&coverage));
        EXPECT(coverage.catalog.coordinates==coverage.lowerable+coverage.unlowered_valid
            +coverage.unlowered_faults+coverage.fetch_demands+coverage.capacity_refusals);
        pl_u64 machine_total=0u,x87_total=0u,vector_total=0u;
        for(pl_u32 rank=0u;rank<=PL_X86_MACHINE_EXTENSION;++rank)machine_total+=coverage.machine_operations[rank];
        for(pl_u32 rank=0u;rank<256u;++rank){x87_total+=coverage.x87_operations[rank];vector_total+=coverage.vector_operations[rank];}
        EXPECT(machine_total==coverage.unlowered_valid+coverage.unlowered_faults);
        EXPECT(x87_total==coverage.machine_operations[PL_X86_MACHINE_X87]);
        EXPECT(vector_total==coverage.machine_operations[PL_X86_MACHINE_VECTOR]);
        pl_elf_image elf;pl_x86_map maps[64];pl_x86_image image;pl_x86_catalog catalog;
        EXPECT(!pl_elf_open(input,input_bytes,&elf));
        EXPECT(!pl_x86_image_from_elf(&elf,0u,1u,maps,64u,&image));
        EXPECT(!pl_x86_catalog_profile(&image,NULL,NULL,&catalog));
        EXPECT(!memcmp(&catalog,&coverage.catalog,sizeof catalog));
        wasm_compiler saved_compiler=compiler;
        EXPECT(wasm_compiler_coverage(&compiler,(wasm_coverage_report *)(void *)&compiler)==WASM_COMPILER_ERROR_INPUT);
        EXPECT(!memcmp(&compiler,&saved_compiler,sizeof compiler));
        EXPECT(wasm_compiler_coverage(&compiler,(wasm_coverage_report *)(void *)input)==WASM_COMPILER_ERROR_INPUT);
        EXPECT(!memcmp(&compiler,&saved_compiler,sizeof compiler));
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
