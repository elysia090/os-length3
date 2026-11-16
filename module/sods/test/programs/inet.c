// The loopback network, as servers and clients on one machine use it: TCP over 127.0.0.1 (a server and its client
// across fork, a large transfer, shutdown, a port taken, nothing listening, a connect that does not wait), UDP between
// two sockets and to a port no one holds, and the addresses each end is told. Ports are the system's to give (port
// 0), so none is printed, only whether it is what it should be.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static void said(const char *what, long r) { printf("%s: %ld %s\n", what, r, r < 0 ? strerror(errno) : "-"); }

static struct sockaddr_in at(const char *ip, int port) {
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(port)};
  inet_pton(AF_INET, ip, &a.sin_addr);
  return a;
}

static int port_of(int s) {
  struct sockaddr_in a; socklen_t l = sizeof a;
  getsockname(s, (struct sockaddr *)&a, &l);
  return ntohs(a.sin_port);
}

static const char *ip_of(struct sockaddr_in *a) { static char b[INET_ADDRSTRLEN]; return inet_ntop(AF_INET, &a->sin_addr, b, sizeof b); }

/** A listener on 127.0.0.1 at a port of the system's. */
static int listener(int *port) {
  int s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a = at("127.0.0.1", 0);
  bind(s, (struct sockaddr *)&a, sizeof a);
  listen(s, 8);
  *port = port_of(s);
  return s;
}

static void tcp(void) {
  int port, s = listener(&port);
  printf("listening, a port given: %d\n", port >= 1024);
  pid_t pid = fork();
  if (pid == 0) {
    int c = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = at("127.0.0.1", port);
    if (connect(c, (struct sockaddr *)&a, sizeof a)) { printf("connect: %s\n", strerror(errno)); _exit(1); }
    write(c, "ping", 4);
    char b[8] = {0}; read(c, b, sizeof b);
    // (Said once the server has said its part: the lines come in one order.)
    struct sockaddr_in peer; socklen_t pl = sizeof peer;
    getpeername(c, (struct sockaddr *)&peer, &pl);
    printf("client got %s; its peer %s, its port %d\n", b, ip_of(&peer), ntohs(peer.sin_port) == port);
    // A megabyte, then the end.
    static char big[1 << 20];
    for (int i = 0; i < (int)sizeof big; i++) big[i] = (char)(i * 7);
    for (size_t off = 0; off < sizeof big;) { ssize_t n = write(c, big + off, sizeof big - off); if (n <= 0) break; off += n; }
    shutdown(c, SHUT_WR);
    read(c, b, sizeof b);
    _exit(0);
  }
  struct sockaddr_in from; socklen_t fl = sizeof from;
  int c = accept(s, (struct sockaddr *)&from, &fl);
  printf("accepted from %s, length %d\n", ip_of(&from), (int)fl);
  struct sockaddr_in me; socklen_t ml = sizeof me;
  getsockname(c, (struct sockaddr *)&me, &ml);
  printf("its own: %s, the listener's port %d\n", ip_of(&me), ntohs(me.sin_port) == port);
  int one = 1;
  said("TCP_NODELAY", setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one));
  char b[8] = {0}; read(c, b, 4);
  printf("server got %s\n", b);
  write(c, "pong", 4);
  static char got[1 << 20];
  size_t total = 0; ssize_t n;
  while ((n = read(c, got + total, sizeof got - total)) > 0) total += n;
  int same = total == sizeof got;
  for (size_t i = 0; same && i < total; i++) same = got[i] == (char)(i * 7);
  printf("server read %zu, as written %d, then %zd\n", total, same, n);
  close(c);
  waitpid(pid, 0, 0);

  // The port is the listener's: another bind is refused, even to the wildcard.
  int t = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a = at("127.0.0.1", port), any = at("0.0.0.0", port);
  said("bind it again", bind(t, (struct sockaddr *)&a, sizeof a));
  said("bind its wildcard", bind(t, (struct sockaddr *)&any, sizeof any));
  close(t);
  int type; socklen_t tl = sizeof type;
  getsockopt(s, SOL_SOCKET, SO_ACCEPTCONN, &type, &tl);
  printf("SO_ACCEPTCONN: %d\n", type);
  close(s);

  // No one at the port now: refused.
  int r = socket(AF_INET, SOCK_STREAM, 0);
  said("connect to no one", connect(r, (struct sockaddr *)&a, sizeof a));
  close(r);
  r = socket(AF_INET, SOCK_STREAM, 0);
  said("send unconnected", send(r, "x", 1, 0));
  struct sockaddr_in none; socklen_t nl = sizeof none;
  getsockname(r, (struct sockaddr *)&none, &nl);
  printf("unbound: %s:%d (%d)\n", ip_of(&none), ntohs(none.sin_port), (int)nl);
  close(r);
}

