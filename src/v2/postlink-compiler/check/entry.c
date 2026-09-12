#include "../src/internal/entry.h"
#include "../src/internal/metadata.h"
#include "../src/internal/table.h"

#include <stdio.h>
#include <stdlib.h>

typedef struct {
    pl_u64 begin;
    pl_u64 end;
} metadata_range;

static int list_metadata_pointer(
    void *context, const pl_x86_metadata_pointer *pointer)
{
    const metadata_range *range = context;
    if (pointer->target_address >= range->begin
            && pointer->target_address < range->end)
        printf("metadata kind=%u field=0x%llx target=0x%llx extent=%llu\n",
               pointer->kind,
               (unsigned long long)pointer->field_address,
               (unsigned long long)pointer->target_address,
               (unsigned long long)pointer->source_extent);
    return 0;
}

static int list_table_rows(const pl_elf_image *elf,
                           const pl_x86_table *tables, pl_u32 table_count,
                           pl_u64 begin, pl_u64 end)
{
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section section;
        int status = pl_elf_section_read(elf, section_index, &section);
        if (status) return status;
        if (section.type != PL_ELF_SECTION_RELA || !section.info) continue;
        pl_elf_section place;
        status = pl_elf_section_read(elf, section.info, &place);
        if (status) return status;
        pl_x86_table_cursor cursor = { 0 };
        pl_u64 count = section.file_bytes / section.entry_bytes;
        for (pl_u64 row = 0u; row < count; ++row) {
            pl_elf_relocation relocation;
            pl_elf_symbol symbol;
            status = pl_elf_relocation_read(
                elf, section_index, row, &relocation);
            if (!status)
                status = pl_elf_symbol_read(
                    elf, relocation.symbol_table_section,
                    relocation.symbol_index, &symbol);
            int recognized = 0;
            pl_u64 base = 0u;
            pl_u64 target = 0u;
            if (!status)
                status = pl_x86_table_row(
                    elf, &relocation, &symbol, &place,
                    tables, table_count, &cursor,
                    &recognized, &base, &target);
            if (status) return status;
            if (recognized && target >= begin && target < end)
                printf("table base=0x%llx field=0x%llx target=0x%llx\n",
                       (unsigned long long)base,
                       (unsigned long long)relocation.offset,
                       (unsigned long long)target);
        }
    }
    return 0;
}

