// Local sockets (AF_UNIX), as programs use them: socketpair of each type, a server on a path and one in the
// abstract namespace, descriptors passed (SCM_RIGHTS), the peer's credentials, shutdown, poll, and the errors a
// program meets (a peer gone, nothing listening, nothing yet to accept).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static void stream_pair(void) {
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv)) { perror("socketpair"); return; }
  write(sv[0], "hello ", 6); write(sv[0], "world", 5);
  char b[64] = {0};
  ssize_t n = read(sv[1], b, sizeof b);
  printf("stream: %zd \"%s\"\n", n, b);
  // Both ways, then the end once the writer shuts its side.
  write(sv[1], "back", 4);
  n = recv(sv[0], b, sizeof b, 0);
  printf("stream back: %zd %.4s\n", n, b);
  shutdown(sv[0], SHUT_WR);
  printf("after shutdown: %zd\n", read(sv[1], b, sizeof b));
  struct pollfd p = {sv[1], POLLIN | POLLOUT, 0};
  poll(&p, 1, 0);
  printf("poll: in %d out %d\n", !!(p.revents & POLLIN), !!(p.revents & POLLOUT));
  close(sv[0]);
  // The reader gone: EPIPE, without SIGPIPE when asked.
  n = send(sv[1], "x", 1, MSG_NOSIGNAL);
  printf("send to closed: %zd %s\n", n, strerror(errno));
  close(sv[1]);
}

static void message_pairs(void) {
  int types[] = {SOCK_DGRAM, SOCK_SEQPACKET};
  for (int k = 0; k < 2; k++) {
    int sv[2];
    if (socketpair(AF_UNIX, types[k], 0, sv)) { perror("socketpair"); continue; }
    send(sv[0], "one", 3, 0); send(sv[0], "two!", 4, 0); send(sv[0], "a longer one", 12, 0);
    char b[8];
    for (int i = 0; i < 3; i++) {
      ssize_t n = recv(sv[1], b, 6, MSG_TRUNC);
      printf("%s %d: %zd %.*s\n", k ? "seqpacket" : "dgram", i, n, n < 6 ? (int)n : 6, b);
    }
    int flags = fcntl(sv[1], F_GETFL);
    fcntl(sv[1], F_SETFL, flags | O_NONBLOCK);
    ssize_t n = recv(sv[1], b, sizeof b, 0);
    printf("%s empty: %zd %s\n", k ? "seqpacket" : "dgram", n, strerror(errno));
    close(sv[0]); close(sv[1]);
  }
}

static void across_fork(void) {
  int sv[2];
  socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
  pid_t pid = fork();
  if (pid == 0) {
    close(sv[0]);
    char b[32]; ssize_t n = read(sv[1], b, sizeof b);
    for (ssize_t i = 0; i < n; i++) b[i] = b[i] >= 'a' && b[i] <= 'z' ? b[i] - 32 : b[i];
    write(sv[1], b, n);
    _exit(0);
  }
  close(sv[1]);
  write(sv[0], "child, shout", 12);
  char b[32] = {0};
  ssize_t n = read(sv[0], b, sizeof b);
  waitpid(pid, 0, 0);
  printf("fork: %zd %s\n", n, b);
  close(sv[0]);
}

