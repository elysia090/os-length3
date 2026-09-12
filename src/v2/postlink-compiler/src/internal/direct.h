/* Backend-neutral direct block produced by the x86 post-link compiler. */

#ifndef POSTLINK_DIRECT_H
#define POSTLINK_DIRECT_H

#include "format.h"
#include "plan.h"

#define PL_DIRECT_RESULT_KIND_BITS 3u
#define PL_DIRECT_RESULT_KIND_MASK 7u

enum pl_direct_result_kind {
    PL_DIRECT_FUNCTION = 0,
    PL_DIRECT_RESOLVE = 1,
    PL_DIRECT_BARRIER = 2,
    PL_DIRECT_FAULT = 3,
    PL_DIRECT_HALT = 4,
};

/* Native emission consumes this exact product.  A later target translator may
 * read only the accepted optimized ELF; it must not form control from the
 * linked input again. */
typedef struct {
    const pl_plan *plan;
    pl_u64 next_rip;
    pl_u32 result_kind;
    pl_u64 result_payload;
    pl_operand next_rip_operand;
    pl_operand branch_predicate;
    pl_u64 alternate_rip;
    pl_u32 alternate_result_kind;
    pl_u64 alternate_result_payload;
    pl_u32 next_rip_relative;
    pl_u32 alternate_rip_relative;
    pl_u32 has_dynamic_rip;
    pl_u32 has_branch_predicate;
    pl_operand fault_predicate;
    pl_operand machine_value;
    pl_u32 has_fault_predicate;
    pl_u32 fault_vector;
    pl_u32 recurrence_local;
    pl_u32 recurrence_bits;
    pl_u64 recurrence_source_instructions;
    pl_u32 machine_operation;
    pl_u64 machine_argument;
} pl_direct_block;

#endif /* POSTLINK_DIRECT_H */
