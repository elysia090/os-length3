#include <x86/decode.h>

enum {
    FIXTURE_BYTES = 2048,
    PROGRAM_AT = 64,
    SECTION_AT = 512,
    TEXT_AT = 0x200,
    INIT_AT = 0x300,
};

static void header(pl_u8 bytes[FIXTURE_BYTES], int sections)
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
    pl_write_u64(bytes + 40u, sections ? SECTION_AT : 0u);
    pl_write_u16(bytes + 52u, PL_ELF_HEADER_BYTES);
    pl_write_u16(bytes + 54u, PL_ELF_PROGRAM_BYTES);
    pl_write_u16(bytes + 56u, 2u);
    pl_write_u16(bytes + 58u,
                 sections ? PL_ELF_SECTION_BYTES : 0u);
    pl_write_u16(bytes + 60u, sections ? 4u : 0u);
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

static pl_u64 map_bytes(const pl_x86_image *image)
{
    pl_u64 total = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index)
        total += image->maps[index].memory_bytes;
    return total;
}

int main(void)
{
    pl_u8 bytes[FIXTURE_BYTES] = { 0 };
    header(bytes, 1);
    program(bytes + PROGRAM_AT,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE,
            TEXT_AT, 0x400000u, 0x40u);
    program(bytes + PROGRAM_AT + PL_ELF_PROGRAM_BYTES,
            PL_ELF_FLAG_READ | PL_ELF_FLAG_WRITE,
            INIT_AT, 0x500000u, 0x20u);
    section(bytes + SECTION_AT + PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_ALLOC | PL_ELF_SECTION_EXECUTE,
            0x400000u, TEXT_AT, 0x10u);
    section(bytes + SECTION_AT + 2u * PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_ALLOC,
            0x400010u, TEXT_AT + 0x10u, 0x30u);
    section(bytes + SECTION_AT + 3u * PL_ELF_SECTION_BYTES,
            PL_ELF_SECTION_ALLOC | PL_ELF_SECTION_EXECUTE,
            0x500000u, INIT_AT, 0x20u);

    pl_elf_image elf;
    if (pl_elf_open(bytes, sizeof bytes, &elf)) return 1;
    pl_u32 full_count = 0u, code_count = 0u;
    if (pl_x86_elf_map_count(&elf, &full_count)
            || pl_x86_elf_code_map_count(&elf, &code_count)
            || full_count != 2u || code_count != 2u)
        return 2;
    pl_x86_map full_maps[2], code_maps[2];
    pl_x86_image full, code;
    if (pl_x86_image_from_elf(&elf, 0u, 7u,
                              full_maps, 2u, &full)
            || pl_x86_image_from_elf_code(&elf, 0u, 7u,
                                          code_maps, 2u, &code))
        return 3;
    if (map_bytes(&full) != 0x60u || map_bytes(&code) != 0x30u
            || code.maps[0].address != 0x400000u
            || code.maps[0].memory_bytes != 0x10u
            || code.maps[1].address != 0x500000u
            || code.maps[1].memory_bytes != 0x20u)
        return 4;

    pl_u64 entry = 0u;
    int entry_present = 0;
    if (pl_elf_process_entry(&elf, &entry, &entry_present)
            || !entry_present || entry != 0x400000u
            || pl_elf_executable_entry(&elf, &entry))
        return 5;

    /* A boot-linked image can name the same byte through p_paddr.  Its
     * canonical compiler coordinate is still the executable virtual one. */
    pl_write_u64(bytes + 24u, 0x100008u);
    pl_write_u64(bytes + PROGRAM_AT + 24u, 0x100000u);
    if (pl_elf_open(bytes, sizeof bytes, &elf)
            || pl_elf_executable_entry(&elf, &entry)
            || entry != 0x400008u)
        return 6;

    /* A shared object has no process entry.  Its executable symbols and
     * loader metadata form the callable root population. */
    header(bytes, 1);
    pl_write_u16(bytes + 16u, PL_ELF_TYPE_DYN);
    pl_write_u64(bytes + 24u, 0u);
    if (pl_elf_open(bytes, sizeof bytes, &elf)
            || pl_elf_process_entry(&elf, &entry, &entry_present)
            || entry_present || entry
            || pl_elf_executable_entry(&elf, &entry) != PL_ERROR_ELF)
        return 7;

    header(bytes, 0);
    if (pl_elf_open(bytes, sizeof bytes, &elf)
            || pl_x86_elf_code_map_count(&elf, &code_count)
            || code_count != 1u
            || pl_x86_image_from_elf_code(
                &elf, 0u, 9u, code_maps, 2u, &code)
            || map_bytes(&code) != 0x40u)
        return 8;
    return 0;
}
