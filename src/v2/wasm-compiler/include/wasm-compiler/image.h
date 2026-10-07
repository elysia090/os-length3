/* Whole immutable image preflight followed by bounded module construction. */
#ifndef WASM_COMPILER_IMAGE_H
#define WASM_COMPILER_IMAGE_H
#include <wasm-compiler/compiler.h>

typedef struct {
    const wasm_compiler *compiler;
    const pl_u8 *input;
    pl_u64 input_bytes;
    wasm_compile_options options;
    wasm_compile_report report;
    pl_u8 input_digest[32];
    pl_u32 maximum_module_bytes;
} wasm_image_plan;

typedef struct {
    const wasm_image_plan *plan;
    pl_x86_map maps[64];
    pl_x86_image image;
    pl_u32 map,finished;
    pl_u64 offset,modules,coordinates,bytes;
} wasm_image_iterator;

typedef struct {
    pl_u64 first,end; /* exact contiguous original ELF coordinate interval */
    wasm_compile_report code;
} wasm_image_module;

/* Preflight EVERY final PF_X coordinate and deterministic adaptive partition.
 * No callback/output module population is produced. A single failed grammar,
 * fetch or irreducible-capacity coordinate refuses the entire plan; all outputs
 * remain unchanged. Borrow compiler/options/input immutably. A successful plan
 * is a construction receipt, NOT a signed release or execution authorization. */
int wasm_compiler_prepare_image(const wasm_compiler *compiler,
    const wasm_compile_options *options,wasm_image_plan *plan);
/* Input identity and compiler lifetime are revalidated before construction.
 * Keep plan/compiler/input immutable until this iterator is discarded. */
int wasm_image_iterator_open(const wasm_image_plan *plan,wasm_image_iterator *iterator);
/* 1=one ordinary module, 0=all coordinates complete, negative=refusal.
 * Caller owns/reuses one output buffer; consume it before requesting the next
 * module. Failed output/capacity preflight preserves bytes/info/cursor. The
 * final root must not be published until iteration AND index construction
 * finish successfully; I/O failure may leave unreferenced staged objects. */
int wasm_image_iterator_next(wasm_image_iterator *iterator,pl_u8 *target,
    pl_u64 capacity,wasm_image_module *module);
#endif
