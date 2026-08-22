/* Range reduction and double-precision trigonometric kernels derived from
 * FreeBSD msun as distributed by musl 1.2.6.
 *
 * Copyright (C) 1993, 2004 Sun Microsystems, Inc. All rights reserved.
 * Permission to use, copy, modify, and distribute this software is freely
 * granted, provided that this notice is preserved.
 *
 * The x87 frontend admits arguments only through the architectural 2^63
 * bound.  Consequently the 24-bit 2/pi expansion needs only this finite
 * prefix; it is not a general unbounded-exponent libm entry point. */

typedef unsigned int vm_u32;
typedef unsigned long long vm_u64;
typedef int vm_i32;

typedef union {
    double value;
    vm_u64 bits;
} VmDoubleBits;

static double vm_scale2(double value, int exponent)
{
    while (exponent > 0) {
        value *= 2.0;
        --exponent;
    }
    while (exponent < 0) {
        value *= 0.5;
        ++exponent;
    }
    return value;
}

static double vm_floor_positive(double value)
{
    VmDoubleBits word = { value };
    int exponent = (int)((word.bits >> 52u) & 0x7ffu) - 1023;
    if (exponent < 0) return 0.0;
    if (exponent >= 52) return value;
    word.bits &= ~((1ull << (52 - exponent)) - 1ull);
    return word.value;
}

static double vm_trig_sin_kernel(double x, double y, int tail)
{
    const double s1 = -1.66666666666666324348e-01;
    const double s2 =  8.33333333332248946124e-03;
    const double s3 = -1.98412698298579493134e-04;
    const double s4 =  2.75573137070700676789e-06;
    const double s5 = -2.50507602534068634195e-08;
    const double s6 =  1.58969099521155010221e-10;
    double z = x * x;
    double w = z * z;
    double r = s2 + z * (s3 + z * s4)
             + z * w * (s5 + z * s6);
    double v = z * x;
    return tail ? x - ((z * (0.5 * y - v * r) - y) - v * s1)
                : x + v * (s1 + z * r);
}

static double vm_trig_cos_kernel(double x, double y)
{
    const double c1 =  4.16666666666666019037e-02;
    const double c2 = -1.38888888888741095749e-03;
    const double c3 =  2.48015872894767294178e-05;
    const double c4 = -2.75573143513906633035e-07;
    const double c5 =  2.08757232129817482790e-09;
    const double c6 = -1.13596475577881948265e-11;
    double z = x * x;
    double w = z * z;
    double r = z * (c1 + z * (c2 + z * c3))
             + w * w * (c4 + z * (c5 + z * c6));
    double half = 0.5 * z;
    w = 1.0 - half;
    return w + (((1.0 - w) - half) + (z * r - x * y));
}

static double vm_trig_tan_kernel(double x, double y, int reciprocal)
{
    static const double coefficient[13] = {
         3.33333333333334091986e-01,  1.33333333333201242699e-01,
         5.39682539762260521377e-02,  2.18694882948595424599e-02,
         8.86323982359930005737e-03,  3.59207910759131235356e-03,
         1.45620945432529025516e-03,  5.88041240820264096874e-04,
         2.46463134818469906812e-04,  7.81794442939557092300e-05,
         7.14072491382608190305e-05, -1.85586374855275456654e-05,
         2.59073051863633712884e-05,
    };
    const double pio4 = 7.85398163397448278999e-01;
    const double pio4_low = 3.06161699786838301793e-17;
    VmDoubleBits word = { x };
    int large = ((vm_u32)(word.bits >> 32u) & 0x7fffffffu) >= 0x3fe59428u;
    int sign = 0;
    if (large) {
        sign = (int)(word.bits >> 63u);
        if (sign) {
            x = -x;
            y = -y;
        }
        x = (pio4 - x) + (pio4_low - y);
        y = 0.0;
    }
    double z = x * x;
    double w = z * z;
    double r = coefficient[1] + w * (coefficient[3]
             + w * (coefficient[5] + w * (coefficient[7]
             + w * (coefficient[9] + w * coefficient[11]))));
    double v = z * (coefficient[2] + w * (coefficient[4]
             + w * (coefficient[6] + w * (coefficient[8]
             + w * (coefficient[10] + w * coefficient[12])))));
    double s = z * x;
    r = y + z * (s * (r + v) + y) + s * coefficient[0];
    w = x + r;
    if (large) {
        s = 1.0 - 2.0 * reciprocal;
        v = s - 2.0 * (x + (r - w * w / (w + s)));
        return sign ? -v : v;
    }
    if (!reciprocal) return w;
    VmDoubleBits high = { w };
    high.bits &= 0xffffffff00000000ull;
    v = r - (high.value - x);
    double inverse = -1.0 / w;
    VmDoubleBits inverse_high = { inverse };
    inverse_high.bits &= 0xffffffff00000000ull;
    return inverse_high.value
         + inverse * (1.0 + inverse_high.value * high.value
                      + inverse_high.value * v);
}

