/* Standard x86-64 ELF proof writer.
 *
 * Runtime bytes remain exactly where the input program headers place them.
 * Non-runtime section tails are replaced by one canonical proof spelling.
 * The GNU build-id is SHA-256 over the complete output with its own 32-byte
 * descriptor zeroed, making it independently recomputable without a sidecar.
 */

#include "internal/emit-x86.h"

#include <optimized-x86/reader.h>
#include <support/checked.h>
#include <support/sha256.h>
#include <x86/elf.h>

#define ELF_NOTE_SECTION 7u
#define ELF_SYMTAB_SECTION 2u
#define ELF_STRTAB_SECTION 3u
#define ELF_SECTION_BYTES 64u
#define ELF_SYMBOL_BYTES 24u
#define ELF_SHN_ABS 0xfff1u
#define ELF_GLOBAL_NOTYPE 0x10u
#define GNU_BUILD_ID_TYPE 3u
#define BUILD_ID_BYTES 32u
#define OUTPUT_SECTION_COUNT 5u
#define SECTION_NAME_NOTE 1u
#define SECTION_NAME_SYMTAB 20u
#define SECTION_NAME_STRTAB 28u
#define SECTION_NAME_SHSTRTAB 36u

typedef struct {
    const char *name;
    pl_u64 value;
} proof_symbol;

typedef struct {
    pl_u64 retained;
    pl_u64 note_at;
    pl_u64 build_id_at;
    pl_u64 symtab_at;
    pl_u64 strtab_at;
    pl_u64 strtab_bytes;
    pl_u64 shstrtab_at;
    pl_u64 shstrtab_bytes;
    pl_u64 sections_at;
    pl_u64 total;
} elf_layout;

static const char section_names[] =
    "\0.note.gnu.build-id\0.symtab\0.strtab\0.shstrtab\0";

static pl_u64 string_bytes(const char *text)
{
    pl_u64 bytes = 1u;
    while (*text++) ++bytes;
    return bytes;
}

static int align_up(pl_u64 value, pl_u64 alignment, pl_u64 *out)
{
    pl_u64 mask = alignment - 1u;
    pl_u64 added;
    if (!alignment || (alignment & mask)) return 0;
    if (!pl_checked_add_u64(value, mask, &added)) return 0;
    *out = added & ~mask;
    return 1;
}

static void proof_symbols(const ox_proof *proof,
                          proof_symbol symbols[OX_PROOF_SYMBOL_COUNT])
{
    const char *names[OX_PROOF_SYMBOL_COUNT] = {
        OX_SYMBOL_PROOF_VERSION, OX_SYMBOL_MACHINE_ABI, OX_SYMBOL_FLAGS,
        OX_SYMBOL_SOURCE_SHA256_0, OX_SYMBOL_SOURCE_SHA256_1,
        OX_SYMBOL_SOURCE_SHA256_2, OX_SYMBOL_SOURCE_SHA256_3,
        OX_SYMBOL_SOURCE_BYTES, OX_SYMBOL_ENTRY_FUNCTION,
        OX_SYMBOL_FUNCTION_COUNT, OX_SYMBOL_COORDINATE_COUNT,
        OX_SYMBOL_DIRECT_COUNT, OX_SYMBOL_FAULT_COUNT,
        OX_SYMBOL_INPUT_SPAN, OX_SYMBOL_OUTPUT_SPAN,
        OX_SYMBOL_INPUT_WORK, OX_SYMBOL_OUTPUT_WORK,
        OX_SYMBOL_MINIMUM_SPAN, OX_SYMBOL_MINIMUM_WORK,
        OX_SYMBOL_PARETO_COMPLETE,
        OX_SYMBOL_INPUT_CODE_BYTES, OX_SYMBOL_OUTPUT_CODE_BYTES,
    };
    pl_u64 values[OX_PROOF_SYMBOL_COUNT] = {
        proof->proof_version, proof->machine_abi, proof->flags,
        proof->source_sha256[0], proof->source_sha256[1],
        proof->source_sha256[2], proof->source_sha256[3],
        proof->source_bytes, proof->entry_function, proof->function_count,
        proof->coordinate_count, proof->direct_count, proof->fault_count,
        proof->input_span, proof->output_span, proof->input_work,
        proof->output_work, proof->minimum_span, proof->minimum_work,
        proof->pareto_complete,
        proof->input_code_bytes, proof->output_code_bytes,
    };
    for (pl_u32 index = 0u; index < OX_PROOF_SYMBOL_COUNT; ++index) {
        symbols[index].name = names[index];
        symbols[index].value = values[index];
    }
}

