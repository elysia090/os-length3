#ifndef POSTLINK_SELECTION_TREE_MEASURE_H
#define POSTLINK_SELECTION_TREE_MEASURE_H

#include "shapes.h"

int pl_select_measure_alu_seed(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand value,
                            pl_u32 bits, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 *bytes,
                            pl_u32 *instructions);

int pl_select_operand_entry_gpr_sources(const pl_plan *plan, pl_operand value,
                                     pl_u32 before_node, pl_u32 remaining,
                                     pl_u32 *sources);

int pl_select_operand_entry_sources_without(
    const pl_plan *plan, pl_operand value, pl_operand excluded,
    pl_u32 before_node, pl_u32 remaining, int expand_root,
    pl_u32 *sources);

int pl_select_operand_contains_unpublished_value(
    const pl_plan *plan, pl_operand root, pl_operand value,
    pl_u32 remaining, int expand_root);

int pl_select_associative_mode(pl_u32 mode);

int pl_select_conditional_or_fold_details(
    const pl_plan *plan, pl_operand left, pl_operand right,
    pl_u32 bits, pl_u32 mode, conditional_or_fold *out);

int pl_select_collect_associative_leaves(const pl_plan *plan,
                                      pl_operand value,
                                      pl_u32 bits, pl_u32 mode,
                                      pl_operand *leaves,
                                      pl_u32 capacity, pl_u32 *count,
                                      pl_u32 remaining);

void pl_select_promote_associative_destination_leaf(
    pl_operand *leaves, pl_u32 count, pl_u32 destination);

int pl_select_masked_entry_affine_details(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    masked_entry_affine *out);

int pl_select_emit_masked_entry_affine(
    const masked_entry_affine *shape, pl_u8 *output,
    pl_u32 *written, pl_u32 *instructions);

int pl_select_entry_bit_overlay_details(const pl_plan *plan,
                                     pl_operand value,
                                     entry_bit_overlay *out);

int pl_select_split_entry_overlay_details(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       split_entry_overlay *out);

int pl_select_emit_split_entry_overlay(const split_entry_overlay *shape,
                                    pl_u8 *output, pl_u32 *written,
                                    pl_u32 *instructions);

int pl_select_low32_entry_overlay_details(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       low32_entry_overlay *out);

int pl_select_write_low32_entry_overlay(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection,
    const low32_entry_overlay *shape, pl_u32 output_at,
    pl_u32 scratch_mask, pl_u8 *output, pl_u32 *written);

int pl_select_emit_entry_bit_overlay(pl_u32 destination,
                                  const entry_bit_overlay *shape,
                                  pl_u8 *output, pl_u32 *written,
                                  pl_u32 *instructions);

int pl_select_multiply_word_operands(
    const pl_plan *plan, const pl_x86_native_selection *selection,
    pl_operand value, pl_u32 destination, pl_operand *left,
    pl_operand *right, pl_u32 *bits);

int pl_select_multiply_immediate_source(const pl_plan *plan, pl_operand left,
                                      pl_operand right, pl_u32 bits, pl_u32 *source);

pl_u32 pl_select_entry_bit_chain_orientation(const pl_plan *plan, pl_operand left,
                                           pl_operand right, pl_u32 destination,
                                           pl_u32 mode);

int pl_select_shared_shift_join(const pl_plan *plan, pl_operand value, pl_u32 bits,
                             pl_operand *seed, pl_operand *amount,
                             pl_u32 *group, pl_u32 *mode);

int pl_select_emit_shared_shift_join(pl_u32 destination, pl_u32 scratch,
                                  pl_operand amount, pl_u32 bits,
                                  pl_u32 group, pl_u32 mode,
                                  pl_u8 *output, pl_u32 *written);

int pl_select_measure_alu_tree(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand value,
                            pl_u32 bits, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 scratch_mask,
                            pl_u32 *bytes, pl_u32 *instructions);

int pl_select_measure_alu_pair(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand left,
                            pl_operand right, pl_u32 bits, pl_u32 mode,
                            pl_u32 preserves_carry, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 scratch_mask,
                            pl_u32 *bytes, pl_u32 *instructions);

#endif
