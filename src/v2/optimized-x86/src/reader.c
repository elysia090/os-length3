#include <optimized-x86/reader.h>
#include <support/checked.h>
#include <support/sha256.h>

#define ELF_HEADER_BYTES 64u
#define ELF_SECTION_BYTES 64u
#define ELF_MACHINE_X86_64 62u
#define ELF_TYPE_EXEC 2u
#define ELF_TYPE_DYN 3u
#define ELF_SECTION_SYMTAB 2u
#define ELF_SECTION_STRTAB 3u
#define ELF_SECTION_NOTE 7u
#define ELF_SYMBOL_BYTES 24u
#define ELF_SHN_ABS 0xfff1u
#define ELF_STB_GLOBAL 1u
#define ELF_STT_NOTYPE 0u
#define GNU_BUILD_ID_TYPE 3u

typedef struct {
    pl_u32 name;
    pl_u32 type;
    pl_u64 offset;
    pl_u64 bytes;
    pl_u32 link;
    pl_u64 entry_bytes;
} section;

typedef struct {
    const char *name;
    pl_u64 *value;
    pl_u32 seen;
} field;

static pl_u64 align4(pl_u64 value)
{
    return (value + 3u) & ~3ull;
}

static int bytes_equal(const pl_u8 *left, const char *right, pl_u32 bytes)
{
    pl_u32 index;
    for (index = 0u; index < bytes; ++index)
        if (left[index] != (pl_u8)right[index]) return 0;
    return 1;
}

static int name_equal(const pl_u8 *table, pl_u64 bytes, pl_u32 at,
                      const char *expected)
{
    pl_u64 index = at;
    if (at >= bytes) return 0;
    while (expected[index - at]) {
        if (index >= bytes || table[index] != (pl_u8)expected[index - at])
            return 0;
        ++index;
    }
    return index < bytes && table[index] == 0u;
}

static int read_section(const pl_u8 *elf, pl_u64 length,
                        pl_u64 section_offset, pl_u32 section_count,
                        pl_u32 index, section *out)
{
    pl_u64 at;
    const pl_u8 *row;
    if (!out || index >= section_count) return OX_ERROR_ELF;
    if (!pl_checked_mul_u64(index, ELF_SECTION_BYTES, &at)
            || !pl_checked_add_u64(section_offset, at, &at)
            || !pl_checked_extent(at, ELF_SECTION_BYTES, length))
        return OX_ERROR_RANGE;
    row = elf + at;
    out->name = pl_read_u32(row);
    out->type = pl_read_u32(row + 4u);
    out->offset = pl_read_u64(row + 24u);
    out->bytes = pl_read_u64(row + 32u);
    out->link = pl_read_u32(row + 40u);
    out->entry_bytes = pl_read_u64(row + 56u);
    if (out->type != 8u
            && !pl_checked_extent(out->offset, out->bytes, length))
        return OX_ERROR_RANGE;
    return 0;
}

static int read_build_id(const pl_u8 *elf, const section *note,
                         ox_proof *proof, pl_u64 *descriptor_at)
{
    pl_u64 at = 0u;
    while (at < note->bytes) {
        pl_u64 names_at, desc_at, next;
        pl_u32 names, desc, type;
        const pl_u8 *row;
        if (!pl_checked_extent(at, 12u, note->bytes)) return OX_ERROR_ELF;
        row = elf + note->offset + at;
        names = pl_read_u32(row);
        desc = pl_read_u32(row + 4u);
        type = pl_read_u32(row + 8u);
        names_at = at + 12u;
        if (!pl_checked_add_u64(names_at, align4(names), &desc_at)
                || !pl_checked_add_u64(desc_at, align4(desc), &next)
                || next > note->bytes)
            return OX_ERROR_RANGE;
        if (type == GNU_BUILD_ID_TYPE && names == 4u
                && bytes_equal(elf + note->offset + names_at, "GNU\0", 4u)) {
            pl_u32 index;
            if (proof->build_id_bytes || desc != PL_SHA256_BYTES)
                return proof->build_id_bytes
                     ? OX_ERROR_DUPLICATE : OX_ERROR_BUILD_ID;
            proof->build_id_bytes = desc;
            *descriptor_at = note->offset + desc_at;
            for (index = 0u; index < desc; ++index)
                proof->build_id[index] = elf[note->offset + desc_at + index];
        }
        at = next;
    }
    return 0;
}

