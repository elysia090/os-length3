// The clocks as a program reads them (answered in the thread, as a vDSO answers them, or by the kernel): monotonic
// going forward, realtime as gettimeofday and time say it, TAI and the coarse clocks, a clock that is none.
#include <stdio.h>
#include <sys/time.h>
#include <time.h>
#include <errno.h>
#include <string.h>
int main(void) {
  struct timespec a, b, r; struct timeval tv; struct timezone tz = {99, 99};
  clock_gettime(CLOCK_MONOTONIC, &a); clock_gettime(CLOCK_MONOTONIC, &b);
  printf("monotonic forward: %d\n", (b.tv_sec > a.tv_sec) || (b.tv_sec == a.tv_sec && b.tv_nsec >= a.tv_nsec));
  printf("nsec in range: %d\n", a.tv_nsec >= 0 && a.tv_nsec < 1000000000);
  clock_gettime(CLOCK_REALTIME, &a); gettimeofday(&tv, &tz); time_t t = time(0);
  printf("realtime agrees: %d %d\n", (long)(tv.tv_sec - a.tv_sec) <= 1, (long)(t - a.tv_sec) <= 1);
  printf("tz: %d %d\n", tz.tz_minuteswest, tz.tz_dsttime);
  // (TAI's offset is the host's: a time daemon may have set it, so only that it reads is said.)
  printf("tai reads: %d\n", clock_gettime(CLOCK_TAI, &b) == 0 && b.tv_sec >= a.tv_sec);
  printf("coarse realtime near: %d\n", clock_gettime(CLOCK_REALTIME_COARSE, &b) == 0 && (long)(b.tv_sec - a.tv_sec) <= 1);
  int e = clock_gettime(99, &b); printf("clock 99: %d %s\n", e, e ? strerror(errno) : "");
  e = clock_getres(99, &r); printf("res 99: %d\n", e);
  return 0;
}
