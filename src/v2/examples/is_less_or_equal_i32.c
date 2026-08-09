#include <stdint.h>

/* isLessOrEqual from the CS:APP Data Lab (CMU 15-213): 1 when x <= y and 0
 * otherwise, for two signed 32-bit values.
 *
 * The two arguments arrive as the high and low halves of one word, because
 * this file states one function of one input. */
uint32_t is_less_or_equal_i32(uint64_t ab)
{
    int32_t a = (int32_t)(uint32_t)(ab >> 32);
    int32_t b = (int32_t)(uint32_t)ab;

    return a <= b ? 1u : 0u;
}

/* Reads whitespace-separated hex words from the terminal and prints what the
 * kernel makes of each one. */
int main(void)
{
    uint64_t x = 0;
    int c, seen = 0;

    while (1) {
        c = getchar();
        if (c >= '0' && c <= '9')      { x = x * 16u + (uint64_t)(c - '0');      seen = 1; }
        else if (c >= 'a' && c <= 'f') { x = x * 16u + (uint64_t)(c - 'a' + 10); seen = 1; }
        else if (c >= 'A' && c <= 'F') { x = x * 16u + (uint64_t)(c - 'A' + 10); seen = 1; }
        else {
            if (seen) {
                print_hex64((uint64_t)is_less_or_equal_i32((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
