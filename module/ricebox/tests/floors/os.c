// The floors an OS sets under every program: each primitive timed alone, in microseconds a time (the best of three
// rounds, each round many times), so the same program run natively and translated says where each floor stands
// (floors.ts runs both). An exec runs this program again, as `exit`, which ends at once.
#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e6 + t.tv_nsec * 1e-3; }

static char page[4096];
static volatile uint64_t sink;

static void getppid_(void) { sink += syscall(SYS_getppid); }
static void clock_(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); sink += t.tv_nsec; }
static void open_close(void) { int fd = open("/tmp/floors.f", O_RDONLY); close(fd); }
static void stat_(void) { struct stat st; stat("/tmp/floors.f", &st); sink += st.st_size; }
static int rfd, wfd;
static void pread4k(void) { sink += pread(rfd, page, sizeof page, 0); }
static void write4k(void) { sink += write(wfd, page, sizeof page); }
static int up[2], down[2];
static void pipe_rtt(void) { char c = 1; write(down[1], &c, 1); read(up[0], &c, 1); }
static void fork_wait(void) { pid_t p = fork(); if (!p) _exit(0); waitpid(p, 0, 0); }
static char *again[] = {"floors", "exit", 0};
static void fork_exec(void) {
  pid_t p = fork();
  if (!p) { execve("/proc/self/exe", again, environ); _exit(127); }
  waitpid(p, 0, 0);
}
static void spawn_(void) { pid_t p; posix_spawn(&p, "/proc/self/exe", 0, 0, again, environ); waitpid(p, 0, 0); }
static void mmap_touch(void) {
  char *m = mmap(0, 1 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  for (int i = 0; i < 1 << 20; i += 4096) m[i] = 1;
  munmap(m, 1 << 20);
}
static void *nothing(void *x) { return x; }
static void thread_(void) { pthread_t t; pthread_create(&t, 0, nothing, 0); pthread_join(t, 0); }
static char *big, *big2;
static void memcpy64m(void) {
  if (!big) big = malloc(64 << 20), big2 = malloc(64 << 20), memset(big, 7, 64 << 20), memset(big2, 1, 64 << 20);
  memcpy(big2, big, 64 << 20);
  sink += big2[12345];
}
static void loop1m(void) { uint64_t s = sink; for (int i = 0; i < 1000000; i++) s = s * 6364136223846793005u + i; sink = s; }

static void child_echo(void) {
  char c;
  while (read(down[0], &c, 1) == 1) write(up[1], &c, 1);
  _exit(0);
}

struct floor { const char *name; void (*f)(void); int n; };

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "exit")) return 0;
  setvbuf(stdout, 0, _IONBF, 0);
  int only = argc > 1 ? atoi(argv[1]) : -1;
  int fd = open("/tmp/floors.f", O_CREAT | O_RDWR | O_TRUNC, 0644);
  write(fd, page, sizeof page);
  close(fd);
  rfd = open("/tmp/floors.f", O_RDONLY);
  wfd = open("/dev/null", O_WRONLY);
  pipe(up), pipe(down);
  if (!fork()) { close(up[0]), close(down[1]); child_echo(); }
  close(up[1]), close(down[0]);
  struct floor floors[] = {
    {"syscall (getppid)", getppid_, 20000}, {"clock_gettime", clock_, 20000}, {"open+close", open_close, 5000},
    {"stat", stat_, 5000}, {"pread 4 KiB", pread4k, 5000}, {"write 4 KiB /dev/null", write4k, 5000},
    {"pipe round trip", pipe_rtt, 2000}, {"fork+exit+wait", fork_wait, 100}, {"fork+exec+wait", fork_exec, 50},
    {"posix_spawn+wait", spawn_, 50}, {"mmap 1 MiB+touch+munmap", mmap_touch, 200}, {"thread create+join", thread_, 200},
    {"memcpy 64 MiB", memcpy64m, 5}, {"1M multiply-adds", loop1m, 20},
  };
  for (unsigned k = 0; k < sizeof floors / sizeof *floors; k++) {
    if (only >= 0 && (int)k != only) continue;
    struct floor *f = &floors[k];
    double best = 1e18;
    for (int round = 0; round < 3; round++) {
      double t = now();
      for (int i = 0; i < f->n; i++) f->f();
      t = (now() - t) / f->n;
      if (t < best) best = t;
    }
    printf("%-26s %12.2f us\n", f->name, best);
  }
  close(down[1]);
  wait(0);
  return 0;
}
