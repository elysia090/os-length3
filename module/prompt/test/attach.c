/*
 * prompt, checked at two real terminals: one it is in front of (the outer: what is typed to it and what it shows)
 * and the one it is given (the inner: a box's). What is typed goes in and what is shown comes out; the size
 * follows; it ends as its box's terminal ends, or as it is told to, under backpressure too; and it leaves the
 * outer terminal, and the descriptors it was given, as it found them.
 *
 *   attach PROMPT
 *
 * One program for every host: built static, it is run on Linux and, the same file, on sods' Linux
 * (../../sods/test/prompt/run.sh), where the terminals are the ones that kernel makes.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static const char *prompt;
static const char *doing = "";

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
static void nap(void) { struct timespec t = {0, 5000000}; nanosleep(&t, 0); }
#define sure(what) do { if (!(what)) { fprintf(stderr, "attach: %s: not so: %s (line %d, errno %d)\n", doing, #what, __LINE__, errno); exit(1); } } while (0)

/* A terminal pair: its master, and its other end opened. */
static void pair(int *master, int *slave) {
  *master = posix_openpt(O_RDWR | O_NOCTTY);
  sure(*master >= 0 && !grantpt(*master) && !unlockpt(*master));
  *slave = open(ptsname(*master), O_RDWR | O_NOCTTY);
  sure(*slave >= 0);
}
static void raw(int fd) {
  struct termios t;
  sure(!tcgetattr(fd, &t));
  cfmakeraw(&t);
  sure(!tcsetattr(fd, TCSANOW, &t));
}
/* How a terminal is set: its flags and the special characters the kernel has (19: what is past them in the C library's struct, nothing sets). */
static int same_mode(const struct termios *a, const struct termios *b) {
  return a->c_iflag == b->c_iflag && a->c_oflag == b->c_oflag && a->c_cflag == b->c_cflag && a->c_lflag == b->c_lflag && !memcmp(a->c_cc, b->c_cc, 19);
}

/* `expected` read at `fd`, within three seconds. */
static void receive(int fd, const char *expected) {
  size_t want = strlen(expected), got = 0;
  char buf[256];
  double until = now() + 3;
  while (got < want) {
    sure(now() < until);
    struct pollfd p = {fd, POLLIN, 0};
    if (poll(&p, 1, 100) > 0) {
      ssize_t n = read(fd, buf + got, want - got);
      sure(n > 0);
      got += (size_t)n;
    }
  }
  if (memcmp(buf, expected, want)) { fprintf(stderr, "attach: %s: read \"%.*s\", not \"%s\"\n", doing, (int)got, buf, expected); exit(1); }
}

/* prompt started: `in` what is typed to it, `out` what it shows on, `peer` the terminal it is given. Nothing else is its. */
static pid_t start(int in, int out, int peer, int errors) {
  char number[16];
  snprintf(number, sizeof number, "%d", peer);
  pid_t pid = fork();
  sure(pid >= 0);
  if (!pid) {
    /* (the three first, each from a copy past them, so none is closed before it is taken) */
    int a = fcntl(in, F_DUPFD, 100), b = fcntl(out, F_DUPFD, 100), c = fcntl(errors, F_DUPFD, 100), d = fcntl(peer, F_DUPFD, 100);
    dup2(a, 0), dup2(b, 1), dup2(c, 2), dup2(d, peer);
    for (int fd = 3; fd < 256; fd++) if (fd != peer) close(fd);
    execl(prompt, prompt, "attach", number, (char *)0);
    _exit(127);
  }
  return pid;
}
/* It has taken the outer terminal: set as it was not before. */
static void attached(pid_t pid, int outer_slave, const struct termios *before) {
  double until = now() + 3;
  for (;;) {
    struct termios t;
    int status;
    sure(!tcgetattr(outer_slave, &t));
    if (!same_mode(&t, before)) return;
    sure(waitpid(pid, &status, WNOHANG) == 0);
    sure(now() < until);
    nap();
  }
}
/* How it ended, within three seconds: its status, or 128 and the signal that ended it. */
static int ended(pid_t pid) {
  double until = now() + 3;
  int status;
  for (;;) {
    pid_t r = waitpid(pid, &status, WNOHANG);
    sure(r >= 0);
    if (r == pid) return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : WEXITSTATUS(status);
    sure(now() < until);
    nap();
  }
}