static void server(const char *how, struct sockaddr_un *a, socklen_t len) {
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  if (bind(s, (struct sockaddr *)a, len)) { printf("%s bind: %s\n", how, strerror(errno)); return; }
  listen(s, 4);
  int other = socket(AF_UNIX, SOCK_STREAM, 0);
  int again = bind(other, (struct sockaddr *)a, len);
  printf("%s bind again: %d %s\n", how, again, strerror(errno));
  close(other);
  fcntl(s, F_SETFL, O_NONBLOCK);
  int none = accept(s, 0, 0);
  printf("%s accept, none yet: %d %s\n", how, none, strerror(errno));
  pid_t pid = fork();
  if (pid == 0) {
    int c = socket(AF_UNIX, SOCK_STREAM, 0);
    if (connect(c, (struct sockaddr *)a, len)) { printf("connect: %s\n", strerror(errno)); _exit(1); }
    write(c, "ping", 4);
    char b[8] = {0}; read(c, b, sizeof b);
    printf("%s client got %s\n", how, b);
    _exit(0);
  }
  struct pollfd p = {s, POLLIN, 0};
  poll(&p, 1, 5000);
  int c = accept4(s, 0, 0, SOCK_CLOEXEC);
  char b[8] = {0}; read(c, b, sizeof b);
  struct ucred cred; socklen_t cl = sizeof cred;
  getsockopt(c, SOL_SOCKET, SO_PEERCRED, &cred, &cl);
  printf("%s server got %s from its child: %d\n", how, b, cred.pid == pid);
  write(c, "pong", 4);
  waitpid(pid, 0, 0);
  struct sockaddr_un me; socklen_t ml = sizeof me;
  getsockname(s, (struct sockaddr *)&me, &ml);
  int named = (int)(ml - sizeof(sa_family_t));
  printf("%s name: %d %.*s\n", how, named, me.sun_path[0] ? named - 1 : named - 1, me.sun_path[0] ? me.sun_path : me.sun_path + 1);
  close(c); close(s);
}

static void named(void) {
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  snprintf(a.sun_path, sizeof a.sun_path, "/tmp/muk-sockets-test");
  unlink(a.sun_path);
  server("path", &a, sizeof a);
  struct stat st;
  printf("path is a socket: %d\n", stat(a.sun_path, &st) == 0 && S_ISSOCK(st.st_mode));
  // Bound by a socket now closed: there is no one to connect to.
  int c = socket(AF_UNIX, SOCK_STREAM, 0);
  int r = connect(c, (struct sockaddr *)&a, sizeof a);
  printf("connect to closed: %d %s\n", r, strerror(errno));
  close(c);
  unlink(a.sun_path);
  struct sockaddr_un b = {.sun_family = AF_UNIX};
  memcpy(b.sun_path + 1, "muk-abstract", 13);
  server("abstract", &b, sizeof(sa_family_t) + 14);
}

static void rights(void) {
  int sv[2], pp[2];
  socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
  pipe(pp);
  char data = 'r';
  struct iovec io = {&data, 1};
  union { char buf[CMSG_SPACE(sizeof(int))]; struct cmsghdr align; } u;
  struct msghdr m = {.msg_iov = &io, .msg_iovlen = 1, .msg_control = u.buf, .msg_controllen = sizeof u.buf};
  struct cmsghdr *c = CMSG_FIRSTHDR(&m);
  c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(c), &pp[1], sizeof(int));
  printf("sendmsg: %zd\n", sendmsg(sv[0], &m, 0));
  close(pp[1]);
  char got;
  struct iovec in = {&got, 1};
  union { char buf[CMSG_SPACE(sizeof(int))]; struct cmsghdr align; } v;
  struct msghdr r = {.msg_iov = &in, .msg_iovlen = 1, .msg_control = v.buf, .msg_controllen = sizeof v.buf};
  ssize_t n = recvmsg(sv[1], &r, 0);
  printf("recvmsg: %zd %c\n", n, got);
  struct cmsghdr *rc = CMSG_FIRSTHDR(&r);
  int fd = -1;
  if (rc && rc->cmsg_type == SCM_RIGHTS) memcpy(&fd, CMSG_DATA(rc), sizeof fd);
  // The pipe's write end, come through the socket: what it writes, the read end reads.
  write(fd, "through", 7);
  close(fd);
  char b[16] = {0};
  n = read(pp[0], b, sizeof b);
  printf("passed descriptor wrote: %zd %s\n", n, b);
  close(pp[0]); close(sv[0]); close(sv[1]);
}

int main(void) {
  // Written as it is said: a forked child's lines are its own, not a copy of what its parent had not written yet.
  setvbuf(stdout, 0, _IONBF, 0);
  signal(SIGPIPE, SIG_IGN);
  stream_pair();
  message_pairs();
  across_fork();
  named();
  rights();
  return 0;
}
