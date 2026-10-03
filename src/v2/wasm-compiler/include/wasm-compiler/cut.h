/* Cold compilation of a bounded executable cut, not whole-image admission. */
#ifndef WASM_COMPILER_CUT_H
#define WASM_COMPILER_CUT_H

#include <wasm-compiler/compiler.h>
#include <x86/decode.h>

#define WASM_CUT_MAX_INSTRUCTIONS 1024u

enum wasm_cut_boundary {
    WASM_CUT_LIMIT = 1,
    WASM_CUT_CONTROL,
    WASM_CUT_UNSUPPORTED,
    WASM_CUT_FAULT,
    WASM_CUT_MEMORY,
    WASM_CUT_SYSTEM,
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
    pl_u32 memory_bytes;
    pl_u32 memory_access;
} wasm_cut_report;

/* Import machine.memory (ordinary wasm32 memory, >= one page); export
 * cut(i32 machine_state_offset, i32 memory_port_offset) -> i64 machine_result.
 * Pure cuts ignore the port; all generated cuts share machine/entry.h's table
 * type. Architectural addresses
 * remain i64. The supervisor owns an aligned, fully resident state reservation
 * and executable admission, including current generation/fetch permissions
 * and event/debug context. This function is not an MMU or code-admission check.
 * RIP mismatch or TF/RF returns ENTRY_MAP without
 * mutation. The baseline is long mode without debug single-stepping.
 *
 * A one-instruction RAM cut also imports machine.access (machine/memory.h)
 * with the same cut type. Its synchronous C provider must
 * pin translations/residency and keep the state/port arena disjoint from guest
 * RAM. Ordinary failed access preserves architectural state and retirement. Alignment
 * checking, FS/GS bases, concurrent workers and MMIO remain unsupported.
 * REP MOVS is a one-instruction Wasm loop through the same access boundary.
 * Completed elements publish only RCX/RSI/RDI at a return, while RIP and
 * retirement stay unchanged until completion. An element's load precedes its
 * all-fragment store. Address-size 32 zero-extends the three implicit parents
 * even for zero count/first architectural fault. A bounded 256-element return
 * uses BARRIER/QUANTUM; a physical miss uses BARRIER/RESOURCE. The serialized
 * C dispatcher pins the original instruction across those returns, including
 * self-modification. Stale/invalid entry remains a refusal, not a fault.
 * AC is rejected, not silently ignored. The C-Wasm provider now performs a
 * four-level 4 KiB/2 MiB walk under its pinned CPU/physical-residency context;
 * exception delivery and executable-generation admission are separate gates.
 * 64-bit register/immediate PUSH, register POP, direct/indirect near CALL and RET also
 * use this exact typed transaction. No 16-bit stack or CET context may be
 * admitted by this baseline. Same-CPL 64-bit far RET has a separate typed C
 * descriptor/cache boundary; outer-CPL and compatibility transfers reject.
 * Near indirect CALL reads its target using old RSP/address state, performs
 * the all-fragment stack store, then checks the target's canonicality. A
 * target #GP retains that payload store, with CPU/RSP/RIP/retirement unchanged.
 * A failed target read or stack transaction prevents the target check. The
 * next target fetch is a separate admission after successful CALL retirement.
 * Memory ADD/ADC/SUB/SBB/AND/OR/XOR uses machine.reserve/commit with pinned physical
 * fragments; generated Wasm computes arithmetic, not a C opcode callback.
 * Memory CMP/TEST uses a READ-only machine.access followed by shared ALU/flags
 * lowering, with no payload/GPR write and no flag commit before read success.
 * Memory DIV/IDIV also reads before any arithmetic guard: an operand #PF or
 * residency wait precedes #DE. The shared divider captures the divisor before
 * implicit AX/DX:RAX publication, rejects zero/quotient overflow without
 * retiring, and never uses a Wasm trap as an architectural divide fault.
 * LGDT/LIDT uses machine.table with ten-byte all-fragment preflight.
 * CLI is a precise one-instruction system cut with the same private port but
 * no host operation import. In long mode without CR4.PVI/EFLAGS.VM it clears
 * IF when CPL <= IOPL, otherwise publishes #GP(0) without retiring. PVI/VM
 * contexts are rejected, not implemented with nonvirtual semantics. Register
 * MOV ES/SS/DS/FS/GS uses machine.segment and the explicit hidden-cache
 * companion. MOV SS records its shadow; the dispatcher consumes it at the
 * next instruction. STI and interrupt/exception delivery remain unsupported.
 * Long-mode MOV from CR0/CR2/CR3/CR4/CR8 is a one-instruction compiled system
 * cut: CPL0 reads the frozen state field; other CPLs publish #GP(0) without
 * modifying CPU state or retirement. Undefined arithmetic flags preserve
 * their previous values as the selected representative. MOV to the same
 * control registers uses machine.control (private port, rank, value): the C
 * boundary enforces the fixed CPU profile and complete write legality before
 * publishing state, and revokes executable context even for equal-value writes.
 *
 * Compilation stops before an unlowered transfer, or after a direct branch.
 * It also stops before a later instruction that crosses/starts another fetch
 * page. A crossing first instruction is emitted alone. Thus executable-page
 * admission cannot fault ahead of retirement of the preceding pure prefix.
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

/* Cold executable-page admission for raw boot/mutable code. Each borrowed
 * map is one completely resident, immutable executable 4 KiB page; at most
 * two adjacent pages are supplied, all with this nonzero generation. The
 * supervisor authenticates source provenance and pins CPU/MMU/load/code
 * generation before calling. This is NOT an ELF-proof verifier or a license
 * to execute unauthenticated bytes. The same plan/lowering/emitter is used as
 * for accepted ELF cuts, and all unsupported instructions fail compilation.
 * No source decoding or original instruction fallback occurs during execution.
 * Output must be disjoint from source pages/maps/image/options/outputs.
 * No executable zero-fill or synthetic ELF/proof is introduced. */
int wasm_compiler_measure_code_cut(const pl_x86_image *source, pl_u64 generation,
                                   const wasm_cut_options *options,
                                   pl_u64 *bytes, wasm_cut_report *report);
int wasm_compiler_emit_code_cut(const pl_x86_image *source, pl_u64 generation,
                                const wasm_cut_options *options,
                                pl_u8 *target, pl_u64 capacity,
                                pl_u64 *written, wasm_cut_report *report);

#endif
