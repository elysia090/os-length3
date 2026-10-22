// Sleeping takes the time asked, by an interval and until a deadline.
#include <stdio.h>
#include <time.h>

static long ms(struct timespec a, struct timespec b) { return (b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000; }

int main(void) {
  struct timespec a, b, d = {0, 200000000};
  clock_gettime(CLOCK_MONOTONIC, &a);
  nanosleep(&d, 0);
  clock_gettime(CLOCK_MONOTONIC, &b);
  printf("interval %s\n", ms(a, b) >= 200 ? "long enough" : "too short");
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  t.tv_nsec += 100000000;
  if (t.tv_nsec >= 1000000000) { t.tv_sec++; t.tv_nsec -= 1000000000; }
  clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &t, 0);
  clock_gettime(CLOCK_MONOTONIC, &b);
  printf("deadline %s\n", b.tv_sec > t.tv_sec || (b.tv_sec == t.tv_sec && b.tv_nsec >= t.tv_nsec) ? "reached" : "early");
  return 0;
}
