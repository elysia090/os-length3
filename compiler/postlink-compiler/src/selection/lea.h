#ifndef POSTLINK_SELECTION_LEA_H
#define POSTLINK_SELECTION_LEA_H

#include "shapes.h"

int pl_select_append_affine_local(affine_lea *out, pl_u32 local,
                               pl_u32 scale_log2);

int pl_select_collect_affine_lea_width(const pl_plan *plan, pl_operand value,
                                    pl_u32 bits, pl_u32 remaining,
                                    affine_lea *out);

int pl_select_collect_affine_lea(const pl_plan *plan, pl_operand value,
                              pl_u32 remaining, affine_lea *out);

int pl_select_collect_native_affine_lea(
    const pl_plan *plan, pl_operand value, pl_u32 remaining,
    affine_lea *out, pl_u32 *bits);

int pl_select_emit_affine_lea_width(pl_u32 destination, affine_lea form,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written);

int pl_select_emit_affine_lea(pl_u32 destination, affine_lea form,
                           pl_u8 *output, pl_u32 *written);

int pl_select_publication_add_preserves_flags(const pl_plan *plan,
                                            pl_operand value,
                                            pl_u32 destination);

int pl_select_final_flags_are_shift(const pl_plan *plan);

int pl_select_emit_boolean_zero(pl_u32 destination, int preserve_flags,
                              pl_u8 *output, pl_u32 *written);

int pl_select_emit_test_boolean(const pl_plan *plan, pl_operand value, pl_u32 destination,
                             pl_u8 *output, pl_u32 *written);

#endif
