/* Cold compilation of a bounded executable cut, not whole-image admission. */
#ifndef WASM_COMPILER_CUT_H
#define WASM_COMPILER_CUT_H

#include <wasm-compiler/compiler.h>
#include <x86/decode.h>

#define WASM_CUT_MAX_INSTRUCTIONS 1024u
#define WASM_CUT_MODULE_MAX_FUNCTIONS 256u
#define WASM_CUT_MODULE_MAX_BYTES 65536u

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
    pl_u32 operand_binding;
} wasm_cut_report;

/* Bounded standard-Wasm collection of explicitly admitted cuts. Entries must
 * be strictly increasing; every option names the same <=64 KiB module cap.
 * Shared typed imports and function types are emitted once, then exports
 * cut.0, cut.1, ... (or cut for one function). The ordinary machine-entry ABI
 * and per-cut source/span/binding obligations are unchanged. Report[i] is the
 * exact ith cut; module_bytes names their shared module, not a private stream.
 * Selected cuts do NOT establish whole-ELF/control/indirect-generation closure.
 * Borrow all inputs immutably; failed preflight leaves target/outputs unchanged. */
int wasm_compiler_emit_cut_module(const wasm_compiler *compiler,
    const wasm_cut_options *cuts,pl_u32 count,pl_u8 *target,pl_u64 capacity,
    pl_u64 *written,wasm_cut_report *reports);
int wasm_compiler_emit_code_module(const pl_x86_image *source,pl_u64 generation,
    const wasm_cut_options *cuts,pl_u32 count,pl_u8 *target,pl_u64 capacity,
    pl_u64 *written,wasm_cut_report *reports);

/* Same code collection, with a trailing standard machine.source custom
 * section carrying derived span/binding/ordinal metadata and one borrowed
 * source-page witness. The code prefix remains byte-identical to the ordinary
 * collection, so metadata does not split executable-body identity. Reports'
 * module_bytes includes this non-executable projection. This explicitly
 * selected cut domain is NOT whole-image closure or a release authorization.
 * Storage must share/rederive its source witness from the canonical owner;
 * it is not a second canonical program. Total object cap remains <=64 KiB. */
int wasm_compiler_emit_code_projection(const pl_x86_image *source,pl_u64 generation,
    const wasm_cut_options *cuts,pl_u32 count,pl_u8 *target,pl_u64 capacity,
    pl_u64 *written,wasm_cut_report *reports);

