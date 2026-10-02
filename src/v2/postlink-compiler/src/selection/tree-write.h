#ifndef POSTLINK_SELECTION_TREE_WRITE_H
#define POSTLINK_SELECTION_TREE_WRITE_H

#include "shapes.h"

int pl_select_absolute_fixup_at(const pl_x86_native_selection *selection,
                             pl_u32 output_at, pl_u64 target);

int pl_select_write_frame_value(const pl_x86_native_selection *selection,
                             pl_u32 output_at, pl_u32 local,
                             pl_operand value, pl_u8 *output,
                             pl_u32 *written);

int pl_select_write_alu_seed(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand value,
                          pl_u32 bits, pl_u32 output_at,
                          pl_u32 remaining, pl_u8 *output,
                          pl_u32 *written);

int pl_select_write_alu_tree(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand value,
                          pl_u32 bits, pl_u32 output_at,
                          pl_u32 remaining, pl_u32 scratch_mask,
                          pl_u8 *output, pl_u32 *written);

int pl_select_measure_quotient_boundary_select(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions);

int pl_select_write_quotient_boundary_select(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const quotient_boundary_select *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u8 *output, pl_u32 *written);

int pl_select_write_alu_pair(const pl_x86_block *block,
                          const pl_x86_native_selection *selection,
                          pl_u32 destination, pl_operand left,
                          pl_operand right, pl_u32 bits, pl_u32 mode,
                          pl_u32 preserves_carry, pl_u32 output_at,
                          pl_u32 remaining, pl_u32 scratch_mask,
                          pl_u8 *output, pl_u32 *written);

#endif
