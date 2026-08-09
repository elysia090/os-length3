/* The same kernel as ranks8.c, with a driver — what Run executes.
 *
 * A paste may carry a `main`. The minimizer never sees it: `main` reads a
 * stream rather than a domain, so minimizing it would report the driver's
 * function instead of the kernel's. The two panes show what QM made of
 * `ranks8` alone.
 *
 * Run compiles this `main` on its own, with `ranks8` left undefined, and
 * answers the call by feeding the artifact. So every line the terminal prints
 * came out of the minimized program:
 *
 *     paste -> QM -> codec -> run
 *
 * Type bytes into the terminal and press Run. `getchar`, `putchar`, `puts`,
 * `print_u64` and `print_hex64` are all there is — the module is freestanding
 * and those two of them are its only imports.
 */
#include <stdint.h>

/* Exclusive prefix popcount, one lane per bit: lane i holds how many of the
 * bits below i are set. */
uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;

    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(m & ((1u << i) - 1)) << (8 * i);

    return r;
}

int main(void)
{
    int c;

    while ((c = getchar()) >= 0) {
        print_hex64(ranks8((uint8_t)c));
        putchar('\n');
    }
    puts("done");
    return 0;
}
