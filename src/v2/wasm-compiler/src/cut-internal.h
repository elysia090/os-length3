#ifndef WASM_CUT_INTERNAL_H
#define WASM_CUT_INTERNAL_H
#include "internal.h"
#include "module-interface.h"
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <machine/memory.h>
#include <x86/decode.h>
#include <x86/semantics.h>
#include <stddef.h>
enum { CUT_FLAGS = 17, CUT_LEFT, CUT_RIGHT, CUT_VALUE, CUT_NEXT,
       CUT_ADDRESS, CUT_STATUS, CUT_REPEAT_BUDGET,
       CUT_LOCAL_COUNT = 21, CUT_MEMORY_LOCALS = 23, CUT_REPEAT_LOCALS = 24 };
enum { CUT_SYSTEM_NONE, CUT_SYSTEM_INTERRUPT_FLAG, CUT_SYSTEM_SEGMENT, CUT_SYSTEM_TABLE,
       CUT_SYSTEM_FAR_RETURN, CUT_SYSTEM_CONTROL_READ, CUT_SYSTEM_CONTROL_WRITE,
       CUT_SYSTEM_CPUID, CUT_SYSTEM_INTERRUPT_RETURN, CUT_SYSTEM_MSR, CUT_SYSTEM_DIVIDE,
       CUT_SYSTEM_SELECTOR_READ, CUT_SYSTEM_INVALIDATE_PAGE, CUT_SYSTEM_IO, CUT_SYSTEM_TIME,
       CUT_SYSTEM_DEBUG, CUT_SYSTEM_X87_INIT, CUT_SYSTEM_FXSAVE, CUT_SYSTEM_SOFTWARE_INTERRUPT,
       CUT_SYSTEM_MXCSR, CUT_SYSTEM_VECTOR_TRANSFER, CUT_SYSTEM_VECTOR_SCALAR,
       CUT_SYSTEM_MEMORY_ORDER, CUT_SYSTEM_FXRSTOR, CUT_SYSTEM_PRIVILEGE_TRANSFER,
       CUT_SYSTEM_HALT, CUT_SYSTEM_COUNTER_BRANCH, CUT_SYSTEM_SELECTOR_SNAPSHOT };
enum { CUT_CARRY_NORMAL, CUT_CARRY_PRESERVE, CUT_CARRY_INPUT };
enum { CUT_BIND_NONE, CUT_BIND_MEMORY_DISPLACEMENT, CUT_BIND_CONTROL_DISPLACEMENT,
       CUT_BIND_IMMEDIATE_UNSIGNED, CUT_BIND_IMMEDIATE_SIGNED };
enum { CUT_STRING_NONE, CUT_STRING_SINGLE, CUT_STRING_REPEAT };
typedef struct {
    wasm_writer *writer;
    wasm_cut_report report;
    pl_u32 loaded;
    pl_u32 wanted_flags;
    pl_u32 has_memory;
    pl_u32 has_port;
    pl_u32 has_segment;
    pl_u32 has_table;
    pl_u32 has_far_return;
    pl_u32 has_interrupt_return;
    pl_u32 has_control_write;
    pl_u32 has_msr;
    pl_u32 has_debug;
    pl_u32 has_repeat;
    pl_u32 vector_local;
    pl_u32 operand_binding_kind;
    const pl_u32 *import_slots;
    pl_u32 imports_used;
} cut_lowering;
typedef struct {
    pl_x86_map maps[64];
    pl_x86_image image;
    wasm_cut_report report;
    /* Admission: write/read masks plus definite-kill bit. After reverse
     * liveness, bits 16..27 contain the needed flag definitions.
     * No decoded instruction or architectural predecessor frame is retained. */
    pl_u32 flag_frontier[WASM_CUT_MAX_INSTRUCTIONS];
    pl_u32 system_cut;
    pl_u32 string_cut;
    pl_u32 indirect_cut;
    pl_u32 operand_binding_kind;
    pl_u32 imports;
    pl_u32 fault_vector;
} cut_plan;
typedef struct { pl_u32 length,imports,binding,span; } cut_body_extent;
typedef struct {
    pl_u32 ranges,payload_bytes,witness_bytes;
    struct { pl_u16 first,count,witness; } range[64];
} cut_image_metadata;
int cut_image_metadata_measure(const wasm_cut_options *cuts,const cut_body_extent *bodies,
    pl_u32 count,cut_image_metadata *metadata);
