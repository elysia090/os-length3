/*
 * The one who takes a box's terminal's other end, for muk's test (muk.sh): it listens at a socket, takes the one
 * descriptor sent there (as an OCI runtime sends a console's: muk, and runc beside it), and writes down what the
 * terminal shows until the box is done with it. On lib, with no C library.
 *
 *   console SOCKET
 */
#define UNIT "console"
#include "../../../lib/io.h"

enum { SYS_socket = 41, SYS_accept = 43, SYS_recvmsg = 47, SYS_bind = 49, SYS_listen = 50 };

static int main_(int argc, char **argv, char **envp) {
  (void)envp;
  if (argc != 2) fail("usage: ", "console SOCKET");
  struct { u16 family; char path[108]; } at = {1 /* AF_UNIX */, {0}};
  u64 n = slen(argv[1]);
  if (n >= sizeof at.path) fail("the socket's path is too long: ", argv[1]);
  __builtin_memcpy(at.path, argv[1], n);
  i64 heard = sys3(SYS_socket, 1, 1 /* SOCK_STREAM */, 0);
  if (heard < 0 || sys3(SYS_bind, heard, (i64)&at, (i64)(2 + n + 1)) < 0 || sys2(SYS_listen, heard, 1) < 0) fail("no socket at ", argv[1]);
  i64 from = sys3(SYS_accept, heard, 0, 0);
  if (from < 0) fail("no one came to ", argv[1]);
  enum { SHOWN = 4096 };
  u8 name[256], *shown = grab(SHOWN);
  struct { u64 len; int level, type, fd, pad; } rights = {0, 0, 0, -1, 0};
  struct { void *base; u64 len; } said = {name, sizeof name};
  struct { void *name; u32 name_len; void *said; u64 saids; void *control; u64 control_len; int flags; } message = {0, 0, &said, 1, &rights, sizeof rights, 0};
  if (sys3(SYS_recvmsg, from, (i64)&message, 0) < 0 || rights.len < 20 || rights.level != 1 || rights.type != 1 || rights.fd < 0)
    fail("no descriptor was sent to ", argv[1]);
  for (i64 r; (r = sys3(SYS_read, rights.fd, (i64)shown, SHOWN)) > 0;) sys3(SYS_write, 1, (i64)shown, r);
  return 0;
}
