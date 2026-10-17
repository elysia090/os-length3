#ifndef POSTLINK_SELECTION_STATE_FRAME_H
#define POSTLINK_SELECTION_STATE_FRAME_H

#include "shapes.h"

int pl_select_next_compare_branch_assignment(const pl_plan *plan, pl_u32 pending,
                                          pl_u32 preferred, pl_u32 *selected);

int pl_select_shared_root_shift_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                           shared_root_shift_handoff *out);

int pl_select_measure_direct_transient_owner_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_zero_result_operand(const pl_plan *plan, pl_operand value);

int pl_select_measure_direct_zero_flag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_shift_handoff_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_shared_owner_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_value_predicate_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_compare_handoff_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_write_direct_transient_owner_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_zero_flag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_shift_handoff_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_shared_owner_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_value_predicate_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_compare_handoff_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

#endif
