// Threads: pthread_create and join, a mutex many threads contend for, a
// condition variable, thread-local storage, a detached thread, thread
// ids, a signal to one thread (pthread_kill, tgkill), and exit_group from
// a thread while others wait.
#define _GNU_SOURCE
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define THREADS 8
#define ROUNDS 20000

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cond = PTHREAD_COND_INITIALIZER;
static long counter;
static int ready;
static __thread int mine = 7;
static volatile int hit_tid;

static void *add(void *arg) {
  long id = (long)arg;
  mine = (int)id;
  for (int k = 0; k < ROUNDS; k++) {
    pthread_mutex_lock(&lock);
    counter++;
    pthread_mutex_unlock(&lock);
    if (k % 1000 == 0) sched_yield();
  }
  return (void *)(long)(mine * 10);
}

static void *waiter(void *arg) {
  pthread_mutex_lock(&lock);
  while (!ready) pthread_cond_wait(&cond, &lock);
  pthread_mutex_unlock(&lock);
  return arg;
}

static void on_usr1(int sig) { hit_tid = syscall(SYS_gettid); }

static void *target(void *arg) {
  *(int *)arg = syscall(SYS_gettid);
  while (!hit_tid) usleep(1000);
  return 0;
}

static void *ender(void *arg) { usleep(50000); exit(3); }
static void *sleeper(void *arg) { for (;;) pause(); }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  pthread_t t[THREADS];
  for (long k = 0; k < THREADS; k++) pthread_create(&t[k], 0, add, (void *)k);
  long sum = 0;
  for (int k = 0; k < THREADS; k++) { void *r; pthread_join(t[k], &r); sum += (long)r; }
  printf("counter %ld (want %d), results %ld, main's tls %d\n", counter, THREADS * ROUNDS, sum, mine);

  pthread_t w[3];
  for (long k = 0; k < 3; k++) pthread_create(&w[k], 0, waiter, (void *)k);
  usleep(20000);
  pthread_mutex_lock(&lock);
  ready = 1;
  pthread_cond_broadcast(&cond);
  pthread_mutex_unlock(&lock);
  long woke = 0;
  for (int k = 0; k < 3; k++) { void *r; pthread_join(w[k], &r); woke += 1 + (long)r; }
  printf("condvar woke %ld\n", woke);

  printf("pid is tid in main %d\n", getpid() == syscall(SYS_gettid));

  signal(SIGUSR1, on_usr1);
  int tid = 0;
  pthread_t th;
  pthread_create(&th, 0, target, &tid);
  while (!tid) usleep(1000);
  pthread_kill(th, SIGUSR1);
  pthread_join(th, 0);
  printf("signal went to the thread: %d\n", hit_tid == tid && tid != getpid());

  pthread_attr_t a;
  pthread_attr_init(&a);
  pthread_attr_setdetachstate(&a, PTHREAD_CREATE_DETACHED);
  pthread_create(&th, &a, waiter, 0);
  usleep(10000);

  // exit from one thread ends them all, the whole process with its status.
  pid_t child = fork();
  if (child == 0) {
    pthread_t s, e;
    pthread_create(&s, 0, sleeper, 0);
    pthread_create(&e, 0, ender, 0);
    for (;;) pause();
  }
  int st;
  waitpid(child, &st, 0);
  printf("exit from a thread: %d\n", WEXITSTATUS(st));
  return 0;
}
