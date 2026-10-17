#ifndef POSTLINK_SELECTION_HANDOFF_H
#define POSTLINK_SELECTION_HANDOFF_H

#include "shapes.h"

pl_u32 pl_select_alu_frame_scratch_mask(
    pl_u32 pending, pl_u32 destination,
    const pl_u32 sources[PL_X86_GPR_COUNT]);

int pl_select_shift_sibling_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    shift_sibling_handoff *out);

int pl_select_arithmetic_width_handoff_shape(
    const pl_plan *plan, pl_u32 pending,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    const pl_u32 dependencies[PL_X86_GPR_COUNT],
    arithmetic_width_handoff *out);

int pl_select_shared_diamond_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    const pl_u32 dependencies[PL_X86_GPR_COUNT],
    pl_u32 protected_entries, shared_diamond_handoff *out);

int pl_select_generation_join_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    generation_join_handoff *out);

int pl_select_apply_generation_join_laws(
    const pl_plan *plan, pl_u32 pending,
    const generation_join_handoff *handoff,
    pl_u32 sources[PL_X86_GPR_COUNT],
    pl_u32 dependencies[PL_X86_GPR_COUNT]);

int pl_select_emit_generation_join(const generation_join_handoff *handoff,
                                 pl_u8 *output, pl_u32 *written);

int pl_select_shared_parent_frame_shape(const pl_x86_block *block,
                                     pl_u32 changed,
                                     pl_u32 final_flag_node,
                                     shared_parent_frame *out);

int pl_select_measure_shared_parent_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, const shared_parent_frame *shape);

int pl_select_select_generation_group_shape(const pl_plan *plan, pl_u32 pending,
    pl_u32 protected_sources, select_generation_group *out);

int pl_select_measure_select_generation_group(const pl_x86_frontend *frontend,
    const pl_x86_block *block, pl_x86_native_selection *selection,
    const select_generation_group *shape, pl_u32 output_at, pl_u32 *bytes, pl_u32 *work);

int pl_select_write_select_generation_group(const pl_x86_block *block,
    const pl_x86_native_selection *selection, const select_generation_group *shape,
    pl_u32 output_at, pl_u8 *output, pl_u32 *written);

int pl_select_conditional_alu_body(const pl_x86_block *block,
                                 pl_x86_block *body, pl_u32 *condition);

int pl_select_flags_root_only_arithmetic(const pl_plan *plan, pl_u32 node_number);

int pl_select_flag_value_preload_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 frame_sources[PL_X86_GPR_COUNT],
    const pl_u32 frame_dependencies[PL_X86_GPR_COUNT],
    flag_value_preload *out);

int pl_select_shared_root_unary_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                           pl_u32 final_flag_node,
                                           shared_root_unary_handoff *out);

int pl_select_emit_shared_root_consumer(const shared_root_consumer *consumer,
                                     pl_u8 *output, pl_u32 *written);

int pl_select_measure_direct_compare_tree_select_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_published_shift_generation_conflict(const pl_plan *plan);

int pl_select_shift_count_requires_published_rcx(const pl_plan *plan);

int pl_select_shared_alu_result_overwrites_entry(const pl_plan *plan,
                                              pl_u32 final_flag_node);

int pl_select_independent_entry_flags_subtract_conflict(const pl_plan *plan,
                                                     pl_u32 final_flag_node);

int pl_select_mixed_entry_and_produced_select_flags(const pl_plan *plan);

int pl_select_write_direct_compare_tree_select_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    pl_u8 *output);

#endif
