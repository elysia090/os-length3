/* Hello, world — and the whole of what this page does, in one file.
 *
 * Two halves, and they go to two different places.
 *
 * `repeat8` is the kernel. QM minimizes it, and the pane on the right shows
 * what it made of it — in whichever machine you pick, or as the codec, which
 * is the artifact itself. One multiply, on every target that has one.
 *
 * `main` is a driver. The minimizer never sees it: it reads a stream rather
 * than a domain, so minimizing it would report the driver's function instead
 * of the kernel's. Press Run and `main` is compiled on its own with `repeat8`
 * left undefined, and every call it makes is answered by running the artifact:
 *
 *     this file -> QM -> codec -> run
 *
 * So the greeting is ordinary C, and every line after it came out of the
 * minimized program. Type a few characters into the terminal and press Run.
 *
 * `getchar`, `putchar`, `puts`, `print_u64` and `print_hex64` are all there
 * is. The module is freestanding and the first two are its only imports.
 */
#include <stdint.h>

/* One byte, eight times over: the classic broadcast, which is a multiply by
 * 0x0101010101010101 and nothing else. */
uint64_t repeat8(uint8_t c)
{
    return (uint64_t)c * 0x0101010101010101ull;
}

int main(void)
{
    int c;

    puts("Hello, world!");

    while ((c = getchar()) >= 0) {
        uint64_t eight = repeat8((uint8_t)c);

        for (int i = 0; i < 8; ++i)
            putchar((int)((eight >> (8 * i)) & 0xFF));
        putchar('\n');
    }
    return 0;
}
