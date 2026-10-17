/* Canonical standard-ELF sealing after native code emission. */

#ifndef POSTLINK_EMIT_X86_H
#define POSTLINK_EMIT_X86_H

#include <optimized-x86/proof.h>

typedef struct {
    pl_u64 retained_bytes;
    pl_u64 output_bytes;
} pl_x86_elf_emission;

/* `native` is an already optimized ET_EXEC/ET_DYN image. The writer retains
 * every program-header byte extent, discards non-runtime section tails, and
 * emits only standard GNU build-id, SHT_SYMTAB, SHT_STRTAB and section-name
 * sections. It neither invents nor verifies compiler semantic facts. */
int pl_x86_elf_measure(const pl_u8 *native, pl_u64 native_bytes,
                       const ox_proof *proof,
                       pl_x86_elf_emission *emission);

int pl_x86_elf_write(const pl_u8 *native, pl_u64 native_bytes,
                     const ox_proof *proof,
                     pl_u8 *output, pl_u64 output_capacity,
                     pl_u64 *output_bytes);

#endif /* POSTLINK_EMIT_X86_H */
