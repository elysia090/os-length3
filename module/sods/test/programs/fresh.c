// What a process is given is zero, whatever ran before it in the same memory: a process writes deep in its stack
// (frames made with sub rsp, frames of pushes and calls alone, a signal handler's frame down there), in its bss and in
// a large mapping, and ends; the next one finds its stack below what it used, its bss and a new mapping all zero. So
// does a process that, having written so, execs its own program (which the kernel starts again on the same memory).
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define DEEP (2 << 20)
static char bss[1 << 20];
static volatile int sink;

/** Frames of 4 KiB each (sub rsp), filled with a pattern, to `depth` bytes down. */
static void framed(long depth) {
  volatile char local[4096];
  memset((char *)local, 0xab, sizeof local);
  if (depth > (long)sizeof local) framed(depth - sizeof local);
  sink += local[7];
}
/** Frames of a return address and a push or two alone, `n` deep. */
__attribute__((noinline)) static long pushed(long n) { return n ? pushed(n - 1) + 1 : 0; }
static void on(int s) { (void)s; volatile char x[256]; memset((char *)x, 0xcd, sizeof x); sink += x[1]; }
static void deep_signal(int depth) { volatile char pad[8192]; memset((char *)pad, 0xee, sizeof pad); if (depth) deep_signal(depth - 1); else raise(SIGUSR1); sink += pad[3]; }

static void dirty(void) {
  framed(DEEP);
  sink += (int)pushed(40000);
  signal(SIGUSR1, on);
  deep_signal(100);
  memset(bss, 0x5a, sizeof bss);
  char *m = mmap(0, 4 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memset(m, 0x77, 4 << 20);
}

/** Bytes not zero in [p, p + n). */
static long nonzero(const volatile char *p, long n) { long k = 0; for (long i = 0; i < n; i++) k += p[i] != 0; return k; }

static void check(void) {
  // Below what this process has used so far (its own start-up wrote the top of its stack): 2 MiB more down.
  volatile char below[DEEP + (64 << 10)];
  printf("stack below: %ld\n", nonzero(below, DEEP));
  printf("bss: %ld\n", nonzero(bss, sizeof bss));
  char *m = mmap(0, 4 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  printf("new mapping: %ld\n", nonzero(m, 4 << 20));
}

static void run(const char *self, const char *what) {
  pid_t k = vfork();
  if (k == 0) { execl(self, self, what, (char *)0); _exit(127); }
  int status; waitpid(k, &status, 0);
}

int main(int argc, char **argv) {
  setvbuf(stdout, 0, _IONBF, 0);
  if (argc > 1 && !strcmp(argv[1], "dirty")) { dirty(); return 0; }
  if (argc > 1 && !strcmp(argv[1], "check")) { check(); return 0; }
  if (argc > 1 && !strcmp(argv[1], "dirty-then-check")) { dirty(); execl("/proc/self/exe", argv[0], "check", (char *)0); return 1; }
  for (int round = 0; round < 3; round++) { run("/proc/self/exe", "dirty"); run("/proc/self/exe", "check"); }
  // A forked child dirties its copy; the next one forked is given zeros below its parent's stack too.
  // Written, then the same program again in that process.
  pid_t k = fork();
  if (k == 0) { execl("/proc/self/exe", argv[0], "dirty-then-check", (char *)0); _exit(127); }
  waitpid(k, 0, 0);
  k = fork();
  if (k == 0) { dirty(); _exit(0); }
  waitpid(k, 0, 0);
  k = fork();
  if (k == 0) { check(); _exit(0); }
  waitpid(k, 0, 0);
  return 0;
}