static int proof_shape(const ox_proof *proof)
{
    ox_proof candidate;
    if (!proof) return 0;
    candidate = *proof;
    candidate.build_id_bytes = BUILD_ID_BYTES;
    for (pl_u32 index = 0u; index < BUILD_ID_BYTES; ++index)
        candidate.build_id[index] = 1u;
    return ox_proof_validate(&candidate) == 0;
}

static int form_layout(const pl_u8 *native, pl_u64 native_bytes,
                       const ox_proof *proof,
                       elf_layout *layout)
{
    pl_elf_image elf;
    proof_symbol symbols[OX_PROOF_SYMBOL_COUNT];
    pl_u64 program_table_bytes;
    pl_u64 at;
    int status;
    if (!native || !native_bytes || !layout || !proof_shape(proof))
        return OX_ERROR_PROOF;
    status = pl_elf_open(native, native_bytes, &elf);
    if (status) return OX_ERROR_ELF;
    if (!pl_checked_mul_u64(elf.program_count, PL_ELF_PROGRAM_BYTES,
                            &program_table_bytes)
            || !pl_checked_add_u64(elf.program_offset,
                                   program_table_bytes, &layout->retained)
            || layout->retained < PL_ELF_HEADER_BYTES
            || layout->retained > native_bytes)
        return OX_ERROR_RANGE;
    for (pl_u32 index = 0u; index < elf.program_count; ++index) {
        pl_elf_segment segment;
        pl_u64 end;
        status = pl_elf_program(&elf, index, &segment);
        if (status) return OX_ERROR_ELF;
        if (!pl_checked_add_u64(segment.file_offset, segment.file_bytes, &end)
                || end > native_bytes)
            return OX_ERROR_RANGE;
        if (end > layout->retained) layout->retained = end;
    }

    proof_symbols(proof, symbols);
    layout->strtab_bytes = 1u;
    for (pl_u32 index = 0u; index < OX_PROOF_SYMBOL_COUNT; ++index)
        if (!pl_checked_add_u64(layout->strtab_bytes,
                               string_bytes(symbols[index].name),
                               &layout->strtab_bytes))
            return OX_ERROR_RANGE;
    layout->shstrtab_bytes = sizeof section_names;

    if (!align_up(layout->retained, 4u, &layout->note_at)
            || !pl_checked_add_u64(layout->note_at, 16u,
                                   &layout->build_id_at)
            || !pl_checked_add_u64(layout->build_id_at, BUILD_ID_BYTES, &at)
            || !align_up(at, 8u, &layout->symtab_at)
            || !pl_checked_add_u64(
                layout->symtab_at,
                (OX_PROOF_SYMBOL_COUNT + 1u) * ELF_SYMBOL_BYTES, &at)
            || !align_up(at, 1u, &layout->strtab_at)
            || !pl_checked_add_u64(layout->strtab_at,
                                   layout->strtab_bytes, &at)
            || !align_up(at, 1u, &layout->shstrtab_at)
            || !pl_checked_add_u64(layout->shstrtab_at,
                                   layout->shstrtab_bytes, &at)
            || !align_up(at, 8u, &layout->sections_at)
            || !pl_checked_add_u64(layout->sections_at,
                OUTPUT_SECTION_COUNT * ELF_SECTION_BYTES, &layout->total))
        return OX_ERROR_RANGE;
    return 0;
}

int pl_x86_elf_measure(const pl_u8 *native, pl_u64 native_bytes,
                       const ox_proof *proof,
                       pl_x86_elf_emission *emission)
{
    elf_layout layout;
    int status;
    if (!emission) return OX_ERROR_RANGE;
    status = form_layout(native, native_bytes, proof, &layout);
    if (status) return status;
    emission->retained_bytes = layout.retained;
    emission->output_bytes = layout.total;
    return 0;
}

static void write_section(pl_u8 *row, pl_u32 name, pl_u32 type,
                          pl_u64 offset, pl_u64 bytes, pl_u32 link,
                          pl_u32 info, pl_u64 alignment, pl_u64 entry_bytes)
{
    pl_write_u32(row, name);
    pl_write_u32(row + 4u, type);
    pl_write_u64(row + 24u, offset);
    pl_write_u64(row + 32u, bytes);
    pl_write_u32(row + 40u, link);
    pl_write_u32(row + 44u, info);
    pl_write_u64(row + 48u, alignment);
    pl_write_u64(row + 56u, entry_bytes);
}

