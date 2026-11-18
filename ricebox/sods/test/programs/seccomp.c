// What a thread puts over its own calls (seccomp(2)): a filter read and checked as the kernel checks one, asked of
// every call it and what it starts make, the answer that allows least holding; strict mode; and what each answer
// does (an errno, a signal that says which call, the thread or the process ended). The same here as on Linux.
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

struct insn { uint16_t code; uint8_t jt, jf; uint32_t k; };
struct prog { uint16_t len; struct insn *filter; };
#define LD_ABS 0x20
#define JEQ 0x15
#define RET 0x06
#define ALLOW 0x7fff0000u
#define ERRNO(e) (0x00050000u | (e))
#define TRAP(d) (0x00030000u | (d))
#define KILL_THREAD 0x00000000u
#define KILL_PROCESS 0x80000000u
#define N(a) (sizeof(a) / sizeof((a)[0]))

static long set(struct insn *filter, unsigned n, unsigned flags) {
  struct prog p = {(uint16_t)n, filter};
  return syscall(SYS_seccomp, 1, flags, &p);
}
static const char *said(long r) { static char b[32]; if (r >= 0) snprintf(b, sizeof b, "%ld", r); else snprintf(b, sizeof b, "errno %d", errno); return b; }
/** One call answered by `action`, every other allowed. */
#define ONE(nr, action) {LD_ABS, 0, 0, 0}, {JEQ, 0, 1, (nr)}, {RET, 0, 0, (action)}, {RET, 0, 0, ALLOW}

/** `run` in a child of its own; how the child ended. */
static void child(const char *what, void (*run)(void)) {
  fflush(stdout);
  pid_t pid = fork();
  if (!pid) { run(); fflush(stdout); _exit(0); }
  int status = 0;
  waitpid(pid, &status, 0);
  if (WIFSIGNALED(status)) printf("%s: ended by signal %d\n", what, WTERMSIG(status));
  else printf("%s: exit %d\n", what, WEXITSTATUS(status));
}

static void refused(void) {
  struct insn ok[] = {{RET, 0, 0, ALLOW}};
  struct insn jump[] = {{JEQ, 5, 0, 1}, {RET, 0, 0, ALLOW}};
  struct insn open_end[] = {{LD_ABS, 0, 0, 0}};
  struct insn unwritten[] = {{0x60, 0, 0, 3}, {RET, 0, 0, ALLOW}};
  struct insn written[] = {{0x00, 0, 0, 7}, {0x02, 0, 0, 3}, {0x60, 0, 0, 3}, {RET, 0, 0, ALLOW}};
  struct insn one_way[] = {{LD_ABS, 0, 0, 0}, {JEQ, 0, 1, 1}, {0x02, 0, 0, 2}, {0x60, 0, 0, 2}, {RET, 0, 0, ALLOW}};
  struct insn unaligned[] = {{LD_ABS, 0, 0, 3}, {RET, 0, 0, ALLOW}};
  struct insn past[] = {{LD_ABS, 0, 0, 64}, {RET, 0, 0, ALLOW}};
  struct insn last_word[] = {{LD_ABS, 0, 0, 60}, {RET, 0, 0, ALLOW}};
  struct insn byte[] = {{0x30, 0, 0, 0}, {RET, 0, 0, ALLOW}};
  struct insn remainder[] = {{0x94, 0, 0, 2}, {RET, 0, 0, ALLOW}};
  struct insn by_nothing[] = {{0x34, 0, 0, 0}, {RET, 0, 0, ALLOW}};
  struct insn far_word[] = {{0x02, 0, 0, 16}, {RET, 0, 0, ALLOW}};
  struct insn shifted[] = {{0x64, 0, 0, 32}, {RET, 0, 0, ALLOW}};
  struct prog none = {0, ok};
  printf("no instructions: %s\n", said(syscall(SYS_seccomp, 1, 0, &none)));
  printf("a jump past its end: %s\n", said(set(jump, N(jump), 0)));
  printf("no answer at its end: %s\n", said(set(open_end, N(open_end), 0)));
  printf("a word read before it is written: %s\n", said(set(unwritten, N(unwritten), 0)));
  printf("a word written on one way only: %s\n", said(set(one_way, N(one_way), 0)));
  printf("a call's word not at a word: %s\n", said(set(unaligned, N(unaligned), 0)));
  printf("a word past what is shown of a call: %s\n", said(set(past, N(past), 0)));
  printf("a byte of a call: %s\n", said(set(byte, N(byte), 0)));
  printf("a remainder: %s\n", said(set(remainder, N(remainder), 0)));
  printf("divided by nothing: %s\n", said(set(by_nothing, N(by_nothing), 0)));
  printf("a seventeenth word: %s\n", said(set(far_word, N(far_word), 0)));
  printf("shifted by 32: %s\n", said(set(shifted, N(shifted), 0)));
  printf("no filter given: %s\n", said(syscall(SYS_seccomp, 1, 0, 0)));
  printf("a flag no kernel has: %s\n", said(set(ok, N(ok), 1u << 30)));
  printf("an operation no kernel has: %s\n", said(syscall(SYS_seccomp, 99, 0, 0)));
  printf("strict mode with a flag: %s\n", said(syscall(SYS_seccomp, 0, 1, 0)));
  unsigned action = ALLOW;
  printf("ALLOW is answered: %s\n", said(syscall(SYS_seccomp, 2, 0, &action)));
  action = ERRNO(0);
  printf("ERRNO is answered: %s\n", said(syscall(SYS_seccomp, 2, 0, &action)));
  action = 0x12340000;
  printf("an action no kernel has: %s\n", said(syscall(SYS_seccomp, 2, 0, &action)));
  printf("mode before any: %d\n", prctl(PR_GET_SECCOMP));
  // (and those that are taken, which then allow everything)
  printf("its last word: %s\n", said(set(last_word, N(last_word), 0)));
  printf("a word written, then read: %s\n", said(set(written, N(written), 0)));
  printf("mode with filters: %d\n", prctl(PR_GET_SECCOMP));
}

