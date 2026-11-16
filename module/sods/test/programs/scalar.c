// Scalar SSE arithmetic, printed through integers only.
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

__attribute__((noinline)) static double f(long a, long b) { return a + b * 1e-9; }
__attribute__((noinline)) static float g(int a) { return a * 0.5f + 0.25f; }

int main(int argc, char **argv) {
    volatile long s = argc * 12345, ns = argc * 678901234L;
    double d = f(s, ns);
    printf("%lld\n", (long long)(d * 1000000));
    printf("%lld\n", (long long)(d - s) * 1000);
    printf("%d\n", (int)(g(argc) * 100));
    double x = argc / 3.0, y = argc * 1.5;
    printf("%d %d %d\n", x < y, x == y, x > y);
    printf("%lld\n", (long long)((x + y) * (x - y) / 7 * 1e6));
    printf("%d\n", (int)(float)(x * 1000));
    printf("%ld\n", lrint(y * 7.3));
    return 0;
}
