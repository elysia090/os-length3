/* Ordinary ELF64 runtime-segment layout around one compact native body. */

#ifndef POSTLINK_LAYOUT_ELF_H
#define POSTLINK_LAYOUT_ELF_H

#include <x86/elf.h>

#define PL_X86_LAYOUT_PROGRAM_LIMIT 64u
#define PL_ERROR_X86_LAYOUT (-50)

typedef struct {
    pl_u64 output_bytes;
    pl_u64 code_offset;
    pl_u64 code_address;
    pl_u64 code_bytes;
    pl_u64 program_offset[PL_X86_LAYOUT_PROGRAM_LIMIT];
    pl_u64 program_file_bytes[PL_X86_LAYOUT_PROGRAM_LIMIT];
    pl_u64 program_memory_bytes[PL_X86_LAYOUT_PROGRAM_LIMIT];
    pl_elf_segment programs[PL_X86_LAYOUT_PROGRAM_LIMIT];
    /* Exact source bytes copied by a retained PT_LOAD interval.  Generated
     * code and non-load views have zero copy bytes. */
    pl_u64 source_file_offset[PL_X86_LAYOUT_PROGRAM_LIMIT];
    pl_u64 source_file_bytes[PL_X86_LAYOUT_PROGRAM_LIMIT];
    pl_u32 input_program_count;
    pl_u32 program_count;
    pl_u32 executable_program;
} pl_x86_runtime_elf_layout;

/* Compute the smallest congruent file placement of every runtime segment.
 * Runtime data keeps its linked virtual coordinates.  The executable PT_LOAD
 * ends at the compact body instead of retaining unreachable source-code tail
 * bytes; construction sections are not retained. */
int pl_x86_runtime_elf_measure(const pl_u8 *input, pl_u64 input_bytes,
                               pl_u64 compact_code_bytes,
                               pl_x86_runtime_elf_layout *layout);

/* Copy and rewrite the runtime shell.  The compact code hole is deliberately
 * left zero for pl_x86_native_write.  Section construction records are
 * dropped; the proof sealer appends the only output section table later. */
int pl_x86_runtime_elf_write(const pl_u8 *input, pl_u64 input_bytes,
                             const pl_x86_runtime_elf_layout *layout,
                             pl_u64 entry,
                             pl_u8 *output, pl_u64 output_capacity,
                             pl_u64 *output_bytes);

/* Map an unchanged runtime virtual extent into its repacked file coordinate.
 * Callers use native layout projection, not this function, for source code
 * fields that moved into the compact body. */
int pl_x86_runtime_elf_resolve_file(
    const pl_u8 *input, pl_u64 input_bytes,
    const pl_x86_runtime_elf_layout *layout,
    pl_u64 address, pl_u64 bytes, pl_u64 *file_offset);

#endif /* POSTLINK_LAYOUT_ELF_H */
