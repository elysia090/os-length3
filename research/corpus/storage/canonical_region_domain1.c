#include <stdint.h>

/* Publish one persistent difference coordinate after the write comparison.
 *
 * changed_write is R = P & (V != B), so R implies written.  Under that
 * necessary invariant the two output terms are disjoint and OR is XOR:
 * D = R ^ (Q & ~P). */
_Bool canonical_region_domain1(
    _Bool previous_dirty,
    _Bool written,
    _Bool changed_write)
{
    return changed_write ^ (previous_dirty & !written);
}
