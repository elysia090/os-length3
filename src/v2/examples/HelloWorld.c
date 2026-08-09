/* Hello, world -- and the whole of what this page does, in one file.
 *
 * Two halves, and they are read differently.
 *
 * `repeat8` is the kernel. It is the half that gets minimized, and the pane on
 * the right shows what came of it -- in whichever machine you pick, or as the
 * one canonical artifact both of them come from. One multiply, on every target
 * that has one.
 *
 * `main` is a driver. It is not analysed: it reads a stream rather than a
 * range of inputs, so analysing it would describe the driver instead of the
 * function under it. Press Run and `main` is compiled on its own with
 * `repeat8` left undefined, and every call it makes is answered by running the
 * minimized program instead.
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
