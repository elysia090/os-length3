// printf and strtod round trips through musl's long double paths.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    double values[] = {0.0, -0.0, 1.0, 3.14159265358979, 1e-300, 6.02214076e23, 123456.789, -2.5, 1.0 / 3.0, 1e15 + 0.3};
    for (unsigned i = 0; i < sizeof values / sizeof *values; i++) {
        double v = values[i] * argc / 3;
        printf("%g %f %.3e %.17g\n", v, v, v, v);
    }
    printf("%.10f %g\n", sqrt(2.0 * argc), strtod("2.718281828459045", 0));
    printf("%Lf %Lg\n", (long double)argc / 7, (long double)argc * 1e10L);
    printf("%d %d\n", (int)lround(2.5 * argc), (int)floor(-1.5 * argc));
    return 0;
}
