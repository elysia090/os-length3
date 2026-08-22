/* Bounded little-endian ELF64 input for linked x86-64 images. */

#ifndef POSTLINK_ELF_H
#define POSTLINK_ELF_H

#include <postlink/format.h>

#define PL_ELF_HEADER_BYTES 64u
#define PL_ELF_PROGRAM_BYTES 56u
#define PL_ELF_SECTION_BYTES 64u

#define PL_ELF_TYPE_EXEC 2u
#define PL_ELF_TYPE_DYN  3u
#define PL_ELF_MACHINE_X86_64 62u

#define PL_ELF_SEGMENT_LOAD 1u
#define PL_ELF_FLAG_EXECUTE 1u
#define PL_ELF_FLAG_WRITE   2u
#define PL_ELF_FLAG_READ    4u

#define PL_ELF_SECTION_PROGBITS 1u
#define PL_ELF_SECTION_NOBITS   8u
#define PL_ELF_SECTION_ALLOC    2u
#define PL_ELF_SECTION_EXECUTE  4u

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

/* Accept one ordinary ET_EXEC or ET_DYN x86-64 image.  Extended program-header
 * numbering is deliberately rejected until the section reader that proves it
 * is added; it must not silently look like an image with no mappings. */
int pl_elf_open(const pl_u8 *bytes, pl_u64 length, pl_elf_image *out);

/* Read and validate one program header, including file extent, virtual extent,
 * overflow and ELF alignment congruence. */
int pl_elf_program(const pl_elf_image *image, pl_u32 index,
                   pl_elf_segment *out);

int pl_elf_segment_is_executable(const pl_elf_segment *segment);

/* Read one allocated section without consulting its name.  NOBITS has a zero
 * file projection and a nonzero memory extent. */
int pl_elf_section_read(const pl_elf_image *image, pl_u32 index,
                        pl_elf_section *out);
int pl_elf_section_is_executable(const pl_elf_section *section);

#endif /* POSTLINK_ELF_H */