static const vm_i32 vm_two_over_pi[24] = {
    0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1,
    0xf534dd, 0xc0db62, 0x95993c, 0x439041,
    0xfe5163, 0xabdebb, 0xc561b7, 0x246e3a,
    0x424dd2, 0xe00649, 0x2eea09, 0xd1921c,
    0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5,
    0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41,
};

static const double vm_pio2_part[8] = {
    1.57079625129699707031e+00, 7.54978941586159635335e-08,
    5.39030252995776476554e-15, 3.28200341580791294123e-22,
    1.27065575308067607349e-29, 1.22933308981111328932e-36,
    2.73370053816464559624e-44, 2.16741683877804819444e-51,
};

/* Return x - n*pi/2 as two non-overlapping doubles and n modulo eight. */
static int vm_rem_pio2_large(double *x, double *y, int exponent, int count)
{
    vm_i32 digit[20];
    double factor[20], product[20], fraction[20] = {0};
    int last_input = count - 1;
    int table = (exponent - 3) / 24;
    if (table < 0) table = 0;
    int quotient_exponent = exponent - 24 * (table + 1);
    int terms = 4;
    int first = table - last_input;
    int extent = last_input + terms;
    for (int i = 0; i <= extent; ++i)
        factor[i] = first + i < 0 ? 0.0
                  : (double)vm_two_over_pi[first + i];
    for (int i = 0; i <= terms; ++i) {
        double sum = 0.0;
        for (int j = 0; j <= last_input; ++j)
            sum += x[j] * factor[last_input + i - j];
        product[i] = sum;
    }

    int last = terms;
    double z;
recompute:
    z = product[last];
    int j = last;
    int i = 0;
    for (; j > 0; ++i, --j) {
        double carry = (double)(vm_i32)(0x1p-24 * z);
        digit[i] = (vm_i32)(z - 0x1p24 * carry);
        z = product[j - 1] + carry;
    }
    z = vm_scale2(z, quotient_exponent);
    z -= 8.0 * vm_floor_positive(z * 0.125);
    int n = (vm_i32)z;
    z -= (double)n;
    int half = 0;
    if (quotient_exponent > 0) {
        i = digit[last - 1] >> (24 - quotient_exponent);
        n += i;
        digit[last - 1] -= i << (24 - quotient_exponent);
        half = digit[last - 1] >> (23 - quotient_exponent);
    } else if (quotient_exponent == 0) {
        half = digit[last - 1] >> 23;
    } else if (z >= 0.5) {
        half = 2;
    }
    if (half > 0) {
        ++n;
        int carry = 0;
        for (i = 0; i < last; ++i) {
            j = digit[i];
            if (!carry) {
                if (j) {
                    carry = 1;
                    digit[i] = 0x1000000 - j;
                }
            } else {
                digit[i] = 0xffffff - j;
            }
        }
        if (quotient_exponent > 0)
            digit[last - 1] &= quotient_exponent == 1
                             ? 0x7fffff : 0x3fffff;
        if (half == 2) {
            z = 1.0 - z;
            if (carry) z -= vm_scale2(1.0, quotient_exponent);
        }
    }
    if (z == 0.0) {
        j = 0;
        for (i = last - 1; i >= terms; --i) j |= digit[i];
        if (!j) {
            int extra = 1;
            while (digit[terms - extra] == 0) ++extra;
            for (i = last + 1; i <= last + extra; ++i) {
                factor[last_input + i] =
                    (double)vm_two_over_pi[table + i];
                double sum = 0.0;
                for (j = 0; j <= last_input; ++j)
                    sum += x[j] * factor[last_input + i - j];
                product[i] = sum;
            }
            last += extra;
            goto recompute;
        }
    }
    if (z == 0.0) {
        --last;
        quotient_exponent -= 24;
        while (!digit[last]) {
            --last;
            quotient_exponent -= 24;
        }
    } else {
        z = vm_scale2(z, -quotient_exponent);
        if (z >= 0x1p24) {
            double carry = (double)(vm_i32)(0x1p-24 * z);
            digit[last] = (vm_i32)(z - 0x1p24 * carry);
            ++last;
            quotient_exponent += 24;
            digit[last] = (vm_i32)carry;
        } else {
            digit[last] = (vm_i32)z;
        }
    }
    double scale = vm_scale2(1.0, quotient_exponent);
    for (i = last; i >= 0; --i) {
        product[i] = scale * (double)digit[i];
        scale *= 0x1p-24;
    }
    for (i = last; i >= 0; --i) {
        double sum = 0.0;
        int limit = last - i < 4 ? last - i : 4;
        for (int k = 0; k <= limit; ++k)
            sum += vm_pio2_part[k] * product[i + k];
        fraction[last - i] = sum;
    }
    double sum = 0.0;
    for (i = last; i >= 0; --i) sum += fraction[i];
    sum = (double)sum;
    y[0] = half ? -sum : sum;
    double tail = fraction[0] - sum;
    for (i = 1; i <= last; ++i) tail += fraction[i];
    y[1] = half ? -tail : tail;
    return n & 7;
}

