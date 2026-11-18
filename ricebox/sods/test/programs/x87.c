// long double operations, printed as raw bits (no float formatting).
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void show(const char *what, long double v) {
    uint64_t m; uint16_t se;
    memcpy(&m, &v, 8); memcpy(&se, (char *)&v + 8, 2);
    printf("%-10s %04x %016llx\n", what, se, (unsigned long long)m);
}

int main(int argc, char **argv) {
    volatile int n = argc;
    long double a = n, b = -0.0L * n, c = 1.0L / 3 * n, d = 1e300L * n;
    show("int", a); show("negzero", b); show("third", c); show("big", d);
    show("double", (long double)(double)(0.1 * n));
    int e;
    show("frexp", frexpl(c * 1000, &e));
    printf("exp %d sign %d %d\n", e, signbit(b) != 0, signbit(c) != 0);
    long double y = 1e9L * n;
    uint32_t u = y; int64_t i = (int64_t)(c * 1e12L);
    printf("conv %u %lld\n", u, (long long)i);
    show("mul", (y - u) * 1000000000);
    show("sub", c - 1);
    printf("cmp %d %d %d\n", a < c, a == a, c > d);
    return 0;
}
