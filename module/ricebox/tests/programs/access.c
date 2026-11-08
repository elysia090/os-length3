// access, faccessat and faccessat2 as root has them (xlat: root): reading and writing allowed whatever the mode,
// running only a directory or a file with some x bit; the at-flags (AT_EACCESS, AT_SYMLINK_NOFOLLOW, AT_EMPTY_PATH)
// and what is not one (EINVAL). A shell asks this before it runs a file: of a script of 0644, bash says "Permission
// denied", not "bad interpreter".
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void say(const char *what, long r) { printf("%-28s %s\n", what, r == 0 ? "yes" : strerror(errno)); }
static long faccessat2(int dirfd, const char *path, int mode, int flags) { return syscall(SYS_faccessat2, dirfd, path, mode, flags); }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  mkdir("/tmp/xlat-access", 0755);
  const char *files[] = {"/tmp/xlat-access/rw", "/tmp/xlat-access/x", "/tmp/xlat-access/none", "/tmp/xlat-access/gx"};
  int modes[] = {0644, 0755, 0000, 0610};
  for (int i = 0; i < 4; i++) {
    close(open(files[i], O_CREAT | O_WRONLY | O_TRUNC, 0600));
    chmod(files[i], modes[i]);
  }
  mkdir("/tmp/xlat-access/shut", 0000);
  chmod("/tmp/xlat-access/shut", 0000);
  const char *names[] = {"rw (0644)", "x (0755)", "none (0000)", "gx (0610)", "shut (dir 0000)"};
  const char *paths[] = {files[0], files[1], files[2], files[3], "/tmp/xlat-access/shut"};
  for (int i = 0; i < 5; i++) {
    char what[64];
    const int ask[] = {F_OK, R_OK, W_OK, X_OK, R_OK | W_OK | X_OK};
    const char *as[] = {"F", "R", "W", "X", "RWX"};
    for (int k = 0; k < 5; k++) { snprintf(what, sizeof what, "%s %s", names[i], as[k]); say(what, access(paths[i], ask[k])); }
  }
  say("missing F", access("/tmp/xlat-access/missing", F_OK));
  int dir = open("/tmp/xlat-access", O_RDONLY | O_DIRECTORY);
  say("faccessat rw X", faccessat(dir, "rw", X_OK, 0));
  say("faccessat x X", faccessat(dir, "x", X_OK, 0));
  say("faccessat2 x X eaccess", faccessat2(dir, "x", X_OK, AT_EACCESS));
  symlink("/tmp/xlat-access/nowhere", "/tmp/xlat-access/dangling");
  say("dangling F", access("/tmp/xlat-access/dangling", F_OK));
  say("dangling F nofollow", faccessat2(dir, "dangling", F_OK, AT_SYMLINK_NOFOLLOW));
  int fx = open(files[1], O_RDONLY), frw = open(files[0], O_RDONLY);
  say("empty path, x's fd X", faccessat2(fx, "", X_OK, AT_EMPTY_PATH));
  say("empty path, rw's fd X", faccessat2(frw, "", X_OK, AT_EMPTY_PATH));
  say("mode 8", access(files[0], 8));
  say("flags 0x4", faccessat2(dir, "rw", F_OK, 0x4));
  for (int i = 0; i < 4; i++) unlink(files[i]);
  unlink("/tmp/xlat-access/dangling");
  rmdir("/tmp/xlat-access/shut");
  rmdir("/tmp/xlat-access");
  return 0;
}
