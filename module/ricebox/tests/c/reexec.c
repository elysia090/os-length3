// A program its first translation cannot see into (built stripped, without relocations: what it calls through
// pointers is found only as it runs), run again and again: exec'd anew three times, forking a child each time. The
// code it reaches later is gathered into one module once it runs again (Kernel.consolidate), and a process takes the
// memory one before it let go of (Kernel.takeMemory): what it computes is the same throughout. The first run goes on
// after a child of it has run it again (and so gathered it), calling functions it had not reached: those are still
// translated for it, the first translation it runs on.
// xlat: stripped
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static unsigned long f0(unsigned long s) { for (int i = 0; i < 3; i++) { s = s * 31 + 7; } return s; }
static unsigned long f1(unsigned long s) { for (int i = 0; i < 4; i++) { s ^= s >> 2; } return s; }
static unsigned long f2(unsigned long s) { for (int i = 0; i < 5; i++) { s += (s << 3) | 2; } return s; }
static unsigned long f3(unsigned long s) { for (int i = 0; i < 6; i++) { s = s * 9 + (s >> 17); } return s; }
static unsigned long f4(unsigned long s) { for (int i = 0; i < 7; i++) { s = s * 31 + 11; } return s; }
static unsigned long f5(unsigned long s) { for (int i = 0; i < 3; i++) { s ^= s >> 6; } return s; }
static unsigned long f6(unsigned long s) { for (int i = 0; i < 4; i++) { s += (s << 7) | 6; } return s; }
static unsigned long f7(unsigned long s) { for (int i = 0; i < 5; i++) { s = s * 17 + (s >> 17); } return s; }
static unsigned long f8(unsigned long s) { for (int i = 0; i < 6; i++) { s = s * 31 + 15; } return s; }
static unsigned long f9(unsigned long s) { for (int i = 0; i < 7; i++) { s ^= s >> 10; } return s; }
static unsigned long f10(unsigned long s) { for (int i = 0; i < 3; i++) { s += (s << 4) | 10; } return s; }
static unsigned long f11(unsigned long s) { for (int i = 0; i < 4; i++) { s = s * 25 + (s >> 17); } return s; }
static unsigned long f12(unsigned long s) { for (int i = 0; i < 5; i++) { s = s * 31 + 19; } return s; }
static unsigned long f13(unsigned long s) { for (int i = 0; i < 6; i++) { s ^= s >> 1; } return s; }
static unsigned long f14(unsigned long s) { for (int i = 0; i < 7; i++) { s += (s << 1) | 14; } return s; }
static unsigned long f15(unsigned long s) { for (int i = 0; i < 3; i++) { s = s * 33 + (s >> 17); } return s; }
static unsigned long f16(unsigned long s) { for (int i = 0; i < 4; i++) { s = s * 31 + 23; } return s; }
static unsigned long f17(unsigned long s) { for (int i = 0; i < 5; i++) { s ^= s >> 5; } return s; }
static unsigned long f18(unsigned long s) { for (int i = 0; i < 6; i++) { s += (s << 5) | 18; } return s; }
static unsigned long f19(unsigned long s) { for (int i = 0; i < 7; i++) { s = s * 41 + (s >> 17); } return s; }
static unsigned long f20(unsigned long s) { for (int i = 0; i < 3; i++) { s = s * 31 + 27; } return s; }
static unsigned long f21(unsigned long s) { for (int i = 0; i < 4; i++) { s ^= s >> 9; } return s; }
static unsigned long f22(unsigned long s) { for (int i = 0; i < 5; i++) { s += (s << 2) | 22; } return s; }
static unsigned long f23(unsigned long s) { for (int i = 0; i < 6; i++) { s = s * 49 + (s >> 17); } return s; }
static unsigned long f24(unsigned long s) { for (int i = 0; i < 7; i++) { s = s * 31 + 31; } return s; }
static unsigned long f25(unsigned long s) { for (int i = 0; i < 3; i++) { s ^= s >> 13; } return s; }
static unsigned long f26(unsigned long s) { for (int i = 0; i < 4; i++) { s += (s << 6) | 26; } return s; }
static unsigned long f27(unsigned long s) { for (int i = 0; i < 5; i++) { s = s * 57 + (s >> 17); } return s; }
static unsigned long f28(unsigned long s) { for (int i = 0; i < 6; i++) { s = s * 31 + 35; } return s; }
static unsigned long f29(unsigned long s) { for (int i = 0; i < 7; i++) { s ^= s >> 4; } return s; }
static unsigned long f30(unsigned long s) { for (int i = 0; i < 3; i++) { s += (s << 3) | 30; } return s; }
static unsigned long f31(unsigned long s) { for (int i = 0; i < 4; i++) { s = s * 65 + (s >> 17); } return s; }
static unsigned long f32(unsigned long s) { for (int i = 0; i < 5; i++) { s = s * 31 + 39; } return s; }
static unsigned long f33(unsigned long s) { for (int i = 0; i < 6; i++) { s ^= s >> 8; } return s; }
static unsigned long f34(unsigned long s) { for (int i = 0; i < 7; i++) { s += (s << 7) | 34; } return s; }
static unsigned long f35(unsigned long s) { for (int i = 0; i < 3; i++) { s = s * 73 + (s >> 17); } return s; }
static unsigned long f36(unsigned long s) { for (int i = 0; i < 4; i++) { s = s * 31 + 43; } return s; }
static unsigned long f37(unsigned long s) { for (int i = 0; i < 5; i++) { s ^= s >> 12; } return s; }
static unsigned long f38(unsigned long s) { for (int i = 0; i < 6; i++) { s += (s << 4) | 38; } return s; }
static unsigned long f39(unsigned long s) { for (int i = 0; i < 7; i++) { s = s * 81 + (s >> 17); } return s; }
static unsigned long f40(unsigned long s) { for (int i = 0; i < 3; i++) { s = s * 31 + 47; } return s; }
static unsigned long f41(unsigned long s) { for (int i = 0; i < 4; i++) { s ^= s >> 3; } return s; }
static unsigned long f42(unsigned long s) { for (int i = 0; i < 5; i++) { s += (s << 1) | 42; } return s; }
static unsigned long f43(unsigned long s) { for (int i = 0; i < 6; i++) { s = s * 89 + (s >> 17); } return s; }
static unsigned long f44(unsigned long s) { for (int i = 0; i < 7; i++) { s = s * 31 + 51; } return s; }
static unsigned long f45(unsigned long s) { for (int i = 0; i < 3; i++) { s ^= s >> 7; } return s; }
static unsigned long f46(unsigned long s) { for (int i = 0; i < 4; i++) { s += (s << 5) | 46; } return s; }
static unsigned long f47(unsigned long s) { for (int i = 0; i < 5; i++) { s = s * 97 + (s >> 17); } return s; }
static unsigned long f48(unsigned long s) { for (int i = 0; i < 6; i++) { s = s * 31 + 55; } return s; }
static unsigned long f49(unsigned long s) { for (int i = 0; i < 7; i++) { s ^= s >> 11; } return s; }
static unsigned long f50(unsigned long s) { for (int i = 0; i < 3; i++) { s += (s << 2) | 50; } return s; }
static unsigned long f51(unsigned long s) { for (int i = 0; i < 4; i++) { s = s * 105 + (s >> 17); } return s; }
static unsigned long f52(unsigned long s) { for (int i = 0; i < 5; i++) { s = s * 31 + 59; } return s; }
static unsigned long f53(unsigned long s) { for (int i = 0; i < 6; i++) { s ^= s >> 2; } return s; }
static unsigned long f54(unsigned long s) { for (int i = 0; i < 7; i++) { s += (s << 6) | 54; } return s; }
static unsigned long f55(unsigned long s) { for (int i = 0; i < 3; i++) { s = s * 113 + (s >> 17); } return s; }
static unsigned long f56(unsigned long s) { for (int i = 0; i < 4; i++) { s = s * 31 + 63; } return s; }
static unsigned long f57(unsigned long s) { for (int i = 0; i < 5; i++) { s ^= s >> 6; } return s; }
static unsigned long f58(unsigned long s) { for (int i = 0; i < 6; i++) { s += (s << 3) | 58; } return s; }
static unsigned long f59(unsigned long s) { for (int i = 0; i < 7; i++) { s = s * 121 + (s >> 17); } return s; }
static unsigned long f60(unsigned long s) { for (int i = 0; i < 3; i++) { s = s * 31 + 67; } return s; }
static unsigned long f61(unsigned long s) { for (int i = 0; i < 4; i++) { s ^= s >> 10; } return s; }
static unsigned long f62(unsigned long s) { for (int i = 0; i < 5; i++) { s += (s << 7) | 62; } return s; }
static unsigned long f63(unsigned long s) { for (int i = 0; i < 6; i++) { s = s * 129 + (s >> 17); } return s; }

