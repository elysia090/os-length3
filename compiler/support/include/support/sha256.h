/* Allocation-free SHA-256 used for content-addressed compiler objects. */

#ifndef SUPPORT_SHA256_H
#define SUPPORT_SHA256_H

#include <support/types.h>

#define PL_SHA256_BYTES 32u
#define PL_SHA256_BLOCK_BYTES 64u

typedef struct {
    pl_u32 state[8];
    pl_u64 bytes;
    pl_u8 block[PL_SHA256_BLOCK_BYTES];
    pl_u32 buffered;
} pl_sha256;

void pl_sha256_open(pl_sha256 *state);
void pl_sha256_write(pl_sha256 *state, const pl_u8 *bytes, pl_u64 length);
void pl_sha256_close(pl_sha256 *state, pl_u8 digest[PL_SHA256_BYTES]);
void pl_sha256_digest(const pl_u8 *bytes, pl_u64 length,
                      pl_u8 digest[PL_SHA256_BYTES]);

#endif /* SUPPORT_SHA256_H */