static int vm_rem_pio2(double x, double *y)
{
    const double pio4 = 0x1.921fb54442d18p-1;
    const double inverse = 6.36619772367581382433e-01;
    const double pio2_1 = 1.57079632673412561417e+00;
    const double pio2_1t = 6.07710050650619224932e-11;
    const double pio2_2 = 6.07710050630396597660e-11;
    const double pio2_2t = 2.02226624879595063154e-21;
    const double pio2_3 = 2.02226624871116645580e-21;
    const double pio2_3t = 8.47842766036889956997e-32;
    const double to_integer = 0x1.8p52;
    VmDoubleBits word = { x };
    int sign = (int)(word.bits >> 63u);
    vm_u32 high = (vm_u32)(word.bits >> 32u) & 0x7fffffffu;
    if (high <= 0x400f6a7au && (high & 0xfffffu) != 0x921fbu) {
        int multiple = high <= 0x4002d97cu ? 1 : 2;
        double z = sign ? x + multiple * pio2_1
                        : x - multiple * pio2_1;
        y[0] = sign ? z + multiple * pio2_1t
                    : z - multiple * pio2_1t;
        y[1] = sign ? (z - y[0]) + multiple * pio2_1t
                    : (z - y[0]) - multiple * pio2_1t;
        return sign ? -multiple : multiple;
    }
    if (high <= 0x401c463bu
            && high != 0x4012d97cu && high != 0x401921fbu) {
        int multiple = high <= 0x4015fdbcu ? 3 : 4;
        double z = sign ? x + multiple * pio2_1
                        : x - multiple * pio2_1;
        y[0] = sign ? z + multiple * pio2_1t
                    : z - multiple * pio2_1t;
        y[1] = sign ? (z - y[0]) + multiple * pio2_1t
                    : (z - y[0]) - multiple * pio2_1t;
        return sign ? -multiple : multiple;
    }
    if (high < 0x413921fbu) {
        double nearest = x * inverse + to_integer - to_integer;
        int n = (vm_i32)nearest;
        double r = x - nearest * pio2_1;
        double w = nearest * pio2_1t;
        if (r - w < -pio4) {
            --n;
            nearest -= 1.0;
            r = x - nearest * pio2_1;
            w = nearest * pio2_1t;
        } else if (r - w > pio4) {
            ++n;
            nearest += 1.0;
            r = x - nearest * pio2_1;
            w = nearest * pio2_1t;
        }
        y[0] = r - w;
        VmDoubleBits reduced = { y[0] };
        int reduced_exponent = (int)(reduced.bits >> 52u) & 0x7ff;
        int input_exponent = (int)(high >> 20u);
        if (input_exponent - reduced_exponent > 16) {
            double prior = r;
            w = nearest * pio2_2;
            r = prior - w;
            w = nearest * pio2_2t - ((prior - r) - w);
            y[0] = r - w;
            reduced.value = y[0];
            reduced_exponent = (int)(reduced.bits >> 52u) & 0x7ff;
            if (input_exponent - reduced_exponent > 49) {
                prior = r;
                w = nearest * pio2_3;
                r = prior - w;
                w = nearest * pio2_3t - ((prior - r) - w);
                y[0] = r - w;
            }
        }
        y[1] = (r - y[0]) - w;
        return n;
    }
    word.bits &= 0x000fffffffffffffull;
    word.bits |= (vm_u64)(1023 + 23) << 52u;
    double z = word.value;
    double chunks[3];
    int i;
    for (i = 0; i < 2; ++i) {
        chunks[i] = (double)(vm_i32)z;
        z = (z - chunks[i]) * 0x1p24;
    }
    chunks[i] = z;
    while (chunks[i] == 0.0) --i;
    int n = vm_rem_pio2_large(
        chunks, y, (int)(high >> 20u) - (1023 + 23), i + 1);
    if (sign) {
        y[0] = -y[0];
        y[1] = -y[1];
        return -n;
    }
    return n;
}

