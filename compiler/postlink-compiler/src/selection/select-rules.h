#ifndef POSTLINK_SELECTION_SELECT_RULES_H
#define POSTLINK_SELECTION_SELECT_RULES_H

#include "shapes.h"

int pl_select_narrow_flag_transfer_shape(
    const pl_x86_block *block, narrow_flag_transfer *out);

int pl_select_measure_narrow_flag_transfer(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    const narrow_flag_transfer *shape);

int pl_select_independent_flag_overwrite_shape(
    const pl_plan *plan, independent_flag_overwrite *out);

int pl_select_condition_value_details(const pl_plan *plan, pl_operand value,
                                   condition_value *out);

int pl_select_flag_operation_details(const pl_plan *plan, pl_operand flags,
                                  pl_operand *left, pl_operand *right,
                                  pl_u32 *bits, pl_u32 *mode,
                                  pl_u32 *preserves_carry);

int pl_select_flag_value_operation_details(
    const pl_plan *plan, pl_u32 flag_node, pl_operand value,
    pl_operand *left, pl_operand *right, pl_u32 *bits,
    pl_u32 *mode, pl_u32 *preserves_carry);

pl_operand pl_select_publication_for_emission(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 flag_node);

int pl_select_prepare_partial_flag_publication(
    const pl_plan *plan, pl_operand publication, pl_u32 destination,
    pl_u32 bits, pl_operand *left, pl_operand *right,
    pl_u8 *output, pl_u32 *bytes, pl_u32 *work);

int pl_select_in_place_lane_insert(const pl_plan *plan, pl_operand value,
                                pl_u32 local, pl_operand *inner,
                                pl_u32 *width);

int pl_select_in_place_condition_insert(const pl_plan *plan, pl_operand value,
                                     pl_u32 local, pl_u32 *condition);

int pl_select_lane_constant_insert(const pl_plan *plan, pl_operand value,
                                pl_u32 local, pl_operand *base,
                                pl_u64 *constant, pl_u32 *width);

int pl_select_emit_flag_coordinate(pl_u32 left, pl_operand right, pl_u32 bits,
                                 pl_u32 test, pl_u32 offset,
                                 pl_u8 *output, pl_u32 *written);

int pl_select_standalone_flag_publication_details(
    const pl_plan *plan, pl_u32 node_number,
    standalone_flag_publication *out);

int pl_select_operand_published_dependencies(const pl_plan *plan, pl_operand operand,
                                          pl_u32 before_node, pl_u32 remaining,
                                          pl_u32 *deps);

int pl_select_emit_standalone_flag_publication(
    const standalone_flag_publication *publication,
    pl_u8 *output, pl_u32 *written);

int pl_select_carry_adjustment_details(const pl_plan *plan, pl_operand value,
                                     pl_u32 destination, pl_u32 bits, carry_adjustment *out);

int pl_select_emit_carry_adjustment(const carry_adjustment *shape, pl_u32 destination,
                                 pl_u8 *output, pl_u32 *written, pl_u32 *work);

int pl_select_boolean_select_details(const pl_plan *plan, pl_operand value,
                                  boolean_select *out);

int pl_select_conditional_select_details_inner(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       int allow_seed,
                                       conditional_select *out);

int pl_select_conditional_select_details(const pl_plan *plan, pl_operand value,
                                       pl_u32 destination,
                                       conditional_select *out);

pl_u32 pl_select_alu_add3_pair_consumer(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 pair_node, pl_u32 skip);

int pl_select_emit_select_compare(const conditional_select *select,
                                pl_u8 *output, pl_u32 *written);

int pl_select_measure_selected_flag_value(const pl_x86_frontend *frontend,
    const pl_x86_block *block, pl_x86_native_selection *selection, pl_u32 destination,
    const conditional_select *shape, pl_u32 output_at, pl_u32 remaining,
    pl_u32 scratch_mask, pl_u32 *bytes, pl_u32 *work);

int pl_select_write_selected_flag_value(const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const conditional_select *shape, pl_u32 output_at, pl_u32 remaining,
    pl_u32 scratch_mask, pl_u8 *output, pl_u32 *written);

int pl_select_quotient_boundary_select_details(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    quotient_boundary_select *out);

int pl_select_conditional_compare_survives_current(
    const conditional_select *select, pl_u32 destination);

int pl_select_publication_emits_selected_flag(const pl_plan *plan,
    pl_operand value, pl_u32 destination, pl_u32 flag_node);

int pl_select_publication_emits_flag_node(const pl_plan *plan,
                                       pl_u32 changed,
                                       pl_u32 flag_node);

int pl_select_flag_node_has_value_publication(const pl_plan *plan,
                                           pl_u32 changed,
                                           pl_u32 flag_node);

int pl_select_entry_select_bit_test_frame_shape(
    const pl_x86_block *block, pl_u32 changed, pl_u32 final_flag_node,
    entry_select_bit_test_frame *out);

int pl_select_emit_entry_select_bit_test_frame(
    const entry_select_bit_test_frame *shape,
    pl_u8 *output, pl_u32 *written);

int pl_select_conditional_select_gpr_sources(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    pl_u32 *sources);

int pl_select_conditional_select_publication_dependencies(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    pl_u32 *dependencies);

int pl_select_apply_select_candidate_laws(
    const pl_plan *plan, pl_u32 changed,
    pl_u32 dependencies[PL_X86_GPR_COUNT]);

int pl_select_apply_shared_flag_producer_laws(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    pl_u32 sources[PL_X86_GPR_COUNT],
    pl_u32 dependencies[PL_X86_GPR_COUNT]);

int pl_select_shared_flag_select_handoff_shape(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    shared_flag_select_handoff *out);

int pl_select_zero_internal_compare_consumers(const pl_plan *plan,
                                           pl_u32 zero_local,
                                           pl_u32 pending);

#endif
