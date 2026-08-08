/* Three ways to execute the same artifact, on the same inputs.
 *
 *   3.1 hash  : memory in an open-addressing table   (what vm/wasm/vm.c ships)
 *   3.1 dense : memory in a flat array               (isolates the table)
 *   3.2 rows  : resident rows over a flat array      (the specification's)
 *
 * The third is the claim in 3.3/3.4: `old` and `change` are already
 * dereferenced, so a transition is `result = old + change` and the two
 * dependent loads disappear. What it pays is the wave (3.5).
 *
 * Two things this cannot show, and neither is a fault in the design.
 *
 * The wave is run serially. 3.7 gives it `work = Theta(k+1)` but
 * `fixed_width_time = Theta(ceil(k/W))` and `row_dependency_span = Theta(1)` —
 * it is a span claim, and one thread turns span into nothing. A serial runner
 * charges Theta(k) time for what the design says costs Theta(k/W).
 *
 * Residency is rebuilt per call rather than rolled back. 3.2 says a read keeps
 * rows speculative and a feed commits them; undoing the wave instead of
 * dropping it would let residency persist across calls, and this does not
 * implement that.
 *
 * What it does show is the part that needs no parallel machine: whether a row
 * is ever entered twice. A first arrival pays the full dereference inside
 * `materialize`, so at reuse 1.00x the resident row is 3.1 with bookkeeping on
 * top, and there is nothing for the cache to amortize.
 *
 *   clang -O2 -o bench vm/wasm/bench.c
 *   ./bench artifact.bin IN_BYTES OUT_BYTES NAME
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef int64_t i64;
typedef uint64_t u64;

/* ------------------------------------------------------------------ codec */
static const unsigned char *bits_base;
static u64 bits_len, bits_at;
static int bits_bad;

static unsigned bit_next(void)
{
    if (bits_at >= bits_len) { bits_bad = 1; return 0; }
    u64 i = bits_at++;
    return (bits_base[i >> 3] >> (7u - (unsigned)(i & 7u))) & 1u;
}

static u64 decode_scalar(void)
{
    if (bits_bad) return 0;
    if (!bit_next()) return 0;
    unsigned k = 0;
    for (;;) {
        if (bits_at >= bits_len) { bits_bad = 1; return 0; }
        if (bit_next()) break;
        if (++k > 63) { bits_bad = 1; return 0; }
    }
    if (bits_at + k > bits_len) { bits_bad = 1; return 0; }
    u64 v = 1;
    for (unsigned i = 0; i < k; ++i) v = (v << 1) | bit_next();
    return v;
}

static i64 unzigzag(u64 p) { return (p & 1u) ? -(i64)((p + 1u) >> 1) : (i64)(p >> 1); }

/* ------------------------------------------------------------------ image */
static i64 *mem;                 /* dense, indexed by coordinate */
static u64 extent;
static i64 pc_out, pc_feed;
static i64 *initial;

static int load(const unsigned char *blob, u64 nbytes)
{
    bits_base = blob; bits_len = nbytes * 8; bits_at = 0; bits_bad = 0;
    u64 payload = decode_scalar();
    if (bits_bad) return 0;
    u64 start = bits_at, end = start + payload;
    if (end > bits_len) return 0;
    bits_len = end; bits_at = start;

    u64 count = decode_scalar();
    pc_out = (i64)decode_scalar();
    pc_feed = (i64)decode_scalar();
    if (bits_bad) return 0;

    /* One pass to size, one to fill. */
    u64 save_at = bits_at;
    i64 address = -1, top = 0;
    for (u64 i = 0; i < count; ++i) {
        u64 gap = decode_scalar(); (void)decode_scalar();
        address += 1 + (i64)gap;
        if (address > top) top = address;
    }
    if (bits_bad) return 0;
    extent = (u64)top + 8;
    initial = calloc(extent, sizeof(i64));
    mem = malloc(extent * sizeof(i64));
    if (!initial || !mem) return 0;

    bits_at = save_at; address = -1;
    for (u64 i = 0; i < count; ++i) {
        u64 gap = decode_scalar(); u64 point = decode_scalar();
        address += 1 + (i64)gap;
        initial[address] = unzigzag(point);
    }
    return !bits_bad;
}

static void reset(void) { memcpy(mem, initial, extent * sizeof(i64)); }

