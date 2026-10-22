#ifndef POSTLINK_SELECTION_SIMPLE_FRAME_H
#define POSTLINK_SELECTION_SIMPLE_FRAME_H

#include "shapes.h"

int pl_select_measure_frame_value(const pl_x86_frontend *frontend,
                               const pl_x86_block *block,
                               pl_x86_native_selection *selection,
                               pl_u32 local, pl_operand value,
                               pl_u32 output_at, pl_u32 *bytes);

int pl_select_measure_direct_frame(const pl_x86_frontend *frontend,
                                const pl_x86_block *block,
                                pl_x86_native_selection *selection);

int pl_select_measure_direct_common_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_equal_compare_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_constant_shift_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_add_frame(const pl_x86_frontend *frontend,
                                    const pl_x86_block *block,
                                    pl_x86_native_selection *selection);

int pl_select_measure_direct_affine_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_measure_direct_insert_frame(const pl_x86_frontend *frontend,
                                       const pl_x86_block *block,
                                       pl_x86_native_selection *selection);

int pl_select_write_direct_frame(const pl_x86_block *block,
                              const pl_x86_native_selection *selection,
                              pl_u8 *output);

int pl_select_write_direct_add_frame(const pl_x86_block *block,
                                  const pl_x86_native_selection *selection,
                                  pl_u8 *output);

int pl_select_write_shared_parent_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    const shared_parent_frame *shape, pl_u8 *output);

int pl_select_write_direct_affine_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_common_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_equal_compare_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_constant_shift_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_write_direct_insert_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

#endif
