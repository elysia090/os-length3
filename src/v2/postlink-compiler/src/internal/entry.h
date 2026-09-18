/* Finite native entry population derived from one linked ELF. */

#ifndef POSTLINK_ENTRY_H
#define POSTLINK_ENTRY_H

#include <x86/decode.h>
#include "table.h"

typedef struct {
    pl_u64 start;
    pl_u64 bytes;
    pl_u32 stride;
    pl_u32 count;
    pl_u32 flags;
} pl_x86_code_grid;

#define PL_X86_CODE_GRID_SOURCE_IDENTITY 1u

typedef struct {
    pl_u32 candidate_count;
    pl_u32 entry_count;
    pl_u32 primary_candidate_count;
    pl_u32 primary_count;
    pl_u32 table_base_candidate_count;
    pl_u32 table_base_count;
    pl_u32 table_target_count;
    pl_u32 address_observable_count;
    pl_u32 code_grid_candidate_count;
    pl_u32 code_grid_count;
} pl_x86_entry_population;

enum pl_x86_entry_role {
    PL_X86_ENTRY_EXECUTION_ROOT = 1u,
    PL_X86_ENTRY_ADDRESS_VALUE = 2u,
    PL_X86_ENTRY_SOURCE_IDENTITY = 4u,
};

/* Measure the exact pre-dedup population. Primary executable entries and
 * metadata code-coordinate candidates remain distinct: native closure can
 * classify an interior metadata target as a relocated field rather than
 * inventing an overlapping x86 entry. */
int pl_x86_entry_measure(const pl_elf_image *image,
                         const pl_x86_image *executable_image,
                         pl_x86_entry_population *out);

int pl_x86_entry_write(const pl_elf_image *image,
                       const pl_x86_image *executable_image,
                       pl_u64 *entries, pl_u32 entry_capacity,
                       pl_u64 *scratch, pl_u32 scratch_capacity,
                       pl_u8 *roles, pl_u8 *role_scratch,
                       pl_x86_code_grid *code_grids,
                       pl_u32 code_grid_capacity,
                       pl_x86_table *tables, pl_u32 table_capacity,
                       pl_x86_table *table_scratch,
                       pl_u32 table_scratch_capacity,
                       pl_u8 *analysis_workspace,
                       pl_u64 analysis_workspace_bytes,
                       pl_x86_entry_population *out);

#endif /* POSTLINK_ENTRY_H */
