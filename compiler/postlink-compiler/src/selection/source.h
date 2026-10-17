#ifndef POSTLINK_SELECTION_SOURCE_H
#define POSTLINK_SELECTION_SOURCE_H

#include "shapes.h"

int pl_select_source_address_binding(const pl_x86_frontend *frontend,
                                  const pl_x86_block *block,
                                  pl_u32 local, pl_u64 value,
                                  pl_u64 *target,
                                  pl_u32 *source_at,
                                  pl_u8 *source_bytes);

int pl_select_source_address_definition(const pl_x86_frontend *frontend,
                                     const pl_x86_block *block,
                                     pl_x86_native_selection *selection,
                                     pl_u32 local, pl_u64 value,
                                     pl_u32 bits, pl_u64 *address,
                                     pl_u32 *source_at);

int pl_select_alias_source_address_fields(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection);

int pl_select_append_absolute_source_fields(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    pl_u32 output_at, pl_u64 target);

int pl_select_source_terminal(const pl_x86_instruction *instruction);

int pl_select_final_instruction(const pl_x86_frontend *frontend,
                             const pl_x86_block *block,
                             pl_x86_instruction *out);

int pl_select_append_fixup(pl_x86_native_selection *selection, pl_u8 kind,
                        pl_u8 bytes, pl_u32 at, pl_u32 next_ip_at,
                        pl_u64 target);

int pl_select_append_control_fixup(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u8 bytes,
    pl_u32 at, pl_u32 next_ip_at, pl_u64 target);

int pl_select_direct_control(const pl_x86_instruction *instruction,
                          pl_u32 output_at, int relax_short_control,
                          pl_x86_native_selection *selection);

int pl_select_inspect_copied_instruction(
    const pl_x86_instruction *instruction, pl_u32 output_at,
    pl_x86_native_selection *selection);

int pl_select_measure_source_run(const pl_x86_frontend *frontend,
                               pl_u64 start, pl_u32 instructions,
                               pl_u32 omitted_prefix_bytes,
                               int relax_short_control,
                               pl_x86_native_selection *selection);

int pl_select_write_source_run(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            const pl_x86_native_selection *selection,
                            pl_u8 *output);

#endif
