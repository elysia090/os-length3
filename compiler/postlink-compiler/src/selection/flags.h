#ifndef POSTLINK_SELECTION_FLAGS_H
#define POSTLINK_SELECTION_FLAGS_H

#include "shapes.h"

int pl_select_test_boolean_details(const pl_plan *plan, pl_operand value, test_boolean *out);

int pl_select_publication_is_flag_result(const pl_plan *plan,
                                      pl_operand publication,
                                      pl_u32 flag_node);

int pl_select_frame_publication_clobbers_flags(const pl_plan *plan,
                                            pl_operand publication);

int pl_select_publication_tree_clobbers_flags(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 destination);

int pl_select_frame_local_emission_clobbers_flags(const pl_plan *plan,
                                               pl_u32 local);

int pl_select_frame_local_publication_clobbers_flags(
    const pl_plan *plan, pl_u32 local);

pl_u32 pl_select_pending_entry_flag_readers(const pl_plan *plan, pl_u32 pending);

int pl_select_next_alu_frame_assignment(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 final_flag_node,
                                     const pl_u32 *sources,
                                     const pl_u32 *dependencies,
                                     pl_u32 protected_entries,
                                     pl_u32 *selected);

#endif
