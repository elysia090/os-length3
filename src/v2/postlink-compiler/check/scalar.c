#include <stdio.h>

#include "../src/internal/scalar.h"

typedef union {
    pl_u64 bits;
    double value;
} binary64;

typedef union {
    pl_u32 bits;
    float value;
} binary32;

static int expect(int condition, const char *name)
{
    if (condition) return 0;
    fprintf(stderr, "scalar cut RED: %s\n", name);
    return 1;
}

static int same_cut(const pl_binary64_scale_cut *left,
                    const pl_binary64_scale_cut *right)
{
    return left->total == right->total
        && left->minimum_prefix == right->minimum_prefix
        && left->maximum_prefix == right->maximum_prefix
        && left->source_operations == right->source_operations;
}

int main(void)
{
    int failures = 0;
    failures += expect(pl_binary64_route_bits(0u) == PL_BINARY64_ZERO,
                       "positive zero route");
    failures += expect(pl_binary64_route_bits(1u) == PL_BINARY64_SUBNORMAL,
                       "subnormal route");
    failures += expect(pl_binary64_route_bits(0x3ff0000000000000ull)
                       == PL_BINARY64_NORMAL, "normal route");
    failures += expect(pl_binary64_route_bits(0x7ff0000000000000ull)
                       == PL_BINARY64_INFINITY, "infinity route");
    failures += expect(pl_binary64_route_bits(0x7ff8000000000000ull)
                       == PL_BINARY64_QUIET_NAN, "quiet NaN route");
    failures += expect(pl_binary64_route_bits(0x7ff0000000000001ull)
                       == PL_BINARY64_SIGNALING_NAN, "signaling NaN route");
    failures += expect(pl_binary32_route_bits(0x3f800000u)
                       == PL_BINARY64_NORMAL, "binary32 normal route");

    pl_i64 recognized_delta = 0;
    failures += expect(pl_binary64_power2_delta(
                           0x3f80000000000000ull, &recognized_delta)
                       && recognized_delta == -7,
                       "binary64 normal power-of-two recognition");
    failures += expect(pl_binary32_power2_delta(
                           0x00000001u, &recognized_delta)
                       && recognized_delta == -149,
                       "binary32 subnormal power-of-two recognition");
    failures += expect(!pl_binary64_power2_delta(
                           0x3ff8000000000000ull, &recognized_delta),
                       "non-power-of-two rejection");

    pl_binary64_scale_cut accumulated;
    pl_binary64_scale_identity(&accumulated);
    for (pl_u32 index = 0u; index < 1000000u; ++index) {
        pl_binary64_scale_cut step, next;
        (void)pl_binary64_scale_step(index & 1u ? -1 : 1, &step);
        int status = pl_binary64_scale_compose(
            &accumulated, &step, &next);
        failures += expect(!status, "million-step composition");
        if (status) break;
        accumulated = next;
    }
    failures += expect(accumulated.total == 0
                       && accumulated.minimum_prefix == 0
                       && accumulated.maximum_prefix == 1
                       && accumulated.source_operations == 1000000u,
                       "constant-size prefix summary");
    failures += expect(pl_binary64_scale_retained_words() == 3u,
                       "three-word execution cut");

    for (pl_i64 a = -3; a <= 3; ++a)
        for (pl_i64 b = -3; b <= 3; ++b)
            for (pl_i64 c = -3; c <= 3; ++c) {
                pl_binary64_scale_cut x, y, z, xy, yz, left, right;
                (void)pl_binary64_scale_step(a, &x);
                (void)pl_binary64_scale_step(b, &y);
                (void)pl_binary64_scale_step(c, &z);
                (void)pl_binary64_scale_compose(&x, &y, &xy);
                (void)pl_binary64_scale_compose(&y, &z, &yz);
                (void)pl_binary64_scale_compose(&xy, &z, &left);
                (void)pl_binary64_scale_compose(&x, &yz, &right);
                failures += expect(same_cut(&left, &right),
                                   "scale-cut associativity");
            }

    binary64 input = { .value = 1.5 };
    pl_u64 result = 0u;
    int fast = pl_binary64_scale_apply(input.bits, &accumulated, &result);
    failures += expect(fast == 1 && result == input.bits,
                       "exact telescoped normal result");

    pl_binary64_scale_cut down;
    (void)pl_binary64_scale_step(-1, &down);
    failures += expect(pl_binary64_scale_apply(
                           0x0010000000000000ull, &down, &result) == 0,
                       "underflow enters residual");
    failures += expect(pl_binary64_scale_apply(0u, &down, &result) == 0,
                       "zero enters residual");

    for (pl_i64 delta = -10; delta <= 10; ++delta) {
        pl_binary64_scale_cut step;
        (void)pl_binary64_scale_step(delta, &step);
        binary64 value = { .bits = 0x405921fb54442d18ull };
        binary64 factor = {
            .bits = (pl_u64)(1023 + delta) << 52u,
        };
        binary64 hardware = { .value = value.value * factor.value };
        fast = pl_binary64_scale_apply(value.bits, &step, &result);
        failures += expect(fast == 1 && result == hardware.bits,
                           "exact power-of-two materialization");
    }

    binary32 input32 = { .value = 1.5f };
    pl_u32 result32 = 0u;
    pl_binary64_scale_cut up32;
    (void)pl_binary64_scale_step(3, &up32);
    binary32 hardware32 = { .value = input32.value * 8.0f };
    fast = pl_binary32_scale_apply(input32.bits, &up32, &result32);
    failures += expect(fast == 1 && result32 == hardware32.bits,
                       "binary32 exact power-of-two materialization");

    pl_binary_integer_translate_cut translated;
    pl_binary_integer_translate_identity(&translated);
    for (pl_u32 index = 0u; index < 1000000u; ++index) {
        pl_binary_integer_translate_cut step, next;
        (void)pl_binary_integer_translate_step(1, &step);
        int status = pl_binary_integer_translate_compose(
            &translated, &step, &next);
        failures += expect(!status, "million exact-integer translations");
        if (status) break;
        translated = next;
    }
    binary64 integer64 = { .value = 1.0 };
    binary64 translated64 = { .value = 1000001.0 };
    fast = pl_binary64_integer_translate_apply(
        integer64.bits, &translated, &result);
    failures += expect(fast == 1 && result == translated64.bits,
                       "binary64 endpoint translation");
    binary32 integer32 = { .value = 1.0f };
    binary32 translated32 = { .value = 1000001.0f };
    fast = pl_binary32_integer_translate_apply(
        integer32.bits, &translated, &result32);
    failures += expect(fast == 1 && result32 == translated32.bits,
                       "binary32 endpoint translation");

    pl_binary_integer_translate_cut crosses_zero;
    (void)pl_binary_integer_translate_step(-1, &crosses_zero);
    failures += expect(pl_binary64_integer_translate_apply(
                           integer64.bits, &crosses_zero, &result) == 0,
                       "signed-zero boundary enters residual");
    pl_binary_integer_translate_cut identity;
    pl_binary_integer_translate_identity(&identity);
    failures += expect(pl_binary64_integer_translate_apply(
                           0x8000000000000000ull, &identity, &result) == 1
                       && result == 0x8000000000000000ull,
                       "identity preserves negative zero");

    if (failures) return 1;
    printf("scalar cut: green (binary32/64 scale and exact-integer translation; 1,000,000 source operations -> 3 retained words, 1 materialization)\n");
    return 0;
}