int main(int argc, char **argv)
{
    int list_range = argc == 4;
    if (argc != 2 && !list_range) return 2;
    pl_u64 range_begin = list_range
        ? (pl_u64)strtoull(argv[2], 0, 0) : 0u;
    pl_u64 range_end = list_range
        ? (pl_u64)strtoull(argv[3], 0, 0) : 0u;
    if (list_range && range_end <= range_begin) return 2;
    FILE *file = fopen(argv[1], "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 2;
    long extent = ftell(file);
    if (extent <= 0 || fseek(file, 0, SEEK_SET)) return 2;
    pl_u8 *bytes = malloc((size_t)extent);
    if (!bytes || fread(bytes, 1u, (size_t)extent, file) != (size_t)extent
            || fclose(file))
        return 2;
    pl_elf_image image;
    pl_x86_map maps[64];
    pl_x86_image executable_image;
    pl_u32 map_count = 0u;
    pl_u64 executable_entry = 0u;
    int executable_entry_present = 0;
    pl_x86_entry_population measured;
    int status = pl_elf_open(bytes, (pl_u64)extent, &image);
    if (status) fprintf(stderr, "entry: ELF open failed (%d)\n", status);
    if (!status) {
        status = pl_elf_process_entry(
            &image, &executable_entry, &executable_entry_present);
        if (status)
            fprintf(stderr, "entry: process coordinate failed (%d)\n",
                    status);
    }
    if (!status) {
        status = pl_x86_elf_map_count(&image, &map_count);
        if (!status && (!map_count || map_count > 64u)) status = -1;
        if (!status)
            status = pl_x86_image_from_elf_code_coordinates(
                &image, 0u, 0u, PL_X86_ELF_VIRTUAL,
                maps, 64u, &executable_image);
    }
    if (!status) {
        status = pl_x86_entry_measure(
            &image, &executable_image, &measured);
        if (status)
            fprintf(stderr, "entry: population measure failed (%d)\n",
                    status);
    }
    if (status || !measured.candidate_count)
        return 1;
    pl_u64 *entries = malloc(
        (size_t)measured.candidate_count * sizeof *entries);
    pl_u64 *scratch = malloc(
        (size_t)measured.candidate_count * sizeof *scratch);
    pl_u8 *roles = malloc((size_t)measured.candidate_count);
    pl_u8 *role_scratch = malloc((size_t)measured.candidate_count);
    pl_x86_code_grid *code_grids = malloc(
        (size_t)(measured.code_grid_candidate_count
                 ? measured.code_grid_candidate_count : 1u)
        * sizeof *code_grids);
    pl_x86_table *tables = malloc(
        (size_t)(measured.table_base_candidate_count
                 ? measured.table_base_candidate_count : 1u)
        * sizeof *tables);
    pl_x86_table *table_scratch = malloc(
        (size_t)(measured.table_base_candidate_count
                 ? measured.table_base_candidate_count : 1u)
        * sizeof *table_scratch);
    pl_x86_entry_population written;
    if (!entries || !scratch || !roles || !role_scratch || !code_grids
            || !tables || !table_scratch) {
        fprintf(stderr,
                "entry: allocation failed (%u entry, %u table candidates)\n",
                measured.candidate_count,
                measured.table_base_candidate_count);
        return 1;
    }
    status = pl_x86_entry_write(
        &image, &executable_image,
        entries, measured.candidate_count,
        scratch, measured.candidate_count,
        roles, role_scratch,
        code_grids, measured.code_grid_candidate_count,
        tables, measured.table_base_candidate_count,
        table_scratch, measured.table_base_candidate_count,
        (pl_u8 *)(void *)scratch,
        (pl_u64)measured.candidate_count * sizeof *scratch,
        &written);
    if (status) {
        fprintf(stderr,
                "entry: population write failed (%d; %u entry, %u table candidates)\n",
                status, measured.candidate_count,
                measured.table_base_candidate_count);
        return 1;
    }
    if (written.candidate_count > measured.candidate_count
            || !written.entry_count
            || written.entry_count > written.candidate_count
            || written.address_observable_count > written.entry_count) {
        fprintf(stderr,
                "entry: population bounds invalid (%u/%u candidates, %u entries)\n",
                written.candidate_count, measured.candidate_count,
                written.entry_count);
        return 1;
    }
    if (!written.primary_count
            || written.primary_count > written.entry_count)
        return 1;
    for (pl_u32 index = 1u; index < written.primary_count; ++index)
        if (entries[index - 1u] >= entries[index]) return 1;
    for (pl_u32 index = written.primary_count + 1u;
            index < written.entry_count; ++index)
        if (entries[index - 1u] >= entries[index]) return 1;
    pl_u32 observable = 0u;
    for (pl_u32 index = 0u; index < written.entry_count; ++index) {
        if (!(roles[index] & PL_X86_ENTRY_EXECUTION_ROOT)) return 1;
        if (roles[index] & PL_X86_ENTRY_ADDRESS_VALUE) ++observable;
    }
    if (observable != written.address_observable_count) return 1;
    int entry_present = 0;
    for (pl_u32 index = 0u; index < written.entry_count; ++index)
        if (entries[index] == executable_entry) entry_present = 1;
    if (executable_entry_present != entry_present) return 1;
    if (list_range)
        for (pl_u32 index = 0u; index < written.entry_count; ++index)
            if (entries[index] >= range_begin && entries[index] < range_end)
                printf("%s entry 0x%llx roles=0x%x\n",
                       index < written.primary_count
                         ? "primary" : "metadata",
                       (unsigned long long)entries[index], roles[index]);
    if (list_range)
        for (pl_u32 index = 0u; index < written.code_grid_count; ++index) {
            const pl_x86_code_grid *grid = &code_grids[index];
            pl_u64 end = grid->start + grid->bytes;
            if (grid->start < range_end && end > range_begin)
                printf("code extent 0x%llx..0x%llx stride=%u count=%u flags=0x%x\n",
                       (unsigned long long)grid->start,
                       (unsigned long long)end,
                       grid->stride, grid->count, grid->flags);
        }
    if (list_range)
        for (pl_u32 index = 0u; index < written.table_base_count; ++index)
            if (tables[index].base >= range_begin
                    && tables[index].base < range_end)
                printf("table descriptor base=0x%llx rows=%u\n",
                       (unsigned long long)tables[index].base,
                       tables[index].rows);
    if (list_range
            && list_table_rows(
                &image, tables, written.table_base_count,
                range_begin, range_end))
        return 1;
    if (list_range) {
        metadata_range range = { range_begin, range_end };
        pl_x86_metadata_report report;
        if (pl_x86_metadata_walk(
                &image, list_metadata_pointer, &range, &report))
            return 1;
    }
    printf("recognized table projection: %u bases, %u rows\n",
           written.table_base_count, written.table_target_count);
    printf("native entry population: green (%u candidates -> %u primary + %u metadata entries; %u observable addresses)\n",
           written.candidate_count, written.primary_count,
           written.entry_count - written.primary_count,
           written.address_observable_count);
    free(role_scratch);
    free(roles);
    free(code_grids);
    free(scratch);
    free(table_scratch);
    free(tables);
    free(entries);
    free(bytes);
    return 0;
}
