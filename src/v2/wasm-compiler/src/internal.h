#ifndef WASM_COMPILER_INTERNAL_H
#define WASM_COMPILER_INTERNAL_H

#include <wasm-compiler/compiler.h>

typedef struct {
    pl_u8 *bytes;
    pl_u64 capacity;
    pl_u64 used;
    int error;
    /* A borrowed window of a virtual stream. Zero length is the ordinary
     * writer; otherwise only [window_start, window_start+window_bytes) is
     * copied, while used/capacity still describe the whole stream. */
    pl_u64 window_start;
    pl_u64 window_bytes;
} wasm_writer;

void wasm_writer_byte(wasm_writer *writer, pl_u32 value);
void wasm_writer_uleb(wasm_writer *writer, pl_u64 value);
int wasm_lower_machine_abi(const wasm_compiler *compiler,
                           wasm_compile_report *report);
int wasm_emit_function(wasm_writer *writer, const wasm_compiler *compiler,
                       pl_u32 function_rank,
                       wasm_compile_report *report);
int wasm_emit_dispatch(wasm_writer *writer, pl_u32 page_rank);
int wasm_emit_module(wasm_writer *writer, const wasm_compiler *compiler,
                     const wasm_compile_options *options,
                     wasm_compile_report *report);

#endif /* WASM_COMPILER_INTERNAL_H */
