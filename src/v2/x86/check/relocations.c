#include <x86/elf.h>

enum {
    FIXTURE_BYTES = 2048,
    PROGRAM_AT = 64,
    SECTION_AT = 256,
    TEXT_AT = 1024,
    SYMTAB_AT = 1152,
    STRTAB_AT = 1216,
    RELA_AT = 1280,
    SECTION_COUNT = 5,
};

static void section(pl_u8 *row, pl_u32 type, pl_u64 flags,
                    pl_u64 address, pl_u64 file, pl_u64 bytes,
                    pl_u32 link, pl_u32 info, pl_u64 entry_bytes)
{
    pl_write_u32(row + 4u, type);
    pl_write_u64(row + 8u, flags);
    pl_write_u64(row + 16u, address);
    pl_write_u64(row + 24u, file);
    pl_write_u64(row + 32u, bytes);
    pl_write_u32(row + 40u, link);
    pl_write_u32(row + 44u, info);
    pl_write_u64(row + 48u, 8u);
    pl_write_u64(row + 56u, entry_bytes);
}

int main(void)
{
    pl_u8 bytes[FIXTURE_BYTES] = { 0 };
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
    pl_write_u16(bytes + 56u, 1u);
    pl_write_u16(bytes + 58u, PL_ELF_SECTION_BYTES);
    pl_write_u16(bytes + 60u, SECTION_COUNT);

    pl_u8 *program = bytes + PROGRAM_AT;
    pl_write_u32(program, PL_ELF_SEGMENT_LOAD);
    pl_write_u32(program + 4u, PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE);
    pl_write_u64(program + 8u, TEXT_AT);
    pl_write_u64(program + 16u, 0x400000u);
    pl_write_u64(program + 24u, 0x400000u);
    pl_write_u64(program + 32u, 16u);
    pl_write_u64(program + 40u, 16u);
    pl_write_u64(program + 48u, 0x100u);

    section(bytes + SECTION_AT + PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_PROGBITS,
            PL_ELF_SECTION_ALLOC | PL_ELF_SECTION_EXECUTE,
            0x400000u, TEXT_AT, 16u, 0u, 0u, 0u);
    section(bytes + SECTION_AT + 2u * PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_SYMTAB, 0u,
            0u, SYMTAB_AT, 48u, 3u, 0u, 24u);
    section(bytes + SECTION_AT + 3u * PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_STRTAB, 0u,
            0u, STRTAB_AT, 16u, 0u, 0u, 0u);
    section(bytes + SECTION_AT + 4u * PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_RELA, 0u,
            0u, RELA_AT, 24u, 2u, 1u, 24u);
    pl_u8 *symbol = bytes + SYMTAB_AT + PL_ELF_SYMBOL_BYTES;
    pl_write_u32(symbol, 1u);
    symbol[4u] = (pl_u8)((1u << 4u) | PL_ELF_SYMBOL_FUNCTION);
    pl_write_u16(symbol + 6u, 1u);
    pl_write_u64(symbol + 8u, 0x400000u);
    pl_write_u64(symbol + 16u, 16u);
    pl_u8 *relocation = bytes + RELA_AT;
    pl_write_u64(relocation, 0x400004u);
    pl_write_u64(relocation + 8u, (1ull << 32u) | 2u);
    pl_write_u64(relocation + 16u, ~3ull);

    pl_elf_image image;
    pl_elf_code_relocations population;
    if (pl_elf_open(bytes, sizeof bytes, &image)
            || pl_elf_code_relocation_population(&image, &population)
            || population.executable_sections != 1u
            || population.relocated_executable_sections != 1u
            || population.relocation_records != 1u)
        return 1;
    pl_elf_symbol opened_symbol;
    pl_elf_relocation opened_relocation;
    if (pl_elf_symbol_read(&image, 2u, 1u, &opened_symbol)
            || opened_symbol.name_offset != 1u
            || opened_symbol.section_index != 1u
            || opened_symbol.type != PL_ELF_SYMBOL_FUNCTION
            || opened_symbol.value != 0x400000u
            || opened_symbol.bytes != 16u
            || pl_elf_relocation_read(&image, 4u, 0u,
                                      &opened_relocation)
            || opened_relocation.offset != 0x400004u
            || opened_relocation.symbol_index != 1u
            || opened_relocation.type != 2u
            || opened_relocation.addend_bits != ~3ull
            || opened_relocation.target_section != 1u
            || opened_relocation.symbol_table_section != 2u)
        return 2;

    /* A dynamic-style RELA row with no target section is not construction
     * evidence for a code rewriter. */
    pl_write_u32(bytes + SECTION_AT
                 + 4u * PL_ELF_SECTION_BYTES + 44u, 0u);
    if (pl_elf_open(bytes, sizeof bytes, &image)
            || pl_elf_code_relocation_population(&image, &population)
            || population.executable_sections != 1u
            || population.relocated_executable_sections != 0u
            || population.relocation_records != 0u)
        return 3;
    return 0;
}