static unsigned long (*const table[64])(unsigned long) = {f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20, f21, f22, f23, f24, f25, f26, f27, f28, f29, f30, f31, f32, f33, f34, f35, f36, f37, f38, f39, f40, f41, f42, f43, f44, f45, f46, f47, f48, f49, f50, f51, f52, f53, f54, f55, f56, f57, f58, f59, f60, f61, f62, f63};
static volatile int pick = 1; // the table is read through this, so no call is direct

int main(int argc, char **argv) {
  int round = argc > 1 ? atoi(argv[1]) : 0;
  unsigned long s = 0x9e3779b97f4a7c15ul + round;
  if (argc > 1 && !strcmp(argv[1], "again")) {
    for (int k = 0; k < 64; k++) s = table[k](s);
    printf("again %lx\n", s);
    return 0;
  }
  // The first run reaches 48 of them, has a child run it again, then reaches the other 16.
  int first = round == 0 ? 48 : 64;
  for (int k = 0; k < first; k++) s = table[(k * pick * 17) % 64](s);
  if (round == 0) {
    fflush(stdout);
    pid_t again = fork();
    if (again == 0) { execl("/proc/self/exe", argv[0], "again", (char *)0); _exit(1); }
    waitpid(again, 0, 0);
    for (int k = first; k < 64; k++) s = table[(k * pick * 17) % 64](s);
  }
  static char heap_check[1 << 16];
  for (unsigned i = 0; i < sizeof heap_check; i++) if (heap_check[i]) { printf("dirty .bss\n"); return 1; }
  memset(heap_check, round + 1, sizeof heap_check);
  char *fresh = malloc(1 << 20);
  for (int i = 0; i < 1 << 20; i += 4096) if (fresh[i]) { printf("dirty heap\n"); return 1; }
  memset(fresh, 0xa5, 1 << 20);
  pid_t child = fork();
  if (child == 0) { unsigned long t = s; for (int k = 63; k >= 0; k--) t = table[k](t); printf("round %d child %lx\n", round, t); return 0; }
  int status;
  waitpid(child, &status, 0);
  printf("round %d %lx\n", round, s);
  fflush(stdout);
  if (round < 3) {
    char next[12];
    snprintf(next, sizeof next, "%d", round + 1);
    execl("/proc/self/exe", argv[0], next, (char *)0);
    perror("exec");
    return 1;
  }
  return 0;
}
