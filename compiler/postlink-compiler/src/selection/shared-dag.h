#ifndef POSTLINK_SELECTION_SHARED_DAG_H
#define POSTLINK_SELECTION_SHARED_DAG_H

#include "shapes.h"

int pl_select_shared_dag_add3_pair(const pl_plan *plan, pl_u32 node_number,
                                pl_u32 *pair_node, pl_operand *remaining,
                                pl_u32 *bits);

int pl_select_shared_dag_add3_published_pair(
    const pl_plan *plan, pl_u32 node_number, pl_u32 *pair_local,
    pl_operand *remaining, pl_u32 *bits);

int pl_select_measure_direct_shared_dag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_write_direct_shared_dag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output);

#endif