/* ------------------------------------------------------- 3.1 over a table */
#define CAP_BITS 20
#define CAP (1u << CAP_BITS)
#define CAP_MASK (CAP - 1u)
static i64 *h_key, *h_val; static uint32_t *h_gen; static uint32_t h_generation = 1;

static uint32_t hash_slot(i64 a)
{
    u64 x = (u64)a * 0x9E3779B97F4A7C15ull;
    x ^= x >> 29; x *= 0xBF58476D1CE4E5B9ull; x ^= x >> 32;
    return (uint32_t)x & CAP_MASK;
}
static uint32_t find(i64 a)
{
    uint32_t i = hash_slot(a);
    for (uint32_t p = 0; p < CAP; ++p) {
        if (h_gen[i] != h_generation || h_key[i] == a) return i;
        i = (i + 1u) & CAP_MASK;
    }
    return CAP;
}
static i64 hget(i64 a)
{
    uint32_t i = find(a);
    return (i == CAP || h_gen[i] != h_generation) ? 0 : h_val[i];
}
static void hset(i64 a, i64 v)
{
    uint32_t i = find(a);
    if (i == CAP) return;
    if (h_gen[i] != h_generation) { h_gen[i] = h_generation; h_key[i] = a; }
    h_val[i] = v;
}
static void hreset(void)
{
    h_generation += 1;
    for (u64 i = 0; i < extent; ++i) if (initial[i]) hset((i64)i, initial[i]);
}

static u64 run_hash(i64 pc, i64 *event)
{
    u64 steps = 0;
    for (;;) {
        steps += 1;
        i64 a = hget(pc), b = hget(pc + 1), c = hget(pc + 2);
        if (a < 0 || b < 0) { *event = 0; return steps; }
        i64 v = hget(b) - hget(a);
        hset(b, v);
        if (v > 0) { pc += 3; continue; }
        if (c >= 0) { pc = c; continue; }
        *event = c; return steps;
    }
}

/* ------------------------------------------------------- 3.1 over an array */
static u64 run_dense(i64 pc, i64 *event)
{
    u64 steps = 0;
    for (;;) {
        steps += 1;
        i64 a = mem[pc], b = mem[pc + 1], c = mem[pc + 2];
        if (a < 0 || b < 0) { *event = 0; return steps; }
        i64 v = mem[b] - mem[a];          /* two dependent loads */
        mem[b] = v;
        if (v > 0) { pc += 3; continue; }
        if (c >= 0) { pc = c; continue; }
        *event = c; return steps;
    }
}

/* ------------------------------------------------ 3.2 rows over an array */
static i64 *r_src, *r_dst, *r_br, *r_old, *r_chg;
static unsigned char *r_live;
static int32_t *dst_head, *dst_next, *src_head, *src_next;
static u64 incidences;

static void rows_alloc(void)
{
    r_src = malloc(extent * sizeof(i64)); r_dst = malloc(extent * sizeof(i64));
    r_br = malloc(extent * sizeof(i64));  r_old = malloc(extent * sizeof(i64));
    r_chg = malloc(extent * sizeof(i64)); r_live = malloc(extent);
    dst_head = malloc(extent * sizeof(int32_t));
    src_head = malloc(extent * sizeof(int32_t));
    dst_next = malloc(extent * sizeof(int32_t));
    src_next = malloc(extent * sizeof(int32_t));
}

static void rows_reset(void)
{
    memset(r_live, 0, extent);
    for (u64 i = 0; i < extent; ++i) { dst_head[i] = -1; src_head[i] = -1; }
    incidences = 0;
}

static void materialize(i64 i)
{
    i64 s = mem[i], d = mem[i + 1];
    r_src[i] = s; r_dst[i] = d; r_br[i] = mem[i + 2];
    if (s >= 0 && d >= 0) {
        r_old[i] = mem[d];
        r_chg[i] = -mem[s];
        if (!r_live[i]) {                  /* index once; rebuilds keep it */
            dst_next[i] = dst_head[d]; dst_head[d] = (int32_t)i;
            src_next[i] = src_head[s]; src_head[s] = (int32_t)i;
        }
        r_live[i] = 1;
    } else {
        r_live[i] = 2;                     /* resident but invalid */
    }
}

