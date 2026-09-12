/* Section-owned executable coordinates are the exact code population.
 * Growing allocated non-code bytes inside PF_X must grow neither closure
 * coverage nor stored code or execution work. */

#include <postlink/compiler.h>
#include <x86/elf.h>
#include "../src/internal/native.h"

#include <stdlib.h>

enum {
    FIXTURE_BYTES = 2048,
    PROGRAM_AT = 64,
    SECTION_AT = 1024,
    TEXT_AT = 0x200,
    INIT_AT = 0x300,
    SYMTAB_AT = 1536,
    STRTAB_AT = 1568,
    RELA_AT = 1600,
};

static void header(pl_u8 bytes[FIXTURE_BYTES])
{
    bytes[0] = 0x7fu;
    bytes[1] = 'E';
    bytes[2] = 'L';
    bytes[3] = 'F';
    bytes[4] = 2u;
    bytes[5] = 1u;
    bytes[6] = 1u;
    pl_write_u16(bytes + 16u, PL_ELF_TYPE_EXEC);
    pl_write_u16(bytes + 18u, PL_ELF_MACHINE_X86_64);
    pl_write_u32(bytes + 20u, 1u);
    pl_write_u64(bytes + 24u, 0x400000u);
    pl_write_u64(bytes + 32u, PROGRAM_AT);
    pl_write_u64(bytes + 40u, SECTION_AT);
    pl_write_u16(bytes + 52u, PL_ELF_HEADER_BYTES);
    pl_write_u16(bytes + 54u, PL_ELF_PROGRAM_BYTES);
    pl_write_u16(bytes + 56u, 2u);
    pl_write_u16(bytes + 58u, PL_ELF_SECTION_BYTES);
    pl_write_u16(bytes + 60u, 7u);
}

static void program(pl_u8 *row, pl_u32 flags, pl_u64 file,
                    pl_u64 address, pl_u64 bytes)
{
    pl_write_u32(row, PL_ELF_SEGMENT_LOAD);
    pl_write_u32(row + 4u, flags);
    pl_write_u64(row + 8u, file);
    pl_write_u64(row + 16u, address);
    pl_write_u64(row + 24u, address);
    pl_write_u64(row + 32u, bytes);
    pl_write_u64(row + 40u, bytes);
    pl_write_u64(row + 48u, 0x100u);
}

static void section(pl_u8 *row, pl_u64 flags, pl_u64 address,
                    pl_u64 file, pl_u64 bytes)
{
    pl_write_u32(row + 4u, PL_ELF_SECTION_PROGBITS);
    pl_write_u64(row + 8u, flags);
    pl_write_u64(row + 16u, address);
    pl_write_u64(row + 24u, file);
    pl_write_u64(row + 32u, bytes);
    pl_write_u64(row + 48u, 16u);
}

static void fixture(pl_u8 bytes[FIXTURE_BYTES], pl_u64 pf_x_bytes)
{
    for (pl_u32 index = 0u; index < FIXTURE_BYTES; ++index)
        bytes[index] = 0u;
    header(bytes);
    program(bytes + PROGRAM_AT,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE,
            TEXT_AT, 0x400000u, pf_x_bytes);
    program(bytes + PROGRAM_AT + PL_ELF_PROGRAM_BYTES,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_WRITE,
            INIT_AT, 0x500000u, 0x20u);
    section(bytes + SECTION_AT + PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_ALLOC | PL_ELF_SECTION_EXECUTE,
            0x400000u, TEXT_AT, 0x10u);
    section(bytes + SECTION_AT + 2u * PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_ALLOC,
            0x400010u, TEXT_AT + 0x10u, pf_x_bytes - 0x10u);
    section(bytes + SECTION_AT + 3u * PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_ALLOC | PL_ELF_SECTION_EXECUTE,
            0x500000u, INIT_AT, 0x20u);
    pl_u8 *symbols = bytes + SECTION_AT + 4u * PL_ELF_SECTION_BYTES;
    pl_write_u32(symbols + 4u, PL_ELF_SECTION_SYMTAB);
    pl_write_u64(symbols + 24u, SYMTAB_AT);
    pl_write_u64(symbols + 32u, 24u);
    pl_write_u32(symbols + 40u, 5u);
    pl_write_u64(symbols + 48u, 8u);
    pl_write_u64(symbols + 56u, 24u);
    pl_u8 *strings = bytes + SECTION_AT + 5u * PL_ELF_SECTION_BYTES;
    pl_write_u32(strings + 4u, PL_ELF_SECTION_STRTAB);
    pl_write_u64(strings + 24u, STRTAB_AT);
    pl_write_u64(strings + 32u, 16u);
    pl_u8 *relocations = bytes + SECTION_AT + 6u * PL_ELF_SECTION_BYTES;
    pl_write_u32(relocations + 4u, PL_ELF_SECTION_RELA);
    pl_write_u64(relocations + 24u, RELA_AT);
    pl_write_u64(relocations + 32u, 24u);
    pl_write_u32(relocations + 40u, 4u);
    pl_write_u32(relocations + 44u, 1u);
    pl_write_u64(relocations + 48u, 8u);
    pl_write_u64(relocations + 56u, 24u);
}

