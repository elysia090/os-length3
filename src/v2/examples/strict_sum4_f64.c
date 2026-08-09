#include <stdint.h>

/* IEEE-754 addition is not associative: rounding after each partial sum makes
 * the order of a summation observable, which is why a compiler may not
 * reassociate one unless it is told the result need not match.
 *
 * The four addends are the four 16-bit lanes of the input, each read as a
 * bfloat16 and widened exactly into binary64; they are summed strictly left to
 * right in binary64 and the result comes back as its bit pattern.  Bfloat16
 * exponents span the whole binary32 range, so four addends routinely need more
 * than fifty-three significant bits and every partial sum rounds.
 *
 * Denormals flush to zero.  The arithmetic is spelled out on the fields of a
 * binary64, because that is what floating-point addition is once the hardware
 * is taken away. */

static uint64_t widen_bf16(uint16_t h)
{
    uint64_t sign = (uint64_t)(h >> 15) << 63;
    unsigned exp = (h >> 7) & 0xFFu;
    uint64_t man = (uint64_t)(h & 0x7Fu) << 45;

    if (exp == 0u) return sign;                       /* zero, or flushed */
    if (exp == 0xFFu) return sign | 0x7FF0000000000000ull | man;
    return sign | ((uint64_t)(exp + 896u) << 52) | man;
}

static uint64_t f64_add(uint64_t a, uint64_t b)
{
    uint64_t swap, ma, mb, sum, sticky;
    unsigned sa, sb, ea, eb, shift;
    int32_t e;

    if ((a & 0x7FFFFFFFFFFFFFFFull) < (b & 0x7FFFFFFFFFFFFFFFull)) {
        swap = a; a = b; b = swap;
    }

    sa = (unsigned)(a >> 63); ea = (unsigned)((a >> 52) & 0x7FFu);
    sb = (unsigned)(b >> 63); eb = (unsigned)((b >> 52) & 0x7FFu);

    if (ea == 0x7FFu) return a;              /* infinity or NaN wins      */
    if (ea == 0u) return 0;                  /* |a| >= |b|, so both zero  */
    if (eb == 0u) return a;                  /* b is zero or flushed      */

    shift = ea - eb;
    if (shift > 56u) return a;               /* b is below the sticky bit */

    ma = (((a & 0x000FFFFFFFFFFFFFull) | 0x0010000000000000ull) << 3);
    mb = (((b & 0x000FFFFFFFFFFFFFull) | 0x0010000000000000ull) << 3);
    sticky = (shift != 0u && (mb & (((uint64_t)1 << shift) - 1u)) != 0u) ? 1u : 0u;
    mb = (mb >> shift) | sticky;

    if (sa == sb) sum = ma + mb;
    else          sum = ma - mb;
    if (sum == 0u) return 0;

    e = (int32_t)ea;
    while (sum >= 0x0100000000000000ull) { sum = (sum >> 1) | (sum & 1u); e += 1; }
    while (sum < 0x0080000000000000ull) { sum <<= 1; e -= 1; }

    if ((sum & 7u) > 4u || ((sum & 7u) == 4u && (sum & 8u) != 0u)) sum += 8u;
    if (sum >= 0x0100000000000000ull) { sum >>= 1; e += 1; }
    sum >>= 3;

    if (e >= 0x7FF) return ((uint64_t)sa << 63) | 0x7FF0000000000000ull;
    if (e <= 0) return (uint64_t)sa << 63;
    return ((uint64_t)sa << 63) | ((uint64_t)e << 52)
         | (sum & 0x000FFFFFFFFFFFFFull);
}

uint64_t strict_sum4_f64(uint64_t v)
{
    uint64_t acc = widen_bf16((uint16_t)v);
    unsigned i;

    for (i = 1; i < 4; ++i)
        acc = f64_add(acc, widen_bf16((uint16_t)(v >> (16 * i))));
    return acc;
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
                print_hex64((uint64_t)strict_sum4_f64((uint64_t)x));
                putchar('\n');
            }
            x = 0;
            seen = 0;
            if (c < 0) break;
        }
    }
    return 0;
}
