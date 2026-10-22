#include "internal/scalar.h"

#define BINARY64_EXPONENT_SHIFT 52u
#define BINARY64_EXPONENT_MASK  0x7ffu
#define BINARY64_FRACTION_MASK  ((1ull << BINARY64_EXPONENT_SHIFT) - 1ull)
#define BINARY64_QUIET_BIT      (1ull << 51u)
#define BINARY64_EXPONENT_BIAS  1023u
#define BINARY32_EXPONENT_SHIFT 23u
#define BINARY32_EXPONENT_MASK  0xffu
#define BINARY32_FRACTION_MASK  ((1u << BINARY32_EXPONENT_SHIFT) - 1u)
#define BINARY32_QUIET_BIT      (1u << 22u)
#define BINARY32_EXPONENT_BIAS  127u
#define PL_I64_MAX_VALUE ((pl_i64)((~(pl_u64)0) >> 1u))
#define PL_I64_MIN_VALUE (-PL_I64_MAX_VALUE - 1)

static int add_i64(pl_i64 left, pl_i64 right, pl_i64 *out)
{
    if (!out || (right > 0 && left > PL_I64_MAX_VALUE - right)
            || (right < 0 && left < PL_I64_MIN_VALUE - right))
        return PL_ERROR_BINARY64_SCALE_RANGE;
    *out = left + right;
    return 0;
}

static pl_u32 route_bits(pl_u64 bits, pl_u32 exponent_shift,
                         pl_u32 exponent_mask, pl_u64 fraction_mask,
                         pl_u64 quiet_bit)
{
    pl_u32 exponent = (pl_u32)(bits >> exponent_shift) & exponent_mask;
    pl_u64 fraction = bits & fraction_mask;
    if (!exponent)
        return fraction ? PL_BINARY64_SUBNORMAL : PL_BINARY64_ZERO;
    if (exponent != exponent_mask) return PL_BINARY64_NORMAL;
    if (!fraction) return PL_BINARY64_INFINITY;
    return fraction & quiet_bit
         ? PL_BINARY64_QUIET_NAN : PL_BINARY64_SIGNALING_NAN;
}

pl_u32 pl_binary32_route_bits(pl_u32 bits)
{
    return route_bits(bits, BINARY32_EXPONENT_SHIFT,
                      BINARY32_EXPONENT_MASK, BINARY32_FRACTION_MASK,
                      BINARY32_QUIET_BIT);
}

pl_u32 pl_binary64_route_bits(pl_u64 bits)
{
    return route_bits(bits, BINARY64_EXPONENT_SHIFT,
                      BINARY64_EXPONENT_MASK, BINARY64_FRACTION_MASK,
                      BINARY64_QUIET_BIT);
}

static pl_u32 bit_rank(pl_u64 single_bit)
{
    pl_u32 rank = 0u;
    while (single_bit > 1u) {
        single_bit >>= 1u;
        ++rank;
    }
    return rank;
}

static int power2_delta(pl_u64 bits, pl_u32 total_bits,
                        pl_u32 exponent_shift, pl_u32 exponent_mask,
                        pl_u32 exponent_bias, pl_i64 subnormal_minimum,
                        pl_i64 *exponent_delta)
{
    if (!exponent_delta || (bits >> (total_bits - 1u)))
        return 0;
    pl_u64 fraction_mask = ((pl_u64)1u << exponent_shift) - 1u;
    pl_u32 exponent = (pl_u32)(bits >> exponent_shift) & exponent_mask;
    pl_u64 fraction = bits & fraction_mask;
    if (exponent == exponent_mask || (!exponent && !fraction)) return 0;
    if (exponent) {
        if (fraction) return 0;
        *exponent_delta = (pl_i64)exponent - (pl_i64)exponent_bias;
        return 1;
    }
    if (fraction & (fraction - 1u)) return 0;
    *exponent_delta = subnormal_minimum + (pl_i64)bit_rank(fraction);
    return 1;
}

int pl_binary32_power2_delta(pl_u32 bits, pl_i64 *exponent_delta)
{
    return power2_delta(bits, 32u, BINARY32_EXPONENT_SHIFT,
                        BINARY32_EXPONENT_MASK, BINARY32_EXPONENT_BIAS,
                        -149, exponent_delta);
}

int pl_binary64_power2_delta(pl_u64 bits, pl_i64 *exponent_delta)
{
    return power2_delta(bits, 64u, BINARY64_EXPONENT_SHIFT,
                        BINARY64_EXPONENT_MASK, BINARY64_EXPONENT_BIAS,
                        -1074, exponent_delta);
}

void pl_binary64_scale_identity(pl_binary64_scale_cut *out)
{
    if (!out) return;
    *out = (pl_binary64_scale_cut){ 0, 0, 0, 0u };
}

