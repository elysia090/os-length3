/* Bounded zlib/Deflate decoder for physical compiler inputs. */

#ifndef STORAGE_COMPRESSION_H
#define STORAGE_COMPRESSION_H

#include <support/types.h>

#define PL_ERROR_DEFLATE       (-70)
#define PL_ERROR_DEFLATE_RANGE (-71)

/* Signature matches pl_physical_inflate. `context` is reserved and ignored. */
int pl_deflate_zlib(void *context,
                    const pl_u8 *source, pl_u32 source_bytes,
                    pl_u8 *target, pl_u32 target_bytes);

/* Deterministic RFC 1950 stream with RFC 1951 fixed Huffman blocks.  This is
 * a final projection for already-quotiented residual bytes; callers retain
 * the source spelling when the returned stream is not smaller. */
#define PL_DEFLATE_FIXED_BOUND(bytes) ((bytes) + (((bytes) + 7u) / 8u) + 16u)
int pl_deflate_fixed_zlib(const pl_u8 *source, pl_u32 source_bytes,
                          pl_u8 *target, pl_u32 target_capacity,
                          pl_u32 *written);


#endif /* STORAGE_COMPRESSION_H */
