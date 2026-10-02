/* Consume linked-ELF construction relocations after compact native layout. */

#ifndef POSTLINK_RELOCATE_ELF_H
#define POSTLINK_RELOCATE_ELF_H

#include "layout-elf.h"
#include "compile-elf.h"
#include "jump-table.h"

#define PL_ERROR_X86_RELOCATE (-51)

typedef struct {
    pl_u64 records;
    pl_u64 code_fields;
    pl_u64 eliminated_code_fields;
    pl_u64 runtime_fields;
    pl_u64 rewritten_fields;
    pl_u64 dynamic_addends;
    pl_u64 dynamic_symbols;
    pl_u64 dynamic_code_pointers;
    pl_u64 lazy_binding_code_pointers;
    pl_u64 unwind_rows;
    pl_u64 unwind_ranges;
    pl_u64 unchanged_records;
    pl_u64 unresolved_records;
    pl_u64 first_unresolved_offset;
    pl_u64 metadata_failure_field;
    pl_u64 metadata_failure_target;
    pl_u64 projection_source;
    pl_u64 projection_source_end;
    pl_u64 projection_block_start;
    pl_u64 projection_block_end;
    pl_u64 projection_omitted_end;
    pl_u32 first_unresolved_type;
    pl_u32 first_unresolved_stage;
    pl_u32 metadata_failure_kind;
    pl_u32 metadata_failure_stage;
} pl_x86_relocation_report;

/* Rewrite every construction record that is affected by moved code.  Code
 * fields and unchanged runtime fields are still counted, so success proves a
 * total relocation population rather than merely finding no known problem. */
int pl_x86_relocate_elf(
    const pl_u8 *input, pl_u64 input_bytes,
    const pl_x86_runtime_elf_layout *runtime,
    const pl_x86_native_layout *native,
    const pl_x86_table *tables, pl_u32 table_count,
    pl_u8 *output, pl_u64 output_bytes,
    pl_x86_relocation_report *report);

#endif /* POSTLINK_RELOCATE_ELF_H */
