#ifndef POSTLINK_SELECTION_ENCODING_H
#define POSTLINK_SELECTION_ENCODING_H

#include "shapes.h"

pl_u32 pl_select_constant_move_bytes(pl_u32 local, pl_u64 value);

int pl_select_emit_add_lea(pl_u32 destination, pl_operand left,
                        pl_operand right, pl_u32 bits,
                        pl_u8 *output, pl_u32 *written);

int pl_select_emit_gpr_move(pl_u32 destination, pl_u32 source, pl_u32 bits,
                         pl_u8 *output, pl_u32 *written);

int pl_select_emit_imul_register(pl_u32 destination, pl_u32 source, pl_u32 bits,
                              pl_u8 *output, pl_u32 *written);

int pl_select_emit_imul_operand(pl_u32 destination, pl_u32 multiplicand,
                             pl_operand source, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written);

int pl_select_emit_unsigned_multiply(pl_u32 source, pl_u8 *output,
                                  pl_u32 *written);

int pl_select_emit_indirect_jump(pl_u32 source, pl_u8 *output,
                              pl_u32 *written);

int pl_select_emit_zero_extend_move(pl_u32 destination, pl_u32 source,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written);

int pl_select_emit_zero_extend_high8(pl_u32 destination, pl_u32 source,
                                  pl_u8 *output, pl_u32 *written);

int pl_select_emit_sign_extend_move(pl_u32 destination, pl_u32 source,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written);

int pl_select_emit_sign_high(pl_u32 destination, pl_u32 source, pl_u32 bits,
                          pl_u8 *output, pl_u32 *written);

int pl_select_emit_low8_alu_flags(pl_u32 destination, pl_operand right,
                               pl_u32 mode, pl_u8 *output,
                               pl_u32 *written);

int pl_select_emit_scaled_lea(pl_u32 destination, pl_u32 source,
                           pl_u32 bits, pl_u32 scale_log2,
                           pl_u8 *output, pl_u32 *written);

int pl_select_emit_shifted_copy(pl_u32 destination, pl_u32 source,
                             pl_u32 bits, pl_u32 count,
                             pl_u8 *output, pl_u32 *written);

int pl_select_emit_shift_instruction(pl_u32 destination, pl_operand amount,
                                  pl_u32 bits, pl_u32 group,
                                  pl_u8 *output, pl_u32 *written);

int pl_select_emit_bit_set_immediate(pl_u32 destination, pl_u32 bit,
                                  pl_u32 bits, pl_u8 *output,
                                  pl_u32 *written);

int pl_select_emit_alu_instruction(pl_u32 destination, pl_operand right,
                                pl_u32 bits, pl_u32 mode,
                                pl_u32 preserves_carry,
                                pl_u8 *output, pl_u32 *written);

int pl_select_emit_alu_value_instruction(pl_u32 destination, pl_operand right,
                                      pl_u32 bits, pl_u32 mode,
                                      pl_u32 preserves_carry,
                                      pl_u8 *output, pl_u32 *written);

int pl_select_emit_bswap_register(pl_u32 destination, pl_u32 bits,
                               pl_u8 *output, pl_u32 *written);

int pl_select_emit_neg_register(pl_u32 destination, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written);

int pl_select_emit_not_register(pl_u32 destination, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written);

int pl_select_emit_compare_same(pl_u32 local, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written);

int pl_select_emit_compare_registers(pl_u32 left, pl_u32 right, pl_u32 bits,
                                  pl_u8 *output, pl_u32 *written);

int pl_select_emit_compare_operand(pl_u32 left, pl_operand right, pl_u32 bits,
                                pl_u8 *output, pl_u32 *written);

int pl_select_emit_conditional_move(pl_u32 destination, pl_u32 source,
                                 pl_u32 bits, pl_u32 condition,
                                 pl_u8 *output, pl_u32 *written);

int pl_select_emit_test_registers(pl_u32 left, pl_u32 right, pl_u32 bits,
                               pl_u8 *output, pl_u32 *written);

int pl_select_emit_test_operand(pl_u32 left, pl_operand right, pl_u32 bits,
                             pl_u8 *output, pl_u32 *written);

int pl_select_emit_high8_test(pl_u32 owner, pl_operand right,
                           pl_u8 *output, pl_u32 *written);

int pl_select_emit_zero_register(pl_u32 local, pl_u8 *output, pl_u32 *written);

int pl_select_emit_lane_constant_move(pl_u32 destination, pl_u64 constant,
                                   pl_u32 width, pl_u8 *output,
                                   pl_u32 *written);

int pl_select_emit_set_condition(pl_u32 destination, pl_u32 condition,
                              pl_u8 *output, pl_u32 *written);

#endif
