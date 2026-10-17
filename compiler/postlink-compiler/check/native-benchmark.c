/* Paired native process benchmark for one source/optimized ELF pair. */

#define _DEFAULT_SOURCE

#include <math.h>
#include <sys/resource.h>

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

static void close_arguments(char **arguments, pl_u32 count)
{
    if (!arguments) return;
    for (pl_u32 index = 0u; index < count; ++index) free(arguments[index]);
    free(arguments);
}

static char **project_arguments(const char *path, char *arguments[], pl_u32 count)
{
    static const char token[] = "@EXECUTABLE_DIR@";
    const char *slash = strrchr(path, '/');
    const char *directory = slash ? path : ".";
    size_t directory_bytes = slash ? (size_t)(slash - path) : 1u;
    if (slash == path) directory_bytes = 1u;
    char **result = calloc((size_t)count + 1u, sizeof(*result));
    if (!result) return NULL;
    for (pl_u32 index = 0u; index < count; ++index) {
        const char *argument = arguments[index];
        if (index == 0u && !strcmp(argument, "@EXECUTABLE@")) argument = path;
        if (!strncmp(argument, token, sizeof(token) - 1u)
                && argument[sizeof(token) - 1u] == '/') {
            const char *suffix = argument + sizeof(token) - 1u;
            size_t suffix_bytes = strlen(suffix);
            if (directory_bytes > SIZE_MAX - suffix_bytes - 1u) {
                close_arguments(result, count);
                return NULL;
            }
            result[index] = malloc(directory_bytes + suffix_bytes + 1u);
            if (result[index]) {
                memcpy(result[index], directory, directory_bytes);
                memcpy(result[index] + directory_bytes, suffix, suffix_bytes + 1u);
            }
        } else result[index] = strdup(argument);
        if (!result[index]) {
            close_arguments(result, count);
            return NULL;
        }
    }
    return result;
}

static int observe(const char *path, char *arguments[],
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
    return WIFEXITED(left->wait_status)
        && WEXITSTATUS(left->wait_status) == 0
        && left->wait_status == right->wait_status
        && left->bytes == right->bytes
        && !memcmp(left->digest, right->digest, PL_SHA256_BYTES);
}

static pl_u64 clock_nanoseconds(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC_RAW, &now)) return 0u;
    return (pl_u64)now.tv_sec * 1000000000ull + (pl_u64)now.tv_nsec;
}

/* One measured run: wall time, the child's own CPU time (user + system, from
 * wait4) and its minor page faults. CPU time is not wall time; both are
 * reported under their own names. */
typedef struct {
    pl_u64 wall_ns;
    pl_u64 cpu_ns;
    pl_u64 faults;
} sample;

static int timed(const char *path, char *arguments[],
                 int null_descriptor, sample *out)
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
    struct rusage usage;
    for (;;) {
        if (wait4(child, &status, 0, &usage) == child) break;
        if (errno != EINTR) return 0;
    }
    pl_u64 end = clock_nanoseconds();
    if (!end || end < begin || !WIFEXITED(status)
            || WEXITSTATUS(status) != 0) return 0;
    out->wall_ns = end - begin;
    out->cpu_ns = ((pl_u64)usage.ru_utime.tv_sec + (pl_u64)usage.ru_stime.tv_sec)
                    * 1000000000ull
                + ((pl_u64)usage.ru_utime.tv_usec + (pl_u64)usage.ru_stime.tv_usec)
                    * 1000ull;
    out->faults = (pl_u64)usage.ru_minflt + (pl_u64)usage.ru_majflt;
    return 1;
}

/* The paired ratio optimized/source as a geometric mean of the per-pair
 * ratios, with a 95% interval (normal approximation; 401 pairs). Pairs ran
 * back to back, so drift of the machine cancels within each pair. An
 * interval that contains 1 says the difference is not resolved. */
typedef struct {
    double ratio;
    double low;
    double high;
    int resolved;
} interval;

static interval paired(const sample *source, const sample *optimized,
                       pl_u32 count, int cpu)
{
    double total = 0.0, square = 0.0;
    pl_u32 used = 0u;
    for (pl_u32 index = 0u; index < count; ++index) {
        double a = (double)(cpu ? source[index].cpu_ns : source[index].wall_ns);
        double b = (double)(cpu ? optimized[index].cpu_ns : optimized[index].wall_ns);
        if (a <= 0.0 || b <= 0.0) continue; /* CPU time below the clock's step */
        double d = log(b / a);
        total += d;
        square += d * d;
        ++used;
    }
    interval out = { 1.0, 0.0, INFINITY, 0 };
    if (used < 2u) return out;
    double mean_log = total / used;
    double variance = (square - total * mean_log) / (used - 1u);
    double half = 1.959963985 * sqrt(variance > 0.0 ? variance : 0.0) / sqrt((double)used);
    out.ratio = exp(mean_log);
    out.low = exp(mean_log - half);
    out.high = exp(mean_log + half);
    out.resolved = out.high < 1.0 || out.low > 1.0;
    return out;
}

