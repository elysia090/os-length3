// openat2(2): an open that says how its path is walked. One that leads nowhere out of where it starts (BENEATH),
// one whose start is its root (IN_ROOT), no link followed, none that leads to what something holds, nothing mounted
// crossed; and what it may not ask said, not passed over. muk opens what a bundle names by it, so that a path
// config.json wrote leads nowhere but the bundle. The same here as on Linux.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_openat2
#define SYS_openat2 437
#endif
struct how { uint64_t flags, mode, resolve; };
enum { NO_XDEV = 1, NO_MAGICLINKS = 2, NO_SYMLINKS = 4, BENEATH = 8, IN_ROOT = 16, CACHED = 32 };

static int dir;
/** `path` opened from `from` as `resolve` says: what was read of it, or its errno. */
static void asks(const char *what, int from, const char *path, uint64_t flags, uint64_t resolve) {
  struct how how = {flags, flags & O_CREAT ? 0644 : 0, resolve};
  long fd = syscall(SYS_openat2, from, path, &how, sizeof how);
  if (fd < 0) { printf("%s: %s: errno %d\n", what, path, errno); return; }
  char text[16] = "";
  long n = flags & O_PATH || flags & O_DIRECTORY ? 0 : read((int)fd, text, sizeof text - 1);
  if (n > 0 && text[n - 1] == '\n') text[n - 1] = 0;
  printf("%s: %s: opened%s%s\n", what, path, n > 0 ? ", " : "", n > 0 ? text : "");
  close((int)fd);
}
static void put(const char *path, const char *text) {
  int fd = openat(dir, path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, text, strlen(text)) < 0) { perror(path); exit(1); }
  close(fd);
}

