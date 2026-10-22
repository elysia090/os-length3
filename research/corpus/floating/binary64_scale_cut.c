#include <stdint.h>

typedef struct {
    int64_t total;
    int64_t minimum_prefix;
    int64_t maximum_prefix;
} binary64_scale_cut_t;

void binary64_scale_cut_append(
    binary64_scale_cut_t *cut,
    int64_t exponent_delta)
{
    const int64_t next = cut->total + exponent_delta;
    cut->total = next;
    cut->minimum_prefix = next < cut->minimum_prefix
                        ? next : cut->minimum_prefix;
    cut->maximum_prefix = next > cut->maximum_prefix
                        ? next : cut->maximum_prefix;
}

int binary64_scale_cut_apply(
    uint64_t input,
    const binary64_scale_cut_t *cut,
    uint64_t *output)
{
    const uint64_t exponent = (input >> 52) & 0x7ffu;
    const int64_t lowest = (int64_t)exponent + cut->minimum_prefix;
    const int64_t highest = (int64_t)exponent + cut->maximum_prefix;
    if ((uint64_t)lowest - 1u >= 2046u
            || (uint64_t)highest - 1u >= 2046u)
        return 0;
    *output = (input & UINT64_C(0x800fffffffffffff))
            | ((uint64_t)((int64_t)exponent + cut->total) << 52);
    return 1;
}