int pl_x86_elf_write(const pl_u8 *native, pl_u64 native_bytes,
                     const ox_proof *proof,
                     pl_u8 *output, pl_u64 output_capacity,
                     pl_u64 *output_bytes)
{
    elf_layout layout;
    proof_symbol symbols[OX_PROOF_SYMBOL_COUNT];
    pl_u64 string_at = 1u;
    pl_u8 digest[PL_SHA256_BYTES];
    pl_sha256 hash;
    int status;
    if (!output || !output_bytes) return OX_ERROR_RANGE;
    *output_bytes = 0u;
    status = form_layout(native, native_bytes, proof, &layout);
    if (status) return status;
    if (layout.total > output_capacity) return OX_ERROR_RANGE;
    if (output == native) {
        for (pl_u64 index = layout.retained; index < layout.total; ++index)
            output[index] = 0u;
    } else {
        for (pl_u64 index = 0u; index < layout.total; ++index)
            output[index] = 0u;
        for (pl_u64 index = 0u; index < layout.retained; ++index)
            output[index] = native[index];
    }

    pl_write_u64(output + 40u, layout.sections_at);
    pl_write_u16(output + 58u, ELF_SECTION_BYTES);
    pl_write_u16(output + 60u, OUTPUT_SECTION_COUNT);
    pl_write_u16(output + 62u, 4u);

    pl_write_u32(output + layout.note_at, 4u);
    pl_write_u32(output + layout.note_at + 4u, BUILD_ID_BYTES);
    pl_write_u32(output + layout.note_at + 8u, GNU_BUILD_ID_TYPE);
    output[layout.note_at + 12u] = 'G';
    output[layout.note_at + 13u] = 'N';
    output[layout.note_at + 14u] = 'U';

    proof_symbols(proof, symbols);
    for (pl_u32 index = 0u; index < OX_PROOF_SYMBOL_COUNT; ++index) {
        pl_u8 *row = output + layout.symtab_at
                   + (pl_u64)(index + 1u) * ELF_SYMBOL_BYTES;
        pl_u64 name_bytes = string_bytes(symbols[index].name);
        pl_write_u32(row, (pl_u32)string_at);
        row[4u] = ELF_GLOBAL_NOTYPE;
        pl_write_u16(row + 6u, ELF_SHN_ABS);
        pl_write_u64(row + 8u, symbols[index].value);
        for (pl_u64 byte = 0u; byte < name_bytes; ++byte)
            output[layout.strtab_at + string_at + byte] =
                (pl_u8)symbols[index].name[byte];
        string_at += name_bytes;
    }
    for (pl_u64 index = 0u; index < layout.shstrtab_bytes; ++index)
        output[layout.shstrtab_at + index] = (pl_u8)section_names[index];

    write_section(output + layout.sections_at + ELF_SECTION_BYTES,
                  SECTION_NAME_NOTE, ELF_NOTE_SECTION, layout.note_at,
                  16u + BUILD_ID_BYTES, 0u, 0u, 4u, 0u);
    write_section(output + layout.sections_at + 2u * ELF_SECTION_BYTES,
                  SECTION_NAME_SYMTAB, ELF_SYMTAB_SECTION, layout.symtab_at,
                  (OX_PROOF_SYMBOL_COUNT + 1u) * ELF_SYMBOL_BYTES,
                  3u, 1u, 8u, ELF_SYMBOL_BYTES);
    write_section(output + layout.sections_at + 3u * ELF_SECTION_BYTES,
                  SECTION_NAME_STRTAB, ELF_STRTAB_SECTION, layout.strtab_at,
                  layout.strtab_bytes, 0u, 0u, 1u, 0u);
    write_section(output + layout.sections_at + 4u * ELF_SECTION_BYTES,
                  SECTION_NAME_SHSTRTAB, ELF_STRTAB_SECTION,
                  layout.shstrtab_at,
                  layout.shstrtab_bytes, 0u, 0u, 1u, 0u);

    pl_sha256_open(&hash);
    pl_sha256_write(&hash, output, layout.build_id_at);
    pl_sha256_write(&hash, output + layout.build_id_at, BUILD_ID_BYTES);
    pl_sha256_write(&hash, output + layout.build_id_at + BUILD_ID_BYTES,
                    layout.total - layout.build_id_at - BUILD_ID_BYTES);
    pl_sha256_close(&hash, digest);
    for (pl_u32 index = 0u; index < BUILD_ID_BYTES; ++index)
        output[layout.build_id_at + index] = digest[index];
    *output_bytes = layout.total;
    return 0;
}
