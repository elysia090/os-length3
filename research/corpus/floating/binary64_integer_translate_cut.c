#include <stdint.h>

typedef struct {
    int64_t total;
    int64_t minimum_prefix;
    int64_t maximum_prefix;
} binary64_integer_translate_cut_t;

/* Summarize ordered additions of exactly represented integer constants. */
void binary64_integer_translate_cut_append(
    binary64_integer_translate_cut_t *cut,
    int64_t delta)
{
    const int64_t next = cut->total + delta;
    cut->total = next;
    cut->minimum_prefix = next < cut->minimum_prefix
                        ? next : cut->minimum_prefix;
    cut->maximum_prefix = next > cut->maximum_prefix
                        ? next : cut->maximum_prefix;
}

/* Apply the summary when every intermediate result is an exactly
 * representable, nonzero binary64 integer. The caller uses the ordinary
 * ordered operations when this function returns zero. */
int binary64_integer_translate_cut_apply(
    int64_t input,
    const binary64_integer_translate_cut_t *cut,
    int64_t *output)
{
    const int64_t limit = INT64_C(1) << 53;
    const int64_t lowest = input + cut->minimum_prefix;
    const int64_t highest = input + cut->maximum_prefix;

    if (lowest < -limit || highest > limit
            || (input > 0 ? lowest <= 0 : highest >= 0))
        return 0;
    *output = input + cut->total;
    return 1;
}