static void nonblocking(void) {
  int port, s = listener(&port);
  int c = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
  struct sockaddr_in a = at("127.0.0.1", port);
  said("connect, not waiting", connect(c, (struct sockaddr *)&a, sizeof a));
  struct pollfd p = {c, POLLOUT, 0};
  poll(&p, 1, 5000);
  int e = -1; socklen_t el = sizeof e;
  getsockopt(c, SOL_SOCKET, SO_ERROR, &e, &el);
  printf("then writable %d, SO_ERROR %d\n", !!(p.revents & POLLOUT), e);
  // Once (as Linux tells the end of a connect it did not wait for), then: connected already.
  said("connect again", connect(c, (struct sockaddr *)&a, sizeof a));
  said("and again", connect(c, (struct sockaddr *)&a, sizeof a));
  struct pollfd q = {s, POLLIN, 0};
  poll(&q, 1, 5000);
  printf("listener readable: %d\n", !!(q.revents & POLLIN));
  int d = accept4(s, 0, 0, SOCK_NONBLOCK);
  char b[4];
  said("read, nothing yet", read(d, b, sizeof b));
  close(d); close(c);
  fcntl(s, F_SETFL, O_NONBLOCK);
  said("accept, none", accept(s, 0, 0));
  close(s);
  // listen without bind: a port of its own.
  int l = socket(AF_INET, SOCK_STREAM, 0);
  listen(l, 1);
  printf("listen unbound, a port given: %d\n", port_of(l) >= 1024);
  close(l);
}

static void shared(void) {
  // Two sockets on one port: refused, unless both say SO_REUSEPORT.
  int one = 1, a = socket(AF_INET, SOCK_STREAM, 0), b = socket(AF_INET, SOCK_STREAM, 0);
  setsockopt(a, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
  setsockopt(b, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
  struct sockaddr_in x = at("127.0.0.1", 0);
  bind(a, (struct sockaddr *)&x, sizeof x);
  x.sin_port = htons(port_of(a));
  said("SO_REUSEPORT both", bind(b, (struct sockaddr *)&x, sizeof x));
  int c = socket(AF_INET, SOCK_STREAM, 0);
  said("a third without", bind(c, (struct sockaddr *)&x, sizeof x));
  close(a); close(b); close(c);
  // 127.0.0.2 is this machine's too.
  int d = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in two = at("127.0.0.2", 0);
  said("bind 127.0.0.2", bind(d, (struct sockaddr *)&two, sizeof two));
  close(d);
  said("socketpair AF_INET", socketpair(AF_INET, SOCK_STREAM, 0, (int[2]){0}));
}

static void udp(void) {
  int a = socket(AF_INET, SOCK_DGRAM, 0), b = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in x = at("127.0.0.1", 0);
  bind(a, (struct sockaddr *)&x, sizeof x);
  struct sockaddr_in to = at("127.0.0.1", port_of(a));
  said("sendto", sendto(b, "first", 5, 0, (struct sockaddr *)&to, sizeof to));
  said("sendto", sendto(b, "second!", 7, 0, (struct sockaddr *)&to, sizeof to));
  char buf[16] = {0};
  struct sockaddr_in from; socklen_t fl = sizeof from;
  ssize_t n = recvfrom(a, buf, sizeof buf, 0, (struct sockaddr *)&from, &fl);
  printf("got %zd %.*s from %s, the sender's port %d\n", n, (int)n, buf, ip_of(&from), ntohs(from.sin_port) == port_of(b));
  n = recv(a, buf, 3, MSG_TRUNC);
  printf("cut: %zd %.3s\n", n, buf);
  // Connected: it sends to and takes from its peer alone.
  struct sockaddr_in back = at("127.0.0.1", port_of(b));
  said("connect", connect(a, (struct sockaddr *)&back, sizeof back));
  said("send", send(a, "reply", 5, 0));
  memset(buf, 0, sizeof buf);
  n = recv(b, buf, sizeof buf, 0);
  printf("b got %zd %s\n", n, buf);
  int c = socket(AF_INET, SOCK_DGRAM, 0);
  sendto(c, "stranger", 8, 0, (struct sockaddr *)&to, sizeof to);
  sendto(b, "peer", 4, 0, (struct sockaddr *)&to, sizeof to);
  memset(buf, 0, sizeof buf);
  n = recv(a, buf, sizeof buf, 0);
  printf("a, connected, got %zd %s\n", n, buf);
  close(c);
  // To a port no one holds: the send goes, the next call is refused.
  close(b);
  said("send to no one", send(a, "x", 1, 0));
  said("recv after", recv(a, buf, sizeof buf, 0));
  close(a);
}

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  signal(SIGPIPE, SIG_IGN);
  tcp();
  nonblocking();
  shared();
  udp();
  return 0;
}
