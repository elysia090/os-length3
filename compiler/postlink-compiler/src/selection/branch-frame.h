#ifndef POSTLINK_SELECTION_BRANCH_FRAME_H
#define POSTLINK_SELECTION_BRANCH_FRAME_H

#include "shapes.h"

int pl_select_measure_direct_shared_sub_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_compare_branch_shape(const pl_x86_block *block, pl_u32 *changed,
                                pl_u32 *left, pl_u32 *right,
                                pl_u32 *bits, pl_u32 *condition,
                                pl_u32 *test);

int pl_select_compare_flag_prefix(const pl_plan *plan, pl_u8 *byte);

int pl_select_next_compare_branch_assignment_excluding(const pl_plan *plan,
                                          pl_u32 pending,
                                          pl_u32 preferred,
                                          pl_u32 deferred,
                                          pl_u32 *selected);

int pl_select_measure_direct_entry_flag_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_mask_flag_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_flag_result_group_shape(const pl_plan *plan, pl_u32 pending,
                                   flag_result_group *out, pl_u32 *deferred);

int pl_select_compare_boolean_group_shape(const pl_plan *plan, pl_u32 pending,
                                       pl_u32 final_flag_node,
                                       flag_result_group *out);

int pl_select_compare_tree_flag_shape(const pl_plan *plan, pl_u32 changed,
                                   pl_u32 final_flag_node,
                                   compare_tree_flag *out);

int pl_select_carry_alu_group_shape(const pl_plan *plan, pl_u32 pending,
                                 pl_u32 final_flag_node, carry_alu_group *out);

int pl_select_emit_group_booleans(const pl_plan *plan, const flag_result_group *shape,
                               int before, pl_u8 *output, pl_u32 *written, pl_u32 *work);

int pl_select_measure_direct_compare_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_write_direct_shared_sub_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_entry_flag_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_mask_flag_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_compare_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

#endif
