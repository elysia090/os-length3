/* Exact x86 instruction semantics lowered into the shared physical SSA. */

#ifndef POSTLINK_SEMANTIC_H
#define POSTLINK_SEMANTIC_H

#include "plan.h"
#include <x86/decode.h>

#define PL_X86_GPR_COUNT       16u
#define PL_X86_RFLAGS_LOCAL    16u
#define PL_X86_FS_BASE_LOCAL   17u
#define PL_X86_GS_BASE_LOCAL   18u
#define PL_X86_LOCAL_COUNT     19u

#define PL_ERROR_X86_SEMANTIC (-43)

typedef struct {
    pl_plan plan;
    pl_u64 successor[2];
    pl_operand target;
    pl_operand predicate;
    pl_operand fault_predicate;
    pl_operand machine_value;
    pl_u32 successor_count;
    pl_u8 flow;
    pl_u8 dynamic_target;
    pl_u8 has_predicate;
    pl_u8 has_fault_predicate;
    pl_u8 trap_vector;
    pl_u8 machine_operation;
    pl_u64 machine_argument;
} pl_x86_semantic;

/* Lower one already-decoded source instruction.  A grammar miss is a compiler
 * error, never a request for an interpreter.  The initial frame is the sixteen
 * x86-64 GPR coordinates followed by RFLAGS, FS.base and GS.base. */
int pl_x86_lower(const pl_x86_instruction *instruction,
                 pl_arena *arena, pl_x86_semantic *out);

#endif /* POSTLINK_SEMANTIC_H */
