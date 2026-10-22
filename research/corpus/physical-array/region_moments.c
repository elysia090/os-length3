/* Small dense comparison for pa_region.h.

   Build:
       cc -std=c11 -O2 region_moments.c -o region_moments
*/
#include <assert.h>
#include <stdint.h>
#include <stdio.h>

#include "pa_region.h"

static pa_moments2_u64 dense(pa_region_i64 region)
{
    pa_moments2_u64 out = {0, 0, 0};
    for (uint64_t i = 0; i < region.count; ++i) {
        uint64_t value = (uint64_t)(region.first + region.step * (int64_t)i);
        out.m0 += 1;
        out.m1 += value;
        out.m2 += value * value;
    }
    return out;
}

static void check(pa_region_i64 region)
{
    pa_moments2_u64 compact = pa_region_moments(region);
    pa_moments2_u64 reference = dense(region);
    assert(compact.m0 == reference.m0);
    assert(compact.m1 == reference.m1);
    assert(compact.m2 == reference.m2);
}

int main(void)
{
    pa_region_i64 base = {3, 5, 100};
    pa_region_i64 interval, phase;
    assert(pa_region_cut_interval(base, 30, 400, &interval));
    assert(pa_region_cut_residue(interval, 7, 2, &phase));

    check(base);
    check(interval);
    check(phase);

    pa_moments2_u64 result = pa_region_moments(phase);
    printf("count=%llu sum=%llu sumsq=%llu\n",
           (unsigned long long)result.m0,
           (unsigned long long)result.m1,
           (unsigned long long)result.m2);
    return 0;
}