int cut_image_metadata_emit(wasm_writer *writer,const cut_image_metadata *metadata,
    const wasm_cut_options *cuts,const cut_body_extent *bodies,pl_u32 count,
    const pl_x86_image *source,const pl_u8 digest[32]);
void cut_emit_dispatch(wasm_writer *writer,const wasm_cut_options *cuts,
    const cut_body_extent *bodies,const pl_u16 *classes,pl_u32 count,pl_u32 imports);
int wasm_emit_image_collection(const wasm_compiler *compiler,const wasm_compile_options *options,
    const wasm_cut_options *cuts,pl_u32 count,pl_u8 *target,pl_u64 capacity,
    pl_u64 *written,wasm_compile_report *report);
/* Construction continuation only: it borrows the immutable source/flag
 * frontier and carries no decoded instruction or generated code owner. */
typedef struct {
    const cut_plan *plan;
    cut_lowering cut;
    pl_u64 rip;
    pl_u32 instruction,phase;
} cut_body_cursor;
void cut_body_open(const cut_plan *plan,const pl_u32 *import_slots,cut_body_cursor *cursor);
/* Emit one prologue/instruction/epilogue. 1 = fragment, 0 = complete. */
int cut_body_next(cut_body_cursor *cursor,wasm_writer *writer);
void cut_call(cut_lowering *cut,pl_u32 import);
void cut_op(cut_lowering *cut, pl_u32 opcode);
void cut_get(cut_lowering *cut, pl_u32 local);
void cut_set(cut_lowering *cut, pl_u32 local);
void cut_const(cut_lowering *cut, pl_u64 bits);
void cut_i32_const(cut_lowering *cut, pl_u32 bits);
/* Only decoder-owned instruction coordinates use this substitution. */
void cut_coordinate(cut_lowering *cut, pl_u64 address);
void cut_mask(cut_lowering *cut, pl_u32 bits);
void cut_load(cut_lowering *cut, pl_u32 offset);
void cut_store(cut_lowering *cut, pl_u32 offset, pl_u32 local);
int cut_gpr(const pl_x86_register *reg);
int cut_selector_read_supported(const pl_x86_instruction *instruction);
void cut_read_operand(cut_lowering *cut, const pl_x86_operand *operand, pl_u32 width);
void cut_write_register(cut_lowering *cut, const pl_x86_register *reg);
void cut_condition(cut_lowering *cut, pl_u32 condition);
void cut_effective_address(cut_lowering *cut, const pl_x86_instruction *instruction,
                            const pl_x86_memory *memory);
