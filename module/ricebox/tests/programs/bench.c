// Deterministic integer workloads. Each prints a checksum so the translated
// program can be compared with native output byte for byte.
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }
static double mark;
#define TIMED(name, fmt, expr) do { mark = now(); printf("%-8s " fmt "\n", name, expr); fprintf(stderr, "%-8s %.3f\n", name, now() - mark); } while (0)

static uint64_t sieve(int n) {
    char *composite = calloc(n + 1, 1);
    uint64_t sum = 0;
    for (int i = 2; i <= n; i++) {
        if (composite[i]) continue;
        sum += i;
        for (long j = (long)i * i; j <= n; j += i) composite[j] = 1;
    }
    free(composite);
    return sum;
}

static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static uint64_t mix(int rounds) {
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    for (int r = 0; r < rounds; r++) {
        uint32_t a = h[0], e = h[4];
        uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        uint32_t ch = (e & h[5]) ^ (~e & h[6]);
        uint32_t t1 = h[7] + s1 + ch + (uint32_t)r * 0x428a2f98u;
        uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        uint32_t maj = (a & h[1]) ^ (a & h[2]) ^ (h[1] & h[2]);
        memmove(h + 1, h, 7 * sizeof h[0]);
        h[4] += t1;
        h[0] = t1 + s0 + maj;
    }
    uint64_t out = 0;
    for (int i = 0; i < 8; i++) out = out * 31 + h[i];
    return out;
}

static int compare(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return x < y ? -1 : x > y;
}

static uint64_t sorting(int n) {
    uint64_t *v = malloc(n * sizeof *v), x = 88172645463325252ull, sum = 0;
    for (int i = 0; i < n; i++) { x ^= x << 13; x ^= x >> 7; x ^= x << 17; v[i] = x; }
    qsort(v, n, sizeof *v, compare);
    for (int i = 0; i < n; i += n / 64) sum = sum * 1000003 + v[i];
    free(v);
    return sum;
}

static long fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

static int opcode(int op, int a, int b) {
    switch (op) {
    case 0: return a + b; case 1: return a - b; case 2: return a * b; case 3: return b ? a / b : 0;
    case 4: return a & b; case 5: return a | b; case 6: return a ^ b; case 7: return a << (b & 7);
    case 8: return a >> (b & 7); case 9: return a % (b | 1); default: return a;
    }
}

static int64_t interpret(int steps) {
    int64_t acc = 1;
    for (int i = 0; i < steps; i++) acc = (acc * 7 + opcode(i % 11, (int)acc, i)) & 0xffffff;
    return acc;
}

static uint64_t wide(int n) {
    unsigned __int128 acc = 1;
    uint64_t q = 0;
    for (int i = 1; i < n; i++) {
        acc = acc * 6364136223846793005u + i;
        q += (uint64_t)(acc >> 64) / (uint64_t)(i | 1) + (uint64_t)acc % 1000003u;
        q ^= (uint64_t)((int64_t)q / -7);
    }
    return q;
}

static uint64_t strings(int n) {
    char buf[256], dst[256];
    uint64_t sum = 0;
    for (int i = 0; i < n; i++) {
        int len = snprintf(buf, sizeof buf, "line %d of %d: %x", i, n, i * 2654435761u);
        memcpy(dst, buf, len + 1);
        sum += strlen(dst) + (uint8_t)dst[len / 2] + (strchr(dst, ':') - dst);
        memset(buf, i & 0xff, sizeof buf);
        sum += (uint8_t)buf[17];
    }
    return sum;
}

static jmp_buf escape;
static int deep(int n) { if (n == 0) longjmp(escape, 42); return deep(n - 1) + 1; }

static uint64_t heap(int n) {
    void *slots[256] = {0};
    uint64_t sum = 0, x = 12345;
    for (int i = 0; i < n; i++) {
        x = x * 6364136223846793005ull + 1442695040888963407ull;
        int k = (x >> 33) & 255;
        if (slots[k]) { sum += ((uint8_t *)slots[k])[0]; free(slots[k]); }
        size_t size = 16 + ((x >> 20) & 4095);
        slots[k] = malloc(size);
        memset(slots[k], (int)(x >> 50), size);
    }
    for (int k = 0; k < 256; k++) free(slots[k]);
    return sum;
}

int main(int argc, char **argv) {
    int scale = argc > 1 ? atoi(argv[1]) : 1;
    TIMED("sieve", "%llu", (unsigned long long)sieve(2000000 * scale));
    TIMED("mix", "%llu", (unsigned long long)mix(20000000 * scale));
    TIMED("sort", "%llu", (unsigned long long)sorting(400000 * scale));
    TIMED("fib", "%ld", fib(30 + (scale > 1)));
    TIMED("switch", "%lld", (long long)interpret(20000000 * scale));
    TIMED("wide", "%llu", (unsigned long long)wide(5000000 * scale));
    TIMED("strings", "%llu", (unsigned long long)strings(300000 * scale));
    TIMED("heap", "%llu", (unsigned long long)heap(1000000 * scale));
    int r = setjmp(escape);
    if (!r) deep(1000);
    printf("longjmp  %d\n", r);
    return 0;
}
