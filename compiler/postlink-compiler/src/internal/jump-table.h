/* Linked x86 shared-base dispatch tables. */

#ifndef POSTLINK_JUMP_TABLE_H
#define POSTLINK_JUMP_TABLE_H

#include <x86/decode.h>

/* A shared-base dispatch exists whose rows no proof bounded. */
#define PL_ERROR_TABLE_UNPROVED (-71)

typedef struct {
    pl_u64 base;
    pl_u64 consumer;
    pl_u32 rows;
    pl_u8 index_register;
    pl_u8 index_bits;
    pl_u16 clobber_mask;
    /* Relocation can know a finite prefix's shared-base encoding without
     * proving that an unrelated indirect edge cannot reenter the consumer.
     * Only a closed domain may discharge a control-flow bound. */
    pl_u8 domain_closed;
} pl_x86_table;

typedef struct {
    pl_x86_table current;
    pl_u64 previous_field;
    pl_u32 table_cursor;
    pl_u8 in_table;
} pl_x86_table_cursor;

enum pl_x86_relocation_field_kind {
    PL_X86_RELOCATION_DISPLACEMENT = 1,
    PL_X86_RELOCATION_IMMEDIATE = 2,
    PL_X86_RELOCATION_DIRECT_CONTROL = 3,
};

/* Measurement is an allocation bound. Writing proves the exact shared-base
 * load/add/indirect-jump encoding and separately marks closed index domains.
 * A relocation-shaped datum alone does not prove either property. */
int pl_x86_table_base_measure(const pl_elf_image *elf, pl_u32 *capacity);
int pl_x86_table_function_index_measure(
    const pl_elf_image *elf, pl_u32 *symbol_rows, pl_u64 *maximum_extent);
int pl_x86_table_cfg_workspace_measure(pl_u64 extent, pl_u64 *bytes);
int pl_x86_table_base_write(
    const pl_elf_image *elf, const pl_x86_image *image,
    const pl_u64 *function_entries, pl_u32 function_count,
    pl_x86_table *tables, pl_u32 capacity,
    pl_x86_table *scratch, pl_u32 scratch_capacity,
    pl_u8 *analysis_workspace, pl_u64 analysis_workspace_bytes,
    pl_u32 *count);

/* Recover the instruction owning a construction relocation field. */
int pl_x86_relocation_instruction(
    const pl_x86_image *image, pl_u64 field, pl_u32 field_kind,
    pl_x86_instruction *instruction);

/* Consume one relocation from an address-ordered relocation section.  A
 * recognized row returns the exact runtime target and the shared base used by
 * the x86 consumer, rather than the relocation field's S+A pseudo-coordinate.
 */
int pl_x86_table_row(
    const pl_elf_image *elf, const pl_elf_relocation *relocation,
    const pl_elf_symbol *symbol, const pl_elf_section *place_section,
    const pl_x86_table *tables, pl_u32 table_count,
    pl_x86_table_cursor *cursor, int *recognized,
    pl_u64 *base, pl_u64 *target);

#endif /* POSTLINK_TABLE_H */
