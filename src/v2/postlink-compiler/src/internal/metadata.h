/* Runtime code pointers synthesized by the ELF linker. */

#ifndef POSTLINK_METADATA_H
#define POSTLINK_METADATA_H

#include <x86/elf.h>

#define PL_ERROR_X86_METADATA (-52)

typedef enum {
    PL_X86_METADATA_DYNAMIC = 1,
    PL_X86_METADATA_LAZY_BINDING = 2,
    PL_X86_METADATA_UNWIND = 3
} pl_x86_metadata_kind;

typedef struct {
    pl_u64 field_address;
    pl_u64 target_address;
    pl_u64 data_address;
    pl_u64 record_address;
    pl_u64 record_data_address;
    pl_u64 source_extent;
    pl_u8 encoding;
    pl_u8 record_encoding;
    pl_u8 kind;
} pl_x86_metadata_pointer;

typedef struct {
    pl_u64 dynamic_pointers;
    pl_u64 lazy_binding_pointers;
    pl_u64 unwind_pointers;
    pl_u64 unwind_frame_address;
} pl_x86_metadata_report;

typedef int (*pl_x86_metadata_visitor)(
    void *context, const pl_x86_metadata_pointer *pointer);

/* Enumerate the complete finite population of runtime code pointers that the
 * linker synthesizes outside ordinary relocated instruction fields. */
int pl_x86_metadata_walk(
    const pl_elf_image *elf, pl_x86_metadata_visitor visitor,
    void *context, pl_x86_metadata_report *report);

pl_u32 pl_x86_metadata_width(const pl_x86_metadata_pointer *pointer);

/* Re-encode one resolved target using the linker's original fixed-width
 * DWARF/absolute spelling. */
int pl_x86_metadata_encode(const pl_x86_metadata_pointer *pointer,
                           pl_u64 target, pl_u8 *output);

#endif /* POSTLINK_METADATA_H */
