// Pipes and readiness: a producer and a consumer at once, a full pipe that
// holds its writer, O_NONBLOCK and EAGAIN, PIPE_BUF writes landing whole,
// SIGPIPE and EPIPE, poll, select and epoll on pipes, F_GETPIPE_SZ, and
// background work while the parent goes on.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/select.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000 + t.tv_nsec / 1000000; }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  int p[2];

  // A producer and consumer making progress together: 8 MiB through a 64 KiB pipe, checked.
  pipe(p);
  printf("pipe size %d\n", fcntl(p[1], F_GETPIPE_SZ));
  pid_t child = fork();
  if (child == 0) {
    close(p[0]);
    static unsigned char buf[100000];
    unsigned long sum = 0;
    for (int round = 0; round < 84; round++) {
      for (int k = 0; k < (int)sizeof buf; k++) { buf[k] = (unsigned char)(round * 7 + k); sum += buf[k]; }
      if (write(p[1], buf, sizeof buf) != sizeof buf) _exit(9);
    }
    _exit((int)(sum % 251));
  }
  close(p[1]);
  unsigned long sum = 0, total = 0;
  unsigned char in[4096];
  ssize_t n;
  while ((n = read(p[0], in, sizeof in)) > 0) { total += n; for (ssize_t k = 0; k < n; k++) sum += in[k]; }
  int st;
  waitpid(child, &st, 0);
  printf("streamed %lu bytes, sums agree %d\n", total, (int)(sum % 251) == WEXITSTATUS(st));
  close(p[0]);

  // Non-blocking: EAGAIN when full and when empty; a write of PIPE_BUF bytes lands whole or not at all.
  pipe2(p, O_NONBLOCK);
  char block[4096];
  memset(block, 'a', sizeof block);
  long filled = 0;
  while ((n = write(p[1], block, 1000)) > 0) filled += n;
  printf("filled %ld then %s\n", filled, strerror(errno));
  char drain[2000];
  read(p[0], drain, sizeof drain);
  n = write(p[1], block, sizeof block);
  printf("PIPE_BUF write with 2000 free: %zd %s\n", n, n < 0 ? strerror(errno) : "");
  while (read(p[0], drain, sizeof drain) > 0) {}
  printf("empty read: %s\n", strerror(errno));
  close(p[0]); close(p[1]);

  // poll and select: nothing, then readable, then hung up.
  pipe(p);
  struct pollfd pf = {.fd = p[0], .events = POLLIN};
  printf("poll empty: %d\n", poll(&pf, 1, 50));
  write(p[1], "hi", 2);
  printf("poll data: %d revents %d\n", poll(&pf, 1, 50), pf.revents);
  fd_set r;
  FD_ZERO(&r); FD_SET(p[0], &r);
  struct timeval tv = {0, 50000};
  printf("select data: %d %d\n", select(p[0] + 1, &r, 0, 0, &tv), FD_ISSET(p[0], &r));
  read(p[0], drain, 2);
  close(p[1]);
  printf("poll hangup: %d revents %d\n", poll(&pf, 1, 50), pf.revents & POLLHUP ? 1 : 0);
  close(p[0]);

  // epoll, level and edge triggered, with a writer that comes later.
  pipe(p);
  int ep = epoll_create1(EPOLL_CLOEXEC);
  struct epoll_event ev = {.events = EPOLLIN, .data.u64 = 42}, out[4];
  epoll_ctl(ep, EPOLL_CTL_ADD, p[0], &ev);
  child = fork();
  if (child == 0) { usleep(100000); write(p[1], "later", 5); _exit(0); }
  long t0 = ms();
  int got = epoll_wait(ep, out, 4, 2000);
  printf("epoll waited for the writer: %d data %llu waited %d\n", got, (unsigned long long)out[0].data.u64, ms() - t0 >= 80);
  printf("level again: %d\n", epoll_wait(ep, out, 4, 0));
  ev.events = EPOLLIN | EPOLLET;
  epoll_ctl(ep, EPOLL_CTL_MOD, p[0], &ev);
  printf("edge first: %d then %d\n", epoll_wait(ep, out, 4, 0), epoll_wait(ep, out, 4, 0));
  waitpid(child, 0, 0);
  close(ep); close(p[0]); close(p[1]);

  // SIGPIPE ends a writer by default; ignored, the write says EPIPE.
  pipe(p);
  close(p[0]);
  child = fork();
  if (child == 0) { write(p[1], "x", 1); _exit(0); }
  waitpid(child, &st, 0);
  printf("writer to no reader: signaled %d sig %d\n", WIFSIGNALED(st), WTERMSIG(st));
  signal(SIGPIPE, SIG_IGN);
  n = write(p[1], "x", 1);
  printf("ignored: %zd %s\n", n, strerror(errno));
  close(p[1]);

  // A full pipe holds its writer until the reader comes, and then both go on.
  pipe(p);
  child = fork();
  if (child == 0) {
    static char big[1 << 20];
    long t = ms();
    ssize_t w = write(p[1], big, sizeof big);
    _exit(w == sizeof big && ms() - t >= 150 ? 0 : 1);
  }
  usleep(200000);
  total = 0;
  close(p[1]);
  while ((n = read(p[0], in, sizeof in)) > 0) total += n;
  waitpid(child, &st, 0);
  printf("held writer: read %lu, writer waited %d\n", total, WEXITSTATUS(st) == 0);

  // In the background: the parent goes on while the child sleeps.
  t0 = ms();
  child = fork();
  if (child == 0) { usleep(300000); _exit(4); }
  printf("parent went on at once: %d\n", ms() - t0 < 200);
  printf("WNOHANG while it runs: %d\n", waitpid(child, &st, WNOHANG));
  waitpid(child, &st, 0);
  printf("then it ended: %d after %d\n", WEXITSTATUS(st), ms() - t0 >= 280);
  return 0;
}