int pl_binary64_scale_step(pl_i64 exponent_delta,
                           pl_binary64_scale_cut *out)
{
    if (!out) return PL_ERROR_BINARY64_SCALE;
    *out = (pl_binary64_scale_cut){
        .total = exponent_delta,
        .minimum_prefix = exponent_delta < 0 ? exponent_delta : 0,
        .maximum_prefix = exponent_delta > 0 ? exponent_delta : 0,
        .source_operations = 1u,
    };
    return 0;
}

int pl_binary64_scale_compose(const pl_binary64_scale_cut *left,
                              const pl_binary64_scale_cut *right,
                              pl_binary64_scale_cut *out)
{
    if (!left || !right || !out
            || left->minimum_prefix > left->maximum_prefix
            || right->minimum_prefix > right->maximum_prefix
            || left->minimum_prefix > 0 || left->maximum_prefix < 0
            || right->minimum_prefix > 0 || right->maximum_prefix < 0
            || left->total < left->minimum_prefix
            || left->total > left->maximum_prefix
            || right->total < right->minimum_prefix
            || right->total > right->maximum_prefix
            || left->source_operations
               > ~(pl_u64)0 - right->source_operations)
        return PL_ERROR_BINARY64_SCALE;
    pl_i64 total, translated_minimum, translated_maximum;
    int status = add_i64(left->total, right->total, &total);
    if (!status)
        status = add_i64(
            left->total, right->minimum_prefix, &translated_minimum);
    if (!status)
        status = add_i64(
            left->total, right->maximum_prefix, &translated_maximum);
    if (status) return status;
    *out = (pl_binary64_scale_cut){
        .total = total,
        .minimum_prefix = left->minimum_prefix < translated_minimum
                        ? left->minimum_prefix : translated_minimum,
        .maximum_prefix = left->maximum_prefix > translated_maximum
                        ? left->maximum_prefix : translated_maximum,
        .source_operations =
            left->source_operations + right->source_operations,
    };
    return 0;
}

static int valid_cut(const pl_scalar_delta_cut *cut)
{
    return cut && cut->minimum_prefix <= 0 && cut->maximum_prefix >= 0
        && cut->minimum_prefix <= cut->maximum_prefix
        && cut->total >= cut->minimum_prefix
        && cut->total <= cut->maximum_prefix;
}

static int scale_apply(pl_u64 input_bits, const pl_scalar_delta_cut *cut,
                       pl_u32 exponent_shift, pl_u32 exponent_mask,
                       pl_u64 *result_bits)
{
    if (!result_bits || !valid_cut(cut)) return PL_ERROR_BINARY64_SCALE;
    pl_i64 exponent = (pl_i64)((input_bits >> exponent_shift)
                              & exponent_mask);
    pl_i64 lowest, highest, final;
    int status = add_i64(exponent, cut->minimum_prefix, &lowest);
    if (!status) status = add_i64(exponent, cut->maximum_prefix, &highest);
    if (!status) status = add_i64(exponent, cut->total, &final);
    if (status) return status;
    /* minimum <= total <= maximum, so proving both endpoint exponents proves
     * the input and final exponents as well.  Zero, subnormal, infinity and
     * both NaN classes fail these two interval tests without a route branch. */
    if ((pl_u64)lowest - 1u >= (pl_u64)exponent_mask - 1u
            || (pl_u64)highest - 1u >= (pl_u64)exponent_mask - 1u)
        return 0;
    *result_bits = (input_bits
                    & ~((pl_u64)exponent_mask << exponent_shift))
                 | ((pl_u64)final << exponent_shift);
    return 1;
}

int pl_binary32_scale_apply(pl_u32 input_bits,
                            const pl_binary64_scale_cut *cut,
                            pl_u32 *result_bits)
{
    if (!result_bits) return PL_ERROR_BINARY64_SCALE;
    pl_u64 result = 0u;
    int status = scale_apply(input_bits, cut, BINARY32_EXPONENT_SHIFT,
                             BINARY32_EXPONENT_MASK, &result);
    if (status == 1) *result_bits = (pl_u32)result;
    return status;
}

int pl_binary64_scale_apply(pl_u64 input_bits,
                            const pl_binary64_scale_cut *cut,
                            pl_u64 *result_bits)
{
    return scale_apply(input_bits, cut, BINARY64_EXPONENT_SHIFT,
                       BINARY64_EXPONENT_MASK, result_bits);
}

void pl_binary_integer_translate_identity(
    pl_binary_integer_translate_cut *out)
{
    pl_binary64_scale_identity(out);
}

int pl_binary_integer_translate_step(
    pl_i64 delta, pl_binary_integer_translate_cut *out)
{
    return pl_binary64_scale_step(delta, out);
}

int pl_binary_integer_translate_compose(
    const pl_binary_integer_translate_cut *left,
    const pl_binary_integer_translate_cut *right,
    pl_binary_integer_translate_cut *out)
{
    return pl_binary64_scale_compose(left, right, out);
}