static void once(const char *how) {
  doing = how;
  int outer, outer_slave, inner, inner_slave, out[2] = {-1, -1}, errors[2];
  pair(&outer, &outer_slave), pair(&inner, &inner_slave);
  raw(inner_slave);
  struct termios before, after;
  sure(!tcgetattr(outer_slave, &before));
  int inner_flags = fcntl(inner, F_GETFL), outer_flags = fcntl(outer_slave, F_GETFL);
  int broken = !strcmp(how, "broken-output");
  sure(!pipe(errors));
  if (broken) sure(!pipe(out));
  pid_t pid = start(outer_slave, broken ? out[1] : outer_slave, inner, errors[1]);
  close(errors[1]);
  attached(pid, outer_slave, &before);
  if (!broken) {
    sure(write(outer, "typed\n", 6) == 6);
    receive(inner_slave, "typed\n");
    sure(write(inner_slave, "shown\n", 6) == 6);
    receive(outer, "shown\n");
    /* The outer terminal's size is the inner's, once prompt is told it changed. */
    struct winsize size = {31, 97, 0, 0}, seen = {0, 0, 0, 0};
    sure(!ioctl(outer_slave, TIOCSWINSZ, &size));
    kill(pid, SIGWINCH);
    for (double until = now() + 3; seen.ws_row != 31 || seen.ws_col != 97; nap()) {
      sure(now() < until);
      sure(!ioctl(inner_slave, TIOCGWINSZ, &seen));
    }
  }
  int expected;
  if (!strcmp(how, "hangup")) {
    close(inner_slave), inner_slave = -1;
    expected = 0;
  } else if (!strcmp(how, "signal")) {
    kill(pid, SIGTERM), expected = 143;
  } else if (!strcmp(how, "backpressure")) {
    /* What the box shows is not read: both queues fill; told to end, it ends all the same. */
    static char flood[65536];
    memset(flood, 'x', sizeof flood);
    fcntl(inner_slave, F_SETFL, fcntl(inner_slave, F_GETFL) | O_NONBLOCK);
    for (double until = now() + 0.2; now() < until;)
      if (write(inner_slave, flood, sizeof flood) < 0) { sure(errno == EAGAIN); struct timespec t = {0, 1000000}; nanosleep(&t, 0); }
    kill(pid, SIGTERM), expected = 143;
  } else {
    /* No one reads what it shows: it says so and ends, 1. */
    close(out[0]), close(out[1]);
    sure(write(inner_slave, "output with no reader", 21) == 21);
    expected = 1;
  }
  int status = ended(pid);
  if (status != expected) {
    char said[512];
    ssize_t n = read(errors[0], said, sizeof said - 1);
    fprintf(stderr, "attach: %s: prompt ended %d, not %d: %.*s\n", how, status, expected, n > 0 ? (int)n : 0, said);
    exit(1);
  }
  sure(!tcgetattr(outer_slave, &after) && same_mode(&after, &before));
  sure(fcntl(inner, F_GETFL) == inner_flags && fcntl(outer_slave, F_GETFL) == outer_flags);
  close(outer), close(outer_slave), close(inner), close(errors[0]);
  if (inner_slave >= 0) close(inner_slave);
  printf("ok %s\n", how);
  fflush(stdout);
}

/* What is no descriptor of a terminal it was given: it says how it is used and ends, 1. */
static void invalid(const char *fd) {
  doing = fd;
  pid_t pid = fork();
  sure(pid >= 0);
  if (!pid) {
    int nowhere = open("/dev/null", O_RDWR);
    dup2(nowhere, 1), dup2(nowhere, 2);
    execl(prompt, prompt, "attach", fd, (char *)0);
    _exit(127);
  }
  sure(ended(pid) == 1);
}

/* The box writes a whole reply before it reads the rest of a long request: both ways must go on together, though both queues fill. */
enum { LONG = 512 << 10 };
static int guest_at, guest_failed;
static void *guest(void *unused) {
  (void)unused;
  static char reply[LONG], got[65536];
  memset(reply, 'o', sizeof reply);
  char first;
  size_t total = 0, sent = 0;
  if (read(guest_at, &first, 1) != 1 || first != 'i') { guest_failed = 1; return 0; }
  total = 1;
  while (sent < LONG) {
    ssize_t n = write(guest_at, reply + sent, LONG - sent);
    if (n <= 0) { guest_failed = 2; return 0; }
    sent += (size_t)n;
  }
  while (total < LONG) {
    ssize_t n = read(guest_at, got, sizeof got < LONG - total ? sizeof got : LONG - total);
    if (n <= 0) { guest_failed = 3; return 0; }
    for (ssize_t k = 0; k < n; k++) if (got[k] != 'i') { guest_failed = 4; return 0; }
    total += (size_t)n;
  }
  return 0;
}
static void crossed(void) {
  doing = "crossed backpressure";
  int outer, outer_slave, inner, inner_slave, errors[2];
  pair(&outer, &outer_slave), pair(&inner, &inner_slave);
  raw(inner_slave);
  struct termios before, after;
  sure(!tcgetattr(outer_slave, &before) && !pipe(errors));
  pid_t pid = start(outer_slave, outer_slave, inner, errors[1]);
  close(errors[1]);
  attached(pid, outer_slave, &before);
  static char request[LONG], got[65536];
  memset(request, 'i', sizeof request);
  guest_at = inner_slave;
  pthread_t thread;
  sure(!pthread_create(&thread, 0, guest, 0));
  fcntl(outer, F_SETFL, fcntl(outer, F_GETFL) | O_NONBLOCK);
  size_t sent = 0, received = 0;
  for (double until = now() + 8; sent < LONG || received < LONG;) {
    sure(now() < until);
    struct pollfd p = {outer, (short)(POLLIN | (sent < LONG ? POLLOUT : 0)), 0};
    if (poll(&p, 1, 50) <= 0) continue;
    if (p.revents & POLLOUT) {
      ssize_t n = write(outer, request + sent, LONG - sent < 65536 ? LONG - sent : 65536);
      if (n > 0) sent += (size_t)n; else sure(errno == EAGAIN);
    }
    if (p.revents & POLLIN) {
      ssize_t n = read(outer, got, sizeof got);
      if (n > 0) { for (ssize_t k = 0; k < n; k++) sure(got[k] == 'o'); received += (size_t)n; } else sure(errno == EAGAIN);
    }
  }
  sure(!pthread_join(thread, 0) && !guest_failed);
  kill(pid, SIGTERM);
  sure(ended(pid) == 143);
  sure(!tcgetattr(outer_slave, &after) && same_mode(&after, &before));
  printf("ok crossed backpressure\n");
}

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: attach PROMPT\n"); return 2; }
  prompt = argv[1];
  static const char *hows[] = {"hangup", "signal", "backpressure", "broken-output"};
  for (unsigned i = 0; i < 4; i++) once(hows[i]);
  static const char *none[] = {"0", "-1", "999999999999999999999", "no"};
  for (unsigned i = 0; i < 4; i++) invalid(none[i]);
  printf("ok invalid descriptors\n");
  crossed();
  return 0;
}
