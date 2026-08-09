#include <stdint.h>

/* logicalNeg from the CS:APP Data Lab (CMU 15-213): the `!` operator,
 * implemented without it. logicalNeg(3) is 0 and logicalNeg(0) is 1.
 *
 * One bit of answer, and the whole thirty-two-bit word decides it. */
uint32_t logical_neg_i32(uint32_t x)
{
    return x == 0u ? 1u : 0u;
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
                print_hex64((uint64_t)logical_neg_i32((uint32_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
