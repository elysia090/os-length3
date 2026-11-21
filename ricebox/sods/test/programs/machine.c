// What a program meets of the machine beyond its own instructions: a
// timer's signal while it computes without a call (its time slice ends),
// recursion deeper than a host's stack, a file written through MAP_SHARED,
// a FIFO met from two processes, file times set to the nanosecond, and
// the flags register pushed and popped whole.
#define _GNU_SOURCE
#include <fcntl.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

static sigjmp_buf out;
static volatile int ticks;
// The third tick ends it: the timer stopped and its signal ignored first, so one that came while this ran (a loaded
// machine's) is let go, not taken once the jump unblocks it.
static void tick(int s) {
  (void)s;
  if (++ticks < 3) return;
  struct itimerval off = {{0, 0}, {0, 0}};
  setitimer(ITIMER_REAL, &off, 0);
  signal(SIGALRM, SIG_IGN);
  siglongjmp(out, 1);
}

static long deep(long n) { volatile char pad[48]; pad[0] = (char)n; return n ? deep(n - 1) + pad[0] % 5 : 0; }

int main(void) {
  // A busy loop sees its timer.
  signal(SIGALRM, tick);
  struct itimerval t = {{0, 3000}, {0, 3000}};
  setitimer(ITIMER_REAL, &t, 0);
  volatile uint64_t spin = 0;
  if (!sigsetjmp(out, 1)) for (;;) spin++;
  printf("ticks %d, spun %s\n", ticks, spin > 0 ? "yes" : "no");

  // 50000 frames: a host stack holds far fewer of its own.
  printf("deep %ld\n", deep(50000));

  // Written through a shared mapping, read back through the file: before msync, after it, after munmap.
  int fd = open("/tmp/machine.dat", O_RDWR | O_CREAT | O_TRUNC, 0644);
  ftruncate(fd, 1 << 16);
  unsigned char *p = mmap(0, 1 << 16, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  for (int i = 0; i < 1 << 16; i++) p[i] = (unsigned char)(i * 13);
  unsigned char b[4];
  pread(fd, b, 4, 1000);
  printf("mapped, read %02x %02x %02x %02x\n", b[0], b[1], b[2], b[3]);
  pwrite(fd, "WXYZ", 4, 2000);
  printf("written, mapped %c%c%c%c\n", p[2000], p[2001], p[2002], p[2003]);
  msync(p, 1 << 16, MS_SYNC);
  if (fork() == 0) { p[3000] = 'c'; munmap(p, 1 << 16); _exit(0); }
  wait(0);
  munmap(p, 1 << 16);
  long s = 0;
  lseek(fd, 0, SEEK_SET);
  for (ssize_t r; (r = read(fd, b, 4)) > 0;) for (ssize_t i = 0; i < r; i++) s += b[i];
  printf("unmapped, sum %ld\n", s);
  close(fd);

  // A FIFO: the writer's open waits for a reader.
  unlink("/tmp/machine.fifo");
  mkfifo("/tmp/machine.fifo", 0600);
  if (fork() == 0) { int w = open("/tmp/machine.fifo", O_WRONLY); write(w, "through the fifo\n", 17); close(w); _exit(0); }
  int r = open("/tmp/machine.fifo", O_RDONLY);
  char line[64];
  ssize_t n = read(r, line, sizeof line);
  close(r);
  wait(0);
  printf("%.*s", (int)n, line);
  printf("nonblocking writer, no reader: %s\n", open("/tmp/machine.fifo", O_WRONLY | O_NONBLOCK) < 0 ? "ENXIO" : "opened");

  // Times to the nanosecond.
  struct timespec ts[2] = {{1000000000, 123456789}, {1500000000, 987654321}};
  utimensat(AT_FDCWD, "/tmp/machine.dat", ts, 0);
  struct stat st;
  stat("/tmp/machine.dat", &st);
  printf("times %ld.%09ld %ld.%09ld\n", (long)st.st_atim.tv_sec, st.st_atim.tv_nsec, (long)st.st_mtim.tv_sec, st.st_mtim.tv_nsec);

  // pushfq and popfq: the carry set, then cleared through the flags word.
  uint64_t f1, f2;
  __asm__ volatile("stc; pushfq; pop %0; push %0; andq $-2, (%%rsp); popfq; pushfq; pop %1" : "=r"(f1), "=r"(f2) :: "cc");
  printf("flags %llx %llx\n", (unsigned long long)(f1 & 0x603), (unsigned long long)(f2 & 0x603));
  return 0;
}
