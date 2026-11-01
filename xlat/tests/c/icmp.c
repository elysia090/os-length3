// ICMP over loopback, as ping makes it: a raw socket sends an echo request to 127.0.0.1 and reads what comes back
// (the request itself, as each raw ICMP socket sees what arrives, and the kernel's echo reply), each with its IPv4
// header; ICMP_FILTER keeps the request out; what an interface is (SIOCGIFINDEX, SIOCGIFFLAGS, SIOCGIFADDR, ...).
// xlat: raw sockets (run.sh runs the native side as root: a raw socket wants CAP_NET_RAW).
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <net/if.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/ip_icmp.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static unsigned short sum(const void *p, int n) {
  const unsigned short *w = p; unsigned long s = 0;
  for (; n > 1; n -= 2) s += *w++;
  if (n) s += *(const unsigned char *)w;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return (unsigned short)~s;
}

/** Read what comes within a moment; say each packet's ICMP type, id and sequence, and its header's TTL and protocol. */
static void drain(int s, const char *what) {
  for (;;) {
    struct pollfd p = {s, POLLIN, 0};
    if (poll(&p, 1, 200) <= 0) break;
    unsigned char b[256]; struct sockaddr_in from; socklen_t fl = sizeof from;
    ssize_t n = recvfrom(s, b, sizeof b, 0, (struct sockaddr *)&from, &fl);
    if (n < 28) break;
    struct iphdr *ip = (struct iphdr *)b;
    struct icmphdr *h = (struct icmphdr *)(b + ip->ihl * 4);
    // (A host with a network of its own may have other ICMP about: only this test's echo is said.)
    if (ntohs(h->un.echo.id) != 4242) continue;
    printf("%s: %zd bytes from %s, ttl %d proto %d, type %d id %d seq %d, checksum ok %d\n", what, n, inet_ntoa(from.sin_addr),
           ip->ttl, ip->protocol, h->type, ntohs(h->un.echo.id), ntohs(h->un.echo.sequence), sum(h, n - ip->ihl * 4) == 0);
  }
}

static void echo(int s, int seq) {
  unsigned char b[64] = {0};
  struct icmphdr *h = (struct icmphdr *)b;
  h->type = ICMP_ECHO; h->un.echo.id = htons(4242); h->un.echo.sequence = htons(seq);
  memcpy(b + 8, "ping over lo", 12);
  h->checksum = sum(b, sizeof b);
  struct sockaddr_in to = {.sin_family = AF_INET};
  inet_pton(AF_INET, "127.0.0.1", &to.sin_addr);
  printf("sendto: %zd\n", sendto(s, b, sizeof b, 0, (struct sockaddr *)&to, sizeof to));
}

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  int s = socket(AF_INET, SOCK_RAW, IPPROTO_ICMP);
  if (s < 0) { printf("raw socket: %s\n", strerror(errno)); return 0; }
  // What comes to 127.0.0.1 alone.
  struct sockaddr_in here = {.sin_family = AF_INET};
  inet_pton(AF_INET, "127.0.0.1", &here.sin_addr);
  printf("bind: %d\n", bind(s, (struct sockaddr *)&here, sizeof here));
  echo(s, 1);
  drain(s, "got");
  // Only the replies, as ping asks.
  struct { unsigned data; } filter = {~(1u << ICMP_ECHOREPLY)};
  printf("ICMP_FILTER: %d\n", setsockopt(s, SOL_RAW, 1, &filter, sizeof filter));
  echo(s, 2);
  drain(s, "filtered");
  // (An address outside is unreachable on a machine with only lo: boundary.test.mjs says so, as this one has more.)
  // lo, by its name.
  struct ifreq r = {0};
  strcpy(r.ifr_name, "lo");
  int got = ioctl(s, SIOCGIFINDEX, &r);
  printf("SIOCGIFINDEX: %d, index %d, if_nametoindex %u\n", got, r.ifr_ifindex, if_nametoindex("lo"));
  ioctl(s, SIOCGIFFLAGS, &r);
  printf("up %d loopback %d running %d\n", !!(r.ifr_flags & IFF_UP), !!(r.ifr_flags & IFF_LOOPBACK), !!(r.ifr_flags & IFF_RUNNING));
  ioctl(s, SIOCGIFADDR, &r);
  printf("address %s\n", inet_ntoa(((struct sockaddr_in *)&r.ifr_addr)->sin_addr));
  ioctl(s, SIOCGIFNETMASK, &r);
  printf("netmask %s\n", inet_ntoa(((struct sockaddr_in *)&r.ifr_netmask)->sin_addr));
  ioctl(s, SIOCGIFMTU, &r);
  printf("mtu %d\n", r.ifr_mtu);
  char name[IF_NAMESIZE] = {0};
  printf("if_indextoname(1): %s\n", if_indextoname(1, name));
  strcpy(r.ifr_name, "eth9");
  int e = ioctl(s, SIOCGIFINDEX, &r);
  printf("eth9: %d %s\n", e, strerror(errno));
  return 0;
}
