/* Cold compilation of a bounded executable cut, not whole-image admission. */
#ifndef WASM_COMPILER_CUT_H
#define WASM_COMPILER_CUT_H

#include <wasm-compiler/compiler.h>

#define WASM_CUT_MAX_INSTRUCTIONS 1024u

enum wasm_cut_boundary {
    WASM_CUT_LIMIT = 1,
    WASM_CUT_CONTROL,
    WASM_CUT_UNSUPPORTED,
    WASM_CUT_FAULT,
};

typedef struct {
    pl_u64 entry;
    pl_u32 maximum_source_instructions;
    pl_u32 maximum_module_bytes;
} wasm_cut_options;

typedef struct {
    pl_u64 entry;
    pl_u64 continuation;
    pl_u64 branch_target;
    pl_u64 source_instructions;
    pl_u64 source_bytes;
    pl_u64 module_bytes;
    pl_u32 read_registers;
    pl_u32 written_registers;
    pl_u32 flags_written;
    pl_u32 boundary;
    pl_u32 boundary_operation;
} wasm_cut_report;

/* Import machine.memory (ordinary wasm32 memory, >= one page); export
 * cut(i32 machine_state_offset) -> i64 machine_result. Architectural addresses
 * remain i64. The supervisor owns an aligned, fully resident state reservation
 * and executable admission, including current generation/fetch permissions
 * and event/debug context. This function is not an MMU or code-admission check.
 * RIP mismatch or TF/RF returns ENTRY_MAP without
 * mutation. The baseline is long mode without debug single-stepping.
 *
 * Compilation stops before an unlowered transfer, or after a direct branch.
 * Success covers only source_bytes, never the continuation or an ELF closure.
 * No decoder or source bytes are imported by the generated function. The
 * caller borrows immutable ELF bytes; no private execution section is read.
 * Undefined arithmetic flags may choose a canonical value; defined flags are
 * exact. Retired advances; work/span are not assigned invented machine costs.
 * The output buffer is disjoint from the borrowed ELF, compiler/options and
 * output descriptors. Failure preserves written/report and target bytes. */
int wasm_compiler_measure_cut(const wasm_compiler *compiler,
                              const wasm_cut_options *options,
                              pl_u64 *bytes, wasm_cut_report *report);
int wasm_compiler_emit_cut(const wasm_compiler *compiler,
                           const wasm_cut_options *options,
                           pl_u8 *target, pl_u64 capacity,
                           pl_u64 *written, wasm_cut_report *report);

#endif
