/* Standalone optimized-x86 ELF -> Wasm compiler. */

#ifndef WASM_COMPILER_COMPILER_H
#define WASM_COMPILER_COMPILER_H

#include <machine/result.h>
#include <optimized-x86/reader.h>
#include <x86/decode.h>

#define WASM_COMPILER_OK 0
#define WASM_COMPILER_ERROR_INPUT      (-100)
#define WASM_COMPILER_ERROR_PROOF      (-101)
#define WASM_COMPILER_ERROR_GRAMMAR    (-102)
#define WASM_COMPILER_ERROR_CAPACITY   (-103)
#define WASM_COMPILER_ERROR_INCOMPLETE (-104)
/* The first instruction is truncated in the supplied source. Demand fetch
 * admission from the machine owner; this is not unsupported semantics or #PF. */
#define WASM_COMPILER_ERROR_FETCH      (-105)

typedef struct {
    ox_image image;
    pl_u64 function_count;
    pl_u64 coordinate_count;
    pl_u8 input_digest[32]; /* One identity per immutable accepted ELF, not per module. */
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

typedef struct {
    pl_x86_catalog catalog;
    pl_u64 lowerable,unlowered_valid,unlowered_faults,fetch_demands,capacity_refusals;
    pl_u64 first_unlowered;
    pl_i32 first_status;
    pl_u8 first_operation,first_machine_operation,first_decode_status,first_source_bytes;
    pl_u8 first_source[PL_X86_MAX_INSTRUCTION_BYTES];
    pl_u64 operations[PL_X86_OPERATION_MAX+1u];
    pl_u64 machine_operations[PL_X86_MACHINE_EXTENSION+1u];
    /* Stable descriptor operation bytes, not decoder mnemonics. */
    pl_u64 x87_operations[256],vector_operations[256];
} wasm_coverage_report;

/* Visit EVERY final PF_X byte coordinate, including interior/padding/zero-fill
 * and indirect targets. Classify actual backend admission, not proof counts,
 * symbols or observed RIPs. A grammar miss is never changed into #UD/#PF;
 * fetch demands mean the source/load context must be completed. This exact
 * finite coverage report is necessary, NOT sufficient for whole-machine
 * closure/publication. No Wasm or program table is emitted by this query. */
int wasm_compiler_coverage(const wasm_compiler *compiler,wasm_coverage_report *report);

/* Borrow immutable ELF bytes until the compiler is discarded. Failed reopen
 * invalidates the compiler; it must not retain a previous accepted image. */
int wasm_compiler_open(wasm_compiler *compiler,
                       const pl_u8 *elf, pl_u64 elf_bytes);
/* Complete final PF_X code projection when the ENTIRE coordinate domain fits
 * one bounded module (currently <=256 coordinates / <=64 KiB). Interior and
 * zero-fill bytes are entries too; any unsupported/fetch-demand coordinate
 * refuses before output publication. Larger domains return INCOMPLETE here;
 * use image.h's complete prepared iterator for multi-module construction,
 * never a prefix of this single-module API.
 *
 * Import ordinary machine.memory / used typed callbacks and immutable i64
 * machine.image_bias. Export entry with the machine-entry ABI 3 signature:
 * it maps admitted_entry-image_bias to a known ELF coordinate, supplies that
 * coordinate's compiled scalar binding and calls its shared body. Unknown
 * coordinates return ENTRY_MAP without CPU mutation, not a guest fault or
 * an execution fallback. The fourth entry argument is ignored; cut exports
 * retain their ordinary separately attested binding contract.
 *
 * The loader owns source/generation/MMU/debug admission and the immutable
 * bias/mapping lifetime. Executable relocations require a new admitted source
 * generation; a bias is not a relocation engine or Linux implementation.
 * This code projection is not a signed release root or whole-machine closure.
 * report.functions counts unique body definitions (dispatcher separately);
 * source_instructions is the complete one-instruction coordinate population;
 * wasm_instructions=0 is unmeasured, not a minimum-work claim. */
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
