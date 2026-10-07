#include <wasm-compiler/compiler.h>
#include <support/sha256.h>

int wasm_compiler_open(wasm_compiler *compiler,
                       const pl_u8 *elf, pl_u64 elf_bytes)
{
    wasm_compiler opened = { 0 };
    int status;
    if (!compiler) return WASM_COMPILER_ERROR_INPUT;
    status = ox_image_open(elf, elf_bytes, &opened.image);
    if (status) {
        *compiler = (wasm_compiler){ 0 };
        return WASM_COMPILER_ERROR_PROOF;
    }
    opened.function_count = opened.image.proof.function_count;
    opened.coordinate_count = opened.image.proof.coordinate_count;
    pl_sha256_digest(elf,elf_bytes,opened.input_digest);
    if (opened.function_count > 0xffffffffu) {
        *compiler = (wasm_compiler){ 0 };
        return WASM_COMPILER_ERROR_GRAMMAR;
    }
    *compiler = opened;
    return 0;
}
