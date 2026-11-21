#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static uint64_t ns(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(100);
    return (uint64_t)t.tv_sec * UINT64_C(1000000000) + t.tv_nsec;
}

int main(int argc, char **argv) {
    if (argc != 2 || argv[1][0] != '/' || !argv[1][1]) return 100;
    const char *program = argv[1];
    char *const args[] = {argv[1], "-j1", "proof", NULL};
    const uint64_t a = ns();
    pid_t child = fork(), got;
    if (child == -1) return 101;
    if (child == 0) { execv(program, args); _exit(102); }
    int st;
    do { got = waitpid(child, &st, 0); } while (got == -1 && errno == EINTR);
    uint64_t b = ns();  // Real positive-child terminal wait, never last stdout or timer estimate.
    if (got != child || b < a || !WIFEXITED(st)) return 103;
    printf("RX_WALL_NS %" PRIu64 "\n", b-a);
    return WEXITSTATUS(st);
}
