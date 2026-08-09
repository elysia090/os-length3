/* Three ways to execute the same artifact, on the same inputs.
 *
 *   hash      : historical open-addressing memory
 *   dense     : the released flat-array memory
 *   rows      : resident source/destination incidences over a flat array
 *
 * The third is the claim in 3.3/3.4: `old` and `change` are already
 * dereferenced, so a transition is `result = old + change` and the two
 * dependent loads disappear. What it pays is the incidence-update wave.
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

#include "../../../../corpus/physical-array/pa_grouped_spans.h"

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

/* --------------------------------------- resident rows over an array
 *
 * Entries are grouped by written coordinate, with each sign in one contiguous
 * span. That is the design, and it is
 * what makes `fixed_width_time = Theta(ceil(k/W))` mean anything: the wave
 * becomes two straight loops over contiguous i64, with no row id, no hit bit,
 * no tag and no order among lanes. Chasing a linked list per incidence — which
 * is what this file did first — is the one shape that cannot vectorize, and it
 * turned a span claim into a work claim.
 *
 * So the components live in the wave's order rather than beside their rows:
 *
 *     old_store   grouped by destination, row i's slot at old_at[i]
 *     chg_store   grouped by source,      row i's slot at chg_at[i]
 *
 * Special rows d, d-1, d-2 are not skipped inside the loop; a branch there
 * would undo the point. They sit in their spans, get updated with everything
 * else, and the coordinator rebuilds them from memory straight after, which
 * overwrites whatever the wave did. The rebuild follows the wave for exactly
 * this reason.
 */
static i64 *r_src, *r_dst, *r_br;
static i64 *old_store, *chg_store;
static int32_t *old_off, *chg_off, *old_at, *chg_at;
static int32_t *old_cursor, *chg_cursor;
static unsigned char *r_row;
static u64 incidences;

static void rows_alloc(void)
{
    r_src = malloc(extent * sizeof(i64)); r_dst = malloc(extent * sizeof(i64));
    r_br  = malloc(extent * sizeof(i64)); r_row = malloc(extent);
    old_off = malloc((extent + 2) * sizeof(int32_t));
    chg_off = malloc((extent + 2) * sizeof(int32_t));
    old_at = malloc(extent * sizeof(int32_t));
    chg_at = malloc(extent * sizeof(int32_t));
    old_cursor = malloc(extent * sizeof(int32_t));
    chg_cursor = malloc(extent * sizeof(int32_t));
    old_store = malloc((extent + 1) * sizeof(i64));
    chg_store = malloc((extent + 1) * sizeof(i64));
}

/* Which row sits in which span is a function of the image, and the image does
 * not move unless the program modifies itself. So this runs once per call
 * rather than being rebuilt per transition, and the wave keeps the values in
 * step from there. */
static void rows_build(void)
{
    memset(r_row, 0, extent);
    incidences = 0;

    for (u64 i = 0; i + 2 < extent; ++i) {
        i64 s = mem[i], d = mem[i + 1];
        if (s < 0 || d < 0 || (u64)s >= extent || (u64)d >= extent) continue;
        r_row[i] = 1;
        r_src[i] = s;
        r_dst[i] = d;
        r_br[i] = mem[i + 2];
    }
    if (!pa_grouped_spans_i64(extent, extent, r_dst, r_row,
                              old_off, old_at, old_cursor) ||
        !pa_grouped_spans_i64(extent, extent, r_src, r_row,
                              chg_off, chg_at, chg_cursor)) {
        fprintf(stderr, "row coordinate is outside the dense image\n");
        abort();
    }
    for (u64 i = 0; i + 2 < extent; ++i) {
        if (!r_row[i]) continue;
        old_store[old_at[i]] = mem[r_dst[i]];
        chg_store[chg_at[i]] = -mem[r_src[i]];
    }
}

static void rebuild(i64 i)
{
    if (i < 0 || (u64)i + 2 >= extent || !r_row[i]) return;
    r_br[i] = mem[i + 2];
    old_store[old_at[i]] = mem[r_dst[i]];
    chg_store[chg_at[i]] = -mem[r_src[i]];
}

/* The wave for one write, with successor selection left to the caller. */
static void wave(i64 d, i64 result, i64 chg)
{
    if (!chg) return;
    mem[d] = result;
    int32_t lo = old_off[d], hi = old_off[d + 1];
    for (int32_t p = lo; p < hi; ++p) old_store[p] += chg;
    int32_t clo = chg_off[d], chi = chg_off[d + 1];
    for (int32_t p = clo; p < chi; ++p) chg_store[p] -= chg;
    incidences += (u64)(hi - lo) + (u64)(chi - clo);
    for (i64 off = 0; off < 3; ++off) rebuild(d - off);
}

/* The initial feed write uses the same wave as every other write, with
 * destination zero and change equal to input minus the old input cell.
 * Storing the byte straight into `mem[0]` instead skips that wave, so every
 * row reading coordinate zero keeps a stale
 * component and the two machine forms take different paths. The step-count
 * check catches that divergence. */
static void feed_write(i64 input)
{
    wave(0, input, input - mem[0]);
}

static u64 run_rows(i64 pc, i64 *event)
{
    u64 steps = 0;
    for (;;) {
        steps += 1;
        if (!r_row[pc]) { *event = 0; return steps; }

        i64 old = old_store[old_at[pc]];
        i64 chg = (r_src[pc] == r_dst[pc]) ? -old : chg_store[chg_at[pc]];
        i64 d = r_dst[pc], br = r_br[pc];
        i64 v = old + chg;                 /* the whole transition */

        wave(d, v, chg);
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

/* Feed the input, then read once.
 *
 * A read commits nothing, so it goes last and there is nothing to roll back.
 * Reading eight times with feeds between them would need speculative rows
 * with transactional rollback, and getting that half-right is how this file
 * previously came to disagree with itself about the step count. Same call the
 * Python `rows.measure` counts, so the two sides are comparable. */
static u64 whole(runner go, void (*prep)(void), int in_bytes, u64 value)
{
    u64 steps = 0; i64 ev;
    prep();
    if (go == run_rows) rows_build();
    for (int i = 0; i < in_bytes; ++i) {
        i64 byte = (i64)((value >> (8 * i)) & 255u);
        if (go == run_hash) hset(0, byte);
        else if (go == run_rows) feed_write(byte);
        else mem[0] = byte;
        steps += go(pc_feed, &ev);
    }
    steps += go(pc_out, &ev);
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

    int in_bytes = atoi(argv[2]); (void)atoi(argv[3]);
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
        u64 steps = whole(cases[c].go, cases[c].prep, in_bytes, value);
        if (!c) first_steps = steps;
        else if (steps != first_steps) printf("  STEPS DIFFER(%llu)", (unsigned long long)steps);
        int reps = 20;
        double t0 = now();
        for (int i = 0; i < reps; ++i)
            whole(cases[c].go, cases[c].prep, in_bytes, value);
        double us = (now() - t0) * 1e6 / reps;
        printf("  %s %8.1f us  %6.1f ns/step", cases[c].name, us,
               us * 1000.0 / (double)steps);
    }
    printf("   steps=%llu\n", (unsigned long long)first_steps);
    return 0;
}
