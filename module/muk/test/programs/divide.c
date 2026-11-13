// A division the processor refuses ends the program with SIGFPE, as on Linux: by zero, and a quotient that does not
// fit (the least integer by -1; a dividend of two words too large for its divisor), in each width and both ways a
// division is translated (the dividend's high word the low one's extension, as a compiler's division has it, and
// not). Each in a child of its own, whose end the parent tells.
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile long zero = 0, minus = -1;
static volatile unsigned long uzero = 0;
static volatile int izero = 0, iminus = -1;
static volatile short szero = 0;
static volatile signed char bzero = 0;

static void div64(void) { volatile unsigned long a = 256; a = a / uzero; }
static void rem64(void) { volatile unsigned long a = 256; a = a % uzero; }
static void idiv64(void) { volatile long a = 256; a = a / zero; }
static void idiv64min(void) { volatile long a = LONG_MIN; a = a / minus; }
static void irem64min(void) { volatile long a = LONG_MIN; a = a % minus; }
static void div32(void) { volatile unsigned a = 256; a = a / (unsigned)izero; }
static void idiv32(void) { volatile int a = 256; a = a / izero; }
static void idiv32min(void) { volatile int a = INT_MIN; a = a / iminus; }
static void irem32min(void) { volatile int a = INT_MIN; a = a % iminus; }
static void div16(void) { volatile short a = 256; a = a / szero; }
static void div8(void) { volatile signed char a = 100; a = a / bzero; }
// A dividend of two words (rdx:rax) by one: by zero, and a quotient that does not fit in one.
static void wide_zero(void) { unsigned long lo = 3, hi = 5; __asm__ volatile("divq %[d]" : "+a"(lo), "+d"(hi) : [d] "r"(uzero)); }
static void wide_over(void) { unsigned long lo = 3, hi = 5, d = 4; __asm__ volatile("divq %[d]" : "+a"(lo), "+d"(hi) : [d] "r"(d)); }
static void iwide_over(void) { long lo = 0, hi = 1, d = 1; __asm__ volatile("idivq %[d]" : "+a"(lo), "+d"(hi) : [d] "r"(d)); }
// A narrow division, its dividend twice as wide as its divisor: the quotient that just does not fit where it goes
// (one past the most an unsigned, or a signed, byte, word and doubleword hold).
#define NARROW(name, insn, type, low, high, divisor) \
  static void name(void) { type a = low, b = high, by = divisor; __asm__ volatile(insn " %[d]" : "+a"(a), "+d"(b) : [d] "r"(by)); }
static void over8(void) { unsigned short ax = 256; unsigned char by = 1; __asm__ volatile("divb %[d]" : "+a"(ax) : [d] "r"(by)); }
static void iover8(void) { short ax = 128; signed char by = 1; __asm__ volatile("idivb %[d]" : "+a"(ax) : [d] "r"(by)); }
static void iunder8(void) { short ax = -129; signed char by = 1; __asm__ volatile("idivb %[d]" : "+a"(ax) : [d] "r"(by)); }
NARROW(over16, "divw", unsigned short, 0, 1, 1)
NARROW(iover16, "idivw", short, (short)0x8000, 0, 1)
NARROW(over32, "divl", unsigned, 0, 1, 1)
NARROW(iover32, "idivl", int, (int)0x80000000, 0, 1)
NARROW(iunder32, "idivl", int, 0x7fffffff, -2, 1)
// And the most that does fit, each way: answered, quotient and remainder.
static void edges(void) {
  unsigned short ax = 255 * 7 + 6; unsigned char by = 7;
  __asm__ volatile("divb %[d]" : "+a"(ax) : [d] "r"(by));
  short sx = -128 * 5 - 4; signed char sby = 5;
  __asm__ volatile("idivb %[d]" : "+a"(sx) : [d] "r"(sby));
  unsigned short lo16 = 0xffff, hi16 = 0, d16 = 1;
  __asm__ volatile("divw %[d]" : "+a"(lo16), "+d"(hi16) : [d] "r"(d16));
  short slo16 = (short)0x8000, shi16 = -1, sd16 = 1;
  __asm__ volatile("idivw %[d]" : "+a"(slo16), "+d"(shi16) : [d] "r"(sd16));
  unsigned lo32 = 0xfffffffe, hi32 = 2, d32 = 3;
  __asm__ volatile("divl %[d]" : "+a"(lo32), "+d"(hi32) : [d] "r"(d32));
  int slo32 = (int)0x80000000, shi32 = -1, sd32 = 1;
  __asm__ volatile("idivl %[d]" : "+a"(slo32), "+d"(shi32) : [d] "r"(sd32));
  printf("edges %04x %04x %u %u %d %d %u %u %d %d\n", ax, (unsigned short)sx, lo16, hi16, slo16, shi16, lo32, hi32, slo32, shi32);
  fflush(stdout);
}
// And the divisions that are answered: nothing is refused that the processor does.
static void fine(void) {
  volatile long a = LONG_MIN, b = 3;
  volatile unsigned long c = ~0ul;
  unsigned long lo = 3, hi = 2, d = 4;
  __asm__ volatile("divq %[d]" : "+a"(lo), "+d"(hi) : [d] "r"(d));
  printf("fine %ld %ld %lu %lu %lu %lu\n", a / b, a % b, c / 7, c % 7, lo, hi);
  fflush(stdout);
}

static void tried(const char *name, void (*f)(void)) {
  fflush(stdout);
  pid_t p = fork();
  if (!p) { f(); _exit(0); }
  int st = 0;
  waitpid(p, &st, 0);
  if (WIFSIGNALED(st)) printf("%s: signal %d\n", name, WTERMSIG(st));
  else printf("%s: exit %d\n", name, WEXITSTATUS(st));
}

int main(void) {
  tried("div64", div64); tried("rem64", rem64); tried("idiv64", idiv64); tried("idiv64min", idiv64min); tried("irem64min", irem64min);
  tried("div32", div32); tried("idiv32", idiv32); tried("idiv32min", idiv32min); tried("irem32min", irem32min);
  tried("div16", div16); tried("div8", div8);
  tried("wide_zero", wide_zero); tried("wide_over", wide_over); tried("iwide_over", iwide_over);
  tried("over8", over8); tried("iover8", iover8); tried("iunder8", iunder8); tried("over16", over16); tried("iover16", iover16);
  tried("over32", over32); tried("iover32", iover32); tried("iunder32", iunder32);
  tried("edges", edges);
  tried("fine", fine);
  // And the program itself, with no one to catch it: its end is the signal's.
  fflush(stdout);
  volatile long a = 1;
  a = a / zero;
  return 0;
}
