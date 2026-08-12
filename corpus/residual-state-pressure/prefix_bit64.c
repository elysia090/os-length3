#include <stdint.h>

/* A word-packed residual answers one future bit query without rescanning the
 * value that produced it.  The independent arguments deliberately total 72
 * bits, so an analyzer must preserve them as separate coordinates instead of
 * forcing them through one 64-bit scalar argument. */
uint8_t prefix_bit64(uint64_t residual, uint8_t index)
{
    return (uint8_t)((residual >> ((unsigned)index & 63u)) & 1u);
}
