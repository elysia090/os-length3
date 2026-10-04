#ifndef WASM_CUT_INTERNAL_H
#define WASM_CUT_INTERNAL_H
#include "internal.h"
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <machine/memory.h>
#include <x86/decode.h>
#include <stddef.h>
enum { CUT_FLAGS = 17, CUT_LEFT, CUT_RIGHT, CUT_VALUE, CUT_NEXT,
       CUT_ADDRESS, CUT_STATUS, CUT_REPEAT_BUDGET,
       CUT_LOCAL_COUNT = 21, CUT_MEMORY_LOCALS = 23, CUT_REPEAT_LOCALS = 24 };
enum { CUT_SYSTEM_NONE, CUT_SYSTEM_INTERRUPT_FLAG, CUT_SYSTEM_SEGMENT, CUT_SYSTEM_TABLE,
       CUT_SYSTEM_FAR_RETURN, CUT_SYSTEM_CONTROL_READ, CUT_SYSTEM_CONTROL_WRITE,
       CUT_SYSTEM_CPUID, CUT_SYSTEM_INTERRUPT_RETURN, CUT_SYSTEM_MSR, CUT_SYSTEM_DIVIDE,
       CUT_SYSTEM_SELECTOR_READ, CUT_SYSTEM_INVALIDATE_PAGE, CUT_SYSTEM_IO, CUT_SYSTEM_TIME,
       CUT_SYSTEM_DEBUG, CUT_SYSTEM_X87_INIT, CUT_SYSTEM_FXSAVE, CUT_SYSTEM_SOFTWARE_INTERRUPT,
       CUT_SYSTEM_MXCSR, CUT_SYSTEM_VECTOR_TRANSFER, CUT_SYSTEM_VECTOR_SCALAR };
enum { CUT_CARRY_NORMAL, CUT_CARRY_PRESERVE, CUT_CARRY_INPUT };
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
} cut_lowering;
typedef struct {
    pl_x86_map maps[64];
    pl_x86_image image;
    wasm_cut_report report;
    /* Low 16: bounded source offset. High 16: needed flag definitions.
     * No decoded instruction or architectural predecessor frame is retained. */
    pl_u32 flag_frontier[WASM_CUT_MAX_INSTRUCTIONS];
    pl_u32 system_cut;
    pl_u32 repeat_cut;
    pl_u32 indirect_cut;
} cut_plan;
void cut_op(cut_lowering *cut, pl_u32 opcode);
void cut_get(cut_lowering *cut, pl_u32 local);
void cut_set(cut_lowering *cut, pl_u32 local);
void cut_const(cut_lowering *cut, pl_u64 bits);
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
int cut_repeat_supported(const pl_x86_instruction *instruction);
void cut_lower_repeat(cut_lowering *cut, const pl_x86_instruction *instruction);
void cut_repeat_frontier(cut_lowering *cut);
int cut_system_supported(const pl_x86_instruction *instruction);
int cut_io_supported(const pl_x86_instruction *instruction);
int cut_fxsave_supported(const pl_x86_instruction *instruction);
void cut_lower_fxsave(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_mxcsr_supported(const pl_x86_instruction *instruction);
void cut_lower_mxcsr(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_vector_supported(const pl_x86_instruction *instruction);
void cut_lower_vector(cut_lowering *cut,const pl_x86_instruction *instruction);
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
int cut_prepare(const wasm_compiler *compiler, const wasm_cut_options *options,
                 cut_plan *plan);
int cut_prepare_image(const pl_x86_image *image, const wasm_cut_options *options,
                       cut_plan *plan);
int cut_emit_body(wasm_writer *writer, const cut_plan *plan, wasm_cut_report *report);
#endif