void pl_vm_math_sincos(double x, double *sine, double *cosine)
{
    VmDoubleBits word = { x };
    vm_u32 magnitude = (vm_u32)(word.bits >> 32u) & 0x7fffffffu;
    if (magnitude <= 0x3fe921fbu) {
        if (magnitude < 0x3e46a09eu) {
            *sine = x;
            *cosine = 1.0;
        } else {
            *sine = vm_trig_sin_kernel(x, 0.0, 0);
            *cosine = vm_trig_cos_kernel(x, 0.0);
        }
        return;
    }
    if (magnitude >= 0x7ff00000u) {
        *sine = x - x;
        *cosine = x - x;
        return;
    }
    double reduced[2];
    int quadrant = vm_rem_pio2(x, reduced);
    double s = vm_trig_sin_kernel(reduced[0], reduced[1], 1);
    double c = vm_trig_cos_kernel(reduced[0], reduced[1]);
    if ((quadrant & 3) == 0) {
        *sine = s; *cosine = c;
    } else if ((quadrant & 3) == 1) {
        *sine = c; *cosine = -s;
    } else if ((quadrant & 3) == 2) {
        *sine = -s; *cosine = -c;
    } else {
        *sine = -c; *cosine = s;
    }
}

double pl_vm_math_tan(double x)
{
    VmDoubleBits word = { x };
    vm_u32 magnitude = (vm_u32)(word.bits >> 32u) & 0x7fffffffu;
    if (magnitude <= 0x3fe921fbu) {
        if (magnitude < 0x3e400000u) return x;
        return vm_trig_tan_kernel(x, 0.0, 0);
    }
    if (magnitude >= 0x7ff00000u) return x - x;
    double reduced[2];
    int quadrant = vm_rem_pio2(x, reduced);
    return vm_trig_tan_kernel(reduced[0], reduced[1], quadrant & 1);
}

/* These bounded kernels share the same freestanding binary64 substrate as
 * the trigonometric frontend.  Their callers own x87 special values and
 * extended-range scaling, so each kernel receives only its reduced finite
 * domain and introduces no libc or host-math import. */
double pl_vm_math_exp2m1(double x)
{
    static const vm_u64 scale_bits[17] = {
        0x3fe0000000000000ull, 0x3fe172b83c7d517bull,
        0x3fe306fe0a31b715ull, 0x3fe4bfdad5362a27ull,
        0x3fe6a09e667f3bcdull, 0x3fe8ace5422aa0dbull,
        0x3feae89f995ad3adull, 0x3fed5818dcfba487ull,
        0x3ff0000000000000ull, 0x3ff172b83c7d517bull,
        0x3ff306fe0a31b715ull, 0x3ff4bfdad5362a27ull,
        0x3ff6a09e667f3bcdull, 0x3ff8ace5422aa0dbull,
        0x3ffae89f995ad3adull, 0x3ffd5818dcfba487ull,
        0x4000000000000000ull,
    };
    static const vm_u64 offset_bits[17] = {
        0xbfe0000000000000ull, 0xbfdd1a8f87055d0aull,
        0xbfd9f203eb9c91d6ull, 0xbfd6804a5593abb2ull,
        0xbfd2bec333018866ull, 0xbfcd4c6af7557c94ull,
        0xbfc45d819a94b14cull, 0xbfb53f391822dbc8ull,
        0x0000000000000000ull, 0x3fb72b83c7d517b0ull,
        0x3fc837f0518db8a8ull, 0x3fd2ff6b54d8a89cull,
        0x3fda827999fcef34ull, 0x3fe159ca845541b6ull,
        0x3fe5d13f32b5a75aull, 0x3feab031b9f7490eull,
        0x3ff0000000000000ull,
    };
    if (x == 0.0) return x;
    if (x == 1.0) return 1.0;
    if (x == -1.0) return -0.5;
    int nearest = (int)(x * 8.0 + (x < 0.0 ? -0.5 : 0.5));
    double reduced = x - (double)nearest * 0.125;
    const double ln2 = 6.93147180559945309417e-01;
    double z = reduced * ln2;
    double term = z;
    double sum = z;
    double correction = 0.0;
    for (int order = 2; order <= 14; ++order) {
        term *= z / (double)order;
        double adjusted = term - correction;
        double next = sum + adjusted;
        correction = (next - sum) - adjusted;
        sum = next;
    }
    VmDoubleBits scale = { .bits = scale_bits[nearest + 8] };
    VmDoubleBits offset = { .bits = offset_bits[nearest + 8] };
    return offset.value + scale.value * sum;
}

