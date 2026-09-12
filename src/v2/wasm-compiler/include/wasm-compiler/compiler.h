/* Standalone optimized-x86 ELF -> Wasm compiler. */

#ifndef WASM_COMPILER_COMPILER_H
#define WASM_COMPILER_COMPILER_H

#include <machine/result.h>
#include <optimized-x86/reader.h>

#define WASM_COMPILER_OK 0
#define WASM_COMPILER_ERROR_INPUT      (-100)
#define WASM_COMPILER_ERROR_PROOF      (-101)
#define WASM_COMPILER_ERROR_GRAMMAR    (-102)
#define WASM_COMPILER_ERROR_CAPACITY   (-103)
#define WASM_COMPILER_ERROR_INCOMPLETE (-104)

typedef struct {
    ox_image image;
    pl_u64 function_count;
    pl_u64 coordinate_count;
} wasm_compiler;

typedef struct {
    pl_u32 maximum_functions_per_module;
    pl_u32 maximum_module_bytes;
} wasm_compile_options;

typedef struct {
    pl_u64 functions;
    pl_u64 dispatchers;
    pl_u64 source_instructions;
    pl_u64 wasm_instructions;
    pl_u64 modules;
    pl_u64 bytes;
} wasm_compile_report;

int wasm_compiler_open(wasm_compiler *compiler,
                       const pl_u8 *elf, pl_u64 elf_bytes);
int wasm_compiler_measure(const wasm_compiler *compiler,
                          const wasm_compile_options *options,
                          pl_u64 *wasm_bytes,
                          wasm_compile_report *report);
int wasm_compiler_emit(const wasm_compiler *compiler,
                       const wasm_compile_options *options,
                       pl_u8 *target, pl_u64 capacity,
                       pl_u64 *written,
                       wasm_compile_report *report);

#endif /* WASM_COMPILER_COMPILER_H */
