/* Bounded zlib/Deflate decoder for physical compiler inputs. */

#ifndef POSTLINK_DEFLATE_H
#define POSTLINK_DEFLATE_H

#include <postlink/format.h>

#define PL_ERROR_DEFLATE       (-70)
#define PL_ERROR_DEFLATE_RANGE (-71)

/* Signature matches pl_physical_inflate. `context` is reserved and ignored. */
int pl_deflate_zlib(void *context,
                    const pl_u8 *source, pl_u32 source_bytes,
                    pl_u8 *target, pl_u32 target_bytes);

#endif /* POSTLINK_DEFLATE_H */