static int verify_build_id(const pl_u8 *bytes, pl_u64 length,
                           pl_u64 descriptor_at, const ox_proof *proof)
{
    pl_sha256 hash;
    pl_u8 zero[PL_SHA256_BYTES] = { 0u };
    pl_u8 digest[PL_SHA256_BYTES];
    if (!descriptor_at || proof->build_id_bytes != PL_SHA256_BYTES
            || !pl_checked_extent(descriptor_at, PL_SHA256_BYTES, length))
        return OX_ERROR_BUILD_ID;
    pl_sha256_open(&hash);
    pl_sha256_write(&hash, bytes, descriptor_at);
    pl_sha256_write(&hash, zero, PL_SHA256_BYTES);
    pl_sha256_write(&hash, bytes + descriptor_at + PL_SHA256_BYTES,
                    length - descriptor_at - PL_SHA256_BYTES);
    pl_sha256_close(&hash, digest);
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        if (digest[index] != proof->build_id[index])
            return OX_ERROR_BUILD_ID;
    return 0;
}

static int read_symbols(const pl_u8 *elf, pl_u64 length,
                        pl_u64 section_offset, pl_u32 section_count,
                        const section *symbols, field *fields,
                        pl_u32 field_count)
{
    section strings;
    pl_u64 count, rank;
    int status;
    if (symbols->entry_bytes != ELF_SYMBOL_BYTES
            || symbols->bytes % ELF_SYMBOL_BYTES
            || symbols->link >= section_count)
        return OX_ERROR_ELF;
    status = read_section(elf, length, section_offset, section_count,
                          symbols->link, &strings);
    if (status) return status;
    if (strings.type != ELF_SECTION_STRTAB) return OX_ERROR_ELF;
    count = symbols->bytes / ELF_SYMBOL_BYTES;
    for (rank = 1u; rank < count; ++rank) {
        const pl_u8 *row = elf + symbols->offset + rank * ELF_SYMBOL_BYTES;
        pl_u32 name = pl_read_u32(row);
        pl_u32 info = row[4u];
        pl_u32 other = row[5u];
        pl_u32 shndx = pl_read_u16(row + 6u);
        pl_u64 value = pl_read_u64(row + 8u);
        pl_u64 size = pl_read_u64(row + 16u);
        pl_u32 index;
        if (!name) continue;
        for (index = 0u; index < field_count; ++index) {
            if (!name_equal(elf + strings.offset, strings.bytes,
                            name, fields[index].name))
                continue;
            if (fields[index].seen++) return OX_ERROR_DUPLICATE;
            if ((info >> 4u) != ELF_STB_GLOBAL
                    || (info & 15u) != ELF_STT_NOTYPE
                    || other != 0u || shndx != ELF_SHN_ABS || size != 0u)
                return OX_ERROR_PROOF;
            *fields[index].value = value;
        }
    }
    return 0;
}

