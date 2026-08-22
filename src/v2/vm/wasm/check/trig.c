#include <stdio.h>

#include "../trig.c"

int main(void)
{
    static const int exponent[] = {0, 10, 20, 21, 30, 40, 50, 60, 63};
    for (unsigned index = 0u;
            index < sizeof exponent / sizeof exponent[0]; ++index) {
        double value = 1.0;
        for (int bit = 0; bit < exponent[index]; ++bit) value *= 2.0;
        double sine, cosine;
        double reduced[2] = {0.0, 0.0};
        int quadrant = value > 0.7853981633974483
                     ? vm_rem_pio2(value, reduced) : 0;
        pl_vm_math_sincos(value, &sine, &cosine);
        printf("2^%d q=%d r=%.17g %.17g s=%.17g c=%.17g\n",
               exponent[index], quadrant, reduced[0], reduced[1],
               sine, cosine);
    }
    return 0;
}
