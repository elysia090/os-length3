// Niceness and the room a file takes, as nice, renice, top and du read them: getpriority and setpriority of the
// process itself, its group and its user, a child taking its parent's, a niceness past 19 taken to 19, the wrong
// `which` and a process that is not there refused; and st_blocks, whole 4 KiB blocks of 512-byte units.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void said(const char *what, long r) { printf("%s: %ld %s\n", what, r, r < 0 ? strerror(errno) : "-"); }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  errno = 0;
  said("nice at start", getpriority(PRIO_PROCESS, 0));
  said("set 5", setpriority(PRIO_PROCESS, 0, 5));
  said("is 5", getpriority(PRIO_PROCESS, getpid()));
  pid_t pid = fork();
  if (pid == 0) { printf("child's: %d\n", getpriority(PRIO_PROCESS, 0)); _exit(0); }
  waitpid(pid, 0, 0);
  said("past 19", setpriority(PRIO_PROCESS, 0, 40));
  said("is 19", getpriority(PRIO_PROCESS, 0));
  said("group's", setpriority(PRIO_PGRP, 0, 7));
  said("group is 7", getpriority(PRIO_PGRP, 0));
  said("user's", getpriority(PRIO_USER, getuid()) >= -20);
  said("no such which", setpriority(9, 0, 1));
  said("no such process", setpriority(PRIO_PROCESS, 999999, 1));
  // A file of 5000 bytes takes two blocks of 4 KiB: 16 of 512 bytes; an empty one none.
  int fd = open("blocks.tmp", O_CREAT | O_TRUNC | O_WRONLY, 0600);
  char b[5000];
  memset(b, 'x', sizeof b);
  said("written", write(fd, b, sizeof b));
  fsync(fd);
  close(fd);
  struct stat st;
  stat("blocks.tmp", &st);
  printf("blocks of 5000 bytes: %ld\n", (long)st.st_blocks);
  truncate("blocks.tmp", 0);
  stat("blocks.tmp", &st);
  printf("blocks of none: %ld\n", (long)st.st_blocks);
  unlink("blocks.tmp");
  return 0;
}