int ox_image_open(const pl_u8 *bytes, pl_u64 length, ox_image *out)
{
    pl_u64 section_offset, table_bytes;
    pl_u64 build_id_at = 0u;
    pl_u64 elf_entry;
    pl_u32 section_count, section_bytes, section_names, index;
    pl_u32 elf_type;
    ox_proof proof = { 0 };
    section names;
    field fields[OX_PROOF_SYMBOL_COUNT] = {
        { OX_SYMBOL_PROOF_VERSION, &proof.proof_version, 0u },
        { OX_SYMBOL_MACHINE_ABI, &proof.machine_abi, 0u },
        { OX_SYMBOL_FLAGS, &proof.flags, 0u },
        { OX_SYMBOL_SOURCE_SHA256_0, &proof.source_sha256[0], 0u },
        { OX_SYMBOL_SOURCE_SHA256_1, &proof.source_sha256[1], 0u },
        { OX_SYMBOL_SOURCE_SHA256_2, &proof.source_sha256[2], 0u },
        { OX_SYMBOL_SOURCE_SHA256_3, &proof.source_sha256[3], 0u },
        { OX_SYMBOL_SOURCE_BYTES, &proof.source_bytes, 0u },
        { OX_SYMBOL_ENTRY_FUNCTION, &proof.entry_function, 0u },
        { OX_SYMBOL_FUNCTION_COUNT, &proof.function_count, 0u },
        { OX_SYMBOL_COORDINATE_COUNT, &proof.coordinate_count, 0u },
        { OX_SYMBOL_DIRECT_COUNT, &proof.direct_count, 0u },
        { OX_SYMBOL_FAULT_COUNT, &proof.fault_count, 0u },
        { OX_SYMBOL_INPUT_SPAN, &proof.input_span, 0u },
        { OX_SYMBOL_OUTPUT_SPAN, &proof.output_span, 0u },
        { OX_SYMBOL_INPUT_WORK, &proof.input_work, 0u },
        { OX_SYMBOL_OUTPUT_WORK, &proof.output_work, 0u },
        { OX_SYMBOL_MINIMUM_SPAN, &proof.minimum_span, 0u },
        { OX_SYMBOL_MINIMUM_WORK, &proof.minimum_work, 0u },
        { OX_SYMBOL_PARETO_COMPLETE, &proof.pareto_complete, 0u },
        { OX_SYMBOL_INPUT_CODE_BYTES, &proof.input_code_bytes, 0u },
        { OX_SYMBOL_OUTPUT_CODE_BYTES, &proof.output_code_bytes, 0u },
    };
    if (!bytes || !out || length < ELF_HEADER_BYTES
            || bytes[0] != 0x7fu || bytes[1] != 'E' || bytes[2] != 'L'
            || bytes[3] != 'F' || bytes[4] != 2u || bytes[5] != 1u
            || bytes[6] != 1u
            || (pl_read_u16(bytes + 16u) != ELF_TYPE_EXEC
                && pl_read_u16(bytes + 16u) != ELF_TYPE_DYN)
            || pl_read_u16(bytes + 18u) != ELF_MACHINE_X86_64
            || pl_read_u32(bytes + 20u) != 1u
            || pl_read_u16(bytes + 52u) != ELF_HEADER_BYTES)
        return OX_ERROR_ELF;
    elf_type = pl_read_u16(bytes + 16u);
    elf_entry = pl_read_u64(bytes + 24u);
    section_offset = pl_read_u64(bytes + 40u);
    section_bytes = pl_read_u16(bytes + 58u);
    section_count = pl_read_u16(bytes + 60u);
    section_names = pl_read_u16(bytes + 62u);
    if (!section_offset || section_bytes != ELF_SECTION_BYTES
            || !section_count || section_count == 0xffffu
            || section_names >= section_count
            || !pl_checked_mul_u64(section_count, ELF_SECTION_BYTES,
                                   &table_bytes)
            || !pl_checked_extent(section_offset, table_bytes, length))
        return OX_ERROR_RANGE;
    if (read_section(bytes, length, section_offset, section_count,
                     section_names, &names)
            || names.type != ELF_SECTION_STRTAB)
        return OX_ERROR_ELF;
    for (index = 0u; index < section_count; ++index) {
        section current;
        int status = read_section(bytes, length, section_offset,
                                  section_count, index, &current);
        if (status) return status;
        if (current.type == ELF_SECTION_NOTE) {
            status = read_build_id(bytes, &current, &proof, &build_id_at);
            if (status) return status;
        } else if (current.type == ELF_SECTION_SYMTAB) {
            status = read_symbols(bytes, length, section_offset,
                                  section_count, &current, fields,
                                  OX_PROOF_SYMBOL_COUNT);
            if (status) return status;
        }
    }
    for (index = 0u; index < OX_PROOF_SYMBOL_COUNT; ++index)
        if (fields[index].seen != 1u) return OX_ERROR_PROOF;
    if (ox_proof_validate(&proof))
        return OX_ERROR_PROOF;
    if ((proof.entry_function == OX_PROOF_NO_ENTRY_FUNCTION)
            != (elf_type == ELF_TYPE_DYN && elf_entry == 0u))
        return OX_ERROR_PROOF;
    if (length >= proof.source_bytes) return OX_ERROR_PROOF;
    if (verify_build_id(bytes, length, build_id_at, &proof))
        return OX_ERROR_BUILD_ID;
    out->bytes = bytes;
    out->length = length;
    out->entry = elf_entry;
    out->proof = proof;
    return 0;
}
