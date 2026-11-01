// xlat: stripped
// Switches that jump through tables, and functions passed as pointers, in a program that keeps no symbols and no
// relocations (as a distribution ships it): translated whole (whole.test.mjs), all of it is found ahead of time.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// A switch of its own: its table read where it is.
__attribute__((noinline)) static int weigh(int c) {
  switch (c) {
    case 0: return 7;
    case 1: return 3;
    case 2: return 11;
    case 3: return 5;
    case 4: return 2;
    case 5: return 13;
    case 6: return 17;
    case 7: return 1;
    case 8: return 19;
    case 9: return 23;
    default: return -1;
  }
}

// A switch in a loop: its table's address taken once, before the loop.
__attribute__((noinline)) static long run(const unsigned char *code, size_t n) {
  long acc = 0, x = 1;
  for (size_t i = 0; i < n; i++) {
    switch (code[i] % 12) {
      case 0: acc += x; break;
      case 1: acc -= x; break;
      case 2: x *= 3; break;
      case 3: x += 7; break;
      case 4: acc ^= x; break;
      case 5: x = x % 1000 + 1; break;
      case 6: acc = acc * 2 + 1; break;
      case 7: acc >>= 1; break;
      case 8: x -= 2; break;
      case 9: acc += weigh((int)(x % 10)); break;
      case 10: acc |= 0x10; break;
      case 11: x ^= acc & 0xff; break;
    }
  }
  return acc ^ x;
}

// Passed by address (a callback), never called directly.
static int ascending(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }
static int descending(const void *a, const void *b) { return *(const int *)b - *(const int *)a; }

int main(int argc, char **argv) {
  unsigned char code[256];
  for (int i = 0; i < 256; i++) code[i] = (unsigned char)(i * 37 + argc);
  printf("run %ld\n", run(code, sizeof code));
  int sum = 0;
  for (int c = -1; c < 12; c++) sum = sum * 31 + weigh(c);
  printf("weigh %d\n", sum);
  int v[16];
  for (int i = 0; i < 16; i++) v[i] = (i * 7919) % 101;
  qsort(v, 16, sizeof *v, argc > 1 ? descending : ascending);
  for (int i = 0; i < 16; i++) printf("%d ", v[i]);
  printf("\n%s\n", argv[0][0] ? "end" : "");
  return 0;
}
