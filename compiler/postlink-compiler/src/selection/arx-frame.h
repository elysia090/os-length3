#ifndef POSTLINK_SELECTION_ARX_FRAME_H
#define POSTLINK_SELECTION_ARX_FRAME_H

#include "shapes.h"

int pl_select_measure_direct_arx_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_write_direct_arx_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

int pl_select_measure_direct_mutable_xor_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_write_direct_mutable_xor_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

#endif
