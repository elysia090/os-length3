// A monotonic timerfd in an epoll loop, as used by a Wayland client for key repeat.
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/epoll.h>
#include <sys/timerfd.h>
#include <sys/select.h>
#include <time.h>
#include <unistd.h>

static void arm(int fd, long first, long period) {
  struct itimerspec spec = {.it_interval = {0, period}, .it_value = {0, first}};
  assert(timerfd_settime(fd, 0, &spec, NULL) == 0);
}

int main(void) {
  uint64_t ticks;
  struct itimerspec got, off = {0};
  int fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
  assert(fd >= 0);
  assert(fcntl(fd, F_GETFD) == FD_CLOEXEC);
  assert(fcntl(fd, F_GETFL) == (O_RDWR | O_NONBLOCK));
  assert(timerfd_create(CLOCK_MONOTONIC, 1) == -1 && errno == EINVAL);
  assert(timerfd_settime(fd, 4, &off, NULL) == -1 && errno == EINVAL);
  assert(timerfd_gettime(fd, &got) == 0 && !got.it_value.tv_sec && !got.it_value.tv_nsec);

  int ep = epoll_create1(EPOLL_CLOEXEC);
  struct epoll_event event = {.events = EPOLLIN | EPOLLET, .data.u64 = 0x1234};
  assert(ep >= 0 && epoll_ctl(ep, EPOLL_CTL_ADD, fd, &event) == 0);
  int copy = dup(fd);
  assert(copy >= 0 && fcntl(copy, F_GETFD) == 0 && close(fd) == 0);
  assert(epoll_wait(ep, &event, 1, 0) == 0);
  assert(read(copy, &ticks, sizeof(ticks)) == -1 && errno == EAGAIN);
  assert(read(copy, &ticks, sizeof(ticks) - 1) == -1 && errno == EINVAL);

  arm(copy, 15 * 1000 * 1000, 0);
  assert(epoll_wait(ep, &event, 1, 1000) == 1);
  assert(event.events == EPOLLIN && event.data.u64 == 0x1234);
  struct pollfd p = {.fd = copy, .events = POLLIN | POLLOUT | POLLRDNORM};
  assert(poll(&p, 1, 0) == 1 && p.revents == POLLIN);
  assert(epoll_wait(ep, &event, 1, 0) == 0);
  fd_set readers;
  FD_ZERO(&readers);
  FD_SET(copy, &readers);
  struct timeval zero = {0};
  assert(select(copy + 1, &readers, NULL, NULL, &zero) == 1 && FD_ISSET(copy, &readers));
  assert(read(copy, &ticks, sizeof(ticks)) == sizeof(ticks) && ticks == 1);
  assert(poll(&p, 1, 0) == 0 && p.revents == 0);

  // A past absolute start has accrued several intervals by the time we read.
  struct timespec now;
  assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  if (now.tv_sec == 0 && now.tv_nsec <= 10 * 1000 * 1000) {
    struct timespec delay = {0, 20 * 1000 * 1000};
    assert(nanosleep(&delay, NULL) == 0);
    assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  }
  now.tv_nsec -= 10 * 1000 * 1000;
  if (now.tv_nsec < 0) { now.tv_sec--; now.tv_nsec += 1000 * 1000 * 1000; }
  struct itimerspec repeat = {.it_interval = {0, 1000 * 1000}, .it_value = now};
  assert(timerfd_settime(copy, TFD_TIMER_ABSTIME, &repeat, &got) == 0 && !got.it_value.tv_sec && !got.it_value.tv_nsec);
  // Even a past deadline can be delivered after timerfd_settime returns.
  assert(epoll_wait(ep, &event, 1, 1000) == 1);
  assert(event.events == EPOLLIN && event.data.u64 == 0x1234);
  assert(timerfd_gettime(copy, &got) == 0 && got.it_interval.tv_nsec == repeat.it_interval.tv_nsec);
  assert(read(copy, &ticks, sizeof(ticks)) == sizeof(ticks) && ticks >= 10);
  assert(timerfd_settime(copy, 0, &off, NULL) == 0);
  assert(read(copy, &ticks, sizeof(ticks)) == -1 && errno == EAGAIN);

  assert(fcntl(copy, F_SETFL, 0) == 0);
  arm(copy, 15 * 1000 * 1000, 0);
  assert(read(copy, &ticks, sizeof(ticks)) == sizeof(ticks) && ticks == 1);
  assert(close(copy) == 0 && epoll_wait(ep, &event, 1, 0) == 0 && close(ep) == 0);
  puts("monotonic timerfd: epoll, overrun, disarm, blocking read and final close");
}