static int exact_integer(pl_u64 bits, pl_u32 total_bits,
                         pl_u32 fraction_bits, pl_u32 exponent_mask,
                         pl_u32 exponent_bias, pl_i64 *out)
{
    pl_u64 fraction_mask = ((pl_u64)1u << fraction_bits) - 1u;
    pl_u32 exponent = (pl_u32)(bits >> fraction_bits) & exponent_mask;
    pl_u64 fraction = bits & fraction_mask;
    pl_u32 sign = (pl_u32)(bits >> (total_bits - 1u));
    if (!exponent) {
        if (fraction) return 0;
        *out = 0;
        return 1;
    }
    if (exponent == exponent_mask) return 0;
    pl_i64 unbiased = (pl_i64)exponent - (pl_i64)exponent_bias;
    if (unbiased < 0 || unbiased > (pl_i64)fraction_bits + 1) return 0;
    pl_u64 significand = ((pl_u64)1u << fraction_bits) | fraction;
    pl_u64 magnitude;
    if (unbiased <= (pl_i64)fraction_bits) {
        pl_u32 discarded = fraction_bits - (pl_u32)unbiased;
        pl_u64 mask = discarded ? ((pl_u64)1u << discarded) - 1u : 0u;
        if (significand & mask) return 0;
        magnitude = significand >> discarded;
    } else {
        magnitude = significand << 1u;
    }
    *out = sign ? -(pl_i64)magnitude : (pl_i64)magnitude;
    return 1;
}

static int integer_bits(pl_i64 value, pl_u32 total_bits,
                        pl_u32 fraction_bits, pl_u32 exponent_bias,
                        pl_u64 *out)
{
    if (!value || !out) return 0;
    pl_u32 sign = value < 0;
    pl_u64 magnitude = sign ? (pl_u64)(-value) : (pl_u64)value;
    pl_u32 exponent = bit_rank(magnitude);
    if (exponent > fraction_bits + 1u) return 0;
    pl_u64 significand;
    if (exponent <= fraction_bits)
        significand = magnitude << (fraction_bits - exponent);
    else {
        if (magnitude != ((pl_u64)1u << (fraction_bits + 1u))) return 0;
        significand = (pl_u64)1u << fraction_bits;
    }
    pl_u64 fraction_mask = ((pl_u64)1u << fraction_bits) - 1u;
    *out = ((pl_u64)sign << (total_bits - 1u))
         | ((pl_u64)(exponent + exponent_bias) << fraction_bits)
         | (significand & fraction_mask);
    return 1;
}

static int integer_translate_apply(
    pl_u64 input_bits, const pl_binary_integer_translate_cut *cut,
    pl_u32 total_bits, pl_u32 fraction_bits, pl_u32 exponent_mask,
    pl_u32 exponent_bias, pl_u64 *result_bits)
{
    if (!result_bits || !valid_cut(cut)) return PL_ERROR_BINARY64_SCALE;
    if (!cut->source_operations) {
        *result_bits = input_bits;
        return 1;
    }
    pl_i64 input;
    if (!exact_integer(input_bits, total_bits, fraction_bits, exponent_mask,
                       exponent_bias, &input) || !input)
        return 0;
    pl_i64 lowest, highest, final;
    int status = add_i64(input, cut->minimum_prefix, &lowest);
    if (!status) status = add_i64(input, cut->maximum_prefix, &highest);
    if (!status) status = add_i64(input, cut->total, &final);
    if (status) return status;
    pl_i64 limit = (pl_i64)((pl_u64)1u << (fraction_bits + 1u));
    if (lowest < -limit || highest > limit
            || (input > 0 ? lowest <= 0 : highest >= 0))
        return 0;
    return integer_bits(final, total_bits, fraction_bits,
                        exponent_bias, result_bits);
}

int pl_binary32_integer_translate_apply(
    pl_u32 input_bits, const pl_binary_integer_translate_cut *cut,
    pl_u32 *result_bits)
{
    if (!result_bits) return PL_ERROR_BINARY64_SCALE;
    pl_u64 result = 0u;
    int status = integer_translate_apply(
        input_bits, cut, 32u, BINARY32_EXPONENT_SHIFT,
        BINARY32_EXPONENT_MASK, BINARY32_EXPONENT_BIAS, &result);
    if (status == 1) *result_bits = (pl_u32)result;
    return status;
}

int pl_binary64_integer_translate_apply(
    pl_u64 input_bits, const pl_binary_integer_translate_cut *cut,
    pl_u64 *result_bits)
{
    return integer_translate_apply(
        input_bits, cut, 64u, BINARY64_EXPONENT_SHIFT,
        BINARY64_EXPONENT_MASK, BINARY64_EXPONENT_BIAS, result_bits);
}

pl_u32 pl_binary64_scale_retained_words(void)
{
    return 3u;
}
