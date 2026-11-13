// What an instruction leaves in the flags and in its operands where a translation can lose it: the overflow flag a
// rotate or a double shift by 1 defines, the flags a count of 0 leaves alone, the parity a double shift makes, the
// sign and parity popcnt clears, and xadd's two results when its memory is addressed by the register it changes.
// Only flags the processor defines are printed.
#include <stdint.h>
#include <stdio.h>

// ---- rol, ror: CF whenever the count is not 0, OF for a count of 1, neither changed by a count of 0 ----

// Before each: CF and OF set (0x80 + 0x80 in a byte carries and overflows), so a flag left alone reads 1.
#define SET_CF_OF "movb $0x80, %%r8b\n\taddb %%r8b, %%r8b\n\t"
#define ROTATE(name, insn, type, reg)                                                                            \
  __attribute__((noinline)) static void name(type x, unsigned char n, int by_cl, type *out, int *cf, int *of) { \
    unsigned char c, o;                                                                                          \
    if (by_cl) __asm__ volatile(SET_CF_OF insn " %%cl, %" reg "[x]\n\tsetc %[c]\n\tseto %[o]"                    \
                                : [x] "+r"(x), [c] "=&q"(c), [o] "=&q"(o) : "c"(n) : "cc", "r8");                \
    else __asm__ volatile(SET_CF_OF insn " $1, %" reg "[x]\n\tsetc %[c]\n\tseto %[o]"                            \
                          : [x] "+r"(x), [c] "=&q"(c), [o] "=&q"(o) : : "cc", "r8");                             \
    *out = x; *cf = c; *of = o;                                                                                  \
  }
ROTATE(rol8, "rolb", uint8_t, "b") ROTATE(ror8, "rorb", uint8_t, "b")
ROTATE(rol16, "rolw", uint16_t, "w") ROTATE(ror16, "rorw", uint16_t, "w")
ROTATE(rol32, "roll", uint32_t, "k") ROTATE(ror32, "rorl", uint32_t, "k")
ROTATE(rol64, "rolq", uint64_t, "q") ROTATE(ror64, "rorq", uint64_t, "q")

