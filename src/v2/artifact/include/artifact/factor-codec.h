/* Stored spelling for the exact prior-factor parse. */

#ifndef ARTIFACT_FACTOR_CODEC_H
#define ARTIFACT_FACTOR_CODEC_H

#include <artifact/factor.h>
#include <artifact/payload.h>

#define ARTIFACT_ERROR_FACTOR_CODEC       (-89)
#define ARTIFACT_ERROR_FACTOR_CODEC_RANGE (-90)

typedef struct {
    pl_u32 output_bytes;
    pl_u32 coordinate_bits;
    pl_u32 tokens;
    pl_u64 payload_bits;
    pl_u32 payload_bytes;
} artifact_factor_code_projection;

/* Emit the selected factor choices without retaining the opened input word.
 * Bits are most-significant first:
 *
 *   literal   = 0 || byte8
 *   reference = 1 || length[W] || prior_coordinate[W]
 *   W         = ceil(log2(output_bytes + 1)).
 *
 * `source` and `length` are the exact choices produced by factor.h or
 * factor-index.h.  The last output byte is zero padded. */
int artifact_factor_code_write(
    const artifact_byte_view *opened,
    const pl_u32 *source, const pl_u32 *length, pl_u32 choice_capacity,
    pl_u8 *code, pl_u32 code_capacity,
    artifact_factor_code_projection *out);

/* Prove that a stored spelling reconstructs the canonical view without
 * allocating an N-byte decode target.  Literal bytes and referenced ranges
 * are compared directly against their immutable owners. */
int artifact_factor_code_verify(
    const pl_u8 *code, pl_u32 code_bytes, pl_u64 code_bits,
    const artifact_byte_view *expected,
    artifact_factor_code_projection *out);

/* Reconstruct using only the stored code.  Truncation, trailing bits,
 * nonzero padding, zero-length references and non-prior sources reject. */
int artifact_factor_code_read(
    const pl_u8 *code, pl_u32 code_bytes, pl_u64 code_bits,
    pl_u8 *target, pl_u32 target_capacity, pl_u32 output_bytes,
    artifact_factor_code_projection *out);

#endif /* ARTIFACT_FACTOR_CODEC_H */
