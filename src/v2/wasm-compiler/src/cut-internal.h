#ifndef WASM_CUT_INTERNAL_H
#define WASM_CUT_INTERNAL_H
#include "internal.h"
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <machine/memory.h>
#include <x86/decode.h>
#include <stddef.h>
enum { CUT_FLAGS = 17, CUT_LEFT, CUT_RIGHT, CUT_VALUE, CUT_NEXT,
       CUT_ADDRESS, CUT_STATUS, CUT_LOCAL_COUNT = 21, CUT_MEMORY_LOCALS = 23 };
typedef struct {
    wasm_writer *writer;
    wasm_cut_report report;
    pl_u32 loaded;
    pl_u32 wanted_flags;
    pl_u32 extra_parameter;
} cut_lowering;
typedef struct {
    pl_x86_map maps[64];
    pl_x86_image image;
    wasm_cut_report report;
    pl_u32 last_flag_writer[12];
} cut_plan;
void cut_op(cut_lowering *cut, pl_u32 opcode);
void cut_get(cut_lowering *cut, pl_u32 local);
void cut_set(cut_lowering *cut, pl_u32 local);
void cut_const(cut_lowering *cut, pl_u64 bits);
void cut_mask(cut_lowering *cut, pl_u32 bits);
void cut_load(cut_lowering *cut, pl_u32 offset);
void cut_store(cut_lowering *cut, pl_u32 offset, pl_u32 local);
int cut_gpr(const pl_x86_register *reg);
void cut_read_operand(cut_lowering *cut, const pl_x86_operand *operand, pl_u32 width);
void cut_write_register(cut_lowering *cut, const pl_x86_register *reg);
void cut_effective_address(cut_lowering *cut, const pl_x86_instruction *instruction,
                            const pl_x86_memory *memory);
int cut_memory_supported(const pl_x86_instruction *instruction);
void cut_lower_memory(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_instruction_supported(const pl_x86_instruction *instruction);
pl_u32 cut_flag_write_mask(const pl_x86_instruction *instruction);
void cut_lower_instruction(cut_lowering *cut, const pl_x86_instruction *instruction);
int cut_prepare(const wasm_compiler *compiler, const wasm_cut_options *options,
                 cut_plan *plan);
int cut_emit_body(wasm_writer *writer, const cut_plan *plan, wasm_cut_report *report);
#endif
