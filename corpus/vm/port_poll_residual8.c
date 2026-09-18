#include <stdint.h>

/* The low byte is a retry budget and bit 1 of the high byte is a stable
 * device-busy observation.  An invariant busy input consumes the complete
 * budget; a ready input leaves it untouched. */
uint8_t port_poll_residual8(uint16_t budget_and_status)
{
    uint8_t budget = (uint8_t)budget_and_status;
    uint8_t status = (uint8_t)(budget_and_status >> 8);

    while (budget != 0 && (status & 2u) != 0)
        --budget;
    return budget;
}
