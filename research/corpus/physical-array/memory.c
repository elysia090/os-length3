#include <stdint.h>

uint32_t memory(uint32_t x)
{
    volatile uint32_t *cells = (volatile uint32_t *)(uintptr_t)1024u;
    uint32_t index = x & 7u;
    uint32_t value = x + 1u;

    cells[index] = value;
    return cells[index] + cells[index];
}
