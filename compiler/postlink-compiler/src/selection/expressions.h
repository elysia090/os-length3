#ifndef POSTLINK_SELECTION_EXPRESSIONS_H
#define POSTLINK_SELECTION_EXPRESSIONS_H

#include "shapes.h"

int pl_select_arithmetic_tree_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *left, pl_operand *right,
                                   pl_u32 *bits, pl_u32 *mode);

int pl_select_single_bit_or_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *source, pl_u32 *bits,
                                 pl_u32 *bit);

int pl_select_arithmetic_node_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *left, pl_operand *right,
                                   pl_u32 *bits, pl_u32 *mode);

int pl_select_negation_node_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *source, pl_u32 *bits);

int pl_select_complement_node_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *source, pl_u32 *bits);

pl_u32 pl_select_node_wave_depth(const pl_plan *plan, pl_operand value);

int pl_select_operand_fits_u32(const pl_plan *plan, pl_operand value,
                            pl_u32 remaining);

int pl_select_narrow_address_select_requires_source(
    const pl_x86_frontend *frontend, const pl_x86_block *block);

int pl_select_derived_rip_address_requires_source(
    const pl_x86_frontend *frontend, const pl_x86_block *block);

pl_u32 pl_select_publication_copy_bits(const pl_plan *plan,
                                    const pl_x86_native_selection *selection,
                                    pl_operand value, pl_u32 output_at);

int pl_select_shift_node_details(const pl_plan *plan, pl_operand value,
                              pl_operand *source, pl_operand *amount,
                              pl_u32 *bits, pl_u32 *group);

int pl_select_lane32_shift_inner_needs_truncation(const pl_plan *plan,
                                               pl_operand inner);

int pl_select_node_base_lane_insert(const pl_plan *plan, pl_operand value,
                                 pl_operand *base, pl_operand *inner,
                                 pl_u32 *width);

int pl_select_masked_shift_count_details(const pl_plan *plan, pl_operand value,
                                      pl_operand *source, pl_operand *count,
                                      pl_u32 *bits, pl_u32 *group);

int pl_select_emit_bit_summary(pl_u32 destination, pl_u32 source, pl_u32 bits,
                             pl_u32 mode, pl_u8 *output, pl_u32 *written);

int pl_select_zero_extend_high8_node(const pl_plan *plan, pl_u32 node_number,
                                  pl_u32 *source);

pl_u32 pl_select_alu_input_expression_bits(const pl_plan *plan,
                                        pl_operand value,
                                        pl_u32 consumer_bits);

pl_u32 pl_select_operand_expression_bits(const pl_plan *plan,
                                      pl_operand value,
                                      pl_u32 fallback);

int pl_select_published_operand_local(const pl_plan *plan, pl_operand value,
                                   pl_u32 *local);

void pl_select_physicalize_published_operand(const pl_plan *plan,
                                          pl_u32 destination,
                                          pl_operand *value);

int pl_select_physicalize_transient_operand(
    const pl_x86_native_selection *selection, pl_operand *value);

void pl_select_physicalize_selected_operand(
    const pl_plan *plan, const pl_x86_native_selection *selection,
    pl_u32 destination, pl_operand *value);

int pl_select_bit_summary_frame(const pl_plan *plan,
                              const pl_x86_native_selection *selection,
                              pl_operand value, pl_u32 destination,
                              pl_operand *seed, pl_u32 *seed_bits,
                              pl_u32 *source_local, pl_u32 *bits, pl_u32 *mode);

void pl_select_push_frame_value_alias(pl_x86_native_selection *selection,
                                   pl_u8 kind, pl_u64 value, pl_u8 local);

void pl_select_orient_commutative_destination(
    const pl_plan *plan, pl_u32 destination,
    pl_u32 mode, pl_operand *left, pl_operand *right);

int pl_select_sign_high_node_details(const pl_plan *plan, pl_operand value,
                                  pl_u32 *source, pl_u32 *bits);

int pl_select_scaled_lea_node_details(const pl_plan *plan, pl_operand value,
                                   pl_u32 *source, pl_u32 *bits,
                                   pl_u32 *scale_log2);

#endif
