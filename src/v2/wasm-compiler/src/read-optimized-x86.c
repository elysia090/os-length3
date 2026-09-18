#include <wasm-compiler/compiler.h>

int wasm_compiler_open(wasm_compiler *compiler,
                       const pl_u8 *elf, pl_u64 elf_bytes)
{
    int status;
    if (!compiler) return WASM_COMPILER_ERROR_INPUT;
    status = ox_image_open(elf, elf_bytes, &compiler->image);
    if (status) return WASM_COMPILER_ERROR_PROOF;
    compiler->function_count = compiler->image.proof.function_count;
    compiler->coordinate_count = compiler->image.proof.coordinate_count;
    if (compiler->function_count > 0xffffffffu)
        return WASM_COMPILER_ERROR_GRAMMAR;
    return 0;
}
