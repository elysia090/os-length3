// Calls a program makes of its files that the kernel answers as Linux does: sendfile, copy_file_range,
// fallocate, memfd_create, posix_fadvise, sync, preadv2 and pwritev2, personality.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/personality.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

static long size_of(int fd) { struct stat st; fstat(fd, &st); return (long)st.st_size; }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  const char *a = "/tmp/xlat-calls-a", *b = "/tmp/xlat-calls-b";
  int fa = open(a, O_RDWR | O_CREAT | O_TRUNC, 0644);
  for (int i = 0; i < 1000; i++) dprintf(fa, "line %04d\n", i);
  printf("written: %ld\n", size_of(fa));

  // sendfile: a file into a pipe, from an offset given (the file's own stays), then into another file.
  int pp[2]; pipe(pp);
  off_t at = 10;
  ssize_t n = sendfile(pp[1], fa, &at, 20);
  char buf[64] = {0};
  read(pp[0], buf, sizeof buf - 1);
  printf("sendfile to pipe: %zd, offset now %ld, \"%.19s\"\n", n, (long)at, buf);
  int fb = open(b, O_RDWR | O_CREAT | O_TRUNC, 0644);
  lseek(fa, 0, SEEK_SET);
  long total = 0;
  while ((n = sendfile(fb, fa, 0, 4096)) > 0) total += n;
  printf("sendfile to file: %ld, its offset %ld, the target %ld\n", total, (long)lseek(fa, 0, SEEK_CUR), size_of(fb));

  // copy_file_range: part of one file into another at an offset.
  off_t from = 100, to = 5;
  n = copy_file_range(fa, &from, fb, &to, 30, 0);
  pread(fb, buf, 40, 0);
  printf("copy_file_range: %zd, from %ld to %ld, \"%.35s\"\n", n, (long)from, (long)to, buf);

  // fallocate: room made (size grows, reads zero), kept size, a hole punched.
  int fc = open("/tmp/xlat-calls-c", O_RDWR | O_CREAT | O_TRUNC, 0644);
  write(fc, "abcdefghij", 10);
  printf("fallocate: %d size %ld\n", fallocate(fc, 0, 0, 4096), size_of(fc));
  printf("keep size: %d size %ld\n", fallocate(fc, FALLOC_FL_KEEP_SIZE, 0, 8192), size_of(fc));
  printf("punch: %d", fallocate(fc, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 2, 4));
  pread(fc, buf, 10, 0);
  printf(" then %d %d %d %d\n", buf[1], buf[2], buf[5], buf[6]);
  int r = fallocate(pp[0], 0, 0, 10);
  printf("fallocate a pipe: %d %s\n", r, strerror(errno));

  // memfd_create: a file in no directory, written, mapped, read back.
  int fm = memfd_create("xlat", MFD_CLOEXEC);
  write(fm, "memory file", 11);
  char *p = mmap(0, 4096, PROT_READ, MAP_SHARED, fm, 0);
  printf("memfd: %ld \"%.11s\" cloexec %d\n", size_of(fm), p, !!(fcntl(fm, F_GETFD) & FD_CLOEXEC));
  munmap(p, 4096);

  // Advice, and syncing: taken.
  printf("fadvise: %d, pipe %d\n", posix_fadvise(fa, 0, 0, POSIX_FADV_SEQUENTIAL), posix_fadvise(pp[0], 0, 0, POSIX_FADV_NORMAL));
  sync();
  printf("syncfs: %d, fdatasync %d\n", syncfs(fa), fdatasync(fa));

  // preadv2 and pwritev2 (by number: not every libc has them), at an offset and at the descriptor's own (-1).
  char x[6] = {0}, y[6] = {0};
  struct iovec two[2] = {{x, 5}, {y, 5}};
  n = syscall(SYS_preadv2, fa, two, 2, 10L, 0L, 0);
  printf("preadv2: %zd \"%s|%s\"\n", n, x, y);
  lseek(fb, 0, SEEK_SET);
  struct iovec one = {"NEW", 3};
  n = syscall(SYS_pwritev2, fb, &one, 1, -1L, 0L, 0);
  pread(fb, buf, 8, 0);
  printf("pwritev2 at its own offset: %zd, now %ld, \"%.8s\"\n", n, (long)lseek(fb, 0, SEEK_CUR), buf);

  printf("personality: %d\n", personality(0xffffffff));
  unlink(a); unlink(b); unlink("/tmp/xlat-calls-c");
  return 0;
}