#define ROTATED(name, type, bits)                                                                 \
  for (int k = 0; k < 4; k++) {                                                                   \
    type r; int cf, of;                                                                           \
    name((type)v[k], 0, 0, &r, &cf, &of);                                                         \
    printf("%s $1 %llx cf=%d of=%d\n", #name, (unsigned long long)r, cf, of);                     \
    name((type)v[k], 1, 1, &r, &cf, &of);                                                         \
    printf("%s cl=1 %llx cf=%d of=%d\n", #name, (unsigned long long)r, cf, of);                   \
    name((type)v[k], 0, 1, &r, &cf, &of);                                                         \
    printf("%s cl=0 %llx cf=%d of=%d\n", #name, (unsigned long long)r, cf, of);                   \
    name((type)v[k], 5, 1, &r, &cf, &of);                                                         \
    printf("%s cl=5 %llx cf=%d\n", #name, (unsigned long long)r, cf);                             \
    /* A count that is the operand's width (not 0 once masked, at 8 and 16 bits): the value as it was, CF changed. */ \
    name((type)v[k], bits, 1, &r, &cf, &of);                                                      \
    if (bits < 32) printf("%s cl=%d %llx cf=%d\n", #name, bits, (unsigned long long)r, cf);       \
  }

// ---- shld, shrd: CF, ZF, SF and PF by the result, OF for a count of 1, nothing changed by a count of 0 ----

#define DOUBLE(name, insn, type, reg)                                                                            \
  __attribute__((noinline)) static void name(type x, type y, unsigned char n, int how, type *out, int *f) {     \
    unsigned char c, o, z, s, p;                                                                                 \
    if (how == 0) __asm__ volatile(SET_CF_OF insn " $1, %" reg "[y], %" reg "[x]\n\tsetc %[c]\n\tseto %[o]\n\tsetz %[z]\n\tsets %[s]\n\tsetp %[p]" \
        : [x] "+r"(x), [c] "=&q"(c), [o] "=&q"(o), [z] "=&q"(z), [s] "=&q"(s), [p] "=&q"(p) : [y] "r"(y) : "cc", "r8"); \
    else if (how == 1) __asm__ volatile(SET_CF_OF insn " $4, %" reg "[y], %" reg "[x]\n\tsetc %[c]\n\tseto %[o]\n\tsetz %[z]\n\tsets %[s]\n\tsetp %[p]" \
        : [x] "+r"(x), [c] "=&q"(c), [o] "=&q"(o), [z] "=&q"(z), [s] "=&q"(s), [p] "=&q"(p) : [y] "r"(y) : "cc", "r8"); \
    else __asm__ volatile(SET_CF_OF insn " %%cl, %" reg "[y], %" reg "[x]\n\tsetc %[c]\n\tseto %[o]\n\tsetz %[z]\n\tsets %[s]\n\tsetp %[p]" \
        : [x] "+r"(x), [c] "=&q"(c), [o] "=&q"(o), [z] "=&q"(z), [s] "=&q"(s), [p] "=&q"(p) : [y] "r"(y), "c"(n) : "cc", "r8"); \
    *out = x; f[0] = c; f[1] = o; f[2] = z; f[3] = s; f[4] = p;                                                   \
  }
DOUBLE(shld16, "shldw", uint16_t, "w") DOUBLE(shrd16, "shrdw", uint16_t, "w")
DOUBLE(shld32, "shldl", uint32_t, "k") DOUBLE(shrd32, "shrdl", uint32_t, "k")
DOUBLE(shld64, "shldq", uint64_t, "q") DOUBLE(shrd64, "shrdq", uint64_t, "q")

#define DOUBLED(name, type)                                                                       \
  for (int k = 0; k < 4; k++) {                                                                   \
    type r; int f[5];                                                                             \
    name((type)v[k], (type)v[(k + 1) % 4], 0, 0, &r, f);                                          \
    printf("%s $1 %llx cf=%d of=%d zf=%d sf=%d pf=%d\n", #name, (unsigned long long)r, f[0], f[1], f[2], f[3], f[4]); \
    name((type)v[k], (type)v[(k + 1) % 4], 0, 1, &r, f);                                          \
    printf("%s $4 %llx cf=%d zf=%d sf=%d pf=%d\n", #name, (unsigned long long)r, f[0], f[2], f[3], f[4]); \
    name((type)v[k], (type)v[(k + 1) % 4], 1, 2, &r, f);                                          \
    printf("%s cl=1 %llx cf=%d of=%d zf=%d sf=%d pf=%d\n", #name, (unsigned long long)r, f[0], f[1], f[2], f[3], f[4]); \
    name((type)v[k], (type)v[(k + 1) % 4], 0, 2, &r, f);                                          \
    printf("%s cl=0 %llx cf=%d of=%d zf=%d sf=%d pf=%d\n", #name, (unsigned long long)r, f[0], f[1], f[2], f[3], f[4]); \
  }

// A double shift straight after an add whose flags are still wanted: the sum's flags are made before the shift's
// result is, not over it.
__attribute__((noinline)) static uint64_t after_add(uint64_t x, uint64_t y, uint64_t z, int *zf) {
  unsigned char q;
  __asm__ volatile("addq %[y], %[x]\n\tshldq $4, %[z], %[x]\n\tsetz %[q]" : [x] "+r"(x), [q] "=&q"(q) : [y] "r"(y), [z] "r"(z) : "cc");
  *zf = q;
  return x;
}

// ---- popcnt: ZF by its source, every other flag clear, whatever they were ----

#define COUNT(name, insn, type, reg)                                                                             \
  __attribute__((noinline)) static void name(type before, type x, type *out, int *f) {                           \
    unsigned char keep, c, o, z, s, p; type r;                                                                   \
    /* The flags before are read too (sets), so what made them is not dropped as unread. */                      \
    __asm__ volatile("test %" reg "[b], %" reg "[b]\n\tsets %[k]\n\t" insn " %" reg "[x], %" reg "[r]\n\tsetc %[c]\n\tseto %[o]\n\tsetz %[z]\n\tsets %[s]\n\tsetp %[p]" \
        : [r] "=&r"(r), [k] "=&q"(keep), [c] "=&q"(c), [o] "=&q"(o), [z] "=&q"(z), [s] "=&q"(s), [p] "=&q"(p) : [b] "r"(before), [x] "r"(x) : "cc"); \
    *out = r; f[0] = c; f[1] = o; f[2] = z; f[3] = s; f[4] = p; f[5] = keep;                                      \
  }
COUNT(popcnt16, "popcntw", uint16_t, "w") COUNT(popcnt32, "popcntl", uint32_t, "k") COUNT(popcnt64, "popcntq", uint64_t, "q")

// The same with nothing reading the flags before: what made them may be dropped, and popcnt's are still its own.
__attribute__((noinline)) static void popcnt_unread(uint64_t before, uint64_t x, uint64_t *out, int *f) {
  unsigned char c, o, z, s, p; uint64_t r;
  __asm__ volatile("testq %[b], %[b]\n\tpopcntq %[x], %[r]\n\tsetc %[c]\n\tseto %[o]\n\tsetz %[z]\n\tsets %[s]\n\tsetp %[p]"
      : [r] "=&r"(r), [c] "=&q"(c), [o] "=&q"(o), [z] "=&q"(z), [s] "=&q"(s), [p] "=&q"(p) : [b] "r"(before), [x] "r"(x) : "cc");
  *out = r; f[0] = c; f[1] = o; f[2] = z; f[3] = s; f[4] = p;
}

#define COUNTED(name, type)                                                                       \
  for (int b = 0; b < 2; b++)                                                                     \
    for (int k = 0; k < 5; k++) {                                                                 \
      type r; int f[6];                                                                           \
      /* Before: sign and parity both set (all ones), or both clear (1). */                       \
      name(b ? (type)-1 : (type)1, k < 4 ? (type)v[k] : 0, &r, f);                                \
      printf("%s after sf=%d: %llu cf=%d of=%d zf=%d sf=%d pf=%d\n", #name, f[5], (unsigned long long)r, f[0], f[1], f[2], f[3], f[4]); \
    }

// ---- xadd: the source takes what the destination held, the destination the sum ----

#define XADD(name, insn, type, reg)                                                                              \
  __attribute__((noinline)) static void name(type *d, type *s, int *cf, int *of) {                               \
    type x = *d, y = *s; unsigned char c, o;                                                                     \
    __asm__ volatile(insn " %" reg "[y], %" reg "[x]\n\tsetc %[c]\n\tseto %[o]" : [x] "+r"(x), [y] "+r"(y), [c] "=&q"(c), [o] "=&q"(o) : : "cc"); \
    *d = x; *s = y; *cf = c; *of = o;                                                                            \
  }                                                                                                              \
  __attribute__((noinline)) static void name##_mem(type *d, type *s, int *cf, int *of) {                         \
    type y = *s; unsigned char c, o;                                                                             \
    __asm__ volatile(insn " %" reg "[y], %[m]\n\tsetc %[c]\n\tseto %[o]" : [m] "+m"(*d), [y] "+r"(y), [c] "=&q"(c), [o] "=&q"(o) : : "cc"); \
    *s = y; *cf = c; *of = o;                                                                                    \
  }                                                                                                              \
  __attribute__((noinline)) static type name##_self(type x, int *cf, int *of) {                                  \
    unsigned char c, o;                                                                                          \
    __asm__ volatile(insn " %" reg "[x], %" reg "[x]\n\tsetc %[c]\n\tseto %[o]" : [x] "+r"(x), [c] "=&q"(c), [o] "=&q"(o) : : "cc"); \
    *cf = c; *of = o;                                                                                            \
    return x;                                                                                                    \
  }
XADD(xadd8, "xaddb", uint8_t, "b") XADD(xadd16, "xaddw", uint16_t, "w") XADD(xadd32, "xaddl", uint32_t, "k") XADD(xadd64, "xaddq", uint64_t, "q")

#define XADDED(name, type)                                                                        \
  for (int k = 0; k < 4; k++) {                                                                   \
    type d = (type)v[k], s = (type)v[(k + 1) % 4]; int cf, of;                                    \
    name(&d, &s, &cf, &of);                                                                       \
    printf("%s %llx %llx cf=%d of=%d\n", #name, (unsigned long long)d, (unsigned long long)s, cf, of); \
    d = (type)v[k]; s = (type)v[(k + 2) % 4];                                                     \
    name##_mem(&d, &s, &cf, &of);                                                                 \
    printf("%s_mem %llx %llx cf=%d of=%d\n", #name, (unsigned long long)d, (unsigned long long)s, cf, of); \
    d = name##_self((type)v[k], &cf, &of);                                                        \
    printf("%s_self %llx cf=%d of=%d\n", #name, (unsigned long long)d, cf, of);                   \
  }

// The memory xadd writes is where its registers pointed before either changed.
static uint64_t cell[4], beside[4];
static void aliased(void) {
  // The source register is the destination's address.
  uint64_t a = (uint64_t)&cell[0];
  cell[0] = (uint64_t)&beside[0]; beside[0] = 7;
  __asm__ volatile("xaddq %%rax, (%%rax)" : "+a"(a) : : "cc", "memory");
  printf("xadd through its source: the register %s, its cell %s, the cell beside %llu\n",
         a == (uint64_t)&beside[0] ? "took what was there" : "wrong",
         cell[0] == (uint64_t)&beside[0] + (uint64_t)&cell[0] ? "holds the sum" : "wrong", (unsigned long long)beside[0]);
  // The same, locked.
  a = (uint64_t)&cell[1];
  cell[1] = (uint64_t)&beside[1]; beside[1] = 9;
  __asm__ volatile("lock xaddq %%rax, (%%rax)" : "+a"(a) : : "cc", "memory");
  printf("lock xadd through its source: the register %s, its cell %s, the cell beside %llu\n",
         a == (uint64_t)&beside[1] ? "took what was there" : "wrong",
         cell[1] == (uint64_t)&beside[1] + (uint64_t)&cell[1] ? "holds the sum" : "wrong", (unsigned long long)beside[1]);
  // The source register is the destination's index: cell[2] it is, and after, whatever the register holds.
  uint64_t n = 2;
  cell[2] = 3; cell[3] = 100;
  __asm__ volatile("xaddq %[n], (%[b], %[n], 8)" : [n] "+r"(n) : [b] "r"(cell) : "cc", "memory");
  printf("xadd through its index: the register %llu, its cell %llu, the cell after %llu\n",
         (unsigned long long)n, (unsigned long long)cell[2], (unsigned long long)cell[3]);
  // Narrower: a byte and a word through the register that is their address (the rest of it stays the address).
  uint32_t w = 0x11223344;
  static uint32_t narrow[2];
  narrow[0] = 0x01020304; narrow[1] = 0x0a0b0c0d;
  uint64_t at = (uint64_t)&narrow[0];
  __asm__ volatile("xaddl %k[w], (%[at])" : [w] "+r"(w) : [at] "r"(at) : "cc", "memory");
  printf("xadd 32: %x %x beside %x\n", w, narrow[0], narrow[1]);
}

int main(int argc, char **argv) {
  (void)argv;
  // Values that put the top and bottom bits, and the bits beside them, both ways; one taken from the run.
  uint64_t v[4] = {0x8000000000000001ULL, 0x4000000040004040ULL, 0xc3a5f00f12345678ULL, (uint64_t)argc * 0x9e3779b97f4a7c15ULL};
  ROTATED(rol8, uint8_t, 8) ROTATED(ror8, uint8_t, 8)
  ROTATED(rol16, uint16_t, 16) ROTATED(ror16, uint16_t, 16)
  ROTATED(rol32, uint32_t, 32) ROTATED(ror32, uint32_t, 32)
  ROTATED(rol64, uint64_t, 64) ROTATED(ror64, uint64_t, 64)
  DOUBLED(shld16, uint16_t) DOUBLED(shrd16, uint16_t)
  DOUBLED(shld32, uint32_t) DOUBLED(shrd32, uint32_t)
  DOUBLED(shld64, uint64_t) DOUBLED(shrd64, uint64_t)
  int zf;
  uint64_t r = after_add(v[2], v[3], v[0], &zf);
  printf("shld after add %llx zf=%d\n", (unsigned long long)r, zf);
  r = after_add(1, ~0ULL, 0, &zf);
  printf("shld after add %llx zf=%d\n", (unsigned long long)r, zf);
  COUNTED(popcnt16, uint16_t) COUNTED(popcnt32, uint32_t) COUNTED(popcnt64, uint64_t)
  for (int b = 0; b < 2; b++)
    for (int k = 0; k < 5; k++) {
      uint64_t n; int f[5];
      popcnt_unread(b ? ~0ULL : 1, k < 4 ? v[k] : 0, &n, f);
      printf("popcnt64, the flags before unread: %llu cf=%d of=%d zf=%d sf=%d pf=%d\n", (unsigned long long)n, f[0], f[1], f[2], f[3], f[4]);
    }
  XADDED(xadd8, uint8_t) XADDED(xadd16, uint16_t) XADDED(xadd32, uint32_t) XADDED(xadd64, uint64_t)
  aliased();
  return 0;
}