static void status(void) {
  char line[256];
  FILE *f = fopen("/proc/self/status", "r");
  while (f && fgets(line, sizeof line, f)) if (!strncmp(line, "Seccomp", 7) || !strncmp(line, "NoNewPrivs", 10)) fputs(line, stdout);
  if (f) fclose(f);
}

static void answers(void) {
  struct insn first[] = {ONE(SYS_getppid, ERRNO(EPERM))};
  // (the uid asked for is 0 and no other: refused by what it is asked)
  struct insn by_argument[] = {{LD_ABS, 0, 0, 0}, {JEQ, 0, 3, SYS_setuid}, {LD_ABS, 0, 0, 16}, {JEQ, 0, 1, 12345}, {RET, 0, 0, ERRNO(E2BIG)}, {RET, 0, 0, ALLOW}};
  struct insn nothing[] = {ONE(SYS_getpgrp, ERRNO(0))};
  struct insn clock[] = {ONE(SYS_clock_gettime, ERRNO(EPERM))};
  // (write, which what is printed here does not go by: it is gathered and goes by writev)
  struct insn written[] = {ONE(SYS_write, ERRNO(EBADF))};
  printf("a first filter: %s\n", said(set(first, N(first), 0)));
  printf("getppid: %s\n", said(syscall(SYS_getppid)));
  printf("getpid is still asked: %s\n", syscall(SYS_getpid) > 0 ? "yes" : "no");
  printf("a second: %s\n", said(set(by_argument, N(by_argument), 0)));
  printf("setuid(12345): %s\n", said(syscall(SYS_setuid, 12345)));
  printf("getppid, under both: %s\n", said(syscall(SYS_getppid)));
  // The same call answered by two: the one that allows least; of two that allow the same, the later.
  struct insn later[] = {ONE(SYS_getppid, ERRNO(ENOSYS))};
  struct insn allows[] = {ONE(SYS_getppid, ALLOW)};
  set(later, N(later), 0);
  printf("getppid, the later of two errnos: %s\n", said(syscall(SYS_getppid)));
  set(allows, N(allows), 0);
  printf("getppid, a later filter allowing it: %s\n", said(syscall(SYS_getppid)));
  set(nothing, N(nothing), 0);
  printf("an errno of 0: %s\n", said(syscall(SYS_getpgrp)));
  // What is answered without the kernel where there is no filter is asked of it where there is one.
  struct timespec now;
  set(clock, N(clock), 0);
  printf("the clock, by the call: %s\n", said(syscall(SYS_clock_gettime, CLOCK_MONOTONIC, &now)));
  fflush(stdout);
  set(written, N(written), 0);
  printf("write to what it writes to: %s\n", said(syscall(SYS_write, 1, "not written\n", 12)));
  status();
  fflush(stdout);
  pid_t pid = fork();
  if (!pid) { printf("in a child, getppid: %s\n", said(syscall(SYS_getppid))); fflush(stdout); _exit(0); }
  waitpid(pid, 0, 0);
}

