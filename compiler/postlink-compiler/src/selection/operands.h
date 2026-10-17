#ifndef POSTLINK_SELECTION_OPERANDS_H
#define POSTLINK_SELECTION_OPERANDS_H

#include "shapes.h"

int pl_select_alu_node_semantics(const pl_plan *plan, pl_u32 node_number,
                              pl_operand *source, pl_operand *right,
                              pl_u32 *bits, pl_u32 *mode,
                              pl_u32 *preserves_carry);

int pl_select_alu_node_details(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *destination, pl_operand *source,
                            pl_operand *right,
                            pl_u32 *bits, pl_u32 *mode,
                            pl_u32 *preserves_carry);

int pl_select_zero_extend_node(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *source, pl_u32 *bits);

int pl_select_zero_extend_operand(const pl_plan *plan, pl_u32 node_number,
                               pl_operand *inner, pl_u32 *width);

int pl_select_sign_extend_value(const pl_plan *plan, pl_u32 node_number,
                             pl_operand *source, pl_u32 *bits);

int pl_select_lane_identity_mask_details(const pl_plan *plan, pl_operand value,
                                      pl_operand *source, pl_u32 *bits);

int pl_select_sign_extend_node(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *source, pl_u32 *bits);

int pl_select_alu_carry_prior_node(const pl_plan *plan, pl_u32 node_number,
                                pl_u32 *prior);

int pl_select_alu_frame_shape(const pl_plan *plan, pl_u32 *changed,
                           pl_u32 *final_flag_node);

int pl_select_operand_gpr_sources(const pl_plan *plan, pl_operand operand,
                               pl_u32 before_node, pl_u32 remaining,
                               pl_u32 *sources);

pl_u32 pl_select_publication_owner(const pl_plan *plan, pl_operand operand);

int pl_select_zero_self_flag_publication(const pl_plan *plan, pl_u32 owner);

int pl_select_alu_frame_source_laws(const pl_plan *plan,
                                 pl_u32 sources[PL_X86_GPR_COUNT],
                                 pl_u32 dependencies[PL_X86_GPR_COUNT]);

int pl_select_operand_frame_source_law(const pl_plan *plan,
                                    pl_operand operand,
                                    pl_u32 *sources,
                                    pl_u32 *dependencies);

int pl_select_flag_result_operand(const pl_plan *plan, pl_u32 node_number,
                               pl_operand *result, pl_operand *prior);

void pl_select_add_flag_chain_dependencies(
    const pl_plan *plan, pl_u32 final_flag_node,
    pl_u32 dependencies[PL_X86_GPR_COUNT]);

int pl_select_equal_operand(pl_operand left, pl_operand right);

#endif