static const char *verdict(interval i)
{
    return !i.resolved ? "within-noise" : i.high < 1.0 ? "faster" : "slower";
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

static long double mean_of(const sample *samples, pl_u32 count, int field)
{
    long double total = 0.0L;
    for (pl_u32 index = 0u; index < count; ++index)
        total += (long double)(field == 0 ? samples[index].wall_ns
                             : field == 1 ? samples[index].cpu_ns
                             : samples[index].faults);
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
    pl_u32 argument_count = (pl_u32)(argc - 3);
    struct stat source_stat, optimized_stat;
    if (stat(argv[1], &source_stat) || stat(argv[2], &optimized_stat)
            || source_stat.st_dev != optimized_stat.st_dev) {
        fprintf(stderr,
                "native-benchmark: SOURCE and OPTIMIZED must be on one filesystem\n");
        return 2;
    }
    /* Resolve package-relative resources before the measured interval, so
     * each executable uses its own distribution instead of host data. */
    char **source_arguments = project_arguments(argv[1], &argv[3], argument_count);
    char **optimized_arguments = project_arguments(argv[2], &argv[3], argument_count);
    if (!source_arguments || !optimized_arguments) {
        close_arguments(source_arguments, argument_count);
        close_arguments(optimized_arguments, argument_count);
        return 1;
    }
    observation source_observation, optimized_observation;
    if (!observe(argv[1], source_arguments, &source_observation)
            || !observe(argv[2], optimized_arguments, &optimized_observation)
            || !same_observation(
                &source_observation, &optimized_observation)) {
        fprintf(stderr, "native benchmark parity: RED\n");
        return 1;
    }

    FILE *null_file = fopen("/dev/null", "w");
    sample *source_runs = malloc((size_t)runs * sizeof *source_runs);
    sample *optimized_runs = malloc((size_t)runs * sizeof *optimized_runs);
    pl_u64 *source = malloc((size_t)runs * sizeof *source);
    pl_u64 *optimized = malloc((size_t)runs * sizeof *optimized);
    if (!null_file || !source || !optimized || !source_runs || !optimized_runs) {
        if (null_file) fclose(null_file);
        free(optimized);
        free(source);
        free(optimized_runs);
        free(source_runs);
        return 1;
    }
    int null_descriptor = fileno(null_file);
    sample discarded;
    for (pl_u32 warm = 0u; warm < PRODUCTION_WARMUPS; ++warm)
        if (!timed(warm & 1u ? argv[1] : argv[2],
                   warm & 1u ? source_arguments : optimized_arguments,
                   null_descriptor, &discarded))
            return 1;
    for (pl_u32 rank = 0u; rank < runs; ++rank) {
        if (rank & 1u) {
            if (!timed(argv[2], optimized_arguments, null_descriptor, &optimized_runs[rank])
                    || !timed(argv[1], source_arguments,
                              null_descriptor, &source_runs[rank]))
                return 1;
        } else if (!timed(argv[1], source_arguments, null_descriptor, &source_runs[rank])
                || !timed(argv[2], optimized_arguments,
                          null_descriptor, &optimized_runs[rank]))
            return 1;
    }
    fclose(null_file);
    for (pl_u32 rank = 0u; rank < runs; ++rank) {
        source[rank] = source_runs[rank].wall_ns;
        optimized[rank] = optimized_runs[rank].wall_ns;
    }
    interval wall = paired(source_runs, optimized_runs, runs, 0);
    interval cpu = paired(source_runs, optimized_runs, runs, 1);
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
    /* What the samples can resolve: paired geometric ratios with their 95%
     * interval, for wall time and for the child's CPU time, and page faults. */
    printf("wall_paired_ratio=%.9f\n", wall.ratio);
    printf("wall_ratio_low=%.9f\n", wall.low);
    printf("wall_ratio_high=%.9f\n", wall.high);
    printf("wall_verdict=%s\n", verdict(wall));
    printf("source_cpu_mean_ns=%.0Lf\n", mean_of(source_runs, runs, 1));
    printf("optimized_cpu_mean_ns=%.0Lf\n", mean_of(optimized_runs, runs, 1));
    printf("cpu_paired_ratio=%.9f\n", cpu.ratio);
    printf("cpu_ratio_low=%.9f\n", cpu.low);
    printf("cpu_ratio_high=%.9f\n", cpu.high);
    printf("cpu_verdict=%s\n", verdict(cpu));
    printf("source_faults_mean=%.1Lf\n", mean_of(source_runs, runs, 2));
    printf("optimized_faults_mean=%.1Lf\n", mean_of(optimized_runs, runs, 2));
    /* Hardware counters are not sampled by this runner. */
    printf("instructions=unavailable\n");
    printf("cycles=unavailable\n");
    free(optimized_runs);
    free(source_runs);
    free(optimized);
    free(source);
    close_arguments(optimized_arguments, argument_count);
    close_arguments(source_arguments, argument_count);
    return 0;
}
