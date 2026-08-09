#ifndef PA_REGION_H
#define PA_REGION_H

#include <limits.h>
#include <stdint.h>

/* A one-dimensional physical region:

       value(i) = first + step*i,  0 <= i < count

   `step` is positive and count is at most INT64_MAX. Cuts return another
   region rather than a materialized list of coordinates. */
typedef struct {
    int64_t first;
    int64_t step;
    uint64_t count;
} pa_region_i64;

/* Endpoint moments observed modulo 2^64. This is the useful observer for a
   fixed-width VM: intermediate C unsigned arithmetic and the returned values
   have exactly the same wrapping semantics. */
typedef struct {
    uint64_t m0;
    uint64_t m1;
    uint64_t m2;
} pa_moments2_u64;

static int64_t pa_ceil_div_i64(int64_t value, int64_t divisor)
{
    int64_t quotient = value / divisor;
    int64_t remainder = value % divisor;
    return quotient + (remainder > 0);
}

static int pa_sub_i64(int64_t left, int64_t right, int64_t *out)
{
    if ((right > 0 && left < INT64_MIN + right) ||
        (right < 0 && left > INT64_MAX + right))
        return 0;
    *out = left - right;
    return 1;
}

static uint64_t pa_gcd_u64(uint64_t left, uint64_t right)
{
    while (right) {
        uint64_t next = left % right;
        left = right;
        right = next;
    }
    return left;
}

static int64_t pa_extended_gcd_i64(int64_t a, int64_t b, int64_t *x, int64_t *y)
{
    if (b == 0) {
        *x = 1;
        *y = 0;
        return a;
    }
    int64_t next_x, next_y;
    int64_t gcd = pa_extended_gcd_i64(b, a % b, &next_x, &next_y);
    *x = next_y;
    *y = next_x - (a / b) * next_y;
    return gcd;
}

static int pa_region_valid(pa_region_i64 region)
{
    return region.step > 0 && region.count <= (uint64_t)INT64_MAX;
}

/* Intersect with the half-open coordinate interval [lo, hi). */
static int pa_region_cut_interval(
    pa_region_i64 region,
    int64_t lo,
    int64_t hi,
    pa_region_i64 *out)
{
    if (!pa_region_valid(region) || !out || lo > hi) return 0;
    int64_t lo_delta, hi_delta;
    if (!pa_sub_i64(lo, region.first, &lo_delta) ||
        !pa_sub_i64(hi, region.first, &hi_delta))
        return 0;
    int64_t begin = pa_ceil_div_i64(lo_delta, region.step);
    int64_t end = pa_ceil_div_i64(hi_delta, region.step);
    if (begin < 0) begin = 0;
    if (end < begin) end = begin;
    if ((uint64_t)begin > region.count) begin = (int64_t)region.count;
    if ((uint64_t)end > region.count) end = (int64_t)region.count;
    if (begin > 0 && region.step > INT64_MAX / begin) return 0;
    int64_t advance = region.step * begin;
    if (region.first > 0 && advance > INT64_MAX - region.first) return 0;
    out->first = region.first + advance;
    out->step = region.step;
    out->count = (uint64_t)(end - begin);
    return 1;
}

/* Intersect with coordinate mod modulus == residue. The linear congruence is
   solved once; the selected coordinates remain one arithmetic region. */
static int pa_region_cut_residue(
    pa_region_i64 region,
    uint64_t modulus,
    uint64_t residue,
    pa_region_i64 *out)
{
    if (!pa_region_valid(region) || !out || modulus == 0 ||
        modulus > (uint64_t)INT32_MAX || residue >= modulus)
        return 0;
    uint64_t step = (uint64_t)region.step;
    int64_t first_mod = region.first % (int64_t)modulus;
    if (first_mod < 0) first_mod += (int64_t)modulus;
    uint64_t target = (residue + modulus - (uint64_t)first_mod) % modulus;
    uint64_t divisor = pa_gcd_u64(step, modulus);
    if (target % divisor) {
        *out = (pa_region_i64){region.first, region.step, 0};
        return 1;
    }

    uint64_t reduced_modulus = modulus / divisor;
    int64_t reduced_step = (int64_t)((step / divisor) % reduced_modulus);
    int64_t inverse, ignored;
    pa_extended_gcd_i64(reduced_step, (int64_t)reduced_modulus,
                        &inverse, &ignored);
    int64_t positive_inverse = inverse % (int64_t)reduced_modulus;
    if (positive_inverse < 0) positive_inverse += (int64_t)reduced_modulus;
    uint64_t start = ((target / divisor) * (uint64_t)positive_inverse)
                     % reduced_modulus;

    if (start >= region.count) {
        *out = (pa_region_i64){region.first, region.step, 0};
        return 1;
    }
    uint64_t count = 1u + (region.count - 1u - start) / reduced_modulus;
    if (start > (uint64_t)(INT64_MAX / region.step) ||
        reduced_modulus > (uint64_t)(INT64_MAX / region.step))
        return 0;
    int64_t advance = region.step * (int64_t)start;
    if (region.first > 0 && advance > INT64_MAX - region.first) return 0;
    out->first = region.first + advance;
    out->step = region.step * (int64_t)reduced_modulus;
    out->count = count;
    return out->step > 0;
}

static uint64_t pa_choose2_u64(uint64_t count)
{
    uint64_t left = count;
    uint64_t right = count - (count != 0);
    if ((left & 1u) == 0) left >>= 1;
    else right >>= 1;
    return left * right;
}

static uint64_t pa_sum_squares_u64(uint64_t count)
{
    if (count == 0) return 0;
    uint64_t factors[3] = {count, count - 1u, 2u * count - 1u};
    for (unsigned i = 0; i < 3; ++i) {
        if ((factors[i] & 1u) == 0) {
            factors[i] >>= 1;
            break;
        }
    }
    for (unsigned i = 0; i < 3; ++i) {
        if (factors[i] % 3u == 0) {
            factors[i] /= 3u;
            break;
        }
    }
    return factors[0] * factors[1] * factors[2];
}

/* Potential at one endpoint. Subtract two endpoint potentials to obtain the
   moments of an index interval without visiting its coordinates. */
static pa_moments2_u64 pa_region_endpoint(
    int64_t first,
    int64_t step,
    uint64_t end)
{
    uint64_t a = (uint64_t)first;
    uint64_t d = (uint64_t)step;
    uint64_t choose2 = pa_choose2_u64(end);
    uint64_t squares = pa_sum_squares_u64(end);
    pa_moments2_u64 out;
    out.m0 = end;
    out.m1 = end * a + choose2 * d;
    out.m2 = end * a * a + 2u * a * d * choose2 + d * d * squares;
    return out;
}

static pa_moments2_u64 pa_region_moments(pa_region_i64 region)
{
    return pa_region_endpoint(region.first, region.step, region.count);
}

#endif
