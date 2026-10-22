#include <stdint.h>

/* One coordinate of normalization against the immutable base.
 *
 * A newer write supersedes the previous dirty bit.  Without a newer write the
 * previous bit is retained.  This is the pointwise necessary-and-sufficient
 * condition D = P ? (V != B) : Q. */
_Bool canonical_region_dirty1(
    uint8_t base,
    uint8_t written_value,
    _Bool previous_dirty,
    _Bool written)
{
    return written ? written_value != base : previous_dirty;
}
