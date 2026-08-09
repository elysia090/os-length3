#include <stdint.h>

/* Princeton 4/e, key-indexed counting — the counting pass on its own: sixteen
 * two-bit keys, and the four counts that come out of them, one per byte.
 *
 * Four independent counts of one word.  Each is a lane predicate and a
 * population count, which the grammar has; what it does not have is a way to
 * say "and these four answers go in these four fields", so an abstract program
 * is still a chain and this is still out of reach. */
uint32_t histogram4_u2x16(uint32_t v)
{
    uint32_t out = 0;

    for (unsigned i = 0; i < 16; ++i)
        out += (uint32_t)1 << (8 * ((v >> (2 * i)) & 3u));
    return out;
}
