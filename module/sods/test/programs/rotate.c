// Rotates through the carry (rcl, rcr) at every width, by 1 (Go's division by a constant makes `rcr $1`) and by
// larger counts, the carry going in set and clear: each result printed with the CF it leaves, and OF where a count
// of 1 defines it.
#include <stdio.h>
#include <stdint.h>

#define ROT(name, insn, type, reg, count)                                                         \
  __attribute__((noinline)) static void name(type x, int cf, type *out, unsigned char *c, unsigned char *o) { \
    unsigned char cc, oo;                                                                         \
    __asm__ volatile("bt $0, %k[cf]\n\t" insn " $" #count ", %" reg "[x]\n\tsetc %[c]\n\tseto %[o]"  \
                     : [x] "+r"(x), [c] "=r"(cc), [o] "=r"(oo) : [cf] "r"(cf) : "cc");              \
    *out = x; *c = cc; *o = oo;                                                                   \
  }

ROT(rcr64_1, "rcrq", uint64_t, "q", 1)
ROT(rcl64_1, "rclq", uint64_t, "q", 1)
ROT(rcr64_5, "rcrq", uint64_t, "q", 5)
ROT(rcl64_63, "rclq", uint64_t, "q", 63)
ROT(rcr32_1, "rcrl", uint32_t, "k", 1)
ROT(rcl32_7, "rcll", uint32_t, "k", 7)
ROT(rcr32_31, "rcrl", uint32_t, "k", 31)
ROT(rcr16_1, "rcrw", uint16_t, "w", 1)
ROT(rcl16_16, "rclw", uint16_t, "w", 16)
ROT(rcr8_1, "rcrb", uint8_t, "b", 1)
ROT(rcl8_8, "rclb", uint8_t, "b", 8)
ROT(rcr8_9, "rcrb", uint8_t, "b", 9)

#define SHOW(name, type, of)                                                                      \
  for (int k = 0; k < 4; k++)                                                                     \
    for (int cf = 0; cf < 2; cf++) {                                                              \
      type r; unsigned char c, o;                                                                 \
      name((type)v[k], cf, &r, &c, &o);                                                           \
      printf("%s %d %llx cf=%d", #name, cf, (unsigned long long)r, c);                            \
      if (of) printf(" of=%d", o);                                                                \
      printf("\n");                                                                               \
    }

int main(int argc, char **argv) {
  (void)argv;
  // Values that put the top and bottom bits, and the bits beside them, both ways; one taken from the run.
  uint64_t v[4] = {0x8000000000000001ULL, 0x7ffffffffffffffeULL, 0xc3a5f00f12345678ULL, (uint64_t)argc * 0x9e3779b97f4a7c15ULL};
  SHOW(rcr64_1, uint64_t, 1)
  SHOW(rcl64_1, uint64_t, 1)
  SHOW(rcr64_5, uint64_t, 0)
  SHOW(rcl64_63, uint64_t, 0)
  SHOW(rcr32_1, uint32_t, 1)
  SHOW(rcl32_7, uint32_t, 0)
  SHOW(rcr32_31, uint32_t, 0)
  SHOW(rcr16_1, uint16_t, 1)
  SHOW(rcl16_16, uint16_t, 0)
  SHOW(rcr8_1, uint8_t, 1)
  SHOW(rcl8_8, uint8_t, 0)
  SHOW(rcr8_9, uint8_t, 0)
  // Division by a constant, as a compiler makes it (a multiply's high half, shifted).
  uint64_t q = 0;
  for (uint64_t x = argc; x < 2000000; x += 9973) q += x / 7;
  printf("q %llu\n", (unsigned long long)q);
  return 0;
}
