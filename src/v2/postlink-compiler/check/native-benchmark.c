/* Paired native process benchmark for one source/optimized ELF pair. */

#define _POSIX_C_SOURCE 200809L

#include <support/sha256.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    int wait_status;
    pl_u64 bytes;
    pl_u8 digest[PL_SHA256_BYTES];
} observation;

enum {
    PRODUCTION_WARMUPS = 8,
    PRODUCTION_PAIRED_SAMPLES = 401
};

static int child_status(pid_t child, int *status)
{
    for (;;) {
        if (waitpid(child, status, 0) == child) return 1;
        if (errno != EINTR) return 0;
    }
}

static int observe(const char *path, char *const arguments[],
                   observation *out)
{
    FILE *capture = tmpfile();
    if (!capture) return 0;
    int descriptor = fileno(capture);
    pid_t child = fork();
    if (child < 0) { fclose(capture); return 0; }
    if (!child) {
        if (dup2(descriptor, STDOUT_FILENO) < 0
                || dup2(descriptor, STDERR_FILENO) < 0)
            _exit(126);
        execv(path, arguments);
        _exit(127);
    }
    if (!child_status(child, &out->wait_status)
            || fflush(capture) || fseek(capture, 0, SEEK_SET)) {
        fclose(capture);
        return 0;
    }
    pl_sha256 hash;
    pl_sha256_open(&hash);
    out->bytes = 0u;
    pl_u8 buffer[4096];
    for (;;) {
        size_t got = fread(buffer, 1u, sizeof buffer, capture);
        if (got) {
            pl_sha256_write(&hash, buffer, (pl_u64)got);
            if (out->bytes > UINT64_MAX - (pl_u64)got) {
                fclose(capture);
                return 0;
            }
            out->bytes += (pl_u64)got;
        }
        if (got != sizeof buffer) {
            if (ferror(capture)) { fclose(capture); return 0; }
            break;
        }
    }
    pl_sha256_close(&hash, out->digest);
    return fclose(capture) == 0;
}

static int same_observation(const observation *left,
                            const observation *right)
{
    return left->wait_status == right->wait_status
        && left->bytes == right->bytes
        && !memcmp(left->digest, right->digest, PL_SHA256_BYTES);
}

static pl_u64 clock_nanoseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC_RAW, &now)) return 0u;
    return (pl_u64)now.tv_sec * 1000000000ull + (pl_u64)now.tv_nsec;
}

static int timed(const char *path, char *const arguments[],
                 int null_descriptor, pl_u64 *nanoseconds)
{
    pl_u64 begin = clock_nanoseconds();
    if (!begin) return 0;
    pid_t child = fork();
    if (child < 0) return 0;
    if (!child) {
        if (dup2(null_descriptor, STDOUT_FILENO) < 0
                || dup2(null_descriptor, STDERR_FILENO) < 0)
            _exit(126);
        execv(path, arguments);
        _exit(127);
    }
    int status;
    if (!child_status(child, &status)) return 0;
    pl_u64 end = clock_nanoseconds();
    if (!end || end < begin || !WIFEXITED(status)) return 0;
    *nanoseconds = end - begin;
    return 1;
}

static int compare_u64(const void *left, const void *right)
{
    pl_u64 a = *(const pl_u64 *)left;
    pl_u64 b = *(const pl_u64 *)right;
    return a > b ? 1 : a < b ? -1 : 0;
}

static long double mean(const pl_u64 *samples, pl_u32 count)
{
    long double total = 0.0L;
    for (pl_u32 index = 0u; index < count; ++index)
        total += (long double)samples[index];
    return total / count;
}

int main(int argc, char **argv)
{
    if (argc < 4) {
        fprintf(stderr,
                "usage: native-benchmark SOURCE OPTIMIZED ARGV0 [ARG...]\n");
        return 2;
    }
    const pl_u32 runs = PRODUCTION_PAIRED_SAMPLES;
    char **arguments = &argv[3];
    struct stat source_stat, optimized_stat;
    if (stat(argv[1], &source_stat) || stat(argv[2], &optimized_stat)
            || source_stat.st_dev != optimized_stat.st_dev) {
        fprintf(stderr,
                "native-benchmark: SOURCE and OPTIMIZED must be on one filesystem\n");
        return 2;
    }
    observation source_observation, optimized_observation;
    if (!observe(argv[1], arguments, &source_observation)
            || !observe(argv[2], arguments, &optimized_observation)
            || !same_observation(
                &source_observation, &optimized_observation)) {
        fprintf(stderr, "native benchmark parity: RED\n");
        return 1;
    }

    FILE *null_file = fopen("/dev/null", "w");
    pl_u64 *source = malloc((size_t)runs * sizeof *source);
    pl_u64 *optimized = malloc((size_t)runs * sizeof *optimized);
    if (!null_file || !source || !optimized) {
        if (null_file) fclose(null_file);
        free(optimized);
        free(source);
        return 1;
    }
    int null_descriptor = fileno(null_file);
    pl_u64 discarded;
    for (pl_u32 warm = 0u; warm < PRODUCTION_WARMUPS; ++warm)
        if (!timed(warm & 1u ? argv[1] : argv[2], arguments,
                   null_descriptor, &discarded))
            return 1;
    for (pl_u32 rank = 0u; rank < runs; ++rank) {
        if (rank & 1u) {
            if (!timed(argv[2], arguments, null_descriptor, &optimized[rank])
                    || !timed(argv[1], arguments,
                              null_descriptor, &source[rank]))
                return 1;
        } else if (!timed(argv[1], arguments, null_descriptor, &source[rank])
                || !timed(argv[2], arguments,
                          null_descriptor, &optimized[rank]))
            return 1;
    }
    fclose(null_file);
    long double source_mean = mean(source, runs);
    long double optimized_mean = mean(optimized, runs);
    qsort(source, runs, sizeof *source, compare_u64);
    qsort(optimized, runs, sizeof *optimized, compare_u64);
    printf("format=native-paired-benchmark-v1\n");
    printf("paired_samples=%u\n", (unsigned)runs);
    printf("warmups=%u\n", (unsigned)PRODUCTION_WARMUPS);
    printf("parity=green\n");
    printf("wait_status=%d\n", source_observation.wait_status);
    printf("output_bytes=%llu\n",
           (unsigned long long)source_observation.bytes);
    printf("source_mean_ns=%.0Lf\n", source_mean);
    printf("source_median_ns=%llu\n",
           (unsigned long long)source[runs / 2u]);
    printf("optimized_mean_ns=%.0Lf\n", optimized_mean);
    printf("optimized_median_ns=%llu\n",
           (unsigned long long)optimized[runs / 2u]);
    printf("mean_ratio=%.9Lf\n", optimized_mean / source_mean);
    printf("median_ratio=%.9Lf\n",
           (long double)optimized[runs / 2u]
             / (long double)source[runs / 2u]);
    free(optimized);
    free(source);
    return 0;
}
