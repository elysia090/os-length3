#include <stdint.h>

/* A page coordinate is a 4-bit row rank followed by an 8-bit tail rank.
 * Equal 256-coordinate rows are stored once.  Publication validates the ranks,
 * so the executed map is exactly two dependent loads. */
uint32_t entry_map(const uint32_t *page_rows,
                   const uint32_t *tail_rows,
                   uint32_t page_rank,
                   uint32_t page_offset)
{
    uint32_t row = page_rows[page_rank * 16u + (page_offset >> 8)];
    return tail_rows[row * 256u + (page_offset & 255u)];
}
