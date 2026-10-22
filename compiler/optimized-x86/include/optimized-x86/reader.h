/* Bounded reader for proof-bearing ordinary x86-64 ELF files. */

#ifndef OPTIMIZED_X86_READER_H
#define OPTIMIZED_X86_READER_H

#include <optimized-x86/proof.h>

typedef struct {
    const pl_u8 *bytes;
    pl_u64 length;
    pl_u64 entry;
    ox_proof proof;
} ox_image;

/* Accept ET_EXEC/ET_DYN ELF64, little-endian, x86-64. The reader requires one
 * canonical definition of every proof symbol in SHT_SYMTAB and one nonempty
 * GNU build-id note. Runtime meaning is carried only by the ordinary x86
 * program segments; there is no private execution section or sidecar. */
int ox_image_open(const pl_u8 *bytes, pl_u64 length, ox_image *out);

#endif /* OPTIMIZED_X86_READER_H */
