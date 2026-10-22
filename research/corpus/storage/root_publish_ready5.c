#include <stdint.h>

/* The five low bits are authenticated-root, exact-parent, next-sequence,
 * live-fence, and complete-object-set.  Publication is legal exactly when
 * all five facts hold.  Higher transport/status bits are irrelevant. */
uint8_t root_publish_ready5(uint8_t conditions)
{
    conditions &= 31u;
    return (uint8_t)((conditions + 1u) >> 5);
}