double pl_vm_math_log2_positive(double x)
{
    VmDoubleBits word = { x };
    int exponent = (int)((word.bits >> 52u) & 0x7ffu);
    if (!exponent) {
        x *= 0x1p54;
        word.value = x;
        exponent = (int)((word.bits >> 52u) & 0x7ffu) - 54;
    }
    int integral = exponent - 1023;
    word.bits = (word.bits & 0x000fffffffffffffull)
              | 0x3ff0000000000000ull;
    double mantissa = word.value;
    if (mantissa > 1.41421356237309514547) {
        mantissa *= 0.5;
        ++integral;
    }
    double t = (mantissa - 1.0) / (mantissa + 1.0);
    double z = t * t;
    double p = 1.0 / 23.0;
    p = 1.0 / 21.0 + z * p;
    p = 1.0 / 19.0 + z * p;
    p = 1.0 / 17.0 + z * p;
    p = 1.0 / 15.0 + z * p;
    p = 1.0 / 13.0 + z * p;
    p = 1.0 / 11.0 + z * p;
    p = 1.0 / 9.0 + z * p;
    p = 1.0 / 7.0 + z * p;
    p = 1.0 / 5.0 + z * p;
    p = 1.0 / 3.0 + z * p;
    p = 1.0 + z * p;
    return (double)integral
         + (2.88539008177792681472 * t) * p;
}

double pl_vm_math_atan_positive(double x)
{
    static const double high[4] = {
        4.63647609000806093515e-01, 7.85398163397448278999e-01,
        9.82793723247329054082e-01, 1.57079632679489655800e+00,
    };
    static const double low[4] = {
        2.26987774529616870924e-17, 3.06161699786838301793e-17,
        1.39033110312309984516e-17, 6.12323399573676603587e-17,
    };
    static const double coefficient[11] = {
         3.33333333333329318027e-01, -1.99999999998764832476e-01,
         1.42857142725034663711e-01, -1.11111104054623557880e-01,
         9.09088713343650656196e-02, -7.69187620504482999495e-02,
         6.66107313738753120669e-02, -5.83357013379057348645e-02,
         4.97687799461593236017e-02, -3.65315727442169155270e-02,
         1.62858201153657823623e-02,
    };
    int interval = -1;
    if (x >= 0.4375) {
        if (x < 1.1875) {
            if (x < 0.6875) {
                interval = 0;
                x = (2.0 * x - 1.0) / (2.0 + x);
            } else {
                interval = 1;
                x = (x - 1.0) / (x + 1.0);
            }
        } else if (x < 2.4375) {
            interval = 2;
            x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
            interval = 3;
            x = -1.0 / x;
        }
    }
    double z = x * x;
    double w = z * z;
    double odd = z * (coefficient[0] + w * (coefficient[2]
               + w * (coefficient[4] + w * (coefficient[6]
               + w * (coefficient[8] + w * coefficient[10])))));
    double even = w * (coefficient[1] + w * (coefficient[3]
                + w * (coefficient[5] + w * (coefficient[7]
                + w * coefficient[9]))));
    if (interval < 0) return x - x * (odd + even);
    return high[interval] - (x * (odd + even) - low[interval] - x);
}
