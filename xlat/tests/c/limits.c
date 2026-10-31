// Resource limits, as ulimit and programs that raise or lower them use them: the descriptor limit held (no open, dup
// or socket at or past it), a soft limit above its hard refused, a child keeping its parent's, prlimit of itself.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

static void said(const char *what, long r) { printf("%s: %ld %s\n", what, r, r < 0 ? strerror(errno) : "-"); }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  struct rlimit was, r;
  getrlimit(RLIMIT_NOFILE, &was);
  printf("stack soft is 8 MiB or more: %d\n", getrlimit(RLIMIT_STACK, &r) == 0 && (r.rlim_cur == RLIM_INFINITY || r.rlim_cur >= 8 << 20));
  // Lowered to 16: descriptors up to 15 open, then EMFILE.
  r.rlim_cur = 16; r.rlim_max = was.rlim_max;
  said("lower to 16", setrlimit(RLIMIT_NOFILE, &r));
  int n = 0, fd;
  while ((fd = open("/dev/null", O_RDONLY)) >= 0) n = fd;
  printf("last opened: %d, then %s\n", n, strerror(errno));
  said("dup2 to 16", dup2(0, 16));
  said("dup2 to 15", dup2(0, 15));
  said("fcntl F_DUPFD from 16", fcntl(0, F_DUPFD, 16));
  for (int k = 3; k <= 15; k++) close(k);
  said("pipe after closing", pipe((int[2]){0}));
  // A child has its parent's.
  pid_t pid = fork();
  if (pid == 0) { struct rlimit c; getrlimit(RLIMIT_NOFILE, &c); printf("child's soft: %ld\n", (long)c.rlim_cur); _exit(0); }
  waitpid(pid, 0, 0);
  // A soft limit above its hard: EINVAL; lowering the hard: then raising it back is not allowed of anyone without the
  // capability, but root has it (not asked here).
  r.rlim_cur = 32; r.rlim_max = 16;
  said("soft above hard", setrlimit(RLIMIT_NOFILE, &r));
  struct rlimit old;
  r.rlim_cur = 20; r.rlim_max = was.rlim_max;
  said("prlimit of itself", prlimit(0, RLIMIT_NOFILE, &r, &old));
  printf("its old soft: %ld\n", (long)old.rlim_cur);
  getrlimit(RLIMIT_NOFILE, &r);
  printf("now: %ld\n", (long)r.rlim_cur);
  said("prlimit of no one", prlimit(99999, RLIMIT_NOFILE, 0, &old));
  said("an unknown resource", getrlimit(99, &r));
  return 0;
}
