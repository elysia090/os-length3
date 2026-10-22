#ifndef POSTLINK_SELECTION_PROJECTION_H
#define POSTLINK_SELECTION_PROJECTION_H

#include "shapes.h"

int pl_select_derive_emitted_candidate_cost(
    const pl_x86_frontend *source_frontend,
    const pl_x86_block *source_block,
    pl_x86_native_selection *selection);

int pl_select_equivalent_suffix_bytes(
    const pl_x86_frontend *frontend,
    const pl_x86_block_workspace *scratch,
    const pl_x86_block *block, pl_u32 *bytes);

int pl_select_measure_direct_live_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

#endif