static int measure(pl_u8 bytes[FIXTURE_BYTES], postlink_report *report)
{
    postlink_measurement measurement;
    int status = postlink_measure(
        bytes, FIXTURE_BYTES, &measurement, report);
    return status;
}

static int barrier_slice_is_not_a_size_cut(void)
{
    enum { NOPS = 65, BYTES = NOPS + 1 };
    pl_u8 code[BYTES];
    for (pl_u32 index = 0u; index < NOPS; ++index) code[index] = 0x90u;
    code[NOPS] = 0xc3u;
    pl_x86_map map = {
        code, 0x1000u, BYTES, BYTES,
        PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
    };
    pl_x86_image image = { &map, 1u, 0u, 0x1000u };
    pl_u64 workspace_bytes = 0u;
    int status = pl_x86_native_workspace_measure(BYTES, &workspace_bytes);
    pl_u8 *workspace = status ? 0 : malloc((size_t)workspace_bytes);
    if (!workspace) return 0;
    pl_u64 entry = 0x1000u;
    pl_x86_code_grid grids[2];
    pl_u32 grid_count = 0u;
    pl_x86_native_population population = { 0 };
    status = pl_x86_native_analyze(
        &image, 0, &entry, 1u, 1u,
        grids, 2u, &grid_count,
        workspace, workspace_bytes, &population);
    pl_u64 persistent_bytes = 0u;
    pl_u64 phase_bytes = 0u;
    pl_u64 future_bytes = 0u;
    pl_u32 *live_outputs = 0;
    pl_u8 *future_workspace = 0;
    if (!status)
        status = pl_x86_native_future_workspace_measure(
            population.blocks, &persistent_bytes, &phase_bytes);
    if (!status && !pl_checked_add_u64(
            persistent_bytes, phase_bytes, &future_bytes))
        status = -1;
    if (!status) {
        live_outputs = malloc(
            (size_t)population.blocks * sizeof *live_outputs);
        future_workspace = malloc((size_t)future_bytes);
        if (!live_outputs || !future_workspace) status = -1;
    }
    if (!status)
        status = pl_x86_native_project_live_outputs(
            &image, workspace, workspace_bytes,
            &population, grids, grid_count,
            live_outputs, population.blocks,
            future_workspace, future_bytes);
    free(future_workspace);
    free(live_outputs);
    free(workspace);
    /* RET is a precise cut, so the pure prefix and RET are two blocks.  The
     * prefix itself must retain all 65 instructions; the former product cap
     * manufactured an unrelated third block at instruction 64. */
    return !status && population.blocks == 2u
        && population.source_instructions == BYTES
        && population.maximum_source_instructions == NOPS;
}

int main(void)
{
    if (!barrier_slice_is_not_a_size_cut()) return 5;
    pl_u8 small[FIXTURE_BYTES];
    pl_u8 large[FIXTURE_BYTES];
    postlink_report small_report;
    postlink_report large_report;
    fixture(small, 0x20u);
    fixture(large, 0x40u);
    if (measure(small, &small_report) || measure(large, &large_report))
        return 1;
    if (small_report.executable_coordinates != 0x30u
            || large_report.executable_coordinates != 0x30u)
        return 2;
    if (small_report.input_code_bytes != 0x30u
            || large_report.input_code_bytes != 0x30u)
        return 3;
    /* Capacity measurement never decodes PF_X.  In particular, extending a
     * non-code tail cannot introduce a second all-coordinate compiler pass. */
    if (small_report.input_work || large_report.input_work
            || small_report.input_span || large_report.input_span
            || small_report.direct_coordinates
            || large_report.direct_coordinates)
        return 4;
    return 0;
}
