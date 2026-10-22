// Process groups, sessions and stopped jobs: setpgid and getpgid across
// processes, kill to a group, SIGSTOP and SIGCONT seen through WUNTRACED
// and WCONTINUED and SIGCHLD, setsid, waitid, orphans going to init.
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int chld, chld_code;
static void on_chld(int sig, siginfo_t *si, void *u) { chld++; chld_code = si->si_code; }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  struct sigaction sa = {.sa_sigaction = on_chld, .sa_flags = SA_SIGINFO | SA_RESTART};
  sigemptyset(&sa.sa_mask);
  sigaction(SIGCHLD, &sa, 0);

  // A group of two children, signalled as one.
  pid_t a = fork();
  if (a == 0) { setpgid(0, 0); for (;;) pause(); }
  setpgid(a, a);
  pid_t b = fork();
  if (b == 0) { for (;;) pause(); }
  setpgid(b, a);
  usleep(50000);
  printf("group: a leads %d, b in it %d, parent not %d\n", getpgid(a) == a, getpgid(b) == a, getpgrp() != a);
  printf("setpgid to a group elsewhere: %d %s\n", setpgid(0, 99999), strerror(errno));

  // Stopped and continued, as a job control shell sees it.
  kill(-a, SIGSTOP);
  int st;
  pid_t w = waitpid(a, &st, WUNTRACED);
  printf("stopped: %d sig %d\n", w == a && WIFSTOPPED(st), WSTOPSIG(st));
  w = waitpid(b, &st, WUNTRACED);
  printf("both stopped: %d\n", w == b && WIFSTOPPED(st));
  printf("said once: %d\n", waitpid(a, &st, WUNTRACED | WNOHANG));
  kill(-a, SIGCONT);
  w = waitpid(a, &st, WCONTINUED);
  printf("continued: %d\n", w == a && WIFCONTINUED(st));
  waitpid(b, &st, WCONTINUED);
  printf("SIGCHLD said it: %d\n", chld >= 1);

  kill(-a, SIGTERM);
  int ended = 0;
  for (int k = 0; k < 2; k++) { w = wait(&st); if (WIFSIGNALED(st) && WTERMSIG(st) == SIGTERM) ended++; }
  printf("group ended by TERM: %d, then no child: %d %s\n", ended, wait(&st), strerror(errno));

  // waitid with WNOWAIT leaves the zombie for wait.
  pid_t c = fork();
  if (c == 0) _exit(6);
  siginfo_t si = {0};
  waitid(P_PID, c, &si, WEXITED | WNOWAIT);
  printf("waitid: pid %d code exited %d status %d\n", si.si_pid == c, si.si_code == CLD_EXITED, si.si_status);
  printf("still there for wait: %d\n", waitpid(c, &st, 0) == c && WEXITSTATUS(st) == 6);

  // setsid: a group leader may not, a child may, and leads a new session.
  printf("leader setsid: %d\n", getpgrp() == getpid() ? setsid() : -1);
  c = fork();
  if (c == 0) {
    pid_t s = setsid();
    _exit(s == getpid() && getsid(0) == getpid() && getpgrp() == getpid() ? 0 : 1);
  }
  waitpid(c, &st, 0);
  printf("child setsid: %d\n", WEXITSTATUS(st) == 0);

  // An orphan's parent is init: its getppid changes once the middle one ends.
  int p[2];
  pipe(p);
  c = fork();
  if (c == 0) {
    pid_t g = fork();
    if (g == 0) {
      usleep(100000);
      char ok = getppid() != c ? 'y' : 'n';
      write(p[1], &ok, 1);
      _exit(0);
    }
    _exit(0);
  }
  waitpid(c, 0, 0);
  close(p[1]);
  char ok = '?';
  read(p[0], &ok, 1);
  printf("orphan reparented: %c\n", ok);

  // A parent that ignores SIGCHLD leaves no zombies: wait has none to give.
  signal(SIGCHLD, SIG_IGN);
  c = fork();
  if (c == 0) _exit(0);
  usleep(50000);
  errno = 0;
  int none = waitpid(c, &st, 0);
  printf("no zombie: %d %s\n", none, strerror(errno));
  return 0;
}
