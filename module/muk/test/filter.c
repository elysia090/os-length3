/* The mandatory policy installed on this process: no namespaces or privileged calls are needed. */
#define UNIT "muk-filter"
#include "../../lib/io.h"
#include "../src/filter.h"
static int main_(int argc, char **argv, char **envp) {
  (void)argc; (void)argv; (void)envp;
  struct bpf made[6 + 4 * FILTERED];
  u32 count = filter_program(made);
  struct { u16 len; struct bpf *filter; } program = {(u16)count, made};
  if (count > sizeof made / sizeof made[0]) fail("filter: ", "too long");
  if (sys6(SYS_prctl, 38, 1, 0, 0, 0, 0) < 0 || sys3(SYS_seccomp, 1, 0, (i64)&program) < 0) fail("filter: ", "not installed");
  if (sys1(SYS_getpid, 0) <= 0) fail("getpid: ", "not allowed");
  if (sys3(SYS_ioctl, -1, 0x5412, 0) != -EPERM) fail("TIOCSTI: ", "not refused before the fd is checked");
  if (sys3(SYS_ioctl, -1, 0x541c, 0) != -EPERM) fail("TIOCLINUX: ", "not refused");
  if (sys3(SYS_socket, 40, 1, 0) != -EAFNOSUPPORT) fail("AF_VSOCK: ", "not refused");
  if (sys1(SYS_clone3, 0) != -ENOSYS || sys1(999999, 0) != -ENOSYS) fail("new calls: ", "not refused");
  if (sys1(SYS_unshare, CLONE_NEWNS) != -EPERM) fail("unshare: ", "not refused");
  put_line("ok mandatory filter", 19); flush(); return 0;
}
