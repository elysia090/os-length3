// Signals delivered to handlers: siginfo and ucontext, the mask while a
// handler runs and after, SA_RESETHAND, sigaltstack, SA_RESTART against
// EINTR, sigsuspend, pending and blocked signals, a signal from another
// process, alarm, and a default action ending a child.
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <ucontext.h>
#include <unistd.h>

static volatile sig_atomic_t got, info_ok, nested, on_alt, code;
static volatile pid_t from;
static char altstack[65536];

static void plain(int sig) { got = sig; }

static void with_info(int sig, siginfo_t *si, void *uc) {
  ucontext_t *u = uc;
  got = sig;
  from = si->si_pid;
  code = si->si_code;
  // The interrupted mask is in the context; USR1 itself is blocked while this runs.
  sigset_t now;
  sigprocmask(SIG_BLOCK, 0, &now);
  info_ok = si->si_signo == sig && sigismember(&now, sig) && !sigismember(&u->uc_sigmask, sig);
}

static void on_stack(int sig) {
  char here;
  on_alt = &here >= altstack && &here < altstack + sizeof altstack;
  got = sig;
}

static void depth(int sig) {
  if (sig == SIGUSR1) { raise(SIGUSR2); nested = got == SIGUSR2; }
  else got = sig;
}

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  struct sigaction sa = {0};

  // A handler runs, and the program goes on after the call that raised it.
  signal(SIGUSR1, plain);
  raise(SIGUSR1);
  printf("plain handler: %d\n", got);

  // SA_SIGINFO: who sent it and how; the mask inside and outside.
  got = 0;
  sa.sa_sigaction = with_info;
  sa.sa_flags = SA_SIGINFO;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGUSR1, &sa, 0);
  kill(getpid(), SIGUSR1);
  printf("siginfo: sig %d from self %d code user %d masks %d\n", got, from == getpid(), code == SI_USER, info_ok);
  sigset_t after;
  sigprocmask(SIG_BLOCK, 0, &after);
  printf("mask restored after: %d\n", !sigismember(&after, SIGUSR1));

  // A handler that raises another: the second runs inside the first.
  got = 0;
  sa.sa_handler = depth;
  sa.sa_flags = 0;
  sigaction(SIGUSR1, &sa, 0);
  sigaction(SIGUSR2, &sa, 0);
  raise(SIGUSR1);
  printf("nested: %d\n", nested);

  // Blocked: pending until unblocked, then delivered once.
  got = 0;
  signal(SIGUSR2, plain);
  sigset_t block;
  sigemptyset(&block);
  sigaddset(&block, SIGUSR2);
  sigprocmask(SIG_BLOCK, &block, 0);
  raise(SIGUSR2);
  raise(SIGUSR2);
  sigset_t pend;
  sigpending(&pend);
  printf("blocked: got %d pending %d\n", got, sigismember(&pend, SIGUSR2));
  sigprocmask(SIG_UNBLOCK, &block, 0);
  printf("unblocked: got %d\n", got);

  // SA_RESETHAND: once, then the default (which here is to ignore SIGWINCH).
  got = 0;
  sa.sa_handler = plain;
  sa.sa_flags = SA_RESETHAND;
  sigaction(SIGWINCH, &sa, 0);
  raise(SIGWINCH);
  struct sigaction now;
  sigaction(SIGWINCH, 0, &now);
  printf("resethand: got %d now default %d\n", got, now.sa_handler == SIG_DFL);

  // sigaltstack and SA_ONSTACK.
  stack_t ss = {.ss_sp = altstack, .ss_size = sizeof altstack, .ss_flags = 0};
  sigaltstack(&ss, 0);
  sa.sa_handler = on_stack;
  sa.sa_flags = SA_ONSTACK;
  sigaction(SIGUSR1, &sa, 0);
  raise(SIGUSR1);
  stack_t old;
  sigaltstack(0, &old);
  printf("altstack: on it %d flags after %d\n", on_alt, old.ss_flags);

  // A read interrupted: EINTR without SA_RESTART, made again with it.
  int p[2];
  pipe(p);
  for (int restart = 0; restart < 2; restart++) {
    got = 0;
    sa.sa_handler = plain;
    sa.sa_flags = restart ? SA_RESTART : 0;
    sigaction(SIGALRM, &sa, 0);
    pid_t writer = fork();
    if (writer == 0) { usleep(300000); write(p[1], "x", 1); _exit(0); }
    alarm(1);
    ualarm(100000, 0);
    char c;
    ssize_t n = read(p[0], &c, 1);
    printf("read restart=%d: n %zd errno %s got %d\n", restart, n, n < 0 ? strerror(errno) : "-", got);
    if (n < 0) read(p[0], &c, 1);
    alarm(0);
    waitpid(writer, 0, 0);
  }

  // sigsuspend: waits with a mask, returns EINTR after the handler, the old mask back.
  got = 0;
  sigprocmask(SIG_BLOCK, &block, 0);
  pid_t sender = fork();
  if (sender == 0) { usleep(100000); kill(getppid(), SIGUSR2); _exit(0); }
  sigset_t empty;
  sigemptyset(&empty);
  int r = sigsuspend(&empty);
  sigprocmask(SIG_BLOCK, 0, &after);
  printf("sigsuspend: %d %s got %d still blocked %d\n", r, strerror(errno), got, sigismember(&after, SIGUSR2));
  waitpid(sender, 0, 0);
  sigprocmask(SIG_UNBLOCK, &block, 0);

  // Another process's signal, its pid in siginfo.
  got = 0;
  sa.sa_sigaction = with_info;
  sa.sa_flags = SA_SIGINFO;
  sigaction(SIGUSR1, &sa, 0);
  sigprocmask(SIG_BLOCK, &(sigset_t){0}, 0);
  pid_t child = fork();
  if (child == 0) { kill(getppid(), SIGUSR1); _exit(0); }
  while (!got) pause();
  printf("from child: %d\n", from == child);
  waitpid(child, 0, 0);

  // Default actions end a child, and its wait status says how.
  child = fork();
  if (child == 0) { signal(SIGTERM, SIG_DFL); raise(SIGTERM); _exit(1); }
  int st;
  waitpid(child, &st, 0);
  printf("child TERM: signaled %d sig %d\n", WIFSIGNALED(st), WTERMSIG(st));
  child = fork();
  if (child == 0) { pause(); _exit(1); }
  kill(child, SIGKILL);
  waitpid(child, &st, 0);
  printf("child KILL: sig %d\n", WTERMSIG(st));
  return 0;
}
