// Translated code's floors, construct by construct: each timed alone, in nanoseconds a time (the best of three rounds),
// so the same program run natively and translated says what each costs where (floors.ts runs both).
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }
static volatile uint64_t sink;

__attribute__((noinline)) static uint64_t fib(int n) { return n < 2 ? (uint64_t)n : fib(n - 1) + fib(n - 2); }
__attribute__((noinline)) static uint64_t leaf(uint64_t x) { return x * 3 + 1; }
static void calls(int n) { uint64_t s = 0; for (int i = 0; i < n; i++) s += leaf(i); sink = s; }
static void fibs(int n) { for (int i = 0; i < n; i++) sink += fib(20); }
static void mallocs(int n) { for (int i = 0; i < n; i++) { char *p = malloc(16 + (i & 63)); p[0] = (char)i; sink += p[0]; free(p); } }
static void mallocs_held(int n) {
  static char *held[256];
  for (int i = 0; i < n; i++) { int k = i & 255; free(held[k]); held[k] = malloc(8 + (i * 7 & 127)); held[k][0] = 1; }
}
static void branches(int n) {
  // An interpreter's loop: a switch on bytes, as a shell's or awk's is.
  static const unsigned char prog[64] = {1, 2, 3, 4, 0, 5, 2, 1, 3, 3, 4, 6, 7, 1, 0, 2, 5, 5, 6, 7, 1, 2, 3, 4, 0, 1, 2, 3, 6, 6, 7, 0,
                                         2, 3, 1, 4, 5, 6, 7, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 0, 0, 1, 2, 3, 4, 5, 6, 7, 0};
  uint64_t a = 1, b = 2;
  for (int i = 0; i < n; i++) {
    switch (prog[i & 63]) {
    case 0: a += b; break;
    case 1: b ^= a; break;
    case 2: a = a * 3; break;
    case 3: b = b + 7; break;
    case 4: a -= b; break;
    case 5: if (a & 1) b++; else a++; break;
    case 6: a = (a << 1) | (a >> 63); break;
    default: b = ~b; break;
    }
  }
  sink = a + b;
}
static char text[4096];
static void strings(int n) { for (int i = 0; i < n; i++) { sink += strlen(text + (i & 15)); sink += (uintptr_t)memchr(text, 'z', sizeof text); } }
static void copies(int n) { static char d[256]; for (int i = 0; i < n; i++) { memcpy(d, text + (i & 31), 64 + (i & 127)); sink += d[5]; } }
static void cmps(int n) { for (int i = 0; i < n; i++) sink += strcmp(text, text + 2048) + memcmp(text, text + 1024, 100); }
static int cmp_int(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }
static void sorts(int n) { static int v[1000]; for (int r = 0; r < n; r++) { for (int i = 0; i < 1000; i++) v[i] = (i * 7919 + r) % 1000; qsort(v, 1000, sizeof *v, cmp_int); } sink += v[3]; }
__attribute__((noinline)) static uint64_t inc1(uint64_t x) { return x + 1; }
__attribute__((noinline)) static uint64_t inc2(uint64_t x) { return x + 2; }
static uint64_t (*volatile fns[2])(uint64_t) = {inc1, inc2};
static void indirect(int n) { uint64_t s = 0; for (int i = 0; i < n; i++) s = fns[i & 1](s); sink = s; }
#include <setjmp.h>
static jmp_buf jb;
__attribute__((noinline)) static void jump_back(int i) { if (i >= 0) longjmp(jb, 1); }
static void jumps(int n) { for (int i = 0; i < n; i++) { if (!setjmp(jb)) jump_back(i); } }
__attribute__((noinline)) static void no_jump(int i) { if (i < 0) longjmp(jb, 1); }
static void setjmps(int n) { for (int i = 0; i < n; i++) { if (!setjmp(jb)) no_jump(i); } }
static void doubles(int n) { double x = 1.0; for (int i = 0; i < n; i++) x = x * 1.0000001 + 0.5 / (i + 1); sink = (uint64_t)x; }
static void prints(int n) { char b[64]; for (int i = 0; i < n; i++) sink += snprintf(b, sizeof b, "%d %s %x", i, "ab", i); }
static void printf_double(int n) { char b[64]; for (int i = 0; i < n; i++) sink += snprintf(b, sizeof b, "%g", i * 0.5); }

struct m { const char *name; void (*f)(int); int n; };

int main(int argc, char **argv) {
  int only = argc > 1 ? atoi(argv[1]) : -1;
  memset(text, 'a', sizeof text - 1);
  struct m ms[] = {
    {"call a leaf", calls, 1000000}, {"fib(20)", fibs, 50}, {"malloc+free", mallocs, 200000}, {"malloc, free held", mallocs_held, 200000},
    {"switch dispatch", branches, 2000000}, {"strlen 4K + memchr 4K", strings, 20000}, {"memcpy 64-191 B", copies, 500000},
    {"strcmp 2K + memcmp 100", cmps, 50000}, {"qsort 1000 ints", sorts, 200}, {"double mul-add-div", doubles, 1000000}, {"indirect call", indirect, 1000000}, {"setjmp+longjmp", jumps, 100000}, {"setjmp alone", setjmps, 1000000},
    {"snprintf %d %s %x", prints, 100000}, {"snprintf %g", printf_double, 100000},
  };
  for (unsigned k = 0; k < sizeof ms / sizeof *ms; k++) {
    if (only >= 0 && (int)k != only) continue;
    double best = 1e30;
    for (int r = 0; r < 3; r++) { double t = now(); ms[k].f(ms[k].n); t = (now() - t) / ms[k].n; if (t < best) best = t; }
    printf("%-24s %12.1f ns\n", ms[k].name, best);
  }
  return 0;
}
