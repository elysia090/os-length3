#include <stdint.h>

/* This is the observable value of a delay leaf followed by one stable port
 * test.  Arithmetic performed only for the discarded delay value must not
 * survive the returned projection. */
uint8_t poll_delay_projection8(uint16_t counter_and_status)
{
    uint8_t counter = (uint8_t)counter_and_status;
    uint8_t status = (uint8_t)(counter_and_status >> 8);
    uint32_t delay = (uint32_t)counter * 62u;

    delay *= 4295u;
    delay += 1u;
    (void)delay;
    return (status & 2u) != 0 ? (uint8_t)(counter - 1u) : counter;
}