int main(void) {
  char top[] = "/tmp/openat2-XXXXXX";
  if (!mkdtemp(top)) { perror("mkdtemp"); return 1; }
  int up = open(top, O_RDONLY | O_DIRECTORY);
  mkdirat(up, "in", 0755);
  dir = openat(up, "in", O_RDONLY | O_DIRECTORY);
  mkdirat(dir, "sub", 0755);
  put("file", "inside\n");
  put("sub/deep", "deep\n");
  put("../outside", "outside\n");
  symlinkat("file", dir, "to-file");
  symlinkat("..", dir, "sub/up");
  symlinkat("../outside", dir, "to-outside");
  symlinkat("/etc/hostname-not-there", dir, "to-root");
  symlinkat("/file", dir, "from-root");
  symlinkat("loop", dir, "loop");

  // Nowhere out of where it starts.
  asks("beneath", dir, "file", O_RDONLY, BENEATH);
  asks("beneath", dir, "sub/../file", O_RDONLY, BENEATH);
  asks("beneath", dir, "sub/up/file", O_RDONLY, BENEATH);
  asks("beneath", dir, "to-file", O_RDONLY, BENEATH);
  asks("beneath", dir, "../outside", O_RDONLY, BENEATH);
  asks("beneath", dir, "sub/../../outside", O_RDONLY, BENEATH);
  asks("beneath", dir, "sub/up/../outside", O_RDONLY, BENEATH);
  asks("beneath", dir, "to-outside", O_RDONLY, BENEATH);
  asks("beneath", dir, "to-root", O_RDONLY, BENEATH);
  asks("beneath", dir, "/tmp", O_RDONLY | O_DIRECTORY, BENEATH);
  asks("beneath", dir, "..", O_RDONLY | O_DIRECTORY, BENEATH);
  asks("beneath", dir, ".", O_RDONLY | O_DIRECTORY, BENEATH);
  asks("beneath", dir, "nothing/there", O_RDONLY, BENEATH);
  asks("beneath", dir, "file/", O_RDONLY, BENEATH);
  asks("beneath", dir, "loop", O_RDONLY, BENEATH);
  asks("beneath", dir, "sub/made", O_WRONLY | O_CREAT, BENEATH);
  asks("beneath", dir, "sub/made", O_RDONLY, BENEATH);
  asks("beneath", dir, "../made-outside", O_WRONLY | O_CREAT, BENEATH);
  asks("beneath", AT_FDCWD, "/tmp", O_RDONLY | O_DIRECTORY, BENEATH);

  // Where it starts is its root.
  asks("in root", dir, "/file", O_RDONLY, IN_ROOT);
  asks("in root", dir, "../../../file", O_RDONLY, IN_ROOT);
  asks("in root", dir, "sub/../../file", O_RDONLY, IN_ROOT);
  asks("in root", dir, "from-root", O_RDONLY, IN_ROOT);
  asks("in root", dir, "to-outside", O_RDONLY, IN_ROOT);
  asks("in root", dir, "to-root", O_RDONLY, IN_ROOT);
  asks("in root", dir, "/", O_RDONLY | O_DIRECTORY, IN_ROOT);

  // No link followed; none that leads to what something holds; nothing mounted crossed.
  asks("no links", dir, "file", O_RDONLY, NO_SYMLINKS);
  asks("no links", dir, "to-file", O_RDONLY, NO_SYMLINKS);
  asks("no links", dir, "sub/up/file", O_RDONLY, NO_SYMLINKS);
  asks("no links", dir, "sub/../file", O_RDONLY, NO_SYMLINKS);
  asks("no magic links", dir, "to-file", O_RDONLY, NO_MAGICLINKS);
  asks("no magic links", AT_FDCWD, "/proc/self/exe", O_PATH, NO_MAGICLINKS);
  asks("no magic links", AT_FDCWD, "/proc/self/cwd", O_RDONLY | O_DIRECTORY, NO_MAGICLINKS);
  asks("no magic links", AT_FDCWD, "/proc/self/comm", O_PATH, NO_MAGICLINKS);
  asks("nothing crossed", dir, "sub/deep", O_RDONLY, NO_XDEV);
  asks("nothing crossed", AT_FDCWD, "/proc/self/comm", O_PATH, NO_XDEV);
  asks("no rule", dir, "sub/up/../outside", O_RDONLY, 0);
  asks("no rule", dir, "to-outside", O_RDONLY, 0);

  // What it may not ask.
  struct how how = {O_RDONLY, 0, 0};
  struct { struct how how; uint64_t more; } long_how = {{O_RDONLY, 0, 0}, 0};
  printf("two of its three words: errno %d\n", syscall(SYS_openat2, dir, "file", &how, 16) < 0 ? errno : 0);
  long fd = syscall(SYS_openat2, dir, "file", &long_how, sizeof long_how);
  printf("a fourth word that is nothing: %s\n", fd >= 0 ? "opened" : "refused");
  if (fd >= 0) close((int)fd);
  long_how.more = 1;
  printf("a fourth word that is something: errno %d\n", syscall(SYS_openat2, dir, "file", &long_how, sizeof long_how) < 0 ? errno : 0);
  how = (struct how){O_RDONLY | 1u << 30, 0, 0};
  printf("a flag no kernel has: errno %d\n", syscall(SYS_openat2, dir, "file", &how, sizeof how) < 0 ? errno : 0);
  how = (struct how){O_RDONLY, 0644, 0};
  printf("a mode where nothing is made: errno %d\n", syscall(SYS_openat2, dir, "file", &how, sizeof how) < 0 ? errno : 0);
  how = (struct how){O_WRONLY | O_CREAT, 010644, 0};
  printf("a mode that is more than a mode: errno %d\n", syscall(SYS_openat2, dir, "new", &how, sizeof how) < 0 ? errno : 0);
  how = (struct how){O_RDONLY, 0, 1u << 20};
  printf("a rule no kernel has: errno %d\n", syscall(SYS_openat2, dir, "file", &how, sizeof how) < 0 ? errno : 0);
  how = (struct how){O_RDONLY, 0, BENEATH | IN_ROOT};
  printf("beneath and in root at once: errno %d\n", syscall(SYS_openat2, dir, "file", &how, sizeof how) < 0 ? errno : 0);
  how = (struct how){O_PATH | O_RDWR, 0, 0};
  printf("a path alone, to write: errno %d\n", syscall(SYS_openat2, dir, "file", &how, sizeof how) < 0 ? errno : 0);
  how = (struct how){O_WRONLY | O_CREAT, 0644, CACHED};
  printf("made, without waiting: errno %d\n", syscall(SYS_openat2, dir, "new", &how, sizeof how) < 0 ? errno : 0);

  // (what was asked to be made outside was not)
  printf("made outside: %s\n", faccessat(up, "made-outside", F_OK, 0) ? "no" : "yes");
  // (what it made, taken away again)
  static const char *made[] = {"in/sub/made", "in/sub/deep", "in/sub/up", "in/file", "in/to-file", "in/to-outside", "in/to-root", "in/from-root", "in/loop", "outside"};
  for (unsigned i = 0; i < sizeof made / sizeof made[0]; i++) unlinkat(up, made[i], 0);
  unlinkat(up, "in/sub", AT_REMOVEDIR), unlinkat(up, "in", AT_REMOVEDIR);
  printf("taken away: %s\n", rmdir(top) ? "no" : "yes");
  return 0;
}
