/* Bounded little-endian ELF64 input for linked x86-64 images. */

#ifndef X86_ELF_H
#define X86_ELF_H

#include <support/checked.h>

#define PL_ELF_HEADER_BYTES 64u
#define PL_ELF_PROGRAM_BYTES 56u
#define PL_ELF_SECTION_BYTES 64u

#define PL_ELF_TYPE_EXEC 2u
#define PL_ELF_TYPE_DYN  3u
#define PL_ELF_MACHINE_X86_64 62u

#define PL_ELF_SEGMENT_LOAD 1u
#define PL_ELF_SEGMENT_DYNAMIC 2u
#define PL_ELF_SEGMENT_GNU_EH_FRAME 0x6474e550u
#define PL_ELF_FLAG_EXECUTE 1u
#define PL_ELF_FLAG_WRITE   2u
#define PL_ELF_FLAG_READ    4u

#define PL_ELF_SECTION_PROGBITS 1u
#define PL_ELF_SECTION_SYMTAB   2u
#define PL_ELF_SECTION_STRTAB   3u
#define PL_ELF_SECTION_RELA     4u
#define PL_ELF_SECTION_NOBITS   8u
#define PL_ELF_SECTION_DYNSYM  11u
#define PL_ELF_SECTION_INIT_ARRAY    14u
#define PL_ELF_SECTION_FINI_ARRAY    15u
#define PL_ELF_SECTION_PREINIT_ARRAY 16u
#define PL_ELF_SECTION_ALLOC    2u
#define PL_ELF_SECTION_EXECUTE  4u

#define PL_ELF_SYMBOL_BYTES     24u
#define PL_ELF_RELOCATION_BYTES 24u
#define PL_ELF_DYNAMIC_BYTES     16u
#define PL_ELF_SYMBOL_FUNCTION   2u
#define PL_ELF_SYMBOL_SECTION    3u

#define PL_ERROR_ELF       (-20)
#define PL_ERROR_ELF_RANGE (-21)

typedef struct {
    const pl_u8 *bytes;
    pl_u64 length;
    pl_u64 entry;
    pl_u64 program_offset;
    pl_u64 section_offset;
    pl_u32 type;
    pl_u32 program_count;
    pl_u32 section_count;
    pl_u32 section_name_index;
} pl_elf_image;

typedef struct {
    pl_u32 type;
    pl_u32 flags;
    pl_u64 file_offset;
    pl_u64 virtual_address;
    pl_u64 physical_address;
    pl_u64 file_bytes;
    pl_u64 memory_bytes;
    pl_u64 alignment;
} pl_elf_segment;

typedef struct {
    pl_u32 name_offset;
    pl_u32 type;
    pl_u64 flags;
    pl_u64 address;
    pl_u64 file_offset;
    pl_u64 file_bytes;
    pl_u64 memory_bytes;
    pl_u32 link;
    pl_u32 info;
    pl_u64 alignment;
    pl_u64 entry_bytes;
} pl_elf_section;

typedef struct {
    pl_u32 executable_sections;
    pl_u32 relocated_executable_sections;
    pl_u64 relocation_records;
} pl_elf_code_relocations;

typedef struct {
    pl_u32 name_offset;
    pl_u32 section_index;
    pl_u64 value;
    pl_u64 bytes;
    pl_u8 binding;
    pl_u8 type;
    pl_u8 visibility;
} pl_elf_symbol;

typedef struct {
    pl_u64 offset;
    pl_u64 addend_bits;
    pl_u32 symbol_index;
    pl_u32 type;
    pl_u32 target_section;
    pl_u32 symbol_table_section;
} pl_elf_relocation;

/* Accept one ordinary ET_EXEC or ET_DYN x86-64 image.  Extended program-header
 * numbering is deliberately rejected until the section reader that proves it
 * is added; it must not silently look like an image with no mappings. */
int pl_elf_open(const pl_u8 *bytes, pl_u64 length, pl_elf_image *out);

/* Read and validate one program header, including file extent, virtual extent,
 * overflow and ELF alignment congruence. */
int pl_elf_program(const pl_elf_image *image, pl_u32 index,
                   pl_elf_segment *out);

int pl_elf_segment_is_executable(const pl_elf_segment *segment);

/* Read the optional process entry.  ET_DYN with e_entry == 0 has no process
 * entry: shared objects begin at exported functions or loader-owned init/fini
 * coordinates instead.  Every other form must resolve e_entry to one
 * executable virtual coordinate.  Boot-linked images such as vmlinux may
 * publish a PT_LOAD physical coordinate; translate it through the owning
 * segment and reject ambiguous maps. */
int pl_elf_process_entry(const pl_elf_image *image, pl_u64 *out,
                         int *present);

/* Strict form for executable products that require a process entry. */
int pl_elf_executable_entry(const pl_elf_image *image, pl_u64 *out);

/* Read one allocated section without consulting its name.  NOBITS has a zero
 * file projection and a nonzero memory extent. */
int pl_elf_section_read(const pl_elf_image *image, pl_u32 index,
                        pl_elf_section *out);
int pl_elf_section_is_executable(const pl_elf_section *section);

/* Count static relocation records whose sh_info names an executable section.
 * Dynamic loader relocations have no target section and do not satisfy this
 * contract.  Records retained by the linker refine construction evidence and
 * must all be closed when present.  Zero is valid for a self-contained linked
 * body; the optimized output never needs to retain construction records. */
int pl_elf_code_relocation_population(
    const pl_elf_image *image, pl_elf_code_relocations *out);

/* Bounded construction-record readers.  The output ELF does not retain these
 * rows, but the post-link compiler uses them to prove function boundaries and
 * rewrite every moved reference in one linear section/row walk. */
int pl_elf_symbol_read(const pl_elf_image *image,
                       pl_u32 symbol_table_section, pl_u32 symbol_index,
                       pl_elf_symbol *out);
int pl_elf_relocation_read(const pl_elf_image *image,
                           pl_u32 relocation_section,
                           pl_u64 relocation_index,
                           pl_elf_relocation *out);
int pl_elf_relocation_read_symbol_free(const pl_elf_image *image,
                                       pl_u32 relocation_section,
                                       pl_u64 relocation_index,
                                       pl_elf_relocation *out);

#endif /* X86_ELF_H */