static u64 run_rows(i64 pc, i64 *event)
{
    u64 steps = 0;
    for (;;) {
        steps += 1;
        if (!r_live[pc]) materialize(pc);
        if (r_live[pc] == 2) { *event = 0; return steps; }

        i64 old = r_old[pc];
        i64 chg = (r_src[pc] == r_dst[pc]) ? -old : r_chg[pc];
        i64 d = r_dst[pc], br = r_br[pc];
        i64 v = old + chg;                 /* the whole transition */

        if (chg) {
            mem[d] = v;
            /* (3.5): one independent single-slot add per incidence. */
            for (int32_t j = dst_head[d]; j >= 0; j = dst_next[j]) {
                if (j == d || j == d - 1 || j == d - 2) continue;
                r_old[j] += chg; incidences += 1;
            }
            for (int32_t j = src_head[d]; j >= 0; j = src_next[j]) {
                if (j == d || j == d - 1 || j == d - 2) continue;
                if (r_dst[j] == d) continue;
                r_chg[j] -= chg; incidences += 1;
            }
            for (i64 off = 0; off < 3; ++off) {
                i64 at = d - off;
                if (at >= 0 && (u64)at < extent && r_live[at]) materialize(at);
            }
        }
        if (v > 0) { pc += 3; continue; }
        if (br >= 0) { pc = br; continue; }
        *event = br; return steps;
    }
}

/* ------------------------------------------------------------------ drive */
static double now(void)
{
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec * 1e-9;
}

typedef u64 (*runner)(i64, i64 *);

static u64 whole(runner go, void (*prep)(void), int in_bytes, int out_bytes,
                 u64 value)
{
    u64 steps = 0; i64 ev;
    prep();
    if (go == run_rows) rows_reset();
    for (int i = 0; i < in_bytes; ++i) {
        i64 byte = (i64)((value >> (8 * i)) & 255u);
        if (go == run_hash) hset(0, byte); else mem[0] = byte;
        if (go == run_rows) { rows_reset(); materialize(0); }
        steps += go(pc_feed, &ev);
    }
    for (int k = 0; k < out_bytes; ++k) {
        if (go == run_rows) rows_reset();
        steps += go(pc_out, &ev);
        if (k + 1 < out_bytes) {
            if (go == run_hash) hset(0, 0); else mem[0] = 0;
            if (go == run_rows) rows_reset();
            steps += go(pc_feed, &ev);
        }
    }
    return steps;
}

int main(int argc, char **argv)
{
    if (argc < 5) { fprintf(stderr, "usage: three FILE IN OUT NAME\n"); return 2; }
    FILE *f = fopen(argv[1], "rb");
    if (!f) { perror("open"); return 2; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *blob = malloc((size_t)n);
    if (fread(blob, 1, (size_t)n, f) != (size_t)n) return 2;
    fclose(f);
    if (!load(blob, (u64)n)) { fprintf(stderr, "did not open\n"); return 2; }

    int in_bytes = atoi(argv[2]), out_bytes = atoi(argv[3]);
    u64 value = (in_bytes >= 8) ? ~0ull : ((1ull << (8 * in_bytes)) - 1);

    h_key = malloc(CAP * sizeof(i64)); h_val = malloc(CAP * sizeof(i64));
    h_gen = calloc(CAP, sizeof(uint32_t));
    rows_alloc();

    struct { const char *name; runner go; void (*prep)(void); } cases[] = {
        { "3.1 hash ", run_hash,  hreset },
        { "3.1 dense", run_dense, reset  },
        { "3.2 rows ", run_rows,  reset  },
    };

    printf("%-18s", argv[4]);
    u64 first_steps = 0;
    for (int c = 0; c < 3; ++c) {
        u64 steps = whole(cases[c].go, cases[c].prep, in_bytes, out_bytes, value);
        if (!c) first_steps = steps;
        else if (steps != first_steps) printf("  STEPS DIFFER(%llu)", (unsigned long long)steps);
        int reps = 20;
        double t0 = now();
        for (int i = 0; i < reps; ++i)
            whole(cases[c].go, cases[c].prep, in_bytes, out_bytes, value);
        double us = (now() - t0) * 1e6 / reps;
        printf("  %s %8.1f us  %6.1f ns/step", cases[c].name, us,
               us * 1000.0 / (double)steps);
    }
    printf("   steps=%llu\n", (unsigned long long)first_steps);
    return 0;
}