static volatile int got_signo, got_code, got_errno, got_syscall;
static volatile unsigned got_arch;
static void on_sys(int sig, siginfo_t *info, void *context) {
  (void)context;
  got_signo = sig, got_code = info->si_code, got_errno = info->si_errno;
  got_syscall = info->si_syscall, got_arch = info->si_arch;
}
static void trapped(void) {
  struct insn trap[] = {ONE(SYS_getppid, TRAP(77))};
  struct sigaction a = {0};
  a.sa_sigaction = on_sys, a.sa_flags = SA_SIGINFO;
  sigaction(SIGSYS, &a, 0);
  set(trap, N(trap), 0);
  long r = syscall(SYS_getppid);
  printf("trapped: it comes back with %ld (getppid is %d); signal %d code %d errno %d call %d machine %x\n", r, (int)SYS_getppid,
    got_signo, got_code, got_errno, got_syscall, got_arch);
}
static void trapped_untaken(void) {
  struct insn trap[] = {ONE(SYS_getppid, TRAP(0))};
  set(trap, N(trap), 0);
  syscall(SYS_getppid);
  printf("not reached\n");
}
static void killed_thread(void) {
  struct insn kill[] = {ONE(SYS_getppid, KILL_THREAD)};
  set(kill, N(kill), 0);
  syscall(SYS_getppid);
  printf("not reached\n");
}
static void killed_process(void) {
  struct insn kill[] = {ONE(SYS_getppid, KILL_PROCESS)};
  set(kill, N(kill), 0);
  syscall(SYS_getppid);
  printf("not reached\n");
}
static void unknown_action(void) {
  struct insn odd[] = {ONE(SYS_getppid, 0x12340000u)};
  set(odd, N(odd), 0);
  syscall(SYS_getppid);
  printf("not reached\n");
}
static void strict(void) {
  printf("strict: %s\n", said(prctl(PR_SET_SECCOMP, 1)));
  fflush(stdout);
  write(1, "strict: written\n", 16);
  syscall(SYS_getpid);
  write(1, "not reached\n", 12);
}
static void strict_then_filter(void) {
  struct insn ok[] = {{RET, 0, 0, ALLOW}};
  syscall(SYS_seccomp, 0, 0, 0);
  // (asked by the one call strict mode has no place for: it is ended)
  set(ok, N(ok), 0);
  write(1, "not reached\n", 12);
}

int main(void) {
  // One that can gain nothing by what it runs may set a filter, whoever it is.
  printf("no_new_privs: %s\n", said(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)));
  child("what is not a filter", refused);
  child("what a filter answers", answers);
  child("a signal that says which call", trapped);
  child("that signal, not taken", trapped_untaken);
  child("its thread ended", killed_thread);
  child("its process ended", killed_process);
  child("an action no kernel has", unknown_action);
  child("strict mode", strict);
  child("a filter asked in strict mode", strict_then_filter);
  // Nothing of a child's is this one's.
  printf("mode here: %d\n", prctl(PR_GET_SECCOMP));
  return 0;
}