/* Import machine.memory (ordinary wasm32 memory, >= one page); export
 * cut(i32 machine_state_offset, i32 memory_port_offset, i64 admitted_entry,
 *     i32 operand_binding) -> i64 machine_result (machine-entry ABI 3).
 * The trusted compiler reports a signed displacement binding for one isolated
 * IP/GPR-relative memory operand, including scaled index and disp8, or the
 * final rel8/rel32 branch of a pure cut. A single GPR MOV whose value fits
 * unsigned32 or sign-extended32 carries that exact scalar value instead.
 * Its emitted topology determines the extension; it is not an opcode or
 * a runtime decoder descriptor. Wider values and multi-instruction literals
 * are encoded exactly in their body; other bindings are zero. A branch uses it as
 * sign_extend_32(d) added to its admitted fallthrough. Absolute pointers,
 * preceding operands and pure LEA literals are not rebound. The caller must
 * preserve it by value through admission and any pinned continuation.
 * Pure cuts ignore the port; all generated cuts share machine/entry.h's table
 * type. Architectural addresses
 * remain i64. The supervisor owns an aligned, fully resident state reservation
 * and executable admission, including the exact entry binding and current generation/fetch permissions
 * and event/debug context. This function is not an MMU or code-admission check.
 * RIP mismatch with that separately admitted binding or TF returns ENTRY_MAP without
 * mutation. The baseline is long mode without debug single-stepping.
 *
 * A one-instruction RAM cut also imports machine.access (machine/memory.h)
 * with the same cut type. Its synchronous C provider must
 * pin translations/residency and keep the state/port arena disjoint from guest
 * RAM. Ordinary failed access preserves architectural state and retirement. Alignment
 * checking, concurrent workers and MMIO remain unsupported. Explicit FS/GS
 * operands carry an already-truncated offset and a segment role; the same C
 * provider adds the full-width hidden base before ordinary linear preflight.
 * Neither generated code nor the host keeps a second copy of that base.
 * Legacy MOVLPS/MOVLPD/MOVHPS/MOVHPD transfers access exactly eight bytes.
 * Only the selected XMM half is read/stored; the other half is neither
 * materialized nor zeroed. Their control/fault boundary is the same SSE
 * guard and machine.access transaction as MOVD/MOVQ, not read_pair.
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
 * use this exact typed transaction. Memory-source PUSH and memory-destination
 * POP support 16/64-bit operands with an always-64-bit implicit stack pointer.
 * Only their explicit operand follows address-size truncation. PUSH reads
 * using old RSP; POP writes using new RSP. Both publish CPU/retirement only
 * after their ordered transactions succeed. CET remains unsupported.
 * Same-CPL 64-bit far RET has a separate typed C
 * descriptor/cache boundary; outer-CPL and compatibility transfers reject.
 * Near indirect CALL reads its target using old RSP/address state, performs
 * the all-fragment stack store, then checks the target's canonicality. A
 * target #GP retains that payload store, with CPU/RSP/RIP/retirement unchanged.
 * A failed target read or stack transaction prevents the target check. The
 * next target fetch is a separate admission after successful CALL retirement.
 * Memory ADD/ADC/SUB/SBB/AND/OR/XOR uses machine.reserve/commit with pinned physical
 * fragments; generated Wasm computes arithmetic, not a C opcode callback.
 * Valid LOCK arithmetic, unary and bit RMW use this same
 * transaction under the ordinary non-shared RAM, single serialized owner
 * contract. No guest writer/event/await intervenes between reservation and
 * commit. This is not SMP, split-lock-detection or MMIO atomicity support.
 * Memory CMP/TEST uses a READ-only machine.access followed by shared ALU/flags
 * lowering, with no payload/GPR write and no flag commit before read success.
 * Memory DIV/IDIV also reads before any arithmetic guard: an operand #PF or
 * residency wait precedes #DE. The shared divider captures the divisor before
 * implicit AX/DX:RAX publication, rejects zero/quotient overflow without
 * retiring, and never uses a Wasm trap as an architectural divide fault.
 * LGDT/LIDT uses machine.table with a complete ten-byte read. SGDT/SIDT
 * uses the same boundary with ordered limit/base stores and a C-owned
 * next-store frontier across residency waits; later faults retain payload.
 * CLI/STI are precise one-instruction cuts importing machine.interrupt_flag
 * (private port, enable). In long mode without CR4.PVI/EFLAGS.VM they transfer
 * IF when CPL <= IOPL, otherwise publish #GP(0) without retiring. PVI/VM
 * contexts are rejected, not implemented with nonvirtual semantics. Register
 * MOV ES/SS/DS/FS/GS uses machine.segment and the explicit hidden-cache
 * companion. MOV SS records its shadow; the dispatcher consumes it at the
 * next instruction. STI creates maskable-only inhibition only when prior IF
 * is zero and no old shadow exists; a second inhibit does not extend it.
 * Faults/waits do not consume a successful-instruction boundary. C event
 * delivery ends inhibition; NMI/debug/outer/TSS/IST coverage remains incomplete.
 * Long-mode MOV from CR0/CR2/CR3/CR4/CR8 is a one-instruction compiled system
 * cut: CPL0 reads the frozen state field; other CPLs publish #GP(0) without
 * modifying CPU state or retirement. Undefined arithmetic flags preserve
 * their previous values as the selected representative. MOV to the same
 * control registers uses machine.control (private port, rank, value): the C
 * boundary enforces the fixed CPU profile and complete write legality before
 * publishing state, and revokes executable context even for equal-value writes.
 * FNINIT is a no-wait one-instruction system cut: CR0.EM or TS publishes #NM
 * before mutation; otherwise control/status/tag/opcode/IP/DP are initialized.
 * Physical x87 data payload, XMM and MXCSR remain unchanged. Pending x87
 * exceptions do not fault this no-wait instruction; FWAIT/FINIT is separate.
 * LDMXCSR/STMXCSR are one-instruction system cuts using the existing C
 * machine.access boundary for an exact four-byte transfer. CR0.EM or
 * CR4.OSFXSR=0 gives #UD before CR0.TS gives #NM, both before the operand.
 * A complete read precedes the DAZ-capable profile's reserved-bit #GP.
 * LDMXCSR publishes only its narrow MXCSR field after every check succeeds;
 * installing unmasked status bits alone does not raise a SIMD exception.
 * Both retain the existing explicit AC/TF context refusal. They are not a
 * SIMD arithmetic, VEX or arbitrary exception/debug closure claim.
 * Legacy packed add/equality/bitwise logic, PSHUFB, immediate one/two-source
 * dword/word permutations and 16/32/64-bit
 * logical packed shifts emit standard deterministic WebAssembly SIMD.
 * The target engine must support it; missing
 * support is an explicit construction refusal, not a scalar/interpreter
 * alternative. Relaxed SIMD is never required. Selector bits and oversized
 * x86 shift counts are normalized before emission; identity/zero substitution
 * does not remove the preceding precise control frontier or retirement.
 * LFENCE/MFENCE/SFENCE remain separate one-instruction system cuts. Under
 * this ordinary (non-shared) Memory, single serialized owner and synchronous
 * C access contract, the outstanding memory frontier is empty at every cut
 * return. No value-state payload or guest-memory import is required; entry,
 * RF clearing and retirement still apply. CR0.EM/TS and CR4.OSFXSR do not
 * disable fences under the fixed SSE/SSE2 CPU profile. Cache-management and
 * SERIALIZE instructions are not admitted by this rule. This is neither an
 * SMP/async/shared-Memory lowering nor a host speculative-side-channel
 * mitigation guarantee. Such projections must replace this ordering contract.
 *
 * Compilation stops before an unlowered transfer, or after a direct branch.
 * It also stops before a later instruction that crosses/starts another fetch
 * page. A crossing first instruction is emitted alone. Thus executable-page
 * admission cannot fault ahead of retirement of the preceding pure prefix.
 * Success covers only source_bytes, never the continuation or an ELF closure.
 * Decoder-owned instruction coordinates are offsets from admitted_entry;
 * literal immediates and loaded guest addresses are not rebound. The binding
 * comes from the C-owned execution row, including its latched continuation;
 * reading current RIP is not a substitute for that independent admission.
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
