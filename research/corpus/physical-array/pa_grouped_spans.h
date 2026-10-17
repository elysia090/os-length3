#ifndef PA_GROUPED_SPANS_H
#define PA_GROUPED_SPANS_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Build a compact grouped-span index from one key per logical item.

   offsets[k]..offsets[k+1] is the contiguous span for key k, and position[i]
   is item i's slot in that span. Invalid items receive position -1. The
   caller owns all arrays, so the function is usable in native and WebAssembly
   runtimes without an allocator or hidden materialization.

   Returns 1 on success. A negative or out-of-domain key is an explicit
   non-compact input and returns 0; it is never silently wrapped. */
static int pa_grouped_spans_i64(
    size_t key_count,
    size_t item_count,
    const int64_t *key,
    const unsigned char *valid,
    int32_t *offsets,
    int32_t *position,
    int32_t *cursor)
{
    if (key_count > (size_t)INT32_MAX || item_count > (size_t)INT32_MAX)
        return 0;

    memset(offsets, 0, (key_count + 1u) * sizeof(*offsets));
    for (size_t item = 0; item < item_count; ++item) {
        position[item] = -1;
        if (!valid[item]) continue;
        if (key[item] < 0 || (uint64_t)key[item] >= (uint64_t)key_count)
            return 0;
        offsets[(size_t)key[item] + 1u] += 1;
    }

    for (size_t point = 0; point < key_count; ++point)
        offsets[point + 1u] += offsets[point];
    memcpy(cursor, offsets, key_count * sizeof(*cursor));

    for (size_t item = 0; item < item_count; ++item) {
        if (!valid[item]) continue;
        position[item] = cursor[(size_t)key[item]]++;
    }
    return 1;
}

#endif