int cut_memory_supported(const pl_x86_instruction *instruction);
int cut_memory_address_supported(const pl_x86_instruction *instruction,const pl_x86_memory *address);
pl_u32 cut_memory_role(const pl_x86_memory *address);
int cut_paired_exchange_supported(const pl_x86_instruction *instruction);
void cut_lower_paired_exchange(cut_lowering *cut,const pl_x86_instruction *instruction);
void cut_lower_memory(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_access(cut_lowering *cut);
void cut_access_value(cut_lowering *cut);
void cut_access_status(cut_lowering *cut);
void cut_arithmetic_flags(cut_lowering *cut, pl_u32 width, int subtraction,
                          int logical, int carry_mode);
int cut_stack_supported(const pl_x86_instruction *instruction);
void cut_lower_stack(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_indirect_supported(const pl_x86_instruction *instruction);
void cut_lower_indirect(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_reject_target(cut_lowering *cut);
int cut_string_supported(const pl_x86_instruction *instruction);
void cut_lower_string(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_repeat_frontier(cut_lowering *cut);
int cut_system_supported(const pl_x86_instruction *instruction);
void cut_lower_counter_branch(cut_lowering *cut,const pl_x86_instruction *instruction);
int cut_io_supported(const pl_x86_instruction *instruction);
int cut_fxsave_supported(const pl_x86_instruction *instruction);
int cut_fxstate_supported(const pl_x86_instruction *instruction,int restore);
void cut_lower_fxsave(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_fxrstor_supported(const pl_x86_instruction *instruction);
void cut_lower_fxrstor(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_mxcsr_supported(const pl_x86_instruction *instruction);
void cut_lower_mxcsr(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_vector_supported(const pl_x86_instruction *instruction);
void cut_lower_vector(cut_lowering *cut,const pl_x86_instruction *instruction);
/* Element width, with bit 7 selecting the old high 64-bit word; zero rejects. */
pl_u32 cut_vector_unpack_shape(const pl_x86_instruction *instruction);
void cut_lower_vector_unpack(cut_lowering *cut,const pl_x86_instruction *instruction,pl_u32 shape);
int cut_vector_binary_local(const pl_x86_instruction *instruction);
void cut_emit_vector_binary(cut_lowering *cut, const pl_x86_instruction *instruction,
                             const pl_x86_vector_binary *law);
void cut_lower_vector_shuffle(cut_lowering *cut,const pl_x86_instruction *instruction);
int cut_vector_projection_local(const pl_x86_instruction *instruction);
void cut_emit_vector_projection(cut_lowering *cut,
    const pl_x86_instruction *instruction,
    const pl_x86_vector_projection *projection);
/* Logical immediate shift: element width, bit 7 for left; zero rejects. */
pl_u32 cut_vector_shift_shape(const pl_x86_instruction *instruction);
void cut_lower_vector_shift(cut_lowering *cut,const pl_x86_instruction *instruction,pl_u32 shape);
int cut_vector_scalar_supported(const pl_x86_instruction *instruction);
void cut_lower_vector_scalar(cut_lowering *cut,const pl_x86_instruction *instruction);
void cut_sse_guard(cut_lowering *cut);
void cut_lower_io(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_lower_system(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_instruction_supported(const pl_x86_instruction *instruction);
pl_u32 cut_flag_write_mask(const pl_x86_instruction *instruction);
pl_u32 cut_flag_kill_mask(const pl_x86_instruction *instruction);
pl_u32 cut_flag_read_mask(const pl_x86_instruction *instruction);
int cut_shift_supported(const pl_x86_instruction *instruction);
int cut_double_shift_supported(const pl_x86_instruction *instruction);
void cut_double_shift_value(cut_lowering *cut,const pl_x86_instruction *instruction);
void cut_lower_double_shift(cut_lowering *cut,const pl_x86_instruction *instruction);
/* Count leaves one masked i64 on the stack. Value consumes captured
 * CUT_LEFT/CUT_RIGHT and updates CUT_VALUE/live flags, never a CPU store. */
void cut_shift_count(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_shift_value(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_lower_shift(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_multiply_supported(const pl_x86_instruction *instruction);
void cut_multiply_value(cut_lowering *cut, pl_u32 width);
void cut_implicit_multiply_value(cut_lowering *cut, pl_u32 width, int signed_product);
void cut_lower_multiply(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_lower_summary(cut_lowering *cut,const pl_x86_instruction *instruction);
void cut_summary_value(cut_lowering *cut,const pl_x86_instruction *instruction);
int cut_divide_supported(const pl_x86_instruction *instruction);
void cut_divide_value(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_lower_divide(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_lower_instruction(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_lower_register_update(cut_lowering *cut,const pl_x86_instruction *instruction);
int cut_prepare(const wasm_compiler *compiler, const wasm_cut_options *options,
                 cut_plan *plan);
int cut_prepare_image(const pl_x86_image *image, const wasm_cut_options *options,
                       cut_plan *plan);
int cut_measure_body(wasm_writer *writer,const cut_plan *plan,wasm_cut_report *report,pl_u32 *imports);
int cut_emit_body(wasm_writer *writer,const cut_plan *plan,wasm_cut_report *report,pl_u32 imports);
#endif
