/* Exact scalar cut summaries used before floating materialization. */

#ifndef POSTLINK_SCALAR_H
#define POSTLINK_SCALAR_H

#include <support/types.h>

#define PL_ERROR_BINARY64_SCALE       (-90)
#define PL_ERROR_BINARY64_SCALE_RANGE (-91)

enum pl_binary64_route {
    PL_BINARY64_ZERO = 0,
    PL_BINARY64_SUBNORMAL,
    PL_BINARY64_NORMAL,
    PL_BINARY64_INFINITY,
    PL_BINARY64_QUIET_NAN,
    PL_BINARY64_SIGNALING_NAN,
};

/* A sequence of exact multiplications by powers of two.  The three signed
 * fields are sufficient to prove that every prefix stays in the normal
 * binary64 exponent interval.  `source_operations` is proof metadata and is
 * not part of the hot execution state. */
typedef struct {
    pl_i64 total;
    pl_i64 minimum_prefix;
    pl_i64 maximum_prefix;
    pl_u64 source_operations;
} pl_scalar_delta_cut;

typedef pl_scalar_delta_cut pl_binary64_scale_cut;
typedef pl_scalar_delta_cut pl_binary_integer_translate_cut;

pl_u32 pl_binary32_route_bits(pl_u32 bits);
pl_u32 pl_binary64_route_bits(pl_u64 bits);

/* Recognize a positive exact power of two and return its unbiased exponent.
 * Normal and subnormal encodings are both accepted; zero, negative values,
 * infinities, NaNs and non-power-of-two fractions are rejected. */
int pl_binary32_power2_delta(pl_u32 bits, pl_i64 *exponent_delta);
int pl_binary64_power2_delta(pl_u64 bits, pl_i64 *exponent_delta);

void pl_binary64_scale_identity(pl_binary64_scale_cut *out);
int pl_binary64_scale_step(pl_i64 exponent_delta,
                           pl_binary64_scale_cut *out);

/* Compose `left` followed by `right`.  This is associative: prefix extrema
 * translate by left.total and no source-sized array is retained. */
int pl_binary64_scale_compose(const pl_binary64_scale_cut *left,
                              const pl_binary64_scale_cut *right,
                              pl_binary64_scale_cut *out);

/* Return 1 and the exact result when all prefixes stay finite and normal.
 * Return 0 when the caller must use the exact exceptional residual.  A
 * negative result denotes a malformed or arithmetically unrepresentable
 * summary. */
int pl_binary64_scale_apply(pl_u64 input_bits,
                            const pl_binary64_scale_cut *cut,
                            pl_u64 *result_bits);

int pl_binary32_scale_apply(pl_u32 input_bits,
                            const pl_binary64_scale_cut *cut,
                            pl_u32 *result_bits);

/* A chain of additions/subtractions by exactly represented integer constants
 * is the same endpoint-region summary. Under the caller's round-to-nearest
 * proof, every prefix is exact when the translated region stays strictly on
 * one side of zero and inside the binary precision's consecutive-integer
 * cell. The chain then materializes one final IEEE word. */
void pl_binary_integer_translate_identity(
    pl_binary_integer_translate_cut *out);
int pl_binary_integer_translate_step(
    pl_i64 delta, pl_binary_integer_translate_cut *out);
int pl_binary_integer_translate_compose(
    const pl_binary_integer_translate_cut *left,
    const pl_binary_integer_translate_cut *right,
    pl_binary_integer_translate_cut *out);
int pl_binary32_integer_translate_apply(
    pl_u32 input_bits, const pl_binary_integer_translate_cut *cut,
    pl_u32 *result_bits);
int pl_binary64_integer_translate_apply(
    pl_u64 input_bits, const pl_binary_integer_translate_cut *cut,
    pl_u64 *result_bits);

/* Runtime state retained by the closed fast path: total and two extrema. */
pl_u32 pl_binary64_scale_retained_words(void);

#endif /* POSTLINK_SCALAR_H */
