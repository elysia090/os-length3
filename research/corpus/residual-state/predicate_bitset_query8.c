#include <stdint.h>

/* A sealed answer byte is the complete residual for eight Boolean predicates.
 * The three low query bits select one answer; no source predicate is evaluated
 * again.  The high query bits are deliberately unobservable. */
uint8_t predicate_bitset_query8(uint16_t answers_and_query)
{
    uint8_t answers = (uint8_t)answers_and_query;
    unsigned query = (unsigned)(answers_and_query >> 8) & 7u;
    return (uint8_t)((answers >> query) & 1u);
}
